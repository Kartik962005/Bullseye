'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePresence } from '@/components/motion/usePresence';
import { CallLists, Scorecard, WindowBanner } from '@/components/alerts/ForecastCalls';
import {
  type AlertSettings,
  type Horizon,
  type Pick,
  type PickRun,
  type RiskLevel,
  DEFAULT_SETTINGS,
  EMAIL_TIMES,
  HORIZONS,
  RISK_LEVELS,
  CONSENT_VERSION,
  disableAlerts,
  emailPicksNow,
  enableAlerts,
  horizonFrom,
  loadPicks,
  loadSettings,
  notReadyMessage,
  saveSettings,
  sessionContext,
  signalTypeFor,
} from '@/lib/daily-picks';

const money = (n: number) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  small = false,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  small?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-2 text-[12.5px] text-[color:var(--ink-3)]">{label}</div>
      <div className={`sx-seg flex w-full ${small ? 'sx-seg-sm' : ''}`} role="radiogroup" aria-label={label}>
        {options.map(option => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            className="min-w-0 flex-1 !px-2"
          >
            <span className="block truncate">{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}


function PickRow({ pick, rank }: { pick: Pick; rank: number }) {
  const [open, setOpen] = useState(false);
  const buy = pick.direction === 'BUY';
  const reasons = pick.explanation_json?.reasons ?? [];
  return (
    <li className="rounded-2xl border border-white/[0.07] bg-white/[0.025]">
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left sm:px-4"
      >
        <span className="w-5 shrink-0 font-numeric text-[11.5px] text-[color:var(--ink-4)] tabular-nums">{String(rank).padStart(2, '0')}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-numeric text-[14.5px] text-white">{pick.symbol}</span>
            <span className={`shrink-0 rounded-full px-2 py-0.5 font-numeric text-[10.5px] ${buy ? 'bg-[color:var(--up)]/12 text-[color:var(--up)]' : 'bg-[color:var(--down)]/12 text-[color:var(--down)]'}`}>
              {pick.direction}
            </span>
          </span>
          <span className="mt-0.5 block truncate font-numeric text-[12px] text-[color:var(--ink-2)]">
            {buy ? 'Buy up to' : 'Sell down to'} {money(buy ? pick.entry_high : pick.entry_low)} · Target {money(pick.target_price)} · Stop {money(pick.stop_loss)}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-numeric text-[13px] text-white">{Math.round((pick.confidence ?? 0) * 100)}%</span>
          <span className="block text-[10.5px] text-[color:var(--ink-4)]">confidence</span>
        </span>
        <svg viewBox="0 0 20 20" className={`h-4 w-4 shrink-0 text-[color:var(--ink-3)] transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m5 8 5 5 5-5" />
        </svg>
      </button>
      {open && (
        <div className="anim-pop border-t border-white/[0.06] px-4 pb-3.5 pt-3 text-[12.5px] leading-5 text-[color:var(--ink-2)]" data-state="open">
          <div className="grid grid-cols-3 gap-2 font-numeric">
            <div><div className="text-[10.5px] text-[color:var(--ink-4)]">Reward : risk</div>{Number(pick.risk_reward).toFixed(2)}</div>
            <div><div className="text-[10.5px] text-[color:var(--ink-4)]">Entry zone</div>{money(pick.entry_low)}–{money(pick.entry_high)}</div>
            <div><div className="text-[10.5px] text-[color:var(--ink-4)]">Company</div><span className="block truncate font-body">{pick.company_name || pick.symbol}</span></div>
          </div>
          {reasons.length > 0 && (
            <ul className="mt-2.5 list-disc space-y-1 pl-4">
              {reasons.slice(0, 3).map(reason => <li key={reason}>{reason}</li>)}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

type Status = { kind: 'idle' } | { kind: 'busy'; label: string } | { kind: 'error'; text: string } | { kind: 'done'; text: string };

/**
 * Daily picks: the stored picks for the current session at a chosen horizon,
 * plus the evening email settings. Reading never waits on the server (signed-in
 * reads come straight from the database); only saving and "email me" do.
 */
export function DailyAlertsDialog({
  open,
  userId,
  userEmail,
  onClose,
  onEnabledChange,
}: {
  open: boolean;
  userId: string;
  userEmail?: string | null;
  onClose: () => void;
  onEnabledChange?: (enabled: boolean) => void;
}) {
  const presence = usePresence(open, 220);
  const [saved, setSaved] = useState<AlertSettings>(DEFAULT_SETTINGS);
  const [draft, setDraft] = useState<AlertSettings>(DEFAULT_SETTINGS);
  const [horizon, setHorizon] = useState<Horizon>(horizonFrom(DEFAULT_SETTINGS.signal_type));
  const [risk, setRisk] = useState<RiskLevel>('Balanced');
  const [loaded, setLoaded] = useState<{ key: string; ok: boolean; run: PickRun | null; picks: Pick[] } | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [consentOpen, setConsentOpen] = useState(false);
  const consent = usePresence(open && consentOpen, 200);
  const settingsLoaded = useRef(false);
  const session = useMemo(() => (open ? sessionContext() : sessionContext()), [open]);

  // Saved settings: once per open, straight from the database.
  useEffect(() => {
    if (!open || !userId) return;
    let cancelled = false;
    settingsLoaded.current = false;
    loadSettings(userId)
      .then(settings => {
        if (cancelled) return;
        setSaved(settings);
        setDraft(settings);
        setHorizon(horizonFrom(settings.signal_type));
        setRisk(settings.risk_level);
        settingsLoaded.current = true;
      })
      .catch(() => {
        settingsLoaded.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  // Picks for the chosen horizon and risk level, keyed so a stale answer is never shown.
  const picksKey = `${horizon}:${risk}`;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    loadPicks({ horizon, risk, signedIn: true })
      .then(result => !cancelled && setLoaded({ key: picksKey, ok: true, ...result }))
      .catch(() => !cancelled && setLoaded({ key: picksKey, ok: false, run: null, picks: [] }));
    return () => {
      cancelled = true;
    };
  }, [open, horizon, risk, picksKey]);
  const current = loaded?.key === picksKey ? loaded : null;
  const picksState: 'loading' | 'ready' | 'error' = !current ? 'loading' : current.ok ? 'ready' : 'error';
  const run = current?.run ?? null;
  const picks = current?.picks ?? [];

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (consentOpen) setConsentOpen(false);
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, consentOpen, onClose]);

  useEffect(() => {
    if (status.kind !== 'done') return;
    const timer = window.setTimeout(() => setStatus({ kind: 'idle' }), 4000);
    return () => window.clearTimeout(timer);
  }, [status]);

  // The email follows whatever horizon and risk level are selected.
  const effective: AlertSettings = { ...draft, signal_type: signalTypeFor(horizon), risk_level: risk };
  const busy = status.kind === 'busy';
  const dirty =
    effective.daily_stock_email_enabled &&
    (effective.email_time !== saved.email_time || effective.signal_type !== saved.signal_type || effective.risk_level !== saved.risk_level);

  const run_ = useCallback(
    async (label: string, action: (onSlow: () => void) => Promise<void>) => {
      setStatus({ kind: 'busy', label });
      try {
        await action(() => setStatus({ kind: 'busy', label: 'Waking the server, this can take up to a minute…' }));
      } catch (error) {
        setStatus({ kind: 'error', text: error instanceof Error ? error.message : 'Something went wrong.' });
      }
    },
    [],
  );

  const applySaved = (next: AlertSettings) => {
    const merged = { ...DEFAULT_SETTINGS, ...next, email_time: String(next.email_time || '18:00').slice(0, 5) };
    setSaved(merged);
    setDraft(merged);
    onEnabledChange?.(Boolean(merged.daily_stock_email_enabled));
  };

  const toggle = () => {
    if (busy) return;
    if (draft.daily_stock_email_enabled) {
      void run_('Turning emails off…', async onSlow => {
        applySaved(await disableAlerts(onSlow));
        setStatus({ kind: 'done', text: 'Evening emails are off.' });
      });
      return;
    }
    if (!saved.consent_accepted_at || saved.consent_version !== CONSENT_VERSION) {
      setConsentOpen(true);
      return;
    }
    void run_('Turning emails on…', async onSlow => {
      applySaved(await enableAlerts(userEmail || '', { ...effective, daily_stock_email_enabled: true }, onSlow));
      setStatus({ kind: 'done', text: `On. Calls arrive around ${draft.email_time} IST on trading days.` });
    });
  };

  const confirmConsent = () => {
    setConsentOpen(false);
    void run_('Turning emails on…', async onSlow => {
      applySaved(await enableAlerts(userEmail || '', { ...effective, daily_stock_email_enabled: true }, onSlow));
      setStatus({ kind: 'done', text: `On. Calls arrive around ${draft.email_time} IST on trading days.` });
    });
  };

  const save = () =>
    void run_('Saving…', async onSlow => {
      applySaved(await saveSettings(userEmail || '', effective, onSlow));
      setStatus({ kind: 'done', text: 'Saved.' });
    });

  const emailNow = () =>
    void run_('Sending…', async onSlow => {
      await emailPicksNow(horizon, risk, onSlow);
      setStatus({ kind: 'done', text: `Sent to ${userEmail || 'your email'}.` });
    });

  if (!presence.mounted) return null;

  const horizonInfo = HORIZONS.find(item => item.value === horizon)!;
  const targetDate = run?.target_date ?? session.sessionDate;
  const forToday = targetDate === session.today;
  const phaseNote =
    forToday && session.phase === 'before_open'
      ? 'Market opens 9:15 AM'
      : forToday && session.phase === 'open'
        ? 'Market is open now'
        : null;
  const withheld = run?.status === 'withheld';
  // A forecast run lists its calls by side, and says why a side has none.
  const forecastRun = run?.summary?.kind === 'forecast' && picks.every(p => Boolean(p.explanation_json?.forecast));

  return (
    <>
      <div data-state={presence.state} className="anim-fade nova-modal-backdrop fixed inset-0 z-[70]" onClick={onClose} />
      <div data-lenis-prevent className="fixed inset-0 z-[71] flex items-end justify-center sm:items-center sm:p-4" onClick={onClose}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="daily-picks-title"
          data-state={presence.state}
          className="anim-dialog ax-sheet font-body text-white"
          onClick={event => event.stopPropagation()}
        >
          <header className="flex items-start gap-3 border-b border-white/[0.07] px-5 pb-4 pt-5 sm:px-7 sm:pt-6">
            <div className="min-w-0 flex-1">
              <h2 id="daily-picks-title" className="text-[19px] font-semibold tracking-[-0.01em] sm:text-[21px]">
                Daily calls
              </h2>
              <p className="mt-0.5 text-[13px] leading-5 text-[color:var(--ink-3)]">
                Nifty 200 calls built after each close, published only at a strength that held up in testing. Forecasts, not advice.
              </p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close daily picks" className="hdr-icon !h-9 !w-9 !min-w-9 shrink-0 !p-0">
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <path d="m5 5 10 10M15 5 5 15" />
              </svg>
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-7">
            <div className="grid gap-4 sm:grid-cols-2">
              <Segmented label="Horizon" value={horizon} options={HORIZONS.map(h => ({ value: h.value, label: h.label }))} onChange={setHorizon} />
              <Segmented label="Risk level" value={risk} options={RISK_LEVELS.map(r => ({ value: r, label: r }))} onChange={setRisk} small />
            </div>

            <section className="mt-5" aria-live="polite">
              <WindowBanner
                firstSession={targetDate}
                horizon={horizon}
                dataDate={run?.summary?.data_date ?? run?.run_date}
                phaseNote={phaseNote}
              />

              <div className="mt-1">
                {picksState === 'loading' ? (
                  <ul className="mt-4 flex flex-col gap-2" aria-label="Loading calls">
                    {[0, 1, 2, 3].map(i => <li key={i} className="sx-skeleton h-[86px] rounded-2xl" />)}
                  </ul>
                ) : picksState === 'error' ? (
                  <p className="mt-4 rounded-2xl border border-white/[0.08] px-4 py-5 text-[13px] text-[color:var(--ink-2)]">Couldn&apos;t load the calls. Close and open this again in a moment.</p>
                ) : withheld ? (
                  <p className="mt-4 rounded-2xl border border-dashed border-white/10 px-4 py-5 text-[13px] leading-6 text-[color:var(--ink-2)]">
                    {run?.summary?.withheld_reason || 'No calls for this horizon yet.'}
                  </p>
                ) : !run ? (
                  <p className="mt-4 rounded-2xl border border-dashed border-white/10 px-4 py-5 text-[13px] leading-6 text-[color:var(--ink-2)]">
                    {notReadyMessage(session)}
                  </p>
                ) : forecastRun ? (
                  <CallLists picks={picks} horizon={horizon} publish={run?.summary?.publish} notes={run?.summary?.side_notes} />
                ) : picks.length === 0 ? (
                  <p className="mt-4 rounded-2xl border border-dashed border-white/10 px-4 py-5 text-[13px] leading-6 text-[color:var(--ink-2)]">
                    No calls for this session.
                  </p>
                ) : (
                  <ol className="mt-4 flex flex-col gap-2">
                    {picks.map((pick, index) => <PickRow key={pick.id ?? pick.symbol} pick={pick} rank={index + 1} />)}
                  </ol>
                )}
              </div>

              {run && picks.length > 0 && (
                <div className="mt-3 flex justify-end">
                  <button type="button" onClick={emailNow} disabled={busy} className="sx-btn-ghost justify-center disabled:opacity-50">
                    Email me these calls
                  </button>
                </div>
              )}

              {forecastRun && (
                <Scorecard test={run?.summary?.model_test} live={run?.summary?.live_record} publish={run?.summary?.publish} horizon={horizon} />
              )}
            </section>

            <section className="mt-6 rounded-[20px] border border-white/[0.08] bg-white/[0.03] p-4">
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-medium">Email me every trading evening</div>
                  <p className="mt-0.5 text-[12.5px] leading-5 text-[color:var(--ink-3)]">
                    {draft.daily_stock_email_enabled
                      ? `${horizonInfo.label} calls, ${risk.toLowerCase()} risk, to ${userEmail || 'your email'}.`
                      : 'The next session’s calls for the horizon and risk level above.'}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={draft.daily_stock_email_enabled}
                  aria-label="Evening email"
                  disabled={busy}
                  onClick={toggle}
                  className="ax-switch"
                />
              </div>
              {draft.daily_stock_email_enabled && (
                <div className="mt-4 flex flex-wrap items-end gap-3">
                  <label className="block min-w-[9rem] flex-1">
                    <span className="mb-1.5 block text-[12.5px] text-[color:var(--ink-3)]">Send at (IST)</span>
                    <select
                      value={draft.email_time}
                      onChange={event => setDraft(current => ({ ...current, email_time: event.target.value }))}
                      className="ax-field"
                    >
                      {[...new Set([...EMAIL_TIMES, draft.email_time])].sort().map(time => (
                        <option key={time} value={time}>{time}</option>
                      ))}
                    </select>
                  </label>
                  <button type="button" onClick={save} disabled={!dirty || busy} className="nova-btn nova-btn-primary !h-11 !text-[14px] disabled:opacity-40">
                    Save changes
                  </button>
                </div>
              )}
            </section>

            <div className="mt-3 min-h-[1.5rem]" role="status">
              {status.kind === 'busy' && (
                <p className="flex items-center gap-2 text-[13px] text-[color:var(--ink-2)]">
                  <span className="nova-spinner" aria-hidden /> {status.label}
                </p>
              )}
              {status.kind === 'error' && <p className="text-[13px] text-[color:var(--down)]">{status.text}</p>}
              {status.kind === 'done' && <p className="text-[13px] text-[color:var(--up)]">{status.text}</p>}
            </div>
          </div>
        </div>
      </div>

      {consent.mounted && (
        <>
          <div data-state={consent.state} className="anim-fade nova-modal-backdrop fixed inset-0 z-[72]" />
          <div className="fixed inset-0 z-[73] flex items-end justify-center sm:items-center sm:p-4">
            <div data-state={consent.state} role="alertdialog" aria-modal="true" aria-labelledby="consent-title" className="anim-dialog ax-sheet !max-w-md p-6 font-body text-white sm:p-7">
              <h3 id="consent-title" className="text-[19px] font-semibold">Before turning this on</h3>
              <ul className="mt-4 flex flex-col gap-2.5">
                {[
                  'Picks are generated by a model from past prices.',
                  'Returns are not guaranteed, and past results don’t predict future ones.',
                  'You can turn emails off or unsubscribe at any time.',
                ].map(line => (
                  <li key={line} className="flex gap-3 text-[14px] leading-6 text-[color:var(--ink-2)]">
                    <span aria-hidden className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[color:var(--accent)]" />
                    {line}
                  </li>
                ))}
              </ul>
              <div className="mt-6 flex flex-col-reverse gap-2 pb-[env(safe-area-inset-bottom,0px)] sm:flex-row sm:justify-end">
                <button type="button" onClick={() => setConsentOpen(false)} className="sx-btn-ghost justify-center !h-11">
                  Cancel
                </button>
                <button type="button" onClick={confirmConsent} className="nova-btn nova-btn-primary !h-11 !text-[14px]">
                  I understand, turn on
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default DailyAlertsDialog;
