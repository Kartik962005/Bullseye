import unittest
from unittest import mock

from app.services import daily_trade_service as dts
from app.services.daily_signal_engine.backtest import _grade_limit_entry
from app.services.daily_signal_engine.config import (
    entry_zone,
    horizon_barrier_scale,
    horizon_from_signal_type,
    is_publishable_setup,
    signal_type_for_horizon,
)


def bar(o, h, l, c):
    return {"open": o, "high": h, "low": l, "close": c}


BUY = {"direction": "BUY", "target_price": 110, "stop_loss": 95, "entry_low": 98, "entry_high": 101}


class HorizonTests(unittest.TestCase):
    def test_signal_types_round_trip_and_legacy_maps_to_five(self):
        for h in (1, 3, 5):
            self.assertEqual(horizon_from_signal_type(signal_type_for_horizon(h)), h)
        for legacy in ("Next-day swing", "Intraday", "Both", None, ""):
            self.assertEqual(horizon_from_signal_type(legacy), 5)
        self.assertEqual(dts._normalize_signal_type("Intraday"), "5-day")

    def test_barriers_and_entry_zone_shrink_with_the_horizon(self):
        self.assertAlmostEqual(horizon_barrier_scale(5), 1.0)
        self.assertLess(horizon_barrier_scale(1), horizon_barrier_scale(3))
        low5, high5 = entry_zone("BUY", 100, 2, 5)
        low1, high1 = entry_zone("BUY", 100, 2, 1)
        self.assertEqual((round(low5, 2), round(high5, 2)), (99.7, 100.4))
        self.assertLess(high1 - low1, high5 - low5)

    def test_markets_other_than_nse_resolve_to_nse(self):
        self.assertEqual(dts._normalize_market("US"), "NSE")
        self.assertEqual(dts._normalize_market("bse"), "NSE")
        with self.assertRaises(ValueError):
            dts._normalize_market("LSE")

    def test_hold_setups_are_not_publishable(self):
        self.assertFalse(is_publishable_setup({"direction": "HOLD", "directional_edge": 5, "chart_setup_quality": 0.9}))
        self.assertFalse(is_publishable_setup({"direction": "BUY", "directional_edge": 1, "chart_setup_quality": 0.9}))
        self.assertTrue(is_publishable_setup({"direction": "SELL", "directional_edge": -3, "chart_setup_quality": 0.7}))


class LimitEntryGradingTests(unittest.TestCase):
    def test_fill_at_open_then_target(self):
        out = _grade_limit_entry(BUY, [bar(100, 103, 99, 102), bar(102, 111, 101, 110)])
        self.assertEqual((out["outcome"], out["realized_r"], out["fill"]), ("WIN", 2.0, 100.0))

    def test_gap_above_the_zone_never_fills(self):
        self.assertEqual(_grade_limit_entry(BUY, [bar(104, 106, 103, 105)])["outcome"], "NO_FILL")

    def test_gap_below_the_zone_is_skipped(self):
        self.assertEqual(_grade_limit_entry(BUY, [bar(97, 99, 96, 98)])["outcome"], "NO_FILL")

    def test_intraday_fill_cannot_win_on_the_fill_bar(self):
        out = _grade_limit_entry(BUY, [bar(104, 112, 100.5, 108)])
        self.assertEqual(out["outcome"], "TIME_EXIT")

    def test_both_levels_on_one_bar_is_a_loss(self):
        self.assertEqual(_grade_limit_entry(BUY, [bar(100, 111, 94, 100)])["outcome"], "LOSS")


class RunTests(unittest.TestCase):
    def test_missing_forecast_models_record_a_withheld_run(self):
        stored = {}
        with mock.patch.object(dts, "_session_complete", return_value=True),              mock.patch.object(dts, "_find_existing_run", return_value=None),              mock.patch.object(dts.forecast_engine, "load_artifact", return_value=None),              mock.patch.object(dts, "_forecast_universe", side_effect=AssertionError("must not run")),              mock.patch.object(dts, "_store_model_run", side_effect=lambda run, rows: stored.update(run=run, rows=rows) or run),              mock.patch.object(dts, "_log_audit"):
            result = dts.run_daily_prediction(signal_type="1-day")
        self.assertEqual(result["model_run"]["status"], "withheld")
        self.assertEqual(stored["rows"], [])

    def test_intraday_run_publishes_buy_and_sell_calls_with_their_window(self):
        import pandas as pd

        predictions = pd.DataFrame({
            "ticker": ["TCS.NS", "INFY.NS", "SBIN.NS"], "sector": ["IT", "IT", "Banks"], "date": ["2026-10-23"] * 3,
            "close": [3000.0, 1500.0, 800.0], "p_beat": [0.58, 0.47, 0.41], "rank_score": [0.6, 0.5, 0.4],
            "q10": [-0.02, -0.03, -0.025], "q50": [0.002, -0.004, -0.003], "q90": [0.025, 0.02, 0.02],
            "rel_strength": [3.0, -2.5, -4.0], "ret20": [0.05, -0.03, -0.06], "rsi": [0.6, 0.4, 0.35],
            "close_to_sma200": [0.08, -0.02, -0.05], "dist_52w_high": [-0.02, -0.2, -0.35], "vol_ratio": [1.1, 0.9, 1.8],
        })
        artifact = {"calibration": [{"p_min": 0.55, "p_max": 1.0, "actual_beat_rate": 0.56, "samples": 900},
                                    {"p_min": 0.0, "p_max": 0.45, "actual_beat_rate": 0.43, "samples": 800}]}
        stored = {}
        with mock.patch.object(dts, "_session_complete", return_value=True), \
             mock.patch.object(dts, "_last_completed_session", return_value=__import__("datetime").date(2026, 10, 23)), \
             mock.patch.object(dts, "_find_existing_run", return_value=None), \
             mock.patch.object(dts.forecast_engine, "load_artifact", return_value=artifact), \
             mock.patch.object(dts, "_forecast_universe", return_value=predictions), \
             mock.patch.object(dts, "_live_forecast_record", return_value={"calls": 0}), \
             mock.patch.object(dts, "MAX_SELECTED_SIGNALS", 1), \
             mock.patch.object(dts, "_store_model_run", side_effect=lambda run, rows: stored.update(run=run, rows=rows) or run), \
             mock.patch.object(dts, "_log_audit"):
            result = dts.run_daily_prediction(signal_type="1-day", risk_level="Aggressive", target_day=__import__("datetime").date(2026, 10, 26))
        run = result["model_run"]
        self.assertEqual(run["status"], "completed")
        self.assertEqual(run["summary"]["last_session"], "2026-10-26")
        rows = {r["direction"]: r for r in stored["rows"]}
        self.assertEqual(rows["BUY"]["symbol"], "TCS")
        self.assertEqual(rows["SELL"]["symbol"], "SBIN")
        sell = rows["SELL"]["explanation_json"]["forecast"]
        self.assertAlmostEqual(sell["p_call"], 0.59)
        self.assertEqual(sell["stop_price"], sell["high_price"])  # a sell's exit line is the high case
        self.assertEqual(sell["tested"]["call_rate"], 0.57)

    def test_default_run_keeps_its_would_be_calls_and_recent_record(self):
        import pandas as pd

        predictions = pd.DataFrame({
            "ticker": ["TCS.NS", "INFY.NS", "SBIN.NS"], "sector": ["IT", "IT", "Banks"], "date": ["2026-10-29"] * 3,
            "close": [3000.0, 1500.0, 800.0], "p_beat": [0.58, 0.47, 0.41], "rank_score": [0.6, 0.5, 0.4],
            "q10": [-0.02, -0.03, -0.025], "q50": [0.002, -0.004, -0.003], "q90": [0.025, 0.02, 0.02],
        })
        daily = [[day, 5, 3, 3] for day in pd.bdate_range("2026-04-01", periods=120).strftime("%Y-%m-%d")]
        artifact = {"calibration": [], "publish": {
            "max_per_day": 5, "sector_cap": 2, "bar": 0.55,
            "buy": {"cut": None, "confirmed": False, "best": {"right_rate": 0.54, "market_rate": 0.54}},
            "sell": {"cut": 0.46, "confirmed": True, "confirmation": {"right_rate": 0.6, "market_rate": 0.6},
                     "recent": {"daily": daily}},
        }}
        stored = {}
        with mock.patch.object(dts, "_session_complete", return_value=True), \
             mock.patch.object(dts, "_last_completed_session", return_value=__import__("datetime").date(2026, 10, 29)), \
             mock.patch.object(dts, "_find_existing_run", return_value=None), \
             mock.patch.object(dts.forecast_engine, "load_artifact", return_value=artifact), \
             mock.patch.object(dts, "_forecast_universe", return_value=predictions), \
             mock.patch.object(dts, "_live_forecast_record", return_value={"calls": 0}), \
             mock.patch.object(dts, "_tracked_sessions", return_value=[]), \
             mock.patch.object(dts, "_store_model_run", side_effect=lambda run, rows: stored.update(run=run, rows=rows) or run), \
             mock.patch.object(dts, "_log_audit"):
            run = dts.run_daily_prediction(signal_type="1-day", risk_level=dts.DEFAULT_RISK_LEVEL,
                                           target_day=__import__("datetime").date(2026, 10, 30))["model_run"]
        self.assertEqual([r["symbol"] for r in stored["rows"]], ["SBIN"])
        self.assertEqual(run["summary"]["tracking"], {"sell": ["SBIN.NS"]})
        recent = run["summary"]["publish"]["sell"]["recent"]
        self.assertTrue(recent["passes"])
        self.assertEqual((recent["sessions"], recent["calls"]), (120, 600))
        self.assertNotIn("daily", recent)

    def test_five_day_window_skips_weekends_and_holidays(self):
        from datetime import date

        from app.services.daily_signal_engine import market_calendar as mc

        self.assertEqual(mc.session_after(date(2026, 11, 9), 5), date(2026, 11, 16))

    def test_no_run_while_the_session_is_open(self):
        with mock.patch.object(dts, "_session_complete", return_value=False):
            result = dts.run_daily_prediction(signal_type="5-day")
        self.assertTrue(result["skipped"])

    def test_catch_up_builds_a_missing_run_during_the_session(self):
        with mock.patch.object(dts, "_session_complete", return_value=False), \
             mock.patch.object(dts, "_find_existing_run", return_value=None), \
             mock.patch.object(dts.forecast_engine, "load_artifact", return_value=None), \
             mock.patch.object(dts, "_store_model_run", side_effect=lambda run, rows: run), \
             mock.patch.object(dts, "_log_audit"):
            result = dts.run_daily_prediction(signal_type="5-day", catch_up=True)
        self.assertNotIn("skipped", result)

    def test_a_run_saved_without_all_its_calls_is_rebuilt(self):
        partial = {"id": "old", "target_date": "2026-10-28", "model_version": "forecast-v3-h3", "selected_count": 10}
        stored = {}
        with mock.patch.object(dts, "_session_complete", return_value=False), \
             mock.patch.object(dts, "_last_completed_session", return_value=__import__("datetime").date(2026, 10, 27)), \
             mock.patch.object(dts, "_find_existing_run", return_value=partial), \
             mock.patch.object(dts, "_load_signals_for_run", return_value=[{"symbol": "TCS"}]), \
             mock.patch.object(dts.forecast_engine, "load_artifact", return_value=None), \
             mock.patch.object(dts, "_store_model_run", side_effect=lambda run, rows: stored.update(run=run) or run), \
             mock.patch.object(dts, "_log_audit"):
            result = dts.run_daily_prediction(signal_type="3-day", catch_up=True)
        self.assertFalse(result.get("cached"))
        self.assertNotEqual(stored["run"]["id"], "old")

    def test_no_intraday_catch_up_once_the_session_has_opened(self):
        with mock.patch.object(dts, "_session_complete", return_value=False), \
             mock.patch.object(dts, "_session_started", return_value=True), \
             mock.patch.object(dts, "_store_model_run", side_effect=AssertionError("must not build")):
            result = dts.run_daily_prediction(signal_type="1-day", catch_up=True)
        self.assertTrue(result["skipped"])

    def test_prepared_runs_are_not_looked_up_again_until_the_next_close(self):
        calls = []
        with mock.patch.object(dts, "_PREPARED_FOR", None), mock.patch.object(dts, "_PREPARE_FAILED_AT", None), \
             mock.patch.object(dts, "run_daily_prediction", side_effect=lambda **kw: calls.append(kw) or {"model_run": {}, "cached": True}):
            dts.prepare_daily_runs()
            second = dts.prepare_daily_runs()
        self.assertEqual(len(calls), 9)
        self.assertTrue(second["skipped"])

    def test_forecast_email_shows_moves_from_the_open(self):
        from app.services.daily_signal_engine.email_generation import build_signal_email

        forecast = {"p_beat": 0.41, "p_call": 0.59, "q10": -0.018, "q50": -0.001, "q90": 0.021, "reference_close": 500.0,
                    "low_price": 491.0, "mid_price": 499.5, "high_price": 510.5, "stop_price": 510.5, "last_session": "2026-10-29",
                    "tested": {"call_rate": 0.595, "samples": 6232}}
        signal = {"symbol": "TCS", "company_name": "TCS", "direction": "SELL", "entry_low": 500.0, "entry_high": 500.0,
                  "target_price": 499.5, "stop_loss": 510.5, "risk_reward": 1.0, "confidence": 0.59, "signal_rank": 1,
                  "explanation_json": {"forecast": forecast, "reasons": ["Weak against its sector"]}}
        subject, text, html = build_signal_email(signal_date="2026-10-29", market="NSE", signals=[signal], unsubscribe_url="u",
                                                 risk_level="Balanced", signal_type="1-day")
        self.assertIn("Likely move from the open", html)
        self.assertIn("-1.8% to +2.1%", text)
        self.assertIn("+2.1% from the open", text)  # a sell's exit line is the high case
        self.assertNotIn("Expected", html)

    def test_email_with_no_calls_says_why(self):
        from app.services.daily_signal_engine.email_generation import build_signal_email

        note = "Buy calls are paused for this horizon."
        subject, text, html = build_signal_email(signal_date="2026-10-29", market="NSE", signals=[], unsubscribe_url="u",
                                                 risk_level="Balanced", signal_type="3-day", empty_note=note)
        self.assertIn("no strong calls", subject)
        self.assertIn(note, html)
        self.assertIn(note, text)

    def test_email_time_reads_both_form_and_database_formats(self):
        self.assertEqual(dts._parse_time_string("20:00").hour, 20)
        self.assertEqual(dts._parse_time_string("20:15:00").minute, 15)

    def test_email_now_sends_stored_picks_and_never_computes(self):
        run = {"id": "r1", "status": "completed", "target_date": "2026-10-14", "market": "NSE", "risk_level": "Balanced", "signal_type": "3-day"}
        user = {"id": "u1", "email": "a@example.com"}
        with mock.patch.object(dts, "get_notification_preference", return_value={"user_id": "u1", "email": "a@example.com"}), \
             mock.patch.object(dts, "latest_run", return_value=run) as latest, \
             mock.patch.object(dts, "_load_signals_for_run", return_value=[{"symbol": "TCS"}]), \
             mock.patch.object(dts, "run_daily_prediction", side_effect=AssertionError("must not compute")), \
             mock.patch.object(dts, "_send_signal_email_to_preference", return_value={"status": "sent"}) as send, \
             mock.patch.object(dts, "_log_audit"):
            result = dts.send_instant_signal_email(user, {"risk_level": "Balanced", "signal_type": "3-day"})
        latest.assert_called_once_with("NSE", "Balanced", "3-day")
        send.assert_called_once()
        self.assertEqual(result["notification"]["status"], "sent")

    def test_email_now_reports_an_email_the_provider_refused(self):
        run = {"id": "r1", "status": "completed", "target_date": "2026-10-14", "market": "NSE", "risk_level": "Balanced", "signal_type": "1-day"}
        refused = {"status": "failed", "error": 'status=401 response={"message":"API key is invalid"}'}
        with mock.patch.object(dts, "get_notification_preference", return_value={"user_id": "u1", "email": "a@example.com"}), \
             mock.patch.object(dts, "latest_run", return_value=run), \
             mock.patch.object(dts, "_load_signals_for_run", return_value=[{"symbol": "TCS"}]), \
             mock.patch.object(dts, "_send_signal_email_to_preference", return_value=refused), \
             mock.patch.object(dts, "_log_audit") as audit:
            with self.assertRaisesRegex(dts.EmailNotSent, "couldn't be sent"):
                dts.send_instant_signal_email({"id": "u1", "email": "a@example.com"}, {"signal_type": "1-day"})
        audit.assert_not_called()

    def test_email_now_explains_a_withheld_horizon(self):
        run = {"id": "r1", "status": "withheld", "summary": {"withheld_reason": "No edge in testing."}}
        with mock.patch.object(dts, "get_notification_preference", return_value={"user_id": "u1", "email": "a@example.com"}), \
             mock.patch.object(dts, "latest_run", return_value=run):
            with self.assertRaisesRegex(ValueError, "No edge in testing"):
                dts.send_instant_signal_email({"id": "u1", "email": "a@example.com"}, {"signal_type": "1-day"})


if __name__ == "__main__":
    unittest.main()
