/**
 * formatDate(d, { relative: true }) reads both ways. It used to return
 * "just now" for every future date, so a creator's accrued commissions
 * all said "Matures just now" through a 30-day holdback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDate } from '../ui.js';

// Local noon, so the absolute fallback names the same day in any timezone.
const NOW = new Date(2026, 9, 21, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

describe('formatDate relative', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says "just now" within a minute either side', () => {
    expect(formatDate(NOW, { relative: true })).toBe('just now');
    expect(formatDate(at(-59_999), { relative: true })).toBe('just now');
    expect(formatDate(at(59_999), { relative: true })).toBe('just now');
  });

  it('keeps the past wording', () => {
    expect(formatDate(at(-MIN), { relative: true })).toBe('1m ago');
    expect(formatDate(at(-5 * MIN), { relative: true })).toBe('5m ago');
    expect(formatDate(at(-HOUR + 1), { relative: true })).toBe('59m ago');
    expect(formatDate(at(-3 * HOUR), { relative: true })).toBe('3h ago');
    expect(formatDate(at(-DAY + 1), { relative: true })).toBe('23h ago');
    expect(formatDate(at(-2 * DAY), { relative: true })).toBe('2d ago');
    expect(formatDate(at(-30 * DAY + 1), { relative: true })).toBe('29d ago');
  });

  it('reads future dates as "in …"', () => {
    expect(formatDate(at(MIN), { relative: true })).toBe('in 1m');
    expect(formatDate(at(5 * MIN), { relative: true })).toBe('in 5m');
    expect(formatDate(at(HOUR - 1), { relative: true })).toBe('in 59m');
    expect(formatDate(at(3 * HOUR), { relative: true })).toBe('in 3h');
    expect(formatDate(at(DAY - 1), { relative: true })).toBe('in 23h');
    expect(formatDate(at(12 * DAY), { relative: true })).toBe('in 12d');
    expect(formatDate(at(30 * DAY - 1), { relative: true })).toBe('in 29d');
  });

  it('takes ISO strings, as the API sends them', () => {
    expect(formatDate(at(12 * DAY).toISOString(), { relative: true })).toBe('in 12d');
    expect(formatDate(at(-2 * DAY).toISOString(), { relative: true })).toBe('2d ago');
  });

  it('falls back to the absolute date from 30 days either side', () => {
    expect(formatDate(at(-30 * DAY), { relative: true })).toBe('Sep 21, 2026');
    expect(formatDate(at(30 * DAY), { relative: true })).toBe('Nov 20, 2026');
    expect(formatDate(new Date(2026, 8, 20, 12), { relative: true })).toBe('Sep 20, 2026');
    expect(formatDate(new Date(2026, 10, 21, 12), { relative: true })).toBe('Nov 21, 2026');
    expect(formatDate(new Date(2027, 0, 5, 12), { relative: true })).toBe('Jan 5, 2027');
  });

  it('leaves the non-relative and empty cases alone', () => {
    expect(formatDate(at(-2 * DAY))).toBe('Oct 19, 2026');
    expect(formatDate(null, { relative: true })).toBe('—');
  });
});
