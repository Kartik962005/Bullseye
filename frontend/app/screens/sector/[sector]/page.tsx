'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { LEGACY_SECTORS, SECTOR_INFO, median, runScreenSql, sqlString, type RunResult } from '../../screen-data';
import ResultsTable from '../../ResultsTable';
import ScreensShell, { Eyebrow } from '../../ScreensShell';

const SIZES = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'large', label: 'Large cap', test: (cap: number) => cap >= 100000 },
  { id: 'mid', label: 'Mid cap', test: (cap: number) => cap >= 30000 && cap < 100000 },
  { id: 'small', label: 'Small cap', test: (cap: number) => cap < 30000 },
] as const;

const COLUMNS = ['price', 'change', 'mcap', 'pe', 'roe', 'dy', 'ret1m', 'ret1y'];

function signed(v: number | null) {
  return v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

export default function SectorDetailPage() {
  const params = useParams<{ sector: string }>();
  const raw = decodeURIComponent(params.sector);
  const sector = LEGACY_SECTORS[raw] ?? raw;
  const info = SECTOR_INFO[sector];
  const [data, setData] = useState<{ sector: string; result: RunResult | null; error?: string } | null>(null);
  const [size, setSize] = useState<(typeof SIZES)[number]['id']>('all');

  useEffect(() => {
    const controller = new AbortController();
    runScreenSql(
      `SELECT symbol, name FROM stock_snapshot WHERE sector = ${sqlString(sector)} ORDER BY COALESCE(market_cap_cr, 0) DESC LIMIT 400`,
      controller.signal,
    )
      .then(result => setData({ sector, result }))
      .catch(error => {
        if ((error as Error).name !== 'AbortError') {
          setData({ sector, result: null, error: 'The screener is not responding. It may be waking up; refresh in a few seconds.' });
        }
      });
    return () => controller.abort();
  }, [sector]);

  const current = data?.sector === sector ? data : null;
  const all = useMemo(() => current?.result?.rows ?? [], [current]);
  const rows = useMemo(() => {
    const bucket = SIZES.find(s => s.id === size)!;
    return all.filter(r => (size === 'all' ? true : typeof r.marketCapCr === 'number' && bucket.test(r.marketCapCr)));
  }, [all, size]);
  const loading = !current;
  const best = useMemo(
    () => [...all].filter(r => typeof r.technical?.return1yPct === 'number' && (r.marketCapCr ?? 0) > 1000)
      .sort((a, b) => (b.technical!.return1yPct as number) - (a.technical!.return1yPct as number))[0],
    [all],
  );

  return (
    <ScreensShell>
      <Link href="/screens" className="sx-back">
        <span aria-hidden>←</span> Screener
      </Link>

      <header className="mt-6">
        <Eyebrow>Sector</Eyebrow>
        <h1 className="mt-3 text-[clamp(2rem,5vw,3.2rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-white">
          {info?.label ?? sector}
        </h1>
        <p className="mt-3 max-w-[60ch] text-[16px] leading-7 text-[#b9b4d6]">
          {info ? `${info.examples}. ` : ''}Every NSE stock Yahoo Finance files under “{sector}”, largest first.
          {raw !== sector ? ` (“${raw}” is now part of this sector.)` : ''}
        </p>
      </header>

      <dl className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          ['Stocks', loading ? '…' : String(all.length), ''],
          ['Median 1Y return', loading ? '…' : signed(median(all.map(r => r.technical?.return1yPct))), ''],
          ['Median P/E', loading ? '…' : (median(all.map(r => (r.pe && r.pe > 0 ? r.pe : null)))?.toFixed(1) ?? '—'), ''],
          ['Best 1Y (over ₹1,000 cr)', loading ? '…' : best ? best.stock.symbol : '—', best ? signed(best.technical?.return1yPct ?? null) : ''],
        ].map(([label, value, extra]) => (
          <div key={label} className="sx-card px-4 py-3.5">
            <dt className="text-[12px] text-[#9f99c2]">{label}</dt>
            <dd className="mt-1 flex items-baseline gap-2 font-numeric text-[20px] text-white">
              {value}
              {extra ? <span className="text-[13px] text-[#6ff0b5]">{extra}</span> : null}
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-8 flex flex-wrap items-center gap-3">
        <div className="sx-seg sx-seg-sm" role="tablist" aria-label="Company size">
          {SIZES.map(s => (
            <button key={s.id} type="button" role="tab" aria-selected={size === s.id} onClick={() => setSize(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <span className="text-[12px] text-[#7d7799]">Large ≥ ₹1L cr · Mid ₹30,000 cr–₹1L cr · Small under ₹30,000 cr</span>
      </div>

      <section className="mt-4">
        {current?.error ? (
          <div className="sx-card p-8 text-center text-[15px] text-white">{current.error}</div>
        ) : (
          <ResultsTable
            rows={rows}
            columns={COLUMNS}
            title={`${sector} stocks`}
            loading={loading}
            asOf={current?.result?.as_of}
            emptyText={all.length ? 'No stocks of this size in the sector.' : 'No stocks are filed under this sector.'}
          />
        )}
      </section>
    </ScreensShell>
  );
}
