/**
 * The pricing-change notice that moves an existing customer onto the
 * commission-floor platform fee (docs/platform-fee.md).
 *
 * The Terms: "We may change pricing with at least 30 days' notice. Changes
 * apply at the start of your next billing cycle." So a tenant whose paid
 * plan started before the cutover is emailed, and its effective date is the
 * notice time + 30 days, then the start of its next Stripe billing period
 * (fee-terms.ts effectiveAfterNotice). Until then it stays on the old rule,
 * and the shadow comparison shows what the new one would bill.
 *
 * Operator-driven only: the ops console previews the recipients, dates and
 * email, and nothing is sent until an operator clicks send. The notice is
 * an essential contractual notice, not marketing: every active admin gets
 * it and there is no opt-out (EmailOptOut covers setup reminders only).
 *
 * Idempotent: a tenant is claimed (HostedFeeTerms.noticeSentAt) before its
 * email goes out, so a double click or a second operator can't notice it
 * twice; if every recipient's send fails, the claim is released and the
 * tenant stays on the old rule, un-noticed.
 */

import type { Knex } from 'knex';
import { DEFAULT_TENANT_ID, TABLES, type AdminRow, type HostedFeeTermsRow, type TenantRow } from '@openpartner/db';
import { pricingChangeNoticeEmail } from './email-templates.js';
import { getMailer } from './mailer.js';
import { getPortalBaseUrl } from './portal-url.js';
import { resolveBrandName } from './brand-name.js';
import { requireStripe } from './stripe.js';
import { planToMode } from './billing-plan.js';
import { effectiveAfterNotice, isMeteredMode, ratesFor } from './fee-terms.js';
import { getFeeRuleSettings, type FeeRuleSettings } from './platform-settings.js';

export const PRICING_URL = 'https://openpartner.dev/pricing';

/** What the notice needs from a tenant's Stripe subscription. */
export interface SubscriptionBilling {
  startDate: Date;
  anchor: Date;
  interval: 'day' | 'week' | 'month' | 'year';
  count: number;
}

export type ReadSubscription = (subscriptionId: string) => Promise<SubscriptionBilling>;

async function readStripeSubscription(subscriptionId: string): Promise<SubscriptionBilling> {
  const sub = await requireStripe().subscriptions.retrieve(subscriptionId);
  const recurring = sub.items.data[0]?.price?.recurring;
  return {
    startDate: new Date(sub.start_date * 1000),
    anchor: new Date(sub.billing_cycle_anchor * 1000),
    interval: recurring?.interval ?? 'month',
    count: recurring?.interval_count ?? 1,
  };
}

export interface NoticeCandidate {
  tenantId: string;
  slug: string;
  brandName: string;
  plan: string | null;
  recipients: Array<{ email: string; name: string | null }>;
  revenueRate: number;
  commissionRate: number;
  /** When the new rule would apply if the notice went out now. */
  effectiveAt: string | null;
  /** Why this tenant can't be noticed right now (e.g. Stripe unreadable). */
  error?: string;
}

export interface NoticePreview {
  cutoverAt: string | null;
  candidates: NoticeCandidate[];
  /** The email the first candidate would get. */
  sample: { to: string; subject: string; text: string } | null;
}

function pct(rate: number): string {
  return `${Number((rate * 100).toFixed(3))}%`;
}

function dateLabel(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Tenants owed a notice: a paid Stripe plan (Flex or Revshare) that started
 * before the cutover, not yet noticed and not already on the new rule.
 * Enterprise contracts are excluded: they move by contract.
 */
async function loadCandidates(
  db: Knex,
  settings: FeeRuleSettings,
  now: Date,
  readSubscription: ReadSubscription,
  tenantIds?: string[],
): Promise<Array<NoticeCandidate & { customDomain: string | null }>> {
  if (!settings.cutoverAt) return [];
  const cutover = new Date(settings.cutoverAt);
  let q = db<TenantRow>(TABLES.Tenant)
    .where({ status: 'active' })
    .whereNot({ id: DEFAULT_TENANT_ID })
    .whereNull('pendingDeletionAt')
    .whereNotNull('stripeSubscriptionId')
    .where((w) => w.whereNull('billingPlan').orWhereIn('billingPlan', ['flex', 'revshare']));
  if (tenantIds) q = q.whereIn('id', tenantIds);
  const tenants = (await q.orderBy('createdAt', 'asc').select('id', 'slug', 'displayName', 'customDomain', 'billingPlan', 'stripeSubscriptionId')) as Array<
    Pick<TenantRow, 'id' | 'slug' | 'displayName' | 'customDomain' | 'billingPlan' | 'stripeSubscriptionId'>
  >;
  if (tenants.length === 0) return [];
  const ids = tenants.map((t) => t.id);
  const terms = new Map(
    ((await db<HostedFeeTermsRow>(TABLES.HostedFeeTerms).whereIn('tenantId', ids)) as HostedFeeTermsRow[]).map((r) => [r.tenantId, r]),
  );
  const admins = (await db<AdminRow>(TABLES.Admin)
    .whereIn('tenantId', ids)
    .whereNull('revokedAt')
    .whereNotNull('activatedAt')
    .orderBy('activatedAt', 'asc')
    .select('tenantId', 'email', 'name')) as Array<Pick<AdminRow, 'tenantId' | 'email' | 'name'>>;

  const out: Array<NoticeCandidate & { customDomain: string | null }> = [];
  for (const t of tenants) {
    const row = terms.get(t.id) ?? null;
    if (row?.noticeSentAt || row?.effectiveAt) continue;
    const mode = planToMode(t.billingPlan);
    if (!isMeteredMode(mode)) continue;
    const recipients = admins.filter((a) => a.tenantId === t.id).map((a) => ({ email: a.email, name: a.name }));
    const rates = ratesFor(mode, settings, row);
    const candidate: NoticeCandidate & { customDomain: string | null } = {
      tenantId: t.id,
      slug: t.slug,
      brandName: (await resolveBrandName(db, t.id)) ?? t.displayName,
      plan: t.billingPlan,
      recipients,
      revenueRate: rates.revenueRate,
      commissionRate: rates.commissionRate,
      effectiveAt: null,
      customDomain: t.customDomain,
    };
    try {
      const billing = await readSubscription(t.stripeSubscriptionId!);
      // A plan started after the cutover is on the new rule already
      // (fee-terms.ts moves it on its next usage report): no notice.
      if (billing.startDate >= cutover) continue;
      candidate.effectiveAt = effectiveAfterNotice(now, billing).toISOString();
    } catch (err) {
      candidate.error = `could not read the Stripe subscription: ${(err as Error).message}`;
    }
    if (recipients.length === 0) candidate.error = candidate.error ?? 'no active admin to notify';
    out.push(candidate);
  }
  return out;
}

function noticeEmail(c: NoticeCandidate & { customDomain: string | null }, recipient: { name: string | null }) {
  return pricingChangeNoticeEmail({
    adminName: recipient.name,
    brandName: c.brandName,
    revenueRate: pct(c.revenueRate),
    commissionRate: pct(c.commissionRate),
    breakEven: c.commissionRate > 0 ? pct(c.revenueRate / c.commissionRate) : '100%',
    effectiveDate: dateLabel(new Date(c.effectiveAt!)),
    pricingUrl: PRICING_URL,
    billingUrl: `${getPortalBaseUrl({ slug: c.slug, customDomain: c.customDomain })}/admin/billing`,
  });
}

export async function previewPricingNotices(
  db: Knex,
  opts: { now?: Date; tenantIds?: string[]; readSubscription?: ReadSubscription; settings?: FeeRuleSettings } = {},
): Promise<NoticePreview> {
  const settings = opts.settings ?? (await getFeeRuleSettings(db));
  const candidates = await loadCandidates(db, settings, opts.now ?? new Date(), opts.readSubscription ?? readStripeSubscription, opts.tenantIds);
  const first = candidates.find((c) => !c.error);
  const sample = first
    ? (() => {
        const e = noticeEmail(first, first.recipients[0]!);
        return { to: first.recipients[0]!.email, subject: e.subject, text: e.text };
      })()
    : null;
  return {
    cutoverAt: settings.cutoverAt,
    candidates: candidates.map(({ customDomain: _customDomain, ...c }) => c),
    sample,
  };
}

export interface NoticeSendResult {
  sent: Array<{ tenantId: string; slug: string; recipients: string[]; effectiveAt: string; failedRecipients: string[] }>;
  skipped: Array<{ tenantId: string; slug: string; reason: string }>;
  failed: Array<{ tenantId: string; slug: string; reason: string }>;
}

export async function sendPricingNotices(
  db: Knex,
  opts: { operatorEmail: string; now?: Date; tenantIds?: string[]; readSubscription?: ReadSubscription; settings?: FeeRuleSettings },
): Promise<NoticeSendResult> {
  const settings = opts.settings ?? (await getFeeRuleSettings(db));
  const now = opts.now ?? new Date();
  const result: NoticeSendResult = { sent: [], skipped: [], failed: [] };
  const candidates = await loadCandidates(db, settings, now, opts.readSubscription ?? readStripeSubscription, opts.tenantIds);
  for (const c of candidates) {
    if (c.error || !c.effectiveAt) {
      result.skipped.push({ tenantId: c.tenantId, slug: c.slug, reason: c.error ?? 'no effective date' });
      continue;
    }
    const effectiveAt = new Date(c.effectiveAt);
    // Claim first: only one send per tenant, ever.
    await db(TABLES.HostedFeeTerms).insert({ tenantId: c.tenantId, updatedAt: now }).onConflict('tenantId').ignore();
    const claimed = (await db(TABLES.HostedFeeTerms)
      .where({ tenantId: c.tenantId })
      .whereNull('noticeSentAt')
      .whereNull('effectiveAt')
      .update({
        noticeSentAt: now,
        noticeSentByEmail: opts.operatorEmail,
        noticeRecipients: JSON.stringify(c.recipients.map((r) => r.email)),
        effectiveAt,
        effectiveSource: 'notice',
        updatedByEmail: opts.operatorEmail,
        updatedAt: now,
      })
      .returning('tenantId')) as Array<{ tenantId: string }>;
    if (claimed.length === 0) {
      result.skipped.push({ tenantId: c.tenantId, slug: c.slug, reason: 'already noticed' });
      continue;
    }

    const delivered: string[] = [];
    const failedRecipients: string[] = [];
    for (const r of c.recipients) {
      const tmpl = noticeEmail(c, r);
      try {
        await getMailer().send(
          { db, tenantId: DEFAULT_TENANT_ID },
          {
            to: r.email,
            subject: tmpl.subject,
            text: tmpl.text,
            html: tmpl.html,
            tag: 'pricing_change_notice',
            metadata: { tenantId: c.tenantId, effectiveAt: c.effectiveAt },
            platform: true,
          },
        );
        delivered.push(r.email);
      } catch (err) {
        console.error(`[fee-notice] send to ${r.email} for tenant ${c.tenantId} failed: ${(err as Error).message}`);
        failedRecipients.push(r.email);
      }
    }
    if (delivered.length === 0) {
      // Nobody got it: no notice was given, so no clock starts.
      await db(TABLES.HostedFeeTerms)
        .where({ tenantId: c.tenantId, noticeSentAt: now })
        .update({ noticeSentAt: null, noticeSentByEmail: null, noticeRecipients: null, effectiveAt: null, effectiveSource: null, updatedAt: new Date() });
      result.failed.push({ tenantId: c.tenantId, slug: c.slug, reason: 'every send failed' });
      continue;
    }
    if (failedRecipients.length > 0) {
      await db(TABLES.HostedFeeTerms)
        .where({ tenantId: c.tenantId })
        .update({ noticeRecipients: JSON.stringify(delivered) });
    }
    result.sent.push({ tenantId: c.tenantId, slug: c.slug, recipients: delivered, effectiveAt: c.effectiveAt, failedRecipients });
  }
  return result;
}
