from __future__ import annotations

import os
from datetime import time


DEFAULT_CONSENT_VERSION = os.getenv("NOTIFICATION_CONSENT_VERSION", "2026-05-29")
DEFAULT_MARKET = os.getenv("DEFAULT_SIGNAL_MARKET", "NSE").upper()
DEFAULT_RISK_LEVEL = os.getenv("DEFAULT_SIGNAL_RISK_LEVEL", "Balanced")
DEFAULT_SIGNAL_TYPE = os.getenv("DEFAULT_SIGNAL_TYPE", "Next-day swing")
DEFAULT_EMAIL_TIME = os.getenv("DEFAULT_SIGNAL_EMAIL_TIME", "18:00")

MIN_EMAIL_AFTER_CLOSE_MINUTES = int(os.getenv("MIN_EMAIL_AFTER_CLOSE_MINUTES", "30"))
MIN_HISTORY_DAYS = int(os.getenv("MIN_SIGNAL_HISTORY_DAYS", "140"))
MAX_SELECTED_SIGNALS = int(os.getenv("MAX_SELECTED_SIGNALS", "10"))
CORRELATION_LOOKBACK = int(os.getenv("SIGNAL_CORRELATION_LOOKBACK", "60"))
CORRELATION_THRESHOLD = float(os.getenv("SIGNAL_CORRELATION_THRESHOLD", "0.92"))
DEFAULT_K_SMOOTHING = int(os.getenv("ADJUSTED_WIN_RATE_K", "20"))
UNIVERSE_AVERAGE_WIN_RATE = float(os.getenv("UNIVERSE_AVG_WIN_RATE", "0.52"))

MARKET_CLOSES = {
    "NSE": time(15, 30),
    "BSE": time(15, 30),
    "US": time(16, 0),
}

RISK_PROFILES = {
    "Conservative": {
        "confidence_threshold": float(os.getenv("CONSERVATIVE_MIN_CONFIDENCE", "0.66")),
        "min_risk_reward": float(os.getenv("CONSERVATIVE_MIN_RISK_REWARD", "1.75")),
        "min_final_score": float(os.getenv("CONSERVATIVE_MIN_FINAL_SCORE", "0.62")),
        "target_atr_multiplier": 1.15,
        "stop_atr_multiplier": 0.62,
        "max_atr_pct": 5.0,
        "risk_penalty_multiplier": 1.1,
    },
    "Balanced": {
        "confidence_threshold": float(os.getenv("BALANCED_MIN_CONFIDENCE", "0.64")),
        "min_risk_reward": float(os.getenv("BALANCED_MIN_RISK_REWARD", "1.55")),
        "min_final_score": float(os.getenv("BALANCED_MIN_FINAL_SCORE", "0.58")),
        "target_atr_multiplier": 1.18,
        "stop_atr_multiplier": 0.68,
        "max_atr_pct": 6.4,
        "risk_penalty_multiplier": 1.0,
    },
    "Aggressive": {
        "confidence_threshold": float(os.getenv("AGGRESSIVE_MIN_CONFIDENCE", "0.61")),
        "min_risk_reward": float(os.getenv("AGGRESSIVE_MIN_RISK_REWARD", "1.4")),
        "min_final_score": float(os.getenv("AGGRESSIVE_MIN_FINAL_SCORE", "0.54")),
        "target_atr_multiplier": 1.28,
        "stop_atr_multiplier": 0.78,
        "max_atr_pct": 7.2,
        "risk_penalty_multiplier": 0.9,
    },
}

NSE_UNIVERSE = [
    "HDFCBANK.NS", "ICICIBANK.NS", "SBIN.NS", "AXISBANK.NS", "KOTAKBANK.NS",
    "RELIANCE.NS", "TCS.NS", "INFY.NS", "HCLTECH.NS", "WIPRO.NS",
    "LT.NS", "BHARTIARTL.NS", "ITC.NS", "HINDUNILVR.NS", "NESTLEIND.NS",
    "TMPV.NS", "MARUTI.NS", "M&M.NS", "BAJAJ-AUTO.NS", "EICHERMOT.NS",
    "SUNPHARMA.NS", "CIPLA.NS", "DRREDDY.NS", "DIVISLAB.NS", "APOLLOHOSP.NS",
    "TATASTEEL.NS", "JSWSTEEL.NS", "HINDALCO.NS", "VEDL.NS", "COALINDIA.NS",
    "NTPC.NS", "POWERGRID.NS", "ONGC.NS", "BPCL.NS", "TATAPOWER.NS",
    "ULTRACEMCO.NS", "GRASIM.NS", "AMBUJACEM.NS", "SHREECEM.NS", "ADANIENT.NS",
    "ADANIPORTS.NS", "ASIANPAINT.NS", "TITAN.NS", "DMART.NS", "TRENT.NS",
    "BAJFINANCE.NS", "BAJAJFINSV.NS", "SHRIRAMFIN.NS", "CHOLAFIN.NS", "PFC.NS",
    "RECLTD.NS", "FEDERALBNK.NS", "BANKBARODA.NS", "CANBK.NS", "PNB.NS",
    "TECHM.NS", "LTM.NS", "COFORGE.NS", "PERSISTENT.NS", "MPHASIS.NS",
    "BRITANNIA.NS", "TATACONSUM.NS", "DABUR.NS", "MARICO.NS", "VBL.NS",
    "LUPIN.NS", "TORNTPHARM.NS", "ZYDUSLIFE.NS", "AUROPHARMA.NS", "BIOCON.NS",
    "INDIGO.NS", "IRCTC.NS", "ETERNAL.NS", "PAYTM.NS", "NYKAA.NS",
    "BEL.NS", "HAL.NS", "BHEL.NS", "SIEMENS.NS", "ABB.NS",
]

US_UNIVERSE = [
    "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL",
    "META", "TSLA", "AMD", "AVGO", "JPM",
    "LLY", "NFLX", "COST", "UBER", "CRM",
]

MARKET_UNIVERSES = {
    "NSE": NSE_UNIVERSE,
    "BSE": NSE_UNIVERSE,
    "US": US_UNIVERSE,
}

MARKET_INDEX = {
    "NSE": "^NSEI",
    "BSE": "^BSESN",
    "US": "^GSPC",
}

SECTOR_BY_SYMBOL = {
    "HDFCBANK": "Financials",
    "ICICIBANK": "Financials",
    "SBIN": "Financials",
    "AXISBANK": "Financials",
    "KOTAKBANK": "Financials",
    "RELIANCE": "Energy",
    "TCS": "Technology",
    "INFY": "Technology",
    "HCLTECH": "Technology",
    "WIPRO": "Technology",
    "LT": "Industrials",
    "BHARTIARTL": "Telecom",
    "ITC": "Consumer Defensive",
    "HINDUNILVR": "Consumer Defensive",
    "NESTLEIND": "Consumer Defensive",
    # TATAMOTORS was renamed TMPV (Oct 2025); TMCV listed separately (Nov 2025).
    "TMPV": "Automotive",
    "TMCV": "Automotive",
    "MARUTI": "Automotive",
    "M&M": "Automotive",
    "BAJAJ-AUTO": "Automotive",
    "EICHERMOT": "Automotive",
    "SUNPHARMA": "Healthcare",
    "CIPLA": "Healthcare",
    "DRREDDY": "Healthcare",
    "DIVISLAB": "Healthcare",
    "APOLLOHOSP": "Healthcare",
    "TATASTEEL": "Materials",
    "JSWSTEEL": "Materials",
    "HINDALCO": "Materials",
    # Vedanta demerged 15 Jun 2026. VEDL remains the residual flagship; the four
    # carve-outs are mapped so they are not bucketed as "General" when scanned.
    "VEDL": "Materials",
    "VAML": "Materials",
    "VISL": "Materials",
    "VOGL": "Energy",
    "VEDPOWER": "Utilities",
    "COALINDIA": "Energy",
    "NTPC": "Utilities",
    "POWERGRID": "Utilities",
    "ONGC": "Energy",
    "BPCL": "Energy",
    "TATAPOWER": "Utilities",
    "ULTRACEMCO": "Materials",
    "GRASIM": "Materials",
    "AMBUJACEM": "Materials",
    "SHREECEM": "Materials",
    "ADANIENT": "Industrials",
    "ADANIPORTS": "Industrials",
    "ASIANPAINT": "Consumer Cyclical",
    "TITAN": "Consumer Cyclical",
    "DMART": "Consumer Defensive",
    "TRENT": "Consumer Cyclical",
    "BAJFINANCE": "Financials",
    "BAJAJFINSV": "Financials",
    "SHRIRAMFIN": "Financials",
    "CHOLAFIN": "Financials",
    "PFC": "Financials",
    "RECLTD": "Financials",
    "FEDERALBNK": "Financials",
    "BANKBARODA": "Financials",
    "CANBK": "Financials",
    "PNB": "Financials",
    "TECHM": "Technology",
    # LTIMindtree: symbol LTIM -> LTM (27 Feb 2026).
    "LTM": "Technology",
    "COFORGE": "Technology",
    "PERSISTENT": "Technology",
    "MPHASIS": "Technology",
    "BRITANNIA": "Consumer Defensive",
    "TATACONSUM": "Consumer Defensive",
    "DABUR": "Consumer Defensive",
    "MARICO": "Consumer Defensive",
    "VBL": "Consumer Defensive",
    "LUPIN": "Healthcare",
    "TORNTPHARM": "Healthcare",
    "ZYDUSLIFE": "Healthcare",
    "AUROPHARMA": "Healthcare",
    "BIOCON": "Healthcare",
    "INDIGO": "Industrials",
    "IRCTC": "Consumer Cyclical",
    # Zomato renamed to Eternal Ltd: symbol ZOMATO -> ETERNAL (9 Apr 2025).
    "ETERNAL": "Consumer Cyclical",
    "PAYTM": "Technology",
    "NYKAA": "Consumer Cyclical",
    "BEL": "Industrials",
    "HAL": "Industrials",
    "BHEL": "Industrials",
    "SIEMENS": "Industrials",
    "ABB": "Industrials",
    "AAPL": "Technology",
    "MSFT": "Technology",
    "NVDA": "Technology",
    "AMZN": "Consumer Cyclical",
    "GOOGL": "Communication Services",
    "META": "Communication Services",
    "TSLA": "Automotive",
    "AMD": "Technology",
    "AVGO": "Technology",
    "JPM": "Financials",
    "LLY": "Healthcare",
    "NFLX": "Communication Services",
    "COST": "Consumer Defensive",
    "UBER": "Industrials",
    "CRM": "Technology",
}

COMPANY_NAME_BY_SYMBOL = {
    symbol: symbol.replace("-", " ")
    for symbol in SECTOR_BY_SYMBOL
}


# ── Prediction horizons ────────────────────────────────────────────────────────
# A pick is entered at the next session and held for up to `horizon` sessions.
# The ATR barriers were tuned for 5 sessions; a shorter hold gets proportionally
# closer barriers (price spreads roughly with the square root of time), so a
# 1-day pick is not asked to make a 5-day move.
HORIZONS = (1, 3, 5)
DEFAULT_HORIZON = 5
BASE_HORIZON = 5


def horizon_barrier_scale(horizon_days: int) -> float:
    return (max(1, int(horizon_days)) / BASE_HORIZON) ** 0.5


def signal_type_for_horizon(horizon_days: int) -> str:
    return f"{int(horizon_days)}-day"


def horizon_from_signal_type(value: str | None) -> int:
    """'1-day' / '3-day' / '5-day'. Older rows ('Next-day swing', 'Intraday',
    'Both') were all graded as 5-session trades, so they map to 5."""
    text = (value or "").strip().lower()
    for horizon in HORIZONS:
        if text in {f"{horizon}-day", f"{horizon}d", f"{horizon} day", f"{horizon} days"}:
            return horizon
    return DEFAULT_HORIZON


# ── Live eligibility and the entry zone (shared by live runs and training) ────
# Training must see exactly the setups the live engine is allowed to publish,
# with the same entry zone, or the tested model is not the one in use.
MIN_DIRECTIONAL_EDGE = int(os.getenv("DAILY_MIN_DIRECTIONAL_EDGE", "2"))
MIN_CHART_SETUP_QUALITY = float(os.getenv("DAILY_MIN_CHART_SETUP_QUALITY", "0.60"))


def entry_zone(direction: str, close: float, atr: float, horizon_days: int) -> tuple[float, float]:
    """(low, high) of the acceptable entry, narrowed with the horizon like the barriers."""
    scale = horizon_barrier_scale(horizon_days)
    if direction == "BUY":
        return close - atr * 0.15 * scale, close + atr * 0.20 * scale
    return close - atr * 0.20 * scale, close + atr * 0.15 * scale


def is_publishable_setup(technical_setup: dict) -> bool:
    """The gates a setup must clear before the live engine will consider it."""
    return (
        technical_setup.get("direction") in {"BUY", "SELL"}
        and abs(int(technical_setup.get("directional_edge") or 0)) >= MIN_DIRECTIONAL_EDGE
        and float(technical_setup.get("chart_setup_quality") or 0) >= MIN_CHART_SETUP_QUALITY
    )
