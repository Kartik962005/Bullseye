# Bullseye — Fixes (2026-06-14) + Deploy Checklist

This round fixed the four user complaints. The headline finding: **the code was
mostly fine — the failures came from missing infrastructure/config**, not broken
logic. Concretely, there was **no trained ML model on disk**, the backend had
**no working LLM fallback**, Ask-AI **never fed real fundamentals to the model**,
and the daily-email automation depended on a loop that dies when Render sleeps.

---

## What was wrong → what changed

### 1. Stock buy/sell calls (only 1–2 of 10 hit target)
**Cause:** No trained model existed, so every signal used a hard-coded fallback
formula (`expected_return` was literally `0.0`). The raw, unranked rule signals
have only a **31.6%** win rate and **negative** expectancy.

**Fixed:**
- Trained the win-probability model and saved the artifact:
  `backend/app/services/daily_signal_engine/artifacts/win_probability_model.joblib`.
  Walk-forward out-of-sample result: **unranked signals = −0.064R (losing)** vs
  **ML-ranked top picks = +0.037R, profit factor 1.16 (winning)**. The trainer's
  own verdict: *"ML adds edge."*
- Switched daily selection to **ranked top-N** (`DAILY_SELECTION_MODE=ranked`,
  `MAX_SELECTED_SIGNALS=5`) — the +EV strategy the backtest validated — instead
  of a hard confidence floor that (with the now-honest model) would have emailed
  **zero** signals most days.
- Added an honest **day-level conviction label** (`high`/`moderate`/`low`/`none`).
  On a weak day it literally says *"trade small or sit out."* No more overpromising.
- Wired **daily outcome tracking** into the same cron tick so the model keeps
  learning which setups actually work (it had only ever run twice → 2 rows in
  `signal_outcomes`).
- **Stopped fabricating prices:** a failed data fetch used to silently fall back
  to random synthetic OHLC. Now it skips the ticker (set `ALLOW_MOCK_PRICES=true`
  only for offline UI demos — never in prod).

> Honest expectation: this is a real but **thin** edge (~53–59% win rate on the
> highest-conviction picks). It will never be "10/10 hit target." The win is that
> it's now **positive-expectancy and honestly labeled**, which is what earns trust.

### 2. Screener AI ("same answer every time" / wrong answers)
**Cause:** The backend only had `GROQ_API_KEY`; when Groq rate-limited there was
**no fallback**, so the screener collapsed to ~4 canned help texts. (The
`stock_snapshot` data table was fine — 2,022 fresh rows.)

**Fixed:**
- Built a real **multi-provider LLM fallback chain**: Groq → Gemini → OpenRouter →
  Cerebras (any provider without a key is skipped). Verified all three working
  keys fail over automatically.
- A malformed Gemini key (`...your_gemini_key`) is now auto-detected and skipped.
- Fixed a bug where a momentum/RSI query falsely reported *"dataset not available"*
  — it now retries without an over-aggressive LLM-picked sector filter and only
  says "unavailable" when the snapshot is genuinely down.

### 3. Ask AI (answers mostly not correct)
**Cause:** When asked "what is the PE of TCS?", Ask-AI injected only **technical**
data (RSI/MACD) into the model — never fundamentals — so the model said *"I don't
have the PE"* or guessed.

**Fixed:** Ask-AI now injects **real fundamentals** (P/E, ROE, ROCE, margins,
growth, dividend, market cap) from `stock_snapshot` as ground truth. Verified:
"PE of TCS" → **15.888** (exact match to the database), not a hallucination.

### 4. Daily alert emails (only "send instantly" worked)
**Cause:** Render's free tier sleeps after 15 min → the in-process scheduler
loop dies. The cron endpoint also didn't run outcome tracking, and skips were
silent (impossible to debug).

**Fixed:**
- New single idempotent entry point `run_scheduled_tick()` — sends due emails
  **and** records outcomes (deduped per day). Both the in-process loop and the
  `/api/v1/daily-updates/run-scheduled` endpoint now call it.
- Every tick logs a breakdown: `considered / due / skipped{no_consent, not_due_yet,
  already_sent, no_email, retry_later, gave_up}` so "no email arrived" is debuggable.
- A failed email is retried every 30 minutes, at most three times a session,
  instead of on every tick. `email_logs.error_message` keeps the provider's reason.
- The daily email now shows the conviction banner + per-signal confidence.

---

## How to run locally

```bash
# Backend (terminal 1)
cd ai-trading-mvp/backend
python -m uvicorn main:app --host 127.0.0.1 --port 8000

# Frontend (terminal 2)
cd ai-trading-mvp/frontend
npm run dev      # http://localhost:3000  (proxies to the local backend)
```

To re-train the model later (uses cached data, fully offline, ~3–5 min):
```bash
cd ai-trading-mvp/backend
python scripts/train_ml.py --top-n 5 --cost 0.05
```

---

## Production deploy checklist

Supabase tables already exist and the snapshot build cron is already running — no
DB work needed. The remaining steps:

1. **Commit the model artifact** (1.5 MB, not gitignored):
   `backend/app/services/daily_signal_engine/artifacts/win_probability_model.joblib`.
   `scikit-learn`, `joblib`, `pyarrow` are already in `requirements.txt`.

2. **Set backend env vars on Render** (Dashboard → Environment):
   ```
   OPENROUTER_API_KEY=<your key>
   CEREBRAS_API_KEY=<your key>
   CEREBRAS_MODEL=zai-glm-4.7
   ALERT_ADMIN_KEY=<pick a strong secret>      # see backend/.env for the local value
   MAX_SELECTED_SIGNALS=5
   DAILY_SELECTION_MODE=ranked
   # Optional: paste a VALID GEMINI_API_KEY (the old one was malformed)
   # Do NOT set ALLOW_MOCK_PRICES in production.
   ```

3. **Point your existing ~10-min keep-alive cron at the scheduled endpoint** so one
   cron keeps Render awake AND sends emails AND tracks outcomes:
   ```
   POST https://<your-backend>/api/v1/daily-updates/run-scheduled
   Header: x-alert-admin-key: <ALERT_ADMIN_KEY>
   ```
   (Or, if you use the GitHub Actions workflow `daily-alert-emails.yml`, set repo
   secrets `BACKEND_URL` and `ALERT_ADMIN_KEY`.)

4. **Redeploy the frontend** (Vercel) to pick up the signal-card/confidence copy.

### How to verify in prod
- `curl -X POST .../api/v1/daily-updates/run-scheduled -H "x-alert-admin-key: KEY"`
  → returns `{emails:{considered, due, skipped, sent}, outcomes:{processed}}`.
- Ask AI: "what is the PE of RELIANCE" → should quote the real snapshot number.
- Screener: try several distinct queries → each returns different, data-backed rows.
