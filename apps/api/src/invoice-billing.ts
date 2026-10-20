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
 * Indian brands are invoiced only with a GSTIN: a GST-registered buyer
 * self-assesses GST under reverse charge, and OpenPartner isn't registered
 * under OIDAR to bill anyone else in India. The GSTIN goes on the Stripe
 * customer as tax ID in_gst, with the footer "Reverse charge applicable",
 * so both print on every invoice.
 */

import type { Knex } from 'knex';
import type Stripe from 'stripe';
import { TABLES, type BillingCollectionMethod, type HostedBillingProfileRow } from '@openpartner/db';
// LocationDeclaration and PlatformSetting are platform-scoped: only the
// privileged pool can read them, whichever pool the caller holds.
import { db as privilegedDb } from './db.js';
import { latestDeclaredCountries } from './country-access.js';
import { getInvoiceBillingSettings, type InvoiceBillingSettings } from './platform-settings.js';
import {
  INVOICE_GRACE_DAYS_DEFAULT,
  mirrorHostedBillingState,
  type MirroredSubscriptionStatus,
} from './billing-plan.js';

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
 * catches a typo.
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
  /** Invoice billing for an Indian brand, which needs a GSTIN. */
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
    gstinRequired: method === 'send_invoice' && country === 'IN',
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

export type BillingProfilePatch = Partial<
  Pick<HostedBillingProfileRow, 'collectionMethod' | 'daysUntilDue' | 'graceDays' | 'gstin'>
>;

/** Insert or update the tenant's profile. Keys left undefined keep their
 *  value (or the column default on a new row). */
export async function upsertBillingProfile(
  db: Knex,
  tenantId: string,
  patch: BillingProfilePatch,
  updatedByEmail: string | null,
): Promise<HostedBillingProfileRow> {
  const set: Record<string, unknown> = { updatedByEmail, updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) set[k] = v;
  const [row] = (await db(TABLES.HostedBillingProfile)
    .insert({ tenantId, ...set })
    .onConflict('tenantId')
    .merge(set)
    .returning('*')) as HostedBillingProfileRow[];
  return row!;
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
    | (Pick<HostedBillingProfileRow, 'collectionMethod' | 'daysUntilDue' | 'graceDays' | 'gstin' | 'updatedByEmail'> & {
        updatedAt: string;
      })
    | null;
  /** What a new subscription gets. */
  terms: CollectionTerms;
  subscription: {
    live: boolean;
    status: string | null;
    collectionMethod: BillingCollectionMethod | null;
    pastDueSince: string | null;
  };
}

/**
 * The tenants the Invoicing tab shows: any ops set terms for, any whose
 * declared country defaults to invoices, and any whose live subscription
 * is invoiced. Overdue ones first.
 */
export async function listInvoiceBillingTenants(
  db: Knex,
  settings: InvoiceBillingSettings,
): Promise<InvoiceBillingTenantView[]> {
  const profiles = (await db<HostedBillingProfileRow>(TABLES.HostedBillingProfile)) as HostedBillingProfileRow[];
  const declared = (
    (await db.raw(
      `select distinct on ("subjectId") "subjectId", "country"
         from ?? where "subjectKind" = 'tenant'
        order by "subjectId", "createdAt" desc`,
      [TABLES.LocationDeclaration],
    )) as { rows: Array<{ subjectId: string; country: string }> }
  ).rows;
  const countryOf = new Map(declared.map((r) => [r.subjectId, r.country]));
  const invoiced = (await db(TABLES.HostedBillingState)
    .where({ collectionMethod: 'send_invoice' })
    .pluck('tenantId')) as string[];
  const ids = [
    ...new Set([
      ...profiles.map((p) => p.tenantId),
      ...declared.filter((r) => settings.defaultCountries.includes(r.country)).map((r) => r.subjectId),
      ...invoiced,
    ]),
  ];
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
    .select(['tenantId', 'subscriptionStatus', 'collectionMethod', 'pastDueSince'])) as Array<{
    tenantId: string;
    subscriptionStatus: string | null;
    collectionMethod: BillingCollectionMethod | null;
    pastDueSince: Date | null;
  }>;
  const mirrors = new Map(mirrorRows.map((m) => [m.tenantId, m]));
  const profileOf = new Map(profiles.map((p) => [p.tenantId, p]));
  return tenants
    .map((t): InvoiceBillingTenantView => {
      const p = profileOf.get(t.id) ?? null;
      const m = mirrors.get(t.id);
      const live = !!t.stripeSubscriptionId;
      const country = countryOf.get(t.id) ?? null;
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
              updatedAt: new Date(p.updatedAt).toISOString(),
            }
          : null,
        terms: collectionTerms(p, country, settings),
        subscription: {
          live,
          status: live ? (m?.subscriptionStatus ?? null) : null,
          collectionMethod: live ? (m?.collectionMethod ?? null) : null,
          pastDueSince: live && m?.pastDueSince ? new Date(m.pastDueSince).toISOString() : null,
        },
      };
    })
    .sort(
      (a, b) =>
        Number(!!b.subscription.pastDueSince) - Number(!!a.subscription.pastDueSince) || a.name.localeCompare(b.name),
    );
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
 * Ops changes how a tenant pays. Saves the profile and, when the tenant has
 * a live subscription that no longer matches, moves that subscription in
 * Stripe first, so a refused move (no GSTIN, no card) saves nothing.
 * `ref` is the tenant id or slug.
 */
export async function setTenantCollection(
  db: Knex,
  stripe: Stripe | null,
  ref: string,
  patch: Pick<BillingProfilePatch, 'collectionMethod' | 'daysUntilDue' | 'graceDays'>,
  operatorEmail: string,
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

  let moved: BillingCollectionMethod | null = null;
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
      let updated: Stripe.Subscription;
      try {
        updated = await switchSubscriptionCollection(stripe, sub.id, terms);
      } catch (err) {
        if (err instanceof CollectionSwitchError) throw new OpsCollectionError(err.code, err.message);
        throw err;
      }
      moved = terms.method;
      await mirrorHostedBillingState(
        db,
        tenant.id,
        updated.status as MirroredSubscriptionStatus,
        updated.collection_method,
      );
    }
  }
  await upsertBillingProfile(db, tenant.id, patch, operatorEmail);
  return { tenantId: tenant.id, terms, moved };
}
