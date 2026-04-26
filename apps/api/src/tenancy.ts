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

declare global {
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
    const resolved = await resolveTenantFromPath(req);
    if (resolved) {
      tenantId = resolved.id;
      tenantSlug = resolved.slug;
    }
  }

  if (!tenantId) {
    // No tenant scope — non-tenant routes (signup, marketing landing,
    // /health) handle themselves. Don't open a transaction.
    return next();
  }

  req.tenantId = tenantId;
  if (tenantSlug) req.tenantSlug = tenantSlug;

  // Wrap the rest of the request in a transaction with app.tenant_id set.
  // Resolving the transaction promise on response finish ensures the
  // commit happens once handlers have written the response. Errors in
  // handlers reject and roll back.
  await new Promise<void>((resolveOuter, rejectOuter) => {
    appDb
      .transaction(async (trx) => {
        await trx.raw(`set local app.tenant_id = '${tenantId.replace(/'/g, "''")}'`);
        if (req.platformAdmin) {
          await trx.raw(`set local app.platform_admin = 'on'`);
        }
        req.db = trx;

        // Wait for the response to finish before resolving the transaction
        // callback. `finish` fires on a successful response; `close` fires
        // if the client disconnected. Either way the transaction body has
        // run to completion.
        await new Promise<void>((resolveInner) => {
          let settled = false;
          const settle = () => {
            if (!settled) {
              settled = true;
              resolveInner();
            }
          };
          res.on('finish', settle);
          res.on('close', settle);
          // Pass through to the next handler now that req.db is set.
          next();
        });
      })
      .then(resolveOuter, rejectOuter);
  }).catch((err) => {
    // Transaction rollback already happened. Surface the error to Express's
    // error handler if the response hasn't been sent yet.
    if (!res.headersSent) {
      next(err);
    }
  });
}

/**
 * Path-based tenant resolution: /t/<slug>/... → Tenant row.
 *
 * Returns null for non-tenant paths (no /t/ prefix) so the middleware
 * can pass through to public routes.
 */
async function resolveTenantFromPath(
  req: Request,
): Promise<{ id: string; slug: string } | null> {
  // Path patterns:
  //   /t/<slug>/...    — portal under a tenant
  //   /api/t/<slug>/...— api under a tenant (note: ingress strips /api)
  //   anything else    — no tenant
  const match = req.path.match(/^\/(?:t|api\/t)\/([a-z0-9-]+)(?:\/|$)/);
  if (!match) return null;
  const slug = match[1]!;

  if (RESERVED_SLUGS.has(slug)) return null;

  // Lookup goes through the privileged db pool because we need to read
  // any tenant by slug, not just the current one. RLS would block this
  // on the appDb pool.
  const { db } = await import('./db.js');
  const row = await db('Tenant').where({ slug, status: 'active' }).first(['id', 'slug']);
  return row ? { id: row.id as string, slug: row.slug as string } : null;
}
