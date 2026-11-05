'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  type Forecast,
  type ForecastTest,
  type GradedCall,
  type Horizon,
  type LiveRecord,
  type Pick,
  type PlanStats,
  type PolicyStats,
  type PublishRules,
  type RecentRecord,
  type ScoredSession,
  type SessionLevel,
  callChance,
  horizonWindow,
  isPublished,
  loadSessionLevels,
  prettyDate,
  sessionContext,
} from '@/lib/daily-picks';

const pct = (n: number) => `${Math.round(n * 100)}%`;
const signedPct = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(1)}%`;
/** Small per-trade numbers (an edge of a quarter of a percent) need two decimals. */
const signedPct2 = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(2)}%`;
const pct1 = (n: number) => `${(Math.abs(n) * 100).toFixed(1)}%`;
const monthYear = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

type Side = 'buy' | 'sell';
const sidesFor = (horizon: Horizon): Side[] => (horizon === 1 ? ['buy', 'sell'] : ['buy']);

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
            <>Intraday · {prettyDate(first)}</>
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
          ? 'Enter at the 9:15 AM open and close out by 3:15 PM the same day, before brokers square off intraday trades.'
          : `Enter at the 9:15 AM open on ${prettyDate(first)}, hold to the 3:30 PM close on ${prettyDate(last)}: ${horizon} trading sessions.`}
        {skipped.length > 0 && ` Skips ${skipped.map(h => `${prettyDate(h.day)} (${h.name})`).join(', ')}.`}
        {dataDate ? ` Built from the ${prettyDate(dataDate)} close.` : ''}
      </p>
    </div>
  );
}

/**
 * A price a broker will take: whole ticks, coarser for dearer stocks. NSE ticks
 * run from 1 paisa to 5 rupees by price band; a multiple of these steps is valid
 * under every band (and under the older 5 paise everywhere).
 */
function tick(price: number) {
  const step = price < 1000 ? 0.05 : price < 5000 ? 0.1 : price < 10000 ? 0.5 : price < 20000 ? 1 : 5;
  return Math.round(price / step) * step;
}
function orderPrice(price: number) {
  return `₹${tick(price).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function PlanRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-3 py-2 first:pt-0 last:pb-0 sm:grid-cols-[7.5rem_1fr]">
      <dt className="text-[11.5px] font-medium uppercase tracking-[0.06em] text-[color:var(--ink-4)]">{label}</dt>
      <dd className="text-[12.5px] leading-5 text-[color:var(--ink-2)]">{children}</dd>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] uppercase tracking-[0.06em] text-[color:var(--ink-4)]">{label}</div>
      <div
        className={`font-numeric text-[13.5px] ${tone === 'up' ? 'text-[color:var(--up)]' : tone === 'down' ? 'text-[color:var(--down)]' : 'text-white'}`}
      >
        {value}
      </div>
    </div>
  );
}

// ── Position sizing ─────────────────────────────────────────────────────────

export type Sizing = { capital: number | null; risk: number };
const SIZING_KEY = 'bullseye.sizing.v1';
const RISKS = [0.005, 0.01, 0.02];

function readSizing(): Sizing {
  try {
    const raw = window.localStorage.getItem(SIZING_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    const capital = typeof saved?.capital === 'number' && saved.capital > 0 ? saved.capital : null;
    return { capital, risk: RISKS.includes(saved?.risk) ? saved.risk : 0.01 };
  } catch {
    return { capital: null, risk: 0.01 };
  }
}

function writeSizing(sizing: Sizing) {
  try {
    window.localStorage.setItem(SIZING_KEY, JSON.stringify(sizing));
  } catch {
    // Private windows can refuse storage; sizing still works for this visit.
  }
}

/** How many shares to trade so a stop-out costs the chosen share of capital. */
function shares(sizing: Sizing, price: number, stopPct: number) {
  if (!sizing.capital || !(price > 0) || !(stopPct > 0)) return null;
  const qty = Math.floor((sizing.capital * sizing.risk) / (price * stopPct));
  return qty > 0 ? { qty, value: qty * price, loss: qty * price * stopPct } : { qty: 0, value: 0, loss: 0 };
}

function SizingBar({ sizing, onChange, calls }: { sizing: Sizing; onChange: (next: Sizing) => void; calls: number }) {
  const [text, setText] = useState(sizing.capital ? String(sizing.capital) : '');
  return (
    <div className="mb-2.5 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-3.5 py-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2.5">
        <label className="min-w-[9.5rem] flex-1">
          <span className="mb-1 block text-[11.5px] text-[color:var(--ink-3)]">Your trading capital (₹)</span>
          <input
            inputMode="numeric"
            value={text}
            placeholder="e.g. 100000"
            onChange={event => {
              const clean = event.target.value.replace(/[^\d]/g, '').slice(0, 10);
              setText(clean);
              const capital = Number(clean);
              onChange({ ...sizing, capital: capital > 0 ? capital : null });
            }}
            className="ax-field !h-10 font-numeric"
            aria-label="Trading capital in rupees"
          />
        </label>
        <div>
          <span className="mb-1 block text-[11.5px] text-[color:var(--ink-3)]">Risk per trade</span>
          <div className="sx-seg sx-seg-sm flex" role="radiogroup" aria-label="Risk per trade">
            {RISKS.map(risk => (
              <button key={risk} type="button" role="radio" aria-checked={sizing.risk === risk} onClick={() => onChange({ ...sizing, risk })} className="!px-3">
                {risk * 100}%
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="mt-2 text-[11.5px] leading-[1.15rem] text-[color:var(--ink-3)]">
        {sizing.capital
          ? `Each call below shows how many shares to sell so a stop-out costs about ${rupees(sizing.capital * sizing.risk)}. ` +
            (calls > 1
              ? `All ${calls} are shorts on the same day and can stop out together: at most ${rupees(sizing.capital * sizing.risk * calls)} (${(sizing.risk * calls * 100).toFixed(1)}% of capital) if every stop is hit. Many traders risk 0.5% each when taking them all.`
              : '')
          : 'Enter your capital to see how many shares to trade for each call. Professionals risk a fixed 0.5 to 1% of capital a trade.'}
      </p>
    </div>
  );
}

// ── Live levels after the open ──────────────────────────────────────────────

/** Today's open and latest price for the calls on screen, refreshed each minute during the session. */
function useSessionLevels(symbols: string[], active: boolean) {
  const [levels, setLevels] = useState<{ at: string; data: Record<string, SessionLevel> } | null>(null);
  const key = symbols.join(',');
  useEffect(() => {
    if (!active || !key) return;
    let cancelled = false;
    const load = () =>
      loadSessionLevels(key.split(','))
        .then(result => !cancelled && setLevels({ at: result.as_of, data: result.levels }))
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, key]);
  return active ? levels : null;
}

type Live =
  | { kind: 'skipped'; open: number; gap: number }
  | { kind: 'open' | 'stopped'; open: number; gap: number; stop: number; last: number | null; high: number | null; low: number | null; pnl: number | null };

/** The plan priced from the actual open, as it was tested, and where it stands now. */
function liveState(level: SessionLevel | undefined, forecast: Forecast, buy: boolean, stopPct: number): Live | null {
  if (!level || !level.open) return null;
  const open = level.open;
  const gap = open / forecast.reference_close - 1;
  const plan = forecast.plan;
  if (plan && !buy && gap < -plan.skip_gap) return { kind: 'skipped', open, gap };
  const stop = buy ? open * (1 - stopPct) : open * (1 + stopPct);
  const hit = buy ? level.low !== null && level.low <= stop : level.high !== null && level.high >= stop;
  const pnl = hit ? -stopPct : level.last ? (buy ? level.last / open - 1 : 1 - level.last / open) : null;
  return { kind: hit ? 'stopped' : 'open', open, gap, stop, last: level.last, high: level.high, low: level.low, pnl };
}

function LiveLine({ live, buy, at }: { live: Live; buy: boolean; at?: string }) {
  const time = at ? new Date(at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : null;
  if (live.kind === 'skipped') {
    return (
      <div className="mt-1.5 rounded-xl bg-white/[0.04] px-3 py-2 text-[11.5px] leading-5 text-[color:var(--ink-2)]">
        <span className="font-semibold text-white">Skip today.</span> It opened at {orderPrice(live.open)}, {pct1(live.gap)} below yesterday&apos;s
        close: the plan skips these.
      </div>
    );
  }
  const status =
    live.kind === 'stopped'
      ? { text: `Stopped out ${signedPct(live.pnl ?? 0)}`, tone: 'text-[color:var(--down)]' }
      : live.pnl !== null
        ? { text: `${live.pnl >= 0 ? 'Ahead' : 'Behind'} ${signedPct(live.pnl)}`, tone: live.pnl >= 0 ? 'text-[color:var(--up)]' : 'text-[color:var(--down)]' }
        : { text: 'In the trade', tone: 'text-white' };
  return (
    <div className="mt-1.5 rounded-xl bg-white/[0.04] px-3 py-2 font-numeric text-[11.5px] leading-5 text-[color:var(--ink-2)]">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[color:var(--accent-text)]">Live</span>
        <span>
          Opened <span className="text-white">{orderPrice(live.open)}</span> ({signedPct(live.gap)})
        </span>
        <span aria-hidden className="text-[color:var(--ink-4)]">·</span>
        <span>
          Stop from the open <span className="text-white">{orderPrice(live.stop)}</span>
        </span>
        {live.last !== null && (
          <>
            <span aria-hidden className="text-[color:var(--ink-4)]">·</span>
            <span>Now {orderPrice(live.last)}</span>
          </>
        )}
        <span className={`ml-auto font-semibold ${status.tone}`}>{status.text}</span>
      </div>
      <div className="font-body text-[10.5px] text-[color:var(--ink-4)]">
        {live.kind === 'stopped'
          ? `The day's ${buy ? 'low' : 'high'} reached the stop, so the trade is closed.`
          : `${buy ? 'Sell' : 'Buy back'} by 3:15 PM if the stop isn't hit.`}
        {time ? ` Prices as of ${time}, from Yahoo; check your broker's screen before acting.` : ''}
      </div>
    </div>
  );
}

// ── One call ────────────────────────────────────────────────────────────────

function CallCard({
  pick,
  forecast,
  horizon,
  tested: planTested,
  live,
  liveAt,
  sizing,
}: {
  pick: Pick;
  forecast: Forecast;
  horizon: Horizon;
  tested?: PlanStats | null;
  live: Live | null;
  liveAt?: string;
  sizing: Sizing;
}) {
  const [open, setOpen] = useState(false);
  const buy = pick.direction === 'BUY';
  const chance = callChance(forecast, pick.direction);
  const plan = forecast.plan;
  // Without a tested plan, the stop is the forecast's 1-in-10 bad case from the open.
  const against = buy ? forecast.q10 : forecast.q90;
  const stopPct = plan ? plan.stop_pct : Math.abs(against);
  const close = orderPrice(forecast.reference_close);
  const stopFromClose = plan ? plan.stop_price : forecast.stop_price ?? forecast.reference_close * (1 + against);
  const tested = forecast.tested;
  const testedRate = tested ? tested.call_rate ?? (typeof tested.actual_beat_rate === 'number' ? (buy ? tested.actual_beat_rate : 1 - tested.actual_beat_rate) : null) : null;
  const endLabel = forecast.last_session ? prettyDate(forecast.last_session) : horizon === 1 ? 'the close' : `session ${horizon}`;
  const exitBy = horizon === 1 ? `${buy ? 'Sell' : 'Buy back'} by 3:15 PM` : `Sell at the ${endLabel} close`;
  const act = buy ? 'Buy' : 'Sell';
  const entryPrice = live && live.kind !== 'skipped' ? live.open : forecast.reference_close;
  const size = live?.kind === 'skipped' ? null : shares(sizing, entryPrice, stopPct);
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
      {/* The order at a glance: what to do at the open, where it's wrong, when to get out. */}
      <div className="px-4 pb-3 font-numeric text-[12px] leading-5 sm:pl-[4.6rem]">
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[color:var(--ink-2)]">
          <span className="text-white">{act} at the open</span>
          <span aria-hidden className="text-[color:var(--ink-4)]">·</span>
          <span>
            Stop-loss <span className="text-[color:var(--down)]">{orderPrice(live && live.kind !== 'skipped' ? live.stop : stopFromClose)}</span>{' '}
            <span className="text-[color:var(--ink-4)]">({buy ? '−' : '+'}{pct1(stopPct)})</span>
          </span>
          <span aria-hidden className="text-[color:var(--ink-4)]">·</span>
          <span>No target</span>
          <span aria-hidden className="text-[color:var(--ink-4)]">·</span>
          <span>{exitBy}</span>
        </div>
        {plan && !live && <div className="text-[11.5px] text-[color:var(--ink-4)]">Skip it if it opens below {orderPrice(plan.skip_below)}</div>}
        {forecast.news?.big_news && (
          <div className="mt-1 inline-flex rounded-full bg-[color:var(--down)]/10 px-2 py-0.5 font-body text-[10.5px] text-[color:var(--down)]">
            Big news in the last two days: expect a wilder day
          </div>
        )}
        {size && (
          <div className="text-[11.5px] text-[color:var(--ink-3)]">
            {size.qty > 0 ? (
              <>
                {act} <span className="text-white">{size.qty.toLocaleString('en-IN')}</span> share{size.qty === 1 ? '' : 's'} ({rupees(size.value)}) · a stop-out costs about{' '}
                {rupees(size.loss)}
              </>
            ) : (
              <>One share risks more than your chosen amount here; skip it or raise the risk.</>
            )}
          </div>
        )}
        {live && <LiveLine live={live} buy={buy} at={liveAt} />}
      </div>
      {open && (
        <div className="anim-pop border-t border-white/[0.06] px-4 pb-3.5 pt-3 text-[12.5px] leading-5 text-[color:var(--ink-2)]" data-state="open">
          <dl className="divide-y divide-white/[0.05]">
            <PlanRow label="Entry">
              <span className="text-white">
                {act} at market at the 9:15 AM open{horizon === 1 ? ', as an intraday (MIS) order' : ''}.
              </span>{' '}
              Yesterday&apos;s close was {close}. If your broker takes orders in the 9:00 to 9:08 AM pre-open session, an order there fills at the
              official opening price, the price this was tested on; a market order after 9:15 can fill a little worse.
            </PlanRow>
            {plan && (
              <PlanRow label="Skip if">
                It opens below <span className="text-white">{orderPrice(plan.skip_below)}</span>, {pct1(plan.skip_gap)} under that close. Sells that had
                already fallen that far by the open lost money in testing.
              </PlanRow>
            )}
            <PlanRow label="Stop-loss">
              <span className="text-white">{orderPrice(stopFromClose)}</span>, {pct1(stopPct)} {buy ? 'below' : 'above'} {close}
              {plan ? ', about 1.5× its usual daily move' : ', the 1-in-10 bad case from the open in testing'}. Keep it {pct1(stopPct)}{' '}
              {buy ? 'below' : 'above'} the price you actually {buy ? 'buy' : 'sell'} at
              {live && live.kind !== 'skipped' ? `: ${orderPrice(live.stop)} from today's open` : ''}. Place it as a stop-loss order (SL-M if your
              broker offers it, so it fills even if the price jumps past) as soon as your {buy ? 'buy' : 'sell'} fills.
            </PlanRow>
            <PlanRow label="Target">
              {plan
                ? 'None. In testing, booking profit at any fixed level made less than holding to the close.'
                : 'None. The call was tested from the open to the close, not to a price.'}
            </PlanRow>
            <PlanRow label="Exit">
              {horizon === 1
                ? `${buy ? 'Sell' : 'Buy back'} by 3:15 PM if the stop hasn't been hit, before your broker squares off intraday trades.`
                : `Sell at the close on ${endLabel}, ${horizon} trading sessions after you buy.`}
            </PlanRow>
            <PlanRow label="Trailing stop">Not tested, so keep the stop where you set it.</PlanRow>
            <PlanRow label="Size">
              {size && size.qty > 0 && sizing.capital
                ? `${act} ${size.qty.toLocaleString('en-IN')} share${size.qty === 1 ? '' : 's'}, about ${rupees(size.value)}: a stop-out then costs about ${rupees(size.loss)}, ${((size.loss / sizing.capital) * 100).toFixed(1)}% of your capital (shares are rounded down).`
                : `Risk a fixed share of your capital: shares = (capital × risk %) ÷ (price × ${pct1(stopPct)}). Enter your capital above to have it worked out.`}
            </PlanRow>
          </dl>
          {plan && planTested ? (
            <PlanRecord tested={planTested} />
          ) : tested && testedRate !== null ? (
            <p className="mt-3 rounded-xl bg-white/[0.03] px-3 py-2.5 text-[12px] leading-5 text-[color:var(--ink-3)]">
              Calls with this chance were right {pct(testedRate)} of the time in testing ({tested.samples.toLocaleString('en-IN')} cases). Some will
              miss, so size the trade so a stop-out is a loss you can afford.
            </p>
          ) : null}
          {(forecast.context ?? []).length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-4">
              {(forecast.context ?? []).slice(0, 4).map(note => <li key={note}>{note}</li>)}
            </ul>
          )}
          {(forecast.news?.stories ?? []).length > 0 && (
            <div className="mt-3">
              <div className="text-[11px] text-[color:var(--ink-4)]">In the news · not used by the model, read it before you trade</div>
              <ul className="mt-1 space-y-1">
                {(forecast.news?.stories ?? []).slice(0, 3).map(story => (
                  <li key={story.title} className="text-[12px] leading-5">
                    {story.url ? (
                      <a href={story.url} target="_blank" rel="noopener noreferrer" className="text-[color:var(--ink-2)] hover:underline">
                        {story.title}
                      </a>
                    ) : (
                      story.title
                    )}
                    <span className="text-[color:var(--ink-4)]">
                      {story.source ? ` · ${story.source}` : ''}
                      {story.published
                        ? ` · ${new Date(story.published).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}`
                        : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Link href={`/stock/${encodeURIComponent(pick.symbol)}`} className="mt-2.5 inline-flex text-[12.5px] font-medium text-[color:var(--accent-text)] hover:underline">
            Open {pick.symbol} →
          </Link>
        </div>
      )}
    </li>
  );
}

/** How the sell plan did in testing: per trade, over the latest six months, and taking every call of a day. */
function PlanRecord({ tested }: { tested: PlanStats }) {
  return (
    <div className="mt-3 rounded-xl bg-white/[0.03] px-3 py-2.5 text-[12px] leading-5 text-[color:var(--ink-3)]">
      <div className="text-[11px] text-[color:var(--ink-4)]">
        This plan in testing, {monthYear(tested.first_day)} to {monthYear(tested.last_day)} ({tested.calls.toLocaleString('en-IN')} calls, after{' '}
        {(tested.cost * 100).toFixed(2)}% costs a trade)
      </div>
      <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2">
        <Stat label="Fell" value={pct(tested.moved_rate)} />
        <Stat label="Stopped out" value={pct(tested.stop_rate)} />
        <Stat label="Per trade" value={signedPct2(tested.avg_after_cost)} tone={tested.avg_after_cost >= 0 ? 'up' : 'down'} />
        <Stat label="Average win" value={signedPct(tested.avg_win)} />
        <Stat label="Average loss" value={signedPct(tested.avg_loss)} />
        {tested.recent ? (
          <Stat label="Last 6 months" value={`${signedPct2(tested.recent.avg_after_cost)}`} tone={tested.recent.avg_after_cost >= 0 ? 'up' : 'down'} />
        ) : (
          <Stat label="Worst 1 in 20" value={signedPct(tested.worst_5pct)} />
        )}
      </div>
      {typeof tested.day_win_rate === 'number' && typeof tested.worst_day === 'number' && (
        <p className="mt-2">
          Taking all of a day&apos;s calls: {pct(tested.day_win_rate)} of days made money, the worst day lost {pct1(tested.worst_day)} a call
          {typeof tested.losing_streak === 'number' ? `, and the longest losing run was ${tested.losing_streak} days` : ''}.
        </p>
      )}
      <p className="mt-1">
        The edge is thin: a fill 0.1% worse than the open would cut it to {signedPct2(tested.avg_after_cost - 0.001)} a trade
        {tested.recent && tested.recent.avg_after_cost < 0.001 ? ', and the last six months were about break-even' : ''}. Size every trade so a
        stop-out is a loss you can afford.
      </p>
    </div>
  );
}

/** Buy calls, then sell calls (intraday), each with its tested record; a side with no calls says why. */
export function CallLists({
  picks,
  horizon,
  publish,
  notes,
  targetDate,
}: {
  picks: Pick[];
  horizon: Horizon;
  publish?: PublishRules | null;
  notes?: { buy?: string; sell?: string } | null;
  /** The session the calls are for: live prices are shown while it is trading. */
  targetDate?: string | null;
}) {
  // The calls only render in the open dialog, never on the server, so the saved
  // sizing can be read straight away.
  const [sizing, setSizingState] = useState<Sizing>(() => (typeof window === 'undefined' ? { capital: null, risk: 0.01 } : readSizing()));
  const setSizing = (next: Sizing) => {
    setSizingState(next);
    writeSizing(next);
  };
  const session = useMemo(() => sessionContext(), []);
  const trading = Boolean(targetDate && targetDate === session.today && session.phase === 'open');
  const symbols = useMemo(() => [...new Set(picks.map(p => p.symbol))].sort(), [picks]);
  const levels = useSessionLevels(symbols, trading);

  const sections = sidesFor(horizon).map(side => {
    const buy = side === 'buy';
    const list = picks.filter(p => p.direction === (buy ? 'BUY' : 'SELL'));
    const rule = publish?.[side];
    const tested = rule?.confirmed ? rule.confirmation : null;
    const recent = rule?.confirmed ? rule.recent : null;
    const note = notes?.[side];
    if (list.length === 0 && !note) return null;
    const title = buy ? 'Buy calls' : 'Sell calls';
    const base = typical(side, publish);
    const lately = typeof recent?.right_rate === 'number' ? `, ${pct(recent.right_rate)} over the last 6 months` : '';
    const caption =
      tested && typeof tested.right_rate === 'number'
        ? `${buy ? 'Rose' : 'Fell'} ${pct(tested.right_rate)} of the time in testing${lately}${base ? ` (typical stock ${pct(base.moved)})` : ''}`
        : buy
          ? 'Most likely to beat the market'
          : 'Most likely to lag it · intraday only';
    return (
      <section key={side} className="mt-4" aria-label={title}>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 className={`shrink-0 whitespace-nowrap text-[13px] font-semibold uppercase tracking-[0.08em] ${buy ? 'text-[color:var(--up)]' : 'text-[color:var(--down)]'}`}>
            {title} {list.length > 0 && <span className="font-numeric text-[color:var(--ink-4)]">{list.length}</span>}
          </h3>
          {list.length > 0 && <span className="text-right text-[11.5px] text-[color:var(--ink-4)]">{caption}</span>}
        </div>
        {list.length > 0 ? (
          <>
            <SizingBar sizing={sizing} onChange={setSizing} calls={list.length} />
            <ol className="flex flex-col gap-2">
              {list.map(pick => {
                const forecast = pick.explanation_json!.forecast!;
                const stopPct = forecast.plan ? forecast.plan.stop_pct : Math.abs(buy ? forecast.q10 : forecast.q90);
                return (
                  <CallCard
                    key={pick.id ?? `${pick.direction}-${pick.symbol}`}
                    pick={pick}
                    forecast={forecast}
                    horizon={horizon}
                    tested={rule?.plan}
                    live={horizon === 1 ? liveState(levels?.data[pick.symbol], forecast, buy, stopPct) : null}
                    liveAt={levels?.at}
                    sizing={sizing}
                  />
                );
              })}
            </ol>
          </>
        ) : (
          <p className="rounded-2xl border border-dashed border-white/10 px-4 py-4 text-[12.5px] leading-5 text-[color:var(--ink-2)]">{note}</p>
        )}
      </section>
    );
  });
  if (sections.every(section => section === null)) {
    return (
      <p className="mt-4 rounded-2xl border border-dashed border-white/10 px-4 py-5 text-[13px] leading-6 text-[color:var(--ink-2)]">
        No strong calls for this session.
      </p>
    );
  }
  return <>{sections}</>;
}

/** A typical stock's rate on the same days: rose (buy) or fell (sell), and beat or lagged the average. */
function typical(side: Side, publish?: PublishRules | null) {
  const base = publish?.base;
  if (!base) return null;
  return side === 'buy' ? { moved: base.rose_rate, market: base.beat_rate } : { moved: 1 - base.rose_rate, market: 1 - base.beat_rate };
}

function testedLine(side: Side, stats: PolicyStats, heldUp: boolean, publish?: PublishRules | null) {
  const buy = side === 'buy';
  const moved = buy ? 'rose' : 'fell';
  const versus = buy ? 'beat' : 'lagged';
  const rates = `${moved} ${pct(stats.right_rate ?? 0)} of the time and ${versus} the market ${pct(stats.market_rate ?? 0)}`;
  if (!heldUp) {
    return `${buy ? 'Buy' : 'Sell'} calls are paused: even the strongest ${rates}, below the ${pct(publish?.bar ?? 0.55)} both must reach to publish.`;
  }
  const base = typical(side, publish);
  const compare = base ? ` A typical stock ${moved} ${pct(base.moved)} and ${versus} it ${pct(base.market)} on the same days.` : '';
  const often =
    typeof stats.calls_per_day === 'number' && typeof stats.days_with_calls === 'number'
      ? ` About ${stats.calls_per_day.toFixed(1)} calls a session, on ${pct(stats.days_with_calls)} of sessions.`
      : '';
  return `${buy ? 'Buy' : 'Sell'} calls at this strength ${rates}.${compare}${often}`;
}

/** The latest stretch, which a side must also clear to keep publishing. */
function recentLine(side: Side, recent: RecentRecord, bar: number) {
  if (typeof recent.right_rate !== 'number' || typeof recent.market_rate !== 'number') return null;
  const buy = side === 'buy';
  const span = `Over the last ${recent.sessions} sessions${recent.live_sessions ? ` (${recent.live_sessions} graded live, the rest from testing)` : ''}`;
  const rates = `${buy ? 'rose' : 'fell'} ${pct(recent.right_rate)} and ${buy ? 'beat' : 'lagged'} the market ${pct(recent.market_rate)}`;
  return recent.passes
    ? `${span}, they ${rates}.`
    : `${span}, they ${rates}: below the ${pct(bar)} bar, so ${side} calls are paused until that recovers.`;
}

function planWord(call: GradedCall) {
  if (call.plan === 'skipped') return { text: 'plan skipped', tone: 'text-[color:var(--ink-4)]' };
  if ((call.plan === 'held' || call.plan === 'stopped') && typeof call.plan_pct === 'number') {
    return {
      text: `${call.plan === 'stopped' ? 'stopped ' : 'plan '}${signedPct(call.plan_pct / 100)}`,
      tone: call.plan_pct >= 0 ? 'text-[color:var(--up)]' : 'text-[color:var(--down)]',
    };
  }
  return null;
}

function SessionRow({ session, defaultOpen }: { session: ScoredSession; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const sells = session.calls.filter(c => c.direction === 'SELL');
  const buys = session.calls.filter(c => c.direction === 'BUY');
  const parts = [
    sells.length ? `${sells.filter(c => c.moved).length} of ${sells.length} sell${sells.length === 1 ? '' : 's'} fell` : null,
    buys.length ? `${buys.filter(c => c.moved).length} of ${buys.length} buy${buys.length === 1 ? '' : 's'} rose` : null,
  ].filter(Boolean);
  return (
    <li className="py-1">
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} className="flex w-full items-center gap-2 py-1.5 text-left">
        <span className="w-[5.5rem] shrink-0 text-[12px] text-white">{prettyDate(session.date)}</span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-[color:var(--ink-2)]">{parts.join(', ')}</span>
        {typeof session.plan_avg_pct === 'number' && (
          <span className={`shrink-0 font-numeric text-[11.5px] ${session.plan_avg_pct >= 0 ? 'text-[color:var(--up)]' : 'text-[color:var(--down)]'}`}>
            plan {signedPct(session.plan_avg_pct / 100)}
          </span>
        )}
        <svg viewBox="0 0 20 20" className={`h-3.5 w-3.5 shrink-0 text-[color:var(--ink-4)] transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m5 8 5 5 5-5" />
        </svg>
      </button>
      {open && (
        <ul className="mb-1 divide-y divide-white/[0.05] font-numeric text-[12px]">
          {session.calls.map(call => {
            const ok = call.moved ?? call.right;
            const word = planWord(call);
            return (
              <li key={`${call.direction}-${call.symbol}`} className="flex items-center gap-2 py-1.5 pl-1">
                <span className={`w-9 text-[10.5px] font-semibold ${call.direction === 'BUY' ? 'text-[color:var(--up)]' : 'text-[color:var(--down)]'}`}>
                  {call.direction}
                </span>
                <span className="min-w-0 flex-1 truncate text-white">{call.symbol}</span>
                {typeof call.move_pct === 'number' && <span className="text-[color:var(--ink-2)]">{signedPct(call.move_pct / 100)}</span>}
                {typeof call.market_pct === 'number' && (
                  <span className="hidden text-[color:var(--ink-4)] sm:inline">market {signedPct(call.market_pct / 100)}</span>
                )}
                {word && <span className={`hidden text-[11px] sm:inline ${word.tone}`}>{word.text}</span>}
                <span className={`w-14 text-right text-[11px] font-medium ${ok ? 'text-[color:var(--up)]' : 'text-[color:var(--down)]'}`}>
                  {ok ? 'Right' : 'Missed'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

/** Every graded call, right or wrong, beside how the published calls did in testing. */
export function Scorecard({
  test,
  live,
  publish,
  horizon,
}: {
  test?: ForecastTest | null;
  live?: LiveRecord | null;
  publish?: PublishRules | null;
  horizon: Horizon;
}) {
  const sides = sidesFor(horizon);
  const published = sides.filter(side => isPublished(publish?.[side]));
  const badge = !publish ? null : published.length === 0 ? 'Paused' : published.length === sides.length ? 'Publishing' : `Publishing ${published[0]} calls`;
  const tested = sides.flatMap(side => {
    const rule = publish?.[side];
    const stats = rule?.confirmed ? rule.confirmation : rule?.best ?? rule?.confirmation;
    if (!stats || typeof stats.right_rate !== 'number') return [];
    const recent = rule?.confirmed && rule.recent ? recentLine(side, rule.recent, publish?.bar ?? 0.55) : null;
    return [testedLine(side, stats, Boolean(rule?.confirmed), publish), ...(recent ? [recent] : [])];
  });
  const worst = published
    .flatMap(side => [publish?.[side]?.confirmation?.right_rate, publish?.[side]?.recent?.right_rate])
    .filter((rate): rate is number => typeof rate === 'number');
  const sessions = live?.sessions ?? (live?.latest ? [live.latest] : []);
  const plan = live?.plan;
  return (
    <section className="mt-5 rounded-2xl border border-white/[0.08] px-4 py-3.5" aria-label="Scorecard">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[13.5px] font-semibold">Scorecard</h3>
        {badge && (
          <span
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
              published.length > 0 ? 'bg-[color:var(--up)]/12 text-[color:var(--up)]' : 'bg-white/[0.07] text-[color:var(--ink-2)]'
            }`}
          >
            {badge}
          </span>
        )}
      </div>

      {live && live.calls > 0 ? (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-[12.5px] sm:grid-cols-3">
            {sides.map(side => {
              const record = live[side];
              if (!record) return null;
              const moved = typeof record.moved === 'number' && record.moved_calls ? record.moved : null;
              return (
                <div key={side}>
                  <dt className="text-[11px] text-[color:var(--ink-4)]">{side === 'buy' ? 'Buy calls that rose' : 'Sell calls that fell'}</dt>
                  <dd className="font-numeric text-[15px] text-white">
                    {moved !== null ? `${moved} of ${record.moved_calls}` : '–'}
                  </dd>
                  <dd className="text-[11px] text-[color:var(--ink-4)]">
                    {side === 'buy' ? 'beat' : 'lagged'} the market {record.right} of {record.calls}
                  </dd>
                </div>
              );
            })}
            {plan && plan.taken > 0 && typeof plan.avg_pct === 'number' && (
              <div>
                <dt className="text-[11px] text-[color:var(--ink-4)]">The sell plan, as printed</dt>
                <dd className={`font-numeric text-[15px] ${plan.avg_pct >= 0 ? 'text-[color:var(--up)]' : 'text-[color:var(--down)]'}`}>
                  {signedPct2(plan.avg_pct / 100)} a trade
                </dd>
                <dd className="text-[11px] text-[color:var(--ink-4)]">
                  {plan.taken} taken, {plan.stopped} stopped, {plan.skipped} skipped
                </dd>
              </div>
            )}
          </dl>
          {sessions.length > 0 && (
            <div className="mt-3">
              <div className="text-[11px] text-[color:var(--ink-4)]">Last {sessions.length} graded session{sessions.length === 1 ? '' : 's'}</div>
              <ul className="mt-1 divide-y divide-white/[0.06]">
                {sessions.map((session, index) => (
                  <SessionRow key={session.date} session={session} defaultOpen={index === 0} />
                ))}
              </ul>
            </div>
          )}
          <p className="mt-2 text-[11.5px] leading-5 text-[color:var(--ink-3)]">
            Every published call since {live.since ? prettyDate(live.since) : 'launch'}, right or wrong, graded after the close. Moves run from the open
            to the close; a buy is right when it rises, a sell when it falls. &ldquo;Plan&rdquo; is the printed sell plan after 0.15% costs.
          </p>
        </>
      ) : (
        <p className="mt-2 text-[12.5px] leading-5 text-[color:var(--ink-2)]">
          No graded calls yet. Each call is graded after its window closes, and every result appears here, right or wrong.
        </p>
      )}

      {tested.length > 0 && (
        <div className="mt-3 border-t border-white/[0.06] pt-3 text-[12px] leading-5 text-[color:var(--ink-2)]">
          <div className="text-[11px] text-[color:var(--ink-4)]">
            In testing
            {publish?.first_day && publish?.last_day ? `, ${monthYear(publish.first_day)} to ${monthYear(publish.last_day)}` : ''}
            {test?.stocks ? `, ${test.stocks} ${test.universe ?? 'Nifty 200'} stocks` : ''}
          </div>
          {tested.map(line => (
            <p key={line} className="mt-1">
              {line}
            </p>
          ))}
        </div>
      )}
      <p className="mt-3 text-[11.5px] leading-5 text-[color:var(--ink-3)]">
        Model research, not advice; Bullseye is not registered with SEBI.
        {worst.length > 0 ? ` Even these calls missed about ${pct(1 - Math.min(...worst))} of the time in testing.` : ' Some calls will miss.'}
      </p>
    </section>
  );
}
