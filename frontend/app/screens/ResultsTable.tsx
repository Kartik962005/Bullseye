'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePresence } from '@/components/motion/usePresence';
import type { ScreenMetricRow } from './screen-data';

type Tone = 'signed' | 'plain';
type Column = {
  label: string;
  hint?: string;
  get: (row: ScreenMetricRow) => number | string | null | undefined;
  format: (value: number) => string;
  tone?: Tone;
};

const T = (row: ScreenMetricRow) => row.technical ?? {};

const inr = (v: number) => `₹${v.toLocaleString('en-IN', { maximumFractionDigits: v >= 1000 ? 0 : 2 })}`;
const pct = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
const pctPlain = (v: number) => `${v.toFixed(1)}%`;
const n1 = (v: number) => v.toFixed(1);
const n2 = (v: number) => v.toFixed(2);
const times = (v: number) => `${v.toFixed(1)}×`;
export function crore(v: number) {
  if (v >= 100000) return `₹${(v / 100000).toFixed(2)}L cr`;
  return `₹${Math.round(v).toLocaleString('en-IN')} cr`;
}
function compact(v: number) {
  if (v >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`;
  if (v >= 1e5) return `${(v / 1e5).toFixed(1)}L`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

export const COLUMNS: Record<string, Column> = {
  price: { label: 'Price', get: r => r.cmp, format: inr },
  change: { label: 'Today', get: r => T(r).todayReturnPct, format: pct, tone: 'signed' },
  mcap: { label: 'Market cap', get: r => r.marketCapCr, format: crore },
  pe: { label: 'P/E', hint: 'Price ÷ last 12 months of earnings', get: r => r.pe, format: n1 },
  pb: { label: 'P/B', hint: 'Price ÷ book value per share', get: r => r.priceToBook, format: n2 },
  roe: { label: 'ROE', hint: 'Return on equity', get: r => r.roe, format: pctPlain },
  de: { label: 'Debt / equity', get: r => r.debtToEquity, format: n2 },
  dy: { label: 'Div yield', get: r => r.divYield, format: pctPlain },
  revg: { label: 'Revenue growth', hint: 'Latest quarter vs the same quarter a year ago', get: r => r.revenueGrowth3Yr, format: pct, tone: 'signed' },
  profg: { label: 'Profit growth', hint: 'Latest quarter vs the same quarter a year ago', get: r => r.profitGrowth3Yr, format: pct, tone: 'signed' },
  qeg: { label: 'Qtr earnings growth', hint: 'Latest quarter vs the same quarter a year ago', get: r => r.qtrProfitVar, format: pct, tone: 'signed' },
  opm: { label: 'Op margin', get: r => r.operatingMargin, format: pctPlain },
  npm: { label: 'Net margin', get: r => r.profitMargin, format: pctPlain },
  beta: { label: 'Beta', hint: 'Movement relative to the market (1 = moves with it)', get: r => r.beta, format: n2 },
  rsi: { label: 'RSI 14', get: r => T(r).rsi14, format: n1 },
  mfi: { label: 'MFI 14', get: r => T(r).mfi14, format: n1 },
  ret1w: { label: '1W', get: r => T(r).return1wPct, format: pct, tone: 'signed' },
  ret1m: { label: '1M', get: r => T(r).return1mPct, format: pct, tone: 'signed' },
  ret3m: { label: '3M', get: r => T(r).return3mPct, format: pct, tone: 'signed' },
  ret6m: { label: '6M', get: r => T(r).return6mPct, format: pct, tone: 'signed' },
  ret1y: { label: '1Y', get: r => T(r).return1yPct, format: pct, tone: 'signed' },
  vs52h: { label: 'From 52W high', get: r => T(r).priceVs52WeekHighPct, format: pct, tone: 'signed' },
  vs52l: { label: 'Above 52W low', get: r => T(r).priceVs52WeekLowPct, format: pct },
  high52: { label: '52W high', get: r => T(r).high52Week, format: inr },
  low52: { label: '52W low', get: r => T(r).low52Week, format: inr },
  sma20: { label: '20-DMA', get: r => T(r).sma20, format: inr },
  sma50: { label: '50-DMA', get: r => T(r).sma50, format: inr },
  sma200: { label: '200-DMA', get: r => T(r).sma200, format: inr },
  ema20: { label: '20-EMA', get: r => T(r).ema20, format: inr },
  atr: { label: 'ATR 14', get: r => T(r).atr14, format: inr },
  volume: { label: 'Volume', get: r => T(r).latestVolume, format: compact },
  volx: { label: 'Vol vs avg', hint: "Today's volume ÷ 20-day average", get: r => T(r).volumeRatio20, format: times },
  gap: { label: 'Gap', get: r => T(r).gapPct, format: pct, tone: 'signed' },
};

/** stock_snapshot column → table column, for AI and SQL results. */
const SQL_TO_COLUMN: Record<string, string> = {
  price: 'price', change_pct: 'change', market_cap_cr: 'mcap', market_cap: 'mcap', trailing_pe: 'pe',
  forward_pe: 'pe', price_to_book: 'pb', roe: 'roe', debt_to_equity: 'de', dividend_yield: 'dy',
  revenue_growth: 'revg', profit_growth: 'profg', earnings_quarterly_growth: 'qeg', operating_margin: 'opm',
  profit_margin: 'npm', beta: 'beta', rsi14: 'rsi', mfi14: 'mfi', ret_1w: 'ret1w', ret_1m: 'ret1m',
  ret_3m: 'ret3m', ret_6m: 'ret6m', ret_1y: 'ret1y', high_52w: 'high52', low_52w: 'low52', sma20: 'sma20',
  sma50: 'sma50', sma200: 'sma200', ema20: 'ema20', atr14: 'atr', latest_volume: 'volume',
  volume_sma20: 'volume', vol_ratio: 'volx', gap_pct: 'gap',
};

export function columnsFromSql(sqlColumns: string[] | undefined) {
  const ids = (sqlColumns ?? []).map(c => SQL_TO_COLUMN[c.toLowerCase()]).filter(Boolean);
  const out = ['price', ...ids.filter(id => id !== 'price')];
  if (!out.includes('mcap')) out.push('mcap');
  if (out.length < 4) out.push(...['pe', 'ret1y'].filter(id => !out.includes(id)));
  return [...new Set(out)];
}

const PAGE = 25;

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export default function ResultsTable({
  rows,
  columns,
  title,
  loading = false,
  asOf,
  emptyText = 'No stock passes every rule right now.',
}: {
  rows: ScreenMetricRow[];
  columns: string[];
  title: string;
  loading?: boolean;
  asOf?: string | null;
  emptyText?: string;
}) {
  const router = useRouter();
  const [visible, setVisible] = useState<string[]>(columns);
  const [sort, setSort] = useState<{ id: string; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = usePresence(menuOpen, 160);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // A new screen brings its own column set and order.
  const columnKey = columns.join(',');
  const [prevKey, setPrevKey] = useState(columnKey);
  if (prevKey !== columnKey) {
    setPrevKey(columnKey);
    setVisible(columns);
    setSort(null);
    setLimit(PAGE);
  }

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const esc = (event: KeyboardEvent) => event.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [menuOpen]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = q
      ? rows.filter(r => `${r.stock.name} ${r.stock.symbol} ${r.sector ?? ''}`.toLowerCase().includes(q))
      : rows;
    if (sort) {
      const col = COLUMNS[sort.id];
      list = [...list].sort((a, b) => {
        const x = col.get(a);
        const y = col.get(b);
        if (typeof x !== 'number') return 1;
        if (typeof y !== 'number') return -1;
        return (x - y) * sort.dir;
      });
    }
    return list;
  }, [rows, filter, sort]);

  const cols = visible.filter(id => COLUMNS[id]);

  const toggleSort = (id: string) =>
    setSort(current => (current?.id !== id ? { id, dir: -1 } : current.dir === -1 ? { id, dir: 1 } : null));

  const downloadCsv = () => {
    const header = ['Symbol', 'Name', 'Sector', ...cols.map(id => COLUMNS[id].label)].map(csvCell).join(',');
    const body = shown
      .map(r => [r.stock.symbol, r.stock.name, r.sector ?? '', ...cols.map(id => COLUMNS[id].get(r) ?? '')].map(csvCell).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([`${header}\n${body}`], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bullseye-screen'}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="sx-card overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.07] px-4 py-3 sm:px-5">
        <div className="mr-auto flex items-baseline gap-2">
          <span className="font-numeric text-[15px] text-white">{loading ? '—' : shown.length}</span>
          <span className="text-[13px] text-[#9f99c2]">
            {shown.length === 1 ? 'stock' : 'stocks'}
            {asOf ? <> · close of {asOf}</> : null}
          </span>
        </div>
        <label className="scr-filter">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter results" aria-label="Filter results by name" />
        </label>
        <div ref={menuRef} className="relative">
          <button type="button" className="sx-btn-ghost !h-9" onClick={() => setMenuOpen(o => !o)} aria-expanded={menuOpen}>
            Columns <span className="sx-count">{cols.length}</span>
          </button>
          {menu.mounted && (
            <div data-state={menu.state} className="anim-pop sx-menu !top-11 max-h-[60vh] overflow-y-auto p-2">
              {Object.entries(COLUMNS).map(([id, col]) => {
                const on = visible.includes(id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setVisible(v => (on ? v.filter(x => x !== id) : [...v, id]))}
                    className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[13px] text-[#d9d4f2] hover:bg-white/[0.06]"
                  >
                    {col.label}
                    <span className={`scr-check ${on ? 'is-on' : ''}`} aria-hidden />
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <button type="button" className="sx-btn-ghost !h-9" onClick={downloadCsv} disabled={!shown.length}>
          CSV
        </button>
      </div>

      <div className="scr-scroll">
        <table className="scr-table">
          <thead>
            <tr>
              <th scope="col" className="scr-sticky">Company</th>
              {cols.map(id => {
                const col = COLUMNS[id];
                const active = sort?.id === id;
                return (
                  <th key={id} scope="col" aria-sort={active ? (sort!.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => toggleSort(id)} title={col.hint} className={active ? 'is-active' : ''}>
                      {col.label}
                      <span aria-hidden className="scr-arrow">{active ? (sort!.dir === 1 ? '↑' : '↓') : '↕'}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 8 }, (_, i) => (
                  <tr key={i}>
                    <td className="scr-sticky">
                      <div className="sx-skeleton h-4 w-40" />
                      <div className="sx-skeleton mt-2 h-3 w-20" />
                    </td>
                    {cols.map(id => (
                      <td key={id}>
                        <div className="sx-skeleton ml-auto h-4 w-14" />
                      </td>
                    ))}
                  </tr>
                ))
              : shown.slice(0, limit).map((row, index) => {
                  const href = `/stock/${encodeURIComponent(row.stock.ticker)}`;
                  return (
                    <tr key={row.stock.ticker} onClick={() => router.push(href)} className="scr-row" style={{ animationDelay: `${Math.min(index, 12) * 18}ms` }}>
                      <td className="scr-sticky">
                        <div className="flex items-center gap-3">
                          <span className="font-numeric w-6 shrink-0 text-right text-[11px] text-[#6f6a8f]">{index + 1}</span>
                          <div className="min-w-0">
                            <Link href={href} onClick={e => e.stopPropagation()} className="block max-w-[15rem] truncate text-[14px] font-medium text-white hover:text-[#ff79c0]">
                              {row.stock.name}
                            </Link>
                            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[#8e88b3]">
                              <span className="font-numeric">{row.stock.symbol}</span>
                              {row.sector ? <span className="truncate">· {row.sector}</span> : null}
                            </div>
                          </div>
                        </div>
                      </td>
                      {cols.map(id => {
                        const col = COLUMNS[id];
                        const value = col.get(row);
                        const tone =
                          col.tone === 'signed' && typeof value === 'number' ? (value > 0 ? 'is-up' : value < 0 ? 'is-down' : '') : '';
                        return (
                          <td key={id} className={tone}>
                            {typeof value === 'number' && Number.isFinite(value) ? col.format(value) : <span className="text-[#5d5880]">—</span>}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {!loading && !shown.length && (
          <div className="px-6 py-14 text-center">
            <p className="text-[15px] text-white">{filter ? `Nothing in these results matches “${filter}”.` : emptyText}</p>
            {!filter && <p className="mt-1.5 text-[13px] text-[#9f99c2]">Try loosening one of the conditions.</p>}
          </div>
        )}
      </div>

      {!loading && shown.length > limit && (
        <div className="border-t border-white/[0.07] p-3 text-center">
          <button type="button" className="sx-btn-ghost" onClick={() => setLimit(l => l + PAGE)}>
            Show {Math.min(PAGE, shown.length - limit)} more · {shown.length - limit} left
          </button>
        </div>
      )}
    </div>
  );
}
