/**
 * The per-referral timeline (referrals.ts): each customer a partner
 * referred, the stages they've reached and what they've earned the
 * partner, plus the brand's setting for which stages partners see.
 *
 *   GET  /partners/:id/referrals  partner (own only), admin, or a key with
 *                                 partners:read: what the partner portal's
 *                                 Referrals page shows, and what a headless
 *                                 brand renders in its own app.
 *   GET  /config/referrals        admin: the stage setting.
 *   POST /config/referrals        admin: change it.
 */

import { Router } from 'express';
import { z } from '../zod.js';
import { TABLES, type PartnerRow } from '@openpartner/db';
import { grantScope, requireAdmin, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { tenantDefaultCurrency } from '../currency.js';
import {
  DEFAULT_REFERRAL_STAGES,
  MAX_REFERRAL_STAGES,
  MAX_STAGE_EVENT_TYPE,
  MAX_STAGE_LABEL,
  ReferralSettingsError,
  listReferrals,
  readReferralSettings,
  recentEventTypes,
  saveReferralSettings,
} from '../referrals.js';
import { tenantOf } from '../tenancy.js';

export const referralsRouter = Router();

/** Newest referral first, keyset-paginated like the commission lists. */
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().optional(),
});

export const stageSchema = z.object({
  eventType: z.string().trim().min(1).max(MAX_STAGE_EVENT_TYPE),
  label: z.string().trim().min(1).max(MAX_STAGE_LABEL),
});

/** Omitted fields keep their value. `stages` replaces the whole list, in
 *  the order given. */
export const settingsSchema = z.object({
  stages: z.array(stageSchema).max(MAX_REFERRAL_STAGES).optional(),
  showCustomerLabels: z.boolean().optional(),
});

referralsRouter.get(
  '/partners/:id/referrals',
  requireAuth,
  grantScope('partners:read'),
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const q = listQuerySchema.safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });

    // A revoked partner has no session or key that resolves (auth.ts), so
    // only the brand gets here for one: their referrals stay readable as
    // history.
    const partner = await db<PartnerRow>(TABLES.Partner).where({ id: req.params.id, tenantId }).first('id');
    if (!partner) return res.status(404).json({ error: 'not_found' });
    const asPartner = req.principal?.role === 'partner';

    const settings = await readReferralSettings(db, tenantId);
    const currency = await tenantDefaultCurrency(db, tenantId);
    const page = await listReferrals(db, {
      tenantId,
      partnerId: partner.id,
      settings,
      currency,
      limit: q.data.limit,
      cursor: q.data.cursor,
      // The brand's userId is the brand's own data: never sent to a partner.
      includeUserId: !asPartner,
    });
    if (!page) return res.status(400).json({ error: 'invalid_cursor' });
    res.json({ partnerId: partner.id, stages: settings.stages, currency, ...page });
  },
);

referralsRouter.get('/config/referrals', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await settingsResponse(db, tenantId, await readReferralSettings(db, tenantId)));
});

referralsRouter.post('/config/referrals', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = settingsSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  try {
    const saved = await saveReferralSettings(db, tenantId, body.data);
    res.json(await settingsResponse(db, tenantId, saved));
  } catch (err) {
    if (err instanceof ReferralSettingsError) {
      return res.status(400).json({ error: err.code, eventType: err.eventType, detail: err.message });
    }
    throw err;
  }
});

async function settingsResponse(
  db: Parameters<typeof recentEventTypes>[0],
  tenantId: string,
  settings: Awaited<ReturnType<typeof readReferralSettings>>,
) {
  return {
    ...settings,
    defaultStages: DEFAULT_REFERRAL_STAGES,
    recentEventTypes: await recentEventTypes(db, tenantId),
  };
}
