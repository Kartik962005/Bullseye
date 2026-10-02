'use client';

import useSWR from 'swr';
import { fetcher } from '@/lib/client-cache';

/**
 * This stock's fundamentals against the median of its sector.
 *
 * A P/E of 17.9 is meaningless alone. Against a sector median of 29.2 it means
 * "cheaper than three quarters of its peers", which is the thing a reader is
 * actually trying to work out. The daily snapshot already holds the same
 * metrics for ~2,000 stocks, so this is a grouping over data we have.
 *
 * The bar shows percentile within the sector, not the raw value, because raw
 * values across metrics have no common scale.
 */

type PeerMetric = {
  key: string;
  label: string;
  value: number;
  median: number;
  peer_count: number;
  percentile: number;
  lower_is_better: boolean;
  better_than_median: boolean;
};

type PeerResponse = {
  available: boolean;
  reason?: string;
  sector?: string;
  peer_count?: number;
  metrics?: PeerMetric[];
  peers?: Array<{ symbol?: string; name?: string; trailing_pe?: number | null }>;
};

function Shell({ subtitle, children }: { subtitle: string; children: React.ReactNode }) {
  return (
    <section className="sx-card p-6 sm:p-7">
      <div className="mb-5">
        <h3 className="text-[18px] font-semibold tracking-[-0.01em] text-paper">Against its sector</h3>
        <p className="mt-1.5 text-[13px] leading-relaxed text-[#9f99c2]">{subtitle}</p>
      </div>
      {children}
    </section>
  );
}

function formatValue(key: string, value: number) {
  if (key === 'debt_to_equity' || key === 'price_to_book' || key === 'trailing_pe') {
    return value.toFixed(2);
  }
  return `${value.toFixed(1)}%`;
}

export function PeerComparison({ ticker }: { ticker?: string | null }) {
  const { data, error, isLoading } = useSWR<PeerResponse>(
    ticker ? `/api/v1/stocks/${encodeURIComponent(ticker)}/peers` : null,
    fetcher,
    { revalidateOnFocus: false },
  );

  if (!ticker) return null;

  if (isLoading) {
    return (
      <Shell subtitle="Comparing against sector peers…">
        <div className="py-6 text-center font-body text-[11px] uppercase tracking-widest text-paper-muted">
          Loading
        </div>
      </Shell>
    );
  }

  // A missing comparison is explained rather than hidden — "too few peers" is
  // information, an empty panel is not.
  if (error || !data?.available) {
    return (
      <Shell subtitle="No sector comparison available">
        <p className="font-body text-[12px] text-paper-muted">
          {data?.reason || 'Sector data for this stock is not in the daily snapshot yet.'}
        </p>
      </Shell>
    );
  }

  const metrics = data.metrics ?? [];

  return (
    <Shell
      subtitle={`Median of ${data.peer_count} other ${data.sector} stocks in Bullseye's daily snapshot.`}
    >
      <div className="flex flex-col gap-4">
        {metrics.map(metric => {
          const pct = Math.min(100, Math.max(0, metric.percentile * 100));
          return (
            <div key={metric.key}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-body text-[11px] text-paper">{metric.label}</span>
                <span className="font-numeric text-[12px] text-paper-muted">
                  <span className="text-paper">{formatValue(metric.key, metric.value)}</span>
                  {' vs '}
                  {formatValue(metric.key, metric.median)} median
                </span>
              </div>
              <div className="relative mt-2 h-1.5 rounded-full bg-white/[0.08]">
                <div
                  className={`absolute inset-y-0 left-0 rounded-full ${
                    metric.better_than_median ? 'bg-[#3dffa2]/70' : 'bg-[#ff4fa3]/70'
                  }`}
                  style={{ width: `${pct}%` }}
                />
                {/* Median tick at the 50th percentile, so "better or worse than
                    the middle of the sector" is readable without the numbers. */}
                <div className="absolute inset-y-[-3px] left-1/2 w-px bg-white/35" aria-hidden />
              </div>
              <div className="mt-1.5 font-body text-[10px] text-paper-muted">
                Higher than {Math.round(pct)}% of {metric.peer_count} peers
                {metric.lower_is_better ? ' · lower is better here' : ''}
              </div>
            </div>
          );
        })}
      </div>

      {data.peers?.length ? (
        <div className="mt-6 border-t border-hairline pt-4">
          <div className="sx-label">
            Largest peers compared
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {data.peers.map(peer => (
              <span
                key={peer.symbol}
                className="rounded-full bg-white/[0.05] px-3 py-1 font-numeric text-[12px] text-[#c9c3e6]"
              >
                {peer.symbol}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </Shell>
  );
}
