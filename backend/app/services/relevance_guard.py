"""Instant replies for greetings and questions that aren't about finance.

Every AI search used to send "hi" through the full pipeline (stock data,
fundamentals, an LLM call), which took seconds even when warm. These checks
are pure regex, so small talk and clearly off-topic questions are answered in
under a millisecond and never spend LLM quota.

Anything the regexes miss is caught by the LLMs themselves: each system prompt
tells the model to reply with OFF_TOPIC_MARKER for non-finance questions, and
``is_off_topic_marker`` maps that back to the same polite reply.
"""

from __future__ import annotations

import re

OFF_TOPIC_MARKER = "OFF_TOPIC"

GREETING_REPLY = (
    "Hi! I'm Bullseye's market assistant. I answer questions about Indian stocks, markets and "
    "investing. Try asking something like \"How has TCS performed this year?\", \"Backtest buying "
    "RELIANCE when RSI drops below 30\" or \"Which banks trade below book value?\""
)

OFF_TOPIC_REPLY = (
    "I can only help with stocks, markets and investing. Please ask a relevant question, for "
    "example \"Is HDFC Bank expensive compared with other banks?\", \"What does a P/E ratio "
    "tell me?\" or \"Show debt-free companies with growing profits.\""
)

# Whole-message small talk: greetings, thanks, "how are you", sign-offs.
_SMALL_TALK = re.compile(
    r"^\s*(?:(?:hi+|hello+|hey+|hiya|yo|namaste|namaskar|hola|sup|wassup|what'?s up|good\s+"
    r"(?:morning|afternoon|evening|night|day)|gm|gn)(?:\s+(?:there|bullseye|bot|ai|bro|buddy|sir|"
    r"team|all))?|how\s+(?:are|r)\s+(?:you|u|ya)(?:\s+doing)?(?:\s+today)?|how'?s\s+it\s+going|"
    r"how\s+do\s+you\s+do|kaise\s+ho|kya\s+haal\s+hai|thanks?|thank\s+you(?:\s+so\s+much)?|thx|ty|"
    r"ok(?:ay)?|cool|nice|great|bye|goodbye|see\s+you|cya|who\s+are\s+you|what\s+are\s+you|"
    r"are\s+you\s+(?:a\s+)?(?:bot|human|ai|real)|test(?:ing)?)"
    r"(?:[\s,!.?]+(?:hi+|hello+|hey+|there|how\s+(?:are|r)\s+(?:you|u)(?:\s+doing)?))*\s*[!.?,:)]*\s*$",
    re.IGNORECASE,
)

# Topics that are never about finance, checked only when no finance word is
# present ("weather impact on sugar stocks" stays on-topic).
_OFF_TOPIC = re.compile(
    r"\b(?:recipe|cook(?:ing)?|weather|temperature\s+in|movie|film|song|lyrics|poem|poetry|"
    r"joke|riddle|story\s+about|horoscope|zodiac|girlfriend|boyfriend|dating|love\s+letter|"
    r"football|cricket\s+(?:score|match)|ipl\s+(?:score|match|team)|world\s+cup|homework|"
    r"essay\s+on|translate|capital\s+of|prime\s+minister\s+of|president\s+of|"
    r"write\s+(?:a\s+)?(?:code|program|script|function)|python\s+code|javascript|"
    r"video\s+game|anime|celebrity|actor|actress)\b",
    re.IGNORECASE,
)

_FINANCE = re.compile(
    r"\b(?:stocks?|shares?|equit(?:y|ies)|market|nifty|sensex|nse|bse|invest\w*|trad(?:e|ing|er)|"
    r"price|rsi|macd|dma|sma|ema|p/?e|pb|roe|roce|eps|dividend|ipo|mutual\s+funds?|sip|etf|bonds?|"
    r"gold|silver|crypto|bitcoin|inflation|interest\s+rates?|repo|rbi|sebi|gdp|econom\w*|tax\w*|"
    r"loan|emi|bank\w*|insurance|portfolio|backtest\w*|buy|sell|profit|loss|revenue|earnings|"
    r"valuation|sector|rupee|forex|currency|fii|dii|broker\w*|demat|returns?|volatil\w*|"
    r"sugar|steel|cement|pharma|oil|auto\w*|company|companies|business|finance|financial|money|"
    r"wealth|savings?|budget|fund\w*|index|indices|options?|futures?|f&o|derivatives?|hedg\w*)\b",
    re.IGNORECASE,
)


def small_talk_reply(prompt: str) -> str | None:
    """Canned reply for a greeting or a clearly non-finance question, else None."""
    text = (prompt or "").strip()
    if not text:
        return None
    if _SMALL_TALK.match(text):
        return GREETING_REPLY
    if _OFF_TOPIC.search(text) and not _FINANCE.search(text):
        return OFF_TOPIC_REPLY
    return None


def is_off_topic_marker(text: str | None) -> bool:
    """True when an LLM answered with the off-topic marker instead of an answer."""
    cleaned = re.sub(r"[^A-Za-z_]", "", text or "").upper()
    return cleaned == OFF_TOPIC_MARKER or (cleaned.startswith(OFF_TOPIC_MARKER) and len(cleaned) < 24)


LLM_RULE = (
    f"If the question is not about stocks, markets, investing, trading, companies, personal finance "
    f"or the economy (for example small talk, coding, sport, entertainment or general knowledge), "
    f"reply with exactly {OFF_TOPIC_MARKER} and nothing else."
)
