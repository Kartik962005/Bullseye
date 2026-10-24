"""Train and test the daily forecast engine (Nifty 200, horizons 1 / 3 / 5 sessions).

For each horizon, from the next open to the close of session h:
  * P(stock beats the average Nifty 200 stock): an ensemble of two boosted-tree
    models and a logistic regression on rank features, averaged and isotonic-
    calibrated. A single boosted model is scored alongside as the baseline.
  * The 10th / 50th / 90th percentile of the stock's return (the likely range).

Walk-forward: train on everything before a cutoff (embargo of h sessions so no
label overlaps the test window), predict the next 120 sessions, repeat. Every
reported number is out of sample. The out-of-sample period is split in two:
  * selection half: picks single vs ensemble and fits the range widening;
  * confirmation half: untouched, and the numbers the app quotes.

    cd backend
    python scripts/build_forecast_universe.py     # once, or to refresh prices
    python scripts/train_forecast.py
    python scripts/calibrate_ranges.py            # then correct the middle and range
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

import sklearn  # noqa: E402
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor  # noqa: E402
from sklearn.isotonic import IsotonicRegression  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.pipeline import make_pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

from app.services.daily_signal_engine.forecast import (  # noqa: E402
    CLASSIFIER_FEATURES,
    FORECAST_FEATURES,
    HORIZONS,
    QUANTILES,
    RANK_FEATURES,
    EnsembleClassifier,
    forecast_frame,
    widen,
)

FRAMES_CACHE = os.path.join(_HERE, "frames_forecast.pkl")
ARTIFACT_DIR = os.path.join(_BACKEND, "app", "services", "daily_signal_engine", "artifacts")
INITIAL_DAYS = 750
STEP_DAYS = 120
TOP_N = 10
TARGET_COVERAGE = 0.80
QUANTILE_SAMPLE = 200_000
BUCKET_EDGES = [0.0, 0.42, 0.45, 0.48, 0.50, 0.52, 0.55, 0.58, 1.0001]
LINEAR_FEATURES = RANK_FEATURES + ["ret5_vs_sector", "ret20_vs_sector", "rel_strength", "vol_regime", "dist_52w_high", "close_to_sma200"]
# Approximate round-trip costs, for the reported after-cost figures only.
COST = {1: 0.0006, 3: 0.0025, 5: 0.0025}


def _members():
    return [
        (lambda: HistGradientBoostingClassifier(
            learning_rate=0.04, max_iter=250, max_leaf_nodes=15, min_samples_leaf=800, l2_regularization=3.0,
            early_stopping=True, validation_fraction=0.1, random_state=7), CLASSIFIER_FEATURES),
        (lambda: HistGradientBoostingClassifier(
            learning_rate=0.03, max_iter=300, max_leaf_nodes=31, min_samples_leaf=1500, l2_regularization=5.0,
            max_features=0.6, early_stopping=True, validation_fraction=0.1, random_state=11), CLASSIFIER_FEATURES),
        (lambda: make_pipeline(StandardScaler(), LogisticRegression(C=0.05, max_iter=1000)), LINEAR_FEATURES),
    ]


def fit_classifiers(train: pd.DataFrame, h: int) -> tuple[EnsembleClassifier, EnsembleClassifier]:
    """Ensemble and single-model baseline, both calibrated on the last 15% of training days."""
    label = (train[f"excess_{h}"] > 0).astype(int)
    dates = sorted(train["date"].unique())
    cut = dates[int(len(dates) * 0.85)]
    base = train["date"] < cut
    fitted = [(make().fit(train.loc[base, cols], label[base]), cols) for make, cols in _members()]
    cal = train.loc[~base]
    cal_y = label[~base]

    def calibrated(members):
        raw = np.mean([m.predict_proba(cal[cols])[:, 1] for m, cols in members], axis=0)
        return EnsembleClassifier(members, IsotonicRegression(out_of_bounds="clip").fit(raw, cal_y))

    return calibrated(fitted), calibrated(fitted[:1])


def fit_quantiles(train: pd.DataFrame, h: int) -> dict[str, HistGradientBoostingRegressor]:
    sample = train.sample(min(len(train), QUANTILE_SAMPLE), random_state=3)
    return {
        str(level): HistGradientBoostingRegressor(
            loss="quantile", quantile=level, learning_rate=0.05, max_iter=250, max_leaf_nodes=15,
            min_samples_leaf=600, l2_regularization=2.0, random_state=7,
        ).fit(sample[FORECAST_FEATURES], sample[f"fwd_{h}"])
        for level in QUANTILES
    }


def walk_forward(data: pd.DataFrame, h: int) -> pd.DataFrame:
    dates = sorted(data["date"].unique())
    pieces = []
    start = INITIAL_DAYS
    while start < len(dates):
        t0 = time.time()
        test_dates = set(dates[start:start + STEP_DAYS])
        train = data[data["date"] <= dates[max(0, start - h - 1)]]
        test = data[data["date"].isin(test_dates)].copy()
        ensemble, single = fit_classifiers(train, h)
        qs = fit_quantiles(train, h)
        test["p_ens"] = ensemble.predict_proba(test)[:, 1]
        test["s_ens"] = ensemble.score(test)
        test["p_single"] = single.predict_proba(test)[:, 1]
        test["s_single"] = single.score(test)
        q = np.column_stack([qs[str(level)].predict(test[FORECAST_FEATURES]) for level in QUANTILES])
        test["raw_q10"], test["raw_q50"], test["raw_q90"] = np.sort(q, axis=1).T
        pieces.append(test)
        print(f"  {h}d test {min(test_dates)}..{max(test_dates)}  train {len(train):,} rows  ({time.time() - t0:.0f}s)", flush=True)
        start += STEP_DAYS
    return pd.concat(pieces, ignore_index=True)


def list_stats(frame: pd.DataFrame, h: int, p: str, s: str) -> dict:
    """BUY = top 10 a day by the model, SELL = bottom 10 a day."""
    ex, fwd = f"excess_{h}", f"fwd_{h}"
    ordered = frame.sort_values(["date", p, s], ascending=[True, False, False])
    buy = ordered.groupby("date").head(TOP_N)
    sell = frame.sort_values(["date", p, s], ascending=[True, True, True]).groupby("date").head(TOP_N)
    buy_daily = buy.groupby("date")[ex].mean()
    sell_daily = -sell.groupby("date")[ex].mean()

    def t(series: pd.Series) -> float:
        return round(float(series.mean() / (series.std(ddof=1) / np.sqrt(len(series)))), 2) if len(series) > 2 else 0.0

    beat = (frame[ex] > 0).astype(int)
    return {
        "first_day": str(frame["date"].min()),
        "last_day": str(frame["date"].max()),
        "days": int(frame["date"].nunique()),
        "roc_auc": round(float(roc_auc_score(beat, frame[s])), 4),
        "base_beat_rate": round(float(beat.mean()), 4),
        "buy": {
            "beat_rate": round(float((buy[ex] > 0).mean()), 4),
            "avg_excess": round(float(buy_daily.mean()), 5),
            "t_stat": t(buy_daily),
            "avg_return": round(float(buy[fwd].mean()), 5),
            "rose_rate": round(float((buy[fwd] > 0).mean()), 4),
            "avg_return_after_cost": round(float(buy[fwd].mean() - COST[h]), 5),
        },
        "sell": {
            "lag_rate": round(float((sell[ex] < 0).mean()), 4),
            "avg_shortfall": round(float(sell_daily.mean()), 5),
            "t_stat": t(sell_daily),
            "avg_return": round(float(sell[fwd].mean()), 5),
            "fell_rate": round(float((sell[fwd] < 0).mean()), 4),
            "short_return_after_cost": round(float(-sell[fwd].mean() - COST[h]), 5),
        },
    }


def calibration_table(frame: pd.DataFrame, h: int, p: str) -> list[dict]:
    beat = frame[f"excess_{h}"] > 0
    table = []
    for lo, hi in zip(BUCKET_EDGES[:-1], BUCKET_EDGES[1:]):
        mask = (frame[p] >= lo) & (frame[p] < hi)
        n = int(mask.sum())
        if n < 300:
            continue
        table.append({
            "p_min": round(lo, 3), "p_max": round(min(hi, 1.0), 3),
            "mean_p": round(float(frame.loc[mask, p].mean()), 4),
            "actual_beat_rate": round(float(beat[mask].mean()), 4), "samples": n,
        })
    return table


def fit_range_scale(frame: pd.DataFrame, h: int) -> float:
    y = frame[f"fwd_{h}"].to_numpy()
    raw = frame[["raw_q10", "raw_q50", "raw_q90"]].to_numpy()
    for scale in np.arange(0.9, 2.51, 0.01):
        q = widen(raw, scale)
        if ((y >= q[:, 0]) & (y <= q[:, 2])).mean() >= TARGET_COVERAGE:
            return round(float(scale), 2)
    return 2.5


def range_stats(frame: pd.DataFrame, h: int, scale: float) -> dict:
    y = frame[f"fwd_{h}"].to_numpy()
    q = widen(frame[["raw_q10", "raw_q50", "raw_q90"]].to_numpy(), scale)
    return {
        "coverage_10_90": round(float(((y >= q[:, 0]) & (y <= q[:, 2])).mean()), 4),
        "below_low": round(float((y < q[:, 0]).mean()), 4),
        "above_high": round(float((y > q[:, 2]).mean()), 4),
        "median_width": round(float(np.median(q[:, 2] - q[:, 0])), 5),
    }


def main() -> None:
    frames = pd.read_pickle(FRAMES_CACHE)
    print(f"Building features for {len(frames['price_frames'])} stocks ...", flush=True)
    df = forecast_frame(frames["price_frames"], frames["index_frame"], horizons=HORIZONS)
    bad = df["anomaly"] > 0
    for h in HORIZONS:
        bad |= df[f"fwd_{h}"].abs() > 0.45
    df = df[~bad].reset_index(drop=True)
    print(f"Rows {len(df):,}, stocks {df['ticker'].nunique()}, days {df['date'].nunique()} "
          f"({df['date'].min()}..{df['date'].max()})", flush=True)
    os.makedirs(ARTIFACT_DIR, exist_ok=True)

    for h in HORIZONS:
        data = df.dropna(subset=[f"fwd_{h}", f"excess_{h}"]).reset_index(drop=True)
        print(f"\n=== {h}-session horizon: walk-forward on {len(data):,} rows", flush=True)
        oos = walk_forward(data, h)
        oos_days = sorted(oos["date"].unique())
        split = oos_days[len(oos_days) // 2]
        select, confirm = oos[oos["date"] < split], oos[oos["date"] >= split]

        candidates = {"ensemble": ("p_ens", "s_ens"), "single": ("p_single", "s_single")}
        selection = {name: list_stats(select, h, *cols) for name, cols in candidates.items()}
        # Pick on the selection half only: the stronger combined buy + sell evidence.
        chosen = max(selection, key=lambda n: selection[n]["buy"]["t_stat"] + selection[n]["sell"]["t_stat"])
        p_col, s_col = candidates[chosen]
        scale = fit_range_scale(select, h)
        confirmed = list_stats(confirm, h, p_col, s_col)
        report = {
            "horizon_days": h,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "universe": "Nifty 200",
            "stocks": int(oos["ticker"].nunique()),
            "model": chosen,
            "range_scale": scale,
            "selection": {name: stats for name, stats in selection.items()},
            "confirmation": {**confirmed, "range": range_stats(confirm, h, scale)},
            "buy_edge_confirmed": bool(confirmed["buy"]["avg_excess"] > 0 and confirmed["buy"]["t_stat"] >= 2.0),
            "sell_edge_confirmed": bool(confirmed["sell"]["avg_shortfall"] > 0 and confirmed["sell"]["t_stat"] >= 2.0),
            "calibration": calibration_table(confirm, h, p_col),
        }
        print(json.dumps({k: v for k, v in report.items() if k != "calibration"}, indent=2), flush=True)
        for b in report["calibration"]:
            print(f"   said {b['mean_p']:.3f} -> beat {b['actual_beat_rate']:.3f}  (n={b['samples']})")

        print("  fitting final models on all data ...", flush=True)
        ensemble, single = fit_classifiers(data, h)
        artifact = {
            "horizon_days": h,
            "features": list(FORECAST_FEATURES),
            "classifier": ensemble if chosen == "ensemble" else single,
            "quantiles": fit_quantiles(data, h),
            "range_scale": scale,
            "calibration": report["calibration"],
            "buy_edge_confirmed": report["buy_edge_confirmed"],
            "sell_edge_confirmed": report["sell_edge_confirmed"],
            "trained_through": str(data["date"].max()),
            "sklearn_version": sklearn.__version__,
        }
        joblib.dump(artifact, os.path.join(ARTIFACT_DIR, f"forecast_h{h}.joblib"), compress=3)
        with open(os.path.join(ARTIFACT_DIR, f"forecast_report_h{h}.json"), "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
        print(f"Saved forecast_h{h}.joblib and forecast_report_h{h}.json", flush=True)


if __name__ == "__main__":
    main()
