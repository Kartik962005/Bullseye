import type { SelectHTMLAttributes } from "react";
import { cn } from "./cn";

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export function Select({ className, children, ...props }: SelectProps) {
  return (
    <select
      className={cn(
        "h-12 w-full rounded-2xl border border-white/10 bg-black/50 px-4 text-sm text-white outline-none transition focus:border-cyan-400 font-numeric",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}
