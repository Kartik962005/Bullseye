'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { BullseyeLogo } from '@/components/brand/BullseyeLogo';
import { SiteFooter } from '@/components/home/SiteFooter';
import StockSearch from './StockSearch';

/** Page frame shared by the screener, a screen and a sector page. */
export default function ScreensShell({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-screen flex-col bg-[#070514] font-body text-white">
      <div aria-hidden className="sx-backdrop" />
      <header className="sticky top-0 z-40 border-b border-white/[0.06] bg-[#070514]/70 backdrop-blur-xl">
        <div className="mx-auto flex h-[68px] w-full max-w-[1200px] items-center gap-2.5 px-4 sm:h-[72px] sm:gap-5 sm:px-6">
          <Link href="/" aria-label="Bullseye home" className="shrink-0">
            <BullseyeLogo size={26} wordClassName="hidden text-[20px] sm:inline" />
          </Link>
          <div className="min-w-0 flex-1">
            <StockSearch compact />
          </div>
          <nav className="flex shrink-0 items-center gap-1.5 sm:gap-2.5">
            <Link href="/?alerts=1" className="hdr-icon" aria-label="Daily alerts" title="Daily stock alerts">
              <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3a6 6 0 0 0-6 6v3.5L4.5 16h15L18 12.5V9a6 6 0 0 0-6-6ZM9.5 19a2.5 2.5 0 0 0 5 0" /></svg>
              <span className="hdr-label">Daily alerts</span>
            </Link>
            <Link href="/ask-ai" className="hdr-icon" aria-label="Ask AI">
              <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8Z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z" /></svg>
              <span className="hdr-label">Ask AI</span>
            </Link>
            <span className="hidden md:inline-flex">
              <Link href="/screens" className="nova-btn nova-btn-primary !h-10 !px-5 !text-[13px]">
                Screener
              </Link>
            </span>
          </nav>
        </div>
      </header>
      <div className="relative z-10 mx-auto w-full max-w-[1200px] flex-1 px-4 pb-20 pt-8 sm:px-6 sm:pt-10">{children}</div>
      <div className="relative z-10">
        <SiteFooter />
      </div>
    </main>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="sx-label">{children}</span>;
}
