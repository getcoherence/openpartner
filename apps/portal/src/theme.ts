/**
 * Design tokens.
 *
 * Palette inspiration: Dub's "clean crisp card" layout for data-density
 * pages; Micro.so's "deep charcoal with warm content" for the shell. We
 * keep the app dark by default — feels the right register for an ops /
 * payouts tool, plus the stat + status tables are easier to scan against
 * a dark surface.
 */

export const theme = {
  // Surfaces
  bg: '#0b0d10',       // page background
  surface: '#14171c',  // cards + content panels
  surface2: '#1b1f26', // raised / hover
  sidebar: '#0e1116',
  border: '#242932',
  borderSubtle: '#1d2029',

  // Ink
  text: '#e6e8eb',
  textMuted: '#8b929c',
  textDim: '#5a6370',

  // Accent — soft teal by default. Distinct from Dub's pink and Stripe's
  // violet; reads as "attribution/trust" without being finance-default blue.
  //
  // Every accent token is a CSS custom property with the teal as fallback:
  // BrandDocument (lib/BrandDocument.tsx) sets the --op-accent* properties
  // from the tenant's brandColor, which re-tints buttons, links, and the
  // active nav across the app without touching any component. IMPORTANT:
  // never build tints by string-concatenating a hex suffix onto
  // theme.accent (`${theme.accent}15` breaks the moment the value is a
  // var() expression) — use the accentA* tokens below.
  accent: 'var(--op-accent, #2dd4bf)',
  accentHover: 'var(--op-accent-hover, #14b8a6)',
  accentSoft: 'var(--op-accent-soft, #0d2c2a)',
  accentInk: 'var(--op-accent-ink, #08141a)',
  // Alpha tints (suffix = hex alpha). Fallbacks are the teal + that alpha.
  accentA10: 'var(--op-accent-a10, #2dd4bf10)',
  accentA15: 'var(--op-accent-a15, #2dd4bf15)',
  accentA22: 'var(--op-accent-a22, #2dd4bf22)',
  accentA25: 'var(--op-accent-a25, #2dd4bf25)',
  accentA55: 'var(--op-accent-a55, #2dd4bf55)',
  accentA88: 'var(--op-accent-a88, #2dd4bf88)',
  accentSoftA40: 'var(--op-accent-soft-a40, #0d2c2a40)',

  // Status hues — used by the StatusPill.
  warn: '#f59e0b',
  warnSoft: '#2a1f0a',
  info: '#60a5fa',
  infoSoft: '#0f1e34',
  success: '#34d399',
  successSoft: '#0c2318',
  danger: '#f87171',
  dangerSoft: '#2a1212',

  // Radii
  radiusSm: 6,
  radiusMd: 10,
  radiusLg: 14,

  // Typography
  fontSans:
    "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  fontMono: "'JetBrains Mono', ui-monospace, 'Menlo', 'Consolas', monospace",
} as const;

export type Theme = typeof theme;
