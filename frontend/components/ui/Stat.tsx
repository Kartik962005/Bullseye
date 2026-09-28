import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export type StatTone = "default" | "positive" | "negative" | "caution" | "accent";

const VALUE_TONE: Record<StatTone, string> = {
  default: "text-white",
  positive: "text-emerald-300",
  negative: "text-rose-300",
  caution: "text-amber-300",
  accent: "text-cyan-300",
};

export interface StatProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: StatTone;
}

/** Label + value metric block (eyebrow label over a mono value). */
export function Stat({ label, value, hint, tone = "default", className, ...props }: StatProps) {
  return (
    <div className={cn("flex flex-col gap-1", className)} {...props}>
      <span className="font-body text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300">
        {label}
      </span>
      <span className={cn("font-numeric text-base font-bold", VALUE_TONE[tone])}>{value}</span>
      {hint != null && <span className="text-[11px] text-slate-400">{hint}</span>}
    </div>
  );
}

export const Metric = Stat;
