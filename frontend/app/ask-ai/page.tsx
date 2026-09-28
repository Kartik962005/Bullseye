'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { STOCKS } from '../stocks';

const BACKEND = '/api/backend';

type Summary = {
  total_trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_return_pct: number;
  avg_return_per_trade_pct: number;
  avg_win_pct?: number;
  avg_loss_pct?: number;
  risk_reward_ratio?: number;
  profit_factor?: number;
  best_trade_pct?: number;
  worst_trade_pct?: number;
  max_drawdown_pct?: number;
  avg_holding_days?: number;
};

type Trade = {
  buy_date: string;
  sell_date: string;
  buy_price: number;
  sell_price: number;
  holding_days: number;
  return_pct: number;
  result: string;
};

type Backtest = {
  buy_expr?: string;
  sell_expr?: string;
  mode?: string;
  current_signal?: string;
  analysis_text?: string;
  summary?: Summary | null;
  trades?: Trade[];
  open_trade?: Record<string, unknown> | null;
  buy_and_hold_return_pct?: number;
  alpha_vs_buy_hold_pct?: number;
  warning?: string;
};

type ScanRow = {
  ticker: string;
  symbol?: string;
  name?: string;
  total_trades: number;
  win_rate: number;
  total_return_pct: number;
  buy_hold_pct: number;
  alpha_pct: number;
};

type Scan = {
  buy_expr?: string;
  sell_expr?: string;
  mode?: string;
  scanned: number;
  universe?: number;
  partial?: boolean;
  traded: number;
  profitable: number;
  beat_buy_hold: number;
  avg_win_rate: number;
  avg_total_return_pct: number;
  rows: ScanRow[];
};

type MoversRow = {
  ticker: string;
  symbol?: string;
  name?: string;
  date: string;
  close: number;
  change_pct: number;
};

type MoversScan = {
  session_date: string | null;
  direction: string;
  coverage: number;
  universe: number;
  ready: boolean;
  rows: MoversRow[];
};

type ScreenerRow = {
  stock?: {
    symbol?: string;
    ticker?: string;
    name?: string;
  };
  cmp?: number | null;
  pe?: number | null;
  marketCapCr?: number | null;
  divYield?: number | null;
  revenueGrowth3Yr?: number | null;
  profitGrowth3Yr?: number | null;
  roe?: number | null;
  roce?: number | null;
  avgRoce7Yr?: number | null;
  debtToEquity?: number | null;
  operatingMargin?: number | null;
  score?: number | null;
  reason?: string;
  technical?: {
    return1mPct?: number | null;
    return1yPct?: number | null;
  };
};

type ScreenerResult = {
  rows: ScreenerRow[];
  matchedRules?: string[];
  explanation?: string;
  source?: string;
};

type AskAiResponse = {
  answer: string;
  mode: string;
  success?: boolean;
  model_used: string;
  target_stock: string | null;
  context_used?: boolean;
  backtest: Backtest | null;
  scan: Scan | MoversScan | null;
  screener?: ScreenerResult | null;
  suggestions?: string[];
  conversation_id?: string;
  saved?: boolean;
  strategy_json?: Record<string, unknown> | null;
  strategy_alert?: {
    alertable?: boolean;
    quality?: { alertable?: boolean; reason?: string };
    stats?: Record<string, number>;
    disclaimer?: string;
    cta?: string | null;
  };
  disclaimer?: string;
};

type AppContext = {
  current_page: string;
  selected_symbol?: string;
  selected_ticker?: string;
};

type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  data?: Partial<AskAiResponse>;
  error?: boolean;
  thoughtMs?: number;
};

type ConversationSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

type StoredConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  data?: Partial<AskAiResponse> | null;
  created_at: string;
};

// Prompts are grouped by INTENT rather than listed flat: the launcher doubles
// as documentation, so a first-time visitor can see what this thing actually
// does (test a rule, sweep the universe, look something up, learn a concept)
// instead of guessing from a row of undifferentiated chips.
const PROMPT_GROUPS: Array<{ label: string; blurb: string; prompts: string[] }> = [
  {
    label: 'Backtest',
    blurb: 'Test a rule on real history.',
    prompts: [
      'Backtest: buy RELIANCE when RSI crosses below 30, sell when it crosses 70',
      'If I buy TCS 2 days after it falls 5% in a week, then sell on a 3% bounce, does it work?',
    ],
  },
  {
    label: 'Scan',
    blurb: 'Sweep the whole NSE universe.',
    prompts: [
      'Scan all NSE stocks: golden cross strategy — which ones beat buy-and-hold?',
      'Which NSE stocks perform best with a gap-up momentum strategy?',
    ],
  },
  {
    label: 'Look up',
    blurb: 'Prices, levels, indicators.',
    prompts: [
      'What was the price of INFY on 15 Oct 2024?',
      'Current RSI and 50-day SMA for HDFCBANK',
    ],
  },
  {
    label: 'Understand',
    blurb: 'Concepts, answered honestly.',
    prompts: [
      'Explain the difference between a high win rate and an actually profitable strategy',
      'Why would a strategy with 70% winning trades still lose money?',
    ],
  },
];

let supabaseClientPromise: Promise<any> | null = null;

async function getSharedSupabaseClient(supabaseUrl: string, supabaseKey: string) {
  if (typeof window === 'undefined') return null;
  const globalKey = '__bullseyeSupabaseClient';
  const browserWindow = window as any;
  if (browserWindow[globalKey]) return browserWindow[globalKey];
  if (!supabaseClientPromise) {
    supabaseClientPromise = import('@supabase/supabase-js').then(({ createClient }) => {
      if (!browserWindow[globalKey]) {
        browserWindow[globalKey] = createClient(supabaseUrl, supabaseKey);
      }
      return browserWindow[globalKey];
    });
  }
  return supabaseClientPromise;
}

function pct(value: number | undefined | null) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function toneClass(value: number | undefined | null) {
  if (value === undefined || value === null || Number.isNaN(value)) return 'text-paper-muted';
  if (value > 0) return 'text-primary';
  if (value < 0) return 'text-rose-200';
  return 'text-paper-muted';
}

function formatDuration(ms?: number | null) {
  if (ms === undefined || ms === null || ms < 0) return '';
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} second${totalSeconds === 1 ? '' : 's'}`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes} min ${seconds} sec` : `${minutes} min`;
}

// A backticked snippet is "runnable" when it reads like a question/command the
// assistant could answer — so we render it as a tap-to-run chip instead of inert
// code. This is what lets a user tap an example the answer suggested (e.g.
// `backtest: buy NET when RSI crosses above 30…`) instead of copy-pasting it.
function looksRunnable(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length < 8 || t.length > 220 || !t.includes(' ')) return false;
  const startsWithVerb = /^(backtest|back test|scan|screen|show|find|which|what|explain|analyze|analyse|compare|buy|sell|test|rank|list)\b/.test(t);
  const hasStrategyPhrase = /\b(crosses?|golden cross|death cross|gap up|gap down|moving average|stop[- ]?loss|breakout|mean[- ]reversion|momentum|rsi|macd|buy and hold|buy-and-hold)\b/.test(t);
  return startsWithVerb || hasStrategyPhrase;
}

// ── Minimal markdown rendering (no extra deps) ────────────────────────────────
function renderInline(text: string, keyPrefix: string, onRun?: (prompt: string) => void): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(<strong key={`${keyPrefix}-b-${i}`} className="font-bold text-paper">{token.slice(2, -2)}</strong>);
    } else {
      const code = token.slice(1, -1);
      if (onRun && looksRunnable(code)) {
        nodes.push(
          <button
            key={`${keyPrefix}-r-${i}`}
            type="button"
            onClick={() => onRun(code)}
            title="Tap to run this"
            className="group/run mx-0.5 inline rounded bg-accent/10 px-1.5 py-0.5 text-left font-numeric text-[0.85em] text-accent underline decoration-accent/50 decoration-dotted underline-offset-2 transition hover:bg-accent/15 hover:text-accent hover:decoration-solid"
          >
            {code}
            <span className="ml-1 text-accent transition group-hover/run:text-accent" aria-hidden="true">↵</span>
          </button>
        );
      } else {
        nodes.push(
          <code key={`${keyPrefix}-c-${i}`} className="rounded bg-white/[0.05] px-1.5 py-0.5 font-numeric text-[0.85em] text-accent">
            {code}
          </code>
        );
      }
    }
    lastIndex = regex.lastIndex;
    i += 1;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function renderMarkdown(text: string, onRun?: (prompt: string) => void): ReactNode[] {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  let key = 0;

  const flushBullets = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={`ul-${key++}`} className="my-2 list-disc space-y-1 pl-5">
        {items.map((item, idx) => (
          <li key={idx}>{renderInline(item, `li-${key}-${idx}`, onRun)}</li>
        ))}
      </ul>
    );
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const bulletMatch = line.match(/^\s*[-*]\s+(.*)$/);
    const headingMatch = line.match(/^#{1,4}\s+(.*)$/);
    if (bulletMatch) {
      bullets.push(bulletMatch[1]);
      continue;
    }
    flushBullets();
    if (headingMatch) {
      blocks.push(
        <p key={`h-${key++}`} className="mt-3 mb-1 text-sm font-black uppercase tracking-wide text-paper">
          {renderInline(headingMatch[1], `h-${key}`, onRun)}
        </p>
      );
    } else if (line.trim() === '') {
      // paragraph spacing handled by margins
    } else {
      blocks.push(
        <p key={`p-${key++}`} className="my-2 leading-relaxed">
          {renderInline(line, `p-${key}`, onRun)}
        </p>
      );
    }
  }
  flushBullets();
  return blocks;
}

// ── Result cards ──────────────────────────────────────────────────────────────
function StatCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-white/[0.03] px-3 py-2 transition hover:border-accent/30 hover:bg-white/[0.03]">
      <div className="text-[9px] font-bold uppercase tracking-wider text-paper-muted">{label}</div>
      <div className={`mt-0.5 font-display text-base font-bold tabular-nums ${tone ?? 'text-paper'}`}>{value}</div>
    </div>
  );
}

function BacktestCard({ data, ticker }: { data: Backtest; ticker: string | null }) {
  const s = data.summary;
  const signal = (data.current_signal || 'HOLD').toUpperCase();
  const signalTone =
    signal === 'BUY' ? 'bg-primary/15 text-primary' : signal === 'SELL' ? 'bg-rose-500/150/15 text-rose-300' : 'bg-white/[0.05] text-paper-muted';

  return (
    <div className="mt-3 rounded-2xl border border-accent/30 bg-accent/[0.05] p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-black uppercase tracking-wider text-accent">
          Backtest{ticker ? ` · ${ticker}` : ''}
        </div>
        <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider ${signalTone}`}>
          Signal: {signal}
        </span>
      </div>

      {(data.buy_expr || data.sell_expr) && (
        <div className="mt-2 space-y-1 text-[11px] text-paper-muted">
          {data.buy_expr && <div><span className="font-bold text-primary">BUY</span> <code className="font-numeric">{data.buy_expr}</code></div>}
          {data.sell_expr && <div><span className="font-bold text-rose-200">SELL</span> <code className="font-numeric">{data.sell_expr}</code></div>}
        </div>
      )}

      {s ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          <StatCell label="Trades" value={String(s.total_trades)} />
          <StatCell label="Win rate" value={`${s.win_rate}%`} />
          <StatCell label="Strategy return" value={pct(s.total_return_pct)} tone={toneClass(s.total_return_pct)} />
          <StatCell label="Buy & hold" value={pct(data.buy_and_hold_return_pct)} tone={toneClass(data.buy_and_hold_return_pct)} />
          <StatCell label="Alpha vs B&H" value={pct(data.alpha_vs_buy_hold_pct)} tone={toneClass(data.alpha_vs_buy_hold_pct)} />
          <StatCell label="Avg / trade" value={pct(s.avg_return_per_trade_pct)} tone={toneClass(s.avg_return_per_trade_pct)} />
          <StatCell label="Max drawdown" value={pct(s.max_drawdown_pct)} tone="text-rose-200" />
          <StatCell label="Profit factor" value={s.profit_factor !== undefined ? String(s.profit_factor) : '—'} />
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {data.warning || 'No trades were triggered by this strategy.'}
        </div>
      )}

      {data.trades && data.trades.length > 0 && (
        <details className="mt-3 group">
          <summary className="cursor-pointer text-[11px] font-bold uppercase tracking-wider text-accent hover:text-accent">
            View last {Math.min(data.trades.length, 12)} trades
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-[11px]">
              <thead>
                <tr className="text-paper-muted">
                  <th className="py-1 pr-3 font-bold uppercase">Buy</th>
                  <th className="py-1 pr-3 font-bold uppercase">Sell</th>
                  <th className="py-1 pr-3 font-bold uppercase">Days</th>
                  <th className="py-1 pr-3 font-bold uppercase">Return</th>
                </tr>
              </thead>
              <tbody>
                {data.trades.slice(-12).reverse().map((t, idx) => (
                  <tr key={idx} className="border-t border-hairline">
                    <td className="py-1 pr-3 text-paper-muted">{t.buy_date} @ {t.buy_price}</td>
                    <td className="py-1 pr-3 text-paper-muted">{t.sell_date} @ {t.sell_price}</td>
                    <td className="py-1 pr-3 text-paper-muted">{t.holding_days}</td>
                    <td className={`py-1 pr-3 font-bold ${toneClass(t.return_pct)}`}>{pct(t.return_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

function ScanCard({ data }: { data: Scan }) {
  return (
    <div className="mt-3 rounded-2xl border border-accent/30 bg-accent/[0.05] p-3 sm:p-4">
      <div className="text-xs font-black uppercase tracking-wider text-accent">Cross-stock scan</div>
      {(data.buy_expr || data.sell_expr) && (
        <div className="mt-2 space-y-1 text-[11px] text-paper-muted">
          {data.buy_expr && <div><span className="font-bold text-primary">BUY</span> <code className="font-numeric">{data.buy_expr}</code></div>}
          {data.sell_expr && <div><span className="font-bold text-rose-200">SELL</span> <code className="font-numeric">{data.sell_expr}</code></div>}
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <StatCell label="Scanned" value={data.universe ? `${data.scanned} / ${data.universe}` : String(data.scanned)} />
        <StatCell label="Traded" value={String(data.traded)} />
        <StatCell label="Profitable" value={`${data.profitable}/${data.traded}`} tone="text-primary" />
        <StatCell label="Beat B&H" value={`${data.beat_buy_hold}/${data.traded}`} />
        <StatCell label="Avg return" value={pct(data.avg_total_return_pct)} tone={toneClass(data.avg_total_return_pct)} />
      </div>
      {data.partial && (
        <p className="mt-2 text-[10px] text-paper-muted">
          Scanned {data.scanned} of {data.universe} stocks within the time budget. Ask again to continue the scan.
        </p>
      )}

      {data.rows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead>
              <tr className="text-paper-muted">
                <th className="py-1 pr-3 font-bold uppercase">Stock</th>
                <th className="py-1 pr-3 font-bold uppercase">Return</th>
                <th className="py-1 pr-3 font-bold uppercase">Win %</th>
                <th className="py-1 pr-3 font-bold uppercase">Trades</th>
                <th className="py-1 pr-3 font-bold uppercase">Buy & hold</th>
                <th className="py-1 pr-3 font-bold uppercase">Alpha</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.slice(0, 15).map((r) => (
                <tr key={r.ticker} className="border-t border-hairline">
                  <td className="py-1 pr-3 font-bold text-paper-muted">{r.symbol || r.ticker}</td>
                  <td className={`py-1 pr-3 font-bold ${toneClass(r.total_return_pct)}`}>{pct(r.total_return_pct)}</td>
                  <td className="py-1 pr-3 text-paper-muted">{r.win_rate}%</td>
                  <td className="py-1 pr-3 text-paper-muted">{r.total_trades}</td>
                  <td className={`py-1 pr-3 ${toneClass(r.buy_hold_pct)}`}>{pct(r.buy_hold_pct)}</td>
                  <td className={`py-1 pr-3 font-bold ${toneClass(r.alpha_pct)}`}>{pct(r.alpha_pct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function MoversCard({ data }: { data: MoversScan }) {
  const isLosers = /declin|loser|lower/i.test(data.direction || '');
  const title = isLosers ? 'Biggest decliners' : 'Biggest gainers';
  return (
    <div className="mt-3 rounded-2xl border border-accent/30 bg-accent/[0.05] p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-black uppercase tracking-wider text-accent">
          {title}{data.session_date ? ` · ${data.session_date}` : ''}
        </div>
        <span className="rounded-full bg-white/[0.05] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-paper-muted">
          {data.ready ? `${data.universe} stocks scanned` : `scanning ${data.coverage}/${data.universe}`}
        </span>
      </div>

      {data.rows.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead>
              <tr className="text-paper-muted">
                <th className="py-1 pr-3 font-bold uppercase">#</th>
                <th className="py-1 pr-3 font-bold uppercase">Stock</th>
                <th className="py-1 pr-3 font-bold uppercase">Change</th>
                <th className="py-1 pr-3 font-bold uppercase">Close</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.slice(0, 15).map((r, idx) => (
                <tr key={r.ticker} className="border-t border-hairline">
                  <td className="py-1 pr-3 text-paper-muted tabular-nums">{idx + 1}</td>
                  <td className="py-1 pr-3 font-bold text-paper-muted">{r.symbol || r.ticker}</td>
                  <td className={`py-1 pr-3 font-bold tabular-nums ${toneClass(r.change_pct)}`}>{pct(r.change_pct)}</td>
                  <td className="py-1 pr-3 text-paper-muted tabular-nums">{r.close}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Scanning the full market now — ask again in a moment for the complete ranking.
        </div>
      )}

      {!data.ready && data.rows.length > 0 && (
        <p className="mt-2 text-[10px] text-paper-muted">
          Still scanning the full market ({data.coverage}/{data.universe}). Ask again shortly for the complete ranking.
        </p>
      )}
    </div>
  );
}

function num(value: number | undefined | null, digits = 2) {
  if (value === undefined || value === null || Number.isNaN(value)) return '-';
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function ScreenerCard({ data }: { data: ScreenerResult }) {
  const rows = data.rows || [];
  return (
    <div className="mt-3 rounded-2xl border border-accent/30 bg-accent/[0.05] p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-black uppercase tracking-wider text-accent">Screener matches</div>
        {data.source && (
          <span className="rounded-full bg-white/[0.03] px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-paper-muted">
            {data.source}
          </span>
        )}
      </div>
      {data.matchedRules && data.matchedRules.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {data.matchedRules.slice(0, 6).map((rule) => (
            <span key={rule} className="rounded-full border border-accent/25 bg-white/[0.03] px-2 py-0.5 text-[10px] font-semibold text-accent">
              {rule}
            </span>
          ))}
        </div>
      )}

      {rows.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-[11px]">
            <thead>
              <tr className="text-paper-muted">
                <th className="py-1 pr-3 font-bold uppercase">#</th>
                <th className="py-1 pr-3 font-bold uppercase">Stock</th>
                <th className="py-1 pr-3 font-bold uppercase">MCap Cr</th>
                <th className="py-1 pr-3 font-bold uppercase">Sales Gr</th>
                <th className="py-1 pr-3 font-bold uppercase">Profit Gr</th>
                <th className="py-1 pr-3 font-bold uppercase">ROCE</th>
                <th className="py-1 pr-3 font-bold uppercase">D/E</th>
                <th className="py-1 pr-3 font-bold uppercase">PE</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 20).map((row, idx) => {
                const symbol = row.stock?.symbol || row.stock?.ticker || `match-${idx}`;
                return (
                  <tr key={`${symbol}-${idx}`} className="border-t border-hairline">
                    <td className="py-1 pr-3 text-paper-muted tabular-nums">{idx + 1}</td>
                    <td className="py-1 pr-3">
                      <div className="font-bold text-paper-muted">{symbol}</div>
                      {row.stock?.name && <div className="max-w-[180px] truncate text-[10px] text-paper-muted">{row.stock.name}</div>}
                    </td>
                    <td className="py-1 pr-3 text-paper-muted tabular-nums">{num(row.marketCapCr, 0)}</td>
                    <td className={`py-1 pr-3 font-bold tabular-nums ${toneClass(row.revenueGrowth3Yr)}`}>{pct(row.revenueGrowth3Yr)}</td>
                    <td className={`py-1 pr-3 font-bold tabular-nums ${toneClass(row.profitGrowth3Yr)}`}>{pct(row.profitGrowth3Yr)}</td>
                    <td className="py-1 pr-3 font-bold text-paper-muted tabular-nums">{pct(row.roce ?? row.avgRoce7Yr)}</td>
                    <td className="py-1 pr-3 text-paper-muted tabular-nums">{num(row.debtToEquity)}</td>
                    <td className="py-1 pr-3 text-paper-muted tabular-nums">{num(row.pe)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          No exact matches were found for this screen.
        </div>
      )}
    </div>
  );
}

export default function AskAiPage() {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [appContext, setAppContext] = useState<AppContext>({ current_page: 'ask-ai' });
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoOpenedRef = useRef(false);
  const activeAbortRef = useRef<AbortController | null>(null);
  const thinkingStartedAtRef = useRef<number | null>(null);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseAvailable = !!(supabaseUrl && supabaseKey);
  const [authReady, setAuthReady] = useState(!supabaseAvailable);
  const [signedInUser, setSignedInUser] = useState<any>(null);

  async function getAccessToken() {
    if (!supabaseAvailable) return null;
    const sb = await getSharedSupabaseClient(supabaseUrl!, supabaseKey!);
    if (!sb) return null;
    const result = await sb.auth.getSession();
    return result?.data?.session?.access_token ?? null;
  }

  async function authHeaders(): Promise<Record<string, string>> {
    const token = await getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function saveStrategyAlert(data: Partial<AskAiResponse>) {
    if (!data.strategy_json) return;
    const headers = await authHeaders();
    if (!('Authorization' in headers)) {
      setMessages((prev) => [
        ...prev,
        { id: `e-${Date.now()}`, role: 'assistant', content: 'Sign in before saving daily strategy alerts.', error: true },
      ]);
      return;
    }
    const response = await fetch(`${BACKEND}/api/v1/strategies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({
        name: 'Ask-AI strategy alert',
        nl_text: messages.slice().reverse().find((message) => message.role === 'user')?.content || 'Ask-AI strategy',
        strategy_json: data.strategy_json,
        quality: data.strategy_alert?.quality,
        enabled: true,
      }),
    });
    const raw = await response.json().catch(() => ({}));
    setMessages((prev) => [
      ...prev,
      {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: response.ok ? 'Saved as a daily strategy alert.' : raw?.detail || 'Could not save that strategy alert.',
        error: !response.ok,
      },
    ]);
  }

  function scrollToBottom(behavior: ScrollBehavior = 'smooth') {
    const scroll = () => {
      bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior });
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
      }
    };
    requestAnimationFrame(scroll);
    window.setTimeout(scroll, 80);
  }

  async function loadConversations(): Promise<ConversationSummary[]> {
    setConversationsLoading(true);
    const headers = await authHeaders();
    if (!('Authorization' in headers)) {
      setConversations([]);
      setConversationsLoading(false);
      return [];
    }
    try {
      const response = await fetch(`${BACKEND}/api/v1/ask-ai/conversations`, { headers, cache: 'no-store' });
      if (!response.ok) {
        setConversations([]);
        return [];
      }
      const data = await response.json().catch(() => ({}));
      const rows = Array.isArray(data.conversations) ? data.conversations : [];
      setConversations(rows);
      return rows;
    } finally {
      setConversationsLoading(false);
    }
  }

  useEffect(() => {
    scrollToBottom('smooth');
  }, [messages, loading]);

  useEffect(() => {
    if (!loading || thinkingStartedAtRef.current === null) return;
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - (thinkingStartedAtRef.current ?? Date.now()));
    }, 250);
    return () => window.clearInterval(timer);
  }, [loading]);

  useEffect(() => {
    let active = true;
    let subscription: { unsubscribe?: () => void } | null = null;
    if (!supabaseAvailable) {
      setAuthReady(true);
      setSignedInUser(null);
      return;
    }
    getSharedSupabaseClient(supabaseUrl!, supabaseKey!).then(async (sb) => {
      if (!sb || !active) return;
      const session = await sb.auth.getSession();
      if (!active) return;
      setSignedInUser(session?.data?.session?.user ?? null);
      setAuthReady(true);
      subscription = sb.auth.onAuthStateChange((_event: string, nextSession: any) => {
        setSignedInUser(nextSession?.user ?? null);
        setAuthReady(true);
        autoOpenedRef.current = false;
      })?.data?.subscription;
    });
    return () => {
      active = false;
      subscription?.unsubscribe?.();
    };
  }, [supabaseAvailable, supabaseKey, supabaseUrl]);

  useEffect(() => {
    if (!authReady) return;
    if (!signedInUser) {
      setConversations([]);
      return;
    }
    loadConversations().catch(() => setConversations([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, signedInUser?.id]);

  useEffect(() => {
    if (!authReady || !signedInUser || autoOpenedRef.current || conversationId || messages.length > 0 || conversations.length === 0) {
      return;
    }
    autoOpenedRef.current = true;
    openConversation(conversations[0].id).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authReady, signedInUser?.id, conversations.length, conversationId, messages.length]);

  // Pick up an optional stock the user arrived with (e.g. /ask-ai?ticker=RELIANCE.NS)
  // so answers can use that stock's real context. No-op when none is present.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const symbol = params.get('symbol') ?? undefined;
      const ticker = params.get('ticker') ?? undefined;
      setAppContext({ current_page: 'ask-ai', selected_symbol: symbol, selected_ticker: ticker });
    } catch {
      /* window not available — keep default page-only context */
    }
  }, []);

  async function send(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed || loading) return;

    const userMessage: ChatMessage = { id: `u-${Date.now()}`, role: 'user', content: trimmed };
    const history = messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));
    const controller = new AbortController();
    activeAbortRef.current = controller;
    thinkingStartedAtRef.current = Date.now();
    setElapsedMs(0);
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    scrollToBottom('smooth');

    try {
      const tokenHeaders = await authHeaders();
      const response = await fetch(`${BACKEND}/api/v1/ask-ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...tokenHeaders },
        signal: controller.signal,
        body: JSON.stringify({ prompt: trimmed, history, stocks: STOCKS, context: appContext, conversation_id: conversationId }),
      });
      const raw = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(raw?.detail || 'The AI engine could not answer that. Please try again.');
      }
      const data = raw as AskAiResponse;
      if (data.success === false) {
        throw new Error(data.answer || 'The AI engine is unavailable right now. Please try again shortly.');
      }
      if (data.conversation_id) {
        setConversationId(data.conversation_id);
      }
      const thoughtMs = Date.now() - (thinkingStartedAtRef.current ?? Date.now());
      setMessages((prev) => [
        ...prev,
        { id: `a-${Date.now()}`, role: 'assistant', content: data.answer || 'No answer returned.', data, thoughtMs },
      ]);
      if (data.saved) {
        loadConversations().catch(() => {});
      }
    } catch (err) {
      const thoughtMs = Date.now() - (thinkingStartedAtRef.current ?? Date.now());
      const stopped = err instanceof Error && err.name === 'AbortError';
      setMessages((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          role: 'assistant',
          content: stopped
            ? 'Stopped. You can ask a different question now.'
            : err instanceof Error ? err.message : 'Something went wrong. Please try again.',
          error: !stopped,
          thoughtMs,
        },
      ]);
    } finally {
      activeAbortRef.current = null;
      thinkingStartedAtRef.current = null;
      setElapsedMs(0);
      setLoading(false);
    }
  }

  function stopThinking() {
    activeAbortRef.current?.abort();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input);
    }
  }

  async function openConversation(id: string) {
    if (historyLoading) return;
    setHistoryLoading(true);
    try {
      const headers = await authHeaders();
      if (!('Authorization' in headers)) return;
      const response = await fetch(`${BACKEND}/api/v1/ask-ai/conversations/${id}`, { headers, cache: 'no-store' });
      const raw = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(raw?.detail || 'Could not open that chat.');
      }
      const loaded = Array.isArray(raw.messages) ? raw.messages as StoredConversationMessage[] : [];
      setConversationId(id);
      setMessages(loaded.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        data: message.role === 'assistant' && message.data ? message.data : undefined,
      })));
    } finally {
      setHistoryLoading(false);
    }
  }

  function startNewChat() {
    setConversationId(null);
    setMessages([]);
  }

  const isEmpty = messages.length === 0;

  // One console, two homes: the centrepiece of the empty-state launcher, and
  // the sticky composer once a conversation exists.
  const renderConsole = (large: boolean) => (
    <div
      className={`flex items-end gap-2 rounded-full border border-hairline p-2 transition focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20 ${large ? 'px-3 py-2.5' : ''}`}
      style={{ background: 'rgba(6,8,7,0.85)' }}
    >
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        placeholder={large ? 'Describe a strategy, or ask anything about the market…' : 'Ask a follow-up…'}
        className={`max-h-40 flex-1 resize-none bg-transparent px-4 py-2 font-body text-paper outline-none placeholder:text-paper-muted/60 ${large ? 'min-h-[44px] text-[15px]' : 'min-h-[40px] text-[14px]'}`}
      />
      {loading ? (
        <button
          type="button"
          onClick={stopThinking}
          aria-label="Stop generating answer"
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-rose-400/40 bg-rose-500/150/15 px-5 font-body text-[12px] font-semibold uppercase tracking-wider text-rose-200 transition hover:bg-rose-500/150/25"
        >
          <span className="text-base leading-none" aria-hidden="true">×</span>
          Stop
        </button>
      ) : (
        <button
          type="button"
          onClick={() => send(input)}
          disabled={!input.trim()}
          aria-label="Send message"
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-full bg-accent px-6 font-body text-[12px] font-semibold uppercase tracking-wider text-black transition duration-300 hover:bg-accent-dim disabled:cursor-not-allowed disabled:opacity-40"
        >
          Ask
          <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden="true">
            <path d="M4 10h11M10.5 5.5L15 10l-4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
    </div>
  );

  return (
    <main className="relative flex min-h-screen flex-col bg-black font-body text-paper">
      {/* ambient background glow */}
      <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[480px] w-[820px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(52,211,153,0.16),transparent_70%)] blur-[120px]" />
        <div className="absolute bottom-0 right-0 h-[360px] w-[360px] rounded-full bg-[radial-gradient(circle,rgba(255,79,163,0.12),transparent_70%)] blur-[120px]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-hairline bg-black/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1100px] items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => router.back()}
              aria-label="Go back to the previous page"
              className="group flex h-9 items-center gap-1.5 rounded-xl border border-hairline bg-white/[0.03] pl-2 pr-3 text-[12px] font-semibold text-paper-muted transition hover:-translate-x-0.5 hover:border-accent/55 hover:text-accent hover:shadow-[0_8px_24px_rgba(8,145,178,0.14)]"
            >
              <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4 transition group-hover:-translate-x-0.5" aria-hidden="true">
                <path d="M12.5 5L7.5 10l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Back
            </button>
            <Link href="/" className="group flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-accent/40 bg-accent/10">
                <span className="font-display text-xs text-accent">BE</span>
              </div>
              <div className="leading-tight">
                <div className="font-display text-[19px] leading-none sm:text-[21px]">
                  <span className="text-paper">BULLS</span><span className="text-accent">EYE</span>
                </div>
                <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-paper-muted">Ask AI · Backtest · Scan</div>
              </div>
            </Link>
          </div>
          <div className="flex items-center gap-2">
            {!isEmpty && (
              <button
                type="button"
                onClick={startNewChat}
                className="h-9 rounded-xl border border-hairline bg-white/[0.03] px-3 text-[12px] font-semibold text-paper-muted transition hover:border-accent/55 hover:text-accent"
              >
                New chat
              </button>
            )}
            <Link
              href="/screens"
              className="h-9 rounded-xl border border-hairline bg-white/[0.03] px-3 text-[12px] font-semibold leading-9 text-paper-muted transition hover:border-accent/55 hover:text-accent"
            >
              Screener
            </Link>
            <Link
              href="/"
              className="hidden h-9 rounded-xl border border-hairline bg-white/[0.03] px-3 text-[12px] font-semibold leading-9 text-paper-muted transition hover:border-accent/55 hover:text-accent sm:inline-block"
            >
              Home
            </Link>
          </div>
        </div>
      </header>

      <div className="w-full flex-1 px-4 py-6 sm:px-6 lg:ml-[292px] lg:w-[calc(100%-292px)]">
        <aside className="mb-4 h-fit rounded-2xl border border-hairline bg-white/[0.03] p-3 shadow-[0_12px_32px_rgba(15,23,42,0.05)] backdrop-blur-xl lg:fixed lg:bottom-0 lg:left-0 lg:top-[85px] lg:z-30 lg:mb-0 lg:w-[292px] lg:overflow-y-auto lg:rounded-none lg:border-y-0 lg:border-l-0 lg:bg-white/[0.03] lg:px-4 lg:py-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-black uppercase tracking-[0.18em] text-paper-muted">Recent chats</div>
              <div className="mt-0.5 text-[11px] text-paper-muted">Last 48 hours</div>
            </div>
            <button
              type="button"
              onClick={() => loadConversations().catch(() => {})}
              disabled={historyLoading || conversationsLoading}
              className="rounded-lg border border-hairline px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-paper-muted transition hover:border-accent/55 hover:text-accent disabled:opacity-40"
            >
              Refresh
            </button>
          </div>
          <div className="space-y-2">
            {conversationsLoading && conversations.length === 0 ? (
              <>
                {[0, 1, 2].map((item) => (
                  <div key={item} className="h-[54px] animate-pulse rounded-xl border border-hairline bg-white/[0.05]" />
                ))}
              </>
            ) : conversations.length > 0 ? (
              conversations.slice(0, 12).map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => openConversation(conversation.id)}
                  disabled={historyLoading}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition disabled:opacity-50 ${
                    conversation.id === conversationId
                      ? 'border-accent/55 bg-accent/10 text-accent'
                      : 'border-hairline bg-white/[0.03] text-paper-muted hover:border-accent/55 hover:text-accent'
                  }`}
                >
                  <div className="truncate text-[12px] font-bold">{conversation.title || 'Ask AI chat'}</div>
                  <div className="mt-1 truncate text-[10px] text-paper-muted">{new Date(conversation.updated_at).toLocaleString()}</div>
                </button>
              ))
            ) : (
              <div className="rounded-xl border border-dashed border-hairline px-3 py-4 text-[12px] leading-5 text-paper-muted">
                {signedInUser ? 'No saved chats yet.' : 'Sign in to save Ask AI history.'}
              </div>
            )}
          </div>
        </aside>

        <div ref={scrollRef} className="mx-auto min-h-0 w-full max-w-[1040px] overflow-y-auto">
        {isEmpty ? (
          // ── LAUNCHER ── console-first: the input is the centrepiece, and the
          // prompts below are grouped by intent so the page explains itself.
          <div className="mx-auto max-w-[900px] py-10 sm:py-16">
            <div className="animate-rise flex items-center gap-3">
              <span className="h-px w-9 bg-accent/60" />
              <span className="font-body text-[11px] font-medium uppercase tracking-[0.28em] text-accent">
                Research desk
              </span>
            </div>
            <h1
              className="animate-rise mt-6 max-w-[20ch] font-display text-[clamp(2.4rem,5.4vw,4rem)] font-normal leading-[0.98] text-paper"
              style={{ animationDelay: '60ms' }}
            >
              Ask it. Then make
              <br />
              it <em className="italic text-accent">prove it.</em>
            </h1>
            <p
              className="animate-rise mt-6 max-w-[60ch] font-body text-[15px] leading-8 text-paper-muted"
              style={{ animationDelay: '120ms' }}
            >
              Describe a strategy in plain English and it gets tested on real history — with the
              honest comparison most tools leave out: how it did against simply buying and holding.
            </p>

            <div className="animate-rise mt-9" style={{ animationDelay: '180ms' }}>
              {renderConsole(true)}
              <p className="mt-3 pl-5 font-body text-[11px] text-paper-muted/70">
                Press Enter to ask · Shift + Enter for a new line
              </p>
            </div>

            {/* Intent grid — four things this desk can do. */}
            <div className="mt-14 grid gap-x-10 gap-y-9 sm:grid-cols-2">
              {PROMPT_GROUPS.map((group, gi) => (
                <div
                  key={group.label}
                  className="animate-rise border-t border-hairline pt-5"
                  style={{ animationDelay: `${240 + gi * 70}ms` }}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-display text-[19px] leading-none text-paper">{group.label}</span>
                    <span className="font-body text-[10px] uppercase tracking-[0.2em] text-paper-muted/70">
                      {String(gi + 1).padStart(2, '0')}
                    </span>
                  </div>
                  <p className="mt-2 font-body text-[12px] text-paper-muted/80">{group.blurb}</p>
                  <div className="mt-4 flex flex-col gap-2.5">
                    {group.prompts.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        onClick={() => send(prompt)}
                        className="group flex items-start gap-2.5 text-left font-body text-[13px] leading-relaxed text-paper-muted transition hover:text-paper"
                      >
                        <span
                          aria-hidden="true"
                          className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent/60 transition group-hover:bg-accent"
                        />
                        <span className="underline-offset-4 group-hover:underline">{prompt}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {messages.map((message) => (
              // Editorial transcript, not a chat log: the question reads as a
              // serif pull-quote and the answer as a research note set directly
              // on the page — no bubbles, no avatar.
              <div key={message.id} className="animate-rise">
                {message.role === 'user' ? (
                  <div className="border-l-2 border-accent/70 py-1 pl-5">
                    <div className="font-body text-[10px] font-medium uppercase tracking-[0.24em] text-accent/80">
                      You asked
                    </div>
                    <p className="mt-2 font-display text-[clamp(1.3rem,2.4vw,1.75rem)] leading-snug text-paper">
                      {message.content}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="w-full">
                      <div
                        className={`border-t pt-5 text-[14px] ${
                          message.error ? 'border-rose-400/40 text-rose-200' : 'border-hairline text-paper-muted'
                        }`}
                      >
                      <div className="mb-4 flex items-baseline justify-between gap-4">
                        <span className={`font-body text-[10px] font-medium uppercase tracking-[0.24em] ${message.error ? 'text-rose-300' : 'text-primary'}`}>
                          {message.error ? 'Could not answer' : 'Bullseye · answer'}
                        </span>
                        {message.thoughtMs !== undefined && (
                          <span className="shrink-0 font-numeric text-[10px] uppercase tracking-widest text-paper-muted/70">
                            {formatDuration(message.thoughtMs)}
                          </span>
                        )}
                      </div>
                      <div className="prose-sm">{renderMarkdown(message.content, message.error ? undefined : send)}</div>
                      {message.data?.backtest && (
                        <BacktestCard data={message.data.backtest} ticker={message.data.target_stock ?? null} />
                      )}
                      {message.data?.mode === 'strategy' && message.data.strategy_alert?.stats && (
                        <div className="mt-3 rounded-xl border border-hairline bg-white/[0.03] p-3">
                          <div className="text-[11px] font-bold uppercase tracking-widest text-paper-muted">Backtest (educational)</div>
                          <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                            <div>
                              <div className="text-[10px] uppercase tracking-wider text-paper-muted">Trades</div>
                              <div className="text-sm font-bold text-paper">{Number(message.data.strategy_alert.stats.trades ?? 0)}</div>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase tracking-wider text-paper-muted">Win rate</div>
                              <div className="text-sm font-bold text-paper">{Number(message.data.strategy_alert.stats.win_rate ?? 0).toFixed(2)}%</div>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase tracking-wider text-paper-muted">Avg trade</div>
                              <div className="text-sm font-bold text-paper">{Number(message.data.strategy_alert.stats.avg_return_per_trade ?? 0).toFixed(2)}%</div>
                            </div>
                            <div>
                              <div className="text-[10px] uppercase tracking-wider text-paper-muted">Max drawdown</div>
                              <div className="text-sm font-bold text-paper">{Number(message.data.strategy_alert.stats.max_drawdown ?? 0).toFixed(2)}%</div>
                            </div>
                          </div>
                          {!message.data.strategy_alert.alertable && message.data.strategy_alert.quality?.reason && (
                            <p className="mt-2 text-[11px] leading-4 text-paper-muted">{message.data.strategy_alert.quality.reason}</p>
                          )}
                          {message.data.strategy_alert.disclaimer && (
                            <p className="mt-2 text-[10px] leading-4 text-paper-muted">{message.data.strategy_alert.disclaimer}</p>
                          )}
                        </div>
                      )}
                      {message.data?.strategy_alert?.alertable && message.data?.strategy_json && (
                        <div className="mt-3 rounded-xl border border-primary/30 bg-primary/[0.06] p-3">
                          <div className="text-[11px] font-bold uppercase tracking-widest text-primary">Daily alert available</div>
                          <p className="mt-1 text-[12px] leading-5 text-paper-muted">
                            {message.data.strategy_alert.quality?.reason || 'This strategy passed the quality gate.'}
                          </p>
                          <button
                            type="button"
                            onClick={() => saveStrategyAlert(message.data || {}).catch(() => {})}
                            className="mt-3 rounded-lg bg-primary px-3 py-2 text-[12px] font-semibold text-black transition hover:opacity-90"
                          >
                            Save as daily alert
                          </button>
                          <p className="mt-2 text-[10px] leading-4 text-paper-muted/70">{message.data.disclaimer}</p>
                        </div>
                      )}
                      {message.data?.mode === 'movers' && message.data.scan && (
                        <MoversCard data={message.data.scan as MoversScan} />
                      )}
                      {message.data?.mode === 'cross_scan' && message.data.scan && (
                        <ScanCard data={message.data.scan as Scan} />
                      )}
                      {message.data?.mode === 'screener' && message.data.screener && (
                        <ScreenerCard data={message.data.screener} />
                      )}
                      {message.data?.model_used && message.data.model_used !== 'local' && (
                        <div className="mt-2 text-[9px] font-bold uppercase tracking-widest text-paper-muted">
                          via {message.data.model_used}
                        </div>
                      )}
                    </div>
                      {message.data?.suggestions && message.data.suggestions.length > 0 && (
                        <div className="mt-2.5">
                          <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-paper-muted">
                            Tap to ask next
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {message.data.suggestions.map((suggestion) => (
                              <button
                                key={suggestion}
                                type="button"
                                onClick={() => send(suggestion)}
                                disabled={loading}
                                className="group/sg inline-flex items-center gap-1.5 rounded-full border border-hairline bg-white/[0.03] px-3 py-1 text-[11px] font-medium text-paper-muted transition hover:border-accent/55 hover:bg-white/[0.03] hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                <span className="text-accent transition group-hover/sg:text-accent" aria-hidden="true">→</span>
                                {suggestion}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            ))}
            {loading && (
              <div className="flex justify-start gap-2.5">
                <div className="mt-0.5 hidden h-8 w-8 shrink-0 animate-pulse items-center justify-center rounded-xl border border-accent/40 bg-accent/10 text-sm text-accent sm:flex" aria-hidden="true">✦</div>
                <div className="flex flex-wrap items-center gap-3 rounded-2xl rounded-tl-md border border-hairline bg-white/[0.03] px-4 py-3 text-[14px] text-paper-muted shadow-[0_16px_44px_rgba(15,23,42,0.07)] backdrop-blur-sm">
                  <div className="inline-flex items-center gap-2">
                    <span>Crunching the numbers</span>
                    <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent">
                      {formatDuration(elapsedMs)}
                    </span>
                    <span className="inline-flex gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-accent [animation:dot-bounce_1.2s_ease-in-out_infinite]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-accent [animation:dot-bounce_1.2s_ease-in-out_0.2s_infinite]" />
                      <span className="h-1.5 w-1.5 rounded-full bg-accent [animation:dot-bounce_1.2s_ease-in-out_0.4s_infinite]" />
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={stopThinking}
                    className="rounded-lg border border-rose-400/40 bg-rose-500/150/15 px-3 py-1 font-body text-[11px] font-semibold text-rose-200 transition hover:bg-rose-500/150/25"
                  >
                    <span className="mr-1 text-sm leading-none" aria-hidden="true">×</span>
                    Stop
                  </button>
                </div>
              </div>
            )}
            <div ref={bottomRef} aria-hidden="true" />
          </div>
        )}
        </div>
      </div>

      {/* Sticky composer only once a conversation exists — in the empty state
          the console lives in the launcher hero instead. */}
      {!isEmpty && (
        <div
          className="sticky bottom-0 border-t border-hairline backdrop-blur-xl lg:ml-[292px]"
          style={{ background: 'rgba(4,6,5,0.9)' }}
        >
          <div className="mx-auto w-full max-w-[1040px] px-4 py-3 sm:px-6 sm:py-4">
            {renderConsole(false)}
            <p className="mt-2.5 text-center font-body text-[10px] text-paper-muted/70">
              Educational analysis on historical data, not financial advice. Past performance does not predict future results.
            </p>
          </div>
        </div>
      )}
    </main>
  );
}
