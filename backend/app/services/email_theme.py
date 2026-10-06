"""Shared look for Bullseye emails and the unsubscribe page.

Emails use a light, minimal layout (dark emails render badly in many mail
apps): near-black text, one pink accent, tables for layout and inline styles
only, since that is all Gmail and Outlook reliably support. The logo is drawn
with two styled circles because mail clients don't render SVG.
"""

from __future__ import annotations

import os
from html import escape

SITE_URL = os.getenv("PUBLIC_SITE_URL", "https://bullseye.help").rstrip("/")

INK = "#0b0b0d"
MUTED = "#5f5b72"
FAINT = "#8a86a0"
LINE = "#ebe9f2"
ACCENT = "#e8338a"
UP = ("#0a7a4b", "#e7f8ef")
DOWN = ("#b42345", "#fdecef")
# Double quotes only: these go inside single-quoted style attributes.
FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif'
MONO = '"SFMono-Regular",Menlo,Consolas,"Liberation Mono",monospace'


def logo_html() -> str:
    """Ring with an off-centre pink dot, plus the wordmark."""
    mark = (
        "<span style='display:inline-block;vertical-align:middle;width:16px;height:16px;"
        f"border:3.5px solid {INK};border-radius:50%;line-height:0;text-align:left'>"
        f"<span style='display:inline-block;width:7px;height:7px;margin:2px 0 0 7px;border-radius:50%;background:{ACCENT}'></span>"
        "</span>"
    )
    word = (
        f"<span style='display:inline-block;vertical-align:middle;margin-left:9px;font-family:{FONT};"
        f"font-size:19px;font-weight:700;letter-spacing:-0.4px;color:{INK}'>Bullseye</span>"
    )
    return f"<a href='{SITE_URL}' style='text-decoration:none'>{mark}{word}</a>"


def pill(text: str, tone: str = "neutral") -> str:
    fg, bg = {"up": UP, "down": DOWN}.get(tone, (MUTED, "#f2f1f7"))
    return (
        f"<span style='display:inline-block;padding:3px 10px;border-radius:999px;background:{bg};"
        f"color:{fg};font-family:{FONT};font-size:12px;font-weight:600;white-space:nowrap'>{escape(text)}</span>"
    )


def metric_grid(items: list[tuple[str, str]]) -> str:
    """Label/value pairs, two per row so it fits a phone without reflowing."""
    rows = []
    for i in range(0, len(items), 2):
        cells = []
        for label, value in items[i:i + 2]:
            cells.append(
                "<td style='width:50%;padding:0 10px 12px 0;vertical-align:top'>"
                f"<div style='font-family:{FONT};font-size:11px;letter-spacing:0.4px;text-transform:uppercase;color:{FAINT}'>{escape(label)}</div>"
                f"<div style='font-family:{MONO};font-size:15px;color:{INK};margin-top:3px'>{escape(value)}</div>"
                "</td>"
            )
        rows.append("<tr>" + "".join(cells) + "</tr>")
    return f"<table role='presentation' width='100%' style='border-collapse:collapse'>{''.join(rows)}</table>"


def email_shell(*, preheader: str, eyebrow: str, title: str, subtitle: str, body: str, footer: str) -> str:
    return (
        "<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
        "<meta name='color-scheme' content='light'><meta name='supported-color-schemes' content='light'></head>"
        f"<body style='margin:0;padding:0;background:#f4f3f8'>"
        # Inbox preview text, hidden in the body.
        f"<div style='display:none;max-height:0;overflow:hidden;opacity:0'>{escape(preheader)}</div>"
        "<table role='presentation' width='100%' style='border-collapse:collapse;background:#f4f3f8'><tr><td align='center' style='padding:24px 12px'>"
        "<table role='presentation' width='100%' style='max-width:600px;border-collapse:separate;background:#ffffff;"
        f"border:1px solid {LINE};border-radius:20px'>"
        f"<tr><td style='padding:24px 26px 6px'>{logo_html()}</td></tr>"
        "<tr><td style='padding:18px 26px 6px'>"
        f"<div style='font-family:{FONT};font-size:12px;letter-spacing:0.6px;text-transform:uppercase;color:{ACCENT};font-weight:600'>{escape(eyebrow)}</div>"
        f"<h1 style='margin:8px 0 0;font-family:{FONT};font-size:26px;line-height:1.25;letter-spacing:-0.5px;color:{INK}'>{escape(title)}</h1>"
        f"<p style='margin:8px 0 0;font-family:{FONT};font-size:14px;line-height:1.6;color:{MUTED}'>{escape(subtitle)}</p>"
        "</td></tr>"
        f"<tr><td style='padding:18px 26px 8px'>{body}</td></tr>"
        f"<tr><td style='padding:6px 26px 26px;border-top:1px solid {LINE}'>{footer}</td></tr>"
        "</table>"
        f"<p style='margin:16px 0 0;font-family:{FONT};font-size:11px;color:{FAINT}'>Bullseye · AI-assisted research for Indian equities</p>"
        "</td></tr></table></body></html>"
    )


def footer_html(note: str, links: list[tuple[str, str]]) -> str:
    link_html = " &nbsp;·&nbsp; ".join(
        f"<a href='{escape(url)}' style='color:{MUTED};text-decoration:underline'>{escape(label)}</a>" for label, url in links
    )
    return (
        f"<p style='margin:16px 0 10px;font-family:{FONT};font-size:12px;line-height:1.6;color:{FAINT}'>{escape(note)}</p>"
        f"<p style='margin:0;font-family:{FONT};font-size:12px;line-height:1.6'>{link_html}</p>"
    )


def status_page_html(*, title: str, body: str, ok: bool = True) -> str:
    """Branded standalone page (unsubscribe confirmation), in the site's dark look."""
    dot = "#ff4fa3" if ok else "#ff8aa0"
    return (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{escape(title)} · Bullseye</title>"
        "<style>"
        "body{margin:0;min-height:100vh;display:grid;place-items:center;background:"
        "radial-gradient(55% 45% at 85% 0%,rgba(139,92,246,.22),transparent 70%),"
        "radial-gradient(45% 40% at 0% 25%,rgba(255,46,151,.11),transparent 70%),#070514;"
        "color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Helvetica,Arial,sans-serif;padding:24px;box-sizing:border-box}"
        ".card{max-width:440px;text-align:center}"
        "h1{margin:22px 0 10px;font-size:30px;line-height:1.15;letter-spacing:-.5px;font-weight:650}"
        "p{margin:0;font-size:15.5px;line-height:1.65;color:#b9b4d6}"
        "a.btn{display:inline-block;margin-top:28px;padding:13px 24px;border-radius:999px;color:#fff;text-decoration:none;"
        "font-weight:600;font-size:14px;background:linear-gradient(100deg,#ff2e97,#8b5cf6)}"
        "a.link{display:block;margin-top:14px;color:#9f99c2;font-size:13px}"
        "</style></head><body><main class='card'>"
        "<svg width='48' height='48' viewBox='0 0 32 32' fill='none' aria-hidden='true'>"
        f"<circle cx='16' cy='16' r='12' stroke='#fff' stroke-width='3.6'/><circle cx='18.6' cy='13.4' r='4.2' fill='{dot}'/></svg>"
        f"<h1>{escape(title)}</h1><p>{escape(body)}</p>"
        f"<a class='btn' href='{SITE_URL}'>Back to Bullseye</a>"
        f"<a class='link' href='{SITE_URL}/?alerts=1'>Manage daily alerts</a>"
        "</main></body></html>"
    )
