import { useCallback, useSyncExternalStore } from 'react';

/**
 * Light / dark preference.
 *
 * Three-way choice — System (follow the OS), Light, Dark — remembered per
 * browser in localStorage. Resolving it sets `data-theme="light" | "dark"`
 * on <html>; global.css swaps the --op-* palette on that attribute and
 * every theme token (theme.ts) follows, so no component re-renders to
 * change theme.
 *
 * The very first resolution happens in an inline script in index.html,
 * before first paint (no flash of the wrong theme). This module repeats it
 * at startup (main.tsx), then keeps it current: OS changes while on
 * System, choices made in the toggle, and choices made in another tab
 * (the `storage` event).
 *
 * Every storage / matchMedia access is guarded: private windows, blocked
 * site data and jsdom must degrade to "system → dark", never throw.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'op-theme';
export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

const LIGHT_QUERY = '(prefers-color-scheme: light)';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Stored preference; missing, invalid, or unreadable storage → 'system'. */
export function readThemePreference(): ThemePreference {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(v) ? v : 'system';
  } catch {
    return 'system';
  }
}

function writeThemePreference(pref: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* storage blocked — the choice still applies for this page view */
  }
}

function systemQuery(): MediaQueryList | null {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
    return window.matchMedia(LIGHT_QUERY);
  } catch {
    return null;
  }
}

/** 'system' follows the OS; no matchMedia (jsdom, very old browsers) → dark. */
export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === 'light' || pref === 'dark') return pref;
  return systemQuery()?.matches ? 'light' : 'dark';
}

// ---------------- module state ----------------

let current: ThemePreference | null = null;
const subscribers = new Set<() => void>();
let systemMql: MediaQueryList | null = null;
let storageBound = false;

function notify(): void {
  for (const fn of subscribers) fn();
}

function onSystemChange(): void {
  if (current !== 'system') return;
  setDocumentTheme(resolveTheme('system'));
  notify();
}

function onStorage(e: StorageEvent): void {
  // key === null → another tab called localStorage.clear().
  if (e.key !== THEME_STORAGE_KEY && e.key !== null) return;
  applyThemePreference(readThemePreference());
  notify();
}

function setDocumentTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = resolved;
}

/** Listen for OS changes only while the preference is 'system'. */
function syncSystemListener(pref: ThemePreference): void {
  if (pref === 'system') {
    if (systemMql) return;
    systemMql = systemQuery();
    systemMql?.addEventListener('change', onSystemChange);
  } else if (systemMql) {
    systemMql.removeEventListener('change', onSystemChange);
    systemMql = null;
  }
}

function bindStorageListener(): void {
  if (storageBound || typeof window === 'undefined') return;
  window.addEventListener('storage', onStorage);
  storageBound = true;
}

/**
 * Resolve + apply a preference (default: the stored one) to <html>, and
 * start following the OS when it's 'system'. Call once at startup; safe to
 * call again. Does not write storage — see setThemePreference.
 */
export function applyThemePreference(pref: ThemePreference = readThemePreference()): ResolvedTheme {
  current = pref;
  const resolved = resolveTheme(pref);
  setDocumentTheme(resolved);
  syncSystemListener(pref);
  bindStorageListener();
  return resolved;
}

/** The user picked a theme: persist, apply, and update every subscriber. */
export function setThemePreference(pref: ThemePreference): void {
  writeThemePreference(pref);
  applyThemePreference(pref);
  notify();
}

export function getThemePreference(): ThemePreference {
  return current ?? readThemePreference();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  bindStorageListener();
  return () => {
    subscribers.delete(fn);
  };
}

/**
 * `[preference, setPreference]` — shared by every mounted toggle and kept
 * in sync across tabs.
 */
export function useThemePreference(): [ThemePreference, (pref: ThemePreference) => void] {
  const pref = useSyncExternalStore(subscribe, getThemePreference, () => 'system' as const);
  const set = useCallback((p: ThemePreference) => setThemePreference(p), []);
  return [pref, set];
}

/** Test hook: drop listeners + cached state so each test starts cold. */
export function resetThemePreferenceForTests(): void {
  syncSystemListener('light'); // unbinds the OS listener if bound
  if (storageBound && typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
  storageBound = false;
  current = null;
  subscribers.clear();
}
