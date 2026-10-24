"""NSE trading calendar: weekends and exchange holidays (equity segment).

Every date the engine forecasts for, and every date range the app shows, comes
from here. frontend/lib/market-calendar.ts carries the same list; a backend
test checks the two match.

Add a year when NSE publishes its circular (usually in December), or set
INDIA_MARKET_HOLIDAYS=YYYY-MM-DD,YYYY-MM-DD on the server to add dates without
a deploy. Special sessions such as Diwali Muhurat trading on a weekend are not
regular sessions and are ignored.
"""
from __future__ import annotations

import os
from datetime import date, timedelta

NSE_HOLIDAYS: dict[str, str] = {
    # 2026, NSE equity segment (weekday closures only)
    "2026-01-26": "Republic Day",
    "2026-03-03": "Holi",
    "2026-03-26": "Shri Ram Navami",
    "2026-03-31": "Shri Mahavir Jayanti",
    "2026-04-03": "Good Friday",
    "2026-04-14": "Dr. Baba Saheb Ambedkar Jayanti",
    "2026-05-01": "Maharashtra Day",
    "2026-05-28": "Bakri Id",
    "2026-06-26": "Muharram",
    "2026-09-14": "Ganesh Chaturthi",
    "2026-10-02": "Mahatma Gandhi Jayanti",
    "2026-10-20": "Dussehra",
    "2026-11-10": "Diwali Balipratipada",
    "2026-11-24": "Prakash Gurpurb Sri Guru Nanak Dev",
    "2026-12-25": "Christmas",
}


def holidays() -> set[str]:
    extra = {d.strip() for d in os.getenv("INDIA_MARKET_HOLIDAYS", "").split(",") if d.strip()}
    return set(NSE_HOLIDAYS) | extra


def is_trading_day(day: date) -> bool:
    return day.weekday() < 5 and day.isoformat() not in holidays()


def next_trading_day(day: date) -> date:
    current = day + timedelta(days=1)
    while not is_trading_day(current):
        current += timedelta(days=1)
    return current


def previous_trading_day(day: date) -> date:
    current = day - timedelta(days=1)
    while not is_trading_day(current):
        current -= timedelta(days=1)
    return current


def session_after(start: date, sessions: int) -> date:
    """The date of the `sessions`-th trading session counting `start` as the first."""
    day = start if is_trading_day(start) else next_trading_day(start)
    for _ in range(max(0, sessions - 1)):
        day = next_trading_day(day)
    return day
