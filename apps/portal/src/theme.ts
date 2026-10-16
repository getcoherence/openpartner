/**
 * Design tokens.
 *
 * Palette inspiration: Dub's "clean crisp card" layout for data-density
 * pages; Micro.so's "deep charcoal with warm content" for the shell. Dark
 * is the reference palette — it's the right register for an ops / payouts
 * tool — and a crisp neutral light palette ships alongside it.
 *
 * Light / dark: every color token is a CSS custom property
 * (`var(--op-<name>, <dark fallback>)`). global.css defines both palettes —
 * `:root` holds the dark values, `:root[data-theme="light"]` the light ones
 * — and lib/theme-preference.ts sets `data-theme` on <html> from the user's
 * System / Light / Dark choice. Components never branch on the theme; the
 * browser re-resolves the vars. The fallbacks are the dark hexes, so a
 * render without the stylesheet (unit tests) looks exactly like before.
 *
 * IMPORTANT: because the values are var() expressions, never build tints by
 * string-concatenating a hex alpha suffix onto a token (appending `55` to
 * `${theme.success}` silently produces an invalid color). Use
 * `alpha(theme.success, 0.333)` instead, or the accentA* tokens below.
 * Likewise SVG: set token colors through `style={{ fill, stroke }}` or
 * `currentColor`, not presentation attributes.
 */

export const theme = {
  // Surfaces
  bg: 'var(--op-bg, #0b0d10)', // page background
  surface: 'var(--op-surface, #14171c)', // cards + content panels
  surface2: 'var(--op-surface2, #1b1f26)', // raised / hover / inputs
  surface3: 'var(--op-surface3, #252a33)', // hover over surface2 (secondary button)
  sidebar: 'var(--op-sidebar, #0e1116)',
  border: 'var(--op-border, #242932)',
  borderSubtle: 'var(--op-border-subtle, #1d2029)',

  // Ink
  text: 'var(--op-text, #e6e8eb)',
  textMuted: 'var(--op-text-muted, #8b929c)',
  textDim: 'var(--op-text-dim, #5a6370)',

  // Accent — soft teal by default. Distinct from Dub's pink and Stripe's
  // violet; reads as "attribution/trust" without being finance-default blue.
  //
  // Two layers: BrandDocument (lib/BrandDocument.tsx) sets the --op-accent*
  // properties from the tenant's brandColor, which re-tints buttons, links,
  // and the active nav across the app without touching any component. With
  // no brandColor those are unset and the per-theme --op-accent-*-default
  // values from global.css apply (teal in dark, a deeper teal in light).
  accent: 'var(--op-accent, var(--op-accent-default, #2dd4bf))',
  accentHover: 'var(--op-accent-hover, var(--op-accent-hover-default, #14b8a6))',
  accentSoft: 'var(--op-accent-soft, var(--op-accent-soft-default, #0d2c2a))',
  accentInk: 'var(--op-accent-ink, var(--op-accent-ink-default, #08141a))',
  // The accent used as TEXT or a link/icon color. Equals the accent in dark
  // mode; in light mode global.css darkens a tenant brand color
  // (color-mix toward black) so a bright brand stays readable on white.
  // Use this — not `accent` — for `color:`; keep `accent` for fills,
  // borders and buttons (whose text is accentInk).
  accentText: 'var(--op-accent-text, var(--op-accent-text-default, #2dd4bf))',
  // Alpha tints (suffix = hex alpha). Fallbacks are the teal + that alpha.
  accentA10: 'var(--op-accent-a10, var(--op-accent-a10-default, #2dd4bf10))',
  accentA15: 'var(--op-accent-a15, var(--op-accent-a15-default, #2dd4bf15))',
  accentA22: 'var(--op-accent-a22, var(--op-accent-a22-default, #2dd4bf22))',
  accentA25: 'var(--op-accent-a25, var(--op-accent-a25-default, #2dd4bf25))',
  accentA55: 'var(--op-accent-a55, var(--op-accent-a55-default, #2dd4bf55))',
  accentA88: 'var(--op-accent-a88, var(--op-accent-a88-default, #2dd4bf88))',
  accentSoftA40: 'var(--op-accent-soft-a40, var(--op-accent-soft-a40-default, #0d2c2a40))',

  // Status hues — used by the StatusPill. Each foreground meets WCAG AA
  // (4.5:1) on its own *Soft background in both themes.
  warn: 'var(--op-warn, #f59e0b)',
  warnSoft: 'var(--op-warn-soft, #2a1f0a)',
  info: 'var(--op-info, #60a5fa)',
  infoSoft: 'var(--op-info-soft, #0f1e34)',
  infoChip: 'var(--op-info-chip, #1e2a3d)', // partner identity chip background
  success: 'var(--op-success, #34d399)',
  successSoft: 'var(--op-success-soft, #0c2318)',
  danger: 'var(--op-danger, #f87171)',
  dangerSoft: 'var(--op-danger-soft, #2a1212)',
  dangerSoftHover: 'var(--op-danger-soft-hover, #3d1818)', // danger button hover

  // Elevation — shadows/scrims tuned per theme (a heavy black shadow suits
  // a dark page; on a light page it reads as a smudge).
  overlay: 'var(--op-overlay, rgba(0,0,0,0.5))', // modal / drawer backdrop
  shadowPopover: 'var(--op-shadow-popover, 0 8px 24px rgba(0,0,0,0.35))',
  shadowDrawer: 'var(--op-shadow-drawer, 0 0 40px rgba(0,0,0,0.5))',
  shadowRaised: 'var(--op-shadow-raised, 0 30px 80px -30px rgba(0,0,0,0.6))', // auth cards

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

/**
 * A translucent version of a color token — the var()-safe replacement for
 * the old `${token}55` hex-alpha suffix. `a` is 0–1 (hex 55 ≈ 0.333,
 * 44 ≈ 0.267, 10 ≈ 0.063, cc = 0.8). Mixing with `transparent` in sRGB is
 * exactly "this color at alpha a", so dark mode renders as it did.
 */
export function alpha(color: string, a: number): string {
  const pct = Math.round(Math.min(1, Math.max(0, a)) * 1000) / 10;
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

/**
 * De-emphasized status text (the secondary line inside a success/danger
 * banner). Dark mode fades it to 80% like the old `${token}cc`; light mode
 * keeps full strength (--op-text-fade: 100% in global.css) because fading
 * a dark ink toward a pale banner drops it below WCAG AA.
 */
export function softText(color: string): string {
  return `color-mix(in srgb, ${color} var(--op-text-fade, 80%), transparent)`;
}
