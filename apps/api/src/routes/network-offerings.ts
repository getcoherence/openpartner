import { Router } from 'express';
import { ulid } from 'ulid';
import { TABLES, type NetworkVendorRow, type OfferingRow } from '@openpartner/db';
import { db } from '../db.js';
import { requireAuth, requireNetworkVendor } from '../auth.js';
import { offeringCreateSchema, offeringUpdateSchema } from '../network/validation.js';

export const networkOfferingsRouter = Router();

// -------- Vendor: manage own offerings --------

networkOfferingsRouter.post('/network/offerings', requireAuth, requireNetworkVendor, async (req, res) => {
  const p = req.principal!;
  if (p.role !== 'network_vendor') return res.status(403).json({ error: 'forbidden' });

  const body = offeringCreateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const vendor = await db<NetworkVendorRow>(TABLES.NetworkVendor).where({ id: p.networkVendorId }).first();
  if (!vendor || vendor.status !== 'active') {
    return res.status(403).json({ error: 'vendor_not_active' });
  }

  const id = ulid();
  await db<OfferingRow>(TABLES.Offering).insert({
    id,
    vendorId: vendor.id,
    title: body.data.title,
    productUrl: body.data.productUrl,
    description: body.data.description ?? null,
    heroImageUrl: body.data.heroImageUrl ?? null,
    vendorCampaignId: body.data.vendorCampaignId,
    terms: body.data.terms as never, // jsonb
    published: body.data.published ?? false,
  });

  const offering = await db<OfferingRow>(TABLES.Offering).where({ id }).first();
  res.status(201).json({ offering });
});

networkOfferingsRouter.patch('/network/offerings/:id', requireAuth, requireNetworkVendor, async (req, res) => {
  const p = req.principal!;
  if (p.role !== 'network_vendor') return res.status(403).json({ error: 'forbidden' });

  const body = offeringUpdateSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const existing = await db<OfferingRow>(TABLES.Offering).where({ id: req.params.id }).first();
  if (!existing) return res.status(404).json({ error: 'offering_not_found' });
  if (existing.vendorId !== p.networkVendorId) return res.status(403).json({ error: 'not_yours' });

  const patch: Partial<OfferingRow> = { updatedAt: new Date() };
  if (body.data.title !== undefined) patch.title = body.data.title;
  if (body.data.productUrl !== undefined) patch.productUrl = body.data.productUrl;
  if (body.data.description !== undefined) patch.description = body.data.description ?? null;
  if (body.data.heroImageUrl !== undefined) patch.heroImageUrl = body.data.heroImageUrl ?? null;
  if (body.data.vendorCampaignId !== undefined) patch.vendorCampaignId = body.data.vendorCampaignId;
  if (body.data.terms !== undefined) patch.terms = body.data.terms as never;
  if (body.data.published !== undefined) patch.published = body.data.published;

  await db<OfferingRow>(TABLES.Offering).where({ id: existing.id }).update(patch);
  const fresh = await db<OfferingRow>(TABLES.Offering).where({ id: existing.id }).first();
  res.json({ offering: fresh });
});

networkOfferingsRouter.get('/network/offerings/mine', requireAuth, requireNetworkVendor, async (req, res) => {
  const p = req.principal!;
  if (p.role !== 'network_vendor') return res.status(403).json({ error: 'forbidden' });
  const offerings = await db<OfferingRow>(TABLES.Offering)
    .where({ vendorId: p.networkVendorId })
    .orderBy('createdAt', 'desc');
  res.json({ offerings });
});

// -------- Public: browse the directory --------

networkOfferingsRouter.get('/network/directory/offerings', async (_req, res) => {
  const rows = (await db(TABLES.Offering)
    .join(TABLES.NetworkVendor, `${TABLES.NetworkVendor}.id`, `${TABLES.Offering}.vendorId`)
    .where(`${TABLES.Offering}.published`, true)
    .andWhere(`${TABLES.NetworkVendor}.status`, 'active')
    .orderBy(`${TABLES.Offering}.createdAt`, 'desc')
    .select(
      `${TABLES.Offering}.id as id`,
      `${TABLES.Offering}.title as title`,
      `${TABLES.Offering}.description as description`,
      `${TABLES.Offering}.heroImageUrl as heroImageUrl`,
      `${TABLES.Offering}.productUrl as productUrl`,
      `${TABLES.Offering}.terms as terms`,
      `${TABLES.Offering}.createdAt as createdAt`,
      `${TABLES.NetworkVendor}.id as vendorId`,
      `${TABLES.NetworkVendor}.name as vendorName`,
      `${TABLES.NetworkVendor}.slug as vendorSlug`,
      `${TABLES.NetworkVendor}.logoUrl as vendorLogoUrl`,
      `${TABLES.NetworkVendor}.routerUrl as vendorRouterUrl`,
      `${TABLES.NetworkVendor}.instanceUrl as vendorInstanceUrl`,
    )) as Array<Record<string, unknown>>;

  res.json({ offerings: rows });
});

networkOfferingsRouter.get('/network/directory/offerings/:id', async (req, res) => {
  const row = (await db(TABLES.Offering)
    .join(TABLES.NetworkVendor, `${TABLES.NetworkVendor}.id`, `${TABLES.Offering}.vendorId`)
    .where(`${TABLES.Offering}.id`, req.params.id)
    .andWhere(`${TABLES.Offering}.published`, true)
    .andWhere(`${TABLES.NetworkVendor}.status`, 'active')
    .first(
      `${TABLES.Offering}.id as id`,
      `${TABLES.Offering}.title as title`,
      `${TABLES.Offering}.description as description`,
      `${TABLES.Offering}.heroImageUrl as heroImageUrl`,
      `${TABLES.Offering}.productUrl as productUrl`,
      `${TABLES.Offering}.terms as terms`,
      `${TABLES.Offering}.createdAt as createdAt`,
      `${TABLES.NetworkVendor}.id as vendorId`,
      `${TABLES.NetworkVendor}.name as vendorName`,
      `${TABLES.NetworkVendor}.slug as vendorSlug`,
      `${TABLES.NetworkVendor}.logoUrl as vendorLogoUrl`,
      `${TABLES.NetworkVendor}.description as vendorDescription`,
      `${TABLES.NetworkVendor}.websiteUrl as vendorWebsiteUrl`,
    )) as Record<string, unknown> | undefined;

  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json({ offering: row });
});
