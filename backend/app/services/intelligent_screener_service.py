"""Intelligent stock screener — Phase 1.

Two ways in, one safe engine out:

* **Natural language** ("cheap profitable smallcaps with low debt and RSI < 40")
  is sent to the LLM (Groq, via ``llm_client``), which writes a single SQL
  ``SELECT`` over the virtual table ``stock_snapshot``. Because the model writes
  real SQL over every column, it is no longer limited to a handful of hand-coded
  phrasings.
* **Raw SQL** (a pro user types ``SELECT ... FROM stock_snapshot WHERE ...``) is
  taken as-is.

Both go through the same validate-then-execute path:

1. ``sqlglot`` parses the SQL and we **reject** anything that is not a single
   read-only ``SELECT`` over ``stock_snapshot`` (no DDL/DML, no other tables, no
   multiple statements, no dangerous functions).
2. Execution runs in ``sqlglot``'s pure-Python executor **over an in-memory copy
   of the snapshot** — the query can never reach the real Postgres, so even a
   hostile query only sees a throwaway list of dicts.

If the LLM is unavailable or produces SQL we cannot run even after one repair
round, the response says so plainly rather than guessing.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

import sqlglot
from sqlglot import expressions as exp
from sqlglot.executor import execute as sqlglot_execute

from app.services import llm_client
from app.services.relevance_guard import OFF_TOPIC_REPLY, small_talk_reply
from app.services.stock_snapshot_service import frontend_metric_row, get_snapshot_rows

TABLE = "stock_snapshot"
DEFAULT_LIMIT = 60
MAX_LIMIT = 300

# Every column the model / a pro user is allowed to reference, with a one-line
# meaning + unit. Kept in sync with database/supabase_stock_snapshot.sql.
COLUMN_DOC = {
    "ticker": "Yahoo ticker, e.g. RELIANCE.NS (text)",
    "symbol": "NSE symbol, e.g. RELIANCE (text)",
    "name": "company name (text)",
    "sector": "Yahoo sector name (text)",
    "price": "current price, INR",
    "previous_close": "previous close, INR",
    "today_open": "today's open, INR",
    "gap_pct": "open vs prev close, %",
    "vwap10": "10-day VWAP, INR",
    "change_pct": "today's move, %",
    "trailing_pe": "trailing P/E ratio",
    "forward_pe": "forward P/E ratio",
    "price_to_book": "P/B ratio",
    "market_cap": "market cap, INR (absolute)",
    "market_cap_cr": "market cap in INR crore (use THIS for cap buckets)",
    "roe": "return on equity, % (e.g. 15 = 15%); reported, or P/B divided by P/E where not reported",
    "roce": "return on capital employed, % — not provided by the data source, always NULL; use roe instead",
    "roa": "return on assets, %",
    "debt_to_equity": "debt/equity RATIO (0 = debt-free, <1 = low debt, 1 = 1x, 2 = 2x). For 'low debt' use < 1, 'debt-free' use < 0.1",
    "revenue_growth": "revenue growth, %",
    "profit_growth": "profit growth, %",
    "earnings_quarterly_growth": "latest quarterly earnings growth, %",
    "dividend_yield": "dividend yield in % (0.86 = 0.86%, 5.67 = 5.67%). For 'yield above 3%' use > 3",
    "operating_margin": "operating margin, %",
    "profit_margin": "net profit margin, %",
    "beta": "beta vs market",
    "enterprise_value": "enterprise value, INR",
    "total_cash": "total cash, INR",
    "total_debt": "total debt, INR",
    "rsi14": "14-day RSI, 0-100 (<30 oversold, >70 overbought)",
    "mfi14": "14-day Money Flow Index, 0-100",
    "sma20": "20-day simple moving average, INR",
    "sma50": "50-day simple moving average, INR",
    "sma200": "200-day simple moving average, INR",
    "ema20": "20-day EMA, INR",
    "atr14": "14-day Average True Range, INR",
    "ret_1w": "1-week return, %",
    "ret_1m": "1-month return, %",
    "ret_3m": "3-month return, %",
    "ret_6m": "6-month return, %",
    "ret_1y": "1-year return, %",
    "high_52w": "52-week high, INR",
    "low_52w": "52-week low, INR",
    "vol_ratio": "latest volume / 20-day avg volume",
    "latest_volume": "latest session volume (shares)",
    "volume_sma20": "20-day average volume (shares)",
    "latest_date": "date of the latest bar (date)",
}
KNOWN_COLUMNS = set(COLUMN_DOC)

# Functions we never want, even though the sandbox has no DB to reach.
_BANNED_TOKENS = re.compile(
    r"\b(pg_sleep|pg_read_file|pg_ls_dir|current_setting|set_config|dblink|copy|"
    r"information_schema|pg_catalog|lo_import|lo_export)\b",
    re.IGNORECASE,
)


class SqlValidationError(ValueError):
    """Raised when a SQL statement is not a safe single SELECT over the snapshot."""


# ── snapshot loading ──────────────────────────────────────────────────────────
def _load_rows() -> list[dict[str, Any]]:
    """Full snapshot (stale allowed) as a list of plain dicts — cached upstream."""
    return list(get_snapshot_rows(max_age_hours=None) or [])


def _distinct_sectors(rows: list[dict[str, Any]], limit: int = 30) -> list[str]:
    seen: list[str] = []
    for row in rows:
        sector = row.get("sector")
        if sector and sector not in seen:
            seen.append(sector)
        if len(seen) >= limit:
            break
    return seen


# ── validation ────────────────────────────────────────────────────────────────
# Statements that begin with a write/DDL keyword are still routed to the SQL path
# on purpose — so validate_sql rejects them with a clear message instead of the
# NL model silently reinterpreting "DROP TABLE ..." as a benign search.
_DDL_DML_START = re.compile(
    r"^\s*(drop|delete|update|insert|alter|create|truncate|grant|revoke|merge|replace)\b",
    re.IGNORECASE,
)


def looks_like_sql(text: str) -> bool:
    low = (text or "").strip().lower()
    if _DDL_DML_START.match(low):
        return True
    if low.startswith("with "):
        return True
    # A real SELECT has a FROM; "select me some banking stocks" (English) does not.
    return low.startswith("select") and re.search(r"\bfrom\b", low) is not None


def validate_sql(sql: str) -> exp.Expression:
    """Parse and validate. Returns the (limit-enforced) AST or raises SqlValidationError."""
    if _BANNED_TOKENS.search(sql or ""):
        raise SqlValidationError("Query uses a function that isn't allowed here.")
    try:
        statements = sqlglot.parse(sql, read="postgres")
    except Exception as exc:  # noqa: BLE001
        raise SqlValidationError(f"Could not parse SQL: {exc}") from exc

    statements = [s for s in statements if s is not None]
    if len(statements) != 1:
        raise SqlValidationError("Only a single SELECT statement is allowed.")

    node = statements[0]
    if not isinstance(node, exp.Select):
        raise SqlValidationError("Only read-only SELECT queries are allowed.")

    # Allowed table names = the snapshot plus any CTE aliases defined in-query.
    cte_names = {c.alias_or_name.lower() for c in node.find_all(exp.CTE)}
    allowed = {TABLE} | cte_names
    for table in node.find_all(exp.Table):
        if table.name.lower() not in allowed:
            raise SqlValidationError(
                f"Only the '{TABLE}' table is available (got '{table.name}')."
            )

    node = _normalise_for_executor(node)

    # Enforce a hard row cap.
    limit = node.args.get("limit")
    if limit is None:
        node = node.limit(DEFAULT_LIMIT)
    else:
        try:
            requested = int(limit.expression.name)
            if requested > MAX_LIMIT:
                node = node.limit(MAX_LIMIT)
        except Exception:  # noqa: BLE001 - non-integer LIMIT, leave as-is
            pass
    return node


def _normalise_for_executor(node: exp.Select) -> exp.Select:
    """Make valid Postgres run the same way in the in-memory executor.

    * Text matching is case-insensitive (ILIKE isn't implemented, and names
      are stored as "HDFC Bank Ltd", so LIKE '%bank%' would miss them).
    * Sorting a column that has blanks crashes Python's sort, and Postgres
      would put the blanks first in a DESC list anyway. A stock with no value
      for the sort key can't rank on it, so plain queries drop those rows;
      grouped queries sort blanks last.
    """
    def _case_insensitive(n: exp.Expression) -> exp.Expression:
        if not isinstance(n, (exp.Like, exp.ILike)) or isinstance(n.this, exp.Lower):
            return n
        like = exp.Like(this=exp.Lower(this=n.this.copy()), expression=exp.Lower(this=n.expression.copy()))
        # sqlglot stores NOT LIKE as a flag on the node, not as a NOT parent.
        if n.args.get("negate"):
            return exp.Not(this=like)
        return like

    node = node.transform(_case_insensitive)

    order = node.args.get("order")
    if not order:
        return node
    grouped = bool(node.args.get("group")) or any(
        isinstance(e.unalias(), exp.AggFunc) for e in node.expressions
    )
    aliases = {e.alias: e.unalias() for e in node.expressions if isinstance(e, exp.Alias)}
    for ordered in order.expressions:
        key = ordered.this
        if grouped:
            sentinel = exp.Literal.number(-1e18 if ordered.args.get("desc") else 1e18)
            ordered.set("this", exp.Coalesce(this=key.copy(), expressions=[sentinel]))
            continue
        target = aliases.get(key.name, key) if isinstance(key, exp.Column) and not key.table else key
        node = node.where(exp.Not(this=exp.Is(this=target.copy(), expression=exp.Null())), copy=False)
    return node


def _execute(node: exp.Expression, rows: list[dict[str, Any]]) -> tuple[list[str], list[tuple]]:
    result = sqlglot_execute(node.sql(), tables={TABLE: rows})
    return list(result.columns), list(result.rows)


# ── result → screener payload ────────────────────────────────────────────────
def _payload(
    columns: list[str],
    data_rows: list[tuple],
    all_rows: list[dict[str, Any]],
    *,
    generated_sql: str,
    mode: str,
    explanation: str,
    source: str,
    provider: str | None = None,
) -> dict[str, Any]:
    dicts = [dict(zip(columns, r)) for r in data_rows]
    by_key: dict[str, dict[str, Any]] = {}
    for snap in all_rows:
        by_key[str(snap.get("ticker"))] = snap
        by_key[str(snap.get("symbol"))] = snap

    key = "ticker" if "ticker" in columns else ("symbol" if "symbol" in columns else None)
    cards: list[dict[str, Any]] = []
    if key is not None:
        for index, row in enumerate(dicts):
            snap = by_key.get(str(row.get(key)))
            if not snap:
                continue
            cards.append(
                frontend_metric_row(
                    snap,
                    reason=f"Matched your screen (row {index + 1}).",
                    score=max(55, 96 - index),
                )
            )

    payload = {
        "rows": cards,
        "matchedRules": [generated_sql],
        "explanation": explanation,
        "source": source,
        "generated_sql": generated_sql,
        "mode": mode,
        "count": len(cards) if cards else len(dicts),
        "columns": columns,
    }
    if provider:
        payload["llm_provider"] = provider
    # Aggregates / projections with no per-stock key (e.g. GROUP BY sector) can't
    # become stock cards, so hand the UI a plain table instead. A stock-style
    # query that simply matched nothing keeps rows=[] and gets NO table, so it
    # reads as an honest "no matches" rather than an empty grid.
    if key is None and dicts:
        payload["table"] = {"columns": columns, "rows": [list(r) for r in data_rows]}
    return payload


# ── natural language → SQL (Groq) ─────────────────────────────────────────────
NIFTY_50 = (
    "ADANIENT ADANIPORTS APOLLOHOSP ASIANPAINT AXISBANK BAJAJ-AUTO BAJFINANCE BAJAJFINSV BEL "
    "BHARTIARTL CIPLA COALINDIA DRREDDY EICHERMOT ETERNAL GRASIM HCLTECH HDFCBANK HDFCLIFE "
    "HINDALCO HINDUNILVR ICICIBANK INDIGO INFY ITC JIOFIN JSWSTEEL KOTAKBANK LT M&M MARUTI "
    "MAXHEALTH NESTLEIND NTPC ONGC POWERGRID RELIANCE SBILIFE SBIN SHRIRAMFIN SUNPHARMA "
    "TATACONSUM TMPV TATASTEEL TCS TECHM TITAN TRENT ULTRACEMCO WIPRO"
).split()
PSU_BANKS = "SBIN PNB BANKBARODA CANBK UNIONBANK BANKINDIA INDIANB IOB UCOBANK CENTRALBK MAHABANK PSB".split()
# Indian themes that cut across Yahoo's broad sectors ("defence" is not a
# sector, and Industrials alone ranks L&T and Adani Ports first).
THEMES = {
    "PSU banks": PSU_BANKS,
    "defence": "HAL BEL BDL MAZDOCK COCHINSHIP GRSE BEML DATAPATTNS MTARTECH PARAS ASTRAMICRO SOLARINDS ZENTEC DCXINDIA".split(),
    "hospitals": "APOLLOHOSP MAXHEALTH FORTIS NH MEDANTA KIMS RAINBOW ASTERDM YATHARTH".split(),
    "gold loans": "MUTHOOTFIN MANAPPURAM IIFL".split(),
    "carmakers / two-wheelers / trucks": "MARUTI M&M TMPV TMCV BAJAJ-AUTO HEROMOTOCO EICHERMOT TVSMOTOR ASHOKLEY ESCORTS FORCEMOT OLAELEC ATHERENERG".split(),
    "auto ancillaries / auto parts": (
        "BOSCHLTD MOTHERSON UNOMINDA SONACOMS BHARATFORG EXIDEIND ARE&M MRF APOLLOTYRE BALKRISIND CEATLTD "
        "ENDURANCE SUNDRMFAST SCHAEFFLER TIINDIA ZFCVINDIA JBMA MINDACORP CRAFTSMAN GABRIEL"
    ).split(),
    "Tata group": (
        "TCS TATASTEEL TMPV TMCV TATAPOWER TATACONSUM TATACOMM TATAELXSI TATACHEM TITAN TRENT VOLTAS "
        "INDHOTEL TATAINVEST TATATECH NELCO RALLIS"
    ).split(),
    "Adani group": "ADANIENT ADANIPORTS ADANIPOWER ADANIGREEN ADANIENSOL ATGL AWL ACC AMBUJACEM NDTV".split(),
    "IT services": (
        "TCS INFY HCLTECH WIPRO TECHM LTIM PERSISTENT COFORGE MPHASIS OFSS KPITTECH TATAELXSI LTTS CYIENT "
        "SONATSOFTW ZENSARTECH BSOFT MASTEK HAPPSTMNDS"
    ).split(),
}


def _sql_list(symbols: list[str]) -> str:
    return ", ".join(f"'{s}'" for s in symbols)


def _nl_system_prompt(sectors: list[str]) -> str:
    cols = "\n".join(f"  {name}: {doc}" for name, doc in COLUMN_DOC.items())
    sector_line = ", ".join(s for s in sectors if s) or "(various Yahoo sectors)"
    return (
        "You turn an Indian retail investor's request into a stock screen over ONE table, "
        "stock_snapshot (one row per NSE stock, latest close).\n"
        "Reply with ONE JSON object and nothing else, in one of two shapes:\n"
        '  {"kind":"screen","sql":"SELECT ...","summary":"...","caveat":"..." or null}\n'
        '  {"kind":"answer","text":"..."}\n'
        '  {"kind":"off_topic"}  (anything not about stocks, markets, investing or the economy)\n\n'
        "Use kind=answer ONLY for a greeting, a definition of a term (what is RSI?), or a request "
        "for buy/sell advice (what should I buy, best stocks to buy now, is X a good investment). "
        "text is 2-4 plain-English sentences, never facts or numbers about a specific company; "
        "for advice say you can't recommend what to buy and suggest one concrete screen in words. "
        "Everything else is a screen, including: a company name (tell me about TCS -> its row), "
        "a number from the data (P/E of Infosys -> its row; how many stocks have RSI below 30 -> "
        "SELECT COUNT(*) AS stocks ...), a comparison of named companies, and sector questions.\n\n"
        "summary: one short sentence saying how you read the request, with the thresholds you "
        "chose, e.g. \"Small caps (under ₹30,000 cr) ranked by 1-week return.\"\n"
        "caveat: one short sentence ONLY if the request needs data this table doesn't have and "
        "you used the closest substitute (all-time high -> 52-week high; 10-year or 3/5-year "
        "history, quarterly trend, FII/promoter holding, free cash flow, ROCE, order book -> "
        "not available). Otherwise null.\n\n"
        "SQL rules:\n"
        "- One PostgreSQL SELECT FROM stock_snapshot. No other tables, no writes. Functions "
        "available: COUNT, AVG, SUM, MIN, MAX, ROUND, ABS, COALESCE, LOWER. There is no MEDIAN or "
        "PERCENTILE: use AVG and call it the average in summary.\n"
        "- Select symbol and name first, then the columns the request is about.\n"
        "- Put parentheses around every OR group.\n"
        "- ORDER BY what the request ranks on; if it ranks on nothing, ORDER BY market_cap_cr DESC.\n"
        "- LIMIT 50 unless a number is asked for.\n"
        "- Size (approximate AMFI cut-offs, market_cap_cr): large cap >= 100000; mid cap "
        "30000 to 100000; small cap < 30000; micro cap < 5000. Penny stock: price < 20.\n"
        "- For vague value or quality words (undervalued, cheap, quality, good, strong, "
        "multibagger) use concrete thresholds, require trailing_pe > 0, and skip tiny "
        "illiquid names with market_cap_cr > 500.\n"
        "- N DMA means smaN exactly: 20 DMA = sma20, 50 DMA = sma50, 200 DMA = sma200. Price "
        "crossing above N DMA: price > smaN AND previous_close <= smaN (below: the reverse).\n"
        "- 'Low on 10 year average earnings' / Graham value: trailing_pe > 0 AND trailing_pe < 15 "
        "AND debt_to_equity < 1 AND roe > 15 (caveat: uses trailing earnings, not a 10-year average).\n"
        "- Streaks (up 3 days in a row) aren't stored: use change_pct > 0 AND ret_1w > 0 and say so in caveat.\n"
        "- Volatility: atr14 / price * 100 AS atr_pct. Near 52-week high: price >= 0.95 * high_52w. "
        "Near 52-week low: price <= 1.05 * low_52w. Golden cross: sma50 > sma200 with sma50 "
        "within 2% of sma200 (recent crossover). Breakout: price >= high_52w * 0.98 with vol_ratio > 1.5. "
        "Loss making: trailing_pe IS NULL AND profit_margin < 0.\n"
        "- Sectors are Yahoo sectors: " + sector_line + ". Indian terms map like this: "
        "banks -> sector = 'Financial Services' AND name LIKE '%bank%'; NBFCs -> "
        "sector = 'Financial Services' AND name NOT LIKE '%bank%' AND name NOT LIKE '%insurance%' "
        "AND (name LIKE '%financ%' OR name LIKE '%capital%' OR name LIKE '%credit%' OR name LIKE "
        "'%housing%' OR name LIKE '%leasing%'); tech (broad) -> 'Technology'; "
        "pharma -> 'Healthcare'; FMCG -> 'Consumer Defensive'; retail, hotels, textiles -> "
        "'Consumer Cyclical'; metals, cement, chemicals -> 'Basic Materials' "
        "(narrow with name LIKE '%steel%' / '%cement%' / '%chem%' when asked); capital goods, "
        "infra -> 'Industrials'; power -> 'Utilities'; oil and gas -> 'Energy'; telecom, "
        "media -> 'Communication Services'; realty -> 'Real Estate'. Other business groups: "
        "name LIKE '%bajaj%', '%birla%', '%mahindra%'.\n"
        "- Nifty 50 (list as of late 2025): symbol IN (" + _sql_list(NIFTY_50) + ").\n"
        "- Themes that aren't Yahoo sectors; use the symbol list (IT companies/IT stocks "
        "means the IT services list, not the whole Technology sector):\n"
        + "".join(f"  {name}: symbol IN ({_sql_list(symbols)})\n" for name, symbols in THEMES.items())
        + "- Questions about sectors (which sector did best, average P/E by sector) GROUP BY "
        "sector with COUNT(*) AS stocks and the averaged metric, WHERE sector IS NOT NULL, "
        "returning every sector ranked (no LIMIT 1). For P/E averages add trailing_pe > 0 AND "
        "trailing_pe < 200.\n"
        "- \"This year\" means ret_1y (trailing 12 months; say so in caveat). Hinglish is fine.\n"
        "- Use ONLY these columns:\n" + cols + "\n\n"
        "Example:\n"
        "Q: cheap profitable midcaps with low debt\n"
        '{"kind":"screen","sql":"SELECT symbol, name, price, trailing_pe, roe, debt_to_equity, '
        "market_cap_cr FROM stock_snapshot WHERE market_cap_cr >= 30000 AND market_cap_cr < 100000 "
        "AND trailing_pe > 0 AND trailing_pe < 20 AND roe > 15 AND debt_to_equity < 1 ORDER BY "
        'roe DESC LIMIT 50","summary":"Mid caps with P/E under 20, ROE above 15% and debt below '
        'equity, highest ROE first.","caveat":null}'
    )


def _clean_sql(text: str) -> str:
    text = (text or "").strip()
    text = re.sub(r"^```(?:sql|json)?\s*|\s*```$", "", text, flags=re.IGNORECASE).strip()
    # Keep only up to the first statement terminator, and drop a trailing ';'.
    if ";" in text:
        text = text.split(";", 1)[0].strip()
    return text


def _parse_plan(text: str) -> dict[str, Any]:
    """The model's JSON plan; bare SQL (older prompt style) is still accepted."""
    raw = re.sub(r"^```(?:json|sql)?\s*|\s*```$", "", (text or "").strip(), flags=re.IGNORECASE).strip()
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if match:
        try:
            plan = json.loads(match.group(0))
            if isinstance(plan, dict):
                if plan.get("sql"):
                    plan["sql"] = _clean_sql(str(plan["sql"]))
                return plan
        except ValueError:
            pass
    return {"kind": "screen", "sql": _clean_sql(raw)}


def nl_to_plan(prompt: str, sectors: list[str], *, repair_hint: str | None = None) -> tuple[dict[str, Any], str | None]:
    messages = [{"role": "system", "content": _nl_system_prompt(sectors)}]
    user = prompt if not repair_hint else (
        f"{prompt}\n\n(Your previous SQL failed: {repair_hint}. Return the corrected JSON.)"
    )
    messages.append({"role": "user", "content": user})
    response = llm_client.chat(messages, temperature=0, max_tokens=600, prefer="groq")
    return _parse_plan(response["text"]), response.get("model")


def nl_to_sql(prompt: str, sectors: list[str], *, repair_hint: str | None = None) -> tuple[str, str | None]:
    plan, provider = nl_to_plan(prompt, sectors, repair_hint=repair_hint)
    return str(plan.get("sql") or ""), provider


# ── orchestration ─────────────────────────────────────────────────────────────
def _sql_path(prompt: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
    try:
        node = validate_sql(prompt)
    except SqlValidationError as exc:
        return {
            "rows": [],
            "matchedRules": [],
            "explanation": str(exc),
            "source": "SQL validation",
            "generated_sql": prompt.strip(),
            "mode": "sql",
            "error": str(exc),
        }
    try:
        columns, data_rows = _execute(node, rows)
    except Exception as exc:  # noqa: BLE001
        return {
            "rows": [],
            "matchedRules": [],
            "explanation": f"Your SQL is valid but failed to run: {exc}",
            "source": "SQL executor",
            "generated_sql": node.sql(),
            "mode": "sql",
            "error": str(exc),
        }
    return _payload(
        columns,
        data_rows,
        rows,
        generated_sql=node.sql(),
        mode="sql",
        explanation=(
            f"Ran your SQL against the live snapshot — {len(data_rows)} row(s)."
            if data_rows
            else "Your SQL ran but matched no stocks. Try loosening a condition."
        ),
        source="Raw SQL over Supabase stock_snapshot (sandboxed)",
    )


# Translated plans keyed by the normalised question. The SQL is re-run on every
# request, so a cached plan still reads the latest snapshot; it only saves the
# LLM call. Groq's free tier allows roughly 60 screener translations a day per
# model, and most visitors click the same example prompts.
_PLAN_CACHE: dict[str, tuple[float, dict[str, Any], str | None]] = {}
_PLAN_TTL = 7 * 24 * 3600
_PLAN_MAX = 1000


def _plan_key(prompt: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w%<>=.\s-]", " ", prompt.lower())).strip()


def _cached_plan(prompt: str, sectors: list[str]) -> tuple[dict[str, Any], str | None]:
    key = _plan_key(prompt)
    hit = _PLAN_CACHE.get(key)
    if hit and time.time() - hit[0] < _PLAN_TTL:
        return dict(hit[1]), hit[2]
    return nl_to_plan(prompt, sectors)


def _remember_plan(prompt: str, plan: dict[str, Any], provider: str | None) -> None:
    if len(_PLAN_CACHE) >= _PLAN_MAX:
        _PLAN_CACHE.pop(next(iter(_PLAN_CACHE)))
    _PLAN_CACHE[_plan_key(prompt)] = (time.time(), dict(plan), provider)


def _nl_path(prompt: str, rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    sectors = _distinct_sectors(rows)
    try:
        plan, provider = _cached_plan(prompt, sectors)
    except Exception as exc:  # noqa: BLE001 - Groq down / rate-limited
        print(f"[IntelligentScreener] NL->SQL generation failed: {exc}")
        return None

    if plan.get("kind") == "off_topic":
        plan = {"kind": "answer", "text": OFF_TOPIC_REPLY}
    if plan.get("kind") == "answer" and plan.get("text"):
        _remember_plan(prompt, plan, provider)
        return {
            "rows": [],
            "matchedRules": [],
            "explanation": str(plan["text"]).strip(),
            "answer": str(plan["text"]).strip(),
            "source": "Bullseye AI",
            "mode": "answer",
            "llm_provider": provider,
        }

    # Validate and run; one repair round covers both invalid SQL and SQL the
    # executor can't run (an unsupported function, a typo'd column).
    for attempt in range(2):
        sql = str(plan.get("sql") or "")
        try:
            node = validate_sql(sql)
            columns, data_rows = _execute(node, rows)
            break
        except Exception as exc:  # noqa: BLE001
            if attempt == 1:
                print(f"[IntelligentScreener] LLM SQL unusable after repair: {exc}")
                return None
            try:
                plan, provider = nl_to_plan(prompt, sectors, repair_hint=str(exc)[:300])
            except Exception:  # noqa: BLE001
                return None
    _remember_plan(prompt, plan, provider)

    summary = str(plan.get("summary") or "").strip()
    caveat = str(plan.get("caveat") or "").strip() or None
    if caveat and caveat.lower() in {"null", "none"}:
        caveat = None
    payload = _payload(
        columns,
        data_rows,
        rows,
        generated_sql=node.sql(),
        mode="nl",
        explanation=summary or (
            f'Read "{prompt.strip()}" as a screen.' if data_rows else f'No stock matched "{prompt.strip()}".'
        ),
        source="AI (Groq) natural-language → SQL over stock_snapshot",
        provider=provider,
    )
    payload["summary"] = summary or None
    payload["caveat"] = caveat
    return payload


def _median(values: list[float]) -> float | None:
    clean = sorted(v for v in values if isinstance(v, (int, float)))
    if not clean:
        return None
    mid = len(clean) // 2
    return clean[mid] if len(clean) % 2 else (clean[mid - 1] + clean[mid]) / 2


def sector_overview() -> dict[str, Any]:
    """Per-sector counts and medians for the screener's sector directory."""
    rows = _load_rows()
    groups: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        if row.get("sector"):
            groups.setdefault(str(row["sector"]), []).append(row)
    sectors = []
    for name, members in groups.items():
        by_size = sorted(members, key=lambda r: r.get("market_cap_cr") or 0, reverse=True)
        sectors.append({
            "sector": name,
            "stocks": len(members),
            "median_ret_1y": _median([r.get("ret_1y") for r in members]),
            "median_ret_1m": _median([r.get("ret_1m") for r in members]),
            "median_pe": _median([r.get("trailing_pe") for r in members if (r.get("trailing_pe") or 0) > 0]),
            "median_roe": _median([r.get("roe") for r in members]),
            "market_cap_cr": sum(r.get("market_cap_cr") or 0 for r in members),
            "leaders": [{"symbol": r.get("symbol"), "name": r.get("name")} for r in by_size[:3]],
        })
    sectors.sort(key=lambda s: s["market_cap_cr"], reverse=True)
    dates = sorted(str(r.get("latest_date") or "")[:10] for r in rows if r.get("latest_date"))
    return {
        "sectors": sectors,
        "unclassified": sum(1 for r in rows if not r.get("sector")),
        "universe": len(rows),
        "as_of": dates[-1] if dates else None,
    }


def run_screen_sql(sql: str) -> dict[str, Any]:
    """Run a preset screen or sector query (validated, sandboxed, no LLM)."""
    rows = _load_rows()
    if not rows:
        return {
            "rows": [],
            "error": "snapshot_unavailable",
            "explanation": "The market snapshot is temporarily unavailable.",
        }
    result = _sql_path(sql, rows)
    dates = sorted(str(r.get("latest_date") or "")[:10] for r in rows if r.get("latest_date"))
    result["as_of"] = dates[-1] if dates else None
    result["universe"] = len(rows)
    return result


def intelligent_smart_search(
    prompt: str,
    stocks: list[dict[str, Any]],
    screeners: list[dict[str, Any]] | None = None,
    sectors: list[dict[str, Any]] | list[str] | None = None,
    mode: str = "auto",
) -> dict[str, Any]:
    """Entry point for POST /api/v1/screener/smart-search.

    mode: 'auto' (detect), 'sql' (force raw SQL), or 'nl' (force natural language).
    Always returns a screener payload; never raises.
    """
    screeners = screeners or []
    sectors = sectors or []
    use_sql = mode == "sql" or (mode == "auto" and looks_like_sql(prompt))
    canned = None if use_sql else small_talk_reply(prompt)
    if canned:
        return {"rows": [], "matchedRules": [], "explanation": canned, "answer": canned,
                "source": "Bullseye AI", "mode": "answer"}
    rows = _load_rows()

    if use_sql:
        if not rows:
            return {
                "rows": [],
                "matchedRules": [],
                "explanation": "The market snapshot is temporarily unavailable, so I can't run SQL right now.",
                "source": "stock_snapshot unavailable",
                "generated_sql": prompt.strip(),
                "mode": "sql",
                "error": "snapshot_unavailable",
            }
        return _sql_path(prompt, rows)

    # Natural-language path (Groq). Fall back to the legacy router when the LLM
    # is unconfigured, fails, or produces SQL that yields nothing usable.
    if rows and llm_client.any_provider_available():
        nl = _nl_path(prompt, rows)
        # A successful translation is trusted even when it matches nothing — we
        # show the generated SQL and invite the user to loosen it, rather than
        # silently falling back to the looser regex router. We only fall through
        # when translation/execution actually failed (nl is None).
        if nl is not None:
            return nl

    # The old keyword router returned empty "sector" results for most requests
    # in testing, so a failed translation now says so plainly instead.
    return {
        "rows": [],
        "matchedRules": [],
        "mode": "unavailable",
        "source": "Bullseye AI",
        "explanation": (
            "I couldn't turn that into a screen right now. Try rephrasing it with a concrete "
            "condition (for example \"P/E under 20 and ROE above 15\"), pick a preset screen, "
            "or write the SQL yourself."
            if rows
            else "The market snapshot is temporarily unavailable. Please try again in a minute."
        ),
    }
