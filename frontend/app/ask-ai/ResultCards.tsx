'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { AskAiResponse, Backtest, MoversScan, Scan, ScreenerResult } from './types';

export function pct(value: number | undefined | null) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function tone(value: number | undefined | null) {
  if (value === undefined || value === null || Number.isNaN(value) || value === 0) return 'text-white';
  return value > 0 ? 'text-[#6ff0b5]' : 'text-[#ff8aa0]';
}

function num(value: number | undefined | null, digits = 2) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  return value.toLocaleString('en-IN', { maximumFractionDigits: digits });
}

const stockHref = (ticker: string) => `/stock/${encodeURIComponent(ticker.includes('.') ? ticker : `${ticker}.NS`)}`;

function Card({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <div className="sx-card mt-4 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="sx-label">{title}</span>
        {badge}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value, className = 'text-white' }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-2xl bg-white/[0.04] px-3.5 py-2.5">
      <div className="text-[11.5px] text-[#9f99c2]">{label}</div>
      <div className={`mt-0.5 font-numeric text-[17px] ${className}`}>{value}</div>
    </div>
  );
}

function Rule({ buy, sell }: { buy?: string; sell?: string }) {
  if (!buy && !sell) return null;
  return (
    <div className="mt-3 flex flex-col gap-1.5">
      {buy && (
        <div className="flex items-start gap-2 text-[12px]">
          <span className="rounded-md bg-[#3dffa2]/15 px-1.5 py-0.5 font-numeric text-[10.5px] text-[#6ff0b5]">BUY</span>
          <code className="min-w-0 break-all font-numeric text-[#c9c3e6]">{buy}</code>
        </div>
      )}
      {sell && (
        <div className="flex items-start gap-2 text-[12px]">
          <span className="rounded-md bg-[#ff5c7a]/15 px-1.5 py-0.5 font-numeric text-[10.5px] text-[#ff8aa0]">SELL</span>
          <code className="min-w-0 break-all font-numeric text-[#c9c3e6]">{sell}</code>
        </div>
      )}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="scr-note mt-3">{children}</p>;
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="scr-scroll -mx-4 mt-4 border-t border-white/[0.06] sm:-mx-5">
      <table className="scr-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} className={i === 0 ? 'scr-sticky' : ''}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function StockCell({ ticker, symbol, name }: { ticker: string; symbol?: string; name?: string }) {
  return (
    <td className="scr-sticky">
      <Link href={stockHref(ticker)} className="block text-[13.5px] font-medium text-white hover:text-[#ff79c0]">
        {symbol || ticker}
      </Link>
      {name && <div className="max-w-[12rem] truncate text-[11px] text-[#8e88b3]">{name}</div>}
    </td>
  );
}

export function BacktestCard({ data, ticker }: { data: Backtest; ticker: string | null }) {
  const s = data.summary;
  const signal = (data.current_signal || 'HOLD').toUpperCase();
  const signalClass =
    signal === 'BUY' ? 'is-up' : signal === 'SELL' ? 'is-down' : '';
  return (
    <Card
      title={`Backtest${ticker ? ` · ${ticker.replace(/\.(NS|BO)$/, '')}` : ''}`}
      badge={<span className={`sx-change ${signalClass} !text-[12px]`}>Signal today: {signal}</span>}
    >
      <Rule buy={data.buy_expr} sell={data.sell_expr} />
      {s ? (
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Trades" value={String(s.total_trades)} />
          <Stat label="Win rate" value={`${s.win_rate}%`} />
          <Stat label="Strategy return" value={pct(s.total_return_pct)} className={tone(s.total_return_pct)} />
          <Stat label="Buy & hold" value={pct(data.buy_and_hold_return_pct)} className={tone(data.buy_and_hold_return_pct)} />
          <Stat label="Beat buy & hold by" value={pct(data.alpha_vs_buy_hold_pct)} className={tone(data.alpha_vs_buy_hold_pct)} />
          <Stat label="Average trade" value={pct(s.avg_return_per_trade_pct)} className={tone(s.avg_return_per_trade_pct)} />
          <Stat label="Worst drawdown" value={pct(s.max_drawdown_pct)} className="text-[#ff8aa0]" />
          <Stat label="Profit factor" value={s.profit_factor !== undefined ? String(s.profit_factor) : '—'} />
        </div>
      ) : (
        <Notice>{data.warning || 'This rule never triggered a trade in the test period.'}</Notice>
      )}
      {data.trades && data.trades.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-[13px] text-[#c9c3e6] hover:text-white">
            Last {Math.min(data.trades.length, 12)} trades
          </summary>
          <Table head={['Bought', 'Sold', 'Days', 'Return']}>
            {data.trades.slice(-12).reverse().map((t, i) => (
              <tr key={i}>
                <td className="scr-sticky font-numeric text-[12px] text-[#c9c3e6]">
                  {t.buy_date} · ₹{num(t.buy_price)}
                </td>
                <td>
                  {t.sell_date} · ₹{num(t.sell_price)}
                </td>
                <td>{t.holding_days}</td>
                <td className={t.return_pct > 0 ? 'is-up' : t.return_pct < 0 ? 'is-down' : ''}>{pct(t.return_pct)}</td>
              </tr>
            ))}
          </Table>
        </details>
      )}
    </Card>
  );
}

export function ScanCard({ data }: { data: Scan }) {
  return (
    <Card title="Strategy across stocks">
      <Rule buy={data.buy_expr} sell={data.sell_expr} />
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="Scanned" value={data.universe ? `${data.scanned} / ${data.universe}` : String(data.scanned)} />
        <Stat label="Traded" value={String(data.traded)} />
        <Stat label="Profitable" value={`${data.profitable} / ${data.traded}`} className="text-[#6ff0b5]" />
        <Stat label="Beat buy & hold" value={`${data.beat_buy_hold} / ${data.traded}`} />
        <Stat label="Average return" value={pct(data.avg_total_return_pct)} className={tone(data.avg_total_return_pct)} />
      </div>
      {data.partial && (
        <Notice>
          Scanned {data.scanned} of {data.universe} stocks within the time limit. Ask again to continue the scan.
        </Notice>
      )}
      {data.rows.length > 0 && (
        <Table head={['Stock', 'Return', 'Win rate', 'Trades', 'Buy & hold', 'Edge']}>
          {data.rows.slice(0, 15).map(r => (
            <tr key={r.ticker}>
              <StockCell ticker={r.ticker} symbol={r.symbol} name={r.name} />
              <td className={r.total_return_pct > 0 ? 'is-up' : r.total_return_pct < 0 ? 'is-down' : ''}>{pct(r.total_return_pct)}</td>
              <td>{r.win_rate}%</td>
              <td>{r.total_trades}</td>
              <td className={r.buy_hold_pct > 0 ? 'is-up' : r.buy_hold_pct < 0 ? 'is-down' : ''}>{pct(r.buy_hold_pct)}</td>
              <td className={r.alpha_pct > 0 ? 'is-up' : r.alpha_pct < 0 ? 'is-down' : ''}>{pct(r.alpha_pct)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}

export function MoversCard({ data }: { data: MoversScan }) {
  const losers = /declin|loser|lower/i.test(data.direction || '');
  return (
    <Card
      title={`${losers ? 'Biggest fallers' : 'Biggest gainers'}${data.session_date ? ` · ${data.session_date}` : ''}`}
      badge={
        <span className="text-[12px] text-[#9f99c2]">
          {data.ready ? `${data.universe} stocks checked` : `Checking ${data.coverage} of ${data.universe}`}
        </span>
      }
    >
      {data.rows.length > 0 ? (
        <Table head={['Stock', 'Change', 'Close']}>
          {data.rows.slice(0, 15).map(r => (
            <tr key={r.ticker}>
              <StockCell ticker={r.ticker} symbol={r.symbol} name={r.name} />
              <td className={r.change_pct > 0 ? 'is-up' : r.change_pct < 0 ? 'is-down' : ''}>{pct(r.change_pct)}</td>
              <td>₹{num(r.close)}</td>
            </tr>
          ))}
        </Table>
      ) : (
        <Notice>Scanning the whole market now. Ask again in a moment for the full ranking.</Notice>
      )}
      {!data.ready && data.rows.length > 0 && (
        <p className="mt-3 text-[12px] text-[#9f99c2]">
          Still scanning ({data.coverage} of {data.universe}). Ask again shortly for the complete list.
        </p>
      )}
    </Card>
  );
}

export function ScreenerCard({ data }: { data: ScreenerResult }) {
  const rows = data.rows || [];
  return (
    <Card title="Matching stocks" badge={<span className="text-[12px] text-[#9f99c2]">{rows.length} found</span>}>
      {data.matchedRules && data.matchedRules.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {data.matchedRules.slice(0, 6).map(rule => (
            <span key={rule} className="scr-rule !py-1 !text-[12px]">
              {rule}
            </span>
          ))}
        </div>
      )}
      {rows.length > 0 ? (
        <Table head={['Stock', 'Market cap', 'P/E', 'ROE', 'Debt / equity', 'Revenue growth', '1Y']}>
          {rows.slice(0, 20).map((row, i) => {
            const ticker = row.stock?.ticker || row.stock?.symbol || `match-${i}`;
            return (
              <tr key={`${ticker}-${i}`}>
                <StockCell ticker={ticker} symbol={row.stock?.symbol} name={row.stock?.name} />
                <td>{row.marketCapCr ? `₹${num(row.marketCapCr, 0)} cr` : '—'}</td>
                <td>{num(row.pe, 1)}</td>
                <td>{row.roe !== null && row.roe !== undefined ? `${num(row.roe, 1)}%` : '—'}</td>
                <td>{num(row.debtToEquity)}</td>
                <td className={(row.revenueGrowth3Yr ?? 0) > 0 ? 'is-up' : (row.revenueGrowth3Yr ?? 0) < 0 ? 'is-down' : ''}>{pct(row.revenueGrowth3Yr)}</td>
                <td className={(row.technical?.return1yPct ?? 0) > 0 ? 'is-up' : (row.technical?.return1yPct ?? 0) < 0 ? 'is-down' : ''}>
                  {pct(row.technical?.return1yPct)}
                </td>
              </tr>
            );
          })}
        </Table>
      ) : (
        <Notice>No stock matched every condition.</Notice>
      )}
    </Card>
  );
}

export function StrategyCard({
  data,
  onSave,
  saving,
}: {
  data: Partial<AskAiResponse>;
  onSave: () => void;
  saving: boolean;
}) {
  const alert = data.strategy_alert;
  if (!alert) return null;
  const stats = alert.stats;
  return (
    <>
      {data.mode === 'strategy' && stats && (
        <Card title="Backtest across the market">
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Trades" value={String(Number(stats.trades ?? 0))} />
            <Stat label="Win rate" value={`${Number(stats.win_rate ?? 0).toFixed(1)}%`} />
            <Stat label="Average trade" value={pct(Number(stats.avg_return_per_trade ?? 0))} className={tone(Number(stats.avg_return_per_trade ?? 0))} />
            <Stat label="Worst drawdown" value={pct(Number(stats.max_drawdown ?? 0))} className="text-[#ff8aa0]" />
          </div>
          {!alert.alertable && alert.quality?.reason && <Notice>{alert.quality.reason}</Notice>}
        </Card>
      )}
      {alert.alertable && data.strategy_json && (
        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-[20px] border border-[#3dffa2]/25 bg-[#3dffa2]/[0.06] p-4">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-medium text-white">Get this as a daily email alert</div>
            <p className="mt-0.5 text-[13px] leading-6 text-[#b9b4d6]">
              {alert.quality?.reason || 'This strategy passed the quality checks.'}
            </p>
          </div>
          <button type="button" onClick={onSave} disabled={saving} className="nova-btn nova-btn-primary !h-10 !px-5 !text-[13px] disabled:opacity-60">
            {saving ? 'Saving…' : 'Save alert'}
          </button>
        </div>
      )}
    </>
  );
}
