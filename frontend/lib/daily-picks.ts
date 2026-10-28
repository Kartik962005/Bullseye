'use client';

import { BACKEND } from '@/lib/client-cache';
import { getSharedSupabaseClient } from '@/lib/supabase-browser';
import { holidaysBetween, isTradingDay, nextTradingDay, sessionAfter } from '@/lib/market-calendar';

/** How long a pick is held: entered at the next session, out by the close of session N. */
export type Horizon = 1 | 3 | 5;
export type RiskLevel = 'Conservative' | 'Balanced' | 'Aggressive';

export const HORIZONS: Array<{ value: Horizon; label: string; detail: string }> = [
  { value: 1, label: 'Intraday', detail: 'Buy or sell at the open, close out by the same day’s close' },
  { value: 3, label: '3 days', detail: 'Buy at the open, hold to the close of the third trading session' },
  { value: 5, label: '5 days', detail: 'Buy at the open, hold to the close of the fifth trading session' },
];
export const RISK_LEVELS: RiskLevel[] = ['Conservative', 'Balanced', 'Aggressive'];
export const DEFAULT_HORIZON: Horizon = 1;
export const CONSENT_VERSION = process.env.NEXT_PUBLIC_NOTIFICATION_CONSENT_VERSION || '2026-05-29';

export const signalTypeFor = (horizon: Horizon) => `${horizon}-day`;
export function horizonFrom(signalType?: string | null): Horizon {
  const match = /^(1|3|5)-day$/.exec((signalType || '').trim());
  // Older settings ('Next-day swing', 'Intraday', 'Both') were 5-session trades.
  return match ? (Number(match[1]) as Horizon) : DEFAULT_HORIZON;
}

export type Pick = {
  id?: string;
  symbol: string;
  company_name?: string | null;
  direction: 'BUY' | 'SELL';
  entry_low: number;
  entry_high: number;
  target_price: number;
  stop_loss: number;
  confidence: number;
  risk_reward: number;
  expected_r?: number;
  setup_type?: string | null;
  signal_rank?: number | null;
  explanation_json?: { reasons?: string[]; forecast?: Forecast } | null;
};

/** One call: a stock the model rates most likely to beat (BUY) or lag (SELL) the market, from the next open. */
export type Forecast = {
  kind: 'forecast';
  horizon_days: number;
  direction?: 'BUY' | 'SELL';
  /** Chance this stock beats the average Nifty 200 stock over the window. */
  p_beat: number;
  /** Chance of the call itself: beating for a BUY, lagging for a SELL. */
  p_call?: number;
  /** The same chance for the middle stock that day, for comparison. */
  typical_p_beat?: number | null;
  q10: number;
  q50: number;
  q90: number;
  reference_close: number;
  low_price: number;
  mid_price: number;
  high_price: number;
  /** The range's 1-in-10 bad case for this call: below it for a BUY, above it for a SELL. */
  stop_price?: number;
  first_session?: string;
  last_session?: string;
  context?: string[];
  tested?: { p_min: number; p_max: number; call_rate?: number; actual_beat_rate?: number; samples: number } | null;
};

/** The chance of the call itself, for v3 forecasts and older ones alike. */
export function callChance(forecast: Forecast, direction: 'BUY' | 'SELL') {
  if (typeof forecast.p_call === 'number') return forecast.p_call;
  return direction === 'BUY' ? forecast.p_beat : 1 - forecast.p_beat;
}

type ListStats = { beat_rate?: number; lag_rate?: number; avg_excess?: number; avg_shortfall?: number; t_stat?: number; rose_rate?: number; fell_rate?: number };

/** Results on the untouched half of the out-of-sample test. */
export type ForecastTest = {
  universe?: string;
  stocks?: number;
  model?: string;
  first_day?: string;
  last_day?: string;
  days?: number;
  base_beat_rate?: number;
  buy?: ListStats | null;
  sell?: ListStats | null;
  buy_edge_confirmed?: boolean;
  sell_edge_confirmed?: boolean;
  range_coverage?: number;
  ml_top_n?: { avg_net_r?: number; fill_rate?: number; trades?: number } | null;
};

/** One graded call: did it beat (buy) or lag (sell) the market, and did it rise (buy) or fall (sell)? */
export type GradedCall = {
  date: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  right: boolean;
  moved?: boolean | null;
  move_pct?: number | null;
  market_pct?: number | null;
  edge_pct?: number;
};

type LiveSide = { calls: number; right: number; moved_calls?: number; moved?: number; avg_edge_pct: number };

/** The scorecard: how the published calls have actually done since this engine went live. */
export type LiveRecord = {
  calls: number;
  since?: string | null;
  buy?: LiveSide;
  sell?: LiveSide;
  latest?: { date: string; calls: GradedCall[] } | null;
};

/** How a publishing cut-off did on one half of the out-of-sample test. */
export type PolicyStats = {
  calls: number;
  days: number;
  days_with_calls?: number;
  calls_per_day?: number;
  /** Rose after a buy, fell after a sell. */
  right_rate?: number;
  /** Beat the average Nifty 200 stock (buy) or lagged it (sell). */
  market_rate?: number;
  avg_move?: number;
  avg_after_cost?: number;
  t_stat?: number;
};

/** A side publishes only when `confirmed`; otherwise it is paused and `best` (or `confirmation`) says how close it came. */
export type PublishSide = {
  cut: number | null;
  confirmed: boolean;
  selection?: PolicyStats;
  confirmation?: PolicyStats;
  best?: PolicyStats | null;
};

export type PublishRules = {
  max_per_day?: number;
  sector_cap?: number;
  /** Both rates must reach this on the untouched half before a side publishes. */
  bar?: number;
  first_day?: string;
  last_day?: string;
  days?: number;
  /** A typical stock on the same days, for comparison. */
  base?: { rose_rate: number; beat_rate: number };
  buy?: PublishSide | null;
  sell?: PublishSide | null;
};

export type PickRun = {
  id: string;
  run_date: string;
  target_date: string;
  risk_level: RiskLevel;
  signal_type: string;
  status: string;
  generated_at: string;
  selected_count: number;
  summary?: {
    withheld_reason?: string | null;
    kind?: string;
    data_date?: string;
    last_session?: string;
    typical_p_beat?: number | null;
    model_test?: ForecastTest | null;
    live_record?: LiveRecord | null;
    publish?: PublishRules | null;
    /** Why a side has no calls in this run, keyed by side. */
    side_notes?: { buy?: string; sell?: string } | null;
  } | null;
};

export type AlertSettings = {
  daily_stock_email_enabled: boolean;
  risk_level: RiskLevel;
  signal_type: string;
  email_time: string;
  consent_version?: string | null;
  consent_accepted_at?: string | null;
};

export const DEFAULT_SETTINGS: AlertSettings = {
  daily_stock_email_enabled: false,
  risk_level: 'Balanced',
  signal_type: signalTypeFor(DEFAULT_HORIZON),
  email_time: '18:00',
};

/** Email times the scheduler covers: after the close settles, before it stops for the night. */
export const EMAIL_TIMES = ['16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00', '21:30', '22:00'];

// ── Market calendar (IST) ───────────────────────────────────────────────────

const IST = 'Asia/Kolkata';
const OPEN_MINUTES = 9 * 60 + 15;
const CLOSE_MINUTES = 15 * 60 + 30;

function istParts(now: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: IST,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map(part => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const prettyDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

export type SessionPhase = 'before_open' | 'open' | 'after_close' | 'closed_day';

/**
 * Which session the calls on screen are for. Until today's close they are
 * today's (built last evening); after the close, or on a weekend or exchange
 * holiday, they are the next trading session's.
 */
export function sessionContext(now = new Date()) {
  const { date: today, minutes } = istParts(now);
  let phase: SessionPhase;
  let sessionDate: string;
  if (!isTradingDay(today)) {
    phase = 'closed_day';
    sessionDate = nextTradingDay(today);
  } else if (minutes < OPEN_MINUTES) {
    phase = 'before_open';
    sessionDate = today;
  } else if (minutes < CLOSE_MINUTES) {
    phase = 'open';
    sessionDate = today;
  } else {
    phase = 'after_close';
    sessionDate = nextTradingDay(today);
  }
  return { today, phase, sessionDate, minutes };
}

/** The trading sessions a horizon covers, from its first session, skipping weekends and NSE holidays. */
export function horizonWindow(firstSession: string, horizon: Horizon) {
  const last = sessionAfter(firstSession, horizon);
  return { first: firstSession, last, skipped: holidaysBetween(firstSession, last) };
}

/** "Mon 26 Oct" or "Mon 26 Oct → Wed 28 Oct", for headers. */
export function windowLabel(firstSession: string, horizon: Horizon) {
  const { first, last } = horizonWindow(firstSession, horizon);
  return horizon === 1 ? prettyDate(first) : `${prettyDate(first)} → ${prettyDate(last)}`;
}

/** What to say when the session's picks are not in the database yet. */
export function notReadyMessage(session: ReturnType<typeof sessionContext>) {
  const day = prettyDate(session.sessionDate);
  if (session.phase === 'after_close') {
    return session.minutes < 16 * 60 + 30
      ? `Calls for ${day} are built after today's close and are usually ready by 4:30 PM IST.`
      : `Calls for ${day} aren't ready yet. They are normally built by 4:30 PM IST, so check back shortly.`;
  }
  if (session.phase === 'closed_day') return `Calls for ${day} aren't ready yet. They are built from the last session's close.`;
  return `No calls were built for ${day}.`;
}

export function sessionTitle(targetDate: string, today: string) {
  if (targetDate === today) return 'Today';
  if (targetDate === addDays(today, 1)) return 'Tomorrow';
  return prettyDate(targetDate);
}

// ── Data ────────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function supabase(): Promise<any | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  return getSharedSupabaseClient(SUPABASE_URL, SUPABASE_KEY);
}

export async function accessToken(): Promise<string | null> {
  const sb = await supabase();
  const result = await sb?.auth.getSession();
  return result?.data?.session?.access_token ?? null;
}

/**
 * Fetch with a hard timeout and a "slow" callback. A free server that was
 * asleep takes up to a minute to answer; the UI says so instead of spinning.
 */
export async function fetchWithTimeout(url: string, init: RequestInit = {}, { timeoutMs = 45000, onSlow }: { timeoutMs?: number; onSlow?: () => void } = {}) {
  const controller = new AbortController();
  const slow = onSlow ? window.setTimeout(onSlow, 4000) : 0;
  const abort = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The server did not answer in time. Please try again in a minute.');
    throw error;
  } finally {
    window.clearTimeout(slow);
    window.clearTimeout(abort);
  }
}

/** The stored picks for the current session. Signed-in reads go straight to the database (instant, no server wake-up). */
export async function loadPicks(
  { horizon, risk, signedIn }: { horizon: Horizon; risk: RiskLevel; signedIn: boolean },
  onSlow?: () => void,
): Promise<{ run: PickRun | null; picks: Pick[] }> {
  const { sessionDate } = sessionContext();
  const sb = signedIn ? await supabase() : null;
  if (sb) {
    const { data: runs, error } = await sb
      .from('model_runs')
      .select('id,run_date,target_date,risk_level,signal_type,status,generated_at,selected_count,summary')
      .eq('market', 'NSE')
      .eq('risk_level', risk)
      .eq('signal_type', signalTypeFor(horizon))
      .gte('target_date', sessionDate)
      .order('target_date', { ascending: true })
      .order('generated_at', { ascending: false })
      .limit(1);
    if (error) throw new Error(error.message);
    const run = (runs?.[0] as PickRun | undefined) ?? null;
    if (!run) return { run: null, picks: [] };
    const { data: picks, error: pickError } = await sb
      .from('stock_signals')
      .select('id,symbol,company_name,direction,entry_low,entry_high,target_price,stop_loss,confidence,risk_reward,expected_r,setup_type,signal_rank,explanation_json')
      .eq('model_run_id', run.id)
      .order('signal_rank', { ascending: true });
    if (pickError) throw new Error(pickError.message);
    return { run, picks: (picks as Pick[]) ?? [] };
  }
  const params = new URLSearchParams({ market: 'NSE', risk_level: risk, signal_type: signalTypeFor(horizon) });
  const response = await fetchWithTimeout(`${BACKEND}/api/v1/signals/today?${params}`, {}, { onSlow });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.detail || 'Could not load picks.');
  return { run: data.model_run ?? null, picks: Array.isArray(data.signals) ? data.signals : [] };
}

/** The signed-in user's saved alert settings, read straight from the database. */
export async function loadSettings(userId: string): Promise<AlertSettings> {
  const sb = await supabase();
  if (!sb) return DEFAULT_SETTINGS;
  const { data, error } = await sb
    .from('notification_preferences')
    .select('daily_stock_email_enabled,risk_level,signal_type,email_time,consent_version,consent_accepted_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return DEFAULT_SETTINGS;
  return {
    ...DEFAULT_SETTINGS,
    ...data,
    risk_level: RISK_LEVELS.includes(data.risk_level) ? data.risk_level : 'Balanced',
    signal_type: signalTypeFor(horizonFrom(data.signal_type)),
    email_time: String(data.email_time || DEFAULT_SETTINGS.email_time).slice(0, 5),
  };
}

async function backend(path: string, method: string, body: unknown, onSlow?: () => void) {
  const token = await accessToken();
  if (!token) throw new Error('Please sign in again.');
  const response = await fetchWithTimeout(
    `${BACKEND}${path}`,
    {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { onSlow },
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.detail || 'Something went wrong. Please try again.');
  return data;
}

export async function saveSettings(email: string, settings: AlertSettings, onSlow?: () => void) {
  const payload = { ...settings, email, market: 'NSE' };
  const path = settings.daily_stock_email_enabled && !settings.consent_accepted_at
    ? '/api/v1/notification-preferences/enable-daily-alerts'
    : '/api/v1/notification-preferences';
  const data = await backend(path, path.endsWith('enable-daily-alerts') ? 'POST' : 'PUT', payload, onSlow);
  return data.preference as AlertSettings;
}

export async function enableAlerts(email: string, settings: AlertSettings, onSlow?: () => void) {
  const data = await backend(
    '/api/v1/notification-preferences/enable-daily-alerts',
    'POST',
    { ...settings, email, market: 'NSE', consent_version: CONSENT_VERSION, consent_accepted_at: new Date().toISOString() },
    onSlow,
  );
  return data.preference as AlertSettings;
}

export async function disableAlerts(onSlow?: () => void) {
  const data = await backend('/api/v1/notification-preferences/disable-daily-alerts', 'POST', undefined, onSlow);
  return data.preference as AlertSettings;
}

export async function emailPicksNow(horizon: Horizon, risk: RiskLevel, onSlow?: () => void) {
  return backend('/api/v1/notification-preferences/send-now', 'POST', { market: 'NSE', risk_level: risk, signal_type: signalTypeFor(horizon) }, onSlow);
}
