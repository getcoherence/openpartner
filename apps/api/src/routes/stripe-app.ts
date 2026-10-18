/**
 * Connect Stripe (hosted brands) — the admin side of the OpenPartner Stripe
 * App. stripe-app.ts holds the tokens and rules; this file is the HTTP.
 *
 *   GET    /stripe-app/connection           status for Admin → Integrations
 *   POST   /stripe-app/connection/start     → the Stripe install link
 *   GET    /stripe-app/oauth/callback       Stripe redirects here (no tenant)
 *   POST   /stripe-app/connection/complete  exchange the code, store tokens
 *   DELETE /stripe-app/connection           disconnect
 *
 * The install round trip, and why it takes two hops:
 *
 *   1. start signs a state binding the tenant, the admin, the link type
 *      and the portal page to return to (stripe-app.ts signOAuthState).
 *   2. Stripe sends the admin to the ONE redirect URI the manifest allows,
 *      on the platform origin. That request carries no tenant, and for a
 *      white-label admin no session either: their session cookie is
 *      host-only, on the brand's custom domain. So the callback checks the
 *      state's signature, wraps code + state in an encrypted grant, and
 *      bounces the admin back to the page they started on.
 *   3. That page POSTs the grant to complete, under the admin's session.
 *      complete exchanges the code only if the state names this tenant AND
 *      this admin.
 *
 * Step 3 is what makes the state worth having. A forged install — an
 * attacker's own state handed to a victim who then installs on their
 * Stripe account — dead-ends: the victim has no admin session on the
 * attacker's tenant, so the code is never exchanged and expires in five
 * minutes. The grant is encrypted so the code never sits readable in a
 * portal URL (page analytics, history).
 */

import { Router } from 'express';
import { z } from 'zod';
import type { TenantStripeConnectionRow } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import {
  STRIPE_APP_KEY_MODES,
  STRIPE_APP_PERMISSIONS_VERSION,
  activeConnectionForTenant,
  allowedReturnUrl,
  completeConnection,
  configuredKeyModes,
  type CompleteConnectionResult,
  disconnectTenant,
  grantsRewardWrites,
  isHostedMode,
  signOAuthState,
  stripeAppInstallUrl,
  verifyOAuthState,
} from '../stripe-app.js';
import { tenantOf } from '../tenancy.js';

/** Tenant-scoped admin routes. Mounted after tenantMiddleware. */
export const stripeAppRouter = Router();

/** The OAuth callback. Platform-wide; mounted before tenantMiddleware. */
export const stripeAppCallbackRouter = Router();

const UNINSTALL_HINT =
  'OpenPartner no longer reads your Stripe account. To remove the app from Stripe too, uninstall OpenPartner under Settings → Installed apps in your Stripe Dashboard.';

function summarize(conn: TenantStripeConnectionRow) {
  return {
    stripeAccountId: conn.stripeAccountId,
    livemode: conn.livemode,
    connectedAt: conn.connectedAt,
    lastEventAt: conn.lastEventAt,
    needsReconnect: conn.refreshFailedAt != null,
    refreshError: conn.refreshError,
    // The manifest has gained permissions since this brand accepted it.
    permissionsOutdated: conn.permissionsVersion < STRIPE_APP_PERMISSIONS_VERSION,
    rewards: conn.refreshFailedAt == null && grantsRewardWrites(conn),
  };
}

stripeAppRouter.get('/stripe-app/connection', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  if (!isHostedMode()) {
    // A self-host's own STRIPE_SECRET_KEY + /webhooks/stripe already is
    // the brand's Stripe connection.
    return res.json({ available: false, reason: 'selfhost', modes: [], connection: null });
  }
  const modes = configuredKeyModes();
  const conn = await activeConnectionForTenant(db, tenantId);
  res.json({
    available: modes.length > 0,
    ...(modes.length === 0 ? { reason: 'not_configured' } : {}),
    modes,
    connection: conn ? summarize(conn) : null,
  });
});

const startSchema = z.object({
  mode: z.enum(STRIPE_APP_KEY_MODES as [string, ...string[]]).default('live'),
  /** The page to come back to — the browser's own location, so a
   *  white-label admin returns to the host their session is on. */
  returnUrl: z.string().url().max(2000),
});

stripeAppRouter.post('/stripe-app/connection/start', requireAuth, requireAdmin, async (req, res) => {
  const { tenantId } = tenantOf(req);
  const principal = req.principal;
  // Only a signed-in person can finish an install (complete checks the
  // session's admin), so only one may start it.
  if (principal?.role !== 'admin' || principal.source !== 'session') {
    return res.status(403).json({ error: 'session_required', detail: 'Sign in to the admin portal with your email, not an API key, to connect Stripe.' });
  }
  if (!isHostedMode()) return res.status(404).json({ error: 'stripe_app_unavailable', reason: 'selfhost' });

  const body = startSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const mode = body.data.mode as (typeof STRIPE_APP_KEY_MODES)[number];
  if (!configuredKeyModes().includes(mode)) {
    return res.status(404).json({ error: 'stripe_app_unavailable', reason: 'not_configured', mode });
  }
  const returnUrl = allowedReturnUrl(body.data.returnUrl, { customDomain: req.tenantCustomDomain ?? null });
  if (!returnUrl) {
    return res.status(400).json({ error: 'invalid_return_url', detail: 'returnUrl must be a page on this portal.' });
  }

  const state = signOAuthState({ t: tenantId, a: principal.adminId, m: mode, r: returnUrl });
  res.json({ url: stripeAppInstallUrl(mode, state) });
});

/** The callback's encrypted handoff to the portal. */
interface Grant {
  code: string;
  state: string;
}

const CALLBACK_PATH = '/stripe-app/oauth/callback';

function callbackError(res: import('express').Response, status: number, message: string) {
  // No redirect target is trustworthy without a valid state, so say it here.
  res
    .status(status)
    .type('html')
    .set('Cache-Control', 'no-store')
    .send(
      `<!doctype html><meta charset="utf-8"><title>Connect Stripe</title><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.25rem">Couldn’t finish connecting Stripe</h1><p>${message}</p><p>Start again from <strong>Admin → Integrations → Connect Stripe</strong>.</p></body>`,
    );
}

stripeAppCallbackRouter.get(CALLBACK_PATH, (req, res) => {
  const q = (name: string) => (typeof req.query[name] === 'string' ? (req.query[name] as string) : '');
  const rawState = q('state');
  const state = rawState ? verifyOAuthState(rawState) : null;
  if (!state) return callbackError(res, 400, 'This link has expired or wasn’t started from OpenPartner.');

  const back = new URL(state.r);
  // The admin backed out, or Stripe refused. Its error code is safe to
  // show; the description goes nowhere.
  if (q('error') || !q('code')) {
    back.searchParams.set('stripe_app_error', (q('error') || 'missing_code').slice(0, 64));
    return res.redirect(302, back.toString());
  }
  const grant: Grant = { code: q('code'), state: rawState };
  back.searchParams.set('stripe_app_grant', encryptSecret(JSON.stringify(grant)));
  res.set('Cache-Control', 'no-store').redirect(302, back.toString());
});

const completeSchema = z.object({ grant: z.string().min(1).max(4000) });

stripeAppRouter.post('/stripe-app/connection/complete', requireAuth, requireAdmin, async (req, res) => {
  const { tenantId } = tenantOf(req);
  const principal = req.principal;
  if (principal?.role !== 'admin' || principal.source !== 'session') {
    return res.status(403).json({ error: 'session_required', detail: 'Sign in to the admin portal with your email, not an API key, to connect Stripe.' });
  }
  if (!isHostedMode()) return res.status(404).json({ error: 'stripe_app_unavailable', reason: 'selfhost' });
  const body = completeSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  let grant: Grant;
  try {
    grant = JSON.parse(decryptSecret(body.data.grant)) as Grant;
  } catch {
    return res.status(400).json({ error: 'invalid_grant' });
  }
  const state = typeof grant.state === 'string' ? verifyOAuthState(grant.state) : null;
  if (!state || typeof grant.code !== 'string') return res.status(400).json({ error: 'invalid_grant' });
  // The binding the whole round trip exists for (see the file header).
  if (state.t !== tenantId || state.a !== principal.adminId) {
    return res.status(403).json({ error: 'state_mismatch', detail: 'This install was started by someone else.' });
  }
  if (!configuredKeyModes().includes(state.m)) {
    return res.status(404).json({ error: 'stripe_app_unavailable', reason: 'not_configured', mode: state.m });
  }

  const result = await completeConnection({
    tenantId,
    adminId: principal.adminId,
    code: grant.code,
    keyMode: state.m,
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error, detail: completeErrorDetail(result) });
  res.json({ connection: summarize(result.connection), replaced: result.replaced });
});

function completeErrorDetail(result: Extract<CompleteConnectionResult, { ok: false }>): string {
  switch (result.error) {
    case 'stripe_account_connected_elsewhere':
      return 'That Stripe account is already connected to another OpenPartner brand. Disconnect it there first.';
    case 'livemode_mismatch':
      return 'Stripe installed the app in a different mode than the link you used. Start again with the matching button.';
    case 'connection_in_progress':
      return 'Another Stripe connection for this brand was being saved at the same time. Reload and try again.';
    case 'oauth_code_rejected':
      return `Stripe rejected the install (${result.detail}). Start again — the link is only good for a few minutes.`;
  }
}

stripeAppRouter.delete('/stripe-app/connection', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const closed = await disconnectTenant(db, tenantId);
  res.json({ ok: true, disconnected: closed != null, detail: UNINSTALL_HINT });
});
