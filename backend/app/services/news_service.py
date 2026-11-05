"""Company headlines: beside each published call, and archived every evening.

The forecast engine does not read news. It can't yet: Yahoo serves no news for
NSE stocks, and no free source offers past Indian headlines dated well enough
to test whether they would have helped. So two things happen instead:

  * each published call carries its latest headlines, shown as context and
    labelled as not used by the model, with a caution when results or other
    big news came out in the last two days;
  * every evening the day's headlines for all forecast stocks are saved (one
    gzip JSON file a day in Storage), so that after a few months news can be
    tested walk-forward like every other input before it is allowed to count.

Headlines come from Google News search, which the stock pages already use.
"""
from __future__ import annotations

import gzip
import json
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any

BUCKET = "stock-prices"
PREFIX = "news"
_UA = {"User-Agent": "Mozilla/5.0 (compatible; BullseyeResearch/1.0)"}
_SUFFIX = re.compile(r"\b(ltd|limited|corporation|corp|inc|plc)\b\.?", re.IGNORECASE)
# Words that mark news a trader would want to know about before the open.
_BIG_NEWS = re.compile(
    r"\b(q[1-4]|quarter(ly)?|results?|earnings|profit|loss|revenue|guidance|orders?|merger|acquisitions?|acquires?|"
    r"block deal|stake|downgrades?|upgrades?|penalty|raids?|fraud|probe|fda|sebi|bans?|recall|resign(s|ed|ation)?)\b",
    re.IGNORECASE,
)
# Group names shared by several listed companies: the next word is needed too.
_GROUP_NAMES = {"tata", "bajaj", "adani", "hindustan", "bharat", "indian", "aditya", "godrej", "mahindra", "jindal",
                "jsw", "max", "sbi", "hero", "hdfc", "icici", "idfc", "bank", "power", "state", "national", "united"}
_CACHE: dict[tuple[str, int], tuple[float, list[dict[str, Any]]]] = {}
_CACHE_SECONDS = 3 * 3600


def company_query(company: str) -> str:
    """The company's name as an exact phrase, without its legal suffix."""
    name = _SUFFIX.sub("", company.replace("&amp;", "&")).replace("(India)", "").strip(" .,")
    return f'"{re.sub(r"\s+", " ", name)}"'


def headlines(query: str, *, days: int = 1, limit: int = 15, timeout: float = 8.0) -> list[dict[str, Any]]:
    """Newest first: title, source, link and publish time (UTC ISO) of matching stories."""
    key = (f"{query}|{limit}", days)
    cached = _CACHE.get(key)
    if cached and time.time() - cached[0] < _CACHE_SECONDS:
        return cached[1]
    q = urllib.parse.quote(f"{query} when:{days}d")
    url = f"https://news.google.com/rss/search?q={q}&hl=en-IN&gl=IN&ceid=IN:en"
    with urllib.request.urlopen(urllib.request.Request(url, headers=_UA), timeout=timeout) as response:
        root = ET.fromstring(response.read())
    stories: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in root.findall(".//item"):
        raw = (item.findtext("title") or "").strip()
        title, _, source = raw.rpartition(" - ") if " - " in raw else (raw, "", "")
        title = title.strip() or raw
        if not title or title.lower() in seen:
            continue
        seen.add(title.lower())
        try:
            published = parsedate_to_datetime(item.findtext("pubDate") or "").astimezone(timezone.utc).isoformat(timespec="minutes")
        except (TypeError, ValueError):
            published = None
        stories.append({"title": title, "source": source.strip() or (item.findtext("source") or "").strip(),
                        "url": (item.findtext("link") or "").strip() or None, "published": published})
    stories.sort(key=lambda s: s["published"] or "", reverse=True)
    stories = stories[:limit]
    if len(_CACHE) > 600:
        _CACHE.clear()
    _CACHE[key] = (time.time(), stories)
    return stories


def name_key(company: str) -> str:
    """The shortest part of a company's name that identifies it in a headline:
    "Patanjali", but "IDFC First" and "Tata Power"."""
    words = company_query(company).strip('"').split()
    if not words:
        return ""
    first = words[0]
    if (len(first) < 5 or first.lower() in _GROUP_NAMES) and len(words) > 1:
        return f"{first} {words[1]}"
    return first


def is_big_news(story: dict[str, Any], key: str = "", within_hours: int = 48) -> bool:
    """Results, deals, regulator action and the like about this company, published recently."""
    try:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(str(story.get("published")))
    except (TypeError, ValueError):
        return False
    title = story.get("title") or ""
    names_it = not key or key.lower() in title.lower()
    return age <= timedelta(hours=within_hours) and names_it and bool(_BIG_NEWS.search(title))


def call_headlines(company: str, limit: int = 3) -> dict[str, Any] | None:
    """A published call's latest headlines (last three days) and whether big news about it just came out."""
    try:
        stories = headlines(company_query(company), days=3, limit=limit)
    except Exception as exc:  # noqa: BLE001 - a call is published with or without its news
        print(f"[News] headlines unavailable for {company}: {exc}")
        return None
    key = name_key(company)
    return {"stories": stories, "big_news": any(is_big_news(s, key) for s in stories)}


def archive_path(day: date) -> str:
    return f"{PREFIX}/{day.isoformat()}.json.gz"


def archive_day(day: date, companies: list[tuple[str, str]], *, storage: Any, pause: float = 0.4) -> dict[str, int]:
    """Save the day's headlines for every (ticker, company) and for the market as a whole."""
    stocks: dict[str, Any] = {}
    failed = 0
    for ticker, company in companies:
        try:
            stocks[ticker] = headlines(company_query(company), days=1, limit=15)
        except Exception:  # noqa: BLE001 - keep going; a gap is recorded as None
            stocks[ticker] = None
            failed += 1
        time.sleep(pause)
    try:
        market = headlines("Nifty OR Sensex OR \"stock market\"", days=1, limit=40)
    except Exception:  # noqa: BLE001
        market = None
    payload = gzip.compress(json.dumps({
        "day": day.isoformat(),
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "Google News search, last 24 hours, per company name",
        "market": market,
        "stocks": stocks,
    }, ensure_ascii=False).encode("utf-8"))
    storage.from_(BUCKET).upload(archive_path(day), payload, file_options={"content-type": "application/gzip", "upsert": "true"})
    return {"stocks": len(companies), "failed": failed, "stories": sum(len(v or []) for v in stocks.values()), "bytes": len(payload)}
