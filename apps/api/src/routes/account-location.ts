/**
 * Where the brand is based — asked once of brands that signed up before
 * the platform captured it (signup and add-brand ask up front now). The
 * portal shows a one-question prompt until it's answered.
 *
 *   GET /account/location   → { required, country, outsideOccupiedRegions }
 *   PUT /account/location   { country, outsideOccupiedRegions? }
 *
 * Hosted multi-tenant only (country-access.ts); self-host answers
 * required:false and never prompts.
 *
 * A brand that reports a country the platform doesn't serve is told so,
 * and platform ops are emailed to close it through the review console.
 * The declaration is kept either way: it is the compliance record.
 */

import { Router } from 'express';
import { z } from 'zod';
import { TABLES, type AdminRow, type TenantRow } from '@openpartner/db';
import { db } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { getTenancyMode, tenantOf } from '../tenancy.js';
import {
  checkCountryAccess,
  countryAccessStatus,
  countryCodeSchema,
  latestDeclaredCountries,
  recordLocationDeclaration,
} from '../country-access.js';
import { opsConsoleUrl } from '../brand-review.js';
import { sendOpsEmail } from '../platform-ops-mail.js';
import { opsBrandCountryNotServedEmail } from '../email-templates.js';

export const accountLocationRouter = Router();

accountLocationRouter.get('/account/location', requireAuth, requireAdmin, async (req, res) => {
  if (getTenancyMode() !== 'multi') return res.json({ required: false, country: null, outsideOccupiedRegions: null });
  const { tenantId } = tenantOf(req);
  // LocationDeclaration is a platform table: read on the privileged pool,
  // always filtered to this request's tenant.
  const latest = (await latestDeclaredCountries(db, 'tenant', [tenantId])).get(tenantId);
  res.json({
    required: true,
    country: latest?.country ?? null,
    outsideOccupiedRegions: latest?.outsideOccupiedRegions ?? null,
  });
});

const putSchema = z.object({
  country: countryCodeSchema(),
  outsideOccupiedRegions: z.boolean().optional(),
});

accountLocationRouter.put('/account/location', requireAuth, requireAdmin, async (req, res) => {
  if (getTenancyMode() !== 'multi') return res.status(400).json({ error: 'not_available_in_single_tenant' });
  const body = putSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const { tenantId } = tenantOf(req);

  const check = await checkCountryAccess(db, {
    declared: body.data.country,
    ip: req.ip,
    outsideOccupiedRegions: body.data.outsideOccupiedRegions,
  });
  if (!check.ok && check.error === 'occupied_region_confirmation_required') {
    return res.status(countryAccessStatus(check.error)).json({ error: check.error });
  }

  const principal = req.principal;
  const admin =
    principal?.role === 'admin' && principal.source === 'session'
      ? await db<AdminRow>(TABLES.Admin).where({ id: principal.adminId, tenantId }).first(['email'])
      : undefined;
  await recordLocationDeclaration(db, {
    subjectKind: 'tenant',
    subjectId: tenantId,
    tenantId,
    country: body.data.country,
    outsideOccupiedRegions: body.data.outsideOccupiedRegions ?? null,
    ipCountry: check.ipCountry,
    source: 'prompt',
    declaredByEmail: admin?.email ?? null,
  });

  if (!check.ok) {
    const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first(['displayName', 'slug']);
    await sendOpsEmail(
      db,
      opsBrandCountryNotServedEmail(
        tenant?.displayName ?? tenantId,
        tenant?.slug ?? tenantId,
        body.data.country,
        check.via,
        opsConsoleUrl(),
      ),
      'ops_brand_country_not_served',
    );
    return res.status(countryAccessStatus(check.error)).json({ error: check.error });
  }
  res.json({ ok: true, country: body.data.country });
});
