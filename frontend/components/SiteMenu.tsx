'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { usePresence } from '@/components/motion/usePresence';
import { setTheme, useTheme, type Theme } from '@/lib/theme';

function Row({ href, onClick, active, icon, children }: { href?: string; onClick?: () => void; active?: boolean; icon: ReactNode; children: ReactNode }) {
  const className = `flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14.5px] transition hover:bg-white/[0.06] ${
    active ? 'bg-white/[0.06] text-white' : 'text-[color:var(--fg)]'
  }`;
  const inner = (
    <>
      <span className="grid h-5 w-5 place-items-center text-[color:var(--ink-3)]">{icon}</span>
      {children}
    </>
  );
  return href ? (
    <Link href={href} onClick={onClick} className={className} aria-current={active ? 'page' : undefined}>
      {inner}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={className}>
      {inner}
    </button>
  );
}

const svg = (d: string) => (
  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

/**
 * The phone menu: every page, the theme switch and the legal links in one
 * sheet. Hidden from the small breakpoint up, where the header has room.
 * `onDailyAlerts` lets the home page open its dialog in place.
 */
export function SiteMenu({ onDailyAlerts, className = 'sm:hidden' }: { onDailyAlerts?: () => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const presence = usePresence(open, 180);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const theme = useTheme();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = () => setOpen(false);
  const themes: { value: Theme; label: string }[] = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ];

  return (
    <div ref={wrapRef} className={`relative shrink-0 ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        className="hdr-icon"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-haspopup="true"
      >
        {open ? svg('M6 6l12 12M18 6 6 18') : svg('M4 6.5h16M4 12h16M4 17.5h16')}
      </button>

      {presence.mounted && (
        <div
          data-lenis-prevent
          data-state={presence.state}
          className="anim-pop nova-auth absolute right-0 top-full z-50 mt-3 w-[min(300px,calc(100vw-24px))] rounded-2xl p-1.5 font-body"
        >
          <nav aria-label="Site">
            <Row href="/" onClick={close} active={pathname === '/'} icon={svg('M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1Z')}>
              Home
            </Row>
            <Row href="/screens" onClick={close} active={pathname?.startsWith('/screens')} icon={svg('M4 6h16M7 12h10M10 18h4')}>
              Screener
            </Row>
            <Row href="/ask-ai" onClick={close} active={pathname?.startsWith('/ask-ai')} icon={svg('M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8Z')}>
              Ask AI
            </Row>
            {onDailyAlerts ? (
              <Row
                onClick={() => {
                  close();
                  onDailyAlerts();
                }}
                icon={svg('M12 3a6 6 0 0 0-6 6v3.5L4.5 16h15L18 12.5V9a6 6 0 0 0-6-6ZM9.5 19a2.5 2.5 0 0 0 5 0')}
              >
                Daily alerts
              </Row>
            ) : (
              <Row href="/?alerts=1" onClick={close} icon={svg('M12 3a6 6 0 0 0-6 6v3.5L4.5 16h15L18 12.5V9a6 6 0 0 0-6-6ZM9.5 19a2.5 2.5 0 0 0 5 0')}>
                Daily alerts
              </Row>
            )}
          </nav>

          <div className="mx-1.5 my-1.5 h-px bg-white/[0.07]" />

          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <span id="site-menu-theme" className="text-[13.5px] text-[color:var(--ink-2)]">
              Theme
            </span>
            <div role="radiogroup" aria-labelledby="site-menu-theme" className="sx-seg sx-seg-sm">
              {themes.map(option => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={theme === option.value}
                  onClick={() => setTheme(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mx-1.5 my-1.5 h-px bg-white/[0.07]" />

          <div className="flex gap-4 px-3 pb-2 pt-1 text-[12.5px] text-[color:var(--ink-3)]">
            <Link href="/privacy" onClick={close} className="transition hover:text-white">
              Privacy policy
            </Link>
            <Link href="/terms" onClick={close} className="transition hover:text-white">
              Terms of use
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

export default SiteMenu;
