/**
 * First-run install endpoint — WordPress-style. Only usable while zero
 * admins are activated. Once the first admin exists, the endpoint 409s
 * so a second "installer" can't take over.
 *
 * Creates the first admin in a single round-trip along with the program
 * settings (name + support email) and emails them a magic-link to
 * activate. After they verify, they're the first admin and can invite
 * others + rotate ADMIN_API_KEY.
 *
 * Multi-tenant: install is the self-host bootstrap. In multi-tenant mode
 * it rejects — hosted operators provision tenants via /signup, and the
 * platform is never "uninstalled". The endpoint stays mounted as a
 * public route (no tenantMiddleware) and uses the privileged `db` to
 * stamp rows with the seeded default tenant.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, type AdminRow, type ConfigRow } from '@openpartner/db';
import { db } from '../db.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { issueMagicLink } from '../auth-sessions.js';
import { getMailer } from '../mailer.js';
import { adminInviteEmail, buildMagicLinkUrl } from '../email-templates.js';
import { saveMailSettings } from '../mail-settings.js';
import { getTenancyMode } from '../tenancy.js';

export const installRouter = Router();

class AlreadyInstalledError extends Error {
  readonly name = 'AlreadyInstalledError';
}

const installLimit = ipRateLimit({ name: 'install', max: 5, windowMs: 60_000 });

const installSchema = z
  .object({
    adminName: z.string().trim().min(1).max(120),
    adminEmail: z.string().trim().email().max(254),
    programName: z.string().trim().min(1).max(120),
    supportEmail: z.string().trim().email().max(254).optional().or(z.literal('')),
    mail: z
      .object({
        kind: z.enum(['smtp', 'postmark', 'none']),
        from: z.string().trim().max(254).optional(),
        smtp: z
          .object({
            host: z.string().trim().min(1).max(253),
            port: z.number().int().min(1).max(65535).default(587),
            secure: z.boolean().default(false),
            user: z.string().trim().max(320).optional(),
            password: z.string().max(500).optional(),
          })
          .optional(),
        postmark: z
          .object({
            serverToken: z.string().min(1).max(500),
            messageStream: z.string().trim().max(120).default('outbound'),
          })
          .optional(),
      })
      .optional(),
  })
  // Cross-field invariants: picking smtp/postmark without the minimum
  // required fields would let the install "succeed" only to then
  // silently drop the activation email (wrong From header, no host, no
  // token). Reject at the boundary instead.
  .superRefine((val, ctx) => {
    const m = val.mail;
    if (!m || m.kind === 'none') return;
    if (!m.from || !m.from.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mail', 'from'], message: 'required when kind is smtp or postmark' });
    }
    if (m.kind === 'smtp' && !m.smtp?.host) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mail', 'smtp', 'host'], message: 'required when kind is smtp' });
    }
    if (m.kind === 'postmark' && !m.postmark?.serverToken) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mail', 'postmark', 'serverToken'], message: 'required when kind is postmark' });
    }
  });

/**
 * Public status probe used by the portal to decide whether to route to
 * /install on mount. Always reachable (it's what tells the portal the
 * system is uninitialized).
 */
installRouter.get('/install/status', async (_req, res) => {
  if (getTenancyMode() === 'multi') {
    return res.json({ needsSetup: false, reason: 'multi_tenant' });
  }
  const [row] = await db<AdminRow>(TABLES.Admin)
    .where({ tenantId: DEFAULT_TENANT_ID })
    .whereNotNull('activatedAt')
    .whereNull('revokedAt')
    .count<{ count: string }[]>({ count: '*' });
  res.json({ needsSetup: Number(row?.count ?? 0) === 0 });
});

/** Deterministic pg advisory-lock key — any 64-bit int, as long as this
 *  is the only caller. Different from 0 to avoid collision with the
 *  naive "no lock" sentinel some libraries use. */
const INSTALL_ADVISORY_LOCK = 49_1092_4719;

installRouter.post('/install', installLimit, async (req, res) => {
  if (getTenancyMode() === 'multi') {
    return res.status(400).json({ error: 'install_not_available_in_multi_tenant' });
  }

  const body = installSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const adminEmail = body.data.adminEmail.toLowerCase();
  const programName = body.data.programName.trim();
  const supportEmail = body.data.supportEmail?.trim() || null;
  const now = new Date();

  let adminId: string | null = null;
  try {
    await db.transaction(async (trx) => {
      // Serialize concurrent installers. The advisory lock is auto-
      // released when the transaction commits / rolls back. Inside
      // the lock, re-check the "no admin exists yet" invariant — a
      // check outside the lock (TOCTOU) would let two concurrent
      // installers both think they're first.
      await trx.raw('SELECT pg_advisory_xact_lock(?)', [INSTALL_ADVISORY_LOCK]);

      // Block on ANY admin row (activated or not) in the default tenant:
      // while a first-run magic-link is outstanding, a second installer
      // shouldn't be able to sneak their own pending admin in.
      const [existing] = await trx<AdminRow>(TABLES.Admin)
        .where({ tenantId: DEFAULT_TENANT_ID })
        .count<{ count: string }[]>({ count: '*' });
      if (Number(existing?.count ?? 0) > 0) {
        throw new AlreadyInstalledError();
      }

      await trx<ConfigRow>(TABLES.Config)
        .insert({
          tenantId: DEFAULT_TENANT_ID,
          key: 'program_settings',
          value: { programName, supportEmail } as unknown as never,
          updatedAt: now,
        })
        .onConflict(['tenantId', 'key'])
        .merge({ value: { programName, supportEmail } as unknown as never, updatedAt: now });

      const id = ulid();
      await trx<AdminRow>(TABLES.Admin).insert({
        id,
        tenantId: DEFAULT_TENANT_ID,
        email: adminEmail,
        name: body.data.adminName.trim(),
        activatedAt: null,
      });
      adminId = id;
    });
  } catch (err) {
    if (err instanceof AlreadyInstalledError) {
      return res.status(409).json({ error: 'already_installed' });
    }
    throw err;
  }
  if (!adminId) return res.status(500).json({ error: 'install_failed' });

  // Finish the install in a compensating try/catch: if mail config OR
  // the invite send fails, roll back the Admin row we just created so
  // /install can be retried. Without this, a partial failure here
  // would leave an unactivated admin in the table and /install's
  // "any admin exists" guard would 409 every subsequent attempt — the
  // only escape being manual DB surgery or env-key intervention.
  try {
    if (body.data.mail) {
      await saveMailSettings(db, DEFAULT_TENANT_ID, {
        kind: body.data.mail.kind,
        from: body.data.mail.from,
        smtp: body.data.mail.smtp,
        postmark: body.data.mail.postmark,
      });
    }

    const issued = await issueMagicLink(db, {
      tenantId: DEFAULT_TENANT_ID,
      email: adminEmail,
      purpose: 'admin_invite',
      principalKind: 'admin',
      principalId: adminId,
    });
    const tmpl = adminInviteEmail(body.data.adminName.trim(), buildMagicLinkUrl(issued.plaintext), programName);
    await getMailer().send({ db, tenantId: DEFAULT_TENANT_ID }, {
      to: adminEmail,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'admin_invite',
      metadata: { purpose: 'admin_invite', adminId, firstRun: true },
    });
  } catch (err) {
    // Remove the admin row + any magic-link token we issued before the
    // failure. MagicLinkToken has no FK to Admin since the schema was
    // generalized, so clean it up explicitly.
    await db.transaction(async (trx) => {
      await trx('MagicLinkToken').where({ principalKind: 'admin', principalId: adminId }).del();
      await trx<AdminRow>(TABLES.Admin).where({ id: adminId }).del();
    });
    const message = err instanceof Error ? err.message : 'install failed';
    return res.status(502).json({ error: 'install_mail_failed', detail: message });
  }

  res.json({ ok: true });
});
