"""Daily stock forecasts: chance to beat the market, and a likely price range.

For every stock, every evening, and each horizon h in (1, 3, 5) sessions:

    entry  = next session's open   (the first price anyone can act on)
    exit   = close of session h
    return = exit / entry - 1

Two things are forecast:

  * P(beat): the chance the stock's return beats the average stock's over the
    same window. Whether stocks rise at all mostly depends on the whole
    market's next move, which no model here could forecast (tested: no skill).
    Relative performance is where a small, confirmed edge exists.
  * The 10th / 50th / 90th percentile of the stock's own return: the likely
    range, widened by a factor fitted out of sample so 8 in 10 outcomes land
    inside it.

The same `forecast_frame` builds the features for training and for the live
run, so the model in use sees exactly what it was tested on.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import pandas as pd

from .config import SECTOR_BY_SYMBOL
from .feature_engineering import build_feature_frame

HORIZONS = (1, 3, 5)
QUANTILES = (0.1, 0.5, 0.9)

FORECAST_FEATURES = [
    # the stock
    "close_to_ema20", "ema20_to_ema50", "rsi", "adx", "atr_pct", "vol_ratio",
    "dist_resistance_atr", "dist_support_atr", "ret1", "ret5", "ret20", "ret60",
    "range_pct", "vol20", "close_location", "gap",
    # against the market and its sector
    "rel_strength", "sector_strength",
    # the market
    "idx_ret5", "idx_ret20", "idx_to_ema50", "idx_vol20",
    "mkt_above_ema50", "mkt_above_ema20", "mkt_adv5", "mkt_breadth_chg",
    "sector_above_ema50", "sector_vs_market",
]
# The relative (beat-the-market) model uses stock-level inputs only: market-wide
# inputs are the same for every stock on a day and cannot rank them.
STOCK_FEATURES = [f for f in FORECAST_FEATURES if not f.startswith(("idx_", "mkt_"))]


def sector_of(ticker: str) -> str:
    return SECTOR_BY_SYMBOL.get(ticker.replace(".NS", "").replace(".BO", ""), "General")


def _stock_frame(ticker: str, raw: pd.DataFrame) -> pd.DataFrame:
    feats = build_feature_frame(raw)
    if feats.empty:
        return feats
    f = feats.sort_values("date").reset_index(drop=True)
    close = f["close"]
    prev_close = close.shift(1)
    daily = close.pct_change()
    out = pd.DataFrame({
        "date": pd.to_datetime(f["date"]).dt.strftime("%Y-%m-%d"),
        "ticker": ticker,
        "sector": sector_of(ticker),
        "open": f["open"].astype(float),
        "high": f["high"].astype(float),
        "low": f["low"].astype(float),
        "close": close.astype(float),
        "close_to_ema20": close / f["ema20"] - 1,
        "ema20_to_ema50": f["ema20"] / f["ema50"] - 1,
        "rsi": f["rsi14"] / 100,
        "adx": f["adx14"] / 50,
        "atr_pct": f["atr14"] / close,
        "vol_ratio": f["volume"] / f["vol_avg20"].replace(0, np.nan),
        "dist_resistance_atr": (f["resistance20"] - close) / f["atr14"],
        "dist_support_atr": (close - f["support20"]) / f["atr14"],
        "ret1": daily,
        "ret5": f["ret5"],
        "ret20": f["ret20"],
        "ret60": close.pct_change(60),
        "range_pct": f["range_pct"],
        "vol20": daily.rolling(20).std(),
        "close_location": (close - f["low"]) / (f["high"] - f["low"]).replace(0, np.nan),
        "gap": f["open"] / prev_close - 1,
        "above_ema50": (close > f["ema50"]).astype(float),
        "above_ema20": (close > f["ema20"]).astype(float),
        "_ret21": close / close.shift(20) - 1,
    })
    return out


def _index_frame(index_raw: pd.DataFrame) -> pd.DataFrame:
    idx = index_raw.copy()
    idx["date"] = pd.to_datetime(idx["date"]).dt.strftime("%Y-%m-%d")
    idx = idx.sort_values("date").reset_index(drop=True)
    close = idx["close"].astype(float)
    ema50 = close.ewm(span=50, adjust=False).mean()
    return pd.DataFrame({
        "date": idx["date"],
        "idx_ret5": close.pct_change(5),
        "idx_ret20": close.pct_change(20),
        "idx_to_ema50": close / ema50 - 1,
        "idx_vol20": close.pct_change().rolling(20).std(),
        "_idx_ret21": close / close.shift(20) - 1,
    })


def forecast_frame(
    price_frames: dict[str, pd.DataFrame],
    index_raw: pd.DataFrame,
    *,
    breadth_universe: set[str] | None = None,
    horizons: tuple[int, ...] = (),
) -> pd.DataFrame:
    """One row per (ticker, date) with every forecast feature.

    Market and sector breadth are measured over `breadth_universe` (the live
    universe) so a model trained on more stocks still sees the same breadth
    numbers it will see live. With `horizons`, forward returns from the next
    open to the close of session h are added as `fwd_{h}` (training only).
    """
    parts = [_stock_frame(t, raw) for t, raw in price_frames.items()]
    parts = [p for p in parts if not p.empty]
    if not parts:
        return pd.DataFrame()
    df = pd.concat(parts, ignore_index=True)
    df = df.merge(_index_frame(index_raw), on="date", how="inner")

    df["rel_strength"] = (df["_ret21"] - df["_idx_ret21"]) * 100
    df["sector_strength"] = df.groupby(["date", "sector"])["rel_strength"].transform("mean")

    pool = df[df["ticker"].isin(breadth_universe)] if breadth_universe else df
    by_day = pool.groupby("date").agg(
        mkt_above_ema50=("above_ema50", "mean"),
        mkt_above_ema20=("above_ema20", "mean"),
        mkt_adv5=("ret5", lambda s: float((s > 0).mean())),
    ).reset_index().sort_values("date")
    by_day["mkt_breadth_chg"] = by_day["mkt_above_ema50"].diff().fillna(0.0)
    by_sector = pool.groupby(["date", "sector"])["above_ema50"].mean().rename("sector_above_ema50").reset_index()
    df = df.merge(by_day, on="date", how="left").merge(by_sector, on=["date", "sector"], how="left")
    df["sector_above_ema50"] = df["sector_above_ema50"].fillna(df["mkt_above_ema50"])
    df["sector_vs_market"] = df["sector_above_ema50"] - df["mkt_above_ema50"]

    df = df.sort_values(["ticker", "date"]).reset_index(drop=True)
    if horizons:
        grouped = df.groupby("ticker", sort=False)
        next_open = grouped["open"].shift(-1)
        for h in horizons:
            exit_close = grouped["close"].shift(-h)
            df[f"fwd_{h}"] = exit_close / next_open - 1
    df = df.replace([np.inf, -np.inf], np.nan)
    df = df.dropna(subset=FORECAST_FEATURES).reset_index(drop=True)
    return df.drop(columns=[c for c in df.columns if c.startswith("_")])


# ── Runtime: turn model outputs into a published forecast ─────────────────────

def bucket_evidence(p: float, calibration: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    """How often stocks actually beat the market when testing gave a similar probability."""
    for bucket in calibration or []:
        if bucket["p_min"] <= p < bucket["p_max"] or (p >= bucket["p_max"] and bucket is calibration[-1]):
            return bucket
    return None


def widen(q: np.ndarray, scale: float) -> np.ndarray:
    """Stretch the 10/90 band around the median by `scale` (fitted out of sample)."""
    q = np.sort(q, axis=1)  # quantile models trained separately can cross; keep them ordered
    mid = q[:, 1]
    return np.column_stack([mid - (mid - q[:, 0]) * scale, mid, mid + (q[:, 2] - mid) * scale])


def predict(artifact: dict[str, Any], rows: pd.DataFrame) -> pd.DataFrame:
    """Chance to beat the market and the 10/50/90 percentile return for each row."""
    out = rows[["ticker", "sector", "date", "close"]].copy()
    Xc = rows[artifact["classifier_features"]]
    out["p_beat"] = artifact["classifier"].predict_proba(Xc)[:, 1]
    # Calibration maps scores onto steps, so stocks often tie; the underlying
    # model's own score (same order, finer grain) breaks the ties.
    try:
        base = artifact["classifier"].calibrated_classifiers_[0].estimator
        out["rank_score"] = base.predict_proba(Xc)[:, 1]
    except Exception:  # noqa: BLE001
        out["rank_score"] = out["p_beat"]
    X = rows[artifact["features"]]
    q = np.column_stack([artifact["quantiles"][str(level)].predict(X) for level in QUANTILES])
    q = widen(q, float(artifact.get("range_scale", 1.0)))
    out["q10"], out["q50"], out["q90"] = q[:, 0], q[:, 1], q[:, 2]
    return out


def describe(row: pd.Series, horizon: int, calibration: list[dict[str, Any]] | None) -> dict[str, Any]:
    p_beat = float(row["p_beat"])
    close = float(row["close"])
    evidence = bucket_evidence(p_beat, calibration)
    return {
        "kind": "forecast",
        "horizon_days": horizon,
        "p_beat": round(p_beat, 4),
        "q10": round(float(row["q10"]), 5),
        "q50": round(float(row["q50"]), 5),
        "q90": round(float(row["q90"]), 5),
        "reference_close": round(close, 2),
        "low_price": round(close * (1 + float(row["q10"])), 2),
        "mid_price": round(close * (1 + float(row["q50"])), 2),
        "high_price": round(close * (1 + float(row["q90"])), 2),
        "tested": (
            {
                "p_min": evidence["p_min"],
                "p_max": evidence["p_max"],
                "actual_beat_rate": evidence["actual_beat_rate"],
                "samples": evidence["samples"],
            }
            if evidence
            else None
        ),
    }


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
        return default if math.isnan(number) or math.isinf(number) else number
    except (TypeError, ValueError):
        return default


# ── Artifacts ────────────────────────────────────────────────────────────────

import json as _json  # noqa: E402
import os as _os  # noqa: E402
from pathlib import Path as _Path  # noqa: E402

ARTIFACT_DIR = _Path(__file__).resolve().parent / "artifacts"
_ARTIFACTS: dict[int, dict[str, Any] | None] = {}
_REPORTS: dict[int, dict[str, Any] | None] = {}


def load_artifact(horizon: int) -> dict[str, Any] | None:
    """The trained forecast models for one horizon, or None if missing/unloadable."""
    horizon = int(horizon)
    if horizon not in _ARTIFACTS:
        path = ARTIFACT_DIR / f"forecast_h{horizon}.joblib"
        artifact = None
        try:
            import joblib

            artifact = joblib.load(path)
            if list(artifact.get("features") or []) != FORECAST_FEATURES or list(artifact.get("classifier_features") or []) != STOCK_FEATURES:
                raise ValueError("forecast artifact features do not match this code")
            print(f"[Forecast] Loaded {horizon}-day forecast models from {path.name}.")
        except FileNotFoundError:
            print(f"[Forecast] No {horizon}-day forecast models at {path}.")
        except Exception as exc:  # noqa: BLE001
            print("=" * 78)
            print(f"[Forecast] {horizon}-DAY FORECAST MODELS NOT LOADED: {exc}")
            print("[Forecast] Usually a scikit-learn version mismatch; retrain with scripts/train_forecast.py.")
            print("=" * 78)
            artifact = None
        _ARTIFACTS[horizon] = artifact
    return _ARTIFACTS[horizon]


def load_report(horizon: int) -> dict[str, Any] | None:
    horizon = int(horizon)
    if horizon not in _REPORTS:
        try:
            with open(ARTIFACT_DIR / f"forecast_report_h{horizon}.json", encoding="utf-8") as fh:
                _REPORTS[horizon] = _json.load(fh)
        except Exception:  # noqa: BLE001
            _REPORTS[horizon] = None
    return _REPORTS[horizon]


def context_notes(row: pd.Series) -> list[str]:
    """Plain facts about where the stock stands. Context for the reader, not the model's reasoning."""
    notes: list[str] = []
    rel = safe_float(row.get("rel_strength"))
    ret20 = safe_float(row.get("ret20")) * 100
    if abs(rel) >= 2:
        notes.append(f"{'Up' if ret20 >= 0 else 'Down'} {abs(ret20):.1f}% over 20 sessions, {'ahead of' if rel > 0 else 'behind'} the Nifty by {abs(rel):.1f} points")
    rsi = safe_float(row.get("rsi")) * 100
    if rsi >= 70:
        notes.append(f"RSI {rsi:.0f}: stretched after a strong run")
    elif rsi <= 30:
        notes.append(f"RSI {rsi:.0f}: heavily sold")
    to_ema = safe_float(row.get("close_to_ema20")) * 100
    notes.append(f"{abs(to_ema):.1f}% {'above' if to_ema >= 0 else 'below'} its 20-day average")
    vol = safe_float(row.get("vol_ratio"), 1.0)
    if vol >= 1.6:
        notes.append(f"Volume {vol:.1f}x its 20-day average")
    sector = safe_float(row.get("sector_above_ema50"), 0.5) * 100
    notes.append(f"{sector:.0f}% of its sector trades above the 50-day average")
    return notes[:4]
