'use client';

import { useEffect } from 'react';
import { usePresence } from '@/components/motion/usePresence';

export type AlertPreference = {
  daily_stock_email_enabled: boolean;
  market: 'NSE' | 'BSE' | 'US';
  risk_level: 'Conservative' | 'Balanced' | 'Aggressive';
  email_time: string;
  signal_type: 'Next-day swing' | 'Intraday' | 'Both';
};

export type AlertSignal = {
  symbol: string;
  direction: 'BUY' | 'SELL';
  entry_low: number;
  entry_high: number;
  target_price: number;
  stop_loss: number;
  confidence: number;
  explanation_json?: { reasons?: string[] };
};

type SendMode = 'today' | 'next_day';

const MARKETS: AlertPreference['market'][] = ['NSE', 'BSE', 'US'];
const RISKS: AlertPreference['risk_level'][] = ['Conservative', 'Balanced', 'Aggressive'];
const TYPES: Array<{ value: AlertPreference['signal_type']; label: string }> = [
  { value: 'Next-day swing', label: 'Swing' },
  { value: 'Intraday', label: 'Intraday' },
  { value: 'Both', label: 'Both' },
];

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div>
      <div className="mb-2 text-[12.5px] text-[#9f99c2]">{label}</div>
      <div className="sx-seg flex w-full" role="radiogroup" aria-label={label}>
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            className="min-w-0 flex-1 !px-2 !text-[13px]"
          >
            <span className="block truncate">{option.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function BellIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M12 3a6 6 0 0 0-6 6v3.5L4.5 16h15L18 12.5V9a6 6 0 0 0-6-6ZM9.5 19a2.5 2.5 0 0 0 5 0" />
    </svg>
  );
}

const money = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

export function DailyAlertsDialog({
  open,
  userEmail,
  preference,
  previewSignals,
  isSaving,
  error,
  message,
  showConsent,
  onClose,
  onChange,
  onSave,
  onSendNow,
  onToggle,
  onConfirmConsent,
  onCancelConsent,
}: {
  open: boolean;
  userEmail?: string | null;
  preference: AlertPreference;
  previewSignals: AlertSignal[];
  isSaving: boolean;
  error: string;
  message: string;
  showConsent: boolean;
  onClose: () => void;
  onChange: (patch: Partial<AlertPreference>) => void;
  onSave: () => void;
  onSendNow: (mode: SendMode) => void;
  onToggle: (enabled: boolean) => void;
  onConfirmConsent: () => void;
  onCancelConsent: () => void;
}) {
  const presence = usePresence(open, 220);
  const consent = usePresence(open && showConsent, 200);
  const enabled = preference.daily_stock_email_enabled;
  const minTime = preference.market === 'US' ? '16:30' : '16:00';

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') (showConsent ? onCancelConsent : onClose)();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, showConsent, onClose, onCancelConsent]);

  if (!presence.mounted) return null;

  return (
    <>
      <div data-state={presence.state} className="anim-fade nova-modal-backdrop fixed inset-0 z-[70]" onClick={onClose} />
      <div data-lenis-prevent className="fixed inset-0 z-[71] flex items-end justify-center sm:items-center sm:p-4" onClick={onClose}>
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="daily-alerts-title"
          data-state={presence.state}
          className="anim-dialog ax-sheet font-body text-white"
          onClick={event => event.stopPropagation()}
        >
          <header className="flex items-start gap-3.5 border-b border-white/[0.07] px-5 pb-4 pt-5 sm:px-7 sm:pt-6">
            <span className="ai-orb !h-11 !w-11 shrink-0 !rounded-[14px]">
              <BellIcon />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="daily-alerts-title" className="text-[19px] font-semibold tracking-[-0.01em] sm:text-[21px]">
                Daily stock alerts
              </h2>
              <p className="mt-0.5 truncate text-[13px] text-[#9f99c2]">
                Bullseye&apos;s top picks, emailed to {userEmail || 'your account'}
              </p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close daily alerts" className="hdr-icon !h-9 !w-9 !min-w-9 shrink-0 !p-0">
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <path d="m5 5 10 10M15 5 5 15" />
              </svg>
            </button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-7">
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_290px]">
              <div className="flex min-w-0 flex-col gap-5">
                <div className={`flex items-center gap-4 rounded-[20px] border p-4 transition-colors ${enabled ? 'border-[#ff4fa3]/35 bg-[#ff4fa3]/[0.07]' : 'border-white/[0.08] bg-white/[0.035]'}`}>
                  <div className="min-w-0 flex-1">
                    <div className="text-[15px] font-medium">Email me every trading day</div>
                    <p className="mt-0.5 text-[13px] leading-5 text-[#b9b4d6]">
                      {enabled
                        ? `On. Your picks arrive around ${preference.email_time} IST, after the market closes.`
                        : 'The model’s best setups for the next session, after the market closes.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label="Daily email alerts"
                    disabled={isSaving}
                    onClick={() => onToggle(!enabled)}
                    className="ax-switch"
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Segmented label="Market" value={preference.market} options={MARKETS.map(m => ({ value: m, label: m }))} onChange={market => onChange({ market })} />
                  <Segmented label="Signal type" value={preference.signal_type} options={TYPES} onChange={signal_type => onChange({ signal_type })} />
                  <div className="sm:col-span-2">
                    <Segmented label="Risk level" value={preference.risk_level} options={RISKS.map(r => ({ value: r, label: r }))} onChange={risk_level => onChange({ risk_level })} />
                  </div>
                  <label className="block sm:col-span-2">
                    <span className="mb-2 block text-[12.5px] text-[#9f99c2]">Email time (after {minTime} IST)</span>
                    <input
                      type="time"
                      value={preference.email_time}
                      min={minTime}
                      onChange={event => onChange({ email_time: event.target.value })}
                      className="ax-field"
                    />
                  </label>
                </div>

                <div>
                  <div className="mb-2 text-[12.5px] text-[#9f99c2]">Send one now</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button type="button" disabled={isSaving} onClick={() => onSendNow('today')} className="sx-btn-ghost !h-auto flex-col !items-start !gap-0.5 !rounded-2xl !py-2.5 text-left disabled:opacity-50">
                      <span className="text-[14px] font-medium text-white">Today&apos;s picks</span>
                      <span className="text-[12px] text-[#9f99c2]">Intraday, from the latest data</span>
                    </button>
                    <button type="button" disabled={isSaving} onClick={() => onSendNow('next_day')} className="sx-btn-ghost !h-auto flex-col !items-start !gap-0.5 !rounded-2xl !py-2.5 text-left disabled:opacity-50">
                      <span className="text-[14px] font-medium text-white">Tomorrow&apos;s picks</span>
                      <span className="text-[12px] text-[#9f99c2]">For the next session</span>
                    </button>
                  </div>
                </div>

                {error && <p className="rounded-2xl border border-[#ff5c7a]/30 bg-[#ff5c7a]/[0.08] px-4 py-3 text-[13px] text-[#ffc2cf]">{error}</p>}
                {message && <p className="rounded-2xl border border-[#3dffa2]/25 bg-[#3dffa2]/[0.07] px-4 py-3 text-[13px] text-[#9ff5cb]">{message}</p>}
              </div>

              <aside className="min-w-0 rounded-[20px] border border-white/[0.07] bg-white/[0.03] p-4">
                <div className="text-[13px] font-medium">What the email looks like</div>
                <p className="mt-1 text-[12.5px] leading-5 text-[#9f99c2]">
                  Up to 10 stocks with entry, target and stop. Fewer, or none, on weak days.
                </p>
                <div className="mt-3 flex flex-col gap-2">
                  {previewSignals.length ? (
                    previewSignals.slice(0, 4).map(signal => (
                      <div key={signal.symbol} className="rounded-2xl bg-black/25 px-3.5 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-numeric text-[13.5px]">{signal.symbol}</span>
                          <span className={`shrink-0 rounded-full px-2 py-0.5 font-numeric text-[11px] ${signal.direction === 'BUY' ? 'bg-[#3dffa2]/12 text-[#6ff0b5]' : 'bg-[#ff5c7a]/12 text-[#ff8aa0]'}`}>
                            {signal.direction} · {Math.round((signal.confidence ?? 0) * 100)}%
                          </span>
                        </div>
                        <div className="mt-1.5 font-numeric text-[11.5px] leading-5 text-[#b9b4d6]">
                          Entry {money(signal.entry_low)}–{money(signal.entry_high)} · Target {money(signal.target_price)} · Stop {money(signal.stop_loss)}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="rounded-2xl border border-dashed border-white/10 px-3.5 py-5 text-center text-[12.5px] text-[#9f99c2]">
                      Tonight&apos;s picks appear here once the model has run.
                    </p>
                  )}
                </div>
              </aside>
            </div>
          </div>

          <footer className="flex items-center gap-3 border-t border-white/[0.07] px-5 py-3.5 pb-[calc(0.875rem+env(safe-area-inset-bottom,0px))] sm:px-7">
            <p className="hidden min-w-0 flex-1 text-[12px] leading-5 text-[#7d7799] sm:block">
              Model-generated research, not advice. Turn it off any time.
            </p>
            <button type="button" onClick={onSave} disabled={isSaving} className="nova-btn nova-btn-primary w-full !h-11 !text-[14px] disabled:opacity-60 sm:w-auto">
              {isSaving ? 'Saving…' : 'Save settings'}
            </button>
          </footer>
        </div>
      </div>

      {consent.mounted && (
        <>
          <div data-state={consent.state} className="anim-fade nova-modal-backdrop fixed inset-0 z-[72]" />
          <div className="fixed inset-0 z-[73] flex items-end justify-center sm:items-center sm:p-4">
            <div data-state={consent.state} role="alertdialog" aria-modal="true" className="anim-dialog ax-sheet !max-w-md p-6 font-body text-white sm:p-7">
              <h3 className="text-[19px] font-semibold">Before turning this on</h3>
              <ul className="mt-4 flex flex-col gap-2.5">
                {[
                  'Picks are generated by a model from past prices.',
                  'Returns are not guaranteed, and past results don’t predict future ones.',
                  'You can turn emails off or unsubscribe at any time.',
                ].map(line => (
                  <li key={line} className="flex gap-3 text-[14px] leading-6 text-[#cfc9ea]">
                    <span aria-hidden className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#ff4fa3]" />
                    {line}
                  </li>
                ))}
              </ul>
              <div className="mt-6 flex flex-col-reverse gap-2 pb-[env(safe-area-inset-bottom,0px)] sm:flex-row sm:justify-end">
                <button type="button" onClick={onCancelConsent} className="sx-btn-ghost justify-center !h-11">
                  Cancel
                </button>
                <button type="button" onClick={onConfirmConsent} className="nova-btn nova-btn-primary !h-11 !text-[14px]">
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
