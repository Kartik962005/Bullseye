"use client";

// Stock page header: back link, identity (ticker, exchange, name), the live
// price with its day change, and the Overview / Financials switch.

export function StockHeader({
  ticker,
  name,
  exchange,
  currency,
  price,
  changePercent,
  view,
  canShowFinancials,
  onBack,
  onOverview,
  onFinancials,
}: {
  ticker: string;
  name?: string | null;
  exchange?: string | null;
  currency: string;
  price?: number | null;
  changePercent?: number | null;
  view: "overview" | "details";
  canShowFinancials: boolean;
  onBack: () => void;
  onOverview: () => void;
  onFinancials: () => void;
}) {
  const symbol = ticker.replace(/\.(NS|BO)$/i, "");
  const hasPrice = typeof price === "number" && Number.isFinite(price) && price > 0;
  const hasChange = typeof changePercent === "number" && Number.isFinite(changePercent);
  const up = (changePercent ?? 0) >= 0;

  return (
    <header className="sx-head">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" onClick={onBack} className="sx-back">
          <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
            <path d="M12.5 5 7.5 10l5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Markets
        </button>
        {canShowFinancials && (
          <div className="sx-seg" role="tablist" aria-label="Stock sections">
            <button type="button" role="tab" aria-selected={view === "overview"} onClick={onOverview}>
              Overview
            </button>
            <button type="button" role="tab" aria-selected={view === "details"} onClick={onFinancials}>
              Financials
            </button>
          </div>
        )}
      </div>

      <div className="mt-6 flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="sx-chip font-numeric">{symbol}</span>
            {exchange ? <span className="text-[13px] text-[#9f99c2]">{exchange}</span> : null}
          </div>
          <h1 className="mt-3 break-words font-display text-[clamp(2.4rem,5vw,4rem)] font-normal leading-[0.98] tracking-[-0.015em] text-paper">
            {name || symbol}
          </h1>
        </div>
        <div className="text-left sm:text-right">
          <div className="font-numeric text-[clamp(2rem,3.6vw,2.9rem)] leading-none tracking-tight text-paper">
            {hasPrice ? `${currency}${price!.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "—"}
          </div>
          {hasChange ? (
            <span className={`sx-change mt-3 ${up ? "is-up" : "is-down"}`}>
              {up ? "▲" : "▼"} {Math.abs(changePercent!).toFixed(2)}% today
            </span>
          ) : null}
        </div>
      </div>
    </header>
  );
}

export default StockHeader;
