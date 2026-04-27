/**
 * Program-wide settings stored in the Config table. Keyed by
 * `program_settings`, the value is a JSON blob of:
 *
 *   programName?: string   — how to brand the portal (admin + partner)
 *   supportEmail?: string  — shown in the partner footer as contact
 *
 * Env is reserved for secrets + build-time; runtime content like this
 * lives here so admins can update it without a redeploy.
 */

import { Router } from 'express';
import type { Knex } from 'knex';
import { z } from 'zod';
import { TABLES, type ConfigRow } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import {
  MailSettingsValidationError,
  getPublicMailSettings,
  saveMailSettings,
  type MailTransportKind,
} from '../mail-settings.js';
import {
  backfillPartners,
  getPublicNetworkMembership,
  saveNetworkMembership,
} from '../network-client.js';
import { tenantOf } from '../tenancy.js';

export const settingsRouter = Router();

const CONFIG_KEY = 'program_settings';

const settingsSchema = z.object({
  programName: z.string().trim().max(120).optional(),
  supportEmail: z.string().trim().email().max(254).optional().or(z.literal('')),
});

export interface ProgramSettings {
  programName: string | null;
  supportEmail: string | null;
}

async function readSettings(db: Knex, tenantId: string): Promise<ProgramSettings> {
  const row = await db<ConfigRow>(TABLES.Config).where({ tenantId, key: CONFIG_KEY }).first();
  const value = (row?.value ?? {}) as Partial<ProgramSettings>;
  return {
    programName: value.programName ?? null,
    supportEmail: value.supportEmail ?? null,
  };
}

/** Any authenticated caller (admin OR partner) can read — not secret. */
settingsRouter.get('/config/program', requireAuth, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await readSettings(db, tenantId));
});

/** Only admins write. Empty strings clear fields. */
settingsRouter.post('/config/program', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = settingsSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const next: ProgramSettings = {
    programName: body.data.programName?.trim() || null,
    supportEmail: body.data.supportEmail?.trim() || null,
  };
  const now = new Date();
  // Upsert: preserves updatedAt semantics without a separate read.
  await db<ConfigRow>(TABLES.Config)
    .insert({ tenantId, key: CONFIG_KEY, value: next as unknown as never, updatedAt: now })
    .onConflict(['tenantId', 'key'])
    .merge({ value: next as unknown as never, updatedAt: now });
  res.json(next);
});

// ---------- Mail settings ----------

const mailSettingsSchema = z.object({
  kind: z.enum(['smtp', 'postmark', 'none']),
  from: z.string().trim().max(254).optional().or(z.literal('')),
  smtp: z
    .object({
      host: z.string().trim().max(253).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      secure: z.boolean().optional(),
      user: z.string().trim().max(320).optional(),
      // Password / token are write-only from the client. Undefined =
      // "keep existing"; empty string = "clear"; set = rotate.
      password: z.string().max(500).optional(),
    })
    .optional(),
  postmark: z
    .object({
      serverToken: z.string().max(500).optional(),
      messageStream: z.string().trim().max(120).optional(),
    })
    .optional(),
});

settingsRouter.get('/config/mail', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await getPublicMailSettings(db, tenantId));
});

settingsRouter.post('/config/mail', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = mailSettingsSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  try {
    await saveMailSettings(db, tenantId, {
      kind: body.data.kind as MailTransportKind,
      from: body.data.from === '' ? null : body.data.from ?? undefined,
      smtp: body.data.smtp,
      postmark: body.data.postmark,
    });
  } catch (err) {
    if (err instanceof MailSettingsValidationError) {
      return res.status(400).json({ error: err.code, field: err.field });
    }
    throw err;
  }
  res.json(await getPublicMailSettings(db, tenantId));
});

// ---------- Partner signup policy ----------

const partnerSignupSchema = z.object({
  policy: z.enum(['auto_approve', 'require_review']).optional(),
  disabled: z.boolean().optional(),
});

settingsRouter.get('/config/partner-signup', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const row = await db<ConfigRow>(TABLES.Config)
    .where({ tenantId, key: 'partner_signup' })
    .first();
  const value = (row?.value ?? {}) as { policy?: string; disabled?: boolean };
  res.json({
    policy: value.policy === 'require_review' ? 'require_review' : 'auto_approve',
    disabled: value.disabled === true,
  });
});

settingsRouter.post('/config/partner-signup', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = partnerSignupSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const current = await db<ConfigRow>(TABLES.Config).where({ tenantId, key: 'partner_signup' }).first();
  const currentValue = (current?.value ?? {}) as { policy?: string; disabled?: boolean };
  const next = {
    policy: body.data.policy ?? currentValue.policy ?? 'auto_approve',
    disabled: body.data.disabled ?? currentValue.disabled ?? false,
  };
  const now = new Date();
  await db<ConfigRow>(TABLES.Config)
    .insert({ tenantId, key: 'partner_signup', value: next as unknown as never, updatedAt: now })
    .onConflict(['tenantId', 'key'])
    .merge({ value: next as unknown as never, updatedAt: now });
  res.json(next);
});

// ---------- Network membership ----------

const networkMembershipSchema = z.object({
  enabled: z.boolean().optional(),
  networkUrl: z.string().url().optional().or(z.literal('')),
  /** Plaintext bearer issued by the Network on /vendors/register. Undefined keeps existing. */
  vendorToken: z.string().max(500).optional(),
  /** ApiKey.id of the scoped key the Network should call back with. */
  scopedKeyId: z.string().nullable().optional(),
  autoEnroll: z.boolean().optional(),
});

settingsRouter.get('/config/network', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await getPublicNetworkMembership(db, tenantId));
});

settingsRouter.post('/config/network', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = networkMembershipSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  await saveNetworkMembership(db, tenantId, {
    enabled: body.data.enabled,
    networkUrl: body.data.networkUrl === '' ? '' : body.data.networkUrl,
    vendorToken: body.data.vendorToken,
    scopedKeyId: body.data.scopedKeyId,
    autoEnroll: body.data.autoEnroll,
  });
  res.json(await getPublicNetworkMembership(db, tenantId));
});

/**
 * Reconcile existing partners with the Network. Called when an admin
 * enables Network membership after already having a partner roster.
 *
 * Pushes every Partner row through /partners/upsert. The Network dedups
 * on email — so a creator who's already on the Network from another
 * vendor returns the existing networkCreatorId, and we stamp
 * Partner.metadata.network.preExisting=true so the admin sees who was
 * already known.
 *
 * Synchronous (returns counts when done). For very large rosters the
 * outbox + scheduler-drained retries handle Network-side timeouts so a
 * single backfill failure doesn't lose the work.
 */
settingsRouter.post('/config/network/backfill', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const partners = await db('Partner')
    .select<Array<{ id: string; email: string; name: string; createdAt: Date; activatedAt: Date | null; revokedAt: Date | null }>>(
      'id',
      'email',
      'name',
      'createdAt',
      'activatedAt',
      'revokedAt',
    );
  const result = await backfillPartners(db, tenantId, partners);
  res.json(result);
});
