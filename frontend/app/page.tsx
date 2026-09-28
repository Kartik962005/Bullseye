'use client';
import { Suspense, useState, useEffect, useRef, useMemo, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { usePathname, useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import { STOCKS } from './stocks';
import {
  DailySignalPreviewCard,
} from '@/components/home';
import { NovaExperience } from '@/components/home/nova/NovaExperience';
import { NovaSearch } from '@/components/home/NovaSearch';
import { BullseyeLogo } from '@/components/brand/BullseyeLogo';
import { TrackRecord } from '@/components/stock/TrackRecord';
import { PeerComparison } from '@/components/stock/PeerComparison';
import { RangeBar } from '@/components/stock/RangeBar';
import { AboutSection } from '@/components/home/AboutSection';
import { LiveScanSection } from '@/components/home/LiveScanSection';
import { SiteFooter } from '@/components/home/SiteFooter';
import { HomeAmbientBackground } from '@/components/home/HomeAmbientBackground';

import { BACKEND, fetcher, getCache, setCache } from '@/lib/client-cache';
import {
  toFiniteNumber,
  getAnalysisPresentation,
  getChartCandles,
} from '@/lib/analysis';
import { getSharedSupabaseClient } from '@/lib/supabase-browser';
import {
  formatIndianNumber,
  formatCurrencyNumber,
  formatCompactRupees,
  formatMarketCap,
  formatRatioValue,
  humanizeLabel,
  getLevenshteinDistance,
} from '@/lib/format';
import { buildMarketNewsRead, type NewsStory } from '@/lib/news';
import {
  type MarketScope,
  resolveMarket,
  canShowDetailedAnalysis,
  formatFaceValue,
} from '@/lib/stock';
import {
  type IndicatorPanelData,
  buildIndicatorPanel,
  buildSvgPath,
  buildPreviewChartPath,
} from '@/lib/chart';
import { buildMarketAnswer } from '@/lib/market-answer';
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
  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-md" onClick={onClose} />
      <div className="fixed inset-0 z-[71] flex items-start justify-center overflow-y-auto p-3 sm:items-center sm:p-4">
        <div
          className="my-4 max-h-[calc(100vh-2rem)] w-full max-w-3xl overflow-y-auto rounded-[24px] border border-hairline font-body text-paper"
          style={{
            background:
              'linear-gradient(145deg, rgba(20,22,19,0.97) 0%, rgba(8,10,9,0.99) 55%, rgba(16,18,15,0.97) 100%)',
            boxShadow: '0 40px 110px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,79,163,0.12)',
          }}
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
          <div className="fixed inset-0 z-[72] bg-black/85 backdrop-blur-md" />
          <div className="fixed inset-0 z-[73] flex items-start justify-center overflow-y-auto p-3 sm:items-center sm:p-4">
            <div
              className="my-4 w-full max-w-lg rounded-[24px] border border-hairline p-7 font-body text-paper"
              style={{
                background:
                  'linear-gradient(145deg, rgba(20,22,19,0.97) 0%, rgba(8,10,9,0.99) 55%, rgba(16,18,15,0.97) 100%)',
                boxShadow: '0 40px 110px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,79,163,0.12)',
              }}
            >
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



const IndicatorPanel = ({ panel }: { panel: IndicatorPanelData }) => {
  const path = buildSvgPath(panel.series);
  return (
    <div className="relative border-t border-slate-200 bg-white">
      <div className="absolute left-3 top-3 z-10 flex items-center gap-2 text-xs font-bold text-slate-700 font-body">
        <span>{panel.name}</span>
        <span className="font-numeric" style={{ color: panel.color }}>{panel.latest}</span>
      </div>
      <div className="absolute right-0 top-1/2 z-10 -translate-y-1/2 rounded-l-md px-2 py-1 text-xs font-black text-white font-numeric" style={{ backgroundColor: panel.color }}>
        {panel.latest}
      </div>
      <svg viewBox="0 0 720 150" className="h-[190px] w-full" preserveAspectRatio="none" role="img" aria-label={`${panel.name} indicator chart`}>
        {Array.from({ length: 6 }, (_, index) => (
          <line key={`h-${index}`} x1="0" x2="720" y1={index * 30} y2={index * 30} stroke="rgba(15,23,42,0.06)" />
        ))}
        {Array.from({ length: 14 }, (_, index) => (
          <line key={`v-${index}`} x1={index * 55.4} x2={index * 55.4} y1="0" y2="150" stroke="rgba(15,23,42,0.05)" />
        ))}
        <path d={path} fill="none" stroke={panel.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
};

const IndicatorChartPane = ({
  panel,
  setPaneRef,
}: {
  panel: IndicatorPanelData;
  setPaneRef: (name: string, element: HTMLDivElement | null) => void;
}) => (
  <div className="relative border-t border-slate-200 bg-white">
    <div className="absolute left-3 top-3 z-10 flex items-center gap-2 text-xs font-bold text-slate-700 font-body">
      <span>{panel.name}</span>
      <span className="font-numeric" style={{ color: panel.color }}>{panel.latest}</span>
    </div>
    <div className="absolute right-0 top-1/2 z-10 -translate-y-1/2 rounded-l-md px-2 py-1 text-xs font-black text-white font-numeric" style={{ backgroundColor: panel.color }}>
      {panel.latest}
    </div>
    <div
      ref={(element) => setPaneRef(panel.name, element)}
      className="h-[190px] w-full"
      aria-label={`${panel.name} synced indicator chart`}
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
  onPreview: (stock: typeof STOCKS[0]) => void;
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
      onClick={() => onPreview(stock)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPreview(stock);
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
}: {
  stock: typeof STOCKS[0];
  quickQuote?: QuoteSnapshot;
  prefetchedAnalysis?: any;
  onClose: () => void;
  onSelect: (stock: typeof STOCKS[0]) => void;
  onAnalysisReady: (ticker: string, analysis: unknown) => void;
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
  const previewPath = buildPreviewChartPath(previewChart);
  const quickPrice = Number(quickQuote?.price);
  const quickChange = Number(quickQuote?.change_percent ?? 0);
  const isBull = analysisView?.isBullish;
  const isHold = analysisView?.isHold;
  const accentText = analysisView
    ? isBull ? 'text-green-400' : isHold ? 'text-paper-muted' : 'text-red-400'
    : 'text-cyan-500';
  const accentBg = analysisView
    ? isBull ? 'from-emerald-400 to-cyan-300' : isHold ? 'from-slate-300 to-cyan-200' : 'from-rose-400 to-orange-300'
    : 'from-cyan-300 to-sky-300';

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/80 p-5 backdrop-blur-md sm:p-6"
      onMouseDown={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${stock.name} preview`}
    >
      <div
        className="relative my-4 flex max-h-[82vh] w-[min(88vw,72rem)] flex-col overflow-y-auto rounded-[24px] border border-hairline bg-[#070a09] shadow-[0_40px_120px_rgba(0,0,0,0.7)] sm:max-h-[88vh] sm:min-h-[60vh] sm:w-full sm:rounded-[28px]"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className={`h-1.5 bg-gradient-to-r ${accentBg}`} />
        <div className="flex flex-col gap-4 p-4 sm:gap-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <button
                type="button"
                onClick={onClose}
                className="mb-4 rounded-full border border-hairline bg-white/[0.03]/[0.03] px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-paper-muted transition-colors hover:border-accent/50 hover:bg-accent/10 font-body"
              >
                Back
              </button>
              <div className="text-[10px] font-black uppercase tracking-[0.24em] text-accent font-body">{stock.symbol} · {stock.exchange}</div>
              <h2 className="mt-2 font-display text-[28px] font-normal leading-tight text-paper sm:text-[44px]">{stock.name}</h2>
              <p className="mt-3 max-w-2xl text-xs leading-6 text-paper-muted font-numeric sm:text-sm">
                Sneak peek of price action, FISO verdict, target zone, and stop-loss risk before opening the full dashboard.
              </p>
            </div>
            <div className="rounded-2xl border border-hairline bg-white/[0.03]/[0.03] p-4 text-right">
              <div className="text-[10px] font-black uppercase tracking-widest text-paper-muted font-body">Live Price</div>
              <div className="mt-1 text-2xl font-black text-paper font-numeric">
                {Number.isFinite(quickPrice) && quickPrice > 0 ? `${stock.currency}${quickPrice.toLocaleString()}` : 'Fetching'}
              </div>
              <div className={`mt-1 text-xs font-black font-numeric ${quickChange >= 0 ? 'text-primary' : 'text-rose-300'}`}>
                {quickChange >= 0 ? '+' : ''}{quickChange.toFixed(2)}%
              </div>
              <div className="mt-3 border-t border-hairline pt-2 text-[10px] font-black uppercase tracking-widest text-paper-muted">
                Face Value <span className="text-paper font-numeric">{formatFaceValue(stock)}</span>
              </div>
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-[1.35fr_0.65fr]">
            <div className="overflow-hidden rounded-2xl border border-hairline bg-white/[0.03]">
              <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
                <div className="text-xs font-black uppercase tracking-[0.2em] text-paper-muted font-body">Mini Chart</div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-paper-muted font-numeric">1M preview</div>
              </div>
              <svg viewBox="0 0 720 230" className="h-44 w-full bg-white/[0.03] sm:h-64" preserveAspectRatio="none" role="img" aria-label={`${stock.name} mini chart`}>
                {Array.from({ length: 7 }, (_, index) => (
                  <line key={`h-${index}`} x1="0" x2="720" y1={index * 38} y2={index * 38} stroke="rgba(15,23,42,0.06)" />
                ))}
                {Array.from({ length: 13 }, (_, index) => (
                  <line key={`v-${index}`} x1={index * 60} x2={index * 60} y1="0" y2="230" stroke="rgba(15,23,42,0.05)" />
                ))}
                {previewPath ? (
                  <path d={previewPath} fill="none" stroke={isBull ? '#22c55e' : isHold ? '#06b6d4' : '#ef4444'} strokeWidth="3" vectorEffect="non-scaling-stroke" />
                ) : (
                  <text x="360" y="118" textAnchor="middle" className="fill-[#c6c6cd] text-xs font-bold uppercase tracking-widest">Loading chart</text>
                )}
              </svg>
            </div>

            <div className="grid gap-3">
              {analysisView ? (
                <>
                  <div className="rounded-2xl border border-hairline bg-black/40 p-4">
                    <div className="text-[10px] font-black uppercase tracking-widest text-paper-muted font-body">Verdict</div>
                    <div className={`mt-2 text-3xl font-black uppercase tracking-widest ${accentText} font-body`}>{analysisView.displayVerdict}</div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/[0.03]/10">
                      <div className={`h-full rounded-full bg-gradient-to-r ${accentBg}`} style={{ width: `${analysisView.confidenceLevel}%` }} />
                    </div>
                    <div className="mt-2 text-xs font-black text-paper font-numeric">{analysisView.confidenceLevel}/100 FISO confidence</div>
                  </div>
                  {isHold ? (
                    <div className="rounded-2xl border border-hairline bg-white/[0.03]/[0.03] p-4">
                      <div className="text-[10px] font-black uppercase tracking-widest text-paper-muted">No Active Trade</div>
                      <div className="mt-2 text-sm font-black text-slate-700 font-body">Target and stop are hidden until the setup becomes actionable.</div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-2xl border border-hairline bg-white/[0.03]/[0.03] p-4">
                        <div className="text-[10px] font-black uppercase tracking-widest text-paper-muted">Target</div>
                        <div className="mt-2 text-lg font-black text-primary font-numeric">{stock.currency}{analysisView.target}</div>
                      </div>
                      <div className="rounded-2xl border border-hairline bg-white/[0.03]/[0.03] p-4">
                        <div className="text-[10px] font-black uppercase tracking-widest text-paper-muted">Stop Loss</div>
                        <div className="mt-2 text-lg font-black text-rose-300 font-numeric">{stock.currency}{analysisView.stop_loss}</div>
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex min-h-52 items-center justify-center rounded-2xl border border-hairline bg-white/[0.03]/[0.03]">
                  <div className="flex flex-col items-center gap-3">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-hairline border-t-cyan-500" />
                    <div className="text-[10px] font-black uppercase tracking-widest text-paper-muted font-numeric">Running analysis</div>
                  </div>
                </div>
              )}
              <a
                href={`/?ticker=${encodeURIComponent(stock.ticker)}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelect(stock);
                }}
                className="rounded-2xl border border-cyan-200 bg-cyan-50 px-5 py-4 text-xs font-black uppercase tracking-[0.2em] text-paper transition-colors hover:bg-cyan-100 font-body"
              >
                Open Full Analysis →
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── DETAILED FISO PANEL ──────────────────────────────────────────────────────
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
}) => {
  const analysisView = getAnalysisPresentation(analysis);
  if (!analysisView) return null;

  const isBull = analysisView.isBullish;
  const isHold = analysisView.isHold;
  const accentColor = isBull ? 'text-green-400' : isHold ? 'text-zinc-300' : 'text-red-400';
  const accentBg = isBull ? 'bg-green-500/10 border-green-500/30' : isHold ? 'bg-zinc-500/10 border-zinc-500/30' : 'bg-red-500/10 border-red-500/30';
  const targetMovePctValue = analysisView.entry
    ? (analysisView.direction === 'bearish'
      ? ((analysisView.entry - analysisView.target) / analysisView.entry) * 100
      : ((analysisView.target - analysisView.entry) / analysisView.entry) * 100)
    : 0;
  const stopRiskPctValue = analysisView.entry
    ? (analysisView.direction === 'bearish'
      ? ((analysisView.stop_loss - analysisView.entry) / analysisView.entry) * 100
      : ((analysisView.entry - analysisView.stop_loss) / analysisView.entry) * 100)
    : 0;
  const targetMovePct = targetMovePctValue.toFixed(2);
  const stopRiskPct = stopRiskPctValue.toFixed(2);
  const rr = (stopRiskPctValue > 0 ? targetMovePctValue / stopRiskPctValue : 0).toFixed(2);
  const setupLabel = analysisView.direction === 'bearish'
    ? 'Sell-side target'
    : analysisView.direction === 'bullish'
      ? 'Buy-side target'
      : 'Balanced setup';
  const stockMeta = STOCKS.find(stock => stock.ticker === ticker);

  // AI search state (lifted into FisoDetailPanel so it lives next to the section)
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiResult, setAiResult] = useState<any>(null);
  const [isAiRunning, setIsAiRunning] = useState(false);
  const [aiLoaderSummary, setAiLoaderSummary] = useState('');

  const handleAiSearch = async () => {
    if (!aiPrompt || !ticker) return;
    setIsAiRunning(true);
    setAiResult(null);
    setAiLoaderSummary(`Compiling your request for ${ticker} and reading local OHLCV history...`);
    try {
      const prompt = aiPrompt.trim();
      const res = await fetch(`${BACKEND}/api/v1/stock-ai/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          current_ticker: ticker,
          stocks: STOCKS.map(stock => ({
            name: stock.name,
            symbol: stock.symbol,
            exchange: stock.exchange,
            ticker: stock.ticker,
            currency: stock.currency,
          })),
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setAiResult({
          type: 'assistant_answer',
          title: 'AI search needs a clearer request',
          answer: data?.detail || 'The stock AI engine could not answer that yet. Try a specific date, quantity, indicator, or buy/sell rule.',
          rows: [
            ['Try', 'Buy Friday close, sell Monday open'],
            ['Try', 'If I bought 100 shares 30 days ago'],
            ['Try', 'Current RSI and support resistance'],
          ],
        });
        return;
      }
      setAiLoaderSummary(data.ai_context_summary || `Running local analytics for ${data.target_stock || ticker}...`);
      setAiResult(data);
    } catch {
      const fallback = buildMarketAnswer('help examples', analysis, ticker, currency, chartData);
      setAiResult(fallback ?? {
        type: 'assistant_answer',
        title: 'AI search fallback',
        answer: 'I could not reach the stock AI engine. The backend may be starting up, or the model/data service may be unavailable.',
        rows: [
          ['Try', 'current price'],
          ['Try', 'support and resistance'],
          ['Try', 'buy Friday close sell Monday open'],
        ],
      });
    } finally {
      setIsAiRunning(false);
    }
  };

  // ── Enter key handler for AI search input
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && aiPrompt.trim() && !isAiRunning) {
      handleAiSearch();
    }
  };

  const aiExamples = [
    'Buy when stock drops 1% intraday, sell at 3% profit',
    'Buy Friday close, sell Monday open',
    'If I bought 100 shares 30 days ago, profit or loss?',
    'What was the price on 15 Oct 2024?',
    'Current RSI and overbought status',
    'SMA 50, EMA 20, support and resistance',
  ];

  const visibleStockStories: NewsStory[] = [];

  return (
    <div className="flex flex-col gap-6">

      {/* ── Row 1: Verdict rationale ── the headline numbers (verdict, entry,
          target, stop, confidence, R:R) live in the hero card at the top of the
          Overview, so this section carries the *reasoning* instead of repeating
          them: the trade-setup framing plus either the no-trade gate notes or
          the projected move context. */}
      <div
        className="rounded-[22px] border border-hairline p-6 sm:p-7"
        style={{
          background:
            'linear-gradient(145deg, rgba(18,20,17,0.9) 0%, rgba(7,9,8,0.95) 55%, rgba(14,16,13,0.9) 100%)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
        }}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-5">
          <div className="min-w-0">
            <span className="font-body text-[10px] font-medium uppercase tracking-[0.24em] text-accent">
              Trade setup
            </span>
            <div className="mt-2.5 font-display text-[clamp(1.6rem,3vw,2.1rem)] leading-none text-paper">
              {setupLabel}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {([
              ['Sell', analysisView.direction === 'bearish', 'text-rose-300 border-rose-300/40 bg-rose-500/10'],
              ['Hold', isHold, 'text-accent border-accent/45 bg-accent/10'],
              ['Buy', analysisView.direction === 'bullish', 'text-primary border-primary/45 bg-primary/10'],
            ] as Array<[string, boolean, string]>).map(([label, active, activeCls]) => (
              <span
                key={label}
                className={`inline-flex h-8 items-center rounded-full border px-4 font-body text-[10px] font-semibold uppercase tracking-[0.18em] transition ${
                  active ? activeCls : 'border-hairline text-paper-muted/60'
                }`}
              >
                {label}
              </span>
            ))}
          </div>
        </div>

        <p className="mt-4 max-w-[72ch] font-body text-[13px] leading-7 text-paper-muted">
          {isHold
            ? 'No active trade is issued. The price bands shown above are for research context only — Bullseye withholds a target and stop until the setup clears its risk, reward, and data-quality gates.'
            : 'The entry, target, and stop shown above are aligned with the displayed verdict. Projected move and per-unit risk are broken out below.'}
        </p>

        {isHold ? (
          <div className="mt-6 border-t border-hairline pt-6">
            <span className="font-body text-[10px] font-medium uppercase tracking-[0.22em] text-accent">
              Why no trade
            </span>
            <ul className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
              {(analysisView.risk_notes?.length ? analysisView.risk_notes : ['Risk/reward and confidence gates did not clear.'])
                .slice(0, 4)
                .map((note: string) => (
                  <li key={note} className="flex gap-3 font-body text-[13px] leading-6 text-paper-muted">
                    <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                    <span>{note}</span>
                  </li>
                ))}
            </ul>
          </div>
        ) : (
          <div className="mt-6 grid gap-x-12 gap-y-5 border-t border-hairline pt-6 sm:grid-cols-3">
            {([
              ['Projected move', `${targetMovePct}%`, analysisView.direction === 'bearish' ? 'downside target' : 'upside target'],
              ['Stop risk', `${stopRiskPct}%`, analysisView.direction === 'bearish' ? 'upside exposure' : 'downside exposure'],
              ['Reward : risk', `1 : ${rr}`, 'per unit of risk'],
            ] as Array<[string, string, string]>).map(([label, value, sub]) => (
              <div key={label}>
                <div className="font-body text-[10px] font-medium uppercase tracking-[0.22em] text-paper-muted">
                  {label}
                </div>
                <div className="mt-1.5 font-numeric text-xl leading-none text-paper">{value}</div>
                <div className="mt-1.5 font-body text-[11px] text-paper-muted/70">{sub}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Row 2: Trade Timeline + Position Snapshot ── */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <div
          className="lg:col-span-8 rounded-[22px] border border-hairline p-6 sm:p-7"
          style={{
            background:
              'linear-gradient(145deg, rgba(18,20,17,0.9) 0%, rgba(7,9,8,0.95) 55%, rgba(14,16,13,0.9) 100%)',
            boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
          }}
        >
          <span className="font-body text-[10px] font-medium uppercase tracking-[0.24em] text-accent">
            {isHold ? 'Trade status' : 'Trade timeline'}
          </span>
          {isHold ? (
            <div className="mt-5 flex items-start gap-4 rounded-2xl border border-hairline bg-white/[0.02] p-5">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-accent/40 bg-accent/10 font-numeric text-sm text-accent">H</div>
              <div>
                <div className="font-display text-lg text-paper">No trade planned</div>
                <p className="mt-2 max-w-2xl font-body text-[12px] leading-6 text-paper-muted">
                  Bullseye is not issuing a target, stop loss, expected move, or holding period because this stock did not pass the current trade-quality gates.
                </p>
              </div>
            </div>
          ) : (
            <div className="mt-5 flex flex-col">
              {([
                ['T', 'Target date', analysis.target_date, `${analysis.estimated_days}d`, 'text-primary', 'border-primary/40 bg-primary/10 text-primary'],
                ['↗', 'Expected move', 'From current price', `${analysisView.direction === 'bearish' ? '-' : '+'}${targetMovePct}%`, analysisView.direction === 'bearish' ? 'text-rose-300' : 'text-primary', 'border-hairline bg-white/[0.03] text-paper-muted'],
                ['◇', 'Max risk', 'If stop loss triggered', `${stopRiskPct}%`, 'text-rose-300', 'border-hairline bg-white/[0.03] text-paper-muted'],
              ] as Array<[string, string, string, string, string, string]>).map(([icon, label, sub, value, valueTone, iconCls], i, arr) => (
                <div key={label} className={`flex items-center justify-between py-3.5 ${i < arr.length - 1 ? 'border-b border-hairline' : ''}`}>
                  <div className="flex items-center gap-3.5">
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border font-numeric text-xs ${iconCls}`}>{icon}</div>
                    <div className="min-w-0">
                      <span className="block font-body text-[13px] text-paper">{label}</span>
                      <span className="font-body text-[11px] text-paper-muted">{sub}</span>
                    </div>
                  </div>
                  <span className={`font-numeric text-sm ${valueTone}`}>{value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div
          className="lg:col-span-4 rounded-[22px] border border-hairline p-6 sm:p-7"
          style={{
            background:
              'linear-gradient(145deg, rgba(18,20,17,0.9) 0%, rgba(7,9,8,0.95) 55%, rgba(14,16,13,0.9) 100%)',
            boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
          }}
        >
          <span className="font-body text-[10px] font-medium uppercase tracking-[0.24em] text-accent">Position snapshot</span>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-hairline bg-white/[0.02] p-4">
              <span className="mb-2 block font-body text-[9px] uppercase tracking-[0.2em] text-paper-muted">Setup</span>
              <span className={`font-display text-lg ${isBull ? 'text-primary' : isHold ? 'text-paper' : 'text-rose-300'}`}>{analysisView.displayVerdict}</span>
            </div>
            <div className="rounded-2xl border border-hairline bg-white/[0.02] p-4">
              <span className="mb-2 block font-body text-[9px] uppercase tracking-[0.2em] text-paper-muted">{isHold ? 'Trade state' : 'Reward : risk'}</span>
              <span className="font-numeric text-base text-paper">{isHold ? 'No trade' : `1 : ${rr}`}</span>
            </div>
            <div className="col-span-2 rounded-2xl border border-accent/25 bg-accent/[0.05] p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="font-body text-[9px] uppercase tracking-[0.2em] text-paper-muted">Face value</span>
                <span className="font-numeric text-sm text-paper">{formatFaceValue(stockMeta)}</span>
              </div>
            </div>
            <div className="col-span-2 rounded-2xl border border-hairline bg-white/[0.02] p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-body text-[9px] uppercase tracking-[0.2em] text-paper-muted">Confidence</span>
                <span className="font-numeric text-xs text-paper">{analysisView.confidenceLevel}/100</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-accent" style={{ width: `${analysisView.confidenceLevel}%` }} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Section 3: AI Market Search ── */}
      <div
        className="ai-market-panel relative overflow-hidden rounded-[22px] border border-accent/30 p-6 text-paper sm:p-7"
        style={{
          background:
            'linear-gradient(145deg, rgba(20,22,19,0.94) 0%, rgba(8,10,9,0.97) 55%, rgba(16,18,15,0.94) 100%)',
          boxShadow: '0 26px 70px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,79,163,0.14)',
        }}
      >
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,79,163,0.12),transparent_42%),radial-gradient(circle_at_bottom_left,rgba(52,211,153,0.08),transparent_44%)]" />
        <h3 className="relative mb-3 flex items-center gap-2 border-b border-hairline pb-4 font-body text-[10px] font-medium uppercase tracking-[0.24em] text-accent">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent"></span>
          AI market search
        </h3>
        <p className="relative mb-4 font-body text-[13px] leading-7 text-paper-muted">
          Ask prices, trend questions, risk checks, profit/loss, or any buy/sell strategy in plain English.
        </p>

        <div className="relative flex flex-col gap-3 sm:flex-row">
          <input
            value={aiPrompt}
            onChange={e => setAiPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything: buy Friday close, sell Monday open; price on 12 Feb; should I buy?"
            className="flex-1 rounded-full border border-hairline bg-black/40 px-5 py-3.5 font-body text-sm text-paper outline-none transition placeholder:text-paper-muted/60 focus:border-accent/60 focus:ring-2 focus:ring-accent/20"
          />
          <button
            onClick={handleAiSearch}
            disabled={isAiRunning || !aiPrompt.trim()}
            className="shrink-0 rounded-full bg-accent px-7 py-3.5 font-body text-xs font-semibold uppercase tracking-widest text-black transition duration-300 hover:bg-accent-dim disabled:opacity-40"
          >
            {isAiRunning ? 'Thinking…' : 'Ask AI'}
          </button>
        </div>

        <div className="relative mt-3 flex flex-wrap gap-2">
          {aiExamples.map(example => (
            <button
              key={example}
              type="button"
              onClick={() => setAiPrompt(example)}
              className="rounded-full border border-hairline bg-white/[0.03] px-3.5 py-2 font-body text-[10px] font-medium uppercase tracking-wider text-paper-muted transition hover:border-accent/50 hover:text-paper"
            >
              {example}
            </button>
          ))}
        </div>

        {/* AI loading */}
        {isAiRunning && (
          <div className="mt-4 flex items-center gap-3 py-4">
            <div className="w-5 h-5 border-2 border-zinc-700 border-t-cyan-400 rounded-full animate-spin shrink-0"></div>
            <span className="text-xs text-slate-300 font-numeric uppercase tracking-widest animate-pulse">
              {aiLoaderSummary || `Reading market data for ${ticker}...`}
            </span>
          </div>
        )}

        {/* AI results */}
        {aiResult && !isAiRunning && (
          <div className="mt-5 animate-in fade-in slide-in-from-bottom-4 duration-500">
            {aiResult.error || aiResult.custom_metrics?.error ? (
              <div className="bg-red-500/5 border border-red-500/20 rounded-2xl p-4">
                <p className="text-red-400 text-sm font-numeric">
                  {aiResult.error || aiResult.custom_metrics?.error}
                </p>
              </div>
            ) : aiResult.type === 'holding_pnl' ? (
              <div className={`${aiResult.pnl >= 0 ? 'bg-green-500/5 border-green-500/20' : 'bg-red-500/5 border-red-500/20'} border rounded-2xl p-4`}>
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-4">
                  <div>
                    <span className={`text-[10px] uppercase tracking-widest font-bold font-body ${aiResult.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {aiResult.pnl >= 0 ? 'Profit' : 'Loss'} estimate
                    </span>
                    <p className="text-sm text-zinc-400 font-numeric mt-1">
                      {aiResult.quantity.toLocaleString()} shares from {aiResult.buyDate} to {aiResult.latestDate}
                    </p>
                  </div>
                  <div className="text-left sm:text-right">
                    <div className={`text-2xl font-black font-numeric ${aiResult.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {aiResult.pnl >= 0 ? '+' : ''}{currency}{Math.abs(aiResult.pnl).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </div>
                    <div className={`text-xs font-bold font-numeric ${aiResult.returnPct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {aiResult.returnPct >= 0 ? '+' : ''}{aiResult.returnPct.toFixed(2)}%
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    ['Buy price', aiResult.buyPrice],
                    ['Current close', aiResult.currentPrice],
                    ['Invested', aiResult.invested],
                    ['Current value', aiResult.currentValue],
                  ].map(([label, value]) => (
                    <div key={label} className="bg-black/30 rounded-xl p-3 border border-white/5">
                      <span className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold block mb-1">{label}</span>
                      <span className="text-lg font-numeric font-bold text-white">
                        {currency}{Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : aiResult.type === 'historical_roi' ? (
              <div className={`${aiResult.pnl >= 0 ? 'bg-green-500/5 border-green-500/20' : 'bg-red-500/5 border-red-500/20'} border rounded-2xl p-4`}>
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-4">
                  <div>
                    <span className={`text-[10px] uppercase tracking-widest font-bold font-body ${aiResult.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      Historical ROI
                    </span>
                    <p className="text-sm text-zinc-300 font-numeric mt-1 leading-relaxed">
                      {aiResult.answer}
                    </p>
                    {!aiResult.exact_match && (
                      <p className="mt-2 text-[10px] text-amber-300 font-numeric">
                        Requested date was not a trading candle, so the nearest available candle was used.
                      </p>
                    )}
                  </div>
                  <div className="text-left sm:text-right">
                    <div className={`text-2xl font-black font-numeric ${aiResult.pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {aiResult.pnl >= 0 ? '+' : '-'}{currency}{Math.abs(Number(aiResult.pnl || 0)).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </div>
                    <div className={`text-xs font-bold font-numeric ${aiResult.return_pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {aiResult.return_pct >= 0 ? '+' : ''}{Number(aiResult.return_pct || 0).toFixed(2)}%
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    ['Quantity', aiResult.quantity],
                    ['Buy close', aiResult.buy_price],
                    ['Latest close', aiResult.current_price],
                    ['Invested', aiResult.invested],
                    ['Current value', aiResult.current_value],
                    ['Buy date', aiResult.investment_date],
                    ['Latest date', aiResult.latest_date],
                    ['Ticker', aiResult.target_stock],
                  ].map(([label, value]) => (
                    <div key={label} className="bg-black/30 rounded-xl p-3 border border-white/5">
                      <span className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold block mb-1">{label}</span>
                      <span className="text-sm font-numeric font-bold text-white break-words">
                        {typeof value === 'number'
                          ? (String(label).toLowerCase().includes('quantity') ? value.toLocaleString() : `${currency}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`)
                          : value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : aiResult.type === 'historical_price' ? (
              <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-2xl p-4">
                <div className="flex items-center justify-between gap-3 mb-4">
                  <span className="text-[10px] text-cyan-400 uppercase tracking-widest font-bold font-body">Historical Price</span>
                  <span className="text-[10px] text-zinc-500 font-numeric">{aiResult.target_stock} · {aiResult.requested_date}</span>
                </div>
                {aiResult.candle ? (
                  <>
                    <p className="mb-4 text-sm text-zinc-300 font-numeric leading-relaxed">{aiResult.answer}</p>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                      {[
                        ['Date', aiResult.candle.date],
                        ['Open', aiResult.candle.open],
                        ['High', aiResult.candle.high],
                        ['Low', aiResult.candle.low],
                        ['Close', aiResult.candle.close],
                      ].map(([label, value]) => (
                        <div key={label} className="bg-black/30 rounded-xl p-3 border border-white/5">
                          <span className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold block mb-1">{label}</span>
                          <span className="text-lg font-numeric font-bold text-white">
                            {typeof value === 'number' ? `${currency}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : value}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-zinc-300 font-numeric">No historical candle was found for this request.</p>
                )}
              </div>
            ) : aiResult.type === 'technical_analysis' ? (
              <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-2xl p-4">
                <span className="text-[10px] text-cyan-400 uppercase tracking-widest font-bold font-body">{aiResult.title}</span>
                <p className="text-sm text-zinc-300 font-numeric leading-relaxed mt-2 mb-4">{aiResult.answer}</p>
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3">
                  {(aiResult.rows ?? []).map(([label, value]: [string, any]) => (
                    <div key={label} className="bg-black/30 rounded-xl p-3 border border-white/5">
                      <span className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold block mb-1">{String(label).replaceAll('_', ' ')}</span>
                      <span className="text-sm font-numeric font-bold text-white break-words">
                        {typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : aiResult.type === 'assistant_answer' ? (
              <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-2xl p-4">
                <span className="text-[10px] text-cyan-400 uppercase tracking-widest font-bold font-body">{aiResult.title}</span>
                <p className="text-sm text-zinc-300 font-numeric leading-relaxed mt-2 mb-4">{aiResult.answer}</p>
                {aiResult.rows?.length > 0 && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                    {aiResult.rows.map(([label, value]: [string, any]) => (
                      <div key={label} className="bg-black/30 rounded-xl p-3 border border-white/5">
                        <span className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold block mb-1">{label}</span>
                        <span className="text-sm font-numeric font-bold text-white break-words">
                          {typeof value === 'number' ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : value}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : aiResult.type === 'price_lookup' ? (
              <div className="bg-cyan-500/5 border border-cyan-500/20 rounded-2xl p-4">
                {aiResult.candle ? (
                  <>
                    <div className="flex items-center justify-between gap-3 mb-4">
                      <span className="text-[10px] text-cyan-400 uppercase tracking-widest font-bold font-body">Price Lookup</span>
                      <span className="text-[10px] text-zinc-500 font-numeric">{ticker} · {aiResult.requestedDate}</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {[
                        ['Open', aiResult.candle.open],
                        ['High', aiResult.candle.high],
                        ['Low', aiResult.candle.low],
                        ['Close', aiResult.candle.close],
                      ].map(([label, value]) => (
                        <div key={label} className="bg-black/30 rounded-xl p-3 border border-white/5">
                          <span className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold block mb-1">{label}</span>
                          <span className="text-lg font-numeric font-bold text-white">
                            {currency}{Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col gap-4">
                    <p className="text-cyan-200/80 text-sm font-numeric">
                      No candle found for {ticker} on {aiResult.requestedDate}. It may be a market holiday, weekend, or outside loaded chart history.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {([
                        ['Previous trading day', aiResult.nearest?.previous],
                        ['Next trading day', aiResult.nearest?.next],
                      ] as Array<[string, any]>).map(([label, candle]) => (
                        <div key={label} className="bg-black/30 rounded-xl p-3 border border-white/5">
                          <span className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold block mb-2">{label}</span>
                          {candle ? (
                            <div className="grid grid-cols-2 gap-2 text-xs font-numeric">
                              <span className="text-cyan-300 col-span-2">{candle.day}</span>
                              <span>O: {currency}{Number(candle.open).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                              <span>C: {currency}{Number(candle.close).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                              <span>H: {currency}{Number(candle.high).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                              <span>L: {currency}{Number(candle.low).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                            </div>
                          ) : (
                            <span className="text-xs text-zinc-500 font-numeric">Not available in loaded data</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <>
                {/* Backtest metric cards */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  {[
                    {
                      label: 'Total Trades',
                      value: aiResult.custom_metrics?.total_trades,
                      suffix: '',
                      color: 'text-white',
                      icon: '📈'
                    },
                    {
                      label: 'Win Rate',
                      value: aiResult.custom_metrics?.win_rate,
                      suffix: '%',
                      color: (aiResult.custom_metrics?.win_rate ?? 0) >= 50 ? 'text-green-400' : 'text-red-400',                      icon: '🎯'
                    },
                    {
                      label: 'Avg Return / Trade',
                      value: aiResult.custom_metrics?.avg_return_per_trade_pct,
                      suffix: '%',
                      color: (aiResult.custom_metrics?.avg_return_per_trade_pct ?? 0) >= 0 ? 'text-green-400' : 'text-red-400',
                      icon: '⚡'
                    },
                    {
                      label: 'Total Return',
                      value: aiResult.custom_metrics?.total_return_pct,
                      suffix: '%',
                      color: (aiResult.custom_metrics?.total_return_pct ?? 0) >= 0 ? 'text-green-400' : 'text-red-400',
                      icon: '💰'
                    },
                  ].map(({ label, value, suffix, color, icon }) => (
                    <div key={label} className="rounded-2xl border border-cyan-300/15 bg-slate-900/75 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-base">{icon}</span>
                        <span className="text-[9px] text-slate-300 uppercase tracking-widest font-bold font-body">{label}</span>
                      </div>
                      <span className={`text-xl font-numeric font-bold ${color}`}>
                        {value !== undefined && value !== null ? `${value}${suffix}` : '—'}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-4 rounded-2xl border border-cyan-300/25 bg-slate-900/75 p-4">
                  <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                    <div className="min-w-0">
                      <span className="text-[10px] text-cyan-500 uppercase tracking-widest font-black font-body">Strategy analysis</span>
                      <p className="mt-2 text-sm text-zinc-300 leading-relaxed font-numeric">
                        {aiResult.custom_metrics?.analysis_text || aiResult.custom_metrics?.warning || 'Strategy completed. Review the trade log below for entries and exits.'}
                      </p>
                    </div>
                    <div className="grid grid-cols-2 gap-2 shrink-0 min-w-[320px]">
                      {[
                        ['Wins', aiResult.custom_metrics?.summary?.wins ?? aiResult.custom_metrics?.wins ?? 0],
                        ['Losses', aiResult.custom_metrics?.summary?.losses ?? aiResult.custom_metrics?.losses ?? 0],
                        ['Best', `${aiResult.custom_metrics?.summary?.best_trade_pct ?? aiResult.custom_metrics?.best_trade_pct ?? 0}%`],
                        ['Worst', `${aiResult.custom_metrics?.summary?.worst_trade_pct ?? aiResult.custom_metrics?.worst_trade_pct ?? 0}%`],
                        ['Max DD', `${aiResult.custom_metrics?.summary?.max_drawdown_pct ?? aiResult.custom_metrics?.max_drawdown_pct ?? 0}%`],
                        ['Buy & Hold', `${aiResult.custom_metrics?.summary?.buy_and_hold_return_pct ?? aiResult.custom_metrics?.buy_and_hold_return_pct ?? 0}%`],
                        ['Alpha', `${aiResult.custom_metrics?.summary?.alpha_vs_buy_hold_pct ?? aiResult.custom_metrics?.alpha_vs_buy_hold_pct ?? 0}%`],
                      ].map(([label, value]) => (
                        <div key={label} className="rounded-xl bg-white/90 border border-cyan-100 p-3 text-slate-950">
                          <span className="text-[9px] text-slate-500 uppercase tracking-widest font-bold block">{label}</span>
                          <span className="text-sm text-slate-950 font-bold font-numeric">{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
                    <div className="rounded-xl bg-white/90 border border-cyan-100 p-3 text-slate-950">
                      <span className="text-[9px] text-slate-500 uppercase tracking-widest font-bold block mb-1">Entry rule</span>
                      <span className="text-xs text-slate-950 font-numeric break-words">{aiResult.custom_metrics?.buy_expr}</span>
                    </div>
                    <div className="rounded-xl bg-white/90 border border-cyan-100 p-3 text-slate-950">
                      <span className="text-[9px] text-slate-500 uppercase tracking-widest font-bold block mb-1">Exit rule</span>
                      <span className="text-xs text-slate-950 font-numeric break-words">{aiResult.custom_metrics?.sell_expr}</span>
                    </div>
                  </div>
                </div>

                {aiResult.custom_metrics?.open_trade && (
                  <div className="mt-4 bg-amber-500/5 border border-amber-500/20 rounded-2xl p-4">
                    <span className="text-[10px] text-amber-500 uppercase tracking-widest font-black font-body">Open trade</span>
                    <div className="mt-3 grid grid-cols-2 lg:grid-cols-5 gap-3">
                      {[
                        ['Buy date', `${aiResult.custom_metrics.open_trade.buy_date} (${aiResult.custom_metrics.open_trade.buy_day || '-'})`],
                        ['Buy price', aiResult.custom_metrics.open_trade.buy_price],
                        ['Target', aiResult.custom_metrics.open_trade.target_price ?? '-'],
                        ['Current', aiResult.custom_metrics.open_trade.current_price],
                        ['Return', `${aiResult.custom_metrics.open_trade.return_pct}%`],
                      ].map(([label, value]) => (
                        <div key={label} className="rounded-xl bg-black/25 border border-white/5 p-3">
                          <span className="text-[9px] text-zinc-500 uppercase tracking-widest font-bold block">{label}</span>
                          <span className="text-sm text-white font-bold font-numeric">{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {aiResult.custom_metrics?.trades?.length > 0 && (
                  <div className="mt-4 overflow-hidden rounded-2xl border border-cyan-200 bg-white text-slate-950 shadow-[0_18px_45px_rgba(2,6,23,0.22)]">
                    <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                      <span className="text-[10px] text-cyan-700 uppercase tracking-widest font-black font-body">
                        {aiResult.custom_metrics?.mode === 'weekday_projection' ? 'Projected setups' : 'Trade log'}
                      </span>
                      <span className="text-[9px] text-slate-600 font-numeric">
                        {aiResult.custom_metrics?.mode === 'weekday_projection' ? aiResult.custom_metrics.scope : `Latest ${aiResult.custom_metrics.trades.length}`}
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[820px] border-separate border-spacing-0 text-left">
                        <thead className="bg-slate-100">
                          <tr>
                            {['Buy day', 'Buy date', 'Buy', 'Sell day', 'Sell date', 'Sell', 'Hold', 'Return', 'Result'].map(label => (
                              <th key={label} className="px-4 py-3 text-[9px] text-slate-600 uppercase tracking-widest font-black font-body">{label}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {aiResult.custom_metrics.trades.map((trade: any, index: number) => (
                            <tr key={`${trade.buy_date}-${trade.sell_date}-${index}`} className="border-t border-slate-200 odd:bg-white even:bg-slate-50 hover:bg-cyan-50">
                              <td className="px-4 py-3 text-xs text-slate-800 font-numeric">{trade.buy_day || '-'}</td>
                              <td className="px-4 py-3 text-xs text-slate-800 font-numeric">{trade.buy_date}</td>
                              <td className="px-4 py-3 text-xs text-slate-950 font-bold font-numeric">{currency}{trade.buy_price}</td>
                              <td className="px-4 py-3 text-xs text-slate-800 font-numeric">{trade.sell_day || '-'}</td>
                              <td className="px-4 py-3 text-xs text-slate-800 font-numeric">{trade.sell_date}</td>
                              <td className="px-4 py-3 text-xs text-slate-950 font-bold font-numeric">{currency}{trade.sell_price}</td>
                              <td className="px-4 py-3 text-xs text-slate-800 font-numeric">{trade.holding_days}d</td>
                              <td className={`px-4 py-3 text-xs font-bold font-numeric ${trade.return_pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>{trade.return_pct}%</td>
                              <td className={`px-4 py-3 text-xs font-black font-body ${trade.result === 'PROJECTED' ? 'text-cyan-300' : trade.result === 'WIN' ? 'text-green-400' : 'text-red-400'}`}>{trade.result}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Section 5: Global NLP Feed (LAST) ── */}
      {false && (
      <div className="stock-news-panel bg-black/40 backdrop-blur-2xl border border-white/10 rounded-3xl p-4 sm:p-6 shadow-[0_8px_30px_rgba(0,0,0,0.5)] mb-8">
        <div className="flex items-center mb-5 border-b border-white/10 pb-4">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse inline-block"></span>
            <span className="stock-news-heading text-[10px] font-bold text-zinc-400 tracking-[0.2em] uppercase font-body">Stock News</span>
          </div>
        </div>

        <ul className="grid gap-3 md:grid-cols-2">
          {visibleStockStories.map((story, i: number) => {
            const { title, source, url } = story;
            return (
              <li key={`${title}-${i}`} className="stock-news-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 leading-relaxed transition-all hover:border-cyan-400/40 hover:bg-white/[0.06]">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer" className="stock-news-title block text-sm font-black text-zinc-100 transition-colors hover:text-cyan-300">
                      {title}
                    </a>
                  ) : (
                    <span className="stock-news-title block text-sm font-black text-zinc-100 transition-colors">{title}</span>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {source && (
                    <span className="text-[9px] text-cyan-400/80 font-numeric uppercase tracking-widest">
                      {source}
                    </span>
                  )}
                  {url && (
                    <span className="rounded-full border border-cyan-400/20 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-cyan-300 font-numeric">
                      Open news
                    </span>
                  )}
                </div>
                <p className="mt-3 text-[11px] leading-5 text-zinc-400 font-numeric">{buildMarketNewsRead(title)}</p>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 pt-3 border-t border-white/5 flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-600 inline-block"></span>
          <span className="text-[9px] text-zinc-600 font-numeric uppercase tracking-widest">
            News sentiment derived via NLP - refreshed on each analysis
          </span>
        </div>
      </div>
      )}

    </div>
  );
};

const FundamentalsTable = ({
  title,
  subtitle,
  table,
  currency,
}: {
  title: string;
  subtitle: string;
  table: any;
  currency: string;
}) => {
  const [tableScale, setTableScale] = useState(() =>
    typeof window !== 'undefined' && window.innerWidth < 640 ? 0.65 : 1.0
  );
  const columns = table?.columns ?? [];
  const rows = table?.rows ?? [];
  const cellPad = `${Math.round(tableScale * 12)}px ${Math.round(tableScale * 16)}px`;

  return (
    <div className="bg-black/40 backdrop-blur-2xl border border-white/10 rounded-3xl p-4 sm:p-6 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
      <div className="flex items-center justify-between gap-3 mb-4 border-b border-white/10 pb-3">
        <div className="min-w-0">
          <h3 className="text-base sm:text-xl font-black text-white font-body">{title}</h3>
          <p className="text-[10px] sm:text-xs text-zinc-500 mt-1 font-numeric">{subtitle}</p>
        </div>
        {/* Zoom controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setTableScale(z => Math.max(0.45, parseFloat((z - 0.1).toFixed(1))))}
            className="w-7 h-7 rounded-lg border border-white/15 bg-white/5 text-zinc-400 hover:text-white hover:bg-white/15 flex items-center justify-center text-base font-bold transition-all select-none"
            title="Zoom out table"
          >−</button>
          <span className="text-[9px] text-zinc-500 font-numeric w-8 text-center tabular-nums">
            {Math.round(tableScale * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setTableScale(z => Math.min(1.4, parseFloat((z + 0.1).toFixed(1))))}
            className="w-7 h-7 rounded-lg border border-white/15 bg-white/5 text-zinc-400 hover:text-white hover:bg-white/15 flex items-center justify-center text-base font-bold transition-all select-none"
            title="Zoom in table"
          >+</button>
        </div>
      </div>

      {rows.length === 0 || columns.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-6 text-xs text-zinc-500 font-numeric">
          This free data source does not expose this statement for the selected stock yet.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-white/10">
          <table
            className="w-full text-left border-collapse"
            style={{ fontSize: `${tableScale * 0.8125}rem`, minWidth: `${Math.round(tableScale * 900)}px` }}
          >
            <thead className="bg-white/5">
              <tr>
                <th
                  className="text-zinc-500 uppercase tracking-widest font-black font-body whitespace-nowrap"
                  style={{ padding: cellPad }}
                >Line Item</th>
                {columns.map((column: string) => (
                  <th
                    key={column}
                    className="text-zinc-500 uppercase tracking-widest font-black font-body whitespace-nowrap"
                    style={{ padding: cellPad }}
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row: any) => (
                <tr key={row.label} className="border-t border-white/5">
                  <td
                    className="text-zinc-200 font-semibold whitespace-nowrap"
                    style={{ padding: cellPad }}
                  >{humanizeLabel(row.label)}</td>
                  {row.values.map((value: any, index: number) => (
                    <td
                      key={`${row.label}-${index}`}
                      className="text-white font-numeric whitespace-nowrap"
                      style={{ padding: cellPad }}
                    >
                      {value === null || value === undefined
                        ? '-'
                        : Math.abs(Number(value)) >= 100000
                          ? formatCompactRupees(value)
                          : formatCurrencyNumber(value, currency, 2)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

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
    <aside className="order-1 rounded-3xl border border-slate-200 bg-white p-4 shadow-[0_22px_70px_rgba(15,23,42,0.12)] sm:p-5 xl:order-2">
      <div className="mb-4 flex items-start justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="min-w-0">
          <div className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 font-body">Key Fundamentals</div>
          <h2 className="mt-1 truncate text-lg font-black text-slate-950 font-body">{stock?.name || stock?.symbol || 'Stock'}</h2>
        </div>
        {quote?.change_percent !== undefined && (
          <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-black font-numeric ${quote.change_percent >= 0 ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}>
            {quote.change_percent >= 0 ? '+' : ''}{quote.change_percent.toFixed(2)}%
          </span>
        )}
      </div>
      {isLoading && !fundamentals ? (
        <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 text-center text-xs font-bold uppercase tracking-widest text-slate-400 font-numeric">
          Loading fundamentals
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {items.map(item => (
            <div key={item.label} className="min-w-0 rounded-2xl bg-slate-50 px-3 py-3">
              <div className="text-[10px] font-semibold text-slate-500">{item.label}</div>
              <div className="mt-1 truncate text-sm font-black text-slate-950 font-numeric" title={item.value}>{item.value}</div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
};

const IndiaDetailedAnalysisPanel = ({
  ticker,
  stock,
  currency,
  fundamentals,
  isLoading,
}: {
  ticker: string;
  stock: typeof STOCKS[number];
  currency: string;
  fundamentals: any;
  isLoading: boolean;
}) => {
  const summary = fundamentals?.summary ?? {};
  const company = fundamentals?.company ?? {};
  const ratios = (fundamentals?.ratios ?? []).filter((ratio: any) => ratio?.value !== null && ratio?.value !== undefined);
  const highlights = [
    { label: 'Market Cap', value: formatMarketCap(summary.market_cap, summary.market_cap_unit, currency) },
    { label: 'Current Price', value: formatCurrencyNumber(summary.current_price, currency, 2) },
    { label: 'Face Value', value: formatFaceValue(stock, summary.face_value) },
    { label: '52W High / Low', value: summary.high_52_week && summary.low_52_week ? `${formatCurrencyNumber(summary.high_52_week, currency, 2)} / ${formatCurrencyNumber(summary.low_52_week, currency, 2)}` : '-' },
    { label: 'Trailing P/E', value: formatRatioValue(summary.trailing_pe) },
    { label: 'Book Value', value: formatCurrencyNumber(summary.book_value, currency, 2) },
    { label: 'Dividend Yield', value: formatRatioValue(summary.dividend_yield, 'percent') },
    { label: 'ROE', value: formatRatioValue(summary.return_on_equity, 'percent') },
  ];
  const [showFullAbout, setShowFullAbout] = useState(false);
  const aboutDescription = company.description || `${stock.name} detailed profile will expand as we ingest more NSE/BSE filings.`;
  const isLongAbout = aboutDescription.length > 240;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-zinc-700 border-t-cyan-400 rounded-full animate-spin"></div>
          <span className="text-xs text-zinc-500 font-numeric uppercase tracking-widest animate-pulse">
            Loading free fundamentals for {ticker}...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        <div className="xl:col-span-8 bg-black/40 backdrop-blur-2xl border border-white/10 rounded-3xl p-4 sm:p-6 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
          <div className="flex items-center justify-between gap-3 mb-4 border-b border-white/10 pb-3">
            <div>
              <h3 className="text-lg sm:text-xl font-black text-white font-body">{resolveMarket(stock.exchange) === 'US' ? 'US Stock Analytics' : 'Indian Stock Analytics'}</h3>
              <p className="text-[10px] sm:text-xs text-zinc-500 mt-1 font-numeric">
                Free fundamentals pipeline for {stock.symbol} using cached market data.
              </p>
            </div>
            <span className="text-[10px] bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 px-3 py-1.5 rounded-full font-bold uppercase tracking-widest font-numeric">
              {resolveMarket(stock.exchange)}
            </span>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
            {highlights.map((item) => (
              <div key={item.label} className="metric-card-hover highlight-card rounded-xl sm:rounded-2xl border border-white/10 bg-white/5 p-2.5 sm:p-4 hover:border-cyan-500/25 cursor-default">
                <div className="text-[9px] sm:text-[10px] text-zinc-500 uppercase tracking-widest font-black font-body leading-tight">{item.label}</div>
                <div className="mt-1.5 sm:mt-2 text-sm sm:text-lg font-bold text-white font-numeric break-words leading-snug">{item.value}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="xl:col-span-4 bg-black/40 backdrop-blur-2xl border border-white/10 rounded-3xl p-4 sm:p-6 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
          <div className="flex items-center justify-between gap-3 mb-4 border-b border-white/10 pb-3">
            <div>
              <h3 className="text-lg sm:text-xl font-black text-white font-body">About</h3>
              <p className="text-[10px] sm:text-xs text-zinc-500 mt-1 font-numeric">
                Company profile and business context
              </p>
            </div>
          </div>
          <div className="space-y-3 text-sm">
            <div className="relative">
              <div className={isLongAbout && !showFullAbout ? 'about-truncated' : ''}>
                <p className="text-zinc-200 leading-relaxed text-[13px]">{aboutDescription}</p>
              </div>
              {isLongAbout && (
                <button
                  type="button"
                  onClick={() => setShowFullAbout(prev => !prev)}
                  className="mt-2 flex items-center gap-1.5 text-[10px] text-cyan-400 hover:text-cyan-300 font-bold uppercase tracking-widest transition-colors"
                >
                  {showFullAbout ? 'Show less' : 'Read more'}
                  <svg
                    className={`w-3.5 h-3.5 transition-transform duration-300 ${showFullAbout ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
              {[
                ['Sector', company.sector],
                ['Industry', company.industry],
                ['Website', company.website],
                ['Employees', company.employees ? formatIndianNumber(company.employees, 0) : null],
              ].map(([label, value]) => (
                <div key={label} className="metric-card-hover rounded-2xl border border-white/10 bg-white/5 p-3 hover:border-cyan-500/25">
                  <div className="text-[10px] text-zinc-500 uppercase tracking-widest font-black font-body">{label}</div>
                  <div className="mt-2 text-sm text-white font-numeric break-words">{value || '-'}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <FundamentalsTable
        title="Quarterly Results"
        subtitle="Free statement data mapped from the latest available quarterly income rows."
        table={fundamentals?.statements?.quarterly_results}
        currency={currency}
      />

      <FundamentalsTable
        title="Profit & Loss"
        subtitle="Annual income statement history from the free backend dataset."
        table={fundamentals?.statements?.profit_and_loss}
        currency={currency}
      />

      <FundamentalsTable
        title="Balance Sheet"
        subtitle="Annual balance sheet rows normalized into a dashboard-ready table."
        table={fundamentals?.statements?.balance_sheet}
        currency={currency}
      />

      <FundamentalsTable
        title="Cash Flow"
        subtitle="Annual cash flow rows pulled into the India-only detailed view."
        table={fundamentals?.statements?.cash_flow}
        currency={currency}
      />

      <div className="bg-black/40 backdrop-blur-2xl border border-white/10 rounded-3xl p-4 sm:p-6 shadow-[0_8px_30px_rgba(0,0,0,0.5)]">
        <div className="flex items-center justify-between gap-3 mb-4 border-b border-white/10 pb-3">
          <div>
            <h3 className="text-lg sm:text-xl font-black text-white font-body">Key Ratios</h3>
            <p className="text-[10px] sm:text-xs text-zinc-500 mt-1 font-numeric">
              Highlights available from the free source for this stock.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
          {ratios.length > 0 ? ratios.map((ratio: any) => (
            <div key={ratio.label} className="metric-card-hover highlight-card rounded-2xl border border-white/10 bg-white/5 p-4 hover:border-cyan-500/25">
              <div className="text-[10px] text-zinc-500 uppercase tracking-widest font-black font-body">{ratio.label}</div>
              <div className="mt-2 text-lg font-bold text-white font-numeric">{formatRatioValue(ratio.value, ratio.kind)}</div>
            </div>
          )) : (
            <div className="col-span-full rounded-2xl border border-dashed border-white/10 bg-white/5 px-4 py-6 text-xs text-zinc-500 font-numeric">
              Ratio fields are not available yet for this symbol.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

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
  const [chartRange, setChartRange] = useState<ChartRange>('1y');
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
    setCachedChart(getCache(`chart:${stock.ticker}:${chartRange}`));
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
      applyUrlState(window.location.search);
      setShowProfileMenu(false);
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
    import('lightweight-charts').then(({ createChart, CandlestickSeries, LineSeries }) => {
      if (cancelled || !chartRef.current) return;
      const container = chartRef.current;
      const rect = container.getBoundingClientRect();
      const initW = rect.width || container.clientWidth || 800;
      const initH = rect.height || container.clientHeight || 320;
      const indicatorHeight = 190;
      const chart = createChart(container, {
        width: initW,
        height: initH,
        // Axis labels need real contrast against the dark panel — #c6c6cd was
        // washing out, which is why dates/prices read as invisible.
        layout: { background: { color: 'transparent' }, textColor: '#e8e8ea', fontSize: 12 },
        grid: { vertLines: { color: 'rgba(255,255,255,0.07)' }, horzLines: { color: 'rgba(255,255,255,0.07)' } },
        crosshair: {
          mode: 1,
          vertLine: { color: 'rgba(255,79,163,0.55)', labelBackgroundColor: '#ff4fa3' },
          horzLine: { color: 'rgba(255,79,163,0.55)', labelBackgroundColor: '#ff4fa3' },
        },
        timeScale: {
          timeVisible: chartRange === '1d' || chartRange === '1w',
          secondsVisible: false,
          borderColor: 'rgba(255,255,255,0.18)',
          fixLeftEdge: chartRange !== 'max',
          fixRightEdge: true,
          rightOffset: 5,
        },
        rightPriceScale: { borderColor: 'rgba(255,255,255,0.18)' },
      });

      const candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: '#34d399', downColor: '#fb7185',
        borderVisible: false, wickUpColor: '#34d399', wickDownColor: '#fb7185'
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
      candleSeries.setData(formattedData);

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
            layout: { background: { color: 'transparent' }, textColor: '#c6c6cd' },
            grid: { vertLines: { color: 'rgba(255,255,255,0.04)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
            crosshair: { mode: 1 },
            rightPriceScale: {
              borderColor: 'rgba(255,255,255,0.12)',
              scaleMargins: { top: 0.18, bottom: 0.18 },
            },
            timeScale: {
              timeVisible: chartRange === '1d' || chartRange === '1w',
              secondsVisible: false,
              borderColor: 'rgba(15,23,42,0.12)',
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
  }, [chartData, chartRange, indicatorPanels, ticker, dashboardView]);

  const openStockView = (stock: typeof STOCKS[0], nextView: DashboardView = 'overview') => {
    const market = resolveMarket(stock.exchange);
    const resolvedView = canShowDetailedAnalysis(stock) ? nextView : 'overview';
    setCachedQuote(getCache(`quote:${stock.ticker}`));
    setCachedChart(getCache(`chart:${stock.ticker}:${chartRange}`));
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

  const openPreview = (stock: typeof STOCKS[0]) => {
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
    setTicker(null);
    setDashboardView('overview');
    setCachedFundamentals(undefined);
    setShowProfileMenu(false);
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

      {/* WELCOME — a short greeting after sign-in, then it fades away. */}
      {showWelcome && (
        <div className="nova-welcome pointer-events-none fixed inset-0 z-[9999] flex items-center justify-center p-6" role="status" aria-live="polite">
          <div className="nova-welcome-card nova-modal rounded-[28px] px-10 py-9 text-center font-body">
            <div className="flex justify-center"><BullseyeLogo size={26} wordClassName="text-[22px]" /></div>
            <p className="mt-5 font-display text-[clamp(40px,6vw,60px)] leading-[1] text-paper">
              Welcome, <em className="nova-gradient-text italic">{welcomeName}.</em>
            </p>
            <p className="mt-3 text-[15px] text-[#c9c3e6]">You&apos;re signed in. Your alerts and saved scans are ready.</p>
          </div>
        </div>
      )}

      <div className="min-h-screen overflow-x-clip bg-[#04070f] text-slate-100 selection:bg-cyan-500/20 selection:text-cyan-100 flex flex-col font-body">

        {/* IMMERSIVE BACKGROUND — View 2 keeps the Market Globe; View 1's
            background is owned by the Nova scroll scene (its own fixed layer). */}
        {ticker && <HomeAmbientBackground />}

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
            <BullseyeLogo size={32} wordClassName="text-[27px] sm:text-[29px]" />
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
            {showSuggestions && suggestions.length > 0 && (
              <div data-lenis-prevent className="nova-modal absolute z-50 mt-2 max-h-[72vh] w-full min-w-[min(82vw,320px)] overflow-y-auto overflow-x-hidden rounded-2xl p-1.5 sm:min-w-full" style={{ animationDuration: '0.25s' }}>
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
              className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-full border border-cyan-200 bg-white text-cyan-700 font-black uppercase shadow-[0_12px_32px_rgba(6,182,212,0.16)] transition-all hover:border-cyan-400 hover:bg-cyan-50 sm:h-12 sm:w-12"
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

            {showProfileMenu && (
              <div className="absolute right-0 top-full mt-3 z-50 w-80 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-9rem)] overflow-y-auto rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-[0_28px_65px_rgba(15,23,42,0.28)] p-4 sm:p-5">
                {authReady && user ? (
                  <>
                    <div className="flex items-center gap-3 border-b border-slate-200 pb-4 mb-4">
                      <div className="w-12 h-12 rounded-full bg-cyan-100 text-cyan-700 font-black flex items-center justify-center overflow-hidden shrink-0">
                        {user.user_metadata?.avatar_url ? (
                          <img src={user.user_metadata.avatar_url} alt="avatar" referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                        ) : (
                          (user.user_metadata?.full_name || user.email || 'U').slice(0, 1)
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="font-black text-sm truncate font-body">{user.user_metadata?.full_name || 'Signed in user'}</div>
                        <div className="text-xs text-slate-500 truncate font-numeric">{user.email}</div>
                      </div>
                    </div>
                    <div className="mb-4">
                      <div className="text-[10px] uppercase tracking-widest text-cyan-700 font-black font-body">Dashboard</div>
                      <div className="text-xs text-slate-500 mt-1 font-numeric">Your signed-in Bullseye workspace</div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 mb-4">
                      <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
                        <span className="text-[9px] uppercase tracking-widest text-slate-500 font-bold">Market</span>
                        <div className="text-sm font-bold">{activeMarket}</div>
                      </div>
                      <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
                        <span className="text-[9px] uppercase tracking-widest text-slate-500 font-bold">Viewing</span>
                        <div className="text-sm font-bold truncate">{ticker || 'Overview'}</div>
                      </div>
                      <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
                        <span className="text-[9px] uppercase tracking-widest text-slate-500 font-bold">Saved scans</span>
                        <div className="text-sm font-bold">{Object.keys(prefetchCache).length}</div>
                      </div>
                      <div className="rounded-xl bg-slate-50 border border-slate-200 p-3">
                        <span className="text-[9px] uppercase tracking-widest text-slate-500 font-bold">Cache</span>
                        <div className="text-sm font-bold">{cachedAnalysis ? 'Ready' : 'Live'}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setShowProfileMenu(false);
                        setShowNotificationSettings(true);
                      }}
                      className="mb-3 w-full rounded-xl border border-cyan-200 bg-cyan-50 py-3 text-xs font-black uppercase tracking-widest text-cyan-700 transition-colors hover:border-cyan-300 hover:bg-cyan-100 font-body"
                    >
                      Logged-in Alerts
                    </button>
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="force-light-text w-full rounded-xl bg-slate-900 py-3 text-xs font-black uppercase tracking-widest font-body hover:bg-slate-700 transition-colors"
                    >
                      Sign Out
                    </button>
                  </>
                ) : !authReady && supabaseAvailable ? (
                  <div className="flex flex-col items-center justify-center gap-3 py-6">
                    <div className="w-6 h-6 border-2 border-slate-200 border-t-cyan-500 rounded-full animate-spin" />
                    <div className="text-center">
                      <div className="text-[10px] uppercase tracking-widest text-cyan-700 font-black font-body">Loading Account</div>
                      <div className="text-xs text-slate-500 mt-1 font-numeric">Checking your sign-in session...</div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="mb-4">
                      <div className="text-[10px] uppercase tracking-widest text-cyan-700 font-black font-body">Account</div>
                      <div className="text-xs text-slate-500 mt-1 font-numeric">Sign in to open your Bullseye dashboard.</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => { setShowProfileMenu(false); setShowAuthModal(true); }}
                      className="force-light-text w-full rounded-xl bg-slate-900 py-3 text-xs font-black uppercase tracking-widest font-body hover:bg-slate-700 transition-colors"
                    >
                      Sign In
                    </button>
                  </>
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
            <div className="bullseye-night animate-in fade-in slide-in-from-bottom-8 duration-700 w-full min-w-0 flex flex-col gap-6">

              {/* Header */}
              <div className="flex flex-col sm:flex-row items-start sm:items-end justify-between border-b border-white/10 pb-5 gap-3 relative">
                <div className="absolute inset-x-0 bottom-0 h-[1px] bg-gradient-to-r from-transparent via-[rgba(255,79,163,0.4)] to-transparent" />
                <div>
                  <button onClick={goHome}
                    className="mb-4 inline-flex items-center gap-2 rounded-full border border-hairline bg-glass px-3.5 py-1.5 font-body text-[11px] font-medium text-paper-muted backdrop-blur-md transition duration-300 hover:border-accent/50 hover:text-accent">
                    ← Overview
                  </button>
                  <h1 className="break-words font-numeric text-4xl font-bold uppercase tracking-tight text-paper sm:text-5xl lg:text-6xl">{ticker}</h1>
                  {selectedStock?.name && (
                    <div className="mt-2 font-display text-xl text-paper-muted">{selectedStock.name}</div>
                  )}
                </div>
                <div className="flex flex-col sm:items-end gap-3">
                  {canOpenDetailedAnalysis && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={openOverview}
                        className={`px-4 py-2 rounded-full border text-[10px] font-black uppercase tracking-[0.2em] font-body transition-all ${
                          dashboardView === 'overview'
                            ? 'stock-view-toggle-active'
                            : 'stock-view-toggle-idle'
                        }`}
                      >
                        Overview
                      </button>
                      <button
                        type="button"
                        onClick={openDetailedAnalysis}
                        className={`px-4 py-2 rounded-full border text-[10px] font-black uppercase tracking-[0.2em] font-body transition-all ${
                          dashboardView === 'details'
                            ? 'stock-view-toggle-active'
                            : 'stock-view-toggle-idle'
                        }`}
                      >
                        Financials
                      </button>
                    </div>
                  )}
                {quote?.price && (
                  <div className="text-left sm:text-right">
                    <div className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest mb-1">Live Price</div>
                    <span className="text-3xl sm:text-4xl font-numeric font-bold text-white tracking-tight">{currency}{quote.price.toLocaleString()}</span>
                    <div className={`text-sm font-numeric font-bold mt-1 tracking-wider ${quote.change_percent > 0 ? 'text-green-400' : 'text-red-500'}`}>
                      {quote.change_percent > 0 ? '▲' : '▼'} {Math.abs(quote.change_percent).toFixed(2)}%
                    </div>
                  </div>
                )}
                </div>
              </div>

              {/* Chart + fundamentals snapshot — shown in Overview only. The
                  Financials tab renders its own ratios and statement tables, so
                  these boxes would otherwise duplicate there. */}
              {dashboardView === 'overview' && (
              <div className="flex flex-col gap-5">

              {/* Verdict-first: the actual product output (verdict + entry /
                  target / stop / confidence) surfaced above the chart. */}
              {(() => {
                const v = getAnalysisPresentation(analysis);
                if (!v) return null;
                const tone = v.isBullish ? 'text-primary' : v.isBearish ? 'text-rose-300' : 'text-paper';
                const upside = v.entry ? Math.abs(((v.target - v.entry) / v.entry) * 100) : 0;
                const downside = v.entry ? Math.abs(((v.entry - v.stop_loss) / v.entry) * 100) : 0;
                const rr = downside > 0 ? (upside / downside).toFixed(2) : '—';
                const stats: Array<[string, string]> = [
                  ['Entry', `${currency}${Number(v.entry).toLocaleString()}`],
                  ['Target', `${currency}${Number(v.target).toLocaleString()}`],
                  ['Stop loss', `${currency}${Number(v.stop_loss).toLocaleString()}`],
                  ['Confidence', `${v.confidenceLevel}/100`],
                  ['Reward : risk', rr],
                ];
                return (
                  <div
                    className="rounded-[24px] border border-accent/35 p-6 sm:p-8"
                    style={{
                      background:
                        'linear-gradient(145deg, rgba(20,22,19,0.94) 0%, rgba(8,10,9,0.97) 55%, rgba(16,18,15,0.94) 100%)',
                      boxShadow: '0 26px 70px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,79,163,0.16)',
                    }}
                  >
                    <div className="flex flex-wrap items-end justify-between gap-6">
                      <div>
                        <div className="font-body text-[10px] font-medium uppercase tracking-[0.26em] text-accent">
                          FISO verdict
                        </div>
                        <div className={`mt-3 font-display text-[clamp(2.2rem,5vw,3.4rem)] leading-none ${tone}`}>
                          {v.displayVerdict}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="h-2 w-40 overflow-hidden rounded-full bg-white/10">
                          <div
                            className="h-full rounded-full bg-accent"
                            style={{ width: `${Math.min(100, Math.max(0, Number(v.confidenceLevel)))}%` }}
                          />
                        </div>
                        <span className="font-numeric text-[13px] text-accent">{v.confidenceLevel}</span>
                      </div>
                    </div>
                    <div className="mt-7 flex flex-wrap gap-x-12 gap-y-5 border-t border-hairline pt-6">
                      {stats.map(([label, value]) => (
                        <div key={label}>
                          <div className="font-body text-[10px] font-medium uppercase tracking-[0.22em] text-paper-muted">
                            {label}
                          </div>
                          <div className="mt-1.5 font-numeric text-lg leading-none text-paper">{value}</div>
                        </div>
                      ))}
                    </div>

                    {/* Why the engine landed here. Every one of these is already
                        computed and returned by /analyze — it was just never
                        surfaced, so the verdict read as an assertion rather than
                        a result. `historical_hit_rate` carries its own sample
                        size because a hit rate over 3 trades is not a hit rate. */}
                    {(() => {
                      const pct = (value: any) =>
                        typeof value === 'number' ? `${Math.round(value * 100)}%` : null;
                      const trades = Number(analysis?.historical_hit_rate_trades ?? 0);
                      const why: Array<[string, string, string]> = [];
                      const modelP = pct(analysis?.model_probability);
                      if (modelP) why.push(['Model win probability', modelP, 'from the trained win-probability model']);
                      const hit = pct(analysis?.historical_hit_rate);
                      if (hit) {
                        why.push([
                          'This setup historically',
                          hit,
                          trades > 0 ? `over ${trades} recorded trade${trades === 1 ? '' : 's'}` : 'no recorded trades yet — treat as a prior',
                        ]);
                      }
                      if (typeof analysis?.expected_r === 'number') {
                        why.push(['Expected R', analysis.expected_r.toFixed(2), 'net of costs and slippage']);
                      }
                      const quality = pct(analysis?.chart_setup_quality);
                      if (quality) why.push(['Chart setup quality', quality, 'trend, breakout, volume and momentum checks']);
                      if (!why.length) return null;
                      return (
                        <div className="mt-6 border-t border-hairline pt-5">
                          <div className="font-body text-[10px] font-medium uppercase tracking-[0.24em] text-accent">
                            Why this call
                          </div>
                          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                            {why.map(([label, value, note]) => (
                              <div key={label}>
                                <div className="font-numeric text-xl leading-none text-paper">{value}</div>
                                <div className="mt-1.5 font-body text-[11px] text-paper">{label}</div>
                                <div className="mt-0.5 font-body text-[10px] leading-relaxed text-paper-muted">{note}</div>
                              </div>
                            ))}
                          </div>
                          {analysis?.signal_status === 'no_trade' && (
                            <p className="mt-4 rounded-xl border border-accent/25 bg-accent/[0.06] px-4 py-3 font-body text-[11px] leading-relaxed text-paper-muted">
                              This setup did not clear Bullseye&apos;s risk, reward and data-quality
                              gates, so no target or stop is issued. The honest call is to sit this one out.
                            </p>
                          )}
                        </div>
                      );
                    })()}

                    {/* Where the price sits in its yearly range — context the
                        entry/target/stop numbers above cannot give on their own. */}
                    <div className="mt-6 border-t border-hairline pt-5">
                      <RangeBar
                        low={fundamentals?.summary?.low_52_week}
                        high={fundamentals?.summary?.high_52_week}
                        current={quote?.price ?? analysis?.current_price}
                        currency={currency}
                      />
                    </div>
                  </div>
                );
              })()}

              <div
                className="relative min-w-0 rounded-[24px] border border-hairline p-5 sm:p-6"
                style={{
                  background:
                    'linear-gradient(145deg, rgba(18,20,17,0.9) 0%, rgba(7,9,8,0.95) 55%, rgba(14,16,13,0.9) 100%)',
                  boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
                }}
              >
                <div className="flex items-center justify-between gap-3 mb-4 border-b border-slate-200 pb-3 flex-wrap">
                  <span className="font-bold text-xs text-slate-500 uppercase tracking-[0.2em] font-body flex items-center gap-2 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse inline-block" />
                    Chart Geometry
                  </span>
                  <div className="flex flex-wrap items-center gap-2 sm:ml-auto sm:gap-3">
                    <div className="chart-controls-pill flex items-center gap-1 rounded-full border border-slate-200 bg-white/80 p-1">
                      {([
                        ['1d',  '1D'],
                        ['1w',  '1W'],
                        ['1mo', '1M'],
                        ['1y',  '1Y'],
                        ['max', 'ALL'],
                      ] as Array<[ChartRange, string]>).map(([range, label]) => (
                        <button
                          key={range}
                          type="button"
                          onClick={() => setChartRange(range)}
                          className={`h-8 min-w-10 rounded-full px-3 text-[10px] font-black font-numeric transition-all duration-200 ${
                            chartRange === range
                              ? range === 'max'
                                ? 'bg-cyan-600 shadow-md chart-range-btn-active ring-1 ring-cyan-500/50'
                                : 'bg-slate-950 shadow-md chart-range-btn-active ring-1 ring-slate-800/50'
                              : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setShowIndicatorMenu(value => !value)}
                        className="h-10 rounded-full border border-slate-200 bg-white px-4 text-[10px] font-black uppercase tracking-widest text-slate-800 shadow-sm transition-all hover:border-cyan-300 hover:bg-cyan-50 font-body"
                      >
                        Indicators
                      </button>
                      {showIndicatorMenu && (
                        <>
                        <div className="fixed inset-0 z-40" onClick={() => setShowIndicatorMenu(false)} />
                        <div className="fixed left-1/2 top-20 z-50 w-[min(92vw,420px)] -translate-x-1/2 overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-950 shadow-[0_28px_80px_rgba(15,23,42,0.28)] sm:absolute sm:left-auto sm:right-0 sm:top-12 sm:translate-x-0">
                          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
                            <div className="text-lg font-black font-body">Indicators</div>
                            <button
                              type="button"
                              onClick={() => setShowIndicatorMenu(false)}
                              className="h-9 w-9 rounded-xl border border-slate-200 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-950"
                              aria-label="Close indicators"
                            >
                              X
                            </button>
                          </div>
                          <div className="border-b border-slate-100 p-3">
                            <input
                              value={indicatorQuery}
                              onChange={event => setIndicatorQuery(event.target.value)}
                              placeholder="Search"
                              className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 text-sm font-bold text-slate-800 outline-none transition-all placeholder:text-slate-400 focus:border-cyan-300 focus:bg-white font-body"
                            />
                          </div>
                          <div className="max-h-[min(55vh,420px)] overflow-y-auto py-2">
                            {filteredIndicators.map(name => {
                              const selected = activeIndicators.includes(name);
                              return (
                                <button
                                  key={name}
                                  type="button"
                                  onClick={() => toggleIndicator(name)}
                                  className={`flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-bold transition-colors font-body ${
                                    selected ? 'bg-slate-100 text-slate-950' : 'text-slate-700 hover:bg-slate-50'
                                  }`}
                                >
                                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[10px] ${
                                    selected ? 'border-cyan-400 bg-cyan-50 text-cyan-700' : 'border-slate-200 text-slate-400'
                                  }`}>
                                    {selected ? '+' : ''}
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
                    {analysis && !analysis.error && (
                      <span className={`hidden text-xs font-black uppercase tracking-widest font-body shrink-0 sm:inline ${accentColor}`}>{dashboardAnalysisView?.displayVerdict}</span>
                    )}
                  </div>
                </div>
                {chartError && !chartData ? (
                  <div className="h-[260px] sm:h-[360px] flex flex-col items-center justify-center rounded-2xl border border-dashed border-red-200 bg-red-50 px-6 text-center font-numeric text-xs text-red-500 sm:text-sm">
                    <div className="mb-2 font-black uppercase tracking-widest text-red-500">Chart unavailable</div>
                    <div>{chartError.message || 'The chart service returned an error. Try again in a moment.'}</div>
                  </div>
                ) : !chartData ? (
                  <div className="h-[260px] sm:h-[360px] flex flex-col items-center justify-center font-numeric text-zinc-500 gap-4 text-xs sm:text-sm uppercase tracking-widest">
                    <div className="w-8 h-8 border-2 border-zinc-700 border-t-cyan-400 rounded-full animate-spin"></div>
                    Loading Data Stream...
                  </div>
                ) : !chartRowsAvailable ? (
                  <div className="flex h-[260px] flex-col items-center justify-center rounded-2xl border border-dashed border-hairline px-6 text-center sm:h-[360px]">
                    <div className="mb-2 font-body text-[10px] font-medium uppercase tracking-[0.22em] text-accent">No chart data</div>
                    <div className="font-body text-[13px] leading-6 text-paper-muted">The backend did not return candle rows for this symbol yet. Refresh in a moment.</div>
                  </div>
                ) : (
                  <div className="w-full overflow-hidden rounded-2xl border border-hairline bg-black/30">
                    <div ref={chartRef} className="w-full h-[340px] sm:h-[440px] overflow-hidden" />
                    {indicatorPanels.length > 0 && (
                      <div>
                        {indicatorPanels.map(panel => (
                          <IndicatorChartPane
                            key={panel.name}
                            panel={panel}
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
                  <div className="mt-3 rounded-2xl border border-dashed border-hairline bg-white/[0.02] px-4 py-3 font-numeric text-xs text-paper-muted">
                    Select an indicator to add a study pane below the stock chart.
                  </div>
                )}
              </div>

              <FundamentalsSnapshotCard
                stock={selectedStock}
                currency={currency}
                fundamentals={fundamentals}
                quote={quote}
                isLoading={fundamentalsLoading}
              />

              {/* Context for the verdict above: how our previous calls on this
                  stock actually resolved, and how its fundamentals sit against
                  the sector. Both answer "compared to what?", which the raw
                  numbers on their own do not. */}
              <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <TrackRecord symbol={selectedStock?.symbol ?? ticker} currency={currency} />
                <PeerComparison ticker={ticker} />
              </div>
              </div>
              )}

              {/* FISO Analysis + all sections in order */}
              {dashboardView === 'details' && selectedStock && canOpenDetailedAnalysis ? (
                <IndiaDetailedAnalysisPanel
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
                <div className="flex gap-3 rounded-2xl border border-accent/20 bg-accent/[0.04] p-4">
                  <span className="mt-0.5 shrink-0 text-lg text-accent">⚠️</span>
                  <p className="font-body text-[11px] leading-relaxed text-paper-muted">
                    <span className="font-semibold text-paper">Disclaimer: </span>
                    Bullseye is an AI-powered predictive tool and is NOT a SEBI-registered investment advisor.
                    Predictions generated by the app are for educational and informational purposes only,
                    and should not be construed as financial or investment advice. Invest at your own risk.
                  </p>
                </div>
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
      {showAuthModal && typeof document !== 'undefined' && createPortal(
        <div
          onClick={dismissAuthModal}
          role="presentation"
          style={{ isolation: 'isolate', transform: 'translateZ(0)' }}
          className="nova-modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
        >
          <div
            onClick={event => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Sign in to Bullseye"
            data-lenis-prevent
            className="nova-modal w-full max-w-[420px] rounded-[28px] p-7 font-body sm:p-8"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-4">
              <BullseyeLogo size={28} wordClassName="text-[24px]" />
              <button
                onClick={dismissAuthModal}
                aria-label="Close sign-in and continue without an account"
                className="-mr-2 -mt-2 flex h-9 w-9 items-center justify-center rounded-full text-[#b9b4d6] transition-colors hover:bg-white/10 hover:text-white"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <h2 className="mt-6 font-display text-[34px] leading-[1.02] text-paper">
              {authMode === 'signin' ? <>Welcome <em className="nova-gradient-text italic">back.</em></> : <>Create your <em className="nova-gradient-text italic">account.</em></>}
            </h2>
            <p className="mt-2 text-[14px] leading-6 text-[#c9c3e6]">
              Save alerts and get the short list by email. The screener, markets and Ask AI work without an account.
            </p>

            {/* Google Sign In */}
            <button
              onClick={handleGoogleSignIn}
              disabled={authLoading}
              className="mt-6 flex h-12 w-full items-center justify-center gap-3 rounded-full bg-white text-[14px] font-semibold text-[#111] transition hover:bg-white/90 disabled:opacity-50"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden>
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Continue with Google
            </button>

            {/* Divider */}
            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-white/10" />
              <span className="text-[12px] text-[#8f89ad]">or use email</span>
              <div className="h-px flex-1 bg-white/10" />
            </div>

            <div className="grid gap-3">
              <input
                type="email"
                value={authEmail}
                onChange={e => setAuthEmail(e.target.value)}
                placeholder="Email address"
                autoComplete="email"
                className="nova-input"
              />
              <input
                type="password"
                value={authPassword}
                onChange={e => setAuthPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleEmailAuth()}
                placeholder="Password"
                autoComplete={authMode === 'signin' ? 'current-password' : 'new-password'}
                className="nova-input"
              />
            </div>

            {/* Error / success messages */}
            {authError && <p className="mt-3 text-[13px] text-[#ff7a93]">{authError}</p>}
            {authSuccess && <p className="mt-3 text-[13px] text-[#6ff0b5]">{authSuccess}</p>}

            <button
              onClick={handleEmailAuth}
              disabled={authLoading}
              className="nova-btn nova-btn-primary mt-4 w-full disabled:opacity-50"
            >
              {authLoading ? 'Please wait…' : authMode === 'signin' ? 'Sign in' : 'Create account'}
            </button>

            <p className="mt-4 text-center text-[13px] text-[#b9b4d6]">
              {authMode === 'signin' ? 'New to Bullseye? ' : 'Already have an account? '}
              <button
                type="button"
                onClick={() => { setAuthMode(authMode === 'signin' ? 'signup' : 'signin'); setAuthError(''); setAuthSuccess(''); }}
                className="font-semibold text-white underline-offset-4 hover:underline"
              >
                {authMode === 'signin' ? 'Create an account' : 'Sign in'}
              </button>
            </p>

            {/* Anonymous escape hatch — sign-in is not required to browse. */}
            <button
              onClick={dismissAuthModal}
              className="mt-5 w-full rounded-full border border-white/15 py-3 text-[14px] font-medium text-[#e9e5ff] transition hover:border-white/30 hover:bg-white/5"
            >
              Continue without signing in
            </button>

            <p className="mt-5 text-center text-[11.5px] leading-5 text-[#8f89ad]">
              Bullseye is research, not advice, and is not a SEBI-registered adviser.
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

