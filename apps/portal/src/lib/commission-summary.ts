/**
 * Renders a Campaign's commission rule + optional customer reward into a
 * single human-readable string for marketplace display.
 *
 * Examples:
 *   [{ trigger:'every', type:'percent', value:20, recurring:true }]
 *     → "20% recurring on every event"
 *   [{ trigger:'first', eventType:'subscription_created', type:'fixed', value:200 },
 *    { trigger:'every', eventType:'invoice_paid', type:'percent', value:20, recurring:true, recurringMonths:12 }]
 *     → "$200 on first sale + 20% recurring on every invoice for 12 months"
 *   …with customerReward { type:'percent_off', value:25, duration:'repeating', durationInMonths:6 }
 *     → "$200 on first sale + 20% recurring on every invoice for 12 months — customers get 25% off for 6 months"
 *
 * Rendering this from the rule (rather than an admin-typed freeform string)
 * is the anti-fraud guarantee: brands can't make claims the engine won't
 * actually pay out on. See the May 2026 offering refactor for context.
 */

export interface CommissionSubRuleLike {
  trigger: 'every' | 'first' | 'subsequent';
  eventType?: string;
  type: 'percent' | 'fixed';
  value: number;
  currency?: string;
  recurring?: boolean;
  recurringMonths?: number;
}

export interface CustomerRewardLike {
  type: 'percent_off' | 'amount_off' | 'free_months';
  value: number;
  currency?: string;
  duration: 'once' | 'forever' | 'repeating';
  durationInMonths?: number;
}

export function renderCommissionSummary(
  rules: CommissionSubRuleLike[] | null | undefined,
  customerReward: CustomerRewardLike | null | undefined = null,
): string {
  if (!rules || rules.length === 0) return '—';
  const partner = rules.map(formatSubRule).join(' + ');
  const customer = customerReward ? formatCustomerReward(customerReward) : null;
  return customer ? `${partner} — customers get ${customer}` : partner;
}

function formatSubRule(rule: CommissionSubRuleLike): string {
  const amount =
    rule.type === 'percent'
      ? `${trimNumber(rule.value)}%`
      : `$${trimNumber(rule.value)}${rule.currency && rule.currency !== 'USD' ? ` ${rule.currency}` : ''}`;
  const eventPhrase = formatEventPhrase(rule.trigger, rule.eventType);
  const recurringPhrase = rule.recurring
    ? rule.recurringMonths
      ? ` for ${rule.recurringMonths} months`
      : ''
    : '';
  const recurringPrefix = rule.recurring && rule.trigger !== 'first' ? ' recurring' : '';
  return `${amount}${recurringPrefix}${eventPhrase}${recurringPhrase}`;
}

function formatEventPhrase(
  trigger: 'every' | 'first' | 'subsequent',
  eventType: string | undefined,
): string {
  if (trigger === 'first') {
    return ` on first ${humanizeEventType(eventType ?? 'sale')}`;
  }
  if (trigger === 'subsequent') {
    return ` on every subsequent ${humanizeEventType(eventType ?? 'sale')}`;
  }
  if (!eventType) return ''; // every-event-no-filter — keep terse
  return ` on every ${humanizeEventType(eventType)}`;
}

function humanizeEventType(eventType: string): string {
  switch (eventType) {
    case 'subscription_created':
      return 'subscription';
    case 'invoice_paid':
      return 'invoice';
    case 'trial_started':
      return 'trial start';
    case 'signup':
      return 'signup';
    default:
      return eventType.replace(/_/g, ' ');
  }
}

export function formatCustomerReward(reward: CustomerRewardLike): string {
  const base = (() => {
    if (reward.type === 'percent_off') return `${trimNumber(reward.value)}% off`;
    if (reward.type === 'amount_off') {
      return `$${trimNumber(reward.value)}${reward.currency && reward.currency.toUpperCase() !== 'USD' ? ` ${reward.currency.toUpperCase()}` : ''} off`;
    }
    return `${trimNumber(reward.value)} ${reward.value === 1 ? 'month' : 'months'} free`;
  })();

  if (reward.type === 'free_months') return base;

  if (reward.duration === 'once') return `${base} on first invoice`;
  if (reward.duration === 'forever') return `${base} forever`;
  if (reward.duration === 'repeating' && reward.durationInMonths) {
    return `${base} for ${reward.durationInMonths} months`;
  }
  return base;
}

function trimNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2).replace(/\.?0+$/, '');
}
