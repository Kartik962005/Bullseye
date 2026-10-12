'use client';

import { useSyncExternalStore } from 'react';

import { THEME_EVENT, THEME_STORAGE_KEY, type Theme } from './theme-boot';

export { THEME_EVENT, THEME_STORAGE_KEY, type Theme };

export function currentTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
}

function subscribe(onChange: () => void) {
  window.addEventListener(THEME_EVENT, onChange);
  return () => window.removeEventListener(THEME_EVENT, onChange);
}

/** The active theme, re-rendering when it changes. Server render assumes dark. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, currentTheme, () => 'dark');
}

/** A CSS custom property's current value, for canvas code (charts) that can't use var(). */
export function cssVar(name: string): string {
  if (typeof document === 'undefined') return '';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** rgb(var(--x-rgb) / a) as a plain string for canvas code. */
export function cssRgba(name: string, alpha: number): string {
  const triplet = cssVar(name);
  return triplet ? `rgb(${triplet} / ${alpha})` : `rgba(0,0,0,${alpha})`;
}

/**
 * Canvas libraries (lightweight-charts) can't read CSS variables. Walks an
 * options object and turns `var(--x)` and `rgb(var(--x-rgb)/a)` strings into
 * plain colours for the current theme.
 */
export function canvasColors<T>(value: T): T {
  if (typeof value === 'string') {
    if (!value.includes('var(')) return value;
    const rgbMatch = value.match(/^rgb\(var\((--[\w-]+)\)\s*\/\s*([\d.]+)\)$/);
    if (rgbMatch) {
      const [r, g, b] = cssVar(rgbMatch[1]).split(/\s+/);
      return `rgba(${r},${g},${b},${rgbMatch[2]})` as T;
    }
    return value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => cssVar(name)) as T;
  }
  if (Array.isArray(value)) return value.map(canvasColors) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = canvasColors(item);
    return out as T;
  }
  return value;
}
