/**
 * Admin persona management — list, invite, revoke, reinstate.
 *
 * Guard rails:
 *   - Can't revoke the last active admin (would lock everyone out)
 *   - Can't revoke yourself (session-sourced admins only; env-sourced
 *     admins can revoke anyone since they're a fallback root)
 *
 * The ADMIN_API_KEY env stays valid alongside admin personas as a
 * bootstrap / headless path — think `doctl` or CI running migrations.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type AdminRow, type ConfigRow, type SessionRow } from '@openpartner/db';
import { db } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { issueMagicLink } from '../auth-sessions.js';
import { getMailer } from '../mailer.js';
import { adminInviteEmail, buildMagicLinkUrl } from '../email-templates.js';

export const adminsRouter = Router();

const inviteSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
});

const revokeSchema = z.object({
  reason: z.string().max(500).optional(),
});

async function getProgramName(): Promise<string | null> {
  const row = await db<ConfigRow>(TABLES.Config).where({ key: 'program_settings' }).first();
  const value = (row?.value ?? {}) as { programName?: string };
  return value.programName ?? null;
}

async function activeAdminCount(trx?: typeof db): Promise<number> {
  const [row] = await (trx ?? db)<AdminRow>(TABLES.Admin)
    .whereNotNull('activatedAt')
    .whereNull('revokedAt')
    .count<{ count: string }[]>({ count: '*' });
  return Number(row?.count ?? 0);
}

async function sendInvite(admin: AdminRow): Promise<void> {
  const issued = await issueMagicLink({
    email: admin.email,
    purpose: 'admin_invite',
    principalKind: 'admin',
    principalId: admin.id,
  });
  const tmpl = adminInviteEmail(admin.name, buildMagicLinkUrl(issued.plaintext), await getProgramName());
  await getMailer().send({
    to: admin.email,
    subject: tmpl.subject,
    text: tmpl.text,
    html: tmpl.html,
    tag: 'admin_invite',
    metadata: { purpose: 'admin_invite', adminId: admin.id },
  });
}

// -------- List --------

adminsRouter.get('/admins', requireAuth, requireAdmin, async (_req, res) => {
  const admins = await db<AdminRow>(TABLES.Admin).orderBy('createdAt', 'desc');
  res.json({ admins });
});

// -------- Invite --------

adminsRouter.post('/admins', requireAuth, requireAdmin, async (req, res) => {
  const body = inviteSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const email = body.data.email.toLowerCase();
  const existing = await db<AdminRow>(TABLES.Admin).where({ email }).first();
  if (existing) return res.status(409).json({ error: 'email_taken' });

  const id = ulid();
  const [admin] = await db<AdminRow>(TABLES.Admin)
    .insert({ id, email, name: body.data.name, activatedAt: null })
    .returning('*');
  await sendInvite(admin as AdminRow);
  res.status(201).json(admin);
});

// -------- Resend invite --------

adminsRouter.post('/admins/:id/invite', requireAuth, requireAdmin, async (req, res) => {
  const admin = await db<AdminRow>(TABLES.Admin).where({ id: req.params.id }).first();
  if (!admin) return res.status(404).json({ error: 'not_found' });
  if (admin.activatedAt) return res.status(409).json({ error: 'already_activated' });
  await sendInvite(admin);
  res.json({ ok: true });
});

// -------- Revoke --------

adminsRouter.post('/admins/:id/revoke', requireAuth, requireAdmin, async (req, res) => {
  const body = revokeSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const admin = await db<AdminRow>(TABLES.Admin).where({ id: req.params.id }).first();
  if (!admin) return res.status(404).json({ error: 'not_found' });
  if (admin.revokedAt) return res.status(409).json({ error: 'already_revoked' });

  // Guard: can't revoke yourself when you're a session-sourced admin.
  // Env-sourced admins (ADMIN_API_KEY) don't have an adminId — they can.
  const caller = req.principal;
  if (caller?.role === 'admin' && caller.source === 'session' && caller.adminId === admin.id) {
    return res.status(409).json({ error: 'cannot_revoke_self' });
  }

  // Guard: never drop the count of active admins to zero via revoke.
  // If only one active admin remains and they're the one being revoked,
  // refuse unless ADMIN_API_KEY was used (env-admin can still get in).
  const count = await activeAdminCount();
  if (count <= 1 && admin.activatedAt && !admin.revokedAt) {
    return res.status(409).json({ error: 'cannot_revoke_last_active_admin' });
  }

  const now = new Date();
  await db.transaction(async (trx) => {
    await trx<AdminRow>(TABLES.Admin)
      .where({ id: admin.id })
      .update({ revokedAt: now, revokeReason: body.data.reason ?? null, updatedAt: now });
    // Kill admin sessions like we do for partners.
    await trx<SessionRow>(TABLES.Session)
      .where({ principalKind: 'admin', principalId: admin.id })
      .whereNull('revokedAt')
      .update({ revokedAt: now });
  });
  res.json({ ok: true, revokedAt: now });
});

// -------- Reinstate --------

adminsRouter.post('/admins/:id/reinstate', requireAuth, requireAdmin, async (req, res) => {
  const admin = await db<AdminRow>(TABLES.Admin).where({ id: req.params.id }).first();
  if (!admin) return res.status(404).json({ error: 'not_found' });
  if (!admin.revokedAt) return res.status(409).json({ error: 'not_revoked' });
  await db<AdminRow>(TABLES.Admin)
    .where({ id: admin.id })
    .update({ revokedAt: null, revokeReason: null, updatedAt: new Date() });
  res.json({ ok: true });
});
