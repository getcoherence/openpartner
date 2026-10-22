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
 *   [{ trigger:'every', eventType:'invoice_paid', type:'percent', value:10,
 *      bands:{ mode:'whole', levels:[{ above:50000, value:15 }] } }]
 *     → "10–15% on every invoice (slabs by invoice value)"
 *
 * A slab rule renders as the range between its lowest and highest step,
 * never as the top rate alone: a headline "15%" would promise every
 * partner a rate most of them won't reach.
 *
 * A fixed amount with no currency of its own pays in the event's currency,
 * which for a conversion sent without one is the brand's default — so it
 * renders in `defaultCurrency` (Tenant.defaultCurrency), not USD: an INR
 * brand's "100 per lead" reads "₹100", not "$100".
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
  bands?: { mode: 'whole' | 'marginal'; levels: Array<{ above: number; value: number }> };
  tiers?: {
    metric: 'revenue' | 'conversions';
    window: 'lifetime' | 'calendar_month' | 'rolling_days';
    windowDays?: number;
    eventType?: string;
    levels: Array<{ atLeast: number; value: number }>;
  };
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
  defaultCurrency = 'USD',
): string {
  if (!rules || rules.length === 0) return '—';
  const partner = rules.map((rule) => formatSubRule(rule, defaultCurrency)).join(' + ');
  const customer = customerReward ? formatCustomerReward(customerReward) : null;
  return customer ? `${partner} — customers get ${customer}` : partner;
}

function formatSubRule(rule: CommissionSubRuleLike, defaultCurrency: string): string {
  const amount = formatAmount(rule, defaultCurrency);
  const eventPhrase = formatEventPhrase(rule.trigger, rule.eventType);
  const recurringPhrase = rule.recurring
    ? rule.recurringMonths
      ? ` for ${rule.recurringMonths} months`
      : ''
    : '';
  const recurringPrefix = rule.recurring && rule.trigger !== 'first' ? ' recurring' : '';
  return `${amount}${recurringPrefix}${eventPhrase}${recurringPhrase}${formatSlabPhrase(rule)}`;
}

function formatAmount(rule: CommissionSubRuleLike, defaultCurrency: string): string {
  const levels = (rule.bands ?? rule.tiers)?.levels;
  const steps = [rule.value, ...(Array.isArray(levels) ? levels.map((l) => l.value) : [])];
  const lo = Math.min(...steps);
  const hi = Math.max(...steps);
  if (rule.type === 'percent') {
    return lo === hi ? `${trimNumber(lo)}%` : `${trimNumber(lo)}–${trimNumber(hi)}%`;
  }
  const currency = rule.currency || defaultCurrency;
  return lo === hi ? money(lo, currency) : `${money(lo, currency)}–${money(hi, currency)}`;
}

/** A fixed amount in its own currency: "$100", "₹100", "€99.50". Unknown
 *  codes fall back to "100 XYZ". (It used to be "$100 INR" for every
 *  non-USD rule.) */
function money(value: number, currency?: string): string {
  const code = (currency ?? 'USD').toUpperCase();
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code, minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${trimNumber(value)} ${code}`;
  }
}

function formatSlabPhrase(rule: CommissionSubRuleLike): string {
  if (rule.bands) {
    const noun = rule.eventType ? humanizeEventType(rule.eventType) : 'event';
    return ` (${rule.bands.mode === 'marginal' ? 'marginal ' : ''}slabs by ${noun} value)`;
  }
  if (rule.tiers) {
    const metric = rule.tiers.metric === 'conversions' ? 'conversions' : 'revenue';
    if (rule.tiers.window === 'lifetime') return ` (tiers by lifetime partner ${metric})`;
    if (rule.tiers.window === 'calendar_month') return ` (tiers by monthly partner ${metric})`;
    return ` (tiers by partner ${metric}, last ${rule.tiers.windowDays} days)`;
  }
  return '';
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
      return `${money(reward.value, reward.currency)} off`;
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
