import pandas as pd
import ta
import yfinance as yf
from textblob import TextBlob
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
import html
import re
import math
import numpy as np
import time
import os
import threading
from concurrent.futures import ThreadPoolExecutor, wait
from datetime import datetime, timedelta

from app.services.daily_signal_engine import (
    build_live_feature_values,
    compute_expected_r,
    compute_final_score,
    evaluate_technical_setup,
    predict_signal_probabilities,
    validate_candidate_frame,
)
from app.services.daily_signal_engine.config import RISK_PROFILES

# ── In-memory analysis cache ──────────────────────────────────────────────────
_analysis_cache: dict = {}
ANALYSIS_TTL = 3600
DETAIL_RISK_PROFILE = os.getenv("DETAIL_ANALYSIS_RISK_PROFILE", "Balanced").title()
DETAIL_MIN_DIRECTIONAL_EDGE = int(os.getenv("DETAIL_MIN_DIRECTIONAL_EDGE", "2"))
DETAIL_MIN_CHART_SETUP_QUALITY = float(os.getenv("DETAIL_MIN_CHART_SETUP_QUALITY", "0.60"))
DETAIL_MIN_EXPECTED_R = float(os.getenv("DETAIL_MIN_EXPECTED_R", "0.08"))
_sentiment_cache: dict = {}
_sentiment_inflight: dict = {}
_sentiment_lock = threading.Lock()
_sentiment_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="news-sentiment")

# ── Supabase for persistent cache ─────────────────────────────────────────────
try:
    from app.core.supabase_client import supabase as _sb
    _SUPABASE_OK = True
    _SUPABASE_WRITES_OK = bool(os.getenv("SUPABASE_SERVICE_ROLE_KEY"))
except Exception:
    _sb = None
    _SUPABASE_OK = False
    _SUPABASE_WRITES_OK = False


def _neutral_sentiment(message: str = "News sentiment is updating in the background.") -> dict:
    return {"score": 0, "label": "Neutral", "headlines": [message], "stories": []}


def _rss_root(url: str):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    response = urllib.request.urlopen(req, timeout=3)
    return ET.fromstring(response.read())


def _fetch_rss_roots(urls: dict[str, str]) -> dict:
    executor = ThreadPoolExecutor(max_workers=min(2, len(urls)))
    futures = {name: executor.submit(_rss_root, url) for name, url in urls.items()}
    done, _ = wait(futures.values(), timeout=3.5)
    roots = {}
    for name, future in futures.items():
        if future not in done:
            future.cancel()
            continue
        try:
            roots[name] = future.result()
        except Exception:
            pass
    executor.shutdown(wait=False, cancel_futures=True)
    return roots


def _finish_sentiment_fetch(ticker: str, future) -> None:
    try:
        sentiment = future.result()
    except Exception as exc:
        print(f"[News] Sentiment fetch failed for {ticker}: {exc}")
        sentiment = _neutral_sentiment("Live news feed unavailable.")
    with _sentiment_lock:
        _sentiment_cache[ticker] = {"result": sentiment, "ts": time.time()}
        _sentiment_inflight.pop(ticker, None)


def _sentiment_for_analysis(ticker: str) -> tuple[dict, bool]:
    now = time.time()
    with _sentiment_lock:
        cached = _sentiment_cache.get(ticker)
        if cached and now - cached["ts"] < ANALYSIS_TTL:
            return cached["result"], True
        if ticker not in _sentiment_inflight:
            future = _sentiment_executor.submit(fetch_news_sentiment, ticker)
            _sentiment_inflight[ticker] = future
            future.add_done_callback(lambda done, symbol=ticker: _finish_sentiment_fetch(symbol, done))
    return _neutral_sentiment(), False

def fetch_news_sentiment(ticker: str):
    try:
        base_ticker = ticker.split('.')[0]
        raw_name = base_ticker
        try:
            info = yf.Ticker(ticker).fast_info
            raw_name = getattr(info, "short_name", None) or raw_name
        except Exception:
            try:
                raw_name = yf.Ticker(ticker).info.get("shortName") or yf.Ticker(ticker).info.get("longName") or raw_name
            except Exception:
                pass

        # Strip generic corporate suffixes to get a clean, searchable name
        SUFFIX_PATTERN = r'\b(limited|ltd|corp|corporation|inc|plc|pvt|llc|group|holdings?|industries|services|finance|financial|company|co)\b'
        clean_name = re.sub(SUFFIX_PATTERN, '', raw_name, flags=re.IGNORECASE).strip()
        clean_name = re.sub(r'\s+', ' ', clean_name).strip()
        # Use cleaned name if meaningful, otherwise fall back to base ticker
        search_name = clean_name if len(clean_name) > 3 else base_ticker

        # Build query: specific company + news-relevant keywords, exclude data sites
        search_query = urllib.parse.quote(
            f'"{search_name}" (earnings OR results OR profit OR revenue OR growth OR '
            f'acquisition OR merger OR raises OR cuts OR dividend OR stake OR fund OR '
            f'investor OR quarter OR outlook OR guidance OR expansion) '
            f'-site:tradingview.com -site:simplywall.st -site:stockanalysis.com '
            f'-site:macrotrends.net -site:screener.in -site:trendlyne.com '
            f'-site:tickertape.in -site:meyka.com'
        )
        url = f"https://news.google.com/rss/search?q={search_query}&hl=en-IN&gl=IN&ceid=IN:en"
        fb_parts = f'({search_name} OR {base_ticker})' if search_name != base_ticker else base_ticker
        fb_q = urllib.parse.quote(
            f'{fb_parts} '
            f'-site:tradingview.com -site:simplywall.st -site:stockanalysis.com '
            f'-site:macrotrends.net -site:screener.in -site:trendlyne.com '
            f'-site:tickertape.in -site:meyka.com'
        )
        fb_url = f"https://news.google.com/rss/search?q={fb_q}&hl=en-IN&gl=IN&ceid=IN:en"
        roots = _fetch_rss_roots({"primary": url, "fallback": fb_url})
        root = roots.get("primary") or roots.get("fallback")
        items = root.findall('.//item') if root is not None else []

        headlines = []
        stories = []
        total_polarity = 0

        # Non-news publishers — data sites, auto-generated tickers, official IR pages
        GENERIC_WORDS = {'the','and','of','ltd','limited','corp','corporation','inc',
                         'plc','pvt','llc','bank','group','holdings','company','co',
                         'india','industries','services','finance','financial'}
        data_only_sources = {
            'tradingview', 'simplywall.st', 'stockanalysis', 'macrotrends',
            'wisesheets', 'tickertape', 'screener.in', 'trendlyne', 'meyka',
            'chartmill', 'finviz', 'nseindia', 'bseindia',
        }
        # Patterns that indicate data pages or auto-generated noise
        junk_patterns = [
            r'financial statements?',
            r'stock price and chart',
            r'(live |today.s )?share price',
            r'balance sheet',
            r'income statement',
            r'cash flow',
            r'historical (data|price)',
            r'(live |real.?time )(price|quote)',
            r'charting by',
            r'stock (rises?|falls?|drops?|jumps?|gains?|slides?|surges?|climbs?) \d',
            r'\d+\.?\d*% (up|down|gain|loss)',
            r'intraday[:\s]',
            r'pre.?market (margins|spotlight)',
            r'multibagger',
            r'penny stock',
            r'top stocks? to buy',
            r'price target',
            r'outlook for (the )?week',
            r'weekly outlook',
            r'technical outlook',
            r'careers?( at| -)',
            r'job (vacancy|opening|listing)',
            r'personal banking',
            r'netbanking',
            r'fasttag|fastag',
            r'privacy policy',
            r'raise (dispute|complaint)',
        ]
        # Only match if a distinctive company term appears in the title
        required_terms = {
            term.lower()
            for term in re.split(r'[^A-Za-z0-9]+', f"{search_name} {base_ticker}")
            if len(term) > 2 and term.lower() not in GENERIC_WORDS
        }
        # Add prefix abbreviations: "sbi" from SBIN, "hdfc" from HDFCBANK, "icici" from ICICIBANK
        for _n in (3, 4, 5):
            if len(base_ticker) > _n:
                required_terms.add(base_ticker[:_n].lower())

        def _title_matches(lower_title: str) -> bool:
            return any(
                re.search(r'\b' + re.escape(t) + r'\b', lower_title)
                for t in required_terms
            )

        def _is_english_title(title: str) -> bool:
            letters = re.findall(r'[^\W\d_]', title, flags=re.UNICODE)
            if not letters:
                return True
            english_letters = re.findall(r'[A-Za-z]', title)
            return len(english_letters) / len(letters) >= 0.85

        for item in items:
            title_el = item.find('title')
            if title_el is None or not title_el.text:
                continue
            link_el = item.find('link')
            raw_title = html.unescape(title_el.text).strip()
            parts = raw_title.rsplit(' - ', 1)
            clean_title = parts[0].strip()
            source = parts[1].strip() if len(parts) > 1 else "News"
            clean_lower = clean_title.lower()
            source_lower = source.lower()

            # Keep stock pages English-only, even when Google News mixes local-language results.
            if not _is_english_title(clean_title):
                continue
            # Skip data-only publishers
            if any(ds in source_lower for ds in data_only_sources):
                continue
            # Skip junk title patterns
            if any(re.search(p, clean_lower) for p in junk_patterns):
                continue
            # Skip if no distinctive company term in title
            if required_terms and not _title_matches(clean_lower):
                continue
            # Skip too-short, pipe-separated, or all-caps ticker-only titles
            if len(clean_title) < 40 or '|' in clean_title:
                continue

            display_title = f"{clean_title} · {source}"
            if display_title not in headlines:
                headlines.append(display_title)
                stories.append({
                    "title": clean_title,
                    "source": source,
                    "url": link_el.text.strip() if link_el is not None and link_el.text else None,
                })
                total_polarity += TextBlob(clean_title).sentiment.polarity
            if len(headlines) == 5:
                break

        # Fallback: broader search when primary returned fewer than 3 headlines
        if len(headlines) < 3:
            try:
                root2 = roots.get("fallback")
                if root2 is None:
                    raise ValueError("Fallback RSS was unavailable.")
                seen = set(headlines)
                for item2 in root2.findall('.//item'):
                    title_el2 = item2.find('title')
                    if title_el2 is None or not title_el2.text:
                        continue
                    link_el2 = item2.find('link')
                    raw2 = html.unescape(title_el2.text).strip()
                    parts2 = raw2.rsplit(' - ', 1)
                    ct2 = parts2[0].strip()
                    src2 = parts2[1].strip() if len(parts2) > 1 else "News"
                    lower2 = ct2.lower()
                    if not _is_english_title(ct2):
                        continue
                    if any(ds in src2.lower() for ds in data_only_sources):
                        continue
                    if any(re.search(p, lower2) for p in junk_patterns):
                        continue
                    if required_terms and not _title_matches(lower2):
                        continue
                    if len(ct2) < 35 or '|' in ct2:
                        continue
                    disp2 = f"{ct2} · {src2}"
                    if disp2 not in seen:
                        headlines.append(disp2)
                        stories.append({
                            "title": ct2,
                            "source": src2,
                            "url": link_el2.text.strip() if link_el2 is not None and link_el2.text else None,
                        })
                        seen.add(disp2)
                        total_polarity += TextBlob(ct2).sentiment.polarity
                    if len(headlines) == 5:
                        break
            except Exception:
                pass

        if not headlines:
            return {"score": 0, "label": "Neutral", "headlines": ["No recent news found for this stock."], "stories": []}
        avg_polarity = total_polarity / len(headlines)
        label = "Bullish" if avg_polarity > 0.05 else "Bearish" if avg_polarity < -0.05 else "Neutral"
        return {"score": round(avg_polarity, 2), "label": label, "headlines": headlines, "stories": stories}
    except Exception:
        return {"score": 0, "label": "Neutral", "headlines": ["Live news feed unavailable."], "stories": []}

def fetch_global_market_news():
    try:
        search_query = urllib.parse.quote('"stock market" OR Nifty OR Sensex OR Nasdaq earnings economy')
        url = f"https://news.google.com/rss/search?q={search_query}&hl=en-US&gl=US&ceid=US:en"
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        response = urllib.request.urlopen(req, timeout=8)
        root = ET.fromstring(response.read())
        stories = []
        spam_patterns = [
            r'watch these stocks',
            r'top stocks? to buy',
            r'multibagger',
            r'penny stock',
            r'price target',
            r'buy or sell',
            r'outlook for (the )?week',
            r'weekly outlook',
            r'technical outlook',
        ]

        for item in root.findall('.//item'):
            title_element = item.find('title')
            if title_element is None or not title_element.text:
                continue
            link_element = item.find('link')
            raw_title = html.unescape(title_element.text).strip()
            parts = raw_title.rsplit(' - ', 1)
            title = parts[0].strip()
            source = parts[1].strip() if len(parts) > 1 else "Google News"
            lower = title.lower()
            if any(re.search(pattern, lower) for pattern in spam_patterns) or len(title) < 30:
                continue
            if title not in [story["title"] for story in stories]:
                stories.append({
                    "title": title,
                    "source": source,
                    "url": link_element.text.strip() if link_element is not None and link_element.text else None,
                })
            if len(stories) == 5:
                break

        return {"stories": stories or [{"title": "Global market news feed is temporarily unavailable.", "source": "Bullseye", "url": None}]}
    except Exception:
        return {"stories": [{"title": "Global market news feed is temporarily unavailable.", "source": "Bullseye", "url": None}]}

def run_analysis(df: pd.DataFrame, ticker: str):
    # Bar the analysis is about to be computed from. A cached result is only
    # valid for the SAME bar: previously the caches were time-based only, so a
    # result computed from an out-of-date price frame kept being served for an
    # hour after fresher bars had arrived — the signal (entry/target/stop) then
    # described a session that had already closed.
    try:
        _current_bar = str(pd.Timestamp(df['date'].max()).date()) if 'date' in df.columns and not df.empty else None
    except Exception:
        _current_bar = None

    # ── RAM cache check ────────────────────────────────────────────────────────
    now = time.time()
    if ticker in _analysis_cache and now - _analysis_cache[ticker]['ts'] < ANALYSIS_TTL:
        cached_entry = _analysis_cache[ticker]
        if _current_bar is None or cached_entry.get('bar') == _current_bar:
            return cached_entry['result']
        print(f"[Cache] Analysis RAM entry for {ticker} was built on bar {cached_entry.get('bar')}, now {_current_bar} - recomputing.")

    # ── Supabase cache check ───────────────────────────────────────────────────
    # Sources that indicate stale/low-quality cached news — bust the cache if found
    _STALE_NEWS_SOURCES = {'meyka', 'tradingview', 'simplywall.st', 'stockanalysis', 'macrotrends'}

    if _SUPABASE_OK and _sb:
        try:
            import json as _json
            cached = _sb.table("analysis_cache").select("result,updated_at").eq("ticker", ticker).execute()
            if cached.data:
                row = cached.data[0]
                updated = datetime.fromisoformat(row['updated_at'].replace('Z', '+00:00'))
                age = (datetime.now(updated.tzinfo) - updated).total_seconds()
                if age < ANALYSIS_TTL:
                    result = _json.loads(row['result']) if isinstance(row['result'], str) else row['result']
                    # Invalidate if cached news contains blocked low-quality sources
                    headlines = result.get('sentiment', {}).get('headlines', [])
                    has_stale_news = any(
                        any(src in h.lower() for src in _STALE_NEWS_SOURCES)
                        for h in headlines
                    )
                    # Reject a cached result that was computed from an older
                    # price bar than the one we now hold.
                    # Entries written before this field existed cannot be
                    # verified, so they are treated as invalid and recomputed
                    # once (after which they carry the stamp).
                    cached_bar = result.get('analysis_bar_date') if isinstance(result, dict) else None
                    bar_matches = _current_bar is None or cached_bar == _current_bar
                    if not bar_matches:
                        print(f"[Cache] Analysis Supabase entry for {ticker} was built on bar {cached_bar}, now {_current_bar} - recomputing.")
                    elif not has_stale_news:
                        _analysis_cache[ticker] = {'result': result, 'ts': time.time(), 'bar': _current_bar}
                        print(f"[Cache] Analysis Supabase hit for {ticker}")
                        return result
                    else:
                        print(f"[Cache] Stale news detected for {ticker}, re-running analysis")
        except Exception as e:
            print(f"[Cache] Analysis Supabase read failed: {e}")
    df = df.dropna(subset=['close', 'high', 'low', 'volume'])
    df = df.reset_index(drop=True)

    close, high, low, volume = df['close'], df['high'], df['low'], df['volume']

    # Indicators needed for 20 strategies
    df['SMA_50']  = ta.trend.sma_indicator(close, window=50)
    df['SMA_200'] = ta.trend.sma_indicator(close, window=200)
    df['EMA_20']  = ta.trend.ema_indicator(close, window=20)
    df['EMA_50']  = ta.trend.ema_indicator(close, window=50)
    df['RSI_14']  = ta.momentum.rsi(close, window=14)
    df['MACD']    = ta.trend.macd(close)
    df['MACD_signal'] = ta.trend.macd_signal(close)
    df['ATR_14']  = ta.volatility.average_true_range(high, low, close, window=14)
    df['ADX_14']  = ta.trend.adx(high, low, close, window=14)
    df['BBU_14_2.0'] = ta.volatility.bollinger_hband(close, window=14, window_dev=2)
    df['BBL_14_2.0'] = ta.volatility.bollinger_lband(close, window=14, window_dev=2)
    df['VWAP'] = ta.volume.volume_weighted_average_price(high, low, close, volume, window=14)
    df['VOL_SMA_20'] = volume.rolling(window=20).mean()
    df['RET_5'] = close.pct_change(5)
    df['RET_20'] = close.pct_change(20)
    df['RANGE_PCT'] = (high - low) / close
    df['RESISTANCE_20'] = high.rolling(20).max().shift(1)
    df['SUPPORT_20'] = low.rolling(20).min().shift(1)

    df = df.dropna()
    if len(df) < 5: return {"error": "Insufficient historical data."}

    latest = df.iloc[-1]
    prev = df.iloc[-2]
    sentiment, sentiment_ready = _sentiment_for_analysis(ticker)

    # Legacy FISO components are retained as a diagnostic score only.
    sma_diff_pct = (latest['SMA_50'] - latest['SMA_200']) / latest['SMA_200']
    trend_score = max(0.0, min(35.0, 17.5 + (sma_diff_pct * 250))) 
    
    rsi = latest['RSI_14']
    if rsi < 30: momentum_score = 35.0 
    elif rsi > 70: momentum_score = 5.0 
    else: momentum_score = max(0.0, min(35.0, 35.0 - ((rsi - 30) * 0.75)))
    
    macd_hist = latest['MACD'] - latest['MACD_signal']
    macd_score = max(0.0, min(30.0, 15.0 + (macd_hist / latest['close'] * 1500)))

    raw_fiso = trend_score + momentum_score + macd_score + (sentiment['score'] * 20.0)
    fiso = min(100.0, max(0.0, raw_fiso))

    live_latest = {
        "close": float(latest["close"]),
        "high": float(latest["high"]),
        "low": float(latest["low"]),
        "volume": float(latest["volume"]),
        "ema20": float(latest["EMA_20"]),
        "ema50": float(latest["EMA_50"]),
        "rsi14": float(latest["RSI_14"]),
        "adx14": float(latest["ADX_14"]),
        "atr14": float(latest["ATR_14"]),
        "vol_avg20": float(latest["VOL_SMA_20"]),
        "resistance20": float(latest["RESISTANCE_20"]),
        "support20": float(latest["SUPPORT_20"]),
        "ret5": float(latest["RET_5"]),
        "ret20": float(latest["RET_20"]),
        "range_pct": float(latest["RANGE_PCT"]),
    }
    relative_strength = float(latest["RET_20"] * 100)
    regime = {"label": "neutral", "alignment_buy": 0.55, "alignment_sell": 0.55, "score": 0.55}
    technical_setup = evaluate_technical_setup(live_latest, relative_strength, 0.0)
    risk_profile_name = DETAIL_RISK_PROFILE if DETAIL_RISK_PROFILE in RISK_PROFILES else "Balanced"
    profile = RISK_PROFILES[risk_profile_name]
    validation = validate_candidate_frame(df, risk_profile_name)
    feature_values = build_live_feature_values(
        live_latest,
        technical_setup,
        regime,
        relative_strength=relative_strength,
        sector_strength=0.0,
    )
    probabilities = predict_signal_probabilities(
        technical_setup,
        regime,
        risk_profile_name,
        relative_strength,
        validation["quality_score"],
        feature_values=feature_values,
        setup_type=technical_setup.get("setup_type"),
    )
    model_pwin = float(probabilities["calibrated_pwin"])
    conservative_p_loss = max(float(probabilities["p_loss"]), 1.0 - model_pwin)
    direction = technical_setup["direction"]
    atr_val = float(latest['ATR_14'])
    entry = float(latest['close'])

    target_multiplier = float(profile["target_atr_multiplier"])
    stop_multiplier = float(profile["stop_atr_multiplier"])
    risk_reward = target_multiplier / max(stop_multiplier, 1e-6)
    expected_r = compute_expected_r(model_pwin, conservative_p_loss, risk_reward, 1.0)
    avg_turnover = float(validation.get("avg_turnover") or 0.0)
    liquidity_score = min(1.0, max(0.0, avg_turnover / 500_000_000))
    risk_penalties = max(0.0, (1.0 - float(validation["quality_score"])) * 0.18)
    final_score = compute_final_score(
        calibrated_pwin=model_pwin,
        expected_r=expected_r,
        adjusted_setup_win_rate=float(probabilities.get("historical_hit_rate") or 0.52),
        market_regime_alignment=regime["alignment_buy"] if direction == "BUY" else regime["alignment_sell"],
        chart_setup_quality=float(technical_setup["chart_setup_quality"]),
        relative_strength=min(1.0, abs(relative_strength) / 5),
        liquidity_score=liquidity_score,
        model_stability=float(probabilities["model_stability"]),
        risk_penalties=risk_penalties,
    )

    # ── Quality gates ────────────────────────────────────────────────────────
    # These used to be a set of independent booleans collapsed with "any failure
    # => Hold". That made the verdict a cliff: a metric a thousandth below its
    # threshold flipped a Strong Buy to Hold overnight, and the Hold looked
    # identical to a genuinely neutral stock — even when the model still put the
    # win probability at 0.83 and the directional edge at +3. Users saw the
    # verdict oscillate day to day and (reasonably) stopped trusting it.
    #
    # Same thresholds, but each gate now reports HOW FAR it is from passing, and
    # a near-miss is separated from a real failure. A setup that only just misses
    # is reported as "Watch": no entry/target/stop is issued (that part must stay
    # strict), but the page states the lean and why it fell short instead of
    # showing a neutral-looking Hold. The intermediate state is also what stops
    # the flip-flop — a stock hovering at a boundary now reads Buy -> Watch ->
    # Hold rather than snapping between the extremes.
    NEAR_MISS_TOLERANCE = float(os.getenv("DETAIL_GATE_TOLERANCE", "0.12"))

    gate_report: list[dict[str, Any]] = []

    def _check(label: str, value: float, threshold: float) -> None:
        """Record a >= threshold gate and how close it came."""
        passed = value >= threshold
        shortfall = 0.0 if passed else (threshold - value) / threshold if threshold else 1.0
        gate_report.append({
            "gate": label,
            "value": round(float(value), 4),
            "threshold": round(float(threshold), 4),
            "passed": passed,
            "shortfall_pct": round(shortfall * 100, 2),
            "near_miss": (not passed) and shortfall <= NEAR_MISS_TOLERANCE,
        })

    hard_failures: list[str] = []
    if direction not in {"BUY", "SELL"}:
        hard_failures.append("no clear directional edge")
    if not validation["is_valid"]:
        # Data-quality problems are never a near miss: acting on bad data is not
        # a marginal call, it is the thing that produces fabricated signals.
        hard_failures.extend(validation.get("rejections") or ["data quality failed"])

    _check("directional edge", abs(int(technical_setup.get("directional_edge") or 0)), DETAIL_MIN_DIRECTIONAL_EDGE)
    _check("chart setup quality", float(technical_setup["chart_setup_quality"]), DETAIL_MIN_CHART_SETUP_QUALITY)
    _check("expected reward after costs", expected_r, DETAIL_MIN_EXPECTED_R)
    _check("model confidence", float(probabilities["confidence"]), float(profile["confidence_threshold"]))
    _check("risk / reward", risk_reward, float(profile["min_risk_reward"]))
    _check("final score", final_score, float(profile["min_final_score"]))

    failed_gates = [g for g in gate_report if not g["passed"]]
    near_misses = [g for g in failed_gates if g["near_miss"]]
    hard_gate_failures = [g for g in failed_gates if not g["near_miss"]]

    quality_failures = hard_failures + [
        f"{g['gate']} is {g['shortfall_pct']}% below threshold" for g in hard_gate_failures
    ] + [
        f"{g['gate']} just missed by {g['shortfall_pct']}%" for g in near_misses
    ]

    # Levels are only issued when EVERY gate passes — a near miss is still not a
    # trade. What changes is how it is described, not what is promised.
    tradable = not quality_failures
    watching = (not tradable) and (not hard_failures) and (not hard_gate_failures) and bool(near_misses)
    # Enabled by default: with this off the stock page could only ever say Buy or
    # Hold, so a genuinely bearish stock produced a "Hold" that read as neutral
    # rather than as a warning. Sell means "exit or avoid" for a cash-equity
    # holder, not an instruction to short.
    if direction == "SELL" and os.getenv("DETAIL_ANALYSIS_ALLOW_SELL", "true").lower() not in {"1", "true", "yes"}:
        quality_failures.append("sell-side calls are disabled by default")
        tradable = False

    if direction == "SELL":
        stop_loss = entry + (stop_multiplier * atr_val)
        target = entry - (target_multiplier * atr_val)
    else:
        stop_loss = entry - (stop_multiplier * atr_val)
        target = entry + (target_multiplier * atr_val)

    if tradable and direction == "BUY":
        verdict = "Strong Buy" if model_pwin >= 0.72 and final_score >= 0.70 else "Buy"
    elif tradable and direction == "SELL":
        verdict = "Strong Sell" if model_pwin >= 0.72 and final_score >= 0.70 else "Sell"
    elif watching and direction in {"BUY", "SELL"}:
        # Leaning, but short of the bar. Says which way without issuing levels.
        verdict = "Watch (bullish)" if direction == "BUY" else "Watch (bearish)"
    else:
        verdict = "Hold"

    momentum_velocity = 1.0 + (abs(rsi - 50) / 50.0) 
    estimated_days = max(1, min(math.ceil((abs(target - entry) / atr_val) / momentum_velocity * 1.4), 21)) if tradable else 0
    
    confidence = float(probabilities["confidence"]) * 100

    # `evaluate_strategies` used to run here on every /analyze call to produce
    # `strategy_evals` / `best_strategy_id`. Both fed the "Top 10 strategies"
    # panel, which scored 20 textbook strategies from hard-coded verdicts and
    # confidence numbers rather than from this stock's data. That panel has been
    # removed, so the call is gone too — it was pure overhead on the hottest
    # endpoint in the app, computing a field nothing read.
    robust_score = max(0.0, min(100.0, final_score * 100))
    fiso = robust_score if tradable else min(55.0, robust_score)

    result = {
        "ticker": ticker,
        "fiso_score": round(fiso, 2),
        "legacy_fiso_score": round(min(100.0, max(0.0, raw_fiso)), 2),
        "verdict": verdict,
        "signal_status": "trade" if tradable else ("watch" if watching else "no_trade"),
        # Every gate with its value, threshold and shortfall, so the page can say
        # exactly what fell short instead of only that something did.
        "gate_report": gate_report,
        "near_miss_gates": [g["gate"] for g in near_misses],
        "entry": round(entry, 2),
        "stop_loss": round(stop_loss, 2),
        "target": round(target, 2),
        "current_price": round(float(latest['close']), 2),
        "sentiment": sentiment,
        "confidence": round(confidence, 2),
        "model_probability": round(model_pwin, 4),
        "model_expected_return_r": round(expected_r, 4),
        "expected_r": round(expected_r, 4),
        "risk_reward": round(risk_reward, 4),
        "final_score": round(final_score, 4),
        "chart_setup_quality": technical_setup["chart_setup_quality"],
        "directional_edge": technical_setup.get("directional_edge"),
        "model_path": probabilities.get("model_path", "fallback"),
        "historical_hit_rate": probabilities.get("historical_hit_rate"),
        "historical_hit_rate_trades": probabilities.get("historical_hit_rate_trades"),
        "risk_notes": list(dict.fromkeys(quality_failures)),
        "analysis_quality": {
            "risk_profile": risk_profile_name,
            "validation": validation,
            "technical_setup": technical_setup,
            "probabilities": probabilities,
            "quality_gates": {
                "min_directional_edge": DETAIL_MIN_DIRECTIONAL_EDGE,
                "min_chart_setup_quality": DETAIL_MIN_CHART_SETUP_QUALITY,
                "min_expected_r": DETAIL_MIN_EXPECTED_R,
                "min_confidence": profile["confidence_threshold"],
                "min_risk_reward": profile["min_risk_reward"],
                "min_final_score": profile["min_final_score"],
                "conservative_p_loss": round(conservative_p_loss, 6),
            },
        },
        "estimated_days": estimated_days,
        "target_date": (datetime.now() + timedelta(days=(estimated_days * 1.4))).strftime('%b %d, %Y') if tradable else "No active trade"
    }

    # Stamp the bar this result was computed from BEFORE caching, so both the
    # RAM and Supabase caches can be invalidated when a newer bar arrives.
    result["analysis_bar_date"] = _current_bar

    # ── Save to RAM cache ──────────────────────────────────────────────────────
    if sentiment_ready:
        _analysis_cache[ticker] = {'result': result, 'ts': time.time(), 'bar': _current_bar}

    # ── Save to Supabase cache ─────────────────────────────────────────────────
    if sentiment_ready and _SUPABASE_OK and _sb and _SUPABASE_WRITES_OK:
        try:
            import json as _json
            _sb.table("analysis_cache").upsert({
                "ticker":     ticker,
                "result":     _json.dumps(result),
                "updated_at": datetime.utcnow().isoformat() + "Z"
            }, on_conflict="ticker").execute()
        except Exception as e:
            print(f"[Cache] Analysis Supabase save failed: {e}")
    if not sentiment_ready:
        print(f"[News] Returning {ticker} analysis with neutral sentiment while news cache warms.")

    return result
