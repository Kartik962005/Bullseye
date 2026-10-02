'use client';

/**
 * Where the price sits inside its 52-week range, as a bar.
 *
 * The two numbers were already on the page, but "₹2,452 / high ₹2,890 / low
 * ₹1,780" makes the reader do the arithmetic. The position is the actual
 * information: near the high is a different situation from near the low, and a
 * bar says which at a glance.
 */
export function RangeBar({
  low,
  high,
  current,
  currency = '₹',
}: {
  low?: number | null;
  high?: number | null;
  current?: number | null;
  currency?: string;
}) {
  const lo = Number(low);
  const hi = Number(high);
  const now = Number(current);
  const usable = [lo, hi, now].every(Number.isFinite) && hi > lo;
  if (!usable) return null;

  const pct = Math.min(100, Math.max(0, ((now - lo) / (hi - lo)) * 100));
  const fmt = (value: number) =>
    `${currency}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  // Describe the position in words as well as pixels — the bar is useless to
  // anyone reading with a screen reader, and the phrasing is what most people
  // actually want ("near its 52-week high").
  const label =
    pct >= 90 ? 'at the top of its 52-week range'
    : pct >= 70 ? 'in the upper part of its 52-week range'
    : pct >= 30 ? 'mid-range over 52 weeks'
    : pct >= 10 ? 'in the lower part of its 52-week range'
    : 'near its 52-week low';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="sx-label">
          52-week range
        </span>
        <span className="text-[12px] text-[#9f99c2]">{label}</span>
      </div>

      <div
        className="relative mt-3 h-2 rounded-full bg-white/[0.08]"
        role="img"
        aria-label={`Price ${fmt(now)} is ${Math.round(pct)}% of the way between the 52-week low of ${fmt(lo)} and the high of ${fmt(hi)} — ${label}.`}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#7c5cff]/60 to-[#ff4fa3]"
          style={{ width: `${pct}%` }}
        />
        {/* Marker sits ON the fill edge, so the eye lands on the current price
            rather than on the bar's end. */}
        <div
          className="absolute top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-paper shadow-[0_0_10px_rgba(255,255,255,0.55)]"
          style={{ left: `calc(${pct}% - 1.5px)` }}
        />
      </div>

      <div className="mt-2 flex items-center justify-between font-numeric text-[12px] text-[#9f99c2]">
        <span>{fmt(lo)}</span>
        <span className="text-paper">{fmt(now)}</span>
        <span>{fmt(hi)}</span>
      </div>
    </div>
  );
}
