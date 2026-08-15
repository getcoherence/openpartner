import { describe, it, expect } from 'vitest';
import { shouldRunPayoutsThisTick } from '../scheduler.js';

// The cron only fires on Mondays 09:00 UTC, so every date in here is a
// real Monday. Pinning to UTC matters for the monthly gate (day-of-month
// in UTC) and biweekly (ISO week number).
const monday = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d, 9, 0, 0));

describe('shouldRunPayoutsThisTick', () => {
  it('weekly runs on every tick', () => {
    expect(shouldRunPayoutsThisTick('weekly', monday(2026, 5, 4))).toBe(true);
    expect(shouldRunPayoutsThisTick('weekly', monday(2026, 5, 11))).toBe(true);
    expect(shouldRunPayoutsThisTick('weekly', monday(2026, 5, 18))).toBe(true);
    expect(shouldRunPayoutsThisTick('weekly', monday(2026, 5, 25))).toBe(true);
  });

  it('manual never runs', () => {
    expect(shouldRunPayoutsThisTick('manual', monday(2026, 5, 4))).toBe(false);
    expect(shouldRunPayoutsThisTick('manual', monday(2026, 5, 11))).toBe(false);
  });

  it('monthly runs only when the Monday is in the first 7 days of the month', () => {
    // First Mondays of 2026
    expect(shouldRunPayoutsThisTick('monthly', monday(2026, 1, 5))).toBe(true);
    expect(shouldRunPayoutsThisTick('monthly', monday(2026, 2, 2))).toBe(true);
    expect(shouldRunPayoutsThisTick('monthly', monday(2026, 3, 2))).toBe(true);
    expect(shouldRunPayoutsThisTick('monthly', monday(2026, 5, 4))).toBe(true);
    expect(shouldRunPayoutsThisTick('monthly', monday(2026, 6, 1))).toBe(true);
    // Second/third/fourth Mondays of May
    expect(shouldRunPayoutsThisTick('monthly', monday(2026, 5, 11))).toBe(false);
    expect(shouldRunPayoutsThisTick('monthly', monday(2026, 5, 18))).toBe(false);
    expect(shouldRunPayoutsThisTick('monthly', monday(2026, 5, 25))).toBe(false);
  });

  it('biweekly alternates by ISO week number', () => {
    // Pick a known alternating run of Mondays and verify exactly half fire.
    const mondays = [
      monday(2026, 5, 4),
      monday(2026, 5, 11),
      monday(2026, 5, 18),
      monday(2026, 5, 25),
      monday(2026, 6, 1),
      monday(2026, 6, 8),
    ];
    const ran = mondays.filter((d) => shouldRunPayoutsThisTick('biweekly', d));
    expect(ran.length).toBe(3);
    // And the running pattern alternates — no two consecutive Mondays both run.
    for (let i = 1; i < mondays.length; i += 1) {
      const prev = shouldRunPayoutsThisTick('biweekly', mondays[i - 1]!);
      const curr = shouldRunPayoutsThisTick('biweekly', mondays[i]!);
      expect(prev).not.toBe(curr);
    }
  });
});
