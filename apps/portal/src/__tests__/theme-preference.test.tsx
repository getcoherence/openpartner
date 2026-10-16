// @vitest-environment jsdom
/**
 * Light / dark preference: System (default, follows the OS) / Light / Dark,
 * remembered per browser under localStorage "op-theme", applied as
 * <html data-theme="light|dark">. Storage and matchMedia must never be able
 * to crash the app (private windows, blocked site data, jsdom).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  THEME_STORAGE_KEY,
  applyThemePreference,
  readThemePreference,
  resetThemePreferenceForTests,
  resolveTheme,
  setThemePreference,
} from '../lib/theme-preference.js';
import { ThemeToggle } from '../lib/ThemeToggle.js';

/** A controllable `(prefers-color-scheme: light)` MediaQueryList. */
function mockSystemTheme(initial: 'light' | 'dark') {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: initial === 'light',
    media: '(prefers-color-scheme: light)',
    onchange: null,
    addEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_type: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  window.matchMedia = vi.fn(() => mql as unknown as MediaQueryList);
  return {
    listenerCount: () => listeners.size,
    set(next: 'light' | 'dark') {
      mql.matches = next === 'light';
      for (const fn of [...listeners]) fn({ matches: mql.matches } as MediaQueryListEvent);
    },
  };
}

const dataTheme = () => document.documentElement.dataset.theme;

beforeEach(() => {
  resetThemePreferenceForTests();
  window.localStorage.clear();
  delete document.documentElement.dataset.theme;
  // jsdom has no matchMedia; individual tests install a mock.
  delete (window as { matchMedia?: unknown }).matchMedia;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetThemePreferenceForTests();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('theme preference', () => {
  it('defaults to system, which resolves to dark without matchMedia (jsdom)', () => {
    expect(readThemePreference()).toBe('system');
    expect(resolveTheme('system')).toBe('dark');
    expect(applyThemePreference()).toBe('dark');
    expect(dataTheme()).toBe('dark');
  });

  it('persists the chosen preference and re-applies it on the next load', () => {
    setThemePreference('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(dataTheme()).toBe('light');

    // "Reload": cold module state, same storage.
    resetThemePreferenceForTests();
    delete document.documentElement.dataset.theme;
    expect(readThemePreference()).toBe('light');
    applyThemePreference();
    expect(dataTheme()).toBe('light');

    setThemePreference('system');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });

  it('treats an invalid stored value as system', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'purple');
    expect(readThemePreference()).toBe('system');
    mockSystemTheme('light');
    expect(applyThemePreference()).toBe('light');
  });

  it('system follows prefers-color-scheme and reacts to OS changes', () => {
    const os = mockSystemTheme('light');
    applyThemePreference('system');
    expect(dataTheme()).toBe('light');

    os.set('dark');
    expect(dataTheme()).toBe('dark');
    os.set('light');
    expect(dataTheme()).toBe('light');
  });

  it('an explicit light/dark choice wins over the OS and stops following it', () => {
    const os = mockSystemTheme('light');
    applyThemePreference('system');
    expect(os.listenerCount()).toBe(1);

    setThemePreference('dark');
    expect(dataTheme()).toBe('dark');
    expect(os.listenerCount()).toBe(0);
    os.set('light');
    expect(dataTheme()).toBe('dark');

    setThemePreference('light');
    expect(dataTheme()).toBe('light');
    os.set('dark');
    expect(dataTheme()).toBe('light');
  });

  it('survives storage that throws (private mode / blocked site data)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(readThemePreference()).toBe('system');
    expect(() => applyThemePreference()).not.toThrow();
    expect(dataTheme()).toBe('dark');
    expect(() => setThemePreference('light')).not.toThrow();
    expect(dataTheme()).toBe('light');
  });

  it('picks up a choice made in another tab (storage event)', () => {
    applyThemePreference();
    expect(dataTheme()).toBe('dark');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'light' }));
    expect(dataTheme()).toBe('light');
  });
});

describe('<ThemeToggle>', () => {
  it('renders System / Light / Dark and switches data-theme', () => {
    applyThemePreference();
    render(<ThemeToggle labels />);

    const system = screen.getByRole('button', { name: 'System theme' });
    const light = screen.getByRole('button', { name: 'Light theme' });
    const dark = screen.getByRole('button', { name: 'Dark theme' });
    expect(screen.getByRole('group', { name: 'Color theme' })).toBeTruthy();
    expect(system.getAttribute('aria-pressed')).toBe('true');
    expect(light.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(light);
    expect(dataTheme()).toBe('light');
    expect(light.getAttribute('aria-pressed')).toBe('true');
    expect(system.getAttribute('aria-pressed')).toBe('false');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    fireEvent.click(dark);
    expect(dataTheme()).toBe('dark');
    expect(dark.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps every mounted toggle in sync, including cross-tab changes', () => {
    applyThemePreference();
    render(
      <>
        <ThemeToggle labels />
        <ThemeToggle />
      </>,
    );
    const lights = screen.getAllByRole('button', { name: 'Light theme' });
    fireEvent.click(lights[0]!);
    expect(lights.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'true']);

    act(() => {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      window.dispatchEvent(new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'dark' }));
    });
    const darks = screen.getAllByRole('button', { name: 'Dark theme' });
    expect(darks.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'true']);
    expect(dataTheme()).toBe('dark');
  });
});
