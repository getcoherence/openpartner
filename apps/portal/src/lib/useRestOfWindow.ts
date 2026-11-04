import { useLayoutEffect, useState } from 'react';
import { useIsMobile } from './useMediaQuery.js';

/** Shortest a list gets, however little of the window is left for it. */
const MIN_LIST_HEIGHT = 320;

/** From the element's top down to the bottom of the window, less `gap`: a
 *  list scrolls within it, so its scrollbars stay in view. None on phones,
 *  where a list is cards in the page's own scroll. */
export function useRestOfWindow(gap: number): [(el: HTMLDivElement | null) => void, number | undefined] {
  const isMobile = useIsMobile();
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    if (!el || isMobile) {
      setHeight(undefined);
      return;
    }
    const measure = () => setHeight(Math.max(MIN_LIST_HEIGHT, Math.floor(window.innerHeight - (el.getBoundingClientRect().top + window.scrollY) - gap)));
    measure();
    window.addEventListener('resize', measure);
    // Whatever moves the list down (an error, a filter's note) resizes the page.
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resized?.observe(document.body);
    return () => {
      window.removeEventListener('resize', measure);
      resized?.disconnect();
    };
  }, [el, isMobile, gap]);
  return [setEl, height];
}
