"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { usePresence } from "@/components/motion/usePresence";

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom";
  className?: string;
}

/** Lightweight hover/focus tooltip. */
export function Tooltip({ content, children, side = "top", className }: TooltipProps) {
  const [open, setOpen] = useState(false);
  const tip = usePresence(open, 120);
  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {tip.mounted && (
        <span
          role="tooltip"
          data-state={tip.state}
          className={cn(
            "anim-pop pointer-events-none absolute left-1/2 z-50 w-max max-w-xs -translate-x-1/2 rounded-xl border border-white/10 bg-slate-950 px-3 py-2 text-[11px] leading-relaxed text-slate-200 shadow-[0_18px_55px_rgba(15,23,42,0.5)] font-numeric",
            side === "top" ? "bottom-full mb-2" : "top-full mt-2",
            className,
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}
