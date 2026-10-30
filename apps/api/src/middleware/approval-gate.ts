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
 *   - POST /admin/network/offerings/:id/invite-creator (email a creator)
 *   - POST /admin/network/requests/:id/approve    (approve a creator application)
 *   - POST /config/network/start-connect|complete-connect, and
 *     POST /config/network carrying a token/URL   (re-federate under a
 *                                                  different vendor identity)
 *   - POST /bonuses                               (pay a partner a bonus)
 *   - POST /partners/:id/signin-link and
 *     POST /partners/signin-link                  (sign a partner in to the
 *                                                  portal from the brand's app)
 *
 * The click router refuses to serve links for an unapproved brand
 * separately (apps/router), so no attribution data is collected either.
 *
 * Marketplace LISTING is not fenced here: saving a program syncs its
 * offering to the Network (campaign-marketplace-sync.ts), and the Network
 * itself keeps a vendor's offerings out of discovery until its
 * reviewStatus is 'approved' (pushed by brand-review.ts + the
 * network-review-reconcile job). The re-federation routes above are gated
 * because they'd let a pending brand mint a second, un-reviewed vendor.
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
  /** Optional body predicate — the route is only go-live when it holds. */
  when?: (body: Record<string, unknown>) => boolean;
}

const GO_LIVE_ROUTES: GatedRoute[] = [
  { method: 'POST', test: (p) => p === '/partners' },
  { method: 'POST', test: (p) => p === '/partner-signup' },
  { method: 'POST', test: (p) => p === '/import/partners-csv' },
  { method: 'POST', test: (p) => p === '/admin/network/offerings' },
  { method: 'POST', test: (p) => /^\/admin\/network\/offerings\/[^/]+\/invite-creator$/.test(p) },
  { method: 'POST', test: (p) => /^\/admin\/network\/requests\/[^/]+\/approve$/.test(p) },
  { method: 'POST', test: (p) => p === '/config/network/start-connect' },
  { method: 'POST', test: (p) => p === '/config/network/complete-connect' },
  // Moves money to a partner.
  { method: 'POST', test: (p) => p === '/bonuses' },
  // Opens the partner portal for a partner (routes/partner-signin-link.ts).
  { method: 'POST', test: (p) => /^\/partners(\/[^/]+)?\/signin-link$/.test(p) },
  // Storefront outreach (openpartner-network docs/creator-storefront.md
  // §8): booking a creator or starting a conversation with one, and tracking
  // a booking, which makes the creator a partner. A brand in review can still
  // answer, pay and approve in a conversation its own claimed request opened.
  { method: 'POST', test: (p) => p === '/admin/network/bookings' },
  { method: 'POST', test: (p) => p === '/admin/network/conversations' },
  { method: 'POST', test: (p) => /^\/admin\/network\/bookings\/[^/]+\/track$/.test(p) },
  // Inviting a creator who isn't on OpenPartner yet emails them on the
  // brand's behalf (openpartner-network docs/creator-index.md §5).
  { method: 'POST', test: (p) => p === '/admin/network/creator-invites' },
  {
    method: 'POST',
    test: (p) => p === '/config/network',
    // Toggling membership off (or autoEnroll) is configuration; swapping in
    // a vendor token or Network URL is re-federation.
    when: (b) => b.vendorToken !== undefined || (typeof b.networkUrl === 'string' && b.networkUrl !== ''),
  },
];

/**
 * Express matches routes case-insensitively and ignores a trailing slash
 * (no `caseSensitive` / `strict` on the app), so `POST /Partners/` reaches
 * the /partners handler. Match on the same canonical form, or the gate is
 * one capital letter from bypassed. Shared with the trial gate.
 */
export function canonicalPath(path: string): string {
  const lower = path.toLowerCase();
  const trimmed = lower.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Exported for tests: is this (method, path[, body]) a go-live action? */
export function isGoLiveRoute(method: string, path: string, body: unknown = {}): boolean {
  const p = canonicalPath(path);
  const m = method.toUpperCase();
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  return GO_LIVE_ROUTES.some((g) => g.method === m && g.test(p) && (g.when ? g.when(b) : true));
}

export async function approvalGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!isGoLiveRoute(req.method, req.path, req.body)) return next();

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
