from __future__ import annotations

import json
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from concurrent.futures import TimeoutError as FuturesTimeout
from datetime import date
from statistics import median
from typing import Any, Literal

import numpy as np
import pandas as pd
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

from app.core.supabase_client import supabase
from app.services import llm_client, price_store, stock_snapshot_service


DISCLAIMER = (
    "Educational only: Bullseye is not a SEBI-registered investment advisor. "
    "These are your own educational strategy signals, not personalized advice. "
    "Backtests can be overfit; costs and slippage reduce returns; about 1 in 3 "
    "trades can lose. Signals are computed after close for the next morning's open."
)
INTRADAY_REJECT_MESSAGE = (
    "I can only run end-of-day strategies right now (signals computed after close, "
    "executed next morning). Intraday/live triggers aren't supported yet."
)

ALLOWED_FIELDS = {
    "gap_pct",
    "price_vs_vwap",
    "rsi",
    "price_vs_sma",
    "price_vs_ema",
    "pct_below_52w_high",
    "pct_above_52w_low",
    "volume_ratio",
    "change_pct",
}
ALLOWED_OPERATORS = {"<", "<=", ">", ">=", "between"}
DEFAULT_CAP = int(os.getenv("STRATEGY_BACKTEST_UNIVERSE_CAP", "60"))
DEFAULT_TIME_BUDGET = float(os.getenv("STRATEGY_BACKTEST_TIME_BUDGET_SEC", "18"))


class Predicate(BaseModel):
    field: str
    op: Literal["<", "<=", ">", ">=", "between"]
    value: float | None = None
    low: float | None = None
    high: float | None = None
    window: int | None = None

    @field_validator("field")
    @classmethod
    def validate_field(cls, value: str) -> str:
        clean = value.strip().lower()
        if clean not in ALLOWED_FIELDS:
            raise ValueError(f"Unsupported predicate field: {value}")
        return clean

    @model_validator(mode="after")
    def validate_values(self):
        if self.op == "between":
            if self.low is None or self.high is None:
                raise ValueError("between predicates require low and high.")
            if self.low > self.high:
                raise ValueError("between low must be <= high.")
        elif self.value is None:
            raise ValueError("predicate requires value.")
        if self.window is not None:
            self.window = max(2, min(int(self.window), 250))
        if self.field in {"price_vs_vwap", "rsi"} and self.window is None:
            self.window = 10 if self.field == "price_vs_vwap" else 14
        if self.field in {"price_vs_sma", "price_vs_ema"} and self.window is None:
            self.window = 20
        return self


class StrategyUniverse(BaseModel):
    exchange: Literal["NSE"] = "NSE"
    include_sectors: list[str] = Field(default_factory=list)
    exclude_sectors: list[str] = Field(default_factory=list)
    min_market_cap_cr: float | None = None
    max_market_cap_cr: float | None = None


class StrategyExecution(BaseModel):
    enter: Literal["next_day_open", "eod_close"] = "next_day_open"


class StrategyExit(BaseModel):
    stop_pct: float = 15
    target_pct: float | None = None
    max_hold_days: int = 20

    @model_validator(mode="after")
    def clamp_exit(self):
        self.stop_pct = max(0.5, min(float(self.stop_pct), 50))
        if self.target_pct is not None:
            self.target_pct = max(0.5, min(float(self.target_pct), 200))
        self.max_hold_days = max(1, min(int(self.max_hold_days), 120))
        return self


class StrategySpec(BaseModel):
    entry: list[Predicate]
    universe: StrategyUniverse = Field(default_factory=StrategyUniverse)
    execution: StrategyExecution = Field(default_factory=StrategyExecution)
    exit: StrategyExit = Field(default_factory=StrategyExit)

    @field_validator("entry")
    @classmethod
    def validate_entry(cls, value: list[Predicate]) -> list[Predicate]:
        if not value:
            raise ValueError("Add at least one supported entry condition.")
        if len(value) > 8:
            raise ValueError("Use at most 8 entry conditions.")
        return value


def strategy_to_dict(strategy: StrategySpec | dict[str, Any]) -> dict[str, Any]:
    if isinstance(strategy, StrategySpec):
        return strategy.model_dump()
    return StrategySpec.model_validate(strategy).model_dump()


def _extract_json(text: str) -> dict[str, Any]:
    clean = text.strip()
    if clean.startswith("```"):
        clean = re.sub(r"^```(?:json)?", "", clean, flags=re.IGNORECASE).strip()
        clean = re.sub(r"```$", "", clean).strip()
    match = re.search(r"\{.*\}", clean, re.DOTALL)
    if not match:
        raise ValueError("The strategy translator did not return JSON.")
    return json.loads(match.group(0))


def _fallback_translate(nl_text: str) -> dict[str, Any] | None:
    text = nl_text.lower()
    if re.search(r"\b(intraday|live|real[- ]?time|1[- ]?min|5[- ]?min|minute|hourly)\b", text):
        raise ValueError(INTRADAY_REJECT_MESSAGE)

    entry: list[dict[str, Any]] = []
    gap = re.search(r"gap\s+up\s+(\d+(?:\.\d+)?)\s*%?", text)
    if gap:
        entry.append({"field": "gap_pct", "op": ">=", "value": float(gap.group(1))})
    elif "gap up" in text:
        entry.append({"field": "gap_pct", "op": ">", "value": 0})

    vwap = re.search(r"(?:below|under)\s+(?:their\s+)?(\d+)[- ]?day\s+vwap", text)
    if vwap or "below" in text and "vwap" in text:
        entry.append({"field": "price_vs_vwap", "op": "<", "value": 0, "window": int(vwap.group(1)) if vwap else 10})

    rsi = re.search(r"rsi\s*(?:\((\d+)\))?\s*(<=|>=|<|>|between)\s*(-?\d+(?:\.\d+)?)", text)
    if rsi and rsi.group(2) != "between":
        entry.append({"field": "rsi", "op": rsi.group(2), "value": float(rsi.group(3)), "window": int(rsi.group(1) or 14)})

    change = re.search(r"(?:change|return)\s*(?:pct|%)?\s*(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)", text)
    if change:
        entry.append({"field": "change_pct", "op": change.group(1), "value": float(change.group(2))})

    # Plain English "buy when X% down, sell when Y% up" style rules.
    def _pct(*patterns: str) -> float | None:
        for pattern in patterns:
            m = re.search(pattern, text)
            if m:
                grp = next((g for g in m.groups() if g), None)
                if grp:
                    return float(grp)
        return None

    down_val = _pct(
        r"(\d+(?:\.\d+)?)\s*(?:percent|%)\s*(?:down|lower|drop|fall|decline|loss)",
        r"(?:down|drop|drops|fall|falls|decline|declines|lower)\s*(?:by\s*)?(\d+(?:\.\d+)?)\s*(?:percent|%)",
    )
    up_val = _pct(
        r"(\d+(?:\.\d+)?)\s*(?:percent|%)\s*(?:up|higher|rise|gain|profit)",
        r"(?:up|rise|rises|gain|gains|profit|higher)\s*(?:by\s*)?(\d+(?:\.\d+)?)\s*(?:percent|%)",
    )
    has_change = any(e.get("field") == "change_pct" for e in entry)
    target_override: float | None = None
    if down_val and not has_change:
        entry.append({"field": "change_pct", "op": "<=", "value": -abs(down_val)})
        has_change = True
    if up_val is not None:
        # "sell when up Y%" -> profit target; a bare "up Y%" with no down -> entry on strength.
        if down_val or "sell" in text or "target" in text or "profit" in text:
            target_override = abs(up_val)
        elif not entry:
            entry.append({"field": "change_pct", "op": ">=", "value": abs(up_val)})

    exclude: list[str] = []
    if "skip it" in text or "exclude it" in text:
        exclude.append("IT")
    if "skip metals" in text or "exclude metals" in text or "metals" in text:
        exclude.append("Metals")

    stop_match = re.search(r"(\d+(?:\.\d+)?)\s*%\s*stop", text)
    hold_match = re.search(r"hold\s+(\d+)\s+days?", text)
    target_match = re.search(r"(\d+(?:\.\d+)?)\s*%\s*target", text)
    enter = "eod_close" if re.search(r"\b(eod|close|same day close)\b", text) else "next_day_open"
    if not entry:
        return None
    return {
        "entry": entry,
        "universe": {"exchange": "NSE", "exclude_sectors": exclude},
        "execution": {"enter": enter},
        "exit": {
            "stop_pct": float(stop_match.group(1)) if stop_match else 15,
            "target_pct": float(target_match.group(1)) if target_match else target_override,
            "max_hold_days": int(hold_match.group(1)) if hold_match else 20,
        },
    }


def translate_strategy(nl_text: str) -> dict[str, Any]:
    if not nl_text or not nl_text.strip():
        raise ValueError("Type a strategy in plain English first.")
    if re.search(r"\b(intraday|live|real[- ]?time|1[- ]?min|5[- ]?min|minute|hourly)\b", nl_text, re.I):
        raise ValueError(INTRADAY_REJECT_MESSAGE)

    fallback = _fallback_translate(nl_text)
    if fallback is not None:
        return strategy_to_dict(fallback)

    if not llm_client.any_provider_available():
        raise ValueError("No LLM provider is configured, and this strategy did not match the supported offline patterns.")

    system = (
        "Translate end-of-day stock strategies into STRICT JSON only. "
        "Allowed fields: gap_pct, price_vs_vwap, rsi, price_vs_sma, price_vs_ema, "
        "pct_below_52w_high, pct_above_52w_low, volume_ratio, change_pct. "
        "Allowed ops: <, <=, >, >=, between. For price_vs_vwap/sma/ema use value 0 "
        "to mean price equals the indicator and window for n. Only NSE is supported. "
        "Reject intraday/live strategies."
    )
    example_user = "Buy NSE stocks that gap up 2% or more but are still below their 10-day VWAP, skip IT and Metals, buy next day open, 15% stop, hold 20 days."
    example_json = {
        "entry": [
            {"field": "gap_pct", "op": ">=", "value": 2},
            {"field": "price_vs_vwap", "op": "<", "value": 0, "window": 10},
        ],
        "universe": {"exchange": "NSE", "exclude_sectors": ["IT", "Metals"]},
        "execution": {"enter": "next_day_open"},
        "exit": {"stop_pct": 15, "target_pct": None, "max_hold_days": 20},
    }
    result = llm_client.chat(
        [
            {"role": "system", "content": system},
            {"role": "user", "content": example_user},
            {"role": "assistant", "content": json.dumps(example_json)},
            {"role": "user", "content": nl_text},
        ],
        temperature=0,
        max_tokens=900,
    )
    try:
        return strategy_to_dict(_extract_json(result["text"]))
    except (json.JSONDecodeError, ValidationError, ValueError) as exc:
        raise ValueError(f"I could not map that to the supported end-of-day strategy fields: {exc}") from exc


def _sector_matches(sector: str | None, wanted: list[str]) -> bool:
    if not wanted:
        return False
    clean = re.sub(r"[^a-z0-9]+", " ", str(sector or "").lower())
    aliases = {"it": "information technology", "metal": "metal", "metals": "metal"}
    for item in wanted:
        token = aliases.get(item.lower(), item.lower())
        if token in clean or item.lower() in clean:
            return True
    return False


def _fallback_universe(strategy: StrategySpec, cap: int) -> list[dict[str, Any]]:
    """Built-in liquid NSE universe (from the frontend catalog) so backtests work
    even before stock_snapshot is populated. Sector/market-cap filters need
    snapshot data, so they're skipped here; the catalog is ordered by liquidity."""
    try:
        stocks = stock_snapshot_service.load_frontend_stock_universe(exchange="NSE")
    except Exception as exc:  # noqa: BLE001
        print(f"[Strategy] fallback universe load failed: {exc}")
        return []
    out: list[dict[str, Any]] = []
    for stock in stocks:
        ticker = str(stock.get("ticker") or "")
        if not ticker:
            continue
        out.append({"ticker": ticker, "symbol": stock.get("symbol"), "name": stock.get("name")})
        if len(out) >= cap:
            break
    return out


def _snapshot_candidates(strategy: StrategySpec, cap: int) -> list[dict[str, Any]]:
    if supabase is None:
        return _fallback_universe(strategy, cap)
    try:
        response = (
            supabase.table("stock_snapshot")
            .select("*")
            .order("market_cap_cr", desc=True)
            .limit(max(cap * 3, cap))
            .execute()
        )
        rows = getattr(response, "data", None) or []
    except Exception as exc:
        print(f"[Strategy] stock_snapshot read failed: {exc}")
        return _fallback_universe(strategy, cap)

    uni = strategy.universe
    filtered = []
    for row in rows:
        ticker = str(row.get("ticker") or "")
        if uni.exchange == "NSE" and not ticker.endswith(".NS"):
            continue
        market_cap = row.get("market_cap_cr")
        try:
            market_cap = float(market_cap) if market_cap is not None else None
        except Exception:
            market_cap = None
        if uni.min_market_cap_cr is not None and (market_cap is None or market_cap < uni.min_market_cap_cr):
            continue
        if uni.max_market_cap_cr is not None and (market_cap is None or market_cap > uni.max_market_cap_cr):
            continue
        if uni.include_sectors and not _sector_matches(row.get("sector"), uni.include_sectors):
            continue
        if uni.exclude_sectors and _sector_matches(row.get("sector"), uni.exclude_sectors):
            continue
        filtered.append(row)
        if len(filtered) >= cap:
            break
    return filtered or _fallback_universe(strategy, cap)


def _prepare_indicators(df: pd.DataFrame) -> pd.DataFrame:
    frame = df.copy()
    frame.columns = [str(col).lower() for col in frame.columns]
    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    for col in ["open", "high", "low", "close", "volume"]:
        frame[col] = pd.to_numeric(frame[col], errors="coerce")
    frame = frame.dropna(subset=["date", "open", "high", "low", "close", "volume"]).sort_values("date").reset_index(drop=True)
    close = frame["close"]
    frame["gap_pct"] = ((frame["open"] - close.shift(1)) / close.shift(1)) * 100
    frame["change_pct"] = close.pct_change() * 100
    delta = close.diff()
    gain = delta.clip(lower=0).rolling(14).mean()
    loss = (-delta.clip(upper=0)).rolling(14).mean()
    rs = gain / loss.replace(0, np.nan)
    frame["rsi_14"] = 100 - (100 / (1 + rs))
    frame["high_52w"] = frame["high"].rolling(252, min_periods=60).max()
    frame["low_52w"] = frame["low"].rolling(252, min_periods=60).min()
    frame["pct_below_52w_high"] = ((frame["high_52w"] - close) / frame["high_52w"]) * 100
    frame["pct_above_52w_low"] = ((close - frame["low_52w"]) / frame["low_52w"]) * 100
    frame["volume_ratio"] = frame["volume"] / frame["volume"].rolling(20, min_periods=5).mean()
    for window in {10, 14, 20, 50, 200}:
        typical = (frame["high"] + frame["low"] + frame["close"]) / 3
        vol_sum = frame["volume"].rolling(window, min_periods=max(2, min(window, 10))).sum()
        frame[f"vwap_{window}"] = (typical * frame["volume"]).rolling(window, min_periods=max(2, min(window, 10))).sum() / vol_sum
        frame[f"sma_{window}"] = close.rolling(window, min_periods=max(2, min(window, 20))).mean()
        frame[f"ema_{window}"] = close.ewm(span=window, adjust=False, min_periods=max(2, min(window, 20))).mean()
    return frame


def _predicate_value(row: pd.Series, predicate: Predicate) -> float | None:
    field = predicate.field
    window = predicate.window or 0
    try:
        if field == "price_vs_vwap":
            indicator = row.get(f"vwap_{window}")
            return ((row["close"] - indicator) / indicator) * 100 if indicator else None
        if field == "price_vs_sma":
            indicator = row.get(f"sma_{window}")
            return ((row["close"] - indicator) / indicator) * 100 if indicator else None
        if field == "price_vs_ema":
            indicator = row.get(f"ema_{window}")
            return ((row["close"] - indicator) / indicator) * 100 if indicator else None
        if field == "rsi":
            return row.get(f"rsi_{window}") if f"rsi_{window}" in row else row.get("rsi14") or row.get("rsi_14")
        return row.get(field)
    except Exception:
        return None


def _compare(value: float | None, predicate: Predicate) -> bool:
    if value is None or pd.isna(value):
        return False
    target = predicate.value
    if predicate.op == "between":
        return predicate.low <= float(value) <= predicate.high  # type: ignore[operator]
    if target is None:
        return False
    if predicate.op == "<":
        return float(value) < target
    if predicate.op == "<=":
        return float(value) <= target
    if predicate.op == ">":
        return float(value) > target
    if predicate.op == ">=":
        return float(value) >= target
    return False


def _entry_ok(row: pd.Series, strategy: StrategySpec) -> bool:
    return all(_compare(_predicate_value(row, predicate), predicate) for predicate in strategy.entry)


def evaluate_snapshot_row(row: dict[str, Any], strategy_json: dict[str, Any]) -> bool:
    strategy = StrategySpec.model_validate(strategy_json)
    series = pd.Series(
        {
            **row,
            "close": row.get("price"),
            "vwap_10": row.get("vwap10"),
            "rsi_14": row.get("rsi14"),
            "volume_ratio": row.get("vol_ratio"),
            "pct_below_52w_high": (
                ((float(row["high_52w"]) - float(row["price"])) / float(row["high_52w"])) * 100
                if row.get("high_52w") and row.get("price") else None
            ),
            "pct_above_52w_low": (
                ((float(row["price"]) - float(row["low_52w"])) / float(row["low_52w"])) * 100
                if row.get("low_52w") and row.get("price") else None
            ),
        }
    )
    return _entry_ok(series, strategy)


def _simulate_one(df: pd.DataFrame, strategy: StrategySpec, ticker: str, symbol: str | None) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    frame = _prepare_indicators(df)
    trades: list[dict[str, Any]] = []
    recent: list[dict[str, Any]] = []
    last_dates = set(frame["date"].dt.date.dropna().tail(10).tolist())
    max_hold = strategy.exit.max_hold_days
    stop_pct = strategy.exit.stop_pct
    target_pct = strategy.exit.target_pct

    for idx in range(252 if len(frame) > 320 else 30, len(frame) - 1):
        signal_row = frame.iloc[idx]
        if not _entry_ok(signal_row, strategy):
            continue
        signal_date = signal_row["date"].date()
        if signal_date in last_dates:
            recent.append(
                {
                    "ticker": ticker,
                    "symbol": symbol,
                    "signal_date": str(signal_date),
                    "close": round(float(signal_row["close"]), 4),
                }
            )

        enter_idx = idx + 1 if strategy.execution.enter == "next_day_open" else idx
        if enter_idx >= len(frame):
            continue
        entry_row = frame.iloc[enter_idx]
        entry_price = float(entry_row["open"] if strategy.execution.enter == "next_day_open" else entry_row["close"])
        stop_price = entry_price * (1 - stop_pct / 100)
        target_price = entry_price * (1 + target_pct / 100) if target_pct else None
        exit_idx = min(enter_idx + max_hold, len(frame) - 1)
        exit_price = float(frame.iloc[exit_idx]["close"])
        exit_reason = "max_hold"
        for pos in range(enter_idx, min(enter_idx + max_hold, len(frame) - 1) + 1):
            row = frame.iloc[pos]
            if float(row["low"]) <= stop_price:
                exit_idx = pos
                exit_price = stop_price
                exit_reason = "stop"
                break
            if target_price is not None and float(row["high"]) >= target_price:
                exit_idx = pos
                exit_price = target_price
                exit_reason = "target"
                break
        trades.append(
            {
                "ticker": ticker,
                "symbol": symbol,
                "signal_date": str(signal_date),
                "entry_date": str(entry_row["date"].date()),
                "exit_date": str(frame.iloc[exit_idx]["date"].date()),
                "entry": round(entry_price, 4),
                "exit": round(exit_price, 4),
                "return_pct": round(((exit_price - entry_price) / entry_price) * 100, 4),
                "exit_reason": exit_reason,
            }
        )
    return trades, recent[-10:]


def _stats(trades: list[dict[str, Any]]) -> dict[str, Any]:
    returns = [float(t["return_pct"]) for t in trades]
    if not returns:
        return {
            "trades": 0,
            "win_rate": 0,
            "avg_return_per_trade": 0,
            "median_return": 0,
            "max_drawdown": 0,
        }
    equity = 1.0
    peak = 1.0
    max_dd = 0.0
    for ret in returns:
        equity *= 1 + ret / 100
        peak = max(peak, equity)
        max_dd = min(max_dd, ((equity - peak) / peak) * 100)
    return {
        "trades": len(returns),
        "win_rate": round(100 * sum(1 for r in returns if r > 0) / len(returns), 2),
        "avg_return_per_trade": round(float(np.mean(returns)), 4),
        "median_return": round(float(median(returns)), 4),
        "max_drawdown": round(max_dd, 4),
    }


def _load_prices(ticker: str) -> pd.DataFrame | None:
    """Cached Parquet first, then the full data_service chain (RAM -> Storage ->
    Postgres -> Yahoo). This lets backtests run even before Storage is migrated."""
    try:
        df = price_store.read_prices(ticker)
        if df is not None and len(df) >= 90:
            return df
    except Exception:  # noqa: BLE001
        pass
    try:
        from app.services.data_service import get_historical_data

        df = get_historical_data(ticker, days=500)
        if df is not None and len(df) >= 90:
            return df
    except Exception as exc:  # noqa: BLE001
        print(f"[Strategy] price load failed for {ticker}: {exc}")
    return None


def backtest_strategy(
    strategy_input: StrategySpec | dict[str, Any],
    *,
    cap: int | None = None,
    time_budget_sec: float | None = None,
) -> dict[str, Any]:
    strategy = StrategySpec.model_validate(strategy_input)
    cap = max(1, min(int(cap or DEFAULT_CAP), 120))
    deadline = time.time() + float(time_budget_sec or DEFAULT_TIME_BUDGET)
    candidates = _snapshot_candidates(strategy, cap)
    if not candidates:
        return {
            "stats": _stats([]),
            "alertable": False,
            "quality": {"alertable": False, "reason": "No NSE universe is available to scan right now. Please try again shortly."},
            "recent_signals": [],
            "scanned": 0,
            "partial": False,
            "note": "Market universe temporarily unavailable.",
            "disclaimer": DISCLAIMER,
        }

    all_trades: list[dict[str, Any]] = []
    recent: list[dict[str, Any]] = []
    scanned = 0
    partial = False
    # Prices load in parallel (one Storage read each); loading 60 stocks one
    # after another took most of the time budget on a small server.
    rows = [row for row in candidates if row.get("ticker")]
    pool = ThreadPoolExecutor(max_workers=8)
    try:
        futures = {pool.submit(_load_prices, str(row["ticker"])): row for row in rows}
        try:
            for future in as_completed(futures, timeout=max(0.1, deadline - time.time())):
                row = futures[future]
                df = future.result()
                if df is None or len(df) < 90:
                    continue
                trades, signals = _simulate_one(df, strategy, str(row["ticker"]), row.get("symbol"))
                all_trades.extend(trades)
                recent.extend(signals)
                scanned += 1
        except FuturesTimeout:
            partial = True
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

    all_trades.sort(key=lambda item: item["entry_date"])
    split = max(1, int(len(all_trades) * 0.7))
    oos = all_trades[split:] if len(all_trades) > 3 else []
    stats = _stats(all_trades)
    oos_stats = _stats(oos)
    alertable = (
        stats["trades"] >= 30
        and stats["avg_return_per_trade"] > 0
        and oos_stats["avg_return_per_trade"] > 0
        and stats["max_drawdown"] > -40
    )
    reason = (
        "Passes quality gate."
        if alertable
        else "Needs at least 30 trades, positive average return, positive out-of-sample average, and non-catastrophic drawdown."
    )
    return {
        "stats": stats,
        "out_of_sample": oos_stats,
        "alertable": alertable,
        "quality": {"alertable": alertable, "reason": reason},
        "recent_signals": sorted(recent, key=lambda item: item["signal_date"], reverse=True)[:10],
        "scanned": scanned,
        "universe_cap": cap,
        "partial": partial,
        "note": "Partial result: time budget reached." if partial else None,
        "disclaimer": DISCLAIMER,
    }


def backtest_nl_strategy(nl_text: str, time_budget_sec: float | None = None) -> dict[str, Any]:
    strategy_json = translate_strategy(nl_text)
    result = backtest_strategy(strategy_json, time_budget_sec=time_budget_sec)
    return {"strategy_json": strategy_json, **result}


def entry_plan(row: dict[str, Any], strategy_json: dict[str, Any]) -> dict[str, Any]:
    strategy = StrategySpec.model_validate(strategy_json)
    price = row.get("price")
    entry = float(price) if price is not None else None
    stop = round(entry * (1 - strategy.exit.stop_pct / 100), 4) if entry else None
    target = round(entry * (1 + strategy.exit.target_pct / 100), 4) if entry and strategy.exit.target_pct else None
    return {
        "entry": entry,
        "enter": strategy.execution.enter,
        "stop_pct": strategy.exit.stop_pct,
        "stop": stop,
        "target_pct": strategy.exit.target_pct,
        "target": target,
        "max_hold_days": strategy.exit.max_hold_days,
        "suggested_sizing": "Educational only; size positions according to your own risk limits.",
        "framing": "signals computed after close, for the next morning's open",
    }


def today_signal_date(row: dict[str, Any] | None = None) -> str:
    return str((row or {}).get("latest_date") or date.today().isoformat())[:10]
