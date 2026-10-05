import requests
import yfinance as yf
import pandas as pd
import time
import os
import random
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

try:
    from app.services import price_store
    PRICE_STORE_OK = True
except Exception as e:
    print(f"[PriceStore] not available: {e}. Running without Storage cache.")
    price_store = None
    PRICE_STORE_OK = False

# ── Safe Supabase import ───────────────────────────────────────────────────────
try:
    from app.core.supabase_client import supabase
    SUPABASE_OK = supabase is not None
    SUPABASE_WRITES_OK = bool(os.getenv("SUPABASE_SERVICE_ROLE_KEY"))
    if SUPABASE_OK:
        print("[Supabase] connected")
    else:
        print("[Supabase] env vars missing. Running without DB cache.")
except Exception as e:
    print(f"[Supabase] not available: {e}. Running without DB cache.")
    supabase = None
    SUPABASE_OK = False
    SUPABASE_WRITES_OK = False

# ── In-memory caches (fast, lost on restart) ──────────────────────────────────
_hist_cache: dict = {}
_quote_cache: dict = {}
_chart_cache: dict = {}
_fundamentals_cache: dict = {}
_nse_quote_cache: dict = {}
HIST_TTL  = 3600   # 1 hour
QUOTE_TTL = 120    # 2 minutes
CHART_TTL = 3600
FUNDAMENTALS_TTL = 3600 * 6
NSE_QUOTE_TTL = 3600
# How many completed trading SESSIONS the cached history may be missing before
# we refetch from Yahoo.
#
# This was previously a flat 5 CALENDAR days, which silently served history that
# was missing up to a week of sessions. Because analysis derives current_price,
# entry, target and stop from the last bar of this frame, a cache missing the
# most recent session produced prices (and therefore signals) that were days
# out of date while the /quote endpoint reported the correct live price.
#
# 0 = the cache must contain the most recent completed session. On an exchange
# holiday Yahoo simply returns the same frame again, so the only cost of being
# strict is an occasional redundant fetch (bounded by the 1-hour RAM cache).
CACHE_MAX_MISSING_SESSIONS = 0

# NSE trades Mon-Fri and closes at 15:30 IST; treat a session as complete from
# 16:00 IST to leave room for the feed to settle.
_IST = timezone(timedelta(hours=5, minutes=30))
_SESSION_COMPLETE_HOUR_IST = 16


def _last_completed_session(now: datetime | None = None) -> pd.Timestamp:
    """Most recent weekday whose session has finished (holidays not modelled)."""
    current = (now or datetime.now(_IST)).astimezone(_IST)
    day = current.date()
    # Today only counts once the session has actually closed.
    if current.weekday() >= 5 or current.hour < _SESSION_COMPLETE_HOUR_IST:
        day = day - timedelta(days=1)
    while day.weekday() >= 5:  # rewind over Sat/Sun
        day = day - timedelta(days=1)
    return pd.Timestamp(day)


# The newest bar actually published, learned from Yahoo refreshes and from the
# market snapshot. Weekday arithmetic alone can't see exchange holidays: on
# Gandhi Jayanti every cached stock looked one session stale, so every request
# re-downloaded its history from Yahoo (which had nothing newer) and rewrote it
# to Supabase. A scan did that for hundreds of stocks and ran for minutes.
_observed_session: dict = {"date": None, "ts": 0.0}
_OBSERVED_SESSION_TTL = 6 * 3600


def _note_latest_bar(latest: pd.Timestamp | None) -> None:
    if latest is None or pd.isna(latest):
        return
    latest = pd.Timestamp(latest).normalize()
    current = _observed_session["date"]
    if current is None or latest >= current or time.time() - _observed_session["ts"] > _OBSERVED_SESSION_TTL:
        _observed_session["date"] = latest
        _observed_session["ts"] = time.time()


def _published_session() -> pd.Timestamp | None:
    """Newest bar known to exist market-wide, if learned recently."""
    candidates = []
    if _observed_session["date"] is not None and time.time() - _observed_session["ts"] < _OBSERVED_SESSION_TTL:
        candidates.append(_observed_session["date"])
    try:
        # Read the snapshot's in-memory cache only; never trigger a fetch here.
        from app.services import stock_snapshot_service as _snap

        rows = _snap._cache.get("rows") or []
        if rows and time.time() - float(_snap._cache.get("ts") or 0) < _OBSERVED_SESSION_TTL:
            dates = [str(r.get("latest_date") or "")[:10] for r in rows if r.get("latest_date")]
            if dates:
                candidates.append(pd.Timestamp(max(dates)))
    except Exception:
        pass
    return max(candidates) if candidates else None


def _sessions_missing(latest_cached: pd.Timestamp, now: datetime | None = None) -> int:
    """Count weekday sessions between the cache's newest bar and the last close."""
    published = _published_session()
    if published is not None and latest_cached.normalize() >= published:
        # Nothing newer exists yet (holiday, or today's bar not published).
        return 0
    last_session = _last_completed_session(now)
    start = latest_cached.normalize() + pd.Timedelta(days=1)
    if start > last_session:
        return 0
    return len(pd.bdate_range(start, last_session))
# Serialize writes to the shared Supabase client. It wraps a single httpx
# connection that isn't safe for concurrent use, so simultaneous upserts from
# the movers-scan thread pool trip "[WinError 10035] non-blocking socket
# operation could not be completed immediately" on Windows. One writer at a time
# plus a short bounded retry makes persistence reliable under that concurrency.
_supabase_write_lock = threading.Lock()
# Saving refreshed history used to happen inside the request (Storage upload
# plus ~25 Postgres upserts behind the lock above), so a user waited on the
# write. One background worker does it now; queued saves for the same ticker
# are collapsed.
_writeback_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="price-writeback")
_writeback_pending: set = set()
_writeback_guard = threading.Lock()
_SUPABASE_WRITE_RETRIES = 3
_SUPABASE_WRITE_BACKOFF = 0.5  # seconds; doubled each retry
YAHOO_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
}


def _required_history_rows(days: int) -> int:
    return max(50, min(days, int(days * 0.55)))


def _normalize_cached_history(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    out['date'] = pd.to_datetime(out['date'], errors='coerce')
    for col in ['open', 'high', 'low', 'close', 'volume']:
        out[col] = pd.to_numeric(out[col], errors='coerce')
    return out.dropna().sort_values('date').reset_index(drop=True)


def _cache_status(df: pd.DataFrame, ticker: str, days: int, source: str) -> tuple[bool, int]:
    required_rows = _required_history_rows(days)
    if len(df) < required_rows:
        print(f"[Cache] {source} data for {ticker} is too short ({len(df)} rows, need {required_rows}) - refreshing from Yahoo.")
        return False, 0

    latest_cached = df['date'].max()
    missing = _sessions_missing(latest_cached)
    if missing <= CACHE_MAX_MISSING_SESSIONS:
        print(f"[Cache] {source} hit for {ticker} ({len(df)} rows, latest {latest_cached.date()})")
        return True, missing

    print(
        f"[Cache] {source} data for {ticker} is missing {missing} session(s) "
        f"(latest {latest_cached.date()}, last close {_last_completed_session().date()}) - refreshing from Yahoo."
    )
    return False, missing


def _clean_scalar(value):
    if value is None:
        return None
    if isinstance(value, pd.Timestamp):
        return value.strftime("%Y-%m-%d")
    if pd.isna(value):
        return None
    if hasattr(value, "item"):
        try:
            value = value.item()
        except Exception:
            pass
    if isinstance(value, float):
        return round(value, 4)
    if isinstance(value, int):
        return value
    return value


def _first_non_null(*values):
    for value in values:
        cleaned = _clean_scalar(value)
        if cleaned is not None:
            return cleaned
    return None


def _nse_symbol_from_ticker(ticker: str):
    return ticker.upper().replace(".NS", "").replace(".BO", "")


def _range_for_days(days: int):
    if days <= 5:
        return "5d"
    if days <= 31:
        return "1mo"
    if days <= 93:
        return "3mo"
    if days <= 186:
        return "6mo"
    if days <= 370:
        return "1y"
    if days <= 740:
        return "2y"
    if days <= 1850:
        return "5y"
    if days <= 3700:
        return "10y"
    return "max"


def _normalize_ohlcv_frame(df: pd.DataFrame):
    if df is None or df.empty:
        return pd.DataFrame(columns=["date", "open", "high", "low", "close", "volume"])

    clean = df.copy()
    if isinstance(clean.columns, pd.MultiIndex):
        clean.columns = clean.columns.get_level_values(0)
    clean.columns = [str(c).lower() for c in clean.columns]

    date_col = "datetime" if "datetime" in clean.columns else "date"
    clean = clean.rename(columns={date_col: "date"})
    required_cols = ["date", "open", "high", "low", "close", "volume"]
    if any(col not in clean.columns for col in required_cols):
        return pd.DataFrame(columns=required_cols)
    clean = clean[required_cols].copy()
    clean["date"] = pd.to_datetime(clean["date"], errors="coerce")
    for col in ["open", "high", "low", "close", "volume"]:
        clean[col] = pd.to_numeric(clean[col], errors="coerce")
    clean["volume"] = clean["volume"].fillna(0)
    clean = clean.dropna(subset=["date", "open", "high", "low", "close"])
    clean = clean.sort_values("date").drop_duplicates(subset=["date"], keep="last")
    return clean.reset_index(drop=True)


def _fetch_yahoo_chart_data(ticker: str, range_key: str = "1y", interval: str = "1d"):
    last_error = None
    params = {
        "range": range_key,
        "interval": interval,
        "includePrePost": "false",
        "events": "div,splits",
    }

    for host in ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]:
        url = f"https://{host}/v8/finance/chart/{ticker}"
        try:
            response = requests.get(url, params=params, headers=YAHOO_HEADERS, timeout=10)
            response.raise_for_status()
            payload = response.json()
            chart = payload.get("chart", {})
            error = chart.get("error")
            if error:
                raise ValueError(error.get("description") or str(error))

            result = (chart.get("result") or [None])[0]
            if not result or not result.get("timestamp"):
                raise ValueError(f"No Yahoo chart timestamps for ticker '{ticker}'.")

            quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
            timestamps = result["timestamp"]
            row_count = len(timestamps)

            def values_for(name: str, default=None):
                values = list(quote.get(name) or [])
                if len(values) < row_count:
                    values.extend([default] * (row_count - len(values)))
                return values[:row_count]

            rows = {
                "date": pd.to_datetime(timestamps, unit="s", utc=True).tz_convert(None),
                "open": values_for("open"),
                "high": values_for("high"),
                "low": values_for("low"),
                "close": values_for("close"),
                "volume": values_for("volume", 0),
            }
            df = _normalize_ohlcv_frame(pd.DataFrame(rows))
            if df.empty:
                raise ValueError(f"No valid Yahoo chart rows for ticker '{ticker}'.")
            return df
        except Exception as exc:
            last_error = exc
            print(f"[YahooChart] {host} failed for {ticker} ({range_key}/{interval}): {exc}")

    raise ValueError(f"Yahoo chart data unavailable for '{ticker}': {last_error}")


def get_nse_quote_data(ticker: str):
    symbol = _nse_symbol_from_ticker(ticker)
    now = time.time()
    if symbol in _nse_quote_cache and now - _nse_quote_cache[symbol]["ts"] < NSE_QUOTE_TTL:
        return _nse_quote_cache[symbol]["data"]

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": f"https://www.nseindia.com/get-quotes/equity?symbol={symbol}",
    }

    session = requests.Session()
    try:
        session.get("https://www.nseindia.com", headers=headers, timeout=6)
        quote = session.get(
            "https://www.nseindia.com/api/quote-equity",
            params={"symbol": symbol},
            headers=headers,
            timeout=8,
        ).json()
        trade_info = session.get(
            "https://www.nseindia.com/api/quote-equity",
            params={"symbol": symbol, "section": "trade_info"},
            headers=headers,
            timeout=8,
        ).json()
    except Exception as e:
        print(f"[NSE] quote lookup failed for {symbol}: {e}")
        return {}

    price_info = quote.get("priceInfo", {})
    metadata = quote.get("metadata", {})
    security_info = quote.get("securityInfo", {})
    industry_info = quote.get("industryInfo", {})
    trade = trade_info.get("marketDeptOrderBook", {}).get("tradeInfo", {})

    week_range = price_info.get("weekHighLow", {})
    intraday = price_info.get("intraDayHighLow", {})
    result = {
        "symbol": symbol,
        "company_name": _first_non_null(metadata.get("companyName"), quote.get("info", {}).get("companyName")),
        "industry": _first_non_null(industry_info.get("industry"), metadata.get("industry")),
        "sector": _first_non_null(industry_info.get("sector"), metadata.get("pdSectorInd")),
        "current_price": _first_non_null(price_info.get("lastPrice")),
        "previous_close": _first_non_null(price_info.get("previousClose")),
        "day_high": _first_non_null(intraday.get("max")),
        "day_low": _first_non_null(intraday.get("min")),
        "high_52_week": _first_non_null(week_range.get("max")),
        "low_52_week": _first_non_null(week_range.get("min")),
        "market_cap": _first_non_null(trade.get("totalMarketCap")),
        "free_float_market_cap": _first_non_null(trade.get("ffmc")),
        "trailing_pe": _first_non_null(metadata.get("pdSymbolPe")),
        "sector_pe": _first_non_null(metadata.get("pdSectorPe")),
        "face_value": _first_non_null(security_info.get("faceValue")),
        "isin": _first_non_null(metadata.get("isin")),
        "listing_date": _first_non_null(metadata.get("listingDate")),
        "source": "NSE",
    }
    _nse_quote_cache[symbol] = {"data": result, "ts": time.time()}
    return result


def _statement_to_table(df: pd.DataFrame | None, max_columns: int = 6, max_rows: int = 14):
    if df is None or df.empty:
        return {"columns": [], "rows": []}

    table = df.copy()

    if isinstance(table.columns, pd.MultiIndex):
        table.columns = table.columns.get_level_values(0)
    if isinstance(table.index, pd.MultiIndex):
        table.index = table.index.get_level_values(0)

    selected_columns = list(table.columns[:max_columns])
    columns = []
    for col in selected_columns:
        if isinstance(col, pd.Timestamp):
            columns.append(col.strftime("%b %Y"))
        else:
            columns.append(str(col))

    rows = []
    for label, row in table.head(max_rows).iterrows():
        values = [_clean_scalar(row[col]) for col in selected_columns]
        if not any(value is not None for value in values):
            continue
        rows.append({
            "label": str(label),
            "values": values,
        })

    return {"columns": columns, "rows": rows}


def get_snapshot_fundamentals(ticker: str, *, retries: int = 3, backoff: float = 1.2) -> dict:
    """Lean fundamentals for the daily snapshot build.

    Makes a SINGLE ``yfinance .info`` call (with retry/backoff) instead of the
    heavy per-ticker history + 4 financial statements + NSE quote that
    ``get_fundamentals_data`` fetches. In a 2,000-stock bulk build from a
    datacenter IP, that heavy path gets rate-limited into ~90% failures; the lean
    path keeps fundamentals populated for the whole universe.

    Units are normalised here so the stored snapshot is intuitive:
    - percentages that Yahoo returns as fractions (ROE, ROA, margins, growth) are
      x100 -> real percent;
    - ``dividendYield`` is ALREADY a percent in this yfinance build, so it is
      stored as-is (no x100);
    - ``debtToEquity`` is Yahoo's percent-of-equity, divided by 100 -> a ratio
      (0 = debt-free, 0.5 = 0.5x, 1 = 1x).
    """
    info: dict = {}
    # Small jitter so concurrent workers don't burst Yahoo's rate limiter in sync.
    time.sleep(random.uniform(0.05, 0.35))
    for attempt in range(max(1, retries)):
        try:
            info = yf.Ticker(ticker).info or {}
            if info.get("sector") or info.get("trailingPE") or info.get("marketCap"):
                break
        except Exception as exc:  # noqa: BLE001 - retry on transient rate limits
            print(f"[Snapshot] .info attempt {attempt + 1} failed for {ticker}: {exc}")
            info = {}
        if attempt < retries - 1:
            time.sleep(backoff * (attempt + 1))

    def _pct(key: str):  # Yahoo fraction (0.15) -> percent (15.0)
        value = info.get(key)
        return round(float(value) * 100, 4) if isinstance(value, (int, float)) else None

    def _plain(key: str):
        value = info.get(key)
        return round(float(value), 4) if isinstance(value, (int, float)) else None

    dividend_yield = info.get("dividendYield")  # already a percent in this build
    debt_to_equity = info.get("debtToEquity")   # Yahoo percent-of-equity
    summary = {
        "current_price": _plain("currentPrice") or _plain("regularMarketPrice"),
        "previous_close": _plain("previousClose"),
        "market_cap": _plain("marketCap"),
        "market_cap_unit": "raw",
        "high_52_week": _plain("fiftyTwoWeekHigh"),
        "low_52_week": _plain("fiftyTwoWeekLow"),
        "trailing_pe": _plain("trailingPE"),
        "forward_pe": _plain("forwardPE"),
        "price_to_book": _plain("priceToBook"),
        "return_on_equity": _pct("returnOnEquity"),
        "return_on_capital": None,  # yfinance .info exposes no ROCE; see COLUMN_DOC
        "return_on_assets": _pct("returnOnAssets"),
        "debt_to_equity": round(float(debt_to_equity) / 100, 4) if isinstance(debt_to_equity, (int, float)) else None,
        "revenue_growth": _pct("revenueGrowth"),
        "earnings_growth": _pct("earningsGrowth"),
        "earnings_quarterly_growth": _pct("earningsQuarterlyGrowth"),
        "dividend_yield": round(float(dividend_yield), 4) if isinstance(dividend_yield, (int, float)) else None,
        "operating_margins": _pct("operatingMargins"),
        "profit_margins": _pct("profitMargins"),
        "beta": _plain("beta"),
        "enterprise_value": _plain("enterpriseValue"),
        "total_cash": _plain("totalCash"),
        "total_debt": _plain("totalDebt"),
    }
    company = {
        "name": info.get("longName") or info.get("shortName"),
        "sector": info.get("sector"),
        "industry": info.get("industry"),
    }
    return {
        "ticker": ticker,
        "company": company,
        "summary": summary,
        "source": "yfinance .info" if info else "unavailable",
    }


def get_fundamentals_data(ticker: str):
    now = time.time()
    if ticker in _fundamentals_cache and now - _fundamentals_cache[ticker]["ts"] < FUNDAMENTALS_TTL:
        return _fundamentals_cache[ticker]["data"]

    stock = yf.Ticker(ticker)
    info = {}
    fast_info = {}
    nse_quote = get_nse_quote_data(ticker) if ticker.upper().endswith(".NS") else {}

    try:
        info = stock.info or {}
    except Exception as e:
        print(f"[Fundamentals] info lookup failed for {ticker}: {e}")

    try:
        fast_info = stock.fast_info or {}
    except Exception as e:
        print(f"[Fundamentals] fast_info lookup failed for {ticker}: {e}")

    history = pd.DataFrame()
    try:
        history = stock.history(period="1y", interval="1d", auto_adjust=False)
    except Exception as e:
        print(f"[Fundamentals] history lookup failed for {ticker}: {e}")

    current_price = _first_non_null(
        nse_quote.get("current_price"),
        fast_info.get("lastPrice"),
        fast_info.get("last_price"),
        info.get("currentPrice"),
        info.get("regularMarketPrice"),
        history["Close"].iloc[-1] if not history.empty else None,
    )
    previous_close = _first_non_null(
        nse_quote.get("previous_close"),
        fast_info.get("previousClose"),
        fast_info.get("previous_close"),
        info.get("previousClose"),
    )
    week_high = _first_non_null(
        nse_quote.get("high_52_week"),
        info.get("fiftyTwoWeekHigh"),
        fast_info.get("yearHigh"),
        fast_info.get("year_high"),
        history["High"].max() if not history.empty else None,
    )
    week_low = _first_non_null(
        nse_quote.get("low_52_week"),
        info.get("fiftyTwoWeekLow"),
        fast_info.get("yearLow"),
        fast_info.get("year_low"),
        history["Low"].min() if not history.empty else None,
    )

    quarterly_income = getattr(stock, "quarterly_income_stmt", pd.DataFrame())
    annual_income = getattr(stock, "income_stmt", pd.DataFrame())
    annual_balance = getattr(stock, "balance_sheet", pd.DataFrame())
    annual_cash_flow = getattr(stock, "cashflow", pd.DataFrame())

    if quarterly_income is None or quarterly_income.empty:
        quarterly_income = getattr(stock, "quarterly_financials", pd.DataFrame())
    if annual_income is None or annual_income.empty:
        annual_income = getattr(stock, "financials", pd.DataFrame())

    result = {
        "ticker": ticker,
        "company": {
            "name": _first_non_null(nse_quote.get("company_name"), info.get("longName"), info.get("shortName"), ticker),
            "sector": _first_non_null(nse_quote.get("sector"), info.get("sector")),
            "industry": _first_non_null(nse_quote.get("industry"), info.get("industry")),
            "website": _clean_scalar(info.get("website")),
            "description": _clean_scalar(info.get("longBusinessSummary")),
            "city": _clean_scalar(info.get("city")),
            "state": _clean_scalar(info.get("state")),
            "country": _clean_scalar(info.get("country")),
            "employees": _clean_scalar(info.get("fullTimeEmployees")),
        },
        "summary": {
            "current_price": current_price,
            "previous_close": previous_close,
            "market_cap": _first_non_null(nse_quote.get("market_cap"), fast_info.get("marketCap"), fast_info.get("market_cap"), info.get("marketCap")),
            "market_cap_unit": "crore" if nse_quote.get("market_cap") is not None else "raw",
            "high_52_week": week_high,
            "low_52_week": week_low,
            "day_high": _clean_scalar(nse_quote.get("day_high")),
            "day_low": _clean_scalar(nse_quote.get("day_low")),
            "trailing_pe": _first_non_null(nse_quote.get("trailing_pe"), info.get("trailingPE")),
            "sector_pe": _clean_scalar(nse_quote.get("sector_pe")),
            "forward_pe": _clean_scalar(info.get("forwardPE")),
            "book_value": _clean_scalar(info.get("bookValue")),
            "price_to_book": _clean_scalar(info.get("priceToBook")),
            "dividend_yield": _clean_scalar(info.get("dividendYield")) if info.get("dividendYield") is not None else None,
            "return_on_equity": _clean_scalar((info.get("returnOnEquity") or 0) * 100) if info.get("returnOnEquity") is not None else None,
            "return_on_capital": _clean_scalar((info.get("returnOnCapital") or info.get("returnOnCapitalEmployed") or 0) * 100) if _first_non_null(info.get("returnOnCapital"), info.get("returnOnCapitalEmployed")) is not None else None,
            "return_on_assets": _clean_scalar((info.get("returnOnAssets") or 0) * 100) if info.get("returnOnAssets") is not None else None,
            "debt_to_equity": (_clean_scalar((info.get("debtToEquity") or 0) / 100) if info.get("debtToEquity") is not None else None),
            "profit_margins": _clean_scalar((info.get("profitMargins") or 0) * 100) if info.get("profitMargins") is not None else None,
            "operating_margins": _clean_scalar((info.get("operatingMargins") or 0) * 100) if info.get("operatingMargins") is not None else None,
            "revenue_growth": _clean_scalar((info.get("revenueGrowth") or 0) * 100) if info.get("revenueGrowth") is not None else None,
            "earnings_growth": _clean_scalar((info.get("earningsGrowth") or 0) * 100) if info.get("earningsGrowth") is not None else None,
            "earnings_quarterly_growth": _clean_scalar((info.get("earningsQuarterlyGrowth") or 0) * 100) if info.get("earningsQuarterlyGrowth") is not None else None,
            "beta": _clean_scalar(info.get("beta")),
            "enterprise_value": _clean_scalar(info.get("enterpriseValue")),
            "total_cash": _clean_scalar(info.get("totalCash")),
            "total_debt": _clean_scalar(info.get("totalDebt")),
            "recommendation": _clean_scalar(info.get("recommendationKey")),
            "face_value": _clean_scalar(nse_quote.get("face_value")),
            "isin": _clean_scalar(nse_quote.get("isin")),
            "listing_date": _clean_scalar(nse_quote.get("listing_date")),
            "quote_type": _clean_scalar(info.get("quoteType")),
            "currency": _clean_scalar(info.get("currency")),
            "exchange": _clean_scalar(info.get("exchange")),
        },
        "ratios": [
            {"label": "Trailing P/E", "value": _first_non_null(nse_quote.get("trailing_pe"), info.get("trailingPE")), "kind": "number"},
            {"label": "Sector P/E", "value": _clean_scalar(nse_quote.get("sector_pe")), "kind": "number"},
            {"label": "Forward P/E", "value": _clean_scalar(info.get("forwardPE")), "kind": "number"},
            {"label": "Price / Book", "value": _clean_scalar(info.get("priceToBook")), "kind": "number"},
            {"label": "Dividend Yield", "value": _clean_scalar(info.get("dividendYield")) if info.get("dividendYield") is not None else None, "kind": "percent"},
            {"label": "ROE", "value": _clean_scalar((info.get("returnOnEquity") or 0) * 100) if info.get("returnOnEquity") is not None else None, "kind": "percent"},
            {"label": "ROCE", "value": _clean_scalar((info.get("returnOnCapital") or info.get("returnOnCapitalEmployed") or 0) * 100) if _first_non_null(info.get("returnOnCapital"), info.get("returnOnCapitalEmployed")) is not None else None, "kind": "percent"},
            {"label": "ROA", "value": _clean_scalar((info.get("returnOnAssets") or 0) * 100) if info.get("returnOnAssets") is not None else None, "kind": "percent"},
            {"label": "Debt / Equity", "value": (_clean_scalar((info.get("debtToEquity") or 0) / 100) if info.get("debtToEquity") is not None else None), "kind": "number"},
            {"label": "Profit Margin", "value": _clean_scalar((info.get("profitMargins") or 0) * 100) if info.get("profitMargins") is not None else None, "kind": "percent"},
            {"label": "Operating Margin", "value": _clean_scalar((info.get("operatingMargins") or 0) * 100) if info.get("operatingMargins") is not None else None, "kind": "percent"},
        ],
        "statements": {
            "quarterly_results": _statement_to_table(quarterly_income, max_columns=8, max_rows=12),
            "profit_and_loss": _statement_to_table(annual_income, max_columns=8, max_rows=14),
            "balance_sheet": _statement_to_table(annual_balance, max_columns=8, max_rows=14),
            "cash_flow": _statement_to_table(annual_cash_flow, max_columns=8, max_rows=14),
        },
        "source": "NSE + yfinance fallback" if nse_quote else "yfinance",
    }

    _fundamentals_cache[ticker] = {"data": result, "ts": time.time()}
    return result


def get_chart_data(ticker: str, range_key: str = "1y"):
    range_key = (range_key or "1y").lower()
    cache_key = f"{ticker}:{range_key}"
    now = time.time()
    if cache_key in _chart_cache and now - _chart_cache[cache_key]["ts"] < CHART_TTL:
        return _chart_cache[cache_key]["df"].copy()

    options = {
        "1d":  ("1d",  "5m"),
        "1w":  ("5d",  "30m"),
        "1mo": ("1mo", "1d"),
        "1m":  ("1mo", "1d"),
        "1y":  ("1y",  "1d"),
        "max": ("max", "1d"),   # all data since listing
        "all": ("max", "1d"),   # alias
    }
    period, interval = options.get(range_key, options["1y"])

    if range_key in {"1m", "1mo", "1y"}:
        try:
            days = 45 if range_key in {"1m", "1mo"} else 365
            df = get_historical_data(ticker, days=days)
            if range_key in {"1m", "1mo"}:
                df = df.tail(31).copy()
            if not df.empty:
                _chart_cache[cache_key] = {"df": df.copy(), "ts": time.time()}
                return df
        except Exception as exc:
            print(f"[Chart] Cached history path failed for {ticker}: {exc}")

    try:
        df = _fetch_yahoo_chart_data(ticker, period, interval)
    except Exception as exc:
        print(f"[Chart] Direct Yahoo chart failed for {ticker}: {exc}")
        if range_key in {"1y", "1m", "1mo"}:
            df = get_historical_data(ticker, days=365)
            if range_key in {"1m", "1mo"}:
                df = df.tail(31).copy()
        else:
            raw = yf.download(ticker, period=period, interval=interval, progress=False, auto_adjust=True)
            raw = _normalize_ohlcv_frame(raw.reset_index() if raw is not None else raw)
            df = raw

    if df.empty:
        raise ValueError(f"No valid chart data for ticker '{ticker}'.")
    _chart_cache[cache_key] = {"df": df.copy(), "ts": time.time()}
    return df


def _fetch_quote_from_chart_api(ticker: str, timeout: float = 3.0, use_backup_host: bool = True):
    hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"] if use_backup_host else ["query1.finance.yahoo.com"]
    for host in hosts:
        base_url = f"https://{host}/v8/finance/chart/{ticker}?interval=1m&range=1d"
        try:
            response = requests.get(base_url, headers=YAHOO_HEADERS, timeout=timeout)
            meta = response.json()['chart']['result'][0]['meta']
            live_price = float(meta['regularMarketPrice'])
            prev_close = float(meta['chartPreviousClose'])
            change_pct = ((live_price - prev_close) / prev_close * 100) if prev_close > 0 else 0.0
            result = {"price": round(live_price, 2), "change_percent": round(change_pct, 2)}
            _quote_cache[ticker] = {'data': result, 'ts': time.time()}
            return result
        except Exception:
            continue
    return None


def get_latest_quote(ticker: str):
    now = time.time()
    cached = _quote_cache.get(ticker)
    if cached and now - cached['ts'] < QUOTE_TTL:
        return cached['data']

    result = _fetch_quote_from_chart_api(ticker, timeout=3)
    if result:
        return result

    try:
        tkr = yf.Ticker(ticker)
        info = tkr.fast_info
        live_price = float(info.last_price)
        prev_close = float(info.previous_close)
        change_pct = ((live_price - prev_close) / prev_close * 100) if prev_close > 0 else 0.0
        result = {"price": round(live_price, 2), "change_percent": round(change_pct, 2)}
        _quote_cache[ticker] = {'data': result, 'ts': time.time()}
        return result
    except Exception as e:
        print(f"[Quote] All sources failed for {ticker}: {e}")

    if cached:
        return cached['data']
    return {"price": None, "change_percent": 0.0}


def _get_latest_quotes_from_price_table(tickers: list[str]):
    if not SUPABASE_OK or not supabase or not tickers:
        return {}

    try:
        since = (pd.Timestamp.now().normalize() - pd.Timedelta(days=21)).strftime("%Y-%m-%d")
        response = supabase.table("stock_prices") \
            .select("ticker,date,close") \
            .in_("ticker", tickers) \
            .gte("date", since) \
            .order("date", desc=True) \
            .limit(max(len(tickers) * 8, 80)) \
            .execute()
    except Exception as exc:
        print(f"[QuoteBatch] Supabase latest-close lookup failed: {exc}")
        return {}

    rows_by_ticker: dict[str, list[dict]] = {}
    for row in response.data or []:
        ticker = row.get("ticker")
        close = _clean_scalar(row.get("close"))
        if ticker and close is not None:
            rows_by_ticker.setdefault(ticker, []).append(row)

    results = {}
    for ticker, rows in rows_by_ticker.items():
        rows = sorted(rows, key=lambda row: str(row.get("date") or ""), reverse=True)
        latest = _clean_scalar(rows[0].get("close")) if rows else None
        previous = _clean_scalar(rows[1].get("close")) if len(rows) > 1 else latest
        if latest is None:
            continue
        latest = float(latest)
        previous = float(previous) if previous else latest
        change_pct = ((latest - previous) / previous * 100) if previous > 0 else 0.0
        result = {"price": round(latest, 2), "change_percent": round(change_pct, 2)}
        results[ticker] = result
        _quote_cache[ticker] = {"data": result, "ts": time.time()}

    return results


def get_latest_quotes_batch(tickers: list[str]):
    now = time.time()
    results: dict[str, dict] = {}
    missing: list[str] = []

    for ticker in tickers:
        cached = _quote_cache.get(ticker)
        if cached and now - cached["ts"] < QUOTE_TTL:
            results[ticker] = cached["data"]
        elif cached:
            results[ticker] = cached["data"]
        else:
            missing.append(ticker)

    if not missing:
        return results

    cached_table_results = _get_latest_quotes_from_price_table(missing)
    results.update(cached_table_results)

    missing_after_cache = [ticker for ticker in missing if ticker not in results]
    if missing_after_cache:
        with ThreadPoolExecutor(max_workers=min(len(missing_after_cache), 24)) as executor:
            futures = {
                executor.submit(_fetch_quote_from_chart_api, ticker, 0.9, False): ticker
                for ticker in missing_after_cache
            }
            for future in as_completed(futures):
                ticker = futures[future]
                try:
                    result = future.result()
                except Exception:
                    result = None
                if result:
                    results[ticker] = result

    for ticker in missing:
        if ticker not in results and ticker in _quote_cache:
            results[ticker] = _quote_cache[ticker]["data"]

    return results


def get_historical_data(ticker: str, days: int = 365, allow_stale: bool = False):
    """Daily OHLCV for ``ticker``.

    allow_stale: use any stored history without refreshing from Yahoo. Market
    scans set this; a backtest over five years doesn't change because the
    last session is missing, and a live fetch per stock made scans take minutes.
    """
    # ── Layer 1: RAM cache ─────────────────────────────────────────────────────
    now = time.time()
    if ticker in _hist_cache and now - _hist_cache[ticker]['ts'] < HIST_TTL:
        cached_df = _hist_cache[ticker]['df'].copy()
        required_rows = _required_history_rows(days)
        if len(cached_df) >= required_rows:
            return cached_df

    # ── Layer 2: Supabase database (simplified — single table, no asset_id) ───
    stale_cache_df = None  # kept as a last-resort fallback if a Yahoo refresh fails
    if PRICE_STORE_OK and price_store is not None:
        try:
            stored_df = price_store.read_prices(ticker)
            if stored_df is not None and len(stored_df) > 50:
                df = _normalize_cached_history(stored_df)
                is_usable, _ = _cache_status(df, ticker, days, "Supabase Storage")
                if is_usable or (allow_stale and len(df) >= 60):
                    _hist_cache[ticker] = {'df': df.copy(), 'ts': time.time()}
                    return df
                stale_cache_df = df
        except Exception as e:
            print(f"[Cache] Supabase Storage read failed for {ticker}: {e}")

    if SUPABASE_OK and supabase:
        try:
            # PostgREST returns at most 1,000 rows per request, and five years
            # is ~1,250 sessions; reading one page made every long history
            # look "too short" and sent it to Yahoo.
            db_rows: list = []
            for start in range(0, 4000, 1000):
                page = supabase.table("stock_prices") \
                    .select("date,open,high,low,close,volume") \
                    .eq("ticker", ticker) \
                    .order("date") \
                    .range(start, start + 999) \
                    .execute()
                db_rows.extend(page.data or [])
                if len(page.data or []) < 1000:
                    break

            if db_rows and len(db_rows) > 50:
                df = _normalize_cached_history(pd.DataFrame(db_rows))
                is_usable, _ = _cache_status(df, ticker, days, "Supabase Postgres")
                if is_usable or (allow_stale and len(df) >= 60):
                    _hist_cache[ticker] = {'df': df.copy(), 'ts': time.time()}
                    return df
                stale_cache_df = df
        except Exception as e:
            print(f"[Cache] Supabase read failed for {ticker}: {e}")

    # Layer 3: direct Yahoo chart API, with yfinance only as a final fallback.
    df = None
    try:
        print(f"[Download] Fetching {ticker} from Yahoo chart API...")
        df = _fetch_yahoo_chart_data(ticker, range_key=_range_for_days(days), interval="1d")
        if days and len(df) > days:
            df = df.tail(days).copy()
    except Exception as direct_error:
        print(f"[Download] Yahoo chart API failed for {ticker}: {direct_error}")
        print(f"[Download] Fetching {ticker} from yfinance fallback...")
        try:
            raw = yf.download(ticker, period=f"{days}d", progress=False, auto_adjust=True)
            df = _normalize_ohlcv_frame(raw.reset_index() if raw is not None else raw)
        except Exception as yf_error:
            print(f"[Download] yfinance fallback failed for {ticker}: {yf_error}")
            df = None

    if df is not None and len(df):
        _note_latest_bar(df["date"].max())

    if df is None or len(df) == 0:
        # A stale cached answer beats no answer at all when Yahoo is unreachable.
        if stale_cache_df is not None and len(stale_cache_df) > 0:
            print(f"[Download] Falling back to stale Supabase cache for {ticker}.")
            _hist_cache[ticker] = {'df': stale_cache_df.copy(), 'ts': time.time()}
            return stale_cache_df
        raise ValueError(f"No valid OHLCV data for ticker '{ticker}'.")

    _schedule_writeback(ticker, df.copy())

    # ── Save to RAM ────────────────────────────────────────────────────────────
    _hist_cache[ticker] = {'df': df.copy(), 'ts': time.time()}
    return df


def _save_history(ticker: str, df: pd.DataFrame) -> None:
    """Persist refreshed history to Supabase Storage and Postgres."""
    if PRICE_STORE_OK and price_store is not None and SUPABASE_WRITES_OK:
        try:
            price_store.write_prices(ticker, df)
        except Exception as e:
            print(f"[Cache] Supabase Storage save failed for {ticker}: {e}")

    # ── Save to Supabase ───────────────────────────────────────────────────────
    if SUPABASE_OK and supabase and SUPABASE_WRITES_OK:
        try:
            records = []
            for _, row in df.iterrows():
                date_str = str(row['date'].date()) if hasattr(row['date'], 'date') else str(row['date'])[:10]
                records.append({
                    "ticker":  ticker,
                    "date":    date_str,
                    "open":    round(float(row['open']),   4),
                    "high":    round(float(row['high']),   4),
                    "low":     round(float(row['low']),    4),
                    "close":   round(float(row['close']),  4),
                    "volume":  int(row['volume'])
                })
            if records:
                # One writer at a time (see _supabase_write_lock) so concurrent
                # movers-scan threads don't race on the shared client's socket.
                with _supabase_write_lock:
                    # upsert in chunks of 100 to avoid payload limits
                    for i in range(0, len(records), 100):
                        chunk = records[i:i+100]
                        for attempt in range(_SUPABASE_WRITE_RETRIES):
                            try:
                                supabase.table("stock_prices").upsert(
                                    chunk,
                                    on_conflict="ticker,date"
                                ).execute()
                                break
                            except Exception as chunk_err:
                                if attempt == _SUPABASE_WRITE_RETRIES - 1:
                                    raise
                                print(f"[Cache] Supabase upsert retry {attempt+1}/{_SUPABASE_WRITE_RETRIES} for {ticker}: {chunk_err}")
                                time.sleep(_SUPABASE_WRITE_BACKOFF * (2 ** attempt))
                print(f"[Cache] Saved {len(records)} rows for {ticker} to Supabase")
        except Exception as e:
            print(f"[Cache] Supabase save failed for {ticker}: {e}")


_WRITEBACK_MAX_PENDING = 40


def _schedule_writeback(ticker: str, df: pd.DataFrame) -> None:
    with _writeback_guard:
        if ticker in _writeback_pending:
            return
        backlog = len(_writeback_pending) >= _WRITEBACK_MAX_PENDING
        if not backlog:
            _writeback_pending.add(ticker)
    if backlog:
        # Backpressure: bulk jobs (the nightly refresh walks ~2,000 stocks)
        # would otherwise queue thousands of frames in a 512 MB instance.
        _save_history(ticker, df)
        return

    def run() -> None:
        try:
            _save_history(ticker, df)
        finally:
            with _writeback_guard:
                _writeback_pending.discard(ticker)

    _writeback_pool.submit(run)
