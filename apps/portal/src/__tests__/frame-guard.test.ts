// @vitest-environment jsdom
/**
 * The hosted portal can't send frame headers (App Platform static site), so
 * the SPA refuses to mount inside another site's frame. The notice it shows
 * instead links to the page without its query: magic-link tokens live there.
 */
import { describe, expect, it } from 'vitest';
import { isFramed, showFramedNotice } from '../lib/frame-guard.js';

describe('isFramed', () => {
  it('is false for a top-level page', () => {
    expect(isFramed(window)).toBe(false);
  });

  it('is true when the top window is another one', () => {
    const top = {} as Window;
    expect(isFramed({ self: {} as Window & typeof globalThis, top })).toBe(true);
  });

  it('is true when reading the top window throws', () => {
    const win = {
      self: {} as Window & typeof globalThis,
      get top(): Window {
        throw new DOMException('Blocked', 'SecurityError');
      },
    };
    expect(isFramed(win)).toBe(true);
  });
});

describe('showFramedNotice', () => {
  it('replaces the app root with a notice that opens the page in a new tab', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button>Sign in</button>';
    showFramedNotice(root, { origin: 'https://portal.brand.test', pathname: '/t/acme/login' });

    expect(root.querySelector('button')).toBeNull();
    expect(root.textContent).toContain('can’t be shown inside another website');
    const link = root.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://portal.brand.test/t/acme/login');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
  });

  it('leaves the query and fragment out of the link', () => {
    const root = document.createElement('div');
    window.history.replaceState(null, '', '/auth/verify?token=secret#next');
    showFramedNotice(root);

    expect(root.querySelector('a')!.getAttribute('href')).toBe(`${window.location.origin}/auth/verify`);
  });
});
