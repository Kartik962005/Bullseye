'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  type Forecast,
  type ForecastTest,
  type Horizon,
  type LiveRecord,
  type Pick,
  callChance,
  horizonWindow,
  prettyDate,
} from '@/lib/daily-picks';

const money = (n: number) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const signedPct = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(1)}%`;
const monthYear = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Which sessions the calls cover, counted on the NSE calendar. */
export function WindowBanner({
  firstSession,
  horizon,
  dataDate,
  phaseNote,
}: {
  firstSession: string;
  horizon: Horizon;
  dataDate?: string | null;
  phaseNote?: string | null;
}) {
  const { first, last, skipped } = horizonWindow(firstSession, horizon);
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="text-[15px] font-semibold">
          {horizon === 1 ? (
            <>
              Intraday · {prettyDate(first)}
            </>
          ) : (
            <>
              {prettyDate(first)} <span className="text-[color:var(--ink-3)]">→</span> {prettyDate(last)}
            </>
          )}
        </div>
        {phaseNote && <span className="rounded-full bg-white/[0.07] px-2.5 py-1 text-[11.5px] text-[color:var(--ink-2)]">{phaseNote}</span>}
      </div>
      <p className="mt-1 text-[12.5px] leading-5 text-[color:var(--ink-3)]">
        {horizon === 1
          ? 'Enter at the 9:15 AM open, close out by the 3:30 PM close the same day.'
          : `Enter at the 9:15 AM open on ${prettyDate(first)}, hold to the 3:30 PM close on ${prettyDate(last)}: ${horizon} trading sessions.`}
        {skipped.length > 0 && ` Skips ${skipped.map(h => `${prettyDate(h.day)} (${h.name})`).join(', ')}.`}
        {dataDate ? ` Built from the ${prettyDate(dataDate)} close.` : ''}
      </p>
    </div>
  );
}

function CallCard({ pick, forecast, horizon }: { pick: Pick; forecast: Forecast; horizon: Horizon }) {
  const [open, setOpen] = useState(false);
  const buy = pick.direction === 'BUY';
  const chance = callChance(forecast, pick.direction);
  const stop = forecast.stop_price ?? (buy ? forecast.low_price : forecast.high_price);
  const tested = forecast.tested;
  const testedRate = tested ? tested.call_rate ?? (typeof tested.actual_beat_rate === 'number' ? (buy ? tested.actual_beat_rate : 1 - tested.actual_beat_rate) : null) : null;
  const endLabel = forecast.last_session ? prettyDate(forecast.last_session) : horizon === 1 ? 'the close' : `session ${horizon}`;
  return (
    <li className="rounded-2xl border border-white/[0.07] bg-white/[0.025]">
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} className="flex w-full items-center gap-3 px-3.5 py-3 text-left sm:px-4">
        <span
          className={`grid h-9 w-11 shrink-0 place-items-center rounded-xl font-numeric text-[11.5px] font-semibold ${
            buy ? 'bg-[color:var(--up)]/14 text-[color:var(--up)]' : 'bg-[color:var(--down)]/14 text-[color:var(--down)]'
          }`}
        >
          {buy ? 'BUY' : 'SELL'}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-numeric text-[14.5px] text-white">{pick.symbol}</span>
          <span className="block truncate text-[11.5px] text-[color:var(--ink-3)]">{pick.company_name || pick.symbol}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="block font-numeric text-[14px] text-white">{pct(chance)}</span>
          <span className="block text-[10.5px] leading-tight text-[color:var(--ink-4)]">to {buy ? 'beat' : 'lag'} market</span>
          {typeof forecast.typical_p_beat === 'number' && (
            <span className="block text-[10.5px] leading-tight text-[color:var(--ink-4)]">
              typical {pct(buy ? forecast.typical_p_beat : 1 - forecast.typical_p_beat)}
            </span>
          )}
        </span>
        <svg viewBox="0 0 20 20" className={`h-4 w-4 shrink-0 text-[color:var(--ink-3)] transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m5 8 5 5 5-5" />
        </svg>
      </button>
      <div className="flex flex-wrap gap-x-4 gap-y-1 px-4 pb-3 font-numeric text-[12px] text-[color:var(--ink-2)] sm:pl-[4.6rem]">
        <span>Last {money(forecast.reference_close)}</span>
        <span>Expected {money(forecast.mid_price)}</span>
        <span className={buy ? 'text-[color:var(--down)]' : 'text-[color:var(--down)]'}>
          Exit if {buy ? 'below' : 'above'} {money(stop)}
        </span>
      </div>
      {open && (
        <div className="anim-pop border-t border-white/[0.06] px-4 pb-3.5 pt-3 text-[12.5px] leading-5 text-[color:var(--ink-2)]" data-state="open">
          <div className="grid grid-cols-3 gap-2 font-numeric">
            <div className="min-w-0">
              <div className="text-[10.5px] text-[color:var(--ink-4)]">Low case</div>
              {money(forecast.low_price)}
              <span className="block text-[11px] text-[color:var(--ink-4)]">{signedPct(forecast.q10)}</span>
            </div>
            <div className="min-w-0">
              <div className="text-[10.5px] text-[color:var(--ink-4)]">Expected</div>
              {money(forecast.mid_price)}
              <span className="block text-[11px] text-[color:var(--ink-4)]">{signedPct(forecast.q50)}</span>
            </div>
            <div className="min-w-0">
              <div className="text-[10.5px] text-[color:var(--ink-4)]">High case</div>
              {money(forecast.high_price)}
              <span className="block text-[11px] text-[color:var(--ink-4)]">{signedPct(forecast.q90)}</span>
            </div>
          </div>
          <p className="mt-2.5 text-[12px] text-[color:var(--ink-3)]">
            “Expected” is the middle of the forecast: half of outcomes finished above it, half below. By {endLabel}, 8 in 10
            outcomes in testing landed between the low and high case; the exit line is the 1-in-10 {buy ? 'low' : 'high'}.
            {tested && testedRate !== null
              ? ` Calls with this chance were right ${pct(testedRate)} of the time in testing (${tested.samples.toLocaleString('en-IN')} cases).`
              : ''}
          </p>
          {(forecast.context ?? []).length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-4">
              {(forecast.context ?? []).slice(0, 4).map(note => <li key={note}>{note}</li>)}
            </ul>
          )}
          <Link href={`/stock/${encodeURIComponent(pick.symbol)}`} className="mt-2.5 inline-flex text-[12.5px] font-medium text-[color:var(--accent-text)] hover:underline">
            Open {pick.symbol} →
          </Link>
        </div>
      )}
    </li>
  );
}

/** Buy calls, then sell calls (intraday), each with its own heading. */
export function CallLists({ picks, horizon }: { picks: Pick[]; horizon: Horizon }) {
  const buys = picks.filter(p => p.direction === 'BUY');
  const sells = picks.filter(p => p.direction === 'SELL');
  const section = (title: string, note: string, list: Pick[], tone: 'up' | 'down') =>
    list.length > 0 && (
      <section className="mt-4" aria-label={title}>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 className={`text-[13px] font-semibold uppercase tracking-[0.08em] ${tone === 'up' ? 'text-[color:var(--up)]' : 'text-[color:var(--down)]'}`}>
            {title} <span className="font-numeric text-[color:var(--ink-4)]">{list.length}</span>
          </h3>
          <span className="text-right text-[11.5px] text-[color:var(--ink-4)]">{note}</span>
        </div>
        <ol className="flex flex-col gap-2">
          {list.map(pick => (
            <CallCard key={pick.id ?? `${pick.direction}-${pick.symbol}`} pick={pick} forecast={pick.explanation_json!.forecast!} horizon={horizon} />
          ))}
        </ol>
      </section>
    );
  return (
    <>
      {section('Buy calls', 'Most likely to beat the market', buys, 'up')}
      {section('Sell calls', 'Most likely to lag it · intraday only', sells, 'down')}
    </>
  );
}

/** How this horizon's calls did in testing, and live so far. */
export function TrackPanel({ test, live, horizon }: { test?: ForecastTest | null; live?: LiveRecord | null; horizon: Horizon }) {
  if (!test) return null;
  const buy = test.buy;
  const sell = test.sell;
  const base = test.base_beat_rate;
  const liveRate = (r?: { calls: number; right: number }) => (r && r.calls > 0 ? pct(r.right / r.calls) : null);
  const buyOk = Boolean(test.buy_edge_confirmed);
  const sellOk = horizon === 1 && Boolean(test.sell_edge_confirmed);
  const confirmed = buyOk || sellOk;
  const badge =
    buyOk && sellOk ? 'Buy and sell edges confirmed' : buyOk ? 'Edge confirmed in testing' : sellOk ? 'Sell edge confirmed' : 'Edge not confirmed';
  return (
    <section className="mt-5 rounded-2xl border border-white/[0.08] px-4 py-3.5" aria-label="How these calls have done">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13.5px] font-semibold">How these calls have done</h3>
        <span
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
            confirmed ? 'bg-[color:var(--up)]/12 text-[color:var(--up)]' : 'bg-white/[0.07] text-[color:var(--ink-2)]'
          }`}
        >
          {badge}
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-[12.5px] sm:grid-cols-3">
        {typeof buy?.beat_rate === 'number' && (
          <div>
            <dt className="text-[11px] text-[color:var(--ink-4)]">Buy calls beat the market</dt>
            <dd className="font-numeric text-[15px] text-white">
              {pct(buy.beat_rate)}
              {typeof base === 'number' && <span className="ml-1 text-[11px] text-[color:var(--ink-4)]">vs {pct(base)} typical</span>}
            </dd>
          </div>
        )}
        {horizon === 1 && typeof sell?.lag_rate === 'number' && (
          <div>
            <dt className="text-[11px] text-[color:var(--ink-4)]">Sell calls lagged it</dt>
            <dd className="font-numeric text-[15px] text-white">
              {pct(sell.lag_rate)}
              {typeof base === 'number' && <span className="ml-1 text-[11px] text-[color:var(--ink-4)]">vs {pct(1 - base)} typical</span>}
            </dd>
          </div>
        )}
        {typeof test.range_coverage === 'number' && (
          <div>
            <dt className="text-[11px] text-[color:var(--ink-4)]">Closed inside the range</dt>
            <dd className="font-numeric text-[15px] text-white">{pct(test.range_coverage)}</dd>
          </div>
        )}
      </dl>
      <p className="mt-3 text-[11.5px] leading-5 text-[color:var(--ink-3)]">
        Tested on {test.days ?? 'hundreds of'} trading sessions{test.first_day && test.last_day ? ` (${monthYear(test.first_day)} to ${monthYear(test.last_day)})` : ''} the model never trained on,
        across the {test.stocks ?? 200} {test.universe ?? 'Nifty 200'} stocks.
        {' '}
        {live && live.calls > 0
          ? `Live so far: buy calls right ${liveRate(live.buy) ?? '–'} of ${live.buy?.calls ?? 0}${horizon === 1 ? `, sell calls right ${liveRate(live.sell) ?? '–'} of ${live.sell?.calls ?? 0}` : ''}.`
          : 'The live record fills in as each call’s window closes.'}
        {' '}Forecasts, not advice; the edge is small and some calls will miss.
      </p>
    </section>
  );
}
