/**
 * Stripe reconciliation for Admin → Tracking health: the brand's own Stripe
 * revenue next to what OpenPartner recorded from it and credited to
 * partners, payment by payment, so a leak shows up as a list of payments
 * rather than a plausible-looking total.
 *
 * Read on demand through the brand's Stripe access (the Stripe App on
 * hosted; a single-tenant self-host's own STRIPE_SECRET_KEY) and matched
 * against the raw Event, Attribution, Identity, Click and Coupon rows.
 * Nothing is stored, so there's nothing to export; the route keeps a short
 * in-process cache because listing Stripe takes seconds.
 *
 * The payments are the two kinds the Stripe pipeline records revenue from
 * (routes/stripe-webhook.ts): paid invoices (subscriptions and other
 * invoices; Event metadata.stripeInvoiceId) and paid one-time Checkout
 * Sessions without an invoice (metadata.stripeCheckoutSessionId), created
 * in the window. Each is one of:
 *
 *   credited    recorded, and credited to a partner
 *   recorded    recorded, credited to nobody (Tracking health's
 *               "conversions that credited nobody" says why)
 *   missed      not recorded, though it carries a partner signal: a
 *               customer linked to a partner click, a client_reference_id
 *               naming one of the program's clicks, or a partner's
 *               promotion code. These are the leaks: a webhook that never
 *               arrived (the catch-up recovers those within 72 hours), or
 *               a payment the pipeline couldn't map.
 *   unreferred  not recorded and no partner signal: a customer who didn't
 *               come through a partner. The pipeline only records
 *               payments it can tie to one, so most revenue is here.
 *
 * Amounts are gross (before refunds), per currency, never added across
 * currencies. Payments taken outside invoices and Checkout (a PaymentIntent
 * the brand's backend charges directly) aren't recorded from Stripe at all
 * and aren't listed: report those with the conversions API.
 */

import type Stripe from 'stripe';
import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';
import { stripe as platformStripe } from './stripe.js';
import { fromStripeMinor } from './stripe-amounts.js';
import { tenantDefaultCurrency } from './currency.js';
import {
  StripeConnectionUnavailableError,
  activeConnectionForTenant,
  brandStripe,
  isHostedMode,
} from './stripe-app.js';
import { getTenancyMode } from './tenancy.js';

export const RECONCILE_MAX_DAYS = 90;
/** Per kind (invoices, Checkout Sessions). Past it the result is partial. */
export const MAX_PAYMENTS_PER_KIND = 2000;
const PAGE_SIZE = 100;
/** Missed payments listed, newest first. */
const MISSED_LISTED = 50;
/** What the brand's Stripe access must be able to read. */
export const RECONCILE_PERMISSIONS = ['invoice_read', 'checkout_session_read', 'customer_read'] as const;

export type PaymentKind = 'invoice' | 'checkout';
export type PaymentClass = 'credited' | 'recorded' | 'missed' | 'unreferred';
export type PartnerSignal = 'linked_customer' | 'partner_click' | 'partner_code';

interface StripePayment {
  kind: PaymentKind;
  id: string;
  created: number;
  amountMinor: number;
  currency: string;
  customerId: string | null;
  /** The brand's own user id on the Customer (openpartner_user_id). */
  merchantUserId: string | null;
  clientReferenceId: string | null;
  promotionCodeIds: string[];
  paymentIntentId: string | null;
}

export interface CurrencyTotals {
  currency: string;
  stripe: number;
  recorded: number;
  credited: number;
  missed: number;
  unreferred: number;
}

export interface MissedPayment {
  kind: PaymentKind;
  id: string;
  created: string;
  amount: number;
  currency: string;
  signals: PartnerSignal[];
  dashboardUrl: string | null;
}

export interface StripeReconciliation {
  available: true;
  window: { days: number; since: string };
  computedAt: string;
  livemode: boolean;
  /** A kind hit MAX_PAYMENTS_PER_KIND: the oldest payments weren't read. */
  truncated: boolean;
  counts: Record<PaymentClass, number> & { payments: number };
  totals: CurrencyTotals[];
  missed: MissedPayment[];
}

export type ReconcileUnavailable =
  | 'not_connected'
  | 'reconnect_needed'
  | 'missing_permissions'
  | 'stripe_error';

export type StripeReconciliationResult =
  | StripeReconciliation
  | { available: false; reason: ReconcileUnavailable; detail?: string };

const idOf = (v: unknown): string | null =>
  typeof v === 'string' ? v : v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' ? (v as { id: string }).id : null;

/** A Customer field that may be an id, an expanded Customer or a deleted one. */
function customerOf(v: unknown): { id: string | null; merchantUserId: string | null } {
  if (!v) return { id: null, merchantUserId: null };
  if (typeof v === 'string') return { id: v, merchantUserId: null };
  const c = v as { id?: string; deleted?: boolean; metadata?: Record<string, string> | null };
  return { id: c.id ?? null, merchantUserId: c.deleted ? null : c.metadata?.openpartner_user_id ?? null };
}

function promotionCodesOf(discounts: unknown): string[] {
  if (!Array.isArray(discounts)) return [];
  const out: string[] = [];
  for (const d of discounts) {
    // An invoice lists discount ids, or Discount objects when expanded; a
    // Checkout Session lists { coupon, promotion_code }.
    const promo = idOf((d as { promotion_code?: unknown } | null)?.promotion_code);
    if (promo) out.push(promo);
  }
  return out;
}

async function listInvoices(stripe: Stripe, gte: number): Promise<{ payments: StripePayment[]; truncated: boolean }> {
  const payments: StripePayment[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.invoices.list({
      status: 'paid',
      created: { gte },
      limit: PAGE_SIZE,
      expand: ['data.customer', 'data.discounts'],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const inv of page.data) {
      if (!inv.id || !(inv.amount_paid > 0)) continue;
      const customer = customerOf(inv.customer);
      const rawPi = (inv as unknown as { payment_intent?: unknown }).payment_intent;
      payments.push({
        kind: 'invoice',
        id: inv.id,
        created: inv.created,
        amountMinor: inv.amount_paid,
        currency: (inv.currency ?? 'usd').toUpperCase(),
        customerId: customer.id,
        merchantUserId: customer.merchantUserId,
        clientReferenceId: null,
        promotionCodeIds: promotionCodesOf(inv.discounts),
        paymentIntentId: idOf(rawPi),
      });
    }
    if (payments.length >= MAX_PAYMENTS_PER_KIND) return { payments, truncated: page.has_more };
    if (!page.has_more || page.data.length === 0) return { payments, truncated: false };
    startingAfter = page.data[page.data.length - 1]!.id;
  }
}

async function listCheckoutPayments(stripe: Stripe, gte: number): Promise<{ payments: StripePayment[]; truncated: boolean }> {
  const payments: StripePayment[] = [];
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.checkout.sessions.list({
      created: { gte },
      status: 'complete',
      limit: PAGE_SIZE,
      expand: ['data.customer'],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const s of page.data) {
      // The same sessions the pipeline takes revenue from (checkoutPaymentRevenue):
      // a subscription's, or one that made an invoice, is paid by an invoice.
      if (s.mode !== 'payment' || s.payment_status !== 'paid' || s.invoice || !((s.amount_total ?? 0) > 0)) continue;
      const customer = customerOf(s.customer);
      payments.push({
        kind: 'checkout',
        id: s.id,
        created: s.created,
        amountMinor: s.amount_total ?? 0,
        currency: (s.currency ?? 'usd').toUpperCase(),
        customerId: customer.id,
        merchantUserId: customer.merchantUserId,
        clientReferenceId: s.client_reference_id ?? null,
        promotionCodeIds: promotionCodesOf((s as unknown as { discounts?: unknown }).discounts),
        paymentIntentId: idOf(s.payment_intent),
      });
    }
    if (payments.length >= MAX_PAYMENTS_PER_KIND) return { payments, truncated: page.has_more };
    if (!page.has_more || page.data.length === 0) return { payments, truncated: false };
    startingAfter = page.data[page.data.length - 1]!.id;
  }
}

function dashboardUrl(p: StripePayment, livemode: boolean): string | null {
  const base = `https://dashboard.stripe.com/${livemode ? '' : 'test/'}`;
  if (p.kind === 'invoice') return `${base}invoices/${p.id}`;
  return p.paymentIntentId ? `${base}payments/${p.paymentIntentId}` : null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function reconcileStripe(
  db: Knex,
  tenantId: string,
  stripe: Stripe,
  opts: { days: number; livemode: boolean; now?: Date },
): Promise<StripeReconciliation> {
  const days = Math.min(Math.max(Math.trunc(opts.days), 1), RECONCILE_MAX_DAYS);
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  const gte = Math.floor(since.getTime() / 1000);

  const invoices = await listInvoices(stripe, gte);
  const checkouts = await listCheckoutPayments(stripe, gte);
  const payments = [...invoices.payments, ...checkouts.payments];

  // What the pipeline recorded from these payments, and whether it credited them.
  const recorded = (await db(`${TABLES.Event} as e`)
    .where('e.tenantId', tenantId)
    .andWhere('e.ts', '>=', since)
    .whereNotNull('e.value')
    .where((q) =>
      q.whereRaw(`e."metadata"->>'stripeInvoiceId' is not null`).orWhereRaw(`e."metadata"->>'stripeCheckoutSessionId' is not null`),
    )
    .select(
      db.raw(`e."metadata"->>'stripeInvoiceId' as "invoiceId"`),
      db.raw(`e."metadata"->>'stripeCheckoutSessionId' as "sessionId"`),
      db.raw(
        `exists (select 1 from ?? a where a."eventId" = e.id and a."tenantId" = e."tenantId") as credited`,
        [TABLES.Attribution],
      ),
    )) as Array<{ invoiceId: string | null; sessionId: string | null; credited: boolean }>;
  const recordedBy = new Map<string, { credited: boolean }>();
  for (const r of recorded) {
    const key = r.invoiceId ?? r.sessionId;
    if (!key) continue;
    const seen = recordedBy.get(key);
    recordedBy.set(key, { credited: (seen?.credited ?? false) || r.credited });
  }

  // Partner signals for the payments nothing was recorded from.
  const unrecorded = payments.filter((p) => !recordedBy.has(p.id));
  const userIds = [...new Set(unrecorded.flatMap((p) => [p.customerId, p.merchantUserId]).filter((v): v is string => !!v))];
  const crefs = [...new Set(unrecorded.map((p) => p.clientReferenceId).filter((v): v is string => !!v))];
  const promoIds = [...new Set(unrecorded.flatMap((p) => p.promotionCodeIds))];
  const linkedUsers = new Set<string>();
  for (let i = 0; i < userIds.length; i += 500) {
    const rows = (await db(TABLES.Identity)
      .where({ tenantId })
      .whereIn('userId', userIds.slice(i, i + 500))
      .distinct('userId')) as Array<{ userId: string }>;
    for (const r of rows) linkedUsers.add(r.userId);
  }
  const knownClicks = new Set<string>();
  for (let i = 0; i < crefs.length; i += 500) {
    const ids = (await db(TABLES.Click).where({ tenantId }).whereIn('id', crefs.slice(i, i + 500)).pluck('id')) as string[];
    for (const id of ids) knownClicks.add(id);
  }
  const partnerPromos = new Set<string>();
  for (let i = 0; i < promoIds.length; i += 500) {
    const ids = (await db(TABLES.Coupon)
      .where({ tenantId })
      .whereIn('stripePromotionCodeId', promoIds.slice(i, i + 500))
      .pluck('stripePromotionCodeId')) as string[];
    for (const id of ids) partnerPromos.add(id);
  }

  const primary = await tenantDefaultCurrency(db, tenantId);
  const counts = { payments: payments.length, credited: 0, recorded: 0, missed: 0, unreferred: 0 };
  const totals = new Map<string, CurrencyTotals>();
  const missed: Array<MissedPayment & { createdSec: number }> = [];
  for (const p of payments) {
    const amount = fromStripeMinor(p.amountMinor, p.currency);
    const t =
      totals.get(p.currency) ??
      { currency: p.currency, stripe: 0, recorded: 0, credited: 0, missed: 0, unreferred: 0 };
    totals.set(p.currency, t);
    t.stripe += amount;

    const rec = recordedBy.get(p.id);
    if (rec) {
      t.recorded += amount;
      if (rec.credited) {
        t.credited += amount;
        counts.credited += 1;
      } else {
        counts.recorded += 1;
      }
      continue;
    }
    const signals: PartnerSignal[] = [];
    if ([p.customerId, p.merchantUserId].some((u) => u && linkedUsers.has(u))) signals.push('linked_customer');
    if (p.clientReferenceId && knownClicks.has(p.clientReferenceId)) signals.push('partner_click');
    if (p.promotionCodeIds.some((id) => partnerPromos.has(id))) signals.push('partner_code');
    if (signals.length > 0) {
      t.missed += amount;
      counts.missed += 1;
      missed.push({
        kind: p.kind,
        id: p.id,
        created: new Date(p.created * 1000).toISOString(),
        createdSec: p.created,
        amount,
        currency: p.currency,
        signals,
        dashboardUrl: dashboardUrl(p, opts.livemode),
      });
    } else {
      t.unreferred += amount;
      counts.unreferred += 1;
    }
  }

  return {
    available: true,
    window: { days, since: since.toISOString() },
    computedAt: now.toISOString(),
    livemode: opts.livemode,
    truncated: invoices.truncated || checkouts.truncated,
    counts,
    totals: [...totals.values()]
      .map((t) => ({
        currency: t.currency,
        stripe: round2(t.stripe),
        recorded: round2(t.recorded),
        credited: round2(t.credited),
        missed: round2(t.missed),
        unreferred: round2(t.unreferred),
      }))
      // The brand's default currency first, then by code: amounts in
      // different currencies don't compare.
      .sort((a, b) => (a.currency === primary ? -1 : b.currency === primary ? 1 : a.currency.localeCompare(b.currency))),
    missed: missed
      .sort((a, b) => b.createdSec - a.createdSec)
      .slice(0, MISSED_LISTED)
      .map(({ createdSec: _sec, ...m }) => m),
  };
}

/**
 * The brand's Stripe, read-only, for reconcileStripe: the Stripe App
 * connection on hosted (with the read permissions it needs), or a
 * single-tenant self-host's own STRIPE_SECRET_KEY, which is the brand's
 * account there. Anything else has no Stripe of the brand's to read.
 */
export async function brandStripeAccess(
  db: Knex,
  tenantId: string,
): Promise<{ ok: true; stripe: Stripe; livemode: boolean } | { ok: false; reason: ReconcileUnavailable }> {
  if (isHostedMode()) {
    const conn = await activeConnectionForTenant(db, tenantId);
    if (!conn) return { ok: false, reason: 'not_connected' };
    if (conn.refreshFailedAt) return { ok: false, reason: 'reconnect_needed' };
    const granted = conn.permissionsGranted;
    if (Array.isArray(granted) && !RECONCILE_PERMISSIONS.every((p) => granted.includes(p))) {
      return { ok: false, reason: 'missing_permissions' };
    }
    try {
      return { ok: true, stripe: await brandStripe(conn), livemode: conn.livemode };
    } catch (err) {
      if (err instanceof StripeConnectionUnavailableError) {
        return { ok: false, reason: err.reason === 'disconnected' ? 'not_connected' : 'reconnect_needed' };
      }
      throw err;
    }
  }
  if (getTenancyMode() !== 'single' || !platformStripe) return { ok: false, reason: 'not_connected' };
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  return { ok: true, stripe: platformStripe, livemode: key.startsWith('sk_live_') || key.startsWith('rk_live_') };
}
