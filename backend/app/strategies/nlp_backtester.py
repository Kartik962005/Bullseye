import os
import re
import json
import math
import pandas as pd
import numpy as np
from groq import Groq
from dotenv import load_dotenv

from app.strategies.expression_guard import ExpressionValidationError, validate_expression
from app.services.llm_client import DEFAULT_GROQ_CHAT_MODEL

load_dotenv()

_client = None

def get_client():
    global _client
    if _client is None:
        api_key = os.environ.get("GROQ_API_KEY")
        if not api_key:
            raise RuntimeError("GROQ_API_KEY environment variable is not set.")
        _client = Groq(api_key=api_key)
    return _client


# ── Step 1: Prepare DataFrame with EVERY possible column ─────────────────────
_ALIASES = {'rsi': 'RSI_14', 'macd': 'MACD', 'atr': 'ATR_14', 'sma50': 'SMA_50', 'sma200': 'SMA_200', 'ema20': 'EMA_20'}


def columns_used(*exprs: str | None) -> set[str]:
    """Indicator columns a strategy expression reads, e.g. {'RSI_14', 'SMA_50'}."""
    used: set[str] = set()
    for expr in exprs:
        for name in re.findall(r"df\[['\"](\w+)['\"]\]", expr or ""):
            used.add(_ALIASES.get(name, name))
    return used


def _prepare_df(df: pd.DataFrame, only: set[str] | None = None) -> pd.DataFrame:
    """Add every indicator column a strategy expression can reference.

    only: when given, the oscillator block computes just these columns (plus
    RSI_14, which trade records report). A market scan runs one rule over 150
    stocks, and computing ADX, CCI, stochastics etc. for each was most of its
    CPU time.
    """
    df = df.copy()
    want = (lambda col: True) if only is None else (lambda col: col in only or col == 'RSI_14')

    # Normalise date
    if 'date' not in df.columns:
        df = df.reset_index()
        col = 'date' if 'date' in df.columns else df.columns[0]
        df = df.rename(columns={col: 'date'})
    df['date'] = pd.to_datetime(df['date'])
    df.columns = [c.lower() for c in df.columns]
    df = df.sort_values('date').reset_index(drop=True)

    close  = df['close']
    open_  = df['open']
    high   = df['high']
    low    = df['low']
    volume = df['volume']

    # ── Returns ───────────────────────────────────────────────────────────────
    df['day_return']   = close.pct_change() * 100
    df['week_return']  = close.pct_change(5) * 100
    df['month_return'] = close.pct_change(21) * 100
    df['prev_close']   = close.shift(1)
    df['prev_open']    = open_.shift(1)
    df['prev_high']    = high.shift(1)
    df['prev_low']     = low.shift(1)

    # ── Candle structure ──────────────────────────────────────────────────────
    df['body']        = abs(close - open_)
    df['upper_wick']  = high - df[['close','open']].max(axis=1)
    df['lower_wick']  = df[['close','open']].min(axis=1) - low
    df['is_green']    = (close > open_).astype(int)
    df['is_red']      = (close < open_).astype(int)
    df['gap_up']      = (open_ > close.shift(1) * 1.01)
    df['gap_down']    = (open_ < close.shift(1) * 0.99)
    df['vol_ratio']   = volume / volume.rolling(20).mean()

    # ── Moving averages ───────────────────────────────────────────────────────
    df['SMA_5']   = close.rolling(5).mean()
    df['SMA_10']  = close.rolling(10).mean()
    df['SMA_20']  = close.rolling(20).mean()
    df['SMA_50']  = close.rolling(50).mean()
    df['SMA_200'] = close.rolling(200).mean()
    df['EMA_9']   = close.ewm(span=9,  adjust=False).mean()
    df['EMA_20']  = close.ewm(span=20, adjust=False).mean()
    df['EMA_50']  = close.ewm(span=50, adjust=False).mean()
    df['VOL_SMA_20'] = volume.rolling(20).mean()

    # ── Momentum ──────────────────────────────────────────────────────────────
    try:
        import ta as ta_lib
        df['RSI_14']      = ta_lib.momentum.rsi(close, window=14)
        if want('RSI_9'):
            df['RSI_9']       = ta_lib.momentum.rsi(close, window=9)
        if want('MACD') or want('MACD_signal') or want('MACD_hist'):
            df['MACD']        = ta_lib.trend.macd(close)
            df['MACD_signal'] = ta_lib.trend.macd_signal(close)
            df['MACD_hist']   = df['MACD'] - df['MACD_signal']
        if want('ATR_14'):
            df['ATR_14']      = ta_lib.volatility.average_true_range(high, low, close, window=14)
        if want('BBU') or want('BBL') or want('BBM') or want('BB_width'):
            df['BBU']         = ta_lib.volatility.bollinger_hband(close, window=20, window_dev=2)
            df['BBL']         = ta_lib.volatility.bollinger_lband(close, window=20, window_dev=2)
            df['BBM']         = ta_lib.volatility.bollinger_mavg(close, window=20)
            df['BB_width']    = (df['BBU'] - df['BBL']) / df['BBM']
        if want('STOCH_K') or want('STOCH_D'):
            df['STOCH_K']     = ta_lib.momentum.stoch(high, low, close)
            df['STOCH_D']     = ta_lib.momentum.stoch_signal(high, low, close)
        if want('ADX'):
            df['ADX']         = ta_lib.trend.adx(high, low, close)
        if want('CCI'):
            df['CCI']         = ta_lib.trend.cci(high, low, close)
        if want('WILLIAMS_R'):
            df['WILLIAMS_R']  = ta_lib.momentum.williams_r(high, low, close)
        if want('OBV'):
            df['OBV']         = ta_lib.volume.on_balance_volume(close, volume)
        if want('MFI'):
            df['MFI']         = ta_lib.volume.money_flow_index(high, low, close, volume)
    except Exception as e:
        print(f"[TA] Some indicators failed: {e}")

    # Alias common names the LLM might use
    for alias, col in [
        ('rsi', 'RSI_14'), ('macd', 'MACD'), ('atr', 'ATR_14'),
        ('sma50', 'SMA_50'), ('sma200', 'SMA_200'), ('ema20', 'EMA_20'),
    ]:
        if col in df.columns and alias not in df.columns:
            df[alias] = df[col]

    return df


# ── Step 2: LLM strategy translation ─────────────────────────────────────────
SYSTEM_PROMPT = """
You are a quantitative finance assistant. Convert the user's trading strategy into TWO single-line Python/Pandas boolean expressions.

AVAILABLE COLUMNS IN df:
Price: df['open'], df['close'], df['high'], df['low'], df['volume']
Returns: df['day_return'] (daily % change), df['week_return'] (5-day %), df['month_return'] (21-day %)
Previous: df['prev_close'], df['prev_open'], df['prev_high'], df['prev_low']
Candle: df['is_green'] (1/0), df['is_red'] (1/0), df['body'], df['upper_wick'], df['lower_wick']
Volume: df['vol_ratio'] (volume / 20d avg), df['VOL_SMA_20'], df['OBV'], df['MFI']
MAs: df['SMA_5'], df['SMA_10'], df['SMA_20'], df['SMA_50'], df['SMA_200'], df['EMA_9'], df['EMA_20'], df['EMA_50']
Momentum: df['RSI_14'], df['RSI_9'], df['MACD'], df['MACD_signal'], df['MACD_hist']
Volatility: df['ATR_14'], df['BBU'], df['BBL'], df['BBM'], df['BB_width']
Oscillators: df['STOCH_K'], df['STOCH_D'], df['ADX'], df['CCI'], df['WILLIAMS_R']
Date: df['date'].dt.weekday (Mon=0,Fri=4), df['date'].dt.month, df['date'].dt.day
Gaps: df['gap_up'] (bool), df['gap_down'] (bool)

RULES:
1. Output ONLY valid JSON with keys "buy_expr", "sell_expr", "mode". Nothing else.
2. mode = "crossover" if buy+sell are separate events (hold between them). mode = "simple" if just a signal.
3. Each expression must be a single-line pandas boolean Series. No assignments, no def, no loops.
4. Use .shift(1) for previous day. Use .shift(2) for 2 days ago.
5. For "crosses above X": (df['COL'] > X) & (df['COL'].shift(1) <= X)
6. For "crosses below X": (df['COL'] < X) & (df['COL'].shift(1) >= X)
7. For consecutive days: chain with .shift() — e.g. 2 consecutive up days: (df['day_return'] > 0) & (df['day_return'].shift(1) > 0)
8. Always wrap compound expressions in parentheses.

STRATEGY PATTERNS:
"2 consecutive days up 1%":  (df['day_return'].shift(1) >= 1.0) & (df['day_return'].shift(2) >= 1.0)
"2 consecutive days down 1%": (df['day_return'] <= -1.0) & (df['day_return'].shift(1) <= -1.0)
"RSI crosses above 30":  (df['RSI_14'] > 30) & (df['RSI_14'].shift(1) <= 30)
"RSI crosses above 70":  (df['RSI_14'] > 70) & (df['RSI_14'].shift(1) <= 70)
"above all major MAs":   (df['close'] > df['SMA_50']) & (df['close'] > df['SMA_200']) & (df['close'] > df['EMA_20']) & (df['close'] > df['EMA_50'])
"5% weekly fall":        df['week_return'] < -5.0
"3% weekly recovery":    df['week_return'] > 3.0
"MACD bullish cross":    (df['MACD'] > df['MACD_signal']) & (df['MACD'].shift(1) <= df['MACD_signal'].shift(1))
"MACD bearish cross":    (df['MACD'] < df['MACD_signal']) & (df['MACD'].shift(1) >= df['MACD_signal'].shift(1))
"golden cross":          (df['SMA_50'] > df['SMA_200']) & (df['SMA_50'].shift(1) <= df['SMA_200'].shift(1))
"death cross":           (df['SMA_50'] < df['SMA_200']) & (df['SMA_50'].shift(1) >= df['SMA_200'].shift(1))
"volume spike":          df['vol_ratio'] > 2.0
"bollinger breakout":    df['close'] > df['BBU']
"oversold bounce":       (df['RSI_14'] < 30) & (df['RSI_14'].shift(1) < 30)
"buy friday sell monday": buy=(df['date'].dt.weekday == 4), sell=(df['date'].dt.weekday == 0)
"3 green candles":       (df['is_green'] == 1) & (df['is_green'].shift(1) == 1) & (df['is_green'].shift(2) == 1)
"gap up":                df['gap_up'] == True

EXAMPLES:
User: "buy if stock up 1% two days in a row, sell if down 1% two consecutive days"
Output: {"buy_expr": "(df['day_return'].shift(1) >= 1.0) & (df['day_return'].shift(2) >= 1.0)", "sell_expr": "(df['day_return'] <= -1.0) & (df['day_return'].shift(1) <= -1.0)", "mode": "crossover"}

User: "buy RSI crosses 30, sell RSI crosses 70"
Output: {"buy_expr": "(df['RSI_14'] > 30) & (df['RSI_14'].shift(1) <= 30)", "sell_expr": "(df['RSI_14'] > 70) & (df['RSI_14'].shift(1) <= 70)", "mode": "crossover"}

User: "buy after 5% weekly fall sell after 3% recovery"
Output: {"buy_expr": "df['week_return'] < -5.0", "sell_expr": "df['week_return'] > 3.0", "mode": "crossover"}

User: "buy when price above all moving averages"
Output: {"buy_expr": "(df['close'] > df['SMA_50']) & (df['close'] > df['SMA_200']) & (df['close'] > df['EMA_20']) & (df['close'] > df['EMA_50'])", "sell_expr": "(df['close'] < df['SMA_50']) | (df['close'] < df['EMA_20'])", "mode": "crossover"}

User: "MACD golden cross"
Output: {"buy_expr": "(df['MACD'] > df['MACD_signal']) & (df['MACD'].shift(1) <= df['MACD_signal'].shift(1))", "sell_expr": "(df['MACD'] < df['MACD_signal']) & (df['MACD'].shift(1) >= df['MACD_signal'].shift(1))", "mode": "crossover"}

User: "RSI below 30"
Output: {"buy_expr": "df['RSI_14'] < 30", "sell_expr": "df['RSI_14'] > 70", "mode": "simple"}
"""

_NUMBER_WORDS = {
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
    "ten": "10",
}


def _apply_number_words(text: str) -> str:
    for word, value in _NUMBER_WORDS.items():
        text = re.sub(rf"\b{word}\b", value, text)
    return re.sub(r"(\d+(?:\.\d+)?)\s*(?:percent|pct)\b", r"\1%", text)


def _normalise_prompt(user_prompt: str) -> str:
    p = user_prompt.lower()
    replacements = {
        "percnt": "percent",
        "prcnt": "percent",
        "consectue": "consecutive",
        "consective": "consecutive",
        "consecutive dyas": "consecutive days",
        "dya": "day",
        "dyas": "days",
        "purchased": "buy",
        "purchase": "buy",
        "buyed": "buy",
        "sold": "sell",
        "sells": "sell",
        "dip": "down",
        "dipped": "down",
    }
    for src, dst in replacements.items():
        p = p.replace(src, dst)
    p = _apply_number_words(p)
    return re.sub(r"\s+", " ", p).strip()


def _light_norm(text: str) -> str:
    """Lowercase + spell out numbers + normalise percents, WITHOUT the aggressive
    word swaps in ``_normalise_prompt`` (which rewrite "sold"->"sell" and
    "oversold"->"oversell"). Used by the clause parser so indicator words survive."""
    return _apply_number_words(re.sub(r"\s+", " ", text.lower()).strip())


def _consecutive_return_expr(direction: str, pct: float, days: int) -> str:
    op = "<=" if direction == "down" else ">="
    value = -abs(pct) if direction == "down" else abs(pct)
    parts = [f"(df['day_return'].shift({i}) {op} {value})" for i in range(days)]
    return " & ".join(parts)


def _parse_percent_strategy(user_prompt: str) -> dict | None:
    p = _normalise_prompt(user_prompt)

    buy_match = re.search(
        r"(?:buy|bought|entry|enter|purchased|test if i buy|test if i)\D{0,35}?(\d+(?:\.\d+)?)%\s*(down|up)",
        p,
    ) or re.search(r"(\d+(?:\.\d+)?)%\s*(down|up)\D{0,35}?(?:buy|entry|enter)", p)
    sell_match = re.search(
        r"(?:sell|exit|sold)\D{0,35}?(\d+(?:\.\d+)?)%\s*(up|down)",
        p,
    ) or re.search(r"then\D{0,25}?(\d+(?:\.\d+)?)%\s*(up|down)", p)

    if not buy_match and re.search(r"\bdown\b.*\bthen\b.*\bup\b", p):
        nums = re.findall(r"(\d+(?:\.\d+)?)%\s*(down|up)", p)
        if len(nums) >= 2:
            buy_match = type("_M", (), {"group": lambda self, i: nums[0][i - 1]})()
            sell_match = type("_M", (), {"group": lambda self, i: nums[1][i - 1]})()

    if not buy_match:
        return None

    buy_pct = float(buy_match.group(1))
    buy_direction = buy_match.group(2)
    sell_pct = float(sell_match.group(1)) if sell_match else buy_pct
    sell_direction = sell_match.group(2) if sell_match else ("up" if buy_direction == "down" else "down")

    buy_days = 1
    sell_days = 1
    has_sell_consecutive = bool(re.search(r"(?:next|then|sell|exit).{0,45}?\b\d+\s*consecutive\s*(?:days?|sessions?)\b", p))
    wants_target_exit = bool(sell_match and re.search(r"\b(?:sell|exit|sold)\b", p) and not has_sell_consecutive)

    if re.search(r"\b2\s*(?:consecutive\s*)?(?:days?|sessions?)\b.*\bthen\b", p) or "2 consecutive" in p:
        buy_days = 2
    sell_days_match = re.search(r"(?:next|then|sell|exit).{0,45}?\b(\d+)\s*consecutive\s*(?:days?|sessions?)\b", p)
    if sell_days_match:
        sell_days = max(1, int(sell_days_match.group(1)))
    elif "2 consecutive" in p and "then" in p:
        sell_days = 2

    if wants_target_exit:
        return {
            "buy_expr": _consecutive_return_expr(buy_direction, buy_pct, buy_days),
            "sell_expr": f"target {sell_direction} {sell_pct}%",
            "mode": "target_exit",
            "target_pct": sell_pct,
            "target_direction": sell_direction,
        }

    return {
        "buy_expr": _consecutive_return_expr(buy_direction, buy_pct, buy_days),
        "sell_expr": _consecutive_return_expr(sell_direction, sell_pct, sell_days),
        "mode": "crossover",
    }


def _parse_lookback_days(user_prompt: str) -> int | None:
    p = _normalise_prompt(user_prompt)
    match = re.search(r"\b(?:past|last|previous)\s*(\d+)\s*(?:trading\s*)?(?:days?|sessions?)\b", p)
    if not match:
        return None
    days = int(match.group(1))
    return days if days > 0 else None


# ── Clause-level natural-language strategy parsing ───────────────────────────
# The canned RULE_PATTERNS table below matches a whole strategy by its BUY phrase
# and substitutes a FIXED exit. That silently discarded an explicit, different exit
# the user actually typed — e.g. "buy when RSI crosses above 30, sell when price
# falls below the 20-day support" was backtested as "sell when RSI crosses 70".
# The clause parser fixes that: it splits the request into its buy and sell halves
# and translates each half on its own, so the rule we backtest is the rule asked for.
_SELL_SPLIT_RE = re.compile(r"\b(?:and\s+)?(?:then\s+)?(?:sell|sold|exit|book|square\s*off|squareoff|close\s+position)\b")
_KNOWN_SMA = {5, 10, 20, 50, 200}
_KNOWN_EMA = {9, 20, 50}


def _ma_col(kind: str, period: int) -> str:
    kind = "EMA" if kind.lower().startswith("e") else "SMA"
    known = _KNOWN_EMA if kind == "EMA" else _KNOWN_SMA
    if period in known:
        return f"df['{kind}_{period}']"
    if kind == "EMA":
        return f"df['close'].ewm(span={period}, adjust=False).mean()"
    return f"df['close'].rolling({period}).mean()"


def _split_strategy_clauses(prompt: str) -> tuple[str, str | None]:
    p = _light_norm(prompt)
    parts = _SELL_SPLIT_RE.split(p, maxsplit=1)
    buy_part = parts[0]
    sell_part = parts[1] if len(parts) > 1 else None
    # Drop everything up to and including the entry verb so the buy clause is just
    # the condition (e.g. "backtest: buy net when rsi..." -> "rsi...").
    buy_part = re.sub(r"^.*?\b(?:buy|bought|enter|entry|go\s+long|long)\b", "", buy_part, count=1)
    return buy_part.strip(" ,.:;-"), (sell_part.strip(" ,.:;-") if sell_part else None)


def _clause_to_expr(clause: str | None, default_indicator: str | None = None) -> str | None:
    """Translate ONE buy- or sell-side condition into a pandas boolean expression.
    Returns None when the clause isn't confidently understood (caller then defers
    to the LLM translator rather than fabricating a rule).

    ``default_indicator`` lets a bare follow-on clause ("...sell when IT crosses 70")
    inherit the indicator named on the other side of the rule (here, RSI)."""
    if not clause:
        return None
    c = clause.lower()
    # Drop indicator period qualifiers so "rsi(14)", "rsi 14", "macd(12,26,9)" don't
    # wedge a stray number between the indicator name and its condition.
    c = re.sub(r"\(\s*\d+(?:\s*,\s*\d+)*\s*\)", "", c)
    c = re.sub(r"\b(rsi|sma|ema|macd|stoch|atr|adx|cci|wr|williams_r)\s*-?\s*\d{1,3}\b(?=\s*(?:cross|above|below|over|under|>|<|reaches?|hits?))", r"\1", c)

    # RSI crosses above/below a level.
    m = re.search(r"rsi[^\d]*?cross\w*\s*(above|over|up|below|under|down)?[^\d]*?(\d+(?:\.\d+)?)", c)
    if m:
        direction = m.group(1) or "above"
        n = float(m.group(2))
        if direction in ("below", "under", "down"):
            return f"(df['RSI_14'] < {n}) & (df['RSI_14'].shift(1) >= {n})"
        return f"(df['RSI_14'] > {n}) & (df['RSI_14'].shift(1) <= {n})"

    # RSI above/below a level (no crossing).
    m = re.search(r"rsi[^\d]*?(above|over|greater than|>|below|under|less than|<)[^\d]*?(\d+(?:\.\d+)?)", c)
    if m:
        op = m.group(1)
        n = float(m.group(2))
        if op in ("below", "under", "less than", "<"):
            return f"df['RSI_14'] < {n}"
        return f"df['RSI_14'] > {n}"
    if re.search(r"oversold", c):
        return "df['RSI_14'] < 30"
    if re.search(r"overbought", c):
        return "df['RSI_14'] > 70"

    down_words = r"\b(fall|falls|fell|drop|drops|break|breaks|broke|below|under|breakdown|loses|lose)\b"
    up_words = r"\b(rise|rises|rose|break|breaks|broke|above|over|breakout|cross|crosses|reclaim)\b"

    # N-day support / resistance (or N-day low / high).
    m = re.search(r"(\d+)\s*[- ]?days?[^.]*?(support|low)", c)
    if m and re.search(down_words, c):
        n = int(m.group(1))
        return f"df['close'] < df['low'].rolling({n}).min().shift(1)"
    m = re.search(r"(\d+)\s*[- ]?days?[^.]*?(resistance|high)", c)
    if m and re.search(up_words, c):
        n = int(m.group(1))
        return f"df['close'] > df['high'].rolling({n}).max().shift(1)"
    # Support / resistance without an explicit period -> default to 20 sessions.
    if re.search(r"\bsupport\b", c) and re.search(down_words, c):
        return "df['close'] < df['low'].rolling(20).min().shift(1)"
    if re.search(r"\bresistance\b", c) and re.search(up_words, c):
        return "df['close'] > df['high'].rolling(20).max().shift(1)"

    # Price relative to a moving average. Two phrasings: "N-day moving average"
    # (period only) or "sma/ema N" (kind + period).
    kind = period = None
    m = re.search(r"\b(sma|ema)\s*-?\s*(\d+)\b", c)
    if m:
        kind, period = m.group(1), int(m.group(2))
    else:
        m = re.search(r"(\d+)\s*[- ]?day\s*(?:simple |exponential )?(?:moving average|ma)\b", c)
        if m:
            period = int(m.group(1))
            kind = "ema" if "exponential" in c else "sma"
    if period is not None:
        col = _ma_col(kind or "sma", period)
        if re.search(r"\b(below|under|falls?|fell|drops?|breakdown)\b", c):
            return f"df['close'] < {col}"
        if re.search(r"\b(above|over|rises?|rose|reclaim|crosses?|breakout)\b", c):
            return f"df['close'] > {col}"

    # MACD signal cross.
    if "macd" in c:
        if re.search(r"(bear|below|down|negative)", c):
            return "(df['MACD'] < df['MACD_signal']) & (df['MACD'].shift(1) >= df['MACD_signal'].shift(1))"
        return "(df['MACD'] > df['MACD_signal']) & (df['MACD'].shift(1) <= df['MACD_signal'].shift(1))"

    if "golden cross" in c:
        return "(df['SMA_50'] > df['SMA_200']) & (df['SMA_50'].shift(1) <= df['SMA_200'].shift(1))"
    if "death cross" in c:
        return "(df['SMA_50'] < df['SMA_200']) & (df['SMA_50'].shift(1) >= df['SMA_200'].shift(1))"

    if re.search(r"gap\s*up", c):
        return "df['gap_up'] == True"
    if re.search(r"gap\s*down", c):
        return "df['gap_down'] == True"

    if re.search(r"(volume\s*spike|spike\s*in\s*volume|vol\w*\s*2x|volume surge|high volume)", c):
        return "df['vol_ratio'] > 2.0"

    if "bollinger" in c:
        if re.search(r"(below|lower)", c):
            return "df['close'] < df['BBL']"
        return "df['close'] > df['BBU']"

    # Single-period % move, only when a day/week/month qualifier is explicit (so we
    # don't hijack the more careful percent/consecutive parser for ambiguous wording).
    m = re.search(r"(up|down|rise|rises|gain|gains|fall|falls|drop|drops)\s*(?:by\s*)?(\d+(?:\.\d+)?)%", c) or re.search(
        r"(\d+(?:\.\d+)?)%\s*(up|down|rise|gain|fall|drop)", c
    )
    if m:
        a, b = m.group(1), m.group(2)
        if a.replace(".", "", 1).isdigit():
            value, word = float(a), b
        else:
            word, value = a, float(b)
        up = word in ("up", "rise", "rises", "gain", "gains")
        if re.search(r"week", c):
            colname = "week_return"
        elif re.search(r"month", c):
            colname = "month_return"
        elif re.search(r"\b(day|today|session|daily|intraday)\b", c):
            colname = "day_return"
        else:
            colname = None
        if colname:
            return f"df['{colname}'] > {value}" if up else f"df['{colname}'] < {-value}"

    # Bare level/cross with no named indicator — only when the other clause told us
    # which indicator "it" refers to (e.g. buy used RSI -> "sell when it crosses 70").
    if default_indicator:
        m = re.search(r"cross\w*\s*(above|over|up|below|under|down)?[^\d]*?(\d+(?:\.\d+)?)", c)
        if m:
            d = m.group(1) or "above"
            n = float(m.group(2))
            if d in ("below", "under", "down"):
                return f"({default_indicator} < {n}) & ({default_indicator}.shift(1) >= {n})"
            return f"({default_indicator} > {n}) & ({default_indicator}.shift(1) <= {n})"
        m = re.search(r"\b(above|over|greater than|>|below|under|less than|<)\b[^\d]*?(\d+(?:\.\d+)?)", c)
        if m:
            op = m.group(1)
            n = float(m.group(2))
            if op in ("below", "under", "less than", "<"):
                return f"{default_indicator} < {n}"
            return f"{default_indicator} > {n}"

    return None


_STOP_LOSS_RE = re.compile(
    r"(?:stop[\s-]?loss|stop|sl|trailing\s+stop)\D{0,25}?(\d+(?:\.\d+)?)\s*%"
    r"|(\d+(?:\.\d+)?)\s*%\D{0,25}?(?:stop[\s-]?loss|trailing\s+stop|below\s+(?:the\s+)?(?:purchase|buy|entry|cost))"
)
# Only match a % that the take-profit keyword introduces (keyword then number).
# The reverse "N% then keyword" form is avoided: with "...stop 8%, take profit 20%"
# it would wrongly grab the stop's 8%.
_TAKE_PROFIT_RE = re.compile(
    r"(?:take[\s-]?profit|profit\s+target|profit\s+booking|tp)\D{0,15}?(\d+(?:\.\d+)?)\s*%"
)


def _parse_stop_loss_strategy(user_prompt: str) -> dict | None:
    """A buy signal protected by a stop-loss (the "safety net" people ask for).
    Exit is the stop — not a canned RSI level. Supports a trailing stop and an
    optional take-profit. Returns None when no stop-loss is described."""
    p = _light_norm(user_prompt)
    sl = _STOP_LOSS_RE.search(p)
    if not sl:
        return None
    stop_pct = float(sl.group(1) or sl.group(2))
    trailing = bool(re.search(r"trailing", p))
    tp_match = _TAKE_PROFIT_RE.search(p)
    take_profit_pct = float(tp_match.group(1)) if tp_match else None

    # The entry condition is whatever precedes the stop-loss / risk wording.
    buy_part, _ = _split_strategy_clauses(user_prompt)
    buy_part = re.split(
        r"\b(?:stop[\s-]?loss|stop|trailing|take[\s-]?profit|profit\s+target|safety\s+net|with\s+a|with)\b",
        buy_part,
        maxsplit=1,
    )[0]
    buy_expr = _clause_to_expr(buy_part)
    if not buy_expr:
        return None

    label = f"{'trailing ' if trailing else ''}stop-loss {stop_pct:g}% below {'the peak' if trailing else 'entry'}"
    if take_profit_pct:
        label += f", or take-profit at {take_profit_pct:g}%"
    return {
        "buy_expr": buy_expr,
        "sell_expr": label,
        "mode": "stop_loss",
        "stop_pct": stop_pct,
        "trailing": trailing,
        "take_profit_pct": take_profit_pct,
    }


def _parse_compound_strategy(user_prompt: str) -> dict | None:
    """Honour an explicit two-sided rule by translating the buy and sell halves
    independently. Returns None (so specialised parsers / the LLM take over) for
    consecutive-day and profit-target wording, or when either half is unclear."""
    p = _light_norm(user_prompt)
    if re.search(r"consecutive|in a row|profit target|target of|book\s+profit", p):
        return None
    buy_part, sell_part = _split_strategy_clauses(user_prompt)
    buy_expr = _clause_to_expr(buy_part)
    if not buy_expr:
        return None
    default_ind = "df['RSI_14']" if "RSI_14" in buy_expr else None
    sell_expr = _clause_to_expr(sell_part, default_ind) if sell_part else None
    if not sell_expr:
        # Entry understood but exit isn't (or wasn't given) — don't fabricate one.
        return None
    return {"buy_expr": buy_expr, "sell_expr": sell_expr, "mode": "crossover"}


def translate_strategy(user_prompt: str) -> dict:
    # Groq retired llama-3.3-70b-versatile; use the current default model.
    completion = get_client().chat.completions.create(
        model=os.getenv("GROQ_CHAT_MODEL", DEFAULT_GROQ_CHAT_MODEL),
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": user_prompt}
        ],
        temperature=0.0,
        max_tokens=1600,
        extra_body={"reasoning_effort": "low"},
    )
    raw = completion.choices[0].message.content.strip()
    raw = re.sub(r"```[\w]*", "", raw).replace("```", "").strip()

    # Extract JSON
    try:
        # Try direct parse
        return json.loads(raw)
    except Exception:
        # Try to find JSON object in response
        m = re.search(r'\{[^}]+\}', raw, re.DOTALL)
        if m:
            try:
                return json.loads(m.group())
            except Exception:
                pass
        # Manual extract
        buy  = re.search(r'"buy_expr"\s*:\s*"([^"]+)"',  raw)
        sell = re.search(r'"sell_expr"\s*:\s*"([^"]+)"', raw)
        mode = "crossover" if "crossover" in raw else "simple"
        return {
            "buy_expr":  buy.group(1)  if buy  else "df['RSI_14'] < 35",
            "sell_expr": sell.group(1) if sell else "df['RSI_14'] > 65",
            "mode":      mode
        }


# ── Step 3: Rule engine fallback (no LLM needed) ─────────────────────────────
RULE_PATTERNS = [
    # (regex pattern, buy_expr, sell_expr, mode)
    (r'rsi.*cross.*30|cross.*rsi.*30|rsi.*above.*30',
     "(df['RSI_14'] > 30) & (df['RSI_14'].shift(1) <= 30)",
     "(df['RSI_14'] > 70) & (df['RSI_14'].shift(1) <= 70)",
     "crossover"),
    (r'rsi.*below.*30|oversold',
     "df['RSI_14'] < 30",
     "df['RSI_14'] > 70",
     "crossover"),
    (r'rsi.*above.*70|overbought',
     "df['RSI_14'] > 70",
     "df['RSI_14'] < 30",
     "simple"),
    (r'golden cross|sma.*50.*cross.*200|50.*cross.*200',
     "(df['SMA_50'] > df['SMA_200']) & (df['SMA_50'].shift(1) <= df['SMA_200'].shift(1))",
     "(df['SMA_50'] < df['SMA_200']) & (df['SMA_50'].shift(1) >= df['SMA_200'].shift(1))",
     "crossover"),
    (r'death cross',
     "(df['SMA_50'] < df['SMA_200']) & (df['SMA_50'].shift(1) >= df['SMA_200'].shift(1))",
     "(df['SMA_50'] > df['SMA_200']) & (df['SMA_50'].shift(1) <= df['SMA_200'].shift(1))",
     "crossover"),
    (r'macd.*bull|macd.*cross.*signal|macd.*golden',
     "(df['MACD'] > df['MACD_signal']) & (df['MACD'].shift(1) <= df['MACD_signal'].shift(1))",
     "(df['MACD'] < df['MACD_signal']) & (df['MACD'].shift(1) >= df['MACD_signal'].shift(1))",
     "crossover"),
    (r'1%.*two.*day|two.*day.*1%|two.*consecutive.*up|up.*two.*day|two prev.*day.*1',
     "(df['day_return'].shift(1) >= 1.0) & (df['day_return'].shift(2) >= 1.0)",
     "(df['day_return'] <= -1.0) & (df['day_return'].shift(1) <= -1.0)",
     "crossover"),
    (r'5%.*week.*fall|week.*fall.*5%|week.*drop.*5',
     "df['week_return'] < -5.0",
     "df['week_return'] > 3.0",
     "crossover"),
    (r'above.*all.*ma|above.*all.*moving|price.*above.*all',
     "(df['close'] > df['SMA_50']) & (df['close'] > df['SMA_200']) & (df['close'] > df['EMA_20']) & (df['close'] > df['EMA_50'])",
     "(df['close'] < df['SMA_50']) | (df['close'] < df['EMA_20'])",
     "crossover"),
    (r'bollinger.*break|break.*bollinger|bb.*break',
     "df['close'] > df['BBU']",
     "df['close'] < df['BBM']",
     "crossover"),
    (r'volume.*spike|spike.*volume|vol.*2x',
     "df['vol_ratio'] > 2.0",
     "df['vol_ratio'] < 0.8",
     "simple"),
    (r'3.*green.*candle|three.*green|3.*consecutive.*green',
     "(df['is_green'] == 1) & (df['is_green'].shift(1) == 1) & (df['is_green'].shift(2) == 1)",
     "(df['is_red'] == 1) & (df['is_red'].shift(1) == 1)",
     "crossover"),
    (r'gap up|gap.*up|opening.*higher',
     "df['gap_up'] == True",
     "(df['close'] < df['prev_close'])",
     "simple"),
    (r'friday|buy.*friday',
     "df['date'].dt.weekday == 4",
     "df['date'].dt.weekday == 0",
     "crossover"),
]

def _rule_engine_fallback(user_prompt: str) -> dict | None:
    # A stop-loss / trailing-stop ("safety net") is a real exit — honour it before
    # the canned table below substitutes an RSI exit the user never asked for.
    stop_loss = _parse_stop_loss_strategy(user_prompt)
    if stop_loss:
        return stop_loss

    # An explicit two-sided rule wins next, so the exit the user typed is the exit
    # we actually backtest (not a canned one from the pattern table below).
    compound = _parse_compound_strategy(user_prompt)
    if compound:
        return compound

    percent_strategy = _parse_percent_strategy(user_prompt)
    if percent_strategy:
        return percent_strategy

    p = _normalise_prompt(user_prompt)
    for pattern, buy_expr, sell_expr, mode in RULE_PATTERNS:
        if re.search(pattern, p):
            return {"buy_expr": buy_expr, "sell_expr": sell_expr, "mode": mode}
    return None


# ── Step 4: Simulation engines ────────────────────────────────────────────────
def _eval_safe(expr: str, df: pd.DataFrame) -> pd.Series:
    """Evaluate an LLM-authored pandas boolean expression, allowlist-checked.

    `expr` originates from a model prompted with untrusted user text, so it is
    validated against app.strategies.expression_guard before evaluation. Note
    that emptying __builtins__ alone would NOT be safe: `pd`/`np` in scope
    expose `read_pickle`/`load`, which execute arbitrary code on deserialisation.
    The guard removes any path to those names, and `pd`/`np` are no longer
    exposed to the expression at all.
    """
    tree = validate_expression(expr)
    code = compile(tree, filename="<strategy-expression>", mode="eval")
    result = eval(code, {"__builtins__": {}}, {"df": df})  # noqa: S307 - guarded above
    if not isinstance(result, pd.Series):
        raise ExpressionValidationError("expression must produce a column of true/false values")
    return result.fillna(False).astype(bool)


def _rsi_at(df, i):
    if "RSI_14" not in df.columns:
        return None
    value = df["RSI_14"].iat[i]
    return round(float(value), 1) if not pd.isna(value) else None


def _entry_price(opens, closes, i):
    return float(opens[i]) if not np.isnan(opens[i]) else float(closes[i])


def _run_crossover(df, buy_expr, sell_expr):
    # Walk plain numpy arrays and touch the DataFrame only when a trade opens
    # or closes. Building a pandas row for every day (df.iloc[i]) made this the
    # slowest part of a market-wide scan.
    buy_sig = _eval_safe(buy_expr, df).to_numpy()
    sell_sig = _eval_safe(sell_expr, df).to_numpy()
    opens = df["open"].to_numpy(dtype=float)
    closes = df["close"].to_numpy(dtype=float)
    dates = df["date"]

    trades = []
    in_trade = False
    buy_date = buy_price = buy_rsi = None

    for i in range(2, len(df)):
        if not in_trade and buy_sig[i]:
            buy_date = dates.iat[i]
            buy_price = _entry_price(opens, closes, i)
            buy_rsi = _rsi_at(df, i)
            in_trade = True
        elif in_trade and sell_sig[i]:
            sell_date = dates.iat[i]
            sell_price = _entry_price(opens, closes, i)
            pnl_pct = (sell_price - buy_price) / buy_price * 100
            trades.append({
                "buy_date":      str(buy_date.date()),
                "buy_day":       _weekday_name(buy_date),
                "buy_price":     round(buy_price, 2),
                "buy_rsi":       buy_rsi,
                "sell_date":     str(sell_date.date()),
                "sell_day":      _weekday_name(sell_date),
                "sell_price":    round(sell_price, 2),
                "sell_rsi":      _rsi_at(df, i),
                "holding_days":  (sell_date - buy_date).days,
                "pnl_per_share": round(sell_price - buy_price, 2),
                "pnl_100shares": round((sell_price - buy_price) * 100, 2),
                "return_pct":    round(pnl_pct, 2),
                "result":        "WIN" if pnl_pct > 0 else "LOSS"
            })
            in_trade = False

    open_trade = None
    if in_trade:
        last_date = dates.iat[-1]
        cur = float(closes[-1])
        open_trade = {
            "buy_date":       str(buy_date.date()),
            "buy_day":        _weekday_name(buy_date),
            "buy_price":      round(buy_price, 2),
            "current_price":  round(cur, 2),
            "current_rsi":    _rsi_at(df, len(df) - 1),
            "holding_days":   (last_date - buy_date).days,
            "unrealised_pnl": round((cur - buy_price) * 100, 2),
            "return_pct":     round((cur - buy_price) / buy_price * 100, 2)
        }
    return trades, open_trade


def _weekday_name(value) -> str:
    return pd.to_datetime(value).day_name()


def _run_target_exit(df, buy_expr, target_pct, target_direction):
    buy_sig = _eval_safe(buy_expr, df).to_numpy()
    target_pct = abs(float(target_pct))
    target_direction = "down" if target_direction == "down" else "up"
    highs = df["high"].to_numpy(dtype=float)
    lows = df["low"].to_numpy(dtype=float)
    closes = df["close"].to_numpy(dtype=float)
    dates = df["date"]
    n = len(df)

    trades = []
    open_trade = None
    i = 2
    while i < n - 1:
        if not buy_sig[i]:
            i += 1
            continue

        buy_date = dates.iat[i]
        buy_price = float(closes[i])
        target_price = buy_price * (1 + target_pct / 100) if target_direction == "up" else buy_price * (1 - target_pct / 100)
        # First later bar that touches the target, found in one vector op.
        later = highs[i + 1:] >= target_price if target_direction == "up" else lows[i + 1:] <= target_price
        hits = np.flatnonzero(later)

        if hits.size:
            j = i + 1 + int(hits[0])
            sell_date = dates.iat[j]
            sell_price = target_price
            pnl_pct = (sell_price - buy_price) / buy_price * 100
            trades.append({
                "buy_date": str(buy_date.date()),
                "buy_day": _weekday_name(buy_date),
                "buy_price": round(buy_price, 2),
                "buy_rsi": _rsi_at(df, i),
                "sell_date": str(sell_date.date()),
                "sell_day": _weekday_name(sell_date),
                "sell_price": round(sell_price, 2),
                "sell_rsi": _rsi_at(df, j),
                "holding_days": (sell_date - buy_date).days,
                "pnl_per_share": round(sell_price - buy_price, 2),
                "pnl_100shares": round((sell_price - buy_price) * 100, 2),
                "return_pct": round(pnl_pct, 2),
                "result": "WIN" if pnl_pct > 0 else "LOSS",
                "entry_reason": "Buy signal triggered",
                "exit_reason": f"{target_pct:g}% {'profit target' if target_direction == 'up' else 'downside target'} touched",
            })
            i = j + 1
            continue

        cur = float(closes[-1])
        open_trade = {
            "buy_date": str(buy_date.date()),
            "buy_day": _weekday_name(buy_date),
            "buy_price": round(buy_price, 2),
            "target_price": round(target_price, 2),
            "current_price": round(cur, 2),
            "current_rsi": _rsi_at(df, n - 1),
            "holding_days": (dates.iat[-1] - buy_date).days,
            "unrealised_pnl": round((cur - buy_price) * 100, 2),
            "return_pct": round((cur - buy_price) / buy_price * 100, 2),
            "exit_reason": f"Still open; {target_pct:g}% target not touched yet",
        }
        break

    return trades, open_trade


def _run_stop_loss(df, buy_expr, stop_pct, trailing=False, take_profit_pct=None):
    """Enter on the buy signal, then ride the position until a stop-loss (fixed or
    trailing) — or an optional take-profit — is touched. This is the "buy and ride
    the recovery with a safety net" pattern, simulated literally."""
    buy_sig = _eval_safe(buy_expr, df).to_numpy()
    stop_pct = abs(float(stop_pct))
    tp = abs(float(take_profit_pct)) if take_profit_pct else None
    highs = df["high"].to_numpy(dtype=float)
    lows = df["low"].to_numpy(dtype=float)
    closes = df["close"].to_numpy(dtype=float)
    dates = df["date"]
    n = len(df)

    trades = []
    open_trade = None
    i = 2
    while i < n - 1:
        if not buy_sig[i]:
            i += 1
            continue

        buy_date = dates.iat[i]
        buy_price = float(closes[i])
        later_highs = highs[i + 1:]
        later_lows = lows[i + 1:]
        # The trailing peak includes the same bar's high before its low is
        # checked, exactly as the bar-by-bar version did.
        peaks = np.fmax(buy_price, np.fmax.accumulate(later_highs)) if trailing else np.full(later_highs.shape, buy_price)
        stops = peaks * (1 - stop_pct / 100)
        tp_level = buy_price * (1 + tp / 100) if tp else None
        hit_stop = later_lows <= stops
        hit_tp = later_highs >= tp_level if tp_level is not None else np.zeros(later_highs.shape, dtype=bool)
        hits = np.flatnonzero(hit_stop | hit_tp)

        if hits.size:
            k = int(hits[0])
            j = i + 1 + k
            # If both are touched in the same candle, assume the stop hit first
            # (conservative — we cannot see intrabar order).
            if hit_stop[k]:
                sell_price = float(stops[k])
                exit_reason = f"{stop_pct:g}% {'trailing ' if trailing else ''}stop-loss hit"
            else:
                sell_price = tp_level
                exit_reason = f"{tp:g}% take-profit hit"
            sell_date = dates.iat[j]
            pnl_pct = (sell_price - buy_price) / buy_price * 100
            trades.append({
                "buy_date": str(buy_date.date()),
                "buy_day": _weekday_name(buy_date),
                "buy_price": round(buy_price, 2),
                "buy_rsi": _rsi_at(df, i),
                "sell_date": str(sell_date.date()),
                "sell_day": _weekday_name(sell_date),
                "sell_price": round(sell_price, 2),
                "sell_rsi": _rsi_at(df, j),
                "holding_days": (sell_date - buy_date).days,
                "pnl_per_share": round(sell_price - buy_price, 2),
                "pnl_100shares": round((sell_price - buy_price) * 100, 2),
                "return_pct": round(pnl_pct, 2),
                "result": "WIN" if pnl_pct > 0 else "LOSS",
                "entry_reason": "Buy signal triggered",
                "exit_reason": exit_reason,
            })
            i = j + 1
            continue

        peak = float(peaks[-1]) if trailing and peaks.size else buy_price
        cur = float(closes[-1])
        open_trade = {
            "buy_date": str(buy_date.date()),
            "buy_day": _weekday_name(buy_date),
            "buy_price": round(buy_price, 2),
            "stop_price": round((peak if trailing else buy_price) * (1 - stop_pct / 100), 2),
            "current_price": round(cur, 2),
            "current_rsi": _rsi_at(df, n - 1),
            "holding_days": (dates.iat[-1] - buy_date).days,
            "unrealised_pnl": round((cur - buy_price) * 100, 2),
            "return_pct": round((cur - buy_price) / buy_price * 100, 2),
            "exit_reason": f"Still open; {stop_pct:g}% {'trailing ' if trailing else ''}stop not hit yet",
        }
        break

    return trades, open_trade


def _run_simple(df, buy_expr):
    buy_sig = _eval_safe(buy_expr, df)
    df = df.copy()
    df['_fwd'] = df['close'].pct_change().shift(-1) * 100

    trades = []
    for i in df[buy_sig].index:
        if i + 1 >= len(df): continue
        row  = df.iloc[i]
        nrow = df.iloc[i + 1]
        pnl  = (float(nrow['close']) - float(row['close'])) / float(row['close']) * 100
        rsi  = round(float(row.get('RSI_14', np.nan)), 1) if not pd.isna(row.get('RSI_14', np.nan)) else None
        trades.append({
            "buy_date":      str(row['date'].date()),
            "buy_day":       _weekday_name(row['date']),
            "buy_price":     round(float(row['close']), 2),
            "buy_rsi":       rsi,
            "sell_date":     str(nrow['date'].date()),
            "sell_day":      _weekday_name(nrow['date']),
            "sell_price":    round(float(nrow['close']), 2),
            "sell_rsi":      None,
            "holding_days":  1,
            "pnl_per_share": round(float(nrow['close']) - float(row['close']), 2),
            "pnl_100shares": round((float(nrow['close']) - float(row['close'])) * 100, 2),
            "return_pct":    round(pnl, 2),
            "result":        "WIN" if pnl > 0 else "LOSS"
        })
    return trades, None


# ── Step 5: Summary stats ─────────────────────────────────────────────────────
def _summary(trades):
    if not trades:
        return None
    td      = pd.DataFrame(trades)
    total   = len(td)
    wins    = int((td['return_pct'] > 0).sum())
    losses  = total - wins
    returns = td['return_pct'] / 100
    cum     = (1 + returns).cumprod()
    peak    = cum.cummax()
    dd      = ((cum - peak) / peak * 100).min()

    avg_win  = round(td[td['result']=='WIN']['return_pct'].mean(),  2) if wins   else 0.0
    avg_loss = round(td[td['result']=='LOSS']['return_pct'].mean(), 2) if losses else 0.0
    rr       = round(abs(avg_win / avg_loss), 2) if avg_loss != 0 else 0.0

    win_pnl  = td[td['result']=='WIN']['pnl_100shares'].sum()
    loss_pnl = abs(td[td['result']=='LOSS']['pnl_100shares'].sum())
    pf       = round(win_pnl / loss_pnl, 2) if loss_pnl > 0 else 999.0

    return {
        "total_trades":             total,
        "wins":                     wins,
        "losses":                   losses,
        "win_rate":                 round(wins / total * 100, 2),
        "total_pnl_100shares":      round(td['pnl_100shares'].sum(), 2),
        "avg_pnl_per_trade":        round(td['pnl_100shares'].mean(), 2),
        "avg_return_per_trade_pct": round(td['return_pct'].mean(), 2),
        "total_return_pct":         round(((1 + returns).prod() - 1) * 100, 2),
        "best_trade_pct":           round(td['return_pct'].max(), 2),
        "worst_trade_pct":          round(td['return_pct'].min(), 2),
        "avg_win_pct":              avg_win,
        "avg_loss_pct":             avg_loss,
        "risk_reward_ratio":        rr,
        "avg_holding_days":         round(td['holding_days'].mean(), 1),
        "max_drawdown_pct":         round(dd, 2),
        "profit_factor":            pf,
    }


# ── Step 6: Main entry ────────────────────────────────────────────────────────
def _build_analysis_text(user_prompt, summary, trades, open_trade, lookback_days, mode):
    scope = f"last {lookback_days} loaded trading rows" if lookback_days else "loaded price history"
    if not summary:
        if open_trade:
            return (
                f"One entry is still open over the {scope}. The exit condition has not been reached yet, "
                f"so it is not counted as a closed win or loss."
            )
        return (
            f"No closed trades matched this strategy over the {scope}. The entry rule, exit rule, or lookback "
            f"window may be too strict for this stock's candles."
        )

    best = max(trades, key=lambda t: t["return_pct"]) if trades else None
    worst = min(trades, key=lambda t: t["return_pct"]) if trades else None
    detail = (
        f"Tested over the {scope}. The strategy produced {summary['total_trades']} closed trades, "
        f"with {summary['wins']} wins and {summary['losses']} losses. Win rate was {summary['win_rate']}%, "
        f"average return per trade was {summary['avg_return_per_trade_pct']}%, and total compounded return was "
        f"{summary['total_return_pct']}%."
    )
    if best and worst:
        detail += (
            f" Best trade was {best['return_pct']}% from {best['buy_date']} to {best['sell_date']}; "
            f"worst trade was {worst['return_pct']}% from {worst['buy_date']} to {worst['sell_date']}."
        )
    if mode == "target_exit":
        detail += " Exit prices are recorded at the requested percentage target once the candle high/low touches that level."
    return detail


def run_custom_backtest(df: pd.DataFrame, user_prompt: str):
    try:
        df = _prepare_df(df)
        lookback_days = _parse_lookback_days(user_prompt)
        if lookback_days:
            df = df.tail(lookback_days + 5).reset_index(drop=True)

        # Detect indicator for chart
        p = _normalise_prompt(user_prompt)
        indicator_col = (
            'RSI_14'      if 'rsi'     in p else
            'MACD'        if 'macd'    in p else
            'MACD_hist'   if 'hist'    in p else
            'SMA_50'      if 'sma'     in p or 'golden' in p or 'death' in p else
            'BB_width'    if 'bolling' in p else
            'vol_ratio'   if 'volume'  in p else
            'day_return'  if 'day'     in p or 'return' in p else
            'week_return' if 'week'    in p else
            None
        )

        # Try rule engine first (instant, no API)
        strategy = _rule_engine_fallback(user_prompt)

        # Fall back to LLM if no rule matched
        if not strategy:
            strategy = translate_strategy(user_prompt)

        buy_expr  = strategy.get("buy_expr", "")
        sell_expr = strategy.get("sell_expr", "")
        mode      = strategy.get("mode", "crossover")
        target_pct = strategy.get("target_pct")
        target_direction = strategy.get("target_direction", "up")

        print(f"[Backtest] buy_expr:  {buy_expr}")
        print(f"[Backtest] sell_expr: {sell_expr}")
        print(f"[Backtest] mode:      {mode}")

        # Run simulation
        try:
            if mode == "stop_loss":
                trades, open_trade = _run_stop_loss(
                    df, buy_expr, strategy.get("stop_pct") or 10,
                    strategy.get("trailing", False), strategy.get("take_profit_pct"),
                )
            elif mode == "target_exit":
                trades, open_trade = _run_target_exit(df, buy_expr, target_pct or 0, target_direction)
            elif mode == "crossover":
                trades, open_trade = _run_crossover(df, buy_expr, sell_expr)
            else:
                trades, open_trade = _run_simple(df, buy_expr)
        except Exception as e:
            print(f"[Backtest] Simulation failed: {e}, trying simple mode")
            trades, open_trade = _run_simple(df, buy_expr)

        # If still no trades, try flipping to simple mode
        if not trades and not open_trade and mode == "crossover":
            print("[Backtest] No crossover trades, falling back to simple mode")
            try:
                trades, open_trade = _run_simple(df, buy_expr)
            except Exception:
                pass

        summary = _summary(trades)

        # Current signal. For stop_loss / target_exit the "sell" is a price level,
        # not a boolean expression — only the buy side is a Series there.
        try:
            bs = _eval_safe(buy_expr, df)
            if mode in ("stop_loss", "target_exit"):
                current_signal = "BUY" if bool(bs.iloc[-1]) else "HOLD"
            else:
                ss = _eval_safe(sell_expr, df)
                current_signal = "BUY" if bool(bs.iloc[-1]) else "SELL" if bool(ss.iloc[-1]) else "HOLD"
        except Exception:
            current_signal = "HOLD"

        # Build chart data
        price_series = [
            {"date": str(r['date'].date()), "close": round(float(r['close']), 2)}
            for _, r in df.iterrows()
        ]
        indicator_series = []
        if indicator_col and indicator_col in df.columns:
            indicator_series = [
                {"date": str(r['date'].date()), "value": round(float(r[indicator_col]), 2)}
                for _, r in df.iterrows()
                if not pd.isna(r[indicator_col])
            ]

        buy_markers  = [{"date": t["buy_date"],  "price": t["buy_price"],  "type": "buy"}  for t in trades]
        sell_markers = [{"date": t["sell_date"], "price": t["sell_price"], "type": "sell"} for t in trades]

        result = {
            "success":        True,
            "prompt":         user_prompt,
            "buy_expr":       buy_expr,
            "sell_expr":      sell_expr,
            "mode":           mode,
            "target_pct":     target_pct,
            "target_direction": target_direction if mode == "target_exit" else None,
            "analysis_text":   _build_analysis_text(user_prompt, summary, trades, open_trade, lookback_days, mode),
            "current_signal": current_signal,
            "summary":        summary,
            "trades":         trades[-30:],
            "open_trade":     open_trade,
            "chart_data": {
                "price":     price_series,
                "indicator": indicator_series,
                "markers":   buy_markers + sell_markers,
            },
            # flat fields for backward compat
            "total_trades":             summary["total_trades"]             if summary else 0,
            "win_rate":                 summary["win_rate"]                 if summary else 0,
            "avg_return_per_trade_pct": summary["avg_return_per_trade_pct"] if summary else 0,
            "total_return_pct":         summary["total_return_pct"]         if summary else 0,
        }

        if not trades and not open_trade:
            result["warning"] = (
                "No trades triggered. The condition may be too strict for this stock's "
                "price history. Try a less restrictive threshold or a different stock."
            )

        return result

    except Exception as e:
        return {
            "error": f"Could not run backtest. Try rephrasing — e.g. 'RSI crosses above 30' or 'buy when MACD bullish crossover'. Detail: {str(e)}"
        }
