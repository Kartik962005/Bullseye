"use client";

// Ask anything about the open stock. The backend routes each question to a
// computed answer (backtest, price on a date, profit/loss, indicator reading)
// or, for everything else, an LLM answer grounded in this stock's own data.
// Every result type renders in the page's card language; nothing light-themed.

import { useState } from "react";
import { STOCKS } from "@/app/stocks";
import { BACKEND } from "@/lib/client-cache";
import { buildMarketAnswer } from "@/lib/market-answer";

/* eslint-disable @typescript-eslint/no-explicit-any -- /stock-ai/search is untyped */

const EXAMPLES = [
  "Should I buy this stock now?",
  "How has it performed this year?",
  "Buy when stock drops 1% intraday, sell at 3% profit",
  "Buy Friday close, sell Monday open",
  "If I bought 100 shares 30 days ago, profit or loss?",
  "Current RSI and support / resistance",
];

const UP = "#6ff0b5";
const DOWN = "#ff8aa0";

function tone(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return undefined;
  return n > 0 ? UP : DOWN;
}

function fmtNumber(value: unknown, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? "—");
  return n.toLocaleString("en-IN", { maximumFractionDigits: digits });
}

function signedPct(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)}%`;
}

function humanLabel(label: string) {
  return String(label)
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b(rsi|sma|ema|macd|atr|ohlc)\b/g, (m) => m.toUpperCase())
    .replace(/^\w/, (c) => c.toUpperCase());
}

function Tile({ label, value, color, hint }: { label: string; value: React.ReactNode; color?: string; hint?: string }) {
  return (
    <div className="min-w-0 rounded-2xl bg-white/[0.04] px-4 py-3">
      <div className="text-[12px] text-[#9f99c2]">{label}</div>
      <div className="mt-1 truncate font-numeric text-[17px] text-paper" style={color ? { color } : undefined}>
        {value}
      </div>
      {hint ? <div className="mt-0.5 text-[11.5px] text-[#8f89ad]">{hint}</div> : null}
    </div>
  );
}

function Summary({ text }: { text?: string | null }) {
  if (!text) return null;
  return (
    <div className="flex gap-3 rounded-2xl border border-[#ff4fa3]/20 bg-[#ff4fa3]/[0.06] px-4 py-3.5">
      <SparkIcon className="mt-0.5 h-4 w-4 shrink-0 text-[#ff79c0]" />
      <p className="text-[14px] leading-6 text-[#e9e5ff]">{text}</p>
    </div>
  );
}

function SparkIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path d="M10 2.5 11.6 8.4 17.5 10l-5.9 1.6L10 17.5l-1.6-5.9L2.5 10l5.9-1.6L10 2.5Z" fill="currentColor" />
    </svg>
  );
}

/** Compounded equity curve from the trade log, as a small inline chart. */
function EquityCurve({ trades }: { trades: any[] }) {
  const values = [100];
  trades.forEach((t) => values.push(values[values.length - 1] * (1 + Number(t.return_pct || 0) / 100)));
  if (values.length < 3) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 0.0001);
  const W = 600;
  const H = 120;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(H - ((v - min) / span) * (H - 12) - 6).toFixed(1)}`);
  const up = values[values.length - 1] >= values[0];
  const color = up ? "#2fe0a0" : "#ff5c7a";
  return (
    <div className="rounded-2xl bg-white/[0.03] px-4 pb-3 pt-3.5">
      <div className="flex items-center justify-between text-[12px] text-[#9f99c2]">
        <span>Growth of ₹100, trade by trade</span>
        <span className="font-numeric" style={{ color }}>
          ₹{fmtNumber(values[values.length - 1])}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-2 h-24 w-full" role="img" aria-label="Equity curve of the backtest">
        <defs>
          <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.3" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`M${pts.join(" L")} L${W},${H} L0,${H} Z`} fill="url(#eq-fill)" />
        <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function StrategyResult({ result, currency }: { result: any; currency: string }) {
  const m = result.custom_metrics ?? {};
  const s = m.summary ?? {};
  const trades: any[] = m.trades ?? [];
  const projected = m.mode === "weekday_projection";
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Tile label="Trades" value={m.total_trades ?? "—"} />
        <Tile label="Win rate" value={m.win_rate !== undefined ? `${m.win_rate}%` : "—"} color={Number(m.win_rate) >= 50 ? UP : DOWN} />
        <Tile label="Avg per trade" value={signedPct(m.avg_return_per_trade_pct)} color={tone(m.avg_return_per_trade_pct)} />
        <Tile label="Total return" value={signedPct(m.total_return_pct)} color={tone(m.total_return_pct)} hint="Compounded" />
        <Tile
          label="Buy & hold"
          value={signedPct(s.buy_and_hold_return_pct ?? m.buy_and_hold_return_pct)}
          color={tone(s.buy_and_hold_return_pct ?? m.buy_and_hold_return_pct)}
          hint="Same period"
        />
      </div>

      <Summary text={result.ai_summary} />

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-2xl bg-white/[0.03] px-4 py-3">
          <div className="text-[12px] text-[#9f99c2]">Entry rule</div>
          <div className="mt-1 text-[13.5px] text-paper">{m.buy_expr || "—"}</div>
        </div>
        <div className="rounded-2xl bg-white/[0.03] px-4 py-3">
          <div className="text-[12px] text-[#9f99c2]">Exit rule</div>
          <div className="mt-1 text-[13.5px] text-paper">{m.sell_expr || "—"}</div>
        </div>
      </div>

      {!projected && <EquityCurve trades={trades} />}

      <p className="text-[13px] leading-6 text-[#9f99c2]">
        {m.analysis_text || result.answer}
        {" "}Worst trade {signedPct(s.worst_trade_pct ?? m.worst_trade_pct)}, best {signedPct(s.best_trade_pct ?? m.best_trade_pct)}, max drawdown{" "}
        {signedPct(s.max_drawdown_pct ?? m.max_drawdown_pct)}.
      </p>

      {m.open_trade && (
        <div className="rounded-2xl border border-[#ffb547]/25 bg-[#ffb547]/[0.06] px-4 py-3">
          <div className="text-[12px] font-medium text-[#ffcf85]">Open trade</div>
          <div className="mt-1.5 flex flex-wrap gap-x-6 gap-y-1 font-numeric text-[13px] text-paper">
            <span>Bought {m.open_trade.buy_date}{m.open_trade.buy_day ? ` (${m.open_trade.buy_day})` : ""}</span>
            <span>at {currency}{fmtNumber(m.open_trade.buy_price)}</span>
            {m.open_trade.target_price ? <span>target {currency}{fmtNumber(m.open_trade.target_price)}</span> : null}
            <span>now {currency}{fmtNumber(m.open_trade.current_price)}</span>
            <span style={{ color: tone(m.open_trade.return_pct) }}>{signedPct(m.open_trade.return_pct)}</span>
          </div>
        </div>
      )}

      {trades.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-white/[0.07]">
          <div className="flex items-center justify-between bg-white/[0.03] px-4 py-2.5">
            <span className="text-[13px] font-medium text-paper">{projected ? "Projected setups" : "Trade log"}</span>
            <span className="text-[12px] text-[#8f89ad]">{projected ? m.scope : `Latest ${trades.length}`}</span>
          </div>
          <div className="max-h-[360px] overflow-auto" data-lenis-prevent>
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead className="sticky top-0 bg-[#141029]">
                <tr>
                  {["Bought", "Buy", "Sold", "Sell", "Held", "Return", ""].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-[11.5px] font-medium text-[#9f99c2]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...trades].reverse().map((t, i) => (
                  <tr key={`${t.buy_date}-${t.sell_date}-${i}`} className="border-t border-white/[0.05] transition-colors hover:bg-white/[0.03]">
                    <td className="px-4 py-2.5 font-numeric text-[12.5px] text-[#e9e5ff]">
                      {t.buy_date}
                      <span className="ml-1.5 text-[#8f89ad]">{String(t.buy_day || "").slice(0, 3)}</span>
                    </td>
                    <td className="px-4 py-2.5 font-numeric text-[12.5px] text-paper">{currency}{fmtNumber(t.buy_price)}</td>
                    <td className="px-4 py-2.5 font-numeric text-[12.5px] text-[#e9e5ff]">
                      {t.sell_date}
                      <span className="ml-1.5 text-[#8f89ad]">{String(t.sell_day || "").slice(0, 3)}</span>
                    </td>
                    <td className="px-4 py-2.5 font-numeric text-[12.5px] text-paper">{currency}{fmtNumber(t.sell_price)}</td>
                    <td className="px-4 py-2.5 font-numeric text-[12.5px] text-[#c9c3e6]">{t.holding_days}d</td>
                    <td className="px-4 py-2.5 font-numeric text-[12.5px]" style={{ color: tone(t.return_pct) }}>
                      {signedPct(t.return_pct)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
                          t.result === "WIN"
                            ? "bg-[#3dffa2]/12 text-[#6ff0b5]"
                            : t.result === "PROJECTED"
                              ? "bg-white/[0.07] text-[#c9c3e6]"
                              : "bg-[#ff5c7a]/12 text-[#ff8aa0]"
                        }`}
                      >
                        {t.result === "WIN" ? "Win" : t.result === "PROJECTED" ? "Projected" : "Loss"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function RoiResult({ result, currency }: { result: any; currency: string }) {
  const pnl = Number(result.pnl ?? 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-2xl bg-white/[0.03] px-5 py-4">
        <div>
          <div className="text-[12px] text-[#9f99c2]">{pnl >= 0 ? "Profit" : "Loss"}</div>
          <div className="mt-1 font-numeric text-[28px] leading-none" style={{ color: pnl >= 0 ? UP : DOWN }}>
            {pnl >= 0 ? "+" : "−"}{currency}{fmtNumber(Math.abs(pnl))}
          </div>
        </div>
        <span className="rounded-full px-3 py-1 font-numeric text-[14px]" style={{ color: pnl >= 0 ? UP : DOWN, background: pnl >= 0 ? "rgba(61,255,162,.12)" : "rgba(255,92,122,.12)" }}>
          {signedPct(result.return_pct)}
        </span>
      </div>
      <Summary text={result.ai_summary || result.answer} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Shares" value={fmtNumber(result.quantity, 0)} />
        <Tile label={`Bought ${result.investment_date ?? ""}`} value={`${currency}${fmtNumber(result.buy_price)}`} />
        <Tile label={`Now (${result.latest_date ?? ""})`} value={`${currency}${fmtNumber(result.current_price)}`} />
        <Tile label="Value now" value={`${currency}${fmtNumber(result.current_value)}`} hint={`Invested ${currency}${fmtNumber(result.invested)}`} />
      </div>
      {result.exact_match === false && (
        <p className="text-[12.5px] text-[#ffcf85]">That date wasn&apos;t a trading day, so the nearest session was used.</p>
      )}
    </div>
  );
}

function PriceResult({ result, currency }: { result: any; currency: string }) {
  const c = result.candle;
  if (!c) return <p className="text-[14px] text-[#c9c3e6]">No trading data was found for {result.requested_date}.</p>;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Open" value={`${currency}${fmtNumber(c.open)}`} />
        <Tile label="High" value={`${currency}${fmtNumber(c.high)}`} color={UP} />
        <Tile label="Low" value={`${currency}${fmtNumber(c.low)}`} color={DOWN} />
        <Tile label="Close" value={`${currency}${fmtNumber(c.close)}`} hint={c.date || c.day} />
      </div>
      <Summary text={result.ai_summary} />
      {result.exact_match === false && (
        <p className="text-[12.5px] text-[#ffcf85]">
          {result.requested_date} wasn&apos;t a trading day, so the nearest session is shown.
        </p>
      )}
    </div>
  );
}

function RowsGrid({ rows, currency }: { rows: Array<[string, any]>; currency: string }) {
  const priceLike = /close|price|high|low|open|sma|ema|support|resistance/i;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {rows.map(([label, value]) => {
        const isPct = /week|month|year|%|from 52/i.test(label) && typeof value === "number";
        const shown =
          typeof value === "number"
            ? isPct
              ? signedPct(value)
              : `${priceLike.test(label) ? currency : ""}${fmtNumber(value)}`
            : String(value);
        return <Tile key={label} label={humanLabel(label)} value={shown} color={isPct ? tone(value) : undefined} />;
      })}
    </div>
  );
}

function AnswerResult({ result, currency }: { result: any; currency: string }) {
  const [showData, setShowData] = useState(false);
  const rows: Array<[string, any]> = result.rows ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-2xl bg-white/[0.03] px-5 py-4">
        {result.title && result.title !== "Answer" ? (
          <div className="mb-1.5 text-[13px] font-medium text-[#ff79c0]">{result.title}</div>
        ) : null}
        <p className="whitespace-pre-line text-[15px] leading-7 text-[#efecff]">{result.answer}</p>
        {result.answered_by === "ai" ? (
          <div className="mt-3 flex items-center gap-1.5 text-[12px] text-[#8f89ad]">
            <SparkIcon className="h-3.5 w-3.5 text-[#ff79c0]" />
            Written by AI from this stock&apos;s price data
          </div>
        ) : null}
      </div>
      {rows.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowData((v) => !v)}
            className="flex items-center gap-1.5 text-[13px] text-[#c9c3e6] transition hover:text-white"
            aria-expanded={showData}
          >
            <svg viewBox="0 0 20 20" className={`h-4 w-4 transition-transform ${showData ? "rotate-90" : ""}`} fill="none" aria-hidden>
              <path d="m8 5 5 5-5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {showData ? "Hide the data used" : "Show the data used"}
          </button>
          {showData && (
            <div className="anim-pop mt-3" data-state="open">
              <RowsGrid rows={rows} currency={currency} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TechnicalResult({ result, currency }: { result: any; currency: string }) {
  return (
    <div className="flex flex-col gap-3">
      <Summary text={result.ai_summary || result.answer} />
      <RowsGrid rows={(result.rows ?? []).filter(([k]: [string]) => k !== "latest_date")} currency={currency} />
    </div>
  );
}

export function AiMarketSearch({
  ticker,
  currency,
  analysis,
  chartData,
}: {
  ticker: string;
  currency: string;
  analysis: any;
  chartData: any;
}) {
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [loader, setLoader] = useState("");
  const symbol = ticker.replace(/\.(NS|BO)$/i, "");

  const ask = async (question?: string) => {
    const q = (question ?? prompt).trim();
    if (!q || running) return;
    if (question) setPrompt(question);
    setRunning(true);
    setResult(null);
    setLoader(`Reading ${symbol}'s price history…`);
    try {
      const res = await fetch(`${BACKEND}/api/v1/stock-ai/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: q,
          current_ticker: ticker,
          stocks: STOCKS.map((s) => ({ name: s.name, symbol: s.symbol, exchange: s.exchange, ticker: s.ticker, currency: s.currency })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        setResult({
          type: "error",
          answer:
            data?.detail ||
            (res.status === 429
              ? "Too many questions in a minute. Wait a moment and try again."
              : "The AI couldn't answer that right now. Try rephrasing, or pick one of the examples."),
        });
        return;
      }
      setResult(data);
    } catch {
      const fallback = buildMarketAnswer(q, analysis, ticker, currency, chartData);
      setResult(
        fallback ?? {
          type: "error",
          answer: "Couldn't reach the AI service. The backend may be waking up; try again in a few seconds.",
        },
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="sx-card p-5 sm:p-6">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-[#7c5cff] to-[#ff2e97]">
          <SparkIcon className="h-4 w-4 text-white" />
        </span>
        <div>
          <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-paper">Ask about {symbol}</h2>
          <p className="text-[12.5px] text-[#9f99c2]">Questions, profit/loss, or test a buy/sell rule on its real history.</p>
        </div>
      </div>

      <form
        className="mt-5 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <div className="relative min-w-0 flex-1">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={`e.g. Should I buy ${symbol} now?`}
            className="nova-field !h-12 !rounded-2xl !pl-4 !text-[15px]"
            aria-label={`Ask a question about ${symbol}`}
          />
        </div>
        <button
          type="submit"
          disabled={running || !prompt.trim()}
          className="h-12 shrink-0 rounded-2xl bg-[#ff4fa3] px-5 text-[14px] font-semibold text-[#14051a] transition hover:bg-[#ff6db3] disabled:opacity-40"
        >
          {running ? "Thinking…" : "Ask"}
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => void ask(example)}
            disabled={running}
            className="rounded-full bg-white/[0.05] px-3 py-1.5 text-[12.5px] text-[#c9c3e6] transition hover:bg-white/[0.09] hover:text-white disabled:opacity-50"
          >
            {example}
          </button>
        ))}
      </div>

      {running && (
        <div className="mt-5 flex flex-col gap-2" aria-live="polite">
          <div className="flex items-center gap-3 text-[13px] text-[#b9b4d6]">
            <span className="nova-spinner" aria-hidden />
            {loader}
          </div>
          <div className="sx-skeleton h-16" />
          <div className="sx-skeleton h-10" />
        </div>
      )}

      {result && !running && (
        <div className="mt-5 animate-in fade-in slide-in-from-bottom-2 duration-300" aria-live="polite">
          {result.type === "error" || result.error || result.custom_metrics?.error ? (
            <div className="rounded-2xl border border-[#ff5c7a]/25 bg-[#ff5c7a]/[0.07] px-4 py-3 text-[14px] text-[#ffb3c1]">
              {result.answer || result.error || result.custom_metrics?.error}
            </div>
          ) : result.type === "strategy_test" || result.custom_metrics ? (
            <StrategyResult result={result} currency={currency} />
          ) : result.type === "historical_roi" ? (
            <RoiResult result={result} currency={currency} />
          ) : result.type === "historical_price" ? (
            <PriceResult result={result} currency={currency} />
          ) : result.type === "technical_analysis" ? (
            <TechnicalResult result={result} currency={currency} />
          ) : (
            <AnswerResult result={result} currency={currency} />
          )}
        </div>
      )}
    </section>
  );
}

export default AiMarketSearch;
