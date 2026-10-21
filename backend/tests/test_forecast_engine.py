import unittest

import numpy as np
import pandas as pd

from app.services import daily_trade_service as dts
from app.services.daily_signal_engine import forecast as fc


def synthetic_prices(n_days=260, seed=1, drift=0.0005):
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
        df = fc.forecast_frame(self.frames, self.index, breadth_universe=set(self.frames), horizons=(1, 3))
        self.assertFalse(df.empty)
        self.assertTrue(set(fc.FORECAST_FEATURES).issubset(df.columns))
        self.assertFalse(df[fc.FORECAST_FEATURES].isna().any().any())
        one = df[df["ticker"] == "S0.NS"].reset_index(drop=True)
        i = 10
        expected = one.loc[i + 3, "close"] / one.loc[i + 1, "open"] - 1
        self.assertAlmostEqual(one.loc[i, "fwd_3"], expected, places=10)

    def test_live_rows_match_training_rows_for_the_same_day(self):
        train = fc.forecast_frame(self.frames, self.index, breadth_universe=set(self.frames), horizons=(1,))
        cut = train["date"].unique()[-5]
        live_frames = {t: f[f["date"] <= cut] for t, f in self.frames.items()}
        live = fc.forecast_frame(live_frames, self.index[self.index["date"] <= cut], breadth_universe=set(self.frames))
        a = train[train["date"] == cut].set_index("ticker")[fc.FORECAST_FEATURES].sort_index()
        b = live[live["date"] == cut].set_index("ticker")[fc.FORECAST_FEATURES].sort_index()
        pd.testing.assert_frame_equal(a, b, check_exact=False, rtol=1e-9)


class SelectionTests(unittest.TestCase):
    def predictions(self):
        return pd.DataFrame({
            "ticker": [f"T{i}.NS" for i in range(8)],
            "sector": ["A", "A", "A", "A", "B", "B", "C", "C"],
            "p_beat": [0.70, 0.68, 0.66, 0.64, 0.30, 0.52, 0.55, 0.50],
            "q10": [-0.02, -0.02, -0.02, -0.02, -0.05, -0.01, -0.08, -0.01],
            "q90": [0.03, 0.03, 0.03, 0.03, 0.04, 0.01, 0.09, 0.01],
        })

    def test_most_likely_to_beat_first_at_most_three_per_sector(self):
        picked = dts._select_forecasts(self.predictions(), "Aggressive")
        self.assertLessEqual((picked["sector"] == "A").sum(), 3)
        self.assertEqual(list(picked["ticker"])[:3], ["T0.NS", "T1.NS", "T2.NS"])
        self.assertLessEqual(len(picked), dts.MAX_SELECTED_SIGNALS)
        self.assertTrue(picked["p_beat"].is_monotonic_decreasing)  # highest chance first

    def test_ties_are_broken_by_the_underlying_score(self):
        preds = self.predictions().assign(p_beat=0.55, rank_score=[0.1, 0.9, 0.5, 0.2, 0.3, 0.4, 0.6, 0.7])
        picked = dts._select_forecasts(preds, "Aggressive")
        self.assertEqual(picked.iloc[0]["ticker"], "T1.NS")

    def test_conservative_drops_the_widest_ranges(self):
        picked = dts._select_forecasts(self.predictions(), "Conservative")
        self.assertNotIn("T6.NS", set(picked["ticker"]))


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

    def test_lag_call_that_beat_the_market_outside_the_range(self):
        out = dts._grade_forecast(self.signal("SELL"), self.bars([(100, 120, 99, 112)]), 1, 0.0)
        self.assertEqual(out["outcome"], "LOSS")
        self.assertAlmostEqual(out["realized_r"], -12.0)
        self.assertIn("out_of_range", out["hit_sequence"])


if __name__ == "__main__":
    unittest.main()
