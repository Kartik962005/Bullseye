"""Walk-forward train + calibrate a win-probability model, then test if it adds
edge over the rule baseline (decisive R = -0.037 on the 5y/80-symbol backtest).

Pipeline
--------
1. Load 5y history for the full Nifty-500 universe + ^NSEI (cached to disk).
2. Build the leakage-safe labelled dataset (cached to disk).
3. Walk forward in time: repeatedly train on all data strictly before a cutoff
   (with a `hold_days` embargo so labels don't overlap the test window),
   calibrate on the tail of the train slice, and predict the next window
   OUT-OF-SAMPLE. Concatenate OOS predictions.
4. Classification quality: ROC-AUC + Brier + a calibration reliability table.
5. Economic test: rank each day's signals by calibrated P(win), take the top-N,
   grade with the SAME stored realised R as the backtest, and compare decisive
   expectancy against the baseline. We only "win" if decisive R is clearly > 0
   AND clearly beats the rule baseline.

Honesty guardrails:
  * Everything is time-ordered; no future row ever trains a past prediction.
  * Calibration uses a held-out tail, not random CV, to respect time order.
  * We report Wilson lower bounds and decisive-only R, never raw win rate alone.

    cd backend
    python scripts/train_ml.py
    python scripts/train_ml.py --rebuild     # force rebuild caches
    python scripts/train_ml.py --top-n 10 --cost 0.05
"""
from __future__ import annotations

import argparse
import math
import os
import sys
import time

import joblib
import numpy as np
import pandas as pd

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
if _BACKEND not in sys.path:
    sys.path.insert(0, _BACKEND)

from sklearn.calibration import CalibratedClassifierCV  # noqa: E402
from sklearn.ensemble import HistGradientBoostingClassifier  # noqa: E402
from sklearn.metrics import brier_score_loss, roc_auc_score  # noqa: E402

from app.services.daily_signal_engine.ml_dataset import (  # noqa: E402
    FEATURE_COLUMNS,
    build_labeled_dataset,
)
from app.services.daily_signal_engine.ml_interface import (  # noqa: E402
    artifact_path_for_horizon,
    report_path_for_horizon,
)
from app.services.daily_signal_engine.scoring import wilson_lower_bound_placeholder  # noqa: E402
from fetch_earnings import EARNINGS_CACHE, fetch_earnings_dates  # noqa: E402
from ingest_history import fetch_nifty500_symbols  # noqa: E402
from run_backtest import _connect, _fetch_with_fallback  # noqa: E402
from app.services.daily_signal_engine.config import MARKET_INDEX  # noqa: E402

try:  # modern sklearn (>=1.6) way to freeze a fitted estimator for calibration
    from sklearn.frozen import FrozenEstimator
    _HAS_FROZEN = True
except Exception:
    _HAS_FROZEN = False

FRAMES_CACHE = os.path.join(_HERE, "frames_5y.pkl")
DATASET_CACHE = os.path.join(_HERE, "ml_dataset.pkl")
OOS_CACHE = os.path.join(_HERE, "ml_oos.pkl")


def _horizon_cache(path: str, hold_days: int) -> str:
    """Caches for the realistic (limit-entry) grading, one per horizon. The
    original ml_dataset.pkl / ml_oos.pkl stay untouched for the paper."""
    root, ext = os.path.splitext(path)
    return f"{root}_v2_h{hold_days}{ext}"
MODEL_ARTIFACT = os.path.join(
    _BACKEND,
    "app",
    "services",
    "daily_signal_engine",
    "artifacts",
    "win_probability_model.joblib",
)


PARTIAL_FRAMES_CACHE = os.path.join(_HERE, "frames_5y.partial.pkl")
FETCH_RETRIES = 4
CHECKPOINT_EVERY = 25


def _fetch_one_with_retry(sb, ticker: str):
    """Fetch one symbol, retrying transient network failures.

    Supabase drops long-running connections (WinError 10054) and DNS blips
    (getaddrinfo failed) partway through a ~500-symbol pull. Retrying the single
    symbol, with a fresh client on the last attempt, keeps one bad moment from
    ending the run.
    """
    delay = 2.0
    for attempt in range(1, FETCH_RETRIES + 1):
        try:
            return sb, _fetch_with_fallback(sb, ticker)
        except Exception as exc:  # noqa: BLE001 - any transport error is retryable here
            if attempt == FETCH_RETRIES:
                print(f"    {ticker}: giving up after {FETCH_RETRIES} attempts ({exc})")
                return sb, (ticker, pd.DataFrame())
            print(f"    {ticker}: attempt {attempt} failed ({type(exc).__name__}), retrying in {delay:.0f}s")
            time.sleep(delay)
            delay *= 2
            if attempt == FETCH_RETRIES - 1:
                # Last try gets a brand-new client: the old one's connection
                # pool may be the thing that is broken.
                try:
                    sb = _connect()
                except Exception:  # noqa: BLE001
                    pass
    return sb, (ticker, pd.DataFrame())


def get_frames(rebuild: bool):
    """Load 5y frames for the universe, resumably.

    This used to call load_frames() for the whole universe in one go and pickle
    the result at the very end. Pulling ~500 symbols takes minutes, and a single
    dropped connection anywhere in that window discarded everything — three
    consecutive runs died that way without ever writing a cache.

    Now each symbol is fetched with retries and progress is checkpointed to disk
    every 25 symbols, so an interrupted run resumes where it stopped instead of
    starting over.
    """
    if not rebuild and os.path.exists(FRAMES_CACHE):
        print(f"Loading cached frames from {os.path.basename(FRAMES_CACHE)} ...")
        obj = pd.read_pickle(FRAMES_CACHE)
        return obj["price_frames"], obj["index_frame"]

    sb = _connect()
    symbols = sorted(set(fetch_nifty500_symbols()))

    price_frames: dict[str, pd.DataFrame] = {}
    done: set[str] = set()
    if not rebuild and os.path.exists(PARTIAL_FRAMES_CACHE):
        try:
            partial = pd.read_pickle(PARTIAL_FRAMES_CACHE)
            price_frames = partial.get("price_frames", {})
            done = set(partial.get("attempted", []))
            print(f"Resuming: {len(price_frames)} symbols already cached, "
                  f"{len(symbols) - len(done)} still to fetch.")
        except Exception as exc:  # noqa: BLE001 - a corrupt checkpoint just means starting over
            print(f"Could not read checkpoint ({exc}); starting fresh.")

    todo = [s for s in symbols if s not in done]
    print(f"Loading {len(todo)} symbols (5y) from Supabase, checkpointing every "
          f"{CHECKPOINT_EVERY} ...")

    missing: list[str] = []
    for index, ticker in enumerate(todo, start=1):
        sb, (key, df) = _fetch_one_with_retry(sb, ticker)
        done.add(ticker)
        if df.empty or len(df) < 250:
            missing.append(ticker)
        else:
            price_frames[key] = df
        if index % CHECKPOINT_EVERY == 0 or index == len(todo):
            pd.to_pickle({"price_frames": price_frames, "attempted": sorted(done)}, PARTIAL_FRAMES_CACHE)
            print(f"  {index}/{len(todo)} fetched ({len(price_frames)} usable) — checkpointed")

    index_symbol = MARKET_INDEX["NSE"]
    sb, (_, index_frame) = _fetch_one_with_retry(sb, index_symbol)
    if index_frame.empty:
        for alias in ("NIFTY", "NIFTY50", "^NSEI"):
            sb, (_, index_frame) = _fetch_one_with_retry(sb, alias)
            if not index_frame.empty:
                break

    print(f"Loaded {len(price_frames)} usable symbols ({len(missing)} dropped); "
          f"index {index_symbol} {len(index_frame)} bars.")
    pd.to_pickle({"price_frames": price_frames, "index_frame": index_frame}, FRAMES_CACHE)
    # The full cache supersedes the checkpoint.
    try:
        os.remove(PARTIAL_FRAMES_CACHE)
    except OSError:
        pass
    return price_frames, index_frame


def get_earnings(price_frames: dict) -> dict[str, list[str]]:
    """Load cached earnings calendar; fetch+cache if missing (slow, one-time)."""
    if os.path.exists(EARNINGS_CACHE):
        print(f"Loading cached earnings calendar from {os.path.basename(EARNINGS_CACHE)} ...")
        return pd.read_pickle(EARNINGS_CACHE)
    symbols = sorted(price_frames.keys())
    print(f"No earnings cache — fetching dates for {len(symbols)} symbols via yfinance "
          "(one-time, ~a few minutes) ...")
    data = fetch_earnings_dates(symbols, delay=0.3)
    pd.to_pickle(data, EARNINGS_CACHE)
    return data


def get_dataset(rebuild_dataset: bool, rebuild_frames: bool, hold_days: int) -> pd.DataFrame:
    dataset_cache = _horizon_cache(DATASET_CACHE, hold_days)
    if not rebuild_dataset and os.path.exists(dataset_cache):
        print(f"Loading cached dataset from {os.path.basename(dataset_cache)} ...")
        return pd.read_pickle(dataset_cache)
    # Reuse cached frames unless a full --rebuild was requested.
    price_frames, index_frame = get_frames(rebuild_frames)
    earnings = get_earnings(price_frames)
    have = sum(1 for v in earnings.values() if v)
    print(f"Earnings calendar: {have}/{len(earnings)} symbols have dates.")
    print("Building labelled dataset (leakage-safe) ...")
    df = build_labeled_dataset(price_frames, index_frame, hold_days=hold_days,
                               ambiguous_as="loss", earnings_dates=earnings)
    df = df.sort_values("date").reset_index(drop=True)
    print(f"Dataset: {len(df):,} rows, {df['ticker'].nunique()} symbols, "
          f"{df['date'].nunique()} days, win-rate(all)={df['label_win'].mean():.3f}")
    pd.to_pickle(df, dataset_cache)
    return df


def _make_model() -> HistGradientBoostingClassifier:
    return HistGradientBoostingClassifier(
        learning_rate=0.05, max_iter=400, max_leaf_nodes=31,
        min_samples_leaf=200, l2_regularization=1.0,
        early_stopping=True, validation_fraction=0.1, random_state=42,
    )


def _calibrate(base, X_cal, y_cal):
    if _HAS_FROZEN:
        return CalibratedClassifierCV(FrozenEstimator(base), method="isotonic").fit(X_cal, y_cal)
    return CalibratedClassifierCV(base, method="isotonic", cv="prefit").fit(X_cal, y_cal)


def _filled(df: pd.DataFrame) -> pd.DataFrame:
    """Rows that became real trades (all rows for legacy datasets without the flag)."""
    return df[df["filled"] == 1] if "filled" in df.columns else df


def _train_final_model(df: pd.DataFrame):
    ordered = _filled(df).sort_values("date").reset_index(drop=True)
    dates = sorted(ordered["date"].unique())
    if len(dates) < 20:
        raise RuntimeError("Not enough dates to train the final runtime model.")
    cut = dates[int(len(dates) * 0.85)]
    train = ordered[ordered["date"] < cut]
    cal = ordered[ordered["date"] >= cut]
    if train.empty or cal["label_win"].nunique() < 2:
        train, cal = ordered, ordered
    base = _make_model().fit(train[FEATURE_COLUMNS], train["label_win"])
    try:
        return _calibrate(base, cal[FEATURE_COLUMNS], cal["label_win"])
    except Exception as exc:
        print(f"Final calibration failed ({exc}); saving the raw classifier.")
        return base


def _return_calibration(oos: pd.DataFrame, bins: int = 8) -> list[dict[str, float]]:
    rows = _filled(oos)[["p_win", "realized_r"]].dropna().copy()
    if rows.empty:
        return []
    q = min(bins, int(rows["p_win"].nunique()))
    if q < 2:
        return [{
            "p_min": round(float(rows["p_win"].min()), 6),
            "p_max": round(float(rows["p_win"].max()), 6),
            "mean_p_win": round(float(rows["p_win"].mean()), 6),
            "mean_realized_r": round(float(rows["realized_r"].mean()), 6),
            "samples": int(len(rows)),
        }]
    rows["bucket"] = pd.qcut(rows["p_win"], q=q, duplicates="drop")
    calibration: list[dict[str, float]] = []
    for bucket, sub in rows.groupby("bucket", observed=True):
        calibration.append({
            "p_min": round(float(bucket.left), 6),
            "p_max": round(float(bucket.right), 6),
            "mean_p_win": round(float(sub["p_win"].mean()), 6),
            "mean_realized_r": round(float(sub["realized_r"].mean()), 6),
            "samples": int(len(sub)),
        })
    return calibration


def save_runtime_artifact(df: pd.DataFrame, oos: pd.DataFrame, output_path: str, hold_days: int = 5) -> None:
    import sklearn

    artifact = {
        "model": _train_final_model(df),
        "feature_columns": list(FEATURE_COLUMNS),
        "hold_days": hold_days,
        "sklearn_version": sklearn.__version__,
        "return_calibration": _return_calibration(oos),
        "created_by": "backend/scripts/train_ml.py",
        "model_family": "HistGradientBoostingClassifier",
    }
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    joblib.dump(artifact, output_path)
    print(f"\nSaved runtime model artifact: {output_path}")


def walk_forward(df: pd.DataFrame, hold_days: int, initial_days: int, step_days: int):
    """Train on past, predict the next `step_days` window OOS. Returns df with p_win."""
    dates = sorted(df["date"].unique())
    if len(dates) <= initial_days + step_days:
        sys.exit("Not enough distinct days for walk-forward; ingest more history.")

    df = df.copy()
    df["p_win"] = np.nan
    fold = 0
    start = initial_days
    while start < len(dates):
        train_end_date = dates[start - 1]
        test_dates = set(dates[start: start + step_days])
        if not test_dates:
            break

        # Embargo: drop train rows whose label window overlaps the test start.
        embargo_cut = dates[max(0, start - hold_days)]
        train_mask = df["date"] <= embargo_cut
        test_mask = df["date"].isin(test_dates)
        train = _filled(df[train_mask])
        test = df[test_mask]
        if len(train) < 3000 or test.empty:
            start += step_days
            continue

        # Time-ordered calibration split: last 15% of train days for calibration.
        tr_dates = sorted(train["date"].unique())
        cut = tr_dates[int(len(tr_dates) * 0.85)]
        base_tr = train[train["date"] < cut]
        cal_tr = train[train["date"] >= cut]
        if cal_tr["label_win"].nunique() < 2 or base_tr.empty:
            base_tr, cal_tr = train, train  # fallback

        Xb, yb = base_tr[FEATURE_COLUMNS], base_tr["label_win"]
        base = _make_model().fit(Xb, yb)
        try:
            model = _calibrate(base, cal_tr[FEATURE_COLUMNS], cal_tr["label_win"])
        except Exception as exc:
            print(f"  fold {fold}: calibration failed ({exc}); using raw model")
            model = base

        proba = model.predict_proba(test[FEATURE_COLUMNS])[:, 1]
        df.loc[test.index, "p_win"] = proba
        fold += 1
        print(f"  fold {fold}: train_through={train_end_date} "
              f"test={dates[start]}..{dates[min(start+step_days, len(dates))-1]} "
              f"(train={len(train):,}, test={len(test):,})")
        start += step_days

    return df[df["p_win"].notna()].copy()


def _wilson(wins: int, decisive: int) -> float:
    return wilson_lower_bound_placeholder(wins, decisive) if decisive else 0.0


def _econ_summary(rows: pd.DataFrame, cost: float, label: str) -> dict:
    sent = len(rows)
    rows = _filled(rows)
    n = len(rows)
    if n == 0:
        return {"label": label, "trades": 0, "signals": sent}
    net = rows["realized_r"] - cost
    wins = int((rows["outcome"] == "WIN").sum())
    losses = int((rows["outcome"] == "LOSS").sum())
    timeouts = int((rows["outcome"] == "TIME_EXIT").sum())
    decisive = wins + losses
    dec_mask = rows["outcome"].isin(["WIN", "LOSS"])
    pos = net[net > 0].sum()
    neg = -net[net < 0].sum()
    return {
        "label": label, "signals": sent, "trades": n, "fill_rate": round(n / sent, 4) if sent else None,
        "wins": wins, "losses": losses, "timeouts": timeouts,
        "raw_win_decisive": round(wins / decisive, 4) if decisive else None,
        "wilson_lb": round(_wilson(wins, decisive), 4) if decisive else None,
        "avg_net_r": round(float(net.mean()), 4),
        "decisive_net_r": round(float(net[dec_mask].mean()), 4) if decisive else None,
        "profit_factor": round(float(pos / neg), 4) if neg > 0 else None,
        "total_net_r": round(float(net.sum()), 2),
    }


def _reliability(rows: pd.DataFrame, bins: int = 10) -> str:
    out = ["  pred_bucket   n     pred_mean  actual_win"]
    edges = np.linspace(0, 1, bins + 1)
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (rows["p_win"] >= lo) & (rows["p_win"] < hi if hi < 1 else rows["p_win"] <= hi)
        sub = rows[m]
        if len(sub) == 0:
            continue
        out.append(f"  [{lo:.2f},{hi:.2f})  {len(sub):>6}   "
                   f"{sub['p_win'].mean():.3f}      {sub['label_win'].mean():.3f}")
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true", help="rebuild frames+dataset caches")
    ap.add_argument("--rebuild-dataset", action="store_true", help="rebuild dataset only")
    ap.add_argument("--hold", type=int, default=5)
    ap.add_argument("--top-n", type=int, default=10)
    ap.add_argument("--cost", type=float, default=0.05)
    ap.add_argument("--initial-days", type=int, default=500, help="warm-up days before first OOS")
    ap.add_argument("--step-days", type=int, default=60, help="OOS window / retrain cadence")
    ap.add_argument("--model-out", default=None, help="runtime joblib artifact path (default: per horizon)")
    args = ap.parse_args()
    model_out = args.model_out or artifact_path_for_horizon(args.hold)

    df = get_dataset(args.rebuild or args.rebuild_dataset, args.rebuild, args.hold)
    if "eligible" in df.columns:
        # Train and test on the setups the live engine may publish, nothing else.
        before = len(df)
        df = df[df["eligible"] == 1].reset_index(drop=True)
        print(f"Eligible setups (live gates): {len(df):,} of {before:,} rows, "
              f"fill rate {df['filled'].mean():.2f}")

    print(f"\nWalk-forward (initial={args.initial_days}d, step={args.step_days}d, "
          f"embargo={args.hold}d)...")
    oos = walk_forward(df, args.hold, args.initial_days, args.step_days)
    print(f"\nOOS predictions: {len(oos):,} rows over {oos['date'].nunique()} test days.")
    oos_cache = _horizon_cache(OOS_CACHE, args.hold)
    pd.to_pickle(oos, oos_cache)
    print(f"(saved OOS predictions to {os.path.basename(oos_cache)} for analysis)")

    # ---- classification quality (on trades that filled) ----
    graded = _filled(oos)
    auc = roc_auc_score(graded["label_win"], graded["p_win"])
    brier = brier_score_loss(graded["label_win"], graded["p_win"])
    print("\n" + "=" * 70)
    print("CLASSIFICATION QUALITY (out-of-sample)")
    print("=" * 70)
    print(f"ROC-AUC = {auc:.4f}   (0.5 = no skill; >0.55 starts to be useful)")
    print(f"Brier   = {brier:.4f}  (lower is better; <0.25 beats always-0.5)")
    print("Calibration reliability (pred vs actual win rate):")
    print(_reliability(graded))

    # ---- economic test ----
    cost = args.cost
    # ML selection: top-N by p_win each day.
    picks = (oos.sort_values(["date", "p_win"], ascending=[True, False])
                .groupby("date").head(args.top_n))
    ml = _econ_summary(picks, cost, f"ML top-{args.top_n}/day")
    allrows = _econ_summary(oos, cost, "ALL signals (no selection)")
    # naive baseline: top-N by the rule's own setup quality (no ML).
    rule_rank = (oos.assign(rule_score=oos["chart_setup_quality"] + 0.01 * oos["buy_score"])
                    .sort_values(["date", "rule_score"], ascending=[True, False])
                    .groupby("date").head(args.top_n))
    rule = _econ_summary(rule_rank, cost, f"RULE top-{args.top_n}/day (no ML)")

    print("\n" + "=" * 70)
    print("ECONOMIC TEST (after costs)   baseline to beat: decisive R = -0.037")
    print("=" * 70)
    hdr = f"{'selection':<26}{'trades':>7}{'dec_R':>9}{'avg_R':>9}{'PF':>8}{'wilson':>9}{'totalR':>10}"
    print(hdr)
    print("-" * len(hdr))
    for s in (ml, rule, allrows):
        print(f"{s['label']:<26}{s['trades']:>7}{_n(s.get('decisive_net_r')):>9}"
              f"{_n(s.get('avg_net_r')):>9}{_n(s.get('profit_factor')):>8}"
              f"{_n(s.get('wilson_lb')):>9}{_n(s.get('total_net_r')):>10}")

    print("\nVERDICT:")
    dec = ml.get("decisive_net_r")
    if dec is None:
        print("  No decisive ML trades — inconclusive.")
    elif dec > 0 and dec > rule.get("decisive_net_r", -9):
        print(f"  ML adds edge: decisive R {dec} > 0 and beats rule selection "
              f"({rule.get('decisive_net_r')}). Worth integrating + further validation.")
    else:
        print(f"  ML does NOT clear the bar: decisive R {dec}. Honest result — do "
              f"not ship as a 'winning' model. Next: better features / labels / horizon, "
              f"not a confident rollout.")

    save_runtime_artifact(df, oos, model_out, hold_days=args.hold)
    write_model_report(
        report_path_for_horizon(args.hold),
        hold_days=args.hold,
        top_n=args.top_n,
        cost=cost,
        auc=auc,
        brier=brier,
        base_rate=float(graded["label_win"].mean()),
        ml=ml,
        rule=rule,
        everything=allrows,
        oos=oos,
    )


def write_model_report(path: str, *, hold_days: int, top_n: int, cost: float, auc: float, brier: float,
                       base_rate: float, ml: dict, rule: dict, everything: dict, oos: pd.DataFrame) -> None:
    """Out-of-sample results the app reads to decide whether a horizon is shown.

    `publish` is the honest gate: the ML top-N must keep a positive average R
    after costs AND beat taking every signal. If it does not, the app says so
    instead of emailing picks that testing could not support.
    """
    import json
    from datetime import datetime, timezone

    ml_avg = ml.get("avg_net_r")
    all_avg = everything.get("avg_net_r")
    publish = ml_avg is not None and ml_avg > 0 and (all_avg is None or ml_avg > all_avg)
    report = {
        "hold_days": hold_days,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "oos_rows": int(len(oos)),
        "oos_days": int(oos["date"].nunique()),
        "oos_first_day": str(oos["date"].min()),
        "oos_last_day": str(oos["date"].max()),
        "roc_auc": round(float(auc), 4),
        "brier": round(float(brier), 4),
        "base_rate": round(base_rate, 4),
        "cost_r": cost,
        "top_n": top_n,
        "ml_top_n": ml,
        "rule_top_n": rule,
        "all_signals": everything,
        "publish": bool(publish),
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, indent=2)
    print(f"Saved model report: {path} (publish={publish})")


def _n(v) -> str:
    if v is None:
        return "—"
    return f"{v:.4f}" if abs(v) < 100 else f"{v:.1f}"


if __name__ == "__main__":
    main()
