/**
 * A brand's programs summarised for its Discover card: the in-app twin of
 * the marketing site's summarizeBrand (openpartner-marketing,
 * src/lib/offerings.ts). Programs with the same terms read exactly as one
 * program would; otherwise the commission is the range across them, so the
 * card never promises a rate only some programs pay.
 */
import {
  formatCustomerReward,
  formatPercent,
  renderCommissionSummary,
  trimNumber,
  type CommissionSubRuleLike,
  type CustomerRewardLike,
  type RecruiterShareLike,
} from '../../lib/commission-summary.js';

export interface SummaryTerms {
  commissionDescription?: string;
  commissionRules?: CommissionSubRuleLike[];
  recurring?: boolean;
  customerReward?: CustomerRewardLike | null;
  recruiterCommission?: RecruiterShareLike | null;
  attributionWindowDays?: number;
  categories?: string[];
}

/** The partner-side commission: derived from the rules, else the Network's
 *  stored text (offerings predating compound rules). */
export function commissionLineOf(terms: SummaryTerms): string | null {
  return terms.commissionRules
    ? renderCommissionSummary(terms.commissionRules, null)
    : (terms.commissionDescription ?? null);
}

/** "30" when every value is the same, else "10–30". */
function rangeOf(values: number[]): string | null {
  if (values.length === 0) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return min === max ? trimNumber(min) : `${trimNumber(min)}–${trimNumber(max)}`;
}

/** "$50" or "$10–50 EUR" across fixed rules; null when they mix currencies. */
function fixedRange(rules: CommissionSubRuleLike[]): string | null {
  const currencies = new Set(rules.map((r) => (r.currency ?? 'usd').toUpperCase()));
  if (rules.length === 0 || currencies.size > 1) return null;
  const cur = [...currencies][0];
  return `$${rangeOf(rules.map((r) => r.value))}${cur !== 'USD' ? ` ${cur}` : ''}`;
}

const isRecurring = (t: SummaryTerms) => (t.commissionRules ?? []).some((r) => r.recurring) || !!t.recurring;

export function brandCommissionLine(programs: SummaryTerms[]): string | null {
  const lines = programs.map(commissionLineOf);
  if (lines.every((l) => l === lines[0])) return lines[0] ?? null;
  const rules = programs.flatMap((t) => t.commissionRules ?? []);
  const percents = rules.filter((r) => r.type === 'percent').map((r) => r.value);
  const fixed = rules.filter((r) => r.type === 'fixed');
  const varies = programs.every(isRecurring) ? 'recurring, varies by program' : 'varies by program';
  if (percents.length > 0) {
    return fixed.length > 0
      ? `${rangeOf(percents)}% or ${fixedRange(fixed) ?? 'a flat fee'} flat on some programs`
      : `${rangeOf(percents)}% ${varies}`;
  }
  const flat = fixedRange(fixed);
  return flat ? `${flat} ${varies}` : 'Varies by program';
}

/** One value when every program agrees, else null. */
function shared<T>(values: T[]): T | null {
  return values.length > 0 && values.every((v) => v === values[0]) ? values[0]! : null;
}

/** What a brand's Discover card shows, across the programs it lists. */
export function summarizeBrandTerms(programs: SummaryTerms[]) {
  const rewards = programs.map((t) => (t.customerReward ? formatCustomerReward(t.customerReward) : null));
  const recruits = programs.map((t) => (t.recruiterCommission ? formatPercent(t.recruiterCommission.percent) : null));
  const sharedReward = shared(rewards);
  const sharedRecruits = shared(recruits);

  // The categories most of its programs share lead.
  const tally = new Map<string, number>();
  for (const t of programs) for (const c of t.categories ?? []) tally.set(c, (tally.get(c) ?? 0) + 1);
  const window = rangeOf(programs.map((t) => t.attributionWindowDays).filter((d): d is number => d != null));

  return {
    commissionLine: brandCommissionLine(programs),
    reward: sharedReward ? `Customers: ${sharedReward}` : rewards.some(Boolean) ? 'Audience discount' : null,
    recruits: sharedRecruits ? `Pays for recruits: ${sharedRecruits}` : recruits.some(Boolean) ? 'Pays for recruits' : null,
    categories: [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([slug]) => slug),
    window: window ? `${window}d window` : null,
  };
}
