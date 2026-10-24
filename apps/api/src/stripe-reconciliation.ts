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
 *               customer linked to a partner click made before the
 *               payment, a client_reference_id naming one of the
 *               program's clicks (an invoiced Checkout's counts for its
 *               invoice), or a partner's code (its promotion code or Stripe
 *               coupon, by id, on the invoice, a line item or the
 *               Checkout). These are the leaks: a webhook that never
 *               arrived, or a payment the pipeline couldn't map.
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
import { CORRECTIVE_EVENT_TYPES } from './attribution.js';
import { tenantDefaultCurrency } from './currency.js';
import {
  StripeConnectionUnavailableError,
  activeConnectionForTenant,
  brandStripe,
  isHostedMode,
} from './stripe-app.js';
import { getTenancyMode } from './tenancy.js';

export const RECONCILE_MAX_DAYS = 90;
/** Payments read per kind (invoices, one-time Checkout payments). Past it
 *  the result is partial. */
export const MAX_PAYMENTS_PER_KIND = 2000;
/** Stripe objects listed per kind, payments or not (a subscription-heavy
 *  account lists many Checkout Sessions that aren't one-time payments). */
export const MAX_SCANNED_PER_KIND = 5000;
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
  discounts: DiscountIds[];
  paymentIntentId: string | null;
}

/** A discount's promotion code and Stripe coupon, by id. */
interface DiscountIds {
  promotionCode: string | null;
  coupon: string | null;
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

/**
 * The discounts on an invoice or Checkout Session, where the Stripe pipeline
 * looks for them (extractDiscounts in routes/stripe-webhook.ts):
 * `discounts` (an invoice's Discount objects when expanded; a session's
 * { coupon, promotion_code }), an invoice's `total_discount_amounts`, which
 * also covers line-item discounts, and a session's
 * `total_details.breakdown.discounts`. A discount names its coupon directly
 * or, from API 2025-03-31, under `source`.
 */
function discountsOf(obj: unknown): DiscountIds[] {
  const o = obj as {
    discounts?: unknown;
    total_discount_amounts?: Array<{ discount?: unknown }> | null;
    total_details?: { breakdown?: { discounts?: Array<{ discount?: unknown }> } | null } | null;
  };
  const refs: unknown[] = [
    ...(Array.isArray(o.discounts) ? o.discounts : []),
    ...(o.total_discount_amounts ?? []).map((t) => t.discount),
    ...(o.total_details?.breakdown?.discounts ?? []).map((t) => t.discount),
  ];
  const out: DiscountIds[] = [];
  for (const r of refs) {
    if (!r || typeof r !== 'object') continue;
    const d = r as { promotion_code?: unknown; coupon?: unknown; source?: { coupon?: unknown } | null };
    const ids = { promotionCode: idOf(d.promotion_code), coupon: idOf(d.coupon) ?? idOf(d.source?.coupon) };
    if (ids.promotionCode || ids.coupon) out.push(ids);
  }
  return out;
}

interface Listed {
  payments: StripePayment[];
  truncated: boolean;
}

async function listInvoices(stripe: Stripe, gte: number): Promise<Listed> {
  const payments: StripePayment[] = [];
  let scanned = 0;
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.invoices.list({
      status: 'paid',
      created: { gte },
      limit: PAGE_SIZE,
      expand: ['data.customer', 'data.discounts', 'data.total_discount_amounts.discount'],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const [i, inv] of page.data.entries()) {
      if (payments.length >= MAX_PAYMENTS_PER_KIND || scanned >= MAX_SCANNED_PER_KIND) {
        return { payments, truncated: i < page.data.length || page.has_more };
      }
      scanned += 1;
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
        discounts: discountsOf(inv),
        paymentIntentId: idOf(rawPi),
      });
    }
    if (!page.has_more || page.data.length === 0) return { payments, truncated: false };
    startingAfter = page.data[page.data.length - 1]!.id;
  }
}

/**
 * Paid one-time Checkout payments, plus what a Checkout that made an invoice
 * says about it: that invoice is the payment (counted once, as an invoice),
 * and the session's click and discounts are its referral evidence.
 */
async function listCheckoutPayments(
  stripe: Stripe,
  gte: number,
): Promise<Listed & { forInvoices: Map<string, { clientReferenceId: string | null; discounts: DiscountIds[] }> }> {
  const payments: StripePayment[] = [];
  const forInvoices = new Map<string, { clientReferenceId: string | null; discounts: DiscountIds[] }>();
  let scanned = 0;
  let startingAfter: string | undefined;
  for (;;) {
    const page = await stripe.checkout.sessions.list({
      created: { gte },
      status: 'complete',
      limit: PAGE_SIZE,
      expand: ['data.customer', 'data.total_details.breakdown'],
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const [i, s] of page.data.entries()) {
      if (payments.length >= MAX_PAYMENTS_PER_KIND || scanned >= MAX_SCANNED_PER_KIND) {
        return { payments, forInvoices, truncated: i < page.data.length || page.has_more };
      }
      scanned += 1;
      const invoiceId = idOf(s.invoice);
      if (invoiceId) {
        forInvoices.set(invoiceId, { clientReferenceId: s.client_reference_id ?? null, discounts: discountsOf(s) });
        continue;
      }
      // The same sessions the pipeline takes revenue from (checkoutPaymentRevenue):
      // a subscription's is paid by its invoices.
      if (s.mode !== 'payment' || s.payment_status !== 'paid' || !((s.amount_total ?? 0) > 0)) continue;
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
        discounts: discountsOf(s),
        paymentIntentId: idOf(s.payment_intent),
      });
    }
    if (!page.has_more || page.data.length === 0) return { payments, forInvoices, truncated: false };
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
  for (const inv of invoices.payments) {
    const fromCheckout = checkouts.forInvoices.get(inv.id);
    if (!fromCheckout) continue;
    inv.clientReferenceId = fromCheckout.clientReferenceId;
    inv.discounts.push(...fromCheckout.discounts);
  }
  const payments = [...invoices.payments, ...checkouts.payments];

  // What OpenPartner recorded from these payments, and whether it credited
  // them: revenue Events the Stripe pipeline wrote (metadata names the invoice
  // or Checkout Session), or the brand forwarded keyed on the same id
  // (externalEventId). Refunds and other corrective events name the invoice
  // too but record no revenue, so they don't count.
  const recorded = (await db(`${TABLES.Event} as e`)
    .where('e.tenantId', tenantId)
    .andWhere('e.ts', '>=', since)
    .andWhere('e.value', '>', 0)
    .whereNotIn('e.type', [...CORRECTIVE_EVENT_TYPES])
    .where((q) =>
      q
        .whereRaw(`e."metadata"->>'stripeInvoiceId' is not null`)
        .orWhereRaw(`e."metadata"->>'stripeCheckoutSessionId' is not null`)
        .orWhere('e.externalEventId', 'like', 'in\\_%')
        .orWhere('e.externalEventId', 'like', 'cs\\_%'),
    )
    .select(
      'e.externalEventId as externalEventId',
      db.raw(`e."metadata"->>'stripeInvoiceId' as "invoiceId"`),
      db.raw(`e."metadata"->>'stripeCheckoutSessionId' as "sessionId"`),
      db.raw(
        `exists (select 1 from ?? a where a."eventId" = e.id and a."tenantId" = e."tenantId") as credited`,
        [TABLES.Attribution],
      ),
    )) as Array<{ externalEventId: string | null; invoiceId: string | null; sessionId: string | null; credited: boolean }>;
  const recordedBy = new Map<string, { credited: boolean }>();
  for (const r of recorded) {
    for (const key of new Set([r.invoiceId, r.sessionId, r.externalEventId])) {
      if (!key) continue;
      const seen = recordedBy.get(key);
      recordedBy.set(key, { credited: (seen?.credited ?? false) || r.credited });
    }
  }

  // Partner signals for the payments nothing was recorded from.
  const unrecorded = payments.filter((p) => !recordedBy.has(p.id));
  const userIds = [...new Set(unrecorded.flatMap((p) => [p.customerId, p.merchantUserId]).filter((v): v is string => !!v))];
  const crefs = [...new Set(unrecorded.map((p) => p.clientReferenceId).filter((v): v is string => !!v))];
  const promoIds = [...new Set(unrecorded.flatMap((p) => p.discounts.map((d) => d.promotionCode)).filter((v): v is string => !!v))];
  const couponIds = [...new Set(unrecorded.flatMap((p) => p.discounts.map((d) => d.coupon)).filter((v): v is string => !!v))];
  // A linked customer counts only for payments after their first partner
  // click: a customer who paid first and clicked a partner later wasn't
  // brought by them.
  const firstClickAt = new Map<string, number>();
  for (let i = 0; i < userIds.length; i += 500) {
    const rows = (await db(`${TABLES.Identity} as i`)
      .join(`${TABLES.Click} as c`, function () {
        this.on('c.id', '=', 'i.clickId').andOn('c.tenantId', '=', 'i.tenantId');
      })
      .where('i.tenantId', tenantId)
      .whereIn('i.userId', userIds.slice(i, i + 500))
      .groupBy('i.userId')
      .select('i.userId as userId', db.raw('min(c.ts) as "firstClick"'))) as Array<{ userId: string; firstClick: Date }>;
    for (const r of rows) firstClickAt.set(r.userId, Math.floor(new Date(r.firstClick).getTime() / 1000));
  }
  const linkedBefore = (userId: string | null, createdSec: number) => {
    const first = userId ? firstClickAt.get(userId) : undefined;
    return first != null && first <= createdSec;
  };
  const knownClicks = new Set<string>();
  for (let i = 0; i < crefs.length; i += 500) {
    const ids = (await db(TABLES.Click).where({ tenantId }).whereIn('id', crefs.slice(i, i + 500)).pluck('id')) as string[];
    for (const id of ids) knownClicks.add(id);
  }
  // A partner's code, matched by id: its promotion code, or the Stripe
  // coupon minted for it. Deactivated codes too: what counts is that the
  // code was a partner's when it was used.
  const partnerPromos = new Set<string>();
  for (let i = 0; i < promoIds.length; i += 500) {
    const ids = (await db(TABLES.Coupon)
      .where({ tenantId })
      .whereIn('stripePromotionCodeId', promoIds.slice(i, i + 500))
      .pluck('stripePromotionCodeId')) as string[];
    for (const id of ids) partnerPromos.add(id);
  }
  const partnerCoupons = new Set<string>();
  for (let i = 0; i < couponIds.length; i += 500) {
    const ids = (await db(TABLES.Coupon)
      .where({ tenantId })
      .whereIn('stripeCouponId', couponIds.slice(i, i + 500))
      .pluck('stripeCouponId')) as string[];
    for (const id of ids) partnerCoupons.add(id);
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
    if (linkedBefore(p.customerId, p.created) || linkedBefore(p.merchantUserId, p.created)) signals.push('linked_customer');
    if (p.clientReferenceId && knownClicks.has(p.clientReferenceId)) signals.push('partner_click');
    if (p.discounts.some((d) => (d.promotionCode && partnerPromos.has(d.promotionCode)) || (d.coupon && partnerCoupons.has(d.coupon)))) {
      signals.push('partner_code');
    }
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
): Promise<
  | {
      ok: true;
      stripe: Stripe;
      livemode: boolean;
      /** Which account and mode this is: part of the route's cache key, so
       *  a reconnect to another account or mode never serves the old one. */
      identity: string;
    }
  | { ok: false; reason: ReconcileUnavailable }
> {
  if (isHostedMode()) {
    const conn = await activeConnectionForTenant(db, tenantId);
    if (!conn) return { ok: false, reason: 'not_connected' };
    if (conn.refreshFailedAt) return { ok: false, reason: 'reconnect_needed' };
    const granted = conn.permissionsGranted;
    if (Array.isArray(granted) && !RECONCILE_PERMISSIONS.every((p) => granted.includes(p))) {
      return { ok: false, reason: 'missing_permissions' };
    }
    try {
      return {
        ok: true,
        stripe: await brandStripe(conn),
        livemode: conn.livemode,
        identity: `app:${conn.id}:${conn.stripeAccountId}:${conn.livemode ? 'live' : 'test'}`,
      };
    } catch (err) {
      if (err instanceof StripeConnectionUnavailableError) {
        return { ok: false, reason: err.reason === 'disconnected' ? 'not_connected' : 'reconnect_needed' };
      }
      throw err;
    }
  }
  if (getTenancyMode() !== 'single' || !platformStripe) return { ok: false, reason: 'not_connected' };
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  const livemode = key.startsWith('sk_live_') || key.startsWith('rk_live_');
  return { ok: true, stripe: platformStripe, livemode, identity: `key:${livemode ? 'live' : 'test'}` };
}
