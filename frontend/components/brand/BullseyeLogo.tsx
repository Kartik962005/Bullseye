"use client";

// Bullseye brand mark + wordmark. The mark is a target (two gradient rings and
// a glowing centre) with an arrow landing in the middle. On hover the arrow
// strikes and the rings pulse (CSS in globals.css, `.bx-logo`).

import { useId } from "react";

export function BullseyeMark({ size = 30, className = "" }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden
      className={`bx-mark ${className}`}
    >
      <defs>
        <linearGradient id={`${id}-ring`} x1="3" y1="3" x2="29" y2="29" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#00e5ff" />
          <stop offset="0.5" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#ff2e97" />
        </linearGradient>
        <radialGradient id={`${id}-core`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.45" stopColor="#ffd1e8" />
          <stop offset="1" stopColor="#ff2e97" />
        </radialGradient>
      </defs>
      <circle className="bx-ring bx-ring-outer" cx="16" cy="16" r="13.5" stroke={`url(#${id}-ring)`} strokeWidth="2.2" />
      <circle className="bx-ring bx-ring-inner" cx="16" cy="16" r="8.5" stroke={`url(#${id}-ring)`} strokeWidth="2" opacity="0.9" />
      <circle className="bx-core" cx="16" cy="16" r="3.8" fill={`url(#${id}-core)`} />
      <g className="bx-arrow" stroke="#ffffff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M28.5 3.5 18.2 13.8" />
        <path d="M28.5 3.5v4.6M28.5 3.5h-4.6" />
      </g>
    </svg>
  );
}

export function BullseyeLogo({
  size = 30,
  wordClassName = "text-[26px]",
  className = "",
}: {
  size?: number;
  wordClassName?: string;
  className?: string;
}) {
  return (
    <span className={`bx-logo inline-flex items-center gap-2.5 ${className}`}>
      <BullseyeMark size={size} />
      <span className={`font-display leading-none tracking-[-0.01em] text-paper ${wordClassName}`}>Bullseye</span>
    </span>
  );
}

export default BullseyeLogo;
