/**
 * Funding authorization gate — spec §10/§12 (brand surface).
 *
 * Before any batch can charge a brand, the brand must have BOTH accepted
 * the funding terms and completed a bank-debit SetupIntent (us_bank_account
 * — the ACH-first launch rail; card is counsel-gated). The flow uses
 * Stripe Checkout in setup mode, matching the existing subscription
 * checkout UX: redirect out, mandate + bank verification handled by
 * Stripe, redirect back, /complete verifies the live session and writes
 * the HostedFundingAuthorization row.
 *
 * Revocation stops NEW batches only — money already reserved or in flight
 * follows the state machine to its terminal state.
 */

import { Router } from 'express';
import { z } from 'zod';
import type Stripe from 'stripe';
import { TABLES, type HostedFundingBatchRow } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import { requireStripe } from '../stripe.js';
import { tenantOf } from '../tenancy.js';
import { getTenantBillingState } from '../billing-plan.js';
import { fundingEnabled, FUNDING_TERMS_VERSION, minorToMajorString } from '../funding/state.js';
import { getFundingAuthorization } from '../funding/reserve.js';
import { ulid } from 'ulid';

export const fundingRouter = Router();

fundingRouter.get('/billing/funding', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const state = await getTenantBillingState(db, tenantId);
  if (state.mode === 'selfhost') {
    return res.json({ available: false, reason: 'selfhost' });
  }
  const auth = await getFundingAuthorization(db, tenantId);
  const batches = (await db(TABLES.HostedFundingBatch)
    .where({ tenantId })
    .orderBy('createdAt', 'desc')
    .limit(10)) as HostedFundingBatchRow[];
  res.json({
    available: true,
    enabled: fundingEnabled(),
    termsVersion: FUNDING_TERMS_VERSION,
    currency: 'usd',
    authorization: auth
      ? {
          acceptedAt: auth.acceptedAt,
          termsVersion: auth.termsVersion,
          paymentMethodType: auth.paymentMethodType,
        }
      : null,
    batches: batches.map((b) => ({
      id: b.id,
      status: b.status,
      currency: b.currency,
      principal: minorToMajorString(b.principalMinor),
      grossCharge: minorToMajorString(b.grossChargeMinor),
      residual: minorToMajorString(b.residualMinor ?? 0),
      createdAt: b.createdAt,
      fundedAt: b.fundedAt,
      settledAt: b.settledAt,
      // NORMALIZED, not the raw column. `failureReason` carries raw
      // Stripe error text, internal state-machine reasons and Stripe
      // object ids (`orphan_payment_intent:pi_…`) — an internal contract
      // that shouldn't leak into a brand-facing surface. The flag is what
      // the UI needs: something happened to this batch that its status
      // alone doesn't show. Operators get the detail from the logs.
      needsAttention: !!b.failureReason,
    })),
  });
});

const setupSchema = z.object({
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  /** Explicit terms acceptance — the portal checkbox. Must match the
   *  current version so stale UI can't record acceptance of terms the
   *  admin never saw. */
  termsVersion: z.literal(FUNDING_TERMS_VERSION),
});

fundingRouter.post('/billing/funding/setup', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const state = await getTenantBillingState(db, tenantId);
  if (state.mode === 'selfhost') return res.status(400).json({ error: 'no_billing_in_selfhost' });
  if (!state.stripeCustomerId || !state.stripeSubscriptionId) {
    return res.status(409).json({
      error: 'subscription_required',
      detail: 'Activate a plan before setting up commission funding.',
    });
  }
  const body = setupSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const principal = req.principal;
  // Null = authorized via the env operator key (no Admin row exists).
  const adminId = principal && 'adminId' in principal ? principal.adminId : null;

  const stripe = requireStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'setup',
    customer: state.stripeCustomerId,
    // ACH-first launch (spec §12): bank debit only. Do NOT add 'card'
    // here without reading §12 — the card fee path is counsel-gated.
    payment_method_types: ['us_bank_account'],
    success_url: body.data.successUrl,
    cancel_url: body.data.cancelUrl,
    metadata: {
      openpartner_tenant_id: tenantId,
      ...(adminId ? { openpartner_admin_id: adminId } : {}),
      openpartner_funding_terms: body.data.termsVersion,
    },
  });
  res.json({ url: session.url });
});

fundingRouter.post('/billing/funding/complete', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = z.object({ sessionId: z.string().min(1) }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const stripe = requireStripe();
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(body.data.sessionId, {
      expand: ['setup_intent'],
    });
  } catch {
    return res.status(404).json({ error: 'session_not_found' });
  }
  // The session id arrives via redirect query param — verify it is OUR
  // session for THIS tenant and actually completed before trusting it.
  if (session.metadata?.openpartner_tenant_id !== tenantId) {
    return res.status(403).json({ error: 'session_tenant_mismatch' });
  }
  if (session.status !== 'complete') {
    return res.status(409).json({ error: 'session_incomplete', status: session.status });
  }
  const si = typeof session.setup_intent === 'object' ? session.setup_intent : null;
  const paymentMethodId =
    si && typeof si.payment_method === 'string'
      ? si.payment_method
      : si && si.payment_method && typeof si.payment_method === 'object'
        ? si.payment_method.id
        : null;
  if (!si || si.status !== 'succeeded' || !paymentMethodId) {
    return res.status(409).json({ error: 'setup_incomplete', status: si?.status ?? 'missing' });
  }

  const termsVersion = session.metadata?.openpartner_funding_terms ?? FUNDING_TERMS_VERSION;
  // Metadata round-trips through Stripe — re-verify the admin still
  // exists rather than trusting it into the FK.
  const claimedAdminId = session.metadata?.openpartner_admin_id ?? null;
  const adminRow = claimedAdminId
    ? await db(TABLES.Admin).where({ id: claimedAdminId }).first(['id'])
    : null;
  const adminId = adminRow ? claimedAdminId : null;

  // One live authorization per tenant (unique tenantId, revoked rows
  // deleted on replace) — completing setup again rotates the mandate.
  await db.transaction(async (trx) => {
    await trx(TABLES.HostedFundingAuthorization).where({ tenantId }).del();
    await trx(TABLES.HostedFundingAuthorization).insert({
      id: ulid(),
      tenantId,
      adminId,
      termsVersion,
      stripePaymentMethodId: paymentMethodId,
      paymentMethodType: 'us_bank_account',
      acceptedAt: new Date(),
      revokedAt: null,
    });
  });

  const auth = await getFundingAuthorization(db, tenantId);
  res.json({ ok: true, authorization: { acceptedAt: auth!.acceptedAt, termsVersion: auth!.termsVersion } });
});

fundingRouter.post('/billing/funding/revoke', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const updated = await db(TABLES.HostedFundingAuthorization)
    .where({ tenantId })
    .whereNull('revokedAt')
    .update({ revokedAt: new Date() });
  if (updated === 0) return res.status(404).json({ error: 'no_active_authorization' });
  // In-flight batches follow the state machine to terminal states; only
  // NEW reservations stop (runPayouts checks the live authorization).
  res.json({ ok: true, revoked: true });
});
