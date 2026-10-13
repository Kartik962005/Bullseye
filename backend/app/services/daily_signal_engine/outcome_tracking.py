from __future__ import annotations

import os
from typing import Any


# How many trading sessions a signal gets to reach its target before it is
# judged. Signals are built with target = 1.18 ATR and stop = 0.68 ATR, so the
# target sits ~1.7x further away than the stop. Measured over 9,105 real
# next-day bars, a single session reaches the target 9.7% of the time and the
# stop 25.8% — 2.7:1 against, from geometry alone, before any question of
# whether the direction call was any good.
#
# Judging a 1.55-reward:risk setup on one bar is therefore self-defeating: those
# two settings cannot both hold. Giving the trade a real swing window is the fix
# that keeps the reward:risk the walk-forward backtest validated.
HOLD_SESSIONS = max(1, int(os.getenv("SIGNAL_HOLD_SESSIONS", "5")))


def evaluate_signal_outcome(signal: dict[str, Any], trading_day_bar: dict[str, Any]) -> dict[str, Any]:
    target = float(signal["target_price"])
    stop = float(signal["stop_loss"])
    entry = float(signal["entry_high"] if signal["direction"] == "SELL" else signal["entry_low"])
    high = float(trading_day_bar["high"])
    low = float(trading_day_bar["low"])
    close = float(trading_day_bar["close"])

    if signal["direction"] == "BUY":
        target_hit = high >= target
        stop_hit = low <= stop
        close_r = (close - entry) / max(entry - stop, 1e-6)
    else:
        target_hit = low <= target
        stop_hit = high >= stop
        close_r = (entry - close) / max(stop - entry, 1e-6)

    if target_hit and stop_hit:
        return {"outcome": "NEUTRAL", "realized_r": round(close_r, 4), "hit_sequence": "ambiguous_same_day"}
    if target_hit:
        return {"outcome": "WIN", "realized_r": round(signal["risk_reward"], 4), "hit_sequence": "target_first"}
    if stop_hit:
        return {"outcome": "LOSS", "realized_r": -1.0, "hit_sequence": "stop_first"}
    return {"outcome": "NEUTRAL", "realized_r": round(close_r, 4), "hit_sequence": "neither_hit"}


def evaluate_signal_outcome_window(
    signal: dict[str, Any],
    bars: list[dict[str, Any]],
    *,
    max_sessions: int | None = None,
) -> dict[str, Any] | None:
    """Judge a signal over a window of sessions, first touch wins.

    `bars` must be the sessions from the target date onward, in order.

    Returns None when the trade is still genuinely undecided — neither level
    touched AND the window has not elapsed — so an open position is reported as
    open rather than silently counted as a non-win. That distinction is what
    keeps the hit rate honest: `run_outcome_tracking` only writes a row when
    this returns a verdict.

    A session that touches BOTH levels stays ambiguous: daily OHLC cannot say
    which came first, and guessing would quietly flatter (or damn) the record.
    """
    if not bars:
        return None
    from .backtest import _grade_limit_entry

    limit = max_sessions or HOLD_SESSIONS
    window = [
        {"open": float(b["open"]), "high": float(b["high"]), "low": float(b["low"]), "close": float(b["close"])}
        for b in bars[:limit]
    ]
    # Same rule the models are trained and tested on: a limit order at the
    # entry zone for the first session, R measured from the actual fill, and a
    # session touching both levels counted as a loss. Tracking live picks any
    # other way would make the published record incomparable with the test.
    graded = _grade_limit_entry(signal, window, ambiguous_as="loss")
    outcome = graded["outcome"]
    if outcome == "TIME_EXIT" and len(window) < limit:
        return None  # still open: the window has not run out yet
    sequence = {
        "NO_FILL": "no_fill",
        "WIN": "target_first",
        "LOSS": "ambiguous_same_session" if graded.get("exit") == "ambiguous_day" else "stop_first",
        "TIME_EXIT": "window_elapsed",
    }[outcome]
    return {
        "outcome": "NEUTRAL" if outcome == "TIME_EXIT" else outcome,
        "realized_r": round(float(graded["realized_r"]), 4),
        "hit_sequence": sequence,
        "sessions_held": int(graded.get("days_held") or 0),
        "fill_price": graded.get("fill"),
    }
