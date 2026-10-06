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


def build_signal_email(
    *,
    signal_date: str,
    market: str,
    signals: list[dict[str, Any]],
    unsubscribe_url: str,
    risk_level: str,
    signal_type: str,
    conviction: dict[str, Any] | None = None,
) -> tuple[str, str, str]:
    signal_label = str(signal_type or "next-trading-day").replace("_", " ").strip()
    subject = f"Bullseye {market} {signal_label} stock signals | generated {signal_date}"
    conviction_html, conviction_text = _conviction_banner(conviction)
    card_rows: list[str] = []
    text_rows: list[str] = []

    for index, signal in enumerate(signals, 1):
        _, text_reason = _detail_reason(signal)
        symbol = str(signal["symbol"])
        direction = str(signal["direction"])
        company_name = str(signal.get("company_name") or symbol)
        entry_range = f"{signal['entry_low']:.2f}–{signal['entry_high']:.2f}"
        target_price = f"{signal['target_price']:.2f}"
        stop_loss = f"{signal['stop_loss']:.2f}"
        risk_reward = f"{signal['risk_reward']:.2f}"
        setup_type = str(signal.get("setup_type") or "Model-ranked setup").replace("_", " ").title()
        reasons = (signal.get("explanation_json") or {}).get("reasons") or signal.get("reasons") or []
        why = "; ".join(str(r) for r in reasons[:2]) or setup_type
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
            + theme.metric_grid([("Entry", entry_range), ("Target", target_price), ("Stop loss", stop_loss), ("Risk / reward", risk_reward)])
            + f"<p style='margin:0 0 10px;font-family:{theme.FONT};font-size:13px;line-height:1.55;color:{theme.MUTED}'>"
            f"<strong style='color:{theme.INK}'>Why:</strong> {escape(why)}</p>"
            "</td></tr></table>"
        )

        text_rows.append(
            f"{index}. {symbol} {direction}\n"
            f"Entry: {entry_range}\n"
            f"Target: {target_price}\n"
            f"Stop Loss: {stop_loss}\n"
            f"Confidence: {_format_percent(signal.get('confidence'), 0)}\n"
            f"Risk / Reward: {risk_reward}\n"
            f"Setup Type: {setup_type}\n"
            f"Why: {text_reason}\n"
        )

    intraday = "intraday" in signal_label.lower()
    count = len(signals)
    title = (
        f"{'Today' if intraday else 'Tomorrow'}'s {count} pick{'' if count == 1 else 's'}"
        if count
        else "No picks cleared the bar"
    )
    body = conviction_html + (
        "".join(card_rows)
        if card_rows
        else f"<p style='margin:0 0 12px;font-family:{theme.FONT};font-size:14px;line-height:1.6;color:{theme.MUTED}'>"
        "No stock passed the quality filters for this session. On weak days, sending nothing is the honest answer.</p>"
    )
    html = theme.email_shell(
        preheader=f"{count} {market} picks with entry, target and stop for {signal_date}." if count else f"No {market} picks for {signal_date}.",
        eyebrow=f"Daily picks · {signal_date}",
        title=title,
        subtitle=f"{market} · {risk_level} risk · {signal_label}. Entry, target and stop for each, ranked by the model.",
        body=body,
        footer=theme.footer_html(
            "Model-generated research, not investment advice. Returns are not guaranteed, and past results don't predict future ones.",
            [("Manage alerts", f"{theme.SITE_URL}/?alerts=1"), ("Unsubscribe", unsubscribe_url)],
        ),
    )

    text = (
        f"Bullseye {market} {signal_label} stock signals\n"
        f"Generated on: {signal_date} | Risk level: {risk_level} | Signal type: {signal_type}\n\n"
        + conviction_text
        + ("\n".join(text_rows) if text_rows else "No signals passed the quality filters for the next trading day.")
        + "\nSignals are model-generated analysis. Returns are not guaranteed. Past performance does not guarantee future results.\n"
        + f"Unsubscribe: {unsubscribe_url}"
    )
    return subject, text, html
