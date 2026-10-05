import json
import math
import os
import re
from datetime import datetime, timedelta
from typing import Any

import numpy as np
import pandas as pd

from app.services import llm_client
from app.services.relevance_guard import LLM_RULE, OFF_TOPIC_REPLY, is_off_topic_marker, small_talk_reply
from app.services.data_service import get_historical_data


VALID_INTENTS = {
    "BACKTEST_STRATEGY",
    "HISTORICAL_ROI",
    "HISTORICAL_PRICE",
    "TECHNICAL_ANALYSIS",
    # Anything that is not one of the four computable shapes above ("should I
    # buy?", "why is it falling?", "how did it do this year?") is answered by
    # the LLM, grounded in this stock's own numbers.
    "GENERAL_QUESTION",
}

WEEKDAYS = {
    "monday": 0,
    "mon": 0,
    "tuesday": 1,
    "tue": 1,
    "tues": 1,
    "wednesday": 2,
    "wed": 2,
    "thursday": 3,
    "thu": 3,
    "thur": 3,
    "thurs": 3,
    "friday": 4,
    "fri": 4,
}

MONTHS = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}


def _empty_instruction(current_ticker: str, prompt: str) -> dict[str, Any]:
    return {
        "intent": _infer_intent(prompt),
        "target_stock": current_ticker,
        "timeframe_days": _parse_timeframe_days(prompt),
        "strategy_parameters": {
            "buy_trigger": None,
            "sell_trigger": None,
            "entry_time": None,
            "exit_time": None,
        },
        "roi_parameters": {
            "quantity": _parse_quantity(prompt),
            "investment_date": _parse_requested_date(prompt),
        },
        "technical_metrics_requested": _infer_technical_metrics(prompt),
        "ai_context_summary": f"Reading local price history for {current_ticker}.",
    }


def _extract_json(text: str) -> dict[str, Any] | None:
    if not text:
        return None
    clean = re.sub(r"```(?:json)?", "", text, flags=re.IGNORECASE).replace("```", "").strip()
    try:
        parsed = json.loads(clean)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        pass
    match = re.search(r"\{[\s\S]*\}", clean)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def _normalise_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _parse_timeframe_days(prompt: str) -> int | None:
    clean = prompt.lower()
    match = re.search(r"\b(?:last|past|previous|recent|over)\s+(\d{1,4})\s*(?:trading\s*)?(days?|sessions?)\b", clean)
    if match:
        return max(1, int(match.group(1)))
    match = re.search(r"\b(\d{1,2})\s*(years?|yrs?)\b", clean)
    if match:
        return max(1, int(match.group(1)) * 365)
    match = re.search(r"\b(\d{1,2})\s*months?\b", clean)
    if match:
        return max(1, int(match.group(1)) * 30)
    match = re.search(r"\b(\d{1,2})\s*weeks?\b", clean)
    if match:
        return max(1, int(match.group(1)) * 7)
    # "a year ago", "one month ago", "last year"
    match = re.search(r"\b(?:a|an|one|last|past)\s+(year|month|week)\b", clean)
    if match:
        return {"year": 365, "month": 30, "week": 7}[match.group(1)]
    match = re.search(r"\b(\d{1,4})\s*(?:trading\s*)?(days?|sessions?)\s+ago\b", clean)
    if match:
        return max(1, int(match.group(1)))
    return None


def _parse_quantity(prompt: str) -> float | None:
    clean = prompt.lower().replace(",", "")
    match = (
        re.search(r"\b(?:bought|buy|purchased|held|holding)\s+(\d+(?:\.\d+)?)\s*(?:shares|stocks|qty|quantity)?\b", clean)
        or re.search(r"\b(\d+(?:\.\d+)?)\s*(?:shares|stocks|qty|quantity)\b", clean)
    )
    if not match:
        return None
    value = float(match.group(1))
    return value if value > 0 else None


def _parse_requested_date(prompt: str) -> str | None:
    clean = prompt.lower()
    named = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})(?:\s+(\d{4}))?\b", clean)
    if named:
        month = MONTHS.get(named.group(2))
        if month:
            year = int(named.group(3) or datetime.utcnow().year)
            return f"{year:04d}-{month:02d}-{int(named.group(1)):02d}"

    month_first = re.search(r"\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?(?:\s+(\d{4}))?\b", clean)
    if month_first:
        month = MONTHS.get(month_first.group(1))
        if month:
            year = int(month_first.group(3) or datetime.utcnow().year)
            return f"{year:04d}-{month:02d}-{int(month_first.group(2)):02d}"

    iso = re.search(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b", clean)
    if iso:
        return f"{int(iso.group(1)):04d}-{int(iso.group(2)):02d}-{int(iso.group(3)):02d}"

    numeric = re.search(r"\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}))?\b", clean)
    if numeric:
        year = int(numeric.group(3) or datetime.utcnow().year)
        return f"{year:04d}-{int(numeric.group(2)):02d}-{int(numeric.group(1)):02d}"

    return None


# Concrete, testable strategy wording: a rule ("buy when / if / on / at"), a
# weekday pair, an explicit percent move, or the words backtest / simulate.
_STRATEGY_RE = re.compile(
    r"\b(backtest|back-test|simulate|strategy)\b"
    r"|\b(buy|enter|go long|short)\s+(when|if|on|at|after|every|whenever)\b"
    r"|\bentry\b.*\bexit\b"
)


def _infer_intent(prompt: str) -> str:
    clean = prompt.lower()
    has_weekday_pair = len([day for day in WEEKDAYS if re.search(rf"\b{day}\b", clean)]) >= 2
    if _STRATEGY_RE.search(clean) or (has_weekday_pair and re.search(r"\b(buy|sell)\b", clean)):
        return "BACKTEST_STRATEGY"
    if re.search(r"\b(rsi|sma|ema|macd|bollinger|indicators?)\b", clean) or re.search(
        r"\b(support|resistance)\b.*\b(level|levels|zone|and)\b|\b(rsi|support|resistance)\b\s*(/|and)", clean
    ):
        if not re.search(r"\b(backtest|test|strategy|simulate)\b", clean):
            return "TECHNICAL_ANALYSIS"
    # A price on a specific date. "52 week high" is a range question, not a date.
    if (
        re.search(r"\b(price|open|opening|close|closing|high|low|ohlc|candle)\b", clean)
        and _parse_requested_date(prompt)
        and not re.search(r"\b52\s*-?\s*w(ee)?k", clean)
    ):
        return "HISTORICAL_PRICE"
    if re.search(r"\b(bought|purchased|holding|held)\b", clean) or (
        _parse_quantity(prompt) and re.search(r"\b(profit|loss|made|lost|pnl|return|roi|worth)\b", clean)
    ):
        return "HISTORICAL_ROI"
    # Everything else, including "should I buy?", is a question for the LLM.
    return "GENERAL_QUESTION"


def _infer_technical_metrics(prompt: str) -> list[str]:
    clean = prompt.lower()
    metrics = []
    if "rsi" in clean or "oversold" in clean or "overbought" in clean:
        metrics.extend(["RSI", "OVERBOUGHT_STATUS"])
    if "sma" in clean or "moving average" in clean:
        metrics.extend(["SMA_20", "SMA_50", "SMA_200"])
    if "ema" in clean or "moving average" in clean:
        metrics.extend(["EMA_20", "EMA_50"])
    if "support" in clean:
        metrics.append("SUPPORT")
    if "resistance" in clean:
        metrics.append("RESISTANCE")
    if "macd" in clean:
        metrics.append("MACD")
    if not metrics:
        metrics = ["RSI", "SMA_50", "EMA_20", "SUPPORT", "RESISTANCE", "OVERBOUGHT_STATUS"]
    return list(dict.fromkeys(metrics))


def _safe_float(value: Any) -> float | None:
    try:
        if value is None or pd.isna(value):
            return None
        result = float(value)
        if not math.isfinite(result):
            return None
        return result
    except Exception:
        return None


def _round(value: Any, digits: int = 2) -> float | None:
    numeric = _safe_float(value)
    return round(numeric, digits) if numeric is not None else None


def _prepare_df(df: pd.DataFrame) -> pd.DataFrame:
    frame = df.copy()
    frame.columns = [str(col).lower() for col in frame.columns]
    if "date" not in frame.columns:
        frame = frame.reset_index().rename(columns={frame.columns[0]: "date"})
    frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
    for col in ["open", "high", "low", "close", "volume"]:
        frame[col] = pd.to_numeric(frame[col], errors="coerce")
    frame = frame.dropna(subset=["date", "open", "high", "low", "close"]).sort_values("date").reset_index(drop=True)
    frame["day"] = frame["date"].dt.strftime("%Y-%m-%d")
    return frame


def _add_indicators(df: pd.DataFrame) -> pd.DataFrame:
    frame = df.copy()
    close = frame["close"]
    high = frame["high"]
    low = frame["low"]
    volume = frame["volume"].fillna(0)

    frame["SMA_20"] = close.rolling(20).mean()
    frame["SMA_50"] = close.rolling(50).mean()
    frame["SMA_200"] = close.rolling(200).mean()
    frame["EMA_20"] = close.ewm(span=20, adjust=False).mean()
    frame["EMA_50"] = close.ewm(span=50, adjust=False).mean()

    try:
        import ta

        frame["RSI_14"] = ta.momentum.rsi(close, window=14)
        frame["MACD"] = ta.trend.macd(close)
        frame["MACD_signal"] = ta.trend.macd_signal(close)
        frame["ATR_14"] = ta.volatility.average_true_range(high, low, close, window=14)
    except Exception:
        delta = close.diff()
        gain = delta.clip(lower=0).rolling(14).mean()
        loss = (-delta.clip(upper=0)).rolling(14).mean()
        rs = gain / loss.replace(0, np.nan)
        frame["RSI_14"] = 100 - (100 / (1 + rs))
        frame["MACD"] = close.ewm(span=12, adjust=False).mean() - close.ewm(span=26, adjust=False).mean()
        frame["MACD_signal"] = frame["MACD"].ewm(span=9, adjust=False).mean()
        true_range = pd.concat(
            [(high - low), (high - close.shift()).abs(), (low - close.shift()).abs()],
            axis=1,
        ).max(axis=1)
        frame["ATR_14"] = true_range.rolling(14).mean()

    frame["VOL_SMA_20"] = volume.rolling(20).mean()
    return frame


def _filter_timeframe(df: pd.DataFrame, timeframe_days: int | None, default_days: int = 1095) -> pd.DataFrame:
    if df.empty:
        return df
    days = timeframe_days or min(default_days, max(365, (df["date"].iloc[-1] - df["date"].iloc[0]).days))
    latest = df["date"].iloc[-1]
    cutoff = latest - timedelta(days=int(days))
    filtered = df[df["date"] >= cutoff].reset_index(drop=True)
    return filtered if len(filtered) >= 20 else df.tail(min(len(df), max(20, int(days)))).reset_index(drop=True)


def _resolve_target_stock(target: Any, current_ticker: str, known_stocks: list[dict[str, Any]] | None = None) -> str:
    raw = _normalise_text(target)
    if not raw or raw.lower() in {"current", "current stock", "this stock", "ticker", "null", "none"}:
        return current_ticker

    raw_upper = raw.upper()
    if "." in raw_upper or "-" in raw_upper:
        return raw_upper

    for stock in known_stocks or []:
        ticker = str(stock.get("ticker") or "").upper()
        symbol = str(stock.get("symbol") or "").upper()
        name = str(stock.get("name") or "").lower()
        if raw_upper in {ticker, symbol}:
            return ticker or current_ticker
        if raw.lower() == name or raw.lower() in name.split():
            return ticker or current_ticker

    # Indian symbols are most common in this app; default bare symbols to NSE.
    return f"{raw_upper}.NS" if raw_upper.isalnum() else current_ticker


def _sanitize_instruction(instruction: dict[str, Any] | None, current_ticker: str, prompt: str, known_stocks: list[dict[str, Any]] | None) -> dict[str, Any]:
    fallback = _empty_instruction(current_ticker, prompt)
    merged = {**fallback, **(instruction or {})}
    # The question TYPE comes from the keyword router, not the LLM. In testing
    # the LLM sent "52 week high and low" to a price-on-a-date lookup and
    # vague questions to backtests; the router only picks a computed answer
    # when the wording clearly asks for one, and sends everything else to a
    # written answer. The LLM still fills in the parameters (dates, amounts,
    # rules, other stocks) below.
    intent = fallback["intent"]

    strategy = merged.get("strategy_parameters")
    if not isinstance(strategy, dict):
        strategy = fallback["strategy_parameters"]
    roi = merged.get("roi_parameters")
    if not isinstance(roi, dict):
        roi = fallback["roi_parameters"]

    timeframe = merged.get("timeframe_days")
    try:
        timeframe = int(timeframe) if timeframe not in {None, "", "null"} else fallback["timeframe_days"]
    except Exception:
        timeframe = fallback["timeframe_days"]
    # Only honour a period the user actually typed ("last 90 days", "2 years").
    # Compilers tend to echo the example value from their prompt, which once
    # cut every backtest down to the last month.
    if fallback["timeframe_days"] is None:
        timeframe = None
    if timeframe is not None:
        timeframe = max(1, min(timeframe, 3650))

    quantity = _safe_float(roi.get("quantity")) or fallback["roi_parameters"]["quantity"]
    investment_date = roi.get("investment_date") or fallback["roi_parameters"]["investment_date"]
    if investment_date and not re.match(r"^\d{4}-\d{2}-\d{2}$", str(investment_date)):
        investment_date = fallback["roi_parameters"]["investment_date"]

    metrics = merged.get("technical_metrics_requested")
    if not isinstance(metrics, list) or not metrics:
        metrics = fallback["technical_metrics_requested"]

    # Written answers stay on the page's stock; another stock the question
    # names is brought in as comparison data, not swapped in.
    target_stock = (
        current_ticker
        if intent == "GENERAL_QUESTION"
        else _resolve_target_stock(merged.get("target_stock"), current_ticker, known_stocks)
    )

    return {
        "intent": intent,
        "target_stock": target_stock,
        "timeframe_days": timeframe,
        "strategy_parameters": {
            "buy_trigger": _normalise_text(strategy.get("buy_trigger")),
            "sell_trigger": _normalise_text(strategy.get("sell_trigger")),
            "entry_time": _normalise_text(strategy.get("entry_time")) or None,
            "exit_time": _normalise_text(strategy.get("exit_time")) or None,
        },
        "roi_parameters": {
            "quantity": quantity,
            "investment_date": investment_date,
        },
        "technical_metrics_requested": [str(item).upper() for item in metrics],
        "ai_context_summary": _normalise_text(merged.get("ai_context_summary")) or fallback["ai_context_summary"],
    }


def _groq_compile(prompt: str, current_ticker: str, known_stocks: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    if not llm_client.any_provider_available():
        return None

    try:
        known_payload = [
            {
                "name": item.get("name"),
                "symbol": item.get("symbol"),
                "ticker": item.get("ticker"),
                "exchange": item.get("exchange"),
            }
            for item in _mentioned_stocks(prompt, known_stocks)
        ]
        system = (
            "You are a strict JSON logic compiler for a stock detail page. "
            "Convert the user's natural-language market question into ONLY this JSON object and no markdown/prose: "
            '{"intent":"BACKTEST_STRATEGY|HISTORICAL_ROI|HISTORICAL_PRICE|TECHNICAL_ANALYSIS|GENERAL_QUESTION",'
            '"target_stock":"Ticker of current stock, or explicit other stock if specified",'
            '"timeframe_days":"number of days ONLY if the user names a period, else null",'
            '"strategy_parameters":{"buy_trigger":"string condition or numerical rule","sell_trigger":"string condition or numerical rule","entry_time":"string or null","exit_time":"string or null"},'
            '"roi_parameters":{"quantity":"number or null","investment_date":"YYYY-MM-DD or null"},'
            '"technical_metrics_requested":["RSI","SMA_50","OVERBOUGHT_STATUS"],'
            '"ai_context_summary":"friendly short loader summary"}. '
            "BACKTEST_STRATEGY only for a concrete, testable buy/sell rule. HISTORICAL_PRICE for a price on a date. "
            "HISTORICAL_ROI for profit/loss on shares bought in the past. TECHNICAL_ANALYSIS for indicator readings. "
            "Use GENERAL_QUESTION for everything else (should I buy, outlook, why it moved, how it has performed, comparisons). "
            "Use the current ticker unless the user clearly names another stock. "
            "For relative holding questions like '30 days ago', set timeframe_days and leave investment_date null. "
            "For strategy questions, preserve the user's buy and sell rules descriptively; do not invent a recommendation. "
            "For dates, use YYYY-MM-DD. For unknown fields use null or empty arrays as appropriate."
        )
        response = llm_client.chat(
            temperature=0,
            max_tokens=550,
            model=os.getenv("GROQ_MODEL", llm_client.DEFAULT_GROQ_FAST_MODEL),
            messages=[
                {"role": "system", "content": system},
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "query": prompt,
                            "current_ticker": current_ticker,
                            "known_stocks": known_payload,
                            "today": datetime.utcnow().strftime("%Y-%m-%d"),
                        }
                    ),
                },
            ],
        )
        return _extract_json(response.get("text") or "")
    except Exception as exc:
        print(f"[StockAI] LLM compiler failed: {exc}")
        return None


def _mentioned_stocks(prompt: str, known_stocks: list[dict[str, Any]] | None, limit: int = 12) -> list[dict[str, Any]]:
    """Only the stocks the question actually names.

    Sending all ~900 known stocks to the compiler cost ~25k tokens per question,
    which blows through free-tier per-minute token limits and made the LLM step
    fail. The compiler only needs candidates for a stock the user mentioned.
    """
    # Everyday words that are also tickers ("has" is Hasbro, "now" ServiceNow)
    # only count when typed in capitals; "how has it performed" once pulled in
    # Hasbro's history as comparison data.
    typed_upper = {t.lower() for t in re.findall(r"[A-Z0-9&]{2,}", prompt)}
    words = {
        w for w in re.findall(r"[a-z0-9&]+", prompt.lower())
        if len(w) >= 3 and (w not in _COMMON_WORDS or w in typed_upper)
    }
    scored: list[tuple[int, dict[str, Any]]] = []
    for stock in known_stocks or []:
        symbol = str(stock.get("symbol") or "").lower()
        # Generic words ("bank", "india", "limited") name half the market; a
        # question saying "bank" is not a mention of Kotak Mahindra Bank.
        name_words = {
            w for w in re.findall(r"[a-z0-9&]+", str(stock.get("name") or "").lower())
            if len(w) >= 4 and w not in _GENERIC_NAME_WORDS
        }
        if symbol in words:
            score = 3
        elif any(len(w) >= 3 and symbol.startswith(w) and len(symbol) - len(w) <= 2 for w in words):
            score = 2  # "sbi" -> SBIN
        elif words & name_words:
            score = 1
        else:
            continue
        scored.append((score, stock))
    scored.sort(key=lambda item: -item[0])
    return [stock for _, stock in scored[:limit]]


_COMMON_WORDS = set("""
has have had the and for are was were how why what when who whom which now buy sell hold can could will would
should shall this that these those with from into onto year years month months week weeks today tomorrow price
prices stock stocks share shares good bad best better worst high low its did does done been any all one two three
new old big top out over under more less than then also just much many very some time long short term return
returns perform performed performance growth value compare compared versus about after before since last next
past still keep worth safe risk risky give show tell explain should invest investing investment market markets
trend trading trade chart analysis data fall fell rise rose gain gains loss losses doing going like look looks
kya hai hain abhi lena karna kaisa kaise mein nahi wala wali
""".split())


_GENERIC_NAME_WORDS = {
    "bank", "india", "indian", "limited", "ltd", "industries", "industry", "services", "service",
    "corporation", "company", "finance", "financial", "motors", "power", "energy", "holdings",
    "enterprises", "technologies", "technology", "systems", "solutions", "international", "global",
    "pharma", "pharmaceuticals", "chemicals", "steel", "cement", "infra", "infrastructure", "capital",
    "insurance", "life", "general", "national", "united", "group", "products", "foods", "consumer",
}


def _nearest_candles(df: pd.DataFrame, requested_date: str) -> tuple[pd.Series | None, pd.Series | None, pd.Series | None]:
    if df.empty:
        return None, None, None
    exact_rows = df[df["day"] == requested_date]
    exact = exact_rows.iloc[-1] if not exact_rows.empty else None
    previous_rows = df[df["day"] < requested_date]
    next_rows = df[df["day"] > requested_date]
    previous = previous_rows.iloc[-1] if not previous_rows.empty else None
    next_row = next_rows.iloc[0] if not next_rows.empty else None
    return exact, previous, next_row


def _row_payload(row: pd.Series | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {
        "date": row["day"],
        "open": _round(row["open"]),
        "high": _round(row["high"]),
        "low": _round(row["low"]),
        "close": _round(row["close"]),
        "volume": int(row["volume"]) if _safe_float(row.get("volume")) is not None else None,
    }


def _weekday_name(value: Any) -> str:
    return pd.to_datetime(value).day_name()


def _max_drawdown_from_returns(returns_pct: list[float]) -> float:
    if not returns_pct:
        return 0.0
    equity = pd.Series([(1 + r / 100.0) for r in returns_pct]).cumprod()
    drawdown = (equity - equity.cummax()) / equity.cummax() * 100
    return round(float(drawdown.min()), 2)


def _summary_from_trades(trades: list[dict[str, Any]], df: pd.DataFrame) -> dict[str, Any]:
    if df.empty:
        buy_hold = 0.0
    else:
        first = float(df.iloc[0]["close"])
        last = float(df.iloc[-1]["close"])
        buy_hold = ((last - first) / first * 100) if first > 0 else 0.0

    if not trades:
        return {
            "total_trades": 0,
            "wins": 0,
            "losses": 0,
            "win_rate": 0,
            "total_return_pct": 0,
            "avg_return_per_trade_pct": 0,
            "best_trade_pct": 0,
            "worst_trade_pct": 0,
            "max_drawdown_pct": 0,
            "buy_and_hold_return_pct": round(buy_hold, 2),
            "alpha_vs_buy_hold_pct": round(-buy_hold, 2),
        }

    returns = [float(trade["return_pct"]) for trade in trades]
    wins = len([value for value in returns if value > 0])
    total_return = (np.prod([(1 + value / 100) for value in returns]) - 1) * 100
    return {
        "total_trades": len(trades),
        "wins": wins,
        "losses": len(trades) - wins,
        "win_rate": round(wins / len(trades) * 100, 2),
        "total_return_pct": round(float(total_return), 2),
        "avg_return_per_trade_pct": round(float(np.mean(returns)), 2),
        "best_trade_pct": round(max(returns), 2),
        "worst_trade_pct": round(min(returns), 2),
        "max_drawdown_pct": _max_drawdown_from_returns(returns),
        "buy_and_hold_return_pct": round(buy_hold, 2),
        "alpha_vs_buy_hold_pct": round(float(total_return - buy_hold), 2),
    }


def _trade_payload(entry: pd.Series, exit_row: pd.Series, buy_price: float, sell_price: float, exit_reason: str) -> dict[str, Any]:
    pnl = sell_price - buy_price
    return_pct = (pnl / buy_price * 100) if buy_price > 0 else 0
    return {
        "buy_day": _weekday_name(entry["date"]),
        "buy_date": entry["day"],
        "buy_price": round(buy_price, 2),
        "sell_day": _weekday_name(exit_row["date"]),
        "sell_date": exit_row["day"],
        "sell_price": round(sell_price, 2),
        "holding_days": max(0, int((exit_row["date"] - entry["date"]).days)),
        "pnl_per_share": round(pnl, 2),
        "pnl_100shares": round(pnl * 100, 2),
        "return_pct": round(return_pct, 2),
        "result": "WIN" if return_pct > 0 else "LOSS",
        "exit_reason": exit_reason,
    }


def _parse_percent(text: str, default: float | None = None) -> float | None:
    match = re.search(r"(\d+(?:\.\d+)?)\s*%", text.lower())
    return float(match.group(1)) if match else default


def _field_from_time(value: str | None, fallback: str) -> str:
    clean = (value or "").lower()
    if "open" in clean:
        return "open"
    if "close" in clean:
        return "close"
    return fallback


def _weekday_strategy(prompt: str, params: dict[str, Any]) -> dict[str, Any] | None:
    text = f"{prompt} {params.get('buy_trigger') or ''} {params.get('sell_trigger') or ''} {params.get('entry_time') or ''} {params.get('exit_time') or ''}".lower()
    found = [day for day in WEEKDAYS if re.search(rf"\b{day}\b", text)]
    if len(found) < 2:
        return None
    buy_match = re.search(r"\b(?:buy|enter|entry)\b([\s\S]*?)(?=\b(?:sell|exit)\b|$)", text)
    sell_match = re.search(r"\b(?:sell|exit)\b([\s\S]*)", text)
    buy_text = buy_match.group(1) if buy_match else text
    sell_text = sell_match.group(1) if sell_match else text
    buy_day = next((day for day in WEEKDAYS if re.search(rf"\b{day}\b", buy_text)), found[0])
    sell_day = next((day for day in WEEKDAYS if re.search(rf"\b{day}\b", sell_text)), found[-1])
    return {
        "type": "weekday_pair",
        "buy_day": WEEKDAYS[buy_day],
        "sell_day": WEEKDAYS[sell_day],
        "buy_label": buy_day.title(),
        "sell_label": sell_day.title(),
        "buy_field": _field_from_time(params.get("entry_time") or buy_text, "close"),
        "sell_field": _field_from_time(params.get("exit_time") or sell_text, "open"),
    }


def _infer_backtest_rule(prompt: str, params: dict[str, Any]) -> dict[str, Any]:
    text = f"{prompt} {params.get('buy_trigger') or ''} {params.get('sell_trigger') or ''}".lower()

    weekday = _weekday_strategy(prompt, params)
    if weekday:
        return weekday

    if ("intraday" in text or "day" in text) and re.search(r"\b(drop|drops|fall|falls|down|dip)\b", text) and re.search(r"\b(profit|target|up|gain)\b", text):
        percents = [float(value) for value in re.findall(r"(\d+(?:\.\d+)?)\s*%", text)]
        return {
            "type": "intraday_drop_profit",
            "drop_pct": percents[0] if percents else 1.0,
            "profit_pct": percents[1] if len(percents) > 1 else 3.0,
        }

    if "rsi" in text:
        numbers = [float(value) for value in re.findall(r"\b(\d{1,3}(?:\.\d+)?)\b", text)]
        return {
            "type": "rsi_band",
            "buy_below": numbers[0] if numbers else 30.0,
            "sell_above": numbers[1] if len(numbers) > 1 else 70.0,
        }

    if "sma" in text or "ema" in text or "moving average" in text:
        return {"type": "ma_trend"}

    if re.search(r"\b(drop|drops|dropped|fall|falls|fell|down|dip|dips|declines?)\b", text):
        percent = _parse_percent(text, 1.0)
        return {"type": "daily_drop_next_close", "drop_pct": percent or 1.0}

    # Nothing we can simulate faithfully. Better to say so than to quietly
    # backtest a different strategy and present it as the user's.
    return {"type": "unsupported"}


def _run_weekday_backtest(df: pd.DataFrame, rule: dict[str, Any]) -> list[dict[str, Any]]:
    trades = []
    for idx in range(len(df) - 1):
        entry = df.iloc[idx]
        if int(entry["date"].weekday()) != rule["buy_day"]:
            continue
        exit_idx = None
        for cursor in range(idx + 1, len(df)):
            if int(df.iloc[cursor]["date"].weekday()) == rule["sell_day"]:
                exit_idx = cursor
                break
        if exit_idx is None:
            continue
        exit_row = df.iloc[exit_idx]
        buy_price = float(entry[rule["buy_field"]])
        sell_price = float(exit_row[rule["sell_field"]])
        trades.append(_trade_payload(entry, exit_row, buy_price, sell_price, f"Next {rule['sell_label']} {rule['sell_field']}"))
    return trades


def _run_intraday_drop_profit_backtest(df: pd.DataFrame, rule: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    trades = []
    open_trade = None
    idx = 0
    while idx < len(df):
        row = df.iloc[idx]
        buy_price = float(row["open"]) * (1 - float(rule["drop_pct"]) / 100)
        if float(row["low"]) > buy_price:
            idx += 1
            continue
        target = buy_price * (1 + float(rule["profit_pct"]) / 100)
        exited = False
        for exit_idx in range(idx, len(df)):
            exit_row = df.iloc[exit_idx]
            if float(exit_row["high"]) >= target:
                trades.append(_trade_payload(row, exit_row, buy_price, target, f"{rule['profit_pct']}% profit target touched"))
                idx = exit_idx + 1
                exited = True
                break
        if not exited:
            latest = df.iloc[-1]
            current = float(latest["close"])
            open_trade = {
                "buy_date": row["day"],
                "buy_day": _weekday_name(row["date"]),
                "buy_price": round(buy_price, 2),
                "target_price": round(target, 2),
                "current_price": round(current, 2),
                "holding_days": max(0, int((latest["date"] - row["date"]).days)),
                "return_pct": round((current - buy_price) / buy_price * 100, 2),
                "exit_reason": "Still open; target has not been touched in loaded OHLCV data.",
            }
            break
    return trades, open_trade


def _run_rsi_backtest(df: pd.DataFrame, rule: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    frame = _add_indicators(df).dropna(subset=["RSI_14"]).reset_index(drop=True)
    trades = []
    in_trade = False
    entry = None
    buy_price = 0.0
    for _, row in frame.iterrows():
        rsi = float(row["RSI_14"])
        if not in_trade and rsi <= float(rule["buy_below"]):
            entry = row
            buy_price = float(row["close"])
            in_trade = True
        elif in_trade and rsi >= float(rule["sell_above"]):
            trades.append(_trade_payload(entry, row, buy_price, float(row["close"]), f"RSI reached {rule['sell_above']}"))
            in_trade = False
    open_trade = None
    if in_trade and entry is not None:
        latest = frame.iloc[-1]
        current = float(latest["close"])
        open_trade = {
            "buy_date": entry["day"],
            "buy_day": _weekday_name(entry["date"]),
            "buy_price": round(buy_price, 2),
            "current_price": round(current, 2),
            "current_rsi": round(float(latest["RSI_14"]), 2),
            "holding_days": max(0, int((latest["date"] - entry["date"]).days)),
            "return_pct": round((current - buy_price) / buy_price * 100, 2),
        }
    return trades, open_trade


def _run_ma_trend_backtest(df: pd.DataFrame) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    frame = _add_indicators(df).dropna(subset=["SMA_50", "EMA_20"]).reset_index(drop=True)
    trades = []
    in_trade = False
    entry = None
    buy_price = 0.0
    for _, row in frame.iterrows():
        buy_signal = float(row["close"]) > float(row["SMA_50"]) and float(row["close"]) > float(row["EMA_20"])
        sell_signal = float(row["close"]) < float(row["EMA_20"])
        if not in_trade and buy_signal:
            entry = row
            buy_price = float(row["close"])
            in_trade = True
        elif in_trade and sell_signal:
            trades.append(_trade_payload(entry, row, buy_price, float(row["close"]), "Close fell below EMA 20"))
            in_trade = False
    return trades, None


def _run_daily_drop_backtest(df: pd.DataFrame, rule: dict[str, Any]) -> list[dict[str, Any]]:
    trades = []
    threshold = -abs(float(rule["drop_pct"]))
    frame = df.copy()
    frame["day_return"] = frame["close"].pct_change() * 100
    for idx in range(1, len(frame) - 1):
        entry = frame.iloc[idx]
        if float(entry["day_return"]) > threshold:
            continue
        exit_row = frame.iloc[idx + 1]
        trades.append(_trade_payload(entry, exit_row, float(entry["close"]), float(exit_row["close"]), "Next close after drop trigger"))
    return trades


def _handle_backtest(prompt: str, instruction: dict[str, Any], df: pd.DataFrame) -> dict[str, Any]:
    frame = _filter_timeframe(df, instruction.get("timeframe_days"))
    rule = _infer_backtest_rule(prompt, instruction["strategy_parameters"])
    if rule["type"] == "unsupported":
        return _handle_general_question(
            prompt,
            instruction,
            df,
            note=(
                "The user asked for a strategy the backtester cannot simulate. Say so plainly, then list "
                "what it can test: weekday pairs (buy Friday close, sell Monday open), intraday drop with "
                "a profit target (buy on a 1% intraday drop, sell at 3% profit), RSI bands (buy under 30, "
                "sell over 70), moving-average trend, and buying after a daily drop. Suggest the closest one."
            ),
        )
    open_trade = None

    if rule["type"] == "weekday_pair":
        trades = _run_weekday_backtest(frame, rule)
        buy_expr = f"Buy on {rule['buy_label']} {rule['buy_field']}"
        sell_expr = f"Sell on next {rule['sell_label']} {rule['sell_field']}"
    elif rule["type"] == "intraday_drop_profit":
        trades, open_trade = _run_intraday_drop_profit_backtest(frame, rule)
        buy_expr = f"Buy when intraday low touches open - {rule['drop_pct']}%"
        sell_expr = f"Sell when high touches {rule['profit_pct']}% profit target"
    elif rule["type"] == "rsi_band":
        trades, open_trade = _run_rsi_backtest(frame, rule)
        buy_expr = f"Buy when RSI <= {rule['buy_below']}"
        sell_expr = f"Sell when RSI >= {rule['sell_above']}"
    elif rule["type"] == "ma_trend":
        trades, open_trade = _run_ma_trend_backtest(frame)
        buy_expr = "Buy when close is above SMA 50 and EMA 20"
        sell_expr = "Sell when close falls below EMA 20"
    else:
        trades = _run_daily_drop_backtest(frame, rule)
        buy_expr = f"Buy after a daily close drop of at least {rule['drop_pct']}%"
        sell_expr = "Sell next trading day close"

    summary = _summary_from_trades(trades, frame)
    analysis = (
        f"Tested {instruction['target_stock']} over {len(frame)} loaded trading candles from "
        f"{frame.iloc[0]['day']} to {frame.iloc[-1]['day']}. The strategy generated "
        f"{summary['total_trades']} closed trades, {summary['win_rate']}% win rate, "
        f"{summary['total_return_pct']}% compounded return, and {summary['max_drawdown_pct']}% max drawdown. "
        f"Buy-and-hold over the same window returned {summary['buy_and_hold_return_pct']}%."
    )

    return {
        "type": "strategy_test",
        "title": "Backtest result",
        "answer": analysis,
        "target_stock": instruction["target_stock"],
        "ai_context_summary": instruction["ai_context_summary"],
        "router": instruction,
        "custom_metrics": {
            "success": True,
            "prompt": prompt,
            "buy_expr": buy_expr,
            "sell_expr": sell_expr,
            "mode": rule["type"],
            "analysis_text": analysis,
            "current_signal": "HOLD",
            "summary": summary,
            "trades": trades[-40:],
            "open_trade": open_trade,
            "total_trades": summary["total_trades"],
            "win_rate": summary["win_rate"],
            "avg_return_per_trade_pct": summary["avg_return_per_trade_pct"],
            "total_return_pct": summary["total_return_pct"],
            "max_drawdown_pct": summary["max_drawdown_pct"],
            "buy_and_hold_return_pct": summary["buy_and_hold_return_pct"],
            "alpha_vs_buy_hold_pct": summary["alpha_vs_buy_hold_pct"],
        },
    }


def _handle_historical_price(instruction: dict[str, Any], df: pd.DataFrame) -> dict[str, Any]:
    requested = instruction["roi_parameters"].get("investment_date")
    if not requested:
        requested = df.iloc[-1]["day"]
    exact, previous, next_row = _nearest_candles(df, str(requested))
    candle = exact if exact is not None else previous if previous is not None else next_row
    answer = (
        f"{instruction['target_stock']} OHLCV for {requested} is available."
        if exact is not None
        else f"No exact trading candle for {requested}; showing the nearest available trading day."
    )
    return {
        "type": "historical_price",
        "title": "Historical price",
        "answer": answer,
        "target_stock": instruction["target_stock"],
        "requested_date": requested,
        "candle": _row_payload(candle),
        "exact_match": exact is not None,
        "nearest": {"previous": _row_payload(previous), "next": _row_payload(next_row)},
        "ai_context_summary": instruction["ai_context_summary"],
        "router": instruction,
    }


def _handle_historical_roi(instruction: dict[str, Any], df: pd.DataFrame) -> dict[str, Any]:
    latest = df.iloc[-1]
    quantity = _safe_float(instruction["roi_parameters"].get("quantity")) or 1.0
    requested = instruction["roi_parameters"].get("investment_date")
    if not requested and instruction.get("timeframe_days"):
        target_date = latest["date"] - timedelta(days=int(instruction["timeframe_days"]))
        requested = target_date.strftime("%Y-%m-%d")
    if not requested:
        requested = df.iloc[max(0, len(df) - 31)]["day"]

    exact, previous, next_row = _nearest_candles(df, str(requested))
    buy_row = exact if exact is not None else previous if previous is not None else next_row
    if buy_row is None:
        raise ValueError("No historical candle is available for the requested ROI date.")

    buy_price = float(buy_row["close"])
    current_price = float(latest["close"])
    invested = buy_price * quantity
    current_value = current_price * quantity
    pnl = current_value - invested
    return_pct = (pnl / invested * 100) if invested else 0.0
    answer = (
        f"{quantity:g} shares of {instruction['target_stock']} bought at the {buy_row['day']} close "
        f"would be {'up' if pnl >= 0 else 'down'} {abs(return_pct):.2f}% by {latest['day']}."
    )
    return {
        "type": "historical_roi",
        "title": "Historical ROI",
        "answer": answer,
        "target_stock": instruction["target_stock"],
        "quantity": quantity,
        "requested_date": requested,
        "investment_date": buy_row["day"],
        "latest_date": latest["day"],
        "exact_match": exact is not None,
        "buy_price": round(buy_price, 2),
        "current_price": round(current_price, 2),
        "invested": round(invested, 2),
        "current_value": round(current_value, 2),
        "pnl": round(pnl, 2),
        "return_pct": round(return_pct, 2),
        "ai_context_summary": instruction["ai_context_summary"],
        "router": instruction,
    }


def _technical_status(rsi: float | None) -> str:
    if rsi is None:
        return "Unavailable"
    if rsi >= 70:
        return "Overbought"
    if rsi <= 30:
        return "Oversold"
    return "Neutral"


def _handle_technical_analysis(instruction: dict[str, Any], df: pd.DataFrame) -> dict[str, Any]:
    frame = _add_indicators(df)
    latest = frame.iloc[-1]
    recent_20 = frame.tail(min(20, len(frame)))
    recent_50 = frame.tail(min(50, len(frame)))
    rsi = _round(latest.get("RSI_14"))
    support_20 = _round(recent_20["low"].min())
    resistance_20 = _round(recent_20["high"].max())
    support_50 = _round(recent_50["low"].min())
    resistance_50 = _round(recent_50["high"].max())
    metrics = {
        "latest_close": _round(latest["close"]),
        "latest_date": latest["day"],
        "RSI": rsi,
        "OVERBOUGHT_STATUS": _technical_status(rsi),
        "SMA_20": _round(latest.get("SMA_20")),
        "SMA_50": _round(latest.get("SMA_50")),
        "SMA_200": _round(latest.get("SMA_200")),
        "EMA_20": _round(latest.get("EMA_20")),
        "EMA_50": _round(latest.get("EMA_50")),
        "MACD": _round(latest.get("MACD"), 4),
        "MACD_SIGNAL": _round(latest.get("MACD_signal"), 4),
        "SUPPORT_20": support_20,
        "RESISTANCE_20": resistance_20,
        "SUPPORT_50": support_50,
        "RESISTANCE_50": resistance_50,
    }
    answer = (
        f"{instruction['target_stock']} latest loaded RSI is {rsi if rsi is not None else 'unavailable'}, "
        f"which reads as {metrics['OVERBOUGHT_STATUS']}. The 20-day support/resistance zone is "
        f"{support_20} to {resistance_20}."
    )
    rows = [[key, value] for key, value in metrics.items() if value is not None]
    return {
        "type": "technical_analysis",
        "title": "Technical analysis",
        "answer": answer,
        "target_stock": instruction["target_stock"],
        "metrics": metrics,
        "rows": rows,
        "ai_context_summary": instruction["ai_context_summary"],
        "router": instruction,
    }


def _pct_change(df: pd.DataFrame, sessions: int) -> float | None:
    if len(df) <= sessions:
        return None
    base = _safe_float(df["close"].iloc[-1 - sessions])
    last = _safe_float(df["close"].iloc[-1])
    if not base or last is None:
        return None
    return round((last / base - 1) * 100, 2)


def _market_context(df: pd.DataFrame) -> list[list[Any]]:
    """The stock's own price numbers, as label/value rows, for grounding an answer."""
    frame = _add_indicators(df)
    latest = frame.iloc[-1]
    close = _safe_float(latest["close"])
    year = frame.tail(min(252, len(frame)))
    high_52 = _round(year["high"].max())
    low_52 = _round(year["low"].min())
    rsi = _round(latest.get("RSI_14"), 1)
    atr = _safe_float(latest.get("ATR_14"))
    vol_ratio = None
    if _safe_float(latest.get("VOL_SMA_20")):
        vol_ratio = _round(_safe_float(latest["volume"]) / _safe_float(latest["VOL_SMA_20"]), 2)

    def position(ma_key: str) -> str | None:
        ma = _safe_float(latest.get(ma_key))
        if ma is None or close is None:
            return None
        return f"{'above' if close >= ma else 'below'} ({_round(ma)})"

    macd = _safe_float(latest.get("MACD"))
    signal = _safe_float(latest.get("MACD_signal"))

    # Calendar periods, so "this year" and "in 2025" have real answers.
    latest_date = latest["date"]
    ytd = None
    this_year = frame[frame["date"].dt.year == latest_date.year]
    prior = frame[frame["date"].dt.year < latest_date.year]
    if not this_year.empty and not prior.empty and close:
        ytd = _round((close / float(prior["close"].iloc[-1]) - 1) * 100)
    calendar_rows: list[list[Any]] = []
    for yr in (latest_date.year - 1, latest_date.year - 2):
        in_year = frame[frame["date"].dt.year == yr]
        before = frame[frame["date"].dt.year < yr]
        if len(in_year) > 150 and not before.empty:
            change = (float(in_year["close"].iloc[-1]) / float(before["close"].iloc[-1]) - 1) * 100
            calendar_rows.append([f"Return in calendar {yr}", _round(change)])

    # How rough the ride has been over the last year.
    daily = year["close"].pct_change() * 100
    big_rows: list[list[Any]] = []
    if daily.notna().sum() > 20:
        worst_idx = daily.idxmin()
        best_idx = daily.idxmax()
        big_rows = [
            ["Biggest one-day fall (1y)", f"{_round(daily[worst_idx])}% on {year.loc[worst_idx, 'day']}"],
            ["Biggest one-day rise (1y)", f"{_round(daily[best_idx])}% on {year.loc[best_idx, 'day']}"],
            ["Days down more than 3% (1y)", int((daily < -3).sum())],
            ["Days up more than 3% (1y)", int((daily > 3).sum())],
        ]
        ytd_daily = this_year["close"].pct_change() * 100
        if len(ytd_daily) > 5:
            big_rows.append(["Days down more than 3% (this year)", int((ytd_daily < -3).sum())])

    rows: list[list[Any]] = [
        ["Last close", _round(close)],
        ["As of", latest["day"]],
        ["1 week %", _pct_change(frame, 5)],
        ["1 month %", _pct_change(frame, 21)],
        ["3 months %", _pct_change(frame, 63)],
        ["6 months %", _pct_change(frame, 126)],
        ["1 year %", _pct_change(frame, 252)],
        [f"Year to date ({latest_date.year}) %", ytd],
        *calendar_rows,
        ["52-week high", high_52],
        ["52-week low", low_52],
        ["From 52-week high %", _round((close / high_52 - 1) * 100) if close and high_52 else None],
        ["Above 52-week low %", _round((close / low_52 - 1) * 100) if close and low_52 else None],
        ["RSI (14)", rsi],
        ["RSI reading", _technical_status(rsi)],
        ["vs SMA 20", position("SMA_20")],
        ["vs SMA 50", position("SMA_50")],
        ["vs SMA 200", position("SMA_200")],
        ["MACD vs signal", None if macd is None or signal is None else ("above (bullish)" if macd >= signal else "below (bearish)")],
        ["Typical daily move (ATR %)", _round(atr / close * 100) if atr and close else None],
        ["Volume vs 20-day avg (x)", vol_ratio],
        *big_rows,
    ]
    return [row for row in rows if row[1] is not None]


def _fundamental_context(ticker: str) -> list[list[Any]]:
    """Company and valuation figures from the daily snapshot, with sector medians."""
    try:
        from app.services.stock_snapshot_service import sector_peer_comparison, snapshot_by_ticker

        row = (snapshot_by_ticker([ticker], max_age_hours=None) or {}).get(ticker) or {}
        peers = sector_peer_comparison(ticker)
    except Exception as exc:  # noqa: BLE001 - answers still work on price data alone
        print(f"[StockAI] fundamentals unavailable for {ticker}: {exc}")
        return []
    if not row:
        return []
    medians = {m.get("key"): m.get("median") for m in (peers.get("metrics") or []) if peers.get("available")}

    def with_median(value: Any, key: str, digits: int = 2) -> Any:
        v = _round(value, digits)
        if v is None:
            return None
        median = _round(medians.get(key), digits)
        return f"{v} (sector median {median})" if median is not None else v

    cap_cr = _safe_float(row.get("market_cap_cr"))
    rows: list[list[Any]] = [
        ["Company", row.get("name")],
        ["Sector", row.get("sector")],
        ["Market cap", (f"₹{cap_cr / 100000:.2f} lakh crore" if cap_cr >= 100000 else f"₹{cap_cr:,.0f} crore") if cap_cr else None],
        ["P/E (trailing)", with_median(row.get("trailing_pe"), "trailing_pe")],
        ["P/E (forward)", _round(row.get("forward_pe"))],
        ["Price / book", with_median(row.get("price_to_book"), "price_to_book")],
        ["Dividend yield %", with_median(row.get("dividend_yield"), "dividend_yield")],
        ["Revenue growth % (yoy)", with_median(row.get("revenue_growth"), "revenue_growth", 1)],
        ["Profit growth % (yoy)", _round(row.get("profit_growth"), 1)],
        ["Operating margin %", with_median(row.get("operating_margin"), "operating_margin", 1)],
        ["Profit margin %", with_median(row.get("profit_margin"), "profit_margin", 1)],
        ["Beta (vs market)", _round(row.get("beta"))],
        ["Sector peers compared", peers.get("peer_count") if peers.get("available") else None],
    ]
    return [r for r in rows if r[1] not in (None, "")]


def _comparison_context(prompt: str, current_ticker: str, known_stocks: list[dict[str, Any]] | None) -> tuple[str | None, list[list[Any]]]:
    """If the question names another stock, that stock's headline numbers."""
    same_market = [
        s for s in (known_stocks or [])
        if not current_ticker.upper().endswith((".NS", ".BO")) or str(s.get("ticker") or "").upper().endswith((".NS", ".BO"))
    ]
    for stock in _mentioned_stocks(prompt, same_market, limit=4):
        other = str(stock.get("ticker") or "").upper()
        if not other or other == current_ticker.upper():
            continue
        try:
            other_df = _prepare_df(get_historical_data(other, days=420))
        except Exception:  # noqa: BLE001
            continue
        if other_df.empty:
            continue
        keep = {"Last close", "1 month %", "3 months %", "6 months %", "1 year %", "From 52-week high %", "RSI (14)", "vs SMA 200"}
        price_rows = [r for r in _market_context(other_df) if r[0] in keep or r[0].startswith("Year to date")]
        fund_rows = [r for r in _fundamental_context(other) if r[0] in {"Company", "P/E (trailing)", "Price / book", "Dividend yield %", "Revenue growth % (yoy)", "Profit margin %"}]
        return other, price_rows + fund_rows
    return None, []


def _context_text(rows: list[list[Any]]) -> str:
    return "\n".join(f"{label}: {value}" for label, value in rows)


_ANSWER_SYSTEM = (
    "You are Bullseye's stock research assistant for Indian (NSE) equities. Prices are in rupees (₹).\n"
    "How to answer:\n"
    "1. Answer the exact question first, in the opening sentence. 'How has it performed this year?' starts "
    "with the year-to-date return; 'is it overvalued?' starts with the P/E against the sector median.\n"
    "2. Then add only the 2-3 facts that matter for THAT question. Do not recite every number you were given, "
    "and do not mention MACD, RSI or volume unless the question is about momentum, timing or trading.\n"
    "3. Explain any technical term in plain words the first time (e.g. 'RSI of 36, meaning sellers have been "
    "in control but it is not extreme'). Write for a smart non-expert.\n"
    "4. Use ONLY the data provided. Never invent news, earnings, management commentary or numbers. If the data "
    "cannot answer the question, say so in one sentence and say what it does show.\n"
    "5. Never predict a future price, give a price target, suggest a price to buy or sell at, or project past "
    "returns forward. If asked, say plainly that you can't, then describe the trend and the range it has traded "
    "in so the reader can judge.\n"
    "6. 'Should I buy/sell/hold' is not personal advice: give the balanced picture (what supports it, the main "
    "risk) and leave the decision to the reader.\n"
    "7. Reply in English. Only if the question itself is written in Hinglish or Hindi, reply in that language and "
    "the same script (Hinglish in English letters gets Hinglish in English letters, never Devanagari).\n"
    "8. Format: one paragraph of 3-5 complete sentences (two short paragraphs at most for comparisons). Plain "
    "text: no headings, no bullet points, no bold, no disclaimer (the page shows one). Vary your wording; do not "
    "end with a stock phrase like 'a cautious investor might watch'.\n"
    "9. " + LLM_RULE
)


_HINGLISH_WORDS = {
    "kya", "hai", "hain", "karu", "karun", "karna", "kare", "lena", "lenа", "chahiye", "abhi", "kab", "kitna",
    "kitne", "kaisa", "kaise", "mein", "nahi", "nahin", "bhai", "yaar", "ye", "yeh", "wo", "woh", "jayega",
    "jaayega", "hoga", "becho", "bechu", "khareed", "kharidu", "kharidna", "paisa", "acha", "accha", "sahi",
}


def _looks_hinglish(text: str) -> bool:
    words = re.findall(r"[a-z]+", text.lower())
    return sum(1 for w in words if w in _HINGLISH_WORDS) >= 2 or bool(re.search(r"[ऀ-ॿ]", text))


def _llm_answer(question: str, ticker: str, rows: list[list[Any]], note: str | None = None, max_tokens: int = 700) -> str | None:
    if not llm_client.any_provider_available():
        return None
    content = f"Stock: {ticker}\nQuestion: {question}\n\nData for {ticker}:\n{_context_text(rows)}"
    if note:
        content += f"\n\n{note}"
    content += (
        "\n\nThe question is written in Hinglish: reply in Hinglish using English letters."
        if _looks_hinglish(question)
        else "\n\nReply in English."
    )
    try:
        result = llm_client.chat(
            [{"role": "system", "content": _ANSWER_SYSTEM}, {"role": "user", "content": content}],
            temperature=0.25,
            max_tokens=max_tokens,
        )
        text = (result.get("text") or "").strip()
        if is_off_topic_marker(text):
            return OFF_TOPIC_REPLY
        # Belt and braces: the page renders plain text.
        text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
        text = re.sub(r"^\s*[-*•]\s+", "", text, flags=re.MULTILINE)
        return text or None
    except Exception as exc:  # noqa: BLE001 - fall back to the deterministic summary
        print(f"[StockAI] answer generation failed: {exc}")
        return None


def _deterministic_answer(ticker: str, rows: list[list[Any]]) -> str:
    data = {label: value for label, value in rows}
    parts = [f"{ticker} last closed at ₹{data.get('Last close')} ({data.get('As of')})."]
    if data.get("1 month %") is not None:
        parts.append(f"It is {data['1 month %']:+.2f}% over the past month and {data.get('1 year %', 0):+.2f}% over the year.")
    if data.get("RSI (14)") is not None:
        parts.append(f"RSI is {data['RSI (14)']} ({data.get('RSI reading', 'neutral').lower()}).")
    if data.get("vs SMA 50"):
        parts.append(f"The price is {data['vs SMA 50'].split(' ')[0]} its 50-day average.")
    return " ".join(parts)


def _handle_general_question(
    prompt: str,
    instruction: dict[str, Any],
    df: pd.DataFrame,
    note: str | None = None,
    known_stocks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    ticker = instruction["target_stock"]
    rows = _market_context(df) + _fundamental_context(ticker)
    other, other_rows = (None, []) if note else _comparison_context(prompt, ticker, known_stocks)
    extra = note
    if other and other_rows:
        extra = f"Data for {other} (the stock the question compares against):\n{_context_text(other_rows)}"
    answer = _llm_answer(prompt, ticker, rows, note=extra)
    if answer == OFF_TOPIC_REPLY:
        return {"type": "assistant_answer", "title": "Answer", "answer": answer, "answered_by": "guard",
                "target_stock": ticker, "rows": []}
    return {
        "type": "assistant_answer",
        "title": "Strategy not supported" if note else "Answer",
        "answer": answer or _deterministic_answer(ticker, rows),
        "answered_by": "ai" if answer else "data",
        "target_stock": ticker,
        "rows": rows,
        "ai_context_summary": instruction["ai_context_summary"],
        "router": instruction,
    }


def _ai_summary(prompt: str, result: dict[str, Any]) -> str | None:
    """One or two plain-English sentences explaining a computed result."""
    facts = {k: v for k, v in result.items() if k in {
        "answer", "quantity", "investment_date", "latest_date", "buy_price", "current_price", "pnl", "return_pct",
        "requested_date", "exact_match", "metrics", "candle", "invested", "current_value",
    }}
    metrics = result.get("custom_metrics") or {}
    if metrics:
        facts["strategy"] = {k: metrics.get(k) for k in ("buy_expr", "sell_expr", "summary")}
    note = (
        "Explain this computed result to the user in 2 sentences: what it means and the one caveat that matters "
        "most (e.g. small sample, compounding, past performance). Use only these facts: "
        + json.dumps(facts, default=str)[:3500]
    )
    return _llm_answer(prompt, result.get("target_stock") or "", [], note=note, max_tokens=400)


def _money(value: Any) -> str:
    n = _safe_float(value)
    return "—" if n is None else f"₹{n:,.2f}"


def _exact_summary(result: dict[str, Any]) -> str | None:
    """Plain-English summaries built from the computed numbers themselves.

    In testing the LLM mis-multiplied a P&L ("worth ₹72,120" for 25 shares at
    ₹721), so results that are pure arithmetic get exact sentences instead.
    """
    kind = result.get("type")
    stock = str(result.get("target_stock") or "").replace(".NS", "").replace(".BO", "")
    if kind == "historical_roi":
        pnl = _safe_float(result.get("pnl")) or 0.0
        qty = _safe_float(result.get("quantity")) or 0
        shares = f"{qty:g} share{'' if qty == 1 else 's'}"
        return (
            f"{shares} of {stock} bought at {_money(result.get('buy_price'))} on {result.get('investment_date')} cost "
            f"{_money(result.get('invested'))} and are worth {_money(result.get('current_value'))} at the "
            f"{result.get('latest_date')} close of {_money(result.get('current_price'))}. That is a "
            f"{'profit' if pnl >= 0 else 'loss'} of {_money(abs(pnl))} ({result.get('return_pct')}%), before "
            f"brokerage, taxes and any dividends received."
        )
    if kind == "historical_price":
        c = result.get("candle") or {}
        if not c:
            return None
        day = c.get("day") or c.get("date")
        lead = (
            f"On {day}, {stock}"
            if result.get("exact_match")
            else f"{result.get('requested_date')} wasn't a trading day. On the nearest session, {day}, {stock}"
        )
        return (
            f"{lead} opened at {_money(c.get('open'))}, traded between {_money(c.get('low'))} and "
            f"{_money(c.get('high'))}, and closed at {_money(c.get('close'))}."
        )
    return None


def run_stock_ai_search(
    prompt: str,
    current_ticker: str,
    known_stocks: list[dict[str, Any]] | None = None,
    with_summary: bool = True,
) -> dict[str, Any]:
    canned = small_talk_reply(prompt)
    if canned:
        # Answered before any data load or LLM call: "hi" used to take seconds.
        ticker = _normalise_text(current_ticker).upper()
        return {
            "type": "assistant_answer",
            "title": "Answer",
            "answer": canned,
            "answered_by": "guard",
            "target_stock": ticker,
            "rows": [],
        }
    if not known_stocks:
        from app.services.stock_snapshot_service import catalog_stocks

        known_stocks = catalog_stocks()
    result = _run_stock_ai_search(prompt, current_ticker, known_stocks)
    exact = _exact_summary(result)
    if exact:
        result["ai_summary"] = exact
    elif with_summary and result.get("type") != "assistant_answer":
        summary = _ai_summary(prompt, result)
        if summary:
            result["ai_summary"] = summary
    return result


def _run_stock_ai_search(prompt: str, current_ticker: str, known_stocks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    if not _normalise_text(prompt):
        raise ValueError("Prompt is required.")
    current_ticker = _normalise_text(current_ticker).upper()
    # A written answer uses nothing the compiler extracts (the router picks the
    # intent and the page's stock is the subject), so skip that LLM round trip.
    needs_parameters = _infer_intent(prompt) != "GENERAL_QUESTION"
    compiled = _groq_compile(prompt, current_ticker, known_stocks) if needs_parameters else None
    instruction = _sanitize_instruction(compiled, current_ticker, prompt, known_stocks)

    # Load a broad free/local window. Supabase is used first by data_service; yfinance is only a fallback.
    df = _prepare_df(get_historical_data(instruction["target_stock"], days=1095))
    if df.empty:
        raise ValueError(f"No OHLCV data available for {instruction['target_stock']}.")

    if instruction["intent"] == "BACKTEST_STRATEGY":
        return _handle_backtest(prompt, instruction, df)
    if instruction["intent"] == "HISTORICAL_ROI":
        return _handle_historical_roi(instruction, df)
    if instruction["intent"] == "HISTORICAL_PRICE":
        return _handle_historical_price(instruction, df)
    if instruction["intent"] == "TECHNICAL_ANALYSIS":
        return _handle_technical_analysis(instruction, df)
    return _handle_general_question(prompt, instruction, df, known_stocks=known_stocks)
