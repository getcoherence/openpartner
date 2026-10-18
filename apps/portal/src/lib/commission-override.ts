import type { CommissionSubRule } from './CompoundRuleEditor.js';

/**
 * The rules in `replaced` that `next` leaves unpaid.
 *
 * A partner's override terms replace the rule set whole; the engine never
 * merges them with the program's (API: resolveCommissionRule). So a stage the
 * new terms don't name stops paying: a program paying $25 on `approved` and
 * $400 on `loan_funded`, overridden with only a `loan_funded` rule, pays this
 * partner nothing on `approved`. A rule with no eventType pays on every type,
 * so it covers any stage, and is itself covered only by another such rule.
 */
export function rulesLeftUnpaid(replaced: CommissionSubRule[], next: CommissionSubRule[]): CommissionSubRule[] {
  const nextTakesEverything = next.some((r) => !r.eventType);
  if (nextTakesEverything) return [];
  return replaced.filter((r) => !r.eventType || !next.some((n) => n.eventType === r.eventType));
}

/** The rule set every one of these programs shares, or null when they
 *  differ (or there are none): the honest starting point for a partner-wide
 *  override, which replaces all of them. */
export function sharedRules(ruleSets: CommissionSubRule[][]): CommissionSubRule[] | null {
  if (ruleSets.length === 0) return null;
  const first = JSON.stringify(ruleSets[0]);
  return ruleSets.every((r) => JSON.stringify(r) === first) ? ruleSets[0]! : null;
}
