import unittest
import unittest.mock

import numpy as np
import pandas as pd

from app.services import daily_trade_service as dts
from app.services.daily_signal_engine import forecast as fc


def synthetic_prices(n_days=360, seed=1, drift=0.0005):
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range("2025-01-01", periods=n_days)
    close = 100 * np.cumprod(1 + rng.normal(drift, 0.015, n_days))
    open_ = close * (1 + rng.normal(0, 0.003, n_days))
    high = np.maximum(open_, close) * (1 + rng.uniform(0.001, 0.01, n_days))
    low = np.minimum(open_, close) * (1 - rng.uniform(0.001, 0.01, n_days))
    volume = rng.integers(100_000, 1_000_000, n_days).astype(float)
    return pd.DataFrame({"date": dates, "open": open_, "high": high, "low": low, "close": close, "volume": volume})


class ForecastFrameTests(unittest.TestCase):
    def setUp(self):
        self.frames = {f"S{i}.NS": synthetic_prices(seed=i) for i in range(6)}
        self.index = synthetic_prices(seed=99)

    def test_builds_every_feature_and_forward_returns_from_the_next_open(self):
        df = fc.forecast_frame(self.frames, self.index, horizons=(1, 3))
        self.assertFalse(df.empty)
        self.assertTrue(set(fc.FORECAST_FEATURES).issubset(df.columns))
        self.assertFalse(df[fc.FORECAST_FEATURES].isna().any().any())
        one = df[df["ticker"] == "S0.NS"].reset_index(drop=True)
        i = 10
        expected = one.loc[i + 3, "close"] / one.loc[i + 1, "open"] - 1
        self.assertAlmostEqual(one.loc[i, "fwd_3"], expected, places=10)
        # Excess return is relative to the same-day average across the universe.
        day = one.loc[i, "date"]
        self.assertAlmostEqual(df.loc[df["date"] == day, "excess_3"].mean(), 0.0, places=12)
        self.assertTrue(df["rank_ret5"].between(0, 1).all())

    def test_weekend_bars_are_ignored(self):
        frames = {t: f.copy() for t, f in self.frames.items()}
        extra = frames["S0.NS"].iloc[[-1]].copy()
        extra["date"] = pd.Timestamp("2026-06-13")  # a Saturday
        frames["S0.NS"] = pd.concat([frames["S0.NS"], extra], ignore_index=True)
        df = fc.forecast_frame(frames, self.index)
        self.assertNotIn("2026-06-13", set(df["date"]))

    def test_price_jumps_mark_the_stock_as_an_anomaly(self):
        frames = {t: f.copy() for t, f in self.frames.items()}
        jump = frames["S1.NS"]
        jump.loc[jump.index[-10]:, ["open", "high", "low", "close"]] *= 0.5  # a 1:2 split nobody adjusted
        df = fc.forecast_frame(frames, self.index)
        last = df[df["date"] == df["date"].max()].set_index("ticker")
        self.assertEqual(last.loc["S1.NS", "anomaly"], 1.0)
        self.assertEqual(last.loc["S0.NS", "anomaly"], 0.0)

    def test_live_rows_match_training_rows_for_the_same_day(self):
        train = fc.forecast_frame(self.frames, self.index, horizons=(1,))
        cut = pd.Timestamp(train["date"].unique()[-5])
        live_frames = {t: f[f["date"] <= cut] for t, f in self.frames.items()}
        live = fc.forecast_frame(live_frames, self.index[self.index["date"] <= cut])
        day = cut.strftime("%Y-%m-%d")
        a = train[train["date"] == day].set_index("ticker")[fc.FORECAST_FEATURES].sort_index()
        b = live[live["date"] == day].set_index("ticker")[fc.FORECAST_FEATURES].sort_index()
        self.assertEqual(len(a), 6)
        pd.testing.assert_frame_equal(a, b, check_exact=False, rtol=1e-9)


class SelectionTests(unittest.TestCase):
    def predictions(self):
        return pd.DataFrame({
            "ticker": [f"T{i}.NS" for i in range(8)],
            "sector": ["A", "A", "A", "A", "B", "B", "C", "C"],
            "p_beat": [0.70, 0.68, 0.66, 0.64, 0.30, 0.52, 0.55, 0.40],
            "q10": [-0.02, -0.02, -0.02, -0.02, -0.05, -0.01, -0.08, -0.01],
            "q90": [0.03, 0.03, 0.03, 0.03, 0.04, 0.01, 0.09, 0.01],
        })

    def test_buys_ranked_first_at_most_three_per_sector(self):
        picked = dts._select_forecasts(self.predictions(), "Aggressive", horizon=3)
        self.assertEqual(set(picked["direction"]), {"BUY"})  # no sells beyond intraday
        self.assertLessEqual((picked["sector"] == "A").sum(), 3)
        self.assertEqual(list(picked["ticker"])[:3], ["T0.NS", "T1.NS", "T2.NS"])
        self.assertLessEqual(len(picked), dts.MAX_SELECTED_SIGNALS)
        self.assertTrue(picked["p_beat"].is_monotonic_decreasing)

    def test_intraday_adds_sell_calls_for_the_weakest(self):
        with unittest.mock.patch.object(dts, "MAX_SELECTED_SIGNALS", 3):
            picked = dts._select_forecasts(self.predictions(), "Aggressive", horizon=1)
        sells = picked[picked["direction"] == "SELL"]
        self.assertEqual(list(sells["ticker"])[:2], ["T4.NS", "T7.NS"])  # lowest chance to beat first
        self.assertTrue(set(sells["ticker"]).isdisjoint(set(picked[picked["direction"] == "BUY"]["ticker"])))
        self.assertAlmostEqual(float(sells.iloc[0]["confidence"]), 0.70)

    def test_ties_are_broken_by_the_underlying_score(self):
        preds = self.predictions().assign(p_beat=0.55, rank_score=[0.1, 0.9, 0.5, 0.2, 0.3, 0.4, 0.6, 0.7])
        picked = dts._select_forecasts(preds, "Aggressive", horizon=3)
        self.assertEqual(picked.iloc[0]["ticker"], "T1.NS")

    def test_conservative_drops_the_widest_ranges(self):
        picked = dts._select_forecasts(self.predictions(), "Conservative", horizon=1)
        self.assertNotIn("T6.NS", set(picked["ticker"]))

    def rule(self, cut, confirmed=True):
        return {"cut": cut, "confirmed": confirmed, "confirmation": {"right_rate": 0.58, "market_rate": 0.6}}

    def test_only_calls_past_a_confirmed_cut_off_are_published(self):
        publish = {"max_per_day": 5, "sector_cap": 2, "buy": self.rule(0.65), "sell": self.rule(0.35)}
        picked = dts._select_forecasts(self.predictions(), "Aggressive", horizon=1, publish=publish)
        buys = picked[picked["direction"] == "BUY"]
        sells = picked[picked["direction"] == "SELL"]
        self.assertEqual(list(buys["ticker"]), ["T0.NS", "T1.NS"])  # 0.66 and 0.64 pass, but two per sector
        self.assertEqual(list(sells["ticker"]), ["T4.NS"])  # only 0.30 is weak enough

    def test_a_side_that_did_not_hold_up_publishes_nothing(self):
        publish = {"max_per_day": 5, "sector_cap": 2, "buy": self.rule(0.5, confirmed=False),
                   "sell": {"cut": None, "confirmed": False, "best": {"right_rate": 0.52, "market_rate": 0.51}}}
        picked = dts._select_forecasts(self.predictions(), "Aggressive", horizon=1, publish=publish)
        self.assertTrue(picked.empty)
        notes = dts._side_notes(publish, 1, [])
        self.assertIn("paused", notes["buy"])
        self.assertIn("52%", notes["sell"])

    def test_a_published_side_with_no_call_today_says_so(self):
        publish = {"buy": self.rule(0.99)}
        notes = dts._side_notes(publish, 3, [])
        self.assertIn("No buy call is strong enough today", notes["buy"])
        self.assertIn("rose 58%", notes["buy"])
        self.assertEqual(dts._side_notes(publish, 3, [{"direction": "BUY"}]), {})

    def test_the_daily_cap_applies_to_each_side(self):
        preds = pd.DataFrame({
            "ticker": [f"T{i}.NS" for i in range(12)], "sector": [f"S{i}" for i in range(12)],
            "p_beat": [0.8] * 12, "q10": [-0.02] * 12, "q90": [0.03] * 12,
        })
        picked = dts._select_forecasts(preds, "Aggressive", horizon=5, publish={"max_per_day": 5, "buy": self.rule(0.6)})
        self.assertEqual(len(picked), 5)


class ForecastGradingTests(unittest.TestCase):
    def bars(self, rows):
        return [{"open": o, "high": h, "low": l, "close": c} for o, h, l, c in rows]

    def signal(self, direction="BUY"):
        return {"direction": direction, "explanation_json": {"forecast": {"low_price": 95, "high_price": 110}}}

    def test_open_until_the_horizon_has_passed(self):
        self.assertIsNone(dts._grade_forecast(self.signal(), self.bars([(100, 101, 99, 100)]), 3, 0.0))

    def test_open_until_the_benchmark_is_known(self):
        self.assertIsNone(dts._grade_forecast(self.signal(), self.bars([(100, 101, 99, 100)]), 1, None))

    def test_beat_the_market_inside_the_range(self):
        bars = self.bars([(100, 102, 99, 101), (101, 104, 100, 103), (103, 105, 102, 104)])
        out = dts._grade_forecast(self.signal(), bars, 3, 0.01)  # stock +4%, market +1%
        self.assertEqual(out["outcome"], "WIN")
        self.assertAlmostEqual(out["realized_r"], 3.0)
        self.assertIn("in_range", out["hit_sequence"])

    def test_rising_stock_that_lagged_a_stronger_market_is_a_miss(self):
        out = dts._grade_forecast(self.signal(), self.bars([(100, 103, 99, 102)]), 1, 0.05)
        self.assertEqual(out["outcome"], "LOSS")
        self.assertAlmostEqual(out["realized_r"], -3.0)
        # ...though it did rise, which the scorecard shows separately.
        self.assertTrue(out["moved"])
        self.assertAlmostEqual(out["move_pct"], 2.0)
        self.assertAlmostEqual(out["market_pct"], 5.0)

    def test_a_sell_that_fell_moved_as_called(self):
        out = dts._grade_forecast(self.signal("SELL"), self.bars([(100, 101, 96, 97)]), 1, -0.01)
        self.assertEqual(out["outcome"], "WIN")
        self.assertTrue(out["moved"])

    def test_lag_call_that_beat_the_market_outside_the_range(self):
        out = dts._grade_forecast(self.signal("SELL"), self.bars([(100, 120, 99, 112)]), 1, 0.0)
        self.assertEqual(out["outcome"], "LOSS")
        self.assertAlmostEqual(out["realized_r"], -12.0)
        self.assertIn("out_of_range", out["hit_sequence"])


class RecentRecordTests(unittest.TestCase):
    """A side that held up in testing must also hold up over its latest sessions."""

    def setUp(self):
        dts._RECENT_CACHE.clear()

    def tearDown(self):
        dts._RECENT_CACHE.clear()

    def daily_rows(self, rate=0.6, sessions=120):
        # Day by day, as calibrate_publishing.py stores it: [date, calls, moved, market].
        days = pd.bdate_range("2026-04-01", periods=sessions).strftime("%Y-%m-%d")
        return [[day, 5, round(5 * rate), round(5 * rate)] for day in days]

    def rule(self, daily, cut=0.46):
        return {"cut": cut, "confirmed": True, "confirmation": {"right_rate": 0.6, "market_rate": 0.6},
                "recent": {"right_rate": 0.6, "market_rate": 0.6, "daily": daily}}

    def test_live_sessions_roll_in_and_the_oldest_tested_sessions_roll_out(self):
        daily = self.daily_rows(0.6)
        live = [(f"2026-11-{d:02d}", {"sell": {"calls": 5, "moved": 1, "market": 1}}) for d in range(20, 0, -1)]
        record = dts._recent_record(self.rule(daily), "sell", live, 0.55)
        self.assertEqual((record["sessions"], record["live_sessions"], record["calls"]), (120, 20, 600))
        self.assertEqual(record["first_day"], daily[20][0])  # the 20 oldest tested sessions dropped out
        self.assertAlmostEqual(record["right_rate"], (20 * 1 + 100 * 3) / 600, places=4)
        self.assertFalse(record["passes"])  # 53% is below the 55% bar
        self.assertTrue(dts._recent_record(self.rule(daily), "sell", [], 0.55)["passes"])

    def test_too_few_recent_calls_do_not_pass(self):
        record = dts._recent_record(self.rule(self.daily_rows(0.8, sessions=5)), "sell", [], 0.55)
        self.assertEqual(record["calls"], 25)
        self.assertFalse(record["passes"])

    def test_a_side_slipping_lately_pauses_but_its_calls_are_still_tracked(self):
        predictions = SelectionTests().predictions()
        publish = {"max_per_day": 5, "sector_cap": 2, "bar": 0.55, "sell": self.rule(self.daily_rows(0.4))}
        with unittest.mock.patch.object(dts, "_tracked_sessions", return_value=[]):
            effective = dts._effective_publish(publish, 1)
        self.assertNotIn("daily", effective["sell"]["recent"])  # the day-by-day test data stays in the artifact
        self.assertFalse(effective["sell"]["recent"]["passes"])
        picked = dts._select_forecasts(predictions, "Aggressive", horizon=1, publish=effective)
        self.assertTrue(picked.empty)
        note = dts._side_notes(effective, 1, [])["sell"]
        self.assertIn("paused for now", note)
        self.assertIn("fell 40%", note)
        self.assertIn("120 sessions of testing", note)
        self.assertEqual(dts._would_be_calls(predictions, 1, effective), {"sell": ["T4.NS", "T7.NS"]})

    def test_a_side_holding_up_lately_publishes_with_its_recent_record(self):
        publish = {"max_per_day": 5, "sector_cap": 2, "sell": self.rule(self.daily_rows(0.6)),
                   "buy": {"cut": 0.6, "confirmed": False, "recent": {"daily": self.daily_rows(0.9)}}}
        with unittest.mock.patch.object(dts, "_tracked_sessions", return_value=[]):
            effective = dts._effective_publish(publish, 1)
        self.assertTrue(effective["sell"]["recent"]["passes"])
        self.assertNotIn("recent", effective["buy"])  # a side that failed the full test is not tracked
        picked = dts._select_forecasts(SelectionTests().predictions(), "Aggressive", horizon=1, publish=effective)
        self.assertEqual(list(picked["ticker"]), ["T4.NS", "T7.NS"])

    def test_would_be_calls_are_graded_once_their_window_closes(self):
        run = {"id": "r1", "run_date": "2026-10-29", "target_date": "2026-10-30", "market": "NSE",
               "risk_level": dts.DEFAULT_RISK_LEVEL, "model_version": f"{dts.FORECAST_VERSION}-h1",
               "summary": {"horizon_days": 1, "tracking": {"sell": ["AAA.NS", "BBB.NS"]}}}
        day = pd.Timestamp("2026-10-30")
        history = {
            "AAA.NS": pd.DataFrame({"date": [day], "open": [100.0], "high": [101.0], "low": [98.0], "close": [99.0]}),
            "BBB.NS": pd.DataFrame({"date": [day], "open": [100.0], "high": [101.0], "low": [99.5], "close": [100.5]}),
        }
        with unittest.mock.patch.object(dts, "supabase", None), \
             unittest.mock.patch.object(dts, "_MEMORY_RUNS", [run]), \
             unittest.mock.patch.object(dts, "_benchmark_move", return_value=0.001):
            self.assertEqual(dts._grade_tracked_calls(pd.Timestamp("2026-10-30").date(), history), 1)
            # AAA fell 1% and lagged the market; BBB rose and beat it.
            self.assertEqual(run["summary"]["tracked"], {"sell": {"calls": 2, "moved": 1, "market": 1}})
            self.assertEqual(dts._grade_tracked_calls(pd.Timestamp("2026-10-30").date(), history), 0)  # graded once
            self.assertEqual(dts._tracked_sessions(1), [("2026-10-30", {"sell": {"calls": 2, "moved": 1, "market": 1}})])

    def test_an_unclosed_window_is_not_remembered_as_final(self):
        tickers = [f"S{i}.NS" for i in range(45)]
        start = pd.Timestamp("2026-10-26")
        one_bar = {t: pd.DataFrame({"date": [start], "open": [100.0], "close": [101.0]}) for t in tickers}
        three_bars = {t: pd.DataFrame({"date": pd.bdate_range(start, periods=3), "open": [100.0] * 3, "close": [100.0, 101.0, 102.0]})
                      for t in tickers}
        with unittest.mock.patch.object(dts.forecast_engine, "universe_tickers", return_value=tickers), \
             unittest.mock.patch.object(dts, "_BENCHMARK_CACHE", {}):
            self.assertIsNone(dts._benchmark_move(start.date(), 3, "NSE", one_bar))
            self.assertAlmostEqual(dts._benchmark_move(start.date(), 3, "NSE", three_bars), 0.02)

    def test_email_quotes_the_recent_record_beside_the_tested_one(self):
        summary = {"publish": {"base": {"rose_rate": 0.46}, "sell": {**self.rule([]), "recent": {
            "sessions": 120, "right_rate": 0.573, "market_rate": 0.568, "passes": True}}}}
        self.assertEqual(dts._record_note(summary), "Sell calls fell 60% of the time in testing and 57% over the last 120 sessions "
                                                    "(a typical stock fell 54%).")
        summary["publish"]["sell"]["recent"]["passes"] = False
        self.assertIsNone(dts._record_note(summary))

        from app.services.daily_signal_engine.email_generation import build_signal_email

        forecast = {"p_beat": 0.41, "p_call": 0.59, "q10": -0.018, "q50": -0.001, "q90": 0.021, "reference_close": 500.0,
                    "low_price": 491.0, "mid_price": 499.5, "high_price": 510.5, "stop_price": 510.5}
        signal = {"symbol": "TCS", "company_name": "TCS", "direction": "SELL", "entry_low": 500.0, "entry_high": 500.0,
                  "target_price": 499.5, "stop_loss": 510.5, "risk_reward": 1.0, "confidence": 0.59, "signal_rank": 1,
                  "explanation_json": {"forecast": forecast, "reasons": []}}
        note = "Sell calls fell 60% of the time in testing and 57% over the last 120 sessions."
        _, text, html = build_signal_email(signal_date="2026-10-30", market="NSE", signals=[signal], unsubscribe_url="u",
                                           risk_level="Balanced", signal_type="1-day", record_note=note)
        self.assertIn(note, text)
        self.assertIn(note, html)


if __name__ == "__main__":
    unittest.main()


class CalendarTests(unittest.TestCase):
    def test_backend_and_frontend_holiday_lists_match(self):
        import pathlib
        import re

        from app.services.daily_signal_engine import market_calendar as mc

        ts = pathlib.Path(__file__).resolve().parents[2] / "frontend" / "lib" / "market-calendar.ts"
        frontend = set(re.findall(r"'(\d{4}-\d{2}-\d{2})'", ts.read_text(encoding="utf-8")))
        self.assertEqual(frontend, set(mc.NSE_HOLIDAYS))

    def test_sessions_skip_weekends_and_holidays(self):
        from datetime import date

        from app.services.daily_signal_engine import market_calendar as mc

        self.assertEqual(mc.session_after(date(2026, 11, 9), 3), date(2026, 11, 12))  # skips Tue 10 Nov
        self.assertEqual(mc.session_after(date(2026, 10, 23), 3), date(2026, 10, 27))  # skips the weekend
        self.assertEqual(mc.next_trading_day(date(2026, 12, 24)), date(2026, 12, 28))  # Christmas, then the weekend
        self.assertFalse(mc.is_trading_day(date(2026, 10, 20)))
