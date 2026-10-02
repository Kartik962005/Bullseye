from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from slowapi import Limiter
from slowapi.util import get_remote_address
from dotenv import load_dotenv
from pydantic import BaseModel, Field
from typing import Any
import asyncio
from concurrent.futures import ThreadPoolExecutor
from threading import Thread
from datetime import datetime
from zoneinfo import ZoneInfo
import os
import pandas as pd

load_dotenv()

default_origins = [
    "https://bullseye-analytics-ai.vercel.app",
    "https://bullseye.help",
    "https://www.bullseye.help",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
    "http://192.168.137.1:3000",
    "http://192.168.137.1:3001",
]
cors_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", ",".join(default_origins)).split(",")
    if origin.strip()
]
cors_origin_regex = os.getenv(
    "CORS_ORIGIN_REGEX",
    r"^(https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?|https://[a-z0-9-]+\.vercel\.app)$",
)

limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="AI Trading Assistant - MVP")
app.state.limiter = limiter

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_origin_regex=cors_origin_regex,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from app.services.data_service import get_latest_quote, get_latest_quotes_batch, get_historical_data, get_fundamentals_data, get_chart_data
from app.services.screener_service import screen_stocks
from app.services.smart_search_service import smart_search
from app.services.intelligent_screener_service import intelligent_smart_search, run_screen_sql, sector_overview
from app.services.stock_ai_service import run_stock_ai_search
from app.services.ask_ai_service import run_ask_ai, movers_snapshot_status
from app.services.ask_ai_history_service import (
    get_conversation,
    history_for_llm,
    list_conversations,
    save_turn,
)
from app.services.stock_snapshot_service import enrich_metric_rows, is_snapshot_stale, sector_peer_comparison
from app.services.strategy_engine import DISCLAIMER as STRATEGY_DISCLAIMER, backtest_nl_strategy, backtest_strategy, strategy_to_dict
from app.services.strategy_store import (
    create_strategy as create_ai_strategy,
    delete_strategy as delete_ai_strategy,
    list_signals as list_ai_strategy_signals,
    list_strategies as list_ai_strategies,
    update_strategy as update_ai_strategy,
    validate_strategy_json,
)
from app.services.alert_service import (
    check_active_alerts,
    check_alert,
    create_alert,
    delete_alert,
    evaluate_alert,
    get_user_from_authorization,
    list_alerts,
    notify_alert,
    update_alert_status,
)
from app.services.daily_trade_service import (
    disable_daily_alerts,
    enable_daily_alerts,
    get_admin_status,
    get_notification_preference,
    get_daily_update_preference,
    get_signals_history,
    get_signals_today,
    get_stock_track_record,
    process_scheduled_daily_alerts,
    run_scheduled_tick,
    run_daily_prediction,
    run_daily_forecast,
    run_outcome_tracking,
    run_daily_review,
    send_instant_signal_email,
    unsubscribe_daily_alerts,
    update_notification_preference,
    update_daily_update_preference,
    _is_market_holiday,
)
from app.strategies.engine import run_analysis, fetch_global_market_news


INDEX_TICKERS = ["^NSEI", "^BSESN", "^IXIC", "^GSPC"]
IST = ZoneInfo("Asia/Kolkata")


@app.on_event("startup")
def warm_index_quotes():
    def warm():
        for ticker in INDEX_TICKERS:
            try:
                get_latest_quote(ticker)
            except Exception as exc:
                print(f"[Warmup] index quote failed for {ticker}: {exc}")

    Thread(target=warm, daemon=True).start()


@app.on_event("startup")
async def start_alert_checker():
    if os.getenv("ALERT_CHECKER_ENABLED", "false").lower() not in {"1", "true", "yes"}:
        print("[Alerts] in-process checker disabled; use external cron on /api/v1/alerts/check-now.")
        return

    async def loop():
        await asyncio.sleep(8)
        interval = max(60, int(os.getenv("ALERT_CHECK_INTERVAL_SECONDS", "300")))
        while True:
            try:
                check_active_alerts(limit=int(os.getenv("ALERT_CHECK_BATCH_SIZE", "100")))
            except Exception as exc:
                print(f"[Alerts] scheduled check failed: {exc}")
            await asyncio.sleep(interval)

    asyncio.create_task(loop())


@app.on_event("startup")
async def start_daily_trade_updates():
    if os.getenv("DAILY_UPDATES_ENABLED", "true").lower() not in {"1", "true", "yes"}:
        print("[DailyTrade] in-process scheduler disabled; use external cron on /api/v1/daily-updates/run-forecast and /api/v1/daily-updates/run-review.")
        return

    async def loop():
        await asyncio.sleep(20)
        while True:
            try:
                # Same idempotent tick the external cron calls; safe to run both.
                run_scheduled_tick()
            except Exception as exc:
                print(f"[DailyTrade] scheduled update failed: {exc}")
            await asyncio.sleep(60)

    asyncio.create_task(loop())


def _run_snapshot_build_background(reason: str) -> None:
    def build():
        try:
            from scripts.build_snapshot import run_snapshot_build

            print(f"[Snapshot] starting background build ({reason})")
            result = run_snapshot_build()
            print(f"[Snapshot] background build complete: {result}")
        except Exception as exc:
            print(f"[Snapshot] background build failed ({reason}): {exc}")

    Thread(target=build, daemon=True).start()


@app.on_event("startup")
async def start_stock_snapshot_refresh():
    # Default OFF: building the full ~2,142-stock snapshot in-process OOM-kills
    # small hosts (e.g. Render free 512MB) on boot, taking the whole API down.
    # Enable only on a host with enough RAM, or build via external cron / the
    # scripts/build_snapshot.py one-off instead.
    if os.getenv("STOCK_SNAPSHOT_REFRESH_ENABLED", "false").lower() not in {"1", "true", "yes"}:
        return
    await asyncio.sleep(2)
    if is_snapshot_stale():
        _run_snapshot_build_background("startup stale snapshot")


@app.on_event("startup")
async def start_daily_snapshot_refresh():
    if os.getenv("STOCK_SNAPSHOT_REFRESH_ENABLED", "false").lower() not in {"1", "true", "yes"}:
        return

    async def loop():
        await asyncio.sleep(30)
        built_for: str | None = None
        while True:
            now = datetime.now(IST)
            today = now.date().isoformat()
            if now.weekday() < 5 and now.hour >= 16 and built_for != today and is_snapshot_stale():
                _run_snapshot_build_background("nightly after close")
                built_for = today
            await asyncio.sleep(600)

    asyncio.create_task(loop())


def analyze_ticker_sync(ticker: str):
    df = get_historical_data(ticker, days=500)
    result = run_analysis(df, ticker)

    # `run_analysis` derives everything from the last DAILY bar, so its
    # "current_price" is a close, not a live price. Report the live quote as
    # current_price (that is what the UI labels LIVE PRICE) and keep the bar
    # the levels were computed from as explicit provenance, so a stale feed can
    # never masquerade as a live price again.
    if isinstance(result, dict):
        try:
            bar_close = result.get("current_price")
            if not df.empty and "date" in df.columns:
                result["analysis_bar_date"] = str(pd.Timestamp(df["date"].max()).date())
            result["analysis_bar_close"] = bar_close

            live = get_latest_quote(ticker) or {}
            live_price = live.get("price")
            if isinstance(live_price, (int, float)) and live_price > 0:
                result["current_price"] = round(float(live_price), 2)
                result["live_price"] = round(float(live_price), 2)
                if isinstance(bar_close, (int, float)) and bar_close > 0:
                    result["live_vs_bar_pct"] = round(
                        (float(live_price) - float(bar_close)) / float(bar_close) * 100, 2
                    )
        except Exception as exc:  # never let provenance break the analysis
            print(f"[Analyze] live-price overlay failed for {ticker}: {exc}")

    return result


@app.get("/health")
@app.get("/api/v1/health")
async def health():
    """Cheap liveness check — no market data work.

    Also exposed under /api/v1 so the frontend can reach it through the
    same-origin proxy (app/api/backend/[...path]), which only forwards /api/v1
    paths. That is what BackendWarmup pings to wake a sleeping free-tier host.
    """
    return {"status": "Backend is running"}


@app.get("/api/v1/quote/{ticker}")
@limiter.limit("180/minute")
async def quote(request: Request, ticker: str):
    return get_latest_quote(ticker)


@app.get("/api/v1/quotes/batch")
@limiter.limit("120/minute")
async def batch_quotes(request: Request, tickers: str):
    ticker_list = [t.strip() for t in tickers.split(",") if t.strip()]
    if not ticker_list:
        raise HTTPException(status_code=400, detail="No tickers provided")
    if len(ticker_list) > 30:
        raise HTTPException(status_code=400, detail="Max 30 tickers per batch")
    bulk_results = get_latest_quotes_batch(ticker_list)
    return {ticker: bulk_results.get(ticker, {"price": None, "change_percent": 0.0}) for ticker in ticker_list}


@app.get("/api/v1/chart/{ticker}")
@limiter.limit("120/minute")
async def chart(request: Request, ticker: str, range: str = "1y"):
    try:
        df = get_chart_data(ticker, range)
        return df.to_dict(orient="records")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/api/v1/analyze-batch")
@limiter.limit("60/minute")
async def analyze_batch_alias(request: Request, tickers: str):
    return await analyze_batch(request, tickers)


@app.get("/api/v1/analyze/{ticker}")
@limiter.limit("60/minute")
async def analyze(request: Request, ticker: str):
    try:
        return analyze_ticker_sync(ticker)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/api/v1/analyze/batch")
@limiter.limit("60/minute")
async def analyze_batch(request: Request, tickers: str):
    ticker_list = [t.strip() for t in tickers.split(",") if t.strip()]
    if not ticker_list:
        raise HTTPException(status_code=400, detail="No tickers provided")
    if len(ticker_list) > 24:
        raise HTTPException(status_code=400, detail="Max 24 tickers per batch")

    loop = asyncio.get_event_loop()
    with ThreadPoolExecutor(max_workers=min(len(ticker_list), 6)) as executor:
        tasks = [loop.run_in_executor(executor, analyze_ticker_sync, ticker) for ticker in ticker_list]
        results = await asyncio.gather(*tasks, return_exceptions=True)

    payload = {}
    for ticker, result in zip(ticker_list, results):
        if isinstance(result, Exception):
            payload[ticker] = {"error": str(result)}
        else:
            payload[ticker] = result
    return payload


@app.get("/api/v1/fundamentals/{ticker}")
@limiter.limit("60/minute")
async def fundamentals(request: Request, ticker: str):
    try:
        return get_fundamentals_data(ticker)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/global-news")
@limiter.limit("60/minute")
async def global_news(request: Request):
    return fetch_global_market_news()


class ScreenerStock(BaseModel):
    name: str
    symbol: str
    exchange: str
    ticker: str
    currency: str | None = None


class ScreenerRequest(BaseModel):
    prompt: str
    stocks: list[ScreenerStock]


class SmartScreenerRequest(BaseModel):
    prompt: str
    stocks: list[ScreenerStock]
    screeners: list[dict[str, Any]] = []
    sectors: list[dict[str, Any]] = []
    # 'auto' detects SQL vs natural language; 'sql' / 'nl' force a path (UI toggle).
    mode: str = "auto"


class ScreenerEnrichRequest(BaseModel):
    rows: list[dict[str, Any]] = []


class ScreenerRunRequest(BaseModel):
    sql: str = Field(..., max_length=2000)


class StockAiRequest(BaseModel):
    prompt: str
    current_ticker: str
    stocks: list[ScreenerStock] = []


class AskAiMessage(BaseModel):
    role: str
    content: str


class AskAiContext(BaseModel):
    """Optional app context the UI can attach so answers use real data
    (selected stock, current prediction/confidence, indicators, trend, page)."""
    selected_symbol: str | None = None
    selected_ticker: str | None = None
    current_page: str | None = None
    prediction: Any | None = None
    confidence: Any | None = None
    trend: str | None = None
    analysis_summary: str | None = None
    indicators: dict[str, Any] = {}


class AskAiRequest(BaseModel):
    prompt: str
    history: list[AskAiMessage] = []
    stocks: list[ScreenerStock] = []
    context: AskAiContext | None = None
    conversation_id: str | None = None


class AlertCreateRequest(BaseModel):
    ticker: str
    prompt: str
    channels: list[str] = ["email"]
    email: str | None = None


class StrategyBacktestRequest(BaseModel):
    nl_text: str


class StrategyCreateRequest(BaseModel):
    name: str | None = None
    nl_text: str
    strategy_json: dict[str, Any] | None = None
    quality: dict[str, Any] | None = None
    enabled: bool = True


class StrategyPatchRequest(BaseModel):
    enabled: bool | None = None
    name: str | None = None


class AlertStatusRequest(BaseModel):
    status: str


class DailyUpdatePreferenceRequest(BaseModel):
    enabled: bool
    email: str | None = None


class NotificationPreferenceRequest(BaseModel):
    email: str | None = None
    daily_stock_email_enabled: bool | None = None
    market: str | None = None
    risk_level: str | None = None
    email_time: str | None = None
    signal_type: str | None = None
    delivery_mode: str | None = None
    force_generation: bool | None = None
    consent_version: str | None = None
    consent_accepted_at: str | None = None


class AdminDailyPredictionRequest(BaseModel):
    market: str | None = None
    risk_level: str | None = None
    email_time: str | None = None
    signal_type: str | None = None
    target_date: str | None = None
    send_email: bool = False
    force: bool = False


@app.post("/api/v1/screener/search")
@limiter.limit("6/minute")
async def screener_search(request: Request, body: ScreenerRequest):
    try:
        stocks = [
            stock.model_dump() if hasattr(stock, "model_dump") else stock.dict()
            for stock in body.stocks
        ]
        return screen_stocks(body.prompt, stocks)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/screener/smart-search")
@limiter.limit("10/minute")
async def smart_screener_search(request: Request, body: SmartScreenerRequest):
    try:
        stocks = [
            stock.model_dump() if hasattr(stock, "model_dump") else stock.dict()
            for stock in body.stocks
        ]
        return intelligent_smart_search(body.prompt, stocks, body.screeners, body.sectors, body.mode)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/screener/run")
@limiter.limit("60/minute")
async def screener_run(request: Request, body: ScreenerRunRequest):
    """Run a preset screen's SQL. Same sandbox as SQL mode, no LLM involved."""
    try:
        return run_screen_sql(body.sql)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/screener/sectors")
@limiter.limit("60/minute")
async def screener_sectors(request: Request):
    try:
        return sector_overview()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/screener/enrich")
@limiter.limit("30/minute")
async def screener_enrich(request: Request, body: ScreenerEnrichRequest):
    try:
        return {
            "rows": enrich_metric_rows(body.rows[:120], max_age_hours=None),
            "source": "Supabase stock_snapshot",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/stock-ai/search")
@limiter.limit("12/minute")
async def stock_ai_search(request: Request, body: StockAiRequest):
    try:
        stocks = [
            stock.model_dump() if hasattr(stock, "model_dump") else stock.dict()
            for stock in body.stocks[:900]
        ]
        return run_stock_ai_search(body.prompt, body.current_ticker, stocks)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/ask-ai/chat")
@limiter.limit("12/minute")
async def ask_ai_chat(request: Request, body: AskAiRequest):
    try:
        user = None
        auth_header = request.headers.get("authorization")
        if auth_header:
            try:
                user = get_user_from_authorization(auth_header)
            except ValueError as exc:
                print(f"[AskAIHistory] auth verification failed; continuing unsaved: {exc}")
        # Pass the FULL catalog through. Market-wide queries (movers/circuit
        # hits) need to see every stock, not a truncated head, or mid-cap names
        # (e.g. NETWEB at ~#1389) get silently dropped before the engine runs.
        stocks = [
            stock.model_dump() if hasattr(stock, "model_dump") else stock.dict()
            for stock in body.stocks[:5000]
        ]
        history = [
            message.model_dump() if hasattr(message, "model_dump") else message.dict()
            for message in body.history[:20]
        ]
        if user:
            history = history_for_llm(user["id"], body.conversation_id, history)
        context = None
        if body.context is not None:
            context = body.context.model_dump() if hasattr(body.context, "model_dump") else body.context.dict()
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, run_ask_ai, body.prompt, history, stocks, context)
        if user:
            conversation_id = save_turn(user["id"], body.conversation_id, body.prompt, result)
            if conversation_id:
                result["conversation_id"] = conversation_id
                result["saved"] = True
            else:
                result["saved"] = False
        else:
            result["saved"] = False
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/ask-ai/movers-status")
@limiter.limit("120/minute")
async def ask_ai_movers_status(request: Request):
    return movers_snapshot_status()


@app.get("/api/v1/ask-ai/conversations")
@limiter.limit("60/minute")
async def ask_ai_conversations(request: Request):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        return {"conversations": list_conversations(user["id"])}
    except ValueError as e:
        raise HTTPException(status_code=401 if "sign in" in str(e).lower() or "session" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/ask-ai/conversations/{conversation_id}")
@limiter.limit("60/minute")
async def ask_ai_conversation(request: Request, conversation_id: str):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        return get_conversation(user["id"], conversation_id)
    except ValueError as e:
        raise HTTPException(status_code=404 if "not found" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/strategies/backtest")
@limiter.limit("6/minute")
async def post_strategy_backtest(request: Request, body: StrategyBacktestRequest):
    try:
        result = backtest_nl_strategy(body.nl_text)
        result["success"] = True
        result["disclaimer"] = STRATEGY_DISCLAIMER
        return result
    except ValueError as e:
        return {
            "success": False,
            "message": str(e),
            "disclaimer": STRATEGY_DISCLAIMER,
            "strategy_json": None,
            "stats": None,
            "alertable": False,
            "recent_signals": [],
        }
    except Exception as e:
        return {
            "success": False,
            "message": f"Strategy backtest is unavailable right now: {e}",
            "disclaimer": STRATEGY_DISCLAIMER,
            "strategy_json": None,
            "stats": None,
            "alertable": False,
            "recent_signals": [],
        }


@app.post("/api/v1/strategies")
@limiter.limit("10/minute")
async def post_ai_strategy(request: Request, body: StrategyCreateRequest):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        strategy_json = validate_strategy_json(body.strategy_json) if body.strategy_json else backtest_nl_strategy(body.nl_text)["strategy_json"]
        strategy = create_ai_strategy(
            user,
            name=body.name,
            nl_text=body.nl_text,
            strategy_json=strategy_json,
            quality=body.quality,
            enabled=body.enabled,
        )
        return {"strategy": strategy, "disclaimer": STRATEGY_DISCLAIMER}
    except ValueError as e:
        raise HTTPException(status_code=401 if "sign in" in str(e).lower() or "session" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/strategies")
@limiter.limit("30/minute")
async def get_ai_strategies(request: Request):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        return {"strategies": list_ai_strategies(user["id"]), "disclaimer": STRATEGY_DISCLAIMER}
    except ValueError as e:
        raise HTTPException(status_code=401 if "sign in" in str(e).lower() or "session" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/api/v1/strategies/{strategy_id}")
@limiter.limit("20/minute")
async def patch_ai_strategy(request: Request, strategy_id: str, body: StrategyPatchRequest):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        patch = body.model_dump(exclude_none=True) if hasattr(body, "model_dump") else body.dict(exclude_none=True)
        return {"strategy": update_ai_strategy(user["id"], strategy_id, patch)}
    except ValueError as e:
        raise HTTPException(status_code=401 if "sign in" in str(e).lower() or "session" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/v1/strategies/{strategy_id}")
@limiter.limit("20/minute")
async def delete_ai_strategy_endpoint(request: Request, strategy_id: str):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        return delete_ai_strategy(user["id"], strategy_id)
    except ValueError as e:
        raise HTTPException(status_code=401 if "sign in" in str(e).lower() or "session" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/strategies/{strategy_id}/signals")
@limiter.limit("30/minute")
async def get_ai_strategy_signals(request: Request, strategy_id: str):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        return {"signals": list_ai_strategy_signals(user["id"], strategy_id), "disclaimer": STRATEGY_DISCLAIMER}
    except ValueError as e:
        raise HTTPException(status_code=401 if "sign in" in str(e).lower() or "session" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/alerts")
@limiter.limit("60/minute")
async def get_alerts(request: Request):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        return {"alerts": list_alerts(user["id"])}
    except ValueError as e:
        raise HTTPException(status_code=401 if "sign in" in str(e).lower() or "session" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/alerts")
@limiter.limit("20/minute")
async def post_alert(request: Request, body: AlertCreateRequest):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        alert = create_alert(
            user=user,
            ticker=body.ticker,
            prompt=body.prompt,
            channels=body.channels,
            email=body.email,
        )
        initial_check = check_alert(alert, send_notifications=True)
        return {"alert": alert, "initial_check": initial_check}
    except ValueError as e:
        raise HTTPException(status_code=401 if "sign in" in str(e).lower() or "session" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.patch("/api/v1/alerts/{alert_id}")
@limiter.limit("30/minute")
async def patch_alert(request: Request, alert_id: str, body: AlertStatusRequest):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        return {"alert": update_alert_status(user["id"], alert_id, body.status)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/v1/alerts/{alert_id}")
@limiter.limit("30/minute")
async def remove_alert(request: Request, alert_id: str):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        return delete_alert(user["id"], alert_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/alerts/{alert_id}/test")
@limiter.limit("10/minute")
async def test_alert(request: Request, alert_id: str):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        alerts = [alert for alert in list_alerts(user["id"]) if alert.get("id") == alert_id]
        if not alerts:
            raise HTTPException(status_code=404, detail="Alert not found")
        evaluation = evaluate_alert(alerts[0])
        notifications = notify_alert(alerts[0], evaluation)
        return {
            "alert_id": alert_id,
            "evaluation": evaluation,
            "notifications": notifications,
            "test_sent": True,
        }
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/alerts/check-now")
@limiter.limit("2/minute")
async def check_alerts_now(request: Request):
    admin_key = os.getenv("ALERT_ADMIN_KEY")
    if admin_key and request.headers.get("x-alert-admin-key") != admin_key:
        raise HTTPException(status_code=403, detail="Invalid alert admin key")
    try:
        return check_active_alerts(limit=int(os.getenv("ALERT_CHECK_BATCH_SIZE", "100")))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/daily-updates/preferences")
@limiter.limit("60/minute")
async def get_daily_updates_preference(request: Request):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        return {"preference": get_daily_update_preference(user)}
    except ValueError as e:
        raise HTTPException(status_code=401 if "sign in" in str(e).lower() or "session" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/v1/daily-updates/preferences")
@limiter.limit("20/minute")
async def put_daily_updates_preference(request: Request, body: DailyUpdatePreferenceRequest):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        preference = update_daily_update_preference(user, enabled=body.enabled, email=body.email)
        return {"preference": preference}
    except ValueError as e:
        raise HTTPException(status_code=401 if "sign in" in str(e).lower() or "session" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/daily-updates/run-review")
@limiter.limit("2/minute")
async def run_daily_updates_review(request: Request):
    admin_key = os.getenv("ALERT_ADMIN_KEY")
    if admin_key and request.headers.get("x-alert-admin-key") != admin_key:
        raise HTTPException(status_code=403, detail="Invalid alert admin key")
    try:
        return run_daily_review(send_email=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/daily-updates/run-forecast")
@limiter.limit("2/minute")
async def run_daily_updates_forecast(request: Request):
    admin_key = os.getenv("ALERT_ADMIN_KEY")
    if admin_key and request.headers.get("x-alert-admin-key") != admin_key:
        raise HTTPException(status_code=403, detail="Invalid alert admin key")
    try:
        return run_daily_forecast(send_email=True)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/v1/daily-updates/run-scheduled")
@limiter.limit("6/minute")
async def run_scheduled_daily_updates(request: Request):
    admin_key = os.getenv("ALERT_ADMIN_KEY")
    if admin_key and request.headers.get("x-alert-admin-key") != admin_key:
        raise HTTPException(status_code=403, detail="Invalid alert admin key")
    try:
        # Drives both due-email delivery AND post-close outcome tracking.
        return run_scheduled_tick(force=False)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/notification-preferences")
@app.get("/api/v1/notification-preferences")
@limiter.limit("60/minute")
async def get_notification_preferences(request: Request):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        return {"preference": get_notification_preference(user)}
    except ValueError as e:
        raise HTTPException(status_code=401 if "sign in" in str(e).lower() or "session" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/notification-preferences")
@app.put("/api/v1/notification-preferences")
@limiter.limit("20/minute")
async def put_notification_preferences(request: Request, body: NotificationPreferenceRequest):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        preference = update_notification_preference(
            user,
            body.model_dump(exclude_none=True) if hasattr(body, "model_dump") else body.dict(exclude_none=True),
        )
        return {"preference": preference}
    except ValueError as e:
        raise HTTPException(status_code=401 if "sign in" in str(e).lower() or "session" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/notification-preferences/enable-daily-alerts")
@app.post("/api/v1/notification-preferences/enable-daily-alerts")
@limiter.limit("20/minute")
async def post_enable_daily_alerts(request: Request, body: NotificationPreferenceRequest):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        preference = enable_daily_alerts(
            user,
            body.model_dump(exclude_none=True) if hasattr(body, "model_dump") else body.dict(exclude_none=True),
        )
        return {"preference": preference}
    except ValueError as e:
        raise HTTPException(status_code=401 if "sign in" in str(e).lower() or "session" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/notification-preferences/disable-daily-alerts")
@app.post("/api/v1/notification-preferences/disable-daily-alerts")
@limiter.limit("20/minute")
async def post_disable_daily_alerts(request: Request):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        preference = disable_daily_alerts(user)
        return {"preference": preference}
    except ValueError as e:
        raise HTTPException(status_code=401 if "sign in" in str(e).lower() or "session" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/notification-preferences/send-now")
@app.post("/api/v1/notification-preferences/send-now")
@limiter.limit("10/minute")
async def post_send_notification_now(request: Request, body: NotificationPreferenceRequest):
    try:
        user = get_user_from_authorization(request.headers.get("authorization"))
        result = send_instant_signal_email(
            user,
            body.model_dump(exclude_none=True) if hasattr(body, "model_dump") else body.dict(exclude_none=True),
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=401 if "sign in" in str(e).lower() or "session" in str(e).lower() else 400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/unsubscribe")
@app.get("/api/v1/unsubscribe")
@limiter.limit("20/minute")
async def get_unsubscribe(request: Request, token: str):
    try:
        result = unsubscribe_daily_alerts(token)
        return HTMLResponse(
            "<html><body style='font-family:Arial,sans-serif;padding:32px'>"
            "<h1>Daily stock emails turned off</h1>"
            "<p>You have been unsubscribed successfully. You can re-enable alerts anytime from your Bullseye account settings.</p>"
            f"<p>User: {result['user_id']}</p>"
            "</body></html>"
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/admin/run-daily-stock-prediction")
@app.post("/api/v1/admin/run-daily-stock-prediction")
@limiter.limit("4/minute")
async def post_run_daily_stock_prediction(request: Request, body: AdminDailyPredictionRequest):
    admin_key = os.getenv("ALERT_ADMIN_KEY")
    if admin_key and request.headers.get("x-alert-admin-key") != admin_key:
        raise HTTPException(status_code=403, detail="Invalid alert admin key")
    try:
        return run_daily_prediction(
            market=body.market or "NSE",
            risk_level=body.risk_level or "Balanced",
            signal_type=body.signal_type or "Next-day swing",
            send_email=body.send_email,
            force=body.force,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/signals/today")
@app.get("/api/v1/signals/today")
@limiter.limit("30/minute")
async def get_today_signals_endpoint(request: Request, market: str = "NSE", risk_level: str = "Balanced", signal_type: str = "Next-day swing"):
    try:
        return get_signals_today(market=market, risk_level=risk_level, signal_type=signal_type)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/admin/model-status")
@limiter.limit("30/minute")
async def get_model_status(request: Request):
    """Is the trained model actually loaded, or is this the fallback?

    A model that fails to unpickle degrades silently to a logistic
    approximation, so "the API is up" says nothing about whether predictions are
    coming from the validated model. This makes that answerable in production
    without reading startup logs.
    """
    from app.services.daily_signal_engine.ml_interface import model_status

    status = model_status()
    if not status["using_trained_model"]:
        status["warning"] = (
            "Predictions are using the logistic fallback, not the trained model. "
            "Retrain with scripts/train_ml.py or align the scikit-learn version."
        )
    return status


@app.get("/api/v1/stocks/{symbol}/track-record")
@limiter.limit("60/minute")
async def get_stock_track_record_endpoint(request: Request, symbol: str, limit: int = 12):
    """Past Bullseye calls on one stock and how they actually resolved."""
    try:
        return get_stock_track_record(symbol, limit=limit)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/v1/stocks/{ticker}/peers")
@limiter.limit("60/minute")
async def get_stock_peers_endpoint(request: Request, ticker: str):
    """This stock's fundamentals against the median of its sector."""
    try:
        return sector_peer_comparison(ticker)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/signals/history")
@app.get("/api/v1/signals/history")
@limiter.limit("30/minute")
async def get_signal_history_endpoint(request: Request, limit: int = 20):
    try:
        return get_signals_history(limit=max(1, min(limit, 60)))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/admin/daily-stock-prediction/status")
@app.get("/api/v1/admin/daily-stock-prediction/status")
@limiter.limit("10/minute")
async def get_daily_stock_prediction_status(request: Request):
    admin_key = os.getenv("ALERT_ADMIN_KEY")
    if admin_key and request.headers.get("x-alert-admin-key") != admin_key:
        raise HTTPException(status_code=403, detail="Invalid alert admin key")
    try:
        return get_admin_status()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


print("FastAPI started - visit http://localhost:8000/health")
