"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";

export interface TabItem {
  id: string;
  label: ReactNode;
}

export interface TabsProps {
  tabs: TabItem[];
  value: string;
  onValueChange: (id: string) => void;
  className?: string;
}

/** Controlled segmented tab switcher. */
export function Tabs({ tabs, value, onValueChange, className }: TabsProps) {
  return (
    <div
      role="tablist"
      className={cn("inline-flex items-center gap-1 rounded-2xl border border-white/10 bg-black/40 p-1", className)}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onValueChange(tab.id)}
            className={cn(
              "rounded-xl px-4 py-2 font-body text-xs font-bold uppercase tracking-[0.12em] outline-none transition focus-visible:ring-2 focus-visible:ring-cyan-300/60",
              active ? "bg-cyan-400 text-slate-950" : "text-slate-400 hover:text-white",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
