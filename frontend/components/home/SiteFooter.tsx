"use client";

// Minimal footer. Deliberately quiet — the page ends on the signals CTA, so
// this is wayfinding plus the disclaimer, nothing more.

import Link from "next/link";
import { BullseyeLogo } from "@/components/brand/BullseyeLogo";

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="mx-auto w-full max-w-[1180px] px-6 pb-16 pt-8 sm:px-8">
      <div className="border-t border-hairline pt-10">
        <div className="flex flex-wrap items-start justify-between gap-10">
          <div className="max-w-[34ch]">
            <BullseyeLogo size={24} wordClassName="text-[18px]" />
            <p className="mt-4 font-body text-[13px] leading-6 text-paper-muted">
              AI-assisted market research for Indian equities. Not investment advice.
            </p>
          </div>

          <nav className="flex flex-wrap gap-x-12 gap-y-6">
            <div>
              <div className="font-body text-[10px] font-medium uppercase tracking-[0.22em] text-paper-muted">
                Product
              </div>
              <ul className="mt-4 space-y-2.5">
                <li>
                  <Link href="/screens" className="font-body text-[14px] text-paper/85 transition hover:text-accent">
                    Screener
                  </Link>
                </li>
                <li>
                  <Link href="/ask-ai" className="font-body text-[14px] text-paper/85 transition hover:text-accent">
                    Ask AI
                  </Link>
                </li>
                <li>
                  <Link href="/alerts" className="font-body text-[14px] text-paper/85 transition hover:text-accent">
                    Daily alerts
                  </Link>
                </li>
              </ul>
            </div>
          </nav>
        </div>

        <div className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t border-hairline pt-6">
          <p className="font-body text-[12px] text-paper-muted">© {year} Bullseye</p>
          <p className="font-body text-[12px] text-paper-muted">
            Research tool — signals are not financial advice.
          </p>
        </div>
      </div>
    </footer>
  );
}

export default SiteFooter;
