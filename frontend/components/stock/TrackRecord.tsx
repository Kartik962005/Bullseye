'use client';

import useSWR from 'swr';
import { fetcher } from '@/lib/client-cache';

/**
 * Every past Bullseye call on this stock, and how it actually resolved.
 *
 * The rest of the page shows the CURRENT verdict, which is unfalsifiable at the
 * moment you read it. This is the falsifiable part: the previous calls, whether
 * they hit target or stopped out, and the hit rate over the closed ones.
 *
 * Two deliberate honesty rules:
 *  - the hit rate is computed over RESOLVED trades only, so open positions can
 *    never inflate it;
 *  - with nothing closed yet we say so plainly rather than rendering 0%, which
 *    would read as "every call lost".
 */

type TrackRecordSignal = {
  id: string;
  run_date?: string | null;
  target_date?: string | null;
  direction?: string | null;
  setup_type?: string | null;
  entry_low?: number | null;
  entry_high?: number | null;
  target_price?: number | null;
  stop_loss?: number | null;
  confidence?: number | null;
  outcome: 'WIN' | 'LOSS' | 'NEUTRAL' | 'PENDING';
  realized_r?: number | null;
};

type TrackRecordResponse = {
  symbol: string;
  signals: TrackRecordSignal[];
  summary: {
    total: number;
    resolved: number;
    pending: number;
    wins: number;
    losses: number;
    neutral: number;
    hit_rate: number | null;
    avg_realized_r: number | null;
  };
};

const OUTCOME_STYLE: Record<string, string> = {
  WIN: 'border-[#3dffa2]/30 bg-[#3dffa2]/10 text-[#6ff0b5]',
  LOSS: 'border-[#ff5c7a]/30 bg-[#ff5c7a]/10 text-[#ff8aa0]',
  NEUTRAL: 'border-white/10 bg-white/[0.04] text-[#b9b4d6]',
  PENDING: 'border-[#ff4fa3]/30 bg-[#ff4fa3]/10 text-[#ff79c0]',
};

const OUTCOME_LABEL: Record<string, string> = {
  WIN: 'Hit target',
  LOSS: 'Stopped out',
  NEUTRAL: 'Neither hit',
  PENDING: 'Open',
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="sx-card p-6 sm:p-7">
      <div className="mb-5">
        <h3 className="text-[18px] font-semibold tracking-[-0.01em] text-paper">Our track record here</h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[#9f99c2]">
          Past Bullseye calls on this stock and how each one resolved. Hit rate counts
          closed calls only.
        </p>
      </div>
      {children}
    </section>
  );
}

export function TrackRecord({ symbol, currency = '₹' }: { symbol?: string | null; currency?: string }) {
  const clean = (symbol || '').replace('.NS', '').replace('.BO', '').toUpperCase();
  const { data, error, isLoading } = useSWR<TrackRecordResponse>(
    clean ? `/api/v1/stocks/${encodeURIComponent(clean)}/track-record` : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  if (!clean) return null;

  if (isLoading) {
    return (
      <Shell>
        <div className="py-6 text-center font-body text-[11px] uppercase tracking-widest text-paper-muted">
          Loading past calls…
        </div>
      </Shell>
    );
  }

  if (error) {
    return (
      <Shell>
        <p className="font-body text-[12px] text-paper-muted">
          Couldn&apos;t load the track record right now.
        </p>
      </Shell>
    );
  }

  const signals = data?.signals ?? [];
  const summary = data?.summary;

  if (!signals.length) {
    return (
      <Shell>
        <p className="font-body text-[12px] leading-relaxed text-paper-muted">
          Bullseye hasn&apos;t issued a signal on {clean} yet. Once it does, every call and
          its outcome will be listed here — including the ones that lost.
        </p>
      </Shell>
    );
  }

  const hitRate = summary?.hit_rate;
  const resolved = summary?.resolved ?? 0;

  return (
    <Shell>
      <div className="mb-6 flex flex-wrap gap-x-10 gap-y-4">
        <div>
          <div className="sx-label">
            Hit rate
          </div>
          <div className="mt-1.5 font-numeric text-[26px] leading-none text-paper">
            {hitRate === null || hitRate === undefined
              ? '—'
              : `${Math.round(hitRate * 100)}%`}
          </div>
          <div className="mt-1 text-[12px] text-[#8f89ad]">
            {resolved > 0 ? `over ${resolved} closed call${resolved === 1 ? '' : 's'}` : 'nothing closed yet'}
          </div>
        </div>
        <div>
          <div className="sx-label">
            Average R
          </div>
          <div className="mt-1.5 font-numeric text-[26px] leading-none text-paper">
            {summary?.avg_realized_r === null || summary?.avg_realized_r === undefined
              ? '—'
              : summary.avg_realized_r.toFixed(2)}
          </div>
          <div className="mt-1 text-[12px] text-[#8f89ad]">per closed call</div>
        </div>
        <div>
          <div className="sx-label">
            Calls
          </div>
          <div className="mt-1.5 font-numeric text-[26px] leading-none text-paper">{summary?.total ?? signals.length}</div>
          <div className="mt-1 text-[12px] text-[#8f89ad]">
            {summary?.pending ? `${summary.pending} still open` : 'all closed'}
          </div>
        </div>
      </div>

      {resolved === 0 && (
        <p className="mb-5 rounded-xl border border-accent/25 bg-accent/[0.06] px-4 py-3 font-body text-[11px] leading-relaxed text-paper-muted">
          None of these have reached their target date yet, so there is no hit rate to
          report. Outcomes are recorded automatically after each target date closes.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {signals.map(signal => {
          const style = OUTCOME_STYLE[signal.outcome] ?? OUTCOME_STYLE.NEUTRAL;
          return (
            <li
              key={signal.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white/[0.035] px-4 py-3 transition hover:bg-white/[0.06]"
            >
              <div className="min-w-0">
                <div className="font-numeric text-[13px] text-paper">
                  {signal.direction} · target {currency}
                  {Number(signal.target_price ?? 0).toLocaleString()} · stop {currency}
                  {Number(signal.stop_loss ?? 0).toLocaleString()}
                </div>
                <div className="mt-1 font-body text-[10px] uppercase tracking-wider text-paper-muted">
                  for {signal.target_date ?? '—'}
                  {signal.setup_type ? ` · ${String(signal.setup_type).replace(/_/g, ' ')}` : ''}
                  {typeof signal.confidence === 'number'
                    ? ` · ${Math.round(signal.confidence * 100)}% confidence`
                    : ''}
                </div>
              </div>
              <div className="flex items-center gap-3">
                {typeof signal.realized_r === 'number' && (
                  <span className="font-numeric text-[12px] text-paper-muted">
                    {signal.realized_r > 0 ? '+' : ''}
                    {signal.realized_r.toFixed(2)}R
                  </span>
                )}
                <span
                  className={`rounded-full border px-3 py-1 font-body text-[9px] font-semibold uppercase tracking-widest ${style}`}
                >
                  {OUTCOME_LABEL[signal.outcome] ?? signal.outcome}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </Shell>
  );
}
