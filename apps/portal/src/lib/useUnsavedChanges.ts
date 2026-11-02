import { useEffect } from 'react';

export const LEAVE_PROMPT = 'You have unsaved changes. Leave without saving them?';

/**
 * Warn before leaving a form with unsaved edits: the browser's own prompt on
 * a reload, a closed tab or another site, and a confirm on in-app links.
 *
 * The portal runs a plain BrowserRouter, not a data router, so React
 * Router's useBlocker isn't available: in-app links are caught as clicks,
 * and the browser's Back button goes unwarned.
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

const dirtyForms = new Set<symbol>();
/** When a leave was last confirmed here: a full-page link unloads right after, and shouldn't ask twice. */
let confirmedAt = 0;

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (Date.now() - confirmedAt < 1000) return;
  e.preventDefault();
  // Older Chromium prompts only once returnValue is set.
  e.returnValue = '';
}

function onClick(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = e.target instanceof Element ? e.target.closest('a[href]') : null;
  if (!(link instanceof HTMLAnchorElement) || link.hasAttribute('download')) return;
  if (link.target && link.target !== '_self') return;
  const to = new URL(link.href);
  // Another site unloads the page, which the browser's own prompt covers.
  if (to.origin !== window.location.origin) return;
  // A jump within this page loses nothing.
  if (to.pathname === window.location.pathname && to.search === window.location.search) return;
  if (window.confirm(LEAVE_PROMPT)) {
    confirmedAt = Date.now();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
}
