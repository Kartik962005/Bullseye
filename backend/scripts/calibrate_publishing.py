"""Decide which forecasts are strong enough to publish, out of sample.

A forecast with a 51% chance is barely better than a coin toss, and a list of
those reads as wrong most days. This script finds, for each horizon and side,
the confidence a call needs before it is published:

  1. walks forward exactly as train_forecast.py does (same models, same seeds),
     keeping every out-of-sample prediction;
  2. on the first half, picks the loosest cut-off whose calls both moved the
     way they were called and beat (or lagged) the market at least
     TARGET_RATE of the time;
  3. checks that cut-off on the second half, untouched. Only a cut-off that
     holds there is published; the second-half numbers are what the app quotes;
  4. keeps the last RECENT_SESSIONS sessions of the test day by day. The app
     rolls that window forward with live results and pauses a side whose recent
     record slips below the bar, even if it held up over the whole test.

    cd backend
    python scripts/calibrate_publishing.py            # report only
    python scripts/calibrate_publishing.py --write    # also save the rule into the artifacts
"""
from __future__ import annotations

import json
import os
import sys
import time

import joblib
import numpy as np
import pandas as pd

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
sys.path.insert(0, _BACKEND)
sys.path.insert(0, _HERE)

from train_forecast import COST, FRAMES_CACHE, INITIAL_DAYS, STEP_DAYS, fit_classifiers, list_stats  # noqa: E402

from app.services.daily_signal_engine.forecast import HORIZONS, forecast_frame  # noqa: E402

ARTIFACT_DIR = os.path.join(_BACKEND, "app", "services", "daily_signal_engine", "artifacts")
TARGET_RATE = 0.56        # first half: both rates at least this
CONFIRM_RATE = 0.55       # second half: both rates at least this, or the side is not published
CONFIRM_T = 2.0           # and the daily edge must be clear of noise
MIN_CALLS = 250           # too few calls on either half and the rate means little
RECENT_SESSIONS = 120     # the latest stretch of the test, kept day by day (matches the app)
MAX_PER_DAY = 5
SECTOR_CAP = 2
BUY_CUTS = [0.50, 0.52, 0.53, 0.54, 0.55, 0.56, 0.57, 0.58, 0.60, 0.62, 0.65]
SELL_CUTS = [0.46, 0.45, 0.44, 0.43, 0.42, 0.41, 0.40, 0.38, 0.36, 0.34]


def oos_predictions(data: pd.DataFrame, h: int, chosen: str) -> pd.DataFrame:
    """The classifier's walk-forward predictions, as in train_forecast.walk_forward."""
    dates = sorted(data["date"].unique())
    pieces = []
    start = INITIAL_DAYS
    while start < len(dates):
        t0 = time.time()
        test_dates = set(dates[start:start + STEP_DAYS])
        train = data[data["date"] <= dates[max(0, start - h - 1)]]
        test = data[data["date"].isin(test_dates)]
        ensemble, single = fit_classifiers(train, h)
        model = ensemble if chosen == "ensemble" else single
        pieces.append(pd.DataFrame({
            "date": test["date"].to_numpy(), "ticker": test["ticker"].to_numpy(), "sector": test["sector"].to_numpy(),
            "p": model.predict_proba(test)[:, 1], "s": model.score(test),
            f"fwd_{h}": test[f"fwd_{h}"].to_numpy(), f"excess_{h}": test[f"excess_{h}"].to_numpy(),
        }))
        print(f"  {h}d fold {min(test_dates)}..{max(test_dates)} ({time.time() - t0:.0f}s)", flush=True)
        start += STEP_DAYS
    return pd.concat(pieces, ignore_index=True)


def picks(frame: pd.DataFrame, side: str, cut: float) -> pd.DataFrame:
    """What would have been published: past the cut-off, strongest first, capped per sector and per day."""
    buy = side == "buy"
    passing = frame[frame["p"] >= cut] if buy else frame[frame["p"] <= cut]
    ordered = passing.sort_values(["date", "p", "s"], ascending=[True, not buy, not buy])
    ordered = ordered[ordered.groupby(["date", "sector"]).cumcount() < SECTOR_CAP]
    return ordered.groupby("date").head(MAX_PER_DAY)


def stats(chosen: pd.DataFrame, frame: pd.DataFrame, h: int, side: str) -> dict:
    sign = 1 if side == "buy" else -1
    days = int(frame["date"].nunique())
    out = {"calls": int(len(chosen)), "days": days}
    if chosen.empty:
        return out
    daily = sign * chosen.groupby("date")[f"excess_{h}"].mean()
    # Overlapping multi-session windows: divide by sqrt(h) so the t-stat is not flattered.
    t = float(daily.mean() / (daily.std(ddof=1) / np.sqrt(len(daily))) / np.sqrt(h)) if len(daily) > 2 else 0.0
    return {
        **out,
        "days_with_calls": round(chosen["date"].nunique() / days, 4),
        "calls_per_day": round(len(chosen) / days, 2),
        # Moved the way it was called: rose after a buy, fell after a sell.
        "right_rate": round(float((sign * chosen[f"fwd_{h}"] > 0).mean()), 4),
        # Beat the average Nifty 200 stock (buy) or lagged it (sell).
        "market_rate": round(float((sign * chosen[f"excess_{h}"] > 0).mean()), 4),
        "avg_move": round(float((sign * chosen[f"fwd_{h}"]).mean()), 5),
        "avg_after_cost": round(float((sign * chosen[f"fwd_{h}"]).mean() - COST[h]), 5),
        "t_stat": round(t, 2),
    }


def recent(frame: pd.DataFrame, h: int, side: str, cut: float) -> dict:
    """The cut-off's calls over the last RECENT_SESSIONS sessions of the test, with a
    row per session: [date, calls, moved as called, beat (buy) or lagged (sell) the market]."""
    days = sorted(frame["date"].unique())[-RECENT_SESSIONS:]
    window = frame[frame["date"].isin(days)]
    chosen = picks(window, side, cut)
    sign = 1 if side == "buy" else -1
    daily = (
        chosen.assign(moved=sign * chosen[f"fwd_{h}"] > 0, market=sign * chosen[f"excess_{h}"] > 0)
        .groupby("date").agg(calls=("moved", "size"), moved=("moved", "sum"), market=("market", "sum"))
        .reindex(days, fill_value=0)
    )
    return {
        **stats(chosen, window, h, side),
        "first_day": str(days[0]),
        "last_day": str(days[-1]),
        "daily": [[str(day), int(row.calls), int(row.moved), int(row.market)] for day, row in daily.iterrows()],
    }


def base_rates(frame: pd.DataFrame, h: int) -> dict:
    return {
        "rose_rate": round(float((frame[f"fwd_{h}"] > 0).mean()), 4),
        "beat_rate": round(float((frame[f"excess_{h}"] > 0).mean()), 4),
    }


def decide(select: pd.DataFrame, confirm: pd.DataFrame, h: int, side: str) -> tuple[dict | None, list[dict]]:
    cuts = BUY_CUTS if side == "buy" else SELL_CUTS
    table = []
    for cut in cuts:
        table.append({"cut": cut, "selection": stats(picks(select, side, cut), select, h, side),
                      "confirmation": stats(picks(confirm, side, cut), confirm, h, side)})
    rule = None
    for row in table:  # loosest first
        s = row["selection"]
        if s["calls"] >= MIN_CALLS and s.get("right_rate", 0) >= TARGET_RATE and s.get("market_rate", 0) >= TARGET_RATE:
            rule = row
            break
    if rule is None:
        # Nothing reached the bar: keep the strongest cut-off's numbers (chosen on
        # the first half, quoted from the second) so the app can say how close it came.
        usable = [row for row in table if row["selection"]["calls"] >= MIN_CALLS]
        best = max(usable, key=lambda row: min(row["selection"].get("right_rate", 0), row["selection"].get("market_rate", 0)), default=None)
        return {"cut": None, "confirmed": False, "best": best["confirmation"] if best else None}, table
    c = rule["confirmation"]
    confirmed = (c["calls"] >= MIN_CALLS and c.get("right_rate", 0) >= CONFIRM_RATE
                 and c.get("market_rate", 0) >= CONFIRM_RATE and c.get("t_stat", 0) >= CONFIRM_T)
    return {"cut": rule["cut"], "confirmed": confirmed, "selection": rule["selection"], "confirmation": c}, table


def fmt_recent(r: dict) -> str:
    if not r.get("calls"):
        return "no calls"
    return (f"{r['calls']} calls, right {r['right_rate']:.3f}, mkt {r['market_rate']:.3f}, "
            f"after cost {r['avg_after_cost']:+.4f}, t {r['t_stat']}")


def main() -> None:
    write = "--write" in sys.argv
    frames = pd.read_pickle(FRAMES_CACHE)
    df = None
    for h in HORIZONS:
        cache = os.path.join(_HERE, f"oos_forecast_h{h}.pkl")
        report_path = os.path.join(ARTIFACT_DIR, f"forecast_report_h{h}.json")
        report = json.load(open(report_path, encoding="utf-8"))
        if os.path.exists(cache):
            oos = pd.read_pickle(cache)
        else:
            if df is None:
                print(f"Building features for {len(frames['price_frames'])} stocks ...", flush=True)
                df = forecast_frame(frames["price_frames"], frames["index_frame"], horizons=HORIZONS)
                bad = df["anomaly"] > 0
                for k in HORIZONS:
                    bad |= df[f"fwd_{k}"].abs() > 0.45
                df = df[~bad].reset_index(drop=True)
            data = df.dropna(subset=[f"fwd_{h}", f"excess_{h}"]).reset_index(drop=True)
            print(f"\n=== {h}-session horizon ({report['model']} model)", flush=True)
            oos = oos_predictions(data, h, report["model"])
            oos.to_pickle(cache)
        days = sorted(oos["date"].unique())
        split = days[len(days) // 2]
        select, confirm = oos[oos["date"] < split], oos[oos["date"] >= split]

        # Same walk-forward as training: the confirmation numbers should match the saved report.
        check = list_stats(confirm.assign(**{f"p_x": confirm["p"], "s_x": confirm["s"]}), h, "p_x", "s_x")
        print(f"\n=== {h}-session: reproduces report? buy beat {check['buy']['beat_rate']} vs "
              f"{report['confirmation']['buy']['beat_rate']}, sell lag {check['sell']['lag_rate']} vs "
              f"{report['confirmation']['sell']['lag_rate']}")
        print(f"  base rates  selection {base_rates(select, h)}  confirmation {base_rates(confirm, h)}")

        publish = {"max_per_day": MAX_PER_DAY, "sector_cap": SECTOR_CAP, "bar": CONFIRM_RATE,
                   "first_day": str(confirm["date"].min()), "last_day": str(confirm["date"].max()),
                   "days": int(confirm["date"].nunique()), "base": base_rates(confirm, h)}
        for side in ("buy", "sell") if h == 1 else ("buy",):
            rule, table = decide(select, confirm, h, side)
            print(f"  {side.upper()} cut-offs (selection half | confirmation half):")
            for row in table:
                s, c = row["selection"], row["confirmation"]
                print(f"    p {'>=' if side == 'buy' else '<='} {row['cut']:.2f}: "
                      f"{s.get('calls_per_day', 0):>4} /day, right {s.get('right_rate', 0):.3f}, mkt {s.get('market_rate', 0):.3f}, "
                      f"t {s.get('t_stat', 0):>5} | {c.get('calls_per_day', 0):>4} /day "
                      f"(days with calls {c.get('days_with_calls', 0):.2f}), right {c.get('right_rate', 0):.3f}, "
                      f"mkt {c.get('market_rate', 0):.3f}, after cost {c.get('avg_after_cost', 0):+.4f}, t {c.get('t_stat', 0)}")
            if rule.get("cut") is not None:
                rule["recent"] = recent(confirm, h, side, rule["cut"])
                r = rule["recent"]
                holds = min(r.get("right_rate", 0), r.get("market_rate", 0)) >= CONFIRM_RATE
                print(f"  {side.upper()} last {RECENT_SESSIONS} sessions ({r['first_day']}..{r['last_day']}): "
                      f"{fmt_recent(r)} -> {'holds' if holds else 'below the bar: the app pauses this side'}")
            print(f"  {side.upper()} rule: {json.dumps({k: v for k, v in rule.items() if k != 'recent'})}")
            # Published only when confirmed; otherwise kept so the app can explain the pause.
            publish[side] = rule
        report["publish"] = publish
        if write:
            with open(report_path, "w", encoding="utf-8") as fh:
                json.dump(report, fh, indent=2)
            artifact_path = os.path.join(ARTIFACT_DIR, f"forecast_h{h}.joblib")
            artifact = joblib.load(artifact_path)
            artifact["publish"] = publish
            joblib.dump(artifact, artifact_path, compress=3)
            print(f"  saved the publishing rule into forecast_h{h}.joblib and its report")


if __name__ == "__main__":
    main()
