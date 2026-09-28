import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "./cn";
import { Eyebrow } from "./Eyebrow";

export interface SectionHeadingProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  actions,
  className,
  ...props
}: SectionHeadingProps) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-4", className)} {...props}>
      <div className="min-w-0">
        {eyebrow != null && <Eyebrow as="div">{eyebrow}</Eyebrow>}
        <h2 className="mt-2 font-body text-2xl font-bold tracking-tight text-white">{title}</h2>
        {description != null && (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-400">{description}</p>
        )}
      </div>
      {actions != null && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
