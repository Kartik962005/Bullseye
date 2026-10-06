import Link from 'next/link';
import type { ReactNode } from 'react';
import { BullseyeLogo } from '@/components/brand/BullseyeLogo';

/** Shared frame for the 404 and error screens. */
export function StatusPage({
  code,
  title,
  accent,
  body,
  children,
}: {
  code: string;
  title: string;
  accent: string;
  body: string;
  children: ReactNode;
}) {
  return (
    <main className="relative flex min-h-dvh flex-col bg-[#070514] font-body text-white">
      <div aria-hidden className="sx-backdrop" />
      <header className="relative z-10 mx-auto flex h-[72px] w-full max-w-[1100px] items-center px-5 sm:px-8">
        <Link href="/" aria-label="Bullseye home">
          <BullseyeLogo size={26} wordClassName="text-[20px]" />
        </Link>
      </header>
      <section className="relative z-10 mx-auto flex w-full max-w-[640px] flex-1 flex-col items-center justify-center px-5 pb-24 text-center">
        <span className="ai-rise font-numeric text-[13px] tracking-[0.3em] text-[#9f99c2]">{code}</span>
        <h1 className="ai-rise mt-4 font-display text-[clamp(2.4rem,8vw,4.2rem)] leading-[1.02]" style={{ animationDelay: '60ms' }}>
          {title} <em className="nova-gradient-text italic">{accent}</em>
        </h1>
        <p className="ai-rise mt-4 max-w-[46ch] text-[15.5px] leading-7 text-[#b9b4d6]" style={{ animationDelay: '120ms' }}>
          {body}
        </p>
        <div className="ai-rise mt-9 flex flex-wrap justify-center gap-3" style={{ animationDelay: '180ms' }}>
          {children}
        </div>
      </section>
    </main>
  );
}
