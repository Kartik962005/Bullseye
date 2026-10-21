"""Which forecast target and model generalise? Selection half, then a confirmation half.

The absolute "will it rise" target is dominated by the market's daily
direction, which nobody forecasts reliably. Relative performance ("will it beat
the average stock") strips that out and is where short-horizon effects such as
momentum and reversal are documented. Candidates are fixed up front:

  A. boosted trees,  absolute target   (the current model, for reference)
  B. boosted trees,  relative target, stock-level features only
  C. logistic regression, relative target, stock-level features only

Each is walk-forward tested. The choice is made on the first half of the
out-of-sample period only; the second half is reported as untouched
confirmation.
"""
from __future__ import annotations

import os
import sys

import numpy as np
import pandas as pd

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))

from sklearn.ensemble import HistGradientBoostingClassifier  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import roc_auc_score  # noqa: E402
from sklearn.pipeline import make_pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402

from app.services.daily_signal_engine.config import NSE_UNIVERSE  # noqa: E402
from app.services.daily_signal_engine.forecast import FORECAST_FEATURES, forecast_frame  # noqa: E402

STOCK_FEATURES = [f for f in FORECAST_FEATURES if not f.startswith(("idx_", "mkt_"))]
INITIAL, STEP, TOP = 500, 60, 10


def models():
    hgb = lambda: HistGradientBoostingClassifier(  # noqa: E731
        learning_rate=0.04, max_iter=200, max_leaf_nodes=15, min_samples_leaf=600,
        l2_regularization=3.0, early_stopping=True, validation_fraction=0.1, random_state=7)
    lr = lambda: make_pipeline(StandardScaler(), LogisticRegression(C=0.05, max_iter=500))  # noqa: E731
    return {
        "A_hgb_absolute": (hgb, FORECAST_FEATURES, "abs"),
        "B_hgb_relative": (hgb, STOCK_FEATURES, "rel"),
        "C_logit_relative": (lr, STOCK_FEATURES, "rel"),
    }


def clip_features(df: pd.DataFrame, cols: list[str]) -> pd.DataFrame:
    out = df.copy()
    for c in cols:
        lo, hi = out[c].quantile(0.005), out[c].quantile(0.995)
        out[c] = out[c].clip(lo, hi)
    return out


def run(df: pd.DataFrame, h: int) -> None:
    y = f"fwd_{h}"
    data = df.dropna(subset=[y]).copy()
    data["excess"] = data[y] - data.groupby("date")[y].transform("mean")
    data = clip_features(data, FORECAST_FEATURES)
    dates = sorted(data["date"].unique())
    oos_dates = dates[INITIAL:]
    split = oos_dates[len(oos_dates) // 2]
    print(f"\n===== {h}-day  selection half < {split} <= confirmation half")
    for name, (make, cols, kind) in models().items():
        label = (data[y] > 0) if kind == "abs" else (data["excess"] > 0)
        preds = []
        start = INITIAL
        while start < len(dates):
            test_dates = set(dates[start:start + STEP])
            cut = dates[max(0, start - h - 1)]
            tr = data["date"] <= cut
            te = data["date"].isin(test_dates)
            model = make().fit(data.loc[tr, cols], label[tr].astype(int))
            p = pd.Series(model.predict_proba(data.loc[te, cols])[:, 1], index=data.index[te])
            preds.append(p)
            start += STEP
        p = pd.concat(preds)
        oos = data.loc[p.index].assign(p=p, lab=label.loc[p.index].astype(int))
        for half, frame in (("select", oos[oos["date"] < split]), ("confirm", oos[oos["date"] >= split])):
            top = frame.sort_values(["date", "p"], ascending=[True, False]).groupby("date").head(TOP)
            bot = frame.sort_values(["date", "p"]).groupby("date").head(TOP)
            spread = top.groupby("date")["excess"].mean() - bot.groupby("date")["excess"].mean()
            print(
                f"  {name:<18} {half:<8} AUC(own target) {roc_auc_score(frame['lab'], frame['p']):.4f}  "
                f"top10 beat avg {(top['excess'] > 0).mean():.3f}  top10 rose {(top[y] > 0).mean():.3f} "
                f"(all {(frame[y] > 0).mean():.3f})  top-bottom spread {spread.mean() * 100:+.3f}%/trade  "
                f"t={spread.mean() / (spread.std(ddof=1) / np.sqrt(len(spread))):.2f}"
            )


def main() -> None:
    frames = pd.read_pickle(os.path.join(_HERE, "frames_5y.pkl"))
    df = forecast_frame(frames["price_frames"], frames["index_frame"], breadth_universe=set(NSE_UNIVERSE), horizons=(1, 3, 5))
    suspect = (df["ret1"].abs() > 0.3) | (df["gap"].abs() > 0.25)
    for h in (1, 3, 5):
        suspect |= df[f"fwd_{h}"].abs() > 0.45
    df = df[~suspect].reset_index(drop=True)
    for h in (1, 3, 5):
        run(df, h)


if __name__ == "__main__":
    main()
