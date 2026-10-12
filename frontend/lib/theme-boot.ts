/** Theme constants shared by the server layout and client code. */

export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'bullseye-theme';
export const THEME_EVENT = 'bullseye-theme';

/**
 * Runs before first paint (inlined in app/layout.tsx) so the page never
 * flashes the wrong theme: a saved choice wins, otherwise the OS setting.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t!=='light'&&t!=='dark'){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='dark';}})();`;

