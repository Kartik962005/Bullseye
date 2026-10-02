'use client';
import { Suspense, useState, useEffect, useLayoutEffect, useCallback, useId, useRef, useMemo, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import Link from 'next/link';
import { createPortal, flushSync } from 'react-dom';
import { usePathname, useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { STOCKS } from './stocks';
import {
  DailySignalPreviewCard,
} from '@/components/home';
import { NovaExperience } from '@/components/home/nova/NovaExperience';
import { NovaSearch } from '@/components/home/NovaSearch';
import { usePresence } from '@/components/motion/usePresence';
import { BullseyeLogo, BullseyeMark } from '@/components/brand/BullseyeLogo';
import { TrackRecord } from '@/components/stock/TrackRecord';
import { PeerComparison } from '@/components/stock/PeerComparison';
import { StockHeader } from '@/components/stock/StockHeader';
import { VerdictPanel } from '@/components/stock/VerdictPanel';
import { TradePlan } from '@/components/stock/TradePlan';
import { AiMarketSearch } from '@/components/stock/AiMarketSearch';
import { Financials } from '@/components/stock/Financials';
import { AboutSection } from '@/components/home/AboutSection';
import { LiveScanSection } from '@/components/home/LiveScanSection';
import { SiteFooter } from '@/components/home/SiteFooter';

import { BACKEND, fetcher, getCache, setCache } from '@/lib/client-cache';
import {
  toFiniteNumber,
  getAnalysisPresentation,
  getChartCandles,
} from '@/lib/analysis';
import { getSharedSupabaseClient } from '@/lib/supabase-browser';
import {
  formatCurrencyNumber,
  formatMarketCap,
  formatRatioValue,
  getLevenshteinDistance,
} from '@/lib/format';
import {
  type MarketScope,
  resolveMarket,
  canShowDetailedAnalysis,
  formatFaceValue,
} from '@/lib/stock';
import {
  type IndicatorPanelData,
  buildIndicatorPanel,
  buildPreviewChartPath,
} from '@/lib/chart';
import {
  stableMarketShuffle,
  asNumber,
  mean,
  rollingMean,
  rollingMin,
  rollingMax,
  rollingStd,
  ema,
  rsi,
  formatIndicatorValue,
  getIndicatorColor,
} from '@/lib/indicators';
type DashboardView = 'overview' | 'details';
type ChartRange = '1d' | '1w' | '1mo' | '1y' | 'max';




type NotificationPreference = {
  email?: string | null;
  daily_stock_email_enabled: boolean;
  market: 'NSE' | 'BSE' | 'US';
  risk_level: 'Conservative' | 'Balanced' | 'Aggressive';
  email_time: string;
  signal_type: 'Next-day swing' | 'Intraday' | 'Both';
  consent_version?: string | null;
  consent_accepted_at?: string | null;
  unsubscribed_at?: string | null;
};

type DailySignalRecord = {
  id?: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  entry_low: number;
  entry_high: number;
  target_price: number;
  stop_loss: number;
  confidence: number;
  risk_reward: number;
  explanation_json?: { reasons?: string[] };
};

type InstantSignalDeliveryMode = 'today' | 'next_day';

const DEFAULT_NOTIFICATION_PREFERENCE: NotificationPreference = {
  email: null,
  daily_stock_email_enabled: false,
  market: 'NSE',
  risk_level: 'Balanced',
  email_time: '18:00',
  signal_type: 'Next-day swing',
  consent_version: null,
  consent_accepted_at: null,
  unsubscribed_at: null,
};

function normalizeNotificationTimeValue(value?: string | null) {
  if (!value) return DEFAULT_NOTIFICATION_PREFERENCE.email_time;
  const match = value.match(/^(\d{2}):(\d{2})/);
  if (match) return `${match[1]}:${match[2]}`;
  return DEFAULT_NOTIFICATION_PREFERENCE.email_time;
}

function getFriendlyErrorMessage(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback;
  try {
    const parsed = JSON.parse(message);
    if (parsed?.message) return String(parsed.message);
  } catch {}
  return message || fallback;
}

function getMinimumNotificationTime(market: NotificationPreference['market']) {
  return market === 'US' ? '16:30' : '16:00';
}

function isNotificationTimeValid(market: NotificationPreference['market'], value?: string | null) {
  const normalized = normalizeNotificationTimeValue(value);
  return normalized >= getMinimumNotificationTime(market);
}

function getSafeNotificationTime(market: NotificationPreference['market'], value?: string | null) {
  const normalized = normalizeNotificationTimeValue(value);
  return isNotificationTimeValid(market, normalized) ? normalized : DEFAULT_NOTIFICATION_PREFERENCE.email_time;
}

function NotificationSettingsModal({
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
  preference: NotificationPreference;
  previewSignals: DailySignalRecord[];
  isSaving: boolean;
  error: string;
  message: string;
  showConsent: boolean;
  onClose: () => void;
  onChange: (patch: Partial<NotificationPreference>) => void;
  onSave: () => void;
  onSendNow: (deliveryMode: InstantSignalDeliveryMode) => void;
  onToggle: (enabled: boolean) => void;
  onConfirmConsent: () => void;
  onCancelConsent: () => void;
}) {
  const presence = usePresence(open, 220);
  if (!presence.mounted) return null;

  return (
    <>
      <div data-state={presence.state} className="anim-fade nova-modal-backdrop fixed inset-0 z-[70]" onClick={onClose} />
      <div data-lenis-prevent className="fixed inset-0 z-[71] flex items-start justify-center overflow-y-auto p-3 sm:items-center sm:p-4" onClick={onClose}>
        <div
          data-state={presence.state}
          className="anim-dialog nova-auth my-4 max-h-[calc(100vh-2rem)] w-full max-w-3xl overflow-y-auto rounded-[24px] font-body text-paper"
          onClick={event => event.stopPropagation()}
          onKeyDown={event => {
            if (
              showConsent ||
              event.key !== 'Enter' ||
              event.shiftKey ||
              event.ctrlKey ||
              event.altKey ||
              event.metaKey ||
              event.target instanceof HTMLButtonElement ||
              event.target instanceof HTMLSelectElement
            ) {
              return;
            }
            event.preventDefault();
            onSendNow('next_day');
          }}
        >
          <div className="flex items-start justify-between gap-4 border-b border-hairline px-7 py-6">
            <div>
              <div className="flex items-center gap-3">
                <span className="h-px w-8 bg-accent/60" />
                <span className="font-body text-[10px] font-medium uppercase tracking-[0.26em] text-accent">Daily alerts</span>
              </div>
              <h2 className="mt-3 font-display text-[28px] leading-tight text-paper">Daily 10-stock signal email</h2>
              <p className="mt-2.5 max-w-[60ch] font-body text-[13px] leading-6 text-paper-muted">
                {userEmail || 'Your signed-in account'} can receive a model-ranked 10-stock email for the next trading day after the Indian market closes.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-hairline text-paper-muted transition hover:border-accent/50 hover:text-paper"
              aria-label="Close notification settings"
            >
              ✕
            </button>
          </div>

          <div className="grid gap-6 px-7 py-7 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => onSendNow('today')}
                  disabled={isSaving}
                  className="flex min-h-[124px] flex-col justify-between rounded-2xl border border-accent/30 bg-accent/[0.06] px-5 py-4 text-left transition hover:border-accent/55 hover:bg-accent/[0.1] disabled:opacity-60"
                >
                  <div>
                    <div className="font-display text-[19px] leading-snug text-paper">
                      Today&apos;s stocks
                    </div>
                    <div className="mt-2 font-body text-[12px] leading-6 text-paper-muted">
                      Send a same-day intraday 10-stock email before market close using the latest available data.
                    </div>
                  </div>
                  <div className="mt-4 font-body text-[10px] font-semibold uppercase tracking-[0.2em] text-accent">
                    {isSaving ? 'Sending…' : 'Send today →'}
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => onSendNow('next_day')}
                  disabled={isSaving}
                  className="flex min-h-[116px] flex-col justify-between rounded-2xl border border-primary/30 bg-primary/[0.06] px-5 py-4 text-left transition hover:border-primary/55 hover:bg-primary/[0.1] disabled:opacity-60"
                >
                  <div>
                    <div className="font-display text-[19px] leading-snug text-paper">
                      Next-day stocks
                    </div>
                    <div className="mt-2 font-body text-[12px] leading-6 text-paper-muted">
                      Send the next trading day&apos;s ranked 10-stock email to your signed-in account right now.
                    </div>
                  </div>
                  <div className="mt-4 font-body text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">
                    {isSaving ? 'Sending…' : 'Send next day →'}
                  </div>
                </button>

                <label className="flex min-h-[116px] items-center justify-between gap-5 rounded-2xl border border-hairline bg-white/[0.02] px-5 py-4 sm:col-span-2">
                  <div>
                    <div className="font-display text-[19px] leading-snug text-paper">
                      Daily automatic alert
                    </div>
                    <div className="mt-2 font-body text-[12px] leading-6 text-paper-muted">
                      Turn this on once and Bullseye will automatically email your next-trading-day top 10 signals on each trading day.
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={preference.daily_stock_email_enabled}
                    onChange={event => onToggle(event.target.checked)}
                    disabled={isSaving}
                    className="h-5 w-5 shrink-0 accent-[#ff4fa3]"
                  />
                </label>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-2">
                  <span className="font-body text-[10px] font-medium uppercase tracking-[0.22em] text-paper-muted">Market</span>
                  <select
                    value={preference.market}
                    onChange={event => onChange({ market: event.target.value as NotificationPreference['market'] })}
                    className="h-12 rounded-full border border-hairline bg-black/40 px-5 font-body text-sm text-paper outline-none transition focus:border-accent/60"
                  >
                    <option value="NSE">NSE</option>
                    <option value="BSE">BSE</option>
                    <option value="US">US</option>
                  </select>
                </label>

                <label className="flex flex-col gap-2">
                  <span className="font-body text-[10px] font-medium uppercase tracking-[0.22em] text-paper-muted">Risk Level</span>
                  <select
                    value={preference.risk_level}
                    onChange={event => onChange({ risk_level: event.target.value as NotificationPreference['risk_level'] })}
                    className="h-12 rounded-full border border-hairline bg-black/40 px-5 font-body text-sm text-paper outline-none transition focus:border-accent/60"
                  >
                    <option value="Conservative">Conservative</option>
                    <option value="Balanced">Balanced</option>
                    <option value="Aggressive">Aggressive</option>
                  </select>
                </label>

                <label className="flex flex-col gap-2">
                  <span className="font-body text-[10px] font-medium uppercase tracking-[0.22em] text-paper-muted">Preferred Email Time</span>
                  <input
                    type="time"
                    value={preference.email_time}
                    onChange={event => onChange({ email_time: event.target.value })}
                    min={getMinimumNotificationTime(preference.market)}
                    className="h-12 rounded-full border border-hairline bg-black/40 px-5 font-body text-sm text-paper outline-none transition focus:border-accent/60"
                  />
                </label>

                <label className="flex flex-col gap-2">
                  <span className="font-body text-[10px] font-medium uppercase tracking-[0.22em] text-paper-muted">Signal Type</span>
                  <select
                    value={preference.signal_type}
                    onChange={event => onChange({ signal_type: event.target.value as NotificationPreference['signal_type'] })}
                    className="h-12 rounded-full border border-hairline bg-black/40 px-5 font-body text-sm text-paper outline-none transition focus:border-accent/60"
                  >
                    <option value="Next-day swing">Next-day swing</option>
                    <option value="Intraday">Intraday</option>
                    <option value="Both">Both</option>
                  </select>
                </label>
              </div>

              <div className="rounded-2xl border border-hairline bg-white/[0.02] p-5">
                <div className="font-body text-[10px] font-medium uppercase tracking-[0.22em] text-accent">Delivery rules</div>
                <div className="mt-2.5 font-body text-[12px] leading-6 text-paper-muted">
                  Your preferred time must be after the Indian market closes. When this is enabled, Bullseye will generate and send next-trading-day ranked signals automatically on trading days.
                </div>
              </div>

              {error && (
                <div className="rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 font-body text-xs text-rose-200">
                  {error}
                </div>
              )}
              {message && (
                <div className="rounded-2xl border border-primary/30 bg-primary/10 px-4 py-3 font-body text-xs text-primary">
                  {message}
                </div>
              )}

              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={onSave}
                  disabled={isSaving}
                  className="rounded-full bg-accent px-7 py-3 font-body text-[11px] font-semibold uppercase tracking-[0.18em] text-black transition duration-300 hover:bg-accent-dim disabled:opacity-50"
                >
                  {isSaving ? 'Saving…' : 'Save settings'}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-full border border-hairline px-7 py-3 font-body text-[11px] font-semibold uppercase tracking-[0.18em] text-paper-muted transition hover:border-accent/50 hover:text-paper"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="rounded-[20px] border border-hairline bg-white/[0.02] p-5">
              <div className="font-body text-[10px] font-medium uppercase tracking-[0.22em] text-accent">Email preview</div>
              <div className="mt-2.5 font-body text-[12px] leading-6 text-paper-muted">
                The top model-ranked stocks for the next trading day are sent, each with a confidence score. Fewer are sent — or none — when the market is weak and few names clear the quality bar.
              </div>
              <div className="mt-4 space-y-3">
                {previewSignals.length > 0 ? previewSignals.slice(0, 4).map(signal => (
                  <div key={signal.symbol} className="rounded-2xl border border-hairline bg-black/40 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-numeric text-[13px] text-paper">{signal.symbol}</div>
                      <div className={`font-body text-[10px] font-semibold uppercase tracking-[0.18em] ${signal.direction === 'BUY' ? 'text-primary' : 'text-rose-300'}`}>
                        {signal.direction}
                      </div>
                    </div>
                    <div className="mt-2.5 font-numeric text-[11px] leading-5 text-paper-muted">
                      Entry {signal.entry_low.toFixed(2)}–{signal.entry_high.toFixed(2)} · Target {signal.target_price.toFixed(2)} · Stop {signal.stop_loss.toFixed(2)}
                    </div>
                    <div className="mt-2.5 flex items-center gap-2">
                      <span className="rounded-full border border-accent/30 bg-accent/10 px-2.5 py-0.5 font-numeric text-[10px] text-accent">
                        Confidence {Math.round((signal.confidence ?? 0) * 100)}%
                      </span>
                      {typeof signal.risk_reward === 'number' && (
                        <span className="font-numeric text-[10px] text-paper-muted">R:R {signal.risk_reward.toFixed(2)}</span>
                      )}
                    </div>
                    <div className="mt-2.5 font-body text-[11px] leading-5 text-paper-muted/80">
                      {(signal.explanation_json?.reasons ?? []).slice(0, 2).join(' · ') || 'Model-ranked technical setup'}
                    </div>
                  </div>
                )) : (
                  <div className="rounded-2xl border border-dashed border-hairline px-4 py-6 font-body text-[12px] text-paper-muted">
                    The latest next-trading-day signal preview will appear here after the prediction engine runs.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {showConsent && (
        <>
          <div data-state="open" className="anim-fade nova-modal-backdrop fixed inset-0 z-[72]" />
          <div className="fixed inset-0 z-[73] flex items-start justify-center overflow-y-auto p-3 sm:items-center sm:p-4">
            <div data-state="open" className="anim-dialog nova-auth my-4 w-full max-w-lg rounded-[24px] p-7 font-body text-paper">
              <div className="flex items-center gap-3">
                <span className="h-px w-8 bg-accent/60" />
                <span className="font-body text-[10px] font-medium uppercase tracking-[0.26em] text-accent">Consent required</span>
              </div>
              <h3 className="mt-3.5 font-display text-[28px] leading-tight text-paper">Before turning this on</h3>
              <ul className="mt-5 space-y-3">
                {[
                  'Signals are model-generated analysis.',
                  'Returns are not guaranteed.',
                  'Past performance does not guarantee future results.',
                  'You can disable or unsubscribe at any time.',
                ].map(line => (
                  <li key={line} className="flex gap-3 font-body text-[13px] leading-6 text-paper-muted">
                    <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-7 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={onConfirmConsent}
                  className="rounded-full bg-accent px-7 py-3 font-body text-[11px] font-semibold uppercase tracking-[0.18em] text-black transition duration-300 hover:bg-accent-dim"
                >
                  I understand, enable
                </button>
                <button
                  type="button"
                  onClick={onCancelConsent}
                  className="rounded-full border border-hairline px-7 py-3 font-body text-[11px] font-semibold uppercase tracking-[0.18em] text-paper-muted transition hover:border-accent/50 hover:text-paper"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

const INDICATOR_NAMES = [
  '52 Week High/Low',
  'Accelerator Oscillator',
  'Accumulation/Distribution',
  'Accumulative Swing Index',
  'Advance/Decline',
  'Arnaud Legoux Moving Average',
  'Aroon',
  'Average Directional Index',
  'Average Price',
  'Average True Range',
  'Awesome Oscillator',
  'Balance of Power',
  'Bollinger Bands',
  'Bollinger Bands %B',
  'Bollinger Bands Width',
  'Chaikin Money Flow',
  'Chaikin Oscillator',
  'Chaikin Volatility',
  'Chande Kroll Stop',
  'Chande Momentum Oscillator',
  'Chop Zone',
  'Choppiness Index',
  'Commodity Channel Index',
  'Connors RSI',
  'Coppock Curve',
  'Correlation - Log',
  'Correlation Coefficient',
  'Detrended Price Oscillator',
  'Directional Movement',
  'Donchian Channels',
  'Double EMA',
  'Ease Of Movement',
  "Elder's Force Index",
  'EMA Cross',
  'Envelopes',
  'Fisher Transform',
  'Guppy Multiple Moving Average',
  'Historical Volatility',
  'Hull Moving Average',
  'Ichimoku Cloud',
  'Keltner Channels',
  'Klinger Oscillator',
  'Know Sure Thing',
  'Least Squares Moving Average',
  'Linear Regression Curve',
  'Linear Regression Slope',
  'MA Cross',
  'MA with EMA Cross',
  'MACD',
  'Majority Rule',
  'Mass Index',
  'McGinley Dynamic',
  'Median Price',
  'Momentum',
  'Money Flow Index',
  'Moving Average',
  'Moving Average Adaptive',
  'Moving Average Channel',
  'Moving Average Double',
  'Moving Average Exponential',
  'Moving Average Hamming',
  'Moving Average Multiple',
  'Moving Average Triple',
  'Moving Average Weighted',
  'Net Volume',
  'On Balance Volume',
  'Parabolic SAR',
  'Pivot Points Standard',
  'Price Channel',
  'Price Oscillator',
  'Price Volume Trend',
  'Rank Correlation Index',
  'Rate Of Change',
  'Ratio',
  'Relative Strength Index',
  'Relative Vigor Index',
  'Relative Volatility Index',
  'SMI Ergodic Indicator/Oscillator',
  'Smoothed Moving Average',
  'Spread',
  'Standard Deviation',
  'Standard Error',
  'Standard Error Bands',
  'Stochastic',
  'Stochastic RSI',
  'SuperTrend',
  'Trend Strength Index',
  'Triple EMA',
  'TRIX',
  'True Strength Index',
  'Typical Price',
  'Ultimate Oscillator',
  'Volatility Close-to-Close',
  'Volatility Index',
  'Volatility O-H-L-C',
  'Volatility Zero Trend Close-to-Close',
  'Volume',
  'Volume Oscillator',
  'Volume Profile Fixed Range',
  'Volume Profile Visible Range',
  'Vortex Indicator',
  'VWAP',
  'VWMA',
  'Williams %R',
  'Williams Alligator',
  'Williams Fractal',
  'Zig Zag',
];

// Homepage is intentionally a lean, fast "featured" view: only a handful of
// India stocks, all analyzed eagerly (few enough to stay fast). Deep browsing
// lives in the Screener.
const STOCKS_PER_PAGE = 6;
const STOCK_PAGE_LIMIT = 6;
const FEATURED_ANALYSIS_COUNT = 6;
const MARKET_SHUFFLE_VERSION = 'sector-mix-v1';



const IndicatorChartPane = ({
  panel,
  setPaneRef,
  onRemove,
}: {
  panel: IndicatorPanelData;
  setPaneRef: (name: string, element: HTMLDivElement | null) => void;
  onRemove?: (name: string) => void;
}) => (
  <div className="sx-study">
    <div className="sx-study-head">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: panel.color, boxShadow: `0 0 10px ${panel.color}` }} aria-hidden />
      <span className="truncate text-[13px] font-medium text-paper">{panel.name}</span>
      <span className="rounded-md px-2 py-0.5 font-numeric text-[12px]" style={{ color: panel.color, background: `color-mix(in srgb, ${panel.color} 14%, transparent)` }}>
        {panel.latest}
      </span>
      {onRemove ? (
        <button
          type="button"
          onClick={() => onRemove(panel.name)}
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-lg text-[#9f99c2] transition hover:bg-white/[0.07] hover:text-white"
          aria-label={`Remove ${panel.name}`}
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      ) : null}
    </div>
    <div
      ref={(element) => setPaneRef(panel.name, element)}
      className="h-[170px] w-full"
      aria-label={`${panel.name} indicator chart`}
    />
  </div>
);



// ─── TICKER TAPE ─────────────────────────────────────────────────────────────
type QuoteSnapshot = {
  price?: number | null;
  change_percent?: number;
};

const INDEX_TICKERS = [
  { title: 'NIFTY 50', symbol: '^NSEI', currency: '' },
  { title: 'SENSEX', symbol: '^BSESN', currency: '' },
  { title: 'NASDAQ', symbol: '^IXIC', currency: '' },
  { title: 'S&P 500', symbol: '^GSPC', currency: '' },
];

const INDEX_QUOTES_KEY = `/api/v1/quotes/batch?tickers=${INDEX_TICKERS.map(item => encodeURIComponent(item.symbol)).join(',')}`;

// Remembers that a visitor chose "continue without signing in", so the prompt
// is not re-shown on every reload. Cleared implicitly when they do sign in.
const AUTH_PROMPT_DISMISSED_KEY = 'bullseye:auth-prompt-dismissed';

const TickerItem = ({ title, currency, quote }: { title: string; currency: string; quote?: QuoteSnapshot }) => {
  const price = Number(quote?.price);
  const changePercent = Number(quote?.change_percent ?? 0);
  return (
    <div className="flex shrink-0 items-center gap-3.5 border-r border-hairline px-7">
      <span className="font-body text-[10px] font-medium uppercase tracking-[0.22em] text-paper-muted">{title}</span>
      {Number.isFinite(price) && price > 0 ? (
        <div className="flex items-center gap-2">
          <span className="font-numeric text-[13px] text-paper">{currency}{price.toLocaleString()}</span>
          <span className={`font-numeric text-[10px] ${changePercent >= 0 ? 'text-primary' : 'text-rose-300'}`}>
            {changePercent >= 0 ? '▲' : '▼'}{Math.abs(changePercent).toFixed(2)}%
          </span>
        </div>
      ) : <span className="font-numeric text-[11px] uppercase tracking-widest text-paper-muted/60">Syncing…</span>}
    </div>
  );
};

// ─── MARKET ASSET CARD ────────────────────────────────────────────────────────
const IndexTickerTape = () => {
  const [cachedQuotes, setCachedQuotes] = useState<Record<string, QuoteSnapshot> | undefined>(undefined);

  useEffect(() => {
    setCachedQuotes(getCache<Record<string, QuoteSnapshot>>('index-quotes'));
  }, []);

  const { data } = useSWR<Record<string, QuoteSnapshot>>(INDEX_QUOTES_KEY, fetcher, {
    fallbackData: cachedQuotes,
    refreshInterval: 60000,
    // Index levels are prices too — always revalidate.
    revalidateOnMount: true,
    revalidateIfStale: true,
    onSuccess: quotes => setCache('index-quotes', quotes),
  });

  const content = (
    <>
      {INDEX_TICKERS.map(item => (
        <TickerItem
          key={item.symbol}
          title={item.title}
          currency={item.currency}
          quote={data?.[item.symbol]}
        />
      ))}
    </>
  );

  return (
    <div className="flex w-[200%] sm:w-[150%] md:w-full">
      <div className="flex animate-marquee whitespace-nowrap min-w-full justify-around shrink-0">{content}</div>
      <div className="flex animate-marquee whitespace-nowrap min-w-full justify-around shrink-0">{content}</div>
    </div>
  );
};

const MarketAssetCard = ({
  stock,
  prefetchedAnalysis,
  quickQuote,
  onPreview,
  onAnalysisReady,
}: {
  stock: typeof STOCKS[0];
  prefetchedAnalysis?: any;
  quickQuote?: QuoteSnapshot;
  onPreview: (stock: typeof STOCKS[0], origin?: HTMLElement | null) => void;
  onAnalysisReady?: (ticker: string, analysis: any) => void;
}) => {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [shouldAnalyze, setShouldAnalyze] = useState(false);

  // Lazy analysis: featured cards arrive pre-analyzed via prefetchedAnalysis;
  // every other card only requests its analysis once it scrolls into view, so
  // the page paints prices immediately instead of blocking on a big batch.
  useEffect(() => {
    if (prefetchedAnalysis) return;
    const element = cardRef.current;
    if (!element || typeof IntersectionObserver === 'undefined') {
      setShouldAnalyze(true);
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setShouldAnalyze(true);
          observer.disconnect();
        }
      },
      { rootMargin: '120px' }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [prefetchedAnalysis]);

  useSWR(
    shouldAnalyze && !prefetchedAnalysis ? `/api/v1/analyze/${stock.ticker}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 1000 * 60 * 10,
      onSuccess: data => {
        if (!data || data.error) return;
        setCache(`analysis:${stock.ticker}`, data);
        onAnalysisReady?.(stock.ticker, data);
      },
    }
  );

  const analysisView = getAnalysisPresentation(prefetchedAnalysis);
  const isReady = !!analysisView;
  const quickPrice = Number(quickQuote?.price);
  const quickChange = Number(quickQuote?.change_percent ?? 0);

  const isBull = analysisView?.isBullish;
  const isHold = analysisView?.isHold;
  const verdictBadge = isReady ? analysisView.displayVerdict.replace('Strong ', '') : 'Analyzing';

  // Verdict colour drives the card's border tint, glow and bar.
  const verdictColor = isReady ? (isBull ? '#3dffa2' : isHold ? '#b9b4d6' : '#ff5c7a') : '#ff4fa3';
  const hasPrice = Number.isFinite(quickPrice) && quickPrice > 0;
  const hasChange = Number.isFinite(quickChange) && quickQuote?.change_percent != null;

  // Spotlight follows the cursor; written straight to CSS variables so moving
  // the mouse never re-renders the card.
  const handleSpotlight = (event: ReactMouseEvent<HTMLDivElement>) => {
    const element = cardRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    element.style.setProperty('--mx', `${event.clientX - rect.left}px`);
    element.style.setProperty('--my', `${event.clientY - rect.top}px`);
  };

  return (
    <div
      ref={cardRef}
      data-market-card={stock.ticker}
      role="button"
      tabIndex={0}
      aria-label={`Open ${stock.name} preview`}
      onMouseMove={handleSpotlight}
      onClick={() => {
        // A light haptic tick on phones that support it (Android Chrome);
        // silently ignored elsewhere.
        try { navigator.vibrate?.(8); } catch { /* not supported */ }
        onPreview(stock, cardRef.current);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPreview(stock, cardRef.current);
        }
      }}
      style={{ '--verdict': verdictColor } as CSSProperties}
      className="nova-card group w-full select-none font-body outline-none"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-numeric text-[14px] font-medium tracking-tight text-paper">{stock.symbol}</div>
          <div className="mt-1 truncate text-[13px] text-[#b9b4d6]" title={stock.name}>
            {stock.name}
          </div>
        </div>
        <span aria-hidden className="nova-card-arrow shrink-0">↗</span>
      </div>

      <div className="mt-5 flex items-end justify-between gap-2">
        <div className="font-numeric text-[22px] leading-none tracking-tight text-paper">
          {hasPrice ? `${stock.currency}${quickPrice.toLocaleString('en-IN')}` : '—'}
        </div>
        {hasChange ? (
          <span
            className={`rounded-full px-2 py-0.5 font-numeric text-[12px] ${
              quickChange >= 0 ? 'bg-[#3dffa2]/12 text-[#6ff0b5]' : 'bg-[#ff5c7a]/12 text-[#ff8aa0]'
            }`}
          >
            {quickChange >= 0 ? '+' : '−'}
            {Math.abs(quickChange).toFixed(2)}%
          </span>
        ) : null}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <div className="nova-card-bar" data-loading={isReady ? undefined : ''}>
          <i style={{ width: `${isReady ? analysisView.confidenceLevel : 40}%` }} />
        </div>
        <span
          className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]"
          style={{ color: verdictColor, background: `color-mix(in srgb, ${verdictColor} 14%, transparent)` }}
        >
          {verdictBadge}
        </span>
      </div>
    </div>
  );
};

const StockPreviewModal = ({
  stock,
  quickQuote,
  prefetchedAnalysis,
  onClose,
  onSelect,
  onAnalysisReady,
  origin,
}: {
  stock: typeof STOCKS[0];
  quickQuote?: QuoteSnapshot;
  prefetchedAnalysis?: any;
  onClose: () => void;
  onSelect: (stock: typeof STOCKS[0]) => void;
  onAnalysisReady: (ticker: string, analysis: unknown) => void;
  /** The card the dialog grows out of and shrinks back into. */
  origin?: HTMLElement | null;
}) => {
  const exactPreviewChart = getCache(`chart:${stock.ticker}:1mo`);
  const fallbackPreviewChart =
    exactPreviewChart ??
    getCache(`chart:${stock.ticker}:1y`) ??
    getCache(`chart:${stock.ticker}:max`);
  const { data: fetchedAnalysis } = useSWR(
    !prefetchedAnalysis ? `/api/v1/analyze/${stock.ticker}` : null,
    fetcher,
    {
      revalidateOnFocus: false,
      dedupingInterval: 1000 * 60 * 10,
      onSuccess: data => {
        if (!data || data.error) return;
        setCache(`analysis:${stock.ticker}`, data);
        onAnalysisReady(stock.ticker, data);
      },
    }
  );
  const { data: previewChart } = useSWR(`/api/v1/chart/${stock.ticker}?range=1mo`, fetcher, {
    fallbackData: fallbackPreviewChart,
    revalidateOnFocus: false,
    revalidateIfStale: !exactPreviewChart,
    revalidateOnMount: !exactPreviewChart,
    dedupingInterval: 1000 * 60 * 10,
    onSuccess: data => setCache(`chart:${stock.ticker}:1mo`, data),
  });

  const analysisView = getAnalysisPresentation(prefetchedAnalysis ?? fetchedAnalysis);
  const previewPath = buildPreviewChartPath(previewChart, 720, 170);
  const areaPath = previewPath ? `${previewPath} L 720 180 L 0 180 Z` : '';
  const quickPrice = Number(quickQuote?.price);
  const quickChange = Number(quickQuote?.change_percent ?? 0);
  const hasPrice = Number.isFinite(quickPrice) && quickPrice > 0;
  const hasChange = Number.isFinite(quickChange) && quickQuote?.change_percent != null;
  const isBull = analysisView?.isBullish;
  const isHold = analysisView?.isHold;
  const verdictColor = analysisView ? (isBull ? '#3dffa2' : isHold ? '#b9b4d6' : '#ff5c7a') : '#ff4fa3';
  const verdictLabel = analysisView ? analysisView.displayVerdict.replace('Strong ', '') : 'Analysing';
  const gradientId = `ql-${useId().replace(/:/g, '')}`;

  const backdropRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const closingRef = useRef(false);

  // Transform that lays the panel exactly over the origin card (FLIP "first").
  const originTransform = useCallback(() => {
    const panel = panelRef.current;
    if (!panel || !origin || !document.contains(origin)) return null;
    const from = origin.getBoundingClientRect();
    const to = panel.getBoundingClientRect();
    if (!from.width || !to.width) return null;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    return `translate(${dx}px, ${dy}px) scale(${from.width / to.width}, ${from.height / to.height})`;
  }, [origin]);

  // Opening: the panel springs out of the tapped card like an app launching
  // on a phone, the backdrop dims, and the contents settle in just after.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    const content = contentRef.current;
    if (!panel || !backdrop || !content || typeof panel.animate !== 'function') return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    backdrop.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: 'ease-out' });
    if (reduced) {
      panel.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 });
      return;
    }
    const from = originTransform();
    panel.animate(
      from
        ? [{ transform: from, opacity: 0.35 }, { transform: 'none', opacity: 1 }]
        : [{ transform: 'translateY(28px) scale(0.9)', opacity: 0 }, { transform: 'none', opacity: 1 }],
      { duration: 640, easing: springEasing() },
    );
    content.animate(
      [{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }],
      { duration: 380, delay: 180, easing: 'cubic-bezier(.22,.61,.36,1)', fill: 'backwards' },
    );
    // Mount-only: the opening plays once per dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Closing: shrink back into the card (or drop away if it scrolled off).
  const animateClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    const panel = panelRef.current;
    const backdrop = backdropRef.current;
    const content = contentRef.current;
    if (
      !panel || !backdrop || !content || typeof panel.animate !== 'function'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      onClose();
      return;
    }
    const to = originTransform();
    content.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' });
    backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 360, easing: 'ease-in', fill: 'forwards' });
    const shrink = panel.animate(
      [{ transform: 'none', opacity: 1 }, { transform: to ?? 'translateY(20px) scale(0.92)', opacity: to ? 0.25 : 0 }],
      { duration: 380, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' },
    );
    shrink.onfinish = () => onClose();
  }, [onClose, originTransform]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') animateClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [animateClose]);

  const stat = (label: string, value: string, tone?: string) => (
    <div className="rounded-2xl bg-white/[0.045] px-3.5 py-3">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#9f99c2]">{label}</div>
      <div className="mt-1.5 truncate font-numeric text-[15px] text-paper" style={tone ? { color: tone } : undefined}>{value}</div>
    </div>
  );

  return (
    <div
      ref={backdropRef}
      data-lenis-prevent
      className="nova-quicklook-backdrop fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto overscroll-contain p-4 sm:p-6"
      onMouseDown={animateClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${stock.name} quick look`}
    >
      <div
        ref={panelRef}
        onMouseDown={event => event.stopPropagation()}
        style={{ '--verdict': verdictColor } as CSSProperties}
        className="nova-quicklook relative my-auto w-full max-w-[460px] overflow-hidden rounded-[28px] font-body"
      >
        <div ref={contentRef} className="relative p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-white/[0.08] px-2.5 py-1 font-numeric text-[12px] text-paper">{stock.symbol}</span>
                <span className="text-[12px] text-[#9f99c2]">{stock.exchange}</span>
              </div>
              <h2 className="mt-3 truncate font-display text-[30px] leading-[1.05] text-paper" title={stock.name}>{stock.name}</h2>
            </div>
            <button
              type="button"
              onClick={animateClose}
              aria-label="Close quick look"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-[#d6d0f0] transition hover:rotate-90 hover:bg-white/15 hover:text-white"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="mt-5 flex items-end justify-between gap-4">
            <div>
              <div className="font-numeric text-[34px] leading-none tracking-tight text-paper">
                {hasPrice ? `${stock.currency}${quickPrice.toLocaleString('en-IN')}` : '—'}
              </div>
              {hasChange ? (
                <div className={`mt-2 inline-flex rounded-full px-2.5 py-0.5 font-numeric text-[12px] ${quickChange >= 0 ? 'bg-[#3dffa2]/12 text-[#6ff0b5]' : 'bg-[#ff5c7a]/12 text-[#ff8aa0]'}`}>
                  {quickChange >= 0 ? '+' : '−'}{Math.abs(quickChange).toFixed(2)}% today
                </div>
              ) : null}
            </div>
            <div
              className="rounded-2xl px-4 py-2 text-[14px] font-semibold uppercase tracking-[0.14em]"
              style={{
                color: verdictColor,
                background: `color-mix(in srgb, ${verdictColor} 14%, transparent)`,
                boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${verdictColor} 35%, transparent)`,
              }}
            >
              {verdictLabel}
            </div>
          </div>

          <div className="nova-quicklook-chart mt-5 overflow-hidden rounded-2xl">
            <div className="flex items-center justify-between px-4 pt-3 text-[12px] text-[#9f99c2]">
              <span>Last month</span>
              <span className="font-numeric">1M</span>
            </div>
            <svg viewBox="0 -10 720 190" preserveAspectRatio="none" className="h-28 w-full" role="img" aria-label={`${stock.name} price over the last month`}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" style={{ stopColor: verdictColor, stopOpacity: 0.35 }} />
                  <stop offset="1" style={{ stopColor: verdictColor, stopOpacity: 0 }} />
                </linearGradient>
              </defs>
              {previewPath ? (
                <>
                  <path d={areaPath} fill={`url(#${gradientId})`} />
                  <path d={previewPath} fill="none" style={{ stroke: verdictColor }} strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
                </>
              ) : (
                <text x="360" y="95" textAnchor="middle" fill="#9f99c2" style={{ fontSize: 13 }}>Loading chart…</text>
              )}
            </svg>
          </div>

          {analysisView ? (
            <>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <div className="rounded-2xl bg-white/[0.045] px-3.5 py-3">
                  <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#9f99c2]">Confidence</div>
                  <div className="mt-1.5 font-numeric text-[15px] text-paper">{analysisView.confidenceLevel}%</div>
                  <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full" style={{ width: `${analysisView.confidenceLevel}%`, background: verdictColor }} />
                  </div>
                </div>
                {stat('Target', isHold ? '—' : `${stock.currency}${analysisView.target}`, isHold ? undefined : '#6ff0b5')}
                {stat('Stop', isHold ? '—' : `${stock.currency}${analysisView.stop_loss}`, isHold ? undefined : '#ff8aa0')}
              </div>
              {isHold ? (
                <p className="mt-3 text-[13px] leading-5 text-[#b9b4d6]">
                  No active trade. Target and stop appear once the setup becomes actionable.
                </p>
              ) : null}
            </>
          ) : (
            <div className="mt-3 flex items-center gap-3 rounded-2xl bg-white/[0.045] px-4 py-3.5 text-[13px] text-[#b9b4d6]">
              <span className="nova-spinner" aria-hidden />
              Running the analysis…
            </div>
          )}

          <a
            href={`/?ticker=${encodeURIComponent(stock.ticker)}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelect(stock);
            }}
            className="nova-btn nova-btn-primary group mt-5 w-full"
          >
            Open full analysis
            <span aria-hidden className="transition-transform duration-300 group-hover:translate-x-1">→</span>
          </a>
        </div>
      </div>
    </div>
  );
};

/**
 * Damped-spring easing (slight overshoot, then settles) for the quick-look
 * opening, as a CSS linear() curve. Falls back to an overshooting
 * cubic-bezier where linear() isn't supported. Computed on first use (client
 * only), then cached.
 */
let springEasingCache: string | null = null;
function springEasing() {
  if (springEasingCache) return springEasingCache;
  const fallback = 'cubic-bezier(0.2, 1.12, 0.3, 1)';
  if (typeof CSS === 'undefined' || !CSS.supports?.('animation-timing-function', 'linear(0, 1)')) {
    springEasingCache = fallback;
    return fallback;
  }
  const zeta = 0.72;
  const omega = 9;
  const damped = omega * Math.sqrt(1 - zeta * zeta);
  const points: string[] = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const v = 1 - Math.exp(-zeta * omega * t) * (Math.cos(damped * t) + ((zeta * omega) / damped) * Math.sin(damped * t));
    points.push(v.toFixed(4));
  }
  points[points.length - 1] = '1';
  springEasingCache = `linear(${points.join(', ')})`;
  return springEasingCache;
}

// ─── DEEP ANALYSIS ───────────────────────────────────────────────────────────
// Below the overview: the trade laid out as a plan, then the stock Q&A.
const FisoDetailPanel = ({
  analysis,
  currency,
  ticker,
  chartData,
}: {
  analysis: any;
  currency: string;
  ticker: string;
  chartData: any;
}) => (
  <div className="flex flex-col gap-5">
    <TradePlan analysis={analysis} currency={currency} />
    <AiMarketSearch ticker={ticker} currency={currency} analysis={analysis} chartData={chartData} />
  </div>
);

const FundamentalsSnapshotCard = ({
  stock,
  currency,
  fundamentals,
  quote,
  isLoading,
}: {
  stock?: typeof STOCKS[number] | null;
  currency: string;
  fundamentals?: { summary?: Record<string, unknown> } | null;
  quote?: QuoteSnapshot | null;
  isLoading: boolean;
}) => {
  const summary = fundamentals?.summary ?? {};
  const currentPrice = quote?.price ?? summary.current_price;
  const marketCapUnit = typeof summary.market_cap_unit === 'string' ? summary.market_cap_unit : undefined;
  const highLow = summary.high_52_week && summary.low_52_week
    ? `${formatCurrencyNumber(summary.high_52_week, currency, 2)} / ${formatCurrencyNumber(summary.low_52_week, currency, 2)}`
    : '-';
  const items = [
    { label: 'Market Cap', value: formatMarketCap(summary.market_cap, marketCapUnit, currency) },
    { label: 'Current Price', value: formatCurrencyNumber(currentPrice, currency, 2) },
    { label: 'High / Low', value: highLow },
    { label: 'Stock P/E', value: formatRatioValue(summary.trailing_pe) },
    { label: 'Book Value', value: formatCurrencyNumber(summary.book_value, currency, 2) },
    { label: 'Dividend Yield', value: formatRatioValue(summary.dividend_yield, 'percent') },
    { label: 'ROE', value: formatRatioValue(summary.return_on_equity, 'percent') },
    { label: 'Face Value', value: formatFaceValue(stock, summary.face_value) },
  ];

  return (
    <section className="sx-card p-5 sm:p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-paper">Key stats</h2>
        <span className="text-[12px] text-[#8f89ad]">Latest reported figures</span>
      </div>
      {isLoading && !fundamentals ? (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {items.map(item => <div key={item.label} className="sx-skeleton h-[62px]" />)}
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-white/[0.06] sm:grid-cols-4">
          {items.map(item => (
            <div key={item.label} className="min-w-0 bg-[#100c22] px-4 py-3.5">
              <div className="text-[12px] text-[#9f99c2]">{item.label}</div>
              <div className="mt-1 truncate font-numeric text-[15px] text-paper" title={item.value}>{item.value}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

/**
 * Runs a same-page view switch (homepage <-> stock, Overview <-> Financials)
 * inside a View Transition so it crossfades and settles instead of snapping.
 * Falls back to an instant switch where the API or motion isn't available.
 */
function withViewTransition(update: () => void) {
  const doc = typeof document !== 'undefined' ? (document as Document & { startViewTransition?: (cb: () => void) => unknown }) : null;
  if (!doc?.startViewTransition || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  doc.startViewTransition(() => flushSync(update));
}

/**
 * The whole Bullseye client app. Rendered by two routes:
 *   /                  the discovery hub
 *   /stock/[ticker]    a single stock, via `initialTicker`
 *
 * The stock view used to live only at `/?ticker=X`, which meant a shared link
 * carried no stock in its path and the page had no per-stock identity. It is a
 * real route now; the query form still resolves so old links keep working.
 */
export function HomeContent({ initialTicker }: { initialTicker?: string } = {}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  // Seeded from the route param so /stock/<ticker> renders the stock view on the
  // first paint. Left at null it would server-render the discovery hub and only
  // swap after hydration, so every shared link flashed the homepage first.
  const [ticker, setTicker] = useState<string | null>(initialTicker ?? null);
  // Seed currency/market from the same stock, so a US ticker does not paint with
  // a rupee sign for a frame before the effect corrects it.
  const initialStock = initialTicker ? STOCKS.find(item => item.ticker === initialTicker) : undefined;
  const [currency, setCurrency] = useState(initialStock?.currency ?? '₹');
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<typeof STOCKS>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [activeMarket, setActiveMarket] = useState<MarketScope>(
    initialStock ? resolveMarket(initialStock.exchange) : 'INDIA',
  );
  const [dashboardView, setDashboardView] = useState<DashboardView>('overview');
  // Every stock opens on one month: the recent move is what a reader checks first.
  const [chartRange, setChartRange] = useState<ChartRange>('1mo');
  const [activeIndicators, setActiveIndicators] = useState<string[]>([]);
  const [indicatorQuery, setIndicatorQuery] = useState('');
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);
  const [expandedTicker, setExpandedTicker] = useState<string | null>(null);
  const [marketPage, setMarketPage] = useState(1);
  const [assetColumnCount, setAssetColumnCount] = useState(2);
  const chartRef = useRef<HTMLDivElement>(null);
  const indicatorPaneRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const expandedTickerRef = useRef<string | null>(null);
  const previewHistoryOpenRef = useRef(false);
  // The card the quick-look dialog grows out of (and shrinks back into).
  const [previewOrigin, setPreviewOrigin] = useState<HTMLElement | null>(null);

  // ── Auth state ───────────────────────────────────────────────────────────
  const [user, setUser] = useState<any>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authMode, setAuthMode] = useState<'signin' | 'signup'>('signin');
  const [authError, setAuthError] = useState('');
  const [authSuccess, setAuthSuccess] = useState('');
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showNotificationSettings, setShowNotificationSettings] = useState(false);
  const [showNotificationConsent, setShowNotificationConsent] = useState(false);
  const [notificationPreference, setNotificationPreference] = useState<NotificationPreference>(DEFAULT_NOTIFICATION_PREFERENCE);
  const [notificationError, setNotificationError] = useState('');
  const [notificationMessage, setNotificationMessage] = useState('');
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [dailySignalPreview, setDailySignalPreview] = useState<DailySignalRecord[]>([]);
  const [authPromptDismissed, setAuthPromptDismissed] = useState(false);
  const [cachedQuote, setCachedQuote] = useState<QuoteSnapshot | undefined>(undefined);
  const [cachedChart, setCachedChart] = useState<any>(undefined);
  const [cachedAnalysis, setCachedAnalysis] = useState<any>(undefined);
  const [cachedFundamentals, setCachedFundamentals] = useState<any>(undefined);
  const [showWelcome, setShowWelcome] = useState(false);
  // Popovers and dialogs stay mounted briefly after closing so they animate out.
  const suggestionsPresence = usePresence(showSuggestions && suggestions.length > 0, 160);
  const profilePresence = usePresence(showProfileMenu, 180);
  const authPresence = usePresence(showAuthModal, 220);
  const indicatorPresence = usePresence(showIndicatorMenu, 160);
  const [welcomeName, setWelcomeName] = useState('');
  const notificationConsentVersion = process.env.NEXT_PUBLIC_NOTIFICATION_CONSENT_VERSION || '2026-05-29';
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const supabaseRef = useRef<any>(null);
  const selectedStock = ticker ? STOCKS.find(s => s.ticker === ticker) ?? null : null;
  const canOpenDetailedAnalysis = canShowDetailedAnalysis(selectedStock);

  // Check if Supabase is available
  const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey  = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseAvailable = !!(supabaseUrl && supabaseKey);

  useEffect(() => {
    let mounted = true;
    let subscription: { unsubscribe: () => void } | null = null;

    if (!supabaseAvailable) {
      setAuthReady(true);
      return () => {};
    }

    setAuthReady(false);

    getSharedSupabaseClient(supabaseUrl!, supabaseKey!).then((client) => {
      if (!mounted) return;

      supabaseRef.current = client;
      const sb = client;

      sb.auth.getSession().then((result: any) => {
        if (!mounted) return;
        setUser(result?.data?.session?.user ?? null);
        setAuthReady(true);
      });

      const authListener = sb.auth.onAuthStateChange((event: string, session: any) => {
        if (!mounted) return;
        const newUser = session?.user ?? null;
        setUser(newUser);
        setAuthReady(true);
        // 'SIGNED_IN' fires only on actual sign-in, not on page reload (which is 'INITIAL_SESSION')
        if (event === 'SIGNED_IN' && newUser) {
          const name =
            newUser.user_metadata?.full_name ||
            newUser.user_metadata?.name ||
            newUser.email?.split('@')[0] ||
            'there';
          setWelcomeName(name);
          setShowWelcome(true);
          setTimeout(() => setShowWelcome(false), 2800);
          setShowAuthModal(false);
          setShowProfileMenu(false);
          setAuthEmail('');
          setAuthPassword('');
          setAuthError('');
          setAuthSuccess('');
        }
      });

      subscription = authListener.data.subscription;
    }).catch(() => {
      if (!mounted) return;
      setAuthReady(true);
    });

    return () => {
      mounted = false;
      subscription?.unsubscribe();
    };
  }, [supabaseAvailable, supabaseKey, supabaseUrl]);

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!showProfileMenu) return;
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setShowProfileMenu(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showProfileMenu]);

  // Sign-in is optional. Offer the prompt once the session check finishes, but
  // let visitors dismiss it and browse anonymously. Actions that genuinely need
  // an account (alerts, saved strategies, daily emails) still open this modal
  // on demand via setShowAuthModal(true).
  //
  // A previous "continue without signing in" choice is restored here rather than
  // in a separate effect: localStorage is unavailable during SSR, and reading it
  // in its own effect lets the modal flash open before the choice is seen.
  useEffect(() => {
    if (!authReady) return;
    if (user) {
      setShowAuthModal(false);
      return;
    }
    let dismissed = authPromptDismissed;
    if (!dismissed) {
      try {
        dismissed = localStorage.getItem(AUTH_PROMPT_DISMISSED_KEY) === '1';
      } catch {
        // Private mode / storage disabled: fall back to prompting each visit.
      }
    }
    setShowAuthModal(!dismissed);
  }, [authReady, user, authPromptDismissed]);

  const dismissAuthModal = () => {
    setAuthPromptDismissed(true);
    setShowAuthModal(false);
    setAuthError('');
    setAuthSuccess('');
    try {
      localStorage.setItem(AUTH_PROMPT_DISMISSED_KEY, '1');
    } catch {
      // Non-fatal: the choice just won't survive a reload.
    }
  };

  // Lock the page behind the modal. Without this the scrollbar disappears when
  // the overlay opens and the whole layout shifts sideways by its width, which
  // reads as a flicker on top of the repaint. The padding compensates so the
  // content does not jump when the bar is removed.
  useEffect(() => {
    if (!showAuthModal || typeof document === 'undefined') return;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    const previousPadding = body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbar > 0) body.style.paddingRight = scrollbar + 'px';
    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPadding;
    };
  }, [showAuthModal]);

  // Esc closes the prompt, same as "continue without signing in".
  useEffect(() => {
    if (!showAuthModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismissAuthModal();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showAuthModal]);

  const getSupabaseClient = async () => {
    if (supabaseRef.current) return supabaseRef.current;
    supabaseRef.current = await getSharedSupabaseClient(supabaseUrl!, supabaseKey!);
    return supabaseRef.current;
  };

  const handleGoogleSignIn = async () => {
    if (!supabaseAvailable) {
      setAuthError('Sign-in is not configured for this deployment yet.');
      return;
    }
    setAuthLoading(true);
    setAuthError('');
    try {
      const sb = await getSupabaseClient();
      // Always redirect back to the exact origin so it works on Vercel, localhost, etc.
      const redirectTo = window.location.origin + '/';
      await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      });
    } catch (err: any) {
      setAuthError(err.message || 'Google sign-in failed. Try again.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleEmailAuth = async () => {
    if (!authEmail || !authPassword) { setAuthError('Please fill in all fields.'); return; }
    if (!supabaseAvailable) {
      setAuthError('Sign-in is not configured for this deployment yet.');
      return;
    }
    setAuthLoading(true);
    setAuthError('');
    setAuthSuccess('');
    try {
      const sb = await getSupabaseClient();
      if (authMode === 'signup') {
        const { data, error } = await sb.auth.signUp({ email: authEmail, password: authPassword });
        if (error) throw error;
        if (data.user) {
          // onAuthStateChange 'SIGNED_IN' will handle welcome animation + modal close
          setAuthSuccess('Account created! Check your email to verify.');
          goHome();
        } else {
          setAuthSuccess('Account created! Check your email to verify.');
        }
      } else {
        const { data, error } = await sb.auth.signInWithPassword({ email: authEmail, password: authPassword });
        if (error) throw error;
        // onAuthStateChange 'SIGNED_IN' handles welcome animation + modal/menu close
        goHome();
      }
    } catch (err: any) {
      setAuthError(err.message || 'Authentication failed. Try again.');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    if (!supabaseAvailable) return;
    const sb = await getSupabaseClient();
    await sb.auth.signOut();
    setUser(null);
    setShowProfileMenu(false);
    setShowNotificationSettings(false);
    setShowNotificationConsent(false);
    setNotificationPreference(DEFAULT_NOTIFICATION_PREFERENCE);
    setDailySignalPreview([]);
  };

  const getAccessToken = async () => {
    if (!supabaseAvailable) return null;
    const sb = await getSupabaseClient();
    const result = await sb.auth.getSession();
    return result?.data?.session?.access_token ?? null;
  };

  const getNotificationHeaders = async () => {
    const token = await getAccessToken();
    if (!token) {
      throw new Error('Please sign in before changing notification settings.');
    }
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    };
  };

  const loadDailySignalPreview = async (nextPreference?: NotificationPreference) => {
    const activePreference = nextPreference || notificationPreference;
    try {
      const params = new URLSearchParams({
        market: activePreference.market,
        risk_level: activePreference.risk_level,
        signal_type: activePreference.signal_type,
      });
      const response = await fetch(`${BACKEND}/api/v1/signals/today?${params.toString()}`, { cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || 'Could not load signal preview.');
      setDailySignalPreview(Array.isArray(data.signals) ? data.signals : []);
    } catch {
      setDailySignalPreview([]);
    }
  };

  const loadNotificationPreference = async () => {
    if (!user) {
      setNotificationPreference(DEFAULT_NOTIFICATION_PREFERENCE);
      setDailySignalPreview([]);
      return;
    }
    setNotificationLoading(true);
    setNotificationError('');
    try {
      const headers = await getNotificationHeaders();
      const response = await fetch(`${BACKEND}/api/v1/notification-preferences`, { headers, cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || 'Could not load notification settings.');
      const nextPreference = {
        ...DEFAULT_NOTIFICATION_PREFERENCE,
        ...data.preference,
        email_time: getSafeNotificationTime(
          (data.preference?.market as NotificationPreference['market']) || DEFAULT_NOTIFICATION_PREFERENCE.market,
          data.preference?.email_time,
        ),
      } as NotificationPreference;
      setNotificationPreference(nextPreference);
      await loadDailySignalPreview(nextPreference);
    } catch (err: any) {
      setNotificationError(getFriendlyErrorMessage(err, 'Could not load notification settings.'));
    } finally {
      setNotificationLoading(false);
    }
  };

  useEffect(() => {
    loadNotificationPreference();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    if (!notificationMessage) return;
    const timer = window.setTimeout(() => {
      setNotificationMessage('');
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [notificationMessage]);

  const patchNotificationPreference = (patch: Partial<NotificationPreference>) => {
    setNotificationPreference(current => {
      const next = { ...current, ...patch };
      if (patch.market && !isNotificationTimeValid(patch.market, next.email_time)) {
        next.email_time = getSafeNotificationTime(patch.market, next.email_time);
      }
      if (patch.email_time) {
        next.email_time = normalizeNotificationTimeValue(patch.email_time);
      }
      return next;
    });
  };

  const saveNotificationPreference = async (payload?: Partial<NotificationPreference>) => {
    if (!user) {
      setNotificationError('Sign in first to save daily stock email settings.');
      setShowAuthModal(true);
      return;
    }
    setNotificationSaving(true);
    setNotificationError('');
    setNotificationMessage('');
    try {
      const market = (payload?.market || notificationPreference.market) as NotificationPreference['market'];
      const rawEmailTime = normalizeNotificationTimeValue(payload?.email_time || notificationPreference.email_time);
      const emailTime = isNotificationTimeValid(market, rawEmailTime)
        ? rawEmailTime
        : getSafeNotificationTime(market, rawEmailTime);
      const timeWasAdjusted = emailTime !== rawEmailTime;
      if (timeWasAdjusted) {
        setNotificationPreference(current => ({ ...current, market, email_time: emailTime }));
      }
      const headers = await getNotificationHeaders();
      const requestBody = {
        ...notificationPreference,
        ...payload,
        email: user.email,
        market,
        email_time: emailTime,
      };
      const response = await fetch(`${BACKEND}/api/v1/notification-preferences`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(requestBody),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || 'Could not save notification settings.');
      const nextPreference = {
        ...DEFAULT_NOTIFICATION_PREFERENCE,
        ...data.preference,
        email_time: getSafeNotificationTime(
          (data.preference?.market as NotificationPreference['market']) || market,
          data.preference?.email_time,
        ),
      } as NotificationPreference;
      setNotificationPreference(nextPreference);
      setShowNotificationSettings(false);
      setShowNotificationConsent(false);
      setNotificationMessage(
        timeWasAdjusted
          ? `Notification settings saved. Time adjusted to ${emailTime} IST.`
          : 'Notification settings saved for next-trading-day stock emails.'
      );
      await loadDailySignalPreview(nextPreference);
    } catch (err: any) {
      setNotificationError(getFriendlyErrorMessage(err, 'Could not save notification settings.'));
    } finally {
      setNotificationSaving(false);
    }
  };

  const sendNotificationEmailNow = async (deliveryMode: InstantSignalDeliveryMode = 'next_day') => {
    if (!user) {
      setNotificationError('Sign in first to send a stock signal email.');
      setShowAuthModal(true);
      return;
    }
    setNotificationSaving(true);
    setNotificationError('');
    setNotificationMessage('');
    try {
      const market = notificationPreference.market;
      const rawEmailTime = normalizeNotificationTimeValue(notificationPreference.email_time);
      const emailTime = isNotificationTimeValid(market, rawEmailTime)
        ? rawEmailTime
        : getSafeNotificationTime(market, rawEmailTime);
      if (emailTime !== rawEmailTime) {
        setNotificationPreference(current => ({ ...current, email_time: emailTime }));
      }
      const headers = await getNotificationHeaders();
      const response = await fetch(`${BACKEND}/api/v1/notification-preferences/send-now`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...notificationPreference,
          email: user.email,
          email_time: emailTime,
          delivery_mode: deliveryMode,
          signal_type: deliveryMode === 'today' ? 'Intraday' : notificationPreference.signal_type,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || 'Could not send the stock signal email right now.');
      const nextPreference = {
        ...DEFAULT_NOTIFICATION_PREFERENCE,
        ...data.preference,
        email_time: getSafeNotificationTime(
          (data.preference?.market as NotificationPreference['market']) || market,
          data.preference?.email_time,
        ),
      } as NotificationPreference;
      setNotificationPreference(nextPreference);
      setShowNotificationConsent(false);
      setShowNotificationSettings(false);
      setNotificationMessage(
        data.notification?.status === 'sent'
          ? (
            deliveryMode === 'today'
              ? `Today's intraday stock signal email sent for ${data.model_run?.target_date || 'today'}.`
              : `Next-trading-day stock signal email sent for ${data.model_run?.target_date || 'the next session'}.`
          )
          : `Instant email status: ${data.notification?.status || 'processed'}.`
      );
      await loadDailySignalPreview(nextPreference);
    } catch (err: any) {
      setNotificationError(getFriendlyErrorMessage(err, 'Could not send the stock signal email right now.'));
    } finally {
      setNotificationSaving(false);
    }
  };

  const confirmEnableDailySignals = async () => {
    if (!user) {
      setNotificationError('Sign in first to enable daily stock emails.');
      setShowAuthModal(true);
      return;
    }
    setNotificationSaving(true);
    setNotificationError('');
    setNotificationMessage('');
    try {
      const market = notificationPreference.market;
      const rawEmailTime = normalizeNotificationTimeValue(notificationPreference.email_time);
      const emailTime = isNotificationTimeValid(market, rawEmailTime)
        ? rawEmailTime
        : getSafeNotificationTime(market, rawEmailTime);
      const timeWasAdjusted = emailTime !== rawEmailTime;
      if (timeWasAdjusted) {
        setNotificationPreference(current => ({ ...current, email_time: emailTime }));
      }
      const headers = await getNotificationHeaders();
      const response = await fetch(`${BACKEND}/api/v1/notification-preferences/enable-daily-alerts`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...notificationPreference,
          email: user.email,
          email_time: emailTime,
          consent_version: notificationConsentVersion,
          consent_accepted_at: new Date().toISOString(),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || 'Could not enable daily stock emails.');
      const nextPreference = {
        ...DEFAULT_NOTIFICATION_PREFERENCE,
        ...data.preference,
        email_time: getSafeNotificationTime(
          (data.preference?.market as NotificationPreference['market']) || market,
          data.preference?.email_time,
        ),
      } as NotificationPreference;
      setNotificationPreference(nextPreference);
      setShowNotificationConsent(false);
      setShowNotificationSettings(false);
      setNotificationMessage(
        timeWasAdjusted
          ? `Next-trading-day stock signal emails are on. Time adjusted to ${emailTime} IST.`
          : 'Next-trading-day stock signal emails are now on.'
      );
      await loadDailySignalPreview(nextPreference);
    } catch (err: any) {
      setNotificationError(getFriendlyErrorMessage(err, 'Could not enable daily stock emails.'));
    } finally {
      setNotificationSaving(false);
    }
  };

  const disableDailySignals = async () => {
    if (!user) {
      setNotificationError('Sign in first to update daily stock emails.');
      setShowAuthModal(true);
      return;
    }
    setNotificationSaving(true);
    setNotificationError('');
    setNotificationMessage('');
    try {
      const headers = await getNotificationHeaders();
      const response = await fetch(`${BACKEND}/api/v1/notification-preferences/disable-daily-alerts`, {
        method: 'POST',
        headers,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.detail || 'Could not disable daily stock emails.');
      setNotificationPreference(current => ({
        ...current,
        ...data.preference,
        daily_stock_email_enabled: false,
      }));
      setNotificationMessage('Next-trading-day stock signal emails are now off.');
    } catch (err: any) {
      setNotificationError(getFriendlyErrorMessage(err, 'Could not disable daily stock emails.'));
    } finally {
      setNotificationSaving(false);
    }
  };

  const toggleDailySignals = async (enabled: boolean) => {
    if (!enabled) {
      await disableDailySignals();
      return;
    }
    const needsConsent = !notificationPreference.consent_accepted_at || notificationPreference.consent_version !== notificationConsentVersion;
    if (needsConsent) {
      setShowNotificationSettings(true);
      setShowNotificationConsent(true);
      return;
    }
    await confirmEnableDailySignals();
  };

  const openDailySignalSettings = () => {
    setShowProfileMenu(false);
    if (user) {
      setShowNotificationSettings(true);
      return;
    }
    setShowAuthModal(true);
  };

  // Resolve the stock from `/stock/<ticker>` first, falling back to the legacy
  // `?ticker=` form so links shared before the route existed still work.
  const tickerFromPath = (path: string | null | undefined): string | null => {
    const match = /^\/stock\/([^/?#]+)/.exec(path || '');
    return match ? decodeURIComponent(match[1]) : null;
  };

  const applyUrlState = (search: string, path?: string | null) => {
    const params = new URLSearchParams(search);
    const activePath = path ?? (typeof window !== 'undefined' ? window.location.pathname : null);
    const urlTicker = tickerFromPath(activePath) ?? params.get('ticker');
    const requestedView: DashboardView = params.get('view') === 'details' ? 'details' : 'overview';

    if (!urlTicker) {
      setTicker(null);
      setDashboardView('overview');
      setCachedChart(undefined);
      setCachedAnalysis(undefined);
      setCachedFundamentals(undefined);
      setInput('');
      setShowSuggestions(false);
      return;
    }

    const stock = STOCKS.find(s => s.ticker === urlTicker);
    if (!stock) return;

    const market = resolveMarket(stock.exchange);
    setChartRange('1mo');
    setCachedChart(getCache(`chart:${stock.ticker}:1mo`));
    setCachedAnalysis(getCache(`analysis:${stock.ticker}`));
    setCachedFundamentals(getCache(`fundamentals:${stock.ticker}`));
    setTicker(stock.ticker);
    setCurrency(stock.currency);
    setActiveMarket(market);
    setDashboardView(canShowDetailedAnalysis(stock) ? requestedView : 'overview');
  };

  useEffect(() => {
    const search = searchParams.toString();
    // `initialTicker` comes from the /stock/[ticker] route's params; prefer it
    // so the correct stock is resolved on the very first render rather than
    // after a pathname round-trip.
    const path = initialTicker ? `/stock/${encodeURIComponent(initialTicker)}` : pathname;
    applyUrlState(search ? `?${search}` : '', path);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, pathname, initialTicker]);

  useEffect(() => {
    const syncCurrentUrl = () => applyUrlState(window.location.search);
    syncCurrentUrl();
    const retryTimer = window.setTimeout(syncCurrentUrl, 250);
    return () => window.clearTimeout(retryTimer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    expandedTickerRef.current = expandedTicker;
  }, [expandedTicker]);

  useEffect(() => {
    const handlePopState = () => {
      if (expandedTickerRef.current) {
        previewHistoryOpenRef.current = false;
        setExpandedTicker(null);
        setShowProfileMenu(false);
        return;
      }
      withViewTransition(() => {
        applyUrlState(window.location.search);
        setShowProfileMenu(false);
      });
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!ticker) {
      setCachedQuote(undefined);
      setCachedChart(undefined);
      setCachedAnalysis(undefined);
      setCachedFundamentals(undefined);
      return;
    }
    setCachedQuote(getCache(`quote:${ticker}`));
    setCachedChart(getCache(`chart:${ticker}:${chartRange}`));
    setCachedAnalysis(getCache(`analysis:${ticker}`));
    setCachedFundamentals(getCache(`fundamentals:${ticker}`));
  }, [ticker, chartRange]);

  const { data: quote } = useSWR(ticker ? `/api/v1/quote/${ticker}` : null, fetcher, {
    fallbackData: cachedQuote,
    refreshInterval: 45000,
    // See the market-quotes note: the live price must always revalidate.
    revalidateIfStale: true,
    revalidateOnMount: true,
    revalidateOnFocus: true,
    dedupingInterval: 1000 * 20,
  });
  const { data: chartData, error: chartError } = useSWR(ticker ? `/api/v1/chart/${ticker}?range=${chartRange}` : null, fetcher, {
    fallbackData: cachedChart,
    revalidateIfStale: !cachedChart,
    revalidateOnMount: !cachedChart,
    revalidateOnFocus: false,
    keepPreviousData: true,
    dedupingInterval: 1000 * 60 * 10,
  });
  const { data: analysis } = useSWR(ticker ? `/api/v1/analyze/${ticker}` : null, fetcher, {
    fallbackData: cachedAnalysis,
    revalidateIfStale: !cachedAnalysis,
    revalidateOnMount: !cachedAnalysis,
    revalidateOnFocus: false,
    dedupingInterval: 1000 * 60 * 10,
  });
  const { data: fundamentals, isLoading: fundamentalsLoading } = useSWR(
    ticker && canOpenDetailedAnalysis ? `/api/v1/fundamentals/${ticker}` : null,
    fetcher,
    {
      fallbackData: cachedFundamentals,
      revalidateIfStale: !cachedFundamentals,
      revalidateOnMount: !cachedFundamentals,
      revalidateOnFocus: false,
      keepPreviousData: true,
      dedupingInterval: 1000 * 60 * 30,
    }
  );

  useEffect(() => {
    if (ticker && quote) setCache(`quote:${ticker}`, quote);
  }, [quote, ticker]);

  useEffect(() => {
    if (ticker && chartData) setCache(`chart:${ticker}:${chartRange}`, chartData);
  }, [chartData, chartRange, ticker]);

  useEffect(() => {
    if (ticker && analysis) setCache(`analysis:${ticker}`, analysis);
  }, [analysis, ticker]);

  useEffect(() => {
    if (ticker && fundamentals) setCache(`fundamentals:${ticker}`, fundamentals);
  }, [fundamentals, ticker]);

  useEffect(() => {
    if (input.trim().length < 1) { setSuggestions([]); setShowSuggestions(false); return; }
    const q = input.trim().toLowerCase();
    const mapped = STOCKS.map(s => {
      const name = s.name.toLowerCase();
      const symbol = s.symbol.toLowerCase();
      const tickerValue = s.ticker.toLowerCase();
      const exactMatch = name.includes(q) || symbol.includes(q) || tickerValue.includes(q) ? 0 : 100;
      const tokenMatch = q.split(/\s+/).every(part => name.includes(part) || symbol.includes(part) || tickerValue.includes(part)) ? 1 : 100;
      const nameDist = getLevenshteinDistance(q, name);
      const symDist = getLevenshteinDistance(q, symbol);
      return { ...s, score: Math.min(exactMatch, tokenMatch, nameDist, symDist) };
    });
    const threshold = Math.max(5, Math.ceil(q.length * 0.45));
    setSuggestions(mapped.filter(s => s.score <= threshold).sort((a, b) => a.score - b.score).slice(0, 8));
    setShowSuggestions(true);
  }, [input]);

  const indicatorPanels = useMemo(
    () => activeIndicators.map(name => buildIndicatorPanel(name, chartData)).filter(Boolean) as IndicatorPanelData[],
    [activeIndicators, chartData]
  );
  const chartRowsAvailable = Array.isArray(chartData) && chartData.some((d: any) => d.date && d.open && d.high && d.low && d.close);

  useEffect(() => {
    if (!ticker || !chartData || !chartRef.current || !Array.isArray(chartData) || chartData.length === 0) return;
    chartRef.current.innerHTML = '';
    let cleanup = () => {};
    let cancelled = false;
    import('lightweight-charts').then(({ createChart, AreaSeries, LineSeries, LineStyle }) => {
      if (cancelled || !chartRef.current) return;
      const container = chartRef.current;
      const rect = container.getBoundingClientRect();
      const initW = rect.width || container.clientWidth || 800;
      const initH = rect.height || container.clientHeight || 320;
      const indicatorHeight = 170;
      const chart = createChart(container, {
        width: initW,
        height: initH,
        // Axis labels need real contrast against the dark panel — #c6c6cd was
        // washing out, which is why dates/prices read as invisible.
        layout: { background: { color: 'transparent' }, textColor: '#c9c3e6', fontSize: 12 },
        grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
        crosshair: {
          mode: 1,
          vertLine: { color: 'rgba(255,79,163,0.55)', labelBackgroundColor: '#ff4fa3' },
          horzLine: { color: 'rgba(255,79,163,0.55)', labelBackgroundColor: '#ff4fa3' },
        },
        timeScale: {
          timeVisible: chartRange === '1d' || chartRange === '1w',
          secondsVisible: false,
          borderColor: 'rgba(255,255,255,0.08)',
          fixLeftEdge: chartRange !== 'max',
          fixRightEdge: true,
          rightOffset: 5,
        },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      });

      const isIntraday = chartRange === '1d' || chartRange === '1w';
      const formattedData = chartData
        .filter((d: any) => d.date && d.open && d.high && d.low && d.close)
        .map((d: any) => ({
          time: isIntraday
            ? Math.floor(new Date(d.date).getTime() / 1000)
            : d.date?.toString().slice(0, 10),
          open: parseFloat(d.open), high: parseFloat(d.high),
          low: parseFloat(d.low), close: parseFloat(d.close),
        }));
      // A clean line of closes reads faster than candles for most visitors.
      // Colour follows the move over the visible range: green up, red down.
      const points = formattedData.map((d: any) => ({ time: d.time, value: d.close }));
      const rising = points.length < 2 || points[points.length - 1].value >= points[0].value;
      const lineColor = rising ? '#2fe0a0' : '#ff5c7a';
      const priceSeries = chart.addSeries(AreaSeries, {
        lineColor,
        lineWidth: 2,
        topColor: rising ? 'rgba(47,224,160,0.26)' : 'rgba(255,92,122,0.24)',
        bottomColor: 'rgba(7,5,20,0)',
        priceLineColor: lineColor,
        crosshairMarkerRadius: 5,
        crosshairMarkerBorderColor: '#ffffff',
        crosshairMarkerBackgroundColor: lineColor,
      });
      priceSeries.setData(points);

      // Entry / target / stop as labelled guides, so the call sits on the chart.
      const plan = getAnalysisPresentation(analysis);
      if (plan && !plan.isHold) {
        ([
          [plan.entry, 'Entry', '#c9c3e6'],
          [plan.target, 'Target', '#2fe0a0'],
          [plan.stop_loss, 'Stop', '#ff5c7a'],
        ] as Array<[number, string, string]>).forEach(([price, title, color]) => {
          if (Number.isFinite(Number(price)) && Number(price) > 0) {
            priceSeries.createPriceLine({ price: Number(price), color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title });
          }
        });
      }

      const indicatorCharts = indicatorPanels
        .map(panel => {
          const pane = indicatorPaneRefs.current[panel.name];
          if (!pane) return null;
          pane.innerHTML = '';
          const paneRect = pane.getBoundingClientRect();
          const paneWidth = paneRect.width || pane.clientWidth || initW;
          const indicatorChart = createChart(pane, {
            width: paneWidth,
            height: indicatorHeight,
            layout: { background: { color: 'transparent' }, textColor: '#9f99c2' },
            grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
            crosshair: {
              mode: 1,
              vertLine: { color: 'rgba(255,79,163,0.45)', labelBackgroundColor: '#ff4fa3' },
              horzLine: { color: 'rgba(255,79,163,0.45)', labelBackgroundColor: '#ff4fa3' },
            },
            rightPriceScale: {
              borderColor: 'rgba(255,255,255,0.08)',
              scaleMargins: { top: 0.2, bottom: 0.12 },
            },
            timeScale: {
              timeVisible: chartRange === '1d' || chartRange === '1w',
              secondsVisible: false,
              borderColor: 'rgba(255,255,255,0.08)',
              fixLeftEdge: chartRange !== 'max',
              fixRightEdge: true,
              rightOffset: 5,
            },
          });
          const lineSeries = indicatorChart.addSeries(LineSeries, {
            color: panel.color,
            lineWidth: 2,
            priceLineVisible: true,
            lastValueVisible: true,
            crosshairMarkerVisible: true,
          });
          const panelValues = panel.series;
          const panelTimes = formattedData.slice(-panelValues.length);
          lineSeries.setData(panelValues.map((point, index) => ({
            time: panelTimes[index]?.time,
            value: point.value,
          })).filter((point: any) => point.time !== undefined));
          return { chart: indicatorChart, pane };
        })
        .filter(Boolean) as Array<{ chart: any; pane: HTMLDivElement }>;

      const allCharts = [chart, ...indicatorCharts.map(item => item.chart)];
      let syncingTimeScale = false;
      const syncRange = (sourceChart: any) => (range: any) => {
        if (!range || syncingTimeScale) return;
        syncingTimeScale = true;
        allCharts.forEach(targetChart => {
          if (targetChart !== sourceChart) {
            targetChart.timeScale().setVisibleLogicalRange(range);
          }
        });
        syncingTimeScale = false;
      };
      const mainRangeHandler = syncRange(chart);
      chart.timeScale().subscribeVisibleLogicalRangeChange(mainRangeHandler);
      const indicatorRangeHandlers = indicatorCharts.map(item => {
        const handler = syncRange(item.chart);
        item.chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
        return { item, handler };
      });

      chart.timeScale().fitContent();
      indicatorCharts.forEach(item => item.chart.timeScale().fitContent());
      // Re-fit after layout settles on mobile
      const rafId = requestAnimationFrame(() => {
        if (cancelled || !chartRef.current) return;
        const r = container.getBoundingClientRect();
        if (r.width && r.width !== initW) {
          chart.applyOptions({ width: r.width });
        }
        indicatorCharts.forEach(item => {
          const paneWidth = item.pane.getBoundingClientRect().width || item.pane.clientWidth || r.width || initW;
          item.chart.applyOptions({ width: paneWidth });
        });
        const range = chart.timeScale().getVisibleLogicalRange();
        if (range) indicatorCharts.forEach(item => item.chart.timeScale().setVisibleLogicalRange(range));
      });
      const resizeObserver = new ResizeObserver(entries => {
        const entry = entries[0];
        const w = entry?.contentRect.width || container.clientWidth || 800;
        const h = entry?.contentRect.height || container.clientHeight || 320;
        chart.applyOptions({ width: w, height: h });
        indicatorCharts.forEach(item => {
          const paneWidth = item.pane.getBoundingClientRect().width || item.pane.clientWidth || w;
          item.chart.applyOptions({ width: paneWidth, height: indicatorHeight });
        });
        const range = chart.timeScale().getVisibleLogicalRange();
        if (range) indicatorCharts.forEach(item => item.chart.timeScale().setVisibleLogicalRange(range));
      });
      resizeObserver.observe(container);
      cleanup = () => {
        cancelAnimationFrame(rafId);
        resizeObserver.disconnect();
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(mainRangeHandler);
        indicatorRangeHandlers.forEach(({ item, handler }) => {
          item.chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
        });
        indicatorCharts.forEach(item => item.chart.remove());
        chart.remove();
      };
    });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [chartData, chartRange, indicatorPanels, ticker, dashboardView, analysis]);

  const openStockView = (stock: typeof STOCKS[0], nextView: DashboardView = 'overview') => {
    withViewTransition(() => openStockViewNow(stock, nextView));
  };

  const openStockViewNow = (stock: typeof STOCKS[0], nextView: DashboardView = 'overview') => {
    const market = resolveMarket(stock.exchange);
    const resolvedView = canShowDetailedAnalysis(stock) ? nextView : 'overview';
    setCachedQuote(getCache(`quote:${stock.ticker}`));
    setChartRange('1mo');
    setCachedChart(getCache(`chart:${stock.ticker}:1mo`));
    setCachedAnalysis(getCache(`analysis:${stock.ticker}`));
    setCachedFundamentals(getCache(`fundamentals:${stock.ticker}`));
    setTicker(stock.ticker);
    setCurrency(stock.currency);
    setActiveMarket(market);
    setDashboardView(resolvedView);
    setInput('');
    setShowSuggestions(false);
    const stockPath = `/stock/${encodeURIComponent(stock.ticker)}`;
    const nextUrl = resolvedView === 'details' ? `${stockPath}?view=details` : stockPath;
    window.history.pushState({ view: 'stock', ticker: stock.ticker, dashboardView: resolvedView }, '', nextUrl);
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }));
  };

  const selectStock = (stock: typeof STOCKS[0]) => {
    openStockView(stock, 'overview');
  };

  const selectStockDetails = (stock: typeof STOCKS[0]) => {
    openStockView(stock, 'details');
  };

  const openPreview = (stock: typeof STOCKS[0], origin?: HTMLElement | null) => {
    setPreviewOrigin(origin ?? null);
    setExpandedTicker(stock.ticker);
    if (typeof window === 'undefined' || previewHistoryOpenRef.current) return;
    previewHistoryOpenRef.current = true;
    window.history.pushState({ view: 'preview', ticker: stock.ticker }, '', window.location.href);
  };

  const closePreview = () => {
    if (previewHistoryOpenRef.current && typeof window !== 'undefined') {
      previewHistoryOpenRef.current = false;
      window.history.back();
      return;
    }
    setExpandedTicker(null);
  };

  const openDetailedAnalysis = () => {
    if (!selectedStock || !canOpenDetailedAnalysis) return;
    openStockView(selectedStock, 'details');
  };

  const openOverview = () => {
    if (!selectedStock) return;
    openStockView(selectedStock, 'overview');
  };

  const goHome = () => {
    withViewTransition(() => {
      setTicker(null);
      setDashboardView('overview');
      setCachedFundamentals(undefined);
      setShowProfileMenu(false);
    });
    window.history.pushState({ view: 'home' }, '', '/');
  };

  const getMarketStocks = () => {
    if (activeMarket === 'INDIA') {
      return stableMarketShuffle(
        STOCKS.filter(s => s.exchange === 'NSE' || s.exchange === 'BSE').slice(0, STOCK_PAGE_LIMIT),
        'INDIA'
      );
    }
    if (activeMarket === 'US') {
      return stableMarketShuffle(
        STOCKS.filter(s => s.exchange === 'NASDAQ' || s.exchange === 'NYSE').slice(0, STOCK_PAGE_LIMIT),
        'US'
      );
    }
    return [];
  };

  const marketStocks = getMarketStocks();
  const marketPageCount = Math.max(1, Math.ceil(marketStocks.length / STOCKS_PER_PAGE));
  const visibleMarketStocks = marketStocks.slice((marketPage - 1) * STOCKS_PER_PAGE, marketPage * STOCKS_PER_PAGE);
  const visibleQuoteKey = visibleMarketStocks.length
    ? `/api/v1/quotes/batch?tickers=${visibleMarketStocks.map(stock => encodeURIComponent(stock.ticker)).join(',')}`
    : null;
  const marketQuoteCacheKey = `market-quotes:${MARKET_SHUFFLE_VERSION}:${activeMarket}:${marketPage}`;
  const [cachedVisibleQuotes, setCachedVisibleQuotes] = useState<Record<string, QuoteSnapshot> | undefined>(undefined);

  useEffect(() => {
    setCachedVisibleQuotes(getCache<Record<string, QuoteSnapshot>>(marketQuoteCacheKey));
  }, [marketQuoteCacheKey]);

  const { data: visibleQuotes } = useSWR<Record<string, QuoteSnapshot>>(visibleQuoteKey, fetcher, {
    fallbackData: cachedVisibleQuotes,
    refreshInterval: 60000,
    // Prices ALWAYS refetch on mount/focus. The cached value still paints
    // instantly via fallbackData, but it must never be the final answer —
    // gating revalidation on the cache is what showed hours-old prices.
    revalidateOnMount: true,
    revalidateIfStale: true,
    revalidateOnFocus: true,
    dedupingInterval: 1000 * 20,
    onSuccess: quotes => {
      setCache(marketQuoteCacheKey, quotes);
      Object.entries(quotes).forEach(([nextTicker, nextQuote]) => setCache(`quote:${nextTicker}`, nextQuote));
    },
  });

  useEffect(() => {
    const nextPage = marketPage + 1;
    if (nextPage > marketPageCount) return;
    const nextCacheKey = `market-quotes:${MARKET_SHUFFLE_VERSION}:${activeMarket}:${nextPage}`;
    if (getCache<Record<string, QuoteSnapshot>>(nextCacheKey)) return;

    const nextStocks = marketStocks.slice((nextPage - 1) * STOCKS_PER_PAGE, nextPage * STOCKS_PER_PAGE);
    if (!nextStocks.length) return;
    const nextKey = `/api/v1/quotes/batch?tickers=${nextStocks.map(stock => encodeURIComponent(stock.ticker)).join(',')}`;
    let cancelled = false;

    fetcher(nextKey)
      .then((quotes: Record<string, QuoteSnapshot>) => {
        if (cancelled || !quotes) return;
        setCache(nextCacheKey, quotes);
        Object.entries(quotes).forEach(([nextTicker, nextQuote]) => setCache(`quote:${nextTicker}`, nextQuote));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMarket, marketPage, marketPageCount]);

  const assetColumns = Array.from({ length: assetColumnCount }, (_, columnIndex) =>
    visibleMarketStocks.filter((_, stockIndex) => stockIndex % assetColumnCount === columnIndex)
  );

  // ── Prefetch cache: ticker → analysis result ──────────────────────────────
  const [prefetchCache, setPrefetchCache] = useState<Record<string, any>>({});
  const [cachedVisibleAnalysis, setCachedVisibleAnalysis] = useState<Record<string, any> | undefined>(undefined);
  const featuredAnalysisStocks = visibleMarketStocks.slice(0, FEATURED_ANALYSIS_COUNT);
  const visibleAnalysisKey = featuredAnalysisStocks.length
    ? `/api/v1/analyze-batch?tickers=${featuredAnalysisStocks.map(stock => encodeURIComponent(stock.ticker)).join(',')}`
    : null;
  const visibleAnalysisComplete = featuredAnalysisStocks.length > 0
    && featuredAnalysisStocks.every(stock => cachedVisibleAnalysis?.[stock.ticker]);

  useEffect(() => {
    const cachedVisible = visibleMarketStocks.reduce((acc, stock) => {
      const cached = getCache(`analysis:${stock.ticker}`);
      if (cached) acc[stock.ticker] = cached;
      return acc;
    }, {} as Record<string, any>);
    setCachedVisibleAnalysis(Object.keys(cachedVisible).length ? cachedVisible : undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMarket, marketPage]);

  useEffect(() => {
    if (!cachedVisibleAnalysis) return;
    const clean: Record<string, any> = {};
    Object.entries(cachedVisibleAnalysis).forEach(([nextTicker, nextAnalysis]) => {
      if (!nextAnalysis || nextAnalysis.error || nextAnalysis.detail) return;
      clean[nextTicker] = nextAnalysis;
      setCache(`analysis:${nextTicker}`, nextAnalysis);
    });
    if (Object.keys(clean).length > 0) {
      setPrefetchCache(prev => ({ ...prev, ...clean }));
    }
  }, [cachedVisibleAnalysis]);

  const { data: visibleAnalysis } = useSWR<Record<string, any>>(visibleAnalysisKey, fetcher, {
    fallbackData: cachedVisibleAnalysis,
    revalidateOnFocus: false,
    dedupingInterval: 1000 * 60 * 10,
    revalidateIfStale: !visibleAnalysisComplete,
    revalidateOnMount: !visibleAnalysisComplete,
    onSuccess: results => {
      const clean: Record<string, any> = {};
      Object.entries(results ?? {}).forEach(([nextTicker, nextAnalysis]) => {
        if (!nextAnalysis || nextAnalysis.error || nextAnalysis.detail) return;
        clean[nextTicker] = nextAnalysis;
        setCache(`analysis:${nextTicker}`, nextAnalysis);
      });
      if (Object.keys(clean).length > 0) {
        setPrefetchCache(prev => ({ ...prev, ...clean }));
      }
    },
  });

  useEffect(() => {
    if (!visibleAnalysis) return;
    const clean: Record<string, any> = {};
    Object.entries(visibleAnalysis).forEach(([nextTicker, nextAnalysis]) => {
      if (!nextAnalysis || nextAnalysis.error || nextAnalysis.detail) return;
      clean[nextTicker] = nextAnalysis;
      setCache(`analysis:${nextTicker}`, nextAnalysis);
    });
    if (Object.keys(clean).length > 0) {
      setPrefetchCache(prev => ({ ...prev, ...clean }));
    }
  }, [visibleAnalysis]);

  // Hydrate visible cards from browser cache first, then refresh visible-page
  // analysis automatically so homepage verdicts match the stock preview.
  useEffect(() => {
    setExpandedTicker(null);
    setMarketPage(1);
    const visibleStocks = getMarketStocks();
    const cachedVisible = visibleStocks.reduce((acc, stock) => {
      const cached = getCache(`analysis:${stock.ticker}`);
      if (cached) acc[stock.ticker] = cached;
      return acc;
    }, {} as Record<string, any>);

    if (Object.keys(cachedVisible).length > 0) {
      setPrefetchCache(prev => ({ ...cachedVisible, ...prev }));
    }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMarket]);

  useEffect(() => {
    const syncAssetColumns = () => {
      const width = window.innerWidth;
      if (width >= 1280) setAssetColumnCount(6);
      else if (width >= 1024) setAssetColumnCount(5);
      else if (width >= 768) setAssetColumnCount(4);
      else if (width >= 640) setAssetColumnCount(3);
      else setAssetColumnCount(2);
    };

    syncAssetColumns();
    window.addEventListener('resize', syncAssetColumns);
    return () => window.removeEventListener('resize', syncAssetColumns);
  }, []);

  const dashboardAnalysisView = getAnalysisPresentation(analysis);
  const isBull = dashboardAnalysisView?.isBullish;
  const isHold = dashboardAnalysisView?.isHold;
  const accentColor = isBull ? 'text-green-400 drop-shadow-[0_0_15px_rgba(74,222,128,0.5)]' : isHold ? 'text-zinc-300' : 'text-red-500 drop-shadow-[0_0_15px_rgba(239,68,68,0.5)]';
  const previewStock = !ticker && expandedTicker ? STOCKS.find(stock => stock.ticker === expandedTicker) ?? null : null;
  const filteredIndicators = INDICATOR_NAMES.filter(name =>
    name.toLowerCase().includes(indicatorQuery.trim().toLowerCase())
  );
  const toggleIndicator = (name: string) => {
    setActiveIndicators(current =>
      current.includes(name)
        ? current.filter(item => item !== name)
        : [...current, name]
    );
  };

  return (
    <>
      <style dangerouslySetInnerHTML={{__html: `
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        @keyframes marquee { 0% { transform: translateX(0%); } 100% { transform: translateX(-100%); } }
        .animate-marquee { animation: marquee 35s linear infinite; }
        @keyframes dataDrift { 0% { transform: translate3d(0, 0, 0); } 50% { transform: translate3d(14px, -10px, 0); } 100% { transform: translate3d(0, 0, 0); } }
        @keyframes scanLine { 0% { transform: translateX(-30%); opacity: 0; } 18%, 72% { opacity: 0.55; } 100% { transform: translateX(130%); opacity: 0; } }
        .brand-mark {
          box-shadow: 0 16px 40px rgba(8,145,178,0.22), inset 0 1px 0 rgba(255,255,255,0.9);
        }
        .market-visual {
          background-image:
            linear-gradient(120deg, rgba(6,182,212,0.13), transparent 28%, rgba(16,185,129,0.10) 62%, transparent),
            linear-gradient(rgba(8,145,178,0.08) 1px, transparent 1px),
            linear-gradient(90deg, rgba(8,145,178,0.08) 1px, transparent 1px);
          background-size: 42px 42px;
          mask-image: linear-gradient(to bottom, black 0%, transparent 76%);
        }
        .market-card-float {
          animation: dataDrift 8s ease-in-out infinite;
        }
        .market-scan {
          animation: scanLine 6s ease-in-out infinite;
        }
        .disclaimer-panel {
          background: linear-gradient(135deg, rgba(255,251,235,0.98), rgba(254,243,199,0.92)) !important;
          border-color: rgba(217,119,6,0.34) !important;
          box-shadow: 0 16px 42px rgba(146,64,14,0.10);
        }
        .disclaimer-panel, .disclaimer-panel * {
          color: #78350f !important;
        }
        .force-light-text {
          color: #ffffff !important;
        }
        .stock-view-toggle-active {
          color: #000000 !important;
          background: #ff4fa3 !important;
          border-color: #ff4fa3 !important;
          box-shadow: 0 12px 28px rgba(255, 79, 163, 0.22);
        }
        .stock-view-toggle-idle {
          color: #c6c6cd !important;
          background: rgba(255, 255, 255, 0.04) !important;
          border-color: rgba(255, 255, 255, 0.12) !important;
        }
        .stock-view-toggle-idle:hover {
          background: rgba(255, 255, 255, 0.07) !important;
          border-color: rgba(255, 79, 163, 0.4) !important;
        }
        /* Active chart range button: preserve white text in light mode */
        .chart-range-btn-active { color: #ffffff !important; }
        /* About description truncation with fade */
        .about-truncated {
          max-height: 88px;
          overflow: hidden;
          -webkit-mask-image: linear-gradient(to bottom, black 45%, transparent 100%);
          mask-image: linear-gradient(to bottom, black 45%, transparent 100%);
        }
        /* Metric card hover lift */
        .metric-card-hover { transition: transform 0.18s ease, box-shadow 0.18s ease; }
        .metric-card-hover:hover { transform: translateY(-2px); box-shadow: 0 10px 28px rgba(6,182,212,0.13); }
        /* Animated confidence bar */
        @keyframes barShimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }
        .bar-shimmer {
          background: linear-gradient(90deg, #ef4444 0%, #71717a 40%, #4ade80 80%);
          background-size: 200% 100%;
        }
        /* Verdict card glow pulse */
        @keyframes glowPulse {
          0%, 100% { box-shadow: 0 0 18px rgba(74,222,128,0.10); }
          50% { box-shadow: 0 0 32px rgba(74,222,128,0.24); }
        }
        @keyframes glowPulseRed {
          0%, 100% { box-shadow: 0 0 18px rgba(239,68,68,0.10); }
          50% { box-shadow: 0 0 32px rgba(239,68,68,0.24); }
        }
        .verdict-glow-bull { animation: glowPulse 2.8s ease-in-out infinite; }
        .verdict-glow-bear { animation: glowPulseRed 2.8s ease-in-out infinite; }
        /* Chart controls pill */
        .chart-controls-pill { box-shadow: 0 2px 8px rgba(15,23,42,0.08), inset 0 1px 0 rgba(255,255,255,0.85); }
        /* Gradient top-border for highlight cards */
        .highlight-card { position: relative; overflow: hidden; }
        .highlight-card::before {
          content: '';
          position: absolute;
          top: 0; left: 0; right: 0;
          height: 2px;
          background: linear-gradient(90deg, rgba(6,182,212,0.6), rgba(16,185,129,0.4));
          opacity: 0;
          transition: opacity 0.2s ease;
        }
        .highlight-card:hover::before { opacity: 1; }
        /* Strategy score bar slightly thicker */
        .strategy-bar { height: 5px; border-radius: 999px; overflow: hidden; }
        /* Market tab active glow line */
        .market-tab-active-india::after {
          content: '';
          position: absolute;
          bottom: 0; left: 10%; right: 10%;
          height: 2px;
          background: linear-gradient(90deg, transparent, rgba(6,182,212,0.8), transparent);
          border-radius: 2px;
        }
        .market-tab-active-us::after {
          content: '';
          position: absolute;
          bottom: 0; left: 10%; right: 10%;
          height: 2px;
          background: linear-gradient(90deg, transparent, rgba(217,70,239,0.8), transparent);
          border-radius: 2px;
        }
        /* Hover glow on strategy rows */
        .strategy-row:hover { background: rgba(6,182,212,0.04) !important; }
      `}} />

      {/* WELCOME — a small toast after sign-in that slides in, then away. */}
      {showWelcome && (
        <div className="nova-toast fixed left-1/2 top-5 z-[9999] font-body" role="status" aria-live="polite">
          <BullseyeMark size={28} className="ml-1 text-white" />
          <div className="leading-tight">
            <div className="text-[14px] font-medium text-white">Welcome back, {welcomeName}</div>
            <div className="text-[12.5px] text-[#9f99c2]">You&apos;re signed in.</div>
          </div>
        </div>
      )}

      {/* Transparent on the homepage: the fixed 3D scene paints the ground
          there and sits beneath this (raised) page layer. */}
      <div className={`min-h-screen overflow-x-clip ${ticker ? 'bg-[#04070f]' : 'bg-transparent'} text-slate-100 selection:bg-cyan-500/20 selection:text-cyan-100 flex flex-col font-body`}>

        {/* IMMERSIVE BACKGROUND — View 2 keeps the Market Globe; View 1's
            background is owned by the Nova scroll scene (its own fixed layer). */}
        {ticker && <div aria-hidden className="sx-backdrop" />}

        {/* FIXED INDEX TAPE — pinned to the very top of the homepage so live
            index levels are visible the moment the page loads and stay there. */}
        {!ticker && (
          // The background stays inline rather than a `bg-black` utility: the
          // `.bullseye-night` scope retints `bg-black*` to translucent glass,
          // which is wrong for the tape — it needs a near-solid bar so the live
          // index levels stay legible over whatever scrolls beneath it.
          <div
            className="bullseye-night fixed inset-x-0 top-0 z-[60] border-b border-hairline py-2.5 backdrop-blur-xl"
            style={{ background: 'rgba(4,6,5,0.92)' }}
          >
            <IndexTickerTape />
          </div>
        )}


        {/* NAV */}
        <nav className={`relative z-20 mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-3 px-5 py-6 sm:px-8 lg:flex-nowrap lg:gap-8 ${!ticker ? 'mt-12' : ''}`}>
          <button
            type="button"
            onClick={goHome}
            className="flex shrink-0 items-center text-left"
            aria-label="Bullseye home"
          >
            <BullseyeLogo size={26} wordClassName="text-[20px]" />
          </button>

          <div className="relative order-last w-full min-w-0 lg:order-none lg:w-auto lg:max-w-[420px] lg:flex-1">
            <NovaSearch>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onFocus={() => input.length > 0 && setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                onKeyDown={(e) => { if (e.key === 'Enter' && suggestions.length > 0) selectStock(suggestions[0]); }}
                aria-label="Search any stock"
                placeholder="Search any stock…"
              />
            </NovaSearch>
            {suggestionsPresence.mounted && (
              <div data-lenis-prevent data-state={suggestionsPresence.state} className="anim-pop nova-modal absolute z-50 mt-2 max-h-[72vh] w-full min-w-[min(82vw,320px)] overflow-y-auto overflow-x-hidden rounded-2xl p-1.5 sm:min-w-full">
                {suggestions.map((stock) => (
                  <div key={stock.ticker} onMouseDown={() => selectStock(stock)} className="group grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-white/[0.07] sm:px-4">
                    <span className="min-w-0 truncate font-body text-[14px] text-[#e9e5ff] group-hover:text-white" title={stock.name}>{stock.name}</span>
                    <div className="flex min-w-0 max-w-[92px] shrink-0 items-center justify-end gap-1.5 sm:max-w-[140px] sm:gap-2">
                      <span className="rounded bg-white/5 px-1.5 py-0.5 font-numeric text-[8px] uppercase text-zinc-500 sm:px-2 sm:text-[9px]">{stock.exchange}</span>
                      <span className="min-w-0 truncate font-numeric text-[12px] text-[#ff79c0]" title={stock.symbol}>{stock.symbol}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <Link
            href="/ask-ai"
            onClick={() => setShowProfileMenu(false)}
            className="ml-auto inline-flex shrink-0 items-center font-body text-[13px] font-medium text-paper-muted transition duration-300 hover:text-paper"
          >
            Ask AI
          </Link>

          <Link
            href="/screens"
            onClick={() => setShowProfileMenu(false)}
            className="nova-btn nova-btn-primary shrink-0 !h-11 !px-5 !text-[13px]"
          >
            Screener
          </Link>

          {/* Account menu */}
          <div ref={accountMenuRef} className="relative shrink-0">
            <button
              type="button"
              onClick={() => setShowProfileMenu(prev => !prev)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setShowProfileMenu(prev => !prev);
                }
              }}
              className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-full border border-white/15 bg-white/[0.06] text-[15px] font-semibold uppercase text-white transition-all hover:border-white/30 hover:bg-white/[0.1]"
              title={user ? 'Open user dashboard' : 'Open account menu'}
              aria-label={user ? 'Open user dashboard' : 'Open account menu'}
              aria-expanded={showProfileMenu}
            >
              {user?.user_metadata?.avatar_url ? (
                <img src={user.user_metadata.avatar_url} alt="avatar" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
              ) : user ? (
                (user.user_metadata?.full_name || user.email || 'U').slice(0, 1)
              ) : (
                <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M20 21a8 8 0 0 0-16 0" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path d="M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z" stroke="currentColor" strokeWidth="2" />
                </svg>
              )}
            </button>

            {profilePresence.mounted && (
              <div
                data-lenis-prevent
                data-state={profilePresence.state}
                className="anim-pop nova-auth absolute right-0 top-full z-50 mt-3 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl p-1.5 font-body"
              >
                {authReady && user ? (
                  <>
                    <div className="flex items-center gap-3 px-3 pb-3 pt-2.5">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-white/[0.08] text-[15px] font-semibold uppercase text-white">
                        {user.user_metadata?.avatar_url ? (
                          <img src={user.user_metadata.avatar_url} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
                        ) : (
                          (user.user_metadata?.full_name || user.email || 'U').slice(0, 1)
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-[14px] font-medium text-white">{user.user_metadata?.full_name || 'Signed in'}</div>
                        <div className="truncate text-[12.5px] text-[#9f99c2]">{user.email}</div>
                      </div>
                    </div>
                    <div className="mx-1.5 h-px bg-white/[0.07]" />
                    <button
                      type="button"
                      onClick={() => {
                        setShowProfileMenu(false);
                        setShowNotificationSettings(true);
                      }}
                      className="mt-1.5 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] text-[#e9e5ff] transition hover:bg-white/[0.06] hover:text-white"
                    >
                      <svg viewBox="0 0 20 20" className="h-4 w-4 text-[#9f99c2]" fill="none" aria-hidden><path d="M10 3a5 5 0 0 0-5 5v3l-1.5 2.5h13L15 11V8a5 5 0 0 0-5-5ZM8 16a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      Daily alerts
                    </button>
                    <Link
                      href="/screens"
                      onClick={() => setShowProfileMenu(false)}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] text-[#e9e5ff] transition hover:bg-white/[0.06] hover:text-white"
                    >
                      <svg viewBox="0 0 20 20" className="h-4 w-4 text-[#9f99c2]" fill="none" aria-hidden><path d="M3 5h14M5.5 10h9M8 15h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
                      Screener
                    </Link>
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] text-[#ff8aa0] transition hover:bg-[#ff5c7a]/10"
                    >
                      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" aria-hidden><path d="M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3M13 13.5 16.5 10 13 6.5M16.5 10H8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      Sign out
                    </button>
                  </>
                ) : !authReady && supabaseAvailable ? (
                  <div className="flex items-center gap-3 px-3 py-4 text-[13.5px] text-[#b9b4d6]">
                    <span className="nova-spinner" aria-hidden />
                    Checking your sign-in…
                  </div>
                ) : (
                  <div className="p-2">
                    <div className="px-1 text-[14px] font-medium text-white">Your Bullseye account</div>
                    <p className="mt-1 px-1 text-[13px] leading-5 text-[#9f99c2]">Sign in to save alerts and get the short list by email.</p>
                    <button
                      type="button"
                      onClick={() => { setShowProfileMenu(false); setShowAuthModal(true); }}
                      className="mt-3 h-10 w-full rounded-xl bg-white text-[14px] font-medium text-[#0f0b1f] transition hover:bg-white/90"
                    >
                      Sign in
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </nav>

        {/* MAIN */}
        <main className="relative z-10 flex-1 w-full min-w-0 max-w-[1600px] mx-auto p-3 sm:p-6 lg:p-8 flex flex-col gap-6">

          {/* ── VIEW 1: DISCOVERY HUB ── */}
          {!ticker && (
            <div className="bullseye-night animate-in fade-in duration-700 w-full flex flex-col">
              <NovaExperience
                signedIn={Boolean(user)}
                onOpenDailySignals={openDailySignalSettings}
                stockStrip={
                  <div>
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <span className="flex items-center gap-3">
                        <span className="nova-dot" aria-hidden />
                        <span className="font-numeric text-[11px] font-medium uppercase tracking-[0.3em] text-[#cfc9ea]">
                          Live scan · today&apos;s short list
                        </span>
                      </span>
                      <Link
                        href="/screens"
                        className="font-body text-[13px] font-medium text-[#ff79c0] underline-offset-4 transition hover:text-white hover:underline"
                      >
                        All screens →
                      </Link>
                    </div>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                      {visibleMarketStocks.slice(0, 6).map(s => (
                        <MarketAssetCard
                          key={s.ticker}
                          stock={s}
                          prefetchedAnalysis={prefetchCache[s.ticker]}
                          quickQuote={visibleQuotes?.[s.ticker]}
                          onPreview={openPreview}
                          onAnalysisReady={(nextTicker, nextAnalysis) =>
                            setPrefetchCache(prev => ({ ...prev, [nextTicker]: nextAnalysis }))
                          }
                        />
                      ))}
                    </div>
                  </div>
                }
              />

              <DailySignalPreviewCard
                signedIn={Boolean(user)}
                userEmail={user?.email}
                signals={dailySignalPreview}
                isSaving={notificationSaving || notificationLoading}
                error={notificationError}
                message={notificationMessage}
                onOpenSettings={openDailySignalSettings}
                onSendNow={deliveryMode => { void sendNotificationEmailNow(deliveryMode); }}
              />

              <AboutSection />

              <SiteFooter />
            </div>
          )}

          {/* ── VIEW 2: STOCK DASHBOARD ── */}
          {ticker && (
            <div className="sx bullseye-night mx-auto flex w-full min-w-0 max-w-[1320px] flex-col gap-5">

              {/* Header */}
              <StockHeader
                ticker={ticker}
                name={selectedStock?.name}
                exchange={selectedStock?.exchange}
                currency={currency}
                price={quote?.price ?? null}
                changePercent={quote?.change_percent ?? null}
                view={dashboardView === 'details' ? 'details' : 'overview'}
                canShowFinancials={Boolean(canOpenDetailedAnalysis)}
                onBack={goHome}
                onOverview={openOverview}
                onFinancials={openDetailedAnalysis}
              />

              {/* Chart + fundamentals snapshot — shown in Overview only. The
                  Financials tab renders its own ratios and statement tables, so
                  these boxes would otherwise duplicate there. */}
              {dashboardView === 'overview' && (
              <div className="flex flex-col gap-5">
                <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
                  <div className="flex min-w-0 flex-col gap-5">
                    {/* Price chart */}
                    <section className="sx-card min-w-0 p-4 sm:p-5">
                      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2.5">
                          <span className="sx-live" aria-hidden />
                          <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-paper">Price chart</h2>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="sx-seg sx-seg-sm" role="tablist" aria-label="Chart range">
                            {([
                              ['1d', '1D'],
                              ['1w', '1W'],
                              ['1mo', '1M'],
                              ['1y', '1Y'],
                              ['max', 'All'],
                            ] as Array<[ChartRange, string]>).map(([range, label]) => (
                              <button
                                key={range}
                                type="button"
                                role="tab"
                                aria-selected={chartRange === range}
                                onClick={() => setChartRange(range)}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                          <div className="relative">
                            <button
                              type="button"
                              onClick={() => setShowIndicatorMenu(value => !value)}
                              aria-expanded={showIndicatorMenu}
                              className="sx-btn-ghost"
                            >
                              <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
                                <path d="M3 14l4-5 3 3 5-7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                              Indicators
                              {activeIndicators.length > 0 && <span className="sx-count">{activeIndicators.length}</span>}
                            </button>
                            {indicatorPresence.mounted && (
                              <>
                                {showIndicatorMenu && <div className="fixed inset-0 z-40" onClick={() => setShowIndicatorMenu(false)} />}
                                <div data-lenis-prevent data-state={indicatorPresence.state} className="anim-pop sx-menu">
                                  <div className="flex items-center justify-between px-4 pb-2 pt-4">
                                    <div className="text-[15px] font-semibold text-paper">Indicators</div>
                                    <button
                                      type="button"
                                      onClick={() => setShowIndicatorMenu(false)}
                                      className="flex h-8 w-8 items-center justify-center rounded-lg text-[#9f99c2] transition hover:bg-white/[0.06] hover:text-white"
                                      aria-label="Close indicators"
                                    >
                                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                                        <path d="M18 6 6 18M6 6l12 12" />
                                      </svg>
                                    </button>
                                  </div>
                                  <div className="px-4 pb-3">
                                    <input
                                      value={indicatorQuery}
                                      onChange={event => setIndicatorQuery(event.target.value)}
                                      placeholder="Search indicators"
                                      className="nova-field"
                                    />
                                  </div>
                                  <div className="max-h-[min(55vh,380px)] overflow-y-auto border-t border-white/[0.06] p-1.5">
                                    {filteredIndicators.map(name => {
                                      const selected = activeIndicators.includes(name);
                                      return (
                                        <button
                                          key={name}
                                          type="button"
                                          onClick={() => toggleIndicator(name)}
                                          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] transition-colors ${
                                            selected ? 'bg-white/[0.07] text-white' : 'text-[#c9c3e6] hover:bg-white/[0.04] hover:text-white'
                                          }`}
                                        >
                                          <span className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md border ${
                                            selected ? 'border-[#ff4fa3] bg-[#ff4fa3] text-[#14051a]' : 'border-white/20'
                                          }`}>
                                            {selected ? (
                                              <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" aria-hidden>
                                                <path d="M2.5 6.2 5 8.5l4.5-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                                              </svg>
                                            ) : null}
                                          </span>
                                          <span>{name}</span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              </>
                            )}
                          </div>
                        </div>
                      </div>

                      {chartError && !chartData ? (
                        <div className="sx-empty h-[320px] sm:h-[420px]">
                          <div className="text-[15px] font-semibold text-paper">Chart unavailable</div>
                          <div className="mt-1 max-w-[46ch] text-[13px] text-[#9f99c2]">{chartError.message || 'The chart service returned an error. Try again in a moment.'}</div>
                        </div>
                      ) : !chartData ? (
                        <div className="sx-empty h-[320px] sm:h-[420px]">
                          <span className="nova-spinner" aria-hidden />
                          <div className="mt-3 text-[13px] text-[#9f99c2]">Loading price history…</div>
                        </div>
                      ) : !chartRowsAvailable ? (
                        <div className="sx-empty h-[320px] sm:h-[420px]">
                          <div className="text-[15px] font-semibold text-paper">No chart data yet</div>
                          <div className="mt-1 text-[13px] text-[#9f99c2]">The data service didn&apos;t return candles for this symbol. Refresh in a moment.</div>
                        </div>
                      ) : (
                        <div className="w-full overflow-hidden rounded-2xl" style={{ background: 'rgba(7,5,20,0.45)' }}>
                          <div ref={chartRef} className="h-[340px] w-full overflow-hidden sm:h-[440px]" />
                          {indicatorPanels.length > 0 && (
                            <div className="border-t border-white/[0.06]">
                              {indicatorPanels.map(panel => (
                                <IndicatorChartPane
                                  key={panel.name}
                                  panel={panel}
                                  onRemove={toggleIndicator}
                                  setPaneRef={(name, element) => {
                                    indicatorPaneRefs.current[name] = element;
                                  }}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                      {indicatorPanels.length === 0 && chartRowsAvailable && (
                        <p className="mt-3 text-[12.5px] text-[#8f89ad]">Add an indicator to open a study pane under the chart.</p>
                      )}
                    </section>

                    <FundamentalsSnapshotCard
                      stock={selectedStock}
                      currency={currency}
                      fundamentals={fundamentals}
                      quote={quote}
                      isLoading={fundamentalsLoading}
                    />
                  </div>

                  <div className="xl:sticky xl:top-6">
                    <VerdictPanel
                      analysis={analysis}
                      currency={currency}
                      price={quote?.price ?? null}
                      low52={fundamentals?.summary?.low_52_week ?? null}
                      high52={fundamentals?.summary?.high_52_week ?? null}
                    />
                  </div>
                </div>

                {/* How past calls on this stock resolved, and how it sits against
                    its sector: both answer "compared to what?". */}
                <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
                  <TrackRecord symbol={selectedStock?.symbol ?? ticker} currency={currency} />
                  <PeerComparison ticker={ticker} />
                </div>
              </div>
              )}

              {/* FISO Analysis + all sections in order */}
              {dashboardView === 'details' && selectedStock && canOpenDetailedAnalysis ? (
                <Financials
                  ticker={ticker}
                  stock={selectedStock}
                  currency={currency}
                  fundamentals={fundamentals}
                  isLoading={fundamentalsLoading && !fundamentals}
                />
              ) : analysis && !analysis.error ? (
                <FisoDetailPanel
                  analysis={analysis}
                  currency={currency}
                  ticker={ticker}
                  chartData={chartData}
                />
              ) : !analysis && (
                <div className="flex items-center justify-center py-16">
                  <div className="flex flex-col items-center gap-4">
                    <div className="w-10 h-10 border-2 border-zinc-700 border-t-cyan-400 rounded-full animate-spin"></div>
                    <span className="text-xs text-zinc-500 font-numeric uppercase tracking-widest animate-pulse">Running FISO Algorithm...</span>
                  </div>
                </div>
              )}

              {/* ── DISCLAIMER ── shown after every analysis */}
              {((dashboardView === 'overview' && analysis && !analysis.error) || dashboardView === 'details') && (
                <aside className="sx-card flex gap-3 p-5">
                  <svg viewBox="0 0 20 20" fill="none" className="mt-0.5 h-5 w-5 shrink-0 text-[#ffb547]" aria-hidden>
                    <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.6" />
                    <path d="M10 6v5M10 13.5v.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                  <p className="text-[13px] leading-6 text-[#b9b4d6]">
                    <span className="font-semibold text-paper">Disclaimer. </span>
                    Bullseye is a research tool, not investment advice, and is not a SEBI-registered investment adviser.
                    Signals come from statistical models and can be wrong. Invest at your own risk.
                  </p>
                </aside>
              )}

            </div>
          )}
        </main>
      </div>

      {previewStock && (
        <StockPreviewModal
          stock={previewStock}
          quickQuote={visibleQuotes?.[previewStock.ticker]}
          prefetchedAnalysis={prefetchCache[previewStock.ticker]}
          origin={previewOrigin}
          onClose={closePreview}
          onSelect={(stock) => {
            previewHistoryOpenRef.current = false;
            setExpandedTicker(null);
            selectStock(stock);
          }}
          onAnalysisReady={(nextTicker, nextAnalysis) => {
            setPrefetchCache(prev => ({ ...prev, [nextTicker]: nextAnalysis }));
          }}
        />
      )}

      {/* ── AUTH MODAL ── */}
      {!showNotificationSettings && notificationMessage && (
        <div className="fixed left-1/2 top-5 z-[85] w-[min(92vw,520px)] -translate-x-1/2 rounded-2xl border border-emerald-300/30 bg-slate-950/96 px-5 py-4 text-center shadow-[0_24px_80px_rgba(15,23,42,0.45)] backdrop-blur-xl">
          <div className="text-[10px] font-black uppercase tracking-[0.18em] text-emerald-300 font-body">
            Logged-in Alerts
          </div>
          <div className="mt-2 text-sm text-emerald-50 font-numeric">
            {notificationMessage}
          </div>
        </div>
      )}

      {user && (
        <NotificationSettingsModal
          open={showNotificationSettings}
          userEmail={user.email}
          preference={notificationPreference}
          previewSignals={dailySignalPreview}
          isSaving={notificationSaving}
          error={notificationError}
          message={notificationMessage}
          showConsent={showNotificationConsent}
          onClose={() => {
            setShowNotificationSettings(false);
            setShowNotificationConsent(false);
          }}
          onChange={patch => patchNotificationPreference(patch)}
          onSave={() => { void saveNotificationPreference(); }}
          onSendNow={deliveryMode => { void sendNotificationEmailNow(deliveryMode); }}
          onToggle={enabled => { void toggleDailySignals(enabled); }}
          onConfirmConsent={() => { void confirmEnableDailySignals(); }}
          onCancelConsent={() => setShowNotificationConsent(false)}
        />
      )}

      {/* Portaled to <body>, not rendered inline.
          `backdrop-blur` forces the browser to re-rasterise everything beneath
          the overlay on each frame. Inline, "beneath" meant the entire page —
          the live WebGL canvas, the animated index tape and every card — so
          opening sign-in visibly flickered the boxes behind it. Portaling moves
          the overlay out of that subtree, `isolation` gives it its own stacking
          context, and `translateZ(0)` promotes it to its own compositor layer so
          the blur samples a static snapshot instead of thrashing live content. */}
      {authPresence.mounted && typeof document !== 'undefined' && createPortal(
        <div
          onClick={dismissAuthModal}
          role="presentation"
          data-state={authPresence.state}
          style={{ isolation: 'isolate', transform: 'translateZ(0)' }}
          className="anim-fade nova-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div
            onClick={event => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Sign in to Bullseye"
            data-lenis-prevent
            data-state={authPresence.state}
            className="anim-dialog nova-auth w-full max-w-[380px] rounded-2xl p-7 font-body"
          >
            <div className="flex items-center justify-between">
              <BullseyeMark size={32} className="text-white" />
              <button
                onClick={dismissAuthModal}
                aria-label="Close sign-in and continue without an account"
                className="-mr-1.5 flex h-8 w-8 items-center justify-center rounded-lg text-[#9f99c2] transition hover:bg-white/[0.06] hover:text-white"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <h2 className="mt-6 text-[22px] font-semibold leading-tight tracking-[-0.02em] text-white">
              {authMode === 'signin' ? 'Sign in to Bullseye' : 'Create your account'}
            </h2>
            <p className="mt-1.5 text-[14px] leading-6 text-[#9f99c2]">
              Save alerts and get the short list by email.
            </p>

            <button
              onClick={handleGoogleSignIn}
              disabled={authLoading}
              className="mt-6 flex h-11 w-full items-center justify-center gap-2.5 rounded-xl bg-white text-[14px] font-medium text-[#111] transition hover:bg-white/90 disabled:opacity-50"
            >
              <svg className="h-[18px] w-[18px]" viewBox="0 0 24 24" aria-hidden>
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Continue with Google
            </button>

            <div className="my-5 flex items-center gap-3 text-[12px] text-[#6f6990]">
              <div className="h-px flex-1 bg-white/[0.08]" />
              or
              <div className="h-px flex-1 bg-white/[0.08]" />
            </div>

            <label className="block text-[13px] font-medium text-[#c9c3e6]" htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              type="email"
              value={authEmail}
              onChange={e => setAuthEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              className="nova-field mt-1.5"
            />
            <label className="mt-4 block text-[13px] font-medium text-[#c9c3e6]" htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              type="password"
              value={authPassword}
              onChange={e => setAuthPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleEmailAuth()}
              autoComplete={authMode === 'signin' ? 'current-password' : 'new-password'}
              className="nova-field mt-1.5"
            />

            {authError && <p className="mt-3 text-[13px] text-[#ff7a93]">{authError}</p>}
            {authSuccess && <p className="mt-3 text-[13px] text-[#6ff0b5]">{authSuccess}</p>}

            <button
              onClick={handleEmailAuth}
              disabled={authLoading}
              className="mt-5 h-11 w-full rounded-xl bg-[#ff4fa3] text-[14px] font-semibold text-[#14051a] transition hover:bg-[#ff6db3] disabled:opacity-50"
            >
              {authLoading ? 'Please wait…' : authMode === 'signin' ? 'Sign in' : 'Create account'}
            </button>

            <div className="mt-5 flex items-center justify-between text-[13px]">
              <button
                type="button"
                onClick={() => { setAuthMode(authMode === 'signin' ? 'signup' : 'signin'); setAuthError(''); setAuthSuccess(''); }}
                className="text-[#c9c3e6] transition hover:text-white"
              >
                {authMode === 'signin' ? 'Create an account' : 'I have an account'}
              </button>
              <button onClick={dismissAuthModal} className="text-[#9f99c2] transition hover:text-white">
                Continue without signing in
              </button>
            </div>

            <p className="mt-6 border-t border-white/[0.06] pt-4 text-[11.5px] leading-5 text-[#6f6990]">
              Bullseye is research, not investment advice, and is not a SEBI-registered adviser.
            </p>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

export default function Home() {
  return (
    <Suspense fallback={null}>
      <HomeContent />
    </Suspense>
  );
}

