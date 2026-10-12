"use client";

// Minimal footer. Deliberately quiet: wayfinding, the legal pages and the
// disclaimer, nothing more.

import Link from "next/link";
import type { ReactNode } from "react";
import { BullseyeLogo } from "@/components/brand/BullseyeLogo";
import { ThemeToggle } from "@/components/ThemeToggle";

const linkClass = "font-body text-[14px] text-paper/85 transition hover:text-accent";

function Column({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="font-body text-[10px] font-medium uppercase tracking-[0.22em] text-paper-muted">{title}</div>
      <ul className="mt-4 space-y-2.5">{children}</ul>
    </div>
  );
}

/** `onDailyAlerts` lets the home page open its dialog in place instead of reloading itself. */
export function SiteFooter({ onDailyAlerts }: { onDailyAlerts?: () => void }) {
  const year = new Date().getFullYear();

  return (
    <footer className="mx-auto w-full max-w-[1180px] px-6 pb-16 pt-8 sm:px-8 print:hidden">
      <div className="border-t border-hairline pt-10">
        <div className="flex flex-wrap items-start justify-between gap-10">
          <div className="max-w-[34ch]">
            <Link href="/" aria-label="Bullseye home" className="inline-flex">
              <BullseyeLogo size={24} wordClassName="text-[18px]" />
            </Link>
            <p className="mt-4 font-body text-[13px] leading-6 text-paper-muted">
              Research for Indian stocks. Not investment advice.
            </p>
          </div>

          <nav aria-label="Footer" className="flex flex-wrap gap-x-14 gap-y-8">
            <Column title="Product">
              <li>
                <Link href="/screens" className={linkClass}>
                  Screener
                </Link>
              </li>
              <li>
                <Link href="/ask-ai" className={linkClass}>
                  Ask AI
                </Link>
              </li>
              <li>
                {onDailyAlerts ? (
                  <button type="button" onClick={onDailyAlerts} className={linkClass}>
                    Daily alerts
                  </button>
                ) : (
                  <Link href="/?alerts=1" className={linkClass}>
                    Daily alerts
                  </Link>
                )}
              </li>
            </Column>
            <Column title="Legal">
              <li>
                <Link href="/privacy" className={linkClass}>
                  Privacy policy
                </Link>
              </li>
              <li>
                <Link href="/terms" className={linkClass}>
                  Terms of use
                </Link>
              </li>
            </Column>
          </nav>
        </div>

        <div className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t border-hairline pt-6">
          <p className="font-body text-[12px] text-paper-muted">© {year} Bullseye</p>
          <div className="flex items-center gap-4">
            <p className="font-body text-[12px] text-paper-muted">Not SEBI-registered. Signals are not financial advice.</p>
            <ThemeToggle />
          </div>
        </div>
      </div>
    </footer>
  );
}

export default SiteFooter;
