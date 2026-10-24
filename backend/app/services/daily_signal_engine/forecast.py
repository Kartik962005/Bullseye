"""Daily stock forecasts for the Nifty 200: buy and sell calls with a likely price range.

For every stock, every evening, and each horizon h in (1, 3, 5) sessions:

    entry  = next session's open   (the first price anyone can act on)
    exit   = close of session h    (h = 1 is an intraday call: open to close)
    return = exit / entry - 1

Two things are forecast:

  * P(beat): the chance the stock's return beats the average Nifty 200 stock
    over the same window. Whether stocks rise at all mostly depends on the
    whole market's next move, which no model here could forecast (tested: no
    skill). Which stocks do better than the rest is where an edge exists.
    BUY calls are the highest P(beat); SELL calls (intraday only, as overnight
    shorts are not available in Indian cash equities) are the lowest.
  * The 10th / 50th / 90th percentile of the stock's own return: the likely
    range, widened by a factor fitted out of sample so 8 in 10 outcomes land
    inside it.

`forecast_frame` builds the features for training and for the live run alike,
so the model in use sees exactly what it was tested on.
"""
from __future__ import annotations

import json
import math
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .config import NSE_UNIVERSE, SECTOR_BY_SYMBOL
from .feature_engineering import build_feature_frame

HORIZONS = (1, 3, 5)
QUANTILES = (0.1, 0.5, 0.9)
DATA_DIR = Path(__file__).resolve().parent / "data"
ARTIFACT_DIR = Path(__file__).resolve().parent / "artifacts"
UNIVERSE_CSV = DATA_DIR / "forecast_universe.csv"
# Bars needed before a stock's features are complete (200-day average, 52-week high).
MIN_HISTORY_BARS = 270

# Per-stock state.
STOCK_BASE = [
    "close_to_ema20", "ema20_to_ema50", "close_to_sma200", "rsi", "adx", "atr_pct",
    "vol_ratio", "vol_trend", "dist_resistance_atr", "dist_support_atr",
    "ret1", "ret5", "ret10", "ret20", "ret60", "intraday_ret", "gap",
    "range_pct", "vol20", "vol60", "vol_regime", "close_location",
    "dist_52w_high", "dist_52w_low",
]
# Against the market and the stock's sector.
RELATIVE = [
    "rel_strength", "sector_strength", "ret5_vs_sector", "ret20_vs_sector",
    "sector_above_ema50", "sector_vs_market",
]
# Same-day percentile ranks across the universe: comparable in calm and wild markets.
RANKED = ["ret1", "ret5", "ret20", "ret60", "vol20", "dist_52w_high", "vol_ratio", "intraday_ret", "gap", "close_to_sma200"]
RANK_FEATURES = [f"rank_{name}" for name in RANKED]
# Market-wide state: the same for every stock on a day, so it cannot rank them,
# but it does widen or narrow the likely range.
MARKET = [
    "idx_ret5", "idx_ret20", "idx_to_ema50", "idx_vol20",
    "mkt_above_ema50", "mkt_above_ema20", "mkt_adv5", "mkt_breadth_chg",
]
CLASSIFIER_FEATURES = STOCK_BASE + RELATIVE + RANK_FEATURES
FORECAST_FEATURES = CLASSIFIER_FEATURES + MARKET


# ── Universe ──────────────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def load_universe() -> pd.DataFrame:
    """The stocks the engine forecasts (ticker, symbol, company, sector)."""
    if UNIVERSE_CSV.exists():
        return pd.read_csv(UNIVERSE_CSV)
    rows = [{"ticker": t, "symbol": t.replace(".NS", ""), "company": t.replace(".NS", ""),
             "sector": SECTOR_BY_SYMBOL.get(t.replace(".NS", ""), "General")} for t in NSE_UNIVERSE]
    return pd.DataFrame(rows)


def universe_tickers() -> list[str]:
    return list(load_universe()["ticker"])


@lru_cache(maxsize=1)
def _sector_map() -> dict[str, str]:
    return dict(zip(load_universe()["ticker"], load_universe()["sector"]))


def sector_of(ticker: str) -> str:
    return _sector_map().get(ticker) or SECTOR_BY_SYMBOL.get(ticker.replace(".NS", "").replace(".BO", ""), "General")


def company_of(ticker: str) -> str:
    match = load_universe().loc[lambda u: u["ticker"] == ticker, "company"]
    return str(match.iloc[0]) if len(match) else ticker.replace(".NS", "")


# ── Features ─────────────────────────────────────────────────────────────────

def _clean_raw(raw: pd.DataFrame) -> pd.DataFrame:
    """Drop weekend bars (special sessions such as Diwali Muhurat trading) and duplicates."""
    frame = raw.copy()
    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    frame = frame.dropna(subset=["date"])
    frame = frame[frame["date"].dt.dayofweek < 5]
    frame["day"] = frame["date"].dt.strftime("%Y-%m-%d")
    return frame.sort_values("date").drop_duplicates("day", keep="last").drop(columns="day").reset_index(drop=True)


def _stock_frame(ticker: str, raw: pd.DataFrame) -> pd.DataFrame:
    raw = _clean_raw(raw)
    if len(raw) < MIN_HISTORY_BARS:
        return pd.DataFrame()
    feats = build_feature_frame(raw)
    if feats.empty:
        return feats
    f = feats.sort_values("date").reset_index(drop=True)
    close = f["close"].astype(float)
    volume = f["volume"].astype(float)
    daily = close.pct_change()
    gap = f["open"] / close.shift(1) - 1
    jump = (daily.abs() > 0.25) | (gap.abs() > 0.2)
    vol20 = daily.rolling(20).std()
    vol60 = daily.rolling(60).std()
    return pd.DataFrame({
        "date": pd.to_datetime(f["date"]).dt.strftime("%Y-%m-%d"),
        "ticker": ticker,
        "sector": sector_of(ticker),
        "open": f["open"].astype(float),
        "high": f["high"].astype(float),
        "low": f["low"].astype(float),
        "close": close,
        "volume": volume,
        "close_to_ema20": close / f["ema20"] - 1,
        "ema20_to_ema50": f["ema20"] / f["ema50"] - 1,
        "close_to_sma200": close / close.rolling(200).mean() - 1,
        "rsi": f["rsi14"] / 100,
        "adx": f["adx14"] / 50,
        "atr_pct": f["atr14"] / close,
        "vol_ratio": volume / f["vol_avg20"].replace(0, np.nan),
        "vol_trend": volume.rolling(5).mean() / volume.rolling(60).mean().replace(0, np.nan),
        "dist_resistance_atr": (f["resistance20"] - close) / f["atr14"],
        "dist_support_atr": (close - f["support20"]) / f["atr14"],
        "ret1": daily,
        "ret5": close.pct_change(5),
        "ret10": close.pct_change(10),
        "ret20": close.pct_change(20),
        "ret60": close.pct_change(60),
        "intraday_ret": close / f["open"] - 1,
        "gap": gap,
        "range_pct": f["range_pct"],
        "vol20": vol20,
        "vol60": vol60,
        "vol_regime": vol20 / vol60.replace(0, np.nan),
        "close_location": (close - f["low"]) / (f["high"] - f["low"]).replace(0, np.nan),
        "dist_52w_high": close / f["high"].rolling(250, min_periods=200).max() - 1,
        "dist_52w_low": close / f["low"].rolling(250, min_periods=200).min() - 1,
        "above_ema50": (close > f["ema50"]).astype(float),
        "above_ema20": (close > f["ema20"]).astype(float),
        # A price jump this large is almost always a corporate action or a data
        # error; the stock is skipped for 60 sessions after one.
        "anomaly": jump.astype(float).rolling(60, min_periods=1).max(),
        "_ret21": close / close.shift(20) - 1,
    })


def _index_frame(index_raw: pd.DataFrame) -> pd.DataFrame:
    idx = _clean_raw(index_raw)
    close = idx["close"].astype(float)
    ema50 = close.ewm(span=50, adjust=False).mean()
    return pd.DataFrame({
        "date": idx["date"].dt.strftime("%Y-%m-%d"),
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
    horizons: tuple[int, ...] = (),
) -> pd.DataFrame:
    """One row per (ticker, date) with every feature.

    With `horizons` (training), adds `fwd_{h}`: the return from the next open
    to the close of session h, and `excess_{h}`: that return minus the average
    stock's over the same window.
    """
    parts = [_stock_frame(t, raw) for t, raw in price_frames.items()]
    parts = [p for p in parts if not p.empty]
    if not parts:
        return pd.DataFrame()
    df = pd.concat(parts, ignore_index=True)
    df = df.merge(_index_frame(index_raw), on="date", how="inner")

    df["rel_strength"] = (df["_ret21"] - df["_idx_ret21"]) * 100
    by_sector = df.groupby(["date", "sector"])
    df["sector_strength"] = by_sector["rel_strength"].transform("mean")
    df["ret5_vs_sector"] = df["ret5"] - by_sector["ret5"].transform("mean")
    df["ret20_vs_sector"] = df["ret20"] - by_sector["ret20"].transform("mean")
    df["sector_above_ema50"] = by_sector["above_ema50"].transform("mean")

    by_day = df.groupby("date").agg(
        mkt_above_ema50=("above_ema50", "mean"),
        mkt_above_ema20=("above_ema20", "mean"),
        mkt_adv5=("ret5", lambda s: float((s > 0).mean())),
    ).reset_index().sort_values("date")
    by_day["mkt_breadth_chg"] = by_day["mkt_above_ema50"].diff().fillna(0.0)
    df = df.merge(by_day, on="date", how="left")
    df["sector_vs_market"] = df["sector_above_ema50"] - df["mkt_above_ema50"]

    by_date = df.groupby("date")
    for name in RANKED:
        df[f"rank_{name}"] = by_date[name].rank(pct=True)

    df = df.sort_values(["ticker", "date"]).reset_index(drop=True)
    if horizons:
        grouped = df.groupby("ticker", sort=False)
        next_open = grouped["open"].shift(-1)
        for h in horizons:
            df[f"fwd_{h}"] = grouped["close"].shift(-h) / next_open - 1
            df[f"excess_{h}"] = df[f"fwd_{h}"] - df.groupby("date")[f"fwd_{h}"].transform("mean")
    df = df.replace([np.inf, -np.inf], np.nan)
    df = df.dropna(subset=FORECAST_FEATURES).reset_index(drop=True)
    return df.drop(columns=[c for c in df.columns if c.startswith("_")])


# ── Models ───────────────────────────────────────────────────────────────────

class EnsembleClassifier:
    """Average of several classifiers' P(beat), then isotonic calibration.

    Averaging models that make different mistakes (two boosted-tree variants
    and a regularised logistic regression on rank features) is steadier out of
    sample than any one of them. `score` is the raw average, used to break
    ties between stocks that calibration puts on the same step.
    """

    def __init__(self, members: list[tuple[Any, list[str]]], calibrator: Any):
        self.members = members
        self.calibrator = calibrator

    def score(self, rows: pd.DataFrame) -> np.ndarray:
        return np.mean([model.predict_proba(rows[cols])[:, 1] for model, cols in self.members], axis=0)

    def predict_proba(self, rows: pd.DataFrame) -> np.ndarray:
        p = np.clip(self.calibrator.predict(self.score(rows)), 0.001, 0.999)
        return np.column_stack([1 - p, p])


def widen(q: np.ndarray, scale: float) -> np.ndarray:
    """Stretch the 10/90 band around the median by `scale` (fitted out of sample)."""
    q = np.sort(q, axis=1)  # quantile models trained separately can cross; keep them ordered
    mid = q[:, 1]
    return np.column_stack([mid - (mid - q[:, 0]) * scale, mid, mid + (q[:, 2] - mid) * scale])


def calibrate_range(raw: np.ndarray, intercept: float, slope: float, scale: float) -> np.ndarray:
    """Correct the 10/50/90 band out of sample: pull the middle toward what really
    happened (middle = intercept + slope x predicted median), keep each side's
    width, then stretch the band by `scale`. All three factors are fitted on
    held-out data by scripts/calibrate_ranges.py."""
    raw = np.sort(raw, axis=1)
    mid = intercept + slope * raw[:, 1]
    low_width = raw[:, 1] - raw[:, 0]
    high_width = raw[:, 2] - raw[:, 1]
    return np.column_stack([mid - low_width * scale, mid, mid + high_width * scale])


def predict(artifact: dict[str, Any], rows: pd.DataFrame) -> pd.DataFrame:
    """P(beat), a tie-break score, and the 10/50/90 percentile return for each row."""
    out = rows[["ticker", "sector", "date", "close"]].copy()
    model: EnsembleClassifier = artifact["classifier"]
    out["rank_score"] = model.score(rows)
    out["p_beat"] = model.predict_proba(rows)[:, 1]
    q = np.column_stack([artifact["quantiles"][str(level)].predict(rows[FORECAST_FEATURES]) for level in QUANTILES])
    q = calibrate_range(
        q,
        float(artifact.get("center_intercept", 0.0)),
        float(artifact.get("center_slope", 1.0)),
        float(artifact.get("range_scale", 1.0)),
    )
    out["q10"], out["q50"], out["q90"] = q[:, 0], q[:, 1], q[:, 2]
    return out


# ── Publishing ───────────────────────────────────────────────────────────────

def bucket_evidence(p_beat: float, calibration: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    """How often stocks actually beat the market when testing gave a similar probability."""
    for bucket in calibration or []:
        if bucket["p_min"] <= p_beat < bucket["p_max"] or (p_beat >= bucket["p_max"] and bucket is calibration[-1]):
            return bucket
    return None


def display_probability(p: float, calibration: list[dict[str, Any]] | None) -> float:
    """Map the model's P(beat) onto what actually happened in out-of-sample testing.

    The calibration table (from the untouched confirmation half) records, per
    probability band, the model's average forecast and the real beat rate.
    The bands are made monotone (pool-adjacent-violators, weighted by sample
    count) and interpolated, so the number shown is the tested rate, not the
    model's opinion: the top bands run a little hot, and this removes that.
    Ranking is unchanged because the map is monotone.
    """
    points = sorted(
        (float(b["mean_p"]), float(b["actual_beat_rate"]), float(b["samples"]))
        for b in (calibration or [])
        if "mean_p" in b
    )
    if len(points) < 2:
        return p
    blocks = [[x, y, w] for x, y, w in points]
    merged: list[list[float]] = []
    for block in blocks:
        merged.append(block)
        while len(merged) > 1 and merged[-2][1] > merged[-1][1]:
            b2, b1 = merged.pop(), merged.pop()
            w = b1[2] + b2[2]
            merged.append([(b1[0] * b1[2] + b2[0] * b2[2]) / w, (b1[1] * b1[2] + b2[1] * b2[2]) / w, w])
    xs = [m[0] for m in merged]
    ys = [m[1] for m in merged]
    return float(np.interp(p, xs, ys)) if len(xs) > 1 else ys[0]


def describe(row: pd.Series, horizon: int, calibration: list[dict[str, Any]] | None, direction: str) -> dict[str, Any]:
    """Everything the app and email show for one call."""
    p_model = float(row["p_beat"])
    p_beat = display_probability(p_model, calibration)
    buy = direction == "BUY"
    close = float(row["close"])
    evidence = bucket_evidence(p_model, calibration)
    low, mid, high = (round(close * (1 + float(row[k])), 2) for k in ("q10", "q50", "q90"))
    return {
        "kind": "forecast",
        "horizon_days": horizon,
        "direction": direction,
        "p_beat": round(p_beat, 4),
        "p_model": round(p_model, 4),
        # The chance of the call itself: beating the market for a buy, lagging it for a sell.
        "p_call": round(p_beat if buy else 1 - p_beat, 4),
        "q10": round(float(row["q10"]), 5),
        "q50": round(float(row["q50"]), 5),
        "q90": round(float(row["q90"]), 5),
        "reference_close": round(close, 2),
        "low_price": low,
        "mid_price": mid,
        "high_price": high,
        # A risk line from the range: the 1-in-10 bad case for this call.
        "stop_price": low if buy else high,
        "tested": (
            {
                "p_min": evidence["p_min"],
                "p_max": evidence["p_max"],
                "call_rate": round(evidence["actual_beat_rate"] if buy else 1 - evidence["actual_beat_rate"], 4),
                "samples": evidence["samples"],
            }
            if evidence
            else None
        ),
    }


def context_notes(row: pd.Series) -> list[str]:
    """Plain facts about where the stock stands. Context for the reader, not the model's reasoning."""
    notes: list[str] = []
    ret20 = safe_float(row.get("ret20")) * 100
    rel = safe_float(row.get("rel_strength"))
    if abs(rel) >= 2:
        notes.append(f"{'Up' if ret20 >= 0 else 'Down'} {abs(ret20):.1f}% over 20 sessions, {'ahead of' if rel > 0 else 'behind'} the Nifty by {abs(rel):.1f} points")
    high = safe_float(row.get("dist_52w_high")) * 100
    if high > -3:
        notes.append("Trading near its 52-week high")
    elif high < -30:
        notes.append(f"{abs(high):.0f}% below its 52-week high")
    rsi = safe_float(row.get("rsi")) * 100
    if rsi >= 70:
        notes.append(f"RSI {rsi:.0f}: stretched after a strong run")
    elif rsi <= 30:
        notes.append(f"RSI {rsi:.0f}: heavily sold")
    to_200 = safe_float(row.get("close_to_sma200")) * 100
    notes.append(f"{abs(to_200):.1f}% {'above' if to_200 >= 0 else 'below'} its 200-day average")
    vol = safe_float(row.get("vol_ratio"), 1.0)
    if vol >= 1.6:
        notes.append(f"Volume {vol:.1f}x its 20-day average")
    return notes[:4]


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
        return default if math.isnan(number) or math.isinf(number) else number
    except (TypeError, ValueError):
        return default


# ── Artifacts ────────────────────────────────────────────────────────────────

_ARTIFACTS: dict[int, dict[str, Any] | None] = {}
_REPORTS: dict[int, dict[str, Any] | None] = {}


def load_artifact(horizon: int) -> dict[str, Any] | None:
    """The trained models for one horizon, or None if missing or unloadable."""
    horizon = int(horizon)
    if horizon not in _ARTIFACTS:
        path = ARTIFACT_DIR / f"forecast_h{horizon}.joblib"
        artifact = None
        try:
            import joblib

            artifact = joblib.load(path)
            if list(artifact.get("features") or []) != FORECAST_FEATURES:
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
                _REPORTS[horizon] = json.load(fh)
        except Exception:  # noqa: BLE001
            _REPORTS[horizon] = None
    return _REPORTS[horizon]

