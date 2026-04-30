/**
 * Soft trial-gate.
 *
 * When a tenant's billing state is "trial expired without subscription"
 * (paid plan picked, trial used, no current Stripe sub), this middleware
 * returns 402 Payment Required on a small allowlist of "expensive"
 * write endpoints. The product keeps working — clicks still get
 * recorded, attribution still runs, the dashboard still renders, the
 * admin can still subscribe — but they can't expand the program until
 * billing is restored.
 *
 * What's gated:
 *   - POST /campaigns                 (create new program)
 *   - POST /partners                  (invite new partner)
 *   - POST /partners/:id/coupons      (mint coupon)
 *   - POST /partners/:id/campaigns    (grant program to partner)
 *   - POST /import/partners-csv       (bulk roster import)
 *   - POST /admin/network/offerings   (publish on the Network)
 *
 * What stays open (deliberate):
 *   - GET *                           (read; show their data)
 *   - POST /attribution/identify      (SDK callback — customer signed up)
 *   - POST /attribution/events        (SDK callback — revenue happened)
 *   - POST /coupons/redeem            (customer used a coupon at checkout)
 *   - POST /webhooks/stripe           (Stripe → us)
 *   - POST /billing/*                 (resubscribe, open portal)
 *   - POST /signin /signup /admins/login etc. (auth)
 *   - POST /attribution/* and click-router endpoints
 *
 * Rationale: don't silently lose attribution data the customer might
 * resubscribe to retrieve, and don't make them debug "why does the
 * SDK return errors" before they've seen the trial-expired banner.
 */

import type { NextFunction, Request, Response } from 'express';
import { tenantOf } from '../tenancy.js';
import { getTenantBillingState } from '../billing-plan.js';

// Methods+path patterns that get the 402. Keep narrow — every entry is
// a pinch point on the user's program-expansion workflow, not a
// catch-all "block everything that mutates".
interface GatedRoute {
  method: string;
  test: (path: string) => boolean;
}

const GATED: GatedRoute[] = [
  { method: 'POST', test: (p) => p === '/campaigns' },
  { method: 'POST', test: (p) => p === '/partners' },
  { method: 'POST', test: (p) => /^\/partners\/[^/]+\/coupons$/.test(p) },
  { method: 'POST', test: (p) => /^\/partners\/[^/]+\/campaigns$/.test(p) },
  { method: 'POST', test: (p) => p === '/import/partners-csv' },
  { method: 'POST', test: (p) => p === '/admin/network/offerings' },
];

export async function trialGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Match before the more expensive billing-state lookup — most
  // requests are not gated, and we don't want to add a DB hop to
  // every read.
  const matched = GATED.some((g) => g.method === req.method && g.test(req.path));
  if (!matched) return next();

  // Tenant scope is required for the lookup. If the request hasn't
  // been through tenantMiddleware (mounted globally before this), we
  // can't evaluate — let it through and rely on auth middleware to
  // handle it.
  let scope: ReturnType<typeof tenantOf> | null = null;
  try {
    scope = tenantOf(req);
  } catch {
    return next();
  }

  const state = await getTenantBillingState(scope.db, scope.tenantId);
  if (!state.trialExpiredWithoutSubscription) return next();

  res.status(402).json({
    error: 'trial_expired',
    detail:
      'Your 14-day trial has ended without an active subscription. Re-subscribe at /admin/billing to restore this action.',
    plan: state.plan,
  });
}
