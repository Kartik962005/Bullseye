/** Theme constants shared by the server layout and client code. */

export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'bullseye-theme';
export const THEME_EVENT = 'bullseye-theme';

/** Every visitor starts in light mode; dark is only used once they choose it. */
export const DEFAULT_THEME: Theme = 'light';

/** Browser toolbar colour for each theme (matches --bg in globals.css). */
export const THEME_BAR_COLOR: Record<Theme, string> = { light: '#f6f6f7', dark: '#0b0c0e' };

/**
 * Runs before first paint (inlined in app/layout.tsx) so the page never
 * flashes the wrong theme: a saved choice wins, otherwise light.
 */
export const THEME_BOOT_SCRIPT = `(function(){var t='${DEFAULT_THEME}';try{var s=localStorage.getItem('${THEME_STORAGE_KEY}');if(s==='light'||s==='dark'){t=s;}}catch(e){}document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name="theme-color"]');if(m){m.setAttribute('content',t==='dark'?'${THEME_BAR_COLOR.dark}':'${THEME_BAR_COLOR.light}');}})();`;

