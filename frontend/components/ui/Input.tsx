import type { InputHTMLAttributes } from "react";
import { cn } from "./cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export function Input({ invalid = false, className, ...props }: InputProps) {
  return (
    <input
      className={cn(
        "h-12 w-full rounded-2xl border bg-black/50 px-4 text-sm text-white outline-none transition placeholder:text-slate-500 font-numeric focus:border-cyan-400",
        invalid ? "border-red-400/60" : "border-white/10",
        className,
      )}
      {...props}
    />
  );
}
