"use client";

// Bullseye brand mark + wordmark. The mark is an app-icon squircle in the
// brand gradient holding a minimal target: an open ring, a centre point and a
// single "hit" sitting in the ring's gap. On hover the ring turns a quarter
// and the hit settles into place (CSS in globals.css, `.bx-logo`).

import { useId } from "react";

export function BullseyeMark({ size = 30, className = "" }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden className={`bx-mark ${className}`}>
      <defs>
        <linearGradient id={`${id}-bg`} x1="2" y1="2" x2="30" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7c5cff" />
          <stop offset="0.55" stopColor="#c43bd6" />
          <stop offset="1" stopColor="#ff2e97" />
        </linearGradient>
        <radialGradient id={`${id}-sheen`} cx="0.2" cy="0.1" r="0.8">
          <stop offset="0" stopColor="#00e5ff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#00e5ff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill={`url(#${id}-bg)`} />
      <rect x="1" y="1" width="30" height="30" rx="9" fill={`url(#${id}-sheen)`} />
      <rect x="1.5" y="1.5" width="29" height="29" rx="8.5" stroke="#ffffff" strokeOpacity="0.18" />
      <g className="bx-ring">
        <path d="M24.37 14.52A8.5 8.5 0 1 1 17.48 7.63" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" />
      </g>
      <circle className="bx-core" cx="16" cy="16" r="3.2" fill="#ffffff" />
      <circle className="bx-hit" cx="22.01" cy="9.99" r="1.7" fill="#ffffff" />
    </svg>
  );
}

export function BullseyeLogo({
  size = 30,
  wordClassName = "text-[19px]",
  className = "",
}: {
  size?: number;
  wordClassName?: string;
  className?: string;
}) {
  return (
    <span className={`bx-logo inline-flex items-center gap-2.5 ${className}`}>
      <BullseyeMark size={size} />
      <span className={`font-body font-semibold leading-none tracking-[-0.035em] text-paper ${wordClassName}`}>Bullseye</span>
    </span>
  );
}

export default BullseyeLogo;
