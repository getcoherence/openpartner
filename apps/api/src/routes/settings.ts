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
import { z } from 'zod';
import { TABLES, type ConfigRow } from '@openpartner/db';
import { db } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';

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

async function readSettings(): Promise<ProgramSettings> {
  const row = await db<ConfigRow>(TABLES.Config).where({ key: CONFIG_KEY }).first();
  const value = (row?.value ?? {}) as Partial<ProgramSettings>;
  return {
    programName: value.programName ?? null,
    supportEmail: value.supportEmail ?? null,
  };
}

/** Any authenticated caller (admin OR partner) can read — not secret. */
settingsRouter.get('/config/program', requireAuth, async (_req, res) => {
  res.json(await readSettings());
});

/** Only admins write. Empty strings clear fields. */
settingsRouter.post('/config/program', requireAuth, requireAdmin, async (req, res) => {
  const body = settingsSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const next: ProgramSettings = {
    programName: body.data.programName?.trim() || null,
    supportEmail: body.data.supportEmail?.trim() || null,
  };
  const now = new Date();
  // Upsert: preserves updatedAt semantics without a separate read.
  await db<ConfigRow>(TABLES.Config)
    .insert({ key: CONFIG_KEY, value: next as unknown as never, updatedAt: now })
    .onConflict('key')
    .merge({ value: next as unknown as never, updatedAt: now });
  res.json(next);
});
