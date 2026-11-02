import { useEffect } from 'react';
import { useBlocker, type BlockerFunction } from 'react-router';

export const LEAVE_PROMPT = 'You have unsaved changes. Leave without saving them?';

/**
 * Warn before leaving a form with unsaved edits: the browser's own prompt on
 * a reload, a closed tab or another site, and a confirm on in-app navigation.
 *
 * In the app, UnsavedChangesGuard at the router root asks before any in-app
 * navigation, the browser's Back and Forward included. Without one (a plain
 * BrowserRouter or MemoryRouter, as in most tests), in-app links are caught
 * as clicks instead, and Back goes unwarned.
 *
 * Several forms can be dirty at once; they share one prompt.
 */
export function useUnsavedChanges(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const form = Symbol();
    if (dirtyForms.size === 0) {
      window.addEventListener('beforeunload', onBeforeUnload);
      // Capture, so the confirm runs before React Router's own link handler.
      document.addEventListener('click', onClick, true);
    }
    dirtyForms.add(form);
    return () => {
      dirtyForms.delete(form);
      if (dirtyForms.size === 0) {
        window.removeEventListener('beforeunload', onBeforeUnload);
        document.removeEventListener('click', onClick, true);
        confirmedAt = 0;
      }
    };
  }, [dirty]);
}

/**
 * Asks before an in-app navigation leaves unsaved edits, Back and Forward
 * included. useBlocker needs a data router, and a router takes one blocker,
 * so render this once, at the root.
 */
export function UnsavedChangesGuard(): null {
  const blocker = useBlocker(leavesDirtyForm);
  useEffect(() => {
    guards++;
    return () => {
      guards--;
    };
  }, []);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm(LEAVE_PROMPT)) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
  return null;
}

const dirtyForms = new Set<symbol>();
/** Mounted UnsavedChangesGuards: with one, the router asks, not the click handler. */
let guards = 0;
/** When a leave was last confirmed here: a full-page link unloads right after, and shouldn't ask twice. */
let confirmedAt = 0;

const leavesDirtyForm: BlockerFunction = ({ currentLocation, nextLocation }) =>
  dirtyForms.size > 0 && !samePage(currentLocation, nextLocation);

/** A jump within this page loses nothing. */
function samePage(a: { pathname: string; search: string }, b: { pathname: string; search: string }): boolean {
  return a.pathname === b.pathname && a.search === b.search;
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (Date.now() - confirmedAt < 1000) return;
  e.preventDefault();
  // Older Chromium prompts only once returnValue is set.
  e.returnValue = '';
}

function onClick(e: MouseEvent) {
  if (guards > 0) return;
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = e.target instanceof Element ? e.target.closest('a[href]') : null;
  if (!(link instanceof HTMLAnchorElement) || link.hasAttribute('download')) return;
  if (link.target && link.target !== '_self') return;
  const to = new URL(link.href);
  // Another site unloads the page, which the browser's own prompt covers.
  if (to.origin !== window.location.origin) return;
  if (samePage(to, window.location)) return;
  if (window.confirm(LEAVE_PROMPT)) {
    confirmedAt = Date.now();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}
