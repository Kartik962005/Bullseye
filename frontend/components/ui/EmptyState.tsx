import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}

/** Dashed-border panel for empty / no-data states. */
export function EmptyState({ title, description, icon, action, className, ...props }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-6 py-10 text-center",
        className,
      )}
      {...props}
    >
      {icon != null && <div className="text-slate-500">{icon}</div>}
      <p className="font-body text-sm font-bold text-slate-200">{title}</p>
      {description != null && (
        <p className="max-w-sm text-[12px] leading-relaxed text-slate-400 font-numeric">{description}</p>
      )}
      {action != null && <div className="mt-1">{action}</div>}
    </div>
  );
}
