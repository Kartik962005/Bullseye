from __future__ import annotations

import os
import re
import time
from datetime import datetime, timezone
from html import escape
import logging
from typing import Any
from uuid import uuid4

import pandas as pd
import requests
import ta

from app.core.supabase_client import supabase
from app.services.data_service import get_historical_data


ALERT_TABLE = "user_alerts"
EVENT_TABLE = "alert_events"
logger = logging.getLogger(__name__)

if not os.getenv("RESEND_API_KEY"):
    logger.warning("RESEND_API_KEY is not set; Resend alert emails will not send.")
if not (os.getenv("ALERT_FROM_EMAIL") or os.getenv("RESEND_FROM_EMAIL")):
    logger.warning("ALERT_FROM_EMAIL or RESEND_FROM_EMAIL is not set; alert emails need a configured from-address.")


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _supabase_required():
    if not supabase:
        raise ValueError("Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.")
    return supabase


def get_user_from_authorization(authorization: str | None) -> dict[str, Any]:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise ValueError("Please sign in before creating alerts.")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise ValueError("Missing auth token.")

    sb = _supabase_required()
    result = sb.auth.get_user(token)
    user = getattr(result, "user", None)
    if user is None and isinstance(result, dict):
        user = result.get("user") or result.get("data", {}).get("user")
    if not user:
        raise ValueError("Your login session could not be verified.")

    user_id = getattr(user, "id", None) or user.get("id")
    email = getattr(user, "email", None) or user.get("email")
    return {"id": user_id, "email": email}


def _normalise_prompt(prompt: str) -> str:
    return re.sub(r"\s+", " ", prompt.lower()).strip()


def _extract_threshold(prompt: str, default: float | None = None) -> float | None:
    match = re.search(r"(-?\d+(?:\.\d+)?)", prompt)
    if match:
        return float(match.group(1))
    return default


def compile_alert_rule(prompt: str, ticker: str) -> dict[str, Any]:
    clean = _normalise_prompt(prompt)

    direction = "above"
    operator = ">"
    if re.search(r"\b(below|under|less than|crosses down|cross below|crosses below)\b", clean):
        direction = "below"
        operator = "<"
    if re.search(r"\b(above|over|greater than|crosses up|cross above|crosses above|breaks above)\b", clean):
        direction = "above"
        operator = ">"

    cross = bool(re.search(r"\b(cross|crosses|breaks|breakout|break down|breakdown)\b", clean))

    if re.search(r"\b(rsi|relative strength index|overbought|oversold)\b", clean):
        threshold = _extract_threshold(clean, 70 if direction == "above" else 30)
        if "oversold" in clean and threshold is None:
            threshold = 30
            operator = "<"
            direction = "below"
        if "overbought" in clean and threshold is None:
            threshold = 70
            operator = ">"
            direction = "above"
        return {
            "type": "indicator_threshold",
            "metric": "rsi14",
            "operator": operator,
            "threshold": threshold,
            "cross": cross,
            "timeframe": "1d",
            "description": f"RSI 14 {('crosses ' if cross else '')}{direction} {threshold}",
        }

    if re.search(r"\b(volume|volumes|vol)\b", clean):
        days_match = re.search(r"(?:last|previous|past)\s+(\d+)\s+(?:days|day|sessions|session)", clean)
        window = int(days_match.group(1)) if days_match else 5
        if re.search(r"\b(average|avg|sma)\b", clean):
            return {
                "type": "volume_average_compare",
                "metric": "volume",
                "operator": operator,
                "window": max(2, min(window, 60)),
                "timeframe": "1d",
                "description": f"Volume is {direction} previous {max(2, min(window, 60))}-day average",
            }
        multiplier_match = re.search(r"(\d+(?:\.\d+)?)\s*x", clean)
        multiplier = float(multiplier_match.group(1)) if multiplier_match else 1.5
        return {
            "type": "volume_spike",
            "metric": "volume",
            "operator": ">",
            "window": max(2, min(window, 60)),
            "multiplier": multiplier,
            "timeframe": "1d",
            "description": f"Volume is above {multiplier}x previous {max(2, min(window, 60))}-day average",
        }

    if re.search(r"\b(sma|moving average|dma|ema)\b", clean):
        ma_type = "ema" if "ema" in clean or "exponential" in clean else "sma"
        window_match = re.search(r"\b(?:sma|ema|ma|dma)\s*[- ]?(\d+)\b", clean)
        window = int(window_match.group(1)) if window_match else 50
        return {
            "type": "price_vs_average",
            "metric": f"{ma_type}{window}",
            "operator": operator,
            "window": max(2, min(window, 250)),
            "average_type": ma_type,
            "cross": cross,
            "timeframe": "1d",
            "description": f"Close price {('crosses ' if cross else '')}{direction} {ma_type.upper()} {max(2, min(window, 250))}",
        }

    threshold = _extract_threshold(clean)
    return {
        "type": "price_threshold",
        "metric": "close",
        "operator": operator,
        "threshold": threshold,
        "cross": cross,
        "timeframe": "1d",
        "description": f"Close price {('crosses ' if cross else '')}{direction} {threshold if threshold is not None else 'your level'}",
    }


def create_alert(
    user: dict[str, Any],
    ticker: str,
    prompt: str,
    channels: list[str],
    email: str | None = None,
) -> dict[str, Any]:
    sb = _supabase_required()
    clean_channels = [channel for channel in channels if channel == "email"]
    if not clean_channels:
        clean_channels = ["email"]

    rule = compile_alert_rule(prompt, ticker)
    payload = {
        "id": str(uuid4()),
        "user_id": user["id"],
        "ticker": ticker.upper(),
        "prompt": prompt.strip(),
        "rule": rule,
        "channels": clean_channels,
        "email": email or user.get("email"),
        "status": "active",
        "last_checked_at": None,
        "last_triggered_at": None,
        "created_at": _utc_now_iso(),
        "updated_at": _utc_now_iso(),
    }
    response = sb.table(ALERT_TABLE).insert(payload).execute()
    data = getattr(response, "data", None) or []
    return data[0] if data else payload


def list_alerts(user_id: str) -> list[dict[str, Any]]:
    sb = _supabase_required()
    response = (
        sb.table(ALERT_TABLE)
        .select("*")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .execute()
    )
    return getattr(response, "data", None) or []


def update_alert_status(user_id: str, alert_id: str, status: str) -> dict[str, Any]:
    if status not in {"active", "paused"}:
        raise ValueError("Alert status must be active or paused.")
    sb = _supabase_required()
    response = (
        sb.table(ALERT_TABLE)
        .update({"status": status, "updated_at": _utc_now_iso()})
        .eq("id", alert_id)
        .eq("user_id", user_id)
        .execute()
    )
    data = getattr(response, "data", None) or []
    if not data:
        raise ValueError("Alert not found.")
    return data[0]


def delete_alert(user_id: str, alert_id: str) -> dict[str, Any]:
    sb = _supabase_required()
    response = sb.table(ALERT_TABLE).delete().eq("id", alert_id).eq("user_id", user_id).execute()
    data = getattr(response, "data", None) or []
    return {"deleted": bool(data), "id": alert_id}


def _with_indicators(df: pd.DataFrame, rule: dict[str, Any]) -> pd.DataFrame:
    work = df.copy()
    if isinstance(work.columns, pd.MultiIndex):
        work.columns = work.columns.get_level_values(0)
    work.columns = [str(col).lower() for col in work.columns]
    required = {"open", "high", "low", "close", "volume"}
    if not required.issubset(set(work.columns)):
        raise ValueError("Historical OHLCV data is missing required columns.")
    work = work.sort_index().copy()
    rule_type = rule.get("type")
    if rule_type == "indicator_threshold":
        work["rsi14"] = ta.momentum.rsi(work["close"], window=14)
    elif rule_type in {"volume_average_compare", "volume_spike"}:
        window = max(2, min(int(rule.get("window") or 5), 60))
        work[f"volume_sma{window}"] = work["volume"].rolling(window=window).mean()
    elif rule_type == "price_vs_average":
        window = max(2, min(int(rule.get("window") or 50), 250))
        average_type = rule.get("average_type", "sma")
        if average_type == "ema":
            work[f"ema{window}"] = ta.trend.ema_indicator(work["close"], window=window)
        else:
            work[f"sma{window}"] = ta.trend.sma_indicator(work["close"], window=window)
    return work.dropna().reset_index(drop=True)


def _compare(left: float, operator: str, right: float) -> bool:
    if operator == "<":
        return left < right
    if operator == "<=":
        return left <= right
    if operator == ">=":
        return left >= right
    return left > right


def evaluate_alert(alert: dict[str, Any]) -> dict[str, Any]:
    rule = alert.get("rule") or {}
    df = _with_indicators(get_historical_data(alert["ticker"]), rule)
    if len(df) < 2:
        return {"triggered": False, "reason": "Not enough market data yet."}

    latest = df.iloc[-1]
    previous = df.iloc[-2]
    operator = rule.get("operator", ">")
    rule_type = rule.get("type")

    if rule_type == "indicator_threshold":
        metric = rule.get("metric", "rsi14")
        threshold = float(rule.get("threshold"))
        current = float(latest[metric])
        prev_value = float(previous[metric])
        crossed = _compare(current, operator, threshold) and not _compare(prev_value, operator, threshold)
        triggered = crossed if rule.get("cross") else _compare(current, operator, threshold)
        target = threshold
        value_label = metric.upper()
    elif rule_type == "volume_average_compare":
        window = int(rule.get("window") or 5)
        avg_col = f"volume_sma{window}"
        current = float(latest["volume"])
        target = float(previous[avg_col])
        triggered = _compare(current, operator, target)
        value_label = "Volume"
    elif rule_type == "volume_spike":
        window = int(rule.get("window") or 5)
        avg_col = f"volume_sma{window}"
        current = float(latest["volume"])
        target = float(previous[avg_col]) * float(rule.get("multiplier") or 1.5)
        triggered = current > target
        value_label = "Volume"
    elif rule_type == "price_vs_average":
        metric = rule.get("metric") or f"{rule.get('average_type', 'sma')}{int(rule.get('window') or 50)}"
        current = float(latest["close"])
        target = float(latest[metric])
        prev_current = float(previous["close"])
        prev_target = float(previous[metric])
        crossed = _compare(current, operator, target) and not _compare(prev_current, operator, prev_target)
        triggered = crossed if rule.get("cross") else _compare(current, operator, target)
        value_label = "Close"
    else:
        threshold = rule.get("threshold")
        if threshold is None:
            return {"triggered": False, "reason": "Price alert needs a numeric level."}
        current = float(latest["close"])
        prev_value = float(previous["close"])
        target = float(threshold)
        crossed = _compare(current, operator, target) and not _compare(prev_value, operator, target)
        triggered = crossed if rule.get("cross") else _compare(current, operator, target)
        value_label = "Close"

    return {
        "triggered": bool(triggered),
        "ticker": alert["ticker"],
        "description": rule.get("description") or alert.get("prompt"),
        "value_label": value_label,
        "current_value": round(current, 2),
        "target_value": round(target, 2),
        "operator": operator,
        "checked_at": _utc_now_iso(),
    }


def _send_email(to_email: str, subject: str, text: str, html: str | None = None) -> dict[str, Any]:
    resend_key = os.getenv("RESEND_API_KEY")
    from_email = os.getenv("ALERT_FROM_EMAIL") or os.getenv("RESEND_FROM_EMAIL")
    if resend_key and from_email:
        payload = {
            "from": from_email,
            "to": [to_email],
            "subject": subject,
            "text": text,
            **({"html": html} if html else {}),
        }
        last_error: str | None = None
        for attempt in range(1, 4):
            try:
                response = requests.post(
                    "https://api.resend.com/emails",
                    headers={"Authorization": f"Bearer {resend_key}", "Content-Type": "application/json"},
                    json=payload,
                    timeout=12,
                )
                if response.ok:
                    return {"provider": "resend", "status": "sent", "response": response.json()}
                last_error = f"status={response.status_code} response={response.text[:1000]}"
                logger.error("Resend alert email failed on attempt %s for %s: %s", attempt, to_email, last_error)
                if response.status_code < 500 and response.status_code != 429:
                    break
            except requests.RequestException as exc:
                last_error = str(exc)
                logger.exception("Resend alert email request failed on attempt %s for %s", attempt, to_email)
            if attempt < 3:
                time.sleep(0.75 * attempt)
        return {"provider": "resend", "status": "failed", "error": last_error or "unknown Resend failure"}

    smtp_host = os.getenv("SMTP_HOST")
    smtp_user = os.getenv("SMTP_USER")
    smtp_password = os.getenv("SMTP_PASSWORD")
    if smtp_host and smtp_user and smtp_password and from_email:
        import smtplib
        from email.message import EmailMessage

        msg = EmailMessage()
        msg["Subject"] = subject
        msg["From"] = from_email
        msg["To"] = to_email
        msg.set_content(text)
        if html:
            msg.add_alternative(html, subtype="html")
        with smtplib.SMTP(smtp_host, int(os.getenv("SMTP_PORT", "587"))) as server:
            server.starttls()
            server.login(smtp_user, smtp_password)
            server.send_message(msg)
        return {"provider": "smtp", "status": "sent"}

    logger.warning(
        "Alert email skipped for %s: no provider configured. Check RESEND_API_KEY and ALERT_FROM_EMAIL/RESEND_FROM_EMAIL.",
        to_email,
    )
    return {"provider": "none", "status": "skipped", "reason": "Email provider not configured."}


def _build_alert_email_html(alert: dict[str, Any], evaluation: dict[str, Any]) -> str:
    from urllib.parse import quote

    from app.services import email_theme as theme

    ticker = str(alert.get("ticker") or "Stock")
    symbol = ticker.replace(".NS", "").replace(".BO", "")
    description = str(evaluation.get("description") or alert.get("prompt") or "Alert rule")
    checked_at = str(evaluation.get("checked_at") or _utc_now_iso())[:16].replace("T", " ")
    stock_url = f"{theme.SITE_URL}/stock/{quote(ticker)}"
    body = (
        f"<div style='border:1px solid {theme.LINE};border-radius:16px;padding:16px 16px 4px'>"
        + theme.metric_grid([
            (str(evaluation.get("value_label") or "Value"), str(evaluation.get("current_value") or "n/a")),
            ("Target", str(evaluation.get("target_value") or "n/a")),
        ])
        + "</div>"
        + f"<p style='margin:14px 0 0;font-family:{theme.FONT};font-size:12.5px;color:{theme.FAINT}'>Checked {escape(checked_at)} UTC</p>"
        + "<table role='presentation' style='margin:20px 0 6px'><tr><td style='border-radius:999px;background:#0b0b0d'>"
        f"<a href='{escape(stock_url)}' style='display:inline-block;padding:12px 22px;font-family:{theme.FONT};font-size:14px;"
        f"font-weight:600;color:#ffffff;text-decoration:none'>Open {escape(symbol)} on Bullseye</a>"
        "</td></tr></table>"
    )
    return theme.email_shell(
        preheader=f"{symbol}: {description}",
        eyebrow="Price alert",
        title=f"{symbol} hit your alert",
        subtitle=description,
        body=body,
        footer=theme.footer_html(
            "Alerts are automated market monitoring for research only. Check the chart before you trade.",
            [("Manage alerts", f"{theme.SITE_URL}/?alerts=1")],
        ),
    )


def notify_alert(alert: dict[str, Any], evaluation: dict[str, Any]) -> list[dict[str, Any]]:
    message = (
        f"Bullseye alert triggered for {alert['ticker']}\n\n"
        f"Rule: {evaluation.get('description')}\n"
        f"{evaluation.get('value_label')}: {evaluation.get('current_value')}\n"
        f"Target: {evaluation.get('target_value')}\n"
        f"Checked: {evaluation.get('checked_at')}"
    )
    subject = f"{alert['ticker']} alert triggered"
    results = []
    channels = alert.get("channels") or ["email"]
    if "email" in channels and alert.get("email"):
        try:
            html = _build_alert_email_html(alert, evaluation)
            results.append(_send_email(alert["email"], subject, message, html=html))
        except Exception as exc:
            logger.exception("Alert notification failed for alert %s", alert.get("id"))
            results.append({"provider": "email", "status": "failed", "error": str(exc)})
    elif "email" in channels:
        logger.error("Alert %s triggered but has no recipient email.", alert.get("id"))
    return results


def check_alert(alert: dict[str, Any], send_notifications: bool = True) -> dict[str, Any]:
    sb = _supabase_required()
    evaluation = evaluate_alert(alert)
    now = _utc_now_iso()
    updates = {"last_checked_at": now, "updated_at": now}
    notifications: list[dict[str, Any]] = []

    if evaluation.get("triggered"):
        last_triggered = alert.get("last_triggered_at")
        cooldown_seconds = int(os.getenv("ALERT_COOLDOWN_SECONDS", "21600"))
        can_notify = True
        if last_triggered:
            try:
                last_ts = datetime.fromisoformat(last_triggered.replace("Z", "+00:00")).timestamp()
                can_notify = time.time() - last_ts > cooldown_seconds
            except Exception:
                can_notify = True
        if send_notifications and can_notify:
            notifications = notify_alert(alert, evaluation)
            sent_ok = any(n.get("status") == "sent" for n in notifications)
            if not sent_ok:
                for n in notifications:
                    print(
                        f"[Alerts] email send failed for alert {alert['id']} "
                        f"to {alert.get('email')}: {n}"
                    )
            # Only start the cooldown when an email actually went out, so a
            # transient/config failure doesn't silently block retries for hours.
            if sent_ok:
                updates["last_triggered_at"] = now
            sb.table(EVENT_TABLE).insert(
                {
                    "id": str(uuid4()),
                    "alert_id": alert["id"],
                    "user_id": alert["user_id"],
                    "ticker": alert["ticker"],
                    "evaluation": evaluation,
                    "notifications": notifications,
                    "created_at": now,
                }
            ).execute()

    sb.table(ALERT_TABLE).update(updates).eq("id", alert["id"]).execute()
    return {"alert_id": alert["id"], "evaluation": evaluation, "notifications": notifications}


def check_active_alerts(limit: int = 100) -> dict[str, Any]:
    sb = _supabase_required()
    response = sb.table(ALERT_TABLE).select("*").eq("status", "active").limit(limit).execute()
    alerts = getattr(response, "data", None) or []
    results = []
    for alert in alerts:
        try:
            results.append(check_alert(alert))
        except Exception as exc:
            results.append({"alert_id": alert.get("id"), "error": str(exc)})
    return {"checked": len(alerts), "results": results}
