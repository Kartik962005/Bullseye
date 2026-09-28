"use client";

// Animated shell around the header's stock search input. The input itself
// stays in page.tsx (it owns the suggestions state); this adds the gradient
// border that wakes up on hover, a spotlight that follows the cursor, a
// rotating example placeholder and the "/" shortcut. Everything is CSS or
// direct DOM writes, so hovering never re-renders the page.

import { useEffect, useRef, type ReactNode } from "react";

const EXAMPLES = ["Search any stock…", "Try “TCS”", "Try “Reliance”", "Try “HDFC Bank”", "Try “Tata Motors”"];

export function NovaSearch({ children, className = "" }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const input = ref.current?.querySelector("input");
    if (!input) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Cycle the placeholder while the field is empty and idle. Written to the
    // DOM directly: the placeholder prop never changes, so React leaves it be.
    let i = 0;
    const timer = reduced
      ? 0
      : window.setInterval(() => {
          if (document.activeElement === input || input.value) return;
          i = (i + 1) % EXAMPLES.length;
          input.placeholder = EXAMPLES[i];
        }, 2600);

    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        input.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={`nova-search ${className}`}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
        e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
      }}
    >
      <svg className="nova-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.6-3.6" />
      </svg>
      {children}
      <kbd className="nova-search-kbd" aria-hidden>
        /
      </kbd>
    </div>
  );
}

export default NovaSearch;
