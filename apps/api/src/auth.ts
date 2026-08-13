/**
 * Bearer-token auth.
 *
 * Two shapes of credential:
 *   - ADMIN_API_KEY env var — bootstrap admin key, valid in all modes.
 *   - ApiKey rows in the database — either admin (partnerId null),
 *     partner-scoped, or a scoped key used by a federating client like
 *     an OpenPartner Network hub.
 *
 * We never store plaintext. Keys look like `op_<24 hex>` and are identified
 * by an 8-char prefix so lookups are indexed rather than table scans. The
 * hash is sha256 over the whole key.
 *
 * Multi-tenant: principal lookups go through `req.db` (the per-request
 * transaction with `app.tenant_id` set), so RLS scopes ApiKey + Session
 * lookups to the current tenant. `requireAuth` therefore must run after
 * `tenantMiddleware`.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { TABLES, type ApiKeyRow } from '@openpartner/db';

export type ApiKeyPrincipal =
  | { role: 'admin'; source: 'env' }
  | { role: 'admin'; source: 'db'; apiKeyId: string }
  | { role: 'admin'; source: 'session'; sessionId: string; adminId: string }
  | { role: 'partner'; source: 'db'; apiKeyId: string; partnerId: string }
  | { role: 'partner'; source: 'session'; sessionId: string; partnerId: string }
  | { role: 'scoped'; source: 'db'; apiKeyId: string; scopes: string[] };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      principal?: ApiKeyPrincipal;
    }
  }
}

export const KEY_PREFIX_LEN = 8;

export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const plaintext = `op_${randomBytes(24).toString('hex')}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, KEY_PREFIX_LEN),
    hash: hashKey(plaintext),
  };
}

export function hashKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Multi-tenant requests need to come in under /t/<slug>/ so the
  // tenant middleware fires and sets req.db. Without that, every
  // downstream auth check would have to defensively re-detect "no
  // tenant scope" and we'd 500 with an internal-only error message
  // (the previous behavior). Surface a clean 400 here instead so
  // callers — Zapier, CRM webhooks, raw curl — get an actionable
  // hint about the missing prefix.
  if (!req.db) {
    res.status(400).json({
      error: 'tenant_slug_missing',
      detail:
        'This API request did not pass through tenant resolution. On multi-tenant installs, include the tenant slug in the URL: /t/<your-slug>/api/...',
    });
    return;
  }
  const principal = await resolvePrincipal(req);
  if (!principal) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.principal = principal;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.principal?.role !== 'admin') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
}

export function requirePartnerOrAdmin(paramName: string = 'id') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const p = req.principal;
    if (!p) return void res.status(401).json({ error: 'unauthorized' });
    if (p.role === 'admin') return next();
    if (p.role === 'partner' && p.partnerId === req.params[paramName]) return next();
    res.status(403).json({ error: 'forbidden' });
  };
}

async function resolvePrincipal(req: Request): Promise<ApiKeyPrincipal | null> {
  const db = req.db;
  if (!db) {
    // requireAuth was mounted on a route that didn't pass through
    // tenantMiddleware. That's a routing bug — fail loudly.
    throw new Error('requireAuth invoked without a tenant-scoped req.db');
  }

  const header = req.header('authorization');
  if (!header) {
    const cookie = (req as unknown as { cookies?: Record<string, string> }).cookies?.op_session;
    if (!cookie) return null;
    const { resolveSession } = await import('./auth-sessions.js');
    const session = await resolveSession(db, cookie);
    if (!session) return null;
    if (session.principalKind === 'admin') {
      return { role: 'admin', source: 'session', sessionId: session.id, adminId: session.principalId };
    }
    return { role: 'partner', source: 'session', sessionId: session.id, partnerId: session.principalId };
  }

  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  const token = match[1]!;

  const envAdmin = process.env.ADMIN_API_KEY;
  if (envAdmin && constantTimeEqual(token, envAdmin)) {
    return { role: 'admin', source: 'env' };
  }

  if (token.length < KEY_PREFIX_LEN) return null;

  const prefix = token.slice(0, KEY_PREFIX_LEN);
  const hash = hashKey(token);

  // Bind the key to the REQUEST'S tenant explicitly.
  //
  // This lookup used to filter on prefix alone and lean on RLS to keep it
  // inside the tenant. That holds on the app role — but `appDb` falls back
  // to the privileged `DATABASE_URL` when `DATABASE_URL_APP` is unset, a
  // configuration db.ts documents as supported, and there RLS is bypassed.
  // Tenant A's admin key then authenticated successfully against tenant B's
  // path (`/t/tenant-b/...`), and every downstream tenant-scoped query —
  // including the export — faithfully served B's data to A (round 7).
  //
  // ApiKey carries `tenantId`, so this is exact rather than defence in
  // depth: a key is only ever valid for the tenant it belongs to.
  const tenantId = req.tenantId;
  if (!tenantId) throw new Error('requireAuth invoked without a resolved tenantId');
  const candidates = await db<ApiKeyRow>(TABLES.ApiKey)
    .where({ prefix, tenantId })
    .whereNull('revokedAt');
  const match2 = candidates.find((row) => constantTimeEqual(row.keyHash, hash));
  if (!match2) return null;

  // Non-blocking last-used bump.
  void db<ApiKeyRow>(TABLES.ApiKey).where({ id: match2.id }).update({ lastUsedAt: new Date() });

  // Scoped keys take precedence — they're used by Network-style federation
  // where the caller has a narrow permission set rather than a role.
  if (Array.isArray(match2.scopes)) {
    return { role: 'scoped', source: 'db', apiKeyId: match2.id, scopes: match2.scopes };
  }
  if (match2.partnerId) {
    return { role: 'partner', source: 'db', apiKeyId: match2.id, partnerId: match2.partnerId };
  }
  return { role: 'admin', source: 'db', apiKeyId: match2.id };
}

/**
 * Scope-granting middleware.
 *
 * Chain it BEFORE the normal role-based guards (requireAdmin /
 * requirePartnerOrAdmin / etc). It's a no-op for any non-scoped principal
 * — they fall through unchanged. If the request is carrying a scoped key,
 * we verify the key's scopes include the required one; on match, we
 * rewrite the principal to `admin` so every downstream auth check
 * transparently accepts it. On miss, we 403 immediately.
 *
 * This design means we didn't have to teach every existing endpoint about
 * scopes — just add `grantScope('x:y')` to the routes federation reaches.
 */
export function grantScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const p = req.principal;
    if (!p || p.role !== 'scoped') return next();
    if (!p.scopes.includes(scope)) {
      res.status(403).json({ error: 'forbidden_scope', required: scope });
      return;
    }
    req.principal = { role: 'admin', source: 'db', apiKeyId: p.apiKeyId };
    next();
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createApiKeyRow(
  db: Knex,
  params: {
    tenantId: string;
    partnerId?: string | null;
    scopes?: string[] | null;
    label?: string;
  },
): Promise<{ id: string; plaintext: string }> {
  const { plaintext, prefix, hash } = generateApiKey();
  const id = ulid();
  await db<ApiKeyRow>(TABLES.ApiKey).insert({
    id,
    tenantId: params.tenantId,
    prefix,
    keyHash: hash,
    partnerId: params.partnerId ?? null,
    // pg jsonb: arrays need stringification; null stays null
    scopes: params.scopes != null
      ? (JSON.stringify(params.scopes) as unknown as never)
      : null,
    label: params.label ?? null,
  });
  return { id, plaintext };
}
