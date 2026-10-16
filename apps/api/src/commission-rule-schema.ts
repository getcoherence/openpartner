/**
 * Cross-field checks every stored commission sub-rule must pass, wherever
 * it's written: a program's terms (routes/programs.ts) and a partner's
 * commission override (routes/partners.ts). Both store the same
 * CommissionSubRule[] array and the engine (attribution.ts
 * evaluateSubRule) reads them identically, so they must reject the same
 * shapes — a rule one route refuses must not get in through the other.
 */

import { z } from 'zod';

interface SubRuleShape {
  trigger: 'every' | 'first' | 'subsequent';
  eventType?: string;
  recurring?: boolean;
  recurringMonths?: number;
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
}
