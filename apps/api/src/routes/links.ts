import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type ProgramRow, type LinkRow } from '@openpartner/db';
import { grantScope, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { tenantOf } from '../tenancy.js';

const createSchema = z.object({
  linkKey: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, 'linkKey must be url-safe'),
  programId: z.string().min(1),
  /** Optional override of Campaign.destinationUrl. Allowed only when
   *  the Campaign has deepLinkAllowedDomains set AND the override host
   *  matches one of those domains. Otherwise rejected with
   *  destination_override_not_allowed. */
  destinationUrl: z.string().url().optional(),
});

export const linksRouter = Router();

linksRouter.get('/partners/:id/links', requireAuth, requirePartnerOrAdmin('id'), async (req, res) => {
  const { db } = tenantOf(req);
  const links = await db<LinkRow>(TABLES.Link)
    .where({ partnerId: req.params.id })
    .orderBy('createdAt', 'desc');
  res.json({ links });
});

linksRouter.post('/partners/:id/links', requireAuth, grantScope('links:write'), requirePartnerOrAdmin('id'), async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = createSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const partner = await db(TABLES.Partner).where({ id: req.params.id }).first();
  if (!partner) return res.status(404).json({ error: 'partner_not_found' });

  const campaign = await db<ProgramRow>(TABLES.Program).where({ id: body.data.programId }).first();
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
      .where({ partnerId: req.params.id, programId: body.data.programId })
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
    res.status(201).json(link);
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return res.status(409).json({ error: 'linkKey_taken' });
    }
    throw err;
  }
});

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
