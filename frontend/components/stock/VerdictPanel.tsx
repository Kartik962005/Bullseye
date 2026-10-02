"use client";

// The stock page's answer, in one panel: the call, how confident the engine
// is, the levels that make it actionable, why it landed there, and where the
// price sits in its yearly range.

import { getAnalysisPresentation } from "@/lib/analysis";
import { RangeBar } from "./RangeBar";

/* eslint-disable @typescript-eslint/no-explicit-any -- /analyze is untyped */

function ConfidenceRing({ value, color }: { value: number; color: string }) {
  const pct = Math.max(0, Math.min(100, value));
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative h-[68px] w-[68px] shrink-0" role="img" aria-label={`Confidence ${Math.round(pct)} out of 100`}>
      <svg viewBox="0 0 64 64" className="h-full w-full -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="5" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * c} ${c}`}
          style={{ transition: "stroke-dasharray 1s cubic-bezier(.22,.61,.36,1)" }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center font-numeric text-[17px] text-paper">{Math.round(pct)}</div>
    </div>
  );
}

export function VerdictPanel({
  analysis,
  currency,
  price,
  low52,
  high52,
}: {
  analysis: any;
  currency: string;
  price?: number | null;
  low52?: number | null;
  high52?: number | null;
}) {
  const v = getAnalysisPresentation(analysis);

  if (!analysis) {
    return (
      <aside className="sx-card sx-verdict p-6">
        <div className="sx-label">Bullseye&apos;s call</div>
        <div className="mt-5 flex items-center gap-3 text-[14px] text-[#b9b4d6]">
          <span className="nova-spinner" aria-hidden />
          Running the analysis…
        </div>
        <div className="mt-6 grid gap-2">
          {[0, 1, 2].map(i => (
            <div key={i} className="sx-skeleton h-11" />
          ))}
        </div>
      </aside>
    );
  }

  if (!v) {
    return (
      <aside className="sx-card sx-verdict p-6">
        <div className="sx-label">Bullseye&apos;s call</div>
        <p className="mt-4 text-[14px] leading-6 text-[#b9b4d6]">
          The analysis isn&apos;t available for this stock right now. Try again in a moment.
        </p>
      </aside>
    );
  }

  const color = v.isBullish ? "#3dffa2" : v.isBearish ? "#ff5c7a" : "#b9b4d6";
  const word = String(v.displayVerdict);
  const entry = Number(v.entry);
  const move = (to: number) => (entry ? ((to - entry) / entry) * 100 : 0);
  const upside = Math.abs(move(Number(v.target)));
  const downside = Math.abs(move(Number(v.stop_loss)));
  const rr = downside > 0 ? (upside / downside).toFixed(2) : "—";
  const fmt = (n: number) => `${currency}${Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const pctText = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;

  const pct = (value: any) => (typeof value === "number" ? `${Math.round(value * 100)}%` : null);
  const trades = Number(analysis?.historical_hit_rate_trades ?? 0);
  const why: Array<[string, string, string]> = [];
  const modelP = pct(analysis?.model_probability);
  if (modelP) why.push(["Model win probability", modelP, "Trained win-probability model"]);
  const hit = pct(analysis?.historical_hit_rate);
  if (hit) why.push(["Setup hit rate", hit, trades > 0 ? `Over ${trades} closed trade${trades === 1 ? "" : "s"}` : "No closed trades yet"]);
  if (typeof analysis?.expected_r === "number") why.push(["Expected R", analysis.expected_r.toFixed(2), "After costs and slippage"]);
  const quality = pct(analysis?.chart_setup_quality);
  if (quality) why.push(["Chart setup quality", quality, "Trend, breakout, volume, momentum"]);

  return (
    <aside className="sx-card sx-verdict p-6" style={{ ["--verdict" as string]: color }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="sx-label">Bullseye&apos;s call</div>
          <div className="mt-3 font-display text-[clamp(2.6rem,4vw,3.4rem)] leading-[0.9]" style={{ color }}>
            {word}
          </div>
        </div>
        <ConfidenceRing value={Number(v.confidenceLevel)} color={color} />
      </div>

      {v.isHold ? (
        <p className="mt-5 rounded-2xl bg-white/[0.04] px-4 py-3 text-[13.5px] leading-6 text-[#c9c3e6]">
          No clear edge right now, so no entry, target or stop is issued. The honest call is to sit this one out.
        </p>
      ) : (
        <dl className="mt-6 grid gap-1.5">
          {(
            [
              ["Entry", fmt(entry), null],
              ["Target", fmt(Number(v.target)), move(Number(v.target))],
              ["Stop loss", fmt(Number(v.stop_loss)), move(Number(v.stop_loss))],
            ] as Array<[string, string, number | null]>
          ).map(([label, value, change]) => (
            <div key={label} className="sx-level">
              <dt>{label}</dt>
              <dd>
                <span className="font-numeric text-paper">{value}</span>
                {change !== null ? (
                  <span className={`font-numeric text-[12px] ${change >= 0 ? "text-[#6ff0b5]" : "text-[#ff8aa0]"}`}>{pctText(change)}</span>
                ) : null}
              </dd>
            </div>
          ))}
          <div className="sx-level">
            <dt>Reward : risk</dt>
            <dd>
              <span className="font-numeric text-paper">{rr === "—" ? "—" : `${rr}R`}</span>
            </dd>
          </div>
        </dl>
      )}

      {why.length > 0 && (
        <div className="mt-6 border-t border-white/[0.07] pt-5">
          <div className="sx-label">Why this call</div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-4">
            {why.map(([label, value, note]) => (
              <div key={label}>
                <div className="font-numeric text-[19px] leading-none text-paper">{value}</div>
                <div className="mt-1.5 text-[12.5px] text-[#e9e5ff]">{label}</div>
                <div className="mt-0.5 text-[11.5px] leading-snug text-[#8f89ad]">{note}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-6 border-t border-white/[0.07] pt-5">
        <RangeBar low={low52} high={high52} current={price ?? analysis?.current_price} currency={currency} />
      </div>
    </aside>
  );
}

export default VerdictPanel;
