'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { getRowsForSector } from '../../screen-data';
import ScreenMetricTable from '../../ScreenMetricTable';
import StockSearch from '../../StockSearch';
import { enrichScreenRows } from '../../enrichRows';
import { BullseyeLogo } from '@/components/brand/BullseyeLogo';

export default function SectorDetailPage() {
  const params = useParams<{ sector: string }>();
  const sector = decodeURIComponent(params.sector);
  const initialRows = useMemo(() => getRowsForSector(sector), [sector]);
  const [rows, setRows] = useState(initialRows);

  useEffect(() => {
    let cancelled = false;
    setRows(initialRows);
    enrichScreenRows(initialRows).then(nextRows => {
      if (!cancelled) setRows(nextRows);
    });
    return () => {
      cancelled = true;
    };
  }, [initialRows]);

  const averageScore = Math.round(rows.reduce((sum, row) => sum + row.score, 0) / Math.max(rows.length, 1));
  const roceValues = rows.map(row => row.roce).filter((value): value is number => typeof value === 'number');
  const topRoce = roceValues.length ? Math.max(...roceValues).toFixed(1) : '-';

  return (
    <main className="bullseye-night relative min-h-screen bg-black font-body text-paper selection:bg-accent/25">
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 bg-black" />
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(820px 520px at 20% 4%, rgba(52,211,153,0.10), transparent 62%), radial-gradient(680px 460px at 84% 10%, rgba(255,79,163,0.07), transparent 58%)',
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.74) 45%, rgba(0,0,0,0.93) 100%)',
          }}
        />
      </div>

      <div className="relative z-10 min-h-screen">
        <header className="relative z-40 border-b border-hairline bg-black/55 backdrop-blur-xl">
          <div className="mx-auto grid max-w-[1400px] grid-cols-1 items-center gap-4 px-5 py-5 sm:px-8 md:grid-cols-[auto_minmax(240px,1fr)_auto]">
            <Link href="/" className="flex min-w-0 items-center gap-2.5">
              <BullseyeLogo size={24} wordClassName="text-[18px]" />
            </Link>
            <StockSearch compact />
            <Link
              href="/screens"
              className="hidden h-10 items-center justify-center rounded-full bg-accent px-5 font-body text-[13px] font-semibold text-black transition duration-300 hover:bg-accent-dim md:inline-flex"
            >
              All screens
            </Link>
          </div>
        </header>

        <section className="relative z-10 mx-auto flex w-full max-w-[1200px] flex-col gap-10 px-5 py-14 sm:px-8">
          <div>
            <Link
              href="/screens"
              className="inline-flex items-center gap-2 font-body text-[12px] text-paper-muted transition hover:text-accent"
            >
              <span aria-hidden>←</span> All screens
            </Link>

            <div className="mt-6 flex items-center gap-3">
              <span aria-hidden className="h-px w-8 bg-accent/60" />
              <span className="font-body text-[11px] font-medium uppercase tracking-[0.28em] text-accent">
                Sector
              </span>
            </div>

            <h1 className="mt-5 font-display text-[clamp(2.2rem,5vw,3.6rem)] font-normal leading-[1.02] text-paper">
              {sector}
            </h1>
            <p className="mt-4 max-w-[62ch] font-body text-[15px] leading-8 text-paper-muted">
              Stocks loaded from the Bullseye database for this sector, sorted by market cap and
              quality score.
            </p>

            <div className="mt-8 flex flex-wrap gap-x-12 gap-y-5 border-y border-hairline py-5">
              {[
                ['Results', String(rows.length)],
                ['Avg score', String(averageScore)],
                ['Top ROCE', `${topRoce}%`],
              ].map(([label, value]) => (
                <div key={label}>
                  <div className="font-body text-[10px] font-medium uppercase tracking-[0.22em] text-paper-muted">
                    {label}
                  </div>
                  <div className="mt-1.5 font-numeric text-lg leading-none text-paper">{value}</div>
                </div>
              ))}
            </div>
          </div>

          {rows.length ? (
            <ScreenMetricTable rows={rows} query={`Sector: ${sector}`} title={`${sector} stocks`} />
          ) : (
            <div className="rounded-[22px] border border-hairline p-8 text-center">
              <div className="font-display text-[20px] text-paper">Nothing loaded yet</div>
              <p className="mt-2 font-body text-[14px] text-paper-muted">
                No stocks are loaded for this sector in the current snapshot.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
