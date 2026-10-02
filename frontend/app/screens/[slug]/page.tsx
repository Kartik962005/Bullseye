'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ALL_SCREENS, buildCustomQueryResult, getRowsForScreen, getScreenBySlug } from '../screen-data';
import ScreenMetricTable from '../ScreenMetricTable';
import StockSearch from '../StockSearch';
import { enrichScreenRows } from '../enrichRows';
import { BullseyeLogo } from '@/components/brand/BullseyeLogo';

/** Median ignores nulls — and beats the mean on skewed financials like P/E. */
function median(values: Array<number | null | undefined>): number | null {
  const clean = values
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function formatStat(value: number | null, suffix = '') {
  return value === null ? '—' : `${value.toFixed(1)}${suffix}`;
}

export default function ScreenDetailPage() {
  const params = useParams<{ slug: string }>();
  const screen = getScreenBySlug(params.slug);
  const initialRows = useMemo(() => getRowsForScreen(params.slug), [params.slug]);
  const [query, setQuery] = useState(screen?.query ?? '');
  const [rows, setRows] = useState(initialRows);
  const [activeTitle, setActiveTitle] = useState(screen?.title ?? 'Stock screen');

  // Newest snapshot date across the rows — states plainly how old the data is.
  const snapshotDate = useMemo(() => {
    const dates = rows
      .map(row => row.technical?.latestDate)
      .filter((value): value is string => typeof value === 'string' && value.length >= 8);
    return dates.length ? dates.sort().at(-1) ?? null : null;
  }, [rows]);

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

  if (!screen) {
    return (
      <main className="flex min-h-screen flex-col items-start justify-center bg-black px-8 font-body text-paper">
        <div className="flex items-center gap-3">
          <span aria-hidden className="h-px w-8 bg-accent/60" />
          <span className="font-body text-[11px] font-medium uppercase tracking-[0.28em] text-accent">404</span>
        </div>
        <h1 className="mt-5 font-display text-[clamp(2rem,4vw,3rem)] leading-tight text-paper">Screen not found</h1>
        <p className="mt-3 max-w-[48ch] font-body text-[14px] leading-7 text-paper-muted">
          That screen slug doesn&apos;t match anything in the library.
        </p>
        <Link
          href="/screens"
          className="mt-7 inline-flex h-12 items-center justify-center rounded-full bg-accent px-7 font-body text-[13px] font-semibold text-black transition duration-300 hover:bg-accent-dim"
        >
          Back to screens
        </Link>
      </main>
    );
  }

  const runCustomQuery = async () => {
    const result = buildCustomQueryResult(query);
    setRows(result.rows);
    setActiveTitle('Custom query result');
    setRows(await enrichScreenRows(result.rows));
  };

  return (
    <main className="bullseye-night relative min-h-screen bg-black font-body text-paper selection:bg-accent/25">
      {/* Ambient scene — same language as the homepage and screener index. */}
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
          {/* Screen header — editorial title with the numbers as a stat rail
              rather than three boxed cards. */}
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
                Preset screen
              </span>
            </div>

            <h1 className="mt-5 max-w-[20ch] font-display text-[clamp(2.2rem,5vw,3.6rem)] font-normal leading-[1.02] text-paper">
              {activeTitle}
            </h1>
            <p className="mt-4 max-w-[62ch] font-body text-[15px] leading-8 text-paper-muted">
              {screen.description}
            </p>

            {/* Honest stat rail. "Avg score" was dropped: the score is a
                derived 50-99 number, so averaging it says nothing about the
                stocks. Medians beat means on skewed financials like P/E. */}
            <div className="mt-8 flex flex-wrap gap-x-12 gap-y-5 border-y border-hairline py-5">
              {[
                ['Results', String(rows.length)],
                ['Median P/E', formatStat(median(rows.map(row => row.pe)))],
                ['Median ROE', formatStat(median(rows.map(row => row.roe)), '%')],
                ['Data as of', snapshotDate ?? '—'],
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

          {/* ── DEFINITION ── moved ABOVE the results. This is what the screen
              IS; you should be able to read and edit the rules without first
              scrolling past a long table, and re-running is the main loop. */}
          <section className="rounded-[22px] border border-hairline p-6 sm:p-7">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div className="flex items-center gap-3">
                <span aria-hidden className="h-px w-8 bg-accent/60" />
                <span className="font-body text-[10px] font-medium uppercase tracking-[0.24em] text-accent">
                  Screen definition
                </span>
              </div>
              <button
                type="button"
                onClick={runCustomQuery}
                className="inline-flex h-10 items-center justify-center rounded-full bg-accent px-6 font-body text-[12px] font-semibold text-black transition duration-300 hover:bg-accent-dim"
              >
                Re-run screen
              </button>
            </div>
            <p className="mt-3 max-w-[62ch] font-body text-[13px] leading-7 text-paper-muted">
              These are the rules this screen applies. Edit them and re-run against the Bullseye
              universe — the results below update in place.
            </p>
            <textarea
              value={query}
              onChange={event => setQuery(event.target.value)}
              spellCheck={false}
              className="mt-5 h-32 w-full resize-y rounded-2xl border border-hairline bg-black/40 p-4 font-numeric text-[13px] leading-6 text-paper outline-none transition placeholder:text-paper-muted/60 focus:border-accent/55"
            />
            <div className="mt-3 font-body text-[11px] leading-6 text-paper-muted/70">
              Columns you can use:{' '}
              <span className="font-numeric text-paper-muted">
                price · trailing_pe · roe · roce · market_cap_cr · debt_to_equity · operating_margin
                · dividend_yield · revenue_growth · profit_growth · rsi14 · ret_1m · vol_ratio
              </span>
            </div>
          </section>

          <ScreenMetricTable rows={rows} query={query} title={activeTitle} />

          {/* Related screens belong AFTER the results — that's when you'd
              reach for a different angle. Was a stub list wedged in a sidebar. */}
          <section>
            <div className="flex items-center gap-3">
              <span aria-hidden className="h-px w-8 bg-accent/60" />
              <span className="font-body text-[11px] font-medium uppercase tracking-[0.28em] text-accent">
                Try another angle
              </span>
            </div>
            <div className="mt-6 grid grid-cols-1 gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
              {ALL_SCREENS.filter(item => item.slug !== screen.slug)
                .slice(0, 9)
                .map(item => (
                  <Link
                    key={item.slug}
                    href={`/screens/${item.slug}`}
                    className="group flex items-baseline justify-between gap-4 border-b border-hairline py-3.5 transition duration-200 hover:border-accent/40"
                  >
                    <span className="font-body text-[13.5px] leading-6 text-paper-muted transition group-hover:text-accent">
                      {item.title}
                    </span>
                    <span
                      aria-hidden
                      className="shrink-0 font-body text-[14px] text-paper-muted/40 transition-transform duration-300 group-hover:translate-x-0.5 group-hover:text-accent"
                    >
                      →
                    </span>
                  </Link>
                ))}
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}
