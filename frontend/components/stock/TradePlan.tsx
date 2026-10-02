"use client";

// The trade, laid out as a plan: where you'd get in, where you'd be wrong,
// where you'd take profit, and by when. When there is no trade, the reasons.

import { getAnalysisPresentation } from "@/lib/analysis";

/* eslint-disable @typescript-eslint/no-explicit-any -- /analyze is untyped */

export function TradePlan({ analysis, currency }: { analysis: any; currency: string }) {
  const v = getAnalysisPresentation(analysis);
  if (!v) return null;

  const fmt = (n: number) => `${currency}${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

  if (v.isHold) {
    const notes: string[] = (v.risk_notes?.length ? v.risk_notes : ["The risk / reward and confidence gates did not clear."]).slice(0, 4);
    return (
      <section className="sx-card p-5 sm:p-6">
        <div className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/[0.06] text-[#c9c3e6]" aria-hidden>
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
              <path d="M7 5v10M13 5v10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <div>
            <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-paper">No trade right now</h2>
            <p className="text-[13px] text-[#9f99c2]">Bullseye only issues levels when a setup clears every gate. This one didn&apos;t:</p>
          </div>
        </div>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2">
          {notes.map((note) => (
            <li key={note} className="flex gap-3 rounded-2xl bg-white/[0.035] px-4 py-3 text-[13.5px] leading-6 text-[#d6d0f0]">
              <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#ff4fa3]" aria-hidden />
              {note}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const bearish = v.direction === "bearish";
  const entry = Number(v.entry);
  const target = Number(v.target);
  const stop = Number(v.stop_loss);
  const movePct = entry ? Math.abs(((target - entry) / entry) * 100) : 0;
  const riskPct = entry ? Math.abs(((entry - stop) / entry) * 100) : 0;
  const rr = riskPct > 0 ? movePct / riskPct : 0;

  // Ladder: stop on one end, target on the other, entry where it falls.
  const lo = Math.min(stop, target);
  const hi = Math.max(stop, target);
  const span = Math.max(hi - lo, 0.0001);
  const pos = (n: number) => ((n - lo) / span) * 100;
  const entryPos = pos(entry);
  const targetOnRight = target > stop;

  return (
    <section className="sx-card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="sx-label">Trade plan</div>
          <h2 className="mt-2 text-[20px] font-semibold tracking-[-0.015em] text-paper">
            {bearish ? "Short setup: looking for a fall" : "Long setup: looking for a rise"}
          </h2>
          <p className="mt-1 max-w-[60ch] text-[13.5px] leading-6 text-[#9f99c2]">
            {bearish
              ? "The engine expects the price to fall toward the target. The stop sits above, where the idea is proven wrong."
              : "The engine expects the price to rise toward the target. The stop sits below, where the idea is proven wrong."}
          </p>
        </div>
        {analysis?.target_date ? (
          <div className="rounded-2xl bg-white/[0.04] px-4 py-2.5 text-right">
            <div className="text-[12px] text-[#9f99c2]">Target date</div>
            <div className="font-numeric text-[15px] text-paper">{analysis.target_date}</div>
          </div>
        ) : null}
      </div>

      {/* Price ladder */}
      <div className="mt-7 px-1">
        <div className="relative h-2.5 rounded-full" style={{ background: targetOnRight ? "linear-gradient(90deg,#ff5c7a,#3a2c5c 45%,#2fe0a0)" : "linear-gradient(90deg,#2fe0a0,#3a2c5c 55%,#ff5c7a)" }}>
          <span
            className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-[#0f0c1d] bg-white shadow-[0_0_0_3px_rgba(255,255,255,0.15)]"
            style={{ left: `${Math.min(97, Math.max(3, entryPos))}%` }}
            aria-hidden
          />
        </div>
        <div className="mt-3 grid grid-cols-3 text-[12.5px]">
          <div>
            <div className="text-[#9f99c2]">{targetOnRight ? "Stop" : "Target"}</div>
            <div className="font-numeric text-[15px]" style={{ color: targetOnRight ? "#ff8aa0" : "#6ff0b5" }}>{fmt(lo)}</div>
          </div>
          <div className="text-center">
            <div className="text-[#9f99c2]">Entry</div>
            <div className="font-numeric text-[15px] text-paper">{fmt(entry)}</div>
          </div>
          <div className="text-right">
            <div className="text-[#9f99c2]">{targetOnRight ? "Target" : "Stop"}</div>
            <div className="font-numeric text-[15px]" style={{ color: targetOnRight ? "#6ff0b5" : "#ff8aa0" }}>{fmt(hi)}</div>
          </div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(
          [
            ["Projected move", `${bearish ? "−" : "+"}${movePct.toFixed(2)}%`, bearish ? "#ff8aa0" : "#6ff0b5", "To target"],
            ["Max risk", `${riskPct.toFixed(2)}%`, "#ff8aa0", "If the stop is hit"],
            ["Reward : risk", rr ? `${rr.toFixed(2)}R` : "—", undefined, "Per unit of risk"],
            ["Holding period", analysis?.estimated_days ? `${analysis.estimated_days} days` : "—", undefined, "Estimated"],
          ] as Array<[string, string, string | undefined, string]>
        ).map(([label, value, color, hint]) => (
          <div key={label} className="rounded-2xl bg-white/[0.04] px-4 py-3">
            <div className="text-[12px] text-[#9f99c2]">{label}</div>
            <div className="mt-1 font-numeric text-[18px]" style={{ color: color ?? "#fff" }}>{value}</div>
            <div className="mt-0.5 text-[11.5px] text-[#8f89ad]">{hint}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default TradePlan;
