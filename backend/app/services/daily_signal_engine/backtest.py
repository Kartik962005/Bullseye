"""Leakage-safe walk-forward backtest for the daily signal engine.

Purpose
-------
Measure whether the CURRENT rule/score engine actually has predictive edge,
before investing in ML, calibration, a larger universe, etc.

Design decisions (read these before trusting the numbers):
- **No lookahead.** For each trading day `t` we build the signal using only
  data up to and including the close of day `t` (exactly what production has
  the evening it emails users), then we grade it against day `t+1`'s OHLC bar.
- **Multi-day triple-barrier outcome.** Each pick is HELD for up to
  `hold_days` sessions (default 5), walking bars t+1, t+2, ... The first bar
  that touches target -> WIN, that touches stop -> LOSS. If neither is touched
  by the horizon, we exit at the horizon close (TIME_EXIT, marked to close).
  This is the honest fix for the single-day "mark-to-close" artifact: a trade
  only counts as a winner/loser when a barrier is actually hit.
- **Conservative same-day ambiguity.** With daily bars we cannot know whether
  target or stop was hit first intraday. When BOTH are touched in one session
  we score it a LOSS by default (`ambiguous_as="loss"`) so results lean
  pessimistic, not optimistic. (Production scores it NEUTRAL — we deliberately
  diverge here to avoid flattering the engine.)
- **Decisive vs time-exit are reported separately** so a positive headline
  cannot hide behind unresolved positions marked to close.
- **Realistic costs.** A flat round-trip cost (in R units) is subtracted from
  every trade's realised R, matching the cost assumption already baked into
  `compute_expected_r` (0.03 txn + 0.02 slippage = 0.05R by default).
- We reuse the production functions (`evaluate_technical_setup`,
  `predict_signal_probabilities`, the ATR entry/target/stop math, the gating
  thresholds) so this grades the *real* engine, not a copy.

Known limitations (so nobody over-reads a good result):
- Daily-bar triple barrier cannot resolve same-day target+stop ordering.
- Survivorship: only the symbols currently in the data are tested.
- Sample is whatever history you have cached (often ~1 year) -> wide
  confidence intervals. Always read the Wilson lower bound, not raw win rate.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from .config import (
    MAX_SELECTED_SIGNALS,
    RISK_PROFILES,
    SECTOR_BY_SYMBOL,
    UNIVERSE_AVERAGE_WIN_RATE,
)
from .feature_engineering import build_feature_frame
from .market_regime import detect_market_regime
from .ml_interface import predict_signal_probabilities
from .scoring import compute_expected_r, compute_final_score, wilson_lower_bound_placeholder
from .technical_rules import evaluate_technical_setup

DEFAULT_COST_R = 0.05  # 0.03 txn + 0.02 slippage, matches compute_expected_r defaults


def _sector_of(ticker: str) -> str:
    return SECTOR_BY_SYMBOL.get(ticker.replace(".NS", "").replace(".BO", ""), "General")


def _relative_strength(close: pd.Series, index_close: pd.Series) -> float:
    """Causal 21-bar relative strength vs index (matches production)."""
    if len(close) < 22 or len(index_close) < 22:
        return 0.0
    stock_ret = float(close.iloc[-1] / close.iloc[-21] - 1)
    index_ret = float(index_close.iloc[-1] / index_close.iloc[-21] - 1)
    return (stock_ret - index_ret) * 100


@dataclass
class Trade:
    date: str
    ticker: str
    direction: str
    setup_type: str
    confidence: float
    risk_reward: float
    regime: str
    realized_r: float          # gross R from triple-barrier
    net_r: float               # after costs
    outcome: str               # WIN / LOSS / TIME_EXIT
    exit_reason: str = ""      # target / stop / ambiguous_day / time
    days_held: int = 0


def _grade_multiday(
    signal: dict[str, Any],
    forward_bars: list[dict[str, float]],
    *,
    ambiguous_as: str = "loss",
) -> dict[str, Any]:
    """Hold the trade across `forward_bars` and resolve the first barrier hit.

    Returns outcome WIN/LOSS/TIME_EXIT with realised R. WIN pays the signal's
    risk_reward, LOSS pays -1.0R, TIME_EXIT marks to the horizon close. Same-day
    target+stop ambiguity is resolved by `ambiguous_as` ('loss' = conservative).
    """
    direction = signal["direction"]
    target = float(signal["target_price"])
    stop = float(signal["stop_loss"])
    entry = float(signal["entry_high"] if direction == "SELL" else signal["entry_low"])
    rr = float(signal["risk_reward"])

    def _close_r(close: float) -> float:
        if direction == "BUY":
            return (close - entry) / max(entry - stop, 1e-6)
        return (entry - close) / max(stop - entry, 1e-6)

    for i, bar in enumerate(forward_bars):
        high = float(bar["high"])
        low = float(bar["low"])
        close = float(bar["close"])
        if direction == "BUY":
            target_hit = high >= target
            stop_hit = low <= stop
        else:
            target_hit = low <= target
            stop_hit = high >= stop

        if target_hit and stop_hit:
            if ambiguous_as == "win":
                return {"outcome": "WIN", "realized_r": rr, "exit": "ambiguous_day", "days_held": i + 1}
            if ambiguous_as == "neutral":
                return {"outcome": "TIME_EXIT", "realized_r": round(_close_r(close), 4), "exit": "ambiguous_day", "days_held": i + 1}
            return {"outcome": "LOSS", "realized_r": -1.0, "exit": "ambiguous_day", "days_held": i + 1}
        if target_hit:
            return {"outcome": "WIN", "realized_r": rr, "exit": "target", "days_held": i + 1}
        if stop_hit:
            return {"outcome": "LOSS", "realized_r": -1.0, "exit": "stop", "days_held": i + 1}

    last_close = float(forward_bars[-1]["close"]) if forward_bars else entry
    return {"outcome": "TIME_EXIT", "realized_r": round(_close_r(last_close), 4),
            "exit": "time", "days_held": len(forward_bars)}


def _grade_limit_entry(
    signal: dict[str, Any],
    forward_bars: list[dict[str, float]],
    *,
    ambiguous_as: str = "loss",
) -> dict[str, Any]:
    """Grade the order a reader can actually place after the evening email.

    A limit order at the edge of the entry zone, good for the next session only:
      * BUY fills at the open if the open is at or below the top of the zone,
        otherwise at the zone top if the day trades down into it. SELL mirrors.
      * No fill, or an open already through the stop, means no trade
        ("NO_FILL", 0R). The old grader assumed every trade filled at the
        better edge of the zone without checking, which flattered short
        horizons where the risk unit is small.
    Once filled, R is measured from the actual fill: WIN pays (target - fill) /
    (fill - stop), LOSS pays -1, and an open position is marked to the last
    close of the horizon. A fill bar that touches both levels counts per
    `ambiguous_as` ('loss' is the conservative default).
    """
    no_fill = {"outcome": "NO_FILL", "realized_r": 0.0, "exit": "no_fill", "days_held": 0}
    if not forward_bars:
        return no_fill
    direction = signal["direction"]
    target = float(signal["target_price"])
    stop = float(signal["stop_loss"])
    first = forward_bars[0]
    open_, high, low = float(first["open"]), float(first["high"]), float(first["low"])

    if direction == "BUY":
        limit = float(signal["entry_high"])
        # Opening below the entry zone (or through either level) breaks the
        # setup; it also keeps a fill from landing just above the stop, where a
        # tiny risk unit would turn ordinary moves into huge R values.
        if open_ < float(signal["entry_low"]) or open_ <= stop or open_ >= target:
            return no_fill
        fill = open_ if open_ <= limit else (limit if low <= limit else None)
        if fill is None or fill <= stop:
            return no_fill
        risk = fill - stop
        reward_r = (target - fill) / risk
    else:
        limit = float(signal["entry_low"])
        if open_ > float(signal["entry_high"]) or open_ >= stop or open_ <= target:
            return no_fill
        fill = open_ if open_ >= limit else (limit if high >= limit else None)
        if fill is None or fill >= stop:
            return no_fill
        risk = stop - fill
        reward_r = (fill - target) / risk

    def _close_r(close: float) -> float:
        return ((close - fill) if direction == "BUY" else (fill - close)) / risk

    # Filled at the limit during the day: that bar's extreme in the target's
    # direction may have come before the fill, so it cannot count as a win.
    filled_intraday = fill != open_
    for i, bar in enumerate(forward_bars):
        high = float(bar["high"])
        low = float(bar["low"])
        close = float(bar["close"])
        if direction == "BUY":
            target_hit, stop_hit = high >= target, low <= stop
        else:
            target_hit, stop_hit = low <= target, high >= stop
        if i == 0 and filled_intraday:
            target_hit = False
        if target_hit and stop_hit:
            if ambiguous_as == "win":
                return {"outcome": "WIN", "realized_r": round(reward_r, 4), "exit": "ambiguous_day", "days_held": i + 1, "fill": fill}
            if ambiguous_as == "neutral":
                return {"outcome": "TIME_EXIT", "realized_r": round(_close_r(close), 4), "exit": "ambiguous_day", "days_held": i + 1, "fill": fill}
            return {"outcome": "LOSS", "realized_r": -1.0, "exit": "ambiguous_day", "days_held": i + 1, "fill": fill}
        if target_hit:
            return {"outcome": "WIN", "realized_r": round(reward_r, 4), "exit": "target", "days_held": i + 1, "fill": fill}
        if stop_hit:
            return {"outcome": "LOSS", "realized_r": -1.0, "exit": "stop", "days_held": i + 1, "fill": fill}

    return {"outcome": "TIME_EXIT", "realized_r": round(_close_r(float(forward_bars[-1]["close"])), 4),
            "exit": "time", "days_held": len(forward_bars), "fill": fill}


@dataclass
class BacktestResult:
    trades: list[Trade] = field(default_factory=list)
    n_days: int = 0
    skipped_no_next_bar: int = 0

    def add(self, trade: Trade) -> None:
        self.trades.append(trade)


def _wilson_lb(wins: int, decisive: int) -> float:
    if decisive <= 0:
        return 0.0
    return wilson_lower_bound_placeholder(wins, decisive)


def _summarise(trades: list[Trade], label: str) -> dict[str, Any]:
    n = len(trades)
    if n == 0:
        return {"segment": label, "trades": 0}
    wins = sum(1 for t in trades if t.outcome == "WIN")
    losses = sum(1 for t in trades if t.outcome == "LOSS")
    time_exits = sum(1 for t in trades if t.outcome == "TIME_EXIT")
    decisive = wins + losses
    gross_pos = sum(t.net_r for t in trades if t.net_r > 0)
    gross_neg = sum(-t.net_r for t in trades if t.net_r < 0)
    total_net_r = sum(t.net_r for t in trades)
    decisive_net_r = sum(t.net_r for t in trades if t.outcome in ("WIN", "LOSS"))
    time_exit_net_r = sum(t.net_r for t in trades if t.outcome == "TIME_EXIT")
    avg_days = sum(t.days_held for t in trades) / n
    return {
        "segment": label,
        "trades": n,
        "wins": wins,
        "losses": losses,
        "time_exits": time_exits,
        "raw_win_rate_decisive": round(wins / decisive, 4) if decisive else None,
        "win_rate_all": round(wins / n, 4),
        "wilson_lb_win_rate": round(_wilson_lb(wins, decisive), 4) if decisive else None,
        "profit_factor": round(gross_pos / gross_neg, 4) if gross_neg > 0 else None,
        "avg_net_r_per_trade": round(total_net_r / n, 4),
        # The honest split: expectancy from trades that actually resolved at a
        # barrier vs. trades that timed out and were marked to close.
        "decisive_avg_net_r": round(decisive_net_r / decisive, 4) if decisive else None,
        "time_exit_avg_net_r": round(time_exit_net_r / time_exits, 4) if time_exits else None,
        "avg_days_held": round(avg_days, 2),
        "total_net_r": round(total_net_r, 2),
    }


def run_backtest(
    price_frames: dict[str, pd.DataFrame],
    index_frame_raw: pd.DataFrame,
    *,
    risk_level: str = "Balanced",
    top_n: int = MAX_SELECTED_SIGNALS,
    cost_r: float = DEFAULT_COST_R,
    warmup_days: int = 60,
    hold_days: int = 5,
    ambiguous_as: str = "loss",
    allowed_regimes: set[str] | None = None,
    allowed_directions: set[str] | None = None,
    target_mult: float | None = None,
    stop_mult: float | None = None,
    conf_threshold: float | None = None,
    min_rr: float | None = None,
) -> dict[str, Any]:
    """Walk forward day-by-day and grade the engine's top-N picks.

    price_frames: {ticker: DataFrame[date, open, high, low, close, volume]}
    index_frame_raw: DataFrame for the market index (e.g. ^NSEI), same columns.

    Gating knobs (for cheap in-sample experiments — beware overfitting):
      allowed_regimes:    only trade days whose regime label is in this set.
      allowed_directions: only keep signals with these directions.
      target_mult/stop_mult/conf_threshold/min_rr: override the risk profile.
    """
    profile = RISK_PROFILES.get(risk_level, RISK_PROFILES["Balanced"])
    conf_threshold = profile["confidence_threshold"] if conf_threshold is None else conf_threshold
    min_rr = profile["min_risk_reward"] if min_rr is None else min_rr
    target_mult = profile["target_atr_multiplier"] if target_mult is None else target_mult
    stop_mult = profile["stop_atr_multiplier"] if stop_mult is None else stop_mult

    # Build causal feature frames once (all indicators are causal).
    feats: dict[str, pd.DataFrame] = {}
    for ticker, raw in price_frames.items():
        f = build_feature_frame(raw)
        if not f.empty and "date" in f.columns:
            f = f.sort_values("date").reset_index(drop=True)
            feats[ticker] = f

    index_feat = build_feature_frame(index_frame_raw).sort_values("date").reset_index(drop=True)
    index_by_date = {str(pd.Timestamp(d).date()): i for i, d in enumerate(index_feat["date"])}

    # Master sorted list of trading dates from the index.
    all_dates = [str(pd.Timestamp(d).date()) for d in index_feat["date"]]
    result = BacktestResult()

    # Per-ticker date -> row index lookup, and ORDERED raw bars so we can hold
    # a trade across the next `hold_days` sessions (not just one bar).
    date_pos: dict[str, dict[str, int]] = {}
    raw_bars: dict[str, list[dict[str, float]]] = {}
    raw_pos: dict[str, dict[str, int]] = {}
    for ticker, f in feats.items():
        date_pos[ticker] = {str(pd.Timestamp(d).date()): i for i, d in enumerate(f["date"])}
    for ticker, raw in price_frames.items():
        r = raw.sort_values("date").reset_index(drop=True)
        bars = [
            {"open": float(row["open"]), "high": float(row["high"]),
             "low": float(row["low"]), "close": float(row["close"])}
            for _, row in r.iterrows()
        ]
        raw_bars[ticker] = bars
        raw_pos[ticker] = {str(pd.Timestamp(d).date()): i for i, d in enumerate(r["date"])}

    for di in range(warmup_days, len(all_dates) - 1):
        day = all_dates[di]
        next_day = all_dates[di + 1]
        if day not in index_by_date:
            continue
        idx_pos = index_by_date[day]
        index_slice = index_feat.iloc[: idx_pos + 1]
        if len(index_slice) < 60:
            continue
        regime = detect_market_regime(index_slice)
        if allowed_regimes is not None and regime["label"] not in allowed_regimes:
            continue
        index_close = index_slice["close"]

        # Cross-sectional relative strength per ticker (for sector strength).
        rel_strength: dict[str, float] = {}
        for ticker, f in feats.items():
            pos = date_pos[ticker].get(day)
            if pos is None or pos < 21:
                continue
            rel_strength[ticker] = _relative_strength(f["close"].iloc[: pos + 1], index_close)

        sector_acc: dict[str, list[float]] = {}
        for ticker, rs in rel_strength.items():
            sector_acc.setdefault(_sector_of(ticker), []).append(rs)
        sector_strength = {s: (sum(v) / len(v)) for s, v in sector_acc.items()}

        candidates: list[dict[str, Any]] = []
        for ticker, f in feats.items():
            pos = date_pos[ticker].get(day)
            if pos is None or pos < 50:
                continue
            latest = f.iloc[pos]
            close = float(latest["close"])
            atr = float(latest["atr14"])
            if close <= 0 or atr <= 0:
                continue

            rs = rel_strength.get(ticker, 0.0)
            sec = sector_strength.get(_sector_of(ticker), 0.0)
            setup = evaluate_technical_setup(latest.to_dict(), rs, sec)
            if allowed_directions is not None and setup["direction"] not in allowed_directions:
                continue
            # quality_score not available without full validation -> use a
            # neutral proxy so probabilities stay comparable to production.
            probs = predict_signal_probabilities(setup, regime, risk_level, rs, 0.6)

            if setup["direction"] == "BUY":
                target_price = close + atr * target_mult
                stop_loss = close - atr * stop_mult
                entry_low = close - atr * 0.15
                entry_high = close + atr * 0.2
                target_r = max((target_price - close) / max(close - stop_loss, 1e-6), 0)
            else:
                target_price = close - atr * target_mult
                stop_loss = close + atr * stop_mult
                entry_low = close - atr * 0.2
                entry_high = close + atr * 0.15
                target_r = max((close - target_price) / max(stop_loss - close, 1e-6), 0)

            expected_r = compute_expected_r(probs["calibrated_pwin"], probs["p_loss"], target_r, 1.0)
            confidence = probs["confidence"]
            risk_reward = target_r

            # Same gating as production (daily_trade_service line ~553).
            if expected_r <= 0 or confidence < conf_threshold or risk_reward < min_rr:
                continue

            final_score = compute_final_score(
                calibrated_pwin=probs["calibrated_pwin"],
                expected_r=expected_r,
                adjusted_setup_win_rate=UNIVERSE_AVERAGE_WIN_RATE,
                market_regime_alignment=regime["alignment_buy"] if setup["direction"] == "BUY" else regime["alignment_sell"],
                chart_setup_quality=setup["chart_setup_quality"],
                relative_strength=min(1.0, abs(rs) / 5),
                liquidity_score=0.8,
                model_stability=probs["model_stability"],
                risk_penalties=0.0,
            )
            candidates.append({
                "ticker": ticker, "direction": setup["direction"],
                "entry_low": entry_low, "entry_high": entry_high,
                "target_price": target_price, "stop_loss": stop_loss,
                "risk_reward": risk_reward, "confidence": confidence,
                "final_score": final_score, "setup_type": setup["setup_type"],
            })

        candidates.sort(key=lambda c: c["final_score"], reverse=True)
        selected = candidates[:top_n]
        result.n_days += 1

        for sig in selected:
            ticker = sig["ticker"]
            pos_today = raw_pos.get(ticker, {}).get(day)
            if pos_today is None:
                result.skipped_no_next_bar += 1
                continue
            forward_bars = raw_bars[ticker][pos_today + 1: pos_today + 1 + hold_days]
            if not forward_bars:
                result.skipped_no_next_bar += 1
                continue
            outcome = _grade_multiday(sig, forward_bars, ambiguous_as=ambiguous_as)
            net_r = outcome["realized_r"] - cost_r
            result.add(Trade(
                date=day, ticker=ticker, direction=sig["direction"],
                setup_type=sig["setup_type"], confidence=round(sig["confidence"], 4),
                risk_reward=round(sig["risk_reward"], 4), regime=regime["label"],
                realized_r=outcome["realized_r"], net_r=round(net_r, 4),
                outcome=outcome["outcome"], exit_reason=outcome["exit"],
                days_held=outcome["days_held"],
            ))

    return _build_report(result, risk_level, top_n, cost_r, hold_days, ambiguous_as)


def _build_report(result: BacktestResult, risk_level: str, top_n: int, cost_r: float,
                  hold_days: int, ambiguous_as: str) -> dict[str, Any]:
    trades = result.trades
    overall = _summarise(trades, "OVERALL")

    by_direction = {d: _summarise([t for t in trades if t.direction == d], f"DIR:{d}") for d in ("BUY", "SELL")}
    regimes = sorted({t.regime for t in trades})
    by_regime = {r: _summarise([t for t in trades if t.regime == r], f"REGIME:{r}") for r in regimes}

    # Confidence buckets
    buckets = {"0.55-0.65": [], "0.65-0.75": [], "0.75-0.85": [], "0.85+": []}
    for t in trades:
        c = t.confidence
        if c < 0.65:
            buckets["0.55-0.65"].append(t)
        elif c < 0.75:
            buckets["0.65-0.75"].append(t)
        elif c < 0.85:
            buckets["0.75-0.85"].append(t)
        else:
            buckets["0.85+"].append(t)
    by_confidence = {k: _summarise(v, f"CONF:{k}") for k, v in buckets.items()}

    return {
        "config": {
            "risk_level": risk_level,
            "top_n_per_day": top_n,
            "cost_r_per_trade": cost_r,
            "hold_days": hold_days,
            "ambiguous_same_day_as": ambiguous_as,
            "trading_days_simulated": result.n_days,
            "skipped_no_next_bar": result.skipped_no_next_bar,
        },
        "overall": overall,
        "by_direction": by_direction,
        "by_regime": by_regime,
        "by_confidence": by_confidence,
        "interpretation": _interpretation(overall),
    }


def _interpretation(overall: dict[str, Any]) -> str:
    if overall.get("trades", 0) == 0:
        return "No trades were generated — check data coverage / thresholds."
    avg_r = overall.get("avg_net_r_per_trade")
    dec_r = overall.get("decisive_avg_net_r")
    te_r = overall.get("time_exit_avg_net_r")
    wilson = overall.get("wilson_lb_win_rate")
    pf = overall.get("profit_factor")
    verdict = []
    if avg_r is not None:
        verdict.append(
            "POSITIVE overall expectancy after costs" if avg_r > 0
            else "NEGATIVE overall expectancy after costs (the rules lose money net of costs)"
        )
    if dec_r is not None:
        verdict.append(
            f"DECISIVE-only expectancy {dec_r}R/trade — this is the real edge test "
            f"({'positive' if dec_r > 0 else 'NEGATIVE: resolved trades lose'})"
        )
    if te_r is not None:
        verdict.append(f"time-exit trades avg {te_r}R (marked to close — treat as soft)")
    if pf is not None:
        verdict.append(f"profit factor {pf}")
    if wilson is not None:
        verdict.append(f"Wilson LB win rate {wilson} (honest floor — trust over raw win rate)")
    return "; ".join(verdict)
