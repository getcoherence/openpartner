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
  type ProgramRow,
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
  // Undo any Network-side suspension from a prior rejection so the brand's
  // marketplace listings can come back.
  await reactivateBrandOnNetwork(db, tenant.id);

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

  // Suspend the brand's Vendor on the Network. This is what actually pulls
  // its programs off the public marketplace — a local suspend alone leaves
  // the listing up and still accepting creator applications.
  await suspendBrandOnNetwork(db, tenant.id, reason ?? `brand rejected by ${actor.email}`);

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

// --------------------------------------------------------------------------
// Network (marketplace) propagation
// --------------------------------------------------------------------------
//
// Offerings live on the Network — a separate service. Taking a brand or a
// program dark LOCALLY (suspending the tenant, blocking the program's links)
// does nothing to its public marketplace listing, so without these calls a
// rejected spam brand stays listed and keeps taking creator applications.
//
// The Network already filters `Offering.published = true AND
// Vendor.status = 'active'` on both the marketplace list and the offering
// detail page — it just has to be TOLD. Brand reject → suspend the Vendor
// (pulls every offering at once); program block → unpublish that offering.
//
// All best-effort: a Network outage must not block a local takedown. We log
// and continue; re-running the action retries the propagation.

/** The brand's Network identity, when it's actually federated. */
async function networkVendorOf(
  db: Knex,
  tenantId: string,
): Promise<{ networkUrl: string; vendorId: string } | null> {
  try {
    const { getNetworkMembership } = await import('./network-client.js');
    const m = await getNetworkMembership(db, tenantId);
    if (!m?.networkUrl || !m.vendorId) return null;
    return { networkUrl: m.networkUrl, vendorId: m.vendorId };
  } catch {
    return null;
  }
}

/** Pull the brand off the marketplace entirely (all offerings, all at once). */
async function suspendBrandOnNetwork(db: Knex, tenantId: string, reason: string): Promise<void> {
  const v = await networkVendorOf(db, tenantId);
  if (!v) return;
  try {
    const { adminSuspendVendor } = await import('./network-client.js');
    await adminSuspendVendor(v.networkUrl, v.vendorId, reason);
  } catch (err) {
    console.error('[brand-review] network vendor suspend failed', { tenantId, err });
  }
}

/** Undo suspendBrandOnNetwork on approve/reinstate. */
async function reactivateBrandOnNetwork(db: Knex, tenantId: string): Promise<void> {
  const v = await networkVendorOf(db, tenantId);
  if (!v) return;
  try {
    const { adminReactivateVendor } = await import('./network-client.js');
    await adminReactivateVendor(v.networkUrl, v.vendorId);
  } catch (err) {
    console.error('[brand-review] network vendor reactivate failed', { tenantId, err });
  }
}

/** Flip a single offering's published flag (program-level takedown). */
async function setOfferingPublished(
  db: Knex,
  tenantId: string,
  offeringId: string,
  published: boolean,
): Promise<void> {
  try {
    const { networkProxy } = await import('./network-client.js');
    await networkProxy.updateOffering(db, tenantId, offeringId, { published });
  } catch (err) {
    console.error('[brand-review] network offering publish flip failed', { tenantId, offeringId, published, err });
  }
}

// --------------------------------------------------------------------------
// Program-level moderation (takedown without removing the brand)
// --------------------------------------------------------------------------

/** Block a single program — its partner links stop redirecting (enforced in
 *  the router) AND its marketplace offering is unpublished, while the brand
 *  stays live. Reversible via unblockProgram. */
export async function blockProgram(
  db: Knex,
  program: ProgramRow,
  actor: OpsActor,
  reason: string | null,
): Promise<void> {
  await db<ProgramRow>(TABLES.Program).where({ id: program.id }).update({
    blockedAt: new Date(),
    blockedReason: reason?.trim() || null,
    blockedByEmail: actor.email,
  });
  await writeAudit(db, {
    actor,
    action: 'program.block',
    targetType: 'program',
    targetId: program.id,
    detail: {
      tenantId: program.tenantId,
      name: program.name,
      reason: reason?.trim() || null,
      networkOfferingId: program.networkOfferingId,
    },
  });
  // Pull the marketplace listing — otherwise the program keeps taking
  // creator applications from the Network even though its links are dead.
  if (program.networkOfferingId) {
    await setOfferingPublished(db, program.tenantId, program.networkOfferingId, false);
  }
}

/** Lift a program block — links redirect again, and the marketplace listing
 *  comes back if the brand had it shared. */
export async function unblockProgram(
  db: Knex,
  program: ProgramRow,
  actor: OpsActor,
): Promise<void> {
  await db<ProgramRow>(TABLES.Program).where({ id: program.id }).update({
    blockedAt: null,
    blockedReason: null,
    blockedByEmail: null,
  });
  await writeAudit(db, {
    actor,
    action: 'program.unblock',
    targetType: 'program',
    targetId: program.id,
    detail: { tenantId: program.tenantId, name: program.name },
  });
  // Only re-list if the brand actually wants it on the marketplace.
  if (program.networkOfferingId && program.shareOnNetwork) {
    await setOfferingPublished(db, program.tenantId, program.networkOfferingId, true);
  }
}
