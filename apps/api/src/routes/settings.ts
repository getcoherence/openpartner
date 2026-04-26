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
