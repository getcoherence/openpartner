/**
 * The storefront booking fee a brand pays, in basis points
 * (openpartner-network docs/creator-storefront.md §8.5).
 *
 * Bookings are paid upfront on the Network: Stripe Checkout on the
 * creator's own account, with OpenPartner's fee on top as the application
 * fee. The rate is the commission rate of the brand's plan, the same one a
 * bonus is billed at (fee-terms.ts): 10% on Revshare, 5% on Flex, contract
 * overrides honoured. A brand with no paid plan yet (one created from a
 * public booking request, or still on its trial) pays the Revshare rate,
 * since Revshare is the plan with no monthly fee.
 *
 * Sent with every booking call to the Network, which trusts it from hosted
 * instances only. Null on self-host, which meters nothing; the Network
 * then uses its own rate for self-hosted vendors.
 */

import type { Knex } from 'knex';
import { db as platformDb } from './db.js';
import { getTenantBillingState, hasActivePlan } from './billing-plan.js';
import { getFeeTermsRow, ratesFor } from './fee-terms.js';
import { getFeeRuleSettings } from './platform-settings.js';

/** The Network refuses more than this from an instance. */
export const MAX_BOOKING_FEE_BPS = 3000;

export async function bookingFeeBpsFor(db: Knex, tenantId: string): Promise<number | null> {
  const state = await getTenantBillingState(db, tenantId);
  if (state.mode === 'selfhost') return null;
  const mode = state.mode === 'flat' && hasActivePlan(state) ? 'flat' : 'revshare';
  const settings = await getFeeRuleSettings(platformDb);
  const { commissionRate } = ratesFor(mode, settings, await getFeeTermsRow(db, tenantId));
  const bps = Math.round(commissionRate * 10_000);
  return Math.min(Math.max(bps, 0), MAX_BOOKING_FEE_BPS);
}
