/**
 * Cross-field checks every stored commission sub-rule must pass, wherever
 * it's written: a program's terms (routes/programs.ts) and a partner's
 * commission override (routes/partners.ts). Both store the same
 * CommissionSubRule[] array and the engine (attribution.ts
 * evaluateSubRule) reads them identically, so they must reject the same
 * shapes — a rule one route refuses must not get in through the other.
 */

import { z } from 'zod';

/** Steps per band / tier table. Ten covers every slab table we've seen
 *  asked for while keeping the editor (and the tier query) bounded. */
export const MAX_SLAB_LEVELS = 10;

function strictlyAscending<K extends string>(key: K) {
  return (levels: Array<Record<K, number>>, ctx: z.RefinementCtx) => {
    for (let i = 1; i < levels.length; i += 1) {
      if (levels[i]![key] <= levels[i - 1]![key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${key} thresholds must be strictly ascending`,
          path: [i, key],
        });
      }
    }
  };
}

/** Value bands — see CommissionBands in @openpartner/db. The sub-rule's own
 *  `value` is the base band, so `levels` lists only the steps above it. */
export const commissionBandsSchema = z.object({
  mode: z.enum(['whole', 'marginal']).default('whole'),
  levels: z
    .array(
      z.object({
        above: z.number().positive().finite(),
        value: z.number().nonnegative().finite(),
      }),
    )
    .min(1)
    .max(MAX_SLAB_LEVELS)
    .superRefine(strictlyAscending('above')),
});

/** Performance tiers — see CommissionTiers in @openpartner/db. */
export const commissionTiersSchema = z.object({
  metric: z.enum(['revenue', 'conversions']),
  window: z.enum(['lifetime', 'calendar_month', 'rolling_days']),
  /** Rolling window length. Ten years is far past any program's horizon
   *  and keeps the window start a valid timestamp. */
  windowDays: z.number().int().positive().max(3650).optional(),
  eventType: z.string().min(1).max(80).optional(),
  levels: z
    .array(
      z.object({
        atLeast: z.number().positive().finite(),
        value: z.number().nonnegative().finite(),
      }),
    )
    .min(1)
    .max(MAX_SLAB_LEVELS)
    .superRefine(strictlyAscending('atLeast')),
});

/** Spread into every sub-rule object schema. */
export const commissionSlabFields = {
  bands: commissionBandsSchema.optional(),
  tiers: commissionTiersSchema.optional(),
};

interface SubRuleShape {
  trigger: 'every' | 'first' | 'subsequent';
  eventType?: string;
  type: 'percent' | 'fixed';
  recurring?: boolean;
  recurringMonths?: number;
  bands?: z.infer<typeof commissionBandsSchema>;
  tiers?: z.infer<typeof commissionTiersSchema>;
}

export function refineCommissionSubRule(sub: SubRuleShape, ctx: z.RefinementCtx): void {
  // `first` and `subsequent` triggers need an eventType — "first/subsequent
  // sale of WHAT" is otherwise ambiguous. `every` without an eventType means
  // "every event with a value" (the legacy single-rule behavior). The
  // engine only filters on eventType when it's set, so a first-trigger
  // rule without one would fire on the first event of every type.
  if ((sub.trigger === 'first' || sub.trigger === 'subsequent') && !sub.eventType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${sub.trigger}-trigger sub-rules require an eventType`,
      path: ['eventType'],
    });
  }
  // recurringMonths only makes sense on recurring rules. Permit it to be
  // present on non-recurring rules but warn loudly via validation rather
  // than silently ignore.
  if (sub.recurringMonths != null && !sub.recurring) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'recurringMonths requires recurring: true',
      path: ['recurringMonths'],
    });
  }
  refineSlabs(sub, ctx);
}

function refineSlabs(sub: SubRuleShape, ctx: z.RefinementCtx): void {
  // One rate table per sub-rule. Bands keyed on the event and tiers keyed
  // on the partner's history would each pick a rate, and no precedence
  // between them is unsurprising. Brands that want both effects use two
  // sub-rules (which add up, as always).
  if (sub.bands && sub.tiers) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'a sub-rule takes bands or tiers, not both',
      path: ['tiers'],
    });
  }
  // Marginal bands split the event's value into slices — a fixed amount
  // has nothing to split.
  if (sub.bands?.mode === 'marginal' && sub.type !== 'percent') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'marginal bands need a percent rule',
      path: ['bands', 'mode'],
    });
  }
  // Steps are new, so they get the cap the top-level percent never had
  // (stored rules predate it; tightening that would 400 their next save).
  if (sub.type === 'percent') {
    for (const [field, table] of [['bands', sub.bands], ['tiers', sub.tiers]] as const) {
      table?.levels.forEach((level, i) => {
        if (level.value > 100) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'a percent rate cannot exceed 100',
            path: [field, 'levels', i, 'value'],
          });
        }
      });
    }
  }
  if (sub.tiers) {
    if (sub.tiers.window === 'rolling_days' && sub.tiers.windowDays == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'rolling_days tiers require windowDays',
        path: ['tiers', 'windowDays'],
      });
    }
    if (sub.tiers.window !== 'rolling_days' && sub.tiers.windowDays != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'windowDays only applies to rolling_days tiers',
        path: ['tiers', 'windowDays'],
      });
    }
    // The metric has to count something specific. "Every event" would
    // count signups as conversions and refunds' negative values as
    // revenue.
    if (!sub.tiers.eventType && !sub.eventType) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "tiers need an eventType to count — set tiers.eventType or the rule's eventType",
        path: ['tiers', 'eventType'],
      });
    }
  }
}
