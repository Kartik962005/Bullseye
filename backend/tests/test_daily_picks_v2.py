import unittest
from unittest import mock

import pandas as pd

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
        self.assertNotIn("target and stop", html)  # forecasts carry a range and an exit line instead
        self.assertIn("A likely move from the open and an exit line for each", html)

    def test_a_sell_gets_the_tested_plan_priced_from_its_close_and_volatility(self):
        publish = {"sell": {"cut": 0.46, "confirmed": True, "plan": {"stop_vol": 1.5, "skip_gap": 0.01}}}
        forecast = {"direction": "SELL", "reference_close": 335.0}
        plan = dts._trade_plan(forecast, pd.Series({"vol20": 0.02}), 1, publish)
        self.assertAlmostEqual(plan["stop_pct"], 0.03)
        self.assertAlmostEqual(plan["stop_price"], 345.05)  # 3% above the close
        self.assertAlmostEqual(plan["skip_below"], 331.65)  # 1% under it
        # No plan where none was tested: buys, longer holds, no volatility, no rule.
        self.assertIsNone(dts._trade_plan({**forecast, "direction": "BUY"}, pd.Series({"vol20": 0.02}), 1, publish))
        self.assertIsNone(dts._trade_plan(forecast, pd.Series({"vol20": 0.02}), 3, publish))
        self.assertIsNone(dts._trade_plan(forecast, pd.Series({"vol20": float("nan")}), 1, publish))
        self.assertIsNone(dts._trade_plan(forecast, pd.Series({"vol20": 0.02}), 1, {"sell": {"cut": 0.46, "confirmed": True}}))

    def test_order_prices_are_whole_ticks(self):
        from app.services.daily_signal_engine.email_generation import _order_price

        self.assertEqual(_order_price(351.23), "₹351.25")
        self.assertEqual(_order_price(2392.73), "₹2,392.70")
        self.assertEqual(_order_price(19371.89), "₹19,372.00")
        self.assertEqual(_order_price(25012.0), "₹25,010.00")

    def test_a_planned_sell_email_shows_entry_skip_stop_and_exit(self):
        from app.services.daily_signal_engine.email_generation import build_signal_email

        forecast = {"p_beat": 0.45, "p_call": 0.55, "q10": -0.026, "q50": -0.001, "q90": 0.023, "reference_close": 335.0,
                    "low_price": 326.3, "mid_price": 334.7, "high_price": 342.7, "stop_price": 342.7, "last_session": "2026-11-05",
                    "plan": {"entry": "open", "skip_gap": 0.01, "skip_below": 331.65, "stop_pct": 0.036, "stop_price": 347.06, "exit": "close"}}
        signal = {"symbol": "TATAPOWER", "company_name": "Tata Power", "direction": "SELL", "entry_low": 335.0, "entry_high": 335.0,
                  "target_price": 334.7, "stop_loss": 347.06, "risk_reward": 1.0, "confidence": 0.55, "signal_rank": 1,
                  "explanation_json": {"forecast": forecast, "reasons": ["Weak against its sector"]}}
        note = "The sell plan was tested on 3,469 calls."
        subject, text, html = build_signal_email(signal_date="2026-11-05", market="NSE", signals=[signal], unsubscribe_url="u",
                                                 risk_level="Balanced", signal_type="1-day", plan_note=note)
        for expected in ("Sell at the 9:15 AM open", "₹331.65", "₹347.05 (+3.6%)", "No target; buy back by 3:15 PM", note):
            self.assertIn(expected, html)
        self.assertIn("stop-loss ₹347.05 (+3.6%)", text)
        self.assertNotIn("Likely move from the open", html)

    def test_the_plan_note_quotes_the_tested_plan(self):
        plan = {"calls": 3469, "first_day": "2023-10-30", "last_day": "2026-10-22", "skip_gap": 0.01, "moved_rate": 0.6031,
                "stop_rate": 0.0948, "avg_after_cost": 0.00262, "cost": 0.0015, "avg_loss": -0.01641, "worst_5pct": -0.03416}
        note = dts._plan_note({"publish": {"sell": {"cut": 0.46, "confirmed": True, "plan": plan}}})
        self.assertIn("3,469 calls (Oct 2023 to Oct 2026)", note)
        self.assertIn("moved the right way 60% of the time, hit the stop 9% of the time", note)
        self.assertIn("+0.26% a trade after 0.15% costs", note)
        self.assertIsNone(dts._plan_note({"publish": {"sell": {"cut": None, "confirmed": False, "plan": plan}}}))

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

    def runs(self, status="completed"):
        return {st: {"id": f"r{st}", "status": status, "target_date": "2026-10-14", "market": "NSE", "risk_level": "Balanced",
                     "signal_type": st, "summary": {}} for st in ("1-day", "3-day", "5-day")}

    def test_email_now_sends_every_horizon_from_stored_runs_and_never_computes(self):
        runs = self.runs()
        user = {"id": "u1", "email": "a@example.com"}
        with mock.patch.object(dts, "get_notification_preference", return_value={"user_id": "u1", "email": "a@example.com"}),              mock.patch.object(dts, "latest_run", side_effect=lambda market, risk, st: runs[st]) as latest,              mock.patch.object(dts, "_load_signals_for_run", return_value=[{"symbol": "TCS"}]),              mock.patch.object(dts, "run_daily_prediction", side_effect=AssertionError("must not compute")),              mock.patch.object(dts, "_live_forecast_record", return_value=None),              mock.patch.object(dts, "_send_digest_to_preference", return_value={"status": "sent"}) as send,              mock.patch.object(dts, "_log_audit"):
            result = dts.send_instant_signal_email(user, {"risk_level": "Balanced", "signal_type": "3-day"})
        self.assertEqual(sorted(call.args[2] for call in latest.call_args_list), ["1-day", "3-day", "5-day"])
        self.assertEqual(sorted(send.call_args.args[0]), [1, 3, 5])  # the same email as the evening one
        self.assertEqual(result["notification"]["status"], "sent")

    def test_email_now_reports_an_email_the_provider_refused(self):
        runs = self.runs()
        refused = {"status": "failed", "error": 'status=401 response={"message":"API key is invalid"}'}
        with mock.patch.object(dts, "get_notification_preference", return_value={"user_id": "u1", "email": "a@example.com"}),              mock.patch.object(dts, "latest_run", side_effect=lambda market, risk, st: runs[st]),              mock.patch.object(dts, "_load_signals_for_run", return_value=[{"symbol": "TCS"}]),              mock.patch.object(dts, "_live_forecast_record", return_value=None),              mock.patch.object(dts, "_send_digest_to_preference", return_value=refused),              mock.patch.object(dts, "_log_audit") as audit:
            with self.assertRaisesRegex(dts.EmailNotSent, "couldn't be sent"):
                dts.send_instant_signal_email({"id": "u1", "email": "a@example.com"}, {"signal_type": "1-day"})
        audit.assert_not_called()

    def test_email_now_says_when_nothing_is_built_yet(self):
        with mock.patch.object(dts, "get_notification_preference", return_value={"user_id": "u1", "email": "a@example.com"}),              mock.patch.object(dts, "latest_run", return_value=None):
            with self.assertRaisesRegex(ValueError, "no calls for the next session yet"):
                dts.send_instant_signal_email({"id": "u1", "email": "a@example.com"}, {"signal_type": "1-day"})

    def test_the_evening_email_only_combines_runs_for_the_same_session(self):
        runs = self.runs()
        runs["5-day"] = {**runs["5-day"], "target_date": "2026-10-13"}  # an older run must not join in
        with mock.patch.object(dts, "latest_run", side_effect=lambda market, risk, st: runs[st]), \
             mock.patch.object(dts, "_load_signals_for_run", return_value=[]):
            combined = dts._digest_runs("NSE", "Balanced")
        self.assertEqual(sorted(combined), [1, 3])
        items = dts._digest_items(combined)
        self.assertEqual([item["horizon"] for item in items], [1, 3, 5])
        self.assertIn("aren't ready yet", items[2]["withheld"])

    def test_each_person_gets_one_evening_email_per_session(self):
        runs = {1: (self.runs()["1-day"], [])}
        prefs = [{"user_id": "u1", "email": "a@example.com", "unsubscribe_nonce": "n"},
                 {"user_id": "u2", "email": "b@example.com", "unsubscribe_nonce": "n"}]
        with mock.patch.object(dts, "_digest_runs", return_value=runs), \
             mock.patch.object(dts, "_live_forecast_record", return_value=None), \
             mock.patch.object(dts, "_iter_preferences", return_value=prefs), \
             mock.patch.object(dts, "_daily_email_already_sent_for_target", side_effect=lambda user, target: user == "u2"), \
             mock.patch.object(dts, "_send_digest_to_preference", return_value={"status": "sent"}) as send:
            sent = dts._send_daily_digests("NSE", "Balanced", ["u1", "u2"])
        self.assertEqual(len(sent), 1)
        self.assertEqual(send.call_args.args[1]["user_id"], "u1")

    def test_the_evening_email_has_every_horizon_and_says_why_one_is_empty(self):
        from app.services.daily_signal_engine.email_generation import build_daily_digest_email

        forecast = {"p_beat": 0.45, "p_call": 0.55, "q10": -0.026, "q50": -0.001, "q90": 0.023, "reference_close": 335.0,
                    "low_price": 326.3, "mid_price": 334.7, "high_price": 342.7, "stop_price": 342.7, "last_session": "2026-11-06",
                    "plan": {"entry": "open", "skip_gap": 0.01, "skip_below": 331.65, "stop_pct": 0.036, "stop_price": 347.06, "exit": "close"}}
        sell = {"symbol": "TATAPOWER", "company_name": "Tata Power", "direction": "SELL", "signal_rank": 1,
                "explanation_json": {"forecast": forecast, "reasons": ["Weak against its sector"]}}
        horizons = [
            {"horizon": 1, "signals": [sell], "notes": {"buy": "Buy calls are paused for now."},
             "captions": {"sell": "Sell calls like these fell 60% of the time in testing."}, "last_session": "2026-11-06"},
            {"horizon": 3, "signals": [], "notes": {"buy": "3-day buys are paused for this horizon."}, "last_session": "2026-11-11"},
            {"horizon": 5, "signals": [], "notes": {"buy": "5-day buys are paused for this horizon."}, "last_session": "2026-11-13"},
        ]
        record = {"calls": 5, "since": "2026-10-29", "sell": {"calls": 5, "right": 3, "moved_calls": 5, "moved": 3},
                  "plan": {"calls": 5, "taken": 4, "skipped": 1, "stopped": 1, "wins": 3, "avg_pct": 0.42},
                  "sessions": [{"date": "2026-11-05", "moved": 3, "right": 3, "plan_avg_pct": 0.42, "calls": [
                      {"symbol": "LICI", "direction": "SELL", "right": True, "moved": True, "move_pct": -1.2, "plan": "held", "plan_pct": 1.05},
                      {"symbol": "MCX", "direction": "SELL", "right": False, "moved": False, "move_pct": 2.1, "plan": "stopped", "plan_pct": -3.75},
                      {"symbol": "INDIGO", "direction": "SELL", "right": False, "moved": False, "move_pct": 0.4, "plan": "skipped"}]}]}
        subject, text, html = build_daily_digest_email(target_date="2026-11-06", market="NSE", risk_level="Balanced",
                                                       horizons=horizons, unsubscribe_url="u", data_date="2026-11-05", record=record)
        self.assertEqual(subject, "Bullseye calls for Fri 06 Nov: 1 intraday sell")
        for expected in ("Intraday · Fri 06 Nov", "3 days · Fri 06 Nov to Wed 11 Nov", "5 days · Fri 06 Nov to Fri 13 Nov",
                         "Sell calls (1)", "Buy calls · none today", "3-day buys are paused", "5-day buys are paused",
                         "Sell at the 9:15 AM open", "₹347.05 (+3.6%)", "How recent calls did",
                         "Thu 05 Nov: 1 of 3 sells fell, the sell plan averaged +0.4% a trade", "stopped out -3.8%",
                         "plan skipped it", "Since Thu 29 Oct: 3 of 5 sells fell (60%)"):
            self.assertIn(expected, html)
        self.assertIn("INTRADAY · FRI 06 NOV", text)
        self.assertIn("No sell calls for 3-day holds", text)

    def test_the_evening_email_with_no_calls_says_so_in_the_subject(self):
        from app.services.daily_signal_engine.email_generation import build_daily_digest_email

        horizons = [{"horizon": h, "signals": [], "notes": {"buy": "Paused."}, "last_session": "2026-11-06"} for h in (1, 3, 5)]
        subject, text, html = build_daily_digest_email(target_date="2026-11-06", market="NSE", risk_level="Balanced",
                                                       horizons=horizons, unsubscribe_url="u")
        self.assertEqual(subject, "Bullseye for Fri 06 Nov: no call passed the bar")
        self.assertIn("Sell calls · none today", html)


if __name__ == "__main__":
    unittest.main()
