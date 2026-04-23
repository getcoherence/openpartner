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

  // Accent — soft teal. Distinct from Dub's pink and Stripe's violet;
  // reads as "attribution/trust" without being finance-default blue.
  accent: '#2dd4bf',
  accentHover: '#14b8a6',
  accentSoft: '#0d2c2a',
  accentInk: '#08141a',

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
