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
import type { Knex } from 'knex';
import type { NextFunction, Request, Response } from 'express';
import { DEFAULT_TENANT_ID } from '@openpartner/db';
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
    }
  }
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
    let resolved: Awaited<ReturnType<typeof resolveTenantFromPath>>;
    try {
      resolved = await resolveTenantFromPath(req);
    } catch (err) {
      if (err instanceof TenantPendingDeletionError) {
        res.status(410).json({ error: 'tenant_pending_deletion', slug: err.slug });
        return;
      }
      throw err;
    }
    if (resolved) {
      tenantId = resolved.id;
      tenantSlug = resolved.slug;
      // Strip the /t/<slug> (or /api/t/<slug>) prefix so the downstream
      // routers — all mounted at root — match. Express respects req.url
      // updates; req.originalUrl stays intact for logging.
      req.url = resolved.remainder;
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
): Promise<{ id: string; slug: string; remainder: string } | null> {
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
  const row = await db('Tenant').where({ slug, status: 'active' }).first(['id', 'slug', 'pendingDeletionAt']);
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
  };
}
