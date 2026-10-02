from __future__ import annotations

import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd

try:
    from app.core.supabase_client import supabase
except Exception:
    supabase = None


SNAPSHOT_TABLE = "stock_snapshot"
SNAPSHOT_STALE_HOURS = float(os.getenv("STOCK_SNAPSHOT_STALE_HOURS", "18"))
_cache: dict[str, Any] = {"ts": 0.0, "rows": []}
_CACHE_TTL = 300


def _clean_number(value: Any) -> float | None:
    try:
        if value is None or pd.isna(value):
            return None
        return round(float(value), 4)
    except Exception:
        return None


def _num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except Exception:
        return None


def _symbol_from_ticker(ticker: str) -> str:
    return str(ticker).replace(".NS", "").replace(".BO", "").upper()


def _stock_from_snapshot(row: dict[str, Any], fallback: dict[str, Any] | None = None) -> dict[str, Any]:
    fallback = fallback or {}
    ticker = row.get("ticker") or fallback.get("ticker")
    symbol = row.get("symbol") or fallback.get("symbol") or _symbol_from_ticker(str(ticker or ""))
    return {
        "name": row.get("name") or fallback.get("name") or symbol,
        "symbol": symbol,
        "exchange": fallback.get("exchange") or ("NSE" if str(ticker or "").endswith(".NS") else fallback.get("exchange", "NSE")),
        "ticker": ticker,
        "currency": fallback.get("currency") or "₹",
    }


def frontend_metric_row(
    row: dict[str, Any],
    fallback_stock: dict[str, Any] | None = None,
    *,
    reason: str | None = None,
    score: int | None = None,
) -> dict[str, Any]:
    market_cap_cr = _num(row.get("market_cap_cr"))
    market_cap = _num(row.get("market_cap"))
    cmp_value = _num(row.get("price"))
    pe = _num(row.get("trailing_pe"))
    roe = _num(row.get("roe"))
    roce = _num(row.get("roce"))
    ret_1m = _num(row.get("ret_1m")) or 0
    vol_ratio = _num(row.get("vol_ratio")) or 0
    computed_score = 60 + min(15, int(max(ret_1m, 0))) + min(15, int(max(vol_ratio, 0) * 5))
    if pe is not None and pe > 0:
        computed_score += max(0, min(8, int(30 - pe)))
    if roe is not None:
        computed_score += max(0, min(8, int(roe / 4)))
    latest_date = str(row.get("latest_date") or row.get("updated_at") or "")[:10] or None
    row_reason = reason or (
        f"Snapshot match: close {cmp_value:.2f} on {latest_date}; "
        f"P/E {pe:.2f}; ROE {roe:.2f}%; 1M return {ret_1m:.2f}%."
        if cmp_value is not None and pe is not None and roe is not None
        else "Snapshot match from precomputed Bullseye market data."
    )
    return {
        "stock": _stock_from_snapshot(row, fallback_stock),
        "sector": row.get("sector"),
        "priceToBook": _num(row.get("price_to_book")),
        "beta": _num(row.get("beta")),
        "profitMargin": _num(row.get("profit_margin")),
        "cmp": cmp_value,
        "pe": pe,
        "marketCapCr": market_cap_cr,
        "marketCapitalization": market_cap,
        "divYield": _num(row.get("dividend_yield")),
        "avgDividendPayout3Yr": None,
        "qtrSalesCr": None,
        "qtrProfitVar": _num(row.get("earnings_quarterly_growth")),
        "qtrSalesVar": None,
        # The snapshot carries ONE revenue-growth and ONE profit-growth figure
        # (latest reported). It is not a 3-year or 5-year series. Previously the
        # single profit_growth value was returned as BOTH profitGrowth3Yr and
        # profitGrowth5Yr, and the current roce as avgRoce7Yr — so the table
        # showed duplicated numbers under headings claiming different periods.
        # We do not have those horizons, so we report nothing for them.
        "revenueGrowth3Yr": _num(row.get("revenue_growth")),
        "profitGrowth3Yr": _num(row.get("profit_growth")),
        "profitGrowth5Yr": None,
        "roe": roe,
        "roce": roce,
        "avgRoce7Yr": None,
        "debtToEquity": _num(row.get("debt_to_equity")),
        "operatingMargin": _num(row.get("operating_margin")),
        "piotroskiScore": None,
        "avgPat10Yrs": None,
        # Score must come from the metrics, not from the row's position in a
        # hand-ordered preset list (the caller's `score` was literally
        # `92 - index * 3`). Fall back to the caller only when we have no
        # snapshot metrics to compute from.
        "score": max(50, min(int(computed_score if cmp_value is not None else (score or computed_score)), 99)),
        "reason": row_reason,
        "technical": {
            "latestDate": latest_date,
            "gainStreakDays": None,
            "recentVolumeAvg": None,
            "previousWeekVolumeAvg": None,
            "volumeRatioVsPreviousWeek": _num(row.get("vol_ratio")),
            "recentReturnPct": _num(row.get("ret_1w")),
            "return1wPct": _num(row.get("ret_1w")),
            "return1mPct": _num(row.get("ret_1m")),
            "return3mPct": _num(row.get("ret_3m")),
            "return6mPct": _num(row.get("ret_6m")),
            "return1yPct": _num(row.get("ret_1y")),
            "todayReturnPct": _num(row.get("change_pct")),
            "gapPct": _num(row.get("gap_pct")),
            "rsi14": _num(row.get("rsi14")),
            "mfi14": _num(row.get("mfi14")),
            "sma20": _num(row.get("sma20")),
            "sma50": _num(row.get("sma50")),
            "sma200": _num(row.get("sma200")),
            "ema20": _num(row.get("ema20")),
            "atr14": _num(row.get("atr14")),
            "atrChange5d": None,
            "latestVolume": _num(row.get("latest_volume")),
            "volumeSma10": None,
            "volumeSma20": _num(row.get("volume_sma20")),
            "volumeRatio10": _num(row.get("volume_ratio10")) or _num(row.get("vol_ratio")),
            "volumeRatio20": _num(row.get("vol_ratio")),
            "high52Week": _num(row.get("high_52w")),
            "low52Week": _num(row.get("low_52w")),
            "priceVs52WeekHighPct": (
                round(((cmp_value - _num(row.get("high_52w"))) / _num(row.get("high_52w"))) * 100, 4)
                if cmp_value is not None and _num(row.get("high_52w")) else None
            ),
            "priceVs52WeekLowPct": (
                round(((cmp_value - _num(row.get("low_52w"))) / _num(row.get("low_52w"))) * 100, 4)
                if cmp_value is not None and _num(row.get("low_52w")) else None
            ),
            "higherHighsLows10d": None,
            "lowerHighsLows10d": None,
            "requestedMetrics": [],
        },
    }


def _row_ticker(row: dict[str, Any]) -> str | None:
    stock = row.get("stock") if isinstance(row.get("stock"), dict) else {}
    ticker = row.get("ticker") or stock.get("ticker")
    return str(ticker) if ticker else None


def _merge_metric_row(row: dict[str, Any], enriched: dict[str, Any]) -> dict[str, Any]:
    merged = dict(enriched)
    for key, value in row.items():
        if key in {"stock", "technical"}:
            continue
        if value is not None:
            merged[key] = value
    merged["stock"] = enriched.get("stock") or row.get("stock")
    merged["technical"] = {
        **(enriched.get("technical") or {}),
        **(row.get("technical") or {}),
    }
    if row.get("reason"):
        merged["reason"] = row["reason"]
    return merged


def enrich_metric_rows(
    rows: list[dict[str, Any]],
    *,
    max_age_hours: float | None = None,
) -> list[dict[str, Any]]:
    """Fill frontend screener rows with the latest stored snapshot metrics.

    This is intentionally allowed to read stale snapshots by default so weekend
    and market-holiday screens show the last available data instead of blank
    metric columns.
    """
    if not rows:
        return []
    tickers = [ticker for ticker in (_row_ticker(row) for row in rows) if ticker]
    snapshots = snapshot_by_ticker(tickers, max_age_hours=max_age_hours)
    if not snapshots:
        return rows
    enriched_rows: list[dict[str, Any]] = []
    for row in rows:
        ticker = _row_ticker(row)
        snapshot = snapshots.get(ticker or "")
        if not snapshot:
            enriched_rows.append(row)
            continue
        snapshot_row = frontend_metric_row(
            snapshot,
            row.get("stock") if isinstance(row.get("stock"), dict) else None,
            reason=row.get("reason"),
            score=row.get("score") if isinstance(row.get("score"), int) else None,
        )
        enriched_rows.append(_merge_metric_row(row, snapshot_row))
    return enriched_rows


def _with_derived_fields(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fill market cap and ROE where Yahoo leaves them blank.

    Market cap = enterprise value - debt + cash; on the stocks that report
    both it matches within 0.6% (median).

    Yahoo reports ROE for only ~5% of NSE names, which made every ROE screen
    return a handful of large caps. P/B divided by P/E is exactly
    EPS / book value per share, i.e. ROE on closing equity; on the stocks that
    do report ROE it lands within about one percentage point (median).

    Trailing P/E is set aside (kept as trailing_pe_raw) when the earnings
    behind it look broken or one-off; see _earnings_unreliable.
    """
    out: list[dict[str, Any]] = []
    for row in rows:
        if row.get("market_cap_cr") is None:
            # Yahoo drops marketCap for some names (TCS and Reliance among
            # them) while still reporting enterprise value, debt and cash.
            ev, debt, cash = (_num(row.get(k)) for k in ("enterprise_value", "total_debt", "total_cash"))
            if ev and debt is not None and cash is not None and ev - debt + cash > 0:
                cap = ev - debt + cash
                row = {**row, "market_cap": cap, "market_cap_cr": round(cap / 1e7, 4)}
        pe = _num(row.get("trailing_pe"))
        if pe is not None and _earnings_unreliable(row, pe):
            # Keep the raw figure for reference, but don't let one-off or
            # broken earnings top every "cheap" screen (ZF CV at P/E 2.5
            # against a forward P/E of 34; net margins of several thousand %).
            row = {**row, "trailing_pe": None, "trailing_pe_raw": pe}
            pe = None
        if row.get("roe") is None:
            pb = _num(row.get("price_to_book"))
            # Above ~100% the inputs are almost always distorted (one-off
            # income, tiny equity); Colgate and Nestle sit around 75-85%.
            if pb and pe and pe > 0 and pb > 0 and pb / pe * 100 <= 100:
                row = {**row, "roe": round(pb / pe * 100, 3)}
        out.append(row)
    return out


def _earnings_unreliable(row: dict[str, Any], pe: float) -> bool:
    if 0 <= pe < 3:
        return True
    forward = _num(row.get("forward_pe"))
    if forward and forward > 0 and pe > 0 and pe < forward / 3:
        return True
    # Profit above revenue means one-off gains, except at holding and
    # investment companies whose income is mostly dividends and associates.
    margin = _num(row.get("profit_margin"))
    return margin is not None and margin > 100 and row.get("sector") != "Financial Services"


def snapshot_available() -> bool:
    return supabase is not None


def get_snapshot_rows(
    tickers: list[str] | None = None,
    *,
    max_age_hours: float | None = SNAPSHOT_STALE_HOURS,
    force_refresh: bool = False,
) -> list[dict[str, Any]]:
    if supabase is None:
        return []
    now = time.time()
    if tickers is None and not force_refresh and now - float(_cache.get("ts") or 0) < _CACHE_TTL:
        rows = list(_cache.get("rows") or [])
    else:
        try:
            if tickers:
                rows: list[dict[str, Any]] = []
                clean = [ticker for ticker in tickers if ticker]
                for index in range(0, len(clean), 100):
                    response = supabase.table(SNAPSHOT_TABLE).select("*").in_("ticker", clean[index:index + 100]).execute()
                    rows.extend(getattr(response, "data", None) or [])
            else:
                rows = []
                start = 0
                page_size = 1000
                while True:
                    response = supabase.table(SNAPSHOT_TABLE).select("*").range(start, start + page_size - 1).execute()
                    page = getattr(response, "data", None) or []
                    rows.extend(page)
                    if len(page) < page_size:
                        break
                    start += page_size
                rows = _with_derived_fields(rows)
                _cache["rows"] = rows
                _cache["ts"] = now
            if tickers:
                rows = _with_derived_fields(rows)
        except Exception as exc:
            print(f"[Snapshot] stock_snapshot read failed: {exc}")
            return []
    if max_age_hours is None:
        return rows
    cutoff = datetime.now(timezone.utc).timestamp() - (max_age_hours * 3600)
    fresh_rows = []
    for row in rows:
        updated = str(row.get("updated_at") or "")
        try:
            ts = datetime.fromisoformat(updated.replace("Z", "+00:00")).timestamp()
        except Exception:
            ts = 0
        if ts >= cutoff:
            fresh_rows.append(row)
    return fresh_rows


def snapshot_by_ticker(tickers: list[str] | None = None, *, max_age_hours: float | None = SNAPSHOT_STALE_HOURS) -> dict[str, dict[str, Any]]:
    return {str(row.get("ticker")): row for row in get_snapshot_rows(tickers, max_age_hours=max_age_hours)}


def is_snapshot_stale(max_age_hours: float = SNAPSHOT_STALE_HOURS) -> bool:
    if supabase is None:
        return True
    try:
        response = supabase.table(SNAPSHOT_TABLE).select("updated_at").order("updated_at", desc=True).limit(1).execute()
        rows = getattr(response, "data", None) or []
        if not rows:
            return True
        latest = datetime.fromisoformat(str(rows[0]["updated_at"]).replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - latest).total_seconds() > max_age_hours * 3600
    except Exception as exc:
        print(f"[Snapshot] Staleness check failed: {exc}")
        return True


def upsert_snapshot_rows(rows: list[dict[str, Any]], chunk_size: int = 100) -> int:
    if supabase is None:
        raise RuntimeError("Supabase is not configured.")
    if not os.getenv("SUPABASE_SERVICE_ROLE_KEY"):
        raise RuntimeError("SUPABASE_SERVICE_ROLE_KEY is required to write stock_snapshot.")
    written = 0
    for index in range(0, len(rows), chunk_size):
        chunk = rows[index:index + chunk_size]
        supabase.table(SNAPSHOT_TABLE).upsert(chunk, on_conflict="ticker").execute()
        written += len(chunk)
    _cache["ts"] = 0.0
    return written


def load_frontend_stock_universe(repo_root: Path | None = None, exchange: str = "NSE") -> list[dict[str, Any]]:
    root = repo_root or Path(__file__).resolve().parents[3]
    stocks_file = root / "frontend" / "app" / "stocks.ts"
    text = stocks_file.read_text(encoding="utf-8")
    pattern = re.compile(
        r"\{\s*name:\s*'(?P<name>(?:\\'|[^'])*)',\s*symbol:\s*'(?P<symbol>(?:\\'|[^'])*)',\s*"
        r"exchange:\s*'(?P<exchange>[^']+)',\s*ticker:\s*'(?P<ticker>[^']+)',\s*currency:\s*'(?P<currency>[^']*)'",
        re.MULTILINE,
    )
    seen: set[str] = set()
    rows: list[dict[str, Any]] = []
    for match in pattern.finditer(text):
        stock = {key: value.replace("\\'", "'") for key, value in match.groupdict().items()}
        if stock["exchange"] != exchange:
            continue
        if stock["ticker"] in seen:
            continue
        seen.add(stock["ticker"])
        rows.append(stock)
    return rows


# ── Sector peer comparison ────────────────────────────────────────────────────
# A P/E of 17.9 means nothing on its own; against a sector median of 24.1 it
# means "cheaper than its peers". The snapshot already holds the same ~45 metrics
# for every stock, so this is a grouping over data we have, not a new fetch.

PEER_METRICS: dict[str, str] = {
    "trailing_pe": "P/E (trailing)",
    "price_to_book": "Price / book",
    "roe": "Return on equity %",
    "debt_to_equity": "Debt / equity",
    "operating_margin": "Operating margin %",
    "profit_margin": "Profit margin %",
    "revenue_growth": "Revenue growth %",
    "dividend_yield": "Dividend yield %",
}

# Metrics where a LOWER value is the better read, used to phrase the comparison.
LOWER_IS_BETTER = {"trailing_pe", "price_to_book", "debt_to_equity"}

MIN_PEERS_FOR_MEDIAN = 5


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def sector_peer_comparison(ticker: str, *, max_peers: int = 8) -> dict[str, Any]:
    """Compare one stock's fundamentals against the median of its sector.

    Returns `available: False` with a reason rather than raising, so the UI can
    say why there is no comparison (unknown sector, too few peers with data)
    instead of rendering an empty panel.
    """
    ticker = (ticker or "").strip()
    rows = get_snapshot_rows(max_age_hours=None) or []
    by_ticker = {str(row.get("ticker")): row for row in rows}
    subject = by_ticker.get(ticker)
    if subject is None:
        return {"available": False, "reason": "This stock is not in the daily snapshot yet.", "ticker": ticker}

    sector = subject.get("sector")
    if not sector:
        return {"available": False, "reason": "No sector recorded for this stock.", "ticker": ticker}

    peers = [
        row for row in rows
        if row.get("sector") == sector and str(row.get("ticker")) != ticker
    ]
    if len(peers) < MIN_PEERS_FOR_MEDIAN:
        return {
            "available": False,
            "reason": f"Only {len(peers)} other {sector} stocks in the snapshot — too few for a meaningful median.",
            "ticker": ticker,
            "sector": sector,
        }

    metrics = []
    for key, label in PEER_METRICS.items():
        value = _num(subject.get(key))
        peer_values = [v for v in (_num(row.get(key)) for row in peers) if v is not None]
        median = _median(peer_values)
        if value is None or median is None or len(peer_values) < MIN_PEERS_FOR_MEDIAN:
            continue
        # Percentile: share of peers this stock is above, so the UI can show
        # position in the sector, not just better/worse than the midpoint.
        below = sum(1 for v in peer_values if v < value)
        metrics.append({
            "key": key,
            "label": label,
            "value": round(value, 4),
            "median": round(median, 4),
            "peer_count": len(peer_values),
            "percentile": round(below / len(peer_values), 4),
            "lower_is_better": key in LOWER_IS_BETTER,
            "better_than_median": (value < median) if key in LOWER_IS_BETTER else (value > median),
        })

    if not metrics:
        return {
            "available": False,
            "reason": f"No comparable {sector} fundamentals in the snapshot.",
            "ticker": ticker,
            "sector": sector,
        }

    # A short peer list by market cap, so the reader can see who they are being
    # compared against rather than trusting an anonymous median.
    named = sorted(
        ({"ticker": p.get("ticker"), "symbol": p.get("symbol"), "name": p.get("name"),
          "market_cap_cr": _num(p.get("market_cap_cr")), "trailing_pe": _num(p.get("trailing_pe"))}
         for p in peers),
        key=lambda item: -(item["market_cap_cr"] or 0),
    )[:max_peers]

    return {
        "available": True,
        "ticker": ticker,
        "symbol": subject.get("symbol"),
        "sector": sector,
        "peer_count": len(peers),
        "metrics": metrics,
        "peers": named,
    }
