'use client';

import { useEffect, useRef, useState } from 'react';

type LenisLike = { scrollTo: (target: number, opts?: Record<string, unknown>) => void };

// Only long pages get the aids; a page barely taller than the screen does not need them.
const MIN_SCROLL_SCREENS = 1.5;
const SHOW_TOP_AFTER_SCREENS = 1.2;

/**
 * A thin reading-progress line along the top edge and a back-to-top button
 * that appears once you are well down a long page. Both stay hidden on pages
 * that scroll inside their own panel (Ask AI) because the window never moves.
 */
export function ScrollAids() {
  const barRef = useRef<HTMLDivElement>(null);
  const [showTop, setShowTop] = useState(false);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const doc = document.documentElement;
      const viewport = window.innerHeight;
      const range = doc.scrollHeight - viewport;
      const y = window.scrollY;
      const long = range > viewport * (MIN_SCROLL_SCREENS - 1);
      if (barRef.current) {
        barRef.current.style.transform = `scaleX(${long && range > 0 ? Math.min(1, y / range) : 0})`;
        barRef.current.style.opacity = long && y > 4 ? '1' : '0';
      }
      setShowTop(long && y > viewport * SHOW_TOP_AFTER_SCREENS);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // Content that loads later (stock data, screen results) changes the page height.
    const observer = new ResizeObserver(schedule);
    observer.observe(document.body);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  const toTop = () => {
    const lenis = (window as unknown as { __bullseyeLenis?: LenisLike }).__bullseyeLenis;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (lenis) lenis.scrollTo(0, { duration: reduce ? 0 : 1.1 });
    else window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    // Move focus to the top too, so keyboard users land where the eye does.
    document.getElementById('main')?.focus({ preventScroll: true });
  };

  return (
    <>
      <div ref={barRef} aria-hidden className="scroll-progress print:hidden" />
      <button
        type="button"
        onClick={toTop}
        aria-label="Back to top"
        title="Back to top"
        data-show={showTop}
        tabIndex={showTop ? 0 : -1}
        className="back-to-top print:hidden"
      >
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
        </svg>
      </button>
    </>
  );
}

export default ScrollAids;
