/**
 * Admin persona management — list, invite, change role, revoke, reinstate.
 *
 * Roles (docs/view-only-seats.md): 'admin' manages everything, 'viewer'
 * sees everything and changes nothing. A viewer reaches none of the writes
 * below: requireAuth refuses them (view-only.ts).
 *
 * Guard rails:
 *   - Can't revoke or demote the last active full admin (would leave
 *     nobody able to manage the brand; viewers don't count)
 *   - Can't revoke yourself or change your own role (session-sourced
 *     admins only; env-sourced admins can act on anyone since they're a
 *     fallback root)
 *
 * The ADMIN_API_KEY env stays valid alongside admin personas as a
 * bootstrap / headless path — think `doctl` or CI running migrations.
 */

import { Router, type Request } from 'express';
import type { Knex } from 'knex';
import { z } from '../zod.js';
import { ulid } from 'ulid';
import { ADMIN_ROLES, TABLES, type AdminRow, type ConfigRow, type SessionRow } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { issueMagicLink } from '../auth-sessions.js';
import { getMailer } from '../mailer.js';
import { adminInviteEmail, buildMagicLinkUrl } from '../email-templates.js';
import { linkTenantOf, type PortalLinkTenant } from '../portal-url.js';
import { tenantOf } from '../tenancy.js';

export const adminsRouter = Router();

const inviteSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  role: z.enum(ADMIN_ROLES).default('admin'),
});

const roleSchema = z.object({ role: z.enum(ADMIN_ROLES) });

const revokeSchema = z.object({
  reason: z.string().max(500).optional(),
});

async function getProgramName(db: Knex, tenantId: string): Promise<string | null> {
  const row = await db<ConfigRow>(TABLES.Config).where({ tenantId, key: 'program_settings' }).first();
  const value = (row?.value ?? {}) as { programName?: string };
  return value.programName ?? null;
}

async function sendInvite(db: Knex, tenantId: string, admin: AdminRow, linkTenant?: PortalLinkTenant | null): Promise<void> {
  const issued = await issueMagicLink(db, {
    tenantId,
    email: admin.email,
    purpose: 'admin_invite',
    principalKind: 'admin',
    principalId: admin.id,
  });
  const tmpl = adminInviteEmail(
    admin.name,
    buildMagicLinkUrl(issued.plaintext, linkTenant),
    await getProgramName(db, tenantId),
    admin.role,
  );
  await getMailer().send({ db, tenantId }, {
    to: admin.email,
    subject: tmpl.subject,
    text: tmpl.text,
    html: tmpl.html,
    tag: 'admin_invite',
    metadata: { purpose: 'admin_invite', adminId: admin.id },
  });
}

// Every query below names tenantId explicitly. RLS scopes req.db, but a
// multi-tenant pool that bypasses RLS (no app role) would otherwise list,
// count and lock every tenant's admins.

// -------- List --------

adminsRouter.get('/admins', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const admins = await db<AdminRow>(TABLES.Admin).where({ tenantId }).orderBy('createdAt', 'desc');
  res.json({ admins });
});

// -------- Invite --------

adminsRouter.post('/admins', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = inviteSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const email = body.data.email.toLowerCase();
  // Admin email is unique per tenant.
  const existing = await db<AdminRow>(TABLES.Admin).where({ tenantId, email }).first();
  if (existing) return res.status(409).json({ error: 'email_taken' });

  const id = ulid();
  const [admin] = await db<AdminRow>(TABLES.Admin)
    .insert({ id, tenantId, email, name: body.data.name, role: body.data.role, activatedAt: null })
    .returning('*');
  await sendInvite(db, tenantId, admin as AdminRow, linkTenantOf(req));
  res.status(201).json(admin);
});

// -------- Resend invite --------

adminsRouter.post('/admins/:id/invite', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const admin = await db<AdminRow>(TABLES.Admin).where({ id: req.params.id, tenantId }).first();
  if (!admin) return res.status(404).json({ error: 'not_found' });
  if (admin.revokedAt) return res.status(409).json({ error: 'admin_revoked' });
  if (admin.activatedAt) return res.status(409).json({ error: 'already_activated' });
  await sendInvite(db, tenantId, admin, linkTenantOf(req));
  res.json({ ok: true });
});

class RevokeGuardError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

/** True when `req` is that admin's own session. */
function isSelf(req: Request, admin: AdminRow): boolean {
  const caller = req.principal;
  return caller?.role === 'admin' && caller.source === 'session' && caller.adminId === admin.id;
}

/** Lock the tenant's active full admins FOR UPDATE and say whether
 *  `admin` is the only one, so two concurrent removals of the last two
 *  serialize instead of both passing. Viewers don't count: they can't
 *  manage the brand. */
async function isLastActiveFullAdmin(db: Knex, tenantId: string, admin: AdminRow): Promise<boolean> {
  const actives = await db<AdminRow>(TABLES.Admin)
    .where({ tenantId, role: 'admin' })
    .whereNotNull('activatedAt')
    .whereNull('revokedAt')
    .forUpdate();
  const counts = admin.role === 'admin' && !!admin.activatedAt && !admin.revokedAt;
  return counts && actives.length <= 1;
}

// -------- Change role --------

adminsRouter.patch('/admins/:id', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = roleSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  try {
    const admin = await db<AdminRow>(TABLES.Admin).where({ id: req.params.id, tenantId }).forUpdate().first();
    if (!admin) throw new RevokeGuardError('not_found');
    if (admin.role !== body.data.role) {
      if (isSelf(req, admin)) throw new RevokeGuardError('cannot_change_own_role');
      if (body.data.role === 'viewer' && (await isLastActiveFullAdmin(db, tenantId, admin))) {
        throw new RevokeGuardError('cannot_demote_last_active_admin');
      }
      await db<AdminRow>(TABLES.Admin)
        .where({ id: admin.id, tenantId })
        .update({ role: body.data.role, updatedAt: new Date() });
    }
    const updated = await db<AdminRow>(TABLES.Admin).where({ id: admin.id, tenantId }).first();
    res.json(updated);
  } catch (err) {
    if (err instanceof RevokeGuardError) {
      const status = err.code === 'not_found' ? 404 : 409;
      return res.status(status).json({ error: err.code });
    }
    throw err;
  }
});

// -------- Revoke --------

adminsRouter.post('/admins/:id/revoke', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = revokeSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const now = new Date();

  try {
    // The request is already in a transaction (per-request via tenantMiddleware),
    // so use it directly. No nested transaction needed — the FOR UPDATE locks
    // are scoped to this transaction and released on commit.
    // Lock the target admin + all active admins FOR UPDATE so
    // concurrent revoke calls serialize. Without this, two simultaneous
    // revokes of the only two active admins both pass the "count > 1"
    // check and lock everyone out.
    const admin = await db<AdminRow>(TABLES.Admin).where({ id: req.params.id, tenantId }).forUpdate().first();
    if (!admin) throw new RevokeGuardError('not_found');
    if (admin.revokedAt) throw new RevokeGuardError('already_revoked');

    // Can't revoke yourself (session-sourced admins only — env-bearer
    // callers are a headless / emergency path and can revoke anyone).
    if (isSelf(req, admin)) throw new RevokeGuardError('cannot_revoke_self');

    // Last-active-admin guard inside the same tx, counted under FOR
    // UPDATE so the count is stable through commit.
    if (await isLastActiveFullAdmin(db, tenantId, admin)) {
      throw new RevokeGuardError('cannot_revoke_last_active_admin');
    }

    await db<AdminRow>(TABLES.Admin)
      .where({ id: admin.id, tenantId })
      .update({ revokedAt: now, revokeReason: body.data.reason ?? null, updatedAt: now });
    // Kill admin sessions.
    await db<SessionRow>(TABLES.Session)
      .where({ tenantId, principalKind: 'admin', principalId: admin.id })
      .whereNull('revokedAt')
      .update({ revokedAt: now });
  } catch (err) {
    if (err instanceof RevokeGuardError) {
      const status = err.code === 'not_found' ? 404 : 409;
      return res.status(status).json({ error: err.code });
    }
    throw err;
  }

  res.json({ ok: true, revokedAt: now });
});

// -------- Reinstate --------

adminsRouter.post('/admins/:id/reinstate', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const admin = await db<AdminRow>(TABLES.Admin).where({ id: req.params.id, tenantId }).first();
  if (!admin) return res.status(404).json({ error: 'not_found' });
  if (!admin.revokedAt) return res.status(409).json({ error: 'not_revoked' });
  await db<AdminRow>(TABLES.Admin)
    .where({ id: admin.id, tenantId })
    .update({ revokedAt: null, revokeReason: null, updatedAt: new Date() });
  res.json({ ok: true });
});
