"""Calibrate the forecast's middle and range out of sample, then confirm.

The quantile models rank stocks' likely moves sensibly, but their median is
overconfident at the extremes (a predicted +1.2% over 3 sessions was really
about +0.35%). This script:

  1. walks forward over the last ~2 years, predicting the 10/50/90 percentile
     returns with fold models that never saw the test days;
  2. on the first year, fits a linear correction that pulls the predicted
     median toward the actual median (shrinkage), then the stretch of the band
     around that corrected middle that holds 80% of outcomes;
  3. reports the second year, untouched, and writes the factors into the saved
     artifacts and reports.

    cd backend
    python scripts/calibrate_ranges.py
"""
from __future__ import annotations

import json
import os
import sys

import joblib
import numpy as np
import pandas as pd

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
sys.path.insert(0, _BACKEND)

from sklearn.ensemble import HistGradientBoostingRegressor  # noqa: E402

from app.services.daily_signal_engine.forecast import FORECAST_FEATURES, HORIZONS, QUANTILES, calibrate_range, forecast_frame  # noqa: E402

ARTIFACT_DIR = os.path.join(_BACKEND, "app", "services", "daily_signal_engine", "artifacts")
WINDOW_DAYS = 500
STEP_DAYS = 125
TARGET = 0.80


def fold_quantiles(data: pd.DataFrame, dates: list[str], h: int) -> pd.DataFrame:
    out = []
    for start in range(len(dates) - WINDOW_DAYS, len(dates), STEP_DAYS):
        cut = dates[start - h - 1]
        train = data[data["date"] <= cut]
        train = train.sample(min(len(train), 200_000), random_state=3)
        test = data[data["date"].isin(dates[start:start + STEP_DAYS])].copy()
        for level in QUANTILES:
            model = HistGradientBoostingRegressor(
                loss="quantile", quantile=level, learning_rate=0.05, max_iter=250, max_leaf_nodes=15,
                min_samples_leaf=600, l2_regularization=2.0, random_state=7,
            ).fit(train[FORECAST_FEATURES], train[f"fwd_{h}"])
            test[f"raw_{int(level * 100)}"] = model.predict(test[FORECAST_FEATURES])
        out.append(test)
        print(f"  {h}d fold {dates[start]}..{dates[min(start + STEP_DAYS, len(dates)) - 1]}", flush=True)
    return pd.concat(out, ignore_index=True)


def fit_center(frame: pd.DataFrame, h: int) -> tuple[float, float]:
    """Linear map predicted median -> actual median, fitted on 20 bands of predicted median."""
    bands = pd.qcut(frame["raw_50"], 20, labels=False, duplicates="drop")
    table = frame.groupby(bands).agg(x=("raw_50", "mean"), y=(f"fwd_{h}", "median"), w=("raw_50", "size"))
    slope, intercept = np.polyfit(table["x"], table["y"], 1, w=np.sqrt(table["w"]))
    return float(intercept), float(np.clip(slope, 0.0, 1.0))


def apply(frame: pd.DataFrame, intercept: float, slope: float, scale: float) -> np.ndarray:
    raw = frame[["raw_10", "raw_50", "raw_90"]].to_numpy()
    return calibrate_range(raw, intercept, slope, scale)


def fit_scale(frame: pd.DataFrame, h: int, intercept: float, slope: float) -> float:
    y = frame[f"fwd_{h}"].to_numpy()
    for scale in np.arange(0.6, 2.51, 0.01):
        q = apply(frame, intercept, slope, scale)
        if ((y >= q[:, 0]) & (y <= q[:, 2])).mean() >= TARGET:
            return round(float(scale), 2)
    return 2.5


def evaluate(frame: pd.DataFrame, h: int, q: np.ndarray) -> dict:
    y = frame[f"fwd_{h}"].to_numpy()
    bands = pd.qcut(q[:, 1], 10, labels=False, duplicates="drop")
    table = pd.DataFrame({"pred": q[:, 1], "y": y, "band": bands}).groupby("band").agg(
        predicted=("pred", "mean"), actual_median=("y", "median"))
    return {
        "coverage_10_90": round(float(((y >= q[:, 0]) & (y <= q[:, 2])).mean()), 4),
        "below_low": round(float((y < q[:, 0]).mean()), 4),
        "above_high": round(float((y > q[:, 2]).mean()), 4),
        "median_width": round(float(np.median(q[:, 2] - q[:, 0])), 5),
        "middle_by_band": [
            {"predicted": round(float(r.predicted), 5), "actual_median": round(float(r.actual_median), 5)}
            for r in table.itertuples()
        ],
    }


def main() -> None:
    frames = pd.read_pickle(os.path.join(_HERE, "frames_forecast.pkl"))
    df = forecast_frame(frames["price_frames"], frames["index_frame"], horizons=HORIZONS)
    df = df[df["anomaly"] <= 0]
    dates = sorted(df["date"].unique())
    for h in HORIZONS:
        data = df.dropna(subset=[f"fwd_{h}"])
        data = data[data[f"fwd_{h}"].abs() < 0.45]
        oos = fold_quantiles(data, dates, h)
        days = sorted(oos["date"].unique())
        split = days[len(days) // 2]
        first, second = oos[oos["date"] < split], oos[oos["date"] >= split]
        intercept, slope = fit_center(first, h)
        scale = fit_scale(first, h, intercept, slope)
        before = evaluate(second, h, calibrate_range(second[["raw_10", "raw_50", "raw_90"]].to_numpy(), 0.0, 1.0, 1.0))
        after = evaluate(second, h, apply(second, intercept, slope, scale))
        result = {
            "center_intercept": round(intercept, 6),
            "center_slope": round(slope, 4),
            "range_scale": scale,
            "fitted_on": f"{first['date'].min()}..{first['date'].max()}",
            "confirmed_on": f"{second['date'].min()}..{second['date'].max()}",
            "confirmation_before": before,
            "confirmation_after": after,
        }
        print(f"\n=== {h}-session: middle = {intercept * 100:+.3f}% + {slope:.3f} x predicted, band stretch {scale}")
        print(f"  untouched year: coverage {before['coverage_10_90']} -> {after['coverage_10_90']}, "
              f"width {before['median_width'] * 100:.2f}% -> {after['median_width'] * 100:.2f}%")
        for b in after["middle_by_band"]:
            print(f"    predicted {b['predicted'] * 100:+.3f}%  actual median {b['actual_median'] * 100:+.3f}%")

        path = os.path.join(ARTIFACT_DIR, f"forecast_h{h}.joblib")
        artifact = joblib.load(path)
        artifact.update({"center_intercept": intercept, "center_slope": slope, "range_scale": scale})
        joblib.dump(artifact, path, compress=3)
        report_path = os.path.join(ARTIFACT_DIR, f"forecast_report_h{h}.json")
        with open(report_path, encoding="utf-8") as fh:
            report = json.load(fh)
        report["range_scale"] = scale
        report["range_calibration"] = result
        report["confirmation"]["range"] = {k: after[k] for k in ("coverage_10_90", "below_low", "above_high", "median_width")}
        with open(report_path, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
        print(f"  updated {os.path.basename(path)} and {os.path.basename(report_path)}", flush=True)


if __name__ == "__main__":
    main()
