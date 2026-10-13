from __future__ import annotations

import math
import os
import time
from pathlib import Path
from typing import Any

import pandas as pd


DEFAULT_MODEL_PATH = Path(__file__).resolve().parent / "artifacts" / "win_probability_model.joblib"
FEATURE_COLUMNS = [
    "close_to_ema20", "ema20_to_ema50", "rsi", "adx", "atr_pct", "vol_ratio",
    "dist_resistance_atr", "dist_support_atr", "ret5", "ret20", "range_pct",
    "rel_strength", "sector_strength", "regime_score",
    "regime_align_buy", "regime_align_sell", "dir_buy",
    "buy_score", "sell_score", "chart_setup_quality",
    "mkt_above_ema50", "mkt_above_ema20", "mkt_adv5", "mkt_breadth_chg",
    "sector_above_ema50", "sector_vs_market",
    "days_since_earnings", "days_to_earnings", "pre_earnings", "post_earnings",
]
_ARTIFACTS: dict[int, dict[str, Any] | None] = {}
_LOAD_ERRORS: dict[int, str] = {}
_REPORTS: dict[int, dict[str, Any] | None] = {}
_HIT_RATE_CACHE: dict[str, Any] = {"ts": 0.0, "rates": {}}
ARTIFACT_DIR = DEFAULT_MODEL_PATH.parent


def artifact_path_for_horizon(horizon_days: int) -> str:
    """One artifact per horizon, trained on the realistic limit-entry grading.

    The original win_probability_model.joblib was graded as if every trade
    filled at the better edge of the entry zone, so it is no longer loaded.
    """
    override = os.getenv(f"ML_MODEL_PATH_H{int(horizon_days)}")
    return str(override or ARTIFACT_DIR / f"win_probability_model_h{int(horizon_days)}.joblib")


def report_path_for_horizon(horizon_days: int) -> str:
    return str(ARTIFACT_DIR / f"model_report_h{int(horizon_days)}.json")


def load_model_report(horizon_days: int) -> dict[str, Any] | None:
    """Out-of-sample results written by scripts/train_ml.py, or None if untrained."""
    horizon_days = int(horizon_days)
    if horizon_days not in _REPORTS:
        report = None
        try:
            import json

            with open(report_path_for_horizon(horizon_days), encoding="utf-8") as fh:
                report = json.load(fh)
        except FileNotFoundError:
            report = None
        except Exception as exc:  # noqa: BLE001
            print(f"[ML] model report for {horizon_days}-day unreadable: {exc}")
        _REPORTS[horizon_days] = report
    return _REPORTS[horizon_days]


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _load_artifact(horizon_days: int = 5) -> dict[str, Any] | None:
    horizon_days = int(horizon_days)
    if horizon_days in _ARTIFACTS:
        return _ARTIFACTS[horizon_days]
    path = Path(artifact_path_for_horizon(horizon_days))
    if not path.exists():
        _LOAD_ERRORS[horizon_days] = f"model artifact not found at {path}"
        print(f"[ML] {horizon_days}-day model unavailable; using logistic fallback ({_LOAD_ERRORS[horizon_days]}).")
        _ARTIFACTS[horizon_days] = None
        return None
    try:
        import joblib

        artifact = joblib.load(path)
        columns = list(artifact.get("feature_columns") or [])
        if columns != list(FEATURE_COLUMNS):
            raise ValueError("artifact feature_columns do not match ml_dataset.FEATURE_COLUMNS")
        trained_for = int(artifact.get("hold_days") or 5)
        if trained_for != horizon_days:
            raise ValueError(f"artifact was trained for {trained_for} days, not {horizon_days}")
        _ARTIFACTS[horizon_days] = artifact
        print(f"[ML] Loaded {horizon_days}-day model artifact from {path}.")
        return artifact
    except Exception as exc:
        _LOAD_ERRORS[horizon_days] = str(exc)
        _ARTIFACTS[horizon_days] = None
        # Loud, and specific about the usual cause. This failure is silent by
        # design (callers fall back to a logistic approximation and keep
        # returning predictions), so a rebuilt machine once ran for weeks on the
        # fallback while the trained model never loaded. The banner exists so
        # that cannot happen again without somebody seeing it.
        hint = ""
        if "No module named" in str(exc) or "version" in str(exc).lower():
            try:
                import sklearn

                hint = (
                    f" This usually means the artifact was trained on a different scikit-learn "
                    f"than the installed {sklearn.__version__}. Retrain with "
                    f"scripts/train_ml.py, or install the version it was trained on."
                )
            except Exception:  # noqa: BLE001
                hint = " This usually means a scikit-learn version mismatch; retrain with scripts/train_ml.py."
        print("=" * 78)
        print(f"[ML] {horizon_days}-DAY MODEL NOT LOADED, running on the logistic fallback.{hint}")
        print(f"[ML] Reason: {exc}")
        print("[ML] Predictions will be materially worse than the backtested model.")
        print("=" * 78)
        return None


def horizon_status(horizon_days: int) -> dict[str, Any]:
    """Whether a horizon has a trained model and whether testing supports publishing it."""
    artifact = _load_artifact(horizon_days)
    report = load_model_report(horizon_days)
    publish = bool(report and report.get("publish"))
    return {
        "horizon_days": int(horizon_days),
        "has_model": artifact is not None,
        "publish": bool(artifact is not None and publish),
        "report": report,
        "load_error": _LOAD_ERRORS.get(int(horizon_days)),
    }


def model_status() -> dict[str, Any]:
    """Whether predictions are coming from the trained models or the fallback.

    Exposed so the running app can be asked, rather than the answer living only
    in a startup log nobody reads.
    """
    artifact = _load_artifact(5)
    try:
        import sklearn

        sklearn_version = sklearn.__version__
    except Exception:  # noqa: BLE001
        sklearn_version = "unknown"
    return {
        "using_trained_model": artifact is not None,
        "source": "model" if artifact is not None else "fallback",
        "load_error": _LOAD_ERRORS.get(5),
        "artifact_path": artifact_path_for_horizon(5),
        "artifact_exists": Path(artifact_path_for_horizon(5)).exists(),
        "sklearn_version": sklearn_version,
        "trained_with_sklearn": (artifact or {}).get("sklearn_version"),
        "feature_count": len(FEATURE_COLUMNS),
        "horizons": {
            h: {k: v for k, v in horizon_status(h).items() if k != "report"}
            for h in (1, 3, 5)
        },
    }


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or pd.isna(value):
            return default
        return float(value)
    except Exception:
        return default


def _num(row: Any, *names: str, default: float = 0.0) -> float:
    for name in names:
        try:
            if isinstance(row, dict) and name in row:
                return _safe_float(row.get(name), default)
            if hasattr(row, "__contains__") and name in row:
                return _safe_float(row[name], default)
        except Exception:
            continue
    return default


def build_live_feature_values(
    latest: Any,
    technical_setup: dict[str, Any],
    regime: dict[str, Any],
    *,
    relative_strength: float = 0.0,
    sector_strength: float = 0.0,
    market_breadth: dict[str, float] | None = None,
) -> dict[str, float]:
    """Build the runtime vector in the exact training feature order.

    Missing cross-sectional/earnings context is filled with neutral values so
    the model can still run on single-stock detail pages.
    """
    market_breadth = market_breadth or {}
    close = _num(latest, "close")
    ema20 = _num(latest, "ema20", "EMA_20", default=close)
    ema50 = _num(latest, "ema50", "EMA_50", default=ema20)
    atr = _num(latest, "atr14", "ATR_14")
    volume = _num(latest, "volume")
    vol_avg20 = _num(latest, "vol_avg20", "VOL_SMA_20", default=volume)
    resistance = _num(latest, "resistance20", default=_num(latest, "high", default=close))
    support = _num(latest, "support20", default=_num(latest, "low", default=close))
    values = {
        "close_to_ema20": (close / ema20 - 1) if ema20 else 0.0,
        "ema20_to_ema50": (ema20 / ema50 - 1) if ema50 else 0.0,
        "rsi": _num(latest, "rsi14", "RSI_14", default=50.0) / 100,
        "adx": _num(latest, "adx14", default=20.0) / 50,
        "atr_pct": (atr / close) if close else 0.0,
        "vol_ratio": (volume / vol_avg20) if vol_avg20 else 1.0,
        "dist_resistance_atr": ((resistance - close) / atr) if atr else 0.0,
        "dist_support_atr": ((close - support) / atr) if atr else 0.0,
        "ret5": _num(latest, "ret5"),
        "ret20": _num(latest, "ret20"),
        "range_pct": _num(latest, "range_pct", default=((_num(latest, "high") - _num(latest, "low")) / close if close else 0.0)),
        "rel_strength": float(relative_strength),
        "sector_strength": float(sector_strength),
        "regime_score": float(regime.get("score", 0.5)),
        "regime_align_buy": float(regime.get("alignment_buy", 0.5)),
        "regime_align_sell": float(regime.get("alignment_sell", 0.5)),
        "dir_buy": 1.0 if technical_setup.get("direction") == "BUY" else 0.0,
        "buy_score": float(technical_setup.get("buy_score", 0.0)),
        "sell_score": float(technical_setup.get("sell_score", 0.0)),
        "chart_setup_quality": float(technical_setup.get("chart_setup_quality", 0.5)),
        "mkt_above_ema50": float(market_breadth.get("mkt_above_ema50", 0.5)),
        "mkt_above_ema20": float(market_breadth.get("mkt_above_ema20", 0.5)),
        "mkt_adv5": float(market_breadth.get("mkt_adv5", 0.5)),
        "mkt_breadth_chg": float(market_breadth.get("mkt_breadth_chg", 0.0)),
        "sector_above_ema50": float(market_breadth.get("sector_above_ema50", 0.5)),
        "sector_vs_market": float(market_breadth.get("sector_vs_market", 0.0)),
        "days_since_earnings": 1.0,
        "days_to_earnings": 1.0,
        "pre_earnings": 0.0,
        "post_earnings": 0.0,
    }
    return {column: float(values.get(column, 0.0)) for column in FEATURE_COLUMNS}


def _fallback_probabilities(
    technical_setup: dict[str, Any],
    regime: dict[str, Any],
    risk_level: str,
    relative_strength: float,
    quality_score: float,
) -> dict[str, float]:
    direction = technical_setup["direction"]
    regime_alignment = regime["alignment_buy"] if direction == "BUY" else regime["alignment_sell"]
    directional_strength = technical_setup["buy_score"] if direction == "BUY" else technical_setup["sell_score"]
    base_logit = (
        -0.22
        + directional_strength * 0.24
        + regime_alignment * 0.9
        + quality_score * 0.75
        + abs(relative_strength) * 0.018
    )
    if risk_level == "Conservative":
        base_logit -= 0.08
    elif risk_level == "Aggressive":
        base_logit += 0.05
    p_win = _clamp(1 / (1 + math.exp(-base_logit)), 0.35, 0.83)
    p_loss = _clamp(0.62 - p_win, 0.1, 0.42)
    return {"p_win": p_win, "p_loss": p_loss, "expected_return": 0.0}


def _expected_return_from_bins(p_win: float, bins: list[dict[str, Any]] | None) -> float:
    if not bins:
        return (p_win - 0.5) * 2.0
    for item in bins:
        if float(item.get("p_min", 0)) <= p_win <= float(item.get("p_max", 1)):
            return float(item.get("mean_realized_r", 0.0))
    nearest = min(bins, key=lambda item: abs(float(item.get("mean_p_win", 0.5)) - p_win))
    return float(nearest.get("mean_realized_r", 0.0))


def _realized_hit_rates() -> dict[str, dict[str, float]]:
    now = time.time()
    if now - float(_HIT_RATE_CACHE.get("ts") or 0) < 600:
        return dict(_HIT_RATE_CACHE.get("rates") or {})
    rates: dict[str, dict[str, float]] = {}
    try:
        from app.core.supabase_client import supabase

        signal_rows = (
            supabase.table("stock_signals")
            .select("id,setup_type")
            .order("run_date", desc=True)
            .limit(800)
            .execute()
        )
        outcome_rows = (
            supabase.table("signal_outcomes")
            .select("stock_signal_id,outcome")
            .limit(800)
            .execute()
        )
        setup_by_id = {row["id"]: row.get("setup_type") or "mixed_setup" for row in getattr(signal_rows, "data", None) or []}
        counts: dict[str, dict[str, int]] = {}
        for row in getattr(outcome_rows, "data", None) or []:
            setup = setup_by_id.get(row.get("stock_signal_id"))
            if not setup or row.get("outcome") == "NO_FILL":
                continue  # an order that never filled is not a trade
            counts.setdefault(setup, {"wins": 0, "trades": 0})
            counts[setup]["trades"] += 1
            if row.get("outcome") == "WIN":
                counts[setup]["wins"] += 1
        rates = {
            setup: {"hit_rate": vals["wins"] / vals["trades"], "trades": vals["trades"]}
            for setup, vals in counts.items()
            if vals["trades"]
        }
    except Exception as exc:
        print(f"[ML] Outcome hit-rate calibration unavailable: {exc}")
    _HIT_RATE_CACHE["ts"] = now
    _HIT_RATE_CACHE["rates"] = rates
    return rates


def _historical_hit_rate(setup_type: str | None) -> tuple[float, int]:
    if not setup_type:
        return 0.52, 0
    rate = _realized_hit_rates().get(setup_type)
    if not rate:
        return 0.52, 0
    trades = int(rate.get("trades") or 0)
    raw = float(rate.get("hit_rate") or 0.52)
    smoothed = (raw * trades + 0.52 * 20) / max(1, trades + 20)
    return _clamp(smoothed, 0.25, 0.8), trades


def predict_signal_probabilities(
    technical_setup: dict[str, Any],
    regime: dict[str, Any],
    risk_level: str,
    relative_strength: float,
    quality_score: float,
    *,
    feature_values: dict[str, float] | None = None,
    setup_type: str | None = None,
    horizon_days: int = 5,
) -> dict[str, float | str | int]:
    artifact = _load_artifact(horizon_days)
    path_used = "fallback"
    expected_return = 0.0
    if artifact and feature_values:
        try:
            features = pd.DataFrame([[float(feature_values[column]) for column in artifact["feature_columns"]]], columns=artifact["feature_columns"])
            p_win = float(artifact["model"].predict_proba(features)[0][1])
            expected_return = _expected_return_from_bins(p_win, artifact.get("return_calibration"))
            p_loss = _clamp(1.0 - p_win, 0.05, 0.95)
            path_used = "model"
        except Exception as exc:
            print(f"[ML] Model inference failed; using logistic fallback ({exc}).")
            fallback = _fallback_probabilities(technical_setup, regime, risk_level, relative_strength, quality_score)
            p_win = fallback["p_win"]
            p_loss = fallback["p_loss"]
            expected_return = fallback["expected_return"]
    else:
        fallback = _fallback_probabilities(technical_setup, regime, risk_level, relative_strength, quality_score)
        p_win = fallback["p_win"]
        p_loss = fallback["p_loss"]
        expected_return = fallback["expected_return"]

    p_win = _clamp(p_win, 0.05, 0.95)
    p_loss = _clamp(p_loss, 0.03, 0.92)
    p_neutral = max(0.03, 1 - p_win - p_loss)
    if p_win + p_loss + p_neutral > 1:
        scale = 0.97 / (p_win + p_loss)
        p_win *= scale
        p_loss *= scale
        p_neutral = 0.03

    direction = technical_setup["direction"]
    regime_alignment = regime["alignment_buy"] if direction == "BUY" else regime["alignment_sell"]
    model_stability = _clamp(0.50 + quality_score * 0.28 + regime_alignment * 0.14, 0.35, 0.96)
    hit_rate, hit_rate_trades = _historical_hit_rate(setup_type or technical_setup.get("setup_type"))
    confidence = _clamp(0.50 * p_win + 0.30 * hit_rate + 0.20 * model_stability, 0.0, 0.99)
    return {
        "calibrated_pwin": round(p_win, 6),
        "p_loss": round(p_loss, 6),
        "p_neutral": round(p_neutral, 6),
        "model_stability": round(model_stability, 6),
        "confidence": round(confidence, 6),
        "expected_return": round(expected_return, 6),
        "model_path": path_used,
        "horizon_days": int(horizon_days),
        "historical_hit_rate": round(hit_rate, 6),
        "historical_hit_rate_trades": hit_rate_trades,
    }
