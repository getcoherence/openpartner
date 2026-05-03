import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type ApiKeyRow, type PartnerRow, type SessionRow } from '@openpartner/db';
import { grantScope, requireAdmin, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { issueMagicLink } from '../auth-sessions.js';
import { getMailer } from '../mailer.js';
import { buildMagicLinkUrl, partnerInviteEmail, partnerRevokedEmail } from '../email-templates.js';
import { tenantOf } from '../tenancy.js';
import { getNetworkMembership, pushPartnerRevoke, pushPartnerUpsert } from '../network-client.js';
import { autoMintCouponsForGrants } from './coupons.js';
import { dispatchEvent } from '../webhook-dispatcher.js';

const createSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  // Admin can opt out of the invite email (e.g. federation creating a
  // Partner row on behalf of an external creator network). Default is
  // "invite them" since that's the intent of the admin UI.
  sendInvite: z.boolean().optional(),
  /** Programs (campaigns) this partner can create share-links for.
   *  Omitted = grant access to ALL current campaigns (preserves the
   *  pre-PartnerCampaign behavior). Empty array = grant nothing
   *  (rare; admin can add later). */
  campaignIds: z.array(z.string()).optional(),
  /** Where the grants come from. 'offering' is what the Network
   *  federation sends so we can tell admin assignments apart from
   *  Network-driven ones in the audit log + UI. */
  campaignGrantSource: z.enum(['admin', 'offering']).optional(),
  /** Snapshot of the offering's commission terms at approval time.
   *  Sent by the Network federation when provisioning a Partner from
   *  an approved PartnershipRequest. Persisted as a PartnerCommission
   *  row so future commission accruals use these values instead of
   *  the live Campaign rule — preserves the rate the partner was
   *  approved under even if the brand later edits the Campaign.
   *  All fields individually optional; partial snapshots are fine. */
  commissionSnapshot: z
    .object({
      commissionType: z.enum(['percent', 'fixed']).optional(),
      commissionValue: z.number().nonnegative().optional(),
      recurring: z.boolean().optional(),
      holdbackDays: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

export const partnersRouter = Router();

/**
 * Create a partner and, by default, send them an invite magic link. The
 * partner starts with `activatedAt = null`; when they click the link,
 * verify flips that to now() and issues a session. Admin never sees a
 * partner-facing credential.
 */
partnersRouter.post('/partners', requireAuth, grantScope('partners:write'), requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = createSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const sendInvite = body.data.sendInvite !== false;
  const email = body.data.email.toLowerCase();
  const id = ulid();

  // Duplicate-email pre-check — we'd rather 409 with a clean error than
  // let Postgres throw a unique-constraint violation that would surface
  // to the admin as a generic 500. Race between the check + insert is
  // caught below via the unique-violation path.
  const existing = await db<PartnerRow>(TABLES.Partner).where({ email }).first();
  if (existing) return res.status(409).json({ error: 'email_taken' });

  let partner;
  try {
    [partner] = await db<PartnerRow>(TABLES.Partner)
      .insert({
        id,
        tenantId,
        email,
        name: body.data.name,
        metadata: body.data.metadata ?? {},
        // sendInvite=false means the caller is responsible for activating
        // (federation client, admin seeding, etc); skip the pending state.
        activatedAt: sendInvite ? null : new Date(),
      })
      .returning('*');
  } catch (err) {
    // Race: two concurrent POSTs with the same email both pass the
    // pre-check and try to insert. The second one hits the unique
    // constraint on Partner.email.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'email_taken' });
    }
    throw err;
  }

  // Grant program (campaign) access. Default = all current campaigns
  // when caller didn't specify, matching the pre-PartnerCampaign
  // behavior so existing flows don't change shape.
  let campaignIds: string[];
  if (body.data.campaignIds) {
    // Explicit list — validate that each ID exists in this tenant.
    // Without this, a stale ID (e.g. Network Offering still references
    // a Campaign deleted on the vendor side) hits the FK constraint
    // and surfaces to the caller as an opaque 500. Federation flows
    // need a clean error message back instead.
    const existing = (await db(TABLES.Campaign)
      .whereIn('id', body.data.campaignIds)
      .select('id')) as Array<{ id: string }>;
    const existingIds = new Set(existing.map((c) => c.id));
    const missing = body.data.campaignIds.filter((cid) => !existingIds.has(cid));
    if (missing.length > 0) {
      return res.status(400).json({ error: 'unknown_campaign_ids', missing });
    }
    campaignIds = body.data.campaignIds;
  } else {
    campaignIds = ((await db(TABLES.Campaign).select('id')) as Array<{ id: string }>).map((c) => c.id);
  }
  if (campaignIds.length > 0) {
    const grantSource = body.data.campaignGrantSource ?? 'admin';
    await db(TABLES.PartnerCampaign)
      .insert(
        campaignIds.map((cid) => ({
          id: `pc_${ulid()}`,
          tenantId,
          partnerId: id,
          campaignId: cid,
          source: grantSource,
        })),
      )
      .onConflict(['tenantId', 'partnerId', 'campaignId'])
      .ignore();
    // Auto-mint a default coupon per granted campaign so creators have
    // both attribution paths (link + code) available without admin
    // explicit action. ON CONFLICT IGNORE inside the helper means
    // re-grants don't error.
    await autoMintCouponsForGrants(db, tenantId, { id, email }, campaignIds);
  }

  // Persist the commission snapshot if the federation push carried one.
  // Only writes when both type + value are present — a partial snapshot
  // would silently mis-price commissions, so we'd rather fall back to
  // the live Campaign rule than guess.
  const snap = body.data.commissionSnapshot;
  if (snap?.commissionType != null && snap.commissionValue != null) {
    await db(TABLES.PartnerCommission).insert({
      partnerId: id,
      tenantId,
      commissionType: snap.commissionType,
      commissionValue: snap.commissionValue.toFixed(4),
      recurring: snap.recurring ?? false,
      holdbackDays: snap.holdbackDays ?? null,
      source: 'approval',
      snapshottedAt: new Date(),
    });
  }

  if (sendInvite) {
    const issued = await issueMagicLink(db, {
      tenantId,
      email,
      purpose: 'partner_invite',
      principalKind: 'partner',
      principalId: id,
    });
    const { resolveBrandName } = await import('../brand-name.js');
    const brandName = await resolveBrandName(db, tenantId);
    const tmpl = partnerInviteEmail(body.data.name, buildMagicLinkUrl(issued.plaintext, req.tenantSlug), brandName);
    await getMailer().send({ db, tenantId }, {
      to: email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'partner_invite',
      metadata: { purpose: 'partner_invite', partnerId: id },
    });
  }

  // Push to Network if configured + autoEnroll. Same fire-and-forget
  // semantics as /partner-signup: a Network outage doesn't fail this
  // request; failures land in NetworkOutbox for the scheduler to retry.
  const network = await getNetworkMembership(db, tenantId);
  if (network?.enabled && network.autoEnroll) {
    const partnerRow = partner as PartnerRow;
    const result = await pushPartnerUpsert(db, tenantId, {
      vendorPartnerId: id,
      email,
      name: body.data.name,
      profile: body.data.metadata,
      joinedVendorAt: partnerRow.createdAt.toISOString(),
      status: partnerRow.activatedAt ? 'active' : 'pending',
      metadata: { source: 'admin_invite' },
    });
    if (result) {
      await db<PartnerRow>(TABLES.Partner)
        .where({ id })
        .update({
          metadata: db.raw(
            `jsonb_set(coalesce("metadata", '{}'::jsonb), '{network}', ?::jsonb, true)`,
            [
              JSON.stringify({
                creatorId: result.networkCreatorId,
                preExisting: result.alreadyExisted,
                affiliations: result.affiliations.length,
                syncedAt: new Date().toISOString(),
              }),
            ],
          ),
          updatedAt: new Date(),
        });
    }
  }

  // Webhook fan-out. partner.created always; partnership.approved
  // only when this Partner was created via Network federation
  // (metadata.source === 'openpartner_network' set by the Network's
  // approve flow). Subscribers like Zapier / ActivePieces use these
  // to drive Slack notifications, CRM contact creation, welcome
  // sequences, etc. Async — failures don't block the response.
  const partnerRow = partner as PartnerRow;
  dispatchEvent(tenantId, 'partner.created', {
    partnerId: id,
    email,
    name: body.data.name,
    activatedAt: partnerRow.activatedAt ? partnerRow.activatedAt.toISOString() : null,
    invited: sendInvite,
    campaignIds,
  });
  if ((body.data.metadata as Record<string, unknown> | undefined)?.source === 'openpartner_network') {
    dispatchEvent(tenantId, 'partnership.approved', {
      partnerId: id,
      email,
      name: body.data.name,
      networkCreatorId: (body.data.metadata as Record<string, unknown>).networkCreatorId,
      campaignIds,
    });
  }

  res.status(201).json({ ...partner, invited: sendInvite });
});

/**
 * Re-send an invite for a partner who hasn't accepted yet. Admin only.
 * Idempotent: multiple sends are fine; the partner can click any one
 * (they all expire in 15 minutes).
 */
partnersRouter.post('/partners/:id/invite', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id }).first();
  if (!partner) return res.status(404).json({ error: 'not_found' });
  if (partner.activatedAt) return res.status(409).json({ error: 'already_activated' });

  const issued = await issueMagicLink(db, {
    tenantId,
    email: partner.email,
    purpose: 'partner_invite',
    principalKind: 'partner',
    principalId: partner.id,
  });
  const { resolveBrandName } = await import('../brand-name.js');
  const brandName = await resolveBrandName(db, tenantId);
  const tmpl = partnerInviteEmail(partner.name, buildMagicLinkUrl(issued.plaintext, req.tenantSlug), brandName);
  await getMailer().send({ db, tenantId }, {
    to: partner.email,
    subject: tmpl.subject,
    text: tmpl.text,
    html: tmpl.html,
    tag: 'partner_invite',
    metadata: { purpose: 'partner_invite', partnerId: partner.id, resend: true },
  });
  res.json({ ok: true });
});

const revokeSchema = z.object({
  reason: z.string().max(500).optional(),
  // Default true: industry-standard partner-program norm is to notify.
  // Admin unchecks for fraud cases where tipping the partner off is
  // counterproductive.
  notify: z.boolean().optional().default(true),
});

/**
 * Suspend a partner. Flips revokedAt, revokes all of their sessions so
 * they're kicked out mid-request, leaves historical commissions
 * untouched. Future attribution skips them; router flags clicks on their
 * links as 'revoked'. Sends a notification email unless notify=false.
 */
partnersRouter.post('/partners/:id/revoke', requireAuth, grantScope('partners:write'), requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = revokeSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id }).first();
  if (!partner) return res.status(404).json({ error: 'not_found' });
  if (partner.revokedAt) return res.status(409).json({ error: 'already_revoked' });

  const now = new Date();
  const reason = body.data.reason ?? null;
  // The request is already in a transaction (per-request via tenantMiddleware);
  // operate on req.db directly without a nested trx.
  await db<PartnerRow>(TABLES.Partner)
    .where({ id: partner.id })
    .update({ revokedAt: now, revokeReason: reason, updatedAt: now });
  // Kill every authentication channel they hold: web sessions AND
  // their partner-scoped API keys. Leaving ApiKey rows live meant a
  // revoked partner retained programmatic access even though their
  // dashboard cookie was killed.
  await db<SessionRow>(TABLES.Session)
    .where({ principalKind: 'partner', principalId: partner.id })
    .whereNull('revokedAt')
    .update({ revokedAt: now });
  await db<ApiKeyRow>(TABLES.ApiKey)
    .where({ partnerId: partner.id })
    .whereNull('revokedAt')
    .update({ revokedAt: now });

  if (body.data.notify) {
    const tmpl = partnerRevokedEmail(partner.name, reason);
    await getMailer().send({ db, tenantId }, {
      to: partner.email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'partner_revoked',
      metadata: { purpose: 'partner_revoked', partnerId: partner.id },
    });
  }

  // Network gets the revoke too — but unconditionally if Network is
  // enabled (not gated on autoEnroll). The reasoning: autoEnroll
  // controls whether NEW partners flow into the Network; revokes need
  // to mirror regardless so a creator the Network thinks is active
  // doesn't keep getting matched after the vendor cuts them off.
  const network = await getNetworkMembership(db, tenantId);
  if (network?.enabled) {
    await pushPartnerRevoke(db, tenantId, partner.id);
  }

  res.json({ ok: true, revokedAt: now, notified: body.data.notify });
});

/** Undo revoke — partner regains dashboard access and future attribution. */
partnersRouter.post('/partners/:id/reinstate', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id }).first();
  if (!partner) return res.status(404).json({ error: 'not_found' });
  if (!partner.revokedAt) return res.status(409).json({ error: 'not_revoked' });

  await db<PartnerRow>(TABLES.Partner)
    .where({ id: partner.id })
    .update({ revokedAt: null, revokeReason: null, updatedAt: new Date() });
  res.json({ ok: true });
});

/**
 * List partners. Supports:
 *   - ?email=foo@bar.com  — exact-match filter (Zapier "find by email")
 *   - ?limit=N            — page size (1-200, default 100)
 *   - ?cursor=...         — opaque cursor returned by the previous page
 *
 * Returns { partners, nextCursor }. nextCursor is null when no more
 * pages. Cursor is base64(`createdAt|id`) — encoded so callers don't
 * try to construct it themselves and we keep ordering invariants.
 *
 * Stable ordering: createdAt DESC, id DESC as tiebreaker (id is
 * lexicographically increasing for ULIDs but not for legacy partners,
 * so we explicitly tie-break).
 */
const listQuerySchema = z.object({
  email: z.string().trim().email().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
  cursor: z.string().optional(),
});
partnersRouter.get('/partners', requireAuth, grantScope('partners:read'), requireAdmin, async (req, res) => {
  const q = listQuerySchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });
  const { db } = tenantOf(req);
  const query = db<PartnerRow>(TABLES.Partner).orderBy([
    { column: 'createdAt', order: 'desc' },
    { column: 'id', order: 'desc' },
  ]);
  if (q.data.email) query.where('email', q.data.email.toLowerCase());
  if (q.data.cursor) {
    const decoded = decodeCursor(q.data.cursor);
    if (!decoded) return res.status(400).json({ error: 'invalid_cursor' });
    // Strict inequality on the composite key — the row at the cursor
    // itself was already returned in the previous page.
    query.andWhere((qb) =>
      qb
        .where('createdAt', '<', decoded.createdAt)
        .orWhere((qq) => qq.where('createdAt', decoded.createdAt).andWhere('id', '<', decoded.id)),
    );
  }
  const partners = await query.limit(q.data.limit + 1);
  const hasMore = partners.length > q.data.limit;
  const page = hasMore ? partners.slice(0, q.data.limit) : partners;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;
  res.json({ partners: page, nextCursor });
});

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso, id] = raw.split('|');
    if (!iso || !id) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

partnersRouter.get('/partners/:id', requireAuth, requirePartnerOrAdmin('id'), async (req, res) => {
  const { db } = tenantOf(req);
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id }).first();
  if (!partner) return res.status(404).json({ error: 'not_found' });
  res.json(partner);
});

// Per-partner commission snapshot (PartnerCommission row, if any).
// Surfaced separately because the partner detail page wants to show
// "Approved under: 20% recurring, 30d holdback (since 2026-04-15)"
// and the snapshot is a sidecar table — keeps the GET /partners/:id
// shape unchanged.
partnersRouter.get('/partners/:id/commission-snapshot', requireAuth, requirePartnerOrAdmin('id'), async (req, res) => {
  const { db } = tenantOf(req);
  const snapshot = await db(TABLES.PartnerCommission)
    .where({ partnerId: req.params.id })
    .first('partnerId', 'commissionType', 'commissionValue', 'recurring', 'holdbackDays', 'source', 'snapshottedAt');
  if (!snapshot) return res.json({ snapshot: null });
  res.json({ snapshot });
});

// Admin override: set or replace a partner's commission snapshot.
// Used for the "VIP gets 30%" case where a brand wants to give a
// specific partner a different rate than the campaign default. Stamped
// with source='amendment' so it's distinguishable from the regular
// approval-time + backfill snapshots in audit + reporting. PUT
// semantics — replaces any existing row in full.
const overrideSchema = z.object({
  commissionType: z.enum(['percent', 'fixed']),
  commissionValue: z.number().nonnegative(),
  recurring: z.boolean().optional(),
  holdbackDays: z.number().int().nonnegative().nullable().optional(),
});
partnersRouter.put('/partners/:id/commission-snapshot', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = overrideSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });
  await db(TABLES.PartnerCommission)
    .insert({
      partnerId: partner.id,
      tenantId,
      commissionType: body.data.commissionType,
      commissionValue: body.data.commissionValue.toFixed(4),
      recurring: body.data.recurring ?? false,
      holdbackDays: body.data.holdbackDays ?? null,
      source: 'amendment',
      snapshottedAt: new Date(),
    })
    .onConflict('partnerId')
    .merge();
  const fresh = await db(TABLES.PartnerCommission)
    .where({ partnerId: partner.id })
    .first('partnerId', 'commissionType', 'commissionValue', 'recurring', 'holdbackDays', 'source', 'snapshottedAt');
  res.json({ snapshot: fresh });
});

// Admin: clear a partner's commission override. Drops the
// PartnerCommission row, which means future commissions fall back to
// the live Campaign rule again. Useful for unwinding a VIP rate when
// a partnership downgrades.
partnersRouter.delete('/partners/:id/commission-snapshot', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });
  await db(TABLES.PartnerCommission).where({ partnerId: partner.id }).del();
  res.json({ ok: true });
});

// One-shot backfill of PartnerCommission for partners that predate
// snapshot federation. Idempotent — can be run multiple times. See
// backfillCommissionSnapshots for the (intentional) limitations
// around multi-campaign partners.
partnersRouter.post('/partners/backfill-commission-snapshots', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const { backfillCommissionSnapshots } = await import('../backfill-commission-snapshots.js');
  const result = await backfillCommissionSnapshots(db, tenantId);
  res.json(result);
});
