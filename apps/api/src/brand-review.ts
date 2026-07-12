/**
 * Brand-review core: blocklist checks, audit logging, ops notifications,
 * and the approve / reject / reinstate state transitions.
 *
 * All of this runs on the privileged `db` pool — the review console routes
 * and the public signup route both sit BEFORE tenantMiddleware, so there is
 * no per-request tenant transaction. Cross-tenant reads/writes (any brand,
 * the platform-scoped blocklist + audit) are legitimate here and RLS is
 * bypassed on this pool by design (see apps/api/src/db.ts).
 */

import { ulid } from 'ulid';
import type { Knex } from 'knex';
import {
  DEFAULT_TENANT_ID,
  TABLES,
  type AdminRow,
  type SignupBlocklistRow,
  type TenantRow,
} from '@openpartner/db';
import { getMailer } from './mailer.js';
import { getPortalBaseUrl } from './portal-url.js';
import {
  brandApprovedEmail,
  brandRejectedEmail,
  opsBrandDecisionEmail,
  opsBrandNeedsReviewEmail,
} from './email-templates.js';

export interface OpsActor {
  id: string;
  email: string;
  role: 'support' | 'admin';
}

// --------------------------------------------------------------------------
// Blocklist
// --------------------------------------------------------------------------

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).trim().toLowerCase();
}

/**
 * True when this email is blocked from signup — either the exact address
 * is banned, or its domain is. Returns the matching entry so callers can
 * log which rule fired.
 */
export async function findBlockingEntry(
  db: Knex,
  email: string,
): Promise<SignupBlocklistRow | null> {
  const normalized = normalizeEmail(email);
  const domain = emailDomain(normalized);
  const rows = await db<SignupBlocklistRow>(TABLES.SignupBlocklist)
    .where({ type: 'email', value: normalized })
    .orWhere((qb) => {
      if (domain) void qb.where({ type: 'domain', value: domain });
      else void qb.whereRaw('1 = 0');
    });
  return rows[0] ?? null;
}

/** Add (or update the reason of) a blocklist entry. Idempotent on
 *  (type, value). Returns the row id. */
export async function addBlocklistEntry(
  db: Knex,
  params: { type: 'email' | 'domain'; value: string; reason?: string | null; createdByEmail?: string | null },
): Promise<string> {
  const id = ulid();
  const value = params.value.trim().toLowerCase();
  await db<SignupBlocklistRow>(TABLES.SignupBlocklist)
    .insert({
      id,
      type: params.type,
      value,
      reason: params.reason ?? null,
      createdByEmail: params.createdByEmail ?? null,
    })
    .onConflict(['type', 'value'])
    .merge({ reason: params.reason ?? null, createdByEmail: params.createdByEmail ?? null });
  return id;
}

// --------------------------------------------------------------------------
// Audit
// --------------------------------------------------------------------------

export async function writeAudit(
  db: Knex,
  params: {
    actor: OpsActor | null;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db(TABLES.PlatformAuditLog).insert({
    id: ulid(),
    platformAdminId: params.actor?.id ?? null,
    platformAdminEmail: params.actor?.email ?? 'system',
    action: params.action,
    targetType: params.targetType ?? null,
    targetId: params.targetId ?? null,
    detail: (params.detail ?? {}) as unknown as never,
  });
}

// --------------------------------------------------------------------------
// Ops notifications
// --------------------------------------------------------------------------

/** The platform-ops inbox that review notifications go to. Unset → ops
 *  email is skipped (self-host / dev). */
export function platformOpsEmail(): string | null {
  const v = (process.env.PLATFORM_OPS_EMAIL ?? '').trim();
  return v.length > 0 ? v : null;
}

/** URL to the review queue in the ops console (platform origin, no tenant
 *  prefix). */
export function opsConsoleUrl(): string {
  return `${getPortalBaseUrl()}/platform/brands`;
}

/**
 * Send an ops notification through the PLATFORM mail transport. We pass
 * DEFAULT_TENANT_ID as the mail context so resolveMailConfig falls through
 * to the env transport rather than a brand's UI-configured provider — an
 * internal ops alert must never egress via a customer's Postmark account.
 */
async function sendOps(db: Knex, tmpl: { subject: string; text: string; html: string }, tag: string): Promise<void> {
  const to = platformOpsEmail();
  if (!to) return;
  try {
    await getMailer().send({ db, tenantId: DEFAULT_TENANT_ID }, {
      to,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag,
      metadata: { channel: 'platform_ops' },
    });
  } catch (err) {
    console.error('[brand-review] ops notify failed', err);
  }
}

export async function notifyOpsNewBrand(
  db: Knex,
  params: { brandName: string; slug: string; adminEmail: string },
): Promise<void> {
  const tmpl = opsBrandNeedsReviewEmail(params.brandName, params.slug, params.adminEmail, opsConsoleUrl());
  await sendOps(db, tmpl, 'ops_brand_needs_review');
}

async function notifyOpsDecision(
  db: Knex,
  params: {
    brandName: string;
    slug: string;
    decision: 'approved' | 'rejected' | 'reinstated';
    operatorEmail: string;
    reason: string | null;
  },
): Promise<void> {
  const tmpl = opsBrandDecisionEmail(
    params.brandName,
    params.slug,
    params.decision,
    params.operatorEmail,
    params.reason,
  );
  await sendOps(db, tmpl, 'ops_brand_decision');
}

// --------------------------------------------------------------------------
// Brand-facing notifications
// --------------------------------------------------------------------------

/** Oldest non-revoked admin for a tenant — our canonical "primary contact"
 *  (same convention as campaign-end-notifications). Null when the brand has
 *  no admin (shouldn't happen post-signup). */
async function primaryAdmin(db: Knex, tenantId: string): Promise<AdminRow | null> {
  const row = await db<AdminRow>(TABLES.Admin)
    .where({ tenantId })
    .whereNull('revokedAt')
    .orderBy('createdAt', 'asc')
    .first();
  return row ?? null;
}

async function notifyBrandApproved(db: Knex, tenant: TenantRow): Promise<void> {
  const admin = await primaryAdmin(db, tenant.id);
  if (!admin) return;
  // Respect a white-label custom domain if the brand already has one.
  const enterUrl = `${getPortalBaseUrl({ slug: tenant.slug, customDomain: tenant.customDomain })}/`;
  const tmpl = brandApprovedEmail(admin.name, tenant.displayName, enterUrl);
  try {
    await getMailer().send({ db, tenantId: tenant.id }, {
      to: admin.email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'brand_approved',
      metadata: { tenantId: tenant.id },
    });
  } catch (err) {
    console.error('[brand-review] brand approved mail failed', err);
  }
}

async function notifyBrandRejected(db: Knex, tenant: TenantRow, reason: string | null): Promise<void> {
  const admin = await primaryAdmin(db, tenant.id);
  if (!admin) return;
  const tmpl = brandRejectedEmail(tenant.displayName, reason);
  try {
    await getMailer().send({ db, tenantId: tenant.id }, {
      to: admin.email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'brand_rejected',
      metadata: { tenantId: tenant.id },
    });
  } catch (err) {
    console.error('[brand-review] brand rejected mail failed', err);
  }
}

// --------------------------------------------------------------------------
// State transitions
// --------------------------------------------------------------------------

/**
 * Approve a brand (from pending OR reinstate from rejected). Sets
 * approvalStatus='approved' and ensures the tenant is live
 * (status='active', suspension cleared). Notifies the brand + ops, writes
 * an audit row. `reinstate` only changes the audit verb.
 */
export async function approveBrand(
  db: Knex,
  tenant: TenantRow,
  actor: OpsActor,
  opts: { reinstate?: boolean } = {},
): Promise<void> {
  const now = new Date();
  await db<TenantRow>(TABLES.Tenant).where({ id: tenant.id }).update({
    approvalStatus: 'approved',
    approvalReason: null,
    reviewedAt: now,
    reviewedByEmail: actor.email,
    // A brand previously rejected-and-suspended comes back to life.
    status: 'active',
    suspendedAt: null,
    updatedAt: now,
  });
  await writeAudit(db, {
    actor,
    action: opts.reinstate ? 'brand.reinstate' : 'brand.approve',
    targetType: 'tenant',
    targetId: tenant.id,
    detail: { slug: tenant.slug, priorApprovalStatus: tenant.approvalStatus },
  });
  await notifyBrandApproved(db, { ...tenant, status: 'active', approvalStatus: 'approved' });
  await notifyOpsDecision(db, {
    brandName: tenant.displayName,
    slug: tenant.slug,
    decision: opts.reinstate ? 'reinstated' : 'approved',
    operatorEmail: actor.email,
    reason: null,
  });
}

/**
 * Reject a brand. Sets approvalStatus='rejected' AND suspends the tenant
 * (status='suspended') so every existing status='active' filter takes it
 * dark immediately — used both for fresh spam signups and for retroactive
 * removal of an already-approved brand. Brand notification is OPT-IN
 * (silent by default, so we don't tip off spam/phishing). Optionally bans
 * the brand's admin email and/or its domain from future signups.
 */
export async function rejectBrand(
  db: Knex,
  tenant: TenantRow,
  actor: OpsActor,
  opts: { reason?: string | null; notifyBrand?: boolean; banEmail?: boolean; banDomain?: boolean } = {},
): Promise<{ bannedEmail: string | null; bannedDomain: string | null }> {
  const now = new Date();
  const reason = opts.reason?.trim() || null;
  await db<TenantRow>(TABLES.Tenant).where({ id: tenant.id }).update({
    approvalStatus: 'rejected',
    approvalReason: reason,
    reviewedAt: now,
    reviewedByEmail: actor.email,
    status: 'suspended',
    suspendedAt: now,
    updatedAt: now,
  });

  let bannedEmail: string | null = null;
  let bannedDomain: string | null = null;
  if (opts.banEmail || opts.banDomain) {
    const admin = await primaryAdmin(db, tenant.id);
    const adminEmail = admin ? normalizeEmail(admin.email) : null;
    if (opts.banEmail && adminEmail) {
      await addBlocklistEntry(db, {
        type: 'email',
        value: adminEmail,
        reason: reason ?? `rejected brand ${tenant.slug}`,
        createdByEmail: actor.email,
      });
      bannedEmail = adminEmail;
    }
    if (opts.banDomain && adminEmail) {
      const domain = emailDomain(adminEmail);
      if (domain) {
        await addBlocklistEntry(db, {
          type: 'domain',
          value: domain,
          reason: reason ?? `rejected brand ${tenant.slug}`,
          createdByEmail: actor.email,
        });
        bannedDomain = domain;
      }
    }
  }

  await writeAudit(db, {
    actor,
    action: 'brand.reject',
    targetType: 'tenant',
    targetId: tenant.id,
    detail: {
      slug: tenant.slug,
      reason,
      notifiedBrand: !!opts.notifyBrand,
      bannedEmail,
      bannedDomain,
      priorApprovalStatus: tenant.approvalStatus,
    },
  });

  if (opts.notifyBrand) {
    await notifyBrandRejected(db, tenant, reason);
  }
  await notifyOpsDecision(db, {
    brandName: tenant.displayName,
    slug: tenant.slug,
    decision: 'rejected',
    operatorEmail: actor.email,
    reason,
  });

  return { bannedEmail, bannedDomain };
}
