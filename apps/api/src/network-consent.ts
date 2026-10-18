/**
 * Partner consent to the OpenPartner Network.
 *
 * A partner's name and email reach the Network only if BOTH hold:
 *
 *   1. the brand offers the Network to its partners — membership enabled,
 *      the `autoEnroll` toggle on (stored name; it now means "offer"), not
 *      white-label, and (self-host) the Network not hidden from partners;
 *   2. the partner opted in: a PartnerNetworkConsent row with status
 *      'granted'.
 *
 * Every push path goes through syncPartnerToNetwork (single partner) or
 * resyncConsentedPartners (the admin re-sync), and the outbox drain
 * re-checks consent before sending, so a push queued before a withdrawal
 * never lands after it. Withdrawing sends an unlink and nothing else.
 *
 * Partners are asked on the join page (optional checkbox), once on first
 * portal login, and can change it any time in the portal. A brand can't
 * consent for them: the write endpoint takes partner sessions only.
 */

import type { Knex } from 'knex';
import {
  TABLES,
  type NetworkConsentSource,
  type PartnerApplication,
  type PartnerNetworkConsentRow,
  type PartnerRow,
} from '@openpartner/db';
import type { ApiKeyPrincipal } from './auth.js';
import {
  backfillPartners,
  getNetworkMembership,
  pushPartnerRevoke,
  pushPartnerUnlink,
  pushPartnerUpsert,
  type BackfillPartnersResult,
  type PartnerUpsertPayload,
} from './network-client.js';
import { getTenancyMode } from './tenancy.js';
import { NETWORK_ORIGIN_SOURCE } from './usage-billing.js';
import { getWhiteLabelState } from './white-label.js';

/**
 * Whether this brand offers the Network to its partners at all. Off means
 * partners are never asked (no checkbox, prompt or setting) and never
 * pushed, whatever consent rows exist.
 */
export async function isNetworkOfferedToPartners(db: Knex, tenantId: string): Promise<boolean> {
  const m = await getNetworkMembership(db, tenantId);
  if (!m?.enabled || !m.autoEnroll) return false;
  if ((await getWhiteLabelState(db, tenantId)).effective) return false;
  return isNetworkVisibleToPartners(db, tenantId);
}

/** Mirrors ProgramSettings.partnerNetworkVisible (routes/settings.ts): only
 *  a single-tenant self-host can hide the Network from its partners. */
async function isNetworkVisibleToPartners(db: Knex, tenantId: string): Promise<boolean> {
  if (getTenancyMode() !== 'single') return true;
  const row = await db(TABLES.Config).where({ tenantId, key: 'program_settings' }).first();
  return (row?.value as { partnerNetworkVisible?: boolean } | undefined)?.partnerNetworkVisible ?? true;
}

export async function getNetworkConsent(db: Knex, partnerId: string): Promise<PartnerNetworkConsentRow | null> {
  return (await db<PartnerNetworkConsentRow>(TABLES.PartnerNetworkConsent).where({ partnerId }).first()) ?? null;
}

export async function hasNetworkConsent(db: Knex, partnerId: string): Promise<boolean> {
  return (await getNetworkConsent(db, partnerId))?.status === 'granted';
}

/**
 * Record an opt-in. A partner who is already opted in keeps their original
 * record — how and when they first consented is what an audit asks for.
 * Returns false in that case.
 */
export async function grantNetworkConsent(
  db: Knex,
  tenantId: string,
  partnerId: string,
  source: NetworkConsentSource,
): Promise<boolean> {
  const current = await getNetworkConsent(db, partnerId);
  if (current?.status === 'granted') return false;
  const now = new Date();
  await db(TABLES.PartnerNetworkConsent)
    .insert({ partnerId, tenantId, status: 'granted', source, consentedAt: now, withdrawnAt: null, updatedAt: now })
    .onConflict('partnerId')
    .merge({ status: 'granted', source, consentedAt: now, withdrawnAt: null, updatedAt: now });
  return true;
}

/** "No thanks" on the first-login prompt. Only for a partner who hasn't
 *  decided yet; returns false otherwise. */
export async function declineNetworkConsent(db: Knex, tenantId: string, partnerId: string): Promise<boolean> {
  const now = new Date();
  const inserted = await db(TABLES.PartnerNetworkConsent)
    .insert({ partnerId, tenantId, status: 'declined', source: null, declinedAt: now, updatedAt: now })
    .onConflict('partnerId')
    .ignore()
    .returning('partnerId');
  return inserted.length > 0;
}

/** Turn an opt-in off. Returns false if the partner wasn't opted in. */
export async function withdrawNetworkConsent(db: Knex, partnerId: string): Promise<boolean> {
  const now = new Date();
  const updated = await db(TABLES.PartnerNetworkConsent)
    .where({ partnerId, status: 'granted' })
    .update({ status: 'withdrawn', withdrawnAt: now, updatedAt: now });
  return updated > 0;
}

/**
 * A Network-originated partner: POST /partners from the Network's
 * partnership-approve federation. They joined by applying on the Network,
 * so they are already members and count as consented ('network_offering').
 *
 * Partner.metadata.source alone isn't proof — an admin could set it. The
 * call must also come in on the scoped key this brand registered with the
 * Network (membership.scopedKeyId).
 */
export async function isNetworkFederationCall(
  db: Knex,
  tenantId: string,
  principal: ApiKeyPrincipal | undefined,
  metadata: Record<string, unknown> | undefined,
): Promise<boolean> {
  if (metadata?.source !== NETWORK_ORIGIN_SOURCE) return false;
  if (!principal || principal.source !== 'db') return false;
  const m = await getNetworkMembership(db, tenantId);
  return !!m?.scopedKeyId && m.scopedKeyId === principal.apiKeyId;
}

/**
 * What a push sends: identity, status, and the profile answers the partner
 * gave on the join page. Partner.metadata is NOT sent — it's the brand's
 * own data about the partner (an admin's CRM ids, a headless integration's
 * customer fields), not something the partner agreed to share.
 */
function upsertPayloadFor(
  partner: PartnerRow,
  opts: { profile?: Record<string, unknown> } = {},
): PartnerUpsertPayload {
  const metadata = (partner.metadata ?? {}) as { application?: PartnerApplication };
  const application = metadata.application;
  return {
    vendorPartnerId: partner.id,
    email: partner.email,
    name: partner.name,
    ...(opts.profile ? { profile: opts.profile } : {}),
    joinedVendorAt: new Date(partner.createdAt).toISOString(),
    status: partner.revokedAt ? 'revoked' : partner.activatedAt ? 'active' : 'pending',
    metadata: { source: application ? 'self_signup' : 'admin_invite' },
    // Fills blanks in the creator's Network profile. The pitch stays with
    // this brand: it was written for this program.
    ...(application
      ? {
          creatorProfile: {
            websiteUrl: application.websiteUrl,
            socialUrls: application.socialUrls,
            audienceSize: application.audienceSize,
          },
        }
      : {}),
  };
}

/** Stamp the Network identity back on the Partner (the admin UI's "already
 *  on the Network" marker). Not consent and not billing — see
 *  usage-billing.ts NETWORK_ORIGIN_SOURCE for what the Network fee keys on. */
async function stampNetworkSync(
  db: Knex,
  partnerId: string,
  result: { networkCreatorId: string; alreadyExisted: boolean; affiliations: unknown[] },
): Promise<void> {
  await db<PartnerRow>(TABLES.Partner)
    .where({ id: partnerId })
    .update({
      metadata: db.raw(`jsonb_set(coalesce("metadata", '{}'::jsonb), '{network}', ?::jsonb, true)`, [
        JSON.stringify({
          creatorId: result.networkCreatorId,
          preExisting: result.alreadyExisted,
          affiliations: result.affiliations.length,
          syncedAt: new Date().toISOString(),
        }),
      ]),
      updatedAt: new Date(),
    });
}

export type NetworkSyncOutcome = 'pushed' | 'queued' | 'not_offered' | 'no_consent';

/**
 * Push one partner to the Network if — and only if — the brand offers it
 * and the partner opted in. Fire-and-forget like every Network push: a
 * Network outage queues the call in NetworkOutbox ('queued').
 */
export async function syncPartnerToNetwork(
  db: Knex,
  tenantId: string,
  partner: PartnerRow,
  opts: { profile?: Record<string, unknown> } = {},
): Promise<NetworkSyncOutcome> {
  if (!(await isNetworkOfferedToPartners(db, tenantId))) return 'not_offered';
  if (!(await hasNetworkConsent(db, partner.id))) return 'no_consent';
  const result = await pushPartnerUpsert(db, tenantId, upsertPayloadFor(partner, opts));
  if (!result) return 'queued';
  await stampNetworkSync(db, partner.id, result);
  return 'pushed';
}

/**
 * Mirror a brand-side revoke — only for a partner the Network has with
 * consent. Not gated on the offer toggle: a brand that stopped offering
 * the Network still shouldn't leave a revoked partner listed as active.
 */
export async function syncPartnerRevokeToNetwork(db: Knex, tenantId: string, partner: PartnerRow): Promise<boolean> {
  const m = await getNetworkMembership(db, tenantId);
  if (!m?.enabled) return false;
  if (!(await hasNetworkConsent(db, partner.id))) return false;
  await pushPartnerRevoke(db, tenantId, partner);
  return true;
}

/**
 * The partner said no (withdrew, or declined the prompt). Drop any push
 * still queued for them and ask the Network to remove the affiliation.
 * The unlink carries no personal data, so it's sent even for a partner
 * the Network may never have received — a push that only landed through
 * the outbox retry left no local trace.
 */
export async function removePartnerFromNetwork(
  db: Knex,
  tenantId: string,
  partnerId: string,
  reason: 'consent_withdrawn' | 'consent_declined',
): Promise<void> {
  await db(TABLES.NetworkOutbox)
    .where({ tenantId, status: 'pending' })
    .whereIn('op', ['partner_upsert', 'backfill_partner', 'partner_revoke'])
    .whereRaw(`"payload"->>'vendorPartnerId' = ?`, [partnerId])
    .del();
  await pushPartnerUnlink(db, tenantId, partnerId, reason);
}

/**
 * Admin "Re-sync opted-in partners" (POST /config/network/backfill): push
 * every consented partner again. Partners who never opted in are not
 * touched — this used to push the whole roster.
 */
export async function resyncConsentedPartners(db: Knex, tenantId: string): Promise<BackfillPartnersResult> {
  const partners = (await db(TABLES.Partner)
    .join(TABLES.PartnerNetworkConsent, `${TABLES.PartnerNetworkConsent}.partnerId`, `${TABLES.Partner}.id`)
    .where(`${TABLES.Partner}.tenantId`, tenantId)
    .where(`${TABLES.PartnerNetworkConsent}.status`, 'granted')
    .select(
      `${TABLES.Partner}.id`,
      `${TABLES.Partner}.email`,
      `${TABLES.Partner}.name`,
      `${TABLES.Partner}.createdAt`,
      `${TABLES.Partner}.activatedAt`,
      `${TABLES.Partner}.revokedAt`,
    )) as Array<{ id: string; email: string; name: string; createdAt: Date; activatedAt: Date | null; revokedAt: Date | null }>;
  return backfillPartners(db, tenantId, partners);
}

export interface NetworkConsentSummary {
  partners: number;
  granted: number;
  withdrawn: number;
  declined: number;
}

/** Counts for the admin Network page. Non-revoked partners only. */
export async function summarizeNetworkConsent(db: Knex, tenantId: string): Promise<NetworkConsentSummary> {
  const rows = (await db(TABLES.Partner)
    .leftJoin(TABLES.PartnerNetworkConsent, `${TABLES.PartnerNetworkConsent}.partnerId`, `${TABLES.Partner}.id`)
    .where(`${TABLES.Partner}.tenantId`, tenantId)
    .whereNull(`${TABLES.Partner}.revokedAt`)
    .groupBy(`${TABLES.PartnerNetworkConsent}.status`)
    .select(`${TABLES.PartnerNetworkConsent}.status as status`)
    .count<Array<{ status: string | null; count: string }>>({ count: '*' })) as Array<{ status: string | null; count: string }>;
  const by = (s: string) => Number(rows.find((r) => r.status === s)?.count ?? 0);
  return {
    partners: rows.reduce((n, r) => n + Number(r.count), 0),
    granted: by('granted'),
    withdrawn: by('withdrawn'),
    declined: by('declined'),
  };
}
