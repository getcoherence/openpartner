/**
 * First-run install endpoint — WordPress-style. Only usable while zero
 * admins are activated. Once the first admin exists, the endpoint 409s
 * so a second "installer" can't take over.
 *
 * Creates the first admin in a single round-trip along with the program
 * settings (name + support email) and emails them a magic-link to
 * activate. After they verify, they're the first admin and can invite
 * others + rotate ADMIN_API_KEY.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type AdminRow, type ConfigRow } from '@openpartner/db';
import { db } from '../db.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { issueMagicLink } from '../auth-sessions.js';
import { getMailer } from '../mailer.js';
import { adminInviteEmail, buildMagicLinkUrl } from '../email-templates.js';

export const installRouter = Router();

const installLimit = ipRateLimit({ name: 'install', max: 5, windowMs: 60_000 });

const installSchema = z.object({
  adminName: z.string().trim().min(1).max(120),
  adminEmail: z.string().trim().email().max(254),
  programName: z.string().trim().min(1).max(120),
  supportEmail: z.string().trim().email().max(254).optional().or(z.literal('')),
});

/**
 * Public status probe used by the portal to decide whether to route to
 * /install on mount. Always reachable (it's what tells the portal the
 * system is uninitialized).
 */
installRouter.get('/install/status', async (_req, res) => {
  const [row] = await db<AdminRow>(TABLES.Admin)
    .whereNotNull('activatedAt')
    .whereNull('revokedAt')
    .count<{ count: string }[]>({ count: '*' });
  res.json({ needsSetup: Number(row?.count ?? 0) === 0 });
});

installRouter.post('/install', installLimit, async (req, res) => {
  const body = installSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const [existing] = await db<AdminRow>(TABLES.Admin)
    .whereNotNull('activatedAt')
    .whereNull('revokedAt')
    .count<{ count: string }[]>({ count: '*' });
  if (Number(existing?.count ?? 0) > 0) {
    return res.status(409).json({ error: 'already_installed' });
  }

  const adminEmail = body.data.adminEmail.toLowerCase();
  const programName = body.data.programName.trim();
  const supportEmail = body.data.supportEmail?.trim() || null;
  const now = new Date();

  await db.transaction(async (trx) => {
    // Program settings first so the admin-invite email can brand the subject.
    await trx<ConfigRow>(TABLES.Config)
      .insert({
        key: 'program_settings',
        value: { programName, supportEmail } as unknown as never,
        updatedAt: now,
      })
      .onConflict('key')
      .merge({ value: { programName, supportEmail } as unknown as never, updatedAt: now });

    // Create the admin row; activation happens on magic-link verify.
    const id = ulid();
    await trx<AdminRow>(TABLES.Admin).insert({
      id,
      email: adminEmail,
      name: body.data.adminName.trim(),
      activatedAt: null,
    });
  });

  // Send invite outside the transaction so mail failures don't roll back.
  const admin = await db<AdminRow>(TABLES.Admin).where({ email: adminEmail }).first();
  if (admin) {
    const issued = await issueMagicLink({
      email: adminEmail,
      purpose: 'admin_invite',
      principalKind: 'admin',
      principalId: admin.id,
    });
    const tmpl = adminInviteEmail(admin.name, buildMagicLinkUrl(issued.plaintext), programName);
    await getMailer().send({
      to: adminEmail,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'admin_invite',
      metadata: { purpose: 'admin_invite', adminId: admin.id, firstRun: true },
    });
  }

  res.json({ ok: true });
});
