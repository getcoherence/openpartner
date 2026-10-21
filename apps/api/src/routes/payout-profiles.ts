/**
 * A partner's payout details for the manual rail (payout-profile.ts,
 * docs/manual-payout-files.md).
 *
 * The partner edits their own in the portal; a brand admin can edit them on
 * the partner's behalf; a headless brand sets them from its own app with a
 * scoped key (`payout_profiles:write`, or `payout_profiles:read` to show
 * them). Nothing here logs a request body, and validation errors name
 * fields, never values.
 *
 * Every change or removal emails the partner (masked summary only), so a
 * hijacked account or session can't quietly redirect their payouts.
 */

import { Router, type Request } from 'express';
import {
  TABLES,
  type PartnerRow,
  type PayoutProfileUpdatedBy,
  type PayoutRailPreference,
  type TenantRow,
} from '@openpartner/db';
import { grantScope, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { afterCommit, tenantOf } from '../tenancy.js';
import { resolvePayoutMethod } from '../payout-method.js';
import {
  deletePayoutProfile,
  getPayoutProfile,
  parsePayoutDetails,
  savePayoutProfile,
  summarizeDetails,
  type OpenedPayoutProfile,
} from '../payout-profile.js';
import { getMailer } from '../mailer.js';
import { payoutDetailsChangedEmail } from '../email-templates.js';
import { resolveBrandName } from '../brand-name.js';

export { payoutDetailsSchema } from '../payout-profile.js';

export const payoutProfilesRouter = Router();

/** Who is saving: the partner, an admin in the portal, or an API key. */
function updatedByOf(req: Request): PayoutProfileUpdatedBy {
  const p = req.principal;
  if (p?.role === 'partner') return 'partner';
  if (p?.role === 'admin' && p.source === 'session') return 'admin';
  return 'api';
}

function view(profile: OpenedPayoutProfile | null) {
  if (!profile) return null;
  return {
    method: profile.method,
    country: profile.country,
    // Null when the stored details can't be opened: the partner has to
    // enter them again.
    details: profile.details,
    summary: profile.details ? summarizeDetails(profile.details) : null,
    updatedAt: profile.updatedAt,
    updatedBy: profile.updatedBy,
  };
}

/** How this partner is paid today: a manual payout (these details) or
 *  Stripe Connect (these details aren't used). `rail` is the brand's
 *  setting behind that, so the partner portal can tell "connect Stripe"
 *  from "the brand pays you itself". */
async function payoutRail(req: Request, partner: Pick<PartnerRow, 'stripeConnectAccountId'>) {
  const { db, tenantId } = tenantOf(req);
  const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first(['payoutRailPreference']);
  const rail: PayoutRailPreference = tenant?.payoutRailPreference ?? 'auto';
  return { paidVia: resolvePayoutMethod(rail, partner), rail };
}

async function findPartner(req: Request) {
  const { db, tenantId } = tenantOf(req);
  return (await db<PartnerRow>(TABLES.Partner)
    .where({ id: req.params.id, tenantId })
    .first(['id', 'name', 'email', 'activatedAt', 'portalAccess', 'stripeConnectAccountId'])) as
    | Pick<PartnerRow, 'id' | 'name' | 'email' | 'activatedAt' | 'portalAccess' | 'stripeConnectAccountId'>
    | undefined;
}

/** After commit: tell the partner (masked), unless they can't use the
 *  portal (a headless program's own app owns that conversation). */
function notifyPartner(
  req: Request,
  partner: Pick<PartnerRow, 'id' | 'name' | 'email' | 'activatedAt' | 'portalAccess'>,
  summary: string | null,
  changedBy: PayoutProfileUpdatedBy,
): void {
  if (!partner.activatedAt || partner.portalAccess === false) return;
  const { tenantId } = tenantOf(req);
  afterCommit(req, 'payout-details-changed email', async (trx) => {
    const tmpl = payoutDetailsChangedEmail({
      name: partner.name,
      brandName: await resolveBrandName(trx, tenantId),
      summary,
      changedBy,
    });
    await getMailer().send(
      { db: trx, tenantId },
      {
        to: partner.email,
        subject: tmpl.subject,
        text: tmpl.text,
        html: tmpl.html,
        tag: 'payout_details_changed',
        metadata: { purpose: 'payout_details_changed', partnerId: partner.id },
      },
    );
  });
}

payoutProfilesRouter.get(
  '/partners/:id/payout-profile',
  requireAuth,
  grantScope('payout_profiles:read', 'payout_profiles:write'),
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const partner = await findPartner(req);
    if (!partner) return res.status(404).json({ error: 'partner_not_found' });
    const profile = await getPayoutProfile(db, tenantId, partner.id);
    res.json({ profile: view(profile), ...(await payoutRail(req, partner)) });
  },
);

payoutProfilesRouter.put(
  '/partners/:id/payout-profile',
  requireAuth,
  grantScope('payout_profiles:write'),
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const parsed = parsePayoutDetails(req.body);
    if (!parsed.ok) return res.status(400).json({ error: 'invalid_body', detail: parsed.error });
    const partner = await findPartner(req);
    if (!partner) return res.status(404).json({ error: 'partner_not_found' });
    const updatedBy = updatedByOf(req);
    const profile = await savePayoutProfile(db, tenantId, partner.id, parsed.details, updatedBy);
    notifyPartner(req, partner, summarizeDetails(parsed.details), updatedBy);
    res.json({ profile: view(profile), ...(await payoutRail(req, partner)) });
  },
);

payoutProfilesRouter.delete(
  '/partners/:id/payout-profile',
  requireAuth,
  grantScope('payout_profiles:write'),
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const partner = await findPartner(req);
    if (!partner) return res.status(404).json({ error: 'partner_not_found' });
    if (!(await deletePayoutProfile(db, tenantId, partner.id))) {
      return res.status(404).json({ error: 'payout_profile_not_found' });
    }
    notifyPartner(req, partner, null, updatedByOf(req));
    res.status(204).send();
  },
);
