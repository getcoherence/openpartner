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
 *   credited       recorded, and credited to a partner
 *   recorded       recorded, credited to nobody (Tracking health's
 *                  "conversions that credited nobody" says why)
 *   missed         not recorded, though it carries a partner signal that
 *                  would have credited a partner. These are the leaks: a
 *                  webhook that never arrived, or a payment the pipeline
 *                  couldn't map.
 *   notCreditable  not recorded, and it carries a partner signal, but the
 *                  signal wouldn't have credited anyone had it been
 *                  recorded (notCreditableReasons says why). Not a leak.
 *   unreferred     not recorded and no partner signal: a customer who
 *                  didn't come through a partner. The pipeline only records
 *                  payments it can tie to one, so most revenue is here.
 *
 * The partner signals: a customer linked to a partner click made before the
 * payment, a client_reference_id naming one of the program's clicks (an
 * invoiced Checkout's counts for its invoice), or a partner's code (its
 * promotion code or Stripe coupon, by id, on the invoice, a line item or the
 * Checkout). Whether a signal would have credited is decided the way
 * attributeEvent would decide the payment had its webhook arrived when it
 * was paid (wouldCredit), for the user the pipeline keys it on: a usable
 * click (not flagged, partner not revoked, as of now, as any replay is
 * judged) inside its program's window, or the customer's earlier credited
 * conversion carrying it the way a renewal does. A code still active at
 * the payment adds a click stamped then, unless the customer already had
 * one of that partner's (ensureCouponClickAndIdentity reuses it).
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
export type PaymentClass = 'credited' | 'recorded' | 'missed' | 'notCreditable' | 'unreferred';
export type PartnerSignal = 'linked_customer' | 'partner_click' | 'partner_code';
/**
 * Why a partner signal wouldn't have credited anyone, in the order the
 * engine stops at (the same words as Tracking health's uncredited reasons):
 *   outside_window  usable partner clicks, none inside the program's window,
 *                   and no earlier credited conversion carrying the customer
 *   inactive_code   the only code was deactivated before the payment
 *   excluded        every click is flagged as fraud or a revoked partner's
 */
export type NotCreditableReason = 'outside_window' | 'inactive_code' | 'excluded';

/** attribution.ts: a click stamped this long after its conversion still counts. */
const CLICK_AFTER_EVENT_GRACE_SEC = 5 * 60;
/** The event type the pipeline records a paid invoice or Checkout as. */
const PAYMENT_EVENT_TYPE = 'invoice_paid';

interface StripePayment {
  kind: PaymentKind;
  id: string;
  created: number;
  /** When it was paid, as near as the object says: an invoice's
   *  status_transitions.paid_at, else its creation. A Checkout Session
   *  doesn't record its completion, and completes within a day. */
  paidAt: number;
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
  notCreditable: number;
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
  /** The notCreditable payments, by why. */
  notCreditableReasons: Record<NotCreditableReason, number>;
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
        paidAt: inv.status_transitions?.paid_at ?? inv.created,
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
        paidAt: s.created,
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
const toSec = (d: Date | string) => Math.floor(new Date(d).getTime() / 1000);

/** The user the pipeline keys the payment on (resolveUserIdFromCustomer):
 *  the brand's openpartner_user_id on the Customer, else the cus_ id. A
 *  guest Checkout has neither; its click's own user holds only that click. */
const userOf = (p: StripePayment): string | null => p.merchantUserId ?? p.customerId;

function* chunks<T>(values: T[], size = 500): Generator<T[]> {
  for (let i = 0; i < values.length; i += size) yield values.slice(i, i + size);
}

/** A click as attributeEvent weighs it. */
interface CandidateClick {
  id: string;
  partnerId: string;
  tsSec: number;
  /** Not flagged as fraud, partner not revoked, program still there. */
  usable: boolean;
  windowSec: number;
  /** Its program keeps renewals with the partner who won the customer. */
  renewals: boolean;
}

/** A partner's code, as the click a redemption would stamp. */
interface PartnerCode {
  id: string;
  partnerId: string;
  deactivatedSec: number | null;
  usable: boolean;
  windowSec: number;
  renewals: boolean;
}

/** One of the customer's earlier credited conversions, under its
 *  first-computed model. */
interface CreditedConversion {
  eventId: string;
  type: string;
  tsSec: number;
  model: string;
  clickIds: string[];
}

interface ClickTermsRow {
  id: string;
  partnerId: string;
  ts: Date;
  fraudFlag: string | null;
  revokedAt: Date | null;
  programFound: string | null;
  windowDays: number | null;
  renewals: boolean | null;
}

/** A query over Click `c`, joined to what decides whether the click can earn. */
function withClickTerms(q: Knex.QueryBuilder): Knex.QueryBuilder {
  return q
    .leftJoin(`${TABLES.Program} as pr`, function () {
      this.on('pr.id', '=', 'c.programId').andOn('pr.tenantId', '=', 'c.tenantId');
    })
    .leftJoin(`${TABLES.Partner} as pa`, function () {
      this.on('pa.id', '=', 'c.partnerId').andOn('pa.tenantId', '=', 'c.tenantId');
    })
    .select(
      'c.id as id',
      'c.partnerId as partnerId',
      'c.ts as ts',
      'c.fraudFlag as fraudFlag',
      'pa.revokedAt as revokedAt',
      'pr.id as programFound',
      'pr.attributionWindowDays as windowDays',
      'pr.renewalsStayWithPartner as renewals',
    );
}

function candidateClick(r: ClickTermsRow): CandidateClick {
  return {
    id: r.id,
    partnerId: r.partnerId,
    tsSec: toSec(r.ts),
    usable: r.fraudFlag == null && r.revokedAt == null && r.programFound != null,
    windowSec: (r.windowDays ?? 0) * 86_400,
    renewals: r.renewals === true,
  };
}

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

  // Partner signals for the payments nothing was recorded from, with what
  // wouldCredit needs to decide each one: every click linked to the
  // customer, the click a Checkout carried, and the partner's codes.
  const unrecorded = payments.filter((p) => !recordedBy.has(p.id));
  const userIds = [...new Set(unrecorded.map(userOf).filter((v): v is string => !!v))];
  const crefs = [...new Set(unrecorded.map((p) => p.clientReferenceId).filter((v): v is string => !!v))];
  const promoIds = [...new Set(unrecorded.flatMap((p) => p.discounts.map((d) => d.promotionCode)).filter((v): v is string => !!v))];
  const couponIds = [...new Set(unrecorded.flatMap((p) => p.discounts.map((d) => d.coupon)).filter((v): v is string => !!v))];

  const clicksByUser = new Map<string, CandidateClick[]>();
  for (const ids of chunks(userIds)) {
    const rows = (await withClickTerms(db(`${TABLES.Identity} as i`).join(`${TABLES.Click} as c`, function () {
      this.on('c.id', '=', 'i.clickId').andOn('c.tenantId', '=', 'i.tenantId');
    }))
      .where('i.tenantId', tenantId)
      .whereIn('i.userId', ids)
      .select('i.userId as userId')) as Array<ClickTermsRow & { userId: string }>;
    for (const r of rows) {
      const list = clicksByUser.get(r.userId) ?? [];
      list.push(candidateClick(r));
      clicksByUser.set(r.userId, list);
    }
  }
  // A linked customer counts only for payments after their first partner
  // click: a customer who paid first and clicked a partner later wasn't
  // brought by them.
  const linkedBefore = (userId: string | null, atSec: number) =>
    !!userId && (clicksByUser.get(userId) ?? []).some((c) => c.tsSec <= atSec);
  const knownClicks = new Map<string, CandidateClick>();
  for (const ids of chunks(crefs)) {
    const rows = (await withClickTerms(db(`${TABLES.Click} as c`))
      .where('c.tenantId', tenantId)
      .whereIn('c.id', ids)) as ClickTermsRow[];
    for (const r of rows) knownClicks.set(r.id, candidateClick(r));
  }
  // A partner's code, matched by id: its promotion code, or the Stripe
  // coupon minted for it. Deactivated codes too: what counts as a signal is
  // that the code was a partner's when it was used. wouldCredit then asks
  // whether it was still active.
  const partnerPromos = new Map<string, PartnerCode>();
  const partnerCoupons = new Map<string, PartnerCode>();
  for (const [column, ids, into] of [
    ['stripePromotionCodeId', promoIds, partnerPromos],
    ['stripeCouponId', couponIds, partnerCoupons],
  ] as const) {
    for (const chunk of chunks(ids)) {
      const rows = (await db(`${TABLES.Coupon} as k`)
        .leftJoin(`${TABLES.Program} as pr`, function () {
          this.on('pr.id', '=', 'k.programId').andOn('pr.tenantId', '=', 'k.tenantId');
        })
        .leftJoin(`${TABLES.Partner} as pa`, function () {
          this.on('pa.id', '=', 'k.partnerId').andOn('pa.tenantId', '=', 'k.tenantId');
        })
        .where('k.tenantId', tenantId)
        .whereIn(`k.${column}`, chunk)
        .select(
          'k.id as id',
          'k.partnerId as partnerId',
          `k.${column} as stripeId`,
          'k.deactivatedAt as deactivatedAt',
          'pa.revokedAt as revokedAt',
          'pr.id as programFound',
          'pr.attributionWindowDays as windowDays',
          'pr.renewalsStayWithPartner as renewals',
        )) as Array<{
        id: string;
        partnerId: string;
        stripeId: string;
        deactivatedAt: Date | null;
        revokedAt: Date | null;
        programFound: string | null;
        windowDays: number | null;
        renewals: boolean | null;
      }>;
      for (const r of rows) {
        into.set(r.stripeId, {
          id: r.id,
          partnerId: r.partnerId,
          deactivatedSec: r.deactivatedAt ? toSec(r.deactivatedAt) : null,
          usable: r.revokedAt == null && r.programFound != null,
          windowSec: (r.windowDays ?? 0) * 86_400,
          renewals: r.renewals === true,
        });
      }
    }
  }
  const signalsOf = (p: StripePayment): PartnerSignal[] => {
    const signals: PartnerSignal[] = [];
    if (linkedBefore(userOf(p), p.paidAt)) signals.push('linked_customer');
    if (p.clientReferenceId && knownClicks.has(p.clientReferenceId)) signals.push('partner_click');
    if (p.discounts.some((d) => (d.promotionCode && partnerPromos.has(d.promotionCode)) || (d.coupon && partnerCoupons.has(d.coupon)))) {
      signals.push('partner_code');
    }
    return signals;
  };

  // The customers' earlier credited conversions, which carry a renewal
  // (priorConversions in attribution.ts). Only for payments with a signal:
  // the rest are unreferred whatever their history.
  const signalled = unrecorded.filter((p) => signalsOf(p).length > 0);
  const creditedByUser = new Map<string, CreditedConversion[]>();
  const before = new Date(now.getTime() + 60_000);
  for (const ids of chunks([...new Set(signalled.map(userOf).filter((v): v is string => !!v))])) {
    const rows = (await db(`${TABLES.Attribution} as a`)
      .join(`${TABLES.Event} as e`, function () {
        this.on('e.id', '=', 'a.eventId').andOn('e.tenantId', '=', 'a.tenantId');
      })
      .where('e.tenantId', tenantId)
      .whereIn('e.userId', ids)
      .andWhere('e.ts', '<', before)
      .whereNotIn('e.type', [...CORRECTIVE_EVENT_TYPES])
      .orderBy([
        { column: 'e.ts', order: 'asc' },
        { column: 'e.id', order: 'asc' },
        { column: 'a.computedAt', order: 'asc' },
        { column: 'a.id', order: 'asc' },
      ])
      .select('e.userId as userId', 'e.id as eventId', 'e.type as type', 'e.ts as ts', 'a.clickId as clickId', 'a.model as model')) as Array<{
      userId: string;
      eventId: string;
      type: string;
      ts: Date;
      clickId: string;
      model: string;
    }>;
    for (const r of rows) {
      const list = creditedByUser.get(r.userId) ?? [];
      const last = list[list.length - 1];
      // One conversion's rows under its first-computed model, as
      // priorConversions reads them.
      if (last && last.eventId === r.eventId) {
        if (r.model === last.model) last.clickIds.push(r.clickId);
      } else {
        list.push({ eventId: r.eventId, type: r.type, tsSec: toSec(r.ts), model: r.model, clickIds: [r.clickId] });
      }
      creditedByUser.set(r.userId, list);
    }
  }

  /**
   * Would this payment have credited a partner had it been recorded?
   * attributeEvent's decision, from the same rows: the usable clicks
   * (not flagged, partner not revoked, program still there, not after the
   * payment), one inside its program's window, and the customer's earlier
   * credited conversions (priorConversions): the first of this type decides
   * it when its program keeps renewals with the partner, and the latest of
   * any type does when no click is left in the window.
   */
  const wouldCredit = (p: StripePayment): { credit: true } | { credit: false; reason: NotCreditableReason } => {
    const at = p.paidAt;
    const user = userOf(p);
    const clicks = new Map<string, CandidateClick>();
    for (const c of (user ? clicksByUser.get(user) : undefined) ?? []) clicks.set(c.id, c);
    const carried = p.clientReferenceId ? knownClicks.get(p.clientReferenceId) : undefined;
    if (carried) clicks.set(carried.id, carried);
    const isUsable = (c: CandidateClick | undefined): c is CandidateClick => !!c && c.usable && c.tsSec <= at + CLICK_AFTER_EVENT_GRACE_SEC;
    // A code credits through a click stamped at the redemption: this
    // payment. Unless the customer already had a click of that partner's,
    // which the redemption reuses instead, whatever its age or flag.
    let inactiveCode = false;
    for (const d of p.discounts) {
      const code = (d.promotionCode ? partnerPromos.get(d.promotionCode) : undefined) ?? (d.coupon ? partnerCoupons.get(d.coupon) : undefined);
      if (!code) continue;
      if (code.deactivatedSec != null && code.deactivatedSec <= at) {
        inactiveCode = true;
        continue;
      }
      const hadOne = [...clicks.values()].some((c) => c.partnerId === code.partnerId && c.tsSec <= at + CLICK_AFTER_EVENT_GRACE_SEC);
      if (hadOne) continue;
      const id = `code:${code.id}`;
      clicks.set(id, { id, partnerId: code.partnerId, tsSec: at, usable: code.usable, windowSec: code.windowSec, renewals: code.renewals });
    }
    const usable = [...clicks.values()].filter(isUsable);
    const inWindow = usable.some((c) => at - c.tsSec <= c.windowSec);

    let sameType: boolean | undefined;
    let latest = false;
    const prior = ((user ? creditedByUser.get(user) : undefined) ?? []).filter((c) => c.tsSec < at);
    for (const conv of prior) {
      const touches = conv.clickIds.map((id) => clicks.get(id)).filter(isUsable);
      if (touches.length === 0) continue;
      const control = touches.reduce((a, b) => (b.tsSec > a.tsSec ? b : a));
      if (sameType === undefined && conv.type === PAYMENT_EVENT_TYPE) sameType = control.renewals;
      latest = control.renewals;
    }
    // A first conversion of this type whose program lets renewals go is
    // decided by the window alone, with no fallback.
    const credit = sameType === undefined ? inWindow || latest : sameType || inWindow;
    if (credit) return { credit: true };
    return { credit: false, reason: usable.length > 0 ? 'outside_window' : inactiveCode ? 'inactive_code' : 'excluded' };
  };

  const primary = await tenantDefaultCurrency(db, tenantId);
  const counts = { payments: payments.length, credited: 0, recorded: 0, missed: 0, notCreditable: 0, unreferred: 0 };
  const notCreditableReasons: Record<NotCreditableReason, number> = { outside_window: 0, inactive_code: 0, excluded: 0 };
  const totals = new Map<string, CurrencyTotals>();
  const missed: Array<MissedPayment & { createdSec: number }> = [];
  for (const p of payments) {
    const amount = fromStripeMinor(p.amountMinor, p.currency);
    const t =
      totals.get(p.currency) ??
      { currency: p.currency, stripe: 0, recorded: 0, credited: 0, missed: 0, notCreditable: 0, unreferred: 0 };
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
    const signals = signalsOf(p);
    if (signals.length === 0) {
      t.unreferred += amount;
      counts.unreferred += 1;
      continue;
    }
    const verdict = wouldCredit(p);
    if (!verdict.credit) {
      t.notCreditable += amount;
      counts.notCreditable += 1;
      notCreditableReasons[verdict.reason] += 1;
    } else {
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
    }
  }

  return {
    available: true,
    window: { days, since: since.toISOString() },
    computedAt: now.toISOString(),
    livemode: opts.livemode,
    truncated: invoices.truncated || checkouts.truncated,
    counts,
    notCreditableReasons,
    totals: [...totals.values()]
      .map((t) => ({
        currency: t.currency,
        stripe: round2(t.stripe),
        recorded: round2(t.recorded),
        credited: round2(t.credited),
        missed: round2(t.missed),
        notCreditable: round2(t.notCreditable),
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
