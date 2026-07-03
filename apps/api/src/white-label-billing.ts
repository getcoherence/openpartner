/**
 * White-label add-on billing (spec §8.2).
 *
 * The add-on is a monthly recurring Stripe price
 * (STRIPE_WHITELABEL_ADD_ON_PRICE_ID) attached as a line item to the
 * tenant's existing plan subscription. For hosted flex/revshare tenants the
 * subscription is the source of truth: `Tenant.whiteLabel` mirrors whether
 * the add-on price is present on the sub, kept in sync by the billing
 * endpoints (optimistically) and the Stripe webhook (authoritatively).
 * Enterprise is sales-led — the flag is set directly, no Stripe item, and
 * no webhook ever clears it (enterprise tenants carry no subscription).
 */

import type { Knex } from 'knex';
import { TABLES, type TenantRow } from '@openpartner/db';

export function whiteLabelPriceId(): string | null {
  return process.env.STRIPE_WHITELABEL_ADD_ON_PRICE_ID || null;
}

export function subscriptionHasWhiteLabel(priceIds: string[]): boolean {
  const price = whiteLabelPriceId();
  return !!price && priceIds.includes(price);
}

/**
 * Mirror the subscription's add-on state onto Tenant.whiteLabel. On the
 * enabled → disabled transition, also revoke custom-domain routing (clear
 * Tenant.customDomain + remove the domain from the DO app) so cancelling
 * the add-on actually turns the white-label edge off — not just the
 * branding. Idempotent; returns what happened for webhook logging.
 *
 * Only meaningful for subscription-carrying tenants: callers on webhook
 * paths are inherently scoped to them (the event's customer maps to the
 * tenant), and enterprise/selfhost never receive subscription events.
 */
export async function applyWhiteLabelFromSubscription(
  db: Knex,
  tenantId: string,
  present: boolean,
): Promise<'enabled' | 'disabled' | 'unchanged'> {
  const tenant = await db<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId })
    .first(['whiteLabel', 'customDomain', 'slug']);
  if (!tenant || !!tenant.whiteLabel === present) return 'unchanged';

  await db<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId })
    .update({ whiteLabel: present, updatedAt: new Date() });

  if (!present) {
    const { revokeTenantCustomDomainRouting } = await import('./portal-domains.js');
    await revokeTenantCustomDomainRouting(
      db,
      tenantId,
      `white-label add-on removed from Stripe subscription (tenant ${tenant.slug})`,
    );
    return 'disabled';
  }
  return 'enabled';
}
