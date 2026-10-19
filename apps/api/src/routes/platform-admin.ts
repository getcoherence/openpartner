/**
 * Platform-ops console API: brand review (approve / reject / reinstate),
 * the signup blocklist, and an audit trail — plus the operator's own
 * magic-link auth.
 *
 * These routes are mounted BEFORE tenantMiddleware (no /t/<slug>/ prefix)
 * and use the privileged `db` pool directly: brand review is inherently
 * cross-tenant, and the platform-scoped tables (PlatformAdmin*, Signup-
 * Blocklist, PlatformAuditLog) live outside per-tenant RLS. The same
 * pattern the existing platform-auth + signup routes use.
 *
 * Auth model:
 *   - An operator is a PlatformAdmin row (role 'support' | 'admin').
 *   - Bootstrap: any email in PLATFORM_ADMIN_EMAILS may sign in and is
 *     upserted as role='admin' on first verify (so a fresh install has a
 *     way in without a seed script).
 *   - requirePlatformAdmin gates every console route; write actions
 *     additionally require role='admin' (support is read-only, matching
 *     the PlatformAdmin contract).
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  DEFAULT_TENANT_ID,
  TABLES,
  isCountryCode,
  type AdminRow,
  type PlatformAdminRow,
  type PartnerRow,
  type PlatformAuditLogRow,
  type ProgramRow,
  type SanctionsScreeningRow,
  type SignupBlocklistRow,
  type TenantRow,
} from '@openpartner/db';
import { db } from '../db.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { clearSessionCookie, consumeMagicLink, issueMagicLink } from '../auth-sessions.js';
import { getMailer } from '../mailer.js';
import { marketplacePolicyWarningEmail, platformAdminSigninEmail } from '../email-templates.js';
import { getPortalBaseUrl } from '../portal-url.js';
import { getTenancyMode } from '../tenancy.js';
import {
  COUNTRY_ACCESS_DEFAULTS,
  getCountryAccessSettings,
  latestDeclaredCountries,
  setCountryAccessSettings,
} from '../country-access.js';
import {
  addBlocklistEntry,
  approveBrand,
  blockProgram,
  type OpsActor,
  rejectBrand,
  unblockProgram,
  writeAudit,
} from '../brand-review.js';
import {
  adminBlockCreator,
  adminListCreators,
  adminListVendors,
  adminRemindCreator,
  adminRunCreatorReminders,
  adminSetFeaturedVendors,
  adminSetVendorReview,
  adminUnblockCreator,
  adminVendorReviewQueue,
  NetworkAdminError,
  platformNetworkUrl,
} from '../network-client.js';
import { linkVendorsToTenants } from '../network-review-reconcile.js';
import {
  MATCH_SCORE_THRESHOLD,
  cslConfigured,
  latestScreenings,
  listHeldPartners,
  reviewScreening,
  screenTenant,
  screeningReviewQueue,
} from '../sanctions-screening.js';
import { brandSetupFor } from '../brand-setup.js';
import { brandReminderHistory, remindBrandNow, runBrandSetupReminders } from '../brand-setup-reminders.js';
import {
  getFeeRuleSettings,
  getNotificationSettings,
  setFeeRuleSettings,
  setNotificationSettings,
} from '../platform-settings.js';
import { METER_RATES, NOTICE_DAYS } from '../fee-terms.js';
import { previewPricingNotices, sendPricingNotices } from '../fee-notice.js';
import {
  ContractTermsError,
  contractStatement,
  estimateFeeImpact,
  listFeeTenants,
  reviewSignals,
  setContractTerms,
} from '../fee-review.js';
import { FxUnavailableError } from '../fx.js';
import { resolveBrandName } from '../brand-name.js';
import {
  createPlatformAdminSession,
  PLATFORM_ADMIN_SESSION_COOKIE,
  platformAdminSessionCookieOptions,
  resolvePlatformAdminSession,
  revokePlatformAdminSession,
} from '../platform-admin-sessions.js';

export const platformAdminRouter = Router();

// The ops console is a hosted/multi-tenant concept — in single-tenant
// self-host there is exactly one brand and nothing to review. Gate ONLY
// this router's own paths (it's mounted at app root, so every request flows
// through here; a blanket guard would 404 the whole API). Non-ours requests
// fall straight through.
platformAdminRouter.use((req, res, next) => {
  const p = req.path;
  const isOurs = p.startsWith('/platform-admin') || p === '/auth/platform-admin-verify';
  if (!isOurs) return next();
  if (getTenancyMode() !== 'multi') return void res.status(404).json({ error: 'not_available_in_single_tenant' });
  next();
});

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requirePlatformAdmin — the authenticated operator. */
      platformAdminActor?: OpsActor;
    }
  }
}

// --------------------------------------------------------------------------
// Bootstrap allowlist
// --------------------------------------------------------------------------

function envAdminEmails(): Set<string> {
  return new Set(
    (process.env.PLATFORM_ADMIN_EMAILS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** May this email sign in to the ops console? True if it has a live
 *  PlatformAdmin row OR is listed in PLATFORM_ADMIN_EMAILS. */
export async function isAllowedOperator(email: string): Promise<boolean> {
  const existing = await db<PlatformAdminRow>(TABLES.PlatformAdmin).where({ email }).first();
  if (existing && !existing.revokedAt) return true;
  return envAdminEmails().has(email);
}

/** Ensure a live PlatformAdmin row for this email at verify time. Creates
 *  one (role='admin') for env-bootstrapped operators; clears a stale
 *  revocation when the email is still env-listed. Returns the row. */
async function ensurePlatformAdmin(email: string): Promise<PlatformAdminRow | null> {
  const existing = await db<PlatformAdminRow>(TABLES.PlatformAdmin).where({ email }).first();
  const envAllowed = envAdminEmails().has(email);
  if (existing) {
    if (existing.revokedAt && envAllowed) {
      await db<PlatformAdminRow>(TABLES.PlatformAdmin).where({ id: existing.id }).update({ revokedAt: null });
      return { ...existing, revokedAt: null };
    }
    return existing.revokedAt ? null : existing;
  }
  if (!envAllowed) return null;
  const row: PlatformAdminRow = {
    id: ulid(),
    email,
    name: email.split('@')[0]!,
    role: 'admin',
    createdAt: new Date(),
    revokedAt: null,
  };
  await db<PlatformAdminRow>(TABLES.PlatformAdmin).insert(row);
  return row;
}

// --------------------------------------------------------------------------
// Middleware
// --------------------------------------------------------------------------

function readSessionCookie(req: Request): string | null {
  return (req as unknown as { cookies?: Record<string, string> }).cookies?.[PLATFORM_ADMIN_SESSION_COOKIE] ?? null;
}

export async function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const cookie = readSessionCookie(req);
  if (!cookie) return void res.status(401).json({ error: 'no_platform_admin_session' });
  const resolved = await resolvePlatformAdminSession(db, cookie);
  if (!resolved) return void res.status(401).json({ error: 'invalid_or_expired_session' });
  req.platformAdmin = true;
  req.platformAdminActor = { id: resolved.admin.id, email: resolved.admin.email, role: resolved.admin.role };
  next();
}

/** Write actions require role='admin'. 'support' operators are read-only. */
function requirePlatformAdminWrite(req: Request, res: Response, next: NextFunction): void {
  if (req.platformAdminActor?.role !== 'admin') {
    return void res.status(403).json({ error: 'read_only_operator' });
  }
  next();
}

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------

const signinLimit = ipRateLimit({ name: 'platform-admin-signin', max: 10, windowMs: 60_000 });
const signinSchema = z.object({ email: z.string().trim().email().max(254) });

/** Request an ops sign-in link. Always 200 (no operator enumeration). */
platformAdminRouter.post('/platform-admin/signin', signinLimit, async (req, res) => {
  const body = signinSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_email' });
  const email = body.data.email.toLowerCase();

  if (await isAllowedOperator(email)) {
    try {
      const issued = await issueMagicLink(db, {
        // Platform tokens aren't tenant-scoped; DEFAULT_TENANT_ID is a
        // placeholder on the privileged pool (RLS bypassed).
        tenantId: DEFAULT_TENANT_ID,
        email,
        purpose: 'platform_admin_signin',
        principalKind: 'platform',
        principalId: email,
      });
      const link = `${getPortalBaseUrl()}/platform/auth?token=${encodeURIComponent(issued.plaintext)}`;
      const tmpl = platformAdminSigninEmail(link);
      await getMailer().send({ db, tenantId: DEFAULT_TENANT_ID }, {
        to: email,
        subject: tmpl.subject,
        text: tmpl.text,
        html: tmpl.html,
        tag: 'platform_admin_signin',
        metadata: { channel: 'platform_ops', email },
        platform: true,
      });
    } catch (err) {
      console.error('[platform-admin] signin mail failed', err);
    }
  }
  res.json({ ok: true });
});

const verifySchema = z.object({ token: z.string().min(8) });

platformAdminRouter.post('/auth/platform-admin-verify', async (req, res) => {
  const body = verifySchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body' });

  const consumed = await consumeMagicLink(db, body.data.token);
  if (!consumed) return res.status(400).json({ error: 'invalid_or_expired_token' });
  const token = consumed.token;
  if (token.purpose !== 'platform_admin_signin' || token.principalKind !== 'platform') {
    return res.status(400).json({ error: 'wrong_token_kind' });
  }

  const email = (token.email || token.principalId).toLowerCase();
  const admin = await ensurePlatformAdmin(email);
  if (!admin) return res.status(403).json({ error: 'not_an_operator' });

  const session = await createPlatformAdminSession(db, admin);
  res.cookie(PLATFORM_ADMIN_SESSION_COOKIE, session.plaintext, platformAdminSessionCookieOptions());
  res.json({ ok: true, email: admin.email, role: admin.role });
});

platformAdminRouter.post('/platform-admin/signout', async (req, res) => {
  const cookie = readSessionCookie(req);
  if (cookie) await revokePlatformAdminSession(db, cookie);
  clearSessionCookie(res, PLATFORM_ADMIN_SESSION_COOKIE, platformAdminSessionCookieOptions());
  res.json({ ok: true });
});

platformAdminRouter.get('/platform-admin/me', requirePlatformAdmin, (req, res) => {
  const actor = req.platformAdminActor!;
  res.json({ email: actor.email, role: actor.role });
});

// --------------------------------------------------------------------------
// Brand review
// --------------------------------------------------------------------------

const listSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** List brands for review, newest first, annotated with the primary admin
 *  email. Defaults to the pending queue. */
platformAdminRouter.get('/platform-admin/brands', requirePlatformAdmin, async (req, res) => {
  const q = listSchema.safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: 'invalid_query' });
  const status = q.data.status ?? 'pending';
  const limit = q.data.limit ?? 100;

  let query = db<TenantRow>(TABLES.Tenant).orderBy('createdAt', 'desc').limit(limit);
  if (status !== 'all') query = query.where({ approvalStatus: status });
  const tenants = await query.select(
    'id',
    'slug',
    'displayName',
    'approvalStatus',
    'status',
    'approvalReason',
    'reviewedAt',
    'reviewedByEmail',
    'billingPlan',
    'createdAt',
    'metadata',
  );

  // Primary (oldest, non-revoked) admin email per tenant.
  const ids = tenants.map((t) => t.id);
  const admins = ids.length
    ? await db<AdminRow>(TABLES.Admin)
        .whereIn('tenantId', ids)
        .whereNull('revokedAt')
        .orderBy('createdAt', 'asc')
        .select('tenantId', 'email', 'name')
    : [];
  const primaryByTenant = new Map<string, { email: string; name: string }>();
  for (const a of admins) {
    if (!primaryByTenant.has(a.tenantId)) primaryByTenant.set(a.tenantId, { email: a.email, name: a.name });
  }

  // Program counts per tenant — a quick "how much is set up" + "any blocked"
  // signal for the queue without expanding each card.
  const programCounts = ids.length
    ? ((await db(TABLES.Program)
        .whereIn('tenantId', ids)
        .groupBy('tenantId')
        .select('tenantId')
        .count({ total: '*' })
        .count({ blocked: db.raw('case when "blockedAt" is not null then 1 end') })) as Array<{
        tenantId: string;
        total: string | number;
        blocked: string | number;
      }>)
    : [];
  const countsByTenant = new Map(programCounts.map((r) => [r.tenantId, r]));
  // Where each brand says it's based — the reviewer's sanctions check.
  const locations = await latestDeclaredCountries(db, 'tenant', ids);
  // The latest Consolidated Screening List answer for each name screened.
  const screenings = await latestScreenings(db, 'tenant', ids);

  // Setup progress, reminder history, and the latest policy warning — so an
  // operator sees "stalled at tracking, reminded twice, warned on the 3rd"
  // without opening anything.
  const setups = await brandSetupFor(db, ids);
  const reminders = await brandReminderHistory(db, ids);
  const warnings = ids.length
    ? ((await db<PlatformAuditLogRow>(TABLES.PlatformAuditLog)
        .where({ action: 'brand.policy_warning', targetType: 'tenant' })
        .whereIn('targetId', ids)
        .orderBy('createdAt', 'desc')
        .select('targetId', 'createdAt', 'detail')) as Array<Pick<PlatformAuditLogRow, 'targetId' | 'createdAt' | 'detail'>>)
    : [];
  const lastWarningBy = new Map<string, { at: Date; deadline: string | null }>();
  for (const w of warnings) {
    if (w.targetId && !lastWarningBy.has(w.targetId)) {
      const deadline = (w.detail as { deadline?: unknown } | null)?.deadline;
      lastWarningBy.set(w.targetId, { at: w.createdAt, deadline: typeof deadline === 'string' ? deadline : null });
    }
  }

  res.json({
    brands: tenants.map((t) => ({
      id: t.id,
      slug: t.slug,
      displayName: t.displayName,
      approvalStatus: t.approvalStatus,
      status: t.status,
      approvalReason: t.approvalReason,
      reviewedAt: t.reviewedAt,
      reviewedByEmail: t.reviewedByEmail,
      billingPlan: t.billingPlan,
      createdAt: t.createdAt,
      createdBy: (t.metadata as { createdBy?: string } | null)?.createdBy ?? null,
      adminEmail: primaryByTenant.get(t.id)?.email ?? null,
      adminName: primaryByTenant.get(t.id)?.name ?? null,
      programCount: Number(countsByTenant.get(t.id)?.total ?? 0),
      blockedProgramCount: Number(countsByTenant.get(t.id)?.blocked ?? 0),
      setupComplete: setups.get(t.id)?.complete ?? false,
      setupMissing: setups.get(t.id)?.missing ?? [],
      setupRemindersSent: reminders.get(t.id)?.sent ?? 0,
      lastSetupReminderAt: reminders.get(t.id)?.lastSentAt ?? null,
      lastPolicyWarningAt: lastWarningBy.get(t.id)?.at ?? null,
      policyWarningDeadline: lastWarningBy.get(t.id)?.deadline ?? null,
      country: locations.get(t.id)?.country ?? null,
      ipCountryAtDeclaration: locations.get(t.id)?.ipCountry ?? null,
      screenings: (screenings.get(t.id) ?? []).map(screeningView),
    })),
  });
});

/** A SanctionsScreening row as the console shows it. */
function screeningView(r: SanctionsScreeningRow) {
  return {
    id: r.id,
    subjectKind: r.subjectKind,
    subjectId: r.subjectId,
    tenantId: r.tenantId,
    screenedName: r.screenedName,
    country: r.country,
    result: r.result,
    matches: r.matches,
    errorDetail: r.errorDetail,
    trigger: r.trigger,
    screenedAt: r.screenedAt,
    decision: r.decision,
    reviewedByEmail: r.reviewedByEmail,
    reviewedAt: r.reviewedAt,
    reviewNote: r.reviewNote,
    decisionCarried: r.decisionCarriedFromId != null,
  };
}

async function loadTenant(id: string): Promise<TenantRow | null> {
  const row = await db<TenantRow>(TABLES.Tenant).where({ id }).first();
  return row ?? null;
}

platformAdminRouter.post(
  '/platform-admin/brands/:id/approve',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const tenant = await loadTenant(req.params.id!);
    if (!tenant) return res.status(404).json({ error: 'brand_not_found' });
    const reinstate = tenant.approvalStatus === 'rejected';
    await approveBrand(db, tenant, req.platformAdminActor!, { reinstate });
    res.json({ ok: true, approvalStatus: 'approved' });
  },
);

const rejectSchema = z.object({
  reason: z.string().trim().max(1000).optional(),
  /** Send the brand a rejection email. Default false — spam/phishing
   *  rejections stay silent so we don't tip them off. */
  notifyBrand: z.boolean().optional(),
  banEmail: z.boolean().optional(),
  banDomain: z.boolean().optional(),
});

platformAdminRouter.post(
  '/platform-admin/brands/:id/reject',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const body = rejectSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body' });
    const tenant = await loadTenant(req.params.id!);
    if (!tenant) return res.status(404).json({ error: 'brand_not_found' });
    const result = await rejectBrand(db, tenant, req.platformAdminActor!, {
      reason: body.data.reason ?? null,
      notifyBrand: body.data.notifyBrand ?? false,
      banEmail: body.data.banEmail ?? false,
      banDomain: body.data.banDomain ?? false,
    });
    res.json({ ok: true, approvalStatus: 'rejected', ...result });
  },
);

/** Reinstate is approve on a rejected brand — kept as a distinct verb for
 *  the audit log + an explicit UI affordance. */
platformAdminRouter.post(
  '/platform-admin/brands/:id/reinstate',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const tenant = await loadTenant(req.params.id!);
    if (!tenant) return res.status(404).json({ error: 'brand_not_found' });
    await approveBrand(db, tenant, req.platformAdminActor!, { reinstate: true });
    res.json({ ok: true, approvalStatus: 'approved' });
  },
);

// --------------------------------------------------------------------------
// Program moderation (per-program takedown; the brand stays live)
// --------------------------------------------------------------------------

/** List a brand's programs for review. destinationUrl is the phishing tell —
 *  a cloaked/scam landing page shows here even when the brand itself looks
 *  legit. Annotated with the partner-link count (reach) + block state. */
platformAdminRouter.get('/platform-admin/brands/:id/programs', requirePlatformAdmin, async (req, res) => {
  const tenant = await loadTenant(req.params.id!);
  if (!tenant) return res.status(404).json({ error: 'brand_not_found' });

  const programs = await db<ProgramRow>(TABLES.Program)
    .where({ tenantId: tenant.id })
    .orderBy('createdAt', 'desc')
    .select(
      'id',
      'name',
      'destinationUrl',
      'deepLinkAllowedDomains',
      'marketplaceDescription',
      'marketplaceCoverUrl',
      'marketplaceVideoUrl',
      'categories',
      'shareOnNetwork',
      'endsAt',
      'blockedAt',
      'blockedReason',
      'blockedByEmail',
      'createdAt',
    );

  const ids = programs.map((p) => p.id);
  const linkRows = ids.length
    ? ((await db(TABLES.Link)
        .whereIn('programId', ids)
        .groupBy('programId')
        .select('programId')
        .count({ n: '*' })) as Array<{ programId: string; n: string | number }>)
    : [];
  const linkCountByProgram = new Map(linkRows.map((r) => [r.programId, Number(r.n)]));

  res.json({
    brand: { id: tenant.id, slug: tenant.slug, displayName: tenant.displayName },
    programs: programs.map((p) => ({ ...p, linkCount: linkCountByProgram.get(p.id) ?? 0 })),
  });
});

async function loadProgram(id: string): Promise<ProgramRow | null> {
  const row = await db<ProgramRow>(TABLES.Program).where({ id }).first();
  return row ?? null;
}

const blockProgramSchema = z.object({ reason: z.string().trim().max(1000).optional() });

platformAdminRouter.post(
  '/platform-admin/programs/:id/block',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const body = blockProgramSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body' });
    const program = await loadProgram(req.params.id!);
    if (!program) return res.status(404).json({ error: 'program_not_found' });
    await blockProgram(db, program, req.platformAdminActor!, body.data.reason ?? null);
    res.json({ ok: true, blocked: true });
  },
);

platformAdminRouter.post(
  '/platform-admin/programs/:id/unblock',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const program = await loadProgram(req.params.id!);
    if (!program) return res.status(404).json({ error: 'program_not_found' });
    await unblockProgram(db, program, req.platformAdminActor!);
    res.json({ ok: true, blocked: false });
  },
);

// --------------------------------------------------------------------------
// Creator (partner) moderation — Network-owned, so these proxy the Network's
// admin API with NETWORK_ADMIN_API_KEY.
// --------------------------------------------------------------------------
//
// A creator is ONE identity across every brand on the Network, so blocking
// one is a network-level act. (A brand removing a partner from its own
// roster is the separate, tenant-scoped POST /partners/:id/revoke.)
// Blocking hides them from marketplace discovery + their public profile and
// logs them out everywhere.

/** Resolve the Network origin, or 503 with an actionable message. */
function networkOr503(res: Response): string | null {
  const url = platformNetworkUrl();
  if (!url) {
    res.status(503).json({
      error: 'network_not_configured',
      detail: 'NETWORK_URL is not set — creator moderation lives on the Network coordinator.',
    });
    return null;
  }
  return url;
}

function networkErrorBody(err: unknown): { error: string; detail: string } {
  const detail = err instanceof Error ? err.message : String(err);
  return { error: 'network_call_failed', detail };
}

platformAdminRouter.get('/platform-admin/creators', requirePlatformAdmin, async (_req, res) => {
  const networkUrl = networkOr503(res);
  if (!networkUrl) return;
  try {
    const creators = await adminListCreators(networkUrl);
    res.json({ creators });
  } catch (err) {
    res.status(502).json(networkErrorBody(err));
  }
});

const blockCreatorSchema = z.object({ reason: z.string().trim().min(1).max(500) });

platformAdminRouter.post(
  '/platform-admin/creators/:id/block',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const body = blockCreatorSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
    const networkUrl = networkOr503(res);
    if (!networkUrl) return;
    const actor = req.platformAdminActor!;
    try {
      await adminBlockCreator(networkUrl, req.params.id!, body.data.reason, actor.email);
    } catch (err) {
      return res.status(502).json(networkErrorBody(err));
    }
    await writeAudit(db, {
      actor,
      action: 'creator.block',
      targetType: 'creator',
      targetId: req.params.id!,
      detail: { reason: body.data.reason },
    });
    res.json({ ok: true, blocked: true });
  },
);

platformAdminRouter.post(
  '/platform-admin/creators/:id/unblock',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const networkUrl = networkOr503(res);
    if (!networkUrl) return;
    const actor = req.platformAdminActor!;
    try {
      await adminUnblockCreator(networkUrl, req.params.id!);
    } catch (err) {
      return res.status(502).json(networkErrorBody(err));
    }
    await writeAudit(db, {
      actor,
      action: 'creator.unblock',
      targetType: 'creator',
      targetId: req.params.id!,
      detail: {},
    });
    res.json({ ok: true, blocked: false });
  },
);

// --------------------------------------------------------------------------
// Marketplace featured placement — Network-owned (the Network decides what
// the marketplace lists), so these proxy its admin API too.
// --------------------------------------------------------------------------

/** Every Network vendor with its listing + featured state. The console
 *  narrows this to what's actually on the marketplace. */
platformAdminRouter.get('/platform-admin/marketplace', requirePlatformAdmin, async (_req, res) => {
  const networkUrl = networkOr503(res);
  if (!networkUrl) return;
  try {
    const vendors = await adminListVendors(networkUrl);
    res.json({ vendors });
  } catch (err) {
    res.status(502).json(networkErrorBody(err));
  }
});

const featuredSchema = z.object({
  /** The whole featured list in display order; anything left out is
   *  unfeatured. Mirrors the Network's PUT /admin/featured-vendors. */
  vendors: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        until: z.string().datetime({ offset: true }).nullable().optional(),
      }),
    )
    .max(24)
    .refine((v) => new Set(v.map((x) => x.id)).size === v.length, { message: 'duplicate vendor id' }),
});

platformAdminRouter.put(
  '/platform-admin/marketplace/featured',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const body = featuredSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
    const networkUrl = networkOr503(res);
    if (!networkUrl) return;
    const vendors = body.data.vendors.map((v) => ({ id: v.id, until: v.until ?? null }));
    try {
      await adminSetFeaturedVendors(networkUrl, vendors);
    } catch (err) {
      if (err instanceof NetworkAdminError && err.code && err.status < 500) {
        return res.status(err.status).json({ error: err.code });
      }
      return res.status(502).json(networkErrorBody(err));
    }
    await writeAudit(db, {
      actor: req.platformAdminActor!,
      action: 'marketplace.featured',
      targetType: 'platform',
      detail: { vendors },
    });
    res.json({ ok: true });
  },
);

// --------------------------------------------------------------------------
// Network vendor review queue
// --------------------------------------------------------------------------
//
// Self-hosted openpartner instances federate with the Network by email
// verify, and land in the Network's review queue: nothing they publish is
// discoverable until an operator approves them here. Vendors that are our
// own hosted brands are listed too, but read-only — their review mirrors
// brand approval (Brands tab), and the network-review-reconcile job would
// overwrite any decision made here within 15 minutes.

platformAdminRouter.get('/platform-admin/network-vendors', requirePlatformAdmin, async (_req, res) => {
  const networkUrl = networkOr503(res);
  if (!networkUrl) return;
  let vendors;
  try {
    vendors = await adminVendorReviewQueue(networkUrl);
  } catch (err) {
    return res.status(502).json(networkErrorBody(err));
  }
  const { links } = await linkVendorsToTenants(networkUrl, vendors);
  res.json({
    vendors: vendors.map((v) => {
      const link = links.get(v.id);
      return {
        ...v,
        managedBy: link ? { tenantId: link.tenantId, slug: link.slug, displayName: link.displayName } : null,
      };
    }),
  });
});

const vendorReviewSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  /** Stored on the Network; included in the vendor's email when notified. */
  reason: z.string().trim().max(500).optional(),
  notifyVendor: z.boolean().optional(),
});

platformAdminRouter.post(
  '/platform-admin/network-vendors/:id/review',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const body = vendorReviewSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
    const networkUrl = networkOr503(res);
    if (!networkUrl) return;
    const vendorId = req.params.id!;

    let vendor;
    let link;
    try {
      const vendors = await adminListVendors(networkUrl);
      vendor = vendors.find((v) => v.id === vendorId);
      if (vendor) link = (await linkVendorsToTenants(networkUrl, vendors)).links.get(vendorId);
    } catch (err) {
      return res.status(502).json(networkErrorBody(err));
    }
    if (!vendor) return res.status(404).json({ error: 'vendor_not_found' });
    if (link) return res.status(409).json({ error: 'managed_by_brand_review', slug: link.slug });

    let result;
    try {
      result = await adminSetVendorReview(networkUrl, vendorId, body.data.status, body.data.reason ?? null, {
        notifyVendor: body.data.notifyVendor,
      });
    } catch (err) {
      if (err instanceof NetworkAdminError && err.code && err.status < 500) {
        return res.status(err.status).json({ error: err.code });
      }
      return res.status(502).json(networkErrorBody(err));
    }
    await writeAudit(db, {
      actor: req.platformAdminActor!,
      action: body.data.status === 'approved' ? 'network_vendor.approve' : 'network_vendor.reject',
      targetType: 'network_vendor',
      targetId: vendorId,
      detail: {
        displayName: vendor.displayName ?? null,
        instanceUrl: vendor.instanceUrl,
        reason: body.data.reason ?? null,
        notified: !!result.notified,
      },
    });
    res.json({ ok: true, reviewStatus: body.data.status, notified: !!result.notified });
  },
);

// --------------------------------------------------------------------------
// Blocklist
// --------------------------------------------------------------------------

platformAdminRouter.get('/platform-admin/blocklist', requirePlatformAdmin, async (_req, res) => {
  const rows = await db<SignupBlocklistRow>(TABLES.SignupBlocklist).orderBy('createdAt', 'desc').limit(500);
  res.json({ entries: rows });
});

const blocklistSchema = z.object({
  type: z.enum(['email', 'domain']),
  value: z.string().trim().min(1).max(254),
  reason: z.string().trim().max(1000).optional(),
});

platformAdminRouter.post(
  '/platform-admin/blocklist',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const body = blocklistSchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'invalid_body' });
    const value = body.data.value.toLowerCase();
    // Light shape validation: an email needs an @, a domain must not.
    if (body.data.type === 'email' && !value.includes('@')) {
      return res.status(400).json({ error: 'email_requires_at' });
    }
    if (body.data.type === 'domain' && value.includes('@')) {
      return res.status(400).json({ error: 'domain_has_at' });
    }
    const actor = req.platformAdminActor!;
    const id = await addBlocklistEntry(db, {
      type: body.data.type,
      value,
      reason: body.data.reason ?? null,
      createdByEmail: actor.email,
    });
    await writeAudit(db, {
      actor,
      action: 'blocklist.add',
      targetType: 'blocklist',
      targetId: id,
      detail: { type: body.data.type, value },
    });
    res.status(201).json({ ok: true, id });
  },
);

platformAdminRouter.delete(
  '/platform-admin/blocklist/:id',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const row = await db<SignupBlocklistRow>(TABLES.SignupBlocklist).where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'not_found' });
    await db<SignupBlocklistRow>(TABLES.SignupBlocklist).where({ id: req.params.id }).del();
    await writeAudit(db, {
      actor: req.platformAdminActor!,
      action: 'blocklist.remove',
      targetType: 'blocklist',
      targetId: req.params.id,
      detail: { type: row.type, value: row.value },
    });
    res.json({ ok: true });
  },
);

// --------------------------------------------------------------------------
// Country access — countries the hosted platform doesn't serve
// --------------------------------------------------------------------------
//
// Signup, partner join and every sign-in check the declared country and the
// request's IP country against this list (country-access.ts). Sanctions
// entries follow US law; policy entries are the company's own choice. The
// two are labelled separately everywhere they appear.

platformAdminRouter.get('/platform-admin/country-access', requirePlatformAdmin, async (_req, res) => {
  const settings = await getCountryAccessSettings(db);
  const [undeclared] = (await db(TABLES.Tenant)
    .whereNotExists(
      db(TABLES.LocationDeclaration)
        .select(db.raw('1'))
        .where('subjectKind', 'tenant')
        .whereRaw(`"${TABLES.LocationDeclaration}"."subjectId" = "${TABLES.Tenant}"."id"`),
    )
    .whereNull('pendingDeletionAt')
    .count({ c: '*' })) as Array<{ c: string | number }>;
  res.json({
    settings,
    defaults: COUNTRY_ACCESS_DEFAULTS,
    // Brands from before country capture; they're asked on next sign-in.
    brandsWithoutCountry: Number(undeclared?.c ?? 0),
    geoip: process.env.GEOIP_COUNTRY_DB ? 'configured' : 'db-ip-lite',
  });
});

const countryAccessSchema = z
  .object({
    enforce: z.boolean().optional(),
    blocked: z
      .array(
        z.object({
          code: z.string().trim().length(2).transform((v) => v.toUpperCase()).refine(isCountryCode, 'unknown country code'),
          basis: z.enum(['sanctions', 'policy']),
        }),
      )
      .max(250)
      .optional(),
  })
  .strict();

platformAdminRouter.put(
  '/platform-admin/country-access',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const body = countryAccessSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
    const actor = req.platformAdminActor!;
    const before = await getCountryAccessSettings(db);
    const settings = await setCountryAccessSettings(db, body.data, actor.email);
    await writeAudit(db, {
      actor,
      action: 'country_access.settings',
      targetType: 'platform',
      detail: { before, after: settings },
    });
    res.json({ settings });
  },
);

// --------------------------------------------------------------------------
// Sanctions screening — Consolidated Screening List matches + payout holds
// --------------------------------------------------------------------------
//
// Brands are screened at signup and add-brand, payable partners hourly
// (sanctions-screening.ts). A possible match waits here for an operator:
// clearing it releases the partner's held payouts; confirming it keeps them
// held and, for a brand, rejects the brand.

platformAdminRouter.get('/platform-admin/screening', requirePlatformAdmin, async (_req, res) => {
  const reviews = await screeningReviewQueue(db);
  const held = await listHeldPartners(db);

  const tenantIds = [...new Set([...reviews.map((r) => r.tenantId), ...held.map((h) => h.tenantId)])];
  const tenants = tenantIds.length
    ? await db<TenantRow>(TABLES.Tenant).whereIn('id', tenantIds).select('id', 'slug', 'displayName')
    : [];
  const tenantById = new Map(tenants.map((t) => [t.id, t]));
  const partnerIds = reviews.filter((r) => r.subjectKind === 'partner').map((r) => r.subjectId);
  const partners = partnerIds.length
    ? await db<PartnerRow>(TABLES.Partner).whereIn('id', partnerIds).select('id', 'name', 'email')
    : [];
  const partnerById = new Map(partners.map((p) => [p.id, p]));

  res.json({
    cslConfigured: cslConfigured(),
    matchScoreThreshold: MATCH_SCORE_THRESHOLD,
    reviews: reviews.map((r) => ({
      ...screeningView(r),
      brandName: tenantById.get(r.tenantId)?.displayName ?? null,
      brandSlug: tenantById.get(r.tenantId)?.slug ?? null,
      // A partner the brand has since deleted shows as null.
      partnerName: r.subjectKind === 'partner' ? (partnerById.get(r.subjectId)?.name ?? null) : null,
      partnerEmail: r.subjectKind === 'partner' ? (partnerById.get(r.subjectId)?.email ?? null) : null,
    })),
    held: held.map((h) => ({
      ...h,
      brandName: tenantById.get(h.tenantId)?.displayName ?? null,
      brandSlug: tenantById.get(h.tenantId)?.slug ?? null,
    })),
  });
});

const reviewSchema = z.object({
  decision: z.enum(['cleared', 'confirmed_match']),
  /** Why. Required to clear: the record must say why the match isn't them. */
  note: z.string().trim().max(2000).optional(),
});

platformAdminRouter.post(
  '/platform-admin/screenings/:id/review',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const body = reviewSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
    const note = body.data.note || null;
    if (body.data.decision === 'cleared' && (!note || note.length < 3)) {
      return res.status(400).json({ error: 'note_required' });
    }
    const actor = req.platformAdminActor!;
    const outcome = await reviewScreening(db, req.params.id!, {
      decision: body.data.decision,
      reviewedByEmail: actor.email,
      note,
    });
    if (!outcome.ok) {
      return res.status(outcome.error === 'not_found' ? 404 : 409).json({ error: outcome.error });
    }
    const row = outcome.row;
    await writeAudit(db, {
      actor,
      action: `screening.${row.decision}`,
      targetType: row.subjectKind,
      targetId: row.subjectId,
      detail: {
        screeningId: row.id,
        tenantId: row.tenantId,
        screenedName: row.screenedName,
        note,
        matches: row.matches.map((m) => ({ source: m.source, name: m.name, score: m.score, entryId: m.entryId })),
      },
    });

    // A confirmed match on a brand: reject it through the normal flow
    // (suspend, pull it off the Network, tell ops). Silently: the brand
    // isn't emailed.
    let brandRejected = false;
    if (row.subjectKind === 'tenant' && row.decision === 'confirmed_match') {
      const tenant = await loadTenant(row.subjectId);
      if (tenant && tenant.approvalStatus !== 'rejected') {
        await rejectBrand(db, tenant, actor, {
          reason: 'Sanctions screening: confirmed match on the US Consolidated Screening List',
          notifyBrand: false,
        });
        brandRejected = true;
      }
    }
    res.json({ ok: true, screening: screeningView(row), brandRejected });
  },
);

/** Screen a brand again now (after an error, a missing key, or a rename). */
platformAdminRouter.post(
  '/platform-admin/brands/:id/screen',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    if (!cslConfigured()) return res.status(409).json({ error: 'screening_not_configured' });
    const tenant = await loadTenant(req.params.id!);
    if (!tenant) return res.status(404).json({ error: 'brand_not_found' });
    const rows = await screenTenant(db, tenant.id, 'ops');
    await writeAudit(db, {
      actor: req.platformAdminActor!,
      action: 'screening.run',
      targetType: 'tenant',
      targetId: tenant.id,
      detail: { results: rows.map((r) => ({ screeningId: r.id, screenedName: r.screenedName, result: r.result })) },
    });
    res.json({ screenings: rows.map(screeningView) });
  },
);

// --------------------------------------------------------------------------
// Notifications — setup reminders to brands + profile reminders to creators
// --------------------------------------------------------------------------
//
// Both sweeps are OFF until an operator turns them on here (they email real
// people). The console previews exactly who the next run would email
// (dryRun), can run one now, and can nudge a single brand/creator. Brand
// reminders run in openpartner; creator reminders run on the Network (which
// owns creators + the unsubscribe flow) and are triggered from here.

platformAdminRouter.get('/platform-admin/notifications', requirePlatformAdmin, async (_req, res) => {
  const settings = await getNotificationSettings(db);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [recent] = (await db(TABLES.BrandNotification)
    .where('sentAt', '>=', weekAgo)
    .count({ c: '*' })) as Array<{ c: string | number }>;
  res.json({
    settings,
    brandRemindersSentLast7Days: Number(recent?.c ?? 0),
    networkConfigured: !!platformNetworkUrl() && !!process.env.NETWORK_ADMIN_API_KEY,
  });
});

const notificationSettingsSchema = z
  .object({
    brandSetupReminders: z.boolean().optional(),
    creatorProfileReminders: z.boolean().optional(),
  })
  .strict();

platformAdminRouter.put(
  '/platform-admin/notifications',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const body = notificationSettingsSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
    const actor = req.platformAdminActor!;
    const settings = await setNotificationSettings(db, body.data, actor.email);
    await writeAudit(db, { actor, action: 'notifications.settings', targetType: 'platform', detail: body.data });
    res.json({ settings });
  },
);

const runSchema = z.object({ dryRun: z.boolean().default(true) });

/** Preview (dryRun, the default — read-only operators may preview) or send
 *  the brand setup reminders that are due right now. */
platformAdminRouter.post('/platform-admin/notifications/brand-setup/run', requirePlatformAdmin, async (req, res) => {
  const body = runSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const actor = req.platformAdminActor!;
  if (!body.data.dryRun && actor.role !== 'admin') return res.status(403).json({ error: 'read_only_operator' });
  const result = await runBrandSetupReminders(db, { dryRun: body.data.dryRun });
  if (!body.data.dryRun) {
    await writeAudit(db, {
      actor,
      action: 'notifications.brand_setup.run',
      targetType: 'platform',
      detail: { sent: result.sent, failed: result.failed },
    });
  }
  res.json(result);
});

platformAdminRouter.post('/platform-admin/notifications/creator-profile/run', requirePlatformAdmin, async (req, res) => {
  const body = runSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const actor = req.platformAdminActor!;
  if (!body.data.dryRun && actor.role !== 'admin') return res.status(403).json({ error: 'read_only_operator' });
  const networkUrl = networkOr503(res);
  if (!networkUrl) return;
  let result;
  try {
    result = await adminRunCreatorReminders(networkUrl, { dryRun: body.data.dryRun });
  } catch (err) {
    return res.status(502).json(networkErrorBody(err));
  }
  if (!body.data.dryRun) {
    await writeAudit(db, {
      actor,
      action: 'notifications.creator_profile.run',
      targetType: 'platform',
      detail: { sent: result.sent, failed: result.failed },
    });
  }
  res.json(result);
});

platformAdminRouter.post(
  '/platform-admin/brands/:id/setup-reminder',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const actor = req.platformAdminActor!;
    const result = await remindBrandNow(db, req.params.id!, actor.email);
    if (!result.ok) {
      const status = result.error === 'brand_not_found' ? 404 : result.error === 'send_failed' ? 502 : 409;
      return res.status(status).json({ error: result.error });
    }
    await writeAudit(db, {
      actor,
      action: 'brand.setup_reminder',
      targetType: 'tenant',
      targetId: req.params.id!,
      detail: { step: result.step, to: result.to },
    });
    res.json(result);
  },
);

platformAdminRouter.post(
  '/platform-admin/creators/:id/remind',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const networkUrl = networkOr503(res);
    if (!networkUrl) return;
    const actor = req.platformAdminActor!;
    let result: { ok: true; step: number };
    try {
      result = await adminRemindCreator(networkUrl, req.params.id!);
    } catch (err) {
      // The Network's reason (profile_complete, opted_out, …) is the useful
      // part — pass it through with its status instead of a blanket 502.
      if (err instanceof NetworkAdminError && err.code && err.status < 500) {
        return res.status(err.status).json({ error: err.code });
      }
      return res.status(502).json(networkErrorBody(err));
    }
    await writeAudit(db, {
      actor,
      action: 'creator.profile_reminder',
      targetType: 'creator',
      targetId: req.params.id!,
      detail: { step: result.step },
    });
    res.json(result);
  },
);

// --------------------------------------------------------------------------
// Marketplace policy warnings
// --------------------------------------------------------------------------
//
// Free marketplace listings exist so creators join (and get tracked + paid)
// through OpenPartner. When an operator finds a listing funnelling creators
// to a different affiliate platform, this emails the brand a templated
// warning with a deadline, in the platform voice, and records it in the
// audit log (the brand card shows the latest one). Removing the listing
// after the deadline is the existing program block / brand removal — an
// operator decision, not automated.

const policyWarningSchema = z.object({
  /** What the operator found, in their own words — goes into the email. */
  details: z.string().trim().min(10).max(2000),
  deadlineDays: z.number().int().min(1).max(30).default(7),
});

platformAdminRouter.post(
  '/platform-admin/brands/:id/policy-warning',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const body = policyWarningSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
    const tenant = await loadTenant(req.params.id!);
    if (!tenant) return res.status(404).json({ error: 'brand_not_found' });

    // Prefer an admin who has signed in (address proven); fall back to the
    // oldest non-revoked one.
    const admin =
      (await db<AdminRow>(TABLES.Admin)
        .where({ tenantId: tenant.id })
        .whereNull('revokedAt')
        .whereNotNull('activatedAt')
        .orderBy('activatedAt', 'asc')
        .first(['email', 'name'])) ??
      (await db<AdminRow>(TABLES.Admin)
        .where({ tenantId: tenant.id })
        .whereNull('revokedAt')
        .orderBy('createdAt', 'asc')
        .first(['email', 'name']));
    if (!admin) return res.status(409).json({ error: 'no_admin' });

    // End of the deadline day (UTC), so the date in the email and the one
    // the console shows agree in any operator/brand timezone west of UTC.
    const now = new Date();
    const deadline = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + body.data.deadlineDays, 23, 59, 59),
    );
    const deadlineLabel = deadline.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
    const tmpl = marketplacePolicyWarningEmail({
      adminName: admin.name,
      brandName: (await resolveBrandName(db, tenant.id)) ?? tenant.displayName,
      details: body.data.details,
      deadline: deadlineLabel,
      dashboardUrl: `${getPortalBaseUrl({ slug: tenant.slug, customDomain: tenant.customDomain })}/admin/programs`,
    });
    try {
      await getMailer().send(
        { db, tenantId: DEFAULT_TENANT_ID },
        {
          to: admin.email,
          subject: tmpl.subject,
          text: tmpl.text,
          html: tmpl.html,
          tag: 'marketplace_policy_warning',
          metadata: { tenantId: tenant.id },
          platform: true,
        },
      );
    } catch (err) {
      return res.status(502).json({ error: 'mail_failed', detail: err instanceof Error ? err.message : String(err) });
    }
    const actor = req.platformAdminActor!;
    await writeAudit(db, {
      actor,
      action: 'brand.policy_warning',
      targetType: 'tenant',
      targetId: tenant.id,
      detail: { details: body.data.details, deadline: deadline.toISOString(), sentTo: admin.email },
    });
    res.json({ ok: true, sentTo: admin.email, deadline: deadline.toISOString() });
  },
);

// --------------------------------------------------------------------------
// Platform fee — the commission-floor rule (docs/platform-fee.md)
// --------------------------------------------------------------------------
//
// Nothing here changes what a tenant is billed by itself: the cutover
// moves only plans that start after it, the notice only moves a tenant 30+
// days out, and both are deliberate operator acts. Read-only operators can
// see everything and preview the notice; writes need the admin role.

platformAdminRouter.get('/platform-admin/fees', requirePlatformAdmin, async (_req, res) => {
  const settings = await getFeeRuleSettings(db);
  res.json({ settings, meterRates: METER_RATES, noticeDays: NOTICE_DAYS, tenants: await listFeeTenants(db, settings) });
});

const feeRatesSchema = z
  .object({ revenueRate: z.number().min(0).max(1).optional(), commissionRate: z.number().min(0).max(1).optional() })
  .strict();
const feeSettingsSchema = z
  .object({
    shadow: z.boolean().optional(),
    cutoverAt: z.string().datetime({ offset: true }).nullable().optional(),
    rates: z.object({ flat: feeRatesSchema.optional(), revshare: feeRatesSchema.optional() }).strict().optional(),
  })
  .strict();

platformAdminRouter.put('/platform-admin/fees/settings', requirePlatformAdmin, requirePlatformAdminWrite, async (req, res) => {
  const body = feeSettingsSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  // A cutover in the past would reclassify plans their owners bought under
  // the old pricing. A day's slack covers "the moment the copy went live".
  if (body.data.cutoverAt && Date.parse(body.data.cutoverAt) < Date.now() - 86_400_000) {
    return res.status(400).json({ error: 'cutover_in_past' });
  }
  const actor = req.platformAdminActor!;
  const settings = await setFeeRuleSettings(db, body.data, actor.email);
  await writeAudit(db, { actor, action: 'fees.settings', targetType: 'platform', detail: body.data });
  res.json({ settings });
});

const feeEstimateSchema = z.object({ days: z.number().int().min(1).max(365).default(90) });

/** Live old-vs-new comparison over the trailing window, per tenant. */
platformAdminRouter.post('/platform-admin/fees/estimate', requirePlatformAdmin, async (req, res) => {
  const body = feeEstimateSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const settings = await getFeeRuleSettings(db);
  res.json({ days: body.data.days, estimates: await estimateFeeImpact(db, settings, { days: body.data.days }) });
});

platformAdminRouter.get('/platform-admin/fees/signals', requirePlatformAdmin, async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days ?? 60) || 60, 7), 365);
  res.json(await reviewSignals(db, { days }));
});

const noticeRunSchema = z.object({
  dryRun: z.boolean().default(true),
  tenantIds: z.array(z.string().min(1)).max(500).optional(),
});

/** Preview (dryRun, the default) or send the pricing-change notice to every
 *  tenant owed one. Sending needs the admin role and a cutover. */
platformAdminRouter.post('/platform-admin/fees/notices', requirePlatformAdmin, async (req, res) => {
  const body = noticeRunSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const actor = req.platformAdminActor!;
  if (body.data.dryRun) return res.json({ dryRun: true, ...(await previewPricingNotices(db, { tenantIds: body.data.tenantIds })) });
  if (actor.role !== 'admin') return res.status(403).json({ error: 'read_only_operator' });
  if (!(await getFeeRuleSettings(db)).cutoverAt) return res.status(409).json({ error: 'no_cutover' });
  const result = await sendPricingNotices(db, { operatorEmail: actor.email, tenantIds: body.data.tenantIds });
  for (const s of result.sent) {
    await writeAudit(db, {
      actor,
      action: 'fees.pricing_notice',
      targetType: 'tenant',
      targetId: s.tenantId,
      detail: { recipients: s.recipients, failedRecipients: s.failedRecipients, effectiveAt: s.effectiveAt },
    });
  }
  res.json({ dryRun: false, ...result });
});

const contractTermsSchema = z
  .object({
    revenueRate: z.number().min(0).max(1).nullable(),
    commissionRate: z.number().min(0).max(1).nullable(),
    monthlyMinimumUsd: z.number().min(0).max(10_000_000).nullable(),
    effectiveAt: z.string().datetime({ offset: true }).nullable(),
    note: z.string().trim().max(2000).nullable(),
  })
  .strict();

platformAdminRouter.put(
  '/platform-admin/fees/contracts/:tenantId',
  requirePlatformAdmin,
  requirePlatformAdminWrite,
  async (req, res) => {
    const body = contractTermsSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
    const actor = req.platformAdminActor!;
    try {
      const terms = await setContractTerms(db, req.params.tenantId!, body.data, actor.email);
      await writeAudit(db, { actor, action: 'fees.contract_terms', targetType: 'tenant', targetId: req.params.tenantId!, detail: body.data });
      res.json({ terms });
    } catch (err) {
      if (err instanceof ContractTermsError) {
        return res.status(err.code === 'not_found' ? 404 : 400).json({ error: err.code, detail: err.message });
      }
      throw err;
    }
  },
);

platformAdminRouter.get('/platform-admin/fees/contracts/:tenantId/statement', requirePlatformAdmin, async (req, res) => {
  const month = typeof req.query.month === 'string' ? req.query.month : new Date().toISOString().slice(0, 7);
  try {
    res.json(await contractStatement(db, await getFeeRuleSettings(db), req.params.tenantId!, month));
  } catch (err) {
    if (err instanceof ContractTermsError) {
      return res.status(err.code === 'not_found' ? 404 : 400).json({ error: err.code, detail: err.message });
    }
    if (err instanceof FxUnavailableError) return res.status(503).json({ error: 'fx_rates_unavailable' });
    throw err;
  }
});

// --------------------------------------------------------------------------
// Audit
// --------------------------------------------------------------------------

platformAdminRouter.get('/platform-admin/audit', requirePlatformAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
  const rows = await db<PlatformAuditLogRow>(TABLES.PlatformAuditLog).orderBy('createdAt', 'desc').limit(limit);
  res.json({ events: rows });
});
