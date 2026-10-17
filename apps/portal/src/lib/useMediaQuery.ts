import { useEffect, useState } from 'react';

/**
 * Subscribe a component to a CSS media query.
 *
 * The portal styles entirely with inline `style` objects, so there are no
 * stylesheets to hang `@media` rules off of. This hook is how components
 * branch their inline styles by viewport: it reads `matchMedia` and
 * re-renders on change.
 *
 * SSR-safe: returns `false` when `window` is unavailable (the portal is a
 * pure SPA today, but this keeps the hook honest if that ever changes).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    // Sync immediately in case the query changed since the last render.
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/**
 * Mobile breakpoint for the portal: 768px and below collapses the fixed
 * sidebar into a drawer and stacks multi-column layouts into one column.
 * Matches the common tablet-portrait / phone boundary.
 */
export const MOBILE_BREAKPOINT = 768;

export function useIsMobile(): boolean {
  return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT}px)`);
}
