/**
 * White-label entitlement.
 *
 * `Tenant.whiteLabel` is the *provisioned* flag (flipped on by the hosted
 * billing add-on). The *effective* entitlement — what the portal keys all
 * branding removal and Network-hiding on, and what the custom-domain cert
 * gate will key on in Phase 1 — additionally requires that the tenant is
 * actually entitled right now:
 *
 *   - self-host: always (a single-tenant install they own is their brand);
 *   - hosted: an enterprise (sales-led) plan, OR an active Stripe
 *     subscription, OR an in-flight trial.
 *
 * The billing gate matters because `whiteLabel` is set at signup *during*
 * the unpaid trial. A trial that lapses without ever subscribing never
 * fires `customer.subscription.deleted`, so a bare-boolean check would keep
 * white-label live for free indefinitely. Requiring effective billing state
 * closes that.
 */

import type { Knex } from 'knex';
import { TABLES, type TenantRow } from '@openpartner/db';
import { getTenantBillingState, type TenantBillingState } from './billing-plan.js';

export function isWhiteLabelEntitled(
  tenant: Pick<TenantRow, 'whiteLabel' | 'status'>,
  billing: TenantBillingState,
): boolean {
  if (!tenant.whiteLabel) return false;
  if (tenant.status !== 'active') return false;
  // Self-host: single-tenant install the operator owns; rebranding is
  // always theirs, no billing relationship to gate on.
  if (billing.mode === 'selfhost') return true;
  // Hosted: must actually be paying (or mid-trial, or enterprise).
  return billing.plan === 'enterprise' || !!billing.stripeSubscriptionId || billing.inTrial;
}

export interface WhiteLabelState {
  /** The provisioned flag — the add-on is turned on for this tenant. */
  provisioned: boolean;
  /** Effective entitlement — provisioned AND on an entitling billing
   *  state. Branding removal + Network-hiding key on this. */
  effective: boolean;
}

export async function getWhiteLabelState(db: Knex, tenantId: string): Promise<WhiteLabelState> {
  const tenant = await db<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId })
    .first(['whiteLabel', 'status']);
  if (!tenant) return { provisioned: false, effective: false };
  const billing = await getTenantBillingState(db, tenantId);
  return {
    provisioned: !!tenant.whiteLabel,
    effective: isWhiteLabelEntitled(
      { whiteLabel: !!tenant.whiteLabel, status: tenant.status },
      billing,
    ),
  };
}
