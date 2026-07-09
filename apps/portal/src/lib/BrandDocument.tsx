import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { usePublicBrand, DEFAULT_BRAND } from './useBrand.js';

/**
 * Keeps the HTML document itself on-brand: tab title, favicon, and og:title.
 *
 * index.html ships hardcoded "OpenPartner" + the platform favicon — the one
 * pair of brand marks that survives every in-app branding change, cache
 * clear, and incognito window (first real-world report: a white-label
 * admin who "changed the name and logo but it still appears" — in the tab).
 *
 * White-label: title is the brand name alone and the favicon is the brand
 * logo (or a neutral monogram — never the platform mark). Branded but
 * non-white-label tenants get "Brand · OpenPartner". Platform surfaces
 * keep the shipped defaults.
 */
export function BrandDocument() {
  // Subscribe to navigation so usePublicBrand re-reads the /t/<slug>/ URL
  // prefix when the user moves between platform and tenant surfaces.
  useLocation();
  const { programName, logoUrl, whiteLabel, brandColor, isLoading } = usePublicBrand();

  useEffect(() => {
    if (isLoading) return;
    const branded = programName && programName !== DEFAULT_BRAND;
    if (!branded && !whiteLabel) return; // platform surface — leave defaults

    const title = whiteLabel ? programName : `${programName} · ${DEFAULT_BRAND}`;
    document.title = title;
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', title);

    const icon = logoUrl ?? (whiteLabel ? monogramIcon(programName, brandColor) : null);
    if (icon) {
      for (const el of Array.from(document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]'))) {
        el.remove();
      }
      const link = document.createElement('link');
      link.rel = 'icon';
      link.href = icon;
      document.head.appendChild(link);
    }
  }, [programName, logoUrl, whiteLabel, brandColor, isLoading]);

  return null;
}

/** Tiny SVG monogram data-URI — the white-label no-logo fallback, so the
 *  tab never shows the platform mark. */
function monogramIcon(name: string, brandColor: string | null): string {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  const bg = brandColor && /^#[0-9a-fA-F]{3,8}$/.test(brandColor) ? brandColor : '#1f2937';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="${bg}"/>` +
    `<text x="16" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="#ffffff">${initial}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
