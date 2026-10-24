/**
 * Two-tier recruitment (recruiter-commissions.ts, docs/two-tier-commissions.md).
 *
 *   GET /partners/:id/recruits  partner (own only), admin, or a key with
 *                               partners:read: the partner's recruit link,
 *                               the programs that pay a recruiter share, who
 *                               recruited them, and their recruits with what
 *                               each has earned them.
 *
 * The recruit link is the join page with `?ref=<recruitCode>`. The code is
 * minted the first time this is read while some program pays a recruiter
 * share; with none, nothing is minted and the link is null.
 *
 * A partner sees only the programs they're granted, so a private program
 * stays private; an admin sees every program that pays a share.
 */

import { Router } from 'express';
import { TABLES, type PartnerRow, type ProgramRow } from '@openpartner/db';
import { grantScope, requireAuth, requirePartnerOrAdmin } from '../auth.js';
import { campaignAcceptsNewActivity } from '../campaign-lifecycle.js';
import { getPortalBaseUrl, linkTenantOf } from '../portal-url.js';
import { ensureRecruitCode, listRecruits, RECRUITS_LIMIT } from '../recruiter-commissions.js';
import { tenantOf } from '../tenancy.js';
import { readSignupSettings } from './partner-signup.js';

export const recruitsRouter = Router();

type RecruiterProgram = Pick<
  ProgramRow,
  'id' | 'name' | 'recruiterCommissionPercent' | 'recruiterCommissionMonths' | 'startsAt' | 'endsAt'
>;

recruitsRouter.get(
  '/partners/:id/recruits',
  requireAuth,
  grantScope('partners:read'),
  requirePartnerOrAdmin('id'),
  async (req, res) => {
    const { db, tenantId } = tenantOf(req);
    const partner = (await db<PartnerRow>(TABLES.Partner).where({ tenantId, id: req.params.id }).first()) as
      | PartnerRow
      | undefined;
    if (!partner) return res.status(404).json({ error: 'not_found' });
    const asPartner = req.principal?.role === 'partner';

    const P = TABLES.Program;
    const query = db(P)
      .where(`${P}.tenantId`, tenantId)
      .whereNotNull(`${P}.recruiterCommissionPercent`)
      .orderBy(`${P}.createdAt`, 'desc')
      .select(
        `${P}.id`,
        `${P}.name`,
        `${P}.recruiterCommissionPercent`,
        `${P}.recruiterCommissionMonths`,
        `${P}.startsAt`,
        `${P}.endsAt`,
      );
    if (asPartner) {
      query
        .join(TABLES.PartnerProgram, `${TABLES.PartnerProgram}.programId`, `${P}.id`)
        .where(`${TABLES.PartnerProgram}.tenantId`, tenantId)
        .where(`${TABLES.PartnerProgram}.partnerId`, partner.id);
    }
    // A partner recruits for programs that are running; an admin also sees
    // scheduled and ended ones, as on the programs list.
    const programs = ((await query) as RecruiterProgram[]).filter((p) => !asPartner || campaignAcceptsNewActivity(p));

    const recruitCode =
      programs.length > 0 && !partner.revokedAt ? await ensureRecruitCode(db, tenantId, partner.id) : partner.recruitCode;
    const signup = await readSignupSettings(db, tenantId);

    let recruitedBy: { id: string; name: string; recruitedAt: string } | null = null;
    if (partner.recruitedByPartnerId && partner.recruitedAt) {
      const recruiter = (await db<PartnerRow>(TABLES.Partner)
        .where({ tenantId, id: partner.recruitedByPartnerId })
        .first('id', 'name')) as Pick<PartnerRow, 'id' | 'name'> | undefined;
      if (recruiter) {
        recruitedBy = { id: recruiter.id, name: recruiter.name, recruitedAt: new Date(partner.recruitedAt).toISOString() };
      }
    }

    const { recruits, total } = await listRecruits(db, tenantId, partner.id);
    res.json({
      partnerId: partner.id,
      recruitCode,
      // Null while no program pays a recruiter share, or the partner is revoked.
      recruitUrl:
        recruitCode && programs.length > 0 && !partner.revokedAt
          ? `${getPortalBaseUrl(linkTenantOf(req))}/join?ref=${encodeURIComponent(recruitCode)}`
          : null,
      // The join page is closed: the link opens a page that says so.
      signupOpen: !signup.disabled,
      programs: programs.map((p) => ({
        id: p.id,
        name: p.name,
        recruiterCommissionPercent: Number(p.recruiterCommissionPercent),
        recruiterCommissionMonths: p.recruiterCommissionMonths,
      })),
      recruitedBy,
      recruits,
      total,
      limit: RECRUITS_LIMIT,
    });
  },
);
