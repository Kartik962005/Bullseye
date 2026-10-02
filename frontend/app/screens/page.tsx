'use client';

import Link from 'next/link';
import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  ALL_SCREENS,
  SCREEN_SECTIONS,
  buildCustomQueryResult,
  getAvailableSectors,
  getRowsForScreen,
  getScreenBySlug,
  getRowsForSector,
  type Stock,
  type ScreenMetricRow,
} from './screen-data';
import StockSearch from './StockSearch';
import { STOCKS } from '../stocks';
import { enrichScreenRows } from './enrichRows';
import { Button } from '@/components/ui';
import { BullseyeLogo } from '@/components/brand/BullseyeLogo';

const BACKEND = '/api/backend';

type ScreenMode = 'auto' | 'nl' | 'sql';

type AggregateTableData = { columns: string[]; rows: (string | number | null)[][] };

type QueryResult = {
  title: string;
  query: string;
  rows: ScreenMetricRow[];
  explanation?: string;
  source?: string;
  intent?: SmartSearchIntent;
  generatedSql?: string;
  mode?: string;
  error?: string;
  table?: AggregateTableData;
};

type SmartSearchIntent = 'CUSTOM_FILTER' | 'PRE_DEFINED_SCREENER' | 'STOCK_INFO' | 'SECTOR_FILTER' | 'GENERAL_CHAT';

type SmartSearchResponse = {
  router?: {
    intent?: SmartSearchIntent;
    screener_name?: string | null;
    stock_symbol?: string | null;
    sector?: string | null;
    custom_query_parameters?: Record<string, unknown>;
    ai_response_message?: string;
  };
  rows: ScreenMetricRow[];
  matchedRules?: string[];
  explanation?: string;
  source?: string;
  // Phase 1 intelligent screener fields:
  generated_sql?: string;
  mode?: string;
  error?: string;
  table?: AggregateTableData;
  count?: number;
};

const examples = [
  'Small cap stocks with maximum gain in the last 1 week',
  'Stocks with today volume more than 2 times 10 day average volume',
  'Oversold stocks with RSI below 30 and volume higher than last week average',
  'Stocks trading above 20 DMA, 50 DMA, and 200 DMA',
  'Stocks near 52 week high with strong weekly gain',
  'Stocks with price breakout, volume breakout, and RSI above 60',
];

// Examples grouped by what you're actually trying to do, so the console
// teaches the query surface instead of hiding six strings behind a <details>.
const EXAMPLE_GROUPS: Array<{ label: string; items: string[] }> = [
  {
    label: 'Momentum',
    items: [
      'Small cap stocks with maximum gain in the last 1 week',
      'Stocks near 52 week high with strong weekly gain',
    ],
  },
  {
    label: 'Mean reversion',
    items: [
      'Oversold stocks with RSI below 30 and volume higher than last week average',
      'Stocks trading above 20 DMA, 50 DMA, and 200 DMA',
    ],
  },
  {
    label: 'Quality',
    items: [
      'Profitable stocks under PE 20 with ROE above 15 and low debt',
      'Companies with operating margin above 25% and debt to equity below 0.5',
    ],
  },
  {
    label: 'Volume',
    items: [
      'Stocks with today volume more than 2 times 10 day average volume',
      'Stocks with price breakout, volume breakout, and RSI above 60',
    ],
  },
];

// The real columns of `stock_snapshot`. SQL mode previously shipped with a
// placeholder and no way to discover what you could query — this is the
// reference, grouped the way you'd reach for them.
const SCHEMA_GROUPS: Array<{ label: string; fields: Array<[string, string]> }> = [
  {
    label: 'Identity',
    fields: [
      ['symbol', 'NSE symbol'],
      ['name', 'Company name'],
      ['ticker', 'Yahoo ticker'],
      ['latest_date', 'Snapshot date'],
    ],
  },
  {
    label: 'Price & size',
    fields: [
      ['price', 'Last close'],
      ['change_pct', 'Session change %'],
      ['market_cap_cr', 'Market cap (₹ cr)'],
      ['high_52w', '52-week high'],
      ['low_52w', '52-week low'],
      ['gap_pct', 'Gap %'],
    ],
  },
  {
    label: 'Fundamentals',
    fields: [
      ['trailing_pe', 'P/E'],
      ['roe', 'Return on equity %'],
      ['roce', 'Return on capital %'],
      ['debt_to_equity', 'Debt / equity'],
      ['operating_margin', 'Operating margin %'],
      ['dividend_yield', 'Dividend yield %'],
      ['revenue_growth', 'Revenue growth %'],
      ['profit_growth', 'Profit growth %'],
    ],
  },
  {
    label: 'Technicals',
    fields: [
      ['rsi14', 'RSI (14)'],
      ['mfi14', 'MFI (14)'],
      ['atr14', 'ATR (14)'],
      ['sma20', 'SMA 20'],
      ['sma50', 'SMA 50'],
      ['sma200', 'SMA 200'],
      ['ema20', 'EMA 20'],
      ['vol_ratio', 'Volume vs average'],
    ],
  },
  {
    label: 'Returns',
    fields: [
      ['ret_1w', '1-week return %'],
      ['ret_1m', '1-month return %'],
      ['ret_3m', '3-month return %'],
      ['ret_6m', '6-month return %'],
      ['ret_1y', '1-year return %'],
    ],
  },
];

function candidateStocksForPrompt(prompt: string) {
  const lower = prompt.toLowerCase();
  if (/\b(us|usa|nasdaq|nyse|america|american)\b/.test(lower)) {
    return STOCKS.filter(stock => stock.exchange === 'NASDAQ' || stock.exchange === 'NYSE');
  }
  return STOCKS.filter(stock => stock.exchange === 'NSE');
}

async function runSmartScreener(prompt: string, stocks: Stock[], sectors: ReturnType<typeof getAvailableSectors>, mode: ScreenMode = 'auto') {
  const response = await fetch(`${BACKEND}/api/v1/screener/smart-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      mode,
      stocks,
      screeners: ALL_SCREENS.map(screen => ({
        slug: screen.slug,
        title: screen.title,
        query: screen.query,
        tags: screen.tags,
      })),
      sectors,
    }),
  });
  if (!response.ok) {
    throw new Error(await response.text().catch(() => 'Smart screener failed'));
  }
  return response.json() as Promise<SmartSearchResponse>;
}

type TableColumn = {
  id: string;
  label: string;
  removable?: boolean;
  value: (row: ScreenMetricRow, index: number) => string | number | null | undefined;
  render?: (row: ScreenMetricRow, index: number) => ReactNode;
};

function formatCellValue(value: string | number | null | undefined) {
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString('en-IN') : value.toFixed(2);
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function GeneratedSqlPanel({ sql, mode }: { sql: string; mode?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — no-op */
    }
  };
  return (
    <div className="mb-4 rounded-2xl border border-slate-800 bg-slate-900 px-4 py-3 shadow-inner">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-body text-[10px] font-black uppercase tracking-widest text-cyan-300">
          {mode === 'sql' ? 'Your SQL' : 'Generated SQL'}
        </span>
        <button
          type="button"
          onClick={copy}
          className="rounded-md border border-white/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-200 transition hover:bg-white/10"
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto text-xs leading-relaxed text-emerald-200 font-numeric"><code>{sql}</code></pre>
    </div>
  );
}

function AggregateTable({ table }: { table: AggregateTableData }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-hairline">
      <table className="w-full min-w-[360px] text-left">
        <thead>
          <tr className="border-b border-hairline bg-white/[0.03]">
            {table.columns.map(column => (
              <th key={column} className="px-4 py-3 font-body text-[10px] font-medium uppercase tracking-[0.18em] text-paper-muted">{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-white/[0.05] transition-colors hover:bg-white/[0.035]">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-4 py-3 font-numeric text-[13px] text-paper">{formatCellValue(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function inferRequestedColumns(rows: ScreenMetricRow[], query: string) {
  const lower = query.toLowerCase();
  const requested = new Set<string>();
  rows.forEach(row => row.technical?.requestedMetrics?.forEach(metric => requested.add(metric)));
  if (/\b(rsi|oversold|overbought)\b/.test(lower)) requested.add('rsi14');
  if (/\b(mfi|money flow index)\b/.test(lower)) requested.add('mfi14');
  if (/\b(sma|dma|moving average)\b/.test(lower)) {
    requested.add('sma20');
    requested.add('sma50');
    if (/\b200\b|long term|long-term/.test(lower)) requested.add('sma200');
  }
  if (/\b(ema|exponential moving average)\b/.test(lower)) requested.add('ema20');
  if (/\b(52 week|near high|new high)\b/.test(lower)) {
    requested.add('high52Week');
    requested.add('priceVs52WeekHighPct');
  }
  if (/\b(today|intraday|gap up|gap down)\b/.test(lower)) requested.add('todayReturnPct');
  if (/\b(1 week|one week|7 days|last week|weekly)\b/.test(lower)) requested.add('return1wPct');
  if (/\b(1 month|one month|monthly|last month)\b/.test(lower)) requested.add('return1mPct');
  if (/\b(3 months|three months|quarter|3-month)\b/.test(lower)) requested.add('return3mPct');
  if (/\b(6 months|six months|doubled|double)\b/.test(lower)) requested.add('return6mPct');
  if (/\b(1 year|one year|ytd)\b/.test(lower)) requested.add('return1yPct');
  if (/\b(volume|delivery|liquid)\b/.test(lower)) {
    requested.add('latestVolume');
    requested.add('volumeRatio20');
  }
  if (/\b(atr|volatility)\b/.test(lower)) requested.add('atr14');
  return requested;
}

function csvEscape(value: string | number | null | undefined) {
  const text = formatCellValue(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function technicalValue(row: ScreenMetricRow, metricId: string) {
  const existing = row.technical?.[metricId as keyof NonNullable<ScreenMetricRow['technical']>];
  return typeof existing === 'number' ? existing : undefined;
}

function MetricTable({ rows, query, title }: { rows: ScreenMetricRow[]; query: string; title: string }) {
  const [tableZoom, setTableZoom] = useState(0.78);
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => new Set());
  const changeZoom = (delta: number) => setTableZoom(current => Math.min(1.15, Math.max(0.55, Number((current + delta).toFixed(2)))));

  const columns = useMemo<TableColumn[]>(() => {
    const technicalColumns: Record<string, TableColumn> = {
      rsi14: { id: 'rsi14', label: 'RSI 14', removable: true, value: row => technicalValue(row, 'rsi14') },
      mfi14: { id: 'mfi14', label: 'MFI 14', removable: true, value: row => technicalValue(row, 'mfi14') },
      sma20: { id: 'sma20', label: 'SMA 20', removable: true, value: row => technicalValue(row, 'sma20') },
      sma50: { id: 'sma50', label: 'SMA 50', removable: true, value: row => technicalValue(row, 'sma50') },
      sma200: { id: 'sma200', label: 'SMA 200', removable: true, value: row => technicalValue(row, 'sma200') },
      ema20: { id: 'ema20', label: 'EMA 20', removable: true, value: row => technicalValue(row, 'ema20') },
      high52Week: { id: 'high52Week', label: '52W High', removable: true, value: row => technicalValue(row, 'high52Week') },
      priceVs52WeekHighPct: { id: 'priceVs52WeekHighPct', label: 'Vs 52W High %', removable: true, value: row => technicalValue(row, 'priceVs52WeekHighPct') },
      todayReturnPct: { id: 'todayReturnPct', label: 'Today %', removable: true, value: row => technicalValue(row, 'todayReturnPct') },
      return1wPct: { id: 'return1wPct', label: '1W %', removable: true, value: row => technicalValue(row, 'return1wPct') },
      return1mPct: { id: 'return1mPct', label: '1M %', removable: true, value: row => technicalValue(row, 'return1mPct') },
      return3mPct: { id: 'return3mPct', label: '3M %', removable: true, value: row => technicalValue(row, 'return3mPct') },
      return6mPct: { id: 'return6mPct', label: '6M %', removable: true, value: row => technicalValue(row, 'return6mPct') },
      return1yPct: { id: 'return1yPct', label: '1Y %', removable: true, value: row => technicalValue(row, 'return1yPct') },
      latestVolume: { id: 'latestVolume', label: 'Volume', removable: true, value: row => technicalValue(row, 'latestVolume') },
      volumeRatio20: { id: 'volumeRatio20', label: 'Vol/20D', removable: true, value: row => technicalValue(row, 'volumeRatio20') },
      atr14: { id: 'atr14', label: 'ATR 14', removable: true, value: row => technicalValue(row, 'atr14') },
    };
    const activeTechnicalColumns = [...inferRequestedColumns(rows, query)]
      .map(id => technicalColumns[id])
      .filter((column): column is TableColumn => Boolean(column));

    return [
      { id: 'serial', label: 'S.No.', value: (_row, index) => `${index + 1}.` },
      {
        id: 'name',
        label: 'Name',
        value: row => `${row.stock.name} (${row.stock.symbol})`,
        render: row => (
          <>
            <Link href={`/?ticker=${encodeURIComponent(row.stock.ticker)}`} className="font-body text-sm font-bold text-cyan-700 hover:text-cyan-500">
              {row.stock.name}
            </Link>
            <div className="mt-0.5 text-[10px] font-numeric text-slate-400">{row.stock.symbol} - {row.stock.exchange}</div>
            {row.technical?.latestDate && (
              <div className="mt-1 max-w-[300px] text-[10px] leading-relaxed text-slate-500">{row.reason}</div>
            )}
          </>
        ),
      },
      { id: 'cmp', label: 'CMP Rs.', removable: true, value: row => row.cmp },
      { id: 'pe', label: 'P/E', removable: true, value: row => row.pe },
      { id: 'marketCapCr', label: 'Mar Cap Rs.Cr.', removable: true, value: row => row.marketCapCr },
      ...activeTechnicalColumns,
      { id: 'revenueGrowth3Yr', label: 'Rev Growth 3Y %', removable: true, value: row => row.revenueGrowth3Yr },
      { id: 'profitGrowth3Yr', label: 'Profit Growth 3Y %', removable: true, value: row => row.profitGrowth3Yr },
      { id: 'profitGrowth5Yr', label: 'Profit Growth 5Y %', removable: true, value: row => row.profitGrowth5Yr },
      { id: 'roe', label: 'ROE %', removable: true, value: row => row.roe },
      { id: 'avgRoce7Yr', label: 'Avg ROCE 7Y %', removable: true, value: row => row.avgRoce7Yr },
      { id: 'debtToEquity', label: 'Debt/Eq', removable: true, value: row => row.debtToEquity },
      { id: 'operatingMargin', label: 'Op Margin %', removable: true, value: row => row.operatingMargin },
      { id: 'piotroskiScore', label: 'Piotroski', removable: true, value: row => row.piotroskiScore },
      { id: 'divYield', label: 'Div Yld %', removable: true, value: row => row.divYield },
      { id: 'avgDividendPayout3Yr', label: 'Payout 3Y %', removable: true, value: row => row.avgDividendPayout3Yr },
      {
        id: 'score',
        label: 'Score',
        removable: true,
        value: row => row.score,
        render: row => (
          <>
            <span className="rounded-full bg-cyan-100 px-2.5 py-1 text-[10px] font-black text-cyan-700">{row.score}</span>
            {row.technical && (
              <div className="mt-2 whitespace-nowrap text-[10px] font-numeric text-slate-500">
                {row.technical.gainStreakDays ?? 0}d up / {row.technical.volumeRatioVsPreviousWeek?.toFixed(2) ?? '-'}x vol
              </div>
            )}
          </>
        ),
      },
    ];
  }, [query, rows]);

  const visibleColumns = columns.filter(column => !hiddenColumns.has(column.id));
  const removableHiddenCount = columns.filter(column => hiddenColumns.has(column.id)).length;
  const tableMinWidth = Math.max(720, visibleColumns.length * 112);

  const removeColumn = (columnId: string) => {
    setHiddenColumns(current => {
      const next = new Set(current);
      next.add(columnId);
      return next;
    });
  };

  const downloadCsv = () => {
    const header = visibleColumns.map(column => csvEscape(column.label)).join(',');
    const body = rows.map((row, index) => visibleColumns.map(column => csvEscape(column.value(row, index))).join(',')).join('\n');
    const blob = new Blob([[header, body].filter(Boolean).join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bullseye-screen'}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/80 shadow-[0_18px_55px_rgba(15,23,42,0.08)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div className="text-[10px] font-black uppercase tracking-widest text-slate-500">{rows.length} rows - {visibleColumns.length} columns</div>
        <div className="flex flex-wrap items-center gap-1">
          <button type="button" onClick={downloadCsv} className="h-8 rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-[10px] font-black uppercase tracking-widest text-emerald-700 hover:border-emerald-400">Download CSV</button>
          {removableHiddenCount > 0 && (
            <button type="button" onClick={() => setHiddenColumns(new Set())} className="h-8 rounded-lg border border-slate-200 bg-white px-3 text-[10px] font-black text-slate-600 hover:border-cyan-300">Reset columns</button>
          )}
          <button type="button" onClick={() => changeZoom(-0.08)} className="h-8 w-8 rounded-lg border border-slate-200 bg-white text-sm font-black text-slate-700 hover:border-cyan-300 hover:text-cyan-700" aria-label="Zoom out">-</button>
          <button type="button" onClick={() => setTableZoom(0.78)} className="h-8 rounded-lg border border-slate-200 bg-white px-3 text-[10px] font-black text-slate-600 hover:border-cyan-300">{Math.round(tableZoom * 100)}%</button>
          <button type="button" onClick={() => changeZoom(0.08)} className="h-8 w-8 rounded-lg border border-slate-200 bg-white text-sm font-black text-slate-700 hover:border-cyan-300 hover:text-cyan-700" aria-label="Zoom in">+</button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left" style={{ zoom: tableZoom, minWidth: tableMinWidth } as CSSProperties}>
          <thead className="bg-slate-950 text-white">
            <tr>
              {visibleColumns.map(column => (
                <th key={column.id} className="px-4 py-3 text-[10px] font-black uppercase tracking-widest font-body">
                  <span className="inline-flex items-center gap-2">
                    {column.label}
                    {column.removable && (
                      <button
                        type="button"
                        onClick={() => removeColumn(column.id)}
                        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-white/20 text-[10px] text-slate-200 transition hover:border-red-200 hover:bg-red-500 hover:text-white"
                        aria-label={`Remove ${column.label} column`}
                        title={`Remove ${column.label}`}
                      >
                        x
                      </button>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.stock.ticker} className="border-t border-slate-100 odd:bg-white even:bg-slate-50/70 hover:bg-cyan-50/70">
                {visibleColumns.map(column => (
                  <td key={`${row.stock.ticker}-${column.id}`} className={`px-4 py-3 ${column.id === 'name' || column.id === 'score' ? '' : "text-xs font-numeric text-slate-700"}`}>
                    {column.render ? column.render(row, index) : formatCellValue(column.value(row, index))}
                  </td>
                ))}
                {false && (
                  <>
                <td className="px-4 py-3 text-xs font-numeric text-slate-500">{index + 1}.</td>
                <td className="px-4 py-3">
                  <Link href={`/?ticker=${encodeURIComponent(row.stock.ticker)}`} className="font-body text-sm font-bold text-cyan-700 hover:text-cyan-500">
                    {row.stock.name}
                  </Link>
                  <div className="mt-0.5 text-[10px] font-numeric text-slate-400">{row.stock.symbol} · {row.stock.exchange}</div>
                  {row.technical?.latestDate && (
                    <div className="mt-1 max-w-[300px] text-[10px] leading-relaxed text-slate-500">{row.reason}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-xs font-numeric text-slate-700">{formatCellValue(row.cmp)}</td>
                <td className="px-4 py-3 text-xs font-numeric text-slate-700">{formatCellValue(row.pe)}</td>
                <td className="px-4 py-3 text-xs font-numeric text-slate-700">{formatCellValue(row.marketCapCr)}</td>
                <td className="px-4 py-3 text-xs font-numeric text-slate-700">{formatCellValue(row.revenueGrowth3Yr)}</td>
                <td className="px-4 py-3 text-xs font-numeric text-slate-700">{formatCellValue(row.profitGrowth3Yr)}</td>
                <td className="px-4 py-3 text-xs font-numeric text-slate-700">{formatCellValue(row.profitGrowth5Yr)}</td>
                <td className="px-4 py-3 text-xs font-numeric text-slate-700">{formatCellValue(row.roe)}</td>
                <td className="px-4 py-3 text-xs font-numeric text-slate-700">{formatCellValue(row.avgRoce7Yr)}</td>
                <td className="px-4 py-3 text-xs font-numeric text-slate-700">{formatCellValue(row.debtToEquity)}</td>
                <td className="px-4 py-3 text-xs font-numeric text-slate-700">{formatCellValue(row.operatingMargin)}</td>
                <td className="px-4 py-3 text-xs font-numeric text-slate-700">{formatCellValue(row.piotroskiScore)}</td>
                <td className="px-4 py-3 text-xs font-numeric text-slate-700">{formatCellValue(row.divYield)}</td>
                <td className="px-4 py-3 text-xs font-numeric text-slate-700">{formatCellValue(row.avgDividendPayout3Yr)}</td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-cyan-100 px-2.5 py-1 text-[10px] font-black text-cyan-700">{row.score}</span>
                  {row.technical && (
                    <div className="mt-2 whitespace-nowrap text-[10px] font-numeric text-slate-500">
                      {row.technical?.gainStreakDays ?? 0}d up / {row.technical?.volumeRatioVsPreviousWeek?.toFixed(2) ?? '-'}x vol
                    </div>
                  )}
                </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ScreensPage() {
  const sectors = useMemo(() => getAvailableSectors(), []);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<ScreenMode>('auto');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchingMessage, setSearchingMessage] = useState('');
  const resultsRef = useRef<HTMLElement | null>(null);

  const scrollToResults = () => {
    window.setTimeout(() => {
      resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
  };

  const runQuery = async (nextQuery = query) => {
    const clean = nextQuery.trim();
    if (!clean) return;
    setQuery(clean);
    setIsSearching(true);
    setSearchingMessage(mode === 'sql' ? 'Running your SQL against the live snapshot…' : 'Translating your request into SQL…');
    try {
      const live = await runSmartScreener(clean, candidateStocksForPrompt(clean), sectors, mode);

      // Phase 1/2 intelligent path (NL→SQL or raw SQL): the backend returns
      // generated_sql / error / table. Handle it directly — these rows already
      // carry full snapshot metrics, so no extra enrich round-trip is needed.
      if (live.generated_sql !== undefined || live.error) {
        const rows = live.error ? [] : (live.rows || []);
        setResult({
          title: live.error
            ? 'Query error'
            : rows.length
              ? `${rows.length} match${rows.length === 1 ? '' : 'es'}`
              : live.table
                ? 'Aggregate result'
                : 'No matches',
          query: live.generated_sql || clean,
          rows,
          explanation: live.explanation,
          source: live.source,
          intent: 'CUSTOM_FILTER',
          generatedSql: live.generated_sql,
          mode: live.mode,
          error: live.error,
          table: live.table,
        });
        return;
      }

      const intent = live.router?.intent;
      const aiMessage = live.router?.ai_response_message || live.explanation;

      if (intent === 'PRE_DEFINED_SCREENER' && live.router?.screener_name) {
        const screen = getScreenBySlug(live.router.screener_name);
        const rows = await enrichScreenRows(live.rows.length ? live.rows : screen ? getRowsForScreen(screen.slug) : []);
        setResult({
          title: screen ? screen.title : 'Preset screen',
          query: screen?.query || live.matchedRules?.join('\n') || clean,
          rows,
          explanation: aiMessage || live.explanation,
          source: live.source,
          intent,
        });
      } else if (intent === 'SECTOR_FILTER') {
        const sector = live.router?.sector || sectors.find(item => clean.toLowerCase().includes(item.name.toLowerCase()))?.name;
        const rows = await enrichScreenRows(live.rows.length ? live.rows : sector ? getRowsForSector(sector) : []);
        setResult({
          title: sector ? `${sector} stocks` : `${rows.length} sector matches`,
          query: live.matchedRules?.join('\n') || `Sector matched: ${sector ?? 'Unknown'}`,
          rows,
          explanation: aiMessage || live.explanation,
          source: live.source,
          intent,
        });
      } else if (intent === 'STOCK_INFO') {
        const rows = await enrichScreenRows(live.rows);
        setResult({
          title: `${rows.length || 1} stock lookup result`,
          query: live.matchedRules?.join('\n') || `Stock: ${live.router?.stock_symbol ?? clean}`,
          rows,
          explanation: aiMessage || live.explanation,
          source: live.source,
          intent,
        });
      } else if (intent === 'GENERAL_CHAT') {
        setResult({
          title: 'Bullseye AI',
          query: 'General assistant response',
          rows: [],
          explanation: aiMessage || live.explanation,
          source: live.source,
          intent,
        });
      } else if (live.rows.length || live.matchedRules?.length) {
        const rows = await enrichScreenRows(live.rows);
        setResult({
          title: `${rows.length} AI screener matches`,
          query: live.matchedRules?.join('\n') || 'No supported live rules matched.',
          rows,
          explanation: aiMessage || live.explanation,
          source: live.source,
          intent: intent || 'CUSTOM_FILTER',
        });
      } else {
        const custom = buildCustomQueryResult(clean);
        const rows = await enrichScreenRows(custom.rows);
        setResult({
          title: `${rows.length} AI screener matches`,
          query: custom.query,
          rows,
          explanation: aiMessage || live.explanation || custom.explanation,
          source: rows.length ? 'Local preset metadata + backend snapshot' : live.source,
          intent: intent || 'CUSTOM_FILTER',
        });
      }
    } catch {
      const custom = buildCustomQueryResult(clean);
      const rows = await enrichScreenRows(custom.rows);
      setResult({
        title: `${rows.length} AI screener matches`,
        query: custom.query,
        rows,
        explanation: custom.explanation || 'Live screener is unavailable, so only local preset metadata is available.',
        source: rows.length ? 'Local preset metadata + backend snapshot' : 'Local preset metadata fallback',
        intent: 'CUSTOM_FILTER',
      });
    } finally {
      setIsSearching(false);
      setSearchingMessage('');
      scrollToResults();
    }
  };

  return (
    <main className="bullseye-night relative min-h-screen bg-black font-body text-paper selection:bg-accent/25">
      {/* Ambient scene — same language as the homepage, quieter so the data reads. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute inset-0 bg-black" />
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(820px 520px at 22% 6%, rgba(52,211,153,0.10), transparent 62%), radial-gradient(680px 460px at 82% 10%, rgba(255,79,163,0.07), transparent 58%)',
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.72) 45%, rgba(0,0,0,0.92) 100%)',
          }}
        />
      </div>

      <div className="relative z-10 min-h-screen">
        <header className="relative z-40 border-b border-hairline bg-black/55 backdrop-blur-xl">
          <div className="mx-auto grid max-w-[1400px] grid-cols-1 items-center gap-4 px-5 py-5 sm:px-8 md:grid-cols-[auto_minmax(240px,1fr)_auto]">
            <Link href="/" className="flex min-w-0 items-center gap-2.5">
              <BullseyeLogo size={28} wordClassName="text-[18px]" />
            </Link>
            <StockSearch compact />
            <div className="hidden items-center gap-6 md:flex">
              <Link
                href="/ask-ai"
                className="font-body text-[13px] font-medium text-paper-muted transition duration-300 hover:text-paper"
              >
                Ask AI
              </Link>
              <Link
                href="/"
                className="inline-flex h-10 items-center justify-center rounded-full bg-accent px-5 font-body text-[13px] font-semibold text-black transition duration-300 hover:bg-accent-dim"
              >
                Home
              </Link>
            </div>
          </div>
        </header>

        <section className="relative z-10 mx-auto flex w-full max-w-[1120px] flex-col gap-16 px-5 py-14 sm:px-8">
          <div className="flex min-w-0 flex-col gap-8">
            <section>
              <div className="max-w-3xl">
                <div className="flex items-center gap-3">
                  <span aria-hidden className="h-px w-8 bg-accent/60" />
                  <span className="font-body text-[11px] font-medium uppercase tracking-[0.28em] text-accent">
                    Screens
                  </span>
                </div>
                <h1 className="mt-5 font-display text-[clamp(2.2rem,5vw,3.6rem)] font-normal leading-[1.02] text-paper">
                  Ask for a screen in <em className="italic text-accent">plain English</em>.
                </h1>
                <p className="mt-4 max-w-[58ch] font-body text-[15px] leading-8 text-paper-muted">
                  Price, volume, technicals and supported fundamentals, screened against Bullseye&apos;s
                  latest market snapshot — or write the SQL yourself.
                </p>
              </div>

              <div
                className="mt-7 rounded-[22px] border border-accent/30 p-5"
                style={{
                  background:
                    'linear-gradient(145deg, rgba(20,22,19,0.94) 0%, rgba(8,10,9,0.97) 55%, rgba(16,18,15,0.94) 100%)',
                  boxShadow: '0 26px 70px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,79,163,0.14)',
                }}
              >
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <span className="font-body text-[10px] font-medium uppercase tracking-[0.24em] text-paper-muted">
                    Mode
                  </span>
                  {(['auto', 'nl', 'sql'] as const).map(option => (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setMode(option)}
                      className={`rounded-full px-3.5 py-1.5 font-body text-[11px] font-semibold uppercase tracking-wider transition duration-300 ${
                        mode === option
                          ? 'bg-accent text-black'
                          : 'border border-hairline text-paper-muted hover:border-accent/50 hover:text-paper'
                      }`}
                    >
                      {option === 'auto' ? 'Auto' : option === 'nl' ? 'English' : 'SQL'}
                    </button>
                  ))}
                  <span className="font-body text-[11px] text-paper-muted">
                    {mode === 'sql'
                      ? 'Write SQL over stock_snapshot'
                      : mode === 'nl'
                        ? 'Plain English → SQL'
                        : 'Auto-detects English or SQL'}
                  </span>
                </div>
                <div className="flex flex-col gap-2 lg:flex-row lg:items-end">
                  <textarea
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    onInput={event => setQuery(event.currentTarget.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        runQuery();
                      }
                    }}
                    placeholder={
                      mode === 'sql'
                        ? 'SELECT symbol, name, price, roe, trailing_pe FROM stock_snapshot WHERE roe > 20 AND debt_to_equity < 50 ORDER BY roe DESC LIMIT 20'
                        : 'Ask AI: profitable stocks under PE 20 with ROE above 15 and low debt, best 1 month momentum first'
                    }
                    className="min-h-16 flex-1 resize-none rounded-2xl border border-hairline bg-white/[0.03] px-5 py-4 font-numeric text-[13px] leading-6 text-paper outline-none transition placeholder:text-paper-muted/60 focus:border-accent/55 focus:bg-white/[0.05]"
                  />
                  <button
                    type="button"
                    onClick={() => runQuery()}
                    disabled={!query.trim() || isSearching}
                    className="inline-flex h-12 shrink-0 items-center justify-center rounded-full bg-accent px-7 font-body text-[13px] font-semibold text-black transition duration-300 hover:bg-accent-dim disabled:opacity-50 lg:w-40"
                  >
                    {isSearching ? 'Thinking…' : mode === 'sql' ? 'Run SQL' : 'Ask AI'}
                  </button>
                </div>
                {/* Starters, grouped by intent — visible, not buried in a
                    <details>. This is the fastest way to learn the surface. */}
                <div className="mt-6 grid gap-x-8 gap-y-6 border-t border-hairline pt-5 sm:grid-cols-2 lg:grid-cols-4">
                  {EXAMPLE_GROUPS.map(group => (
                    <div key={group.label}>
                      <div className="font-body text-[10px] font-medium uppercase tracking-[0.22em] text-accent">
                        {group.label}
                      </div>
                      <div className="mt-2.5 flex flex-col gap-2">
                        {group.items.map(example => (
                          <button
                            key={example}
                            type="button"
                            onClick={() => runQuery(example)}
                            className="group flex items-start gap-2 text-left font-body text-[12px] leading-relaxed text-paper-muted transition hover:text-paper"
                          >
                            <span
                              aria-hidden
                              className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-accent/60 transition group-hover:bg-accent"
                            />
                            <span className="underline-offset-4 group-hover:underline">{example}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Field reference — what you can actually query. Essential for
                    SQL mode, which previously offered no discoverability. */}
                <details className="mt-5 border-t border-hairline pt-4">
                  <summary className="cursor-pointer font-body text-[10px] font-medium uppercase tracking-[0.22em] text-accent">
                    Queryable fields · stock_snapshot
                  </summary>
                  <div className="mt-4 grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
                    {SCHEMA_GROUPS.map(group => (
                      <div key={group.label}>
                        <div className="font-body text-[10px] font-medium uppercase tracking-[0.2em] text-paper-muted">
                          {group.label}
                        </div>
                        <dl className="mt-2.5 flex flex-col gap-1.5">
                          {group.fields.map(([field, meaning]) => (
                            <div key={field} className="flex items-baseline justify-between gap-3">
                              <dt>
                                <button
                                  type="button"
                                  onClick={() => setQuery(current => (current ? `${current} ${field}` : field))}
                                  className="font-numeric text-[11.5px] text-paper transition hover:text-accent"
                                  title={`Insert ${field}`}
                                >
                                  {field}
                                </button>
                              </dt>
                              <dd className="shrink-0 font-body text-[10.5px] text-paper-muted/70">{meaning}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    ))}
                  </div>
                </details>
                {isSearching && (
                  <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-accent/25 bg-accent/[0.06] px-4 py-2.5 font-body text-[12px] text-accent">
                    <span className="h-1.5 w-1.5 animate-ping rounded-full bg-accent" aria-hidden />
                    {searchingMessage || 'Routing your request through Bullseye AI…'}
                  </div>
                )}
              </div>
            </section>

            {result && (
              <section
                ref={resultsRef}
                className="scroll-mt-24 rounded-[22px] border border-hairline p-6 sm:p-7"
                style={{
                  background:
                    'linear-gradient(145deg, rgba(20,22,19,0.92) 0%, rgba(8,10,9,0.96) 55%, rgba(16,18,15,0.92) 100%)',
                  boxShadow: '0 26px 70px rgba(0,0,0,0.55)',
                }}
              >
                <div className="mb-4">
                  <span className="font-body text-[11px] font-medium uppercase tracking-[0.28em] text-accent">AI screener result</span>
                  <h2 className="mt-2 font-body text-xl font-black text-slate-950 sm:text-2xl">{result.title}</h2>
                  {result.explanation && <p className="mt-1 max-w-3xl text-xs leading-relaxed text-slate-500">{result.explanation}</p>}
                  {result.source && <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">{result.source}</p>}
                </div>

                {result.generatedSql ? (
                  <GeneratedSqlPanel sql={result.generatedSql} mode={result.mode} />
                ) : result.query ? (
                  <details className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                    <summary className="cursor-pointer text-[10px] font-black uppercase tracking-widest text-slate-500">Matched rules</summary>
                    <pre className="mt-3 overflow-x-auto text-xs leading-relaxed text-slate-700"><code>{result.query}</code></pre>
                  </details>
                ) : null}

                {result.error ? (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
                    <p className="font-body font-black">Couldn&apos;t run that query</p>
                    <p className="mt-1 leading-relaxed">{result.error}</p>
                    <p className="mt-2 text-xs text-rose-500">Only read-only <code>SELECT</code> queries over <code>stock_snapshot</code> are allowed.</p>
                  </div>
                ) : result.rows.length ? (
                  <MetricTable rows={result.rows} query={result.query || query} title={result.title} />
                ) : result.table ? (
                  <AggregateTable table={result.table} />
                ) : result.intent === 'GENERAL_CHAT' ? (
                  <div className="rounded-2xl border border-cyan-200 bg-cyan-50 p-5 text-sm leading-relaxed text-slate-700">
                    {result.explanation || 'Ask for a preset screen, sector, ticker lookup, or technical filter to fetch stock rows.'}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm text-slate-600">
                    No stocks matched this prompt. Try loosening a condition — I did not return broad or random fallback rows.
                  </div>
                )}
              </section>
            )}

          </div>

          {/* ── SCREEN LIBRARY ──────────────────────────────────────────────
              Was a stack of cramped cards inside the narrow left column; now a
              full-width browsable library with one rhythm per category. */}
          <div className="flex flex-col gap-14">
            <div className="flex items-center gap-3">
              <span aria-hidden className="h-px w-8 bg-accent/60" />
              <span className="font-body text-[11px] font-medium uppercase tracking-[0.28em] text-accent">
                Screen library
              </span>
            </div>

            {/* An index, not another wall of cards. Every screen is one row:
                name on the left, what it looks for on the right, hairline
                between. Far denser and quicker to scan than a 3-col grid, and
                it makes the categories the organising rhythm. */}
            {SCREEN_SECTIONS.map(section => (
              <section key={section.title}>
                <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-hairline pb-4">
                  <h2 className="font-display text-[clamp(1.5rem,2.6vw,2.1rem)] leading-tight text-paper">
                    {section.title}
                  </h2>
                  <span className="font-numeric text-[11px] text-paper-muted/70">
                    {section.items.length} screens
                  </span>
                </div>
                <p className="mt-3 max-w-[62ch] font-body text-[14px] leading-7 text-paper-muted">
                  {section.subtitle}
                </p>
                <div className="mt-5">
                  {section.items.map((item, index) => (
                    <Link
                      key={item.slug}
                      href={`/screens/${item.slug}`}
                      className="group grid grid-cols-1 items-baseline gap-x-8 gap-y-1 border-b border-hairline py-4 transition duration-200 hover:border-accent/40 sm:grid-cols-[auto_minmax(0,17rem)_minmax(0,1fr)_auto]"
                    >
                      <span className="hidden font-numeric text-[11px] text-paper-muted/50 sm:block">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <h3 className="font-display text-[19px] leading-snug text-paper transition group-hover:text-accent">
                        {item.title}
                      </h3>
                      <p className="font-body text-[12.5px] leading-6 text-paper-muted">
                        {item.description}
                      </p>
                      <span
                        aria-hidden
                        className="hidden font-body text-[16px] text-paper-muted/40 transition-transform duration-300 group-hover:translate-x-1 group-hover:text-accent sm:block"
                      >
                        →
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {/* ── BROWSE BY SECTOR ────────────────────────────────────────────
              Was a cramped scrolling list wedged into a 380px sidebar. Sector
              navigation is browsing, not a feed, so it is now a full-width row
              of chips that go straight to the sector page. */}
          <div>
            <div className="flex items-center gap-3">
              <span aria-hidden className="h-px w-8 bg-accent/60" />
              <span className="font-body text-[11px] font-medium uppercase tracking-[0.28em] text-accent">
                Browse by sector
              </span>
            </div>
            <h2 className="mt-5 font-display text-[clamp(1.5rem,2.6vw,2.1rem)] leading-tight text-paper">
              Start from an industry.
            </h2>
            <p className="mt-2 max-w-[62ch] font-body text-[14px] leading-7 text-paper-muted">
              Only sectors that actually have stocks in the Bullseye database are listed.
            </p>
            {/* Sectors are a different axis from screens, so they get a
                different form: a multi-column directory with counts, rather
                than chips that look identical to everything else. */}
            <div className="mt-7 grid grid-cols-1 gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
              {sectors.map(sector => (
                <Link
                  key={sector.name}
                  href={`/screens/sector/${encodeURIComponent(sector.name)}`}
                  className="group flex items-baseline justify-between gap-4 border-b border-hairline py-3 transition duration-200 hover:border-accent/40"
                >
                  <span className="font-body text-[13.5px] text-paper-muted transition group-hover:text-accent">
                    {sector.name}
                  </span>
                  <span className="shrink-0 font-numeric text-[11px] text-paper-muted/60">
                    {sector.count}
                  </span>
                </Link>
              ))}
            </div>
          </div>

          {/* "Popular screens" was removed: it was the same links as the
              library above, rendered as chips, so it added a third
              undifferentiated block without adding information. */}
        </section>
      </div>
    </main>
  );
}
