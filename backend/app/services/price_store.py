from __future__ import annotations

from io import BytesIO
import os
import threading
from typing import Iterable

import pandas as pd
import requests
from storage3.exceptions import StorageApiError

from app.core.supabase_client import supabase, supabase_key, supabase_url

BUCKET = "stock-prices"
PRICE_PREFIX = "prices"
OHLCV_COLUMNS = ["date", "open", "high", "low", "close", "volume"]
FREE_TIER_FILE_CAP_BYTES = 50 * 1024 * 1024
WARN_FILE_BYTES = 45 * 1024 * 1024
STORAGE_WRITES_OK = bool(os.getenv("SUPABASE_SERVICE_ROLE_KEY"))


def _object_path(ticker: str) -> str:
    return f"{PRICE_PREFIX}/{str(ticker).strip()}.parquet"


def _is_not_found(exc: StorageApiError) -> bool:
    status = str(getattr(exc, "status", ""))
    code = str(getattr(exc, "code", "")).lower()
    message = str(exc).lower()
    return status == "404" or "not found" in message or code in {"404", "nosuchkey", "not_found"}


def _normalize_prices(df: pd.DataFrame | None) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame(columns=OHLCV_COLUMNS)

    out = df.copy()
    keep = [col for col in OHLCV_COLUMNS if col in out.columns]
    out = out[keep]
    for col in OHLCV_COLUMNS:
        if col not in out.columns:
            out[col] = pd.NA

    out["date"] = pd.to_datetime(out["date"], errors="coerce")
    for col in ["open", "high", "low", "close", "volume"]:
        out[col] = pd.to_numeric(out[col], errors="coerce")
    out = out.dropna(subset=OHLCV_COLUMNS)
    out = out[OHLCV_COLUMNS].drop_duplicates(subset=["date"], keep="last")
    return out.sort_values("date").reset_index(drop=True)


_thread_local = threading.local()


def _download(path: str) -> bytes | None:
    """Fetch one object over a per-thread HTTP session.

    The shared supabase client multiplexes every thread over one HTTP/2
    connection, and parallel scans made it drop ("ConnectionTerminated"); each
    failed read then fell back to a slow Yahoo download. Returns None if the
    object doesn't exist.
    """
    session = getattr(_thread_local, "session", None)
    if session is None:
        session = requests.Session()
        _thread_local.session = session
    url = f"{supabase_url.rstrip('/')}/storage/v1/object/{BUCKET}/{path}"
    headers = {"Authorization": f"Bearer {supabase_key}", "apikey": supabase_key}
    for attempt in range(2):
        try:
            response = session.get(url, headers=headers, timeout=15)
        except requests.RequestException:
            if attempt:
                raise
            continue
        if response.status_code in (400, 404):
            return None
        response.raise_for_status()
        return response.content
    return None


def read_prices(ticker: str) -> pd.DataFrame | None:
    if supabase is None:
        print("[PriceStore] Supabase client unavailable; check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY.")
        return None

    path = _object_path(ticker)
    try:
        payload = _download(path)
        if payload is None:
            return None
        df = pd.read_parquet(BytesIO(payload), engine="pyarrow")
        df = _normalize_prices(df)
        if df.empty:
            return None
        return df
    except StorageApiError as exc:
        if _is_not_found(exc):
            return None
        print(f"[PriceStore] Storage read failed for {ticker}: {exc}")
        return None
    except Exception as exc:
        print(f"[PriceStore] Storage read failed for {ticker}: {exc}")
        return None


def read_many(tickers: Iterable[str]) -> pd.DataFrame:
    frames: list[pd.DataFrame] = []
    for ticker in tickers:
        df = read_prices(ticker)
        if df is None or df.empty:
            continue
        with_ticker = df.copy()
        with_ticker["ticker"] = ticker
        frames.append(with_ticker[["ticker", *OHLCV_COLUMNS]])
    if not frames:
        return pd.DataFrame(columns=["ticker", *OHLCV_COLUMNS])
    return pd.concat(frames, ignore_index=True)


def write_prices(ticker: str, df: pd.DataFrame) -> None:
    if supabase is None:
        print("[PriceStore] Storage write skipped; check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")
        return
    if not STORAGE_WRITES_OK:
        print("[PriceStore] Storage write skipped; SUPABASE_SERVICE_ROLE_KEY is required for private bucket writes.")
        return

    incoming = _normalize_prices(df)
    if incoming.empty:
        return

    try:
        existing = read_prices(ticker)
        if existing is not None and not existing.empty:
            merged = pd.concat([existing, incoming], ignore_index=True)
            merged = _normalize_prices(merged)
        else:
            merged = incoming

        buffer = BytesIO()
        merged.to_parquet(buffer, index=False, engine="pyarrow")
        payload = buffer.getvalue()
        if len(payload) >= WARN_FILE_BYTES:
            mb = len(payload) / (1024 * 1024)
            cap = FREE_TIER_FILE_CAP_BYTES / (1024 * 1024)
            print(f"[PriceStore] Warning: {ticker} Parquet file is {mb:.1f}MB near the {cap:.0f}MB Storage upload cap.")

        supabase.storage.from_(BUCKET).upload(
            _object_path(ticker),
            payload,
            file_options={
                "content-type": "application/octet-stream",
                "upsert": "true",
            },
        )
        print(f"[PriceStore] Saved {len(merged)} merged rows for {ticker} to Supabase Storage.")
    except Exception as exc:
        print(f"[PriceStore] Storage write failed for {ticker}: {exc}")
