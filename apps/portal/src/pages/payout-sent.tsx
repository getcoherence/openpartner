import { theme } from '../theme.js';
import { money } from '../ui.js';

/**
 * A payout PayPal can't send in its own currency (INR), sent through Pay
 * with PayPal in USD at the ECB rate frozen when the batch was made
 * (docs/paypal-payouts.md "Balances PayPal can't send"). The payout's own
 * amount and currency don't change; this is what PayPal was asked to send.
 */
export interface PayoutSent {
  amount: string;
  currency: string;
  rate: string;
  rateSource: 'ecb';
  rateDate: string;
}

/** "22 Oct", or "22 Oct 2025" outside this year. ECB dates are calendar
 *  days: formatted in UTC so no time zone moves them. */
export function rateDateLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  const sameYear = d.getUTCFullYear() === new Date().getUTCFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
}

/** "1 INR = 0.011958866935 USD", every digit the amounts were computed
 *  from (`exact`), or "1 INR ≈ 0.011959 USD" where it's only a label. */
export function rateLabel(rate: string, from: string, to: string, opts: { exact?: boolean } = {}): string {
  return opts.exact ? `1 ${from} = ${rate} ${to}` : `1 ${from} ≈ ${Number(Number(rate).toPrecision(5))} ${to}`;
}

/** Whose the later conversion is, said wherever a converted amount is
 *  shown: to the partner, or to the brand about its partners. */
export function withdrawalNote(sentCurrency: string, ownCurrency: string, to: 'partner' | 'brand'): string {
  return to === 'partner'
    ? `PayPal paid you in ${sentCurrency}, converted at the European Central Bank reference rate shown. PayPal converts it to ${ownCurrency} for your bank at its own rate; that conversion is between you and PayPal.`
    : `Partners receive ${sentCurrency}, converted at the European Central Bank reference rate. PayPal converts it to ${ownCurrency} for their bank at its own rate; that conversion is between them and PayPal.`;
}

/** "sent as $17.99 at the ECB rate of 22 Oct", under a payout's amount. */
export function SentAs({ sent, pending }: { sent: PayoutSent; pending?: boolean }) {
  return (
    <div style={{ fontSize: 12, color: theme.textMuted, fontWeight: 400 }} title={`ECB reference rate: ${sent.rate}`}>
      {pending ? 'sending as' : 'sent as'} {money(sent.amount, sent.currency)} at the ECB rate of {rateDateLabel(sent.rateDate)}
    </div>
  );
}
