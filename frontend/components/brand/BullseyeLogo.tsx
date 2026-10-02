"use client";

// Bullseye brand mark + wordmark. Minimal by design: one bold ring with the
// point set off-centre, up and to the right, so it reads as an eye looking
// ahead (the "eye" in Bullseye) as much as a target. The ring and wordmark use
// the current text colour (white on dark, black on paper); only the point
// carries the accent, and `mono` drops even that for documents and print.

export function BullseyeMark({
  size = 26,
  className = "",
  mono = false,
}: {
  size?: number;
  className?: string;
  mono?: boolean;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden className={`bx-mark ${className}`}>
      <circle className="bx-ring" cx="16" cy="16" r="12" stroke="currentColor" strokeWidth="3.6" />
      <circle className="bx-hit" cx="18.6" cy="13.4" r="4.2" fill={mono ? "currentColor" : "#ff4fa3"} />
    </svg>
  );
}

export function BullseyeLogo({
  size = 26,
  wordClassName = "text-[19px]",
  className = "",
  mono = false,
}: {
  size?: number;
  wordClassName?: string;
  className?: string;
  mono?: boolean;
}) {
  return (
    <span className={`bx-logo inline-flex items-center gap-2 text-paper ${className}`}>
      <BullseyeMark size={size} mono={mono} />
      <span className={`font-body font-semibold leading-none tracking-[-0.035em] ${wordClassName}`}>Bullseye</span>
    </span>
  );
}

export default BullseyeLogo;
