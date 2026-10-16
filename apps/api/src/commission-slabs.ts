/**
 * Commission slabs: a sub-rule whose rate varies.
 *
 *   bands — by the event's own value ("≤ 50,000 → 10%, > 50,000 → 15%")
 *   tiers — by the partner's attributed performance in the program over a
 *           window ("15% once the partner has driven 100,000 this month")
 *
 * The sub-rule's `value` is always the base rate. Shapes and validation
 * live in @openpartner/db (CommissionBands / CommissionTiers) and
 * commission-rule-schema.ts; docs/commission-slabs.md is the reference.
 *
 * A tier is a pure function of raw history: Attribution × Event rows for
 * this (partner, program) strictly before the event being accrued, read
 * at accrual time. Nothing is cached or carried on a partner row, so a
 * re-derivation over the same raw tables picks the same tier. The level
 * that applied, and the metric value it was picked from, is stamped on the
 * Commission row (`metadata.slab`) so the immutable ledger shows its work.
 */

import type { Knex } from 'knex';
import { TABLES, type CommissionSubRule, type CommissionTiers, type EventRow } from '@openpartner/db';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What `Commission.metadata.slab` records. Level 0 is the rule's base
 *  value; level n is the rule's levels[n - 1]. */
export interface CommissionSlabTrace {
  kind: 'band' | 'tier';
  /** Position of the sub-rule in the rule array the engine resolved
   *  (the partner's override when one exists, else the program's). */
  ruleIndex: number;
  type: 'percent' | 'fixed';
  /** The level that set the rate. Marginal bands: the highest slice reached. */
  level: number;
  /** That level's `above` / `atLeast`; null for the base level. */
  threshold: number | null;
  /** That level's rate (percent) or amount (fixed). */
  value: number;
  /** Currency the thresholds were read in. */
  currency: string;
  /** Bands: whole or marginal. */
  mode?: 'whole' | 'marginal';
  /** Bands: the event value compared against the thresholds. */
  basis?: number;
  /** Marginal bands: each slice of the event value and the rate it paid. */
  slices?: Array<{ level: number; from: number; to: number | null; portion: number; value: number }>;
  /** Bands: the rule's currency differs from the event's, so the
   *  thresholds can't be compared and the base rate applied. */
  currencyMismatch?: true;
  /** Tiers: what was measured, over which window, and the result. */
  metric?: CommissionTiers['metric'];
  window?: CommissionTiers['window'];
  windowDays?: number;
  windowStart?: string | null;
  countedEventType?: string;
  metricValue?: number;
}

export interface SubRuleAccrual {
  /** Pre-weight commission amount (the caller multiplies by the touch's weight). */
  amount: number;
  slab?: Omit<CommissionSlabTrace, 'ruleIndex'>;
}

type SlabEvent = Pick<EventRow, 'id' | 'type' | 'value' | 'currency' | 'ts'>;

/** Pre-weight amount for a sub-rule that carries bands or tiers. */
export async function accrueSlabRule(
  db: Knex,
  subRule: CommissionSubRule,
  event: SlabEvent,
  ctx: { partnerId: string; programId: string },
): Promise<SubRuleAccrual> {
  const eventCurrency = (event.currency ?? 'USD').toUpperCase();
  const currency = (subRule.currency ?? eventCurrency).toUpperCase();
  const eventValue = event.value != null ? Number(event.value) : 0;

  if (subRule.bands) {
    if (currency !== eventCurrency) {
      // No FX in the engine: a 50,000 INR threshold says nothing about a
      // USD invoice. Pay the base rate rather than guess, and say so.
      return {
        amount: rateAmount(subRule.type, subRule.value, eventValue),
        slab: {
          kind: 'band',
          type: subRule.type,
          mode: subRule.bands.mode,
          level: 0,
          threshold: null,
          value: subRule.value,
          currency,
          basis: eventValue,
          currencyMismatch: true,
        },
      };
    }
    return bandAccrual(subRule, eventValue, currency);
  }

  const tiers = subRule.tiers!;
  const counted = tiers.eventType ?? subRule.eventType;
  const windowStart = tierWindowStart(tiers, new Date(event.ts));
  const metricValue = counted
    ? await tierMetric(db, tiers.metric, counted, windowStart, event, ctx, currency)
    : 0;
  const levels = steps(tiers.levels, 'atLeast');
  let level = 0;
  levels.forEach((l, i) => {
    if (metricValue >= l.threshold) level = i + 1;
  });
  const value = level === 0 ? subRule.value : levels[level - 1]!.value;
  return {
    amount: rateAmount(subRule.type, value, eventValue),
    slab: {
      kind: 'tier',
      type: subRule.type,
      level,
      threshold: level === 0 ? null : levels[level - 1]!.threshold,
      value,
      currency,
      metric: tiers.metric,
      window: tiers.window,
      ...(tiers.window === 'rolling_days' ? { windowDays: tiers.windowDays } : {}),
      windowStart: windowStart ? windowStart.toISOString() : null,
      ...(counted ? { countedEventType: counted } : {}),
      metricValue: roundMetric(metricValue),
    },
  };
}

/**
 * Value bands, pure. `whole` pays the whole event at the rate of the band
 * its value falls in; `marginal` (percent only) pays each slice of the
 * value at its own band's rate. A threshold is the top of the band below
 * it: with `above: 50000`, exactly 50,000 is still in the base band.
 * Values at or below zero (and value-less events) sit in the base band.
 */
export function bandAccrual(
  subRule: Pick<CommissionSubRule, 'type' | 'value' | 'bands'>,
  eventValue: number,
  currency: string,
): SubRuleAccrual {
  const bands = subRule.bands!;
  const levels = steps(bands.levels, 'above');
  const base = { kind: 'band' as const, type: subRule.type, mode: bands.mode, currency, basis: eventValue };

  if (bands.mode === 'marginal' && subRule.type === 'percent' && eventValue > 0) {
    // Integer cents so a slice boundary can't lose a cent to float drift
    // (60,000.10 − 50,000 is 10,000.0999… in binary). Rounded once, at
    // the end, to the nearest cent — the same rounding as a flat percent.
    const valueCents = Math.round(eventValue * 100);
    const bounds = [0, ...levels.map((l) => Math.round(l.threshold * 100))];
    const rates = [subRule.value, ...levels.map((l) => l.value)];
    const slices: NonNullable<CommissionSlabTrace['slices']> = [];
    let centsTimesRate = 0;
    for (let i = 0; i < bounds.length && valueCents > bounds[i]!; i += 1) {
      const top = i + 1 < bounds.length ? bounds[i + 1]! : Infinity;
      const portionCents = Math.min(valueCents, top) - bounds[i]!;
      centsTimesRate += portionCents * rates[i]!;
      slices.push({
        level: i,
        from: bounds[i]! / 100,
        to: Number.isFinite(top) ? top / 100 : null,
        portion: portionCents / 100,
        value: rates[i]!,
      });
    }
    const level = slices.length - 1;
    return {
      amount: Math.round(centsTimesRate / 100) / 100,
      slab: {
        ...base,
        level,
        threshold: level === 0 ? null : levels[level - 1]!.threshold,
        value: rates[level]!,
        slices,
      },
    };
  }

  let level = 0;
  levels.forEach((l, i) => {
    if (eventValue > l.threshold) level = i + 1;
  });
  const value = level === 0 ? subRule.value : levels[level - 1]!.value;
  return {
    amount: rateAmount(subRule.type, value, eventValue),
    slab: { ...base, level, threshold: level === 0 ? null : levels[level - 1]!.threshold, value },
  };
}

/** Start of the tier window for an event at `eventTs`; null = lifetime. */
export function tierWindowStart(tiers: Pick<CommissionTiers, 'window' | 'windowDays'>, eventTs: Date): Date | null {
  if (tiers.window === 'calendar_month') {
    // UTC, like every other date boundary in the engine.
    return new Date(Date.UTC(eventTs.getUTCFullYear(), eventTs.getUTCMonth(), 1));
  }
  if (tiers.window === 'rolling_days') {
    return new Date(eventTs.getTime() - (tiers.windowDays ?? 0) * DAY_MS);
  }
  return null;
}

/**
 * The partner's metric in this program before `event`: attributed events of
 * `eventType` with ts in [windowStart, event.ts), plus same-instant events
 * with a lower id so two events stamped the same millisecond still order
 * deterministically. Weighted by the touch's attribution weight, like the
 * commission itself. Clicks flagged as fraud don't count — a partner can't
 * climb a tier on traffic the program has rejected.
 */
async function tierMetric(
  db: Knex,
  metric: CommissionTiers['metric'],
  eventType: string,
  windowStart: Date | null,
  event: SlabEvent,
  ctx: { partnerId: string; programId: string },
  currency: string,
): Promise<number> {
  const eventTs = new Date(event.ts);
  const q = db(`${TABLES.Attribution} as a`)
    .join(`${TABLES.Event} as e`, 'e.id', 'a.eventId')
    .join(`${TABLES.Click} as c`, 'c.id', 'a.clickId')
    .where('a.partnerId', ctx.partnerId)
    .andWhere('a.programId', ctx.programId)
    .andWhere('e.type', eventType)
    .whereNull('c.fraudFlag')
    .andWhere((qb) =>
      qb.where('e.ts', '<', eventTs).orWhere((same) => same.where('e.ts', eventTs).andWhere('e.id', '<', event.id)),
    );
  if (windowStart) q.andWhere('e.ts', '>=', windowStart);
  if (metric === 'revenue') {
    // Revenue in other currencies can't be added to this one without FX.
    q.andWhereRaw(`upper(coalesce("e"."currency", 'USD')) = ?`, [currency]);
  }
  const row = (await q.first(
    db.raw(
      metric === 'revenue'
        ? 'coalesce(sum(coalesce("e"."value", 0) * "a"."weight"), 0) as total'
        : 'coalesce(sum("a"."weight"), 0) as total',
    ),
  )) as { total: string | number } | undefined;
  return Number(row?.total ?? 0);
}

/** Percent of the event's value, rounded to the cent, or the fixed amount.
 *  Same arithmetic as computeSubRuleAmount in attribution.ts. */
function rateAmount(type: 'percent' | 'fixed', value: number, eventValue: number): number {
  if (type === 'fixed') return value;
  return Math.round(eventValue * value) / 100;
}

/** A level table as stored, coerced and ordered. Validation already
 *  guarantees this shape for anything written through the API; an import
 *  bypasses it, and a malformed step must not take attribution down. */
function steps(levels: unknown, key: 'above' | 'atLeast'): Array<{ threshold: number; value: number }> {
  if (!Array.isArray(levels)) return [];
  return levels
    .map((l: Record<string, unknown> | null) => ({ threshold: Number(l?.[key]), value: Number(l?.value) }))
    .filter((l) => Number.isFinite(l.threshold) && l.threshold > 0 && Number.isFinite(l.value) && l.value >= 0)
    .sort((a, b) => a.threshold - b.threshold);
}

/** Weighted sums carry the weight column's 4 decimals into money. */
function roundMetric(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** `Commission.metadata` for one accrual. */
export function commissionMetadata(accrual: SubRuleAccrual, ruleIndex: number): Record<string, unknown> {
  return accrual.slab ? { slab: { ruleIndex, ...accrual.slab } } : {};
}

/** True when a stored rule array has any banded or tiered sub-rule. */
export function rulesHaveSlabs(rules: unknown): boolean {
  return (
    Array.isArray(rules) &&
    rules.some((r) => r != null && typeof r === 'object' && Boolean((r as CommissionSubRule).bands || (r as CommissionSubRule).tiers))
  );
}

/** True when any of these programs pays on a slab rule. */
export async function programsUseSlabs(db: Knex, programIds: string[]): Promise<boolean> {
  if (programIds.length === 0) return false;
  const programs = (await db(TABLES.Program).whereIn('id', programIds).select('commissionRule')) as Array<{
    commissionRule: unknown;
  }>;
  return programs.some((p) => rulesHaveSlabs(p.commissionRule));
}
