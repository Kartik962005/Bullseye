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

    def test_forecasts_publish_every_day_with_their_ranges(self):
        import pandas as pd

        predictions = pd.DataFrame({
            "ticker": ["TCS.NS", "INFY.NS"], "sector": ["Technology", "Technology"], "date": ["2026-10-20"] * 2,
            "close": [3000.0, 1500.0], "p_beat": [0.58, 0.41], "q10": [-0.02, -0.03], "q50": [0.002, -0.004],
            "q90": [0.025, 0.02], "rel_strength": [3.0, -2.5], "ret20": [0.05, -0.03], "rsi": [0.6, 0.4],
            "close_to_ema20": [0.01, -0.02], "vol_ratio": [1.1, 0.9], "sector_above_ema50": [0.6, 0.6],
        })
        artifact = {"calibration": [{"p_min": 0.56, "p_max": 1.0, "actual_beat_rate": 0.55, "samples": 900}]}
        stored = {}
        with mock.patch.object(dts, "_session_complete", return_value=True),              mock.patch.object(dts, "_find_existing_run", return_value=None),              mock.patch.object(dts.forecast_engine, "load_artifact", return_value=artifact),              mock.patch.object(dts, "_forecast_universe", return_value=predictions),              mock.patch.object(dts, "_store_model_run", side_effect=lambda run, rows: stored.update(run=run, rows=rows) or run),              mock.patch.object(dts, "_log_audit"):
            result = dts.run_daily_prediction(signal_type="1-day", risk_level="Aggressive")
        self.assertEqual(result["model_run"]["status"], "completed")
        rows = {r["symbol"]: r for r in stored["rows"]}
        self.assertEqual(rows["TCS"]["signal_rank"], 1)  # higher chance to beat ranks first
        self.assertEqual(rows["INFY"]["signal_rank"], 2)
        self.assertEqual(rows["TCS"]["explanation_json"]["forecast"]["typical_p_beat"], 0.495)
        forecast = rows["TCS"]["explanation_json"]["forecast"]
        self.assertEqual((forecast["low_price"], forecast["high_price"]), (2940.0, 3075.0))
        self.assertEqual(forecast["tested"]["actual_beat_rate"], 0.55)

    def test_no_run_while_the_session_is_open(self):
        with mock.patch.object(dts, "_session_complete", return_value=False):
            result = dts.run_daily_prediction(signal_type="5-day")
        self.assertTrue(result["skipped"])

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

    def test_email_now_explains_a_withheld_horizon(self):
        run = {"id": "r1", "status": "withheld", "summary": {"withheld_reason": "No edge in testing."}}
        with mock.patch.object(dts, "get_notification_preference", return_value={"user_id": "u1", "email": "a@example.com"}), \
             mock.patch.object(dts, "latest_run", return_value=run):
            with self.assertRaisesRegex(ValueError, "No edge in testing"):
                dts.send_instant_signal_email({"id": "u1", "email": "a@example.com"}, {"signal_type": "1-day"})


if __name__ == "__main__":
    unittest.main()
