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

const createSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
  // Admin can opt out of the invite email (e.g. federation creating a
  // Partner row on behalf of an external creator network). Default is
  // "invite them" since that's the intent of the admin UI.
  sendInvite: z.boolean().optional(),
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

  if (sendInvite) {
    const issued = await issueMagicLink(db, {
      tenantId,
      email,
      purpose: 'partner_invite',
      principalKind: 'partner',
      principalId: id,
    });
    const tmpl = partnerInviteEmail(body.data.name, buildMagicLinkUrl(issued.plaintext));
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
  const tmpl = partnerInviteEmail(partner.name, buildMagicLinkUrl(issued.plaintext));
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
partnersRouter.post('/partners/:id/revoke', requireAuth, requireAdmin, async (req, res) => {
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

partnersRouter.get('/partners', requireAuth, requireAdmin, async (req, res) => {
  const { db } = tenantOf(req);
  const partners = await db<PartnerRow>(TABLES.Partner).orderBy('createdAt', 'desc').limit(500);
  res.json({ partners });
});

partnersRouter.get('/partners/:id', requireAuth, requirePartnerOrAdmin('id'), async (req, res) => {
  const { db } = tenantOf(req);
  const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id }).first();
  if (!partner) return res.status(404).json({ error: 'not_found' });
  res.json(partner);
});
