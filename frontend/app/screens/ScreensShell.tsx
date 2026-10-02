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
        <div className="mx-auto flex h-[72px] w-full max-w-[1200px] items-center gap-4 px-4 sm:gap-6 sm:px-6">
          <Link href="/" aria-label="Bullseye home" className="shrink-0">
            <BullseyeLogo size={26} wordClassName="hidden text-[20px] sm:inline" />
          </Link>
          <div className="min-w-0 flex-1">
            <StockSearch compact />
          </div>
          <nav className="flex shrink-0 items-center gap-5">
            <Link href="/ask-ai" className="hidden text-[13px] font-medium text-[#c9c3e6] transition hover:text-white sm:inline">
              Ask AI
            </Link>
            <Link href="/screens" className="nova-btn nova-btn-primary !h-10 !px-4 !text-[13px] sm:!px-5">
              Screener
            </Link>
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
