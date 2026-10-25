// Light or dark. The viewer picks System, Light or Dark (kept in this browser); System follows the operating
// system, and is what a share link always uses. A choice sets data-theme on <html>, which styles.css reads (with
// prefers-color-scheme for System). Charts drawn on a canvas can't read CSS, so they ask color() for a token's value
// and draw again when useTheme() changes.
import { useSyncExternalStore } from 'react';

const KEY = 'glitchless.theme';
export const THEMES = ['system', 'light', 'dark'];
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const listeners = new Set();
const notify = () => listeners.forEach((f) => f());
media?.addEventListener?.('change', notify);

export function themePref() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.includes(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

// Applies a choice to the page; `remember` keeps it for next time (a share link applies System without forgetting
// the viewer's own choice).
export function applyTheme(pref = themePref(), { remember = false } = {}) {
  if (remember) {
    try {
      if (pref === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, pref);
    } catch {}
  }
  const root = document.documentElement;
  if (pref === 'light' || pref === 'dark') root.dataset.theme = pref;
  else delete root.dataset.theme;
  notify();
}

// 'light' or 'dark', as the page shows now.
export function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'dark' ? t : media?.matches ? 'dark' : 'light';
}

const subscribe = (f) => (listeners.add(f), () => listeners.delete(f));
export const useTheme = () => useSyncExternalStore(subscribe, currentTheme);
export const useThemePref = () => useSyncExternalStore(subscribe, themePref);

// A colour as a canvas needs it: "var(--ink)" read from the element it is drawn in (so a board's own accent
// counts), anything else as it is.
export function color(c, el = document.documentElement) {
  const m = typeof c === 'string' && /^var\((--[\w-]+)\)$/.exec(c.trim());
  if (!m) return c;
  return getComputedStyle(el).getPropertyValue(m[1]).trim() || c;
}
