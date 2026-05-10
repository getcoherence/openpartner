/**
 * User-agent parsing for analytics breakdowns.
 *
 * We parse on read (vs. persisting parsed values at click time) so that:
 *   - The Click table stays simple — one userAgent string column
 *   - Bumping ua-parser-js retroactively re-parses historical clicks
 *     under the new rules without a backfill
 *   - Custom event types or upstream changes can repurpose these
 *     dimensions without a schema migration
 *
 * The cost is one parse per row when the analytics endpoint runs the
 * breakdown queries. ua-parser-js is regex-based and ~50µs per parse —
 * well under the noise floor of a 1000-row aggregation.
 *
 * Buckets are deliberately coarse:
 *   device  → desktop | mobile | tablet | other
 *   browser → top-level family (Chrome, Safari, Firefox, ...) or 'other'
 *   os      → top-level family (iOS, Android, Windows, macOS, ...) or 'other'
 *
 * Bot user-agents are normalized to dimensionKey='bot' so they fall into
 * one bucket on the chart instead of fragmenting the breakdown.
 */

import { UAParser } from 'ua-parser-js';

export type DeviceBucket = 'desktop' | 'mobile' | 'tablet' | 'bot' | 'other';

export interface ParsedUserAgent {
  device: DeviceBucket;
  browser: string;
  os: string;
}

const BOT_HINT = /(bot|crawler|spider|headless|preview|scrapy|wget|curl)/i;

/**
 * Parse a userAgent string into stable bucket labels suitable for
 * GROUP BY breakdowns. Null / empty UA → 'unknown' across all
 * dimensions so the row still aggregates instead of dropping silently.
 */
export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
  if (!ua) return { device: 'other', browser: 'unknown', os: 'unknown' };

  // Catch obvious bots before parsing — they pollute browser/OS
  // breakdowns with thousands of one-off labels otherwise.
  if (BOT_HINT.test(ua)) return { device: 'bot', browser: 'bot', os: 'bot' };

  const parsed = new UAParser(ua).getResult();

  let device: DeviceBucket;
  switch (parsed.device.type) {
    case 'mobile':
      device = 'mobile';
      break;
    case 'tablet':
      device = 'tablet';
      break;
    case undefined:
      // ua-parser-js returns undefined for desktop UAs (the spec has
      // no 'desktop' type). Anything else exotic (smarttv, console,
      // wearable, embedded) bucketed as 'other'.
      device = 'desktop';
      break;
    default:
      device = 'other';
  }

  return {
    device,
    browser: parsed.browser.name || 'unknown',
    os: parsed.os.name || 'unknown',
  };
}
