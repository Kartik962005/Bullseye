'use client';

import { currentTheme, setTheme } from '@/lib/theme';

/**
 * Sun/moon button that switches light and dark and remembers the choice.
 *
 * The icon and the spoken label follow the page's data-theme through CSS
 * (.theme-when-dark / .theme-when-light), not React state, so they are right
 * from the first paint even for a visitor who chose dark: the server always
 * renders the light default, and state only catches up after hydration.
 */
export function ThemeToggle({ className = 'hdr-icon' }: { className?: string }) {
  return (
    <button type="button" onClick={() => setTheme(currentTheme() === 'dark' ? 'light' : 'dark')} className={className}>
      <span className="theme-when-dark sr-only">Switch to light mode</span>
      <span className="theme-when-light sr-only">Switch to dark mode</span>
      <svg viewBox="0 0 24 24" className="theme-when-dark h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
      </svg>
      <svg viewBox="0 0 24 24" className="theme-when-light h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
      </svg>
    </button>
  );
}
