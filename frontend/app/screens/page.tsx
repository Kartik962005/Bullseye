'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  CATEGORIES,
  SCREENS,
  SECTOR_INFO,
  runSmartSearch,
  type ScreenCategory,
  type SmartSearchResult,
} from './screen-data';
import ResultsTable, { columnsFromSql, crore } from './ResultsTable';
import ScreensShell, { Eyebrow } from './ScreensShell';

type Mode = 'auto' | 'sql';

const AI_EXAMPLES = [
  'Profitable mid caps with P/E under 20 and ROE above 15%',
  'Debt-free companies with growing profits',
  'Banks trading below book value',
  'Small caps near their 52-week high with volume surging',
  'Oversold large caps with RSI under 35',
  'Which sector has done best over the past year?',
  'FMCG stocks with dividend yield above 2%',
  'Sasta aur accha IT stock batao',
];

const SQL_EXAMPLES = [
  'SELECT symbol, name, roe, trailing_pe FROM stock_snapshot WHERE roe > 20 AND trailing_pe BETWEEN 0 AND 20 ORDER BY roe DESC LIMIT 25',
  "SELECT sector, COUNT(*) AS stocks, AVG(ret_1y) AS avg_1y FROM stock_snapshot WHERE sector IS NOT NULL GROUP BY sector ORDER BY avg_1y DESC",
  'SELECT symbol, name, price, high_52w, vol_ratio FROM stock_snapshot WHERE price >= 0.98 * high_52w AND vol_ratio > 1.5 ORDER BY vol_ratio DESC',
];

const FIELDS: Array<[string, string]> = [
  ['price', 'Last close, ₹'],
  ['change_pct', "Today's move, %"],
  ['market_cap_cr', 'Market cap, ₹ crore'],
  ['sector', 'Yahoo sector'],
  ['trailing_pe', 'P/E'],
  ['price_to_book', 'P/B'],
  ['roe', 'Return on equity, %'],
  ['debt_to_equity', 'Debt / equity (ratio)'],
  ['dividend_yield', 'Dividend yield, %'],
  ['revenue_growth', 'Revenue growth, % (qtr YoY)'],
  ['profit_growth', 'Profit growth, % (qtr YoY)'],
  ['operating_margin', 'Operating margin, %'],
  ['profit_margin', 'Net margin, %'],
  ['beta', 'Beta'],
  ['rsi14', 'RSI (14)'],
  ['sma20 · sma50 · sma200', 'Moving averages, ₹'],
  ['ret_1w … ret_1y', 'Returns, %'],
  ['high_52w · low_52w', '52-week range, ₹'],
  ['vol_ratio', 'Volume ÷ 20-day average'],
  ['total_cash · total_debt', '₹'],
];

type SectorStat = {
  sector: string;
  stocks: number;
  median_ret_1y: number | null;
  median_pe: number | null;
  market_cap_cr: number;
  leaders: Array<{ symbol: string; name: string }>;
};

function signed(v: number | null | undefined) {
  if (typeof v !== 'number') return '—';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function cell(v: string | number | null) {
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString('en-IN') : v.toFixed(2);
  return v ?? '—';
}

function ScreenerPage() {
  const params = useSearchParams();
  const initialSql = params.get('sql');
  const initialQ = params.get('q');
  const [mode, setMode] = useState<Mode>(initialSql ? 'sql' : 'auto');
  const [query, setQuery] = useState(initialSql ?? initialQ ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(SmartSearchResult & { prompt: string }) | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [showSql, setShowSql] = useState(false);
  const [copied, setCopied] = useState(false);
  const [category, setCategory] = useState<ScreenCategory | 'All'>('All');
  const [sectors, setSectors] = useState<{ list: SectorStat[]; universe?: number; asOf?: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const resultRef = useRef<HTMLElement | null>(null);
  const autoRan = useRef(false);

  const run = async (text: string, runMode: Mode = mode) => {
    const clean = text.trim();
    if (!clean || busy) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setQuery(clean);
    setBusy(true);
    setFailure(null);
    setShowSql(false);
    const url = new URL(window.location.href);
    url.searchParams.delete(runMode === 'sql' ? 'q' : 'sql');
    url.searchParams.set(runMode === 'sql' ? 'sql' : 'q', clean);
    window.history.replaceState(null, '', url);
    try {
      const data = await runSmartSearch(clean, runMode, controller.signal);
      setResult({ ...data, prompt: clean });
      window.setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setResult(null);
      setFailure((error as Error).message);
    } finally {
      if (abortRef.current === controller) setBusy(false);
    }
  };

  useEffect(() => {
    if (autoRan.current || !(initialSql || initialQ)) return;
    // Mark inside the timer: in development React mounts effects twice and
    // the first timer is cleared, so a flag set here would skip the real run.
    const timer = window.setTimeout(() => {
      autoRan.current = true;
      run(initialSql ?? initialQ ?? '', initialSql ? 'sql' : 'auto');
    }, 0);
    return () => window.clearTimeout(timer);
    // Runs once for a shared or "edit as SQL" link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let alive = true;
    fetch('/api/backend/api/v1/screener/sectors')
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (alive && data?.sectors) setSectors({ list: data.sectors, universe: data.universe, asOf: data.as_of });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const screens = useMemo(() => (category === 'All' ? SCREENS : SCREENS.filter(s => s.category === category)), [category]);
  const examples = mode === 'sql' ? SQL_EXAMPLES : AI_EXAMPLES;
  const rows = result?.rows ?? [];

  const copySql = async () => {
    if (!result?.generated_sql) return;
    try {
      await navigator.clipboard.writeText(result.generated_sql);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <ScreensShell>
      {/* ── Hero + console ─────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[860px] pt-4 text-center sm:pt-8">
        <Eyebrow>Screener{sectors?.universe ? ` · ${sectors.universe.toLocaleString('en-IN')} NSE stocks` : ''}</Eyebrow>
        <h1 className="mt-4 font-display text-[clamp(2.4rem,6vw,4.2rem)] leading-[1.02] tracking-[-0.01em] text-white">
          Find the stocks <em className="nova-gradient-text italic">worth a look.</em>
        </h1>
        <p className="mx-auto mt-4 max-w-[52ch] text-[15px] leading-7 text-[#b9b4d6]">
          Describe what you want in plain English, or Hinglish. Bullseye turns it into a screen over
          today&apos;s prices, fundamentals and technicals, and shows you exactly how it read you.
        </p>

        <form
          className="scr-console mt-8 text-left"
          onSubmit={event => {
            event.preventDefault();
            run(query);
          }}
        >
          <label htmlFor="screen-query" className="sr-only">
            {mode === 'sql' ? 'SQL query' : 'Describe your screen'}
          </label>
          <textarea
            id="screen-query"
            rows={mode === 'sql' ? 4 : 2}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                run(query);
              }
            }}
            className={mode === 'sql' ? 'is-sql' : ''}
            placeholder={
              mode === 'sql'
                ? 'SELECT symbol, name, roe FROM stock_snapshot WHERE roe > 20 ORDER BY roe DESC'
                : 'e.g. profitable small caps with low debt that are near their 52-week high'
            }
            spellCheck={mode !== 'sql'}
          />
          <div className="flex flex-wrap items-center gap-3 px-3 pb-3 pt-1 sm:px-4">
            <div className="sx-seg sx-seg-sm" role="tablist" aria-label="Search mode">
              {(['auto', 'sql'] as const).map(option => (
                <button
                  key={option}
                  type="button"
                  role="tab"
                  aria-selected={mode === option}
                  onClick={() => setMode(option)}
                >
                  {option === 'auto' ? 'Ask AI' : 'SQL'}
                </button>
              ))}
            </div>
            <span className="hidden text-[12px] text-[#7d7799] sm:inline">
              {mode === 'sql' ? 'Read-only SELECT over stock_snapshot' : 'Enter to search · Shift+Enter for a new line'}
            </span>
            <button type="submit" disabled={!query.trim() || busy} className="nova-btn nova-btn-primary ml-auto !h-11 !px-6 !text-[14px] disabled:opacity-50">
              {busy ? <span className="nova-spinner" aria-hidden /> : null}
              {busy ? 'Screening…' : mode === 'sql' ? 'Run SQL' : 'Search'}
            </button>
          </div>
        </form>

        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {examples.map(example => (
            <button
              key={example}
              type="button"
              className="scr-example max-w-full truncate"
              title={example}
              onClick={() => run(example)}
            >
              {mode === 'sql' ? `${example.slice(0, 64)}…` : example}
            </button>
          ))}
        </div>

        {mode === 'sql' && (
          <details className="sx-card mt-5 p-4 text-left">
            <summary className="cursor-pointer text-[13px] text-[#cfc9ea]">Columns you can query</summary>
            <dl className="mt-3 grid gap-x-8 gap-y-1.5 sm:grid-cols-2">
              {FIELDS.map(([field, meaning]) => (
                <div key={field} className="flex items-baseline justify-between gap-4 border-b border-white/[0.05] py-1.5">
                  <dt className="font-numeric text-[12px] text-white">{field}</dt>
                  <dd className="text-right text-[12px] text-[#9f99c2]">{meaning}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </section>

      {/* ── Result ─────────────────────────────────────────────────────── */}
      {(result || failure) && (
        <section ref={resultRef} key={result?.prompt ?? failure} className="scr-reveal mt-12 scroll-mt-24">
          {failure ? (
            <div className="sx-card p-6 text-center">
              <p className="text-[15px] text-white">{failure}</p>
            </div>
          ) : result?.mode === 'answer' || result?.mode === 'unavailable' ? (
            <div className="sx-card mx-auto max-w-[760px] p-6 sm:p-7">
              <Eyebrow>Bullseye AI</Eyebrow>
              <p className="mt-3 text-[16px] leading-7 text-[#ece8ff]">{result.answer ?? result.explanation}</p>
              <div className="mt-5 flex flex-wrap gap-2">
                {AI_EXAMPLES.slice(0, 3).map(example => (
                  <button key={example} type="button" className="scr-example" onClick={() => run(example, 'auto')}>
                    {example}
                  </button>
                ))}
              </div>
            </div>
          ) : result?.error ? (
            <div className="sx-card p-6">
              <Eyebrow>Couldn&apos;t run that</Eyebrow>
              <p className="mt-3 text-[15px] leading-7 text-[#ffc2cf]">{result.error}</p>
              <p className="mt-2 text-[13px] text-[#9f99c2]">Only one read-only SELECT over stock_snapshot is allowed.</p>
            </div>
          ) : result ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="max-w-[70ch]">
                  <Eyebrow>{result.mode === 'sql' ? 'Your SQL' : 'How I read it'}</Eyebrow>
                  <h2 className="mt-2 text-[clamp(1.15rem,2.2vw,1.45rem)] font-medium leading-snug text-white">
                    {result.mode === 'sql'
                      ? `${(rows.length || result.table?.rows.length) ?? 0} result${(rows.length || result.table?.rows.length) === 1 ? '' : 's'} from your query`
                      : result.summary || `“${result.prompt}”`}
                  </h2>
                </div>
                {result.generated_sql && (
                  <div className="flex gap-2">
                    <button type="button" className="sx-btn-ghost !h-9" onClick={() => setShowSql(s => !s)} aria-expanded={showSql}>
                      {showSql ? 'Hide SQL' : 'Show SQL'}
                    </button>
                    {result.mode !== 'sql' && (
                      <button
                        type="button"
                        className="sx-btn-ghost !h-9"
                        onClick={() => {
                          setMode('sql');
                          setQuery(result.generated_sql ?? '');
                          window.scrollTo({ top: 0, behavior: 'smooth' });
                        }}
                      >
                        Edit as SQL
                      </button>
                    )}
                  </div>
                )}
              </div>
              {result.caveat && (
                <p className="scr-note">
                  <span aria-hidden>⚑</span>
                  {result.caveat}
                </p>
              )}
              {showSql && result.generated_sql && (
                <div className="scr-reveal sx-card relative p-4">
                  <button type="button" onClick={copySql} className="sx-btn-ghost absolute right-3 top-3 !h-8 !text-[12px]">
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <pre className="overflow-x-auto whitespace-pre-wrap pr-20 font-numeric text-[12.5px] leading-6 text-[#bfe9ff]">
                    <code>{result.generated_sql}</code>
                  </pre>
                </div>
              )}
              {result.table && !rows.length ? (
                <div className="sx-card overflow-hidden">
                  <div className="scr-scroll">
                    <table className="scr-table">
                      <thead>
                        <tr>
                          {result.table.columns.map((c, i) => (
                            <th key={c} className={i === 0 ? 'scr-sticky' : ''}>
                              {c.replace(/_/g, ' ')}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.table.rows.map((r, i) => (
                          <tr key={i} className="scr-row !cursor-default">
                            {r.map((v, j) => (
                              <td key={j} className={j === 0 ? 'scr-sticky' : ''}>
                                {cell(v)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <ResultsTable rows={rows} columns={columnsFromSql(result.columns)} title={result.summary || result.prompt} />
              )}
            </div>
          ) : null}
        </section>
      )}

      {/* ── Screen library ─────────────────────────────────────────────── */}
      <section className="mt-20">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Eyebrow>Ready-made screens</Eyebrow>
            <h2 className="mt-2 text-[clamp(1.5rem,3vw,2rem)] font-semibold tracking-[-0.02em] text-white">Start from a proven idea</h2>
          </div>
          <div className="sx-seg sx-seg-sm max-w-full overflow-x-auto" role="tablist" aria-label="Screen category">
            {(['All', ...CATEGORIES.map(c => c.id)] as const).map(id => (
              <button key={id} type="button" role="tab" aria-selected={category === id} onClick={() => setCategory(id)}>
                {id}
              </button>
            ))}
          </div>
        </div>
        <div key={category} className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {screens.map((screen, index) => (
            <Link
              key={screen.slug}
              href={`/screens/${screen.slug}`}
              className="scr-tile scr-row"
              style={{ animationDelay: `${Math.min(index, 9) * 30}ms` }}
            >
              <div className="flex items-start justify-between gap-3">
                <span className="sx-label !text-[10px]">{screen.category}</span>
                <span className="scr-tile-arrow" aria-hidden>
                  →
                </span>
              </div>
              <h3 className="mt-3 text-[17px] font-semibold tracking-[-0.01em] text-white">{screen.title}</h3>
              <p className="mt-1.5 text-[13.5px] leading-6 text-[#b9b4d6]">{screen.description}</p>
              <p className="mt-auto pt-4 font-numeric text-[11px] text-[#7d7799]">{screen.rules.join(' · ')}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* ── Sectors ────────────────────────────────────────────────────── */}
      <section className="mt-20">
        <Eyebrow>Browse by sector</Eyebrow>
        <h2 className="mt-2 text-[clamp(1.5rem,3vw,2rem)] font-semibold tracking-[-0.02em] text-white">Start from an industry</h2>
        <p className="mt-2 max-w-[62ch] text-[14px] leading-6 text-[#9f99c2]">
          Median 1-year return and P/E for every stock in the sector{sectors?.asOf ? `, as of the ${sectors.asOf} close` : ''}.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sectors
            ? sectors.list.map((s, index) => {
                const info = SECTOR_INFO[s.sector];
                const tone = (s.median_ret_1y ?? 0) >= 0 ? 'text-[#6ff0b5]' : 'text-[#ff8aa0]';
                return (
                  <Link
                    key={s.sector}
                    href={`/screens/sector/${encodeURIComponent(s.sector)}`}
                    className="scr-tile scr-row"
                    style={{ animationDelay: `${Math.min(index, 9) * 30}ms` }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-white">{info?.label ?? s.sector}</h3>
                        <p className="mt-0.5 text-[12.5px] text-[#9f99c2]">{info?.examples ?? s.sector}</p>
                      </div>
                      <span className="scr-tile-arrow" aria-hidden>
                        →
                      </span>
                    </div>
                    <dl className="mt-4 grid grid-cols-3 gap-2">
                      <div>
                        <dt className="text-[11px] text-[#7d7799]">Stocks</dt>
                        <dd className="font-numeric text-[15px] text-white">{s.stocks}</dd>
                      </div>
                      <div>
                        <dt className="text-[11px] text-[#7d7799]">Median 1Y</dt>
                        <dd className={`font-numeric text-[15px] ${tone}`}>{signed(s.median_ret_1y)}</dd>
                      </div>
                      <div>
                        <dt className="text-[11px] text-[#7d7799]">Median P/E</dt>
                        <dd className="font-numeric text-[15px] text-white">{s.median_pe ? s.median_pe.toFixed(1) : '—'}</dd>
                      </div>
                    </dl>
                    <p className="mt-auto truncate pt-4 text-[12px] text-[#7d7799]">
                      {s.leaders.map(l => l.symbol).join(' · ')} · {crore(s.market_cap_cr)}
                    </p>
                  </Link>
                );
              })
            : Array.from({ length: 6 }, (_, i) => <div key={i} className="sx-skeleton h-[150px]" />)}
        </div>
      </section>

      <p className="mt-16 text-center text-[12px] leading-6 text-[#7d7799]">
        Screens are for research, not recommendations. Data is from the latest market close and Yahoo Finance fundamentals,
        which can be missing or late for smaller companies.
        {' '}
        <Link href="/ask-ai" className="underline underline-offset-4 hover:text-white">
          Ask AI about a single stock
        </Link>
        .
      </p>
    </ScreensShell>
  );
}

export default function ScreensPage() {
  return (
    <Suspense>
      <ScreenerPage />
    </Suspense>
  );
}
