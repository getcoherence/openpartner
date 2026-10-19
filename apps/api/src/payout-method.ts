import type { PartnerRow, PayoutMethod, PayoutRailPreference } from '@openpartner/db';

/**
 * Which rail a partner's payout goes out on, from the tenant's rail
 * preference:
 *   auto            (legacy) stripe_connect if a Connect account exists, else manual
 *   stripe_connect  always stripe_connect — partners without a Connect
 *                   account get a 'failed' payout with a clear error
 *                   instead of silently being paid manually
 *   manual          force manual — operator handles all transfers off-platform
 *
 * Shared by the planner (payouts.ts) and the compliance-hold listing
 * (sanctions-screening.ts), which reports whether a hold stops a payout
 * or only warns about one the brand sends itself.
 */
export function resolvePayoutMethod(
  railPreference: PayoutRailPreference,
  partner: Pick<PartnerRow, 'stripeConnectAccountId'>,
): PayoutMethod {
  if (railPreference === 'manual') return 'manual';
  if (railPreference === 'stripe_connect') return 'stripe_connect';
  return partner.stripeConnectAccountId ? 'stripe_connect' : 'manual';
}
