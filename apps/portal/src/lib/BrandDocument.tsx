import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { usePublicBrand, DEFAULT_BRAND } from './useBrand.js';

/**
 * Keeps the HTML document itself on-brand: tab title, favicon, og:title,
 * and the accent CSS custom properties the theme tokens read.
 *
 * index.html ships hardcoded "OpenPartner" + the platform favicon — the one
 * pair of brand marks that survives every in-app branding change, cache
 * clear, and incognito window (first real-world report: a white-label
 * admin who "changed the name and logo but it still appears" — in the tab).
 *
 * White-label: title is the brand name alone and the favicon is the brand
 * favicon → logo → a neutral monogram — never the platform mark. Branded
 * but non-white-label tenants get "Brand · OpenPartner". Platform surfaces
 * keep the shipped defaults.
 *
 * Theming: when the tenant has a brandColor, the --op-accent* properties
 * are set on <html>; every accent token in theme.ts is a var() over them,
 * so buttons, links, and the active nav re-tint app-wide. No brandColor →
 * properties removed → teal fallbacks apply.
 */
export function BrandDocument() {
  // Subscribe to navigation so usePublicBrand re-reads the /t/<slug>/ URL
  // prefix when the user moves between platform and tenant surfaces.
  useLocation();
  const { programName, logoUrl, faviconUrl, whiteLabel, brandColor, isLoading } = usePublicBrand();

  useEffect(() => {
    if (isLoading) return;
    applyAccent(brandColor);

    const branded = programName && programName !== DEFAULT_BRAND;
    if (!branded && !whiteLabel) return; // platform surface — leave defaults

    const title = whiteLabel ? programName : `${programName} · ${DEFAULT_BRAND}`;
    document.title = title;
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', title);

    const icon = faviconUrl ?? logoUrl ?? (whiteLabel ? monogramIcon(programName, brandColor) : null);
    if (icon) {
      for (const el of Array.from(document.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]'))) {
        el.remove();
      }
      const link = document.createElement('link');
      link.rel = 'icon';
      link.href = icon;
      document.head.appendChild(link);
    }
  }, [programName, logoUrl, faviconUrl, whiteLabel, brandColor, isLoading]);

  return null;
}

const ACCENT_ALPHAS = ['10', '15', '22', '25', '55', '88'] as const;

/** Set (or clear) the --op-accent* custom properties from a brand color.
 *  Derivations happen here once, in JS, because inline styles can't
 *  color-math a var(): hover = darkened, ink = black/white by luminance,
 *  soft = low-alpha tint that reads on the dark surface. */
function applyAccent(brandColor: string | null): void {
  const root = document.documentElement;
  const hex = normalizeHex(brandColor);
  if (!hex) {
    for (const prop of allAccentProps()) root.style.removeProperty(prop);
    return;
  }
  root.style.setProperty('--op-accent', hex);
  root.style.setProperty('--op-accent-hover', shade(hex, 0.85));
  root.style.setProperty('--op-accent-ink', luminance(hex) > 0.45 ? '#0b0d10' : '#ffffff');
  root.style.setProperty('--op-accent-soft', `${hex}26`);
  root.style.setProperty('--op-accent-soft-a40', `${hex}1a`);
  for (const a of ACCENT_ALPHAS) root.style.setProperty(`--op-accent-a${a}`, `${hex}${a}`);
}

function allAccentProps(): string[] {
  return [
    '--op-accent',
    '--op-accent-hover',
    '--op-accent-ink',
    '--op-accent-soft',
    '--op-accent-soft-a40',
    ...ACCENT_ALPHAS.map((a) => `--op-accent-a${a}`),
  ];
}

/** #RGB / #RRGGBB / #RRGGBBAA → #rrggbb (alpha stripped), else null. */
export function normalizeHex(input: string | null): string | null {
  if (!input) return null;
  const v = input.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) {
    return v.slice(0, 7).toLowerCase();
  }
  return null;
}

function channels(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** Multiply RGB toward black (factor < 1) for the hover shade. */
export function shade(hex: string, factor: number): string {
  const [r, g, b] = channels(hex).map((c) => Math.max(0, Math.min(255, Math.round(c * factor)))) as [
    number,
    number,
    number,
  ];
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** WCAG relative luminance — picks readable text on the accent. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** Tiny SVG monogram data-URI — the white-label no-logo fallback, so the
 *  tab never shows the platform mark. */
function monogramIcon(name: string, brandColor: string | null): string {
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  const bg = normalizeHex(brandColor) ?? '#1f2937';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="${bg}"/>` +
    `<text x="16" y="22" text-anchor="middle" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="${luminance(bg) > 0.45 ? '#0b0d10' : '#ffffff'}">${initial}</text>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
