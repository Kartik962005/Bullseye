import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export type BadgeTone = "neutral" | "accent" | "positive" | "negative" | "caution";

const TONE: Record<BadgeTone, string> = {
  neutral: "border-white/10 bg-white/5 text-slate-300",
  accent: "border-cyan-300/30 bg-cyan-500/15 text-cyan-300",
  positive: "border-emerald-300/30 bg-emerald-500/15 text-emerald-300",
  negative: "border-rose-300/30 bg-rose-500/15 text-rose-300",
  caution: "border-amber-300/30 bg-amber-500/15 text-amber-300",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Fully rounded chip style. */
  pill?: boolean;
}

export function Badge({ tone = "neutral", pill = false, className, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 border px-2.5 py-0.5 font-body text-[10px] font-black uppercase tracking-[0.14em]",
        pill ? "rounded-full" : "rounded-md",
        TONE[tone],
        className,
      )}
      {...props}
    />
  );
}

/** Convenience: a Badge with the rounded-full chip style. */
export function Pill(props: BadgeProps) {
  return <Badge pill {...props} />;
}
