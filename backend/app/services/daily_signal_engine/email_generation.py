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
            plan = [
                ("Last close", last),
                ("Likely move from the open", f"{_signed_pct(q10)} to {_signed_pct(q90)}"),
                ("Exit if it moves", exit_move),
                ("Right in testing", f"{round(rate * 100)}%" if rate is not None else "n/a"),
            ]
            if section_direction != direction:
                section_direction = direction
                card_rows.append(
                    f"<p style='margin:18px 0 8px;font-family:{theme.FONT};font-size:12px;font-weight:700;letter-spacing:1px;"
                    f"text-transform:uppercase;color:{theme.MUTED}'>{'Buy calls' if buy else 'Sell calls'}</p>"
                )
                text_rows.append("BUY CALLS" if buy else "SELL CALLS")
            card_rows.append(
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
                "</td></tr></table>"
            )
            text_rows.append(
                f"{symbol} {label}: {odds}\n"
                f"Last close {last}; likely move from the open {_signed_pct(q10)} to {_signed_pct(q90)}; "
                f"exit if it moves {exit_move}"
                + f"\n{why}. {evidence}\n"
            )
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
    how_to = (
        f"Each call runs {window}. A BUY is a stock the model rates most likely to beat the average Nifty 200 stock; "
        "a SELL (intraday only) is one most likely to lag it. Only calls at a strength that held up in testing are sent, "
        "and some will still miss. Moves are measured from the open; the likely range held 8 in 10 outcomes in testing, "
        "and the exit line is its 1-in-10 bad case. These are forecasts, not advice."
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
    detail = "a likely move from the open and an exit line" if is_forecast else "entry, target and stop"
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
