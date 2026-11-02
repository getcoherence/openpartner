import { Router } from 'express';
import { utcDateTime, z } from '../zod.js';
import { ulid } from 'ulid';
import { TABLES, type ProgramRow, type LinkRow } from '@openpartner/db';
import { grantScope, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { destinationUrlSchema, destinationWarnings } from '../destination-url.js';
import { LINK_RESULTS_VERSION, linkResults } from '../link-results.js';

export const createSchema = z.object({
  linkKey: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, 'linkKey must be url-safe'),
  programId: z.string().min(1),
  /** Optional override of Campaign.destinationUrl. Allowed only when
   *  the Campaign has deepLinkAllowedDomains set AND the override host
   *  matches one of those domains. Otherwise rejected with
   *  destination_override_not_allowed. May carry the {click_id} macro,
   *  as Program.destinationUrl may. */
  destinationUrl: destinationUrlSchema.optional(),
});

export const linksRouter = Router();

linksRouter.get('/partners/:id/links', requireAuth, grantScope('links:read'), requirePartnerOrAdmin('id'), async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const links = await db<LinkRow>(TABLES.Link)
    .where({ tenantId, partnerId: req.params.id })
    .orderBy('createdAt', 'desc');
  res.json({ links });
});

linksRouter.post('/partners/:id/links', requireAuth, grantScope('links:write'), requirePartnerOrAdmin('id'), async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = createSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const partner = await db(TABLES.Partner).where({ id: req.params.id, tenantId }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });

  const campaign = await db<ProgramRow>(TABLES.Program).where({ id: body.data.programId, tenantId }).first();
  if (!campaign) return res.status(404).json({ error: 'campaign_not_found' });

  // Lifecycle gate: scheduled or ended campaigns refuse new Link
  // creation. Existing Links keep redirecting (URLs intact); only the
  // create path is gated. Admins are subject to the same rule — if
  // they want to make Links for an ended campaign they extend the
  // endsAt first.
  const { campaignAcceptsNewActivity, campaignStatus } = await import('../campaign-lifecycle.js');
  if (!campaignAcceptsNewActivity(campaign)) {
    return res.status(409).json({
      error: 'campaign_not_active',
      detail: `Campaign is ${campaignStatus(campaign)} — Links can be created only while the campaign is active.`,
    });
  }

  // Partner-side: must be granted access to this Campaign via
  // PartnerCampaign. Admins acting on a partner's behalf bypass this
  // check (they're the ones who'd grant it anyway).
  if (req.principal?.role === 'partner') {
    const grant = await db(TABLES.PartnerProgram)
      .where({ tenantId, partnerId: req.params.id, programId: body.data.programId })
      .first();
    if (!grant) {
      return res.status(403).json({
        error: 'campaign_not_granted',
        detail: 'You don’t have access to this program. Apply through the Network or ask the brand admin to add you.',
      });
    }
  }

  // Destination resolution: if the partner supplied an override, the
  // Campaign must allow deep-linking AND the override host must match
  // the allowlist. Otherwise the Link inherits Campaign.destinationUrl
  // (stored as null on the row → router resolves at click time).
  let destinationOverride: string | null = null;
  if (body.data.destinationUrl) {
    if (!isDeepLinkAllowed(campaign, body.data.destinationUrl)) {
      return res.status(400).json({
        error: 'destination_override_not_allowed',
        detail: campaign.deepLinkAllowedDomains
          ? `Override must be on one of: ${campaign.deepLinkAllowedDomains}`
          : 'This program does not allow custom destinations.',
      });
    }
    destinationOverride = body.data.destinationUrl;
  }

  const id = ulid();
  try {
    const [link] = await db<LinkRow>(TABLES.Link)
      .insert({
        id,
        tenantId,
        linkKey: body.data.linkKey,
        partnerId: req.params.id,
        programId: body.data.programId,
        destinationUrl: destinationOverride,
      })
      .returning('*');
    res.status(201).json({ ...link, ...destinationWarnings(destinationOverride) });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'linkKey_taken' });
    }
    throw err;
  }
});

const DAY_MS = 24 * 60 * 60 * 1000;
/** Longest click window a results read takes (the Network asks for 90
 *  days after delivery, plus whatever ran before it). */
const MAX_CLICK_WINDOW_DAYS = 400;
/** Longest conversion tail after the click window: a year-long attribution
 *  window and some. With the click window it bounds the daily series. */
const MAX_CONVERSION_TAIL_DAYS = 400;

export const linkResultsQuerySchema = z
  .object({
    clickSince: utcDateTime(),
    clickUntil: utcDateTime(),
    /** The end an earlier read returned. Passed back so a later change to
     *  the program's attribution window doesn't move a report. Defaults to
     *  clickUntil plus the program's attributionWindowDays. */
    conversionUntil: utcDateTime().optional(),
  })
  .refine((q) => Date.parse(q.clickSince) <= Date.parse(q.clickUntil), 'clickSince must not be after clickUntil')
  .refine(
    (q) => Date.parse(q.clickUntil) - Date.parse(q.clickSince) <= MAX_CLICK_WINDOW_DAYS * DAY_MS,
    `The click window can be at most ${MAX_CLICK_WINDOW_DAYS} days`,
  )
  .refine((q) => !q.conversionUntil || Date.parse(q.conversionUntil) >= Date.parse(q.clickUntil), 'conversionUntil must not be before clickUntil')
  .refine(
    (q) => !q.conversionUntil || Date.parse(q.conversionUntil) - Date.parse(q.clickUntil) <= MAX_CONVERSION_TAIL_DAYS * DAY_MS,
    `conversionUntil can be at most ${MAX_CONVERSION_TAIL_DAYS} days after clickUntil`,
  );

/** One link's clicks and the conversions credited to them (link-results.ts).
 *  The Network reads it for a booking's report. */
linksRouter.get(
  '/partners/:id/links/:linkId/results',
  requireAuth,
  grantScope('partners:read'),
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const q = linkResultsQuerySchema.safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: 'invalid_query', detail: q.error.flatten() });

    const partner = await db(TABLES.Partner).where({ id: req.params.id, tenantId }).first('id');
    if (!partner) return res.status(404).json({ error: 'partner_not_found' });
    // By id, or by linkKey: the Network reserves a booking link's key before
    // creating it, so after a lost response it can find the link by that key
    // (its federation key can create links but not list them).
    const link =
      (await db<LinkRow>(TABLES.Link).where({ id: req.params.linkId, tenantId, partnerId: req.params.id }).first()) ??
      (await db<LinkRow>(TABLES.Link).where({ linkKey: req.params.linkId, tenantId, partnerId: req.params.id }).first());
    if (!link) return res.status(404).json({ error: 'link_not_found' });
    const program = await db<ProgramRow>(TABLES.Program).where({ id: link.programId, tenantId }).first('attributionWindowDays');
    const attributionWindowDays = program?.attributionWindowDays ?? 0;

    const clickSince = new Date(q.data.clickSince);
    const clickUntil = new Date(q.data.clickUntil);
    const conversionUntil = q.data.conversionUntil
      ? new Date(q.data.conversionUntil)
      : new Date(clickUntil.getTime() + Math.min(attributionWindowDays, MAX_CONVERSION_TAIL_DAYS) * DAY_MS);
    const results = await linkResults(db, {
      tenantId,
      partnerId: link.partnerId,
      linkId: link.id,
      window: { clickSince, clickUntil, conversionUntil },
    });
    res.json({
      reportingVersion: LINK_RESULTS_VERSION,
      linkId: link.id,
      partnerId: link.partnerId,
      programId: link.programId,
      attributionWindowDays,
      clickSince: clickSince.toISOString(),
      clickUntil: clickUntil.toISOString(),
      conversionUntil: conversionUntil.toISOString(),
      ...results,
    });
  },
);

function isDeepLinkAllowed(campaign: ProgramRow, url: string): boolean {
  if (!campaign.deepLinkAllowedDomains) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return campaign.deepLinkAllowedDomains
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
