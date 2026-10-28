/**
 * Pay-by-invoice billing for hosted brands (docs/invoice-billing.md).
 *
 * The default hosted subscription charges a saved card every month. Some
 * brands can't be charged that way: an Indian card's recurring debit over
 * ₹15,000 needs the cardholder to approve it each time (RBI e-mandate
 * rules), and Stripe retries an Indian renewal only once. For those brands
 * the same plan prices and meter run on a subscription with
 * collection_method=send_invoice: Stripe emails each monthly invoice, and
 * the brand pays it from the hosted invoice page by card or bank transfer
 * (ACH, domestic wire, or an international SWIFT wire in USD).
 *
 * Which way a tenant pays (CollectionTerms) comes from, in order:
 *   1. ops' choice for the tenant (HostedBillingProfile.collectionMethod),
 *   2. the declared-country default (PlatformSetting 'invoiceBilling',
 *      India out of the box),
 *   3. a card.
 *
 * Indian brands are billed only with a GSTIN, by card or by invoice: a
 * GST-registered buyer self-assesses GST under reverse charge, and
 * OpenPartner isn't registered under OIDAR to bill anyone else in India.
 * The GSTIN goes on the Stripe customer as tax ID in_gst, with the footer
 * "Reverse charge applicable", so both print on every invoice.
 */

import type { Knex } from 'knex';
import type Stripe from 'stripe';
import { TABLES, type BillingCollectionMethod, type HostedBillingProfileRow, type TenantRow } from '@openpartner/db';
// LocationDeclaration and PlatformSetting are platform-scoped: only the
// privileged pool can read them, whichever pool the caller holds.
import { db as privilegedDb } from './db.js';
import { latestDeclaredCountries } from './country-access.js';
import { getInvoiceBillingSettings, type InvoiceBillingSettings } from './platform-settings.js';
import {
  BILLING_CUSTOMER_ROLE,
  INVOICE_GRACE_DAYS_DEFAULT,
  invoiceOverdue,
  mirrorHostedBillingState,
  mirrorInvoiceDue,
  type InvoiceOverdue,
  type MirroredSubscriptionStatus,
} from './billing-plan.js';
import { withTenantTransaction } from './tenancy.js';
import { houseCustomerMetadata } from './house-program.js';
import { applyWhiteLabelFromSubscription, subscriptionHasWhiteLabel } from './white-label-billing.js';

export const DAYS_UNTIL_DUE_DEFAULT = 15;

export const REVERSE_CHARGE_FOOTER = 'Reverse charge applicable';

/**
 * What the hosted invoice page offers. Checked in Stripe test mode for a
 * USD invoice to an Indian customer: "Card" and "Bank transfer", the latter
 * showing account and routing numbers plus a SWIFT code, with the invoice
 * number as the reference. A transfer quoting it is matched to the invoice
 * automatically.
 */
export const INVOICE_PAYMENT_SETTINGS: Stripe.SubscriptionCreateParams.PaymentSettings = {
  payment_method_types: ['card', 'customer_balance'],
  payment_method_options: {
    customer_balance: { funding_type: 'bank_transfer', bank_transfer: { type: 'us_bank_transfer' } },
  },
};

/** Subscription params for invoice collection — on create, and to move a
 *  card subscription across. */
export function sendInvoiceParams(daysUntilDue: number): Pick<
  Stripe.SubscriptionCreateParams,
  'collection_method' | 'days_until_due' | 'payment_settings'
> {
  return { collection_method: 'send_invoice', days_until_due: daysUntilDue, payment_settings: INVOICE_PAYMENT_SETTINGS };
}

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * A GSTIN in canonical form, or null when it isn't one. Fifteen characters:
 * a two-digit state code, the holder's PAN, an entity number, a fixed
 * character, and a mod-36 check character. Stripe checks only the shape of
 * an in_gst tax ID (it can't verify one), so the check character is what
 * catches a typo. It can't tell a real registration from an invented one:
 * see "Abuse" in docs/invoice-billing.md for what limits that.
 */
export function normalizeGstin(raw: string): string | null {
  const g = raw.replace(/[\s-]+/g, '').toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][A-Z0-9][0-9A-Z]$/.test(g)) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = GSTIN_CHARS.indexOf(g[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === g[14] ? g : null;
}

export interface CollectionTerms {
  method: BillingCollectionMethod;
  /** Where `method` came from. */
  source: 'ops' | 'country' | 'default';
  daysUntilDue: number;
  graceDays: number;
  /** The brand's declared country, when it declared one. */
  country: string | null;
  gstin: string | null;
  /** An Indian brand, which needs a GSTIN however it pays. */
  gstinRequired: boolean;
}

export function collectionTerms(
  profile: Pick<HostedBillingProfileRow, 'collectionMethod' | 'daysUntilDue' | 'graceDays' | 'gstin'> | null,
  country: string | null,
  settings: InvoiceBillingSettings,
): CollectionTerms {
  const byCountry = country !== null && settings.defaultCountries.includes(country);
  const method: BillingCollectionMethod =
    profile?.collectionMethod ?? (byCountry ? 'send_invoice' : 'charge_automatically');
  return {
    method,
    source: profile?.collectionMethod ? 'ops' : byCountry ? 'country' : 'default',
    daysUntilDue: profile?.daysUntilDue ?? DAYS_UNTIL_DUE_DEFAULT,
    graceDays: profile?.graceDays ?? INVOICE_GRACE_DAYS_DEFAULT,
    country,
    gstin: profile?.gstin ?? null,
    gstinRequired: country === 'IN',
  };
}

export async function getBillingProfile(db: Knex, tenantId: string): Promise<HostedBillingProfileRow | null> {
  return ((await db<HostedBillingProfileRow>(TABLES.HostedBillingProfile).where({ tenantId }).first()) ??
    null) as HostedBillingProfileRow | null;
}

export async function declaredTenantCountry(tenantId: string): Promise<string | null> {
  return (await latestDeclaredCountries(privilegedDb, 'tenant', [tenantId])).get(tenantId)?.country ?? null;
}

/** How this tenant pays. `db` reads the tenant's own profile (tenant-scoped
 *  or privileged — both see it). */
export async function resolveCollectionTerms(db: Knex, tenantId: string): Promise<CollectionTerms> {
  const [profile, country, settings] = await Promise.all([
    getBillingProfile(db, tenantId),
    declaredTenantCountry(tenantId),
    getInvoiceBillingSettings(privilegedDb),
  ]);
  return collectionTerms(profile, country, settings);
}

export type BillingTermsPatch = Partial<Pick<HostedBillingProfileRow, 'collectionMethod' | 'daysUntilDue' | 'graceDays'>>;

async function upsertProfile(db: Knex, tenantId: string, set: Record<string, unknown>): Promise<HostedBillingProfileRow> {
  const [row] = (await db(TABLES.HostedBillingProfile)
    .insert({ tenantId, ...set })
    .onConflict('tenantId')
    .merge(set)
    .returning('*')) as HostedBillingProfileRow[];
  return row!;
}

/** Ops sets how a tenant pays. Keys left undefined keep their value (or the
 *  column default on a new row). */
export async function setBillingTerms(
  db: Knex,
  tenantId: string,
  patch: BillingTermsPatch,
  operatorEmail: string,
): Promise<HostedBillingProfileRow> {
  const set: Record<string, unknown> = { updatedByEmail: operatorEmail, updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v;
  return upsertProfile(db, tenantId, set);
}

/** The brand records its GSTIN. Kept apart from updatedByEmail, which says
 *  who set the collection terms. */
export async function setGstin(
  db: Knex,
  tenantId: string,
  gstin: string,
  adminEmail: string | null,
): Promise<HostedBillingProfileRow> {
  return upsertProfile(db, tenantId, { gstin, gstinUpdatedByEmail: adminEmail, gstinUpdatedAt: new Date() });
}

/**
 * Put an Indian brand's tax details on its Stripe customer: the GSTIN as
 * tax ID in_gst (replacing any other), the reverse-charge footer, and the
 * country on an address that has none. An invoice copies these when it is
 * finalized, so this runs before the subscription that issues it.
 */
export async function applyCustomerTaxDetails(
  stripe: Stripe,
  customerId: string,
  details: { country: string | null; gstin: string | null },
): Promise<void> {
  if (details.country !== 'IN' || !details.gstin) return;
  const ids = await stripe.customers.listTaxIds(customerId, { limit: 100 });
  const gst = ids.data.filter((t) => t.type === 'in_gst');
  if (!gst.some((t) => t.value === details.gstin)) {
    await stripe.customers.createTaxId(customerId, { type: 'in_gst', value: details.gstin });
  }
  for (const t of gst) {
    if (t.value !== details.gstin) await stripe.customers.deleteTaxId(customerId, t.id);
  }
  const customer = await stripe.customers.retrieve(customerId);
  const hasAddress = !customer.deleted && !!customer.address?.country;
  await stripe.customers.update(customerId, {
    invoice_settings: { footer: REVERSE_CHARGE_FOOTER },
    ...(hasAddress ? {} : { address: { country: 'IN' } }),
  });
}

// --------------------------------------------------------------------------
// Starting a subscription
// --------------------------------------------------------------------------

export class InvoiceSubscribeError extends Error {
  constructor(
    readonly code: 'already_subscribed',
    message: string,
  ) {
    super(message);
  }
}

export interface StartInvoiceSubscription {
  tenantId: string;
  plan: 'flex' | 'revshare';
  lineItems: Array<{ price: string; quantity?: number }>;
  terms: CollectionTerms;
  /** Validated; saved when it differs from the one on file. */
  gstin: string | null;
  billingEmail?: string;
  legalName?: string;
  adminEmail: string | null;
  promotionCodeId?: string;
}

const LIVE_STATUSES = new Set(['active', 'past_due', 'unpaid', 'trialing', 'incomplete']);

/**
 * Start a send_invoice subscription. Unlike a Checkout Session, it bills
 * the moment it exists, so the app must never lose track of one:
 *
 *  1. The customer (and GSTIN) commit in a transaction of their own, before
 *     any subscription exists.
 *  2. A second transaction locks the tenant row (a double submit waits,
 *     then sees the pointer), ADOPTS a live subscription this tenant
 *     already started whose pointer never committed (a crash, a lost
 *     response), or else creates one, and commits the pointer.
 *  3. If that transaction fails after Stripe created the subscription, the
 *     subscription is cancelled and its draft first invoice deleted, so a
 *     retry starts clean.
 *
 * The customer.subscription.created webhook also adopts a stamped
 * subscription whose tenant has no pointer (adoptInvoiceSubscription), for
 * a process that died between steps 2 and 3. None of this runs in the
 * request's transaction, whose rollback would otherwise lose the pointer.
 */
export async function startInvoiceSubscription(
  stripe: Stripe,
  input: StartInvoiceSubscription,
): Promise<{ subscription: Stripe.Subscription; invoice: Stripe.Invoice | null; adopted: boolean }> {
  const { tenantId, terms } = input;

  const customerId = await withTenantTransaction(tenantId, async (trx) => {
    const tenant = await trx<TenantRow>(TABLES.Tenant)
      .where({ id: tenantId })
      .forUpdate()
      .first(['stripeCustomerId', 'stripeSubscriptionId', 'displayName']);
    if (tenant?.stripeSubscriptionId) {
      throw new InvoiceSubscribeError('already_subscribed', 'Use the Customer Portal to change plans.');
    }
    if (input.gstin && input.gstin !== terms.gstin) await setGstin(trx, tenantId, input.gstin, input.adminEmail);
    if (tenant?.stripeCustomerId) return tenant.stripeCustomerId;
    const customer = await stripe.customers.create({
      email: input.billingEmail ?? input.adminEmail ?? undefined,
      name: input.legalName ?? tenant?.displayName ?? undefined,
      // As at card Checkout (billing.ts): a referred brand's house-program
      // user id rides along.
      metadata: {
        openpartner_role: BILLING_CUSTOMER_ROLE,
        openpartner_tenant_id: tenantId,
        ...(await houseCustomerMetadata(tenantId)),
      },
    });
    await trx<TenantRow>(TABLES.Tenant).where({ id: tenantId }).update({ stripeCustomerId: customer.id, updatedAt: new Date() });
    return customer.id;
  });
  if (input.billingEmail || input.legalName) {
    await stripe.customers.update(customerId, {
      ...(input.billingEmail ? { email: input.billingEmail } : {}),
      ...(input.legalName ? { name: input.legalName } : {}),
    });
  }
  await applyCustomerTaxDetails(stripe, customerId, { country: terms.country, gstin: input.gstin });

  const made: { sub?: Stripe.Subscription } = {};
  let started: { sub: Stripe.Subscription; adopted: boolean };
  try {
    started = await withTenantTransaction(tenantId, async (trx) => {
      const tenant = await trx<TenantRow>(TABLES.Tenant).where({ id: tenantId }).forUpdate().first(['stripeSubscriptionId']);
      if (tenant?.stripeSubscriptionId) {
        throw new InvoiceSubscribeError('already_subscribed', 'Use the Customer Portal to change plans.');
      }
      const existing = (
        await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20, expand: ['data.latest_invoice'] })
      ).data.find(
        (s) =>
          LIVE_STATUSES.has(s.status) &&
          s.metadata?.openpartner_tenant_id === tenantId &&
          s.metadata?.openpartner_collection === 'send_invoice',
      );
      const sub =
        existing ??
        (made.sub = await stripe.subscriptions.create({
          customer: customerId,
          items: input.lineItems,
          ...sendInvoiceParams(terms.daysUntilDue),
          ...(input.promotionCodeId ? { discounts: [{ promotion_code: input.promotionCodeId }] } : {}),
          metadata: { openpartner_tenant_id: tenantId, openpartner_plan: input.plan, openpartner_collection: 'send_invoice' },
          expand: ['latest_invoice'],
        }));
      await linkSubscription(trx, tenantId, customerId, sub);
      return { sub, adopted: !!existing };
    });
  } catch (err) {
    if (made.sub) await cancelUnlinkedSubscription(stripe, made.sub, tenantId);
    throw err;
  }

  // Stripe finalizes a subscription's first invoice about an hour after
  // creating it. Finalizing now emails it and returns the pay link at once;
  // if this fails, Stripe still finalizes it on its own schedule.
  let invoice = typeof started.sub.latest_invoice === 'object' ? started.sub.latest_invoice : null;
  if (invoice?.id && invoice.status === 'draft') {
    try {
      invoice = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: true });
    } catch (err) {
      console.warn('[billing] first invoice left for Stripe to finalize', {
        tenantId,
        invoiceId: invoice.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  try {
    await withTenantTransaction(tenantId, (trx) => refreshInvoiceDue(trx, stripe, tenantId, customerId));
  } catch (err) {
    // Best effort: the webhooks and the nightly reconcile refresh it too.
    console.warn('[billing] invoice due date not mirrored yet', { tenantId, err: err instanceof Error ? err.message : String(err) });
  }
  return { subscription: started.sub, invoice, adopted: started.adopted };
}

/** Point the tenant at a subscription and mirror it. */
async function linkSubscription(trx: Knex, tenantId: string, customerId: string, sub: Stripe.Subscription): Promise<void> {
  await trx<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId })
    .update({ stripeCustomerId: customerId, stripeSubscriptionId: sub.id, updatedAt: new Date() });
  await mirrorHostedBillingState(trx, tenantId, sub.status as MirroredSubscriptionStatus, sub.collection_method);
  if (subscriptionHasWhiteLabel(sub.items.data.map((it) => it.price.id))) {
    await applyWhiteLabelFromSubscription(trx, tenantId, true);
  }
}

/**
 * Compensation: a subscription the app failed to record must not keep
 * invoicing. Its first invoice is still a draft (finalizing comes after the
 * commit). Stripe won't delete a subscription's invoice, and cancelling the
 * subscription leaves the draft to auto-finalize and be emailed an hour
 * later, so it is finalized silently (auto_advance off: no email) and
 * voided. Checked in Stripe test mode: no invoice.sent, ends void.
 */
async function cancelUnlinkedSubscription(stripe: Stripe, sub: Stripe.Subscription, tenantId: string): Promise<void> {
  try {
    await stripe.subscriptions.cancel(sub.id);
    const invoice = typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null;
    if (invoice?.id && invoice.status === 'draft') {
      await stripe.invoices.update(invoice.id, { auto_advance: false });
      await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false });
      await stripe.invoices.voidInvoice(invoice.id);
    }
  } catch (err) {
    console.error(
      `[billing] ALERT: subscription ${sub.id} for tenant ${tenantId} was created but not recorded, and cancelling it failed — cancel it in Stripe by hand`,
      err,
    );
  }
}

/**
 * customer.subscription.created for a subscription startInvoiceSubscription
 * stamped (openpartner_collection=send_invoice): record it when the tenant
 * has no pointer and the customer matches, so a subscription whose request
 * died before committing is not invoiced unseen. In the normal case the
 * route's transaction holds the tenant row; this update waits for it, then
 * finds the pointer set and does nothing.
 */
export async function adoptInvoiceSubscription(
  trx: Knex,
  tenantId: string,
  sub: Stripe.Subscription,
): Promise<'adopted' | 'already_linked' | 'conflict'> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  if (!LIVE_STATUSES.has(sub.status)) return 'already_linked';
  const updated = await trx<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId })
    .whereNull('stripeSubscriptionId')
    .where((q) => q.whereNull('stripeCustomerId').orWhere('stripeCustomerId', customerId))
    .update({ stripeCustomerId: customerId, stripeSubscriptionId: sub.id, updatedAt: new Date() });
  if (updated > 0) {
    await mirrorHostedBillingState(trx, tenantId, sub.status as MirroredSubscriptionStatus, sub.collection_method);
    if (subscriptionHasWhiteLabel(sub.items.data.map((it) => it.price.id))) {
      await applyWhiteLabelFromSubscription(trx, tenantId, true);
    }
    return 'adopted';
  }
  const tenant = await trx<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first(['stripeSubscriptionId']);
  if (tenant?.stripeSubscriptionId === sub.id) return 'already_linked';
  console.error(
    `[billing] ALERT: tenant ${tenantId} has subscription ${tenant?.stripeSubscriptionId ?? '(none, other customer)'} but invoice subscription ${sub.id} was also created — cancel one in Stripe`,
  );
  return 'conflict';
}

// --------------------------------------------------------------------------
// Overdue invoices
// --------------------------------------------------------------------------

/** Does the mirror track an open pay-by-invoice invoice for this tenant? */
export async function invoiceDueTracked(db: Knex, tenantId: string): Promise<boolean> {
  const row = await db(TABLES.HostedBillingState).where({ tenantId }).first<{ oldestOpenInvoiceId: string | null } | undefined>('oldestOpenInvoiceId');
  return !!row?.oldestOpenInvoiceId;
}

/**
 * Re-read the customer's open pay-by-invoice invoices and mirror the oldest
 * with an amount due, plus whether the brand has ever paid a non-zero
 * invoice. Called on invoice and subscription webhooks, after a subscribe,
 * and by the nightly reconcile. Returns the overdue state it implies.
 */
export async function refreshInvoiceDue(
  db: Knex,
  stripe: Pick<Stripe, 'invoices'>,
  tenantId: string,
  customerId: string,
): Promise<InvoiceOverdue | null> {
  const open = await stripe.invoices.list({ customer: customerId, status: 'open', collection_method: 'send_invoice', limit: 100 });
  const oldest =
    open.data
      .filter((i) => i.amount_remaining > 0 && typeof i.due_date === 'number')
      .sort((a, b) => a.due_date! - b.due_date!)[0] ?? null;
  const row = (await db(`${TABLES.HostedBillingState} as s`)
    .leftJoin(`${TABLES.HostedBillingProfile} as p`, 'p.tenantId', 's.tenantId')
    .where('s.tenantId', tenantId)
    .first(['s.invoicePaidAt', 'p.graceDays'])) as { invoicePaidAt: Date | null; graceDays: number | null } | undefined;
  let paid = !!row?.invoicePaidAt;
  if (!paid) {
    const recent = await stripe.invoices.list({ customer: customerId, status: 'paid', limit: 100 });
    paid = recent.data.some((i) => i.amount_paid > 0);
  }
  const dueAt = oldest ? new Date(oldest.due_date! * 1000) : null;
  await mirrorInvoiceDue(db, tenantId, { invoiceId: oldest?.id ?? null, dueAt, paid });
  return invoiceOverdue({
    oldestOpenInvoiceId: oldest?.id ?? null,
    oldestOpenInvoiceDueAt: dueAt,
    invoicePaidAt: paid ? (row?.invoicePaidAt ?? new Date()) : null,
    graceDays: row?.graceDays ?? null,
  });
}

// --------------------------------------------------------------------------
// Moving a live subscription
// --------------------------------------------------------------------------

export class CollectionSwitchError extends Error {
  constructor(
    readonly code: 'no_payment_method',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Move a live subscription to `terms`. From the next invoice on: one
 * already finalized keeps how it was collected. Moving back to a card needs
 * one on file, or the next renewal would fail outright.
 */
export async function switchSubscriptionCollection(
  stripe: Stripe,
  subscriptionId: string,
  terms: Pick<CollectionTerms, 'method' | 'daysUntilDue'>,
): Promise<Stripe.Subscription> {
  if (terms.method === 'send_invoice') {
    return stripe.subscriptions.update(subscriptionId, sendInvoiceParams(terms.daysUntilDue));
  }
  const sub = await stripe.subscriptions.retrieve(subscriptionId, { expand: ['customer'] });
  const customer = sub.customer as Stripe.Customer | Stripe.DeletedCustomer;
  const card =
    sub.default_payment_method ??
    (customer.deleted ? null : (customer.invoice_settings?.default_payment_method ?? customer.default_source ?? null));
  if (!card) {
    throw new CollectionSwitchError(
      'no_payment_method',
      'The brand has no card on file. It can add one in the Stripe Customer Portal from its Billing page.',
    );
  }
  // Stripe refuses charge_automatically while the bank-transfer option is
  // still set, so both invoice-only settings are cleared with it.
  return stripe.subscriptions.update(subscriptionId, {
    collection_method: 'charge_automatically',
    payment_settings: { payment_method_types: '', payment_method_options: { customer_balance: '' } },
  });
}

// --------------------------------------------------------------------------
// Ops console (privileged pool)
// --------------------------------------------------------------------------

export interface InvoiceBillingTenantView {
  tenantId: string;
  slug: string;
  name: string;
  plan: string | null;
  country: string | null;
  /** What ops set; null when nothing was. */
  profile:
    | (Pick<HostedBillingProfileRow, 'collectionMethod' | 'daysUntilDue' | 'graceDays' | 'gstin' | 'updatedByEmail' | 'gstinUpdatedByEmail'> & {
        updatedAt: string;
      })
    | null;
  /** What a new subscription gets. */
  terms: CollectionTerms;
  subscription: {
    live: boolean;
    status: string | null;
    collectionMethod: BillingCollectionMethod | null;
  };
  /** The oldest unpaid invoice past its due date, if any. */
  overdue: { invoiceId: string | null; since: string; graceEndsAt: string; graceExpired: boolean; neverPaid: boolean } | null;
}

/**
 * The tenants the Invoicing tab shows: any ops set terms for, any whose
 * declared country defaults to invoices, every Indian brand (each needs a
 * GSTIN, however it pays), and any whose live subscription is invoiced.
 * Missing GSTINs and overdue invoices first.
 */
export async function listInvoiceBillingTenants(
  db: Knex,
  settings: InvoiceBillingSettings,
): Promise<InvoiceBillingTenantView[]> {
  const profiles = (await db<HostedBillingProfileRow>(TABLES.HostedBillingProfile)) as HostedBillingProfileRow[];
  const countries = [...new Set([...settings.defaultCountries, 'IN'])];
  // Tenants that ever declared one of those countries; their LATEST
  // declaration is checked below. Partner declarations never match.
  const declaredThere = (await db(TABLES.LocationDeclaration)
    .where({ subjectKind: 'tenant' })
    .whereIn('country', countries)
    .distinct('subjectId')
    .pluck('subjectId')) as string[];
  const invoiced = (await db(TABLES.HostedBillingState)
    .where({ collectionMethod: 'send_invoice' })
    .orWhereNotNull('oldestOpenInvoiceId')
    .pluck('tenantId')) as string[];
  const candidates = [...new Set([...profiles.map((p) => p.tenantId), ...declaredThere, ...invoiced])];
  if (candidates.length === 0) return [];
  const latest = await latestDeclaredCountries(db, 'tenant', candidates);
  const profileOf = new Map(profiles.map((p) => [p.tenantId, p]));
  const invoicedSet = new Set(invoiced);
  const ids = candidates.filter((id) => {
    const country = latest.get(id)?.country ?? null;
    return profileOf.has(id) || invoicedSet.has(id) || (country !== null && countries.includes(country));
  });
  if (ids.length === 0) return [];
  const tenants = (await db(TABLES.Tenant)
    .whereIn('id', ids)
    .select(['id', 'slug', 'displayName', 'billingPlan', 'stripeSubscriptionId'])) as Array<{
    id: string;
    slug: string;
    displayName: string;
    billingPlan: string | null;
    stripeSubscriptionId: string | null;
  }>;
  const mirrorRows = (await db(TABLES.HostedBillingState)
    .whereIn('tenantId', ids)
    .select(['tenantId', 'subscriptionStatus', 'collectionMethod', 'oldestOpenInvoiceId', 'oldestOpenInvoiceDueAt', 'invoicePaidAt'])) as Array<{
    tenantId: string;
    subscriptionStatus: string | null;
    collectionMethod: BillingCollectionMethod | null;
    oldestOpenInvoiceId: string | null;
    oldestOpenInvoiceDueAt: Date | null;
    invoicePaidAt: Date | null;
  }>;
  const mirrors = new Map(mirrorRows.map((m) => [m.tenantId, m]));
  const views = tenants.map((t): InvoiceBillingTenantView => {
    const p = profileOf.get(t.id) ?? null;
    const m = mirrors.get(t.id);
    const live = !!t.stripeSubscriptionId;
    const country = latest.get(t.id)?.country ?? null;
    const overdue = m ? invoiceOverdue({ ...m, graceDays: p?.graceDays ?? null }) : null;
    return {
      tenantId: t.id,
      slug: t.slug,
      name: t.displayName,
      plan: t.billingPlan,
      country,
      profile: p
        ? {
            collectionMethod: p.collectionMethod,
            daysUntilDue: p.daysUntilDue,
            graceDays: p.graceDays,
            gstin: p.gstin,
            updatedByEmail: p.updatedByEmail,
            gstinUpdatedByEmail: p.gstinUpdatedByEmail,
            updatedAt: new Date(p.updatedAt).toISOString(),
          }
        : null,
      terms: collectionTerms(p, country, settings),
      subscription: {
        live,
        status: live ? (m?.subscriptionStatus ?? null) : null,
        collectionMethod: live ? (m?.collectionMethod ?? null) : null,
      },
      overdue: overdue
        ? {
            invoiceId: overdue.invoiceId,
            since: overdue.since.toISOString(),
            graceEndsAt: overdue.graceEndsAt.toISOString(),
            graceExpired: overdue.graceExpired,
            neverPaid: overdue.neverPaid,
          }
        : null,
    };
  });
  const rank = (v: InvoiceBillingTenantView) => (v.overdue ? 0 : v.terms.gstinRequired && !v.terms.gstin ? 1 : 2);
  return views.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export class OpsCollectionError extends Error {
  constructor(
    readonly code: 'not_found' | 'gstin_required' | 'no_payment_method',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Ops changes how a tenant pays. When the tenant has a live subscription
 * that no longer matches, Stripe moves first (a refused move saves
 * nothing). The profile, the mirror and the audit row (`audit`, from the
 * route) then commit together; if that fails, the subscription is moved
 * back, so Stripe and the profile never disagree silently. `ref` is the
 * tenant id or slug.
 */
export async function setTenantCollection(
  db: Knex,
  stripe: Stripe | null,
  ref: string,
  patch: BillingTermsPatch,
  operatorEmail: string,
  audit: (trx: Knex, result: { tenantId: string; terms: CollectionTerms; moved: BillingCollectionMethod | null }) => Promise<void>,
): Promise<{ tenantId: string; terms: CollectionTerms; moved: BillingCollectionMethod | null }> {
  const tenant = (await db(TABLES.Tenant)
    .where({ id: ref })
    .orWhere({ slug: ref })
    .first(['id', 'billingPlan', 'stripeCustomerId', 'stripeSubscriptionId'])) as
    | { id: string; billingPlan: string | null; stripeCustomerId: string | null; stripeSubscriptionId: string | null }
    | undefined;
  if (!tenant) throw new OpsCollectionError('not_found', 'No brand with that id or slug.');
  const [profile, country, settings] = await Promise.all([
    getBillingProfile(db, tenant.id),
    declaredTenantCountry(tenant.id),
    getInvoiceBillingSettings(privilegedDb),
  ]);
  const terms = collectionTerms(
    {
      collectionMethod: patch.collectionMethod !== undefined ? patch.collectionMethod : (profile?.collectionMethod ?? null),
      daysUntilDue: patch.daysUntilDue ?? profile?.daysUntilDue ?? DAYS_UNTIL_DUE_DEFAULT,
      graceDays: patch.graceDays ?? profile?.graceDays ?? INVOICE_GRACE_DAYS_DEFAULT,
      gstin: profile?.gstin ?? null,
    },
    country,
    settings,
  );

  let moved: { sub: Stripe.Subscription; previous: Pick<CollectionTerms, 'method' | 'daysUntilDue'> } | null = null;
  if (tenant.stripeSubscriptionId && tenant.billingPlan !== 'enterprise') {
    if (!stripe) throw new Error('Stripe not configured (STRIPE_SECRET_KEY missing)');
    const sub = await stripe.subscriptions.retrieve(tenant.stripeSubscriptionId);
    const needsMove =
      terms.method === 'send_invoice'
        ? sub.collection_method !== 'send_invoice' || sub.days_until_due !== terms.daysUntilDue
        : sub.collection_method === 'send_invoice';
    if (needsMove) {
      if (terms.gstinRequired && !terms.gstin) {
        throw new OpsCollectionError(
          'gstin_required',
          'This brand is in India and has no GSTIN on file. Ask it to add one on its Billing page first.',
        );
      }
      if (terms.method === 'send_invoice' && tenant.stripeCustomerId) {
        await applyCustomerTaxDetails(stripe, tenant.stripeCustomerId, { country: terms.country, gstin: terms.gstin });
      }
      try {
        const updated = await switchSubscriptionCollection(stripe, sub.id, terms);
        moved = {
          sub: updated,
          previous: { method: sub.collection_method, daysUntilDue: sub.days_until_due ?? DAYS_UNTIL_DUE_DEFAULT },
        };
      } catch (err) {
        if (err instanceof CollectionSwitchError) throw new OpsCollectionError(err.code, err.message);
        throw err;
      }
    }
  }

  const result = { tenantId: tenant.id, terms, moved: moved ? terms.method : null };
  try {
    await db.transaction(async (trx) => {
      if (moved) {
        await mirrorHostedBillingState(
          trx,
          tenant.id,
          moved.sub.status as MirroredSubscriptionStatus,
          moved.sub.collection_method,
        );
      }
      await setBillingTerms(trx, tenant.id, patch, operatorEmail);
      await audit(trx, result);
    });
  } catch (err) {
    if (moved && stripe) {
      try {
        await switchSubscriptionCollection(stripe, moved.sub.id, moved.previous);
      } catch (undo) {
        console.error(
          `[billing] ALERT: moved subscription ${moved.sub.id} (tenant ${tenant.id}) to ${terms.method} but could not save it or move it back — set it in Stripe by hand`,
          undo,
        );
      }
    }
    throw err;
  }
  return result;
}
