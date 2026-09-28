import type { HTMLAttributes } from "react";
import { cn } from "./cn";

export interface EyebrowProps extends HTMLAttributes<HTMLElement> {
  tone?: "accent" | "muted";
  as?: "span" | "div" | "p";
}

/** The signature Bullseye eyebrow label: tiny, uppercase, wide-tracked, display font. */
export function Eyebrow({ tone = "accent", as = "span", className, ...props }: EyebrowProps) {
  const Tag = as;
  return (
    <Tag
      className={cn(
        "font-body text-[10px] font-black uppercase tracking-[0.18em]",
        tone === "accent" ? "text-cyan-300" : "text-slate-400",
        className,
      )}
      {...props}
    />
  );
}
