/**
 * A performance bounty's goal in words, rendered from its structured fields
 * (docs/bounties.md §7). Partners, emails and any marketplace listing see
 * this, never free text, for the same reason commission-summary.ts exists:
 * a brand can't advertise a goal the sweep won't actually pay on. The
 * bounty's `description` is shown beside it, as the brand's own words.
 *
 *   { metric:'conversions', threshold:10, scope:'new', startsAt:Nov 1,
 *     endsAt:Dec 31, rewardAmount:500, currency:'USD' }
 *     → "Reach 10 new sales between Nov 1, 2026 and Dec 31, 2026 to earn $500."
 *   { metric:'revenue', eventType:'invoice_paid', threshold:5000, scope:'lifetime', endsAt:null, … }
 *     → "Reach $5,000 in invoice revenue to earn $250."
 *
 * Dates are UTC, like every other date boundary in the engine. Pure, so the
 * portal renders exactly what the API's emails say.
 */

export type BountyMetricLike = 'conversions' | 'revenue' | 'leads' | 'commissions';

export interface BountyLike {
  metric: BountyMetricLike;
  eventType?: string | null;
  threshold: number | string;
  scope: 'new' | 'lifetime';
  startsAt: Date | string;
  endsAt: Date | string | null;
  rewardAmount: number | string;
  currency: string;
}

/** True when the metric is an amount of money, measured in the bounty's
 *  currency; false when it counts conversions or leads. */
export function bountyMetricIsMoney(metric: BountyMetricLike): boolean {
  return metric === 'revenue' || metric === 'commissions';
}

/** An amount in a currency, e.g. "$500" or "€1,250.50". */
export function formatBountyAmount(amount: number | string, currency: string): string {
  const n = Number(amount);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${trimNumber(n)} ${currency.toUpperCase()}`;
  }
}

/** A partner's progress value in the metric's own unit: "7.5" or "$1,234.50". */
export function formatBountyValue(b: Pick<BountyLike, 'metric' | 'currency'>, value: number | string): string {
  return bountyMetricIsMoney(b.metric) ? formatBountyAmount(value, b.currency) : trimNumber(Number(value));
}

/** The goal alone, e.g. "10 new sales" or "$5,000 in invoice revenue". */
export function renderBountyGoal(b: BountyLike): string {
  const n = Number(b.threshold);
  const fresh = b.scope === 'new' ? 'new ' : '';
  switch (b.metric) {
    case 'leads':
      return `${trimNumber(n)} ${fresh}${n === 1 ? 'lead' : 'leads'}`;
    case 'conversions': {
      const noun = b.eventType ? humanizeEventType(b.eventType) : 'sale';
      return `${trimNumber(n)} ${fresh}${n === 1 ? noun : pluralize(noun)}`;
    }
    case 'revenue': {
      const what = b.eventType ? `${humanizeEventType(b.eventType)} revenue` : 'revenue';
      return `${formatBountyAmount(n, b.currency)} in ${fresh}${what}`;
    }
    case 'commissions':
      return `${formatBountyAmount(n, b.currency)} in ${fresh}commissions`;
  }
}

/** The whole goal as one sentence a partner can act on. */
export function renderBountySummary(b: BountyLike): string {
  const goal = renderBountyGoal(b);
  const when = (() => {
    const end = b.endsAt ? formatDate(b.endsAt) : null;
    if (b.scope === 'new') {
      return end ? ` between ${formatDate(b.startsAt)} and ${end}` : ` from ${formatDate(b.startsAt)} on`;
    }
    return end ? ` by ${end}` : '';
  })();
  return `Reach ${goal}${when} to earn ${formatBountyAmount(b.rewardAmount, b.currency)}.`;
}

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function humanizeEventType(eventType: string): string {
  switch (eventType) {
    case 'subscription_created':
      return 'subscription';
    case 'invoice_paid':
      return 'invoice';
    case 'trial_started':
      return 'trial start';
    default:
      return eventType.replace(/_/g, ' ');
  }
}

function pluralize(noun: string): string {
  if (/(s|x|ch|sh)$/.test(noun)) return `${noun}es`;
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  return `${noun}s`;
}

function trimNumber(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString('en-US');
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
