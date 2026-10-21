import type { Knex } from 'knex';
import type { PartnerRow, PayoutMethod, PayoutRailPreference } from '@openpartner/db';
import { stripe, type OpenPartnerMode } from './stripe.js';
import { fundingEnabled } from './funding/state.js';
import { getFundingAuthorization } from './funding/reserve.js';

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

/**
 * Whether a Connect payout for a tenant in this billing mode has to go
 * through hosted funding (payouts.ts, "HOSTED CONNECT = FUNDED FLOW OR
 * NOTHING"). On self-host the platform account is the brand's own Stripe,
 * so a transfer spends the brand's money; on hosted it would spend the
 * platform's. The env var is the operator's deliberate override.
 */
export function connectNeedsFunding(mode: OpenPartnerMode): boolean {
  return mode !== 'selfhost' && process.env.OPENPARTNER_ALLOW_UNFUNDED_CONNECT_PAYOUTS !== '1';
}

/**
 * Whether this brand can pay partners through Stripe Connect at all, so
 * the partner portal only offers Connect where a connected account would
 * get paid. No when Stripe isn't configured or the brand pays manually;
 * on hosted, only once funding is on and the brand has authorized it.
 * Otherwise runPayouts refuses the transfer and the commissions sit
 * approved while the partner waits on a payout that never comes.
 */
export async function connectPayoutsAvailable(
  db: Knex,
  tenantId: string,
  railPreference: PayoutRailPreference,
  mode: OpenPartnerMode,
): Promise<boolean> {
  if (!stripe || railPreference === 'manual') return false;
  if (!connectNeedsFunding(mode)) return true;
  return fundingEnabled() && (await getFundingAuthorization(db, tenantId)) !== null;
}
