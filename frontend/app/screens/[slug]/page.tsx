'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { RETIRED_SCREENS, SCREENS, getScreenBySlug, median, runScreenSql, type RunResult } from '../screen-data';
import ResultsTable from '../ResultsTable';
import ScreensShell, { Eyebrow } from '../ScreensShell';

function stat(value: number | null, suffix = '') {
  return value === null ? '—' : `${value.toFixed(1)}${suffix}`;
}

export default function ScreenDetailPage() {
  const { slug } = useParams<{ slug: string }>();
  const screen = getScreenBySlug(slug);
  const [data, setData] = useState<{ slug: string; result: RunResult | null; error?: string } | null>(null);

  useEffect(() => {
    if (!screen) return;
    const controller = new AbortController();
    runScreenSql(screen.sql, controller.signal)
      .then(result => setData({ slug: screen.slug, result }))
      .catch(error => {
        if ((error as Error).name !== 'AbortError') {
          setData({ slug: screen.slug, result: null, error: 'The screener is not responding. It may be waking up; refresh in a few seconds.' });
        }
      });
    return () => controller.abort();
  }, [screen]);

  if (!screen) {
    const retired = RETIRED_SCREENS[slug];
    const instead = retired ? getScreenBySlug(retired.instead) : undefined;
    return (
      <ScreensShell>
        <div className="mx-auto max-w-[640px] py-16 text-center">
          <Eyebrow>{retired ? 'Screen retired' : 'Not found'}</Eyebrow>
          <h1 className="mt-4 text-[clamp(1.8rem,4vw,2.6rem)] font-semibold tracking-[-0.02em] text-white">
            {retired ? retired.title : 'There is no screen here'}
          </h1>
          <p className="mt-4 text-[15px] leading-7 text-[#b9b4d6]">
            {retired && retired.needs
              ? `This screen needs ${retired.needs}, which Bullseye's data doesn't include yet. Rather than show a made-up list, it has been removed.`
              : retired
                ? 'This screen was replaced by a version that runs on real data.'
                : "That link doesn't match any screen in the library."}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            {instead && (
              <Link href={`/screens/${instead.slug}`} className="nova-btn nova-btn-primary !h-11 !text-[14px]">
                Try {instead.title}
              </Link>
            )}
            <Link href="/screens" className="nova-btn nova-btn-ghost !h-11 !text-[14px]">
              All screens
            </Link>
          </div>
        </div>
      </ScreensShell>
    );
  }

  const current = data?.slug === screen.slug ? data : null;
  const rows = current?.result?.rows ?? [];
  const loading = !current;
  const related = SCREENS.filter(s => s.category === screen.category && s.slug !== screen.slug)
    .concat(SCREENS.filter(s => s.category !== screen.category))
    .slice(0, 3);

  return (
    <ScreensShell>
      <Link href="/screens" className="sx-back">
        <span aria-hidden>←</span> Screener
      </Link>

      <header className="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div>
          <Eyebrow>{screen.category} screen</Eyebrow>
          <h1 className="mt-3 text-[clamp(2rem,5vw,3.2rem)] font-semibold leading-[1.05] tracking-[-0.03em] text-white">
            {screen.title}
          </h1>
          <p className="mt-3 max-w-[58ch] text-[16px] leading-7 text-[#b9b4d6]">{screen.description}</p>
        </div>
        <dl className="grid grid-cols-3 gap-6 sm:gap-8">
          {[
            ['Matches', loading ? '…' : String(rows.length)],
            ['Median P/E', loading ? '…' : stat(median(rows.map(r => (r.pe && r.pe > 0 ? r.pe : null))))],
            ['Median ROE', loading ? '…' : stat(median(rows.map(r => r.roe)), '%')],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-[12px] text-[#9f99c2]">{label}</dt>
              <dd className="mt-1 font-numeric text-[22px] text-white">{value}</dd>
            </div>
          ))}
        </dl>
      </header>

      <section className="mt-8 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[13px] text-[#9f99c2]">Rules</span>
          {screen.rules.map(rule => (
            <span key={rule} className="scr-rule">
              {rule}
            </span>
          ))}
          <Link href={`/screens?sql=${encodeURIComponent(screen.sql)}`} className="sx-btn-ghost ml-auto !h-9">
            Tweak in SQL
          </Link>
        </div>
        {screen.note && (
          <p className="scr-note">
            <span aria-hidden>⚑</span>
            {screen.note}
          </p>
        )}
      </section>

      <section className="mt-6">
        {current?.error ? (
          <div className="sx-card p-8 text-center text-[15px] text-white">{current.error}</div>
        ) : (
          <ResultsTable rows={rows} columns={screen.columns} title={screen.title} loading={loading} asOf={current?.result?.as_of} />
        )}
      </section>

      <section className="mt-16">
        <Eyebrow>Try another angle</Eyebrow>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {related.map(item => (
            <Link key={item.slug} href={`/screens/${item.slug}`} className="scr-tile">
              <div className="flex items-start justify-between gap-3">
                <span className="sx-label !text-[10px]">{item.category}</span>
                <span className="scr-tile-arrow" aria-hidden>
                  →
                </span>
              </div>
              <h3 className="mt-3 text-[16px] font-semibold text-white">{item.title}</h3>
              <p className="mt-1 text-[13px] leading-6 text-[#b9b4d6]">{item.description}</p>
            </Link>
          ))}
        </div>
      </section>
    </ScreensShell>
  );
}
