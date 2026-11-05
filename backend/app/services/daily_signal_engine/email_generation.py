from __future__ import annotations

from html import escape
from typing import Any

from app.services import email_theme as theme


def _format_percent(value: float | None, digits: int = 0) -> str:
    if value is None:
        return "n/a"
    return f"{value:.{digits}%}"


def _detail_reason(signal: dict[str, Any]) -> tuple[str, str]:
    explanation = signal.get("explanation_json") or {}
    reasons = explanation.get("reasons") or signal.get("reasons") or []
    probabilities = explanation.get("probabilities") or {}
    validation = explanation.get("validation") or {}
    direction = signal.get("direction", "BUY")
    setup = str(signal.get("setup_type") or "model-ranked setup").replace("_", " ")
    relative_strength = explanation.get("relative_strength", signal.get("relative_strength"))
    sector_strength = explanation.get("sector_strength")
    confidence = signal.get("confidence")
    regime_alignment = signal.get("market_regime_alignment")

    lead = (
        f"Bullseye suggests {direction} because the setup scored well on "
        f"{', '.join(reasons[:3]) if reasons else 'trend, momentum, and risk filters'}."
    )
    technical = (
        "Indicators reviewed: EMA 20 / EMA 50 trend alignment, breakout or breakdown versus recent support and resistance, "
        "volume versus the 20-day average, RSI(14), ADX(14), relative strength versus the market index, sector strength, "
        "liquidity checks, volatility filters, and model confidence scoring."
    )
    metrics = f"Setup type: {setup}. Confidence: {_format_percent(confidence, 0)}. "
    metrics += (
        f"Relative strength vs index: {relative_strength:.2f}%. " if isinstance(relative_strength, (int, float)) else ""
    )
    metrics += (
        f"Sector strength: {sector_strength:.2f}. " if isinstance(sector_strength, (int, float)) else ""
    )
    metrics += (
        f"Market regime alignment: {regime_alignment:.2f}. " if isinstance(regime_alignment, (int, float)) else ""
    )
    quality = (
        "Data quality passed liquidity, stale-data, spread, and abnormal-volatility checks."
        if validation.get("is_valid", True)
        else f"Validation notes: {', '.join(validation.get('rejections') or [])}."
    )

    html_reason = (
        f"<div style='font-size:13px;line-height:1.65;color:#334155'>"
        f"<strong style='color:#0f172a'>{escape(lead)}</strong><br/>"
        f"{escape(technical)}<br/>"
        f"{escape(metrics + quality)}"
        f"</div>"
    )
    text_reason = f"{lead} {technical} {metrics}{quality}"
    return html_reason, text_reason


_CONVICTION_STYLE = {
    "high": ("#065f46", "#ecfdf5", "#a7f3d0"),
    "moderate": ("#92400e", "#fffbeb", "#fde68a"),
    "low": ("#9a3412", "#fff7ed", "#fed7aa"),
    "none": ("#9a3412", "#fff7ed", "#fed7aa"),
}


def _conviction_banner(conviction: dict[str, Any] | None) -> tuple[str, str]:
    if not conviction:
        return "", ""
    level = str(conviction.get("level") or "moderate").lower()
    note = str(conviction.get("note") or "")
    fg, bg, border = _CONVICTION_STYLE.get(level, _CONVICTION_STYLE["moderate"])
    label = f"Today's conviction: {level.upper()}"
    html = (
        f"<div style='margin:0 0 16px;padding:13px 15px;background:{bg};border:1px solid {border};"
        f"border-radius:14px;color:{fg};font-family:{theme.FONT};font-size:13px;line-height:1.6'>"
        f"<strong style='display:block;font-size:12px;letter-spacing:0.4px;text-transform:uppercase;margin-bottom:3px'>{escape(label)}</strong>"
        f"{escape(note)}"
        "</div>"
    )
    text = f"{label}\n{note}\n\n"
    return html, text


def _signed_pct(value: float) -> str:
    return f"{'+' if value >= 0 else '-'}{abs(value) * 100:.1f}%"


def _order_price(price: float) -> str:
    """A price a broker will take: whole ticks, coarser for dearer stocks.

    NSE ticks run from 1 paisa to 5 rupees by price band; a multiple of the
    coarser steps here is valid under each band (and under the older 5 paise).
    """
    step = 0.05 if price < 1000 else 0.1 if price < 5000 else 0.5 if price < 10000 else 1.0 if price < 20000 else 5.0
    return f"₹{round(round(price / step) * step, 2):,.2f}"


def _pretty(iso: Any) -> str:
    """"Fri 06 Nov" from an ISO date."""
    from datetime import date as _date

    try:
        return _date.fromisoformat(str(iso)[:10]).strftime("%a %d %b")
    except (TypeError, ValueError):
        return str(iso or "")


def _side_heading(label: str, caption: str | None = None) -> str:
    return (
        f"<p style='margin:18px 0 8px;font-family:{theme.FONT};font-size:12px;font-weight:700;letter-spacing:1px;"
        f"text-transform:uppercase;color:{theme.MUTED}'>{escape(label)}</p>"
        + (
            f"<p style='margin:-4px 0 10px;font-family:{theme.FONT};font-size:12.5px;line-height:1.55;color:{theme.FAINT}'>{escape(caption)}</p>"
            if caption
            else ""
        )
    )


def _forecast_card(signal: dict[str, Any], *, digest: bool = False) -> tuple[str, str]:
    """One forecast call as an email card and as plain text.

    A sell with the tested plan shows the order to place: entry, the level to
    skip it at, the stop-loss and the exit. In the evening email (digest) every
    other call shows its entry, a stop at the 1-in-10 bad case and its exit, with
    no invented target; the older layout showed the likely range instead.
    """
    symbol = str(signal["symbol"])
    direction = str(signal["direction"])
    horizon = int(((signal.get("explanation_json") or {}).get("forecast") or {}).get("horizon_days")
                  or (signal.get("explanation_json") or {}).get("horizon_days") or 1)
    company_name = str(signal.get("company_name") or symbol)
    reasons = (signal.get("explanation_json") or {}).get("reasons") or signal.get("reasons") or []
    setup_type = str(signal.get("setup_type") or "Model-ranked setup").replace("_", " ").title()
    why = "; ".join(str(r) for r in reasons[:2]) or setup_type
    forecast = (signal.get("explanation_json") or {}).get("forecast") or {}
    buy = direction == "BUY"
    chance = float(forecast.get("p_call", forecast["p_beat"] if buy else 1 - forecast["p_beat"]))
    label = "BUY" if buy else "SELL"
    odds = f"{round(chance * 100)}% to {'beat' if buy else 'lag'} the market"
    last = f"{float(forecast['reference_close']):,.2f}"
    tested = forecast.get("tested") or {}
    rate = tested.get("call_rate", tested.get("actual_beat_rate"))
    evidence = (
        f"In testing, calls like this were right {round(rate * 100)}% of the time ({tested['samples']:,} cases)."
        if tested and rate is not None
        else ""
    )
    # The forecast runs from the open, so its range is a move from the open,
    # not a price from the last close (the open can gap away from it).
    q10, q90 = float(forecast["q10"]), float(forecast["q90"])
    against = q10 if buy else q90
    exit_move = f"{_signed_pct(against)} from the open" if (against < 0) == buy else "outside the range"
    trade = forecast.get("plan")
    if trade:
        # The tested intraday sell plan, priced from yesterday's close.
        stop_pct = float(trade["stop_pct"])
        plan = [
            ("Entry", "Sell at the 9:15 AM open"),
            ("Skip if it opens below", _order_price(float(trade["skip_below"]))),
            ("Stop-loss", f"{_order_price(float(trade['stop_price']))} (+{stop_pct * 100:.1f}%)"),
            ("Target and exit", "No target; buy back by 3:15 PM"),
        ]
        evidence = (
            f"Yesterday's close {_order_price(float(forecast['reference_close']))}. If you sell at another price, "
            f"keep the stop {stop_pct * 100:.1f}% above it. {evidence}"
        ).strip()
    elif digest:
        # No plan was tested for this call, so no profit target is invented: the
        # stop is the 1-in-10 bad case from the open, priced from the last close.
        stop = float(forecast.get("stop_price") or float(forecast["reference_close"]) * (1 + against))
        exit_at = "Sell by 3:15 PM" if horizon == 1 and buy else "Buy back by 3:15 PM" if horizon == 1 else f"Sell at the close on {_pretty(forecast.get('last_session'))}"
        plan = [
            ("Entry", f"{'Buy' if buy else 'Sell'} at the 9:15 AM open"),
            ("Stop-loss", f"{_order_price(stop)} ({_signed_pct(against)})"),
            ("Target and exit", f"No target; {exit_at[0].lower()}{exit_at[1:]}"),
            ("Right in testing", f"{round(rate * 100)}%" if rate is not None else "n/a"),
        ]
        evidence = (
            f"Yesterday's close {_order_price(float(forecast['reference_close']))}. If it opens elsewhere, keep the stop "
            f"{abs(against) * 100:.1f}% {'below' if buy else 'above'} your price. {evidence}"
        ).strip()
    else:
        plan = [
            ("Last close", last),
            ("Likely move from the open", f"{_signed_pct(q10)} to {_signed_pct(q90)}"),
            ("Exit if it moves", exit_move),
            ("Right in testing", f"{round(rate * 100)}%" if rate is not None else "n/a"),
        ]
    # The latest headline, as context: the model does not read news.
    news = forecast.get("news") or {}
    story = (news.get("stories") or [None])[0]
    news_line = ""
    if story:
        source = f" ({story['source']})" if story.get("source") else ""
        caution = "Big news in the last two days, so expect a wilder day. " if news.get("big_news") else ""
        news_line = f"{caution}In the news (not used by the model): {story['title']}{source}."
    html = (
        f"<table role='presentation' width='100%' style='border-collapse:separate;border:1px solid {theme.LINE};"
        "border-radius:16px;margin:0 0 12px'><tr><td style='padding:16px 16px 6px'>"
        "<table role='presentation' width='100%' style='border-collapse:collapse'><tr>"
        "<td style='vertical-align:top'>"
        f"<div style='font-family:{theme.FONT};font-size:19px;font-weight:700;letter-spacing:-0.3px;color:{theme.INK}'>{escape(symbol)}</div>"
        f"<div style='font-family:{theme.FONT};font-size:13px;color:{theme.MUTED}'>{escape(company_name)}</div>"
        "</td>"
        "<td style='vertical-align:top;text-align:right'>"
        f"{theme.pill(label, 'up' if buy else 'down')}"
        f"<div style='margin-top:6px'>{theme.pill(odds)}</div>"
        "</td></tr></table>"
        "<div style='height:14px'></div>"
        + theme.metric_grid(plan)
        + f"<p style='margin:0 0 10px;font-family:{theme.FONT};font-size:13px;line-height:1.55;color:{theme.MUTED}'>"
        f"{escape(why)}. {escape(evidence)}</p>"
        + (
            f"<p style='margin:0 0 10px;font-family:{theme.FONT};font-size:12.5px;line-height:1.55;color:{theme.FAINT}'>{escape(news_line)}</p>"
            if news_line
            else ""
        )
        + "</td></tr></table>"
    )
    if trade:
        order = (
            "Sell at the 9:15 AM open; skip it if it opens below "
            f"{_order_price(float(trade['skip_below']))}; stop-loss {_order_price(float(trade['stop_price']))} "
            f"(+{float(trade['stop_pct']) * 100:.1f}%); no target, buy back by 3:15 PM"
        )
    elif digest:
        order = "; ".join(f"{name}: {value}" for name, value in plan[:3])
    else:
        order = f"Last close {last}; likely move from the open {_signed_pct(q10)} to {_signed_pct(q90)}; exit if it moves {exit_move}"
    text = f"{symbol} {label}: {odds}\n{order}\n{why}. {evidence}\n" + (f"{news_line}\n" if news_line else "")
    return html, text


def build_signal_email(
    *,
    signal_date: str,
    market: str,
    signals: list[dict[str, Any]],
    unsubscribe_url: str,
    risk_level: str,
    signal_type: str,
    conviction: dict[str, Any] | None = None,
    experimental_note: str | None = None,
    empty_note: str | None = None,
    record_note: str | None = None,
    plan_note: str | None = None,
) -> tuple[str, str, str]:
    from datetime import date as _date

    from .config import horizon_from_signal_type

    horizon = horizon_from_signal_type(signal_type)
    held = "the same session" if horizon == 1 else f"up to {horizon} sessions"
    try:
        pretty_date = _date.fromisoformat(str(signal_date)[:10]).strftime("%a %d %b")
    except ValueError:
        pretty_date = str(signal_date)
    count_preview = len(signals)
    buys = sum(1 for s_ in signals if s_.get("direction") == "BUY")
    sells = count_preview - buys
    calls = ", ".join(part for part in (f"{buys} buy" if buys else "", f"{sells} sell" if sells else "") if part)
    subject = (
        f"Bullseye {'intraday' if horizon == 1 else f'{horizon}-session'} calls for {pretty_date}: {calls}"
        if any((s_.get("explanation_json") or {}).get("forecast") for s_ in signals) and count_preview
        else f"Bullseye: {count_preview} pick{'' if count_preview == 1 else 's'} for {pretty_date}, held {held}"
        if count_preview
        else f"Bullseye: no strong calls for {pretty_date}"
    )
    conviction_html, conviction_text = _conviction_banner(conviction)
    card_rows: list[str] = []
    text_rows: list[str] = []

    section_direction = None
    # Forecasts are grouped: buy calls first, then sell calls.
    if any((s_.get("explanation_json") or {}).get("forecast") for s_ in signals):
        signals = sorted(signals, key=lambda s_: (s_.get("direction") != "BUY", s_.get("signal_rank") or 0))
    for index, signal in enumerate(signals, 1):
        _, text_reason = _detail_reason(signal)
        symbol = str(signal["symbol"])
        direction = str(signal["direction"])
        company_name = str(signal.get("company_name") or symbol)
        # The order the picks are tested on: a limit at the edge of the entry
        # zone, valid for the first session only.
        entry_range = (
            f"up to {signal['entry_high']:.2f}" if direction == "BUY" else f"down to {signal['entry_low']:.2f}"
        )
        target_price = f"{signal['target_price']:.2f}"
        stop_loss = f"{signal['stop_loss']:.2f}"
        risk_reward = f"{signal['risk_reward']:.2f}"
        setup_type = str(signal.get("setup_type") or "Model-ranked setup").replace("_", " ").title()
        reasons = (signal.get("explanation_json") or {}).get("reasons") or signal.get("reasons") or []
        why = "; ".join(str(r) for r in reasons[:2]) or setup_type
        forecast = (signal.get("explanation_json") or {}).get("forecast")
        if forecast:
            buy = direction == "BUY"
            if section_direction != direction:
                section_direction = direction
                card_rows.append(_side_heading("Buy calls" if buy else "Sell calls"))
                text_rows.append("BUY CALLS" if buy else "SELL CALLS")
            card_html, card_text = _forecast_card(signal)
            card_rows.append(card_html)
            text_rows.append(card_text)
            continue
        card_rows.append(
            f"<table role='presentation' width='100%' style='border-collapse:separate;border:1px solid {theme.LINE};"
            "border-radius:16px;margin:0 0 12px'><tr><td style='padding:16px 16px 6px'>"
            "<table role='presentation' width='100%' style='border-collapse:collapse'><tr>"
            "<td style='vertical-align:top'>"
            f"<div style='font-family:{theme.FONT};font-size:12px;color:{theme.FAINT}'>{index:02d}</div>"
            f"<div style='font-family:{theme.FONT};font-size:19px;font-weight:700;letter-spacing:-0.3px;color:{theme.INK}'>{escape(symbol)}</div>"
            f"<div style='font-family:{theme.FONT};font-size:13px;color:{theme.MUTED}'>{escape(company_name)}</div>"
            "</td>"
            "<td style='vertical-align:top;text-align:right'>"
            f"{theme.pill(direction, 'up' if direction == 'BUY' else 'down')}"
            f"<div style='margin-top:6px'>{theme.pill(_format_percent(signal.get('confidence'), 0) + ' confidence')}</div>"
            "</td></tr></table>"
            "<div style='height:14px'></div>"
            + theme.metric_grid([("Entry (limit)", entry_range), ("Target", target_price), ("Stop loss", stop_loss), ("Risk / reward", risk_reward)])
            + f"<p style='margin:0 0 10px;font-family:{theme.FONT};font-size:13px;line-height:1.55;color:{theme.MUTED}'>"
            f"<strong style='color:{theme.INK}'>Why:</strong> {escape(why)}</p>"
            "</td></tr></table>"
        )

        text_rows.append(
            f"{index}. {symbol} {direction}\n"
            f"Entry (limit): {entry_range}\n"
            f"Target: {target_price}\n"
            f"Stop Loss: {stop_loss}\n"
            f"Confidence: {_format_percent(signal.get('confidence'), 0)}\n"
            f"Risk / Reward: {risk_reward}\n"
            f"Setup Type: {setup_type}\n"
            f"Why: {text_reason}\n"
        )

    count = len(signals)
    is_forecast = any((s_.get("explanation_json") or {}).get("forecast") for s_ in signals)
    title = (
        f"{count} forecast{'' if count == 1 else 's'} for {pretty_date}" if is_forecast and count
        else f"{count} pick{'' if count == 1 else 's'} for {pretty_date}" if count
        else f"No strong calls for {pretty_date}"
    )
    last_session = next(
        ((s_.get("explanation_json") or {}).get("forecast", {}).get("last_session") for s_ in signals
         if (s_.get("explanation_json") or {}).get("forecast", {}).get("last_session")),
        None,
    )
    try:
        last_pretty = _date.fromisoformat(str(last_session)[:10]).strftime("%a %d %b") if last_session else None
    except ValueError:
        last_pretty = None
    window = (
        f"from the open to the close on {pretty_date} (intraday)" if horizon == 1
        else f"from the open on {pretty_date} to the close on {last_pretty or f'session {horizon}'} ({horizon} trading sessions)"
    )
    has_plan = any(((s_.get("explanation_json") or {}).get("forecast") or {}).get("plan") for s_ in signals)
    how_to = (
        f"Each call runs {window}. A BUY is a stock the model rates most likely to beat the average Nifty 200 stock; "
        "a SELL (intraday only) is one most likely to lag it. Only calls at a strength that held up in testing are sent, "
        "and some will still miss. "
        + (
            (plan_note or "Each sell comes with the plan it was tested on: entry, a level to skip it at, a stop-loss and the exit.")
            if has_plan
            else "Moves are measured from the open; the likely range held 8 in 10 outcomes in testing, "
            "and the exit line is its 1-in-10 bad case."
        )
        + " Size each trade so a stop-out is a loss you can afford. These are forecasts, not advice."
    ) if is_forecast else (
        f"Place each order as a limit for the session on {pretty_date} only, and skip a pick that opens past its stop "
        f"or target. Exit at the target, at the stop, or at the close {'of that session' if horizon == 1 else f'of session {horizon}'}, "
        "whichever comes first. A SELL means exit or avoid; most retail accounts cannot hold a short overnight."
    )
    # The tested record beside the recent one, so a reader sees both before the calls.
    if record_note and count:
        how_to = f"{how_to} {record_note}"
    how_to_html = (
        f"<p style='margin:0 0 14px;font-family:{theme.FONT};font-size:13px;line-height:1.6;color:{theme.MUTED}'>"
        f"{escape(how_to)}</p>"
        if count
        else ""
    )
    note_html = (
        f"<p style='margin:0 0 14px;font-family:{theme.FONT};font-size:13px;line-height:1.6;color:{theme.MUTED}'>"
        f"<strong style='color:{theme.INK}'>Experimental:</strong> {escape(experimental_note)}</p>"
        if experimental_note and count
        else ""
    )
    body = conviction_html + note_html + how_to_html + (
        "".join(card_rows)
        if card_rows
        else f"<p style='margin:0 0 12px;font-family:{theme.FONT};font-size:14px;line-height:1.6;color:{theme.MUTED}'>"
        f"{escape(empty_note or 'No stock passed the quality filters for this session. On weak days, sending nothing is the honest answer.')}</p>"
    )
    detail = (
        ("an entry, a stop-loss and an exit" if has_plan else "a likely move from the open and an exit line")
        if is_forecast
        else "entry, target and stop"
    )
    html = theme.email_shell(
        preheader=f"{count} {market} picks for {signal_date}, each with {detail}." if count else f"No {market} picks for {signal_date}.",
        eyebrow=f"Daily picks · {signal_date}",
        title=title,
        subtitle=f"{risk_level} risk · held {held}. {detail[0].upper()}{detail[1:]} for each, ranked by the model.",
        body=body,
        footer=theme.footer_html(
            "Model-generated research, not investment advice. Returns are not guaranteed, and past results don't predict future ones.",
            [("Manage alerts", f"{theme.SITE_URL}/?alerts=1"), ("Unsubscribe", unsubscribe_url)],
        ),
    )

    text = (
        f"Bullseye picks for {pretty_date}\n"
        f"Risk level: {risk_level} | Held {held}\n\n"
        + (f"Experimental: {experimental_note}\n\n" if experimental_note and count else "")
        + (how_to + "\n\n" if count else "")
        + conviction_text
        + ("\n".join(text_rows) if text_rows else (empty_note or "No signals passed the quality filters for the next trading day."))
        + "\nSignals are model-generated analysis. Returns are not guaranteed. Past performance does not guarantee future results.\n"
        + f"Unsubscribe: {unsubscribe_url}"
    )
    return subject, text, html


# ── The evening email: every horizon in one ─────────────────────────────────

_HORIZON_TITLE = {1: "Intraday", 3: "3 days", 5: "5 days"}
_COUNT_WORD = {1: "intraday", 3: "3-day", 5: "5-day"}
_SIZING_NOTE = (
    "Size each trade so a stop-out costs at most about 1% of your capital. All of these are shorts on the same "
    "day, so a market-wide rally can stop several at once; if you take them all, risk about 0.5% on each."
)


def _note_box(text: str) -> str:
    return (
        "<p style='margin:0 0 10px;padding:12px 14px;border:1px dashed #d9d6e4;border-radius:14px;"
        f"font-family:{theme.FONT};font-size:13px;line-height:1.6;color:{theme.MUTED}'>{escape(text)}</p>"
    )


def _muted(text: str, margin: str = "0 0 12px") -> str:
    return (
        f"<p style='margin:{margin};font-family:{theme.FONT};font-size:13px;line-height:1.6;color:{theme.MUTED}'>"
        f"{escape(text)}</p>"
    )


def _section_heading(title: str, window: str) -> str:
    return (
        f"<div style='margin:26px 0 2px;padding-top:18px;border-top:1px solid {theme.LINE}'>"
        f"<div style='font-family:{theme.FONT};font-size:18px;font-weight:700;letter-spacing:-0.3px;color:{theme.INK}'>{escape(title)}</div>"
        f"<div style='margin-top:3px;font-family:{theme.FONT};font-size:13px;line-height:1.55;color:{theme.MUTED}'>{escape(window)}</div>"
        "</div>"
    )


def _plan_word(call: dict[str, Any]) -> str:
    """How the printed sell plan did on a graded call, in a few words."""
    plan, pct = call.get("plan"), call.get("plan_pct")
    if plan == "skipped":
        return "plan skipped it"
    if plan in {"held", "stopped"} and isinstance(pct, (int, float)):
        return f"{'stopped out' if plan == 'stopped' else 'plan'} {_signed_pct(pct / 100)}"
    return ""


def _scorecard(record: dict[str, Any] | None) -> tuple[str, str]:
    """The last five graded sessions, call by call, then the running totals."""
    record = record or {}
    sessions = record.get("sessions") or ([record["latest"]] if record.get("latest") else [])
    if not sessions:
        return "", ""
    html = [_section_heading("How recent calls did", "Every published call, right or wrong. Moves run from the open to the close.")]
    text = ["HOW RECENT CALLS DID"]
    for session in sessions:
        calls = session.get("calls") or []
        sells = [c for c in calls if c.get("direction") == "SELL"]
        buys = [c for c in calls if c.get("direction") == "BUY"]
        parts = []
        if sells:
            parts.append(f"{sum(1 for c in sells if c.get('moved'))} of {len(sells)} sells fell")
        if buys:
            parts.append(f"{sum(1 for c in buys if c.get('moved'))} of {len(buys)} buys rose")
        if isinstance(session.get("plan_avg_pct"), (int, float)):
            parts.append(f"the sell plan averaged {_signed_pct(session['plan_avg_pct'] / 100)} a trade")
        headline = f"{_pretty(session.get('date'))}: {', '.join(parts)}" if parts else _pretty(session.get("date"))
        text.append(headline)
        rows = []
        for call in calls:
            ok = call.get("moved") if call.get("moved") is not None else call.get("right")
            move = call.get("move_pct")
            moved = _signed_pct(move / 100) if isinstance(move, (int, float)) else ""
            tone = theme.UP if call.get("direction") == "BUY" else theme.DOWN
            rows.append(
                "<tr>"
                f"<td style='padding:5px 8px 5px 0;font-family:{theme.FONT};font-size:11px;font-weight:700;color:{tone[0]}'>"
                f"{escape(str(call.get('direction')))}</td>"
                f"<td style='padding:5px 8px 5px 0;font-family:{theme.MONO};font-size:13px;color:{theme.INK}'>{escape(str(call.get('symbol')))}</td>"
                f"<td style='padding:5px 8px 5px 0;font-family:{theme.MONO};font-size:13px;color:{theme.INK};text-align:right'>{moved}</td>"
                f"<td style='padding:5px 8px 5px 0;font-family:{theme.FONT};font-size:12px;color:{theme.MUTED};text-align:right'>"
                f"{escape(_plan_word(call))}</td>"
                f"<td style='padding:5px 0;font-family:{theme.FONT};font-size:12px;font-weight:600;text-align:right;"
                f"color:{(theme.UP if ok else theme.DOWN)[0]}'>{'Right' if ok else 'Missed'}</td>"
                "</tr>"
            )
            text.append(f"  {call.get('direction')} {call.get('symbol')} {moved} {_plan_word(call)} {'right' if ok else 'missed'}".replace("  ", " ").rstrip())
        html.append(
            f"<div style='margin:14px 0 4px;font-family:{theme.FONT};font-size:13px;font-weight:600;color:{theme.INK}'>{escape(headline)}</div>"
            f"<table role='presentation' width='100%' style='border-collapse:collapse'>{''.join(rows)}</table>"
        )
    totals = []
    for side, moved_word, versus in (("sell", "fell", "lagged"), ("buy", "rose", "beat")):
        stats = record.get(side) or {}
        if stats.get("calls"):
            known = stats.get("moved_calls") or stats["calls"]
            totals.append(
                f"{stats.get('moved', 0)} of {known} {side}s {moved_word} ({round(100 * stats.get('moved', 0) / known)}%) "
                f"and {stats.get('right', 0)} of {stats['calls']} {versus} the market"
            )
    plan = record.get("plan") or {}
    if plan.get("taken") and isinstance(plan.get("avg_pct"), (int, float)):
        totals.append(
            f"following the sell plan, {plan['taken']} trades were taken, {plan.get('stopped', 0)} stopped out and "
            f"{plan.get('skipped', 0)} skipped, averaging {_signed_pct(plan['avg_pct'] / 100)} a trade after costs"
        )
    if totals:
        joined = "; ".join(totals)
        line = f"Since {_pretty(record['since'])}: {joined}." if record.get("since") else f"{joined[0].upper()}{joined[1:]}."
        html.append(_muted(line, "14px 0 0"))
        text.append(line)
    return "".join(html), "\n".join(text) + "\n"


def build_daily_digest_email(
    *,
    target_date: str,
    market: str,
    risk_level: str,
    horizons: list[dict[str, Any]],
    unsubscribe_url: str,
    data_date: str | None = None,
    record: dict[str, Any] | None = None,
    plan_note: str | None = None,
) -> tuple[str, str, str]:
    """The evening email: intraday buy and sell calls, then 3-day and 5-day calls,
    then how the last five sessions' calls did.

    Each item in `horizons` is {"horizon", "signals", "notes" (why a side has no
    calls), "captions" (each side's tested record), "last_session", "withheld"}.
    A horizon with nothing to publish still gets its section, saying why, so the
    email always reads the same way.
    """
    pretty_date = _pretty(target_date)
    counts: list[tuple[int, str, int]] = []
    body_html: list[str] = []
    body_text: list[str] = []
    for item in sorted(horizons, key=lambda entry: int(entry["horizon"])):
        horizon = int(item["horizon"])
        last = item.get("last_session")
        if horizon == 1:
            title = f"{_HORIZON_TITLE[1]} · {pretty_date}"
            window = "Enter at the 9:15 AM open and close out by 3:15 PM, before brokers square off intraday trades."
        elif last:
            title = f"{_HORIZON_TITLE[horizon]} · {pretty_date} to {_pretty(last)}"
            window = f"Buy at the 9:15 AM open on {pretty_date} and sell at the close on {_pretty(last)}: {horizon} trading sessions."
        else:
            title = f"{_HORIZON_TITLE[horizon]} · from {pretty_date}"
            window = f"Buy at the open and hold for {horizon} trading sessions."
        body_html.append(_section_heading(title, window))
        body_text.append(f"\n{title.upper()}\n{window}")
        if item.get("withheld"):
            body_html.append(_note_box(str(item["withheld"])))
            body_text.append(str(item["withheld"]))
            continue
        signals = [s for s in item.get("signals") or [] if (s.get("explanation_json") or {}).get("forecast")]
        notes = item.get("notes") or {}
        captions = item.get("captions") or {}
        sides = ("sell", "buy") if horizon == 1 else ("buy",)
        listed = [side for side in sides if any(s.get("direction") == side.upper() for s in signals)]
        for side in listed:
            mine = sorted((s for s in signals if s.get("direction") == side.upper()), key=lambda s: s.get("signal_rank") or 0)
            counts.append((horizon, side, len(mine)))
            label = f"{'Sell' if side == 'sell' else 'Buy'} calls ({len(mine)})"
            body_html.append(_side_heading(label, captions.get(side)))
            body_text.append(label.upper() + (f"\n{captions[side]}" if captions.get(side) else ""))
            if side == "sell" and horizon == 1:
                guide = " ".join(part for part in (plan_note, _SIZING_NOTE) if part)
                body_html.append(_muted(guide))
                body_text.append(guide)
            for signal in mine:
                card_html, card_text = _forecast_card(signal, digest=True)
                body_html.append(card_html)
                body_text.append(card_text)
        for side in sides:
            if side in listed:
                continue
            note = notes.get(side) or f"No {side} call passed its tested bar for this session."
            body_html.append(_side_heading(f"{'Sell' if side == 'sell' else 'Buy'} calls · none today"))
            body_html.append(_note_box(note))
            body_text.append(f"{side.upper()} CALLS: none today. {note}")
        if horizon != 1:
            line = f"No sell calls for {horizon}-day holds: a short can't be carried overnight in the cash market."
            body_html.append(_muted(line, "2px 0 4px"))
            body_text.append(line)

    score_html, score_text = _scorecard(record)
    total = sum(n for _, _, n in counts)
    parts = [f"{n} {_COUNT_WORD[h]} {side}{'' if n == 1 else 's'}" for h, side, n in counts]
    if total:
        subject = f"Bullseye calls for {pretty_date}: {', '.join(parts)}"
        title = f"{total} call{'' if total == 1 else 's'} for {pretty_date}"
        listed_text = ", ".join(parts)
        preheader = f"{listed_text[0].upper()}{listed_text[1:]}, each with an entry, a stop-loss and an exit. Then how recent calls did."
    else:
        subject = f"Bullseye for {pretty_date}: no call passed the bar"
        title = f"No calls for {pretty_date}"
        preheader = "No call passed its tested bar for this session. Here's why, and how recent calls did."
    built = f" · built from the {_pretty(data_date)} close" if data_date else ""
    subtitle = f"{risk_level} risk{built}. Intraday, 3-day and 5-day calls below, then how recent calls did."
    html = theme.email_shell(
        preheader=preheader,
        eyebrow=f"Daily calls · {pretty_date}",
        title=title,
        subtitle=subtitle,
        body="".join(body_html) + score_html,
        footer=theme.footer_html(
            "Model-generated research, not investment advice. Bullseye is not registered with SEBI. "
            "Returns are not guaranteed, and past results don't predict future ones.",
            [("See every call", f"{theme.SITE_URL}/?alerts=1"), ("Unsubscribe", unsubscribe_url)],
        ),
    )
    text = (
        f"Bullseye calls for {pretty_date}\n{subtitle}\n"
        + "\n".join(body_text)
        + ("\n\n" + score_text if score_text else "\n")
        + "\nModel-generated research, not investment advice. Returns are not guaranteed.\n"
        + f"Unsubscribe: {unsubscribe_url}"
    )
    return subject, text, html
