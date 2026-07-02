/**
 * Tenant resolution + per-request transaction wiring.
 *
 * Two tenancy modes:
 *
 *   single  — every request runs as tenantId = 'default' (the seeded
 *             tenant from the multi_tenant migration). Self-host. The
 *             same code paths and queries work; we just always use one
 *             tenant.
 *
 *   multi   — tenantId resolved from the request URL (path-based for v1:
 *             /t/<slug>/...). Reserved slugs reject. Unknown slugs 404.
 *
 * Each tenant-scoped request runs inside a database transaction with
 * `SET LOCAL app.tenant_id = '<id>'`. RLS policies on every data table
 * enforce that the response only contains rows for that tenant. The
 * transaction is bound to `req.db`; routes use `req.db('Partner')...`
 * instead of the module-level `db`.
 *
 * Public, non-tenant routes (e.g. /signup, /health, the marketing
 * landing pages) are handled by routing them away from the tenant
 * middleware — they use the privileged `db` directly.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Knex } from 'knex';
import type { NextFunction, Request, Response } from 'express';
import { DEFAULT_TENANT_ID, TABLES, type TenantRow } from '@openpartner/db';
import { appDb } from './db.js';

export type TenancyMode = 'single' | 'multi';

/** Thrown when a tenant request hits a brand inside its deletion grace
 *  window (and isn't on the recovery path). The middleware catches and
 *  surfaces a 410 Gone — explicit so the SPA can show "this brand was
 *  deleted; sign in again". */
export class TenantPendingDeletionError extends Error {
  constructor(public slug: string) {
    super(`tenant_pending_deletion:${slug}`);
    this.name = 'TenantPendingDeletionError';
  }
}

export function getTenancyMode(): TenancyMode {
  const m = process.env.OPENPARTNER_TENANCY ?? 'single';
  if (m !== 'single' && m !== 'multi') {
    throw new Error(`Invalid OPENPARTNER_TENANCY: ${m}`);
  }
  return m;
}

/** Reserved subdomain/path slugs that can't be claimed by a tenant. */
export const RESERVED_SLUGS = new Set([
  'default', // already used by single-host bootstrap
  'www',
  'api',
  'app',
  'admin',
  'signup',
  'login',
  'auth',
  'docs',
  'help',
  'support',
  'status',
  'network',
  'static',
  'public',
  'platform',
]);

// Express's own type definitions use a namespace under global, so the
// canonical way to extend Request is the same shape — no idiomatic
// "module" rewrite available without losing the augmentation.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Resolved tenant ID. Always set inside the tenant middleware. */
      tenantId?: string;
      /** Resolved tenant slug. */
      tenantSlug?: string;
      /** Transaction-bound knex instance with app.tenant_id set. */
      db?: Knex;
      /** True when a platform admin is acting (rare; gated separately). */
      platformAdmin?: boolean;
      /** The tenant's verified custom domain, when it has one — set both
       *  when the tenant was resolved FROM that host and when a path-based
       *  request's Tenant row carries one (so emailed links always target
       *  the custom domain). Absent when the tenant has no custom domain. */
      tenantCustomDomain?: string;
      /** Effective white-label entitlement for a host-resolved tenant —
       *  provisioned flag AND entitling billing state. Branding + Network-
       *  hiding key on this; host resolution itself does NOT (graceful
       *  degradation on cancellation, spec §8.1). */
      tenantWhiteLabelEffective?: boolean;
    }
  }
}

// ---------------------------------------------------------------------------
// Host-based tenant resolution (white-label custom domains, spec §4.3/§7.5)
// ---------------------------------------------------------------------------

/**
 * Hosts that must never resolve a tenant by Host header — they are the
 * platform's own origins, so requests on them take the path-based branch.
 * Includes the PORTAL_URL host so a misconfigured Tenant.customDomain can't
 * shadow the platform origin.
 */
export function isPlatformHost(host: string): boolean {
  if (!host) return true;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.endsWith('.ondigitalocean.app')) return true;
  if (host === 'openpartner.dev' || host.endsWith('.openpartner.dev')) return true;
  const portalUrl = process.env.PORTAL_URL;
  if (portalUrl) {
    try {
      if (host === new URL(portalUrl).hostname.toLowerCase()) return true;
    } catch {
      // Malformed PORTAL_URL — fall through; the static list above still holds.
    }
  }
  return false;
}

/** Constant-time string compare that doesn't leak length. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still burn a comparison so length mismatch isn't a faster path.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * True when the request provably transited OUR edge (the Phase-3 white-label
 * droplet injects X-OP-Edge-Token and rewrites Host → the platform origin).
 * With no EDGE_TRUST_SECRET configured (MVP DO-native path), nothing is
 * edge-trusted and X-Forwarded-Host is never honored.
 */
/** Minimal request surface for the host decision — keeps the pure header
 *  logic testable without constructing an Express Request. */
export interface HeaderReader {
  header(name: string): string | undefined;
}

function edgeTrusted(req: HeaderReader): boolean {
  const secret = process.env.EDGE_TRUST_SECRET ?? '';
  if (secret.length === 0) return false;
  return timingSafeEqualStr(req.header('x-op-edge-token') ?? '', secret);
}

/**
 * The host the request is really for. X-Forwarded-Host is honored ONLY
 * behind a valid edge token — otherwise anyone could curl the platform
 * origin with a forged XFH and get RLS-scoped to another tenant (§7.5).
 * NEVER use Express req.hostname here: under `trust proxy` it is itself
 * derived from the client-spoofable X-Forwarded-Host.
 */
export function inboundHost(req: HeaderReader): string {
  const raw = edgeTrusted(req) ? (req.header('x-forwarded-host') ?? '') : (req.header('host') ?? '');
  return (raw.split(',')[0] ?? '').split(':')[0]!.toLowerCase().trim();
}

/**
 * Custom-domain tenant lookup. Deliberately NOT gated on whiteLabel — a
 * tenant whose add-on lapsed keeps resolving (portal reverts to platform
 * branding) until the domain/cert is actually revoked; hard-down would break
 * login mid-cancellation (§8.1). Runs on the privileged pool: this is a
 * legitimate cross-tenant host → tenant lookup that RLS would block.
 */
async function resolveTenantFromHost(
  req: Request,
): Promise<{ id: string; slug: string } | null> {
  const host = inboundHost(req);
  if (isPlatformHost(host)) return null;
  const { db } = await import('./db.js');
  const row = await db<TenantRow>(TABLES.Tenant)
    .where({ customDomain: host, status: 'active' })
    .first(['id', 'slug', 'whiteLabel', 'status', 'pendingDeletionAt']);
  if (!row) return null;
  if (row.pendingDeletionAt) {
    const isRecoveryPath =
      req.url.includes('/account/restore') || req.url.includes('/account/deletion-status');
    if (!isRecoveryPath) throw new TenantPendingDeletionError(row.slug);
  }
  req.tenantCustomDomain = host;
  // Effective entitlement drives branding + Network-hiding downstream
  // (surfaced via /branding and /config/program). Computed here once so
  // pre-auth surfaces see the same truth as authenticated ones.
  const { getTenantBillingState } = await import('./billing-plan.js');
  const { isWhiteLabelEntitled } = await import('./white-label.js');
  const billing = await getTenantBillingState(db, row.id);
  req.tenantWhiteLabelEffective = isWhiteLabelEntitled(
    { whiteLabel: !!row.whiteLabel, status: row.status },
    billing,
  );
  return { id: row.id, slug: row.slug };
}

/**
 * Convenience helper for tenant-scoped route handlers. Throws if the
 * request didn't pass through the tenant middleware (which would be a
 * routing bug — the handler shouldn't be there).
 *
 *   const { db, tenantId } = tenantOf(req);
 *   await db('Partner').insert({ tenantId, ... });
 */
export function tenantOf(req: Request): { db: Knex; tenantId: string } {
  if (!req.db || !req.tenantId) {
    throw new Error(
      'tenantOf called on a request without tenant context — mount tenantMiddleware before this route',
    );
  }
  return { db: req.db, tenantId: req.tenantId };
}

/**
 * Express middleware that:
 *   1. Resolves the tenantId for the request
 *   2. Opens a transaction on the appDb pool
 *   3. Sets `app.tenant_id` (and `app.platform_admin` if applicable)
 *   4. Stashes the trx as `req.db` so handlers can issue tenant-scoped queries
 *   5. Awaits response completion before committing/rolling back
 *
 * Behavior depends on OPENPARTNER_TENANCY:
 *   single → tenantId = 'default' for every request
 *   multi  → resolveTenantFromPath(req); if no tenant, calls next() without
 *            opening a transaction so non-tenant routes (signup, marketing)
 *            still work.
 */
export async function tenantMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const mode = getTenancyMode();

  let tenantId: string | null = null;
  let tenantSlug: string | null = null;

  if (mode === 'single') {
    tenantId = DEFAULT_TENANT_ID;
    tenantSlug = 'default';
  } else {
    try {
      // Host first: a white-label custom domain serves the SPA at / and the
      // API at root-relative paths, so there is no /t/<slug>/ prefix to
      // strip. Path-based resolution stays the fallback for the platform
      // origin. Host wins when both could apply.
      const fromHost = await resolveTenantFromHost(req);
      if (fromHost) {
        tenantId = fromHost.id;
        tenantSlug = fromHost.slug;
      } else {
        const resolved = await resolveTenantFromPath(req);
        if (resolved) {
          tenantId = resolved.id;
          tenantSlug = resolved.slug;
          if (resolved.customDomain) req.tenantCustomDomain = resolved.customDomain;
          // Strip the /t/<slug> (or /api/t/<slug>) prefix so the downstream
          // routers — all mounted at root — match. Express respects req.url
          // updates; req.originalUrl stays intact for logging.
          req.url = resolved.remainder;
        }
      }
    } catch (err) {
      if (err instanceof TenantPendingDeletionError) {
        res.status(410).json({ error: 'tenant_pending_deletion', slug: err.slug });
        return;
      }
      throw err;
    }
  }

  if (!tenantId) {
    // No tenant scope — non-tenant routes (signup, marketing landing,
    // /health) handle themselves. Don't open a transaction.
    return next();
  }

  req.tenantId = tenantId;
  if (tenantSlug) req.tenantSlug = tenantSlug;

  // Open the transaction outside any callback so we can finalize it
  // synchronously when a handler calls res.json/send/end. Committing on
  // response 'finish' (the previous design) released the trx AFTER the
  // client got its response, which raced any caller doing direct DB
  // reads immediately after `await fetch(...)` — including every
  // integration test that follows POST /partners with db('Click').insert().
  let trx: Knex.Transaction;
  try {
    trx = await appDb.transaction();
    await trx.raw(`set local app.tenant_id = '${tenantId.replace(/'/g, "''")}'`);
    if (req.platformAdmin) {
      await trx.raw(`set local app.platform_admin = 'on'`);
    }
  } catch (err) {
    return next(err);
  }
  req.db = trx;

  // Patch res.send/json/end so they commit (or rollback on 5xx) before
  // any byte goes to the client. If commit fails the request becomes a
  // 500; if it succeeds the original response is sent unchanged.
  const origJson = res.json.bind(res);
  const origSend = res.send.bind(res);
  const origEnd = res.end.bind(res);
  let finalized = false;

  async function finalize(success: boolean): Promise<void> {
    if (finalized) return;
    finalized = true;
    if (success) {
      try {
        await trx.commit();
      } catch (err) {
        // Commit failed after the handler succeeded — the response we're
        // about to send is a lie. Mutate to a 500 if we still can.
        if (!res.headersSent) {
          res.status(500);
          throw err;
        }
        // Headers already out; nothing safe to do but log.
        console.error('[tenancy] commit failed after headers sent', err);
      }
    } else {
      try {
        await trx.rollback();
      } catch {
        // Best-effort rollback; ignore secondary failures.
      }
    }
  }

  res.json = function (body: unknown) {
    const success = res.statusCode < 500;
    finalize(success).then(
      () => origJson(body),
      (err) => {
        if (!res.headersSent) origJson({ error: 'commit_failed', detail: err instanceof Error ? err.message : String(err) });
      },
    );
    return res;
  };
  res.send = function (body?: unknown) {
    const success = res.statusCode < 500;
    finalize(success).then(
      () => origSend(body),
      (err) => {
        if (!res.headersSent) origSend(`commit_failed: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
    return res;
  };
  res.end = function (chunk?: unknown, encoding?: BufferEncoding | (() => void), cb?: () => void) {
    const success = res.statusCode < 500;
    finalize(success).then(
      () => (origEnd as unknown as (...a: unknown[]) => Response)(chunk, encoding, cb),
      () => (origEnd as unknown as (...a: unknown[]) => Response)(chunk, encoding, cb),
    );
    return res;
  };

  // Belt and suspenders: if the client disconnects before any res.* call
  // ran (or if Express's error path bypasses our patched methods), still
  // release the trx so it doesn't leak.
  res.on('close', () => {
    if (!finalized) {
      finalize(false).catch(() => {});
    }
  });

  next();
}

/**
 * Path-based tenant resolution: /t/<slug>/... → Tenant row.
 *
 * Returns null for non-tenant paths (no /t/ prefix) so the middleware
 * can pass through to public routes.
 */
async function resolveTenantFromPath(
  req: Request,
): Promise<{ id: string; slug: string; remainder: string; customDomain: string | null } | null> {
  // Path patterns:
  //   /t/<slug>/...    — portal under a tenant
  //   /api/t/<slug>/...— api under a tenant (note: ingress strips /api)
  //   anything else    — no tenant
  // We capture the prefix length so the middleware can rewrite req.url
  // to just the post-prefix path; downstream routers — all mounted at
  // root — then match cleanly.
  const match = req.url.match(/^(\/(?:t|api\/t)\/[a-z0-9-]+)(\/.*)?$/);
  if (!match) return null;
  const prefix = match[1]!;
  const slug = prefix.split('/').pop()!;

  if (RESERVED_SLUGS.has(slug)) return null;

  // Lookup goes through the privileged db pool because we need to read
  // any tenant by slug, not just the current one. RLS would block this
  // on the appDb pool.
  const { db } = await import('./db.js');
  const row = await db('Tenant').where({ slug, status: 'active' }).first(['id', 'slug', 'pendingDeletionAt', 'customDomain']);
  if (!row) return null;
  // Tenants in the deletion grace window are accessible only via the
  // explicit recovery routes — anything else 410s on the way out so a
  // browser cookie hanging around can't keep working against a deleted
  // brand. The recovery routes use the `?recover=1` query flag the
  // restore page sets.
  if (row.pendingDeletionAt) {
    const isRecoveryPath =
      req.url.includes('/account/restore') ||
      req.url.includes('/account/deletion-status');
    if (!isRecoveryPath) {
      throw new TenantPendingDeletionError(slug);
    }
  }
  return {
    id: row.id as string,
    slug: row.slug as string,
    remainder: match[2] || '/',
    customDomain: (row.customDomain as string | null) ?? null,
  };
}
