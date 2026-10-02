"use client";

// The Financials tab: who the company is, its headline numbers, the four
// statements behind one switch (instead of four stacked tables), and ratios.
// Each statement row carries a trend line and the latest period's change, so
// direction is readable without scanning every column.

import { useState } from "react";
import {
  formatCompactRupees,
  formatCurrencyNumber,
  formatIndianNumber,
  formatMarketCap,
  formatRatioValue,
  humanizeLabel,
} from "@/lib/format";
import { formatFaceValue } from "@/lib/stock";
import type { STOCKS } from "@/app/stocks";

/* eslint-disable @typescript-eslint/no-explicit-any -- /fundamentals is untyped */

type Stock = (typeof STOCKS)[number];

const STATEMENTS = [
  ["quarterly_results", "Quarterly"],
  ["profit_and_loss", "Profit & loss"],
  ["balance_sheet", "Balance sheet"],
  ["cash_flow", "Cash flow"],
] as const;

function Sparkline({ values }: { values: number[] }) {
  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length < 2) return <span className="text-[#5f5a7d]">—</span>;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = Math.max(max - min, 1e-9);
  const W = 72;
  const H = 22;
  const d = pts.map((v, i) => `${i === 0 ? "M" : "L"}${((i / (pts.length - 1)) * W).toFixed(1)},${(H - 2 - ((v - min) / span) * (H - 4)).toFixed(1)}`).join(" ");
  const up = pts[pts.length - 1] >= pts[0];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[22px] w-[72px]" aria-hidden>
      <path d={d} fill="none" stroke={up ? "#2fe0a0" : "#ff5c7a"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function formatCell(value: any, currency: string) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return Math.abs(n) >= 100000 ? formatCompactRupees(n) : formatCurrencyNumber(n, currency, 2);
}

function StatementTable({ table, currency }: { table: any; currency: string }) {
  const columns: string[] = table?.columns ?? [];
  const rows: any[] = table?.rows ?? [];
  if (!rows.length || !columns.length) {
    return (
      <div className="sx-empty h-40">
        <div className="text-[14px] text-[#c9c3e6]">This statement isn&apos;t available for this stock yet.</div>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/[0.06]" data-lenis-prevent>
      <table className="w-full min-w-[760px] border-collapse text-left">
        <thead>
          <tr className="bg-white/[0.03]">
            <th className="sticky left-0 z-[1] bg-[#141029] px-4 py-3 text-[12px] font-medium text-[#9f99c2]">Line item</th>
            <th className="px-3 py-3 text-[12px] font-medium text-[#9f99c2]">Trend</th>
            <th className="px-3 py-3 text-right text-[12px] font-medium text-[#9f99c2]">Change</th>
            {columns.map((c) => (
              <th key={c} className="whitespace-nowrap px-4 py-3 text-right text-[12px] font-medium text-[#9f99c2]">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const values: number[] = (row.values ?? []).map((v: any) => Number(v));
            // Columns run newest first; the trend reads oldest → newest.
            const chrono = [...values].reverse();
            const latest = values[0];
            const prev = values[1];
            const change = Number.isFinite(latest) && Number.isFinite(prev) && prev !== 0 ? ((latest - prev) / Math.abs(prev)) * 100 : null;
            return (
              <tr key={row.label} className="border-t border-white/[0.05] transition-colors hover:bg-white/[0.025]">
                <td className="sticky left-0 z-[1] whitespace-nowrap bg-[#110d24] px-4 py-2.5 text-[13.5px] text-[#e9e5ff]">
                  {humanizeLabel(row.label)}
                </td>
                <td className="px-3 py-2.5">
                  <Sparkline values={chrono} />
                </td>
                <td
                  className="whitespace-nowrap px-3 py-2.5 text-right font-numeric text-[12.5px]"
                  style={{ color: change === null ? "#8f89ad" : change >= 0 ? "#6ff0b5" : "#ff8aa0" }}
                >
                  {change === null ? "—" : `${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(1)}%`}
                </td>
                {(row.values ?? []).map((v: any, i: number) => (
                  <td key={`${row.label}-${i}`} className="whitespace-nowrap px-4 py-2.5 text-right font-numeric text-[13px] text-paper">
                    {formatCell(v, currency)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Financials({
  ticker,
  stock,
  currency,
  fundamentals,
  isLoading,
}: {
  ticker: string;
  stock: Stock;
  currency: string;
  fundamentals: any;
  isLoading: boolean;
}) {
  const [statement, setStatement] = useState<(typeof STATEMENTS)[number][0]>("quarterly_results");
  const [showFullAbout, setShowFullAbout] = useState(false);

  if (isLoading) {
    return (
      <div className="grid gap-5 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="sx-card p-6">
            <div className="sx-skeleton h-6 w-40" />
            <div className="mt-5 grid grid-cols-2 gap-2">
              {[0, 1, 2, 3].map((j) => (
                <div key={j} className="sx-skeleton h-16" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  const summary = fundamentals?.summary ?? {};
  const company = fundamentals?.company ?? {};
  const ratios = (fundamentals?.ratios ?? []).filter((r: any) => r?.value !== null && r?.value !== undefined);
  const about = company.description || `${stock.name} doesn't have a company profile in the data feed yet.`;
  const longAbout = about.length > 280;

  const glance = [
    ["Market cap", formatMarketCap(summary.market_cap, summary.market_cap_unit, currency)],
    ["P/E (trailing)", formatRatioValue(summary.trailing_pe)],
    ["Book value", formatCurrencyNumber(summary.book_value, currency, 2)],
    ["Dividend yield", formatRatioValue(summary.dividend_yield, "percent")],
    ["ROE", formatRatioValue(summary.return_on_equity, "percent")],
    ["52W high", formatCurrencyNumber(summary.high_52_week, currency, 2)],
    ["52W low", formatCurrencyNumber(summary.low_52_week, currency, 2)],
    ["Face value", formatFaceValue(stock, summary.face_value)],
  ];

  const facts = [
    ["Sector", company.sector],
    ["Industry", company.industry],
    ["Employees", company.employees ? formatIndianNumber(company.employees, 0) : null],
    ["Website", company.website],
  ].filter(([, v]) => v);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <section className="sx-card p-5 sm:p-6">
          <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-paper">About {stock.name}</h2>
          <p className={`mt-3 text-[14px] leading-7 text-[#d6d0f0] ${longAbout && !showFullAbout ? "line-clamp-4" : ""}`}>{about}</p>
          {longAbout && (
            <button
              type="button"
              onClick={() => setShowFullAbout((v) => !v)}
              className="mt-2 text-[13px] font-medium text-[#ff79c0] transition hover:text-white"
            >
              {showFullAbout ? "Show less" : "Read more"}
            </button>
          )}
          {facts.length > 0 && (
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-white/[0.07] pt-4">
              {facts.map(([label, value]) => (
                <div key={label} className="min-w-0">
                  <dt className="text-[12px] text-[#9f99c2]">{label}</dt>
                  <dd className="mt-0.5 truncate text-[14px] text-paper">
                    {label === "Website" ? (
                      <a href={String(value).startsWith("http") ? String(value) : `https://${value}`} target="_blank" rel="noreferrer" className="text-[#ff79c0] hover:underline">
                        {String(value).replace(/^https?:\/\//, "")}
                      </a>
                    ) : (
                      value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>

        <section className="sx-card p-5 sm:p-6">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-paper">At a glance</h2>
            <span className="font-numeric text-[12px] text-[#8f89ad]">{ticker.replace(/\.(NS|BO)$/i, "")}</span>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-white/[0.06] sm:grid-cols-4">
            {glance.map(([label, value]) => (
              <div key={label} className="min-w-0 bg-[#100c22] px-4 py-3.5">
                <div className="text-[12px] text-[#9f99c2]">{label}</div>
                <div className="mt-1 truncate font-numeric text-[15px] text-paper" title={String(value)}>
                  {value}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="sx-card p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-paper">Financial statements</h2>
            <p className="mt-0.5 text-[12.5px] text-[#8f89ad]">Newest period first. Large figures in crore (Cr) or lakh (L).</p>
          </div>
          <div className="sx-seg overflow-x-auto" role="tablist" aria-label="Statement">
            {STATEMENTS.map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={statement === key} onClick={() => setStatement(key)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4">
          <StatementTable table={fundamentals?.statements?.[statement]} currency={currency} />
        </div>
      </section>

      <section className="sx-card p-5 sm:p-6">
        <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-paper">Key ratios</h2>
        {ratios.length > 0 ? (
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {ratios.map((r: any) => (
              <div key={r.label} className="rounded-2xl bg-white/[0.04] px-4 py-3">
                <div className="text-[12px] text-[#9f99c2]">{r.label}</div>
                <div className="mt-1 font-numeric text-[16px] text-paper">{formatRatioValue(r.value, r.kind)}</div>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-[13.5px] text-[#9f99c2]">Ratios aren&apos;t available for this stock yet.</p>
        )}
      </section>
    </div>
  );
}

export default Financials;
