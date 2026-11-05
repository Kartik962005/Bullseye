"""Stored prices stay final, and each call is graded on its own day."""
import time as _time
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest import mock

import pandas as pd

from app.services import daily_trade_service as dts
from app.services import data_service as ds

IST = timezone(timedelta(hours=5, minutes=30))


def frame(days, opens, closes, highs=None):
    return pd.DataFrame({
        "date": pd.to_datetime(days), "open": opens, "close": closes,
        "high": highs or [max(o, c) for o, c in zip(opens, closes)], "low": [min(o, c) for o, c in zip(opens, closes)],
        "volume": [1000] * len(days),
    })


class PriceFreshnessTests(unittest.TestCase):
    def test_todays_moving_bar_is_never_stored(self):
        bars = frame(["2026-11-03", "2026-11-04"], [100, 101], [101, 102])
        during = datetime(2026, 11, 4, 10, 0, tzinfo=IST)
        after = datetime(2026, 11, 4, 16, 5, tzinfo=IST)
        self.assertEqual(list(ds._completed_bars(bars, during)["date"].dt.day), [3])
        self.assertEqual(list(ds._completed_bars(bars, after)["date"].dt.day), [3, 4])
        saturday = datetime(2026, 11, 7, 10, 0, tzinfo=IST)
        self.assertEqual(len(ds._completed_bars(bars, saturday)), 2)

    def test_a_frame_fetched_before_the_close_expires_at_the_close(self):
        fetched = datetime(2026, 11, 4, 15, 20, tzinfo=IST).timestamp()
        self.assertFalse(ds._fetched_before_last_close(fetched, datetime(2026, 11, 4, 15, 50, tzinfo=IST)))
        self.assertTrue(ds._fetched_before_last_close(fetched, datetime(2026, 11, 4, 16, 5, tzinfo=IST)))

    def test_only_an_observation_after_the_close_can_vouch_for_the_newest_bar(self):
        evening = datetime(2026, 11, 4, 16, 30, tzinfo=IST)
        morning_ts = datetime(2026, 11, 4, 9, 0, tzinfo=IST).timestamp()
        late_ts = datetime(2026, 11, 4, 16, 10, tzinfo=IST).timestamp()
        with mock.patch.object(_time, "time", return_value=evening.timestamp()), \
             mock.patch.dict(ds._observed_session, {"date": pd.Timestamp("2026-11-03"), "ts": morning_ts}):
            # Seen at 9 AM, "3 Nov is the newest bar" says nothing about 4 Nov.
            self.assertIsNone(ds._published_session(evening))
            self.assertEqual(ds._sessions_missing(pd.Timestamp("2026-11-03"), evening), 1)
        with mock.patch.object(_time, "time", return_value=evening.timestamp()), \
             mock.patch.dict(ds._observed_session, {"date": pd.Timestamp("2026-11-03"), "ts": late_ts}):
            # Seen after the close (a holiday, say): nothing newer exists.
            self.assertEqual(ds._published_session(evening), pd.Timestamp("2026-11-03"))
            self.assertEqual(ds._sessions_missing(pd.Timestamp("2026-11-03"), evening), 0)


class WindowGradingTests(unittest.TestCase):
    def test_a_session_missing_from_the_daily_chart_is_rebuilt_not_replaced(self):
        # Yahoo left 4 Nov blank; 5 Nov must not stand in for it.
        daily = {"GODREJPROP.NS": frame(["2026-11-03", "2026-11-05"], [1651.0, 1785.0], [1669.5, 1774.5])}
        rebuilt = {"date": pd.Timestamp("2026-11-04"), "open": 1653.4, "high": 1760.0, "low": 1650.0, "close": 1739.0, "source": "15m"}
        with mock.patch.object(dts, "_intraday_bar", return_value=rebuilt) as intraday:
            bars = dts._window_bars("GODREJPROP.NS", date(2026, 11, 4), 1, daily)
        intraday.assert_called_once_with("GODREJPROP.NS", date(2026, 11, 4))
        self.assertEqual(bars[0]["open"], 1653.4)
        with mock.patch.object(dts, "_intraday_bar", return_value=None):
            self.assertIsNone(dts._window_bars("GODREJPROP.NS", date(2026, 11, 4), 1, daily))
        # The market average leaves such a stock out rather than misdating it.
        self.assertIsNone(dts._window_bars("GODREJPROP.NS", date(2026, 11, 4), 1, daily, fill_gaps=False))

    def test_a_window_is_not_graded_before_its_last_session_closes(self):
        today = datetime.now(dts.IST).date()
        daily = {"X.NS": frame([today.isoformat()], [100.0], [101.0])}
        with mock.patch.object(dts, "_session_complete", return_value=False):
            self.assertIsNone(dts._window_bars("X.NS", today, 1, daily))

    def test_multi_session_windows_follow_the_exchange_calendar(self):
        # 10 Nov 2026 is a holiday: a 3-session window from 9 Nov ends on 12 Nov.
        self.assertEqual(dts._window_sessions(date(2026, 11, 9), 3), [date(2026, 11, 9), date(2026, 11, 11), date(2026, 11, 12)])


class PlanGradingTests(unittest.TestCase):
    forecast = {"reference_close": 100.0, "plan": {"skip_gap": 0.01, "stop_pct": 0.03}}

    def test_held_to_the_close(self):
        result = dts._plan_result(self.forecast, {"open": 100.0, "high": 102.0, "close": 98.0})
        self.assertEqual(result["plan"], "held")
        self.assertAlmostEqual(result["plan_pct"], 1.85)  # 2% short gain less 0.15% costs
        self.assertEqual(result["plan_stop"], 103.0)

    def test_stopped_out_at_the_stop_from_the_open(self):
        result = dts._plan_result(self.forecast, {"open": 100.0, "high": 103.5, "close": 99.0})
        self.assertEqual(result["plan"], "stopped")
        self.assertAlmostEqual(result["plan_pct"], -3.15)

    def test_skipped_after_a_big_gap_down(self):
        result = dts._plan_result(self.forecast, {"open": 98.5, "high": 99.0, "close": 97.0})
        self.assertEqual(result, {"plan": "skipped", "plan_gap_pct": -1.5})

    def test_a_graded_sell_carries_its_plan_result(self):
        signal = {"direction": "SELL", "explanation_json": {"forecast": self.forecast}}
        graded = dts._grade_forecast(signal, [{"open": 100.0, "high": 101.0, "low": 97.0, "close": 98.0}], 1, benchmark_move=0.001)
        self.assertEqual(graded["outcome"], "WIN")
        self.assertEqual(graded["plan"], "held")
        self.assertTrue(graded["moved"])


class ScorecardRefreshTests(unittest.TestCase):
    def test_runs_on_screen_get_the_latest_scorecard(self):
        session = dts._current_session_date().isoformat()
        runs = [
            {"id": "a", "model_version": f"{dts.FORECAST_VERSION}-h1", "target_date": session, "summary": {"live_record": {"calls": 1}}},
            {"id": "b", "model_version": f"{dts.FORECAST_VERSION}-h1", "target_date": "2020-01-01", "summary": {"live_record": {"calls": 1}}},
        ]
        fresh = {"calls": 12, "sessions": [{"date": "2026-11-04"}]}
        with mock.patch.object(dts, "supabase", None), mock.patch.object(dts, "_MEMORY_RUNS", runs), \
             mock.patch.object(dts, "_live_forecast_record", side_effect=lambda h: fresh if h == 1 else None):
            self.assertEqual(dts._refresh_live_records(), 1)
        self.assertEqual(runs[0]["summary"]["live_record"], fresh)
        self.assertEqual(runs[1]["summary"]["live_record"], {"calls": 1})  # an old run is left as it was


if __name__ == "__main__":
    unittest.main()
