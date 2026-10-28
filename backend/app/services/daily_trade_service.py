from __future__ import annotations

import base64
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
import hashlib
import hmac
import json
import os
import secrets
import threading
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

import pandas as pd

from app.core.supabase_client import supabase
from app.services.alert_service import _send_email
from app.services.daily_signal_engine import (
    DEFAULT_CONSENT_VERSION,
    adjusted_win_rate,
    build_feature_frame,
    build_live_feature_values,
    build_signal_email,
    compute_expected_r,
    compute_final_score,
    detect_market_regime,
    diversify_candidates,
    HOLD_SESSIONS,
    evaluate_signal_outcome_window,
    evaluate_technical_setup,
    fetch_market_context,
    get_universe,
    predict_signal_probabilities,
    validate_candidate_frame,
    wilson_lower_bound_placeholder,
)
from app.services.daily_signal_engine.config import (
    COMPANY_NAME_BY_SYMBOL,
    DEFAULT_EMAIL_TIME,
    DEFAULT_MARKET,
    DEFAULT_RISK_LEVEL,
    DEFAULT_SIGNAL_TYPE,
    DEFAULT_K_SMOOTHING,
    MARKET_CLOSES,
    MARKET_INDEX,
    MAX_SELECTED_SIGNALS,
    MIN_EMAIL_AFTER_CLOSE_MINUTES,
    RISK_PROFILES,
    SECTOR_BY_SYMBOL,
    UNIVERSE_AVERAGE_WIN_RATE,
    HORIZONS,
    horizon_barrier_scale,
    horizon_from_signal_type,
    signal_type_for_horizon,
)
from app.services.daily_signal_engine.data_ingestion import fetch_price_history, get_symbol_metadata
from app.services.daily_signal_engine import forecast as forecast_engine
from app.services.daily_signal_engine import market_calendar
from app.services.daily_signal_engine.ml_interface import horizon_status


IST = ZoneInfo("Asia/Kolkata")
PREFERENCE_TABLE = "notification_preferences"
MODEL_RUNS_TABLE = "model_runs"
SIGNALS_TABLE = "stock_signals"
OUTCOMES_TABLE = "signal_outcomes"
EMAIL_LOGS_TABLE = "email_logs"
AUDIT_LOGS_TABLE = "audit_logs"

_MEMORY_PREFERENCES: dict[str, dict[str, Any]] = {}
_MEMORY_RUNS: list[dict[str, Any]] = []
_MEMORY_SIGNALS: list[dict[str, Any]] = []
_MEMORY_OUTCOMES: list[dict[str, Any]] = []
_MEMORY_EMAIL_LOGS: list[dict[str, Any]] = []

# Shared with training (config.py) so both see the same publishable setups.
from app.services.daily_signal_engine.config import (  # noqa: E402
    MIN_CHART_SETUP_QUALITY,
    MIN_DIRECTIONAL_EDGE,
    entry_zone,
)
MIN_EXPECTED_R = float(os.getenv("DAILY_MIN_EXPECTED_R", "0.08"))
# Absolute floor only. The real gate is derived from each setup's reward:risk
# (see _build_candidate) — a hit rate is meaningless without the payoff it is
# being paid at. This is the "something is broken" backstop: below 30% no
# plausible reward:risk in these profiles produces positive expectancy.
# It was 0.45, which silently rejected every signal once real outcomes existed.
MIN_HISTORICAL_HIT_RATE = float(os.getenv("DAILY_MIN_HISTORICAL_HIT_RATE", "0.30"))
MIN_HISTORICAL_TRADES_FOR_REJECTION = int(os.getenv("DAILY_MIN_HIT_RATE_TRADES", "10"))
# "ranked" (default): keep every structurally-sound setup and let final-score
# ranking + top-N pick the day's best — this is the selection the walk-forward
# backtest validated as positive-expectancy. "threshold": also apply the hard
# confidence/expected-R/final-score floors (can legitimately yield 0 signals on
# weak days). The honest model's confidence rarely clears the old hard floors,
# so a hard floor would otherwise leave daily emails empty most days.
DAILY_SELECTION_MODE = os.getenv("DAILY_SELECTION_MODE", "ranked").strip().lower()
# Confidence at/above which a ranked pick is framed as genuinely high-conviction.
DAILY_HIGH_CONVICTION_CONFIDENCE = float(os.getenv("DAILY_HIGH_CONVICTION_CONFIDENCE", "0.5"))


def _conviction_for_signals(signals: list[dict[str, Any]]) -> dict[str, Any]:
    """Honest day-level conviction label so the UI/email never overpromises.

    Markets are not always tradable; on weak days the right answer is "sit out".
    """
    if not signals:
        return {
            "level": "none",
            "top_confidence": 0.0,
            "positive_ev_count": 0,
            "note": "No setups cleared today's filters. The honest call is to sit out today.",
        }
    top_conf = max(float(s.get("confidence") or 0.0) for s in signals)
    positive_ev = sum(1 for s in signals if float(s.get("expected_r") or 0.0) > 0)
    if top_conf >= DAILY_HIGH_CONVICTION_CONFIDENCE and positive_ev:
        level = "high"
        note = "Several setups cleared a high-conviction bar today."
    elif top_conf >= DAILY_HIGH_CONVICTION_CONFIDENCE or positive_ev:
        level = "moderate"
        note = "These are today's best-ranked setups, but conviction is moderate, so size conservatively."
    else:
        level = "low"
        note = (
            "Market conditions are weak today. These are only the best-ranked setups available; "
            "overall conviction is low, so trade small or sit out."
        )
    return {
        "level": level,
        "top_confidence": round(top_conf, 4),
        "positive_ev_count": positive_ev,
        "note": note,
    }


def _is_missing_table_error(exc: Exception, table_name: str | None = None) -> bool:
    message = str(exc)
    if "PGRST205" not in message and "schema cache" not in message.lower():
        return False
    if not table_name:
        return True
    return table_name in message


def _should_use_memory_fallback(exc: Exception, table_name: str | None = None) -> bool:
    if _is_missing_table_error(exc, table_name):
        return True
    message = str(exc).lower()
    return (
        "connecterror" in message
        or "connection refused" in message
        or "timed out" in message
        or "forbidden by its access permissions" in message
        or "network is unreachable" in message
    )


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_now_iso() -> str:
    return _utc_now().isoformat()


def _today_ist() -> date:
    return datetime.now(IST).date()


def _holiday_set() -> set[str]:
    return market_calendar.holidays()


def _is_market_holiday(day: date) -> bool:
    return not market_calendar.is_trading_day(day)


def _next_trading_day(from_day: date | None = None) -> date:
    current = (from_day or _today_ist()) + timedelta(days=1)
    while _is_market_holiday(current):
        current += timedelta(days=1)
    return current


def _previous_trading_day(from_day: date | None = None) -> date:
    current = (from_day or _today_ist()) - timedelta(days=1)
    while _is_market_holiday(current):
        current -= timedelta(days=1)
    return current


def _parse_time_string(value: str | None) -> time:
    clean = (value or DEFAULT_EMAIL_TIME).strip()
    # A Postgres time column comes back as "20:00:00"; the form sends "20:00".
    for fmt in ("%H:%M", "%H:%M:%S"):
        try:
            return datetime.strptime(clean, fmt).time()
        except ValueError:
            continue
    return datetime.strptime(clean[:5], "%H:%M").time()


def _public_backend_base_url() -> str:
    return (
        os.getenv("PUBLIC_BACKEND_BASE_URL")
        or os.getenv("BACKEND_PUBLIC_URL")
        or "http://127.0.0.1:8000"
    ).rstrip("/")


def _unsubscribe_secret() -> str:
    return os.getenv("UNSUBSCRIBE_TOKEN_SECRET") or os.getenv("ALERT_ADMIN_KEY") or "dev-unsubscribe-secret"


def _default_preference(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "user_id": user["id"],
        "email": user.get("email"),
        "daily_stock_email_enabled": False,
        "market": DEFAULT_MARKET,
        "risk_level": DEFAULT_RISK_LEVEL,
        "email_time": DEFAULT_EMAIL_TIME,
        "signal_type": DEFAULT_SIGNAL_TYPE,
        "consent_version": None,
        "consent_accepted_at": None,
        "unsubscribed_at": None,
        "unsubscribe_nonce": None,
        "unsubscribe_token_hash": None,
        "created_at": _utc_now_iso(),
        "updated_at": _utc_now_iso(),
    }


def _supabase_required():
    if not supabase:
        raise ValueError("Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")
    return supabase


def _normalize_market(value: str | None) -> str:
    # Bullseye covers Indian equities only. BSE used the same NSE universe and
    # the US option is gone, so older rows with either resolve to NSE.
    market = (value or DEFAULT_MARKET).upper()
    if market not in MARKET_CLOSES:
        raise ValueError("Unsupported market.")
    return "NSE"


def _normalize_risk(value: str | None) -> str:
    risk = (value or DEFAULT_RISK_LEVEL).strip().title()
    if risk not in RISK_PROFILES:
        raise ValueError("Risk level must be Conservative, Balanced, or Aggressive.")
    return risk


def _normalize_signal_type(value: str | None) -> str:
    """The signal type now names the holding period: '1-day', '3-day' or '5-day'.

    Older values ('Next-day swing', 'Intraday', 'Both') were all graded as
    5-session trades, so they become '5-day'.
    """
    return signal_type_for_horizon(horizon_from_signal_type(value or DEFAULT_SIGNAL_TYPE))


def _session_complete(now: datetime | None = None) -> bool:
    """True once today's session has closed and its bar is final (or no session today)."""
    now = now or datetime.now(IST)
    if _is_market_holiday(now.date()):
        return True
    close = MARKET_CLOSES.get(DEFAULT_MARKET, time(15, 30))
    settled = (datetime.combine(now.date(), close) + timedelta(minutes=MIN_EMAIL_AFTER_CLOSE_MINUTES)).time()
    return now.time() >= settled


_SESSION_OPENS = time(9, 15)


def _session_started(now: datetime | None = None) -> bool:
    """True from the open of a trading day until its close is settled."""
    now = now or datetime.now(IST)
    return not _is_market_holiday(now.date()) and now.time() >= _SESSION_OPENS and not _session_complete(now)


def _current_session_date(now: datetime | None = None) -> date:
    """The session the picks on screen are for: today until the close, then the next one."""
    now = now or datetime.now(IST)
    today = now.date()
    close = MARKET_CLOSES.get(DEFAULT_MARKET, time(15, 30))
    if not _is_market_holiday(today) and now.time() < close:
        return today
    return _next_trading_day(today)


def _last_completed_session(now: datetime | None = None) -> date:
    """The latest session whose daily bar is final, which is the data a run uses."""
    now = now or datetime.now(IST)
    today = now.date()
    if not _is_market_holiday(today) and _session_complete(now):
        return today
    return _previous_trading_day(today)


def _normalize_delivery_mode(value: str | None) -> str:
    mode = (value or "next_day").strip().lower().replace("-", "_").replace(" ", "_")
    if mode in {"today", "same_day", "intraday_today"}:
        return "today"
    return "next_day"


def _coerce_email_time(value: str | None) -> str:
    try:
        return _parse_time_string(value).strftime("%H:%M")
    except Exception:
        return DEFAULT_EMAIL_TIME


def _validate_email_time(market: str, value: str | None) -> str:
    parsed = _parse_time_string(value)
    close_time = MARKET_CLOSES[market]
    minimum = datetime.combine(date.today(), close_time) + timedelta(minutes=MIN_EMAIL_AFTER_CLOSE_MINUTES)
    preferred = datetime.combine(date.today(), parsed)
    if preferred < minimum:
        minimum_value = minimum.time().strftime("%H:%M")
        raise ValueError(f"Preferred email time must be after the market closes. Choose {minimum_value} IST or later.")
    return parsed.strftime("%H:%M")


def _build_unsubscribe_token(user_id: str, nonce: str) -> str:
    payload = f"{user_id}:{nonce}"
    signature = hmac.new(_unsubscribe_secret().encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    token_bytes = f"{payload}:{signature}".encode("utf-8")
    return base64.urlsafe_b64encode(token_bytes).decode("utf-8").rstrip("=")


def _decode_unsubscribe_token(token: str) -> tuple[str, str]:
    padded = token + "=" * (-len(token) % 4)
    decoded = base64.urlsafe_b64decode(padded.encode("utf-8")).decode("utf-8")
    user_id, nonce, signature = decoded.split(":", 2)
    payload = f"{user_id}:{nonce}"
    expected = hmac.new(_unsubscribe_secret().encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise ValueError("Invalid unsubscribe token.")
    return user_id, nonce


def _ensure_unsubscribe_token_fields(preference: dict[str, Any]) -> dict[str, Any]:
    if preference.get("unsubscribe_nonce"):
        return preference
    nonce = secrets.token_urlsafe(18)
    token = _build_unsubscribe_token(preference["user_id"], nonce)
    preference["unsubscribe_nonce"] = nonce
    preference["unsubscribe_token_hash"] = hashlib.sha256(token.encode("utf-8")).hexdigest()
    return preference


def _unsubscribe_url(preference: dict[str, Any]) -> str:
    preference = _ensure_unsubscribe_token_fields(preference)
    token = _build_unsubscribe_token(preference["user_id"], preference["unsubscribe_nonce"])
    return f"{_public_backend_base_url()}/api/v1/unsubscribe?token={token}"


def _log_audit(action: str, entity_type: str, payload: dict[str, Any], user_id: str | None = None, entity_id: str | None = None):
    record = {
        "id": str(uuid4()),
        "user_id": user_id,
        "action": action,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "payload": payload,
        "created_at": _utc_now_iso(),
    }
    if supabase:
        try:
            supabase.table(AUDIT_LOGS_TABLE).insert(record).execute()
            return
        except Exception as exc:
            if _should_use_memory_fallback(exc, AUDIT_LOGS_TABLE):
                print(f"[DailySignals] audit log table missing, using in-memory fallback: {exc}")
                return record
            print(f"[DailySignals] audit log failed: {exc}")
    return record


def _fetch_preference_row(user_id: str) -> dict[str, Any] | None:
    if supabase:
        try:
            response = (
                supabase.table(PREFERENCE_TABLE)
                .select("*")
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
            rows = getattr(response, "data", None) or []
            return rows[0] if rows else None
        except Exception as exc:
            if _should_use_memory_fallback(exc, PREFERENCE_TABLE):
                print(f"[DailySignals] notification preferences table missing, using in-memory fallback: {exc}")
                return _MEMORY_PREFERENCES.get(user_id)
            raise
    return _MEMORY_PREFERENCES.get(user_id)


def get_notification_preference(user: dict[str, Any]) -> dict[str, Any]:
    row = _fetch_preference_row(user["id"]) or _default_preference(user)
    row.setdefault("email", user.get("email"))
    row.setdefault("market", DEFAULT_MARKET)
    row.setdefault("risk_level", DEFAULT_RISK_LEVEL)
    row.setdefault("email_time", DEFAULT_EMAIL_TIME)
    row.setdefault("signal_type", DEFAULT_SIGNAL_TYPE)
    row.setdefault("daily_stock_email_enabled", False)
    return row


def _upsert_preference(preference: dict[str, Any]) -> dict[str, Any]:
    preference["updated_at"] = _utc_now_iso()
    preference = _ensure_unsubscribe_token_fields(preference)
    if supabase:
        try:
            response = supabase.table(PREFERENCE_TABLE).upsert(preference, on_conflict="user_id").execute()
            rows = getattr(response, "data", None) or []
            return rows[0] if rows else preference
        except Exception as exc:
            if not _should_use_memory_fallback(exc, PREFERENCE_TABLE):
                raise
            print(f"[DailySignals] notification preferences table missing during save, using in-memory fallback: {exc}")
    _MEMORY_PREFERENCES[preference["user_id"]] = preference
    return preference


def update_notification_preference(user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    current = get_notification_preference(user)
    market = _normalize_market(payload.get("market") or current.get("market"))
    risk_level = _normalize_risk(payload.get("risk_level") or current.get("risk_level"))
    signal_type = _normalize_signal_type(payload.get("signal_type") or current.get("signal_type"))
    email_time = _validate_email_time(market, payload.get("email_time") or current.get("email_time"))
    enabled = bool(payload.get("daily_stock_email_enabled", current.get("daily_stock_email_enabled")))
    clean_email = (payload.get("email") or user.get("email") or current.get("email") or "").strip()
    if enabled and "@" not in clean_email:
        raise ValueError("Daily stock emails need a valid account email.")

    current.update(
        {
            "email": clean_email,
            "market": market,
            "risk_level": risk_level,
            "email_time": email_time,
            "signal_type": signal_type,
            "daily_stock_email_enabled": enabled,
        }
    )
    if payload.get("consent_version"):
        current["consent_version"] = payload["consent_version"]
    if payload.get("consent_accepted_at"):
        current["consent_accepted_at"] = payload["consent_accepted_at"]
        current["unsubscribed_at"] = None
    saved = _upsert_preference(current)
    _log_audit("notification_preference_updated", "notification_preferences", saved, user_id=user["id"], entity_id=user["id"])
    return saved


def enable_daily_alerts(user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    consent_version = payload.get("consent_version") or DEFAULT_CONSENT_VERSION
    consent_accepted_at = payload.get("consent_accepted_at") or _utc_now_iso()
    preference = update_notification_preference(
        user,
        {
            **payload,
            "daily_stock_email_enabled": True,
            "consent_version": consent_version,
            "consent_accepted_at": consent_accepted_at,
        },
    )
    _log_audit("daily_alerts_enabled", "notification_preferences", preference, user_id=user["id"], entity_id=user["id"])
    return preference


def disable_daily_alerts(user: dict[str, Any]) -> dict[str, Any]:
    current = get_notification_preference(user)
    current["daily_stock_email_enabled"] = False
    saved = _upsert_preference(current)
    _log_audit("daily_alerts_disabled", "notification_preferences", saved, user_id=user["id"], entity_id=user["id"])
    return saved


def unsubscribe_daily_alerts(token: str) -> dict[str, Any]:
    user_id, nonce = _decode_unsubscribe_token(token)
    row = _fetch_preference_row(user_id)
    if not row or row.get("unsubscribe_nonce") != nonce:
        raise ValueError("That unsubscribe link is no longer valid.")
    row["daily_stock_email_enabled"] = False
    row["unsubscribed_at"] = _utc_now_iso()
    saved = _upsert_preference(row)
    _log_audit("daily_alerts_unsubscribed", "notification_preferences", saved, user_id=user_id, entity_id=user_id)
    return {"unsubscribed": True, "user_id": user_id}


def get_daily_update_preference(user: dict[str, Any]) -> dict[str, Any]:
    preference = get_notification_preference(user)
    return {
        "user_id": preference["user_id"],
        "email": preference.get("email"),
        "enabled": preference.get("daily_stock_email_enabled", False),
        "market": preference.get("market"),
        "risk_level": preference.get("risk_level"),
        "email_time": preference.get("email_time"),
        "signal_type": preference.get("signal_type"),
    }


def _has_delivery_consent(preference: dict[str, Any]) -> bool:
    if preference.get("consent_accepted_at"):
        return True
    # Backward compatibility: older rows saved an explicit enabled flag before
    # consent timestamps existed. Treat enabled + email as legacy opt-in instead
    # of silently skipping the user forever.
    return bool(preference.get("daily_stock_email_enabled") and preference.get("email"))


def _ensure_delivery_consent(preference: dict[str, Any]) -> dict[str, Any]:
    if preference.get("consent_accepted_at") or not _has_delivery_consent(preference):
        return preference
    preference["consent_version"] = preference.get("consent_version") or f"{DEFAULT_CONSENT_VERSION}-legacy"
    preference["consent_accepted_at"] = (
        preference.get("updated_at")
        or preference.get("created_at")
        or _utc_now_iso()
    )
    return _upsert_preference(preference)


def update_daily_update_preference(user: dict[str, Any], enabled: bool, email: str | None = None) -> dict[str, Any]:
    if enabled:
        return enable_daily_alerts(
            user,
            {
                "email": email or user.get("email"),
                "market": DEFAULT_MARKET,
                "risk_level": DEFAULT_RISK_LEVEL,
                "email_time": DEFAULT_EMAIL_TIME,
                "signal_type": DEFAULT_SIGNAL_TYPE,
                "consent_version": DEFAULT_CONSENT_VERSION,
                "consent_accepted_at": _utc_now_iso(),
            },
        )
    return disable_daily_alerts(user)


def _risk_profile(risk_level: str) -> dict[str, float]:
    return RISK_PROFILES.get(risk_level, RISK_PROFILES[DEFAULT_RISK_LEVEL])


def _setup_stats() -> dict[str, dict[str, int]]:
    stats: dict[str, dict[str, int]] = defaultdict(lambda: {"wins": 0, "trades": 0})
    if supabase:
        try:
            signal_rows = (
                supabase.table(SIGNALS_TABLE)
                .select("id,setup_type")
                .order("run_date", desc=True)
                .limit(600)
                .execute()
            )
            outcome_rows = (
                supabase.table(OUTCOMES_TABLE)
                .select("stock_signal_id,outcome")
                .limit(600)
                .execute()
            )
            setup_by_id = {row["id"]: row.get("setup_type") or "mixed_setup" for row in getattr(signal_rows, "data", None) or []}
            for outcome in getattr(outcome_rows, "data", None) or []:
                setup = setup_by_id.get(outcome.get("stock_signal_id"))
                if not setup or outcome.get("outcome") == "NO_FILL":
                    continue
                stats[setup]["trades"] += 1
                if outcome.get("outcome") == "WIN":
                    stats[setup]["wins"] += 1
            return stats
        except Exception as exc:
            if not (_should_use_memory_fallback(exc, SIGNALS_TABLE) or _should_use_memory_fallback(exc, OUTCOMES_TABLE)):
                raise
            print(f"[DailySignals] signal stats tables missing, using in-memory fallback: {exc}")
    for signal in _MEMORY_SIGNALS:
        for outcome in _MEMORY_OUTCOMES:
            if outcome.get("stock_signal_id") != signal.get("id"):
                continue
            if outcome.get("outcome") == "NO_FILL":
                continue
            setup = signal.get("setup_type") or "mixed_setup"
            stats[setup]["trades"] += 1
            if outcome.get("outcome") == "WIN":
                stats[setup]["wins"] += 1
    return stats


def _liquidity_score(avg_turnover: float) -> float:
    return min(1.0, max(0.0, avg_turnover / 500_000_000))


def _risk_penalties(validation: dict[str, Any], atr_pct: float, risk_level: str) -> float:
    penalty = max(0.0, (1.0 - validation["quality_score"]) * 0.18)
    penalty += max(0.0, atr_pct - (_risk_profile(risk_level)["max_atr_pct"] / 100)) * 0.5
    return penalty * _risk_profile(risk_level)["risk_penalty_multiplier"]


def _relative_strength(frame: pd.DataFrame, index_frame: pd.DataFrame) -> float:
    if len(frame) < 25 or len(index_frame) < 25:
        return 0.0
    stock_ret = float(frame["close"].iloc[-1] / frame["close"].iloc[-21] - 1)
    index_ret = float(index_frame["close"].iloc[-1] / index_frame["close"].iloc[-21] - 1)
    return (stock_ret - index_ret) * 100


def _build_candidate(
    *,
    ticker: str,
    feature_frame: pd.DataFrame,
    index_frame: pd.DataFrame,
    regime: dict[str, Any],
    sector_strength: float,
    setup_stats: dict[str, dict[str, int]],
    risk_level: str,
    horizon_days: int = 5,
    market_breadth: dict[str, float] | None = None,
) -> dict[str, Any] | None:
    latest = feature_frame.iloc[-1]
    close = float(latest["close"])
    atr = float(latest["atr14"])
    if close <= 0 or atr <= 0:
        return None

    validation = validate_candidate_frame(feature_frame, risk_level)
    if not validation["is_valid"]:
        return None

    relative_strength = _relative_strength(feature_frame, index_frame)
    technical_setup = evaluate_technical_setup(latest.to_dict(), relative_strength, sector_strength)
    if technical_setup.get("direction") not in {"BUY", "SELL"}:
        return None
    if abs(int(technical_setup.get("directional_edge") or 0)) < MIN_DIRECTIONAL_EDGE:
        return None
    feature_values = build_live_feature_values(
        latest,
        technical_setup,
        regime,
        relative_strength=relative_strength,
        sector_strength=sector_strength,
        market_breadth=market_breadth,
    )
    probabilities = predict_signal_probabilities(
        technical_setup,
        regime,
        risk_level,
        relative_strength,
        validation["quality_score"],
        feature_values=feature_values,
        setup_type=technical_setup.get("setup_type"),
        horizon_days=horizon_days,
    )

    # Same geometry the model was trained on for this horizon.
    profile = _risk_profile(risk_level)
    scale = horizon_barrier_scale(horizon_days)
    target_multiplier = profile["target_atr_multiplier"] * scale
    stop_multiplier = profile["stop_atr_multiplier"] * scale

    entry_low, entry_high = entry_zone(technical_setup["direction"], close, atr, horizon_days)
    if technical_setup["direction"] == "BUY":
        target_price = close + atr * target_multiplier
        stop_loss = close - atr * stop_multiplier
        target_r = max((target_price - close) / max(close - stop_loss, 1e-6), 0)
        stop_r = 1.0
    else:
        target_price = close - atr * target_multiplier
        stop_loss = close + atr * stop_multiplier
        target_r = max((close - target_price) / max(stop_loss - close, 1e-6), 0)
        stop_r = 1.0

    calibrated_pwin = float(probabilities["calibrated_pwin"])
    conservative_p_loss = max(float(probabilities["p_loss"]), 1.0 - calibrated_pwin)
    expected_r = compute_expected_r(
        calibrated_pwin,
        conservative_p_loss,
        target_r,
        stop_r,
        transaction_cost_r=0.03,
        slippage_r=0.02,
    )
    setup_stat = setup_stats.get(technical_setup["setup_type"], {"wins": 0, "trades": 0})
    setup_win_rate = adjusted_win_rate(
        setup_stat["wins"],
        setup_stat["trades"],
        UNIVERSE_AVERAGE_WIN_RATE,
        DEFAULT_K_SMOOTHING,
    )
    wilson_floor = wilson_lower_bound_placeholder(setup_stat["wins"], setup_stat["trades"]) if setup_stat["trades"] else UNIVERSE_AVERAGE_WIN_RATE * 0.8
    adjusted_setup_win_rate = min(setup_win_rate, max(wilson_floor, 0.0) + 0.12)
    avg_turnover = float(validation["avg_turnover"])
    liquidity_score = _liquidity_score(avg_turnover)
    risk_reward = target_r
    confidence = probabilities["confidence"]
    historical_hit_rate = float(probabilities.get("historical_hit_rate") or UNIVERSE_AVERAGE_WIN_RATE)
    historical_hit_rate_trades = int(probabilities.get("historical_hit_rate_trades") or 0)
    atr_pct = atr / close
    penalties = _risk_penalties(validation, atr_pct, risk_level)
    regime_alignment = regime["alignment_buy"] if technical_setup["direction"] == "BUY" else regime["alignment_sell"]

    final_score = compute_final_score(
        calibrated_pwin=probabilities["calibrated_pwin"],
        expected_r=expected_r,
        adjusted_setup_win_rate=adjusted_setup_win_rate,
        market_regime_alignment=regime_alignment,
        chart_setup_quality=technical_setup["chart_setup_quality"],
        relative_strength=min(1.0, abs(relative_strength) / 5),
        liquidity_score=liquidity_score,
        model_stability=probabilities["model_stability"],
        risk_penalties=penalties,
    )

    # Sell-side calls are ON by default now. While they were disabled, every one
    # of 229 stored signals was a BUY: in a falling market the engine could only
    # ever be long, and had no way to say "this one is going down". The rule
    # engine already scores both directions and ml_dataset emits SELL rows with
    # dir_buy = 0, so the model has trained on short setups rather than
    # extrapolating into them.
    #
    # Read a SELL as "exit or avoid", not "short it" — shorting Indian cash
    # equities overnight is not available to most retail accounts.
    allow_sell_signals = os.getenv("DAILY_SIGNALS_ALLOW_SELL", "true").lower() in {"1", "true", "yes"}
    if technical_setup["direction"] == "SELL" and not allow_sell_signals:
        return None
    # Reject a setup whose realised hit rate cannot pay for its own risk/reward.
    #
    # This used to compare against a flat 0.45. That number was arbitrary, and
    # once real outcomes existed it rejected EVERYTHING: the two live setups sit
    # at 39.2% and 40.0%, so a 45% floor produced zero signals every day. But a
    # hit rate is only good or bad relative to the payoff — at 1.74 reward:risk,
    # break-even is 1/(1+1.74) = 36.6%, and 38.3% once the 0.05R of costs and
    # slippage are covered. Both setups clear that; neither clears 45%.
    #
    # So the bar is derived rather than guessed:
    #     required = (1 + cost_r) / (1 + reward:risk)
    # which is exactly the win rate at which expectancy turns positive. A wider
    # target has to earn its lower hit rate, a tighter one is allowed a worse
    # one, and the gate stays honest as the risk profile changes.
    # DAILY_MIN_HISTORICAL_HIT_RATE remains an absolute floor beneath this.
    round_trip_cost_r = 0.05
    breakeven_hit_rate = (1.0 + round_trip_cost_r) / (1.0 + max(risk_reward, 0.01))
    required_hit_rate = max(breakeven_hit_rate, MIN_HISTORICAL_HIT_RATE)
    if historical_hit_rate_trades >= MIN_HISTORICAL_TRADES_FOR_REJECTION and historical_hit_rate < required_hit_rate:
        return None
    # Sanity floors applied in every mode: never surface a structurally broken
    # setup (poor reward:risk geometry or a low-quality chart pattern).
    if (
        risk_reward < profile["min_risk_reward"]
        or technical_setup["chart_setup_quality"] < MIN_CHART_SETUP_QUALITY
    ):
        return None
    # Hard conviction floors only in "threshold" mode. In "ranked" mode we keep
    # the candidate and let diversify_candidates() rank by final_score and take
    # the top N — the +EV selection the backtest validated.
    if DAILY_SELECTION_MODE == "threshold" and (
        expected_r < MIN_EXPECTED_R
        or confidence < profile["confidence_threshold"]
        or final_score < float(profile.get("min_final_score", 0.0))
    ):
        return None

    returns = feature_frame["close"].pct_change().dropna().tail(90).tolist()
    meta = get_symbol_metadata(ticker)
    symbol = meta["symbol"]
    return {
        "symbol": symbol,
        "company_name": meta["company_name"],
        "sector": meta["sector"],
        "ticker": ticker,
        "direction": technical_setup["direction"],
        "entry_low": round(entry_low, 2),
        "entry_high": round(entry_high, 2),
        "target_price": round(target_price, 2),
        "stop_loss": round(stop_loss, 2),
        "confidence": round(confidence, 6),
        "expected_r": round(expected_r, 6),
        "risk_reward": round(risk_reward, 6),
        "final_score": round(final_score, 6),
        "setup_type": technical_setup["setup_type"],
        "reasons": technical_setup["reasons"],
        "relative_strength": round(relative_strength, 4),
        "liquidity_score": round(liquidity_score, 6),
        "model_stability": probabilities["model_stability"],
        "market_regime_alignment": round(regime_alignment, 6),
        "chart_setup_quality": technical_setup["chart_setup_quality"],
        "calibrated_pwin": probabilities["calibrated_pwin"],
        "data_quality_valid": True,
        "explanation_json": {
            "reasons": technical_setup["reasons"],
            "validation": validation,
            "probabilities": probabilities,
            "sector_strength": round(sector_strength, 4),
            "relative_strength": round(relative_strength, 4),
            "signal_type": signal_type_for_horizon(horizon_days),
            "horizon_days": int(horizon_days),
            "market_breadth": {k: round(float(v), 4) for k, v in (market_breadth or {}).items()},
            "quality_gates": {
                "min_directional_edge": MIN_DIRECTIONAL_EDGE,
                "min_chart_setup_quality": MIN_CHART_SETUP_QUALITY,
                "min_expected_r": MIN_EXPECTED_R,
                "min_risk_reward": profile["min_risk_reward"],
                "conservative_p_loss": round(conservative_p_loss, 6),
            },
        },
        "recent_returns": returns,
    }


def _market_breadth(feature_frames: dict[str, pd.DataFrame]) -> dict[str, Any]:
    """Cross-sectional breadth as of the last bar, defined exactly as in training.

    The model was trained with these features computed across the universe
    (ml_dataset.build_labeled_dataset), but the live engine never passed them,
    so ten of its thirty inputs were frozen at neutral defaults. A model fed
    values it never saw in training is not the model that was tested.
    """
    today: list[tuple[str, dict[str, float]]] = []
    previous_above50: list[float] = []
    for ticker, frame in feature_frames.items():
        if len(frame) < 52:
            continue
        last = frame.iloc[-1]
        prev = frame.iloc[-2]
        try:
            snap = {
                "close": float(last["close"]),
                "ema20": float(last["ema20"]),
                "ema50": float(last["ema50"]),
                "ret5": float(last["ret5"]),
            }
            previous_above50.append(1.0 if float(prev["close"]) > float(prev["ema50"]) else 0.0)
        except (KeyError, TypeError, ValueError):
            continue
        today.append((ticker, snap))
    if not today:
        return {"market": {}, "sectors": {}}
    n = len(today)
    above50 = sum(1 for _, s in today if s["close"] > s["ema50"]) / n
    market = {
        "mkt_above_ema50": above50,
        "mkt_above_ema20": sum(1 for _, s in today if s["close"] > s["ema20"]) / n,
        "mkt_adv5": sum(1 for _, s in today if s["ret5"] > 0) / n,
        "mkt_breadth_chg": above50 - (sum(previous_above50) / len(previous_above50) if previous_above50 else above50),
    }
    members: dict[str, list[float]] = defaultdict(list)
    for ticker, snap in today:
        sector = SECTOR_BY_SYMBOL.get(ticker.replace(".NS", "").replace(".BO", ""), "General")
        members[sector].append(1.0 if snap["close"] > snap["ema50"] else 0.0)
    sectors = {sector: sum(v) / len(v) for sector, v in members.items()}
    return {"market": market, "sectors": sectors}


def _breadth_for(ticker: str, breadth: dict[str, Any]) -> dict[str, float]:
    market = dict(breadth.get("market") or {})
    if not market:
        return {}
    sector = SECTOR_BY_SYMBOL.get(ticker.replace(".NS", "").replace(".BO", ""), "General")
    sector_above = float((breadth.get("sectors") or {}).get(sector, 0.0))
    market["sector_above_ema50"] = sector_above
    market["sector_vs_market"] = sector_above - float(market["mkt_above_ema50"])
    return market


# One evening run builds several horizons and risk levels from the same prices,
# so the universe is fetched and featurised once and reused for a while.
_UNIVERSE_CACHE: dict[str, Any] = {}
_UNIVERSE_TTL_SECONDS = 30 * 60


def _load_universe(market: str) -> dict[str, Any]:
    key = f"{market}:{_last_completed_session().isoformat()}"
    cached = _UNIVERSE_CACHE.get(key)
    if cached and (datetime.now(timezone.utc) - cached["at"]).total_seconds() < _UNIVERSE_TTL_SECONDS:
        return cached
    market_context = fetch_market_context(market)
    feature_frames: dict[str, pd.DataFrame] = {}
    for ticker in get_universe(market):
        features = build_feature_frame(fetch_price_history(ticker, days=320))
        if not features.empty:
            feature_frames[ticker] = features
    loaded = {
        "at": datetime.now(timezone.utc),
        "market_context": market_context,
        "regime": detect_market_regime(market_context["index_history"]),
        "feature_frames": feature_frames,
        "sector_strengths": _group_sector_strength(feature_frames, market_context["index_history"]),
        "breadth": _market_breadth(feature_frames),
    }
    _UNIVERSE_CACHE.clear()
    _UNIVERSE_CACHE[key] = loaded
    return loaded


def _group_sector_strength(feature_frames: dict[str, pd.DataFrame], index_frame: pd.DataFrame) -> dict[str, float]:
    sector_returns: dict[str, list[float]] = defaultdict(list)
    index_ret = float(index_frame["close"].iloc[-1] / index_frame["close"].iloc[-21] - 1) if len(index_frame) >= 25 else 0.0
    for ticker, frame in feature_frames.items():
        if len(frame) < 25:
            continue
        symbol = ticker.replace(".NS", "").replace(".BO", "")
        sector = SECTOR_BY_SYMBOL.get(symbol, "General")
        sector_returns[sector].append(float(frame["close"].iloc[-1] / frame["close"].iloc[-21] - 1))
    return {
        sector: ((sum(values) / len(values)) - index_ret) * 100
        for sector, values in sector_returns.items()
        if values
    }


def _store_model_run(run_payload: dict[str, Any], signals: list[dict[str, Any]]) -> dict[str, Any]:
    if supabase:
        try:
            run_record = {
                "id": run_payload["id"],
                "run_date": run_payload["run_date"],
                "target_date": run_payload["target_date"],
                "market": run_payload["market"],
                "risk_level": run_payload["risk_level"],
                "signal_type": run_payload["signal_type"],
                "model_version": run_payload["model_version"],
                "generated_at": run_payload["generated_at"],
                "universe_size": run_payload["universe_size"],
                "filtered_count": run_payload["filtered_count"],
                "selected_count": run_payload["selected_count"],
                "data_timestamp": run_payload["data_timestamp"],
                "status": run_payload["status"],
                "summary": run_payload["summary"],
            }
            # One request for all of a run's calls, retried once: the shared
            # connection to Supabase is sometimes dropped mid-run, which used to
            # leave a run stored with only some of its calls.
            for attempt in range(2):
                try:
                    supabase.table(MODEL_RUNS_TABLE).upsert(run_record, on_conflict="id").execute()
                    if signals:
                        supabase.table(SIGNALS_TABLE).upsert(signals, on_conflict="id").execute()
                    break
                except Exception as exc:
                    if attempt or _should_use_memory_fallback(exc, MODEL_RUNS_TABLE) or _should_use_memory_fallback(exc, SIGNALS_TABLE):
                        raise
                    print(f"[DailySignals] storing run failed, retrying once: {exc}")
            return run_payload
        except Exception as exc:
            if not (_should_use_memory_fallback(exc, MODEL_RUNS_TABLE) or _should_use_memory_fallback(exc, SIGNALS_TABLE)):
                raise
            print(f"[DailySignals] model run tables missing, using in-memory fallback: {exc}")
    else:
        pass
    _MEMORY_RUNS[:] = [item for item in _MEMORY_RUNS if item["id"] != run_payload["id"]]
    _MEMORY_RUNS.append(run_payload)
    existing_ids = {signal["id"] for signal in signals}
    _MEMORY_SIGNALS[:] = [item for item in _MEMORY_SIGNALS if item["id"] not in existing_ids]
    _MEMORY_SIGNALS.extend(signals)
    return run_payload


def _find_existing_run(run_date: str, market: str, risk_level: str, signal_type: str) -> dict[str, Any] | None:
    if supabase:
        try:
            response = (
                supabase.table(MODEL_RUNS_TABLE)
                .select("*")
                .eq("run_date", run_date)
                .eq("market", market)
                .eq("risk_level", risk_level)
                .eq("signal_type", signal_type)
                .order("generated_at", desc=True)
                .limit(1)
                .execute()
            )
            rows = getattr(response, "data", None) or []
            return rows[0] if rows else None
        except Exception as exc:
            if not _should_use_memory_fallback(exc, MODEL_RUNS_TABLE):
                raise
            print(f"[DailySignals] model runs table missing during lookup, using in-memory fallback: {exc}")
    matches = [
        item for item in _MEMORY_RUNS
        if item["run_date"] == run_date and item["market"] == market and item["risk_level"] == risk_level and item["signal_type"] == signal_type
    ]
    return sorted(matches, key=lambda item: item["generated_at"], reverse=True)[0] if matches else None


def latest_run(market: str, risk_level: str, signal_type: str, *, from_date: date | None = None) -> dict[str, Any] | None:
    """The newest stored run whose session is today or later (nothing is computed)."""
    since = (from_date or _current_session_date()).isoformat()
    if supabase:
        try:
            response = (
                supabase.table(MODEL_RUNS_TABLE)
                .select("*")
                .eq("market", market)
                .eq("risk_level", risk_level)
                .eq("signal_type", signal_type)
                .gte("target_date", since)
                .order("target_date")
                .order("generated_at", desc=True)
                .limit(1)
                .execute()
            )
            rows = getattr(response, "data", None) or []
            return rows[0] if rows else None
        except Exception as exc:
            if not _should_use_memory_fallback(exc, MODEL_RUNS_TABLE):
                raise
    matches = [
        item for item in _MEMORY_RUNS
        if item["market"] == market and item["risk_level"] == risk_level
        and item["signal_type"] == signal_type and item["target_date"] >= since
    ]
    matches.sort(key=lambda item: item["generated_at"], reverse=True)
    matches.sort(key=lambda item: item["target_date"])
    return matches[0] if matches else None


def _load_signals_for_run(run_id: str) -> list[dict[str, Any]]:
    if supabase:
        try:
            response = (
                supabase.table(SIGNALS_TABLE)
                .select("*")
                .eq("model_run_id", run_id)
                .order("signal_rank")
                .execute()
            )
            return getattr(response, "data", None) or []
        except Exception as exc:
            if not _should_use_memory_fallback(exc, SIGNALS_TABLE):
                raise
            print(f"[DailySignals] stock signals table missing during load, using in-memory fallback: {exc}")
    return sorted([item for item in _MEMORY_SIGNALS if item["model_run_id"] == run_id], key=lambda item: item.get("signal_rank", 999))


def run_daily_prediction(
    *,
    market: str = DEFAULT_MARKET,
    risk_level: str = DEFAULT_RISK_LEVEL,
    signal_type: str = DEFAULT_SIGNAL_TYPE,
    target_day: date | None = None,
    send_email: bool = False,
    user_ids: list[str] | None = None,
    force: bool = False,
    catch_up: bool = False,
) -> dict[str, Any]:
    """Build (or reuse) the picks for the next session at one horizon and risk level.

    Runs only on completed daily bars: during a trading session the latest bar
    is still moving, so features computed from it would not match anything the
    model was trained or tested on. On weekends and holidays it uses the last
    completed session and targets the next one. With catch_up, a run missing
    for the session in progress is built from the previous close, the same
    inputs it would have had the evening before.
    """
    market = _normalize_market(market)
    risk_level = _normalize_risk(risk_level)
    signal_type = _normalize_signal_type(signal_type)
    horizon_days = horizon_from_signal_type(signal_type)
    now = datetime.now(IST)
    if not _session_complete(now) and not (force or catch_up):
        return {
            "skipped": True,
            "reason": "Today's session is still open. Picks for the next session are built after the close.",
            "run_date": now.date().isoformat(),
        }
    # An intraday call runs from the open, so a missing one cannot be filled in
    # once the session has started: nobody could have acted on it.
    if catch_up and not force and horizon_days == 1 and _session_started(now):
        return {
            "skipped": True,
            "reason": "Today's session has opened, so its intraday calls can no longer be published.",
            "run_date": now.date().isoformat(),
        }
    run_day = _last_completed_session(now)
    target_date = (target_day or _next_trading_day(now.date() if _session_complete(now) else run_day)).isoformat()

    existing_run = _find_existing_run(run_day.isoformat(), market, risk_level, signal_type)
    if existing_run and existing_run.get("target_date") != target_date:
        existing_run = None
    # A run made by an older engine is replaced by a current forecast run.
    if existing_run and not str(existing_run.get("model_version") or "").startswith("forecast-v3"):
        existing_run = None
    signals = _load_signals_for_run(existing_run["id"]) if existing_run and not force else []
    # A run stored without all of its calls (an interrupted save) is rebuilt.
    if existing_run and not force and len(signals) < int(existing_run.get("selected_count") or 0):
        existing_run = None
    if existing_run and not force:
        notifications = _send_daily_signal_emails(existing_run, signals, user_ids=user_ids) if send_email else []
        return {"model_run": existing_run, "signals": signals, "notifications": notifications, "cached": True}

    model_version = os.getenv("DAILY_SIGNAL_MODEL_VERSION", "forecast-v3") + f"-h{horizon_days}"
    run_id = str(uuid4())
    generated_at = _utc_now_iso()
    signal_rows: list[dict[str, Any]] = []
    universe_size = len(forecast_engine.universe_tickers())
    run_status = "completed"
    withheld_reason = None
    forecast_count = 0
    typical = None
    report = forecast_engine.load_report(horizon_days) or {}

    artifact = forecast_engine.load_artifact(horizon_days)
    if artifact is None:
        run_status = "withheld"
        withheld_reason = f"The {horizon_days}-session forecast models are not available on the server yet."
    else:
        predictions = _forecast_universe(artifact, run_day)
        forecast_count = len(predictions)
        if predictions.empty:
            run_status = "withheld"
            withheld_reason = "Price data for the last session was not available, so no forecasts were made."
        else:
            typical = round(forecast_engine.display_probability(float(predictions["p_beat"].median()), artifact.get("calibration")), 4)
            calls = _select_forecasts(predictions, risk_level, horizon_days)
            for index, (_, row) in enumerate(calls.iterrows(), 1):
                signal_rows.append(_forecast_signal_row(row, horizon_days, artifact, run_id, index,
                                                        model_version, run_day, target_date, market, typical))

    confirmation = report.get("confirmation") or {}
    run_payload = {
        "id": run_id,
        "run_date": run_day.isoformat(),
        "target_date": target_date,
        "market": market,
        "risk_level": risk_level,
        "signal_type": signal_type,
        "model_version": model_version,
        "generated_at": generated_at,
        "universe_size": universe_size,
        "filtered_count": forecast_count,
        "selected_count": len(signal_rows),
        "data_timestamp": generated_at,
        "status": run_status,
        "summary": {
            "kind": "forecast",
            "horizon_days": horizon_days,
            "data_date": run_day.isoformat(),
            "last_session": market_calendar.session_after(date.fromisoformat(target_date), horizon_days).isoformat(),
            "typical_p_beat": typical,
            "withheld_reason": withheld_reason,
            # The untouched half of the out-of-sample test: what the app quotes.
            "model_test": (
                {
                    "universe": report.get("universe"),
                    "stocks": report.get("stocks"),
                    "model": report.get("model"),
                    "first_day": confirmation.get("first_day"),
                    "last_day": confirmation.get("last_day"),
                    "days": confirmation.get("days"),
                    "base_beat_rate": confirmation.get("base_beat_rate"),
                    "buy": confirmation.get("buy"),
                    "sell": confirmation.get("sell"),
                    "buy_edge_confirmed": report.get("buy_edge_confirmed"),
                    "sell_edge_confirmed": report.get("sell_edge_confirmed"),
                    "range_coverage": (confirmation.get("range") or {}).get("coverage_10_90"),
                }
                if report
                else None
            ),
            "live_record": _live_forecast_record(horizon_days),
            "method": "Nifty 200, from the next open to the close of the horizon: calibrated chance to beat the average stock, and a 10/50/90% price range",
        },
    }
    stored_run = _store_model_run(run_payload, signal_rows)
    _log_audit("model_run_created", "model_runs", {"id": run_id, "signal_type": signal_type, "status": run_status}, entity_id=run_id)
    notifications = _send_daily_signal_emails(stored_run, signal_rows, user_ids=user_ids) if send_email and signal_rows else []
    return {"model_run": stored_run, "signals": signal_rows, "notifications": notifications, "cached": False}


# ── Forecast engine ──────────────────────────────────────────────────────────

_FORECAST_INPUT_CACHE: dict[str, Any] = {}
# Enough daily bars for the 200-day average and the 52-week high.
_FORECAST_HISTORY_DAYS = 560
# Bars kept per stock for the features: the longest window (52-week high,
# 250 bars) plus the feature warm-up, with room to spare. Fewer bars means less
# memory on the small server; the latest row's features are unchanged.
_FORECAST_BARS = 340


def _latest_forecast_rows(run_day: date) -> pd.DataFrame:
    """Features for the last completed session, built once per evening.

    Every horizon and risk level reads these same rows, so the expensive part
    (fetching 200 histories and building features) runs once, not nine times,
    and the raw prices are released straight after. On a small shared server
    that is the difference between a few seconds of work and minutes of it.
    """
    key = run_day.isoformat()
    cached = _FORECAST_INPUT_CACHE.get(key)
    if cached is not None and (datetime.now(timezone.utc) - cached["at"]).total_seconds() < _UNIVERSE_TTL_SECONDS:
        return cached["rows"]
    frames: dict[str, pd.DataFrame] = {}
    for ticker in forecast_engine.universe_tickers():
        frame = fetch_price_history(ticker, days=_FORECAST_HISTORY_DAYS)
        if frame is not None and not frame.empty:
            frames[ticker] = frame.tail(_FORECAST_BARS).reset_index(drop=True)
    index = fetch_price_history(MARKET_INDEX.get(DEFAULT_MARKET, "^NSEI"), days=_FORECAST_HISTORY_DAYS).tail(_FORECAST_BARS)
    rows = forecast_engine.forecast_frame(frames, index)
    del frames
    if not rows.empty:
        # Never a bar newer than the last completed session: during market hours
        # the price feed carries today's unfinished bar.
        settled = rows[rows["date"] <= key]
        rows = settled[settled["date"] == settled["date"].max()].copy() if not settled.empty else settled
        # Skip stocks with a recent corporate action or data jump.
        rows = rows[rows["anomaly"] <= 0].reset_index(drop=True)
    import gc

    gc.collect()
    _FORECAST_INPUT_CACHE.clear()
    _FORECAST_INPUT_CACHE[key] = {"at": datetime.now(timezone.utc), "rows": rows}
    return rows


def _forecast_universe(artifact: dict[str, Any], run_day: date) -> pd.DataFrame:
    """Forecasts for every stock with a clean, current bar for the last completed session."""
    latest = _latest_forecast_rows(run_day)
    if latest.empty:
        return latest
    predictions = forecast_engine.predict(artifact, latest)
    return predictions.merge(latest.drop(columns=["sector", "date", "close"]), on="ticker", how="left")


# Risk level = how wide a range the reader accepts: Conservative keeps the
# steadier 40% of stocks by forecast range, Balanced drops the widest 20%.
_RISK_RANGE_QUANTILE = {"Conservative": 0.4, "Balanced": 0.8, "Aggressive": 1.0}
_MAX_PER_SECTOR = 3


def _pick(work: pd.DataFrame, limit: int) -> list[pd.Series]:
    picked, per_sector = [], defaultdict(int)
    for _, row in work.iterrows():
        if per_sector[row["sector"]] >= _MAX_PER_SECTOR:
            continue
        per_sector[row["sector"]] += 1
        picked.append(row)
        if len(picked) >= limit:
            break
    return picked


def _select_forecasts(predictions: pd.DataFrame, risk_level: str, horizon: int = 1) -> pd.DataFrame:
    """BUY calls: most likely to beat the market. SELL calls (intraday only):
    most likely to lag it; overnight shorts are not available in Indian cash
    equities, so 3- and 5-session forecasts publish buys only."""
    work = predictions.copy()
    work["width"] = work["q90"] - work["q10"]
    limit = work["width"].quantile(_RISK_RANGE_QUANTILE.get(risk_level, 0.8))
    work = work[work["width"] <= limit + 1e-12]
    if "rank_score" not in work.columns:
        work["rank_score"] = work["p_beat"]
    buys = _pick(work.sort_values(["p_beat", "rank_score"], ascending=False), MAX_SELECTED_SIGNALS)
    rows = [row.copy() for row in buys]
    for row in rows:
        row["direction"] = "BUY"
        row["confidence"] = row["p_beat"]
    if horizon == 1:
        bought = {row["ticker"] for row in rows}
        candidates = work[~work["ticker"].isin(bought)].sort_values(["p_beat", "rank_score"], ascending=True)
        for row in _pick(candidates, MAX_SELECTED_SIGNALS):
            row = row.copy()
            row["direction"] = "SELL"
            row["confidence"] = 1 - row["p_beat"]
            rows.append(row)
    return pd.DataFrame(rows)


def _forecast_signal_row(row: pd.Series, horizon: int, artifact: dict[str, Any], run_id: str, rank: int,
                         model_version: str, run_day: date, target_date: str, market: str,
                         typical_p_beat: float | None = None) -> dict[str, Any]:
    direction = str(row.get("direction") or "BUY")
    forecast = forecast_engine.describe(row, horizon, artifact.get("calibration"), direction)
    forecast["context"] = forecast_engine.context_notes(row)
    # The same model's chance for the middle stock today, for comparison.
    forecast["typical_p_beat"] = typical_p_beat
    forecast["first_session"] = target_date
    forecast["last_session"] = market_calendar.session_after(date.fromisoformat(target_date), horizon).isoformat()
    buy = direction == "BUY"
    close = forecast["reference_close"]
    upside, downside = forecast["q90"], -forecast["q10"]
    symbol = str(row["ticker"]).replace(".NS", "")
    return {
        "id": str(uuid4()),
        "model_run_id": run_id,
        "symbol": symbol,
        "company_name": forecast_engine.company_of(row["ticker"]),
        "sector": row["sector"],
        "direction": direction,
        # A forecast has no entry rule: the reference is the last close, and
        # the forecast runs from the next open.
        "entry_low": close,
        "entry_high": close,
        "target_price": forecast["mid_price"],
        "stop_loss": forecast["stop_price"],
        "confidence": round(float(forecast["p_call"]), 6),
        "expected_r": round(forecast["q50"], 6),
        "risk_reward": round((upside / downside) if buy and downside > 0 else (downside / upside) if upside > 0 else 0.0, 6),
        "final_score": round(float(forecast["p_call"]), 6),
        "setup_type": "forecast",
        "explanation_json": {"reasons": forecast["context"], "forecast": forecast, "horizon_days": horizon},
        "model_version": model_version,
        "run_date": run_day.isoformat(),
        "target_date": target_date,
        "market": market,
        "data_quality_valid": True,
        "signal_rank": rank,
    }


def _live_forecast_record(horizon: int, limit: int = 400) -> dict[str, Any] | None:
    """How the published forecast calls for this horizon have actually done."""
    if not supabase:
        return None
    try:
        signals = (
            supabase.table(SIGNALS_TABLE)
            .select("id,direction,model_version")
            .eq("setup_type", "forecast")
            .like("model_version", f"forecast-v3%-h{horizon}")
            .order("run_date", desc=True)
            .limit(limit)
            .execute()
        )
        rows = getattr(signals, "data", None) or []
        if not rows:
            return {"calls": 0}
        by_id = {r["id"]: r for r in rows}
        outcomes = (
            supabase.table(OUTCOMES_TABLE)
            .select("stock_signal_id,outcome,realized_r")
            .in_("stock_signal_id", list(by_id)[:400])
            .execute()
        )
        graded = [o for o in (getattr(outcomes, "data", None) or []) if o.get("outcome") in {"WIN", "LOSS"}]
        record: dict[str, Any] = {"calls": len(graded)}
        for direction in ("BUY", "SELL"):
            mine = [o for o in graded if by_id[o["stock_signal_id"]]["direction"] == direction]
            if mine:
                record[direction.lower()] = {
                    "calls": len(mine),
                    "right": sum(1 for o in mine if o["outcome"] == "WIN"),
                    "avg_edge_pct": round(sum(float(o.get("realized_r") or 0) for o in mine) / len(mine), 3),
                }
        return record
    except Exception as exc:  # noqa: BLE001 - the record is informational
        print(f"[DailySignals] live forecast record unavailable: {exc}")
        return None


_PREPARE_FAILED_AT: datetime | None = None
_PREPARED_FOR: str | None = None
_PREPARE_RETRY_SECONDS = 20 * 60


def prepare_daily_runs(market: str = DEFAULT_MARKET) -> dict[str, Any]:
    """Build every horizon x risk level for the next session.

    Called by the scheduled tick, never by a page: users only ever read stored
    runs, so nobody waits on a model run. Cheap to repeat, as finished runs are
    found and reused. During a session it only fills in runs still missing for
    that session (say the server was down the evening before), always from the
    previous close.
    """
    global _PREPARE_FAILED_AT, _PREPARED_FOR
    now = datetime.now(IST)
    # Once every run for this stretch is stored, nothing changes until the next
    # close, so later ticks skip the nine lookups instead of repeating them.
    stretch = f"{_last_completed_session(now)}:{_session_complete(now)}"
    if _PREPARED_FOR == stretch:
        return {"skipped": True, "reason": "Runs already prepared"}
    # After a failure, wait before trying again, so a persistent problem cannot
    # rerun the heavy build every minute and starve the API.
    if _PREPARE_FAILED_AT and (datetime.now(timezone.utc) - _PREPARE_FAILED_AT).total_seconds() < _PREPARE_RETRY_SECONDS:
        return {"skipped": True, "reason": "Waiting after a failed build"}
    built: list[dict[str, Any]] = []
    for horizon in HORIZONS:
        for risk_level in RISK_PROFILES:
            try:
                result = run_daily_prediction(
                    market=market,
                    risk_level=risk_level,
                    signal_type=signal_type_for_horizon(horizon),
                    catch_up=True,
                )
                run = result.get("model_run") or {}
                built.append({
                    "horizon_days": horizon,
                    "risk_level": risk_level,
                    "status": run.get("status"),
                    "picks": run.get("selected_count"),
                    "cached": result.get("cached"),
                    "skipped": result.get("reason") if result.get("skipped") else None,
                })
            except Exception as exc:  # noqa: BLE001 - one failure must not block the rest
                print(f"[DailySignals] prepare {horizon}-day/{risk_level} failed: {exc}")
                built.append({"horizon_days": horizon, "risk_level": risk_level, "error": str(exc)})
    failed = any("error" in b for b in built)
    _PREPARE_FAILED_AT = datetime.now(timezone.utc) if failed else None
    if not failed:
        _PREPARED_FOR = stretch
    if any(not b.get("cached") and not b.get("skipped") and "error" not in b for b in built):
        print(f"[DailySignals] prepared runs: {built}")
    return {"runs": built}


def _iter_preferences() -> list[dict[str, Any]]:
    if supabase:
        try:
            response = (
                supabase.table(PREFERENCE_TABLE)
                .select("*")
                .eq("daily_stock_email_enabled", True)
                .is_("unsubscribed_at", "null")
                .execute()
            )
            return getattr(response, "data", None) or []
        except Exception as exc:
            if not _should_use_memory_fallback(exc, PREFERENCE_TABLE):
                raise
            print(f"[DailySignals] notification preferences table missing during subscriber lookup, using in-memory fallback: {exc}")
    return [value for value in _MEMORY_PREFERENCES.values() if value.get("daily_stock_email_enabled") and not value.get("unsubscribed_at")]


def _email_already_sent(user_id: str, run_id: str) -> bool:
    if supabase:
        try:
            response = (
                supabase.table(EMAIL_LOGS_TABLE)
                .select("id,status")
                .eq("user_id", user_id)
                .eq("model_run_id", run_id)
                .eq("email_kind", "daily_signal")
                .in_("status", ["sent", "queued"])
                .limit(1)
                .execute()
            )
            return bool(getattr(response, "data", None))
        except Exception as exc:
            if not _should_use_memory_fallback(exc, EMAIL_LOGS_TABLE):
                raise
            print(f"[DailySignals] email logs table missing during duplicate check, using in-memory fallback: {exc}")
    return any(
        item
        for item in _MEMORY_EMAIL_LOGS
        if item["user_id"] == user_id
        and item["model_run_id"] == run_id
        and item["email_kind"] == "daily_signal"
        and item.get("status") in {"sent", "queued"}
    )


def _summarize_delivery_results(notifications: list[dict[str, Any]]) -> dict[str, int]:
    attempted = len(notifications)
    sent = sum(1 for item in notifications if item.get("status") == "sent")
    failed = sum(1 for item in notifications if item.get("status") == "failed")
    skipped = sum(1 for item in notifications if item.get("status") == "skipped")
    other = attempted - sent - failed - skipped
    return {
        "attempted": attempted,
        "sent": sent,
        "failed": failed,
        "skipped": skipped,
        "other": other,
    }


def _daily_email_already_sent_for_target(user_id: str, target_date: str, email_kind: str = "daily_signal") -> bool:
    if supabase:
        try:
            response = (
                supabase.table(EMAIL_LOGS_TABLE)
                .select("id,sent_at")
                .eq("user_id", user_id)
                .eq("target_date", target_date)
                .eq("email_kind", email_kind)
                .in_("status", ["sent", "queued"])
                .order("sent_at", desc=True)
                .limit(1)
                .execute()
            )
            return bool(getattr(response, "data", None))
        except Exception as exc:
            if not _should_use_memory_fallback(exc, EMAIL_LOGS_TABLE):
                raise
            print(f"[DailySignals] email logs table missing during target-date duplicate check, using in-memory fallback: {exc}")
    return any(
        item
        for item in _MEMORY_EMAIL_LOGS
        if item["user_id"] == user_id
        and item.get("target_date") == target_date
        and item.get("email_kind") == email_kind
        and item.get("status") in {"sent", "queued"}
    )


def _log_email(record: dict[str, Any]):
    if supabase:
        try:
            supabase.table(EMAIL_LOGS_TABLE).insert(record).execute()
            return
        except Exception as exc:
            if not _should_use_memory_fallback(exc, EMAIL_LOGS_TABLE):
                raise
            print(f"[DailySignals] email logs table missing during insert, using in-memory fallback: {exc}")
    _MEMORY_EMAIL_LOGS.append(record)


def _experimental_note(model_run: dict[str, Any]) -> str | None:
    if model_run.get("status") != "experimental":
        return None
    tested = (((model_run.get("summary") or {}).get("model_test") or {}).get("ml_top_n") or {}).get("avg_net_r")
    result = f" ({tested:+.2f}R per filled trade after costs)" if isinstance(tested, (int, float)) else ""
    return f"in out-of-sample testing this holding period did not beat trading costs{result}. Treat these picks as research only."


def _send_signal_email_to_preference(
    model_run: dict[str, Any],
    signals: list[dict[str, Any]],
    preference: dict[str, Any],
    *,
    email_kind: str,
) -> dict[str, Any]:
    if not preference.get("unsubscribe_nonce"):
        # Settings saved straight from the browser have no nonce yet. Without
        # storing it, every email would carry a different, unusable link.
        preference = _upsert_preference(dict(preference))
    subject, text, html = build_signal_email(
        signal_date=model_run["target_date"],
        market=model_run["market"],
        signals=signals,
        unsubscribe_url=_unsubscribe_url(preference),
        risk_level=model_run["risk_level"],
        signal_type=model_run["signal_type"],
        conviction=(model_run.get("summary") or {}).get("conviction"),
        experimental_note=_experimental_note(model_run),
    )
    result = _send_email(preference["email"], subject, text, html=html)
    log_record = {
        "id": str(uuid4()),
        "user_id": preference["user_id"],
        "model_run_id": model_run["id"],
        "email": preference["email"],
        "email_kind": email_kind,
        "target_date": model_run["target_date"],
        "status": result.get("status"),
        "provider": result.get("provider"),
        "response": result,
        "sent_at": _utc_now_iso(),
        "error_message": result.get("error") or result.get("reason"),
    }
    _log_email(log_record)
    return {"user_id": preference["user_id"], "email": preference["email"], **result}


def _send_daily_signal_emails(model_run: dict[str, Any], signals: list[dict[str, Any]], user_ids: list[str] | None = None) -> list[dict[str, Any]]:
    notifications: list[dict[str, Any]] = []
    allowed = set(user_ids or [])
    for preference in _iter_preferences():
        if allowed and preference["user_id"] not in allowed:
            continue
        if (
            _normalize_market(preference.get("market")) != model_run["market"]
            or preference.get("risk_level") != model_run["risk_level"]
            or _normalize_signal_type(preference.get("signal_type")) != model_run["signal_type"]
        ):
            continue
        if _email_already_sent(preference["user_id"], model_run["id"]):
            continue
        if _daily_email_already_sent_for_target(preference["user_id"], model_run["target_date"]):
            continue
        notifications.append(
            _send_signal_email_to_preference(
                model_run,
                signals,
                preference,
                email_kind="daily_signal",
            )
        )
    return notifications


def send_instant_signal_email(user: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """Email the latest stored picks to the signed-in user right away.

    This used to run the whole model inside the request, which on a small free
    server took many minutes. Picks are built once after the close; this only
    reads and sends them.
    """
    current = get_notification_preference(user)
    market = _normalize_market(payload.get("market") or current.get("market"))
    risk_level = _normalize_risk(payload.get("risk_level") or current.get("risk_level"))
    signal_type = _normalize_signal_type(payload.get("signal_type") or current.get("signal_type"))
    clean_email = (user.get("email") or current.get("email") or "").strip()
    if "@" not in clean_email:
        raise ValueError("Instant stock emails need a valid account email.")
    run = latest_run(market, risk_level, signal_type)
    if not run:
        raise ValueError("There are no picks for the next session yet. They are built after the market closes.")
    if run.get("status") == "withheld":
        raise ValueError((run.get("summary") or {}).get("withheld_reason") or "This horizon publishes no picks.")
    signals = _load_signals_for_run(run["id"])
    if not signals:
        raise ValueError("The model found no setups worth taking for this session, so there is nothing to send.")
    preference = {**current, "email": clean_email, "user_id": user["id"]}
    notification = _send_signal_email_to_preference(run, signals, preference, email_kind="instant_signal")
    _log_audit("instant_signal_email_sent", "model_runs", {"run_id": run["id"]}, user_id=user["id"], entity_id=run["id"])
    return {"model_run": run, "signals": signals, "notification": notification}


def process_scheduled_daily_alerts(force: bool = False) -> dict[str, Any]:
    now = datetime.now(IST)
    if _is_market_holiday(now.date()) and not force:
        return {"sent": 0, "reason": "Non-trading day"}

    target_date = _next_trading_day(now.date()).isoformat()
    due_preferences: list[dict[str, Any]] = []
    considered = 0
    skipped = {"no_consent": 0, "not_due_yet": 0, "already_sent": 0, "no_email": 0}
    for preference in _iter_preferences():
        considered += 1
        if not _has_delivery_consent(preference):
            skipped["no_consent"] += 1
            continue
        preference = _ensure_delivery_consent(preference)
        if not preference.get("email"):
            skipped["no_email"] += 1
            continue
        preferred_time = _parse_time_string(preference.get("email_time"))
        if not (force or (now.hour, now.minute) >= (preferred_time.hour, preferred_time.minute)):
            skipped["not_due_yet"] += 1
            continue
        if _daily_email_already_sent_for_target(preference["user_id"], target_date):
            skipped["already_sent"] += 1
            continue
        due_preferences.append(preference)

    # Always log the tick outcome so "no emails arrived" is debuggable in prod.
    print(
        f"[DailySignals] scheduled tick at {now.strftime('%H:%M IST')} target={target_date} "
        f"considered={considered} due={len(due_preferences)} skipped={skipped} force={force}"
    )

    if not due_preferences:
        delivery = _summarize_delivery_results([])
        return {
            "sent": 0,
            "attempted": 0,
            "failed": 0,
            "delivery_skipped": 0,
            "delivery": delivery,
            "considered": considered,
            "skipped": skipped,
            "reason": "No due unsent preferences",
            "target_date": target_date,
        }

    grouped: dict[tuple[str, str, str], list[str]] = defaultdict(list)
    for preference in due_preferences:
        key = (
            _normalize_market(preference.get("market")),
            _normalize_risk(preference.get("risk_level")),
            _normalize_signal_type(preference.get("signal_type")),
        )
        grouped[key].append(preference["user_id"])

    all_notifications: list[dict[str, Any]] = []
    for (market, risk_level, signal_type), user_ids in grouped.items():
        result = run_daily_prediction(
            market=market,
            risk_level=risk_level,
            signal_type=signal_type,
            send_email=True,
            user_ids=user_ids,
            force=force,
        )
        all_notifications.extend(result.get("notifications", []))

    delivery = _summarize_delivery_results(all_notifications)
    print(
        f"[DailySignals] scheduled tick delivery for target={target_date}: "
        f"attempted={delivery['attempted']} sent={delivery['sent']} "
        f"failed={delivery['failed']} skipped={delivery['skipped']}"
    )
    return {
        "sent": delivery["sent"],
        "attempted": delivery["attempted"],
        "failed": delivery["failed"],
        "delivery_skipped": delivery["skipped"],
        "delivery": delivery,
        "considered": considered,
        "skipped": skipped,
        "target_date": target_date,
        "notifications": all_notifications,
    }


# Per-day guard so repeated cron hits don't re-run outcome tracking all day.
_OUTCOME_TRACKED_FOR: str | None = None
# One tick at a time: the in-process loop, the database cron and the GitHub
# backup can all fire close together, and overlapping ticks could both decide
# the same email is due.
_TICK_LOCK = threading.Lock()


def run_scheduled_tick_in_background() -> dict[str, Any]:
    """Start a tick on a worker thread and return at once (for short-timeout callers)."""
    if _TICK_LOCK.locked():
        return {"started": False, "busy": True}
    threading.Thread(target=run_scheduled_tick, name="daily-tick", daemon=True).start()
    return {"started": True}


def run_scheduled_tick(force: bool = False) -> dict[str, Any]:
    """Single entry point a cron (or the in-process loop) can call repeatedly.

    Does everything the daily pipeline needs, idempotently:
      1. Send any due daily-signal emails (respects each user's email_time and
         the per-target-date dedupe in email_logs).
      2. After market close, record yesterday's signal outcomes ONCE so the
         model's hit-rate calibration keeps learning.

    Point the existing ~10-min keep-alive cron at POST
    /api/v1/daily-updates/run-scheduled with the x-alert-admin-key header: one
    cron then keeps the host awake AND drives both steps, with no dependency on
    a long-lived in-process loop surviving a sleeping free-tier dyno.
    """
    if not _TICK_LOCK.acquire(blocking=False):
        return {"busy": True, "emails": {}, "prepared": None, "outcomes": None}
    try:
        return _run_scheduled_tick(force)
    finally:
        _TICK_LOCK.release()


def _run_scheduled_tick(force: bool) -> dict[str, Any]:
    global _OUTCOME_TRACKED_FOR
    now = datetime.now(IST)
    prepared: dict[str, Any] | None = None
    try:
        prepared = prepare_daily_runs()
    except Exception as exc:  # noqa: BLE001 - emails can still go out from stored runs
        print(f"[DailySignals] preparing runs failed: {exc}")
    emails = process_scheduled_daily_alerts(force=force)

    outcomes: dict[str, Any] | None = None
    today = now.date().isoformat()
    after_close = force or now.time() >= MARKET_CLOSES.get(DEFAULT_MARKET, time(15, 30))
    if after_close and _OUTCOME_TRACKED_FOR != today and (force or not _is_market_holiday(now.date())):
        try:
            outcomes = run_outcome_tracking(review_day=now.date())
            _OUTCOME_TRACKED_FOR = today
            print(f"[DailySignals] outcome tracking processed {outcomes.get('processed', 0)} signal(s) for {today}")
        except Exception as exc:  # noqa: BLE001 - never let tracking break email delivery
            print(f"[DailySignals] outcome tracking failed: {exc}")

    return {"prepared": prepared, "emails": emails, "outcomes": outcomes}


def _load_pending_signals(target_day: str, *, include_evaluated: bool = False) -> list[dict[str, Any]]:
    """Every signal whose target date has passed and has no recorded outcome.

    This used to filter `target_date == target_day` — one exact date. Outcome
    tracking runs once per day, so any day the tick did not fire (host asleep,
    cron failing, a restart at the wrong moment) left that day's signals
    permanently unevaluated: the next run only looked at the NEW target date and
    never went back. That is why 229 signals had produced 2 outcomes.

    Selecting everything still pending on or before the review day makes the job
    self-healing — a missed day is simply picked up on the next run.
    """
    if supabase:
        try:
            response = (
                supabase.table(SIGNALS_TABLE)
                .select("*")
                .lte("target_date", target_day)
                .order("target_date", desc=True)
                .limit(500)
                .execute()
            )
            all_signals = getattr(response, "data", None) or []
            outcomes = (
                supabase.table(OUTCOMES_TABLE)
                .select("stock_signal_id")
                .execute()
            )
            processed = {row["stock_signal_id"] for row in getattr(outcomes, "data", None) or []}
            if include_evaluated:
                return all_signals
            return [signal for signal in all_signals if signal["id"] not in processed]
        except Exception as exc:
            if not (_should_use_memory_fallback(exc, SIGNALS_TABLE) or _should_use_memory_fallback(exc, OUTCOMES_TABLE)):
                raise
            print(f"[DailySignals] pending signal tables missing, using in-memory fallback: {exc}")
    processed = {row["stock_signal_id"] for row in _MEMORY_OUTCOMES}
    return [
        signal for signal in _MEMORY_SIGNALS
        if signal["target_date"] <= target_day
        and (include_evaluated or signal["id"] not in processed)
    ]


_BENCHMARK_CACHE: dict[tuple[str, int, str], float | None] = {}


def _benchmark_move(start: date, horizon: int, market: str, history_by_ticker: dict[str, pd.DataFrame]) -> float | None:
    """Average move of the stocks in the universe over the same window (equal weight)."""
    key = (start.isoformat(), horizon, market)
    if key in _BENCHMARK_CACHE:
        return _BENCHMARK_CACHE[key]
    moves: list[float] = []
    for ticker in forecast_engine.universe_tickers():
        if ticker not in history_by_ticker:
            frame = fetch_price_history(ticker, days=400)
            if not frame.empty:
                frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
            history_by_ticker[ticker] = frame
        frame = history_by_ticker[ticker]
        if frame.empty:
            continue
        rows = frame[frame["date"].dt.date >= start].to_dict("records")
        move = _window_move(rows, horizon)
        if move is not None and abs(move) < 0.45:
            moves.append(move)
    result = sum(moves) / len(moves) if len(moves) >= 40 else None
    _BENCHMARK_CACHE[key] = result
    return result


def _window_move(bars: list[dict[str, Any]], horizon: int) -> float | None:
    """Return from the first bar's open to the close of bar `horizon`, or None if not there yet."""
    if len(bars) < horizon:
        return None
    entry = float(bars[0]["open"])
    return float(bars[horizon - 1]["close"]) / entry - 1 if entry > 0 else None


def _grade_forecast(
    signal: dict[str, Any],
    bars: list[dict[str, Any]],
    horizon: int,
    benchmark_move: float | None = None,
) -> dict[str, Any] | None:
    """A forecast is right when the stock beat (or lagged) the average stock as
    called, from the next open to the close of session `horizon`. Also records
    whether that close landed inside the forecast's 10-90% range. None while
    still open, or while the benchmark move is unknown."""
    move = _window_move(bars, horizon)
    if move is None or benchmark_move is None:
        return None
    entry = float(bars[0]["open"])
    exit_close = float(bars[horizon - 1]["close"])
    excess = move - benchmark_move
    buy = signal.get("direction") != "SELL"
    right = excess > 0 if buy else excess < 0
    forecast = (signal.get("explanation_json") or {}).get("forecast") or {}
    low, high = forecast.get("low_price"), forecast.get("high_price")
    in_range = bool(low is not None and high is not None and float(low) <= exit_close <= float(high))
    return {
        "outcome": "WIN" if right else "LOSS",
        # For forecasts: how far it beat (or lagged) the average stock, in percent,
        # signed so a right call is positive.
        "realized_r": round(excess * 100 * (1 if buy else -1), 4),
        "hit_sequence": f"forecast_{'right' if right else 'wrong'}_{'in' if in_range else 'out_of'}_range",
        "sessions_held": horizon,
        "fill_price": entry,
    }


def run_outcome_tracking(review_day: date | None = None, *, recompute: bool = False) -> dict[str, Any]:
    """Record outcomes for signals whose target date has passed.

    `recompute=True` re-evaluates signals that ALREADY have an outcome and
    upserts over them. Needed whenever the evaluation rule itself changes —
    otherwise the table holds a mix of verdicts produced by different methods,
    which quietly corrupts the ML hit-rate calibration that reads it. The upsert
    is keyed on stock_signal_id, so a re-run replaces rather than duplicates.
    """
    day = review_day or _previous_trading_day(_next_trading_day(_today_ist()) if _is_market_holiday(_today_ist()) else _today_ist())
    pending = _load_pending_signals(day.isoformat(), include_evaluated=recompute)
    stored: list[dict[str, Any]] = []
    # Price history is fetched once per ticker, not once per signal: the backfill
    # can now span months, and several signals usually share a ticker.
    history_by_ticker: dict[str, pd.DataFrame] = {}
    for signal in pending:
        ticker = signal["symbol"] if signal["market"] == "US" else f"{signal['symbol']}.NS"
        if ticker not in history_by_ticker:
            frame = fetch_price_history(ticker, days=400)
            if not frame.empty:
                frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
            history_by_ticker[ticker] = frame
        history = history_by_ticker[ticker]
        if history.empty:
            continue
        # Each signal is judged on ITS OWN target date. Using the review day here
        # was only correct while this processed a single date at a time.
        try:
            signal_day = pd.to_datetime(signal["target_date"]).date()
        except Exception:  # noqa: BLE001 - a malformed row must not stop the batch
            continue
        # Every session from the target date onward, so the trade is judged over
        # its holding window rather than on a single bar.
        window_rows = history[history["date"].dt.date >= signal_day]
        if window_rows.empty:
            continue
        bars = window_rows.to_dict("records")
        horizon = int(((signal.get("explanation_json") or {}).get("horizon_days")) or HOLD_SESSIONS)
        if (signal.get("explanation_json") or {}).get("forecast"):
            outcome = _grade_forecast(signal, bars, horizon, _benchmark_move(signal_day, horizon, signal["market"], history_by_ticker))
        else:
            outcome = evaluate_signal_outcome_window(signal, bars, max_sessions=horizon)
        if outcome is None:
            continue  # still open — leave it pending rather than recording a verdict
        record = {
            "id": str(uuid4()),
            "stock_signal_id": signal["id"],
            "outcome": outcome["outcome"],
            "realized_r": outcome["realized_r"],
            "evaluated_at": _utc_now_iso(),
            "hit_sequence": outcome["hit_sequence"],
            "notes": {
                "target_date": signal_day.isoformat(),
                "sessions_held": outcome.get("sessions_held"),
                "window_sessions": horizon,
                "unit": "pct" if (signal.get("explanation_json") or {}).get("forecast") else "R",
            },
        }
        if supabase:
            try:
                supabase.table(OUTCOMES_TABLE).upsert(record, on_conflict="stock_signal_id").execute()
            except Exception as exc:
                if not _should_use_memory_fallback(exc, OUTCOMES_TABLE):
                    raise
                print(f"[DailySignals] outcomes table missing during tracking, using in-memory fallback: {exc}")
                _MEMORY_OUTCOMES.append(record)
        else:
            _MEMORY_OUTCOMES.append(record)
        stored.append(record)
    return {"review_day": day.isoformat(), "processed": len(stored), "outcomes": stored}


def get_signals_today(market: str | None = None, risk_level: str | None = None, signal_type: str | None = None) -> dict[str, Any]:
    """The latest stored picks for the next session. Reading never runs the model."""
    selected_market = _normalize_market(market or DEFAULT_MARKET)
    selected_risk = _normalize_risk(risk_level or DEFAULT_RISK_LEVEL)
    selected_type = _normalize_signal_type(signal_type or DEFAULT_SIGNAL_TYPE)
    run = latest_run(selected_market, selected_risk, selected_type)
    return {"model_run": run, "signals": _load_signals_for_run(run["id"]) if run else []}


def get_stock_track_record(symbol: str, limit: int = 12) -> dict[str, Any]:
    """Every past Bullseye call on one stock, with how it actually resolved.

    This is the honest counterpart to the verdict on the stock page: rather than
    only ever showing the current call, show the closed ones and whether they
    hit target or stopped out. `pending` signals (target date not yet evaluated)
    are counted separately so the hit rate is computed only over resolved trades
    and cannot be inflated by open positions.
    """
    clean = (symbol or "").strip().upper().replace(".NS", "").replace(".BO", "")
    if not clean:
        raise ValueError("Symbol is required.")

    signals: list[dict[str, Any]] = []
    outcomes_by_signal: dict[str, dict[str, Any]] = {}
    if supabase:
        try:
            signal_rows = (
                supabase.table(SIGNALS_TABLE)
                .select("*")
                .eq("symbol", clean)
                .order("target_date", desc=True)
                .limit(max(1, min(limit, 60)))
                .execute()
            )
            signals = getattr(signal_rows, "data", None) or []
            if signals:
                outcome_rows = (
                    supabase.table(OUTCOMES_TABLE)
                    .select("*")
                    .in_("stock_signal_id", [s["id"] for s in signals])
                    .execute()
                )
                outcomes_by_signal = {
                    row["stock_signal_id"]: row for row in getattr(outcome_rows, "data", None) or []
                }
        except Exception as exc:
            if not (_should_use_memory_fallback(exc, SIGNALS_TABLE) or _should_use_memory_fallback(exc, OUTCOMES_TABLE)):
                raise
            print(f"[DailySignals] track-record tables missing, using in-memory fallback: {exc}")
            signals = [s for s in _MEMORY_SIGNALS if s.get("symbol") == clean][:limit]
            outcomes_by_signal = {o["stock_signal_id"]: o for o in _MEMORY_OUTCOMES}
    else:
        signals = [s for s in _MEMORY_SIGNALS if s.get("symbol") == clean][:limit]
        outcomes_by_signal = {o["stock_signal_id"]: o for o in _MEMORY_OUTCOMES}

    entries: list[dict[str, Any]] = []
    wins = losses = neutral = pending = no_fill = 0
    realized: list[float] = []
    forecast_moves: list[float] = []
    for signal in signals:
        outcome = outcomes_by_signal.get(signal.get("id"))
        status = (outcome or {}).get("outcome")
        if status == "WIN":
            wins += 1
        elif status == "LOSS":
            losses += 1
        elif status == "NEUTRAL":
            neutral += 1
        elif status == "NO_FILL":
            no_fill += 1  # the entry price was never reached: not a trade
        else:
            pending += 1
        realized_r = (outcome or {}).get("realized_r")
        if isinstance(realized_r, (int, float)) and status != "NO_FILL":
            # Forecast outcomes are percent moves, trade outcomes are R: keep them apart.
            (forecast_moves if signal.get("setup_type") == "forecast" else realized).append(float(realized_r))
        entries.append(
            {
                "id": signal.get("id"),
                "run_date": signal.get("run_date"),
                "target_date": signal.get("target_date"),
                "direction": signal.get("direction"),
                "setup_type": signal.get("setup_type"),
                "entry_low": signal.get("entry_low"),
                "entry_high": signal.get("entry_high"),
                "target_price": signal.get("target_price"),
                "stop_loss": signal.get("stop_loss"),
                "confidence": signal.get("confidence"),
                "outcome": status or "PENDING",
                "realized_r": realized_r,
                "hit_sequence": (outcome or {}).get("hit_sequence"),
            }
        )

    resolved = wins + losses + neutral
    return {
        "symbol": clean,
        "signals": entries,
        "summary": {
            "total": len(entries),
            "resolved": resolved,
            "pending": pending,
            "wins": wins,
            "losses": losses,
            "neutral": neutral,
            "no_fill": no_fill,
            # Only over resolved trades. None (not 0) when nothing has closed yet,
            # so the UI can say "no closed calls" instead of showing a 0% hit rate
            # that would read as "we always lose".
            "hit_rate": round(wins / resolved, 4) if resolved else None,
            "avg_realized_r": round(sum(realized) / len(realized), 4) if realized else None,
            "avg_forecast_move_pct": round(sum(forecast_moves) / len(forecast_moves), 3) if forecast_moves else None,
        },
    }


def get_signals_history(limit: int = 20) -> dict[str, Any]:
    if supabase:
        try:
            response = supabase.table(MODEL_RUNS_TABLE).select("*").order("generated_at", desc=True).limit(limit).execute()
            runs = getattr(response, "data", None) or []
        except Exception as exc:
            if not _should_use_memory_fallback(exc, MODEL_RUNS_TABLE):
                raise
            print(f"[DailySignals] model runs table missing during history load, using in-memory fallback: {exc}")
            runs = sorted(_MEMORY_RUNS, key=lambda item: item["generated_at"], reverse=True)[:limit]
    else:
        runs = sorted(_MEMORY_RUNS, key=lambda item: item["generated_at"], reverse=True)[:limit]
    return {
        "runs": [
            {
                **run,
                "signals": _load_signals_for_run(run["id"]),
            }
            for run in runs
        ]
    }


def get_admin_status() -> dict[str, Any]:
    history = get_signals_history(limit=1)["runs"]
    latest_run = history[0] if history else None
    if supabase:
        try:
            latest_email_logs = getattr(
                supabase.table(EMAIL_LOGS_TABLE).select("*").order("sent_at", desc=True).limit(20).execute(),
                "data",
                None,
            ) or []
        except Exception as exc:
            if not _should_use_memory_fallback(exc, EMAIL_LOGS_TABLE):
                raise
            print(f"[DailySignals] email logs table missing during admin status, using in-memory fallback: {exc}")
            latest_email_logs = sorted(_MEMORY_EMAIL_LOGS, key=lambda item: item["sent_at"], reverse=True)[:20]
        try:
            latest_outcomes = getattr(
                supabase.table(OUTCOMES_TABLE).select("*").order("evaluated_at", desc=True).limit(20).execute(),
                "data",
                None,
            ) or []
        except Exception as exc:
            if not _should_use_memory_fallback(exc, OUTCOMES_TABLE):
                raise
            print(f"[DailySignals] outcomes table missing during admin status, using in-memory fallback: {exc}")
            latest_outcomes = sorted(_MEMORY_OUTCOMES, key=lambda item: item["evaluated_at"], reverse=True)[:20]
    else:
        latest_email_logs = sorted(_MEMORY_EMAIL_LOGS, key=lambda item: item["sent_at"], reverse=True)[:20]
        latest_outcomes = sorted(_MEMORY_OUTCOMES, key=lambda item: item["evaluated_at"], reverse=True)[:20]
    return {
        "latest_model_run": latest_run,
        "email_send_status": latest_email_logs,
        "signal_outcomes": latest_outcomes,
        "model_version": os.getenv("DAILY_SIGNAL_MODEL_VERSION", "signal-engine-v1"),
        "data_timestamp": latest_run.get("data_timestamp") if latest_run else None,
    }


def run_daily_forecast(send_email: bool = True) -> dict[str, Any]:
    result = run_daily_prediction(send_email=send_email)
    report = {
        "kind": "forecast",
        "report_date": result["model_run"]["run_date"],
        "target_date": result["model_run"]["target_date"],
        "market": result["model_run"]["market"],
        "picks": result["signals"],
        "qualified_count": result["model_run"]["filtered_count"],
        "disclaimer": "Signals are model-generated analysis. Returns are not guaranteed.",
    }
    return {"report": report, "notifications": result.get("notifications", [])}


def run_daily_review(send_email: bool = True) -> dict[str, Any]:
    result = run_outcome_tracking()
    report = {
        "kind": "review",
        "report_date": result["review_day"],
        "results": result["outcomes"],
        "processed": result["processed"],
        "disclaimer": "Outcomes use available daily OHLC data. Intraday sequencing can be refined with lower-timeframe feeds later.",
    }
    return {"report": report, "notifications": [] if not send_email else []}
