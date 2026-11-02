/**
 * "Is this brand actually set up?" — the checklist behind brand setup
 * reminders, the ops console's per-brand setup line, and the dashboard's
 * tracking step.
 *
 * Only the steps that decide whether a brand can earn anything through
 * OpenPartner, from LOCAL signals (no Network round trip, so a sweep over
 * every brand stays cheap and an outage can't skew it):
 *
 *   program   — at least one program exists
 *   listing   — a program is shared to the marketplace (on-Network,
 *               non-white-label brands only; a white-label brand is
 *               isolated from the marketplace by design, and a brand that
 *               said "Not now" to the Network listing isn't asked again —
 *               onboarding-settings.ts)
 *   tracking  — verified (tracking-verification.ts): a test click reached
 *               identify, or a partner click is linked to a customer
 *               (an Identity, which a coupon redemption writes too). Clicks
 *               alone prove nothing — the router records those without the
 *               brand integrating at all — and neither does an event that
 *               no click led to.
 *   partners  — at least one partner on the roster (approved brands only;
 *               a pending brand can't invite yet, so nagging is pointless)
 *
 * Batched over tenant ids with explicit tenantId filters, so the same code
 * serves the privileged cross-tenant sweep and a tenant-scoped (RLS)
 * request handler.
 */

import type { Knex } from 'knex';
import { TABLES, type TenantRow } from '@openpartner/db';
import { ONBOARDING_CONFIG_KEY } from './onboarding-settings.js';
import { trackingVerifiedFor } from './tracking-verification.js';

export type SetupStepKey = 'program' | 'listing' | 'tracking' | 'partners';

export interface SetupStep {
  key: SetupStepKey;
  label: string;
  done: boolean;
}

export interface BrandSetup {
  tenantId: string;
  steps: SetupStep[];
  complete: boolean;
  /** Labels of the steps still to do, in order. */
  missing: string[];
}

export const SETUP_STEP_LABELS: Record<SetupStepKey, string> = {
  program: 'Create your first program',
  listing: 'List your program on the OpenPartner marketplace',
  tracking: 'Install tracking and send a test click so partners get credited',
  partners: 'Invite your first partner',
};

export async function brandSetupFor(db: Knex, tenantIds: string[]): Promise<Map<string, BrandSetup>> {
  const out = new Map<string, BrandSetup>();
  if (tenantIds.length === 0) return out;

  const tenants = (await db<TenantRow>(TABLES.Tenant)
    .whereIn('id', tenantIds)
    .select('id', 'approvalStatus', 'whiteLabel', 'couponIntegrationVerifiedAt')) as Array<
    Pick<TenantRow, 'id' | 'approvalStatus' | 'whiteLabel' | 'couponIntegrationVerifiedAt'>
  >;

  const programs = (await db(TABLES.Program)
    .whereIn('tenantId', tenantIds)
    .groupBy('tenantId')
    .select('tenantId')
    .count({ total: '*' })
    .count({
      listed: db.raw(
        `case when "shareOnNetwork" and "networkOfferingId" is not null and "blockedAt" is null then 1 end`,
      ),
    })) as Array<{ tenantId: string; total: string | number; listed: string | number }>;
  const programsBy = new Map(programs.map((r) => [r.tenantId, r]));

  const partners = (await db(TABLES.Partner)
    .whereIn('tenantId', tenantIds)
    .whereNull('revokedAt')
    .groupBy('tenantId')
    .select('tenantId')
    .count({ total: '*' })) as Array<{ tenantId: string; total: string | number }>;
  const partnersBy = new Map(partners.map((r) => [r.tenantId, Number(r.total)]));

  const trackedSet = await trackingVerifiedFor(db, tenantIds);

  const memberships = (await db(TABLES.Config)
    .whereIn('tenantId', tenantIds)
    .andWhere({ key: 'network_membership' })
    .select('tenantId', 'value')) as Array<{ tenantId: string; value: { enabled?: boolean } | null }>;
  const onNetwork = new Set(memberships.filter((m) => m.value?.enabled).map((m) => m.tenantId));

  const onboarding = (await db(TABLES.Config)
    .whereIn('tenantId', tenantIds)
    .andWhere({ key: ONBOARDING_CONFIG_KEY })
    .select('tenantId', 'value')) as Array<{ tenantId: string; value: { networkListingSkipped?: boolean } | null }>;
  const listingSkipped = new Set(
    onboarding.filter((o) => o.value?.networkListingSkipped === true).map((o) => o.tenantId),
  );

  for (const t of tenants) {
    const p = programsBy.get(t.id);
    const steps: SetupStep[] = [
      { key: 'program', label: SETUP_STEP_LABELS.program, done: Number(p?.total ?? 0) > 0 },
    ];
    if (onNetwork.has(t.id) && !t.whiteLabel && !listingSkipped.has(t.id)) {
      steps.push({ key: 'listing', label: SETUP_STEP_LABELS.listing, done: Number(p?.listed ?? 0) > 0 });
    }
    steps.push({
      key: 'tracking',
      label: SETUP_STEP_LABELS.tracking,
      done: trackedSet.has(t.id) || t.couponIntegrationVerifiedAt != null,
    });
    if (t.approvalStatus === 'approved') {
      steps.push({ key: 'partners', label: SETUP_STEP_LABELS.partners, done: (partnersBy.get(t.id) ?? 0) > 0 });
    }
    const missing = steps.filter((s) => !s.done).map((s) => s.label);
    out.set(t.id, { tenantId: t.id, steps, complete: missing.length === 0, missing });
  }
  return out;
}
