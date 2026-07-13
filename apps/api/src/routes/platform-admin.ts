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
  type AdminRow,
  type PlatformAdminRow,
  type PlatformAuditLogRow,
  type ProgramRow,
  type SignupBlocklistRow,
  type TenantRow,
} from '@openpartner/db';
import { db } from '../db.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { consumeMagicLink, issueMagicLink } from '../auth-sessions.js';
import { getMailer } from '../mailer.js';
import { platformAdminSigninEmail } from '../email-templates.js';
import { getPortalBaseUrl } from '../portal-url.js';
import { getTenancyMode } from '../tenancy.js';
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
  adminUnblockCreator,
  platformNetworkUrl,
} from '../network-client.js';
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
async function isAllowedOperator(email: string): Promise<boolean> {
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
  res.clearCookie(PLATFORM_ADMIN_SESSION_COOKIE, platformAdminSessionCookieOptions());
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
    })),
  });
});

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
// Audit
// --------------------------------------------------------------------------

platformAdminRouter.get('/platform-admin/audit', requirePlatformAdmin, async (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
  const rows = await db<PlatformAuditLogRow>(TABLES.PlatformAuditLog).orderBy('createdAt', 'desc').limit(limit);
  res.json({ events: rows });
});
