import time
import unittest
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from app.services import data_service as ds
from app.strategies.nlp_backtester import _run_crossover, _run_stop_loss, _run_target_exit, columns_used

IST = timezone(timedelta(hours=5, minutes=30))


class HolidayAwareCacheTests(unittest.TestCase):
    def tearDown(self):
        ds._observed_session.update(date=None, ts=0.0)

    def test_weekday_gap_counts_as_missing_without_knowledge(self):
        # Sunday 4 Oct 2026; cache ends Thursday 1 Oct, Friday 2 Oct looks missing.
        sunday = datetime(2026, 10, 4, 12, tzinfo=IST)
        self.assertEqual(ds._sessions_missing(pd.Timestamp("2026-10-01"), now=sunday), 1)

    def test_holiday_learned_from_a_refresh_is_not_missing(self):
        # A Yahoo refresh showed 1 Oct is the newest bar (2 Oct was Gandhi Jayanti).
        ds._note_latest_bar(pd.Timestamp("2026-10-01"))
        sunday = datetime(2026, 10, 4, 12, tzinfo=IST)
        self.assertEqual(ds._sessions_missing(pd.Timestamp("2026-10-01"), now=sunday), 0)
        # An older cache is still stale.
        self.assertGreater(ds._sessions_missing(pd.Timestamp("2026-09-29"), now=sunday), 0)

    def test_learned_session_expires(self):
        ds._observed_session.update(date=pd.Timestamp("2026-10-01"), ts=time.time() - 7 * 3600)
        sunday = datetime(2026, 10, 4, 12, tzinfo=IST)
        self.assertEqual(ds._sessions_missing(pd.Timestamp("2026-10-01"), now=sunday), 1)


class ColumnsUsedTests(unittest.TestCase):
    def test_columns_and_aliases(self):
        self.assertEqual(
            columns_used("(df['SMA_50'] > df['SMA_200']) & (df['rsi'] < 30)", 'df["MACD_hist"] > 0'),
            {"SMA_50", "SMA_200", "RSI_14", "MACD_hist"},
        )
        self.assertEqual(columns_used(None, ""), set())


def _frame(closes, highs=None, lows=None):
    n = len(closes)
    closes = np.asarray(closes, dtype=float)
    return pd.DataFrame({
        "date": pd.bdate_range("2024-01-01", periods=n),
        "open": closes,
        "close": closes,
        "high": np.asarray(highs if highs is not None else closes, dtype=float),
        "low": np.asarray(lows if lows is not None else closes, dtype=float),
        "day_return": pd.Series(closes).pct_change().fillna(0).to_numpy() * 100,
    })


class RunnerTests(unittest.TestCase):
    """Known answers for the array-based simulators."""

    def test_crossover_enters_and_exits_on_signals(self):
        df = _frame([100, 100, 100, 90, 95, 110, 120, 118])
        trades, open_trade = _run_crossover(df, "df['close'] < 95", "df['close'] > 115")
        self.assertEqual(len(trades), 1)
        self.assertEqual((trades[0]["buy_price"], trades[0]["sell_price"]), (90.0, 120.0))
        self.assertIsNone(open_trade)

    def test_target_exit_hits_target(self):
        df = _frame([100, 100, 100, 101, 104, 103], highs=[100, 100, 100, 102, 106, 104])
        trades, _ = _run_target_exit(df, "df['day_return'] < 0.5", 5, "up")
        self.assertEqual(trades[0]["sell_price"], 105.0)

    def test_trailing_stop_follows_the_peak(self):
        closes = [100, 100, 100, 110, 120, 113, 108]
        df = _frame(closes, highs=closes, lows=closes)
        trades, _ = _run_stop_loss(df, "df['close'] == 100", 5, trailing=True)
        # Bought at 100 on the 3rd bar, peak 120, 5% trailing stop at 114 hit on 113.
        first = trades[0]
        self.assertEqual(first["buy_price"], 100.0)
        self.assertEqual(first["sell_price"], 114.0)

    def test_open_position_reported(self):
        df = _frame([100, 100, 100, 101, 102, 103])
        trades, open_trade = _run_crossover(df, "df['close'] == 100", "df['close'] > 200")
        self.assertEqual(trades, [])
        self.assertEqual(open_trade["current_price"], 103.0)


if __name__ == "__main__":
    unittest.main()
