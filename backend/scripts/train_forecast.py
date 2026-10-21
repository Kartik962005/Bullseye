"""Train and test the daily forecast models.

For each horizon (1, 3, 5 sessions), from the next open to the close of session h:
  * a classifier for P(stock beats the average stock over the window), on
    stock-level features (the target and features chosen in
    scripts/research_forecast_targets.py, on its selection half only);
  * quantile models for the 10th / 50th / 90th percentile of the stock's return.

Walk-forward: train on everything before a cutoff (with an embargo of h
sessions), predict the next 60 sessions, repeat. Every number in the report is
out of sample. The out-of-sample period is split in two:
  * the first half fits the range widening factor (so 8 in 10 outcomes land
    inside the range) and is where design choices were made;
  * the second half is the untouched confirmation, and its numbers are the ones
    the app shows.

    cd backend
    python scripts/train_forecast.py
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

import sklearn  # noqa: E402
from sklearn.calibration import CalibratedClassifierCV  # noqa: E402
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor  # noqa: E402
from sklearn.metrics import brier_score_loss, roc_auc_score  # noqa: E402

from app.services.daily_signal_engine.config import NSE_UNIVERSE  # noqa: E402
from app.services.daily_signal_engine.forecast import (  # noqa: E402
    FORECAST_FEATURES,
    HORIZONS,
    QUANTILES,
    STOCK_FEATURES,
    forecast_frame,
    widen,
)

try:
    from sklearn.frozen import FrozenEstimator

    _HAS_FROZEN = True
except Exception:  # noqa: BLE001
    _HAS_FROZEN = False

FRAMES_CACHE = os.path.join(_HERE, "frames_5y.pkl")
ARTIFACT_DIR = os.path.join(_BACKEND, "app", "services", "daily_signal_engine", "artifacts")
INITIAL_DAYS = 500
STEP_DAYS = 60
TOP_N = 10
TARGET_COVERAGE = 0.80
BUCKET_EDGES = [0.0, 0.44, 0.47, 0.49, 0.51, 0.53, 0.56, 1.0001]


def _classifier() -> HistGradientBoostingClassifier:
    return HistGradientBoostingClassifier(
        learning_rate=0.04, max_iter=200, max_leaf_nodes=15, min_samples_leaf=600,
        l2_regularization=3.0, early_stopping=True, validation_fraction=0.1, random_state=7,
    )


def _quantile(level: float) -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(
        loss="quantile", quantile=level, learning_rate=0.05, max_iter=250, max_leaf_nodes=15,
        min_samples_leaf=400, l2_regularization=2.0, random_state=7,
    )


def _fit_calibrated(train: pd.DataFrame, label: pd.Series):
    """Boosted classifier, isotonic-calibrated on the most recent 15% of its own training days."""
    dates = sorted(train["date"].unique())
    cut = dates[int(len(dates) * 0.85)]
    base_mask = train["date"] < cut
    base = _classifier().fit(train.loc[base_mask, STOCK_FEATURES], label[base_mask])
    cal_X, cal_y = train.loc[~base_mask, STOCK_FEATURES], label[~base_mask]
    if _HAS_FROZEN:
        return CalibratedClassifierCV(FrozenEstimator(base), method="isotonic").fit(cal_X, cal_y)
    return CalibratedClassifierCV(base, method="isotonic", cv="prefit").fit(cal_X, cal_y)


def _fit_quantiles(train: pd.DataFrame, target: pd.Series) -> dict[str, HistGradientBoostingRegressor]:
    return {str(level): _quantile(level).fit(train[FORECAST_FEATURES], target) for level in QUANTILES}


def _beat_label(data: pd.DataFrame, h: int) -> pd.Series:
    return (data[f"excess_{h}"] > 0).astype(int)


def walk_forward(data: pd.DataFrame, h: int) -> pd.DataFrame:
    target = f"fwd_{h}"
    dates = sorted(data["date"].unique())
    pieces = []
    start = INITIAL_DAYS
    while start < len(dates):
        test_dates = set(dates[start:start + STEP_DAYS])
        embargo_cut = dates[max(0, start - h - 1)]
        train = data[data["date"] <= embargo_cut]
        test = data[data["date"].isin(test_dates)].copy()
        clf = _fit_calibrated(train, _beat_label(train, h))
        qs = _fit_quantiles(train, train[target])
        test["p_beat"] = clf.predict_proba(test[STOCK_FEATURES])[:, 1]
        q = np.column_stack([qs[str(level)].predict(test[FORECAST_FEATURES]) for level in QUANTILES])
        test["raw_q10"], test["raw_q50"], test["raw_q90"] = np.sort(q, axis=1).T
        pieces.append(test)
        print(f"  {h}d fold through {embargo_cut}: test {min(test_dates)}..{max(test_dates)} ({len(test):,} rows)")
        start += STEP_DAYS
    return pd.concat(pieces, ignore_index=True)


def fit_range_scale(frame: pd.DataFrame, h: int) -> float:
    """Smallest stretch of the 10-90 band that covers TARGET_COVERAGE of outcomes."""
    y = frame[f"fwd_{h}"].to_numpy()
    raw = frame[["raw_q10", "raw_q50", "raw_q90"]].to_numpy()
    for scale in np.arange(0.9, 2.51, 0.01):
        q = widen(raw, scale)
        if ((y >= q[:, 0]) & (y <= q[:, 2])).mean() >= TARGET_COVERAGE:
            return round(float(scale), 2)
    return 2.5


def apply_scale(frame: pd.DataFrame, scale: float) -> pd.DataFrame:
    q = widen(frame[["raw_q10", "raw_q50", "raw_q90"]].to_numpy(), scale)
    return frame.assign(q10=q[:, 0], q50=q[:, 1], q90=q[:, 2])


def calibration_table(frame: pd.DataFrame, h: int) -> list[dict]:
    beat = frame[f"excess_{h}"] > 0
    table = []
    for lo, hi in zip(BUCKET_EDGES[:-1], BUCKET_EDGES[1:]):
        mask = (frame["p_beat"] >= lo) & (frame["p_beat"] < hi)
        n = int(mask.sum())
        if n < 150:
            continue
        table.append({
            "p_min": round(lo, 3),
            "p_max": round(min(hi, 1.0), 3),
            "mean_p": round(float(frame.loc[mask, "p_beat"].mean()), 4),
            "actual_beat_rate": round(float(beat[mask].mean()), 4),
            "samples": n,
        })
    return table


def ranking_stats(frame: pd.DataFrame, h: int) -> dict:
    y, ex = f"fwd_{h}", f"excess_{h}"
    ordered = frame.sort_values(["date", "p_beat"], ascending=[True, False])
    top = ordered.groupby("date").head(TOP_N)
    bottom = frame.sort_values(["date", "p_beat"]).groupby("date").head(TOP_N)
    spread = top.groupby("date")[ex].mean() - bottom.groupby("date")[ex].mean()
    t = float(spread.mean() / (spread.std(ddof=1) / np.sqrt(len(spread)))) if len(spread) > 2 else 0.0
    beat = (frame[ex] > 0).astype(int)
    return {
        "first_day": str(frame["date"].min()),
        "last_day": str(frame["date"].max()),
        "days": int(frame["date"].nunique()),
        "roc_auc": round(float(roc_auc_score(beat, frame["p_beat"])), 4),
        "brier_skill": round(1 - brier_score_loss(beat, frame["p_beat"]) / brier_score_loss(beat, np.full(len(beat), beat.mean())), 4),
        "top_beat_rate": round(float((top[ex] > 0).mean()), 4),
        "bottom_beat_rate": round(float((bottom[ex] > 0).mean()), 4),
        "top_excess": round(float(top[ex].mean()), 5),
        "bottom_excess": round(float(bottom[ex].mean()), 5),
        "top_bottom_spread": round(float(spread.mean()), 5),
        "spread_t_stat": round(t, 2),
        "top_up_rate": round(float((top[y] > 0).mean()), 4),
        "all_up_rate": round(float((frame[y] > 0).mean()), 4),
    }


def range_stats(frame: pd.DataFrame, h: int) -> dict:
    y = frame[f"fwd_{h}"]
    return {
        "coverage_10_90": round(float(((y >= frame["q10"]) & (y <= frame["q90"])).mean()), 4),
        "below_q10": round(float((y < frame["q10"]).mean()), 4),
        "above_q90": round(float((y > frame["q90"]).mean()), 4),
        "median_width": round(float((frame["q90"] - frame["q10"]).median()), 5),
    }


def main() -> None:
    frames = pd.read_pickle(FRAMES_CACHE)
    price_frames, index_frame = frames["price_frames"], frames["index_frame"]
    print(f"Building forecast features for {len(price_frames)} stocks ...")
    df = forecast_frame(price_frames, index_frame, breadth_universe=set(NSE_UNIVERSE), horizons=HORIZONS)
    print(f"Rows: {len(df):,}, days {df['date'].nunique()}, {df['date'].min()}..{df['date'].max()}")
    # Splits and bonus issues show up as impossible one-day moves in unadjusted
    # prices; rows touching one would teach the model nonsense.
    suspect = (df["ret1"].abs() > 0.3) | (df["gap"].abs() > 0.25)
    for h in HORIZONS:
        suspect |= df[f"fwd_{h}"].abs() > 0.45
    print(f"Dropping {int(suspect.sum())} rows around corporate actions")
    df = df[~suspect].reset_index(drop=True)
    os.makedirs(ARTIFACT_DIR, exist_ok=True)

    for h in HORIZONS:
        data = df.dropna(subset=[f"fwd_{h}"]).reset_index(drop=True)
        data[f"excess_{h}"] = data[f"fwd_{h}"] - data.groupby("date")[f"fwd_{h}"].transform("mean")
        print(f"\n=== {h}-day: walk-forward on {len(data):,} rows")
        oos = walk_forward(data, h)
        oos_days = sorted(oos["date"].unique())
        split = oos_days[len(oos_days) // 2]
        select, confirm = oos[oos["date"] < split], oos[oos["date"] >= split]

        scale = fit_range_scale(select, h)
        select, confirm = apply_scale(select, scale), apply_scale(confirm, scale)
        confirmed = ranking_stats(confirm, h)
        report = {
            "horizon_days": h,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "stocks": int(oos["ticker"].nunique()),
            "range_scale": scale,
            "selection": {**ranking_stats(select, h), "range": range_stats(select, h)},
            "confirmation": {**confirmed, "range": range_stats(confirm, h)},
            # The ranking is shown as having an edge only when the untouched half confirms it.
            "edge_confirmed": bool(confirmed["top_bottom_spread"] > 0 and confirmed["spread_t_stat"] >= 2.0),
            "calibration": calibration_table(confirm, h),
        }
        print(json.dumps({k: v for k, v in report.items() if k != "calibration"}, indent=2))
        for b in report["calibration"]:
            print(f"   p {b['p_min']:.2f}-{b['p_max']:.2f}  said {b['mean_p']:.3f}  beat {b['actual_beat_rate']:.3f}  n={b['samples']}")

        artifact = {
            "horizon_days": h,
            "features": list(FORECAST_FEATURES),
            "classifier_features": list(STOCK_FEATURES),
            "classifier": _fit_calibrated(data, _beat_label(data, h)),
            "quantiles": _fit_quantiles(data, data[f"fwd_{h}"]),
            "range_scale": scale,
            "calibration": report["calibration"],
            "edge_confirmed": report["edge_confirmed"],
            "trained_through": str(data["date"].max()),
            "sklearn_version": sklearn.__version__,
        }
        joblib.dump(artifact, os.path.join(ARTIFACT_DIR, f"forecast_h{h}.joblib"), compress=3)
        with open(os.path.join(ARTIFACT_DIR, f"forecast_report_h{h}.json"), "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
        print(f"Saved forecast_h{h}.joblib and forecast_report_h{h}.json")


if __name__ == "__main__":
    main()
