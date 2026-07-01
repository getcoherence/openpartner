/**
 * Soft trial-gate.
 *
 * Two tiers of 402 gating:
 *   - PLAN_REQUIRED (partner onboarding): needs an ACTIVE subscription
 *     regardless of trial — a brand must pick a plan before it onboards
 *     its first partner (each brand is its own separately-billed tenant).
 *     error = 'plan_required'.
 *   - TRIAL_GATED (program expansion): soft-blocked only once the 14-day
 *     trial lapses without a subscription. error = 'trial_expired'.
 *
 * Either way the product keeps working — clicks still get recorded,
 * attribution still runs, the dashboard still renders, the admin can still
 * subscribe — we only gate the specific write actions listed below.
 *
 * What's gated:
 *   - POST /campaigns                       (create new program)
 *   - POST /partners                        (invite new partner OR
 *                                            federated approval landing)
 *   - POST /partners/:id/coupons            (mint coupon)
 *   - POST /partners/:id/programs          (grant program to partner)
 *   - POST /import/partners-csv             (bulk roster import)
 *   - POST /admin/network/offerings         (publish on the Network)
 *   - POST /admin/network/requests/:id/approve  (approve creator
 *                                            application coming through
 *                                            the Network)
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
import { getTenantBillingState, hasActivePlan, isTrialGateActive } from '../billing-plan.js';

// Methods+path patterns that get the 402. Keep narrow — every entry is
// a pinch point on the user's program-expansion workflow, not a
// catch-all "block everything that mutates".
interface GatedRoute {
  method: string;
  test: (path: string) => boolean;
}

// Partner-onboarding routes require an ACTIVE PLAN (subscription), not just
// an unexpired trial. A brand can explore during its trial, but must pick a
// plan (RevShare or Flex) before it brings in its first partner — per the
// per-brand billing policy (each brand is a separately-billed tenant).
// Enterprise + self-host are exempt (see hasActivePlan).
const PLAN_REQUIRED: GatedRoute[] = [
  { method: 'POST', test: (p) => p === '/partners' },
  { method: 'POST', test: (p) => /^\/admin\/network\/requests\/[^/]+\/approve$/.test(p) },
];

// Program-expansion routes: soft-gated only AFTER the trial expires without a
// subscription. During the trial these stay open so the brand can set up.
const TRIAL_GATED: GatedRoute[] = [
  { method: 'POST', test: (p) => p === '/programs' },
  { method: 'POST', test: (p) => /^\/partners\/[^/]+\/coupons$/.test(p) },
  { method: 'POST', test: (p) => /^\/partners\/[^/]+\/campaigns$/.test(p) },
  { method: 'POST', test: (p) => p === '/import/partners-csv' },
  { method: 'POST', test: (p) => p === '/admin/network/offerings' },
];

export async function trialGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Match before the more expensive billing-state lookup — most requests are
  // not gated, and we don't want to add a DB hop to every read.
  const planRequired = PLAN_REQUIRED.some((g) => g.method === req.method && g.test(req.path));
  const trialMatched = TRIAL_GATED.some((g) => g.method === req.method && g.test(req.path));
  if (!planRequired && !trialMatched) return next();

  // Tenant scope is required for the lookup. If the request hasn't been
  // through tenantMiddleware (mounted globally before this), we can't
  // evaluate — let it through and rely on auth middleware to handle it.
  let scope: ReturnType<typeof tenantOf> | null = null;
  try {
    scope = tenantOf(req);
  } catch {
    return next();
  }

  const state = await getTenantBillingState(scope.db, scope.tenantId);

  // Onboarding a partner requires a real plan — trial or not.
  if (planRequired && !hasActivePlan(state)) {
    res.status(402).json({
      error: 'plan_required',
      detail: 'Pick a plan (RevShare or Flex) at /admin/billing to start onboarding partners.',
      plan: state.plan,
      trialEndsAt: state.trialEndsAt?.toISOString() ?? null,
    });
    return;
  }

  // Program-expansion actions: soft-block only once the trial has lapsed
  // without a subscription.
  if (trialMatched && isTrialGateActive(state)) {
    res.status(402).json({
      error: 'trial_expired',
      detail:
        'Your 14-day evaluation period has ended. Subscribe at /admin/billing to continue expanding your program.',
      plan: state.plan,
      trialEndsAt: state.trialEndsAt?.toISOString() ?? null,
    });
    return;
  }

  return next();
}
