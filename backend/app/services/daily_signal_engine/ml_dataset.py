"""Build a leakage-safe, labelled training table for the ML win-probability model.

For every (symbol, trading-day t) we:
  * compute the SAME causal features the live engine sees at the close of day t
    (nothing from t+1 onward leaks in),
  * take the rule engine's preferred direction + ATR-based entry/target/stop,
  * grade the trade over the next `hold_days` bars with the exact multi-day
    triple-barrier used by the backtest (`_grade_multiday`),
  * emit one row: features + direction + barrier prices + label + realised R.

The label is binary: 1 if the trade WON (target hit before stop, ambiguity
resolved conservatively), else 0. We also keep `realized_r` so the evaluator can
score expectancy in R, and `outcome` so we can separate decisive vs timeout.

This table is the single source of truth for training/eval — it is fully
self-contained and contains no lookahead, so a model trained on rows with
date < cutoff and tested on date >= cutoff is genuinely out-of-sample.
"""
from __future__ import annotations

import bisect
from datetime import date

import pandas as pd

from .backtest import _grade_limit_entry, _grade_multiday, _relative_strength, _sector_of
from .config import RISK_PROFILES, entry_zone, horizon_barrier_scale, is_publishable_setup
from .feature_engineering import build_feature_frame
from .market_regime import detect_market_regime
from .technical_rules import evaluate_technical_setup

# Feature columns the model will train on (order is stable).
FEATURE_COLUMNS = [
    "close_to_ema20", "ema20_to_ema50", "rsi", "adx", "atr_pct", "vol_ratio",
    "dist_resistance_atr", "dist_support_atr", "ret5", "ret20", "range_pct",
    "rel_strength", "sector_strength", "regime_score",
    "regime_align_buy", "regime_align_sell", "dir_buy",
    "buy_score", "sell_score", "chart_setup_quality",
    # --- phase 1: causal market/sector breadth (cross-sectional context) ---
    "mkt_above_ema50", "mkt_above_ema20", "mkt_adv5", "mkt_breadth_chg",
    "sector_above_ema50", "sector_vs_market",
    # --- phase 2: leakage-safe earnings proximity (see _earnings_features) ---
    "days_since_earnings", "days_to_earnings", "pre_earnings", "post_earnings",
]


def _earnings_features(day_d: date, dts: list[date]) -> tuple[float, float, float, float]:
    """Causal earnings-proximity features as known at the close of `day_d`.

    Returns (days_since_norm, days_to_norm, pre_earnings, post_earnings).
      * days_since uses only PAST dates (fully causal), normalised /90 and capped.
      * days_to uses the next FUTURE date but is CLIPPED to 30 days, because a
        results date further out than ~a month wasn't yet publicly scheduled —
        clipping prevents leaking a date the market didn't know.
      * pre/post are binary run-up / drift-window flags (within 5 sessions).
    No earnings info -> (1.0 far-since, 1.0 far-to, 0, 0) i.e. "nothing nearby".
    """
    if not dts:
        return 1.0, 1.0, 0.0, 0.0
    i = bisect.bisect_right(dts, day_d)  # dts[:i] are <= day_d (known/past)
    days_since = (day_d - dts[i - 1]).days if i > 0 else None
    days_to = (dts[i] - day_d).days if i < len(dts) else None
    since_norm = min(days_since, 90) / 90.0 if days_since is not None else 1.0
    to_norm = min(days_to, 30) / 30.0 if days_to is not None else 1.0
    pre = 1.0 if (days_to is not None and 0 < days_to <= 5) else 0.0
    post = 1.0 if (days_since is not None and 0 <= days_since <= 5) else 0.0
    return since_norm, to_norm, pre, post


def _safe(num: float, den: float, default: float = 0.0) -> float:
    return float(num / den) if den not in (0, 0.0) else default


def build_labeled_dataset(
    price_frames: dict[str, pd.DataFrame],
    index_frame_raw: pd.DataFrame,
    *,
    risk_level: str = "Balanced",
    hold_days: int = 5,
    ambiguous_as: str = "loss",
    warmup_days: int = 60,
    earnings_dates: dict[str, list[str]] | None = None,
    grading: str = "limit_entry",
) -> pd.DataFrame:
    """`grading='limit_entry'` (default) grades the order a reader can place and
    drops setups that would not have filled; 'legacy' keeps the original
    assume-filled grader for reproducing older results."""
    profile = RISK_PROFILES.get(risk_level, RISK_PROFILES["Balanced"])
    # Barriers shrink with the holding period (identical to before at 5 days).
    scale = horizon_barrier_scale(hold_days)
    target_mult = profile["target_atr_multiplier"] * scale
    stop_mult = profile["stop_atr_multiplier"] * scale

    # Per-ticker sorted earnings dates (date objects) for causal proximity feats.
    earn_dt: dict[str, list[date]] = {}
    if earnings_dates:
        for tk, ds in earnings_dates.items():
            parsed = sorted({date.fromisoformat(d[:10]) for d in ds if d})
            if not parsed:
                continue
            bare = tk.replace(".NS", "").replace(".BO", "")
            for alias in {tk, bare, bare + ".NS"}:  # tolerate either key form
                earn_dt.setdefault(alias, parsed)

    # Causal feature frames once.
    feats: dict[str, pd.DataFrame] = {}
    for ticker, raw in price_frames.items():
        f = build_feature_frame(raw)
        if not f.empty and "date" in f.columns:
            feats[ticker] = f.sort_values("date").reset_index(drop=True)

    index_feat = build_feature_frame(index_frame_raw).sort_values("date").reset_index(drop=True)
    index_dates = [str(pd.Timestamp(d).date()) for d in index_feat["date"]]
    index_pos = {d: i for i, d in enumerate(index_dates)}
    index_close = index_feat["close"]

    # Precompute regime per index date ONCE (expensive otherwise).
    regime_by_date: dict[str, dict] = {}
    for i in range(len(index_feat)):
        if i < warmup_days:
            continue
        regime_by_date[index_dates[i]] = detect_market_regime(index_feat.iloc[: i + 1])

    # Per-ticker lookups + ordered raw bars for forward grading.
    date_pos: dict[str, dict[str, int]] = {}
    raw_bars: dict[str, list[dict[str, float]]] = {}
    raw_pos: dict[str, dict[str, int]] = {}
    for ticker, f in feats.items():
        date_pos[ticker] = {str(pd.Timestamp(d).date()): i for i, d in enumerate(f["date"])}
    for ticker, raw in price_frames.items():
        r = raw.sort_values("date").reset_index(drop=True)
        raw_bars[ticker] = [
            {"open": float(x["open"]), "high": float(x["high"]),
             "low": float(x["low"]), "close": float(x["close"])}
            for _, x in r.iterrows()
        ]
        raw_pos[ticker] = {str(pd.Timestamp(d).date()): i for i, d in enumerate(r["date"])}

    # Pass 1: relative strength per (ticker, day) -> for sector strength.
    # Done lazily inside the main loop, but sector strength needs the whole
    # cross-section for that day, so we compute rs per day first.
    rows: list[dict] = []
    tickers = list(feats.keys())

    prev_mkt_above50: float | None = None  # for breadth-change feature

    for day in index_dates[warmup_days:]:
        regime = regime_by_date.get(day)
        if regime is None:
            continue
        idx_i = index_pos[day]
        idx_close_slice = index_close.iloc[: idx_i + 1]
        day_d = date.fromisoformat(day)

        # rel strength + per-ticker snapshot for breadth, for every ticker today
        rs_today: dict[str, float] = {}
        snap: dict[str, dict[str, float]] = {}
        for ticker in tickers:
            pos = date_pos[ticker].get(day)
            if pos is None or pos < 50:
                continue
            row = feats[ticker].iloc[pos]
            rs_today[ticker] = _relative_strength(feats[ticker]["close"].iloc[: pos + 1], idx_close_slice)
            snap[ticker] = {
                "close": float(row["close"]), "ema20": float(row["ema20"]),
                "ema50": float(row["ema50"]), "ret5": float(row["ret5"]),
            }

        # sector strength = mean rs of sector members today
        sector_acc: dict[str, list[float]] = {}
        for ticker, rs in rs_today.items():
            sector_acc.setdefault(_sector_of(ticker), []).append(rs)
        sector_strength = {s: sum(v) / len(v) for s, v in sector_acc.items()}

        # --- causal market & sector breadth (cross-sectional, as-of day t) ---
        n_snap = len(snap)
        if n_snap == 0:
            continue
        mkt_above_ema50 = sum(1 for s in snap.values() if s["close"] > s["ema50"]) / n_snap
        mkt_above_ema20 = sum(1 for s in snap.values() if s["close"] > s["ema20"]) / n_snap
        mkt_adv5 = sum(1 for s in snap.values() if s["ret5"] > 0) / n_snap
        mkt_breadth_chg = 0.0 if prev_mkt_above50 is None else (mkt_above_ema50 - prev_mkt_above50)
        prev_mkt_above50 = mkt_above_ema50

        sector_breadth: dict[str, float] = {}
        sec_members: dict[str, list[float]] = {}
        for ticker, s in snap.items():
            sec_members.setdefault(_sector_of(ticker), []).append(1.0 if s["close"] > s["ema50"] else 0.0)
        for sct, vals in sec_members.items():
            sector_breadth[sct] = sum(vals) / len(vals)

        for ticker, rs in rs_today.items():
            pos = date_pos[ticker][day]
            latest = feats[ticker].iloc[pos]
            close = float(latest["close"])
            atr = float(latest["atr14"])
            if close <= 0 or atr <= 0:
                continue

            sec = sector_strength.get(_sector_of(ticker), 0.0)
            setup = evaluate_technical_setup(latest.to_dict(), rs, sec)
            direction = setup["direction"]
            if direction not in {"BUY", "SELL"}:
                # "HOLD" means the rules see no trade. These rows used to be
                # graded as if they were SELLs, which the live engine never
                # does, and they skewed both training and the test.
                continue

            entry_low, entry_high = entry_zone(direction, close, atr, hold_days)
            if direction == "BUY":
                target_price = close + atr * target_mult
                stop_loss = close - atr * stop_mult
                risk_reward = max((target_price - close) / max(close - stop_loss, 1e-6), 0)
            else:
                target_price = close - atr * target_mult
                stop_loss = close + atr * stop_mult
                risk_reward = max((close - target_price) / max(stop_loss - close, 1e-6), 0)

            # forward grade
            rp = raw_pos.get(ticker, {}).get(day)
            if rp is None:
                continue
            fwd = raw_bars[ticker][rp + 1: rp + 1 + hold_days]
            if not fwd:
                continue
            sig = {
                "direction": direction, "target_price": target_price, "stop_loss": stop_loss,
                "entry_low": entry_low, "entry_high": entry_high, "risk_reward": risk_reward,
            }
            if grading == "legacy":
                graded = _grade_multiday(sig, fwd, ambiguous_as=ambiguous_as)
            else:
                # NO_FILL rows stay in the table (0R, filled=0): the daily
                # ranking must choose among every setup it could have sent,
                # not only the ones that turned out to fill. Training uses
                # filled rows only.
                graded = _grade_limit_entry(sig, fwd, ambiguous_as=ambiguous_as)

            rows.append({
                "date": day,
                "ticker": ticker,
                "direction": direction,
                "regime_label": regime["label"],
                # --- features ---
                "close_to_ema20": _safe(close, float(latest["ema20"])) - 1,
                "ema20_to_ema50": _safe(float(latest["ema20"]), float(latest["ema50"])) - 1,
                "rsi": float(latest["rsi14"]) / 100,
                "adx": float(latest["adx14"]) / 50,
                "atr_pct": atr / close,
                "vol_ratio": _safe(float(latest["volume"]), float(latest["vol_avg20"])),
                "dist_resistance_atr": _safe(float(latest["resistance20"]) - close, atr),
                "dist_support_atr": _safe(close - float(latest["support20"]), atr),
                "ret5": float(latest["ret5"]),
                "ret20": float(latest["ret20"]),
                "range_pct": float(latest["range_pct"]),
                "rel_strength": rs,
                "sector_strength": sec,
                "regime_score": float(regime.get("score", 0.0)),
                "regime_align_buy": float(regime.get("alignment_buy", 0.0)),
                "regime_align_sell": float(regime.get("alignment_sell", 0.0)),
                "dir_buy": 1.0 if direction == "BUY" else 0.0,
                "buy_score": float(setup["buy_score"]),
                "sell_score": float(setup["sell_score"]),
                "chart_setup_quality": float(setup["chart_setup_quality"]),
                # --- phase 1 breadth features (same for all stocks that day,
                #     except the sector ones) ---
                "mkt_above_ema50": mkt_above_ema50,
                "mkt_above_ema20": mkt_above_ema20,
                "mkt_adv5": mkt_adv5,
                "mkt_breadth_chg": mkt_breadth_chg,
                "sector_above_ema50": sector_breadth.get(_sector_of(ticker), 0.0),
                "sector_vs_market": sector_breadth.get(_sector_of(ticker), 0.0) - mkt_above_ema50,
                # --- phase 2: leakage-safe earnings proximity ---
                **dict(zip(
                    ("days_since_earnings", "days_to_earnings", "pre_earnings", "post_earnings"),
                    _earnings_features(day_d, earn_dt.get(ticker, [])),
                )),
                # --- barrier / outcome ---
                "risk_reward": risk_reward,
                "outcome": graded["outcome"],
                "realized_r": float(graded["realized_r"]),
                "label_win": 1 if graded["outcome"] == "WIN" else 0,
                "filled": 0 if graded["outcome"] == "NO_FILL" else 1,
                "directional_edge": int(setup.get("directional_edge") or 0),
                # Passes the live publishing gates; training and testing use these rows only.
                "eligible": 1 if is_publishable_setup(setup) else 0,
            })

    return pd.DataFrame(rows)
