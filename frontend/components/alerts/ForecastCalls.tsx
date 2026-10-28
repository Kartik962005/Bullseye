'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  type Forecast,
  type ForecastTest,
  type Horizon,
  type LiveRecord,
  type Pick,
  type PolicyStats,
  type PublishRules,
  callChance,
  horizonWindow,
  prettyDate,
} from '@/lib/daily-picks';

const money = (n: number) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const signedPct = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(1)}%`;
const monthYear = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

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
  // The forecast runs from the open, so the exit line is a move from the open.
  const against = buy ? forecast.q10 : forecast.q90;
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
        <span>
          Likely {signedPct(forecast.q10)} to {signedPct(forecast.q90)}
        </span>
        <span className="text-[color:var(--down)]">
          Exit {buy ? 'below' : 'above'} {signedPct(against)}
        </span>
        <span className="text-[color:var(--ink-4)]">from the open</span>
      </div>
      {open && (
        <div className="anim-pop border-t border-white/[0.06] px-4 pb-3.5 pt-3 text-[12.5px] leading-5 text-[color:var(--ink-2)]" data-state="open">
          <div className="grid grid-cols-3 gap-2 font-numeric">
            {([
              ['Low case', forecast.q10, forecast.low_price],
              ['Middle', forecast.q50, forecast.mid_price],
              ['High case', forecast.q90, forecast.high_price],
            ] as const).map(([label, move, price]) => (
              <div key={label} className="min-w-0">
                <div className="text-[10.5px] text-[color:var(--ink-4)]">{label}</div>
                {signedPct(move)}
                <span className="block text-[11px] text-[color:var(--ink-4)]">≈ {money(price)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2.5 text-[12px] text-[color:var(--ink-3)]">
            Moves run from the 9:15 AM open to the close {horizon === 1 ? 'the same day' : `on ${endLabel}`}. The prices assume it opens near the
            last close ({money(forecast.reference_close)}); if it opens higher or lower, they shift with it. By {endLabel}, 8 in 10 outcomes in
            testing landed between the low and high case, and the exit line is the 1-in-10 {buy ? 'low' : 'high'}.
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

/** Buy calls, then sell calls (intraday), each with its tested record; a side with no calls says why. */
export function CallLists({
  picks,
  horizon,
  publish,
  notes,
}: {
  picks: Pick[];
  horizon: Horizon;
  publish?: PublishRules | null;
  notes?: { buy?: string; sell?: string } | null;
}) {
  const sections = sidesFor(horizon).map(side => {
    const buy = side === 'buy';
    const list = picks.filter(p => p.direction === (buy ? 'BUY' : 'SELL'));
    const rule = publish?.[side];
    const tested = rule?.confirmed ? rule.confirmation : null;
    const note = notes?.[side];
    if (list.length === 0 && !note) return null;
    const title = buy ? 'Buy calls' : 'Sell calls';
    const base = typical(side, publish);
    const caption =
      tested && typeof tested.right_rate === 'number'
        ? `${buy ? 'Rose' : 'Fell'} ${pct(tested.right_rate)} of the time in testing${base ? ` (typical stock ${pct(base.moved)})` : ''}`
        : buy
          ? 'Most likely to beat the market'
          : 'Most likely to lag it · intraday only';
    return (
      <section key={side} className="mt-4" aria-label={title}>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 className={`text-[13px] font-semibold uppercase tracking-[0.08em] ${buy ? 'text-[color:var(--up)]' : 'text-[color:var(--down)]'}`}>
            {title} {list.length > 0 && <span className="font-numeric text-[color:var(--ink-4)]">{list.length}</span>}
          </h3>
          {list.length > 0 && <span className="text-right text-[11.5px] text-[color:var(--ink-4)]">{caption}</span>}
        </div>
        {list.length > 0 ? (
          <ol className="flex flex-col gap-2">
            {list.map(pick => (
              <CallCard key={pick.id ?? `${pick.direction}-${pick.symbol}`} pick={pick} forecast={pick.explanation_json!.forecast!} horizon={horizon} />
            ))}
          </ol>
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

function testedLine(side: Side, stats: PolicyStats, published: boolean, publish?: PublishRules | null) {
  const buy = side === 'buy';
  const moved = buy ? 'rose' : 'fell';
  const versus = buy ? 'beat' : 'lagged';
  const rates = `${moved} ${pct(stats.right_rate ?? 0)} of the time and ${versus} the market ${pct(stats.market_rate ?? 0)}`;
  if (!published) {
    return `${buy ? 'Buy' : 'Sell'} calls are paused: even the strongest ${rates}, below the ${pct(publish?.bar ?? 0.55)} both must reach to publish.`;
  }
  const base = typical(side, publish);
  const compare = base ? ` A typical stock ${moved} ${pct(base.moved)} and ${versus} it ${pct(base.market)} on the same days.` : '';
  const often =
    typeof stats.calls_per_day === 'number' && typeof stats.days_with_calls === 'number'
      ? ` About ${stats.calls_per_day.toFixed(1)} calls a session, on ${pct(stats.days_with_calls)} of sessions.`
      : '';
  return `Published ${side} calls ${rates}.${compare}${often}`;
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
  const published = sides.filter(side => publish?.[side]?.confirmed);
  const badge = !publish ? null : published.length === 0 ? 'Paused' : published.length === sides.length ? 'Publishing' : `Publishing ${published[0]} calls`;
  const tested = sides
    .map(side => {
      const rule = publish?.[side];
      const stats = rule?.confirmed ? rule.confirmation : rule?.best ?? rule?.confirmation;
      return stats && typeof stats.right_rate === 'number' ? testedLine(side, stats, Boolean(rule?.confirmed), publish) : null;
    })
    .filter(Boolean);
  const worst = published
    .map(side => publish?.[side]?.confirmation?.right_rate)
    .filter((rate): rate is number => typeof rate === 'number');
  const latest = live?.latest;
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
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 text-[12.5px]">
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
          </dl>
          {latest && latest.calls.length > 0 && (
            <div className="mt-3">
              <div className="text-[11px] text-[color:var(--ink-4)]">Last graded session · {prettyDate(latest.date)}</div>
              <ul className="mt-1.5 divide-y divide-white/[0.06] font-numeric text-[12px]">
                {latest.calls.map(call => {
                  const ok = call.moved ?? call.right;
                  return (
                    <li key={`${call.direction}-${call.symbol}`} className="flex items-center gap-2 py-1.5">
                      <span className={`w-9 text-[10.5px] font-semibold ${call.direction === 'BUY' ? 'text-[color:var(--up)]' : 'text-[color:var(--down)]'}`}>
                        {call.direction}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-white">{call.symbol}</span>
                      {typeof call.move_pct === 'number' && <span className="text-[color:var(--ink-2)]">{signedPct(call.move_pct / 100)}</span>}
                      {typeof call.market_pct === 'number' && (
                        <span className="hidden text-[color:var(--ink-4)] sm:inline">market {signedPct(call.market_pct / 100)}</span>
                      )}
                      <span className={`w-14 text-right text-[11px] font-medium ${ok ? 'text-[color:var(--up)]' : 'text-[color:var(--down)]'}`}>
                        {ok ? 'Right' : 'Missed'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <p className="mt-2 text-[11.5px] leading-5 text-[color:var(--ink-3)]">
            Every published call since {live.since ? prettyDate(live.since) : 'launch'}, right or wrong. Moves run from the open; a buy is right when it
            rises, a sell when it falls.
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
        Forecasts, not advice.
        {worst.length > 0 ? ` Even these calls missed about ${pct(1 - Math.min(...worst))} of the time in testing.` : ' Some calls will miss.'}
      </p>
    </section>
  );
}
