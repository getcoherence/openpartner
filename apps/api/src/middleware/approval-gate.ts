/**
 * Brand-approval gate.
 *
 * A brand that hasn't cleared review (Tenant.approvalStatus !== 'approved')
 * can sign in and CONFIGURE — create programs, set branding, wire settings —
 * but it can't GO LIVE. "Going live" is anything that exposes the brand to
 * partners or the public marketplace, or brings partners in:
 *
 *   - POST /partners                              (invite a partner)
 *   - POST /partner-signup                        (public creator self-signup)
 *   - POST /import/partners-csv                   (bulk roster import)
 *   - POST /admin/network/offerings               (publish on the marketplace)
 *   - POST /admin/network/requests/:id/approve    (approve a creator application)
 *
 * The click router refuses to serve links for an unapproved brand
 * separately (apps/router), so no attribution data is collected either.
 * Everything else — reads, program/branding config, billing, auth, SDK
 * callbacks — stays open so a legitimate brand can be fully set up and
 * ready the moment an operator approves it.
 *
 * Rejected brands are additionally status='suspended', so they never even
 * resolve a tenant (tenancy.ts filters status='active') and never reach
 * this middleware — this gate is really the pending-brand fence.
 *
 * Runs after tenantMiddleware (needs tenant scope) and reads the tenant's
 * own row through req.db (RLS lets a tenant read its own Tenant row).
 */

import type { NextFunction, Request, Response } from 'express';
import { TABLES, type TenantRow } from '@openpartner/db';
import { tenantOf } from '../tenancy.js';

interface GatedRoute {
  method: string;
  test: (path: string) => boolean;
}

const GO_LIVE_ROUTES: GatedRoute[] = [
  { method: 'POST', test: (p) => p === '/partners' },
  { method: 'POST', test: (p) => p === '/partner-signup' },
  { method: 'POST', test: (p) => p === '/import/partners-csv' },
  { method: 'POST', test: (p) => p === '/admin/network/offerings' },
  { method: 'POST', test: (p) => /^\/admin\/network\/requests\/[^/]+\/approve$/.test(p) },
];

/** Exported for tests: is this (method, path) a go-live action? */
export function isGoLiveRoute(method: string, path: string): boolean {
  return GO_LIVE_ROUTES.some((g) => g.method === method && g.test(path));
}

export async function approvalGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isGoLiveRoute(req.method, req.path)) return next();

  let scope: ReturnType<typeof tenantOf>;
  try {
    scope = tenantOf(req);
  } catch {
    // No tenant scope — let auth middleware handle it (same posture as the
    // trial gate).
    return next();
  }

  const tenant = await scope.db<TenantRow>(TABLES.Tenant)
    .where({ id: scope.tenantId })
    .first('approvalStatus');
  // Missing row shouldn't happen inside a resolved tenant scope; default to
  // open rather than trap a legitimate request on a read glitch.
  if (tenant && tenant.approvalStatus !== 'approved') {
    res.status(403).json({
      error: 'brand_pending_review',
      detail:
        'This brand is awaiting approval. You can finish setting up your program, but partner onboarding and going live unlock once an OpenPartner operator approves your account.',
      approvalStatus: tenant.approvalStatus,
    });
    return;
  }
  next();
}
