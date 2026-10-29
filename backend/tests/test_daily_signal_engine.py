from datetime import datetime, timedelta, timezone
import unittest
from unittest import mock

from app.services.daily_signal_engine.diversification import diversify_candidates
from app.services.daily_signal_engine.scoring import adjusted_win_rate, compute_expected_r
from app.services.daily_signal_engine.technical_rules import evaluate_technical_setup
from app.services import daily_trade_service as dts
from app.services.daily_trade_service import (
    _build_unsubscribe_token,
    _decode_unsubscribe_token,
    _email_already_sent,
    _ensure_delivery_consent,
    _has_delivery_consent,
    _validate_email_time,
)


class DailySignalEngineTests(unittest.TestCase):
    def test_adjusted_win_rate_shrinks_toward_universe_average(self):
        result = adjusted_win_rate(wins=2, trades=2, universe_average_win_rate=0.52, k=20)
        self.assertAlmostEqual(result, (2 + 20 * 0.52) / 22, places=6)

    def test_expected_r_penalizes_costs(self):
        result = compute_expected_r(0.62, 0.24, 1.8, 1.0, transaction_cost_r=0.03, slippage_r=0.02)
        self.assertAlmostEqual(result, 0.62 * 1.8 - 0.24 * 1.0 - 0.03 - 0.02, places=6)

    def test_diversification_caps_sector_and_skips_correlated_duplicates(self):
        base_returns = [0.01, 0.012, 0.011, 0.014, 0.009, 0.013, 0.015, 0.01, 0.008, 0.014, 0.009, 0.01]
        candidates = [
            {"symbol": "AAA", "sector": "Tech", "final_score": 0.91, "recent_returns": base_returns},
            {"symbol": "BBB", "sector": "Tech", "final_score": 0.89, "recent_returns": [value * 0.99 for value in base_returns]},
            {"symbol": "CCC", "sector": "Tech", "final_score": 0.88, "recent_returns": [value * 1.01 for value in base_returns]},
            {"symbol": "DDD", "sector": "Banks", "final_score": 0.87, "recent_returns": [-0.01, 0.005, -0.004, 0.008, -0.003, 0.004, 0.007, -0.005, 0.006, -0.002, 0.004, -0.001]},
        ]
        selected = diversify_candidates(candidates)
        self.assertEqual([item["symbol"] for item in selected], ["AAA", "DDD"])

    def test_unsubscribe_token_round_trip(self):
        token = _build_unsubscribe_token("user-123", "nonce-abc")
        user_id, nonce = _decode_unsubscribe_token(token)
        self.assertEqual(user_id, "user-123")
        self.assertEqual(nonce, "nonce-abc")

    def test_email_time_must_be_after_market_close(self):
        self.assertEqual(_validate_email_time("NSE", "18:00"), "18:00")
        with self.assertRaises(ValueError):
            _validate_email_time("NSE", "15:45")

    def test_mixed_setup_does_not_become_buy_by_tie_break(self):
        setup = evaluate_technical_setup(
            {
                "close": 100,
                "ema20": 100,
                "ema50": 100,
                "resistance20": 110,
                "support20": 90,
                "volume": 1000,
                "vol_avg20": 1000,
                "rsi14": 50,
                "adx14": 10,
            },
            relative_strength=0,
            sector_strength=0,
        )
        self.assertEqual(setup["direction"], "HOLD")
        self.assertEqual(setup["setup_type"], "no_trade")

    def test_enabled_legacy_preference_counts_as_delivery_consent(self):
        preference = {
            "user_id": "user-legacy",
            "email": "legacy@example.com",
            "daily_stock_email_enabled": True,
            "updated_at": "2026-06-03T12:00:00+00:00",
        }
        self.assertTrue(_has_delivery_consent(preference))
        original_supabase = dts.supabase
        dts.supabase = None
        try:
            updated = _ensure_delivery_consent(preference)
            self.assertEqual(updated["consent_accepted_at"], "2026-06-03T12:00:00+00:00")
            self.assertIn("legacy", updated["consent_version"])
        finally:
            dts.supabase = original_supabase

    def test_failed_email_log_does_not_block_daily_retry(self):
        original_supabase = dts.supabase
        original_logs = list(dts._MEMORY_EMAIL_LOGS)
        dts.supabase = None
        dts._MEMORY_EMAIL_LOGS = [
            {
                "user_id": "user-123",
                "model_run_id": "run-123",
                "email_kind": "daily_signal",
                "status": "failed",
            }
        ]
        try:
            self.assertFalse(_email_already_sent("user-123", "run-123"))
            dts._MEMORY_EMAIL_LOGS[0]["status"] = "sent"
            self.assertTrue(_email_already_sent("user-123", "run-123"))
        finally:
            dts.supabase = original_supabase
            dts._MEMORY_EMAIL_LOGS = original_logs

    def test_scheduled_alerts_count_only_provider_sent_as_sent(self):
        original_iter_preferences = dts._iter_preferences
        original_dedupe = dts._daily_email_already_sent_for_target
        original_run_daily_prediction = dts.run_daily_prediction
        preferences = [
            {
                "user_id": "user-sent",
                "email": "sent@example.com",
                "daily_stock_email_enabled": True,
                "market": "NSE",
                "risk_level": "Balanced",
                "signal_type": "Next-day swing",
                "email_time": "18:00",
                "consent_accepted_at": "2026-06-03T12:00:00+00:00",
            },
            {
                "user_id": "user-failed",
                "email": "failed@example.com",
                "daily_stock_email_enabled": True,
                "market": "NSE",
                "risk_level": "Balanced",
                "signal_type": "Next-day swing",
                "email_time": "18:00",
                "consent_accepted_at": "2026-06-03T12:00:00+00:00",
            },
        ]

        def fake_run_daily_prediction(**kwargs):
            self.assertEqual(set(kwargs["user_ids"]), {"user-sent", "user-failed"})
            return {
                "notifications": [
                    {"user_id": "user-sent", "status": "sent", "provider": "resend"},
                    {"user_id": "user-failed", "status": "failed", "provider": "resend"},
                ]
            }

        dts._iter_preferences = lambda: preferences
        dts._daily_email_already_sent_for_target = lambda user_id, target_date, email_kind="daily_signal": False
        dts.run_daily_prediction = fake_run_daily_prediction
        try:
            with mock.patch.object(dts, "_failed_daily_sends", return_value=[]):
                result = dts.process_scheduled_daily_alerts(force=True)
            self.assertEqual(result["attempted"], 2)
            self.assertEqual(result["sent"], 1)
            self.assertEqual(result["failed"], 1)
            self.assertEqual(result["delivery"], {"attempted": 2, "sent": 1, "failed": 1, "skipped": 0, "other": 0})
        finally:
            dts._iter_preferences = original_iter_preferences
            dts._daily_email_already_sent_for_target = original_dedupe
            dts.run_daily_prediction = original_run_daily_prediction

    def test_scheduled_alerts_space_out_retries_and_stop_after_three(self):
        def preference(user_id):
            return {"user_id": user_id, "email": f"{user_id}@example.com", "daily_stock_email_enabled": True, "market": "NSE",
                    "risk_level": "Balanced", "signal_type": "1-day", "email_time": "18:00",
                    "consent_accepted_at": "2026-06-03T12:00:00+00:00"}

        target = dts._next_trading_day(datetime.now(dts.IST).date()).isoformat()

        def failed(user_id, minutes_ago):
            sent_at = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()
            return {"user_id": user_id, "model_run_id": "r", "email_kind": "daily_signal",
                    "target_date": target, "status": "failed", "sent_at": sent_at}

        logs = [
            failed("just-failed", 5),
            failed("failed-a-while-ago", 45),
            *[failed("failed-three-times", minutes) for minutes in (100, 70, 40)],
        ]
        due = []
        with mock.patch.object(dts, "supabase", None), \
             mock.patch.object(dts, "_MEMORY_EMAIL_LOGS", logs), \
             mock.patch.object(dts, "_iter_preferences", return_value=[preference(u) for u in ("just-failed", "failed-a-while-ago", "failed-three-times", "new")]), \
             mock.patch.object(dts, "run_daily_prediction", side_effect=lambda **kw: due.extend(kw["user_ids"]) or {"notifications": []}):
            result = dts.process_scheduled_daily_alerts(force=True)
        self.assertEqual(sorted(due), ["failed-a-while-ago", "new"])
        self.assertEqual(result["skipped"]["retry_later"], 1)
        self.assertEqual(result["skipped"]["gave_up"], 1)


if __name__ == "__main__":
    unittest.main()
