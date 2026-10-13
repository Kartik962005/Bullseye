'use client';

import { BACKEND } from '@/lib/client-cache';
import { getSharedSupabaseClient } from '@/lib/supabase-browser';

/** How long a pick is held: entered at the next session, out by the close of session N. */
export type Horizon = 1 | 3 | 5;
export type RiskLevel = 'Conservative' | 'Balanced' | 'Aggressive';

export const HORIZONS: Array<{ value: Horizon; label: string; detail: string }> = [
  { value: 1, label: 'Next day', detail: 'Out by the close of the same session' },
  { value: 3, label: '3 days', detail: 'Held up to 3 sessions' },
  { value: 5, label: '5 days', detail: 'Held up to 5 sessions' },
];
export const RISK_LEVELS: RiskLevel[] = ['Conservative', 'Balanced', 'Aggressive'];
export const DEFAULT_HORIZON: Horizon = 5;
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
  explanation_json?: { reasons?: string[] } | null;
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
    model_test?: { roc_auc?: number; oos_first_day?: string; oos_last_day?: string; ml_top_n?: { avg_net_r?: number; fill_rate?: number; trades?: number } | null } | null;
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
const isWeekend = (iso: string) => {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};
const nextWeekday = (iso: string) => {
  let next = addDays(iso, 1);
  while (isWeekend(next)) next = addDays(next, 1);
  return next;
};

export const prettyDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

export type SessionPhase = 'before_open' | 'open' | 'after_close' | 'closed_day';

/**
 * Which session the picks on screen are for. Until today's close they are
 * today's picks (built last evening); after the close they are the next
 * session's, built once the day's bars settle. Exchange holidays are not
 * known here, so the query takes the nearest session on or after this date.
 */
export function sessionContext(now = new Date()) {
  const { date: today, minutes } = istParts(now);
  const tradingToday = !isWeekend(today);
  let phase: SessionPhase;
  let sessionDate: string;
  if (!tradingToday) {
    phase = 'closed_day';
    sessionDate = nextWeekday(today);
  } else if (minutes < OPEN_MINUTES) {
    phase = 'before_open';
    sessionDate = today;
  } else if (minutes < CLOSE_MINUTES) {
    phase = 'open';
    sessionDate = today;
  } else {
    phase = 'after_close';
    sessionDate = nextWeekday(today);
  }
  return { today, phase, sessionDate, minutes };
}

/** What to say when the session's picks are not in the database yet. */
export function notReadyMessage(session: ReturnType<typeof sessionContext>) {
  const day = prettyDate(session.sessionDate);
  if (session.phase === 'after_close') {
    return session.minutes < 16 * 60 + 30
      ? `Picks for ${day} are built after today's close and are usually ready by 4:30 PM IST.`
      : `Picks for ${day} aren't ready yet. They are normally built by 4:30 PM IST, so check back shortly.`;
  }
  if (session.phase === 'closed_day') return `Picks for ${day} aren't ready yet. They are built from the last session's close.`;
  return `No picks were built for ${day}.`;
}

export function sessionTitle(targetDate: string, today: string) {
  if (targetDate === today) return "Today's picks";
  if (targetDate === addDays(today, 1)) return "Tomorrow's picks";
  return `Picks for ${prettyDate(targetDate)}`;
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
