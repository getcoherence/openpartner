/**
 * Program-wide settings stored in the Config table. Keyed by
 * `program_settings`, the value is a JSON blob of:
 *
 *   programName?: string   — how to brand the portal (admin + partner)
 *   supportEmail?: string  — shown in the partner footer as contact
 *
 * Env is reserved for secrets + build-time; runtime content like this
 * lives here so admins can update it without a redeploy.
 */

import { Router } from 'express';
import type { Knex } from 'knex';
import { z } from '../zod.js';
import {
  PAYOUT_CADENCES,
  PAYOUT_RAIL_PREFERENCES,
  TABLES,
  type AdminRow,
  type ConfigRow,
  type PayoutCadence,
  type PayoutRailPreference,
  type TenantRow,
} from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import {
  MailSettingsValidationError,
  getPublicMailSettings,
  saveMailSettings,
  type MailTransportKind,
} from '../mail-settings.js';
import { getMailer } from '../mailer.js';
import {
  completeNetworkConnect,
  getNetworkMembership,
  getPublicNetworkMembership,
  grantFederationScope,
  NETWORK_BONUS_SCOPE,
  NetworkProxyError,
  networkProxy,
  saveNetworkMembership,
  sendHeartbeat,
  signupWithNetwork,
} from '../network-client.js';
import { isNetworkOfferedToPartners, resyncConsentedPartners, summarizeNetworkConsent } from '../network-consent.js';
import { readPartnerAccessSettings, savePartnerAccessSettings } from '../partner-portal-access.js';
import { readStatementSettings, saveStatementSettings } from '../payout-statements.js';
import { clearNetworkListingSkip } from '../onboarding-settings.js';
import { createApiKeyRow } from '../auth.js';
import { getTenancyMode, tenantOf } from '../tenancy.js';
import { NETWORK_FEDERATION_SCOPES } from './api-keys.js';
import { getTenantBillingState, hasActivePlan } from '../billing-plan.js';
import { bookingFeeBpsFor } from '../booking-fee.js';
import { connectPayoutsAvailable } from '../payout-method.js';
import { isWhiteLabelEntitled, getWhiteLabelState } from '../white-label.js';
import { currencyInputSchema } from '../currency.js';

export const settingsRouter = Router();

const CONFIG_KEY = 'program_settings';

const settingsSchema = z.object({
  partnerNetworkVisible: z.boolean().optional(),
  routerUrl: z.string().trim().max(2048).refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
        url.pathname === '/' && !url.search && !url.hash;
    } catch { return false; }
  }, 'Use an HTTP(S) origin without a path, credentials, query or fragment').optional(),
  programName: z.string().trim().max(120).optional(),
  supportEmail: z.string().trim().email().max(254).optional().or(z.literal('')),
  // Hex format mirrors the DB CHECK constraint (#RGB / #RRGGBB / #RRGGBBAA).
  brandColor: z
    .string()
    .trim()
    .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/)
    .optional()
    .or(z.literal('')),
  programTermsUrl: z.string().trim().url().max(2048).optional().or(z.literal('')),
  /** ISO 4217. Conversions sent without a currency are stored in it. */
  defaultCurrency: currencyInputSchema.optional(),
});

/** What we persist into the Config row. Logo lives on Tenant; everything
 *  else is per-tenant program settings. */
interface PersistedProgramSettings {
  partnerNetworkVisible: boolean;
  routerUrl: string | null;
  programName: string | null;
  supportEmail: string | null;
}

export interface ProgramSettings extends PersistedProgramSettings {
  logoUrl: string | null;
  faviconUrl: string | null;
  brandColor: string | null;
  programTermsUrl: string | null;
  /** The brand's currency (Tenant.defaultCurrency): conversions sent
   *  without one are stored in it, and the portal formats currency-less
   *  amounts in it. Readable by partners, who see amounts in it. */
  defaultCurrency: string;
  /** Effective white-label entitlement. The portal keys branding removal
   *  + Network-surface hiding on this (provisioned flag AND entitling
   *  billing state — see white-label.ts). */
  whiteLabel: boolean;
  /** Whether this deployment lets a brand hide the Network from its
   *  partners. Self-host (single-tenant) only: on the hosted multi-tenant
   *  platform partner Network discovery is part of the product, and hiding
   *  it is what the paid white-label add-on does. */
  partnerNetworkToggleAvailable: boolean;
  /** Whether this brand can pay partners through Stripe Connect
   *  (payout-method.ts connectPayoutsAvailable). The partner portal
   *  offers Connect only when it can: elsewhere partners give payout
   *  details and the brand pays them directly. */
  connectPayoutsAvailable: boolean;
}

/** See ProgramSettings.partnerNetworkToggleAvailable. */
function partnerNetworkToggleAvailable(): boolean {
  return getTenancyMode() === 'single';
}

async function readSettings(db: Knex, tenantId: string): Promise<ProgramSettings> {
  const row = await db<ConfigRow>(TABLES.Config).where({ tenantId, key: CONFIG_KEY }).first();
  const value = (row?.value ?? {}) as Partial<PersistedProgramSettings>;
  // Fall back to Tenant.displayName so brand admins don't have to re-type
  // the brand name they set at signup. Saving this page promotes the
  // value into program_settings; until then we just surface the signup
  // value so the UI is pre-populated and the onboarding checklist
  // doesn't keep nagging about a thing that's effectively already set.
  let programName = value.programName ?? null;
  // Logo, brand color, and terms URL live on Tenant. Always read from
  // there so the cached Config row never lags the actual values.
  const tenant = await db<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId })
    .first([
      'displayName',
      'logoUrl',
      'faviconUrl',
      'brandColor',
      'programTermsUrl',
      'whiteLabel',
      'status',
      'defaultCurrency',
      'payoutRailPreference',
    ]);
  if (!programName && tenant?.displayName) programName = tenant.displayName as string;
  // Effective white-label: the provisioned flag AND an entitling billing
  // state. Computed here so any authenticated caller (admin or partner)
  // gets the brand truth — including whether to strip platform branding —
  // in the same fetch the portal already makes on load.
  const billing = await getTenantBillingState(db, tenantId);
  const whiteLabel = isWhiteLabelEntitled(
    { whiteLabel: tenant?.whiteLabel ?? false, status: tenant?.status ?? 'active' },
    billing,
  );
  return {
    programName,
    // Hosted always shows it, whatever a stale Config row says.
    partnerNetworkVisible: partnerNetworkToggleAvailable() ? (value.partnerNetworkVisible ?? true) : true,
    routerUrl: value.routerUrl ?? null,
    supportEmail: value.supportEmail ?? null,
    logoUrl: tenant?.logoUrl ?? null,
    faviconUrl: tenant?.faviconUrl ?? null,
    brandColor: tenant?.brandColor ?? null,
    programTermsUrl: tenant?.programTermsUrl ?? null,
    defaultCurrency: tenant?.defaultCurrency ?? 'USD',
    whiteLabel,
    partnerNetworkToggleAvailable: partnerNetworkToggleAvailable(),
    connectPayoutsAvailable: await connectPayoutsAvailable(db, tenantId, tenant?.payoutRailPreference ?? 'auto', billing.mode),
  };
}

/** Any authenticated caller (admin OR partner) can read — not secret. */
settingsRouter.get('/config/program', requireAuth, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await readSettings(db, tenantId));
});

/**
 * PUBLIC brand bootstrap (spec §4.7/§5.2) — deliberately unauthenticated so
 * pre-auth surfaces (login, magic-link landing) can render the tenant's
 * brand instead of platform branding. The tenant comes from tenantMiddleware
 * (custom-domain host or /t/<slug>/ path); a request with no tenant scope
 * (platform origin, marketing pages) gets platform defaults. Returns brand
 * fields only for the resolved tenant — the §4.3 edge-trust guard is what
 * prevents forging a host to read another tenant's brand context.
 */
settingsRouter.get('/branding', async (req, res) => {
  if (!req.db || !req.tenantId) {
    return res.json({
      tenantSlug: null,
      programName: null,
      logoUrl: null,
      faviconUrl: null,
      brandColor: null,
      supportEmail: null,
      programTermsUrl: null,
      whiteLabel: false,
      approvalStatus: null,
    });
  }
  const s = await readSettings(req.db, req.tenantId);
  // Approval state drives the "pending review" banner in the brand portal.
  // A tenant can read its own Tenant row under RLS (tenant_self policy).
  const tenantRow = await req.db<TenantRow>(TABLES.Tenant)
    .where({ id: req.tenantId })
    .first('approvalStatus');
  res.json({
    // The resolved tenant slug. A prefix-less request (the SPA probes bare
    // /api/branding) only carries a tenant when the HOST resolved one —
    // i.e. the SPA is being served from a white-label custom domain — so
    // the portal keys its root-mounted tenant routing on this.
    tenantSlug: req.tenantSlug ?? null,
    programName: s.programName,
    logoUrl: s.logoUrl,
    faviconUrl: s.faviconUrl,
    brandColor: s.brandColor,
    supportEmail: s.supportEmail,
    programTermsUrl: s.programTermsUrl,
    whiteLabel: s.whiteLabel,
    approvalStatus: tenantRow?.approvalStatus ?? null,
  });
});

/** Only admins write. Empty strings clear fields. */
settingsRouter.post('/config/program', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = settingsSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const previous = await readSettings(db, tenantId);
  const next: PersistedProgramSettings = {
    partnerNetworkVisible: partnerNetworkToggleAvailable()
      ? (body.data.partnerNetworkVisible ?? previous.partnerNetworkVisible)
      : true,
    routerUrl: body.data.routerUrl === undefined ? previous.routerUrl : (body.data.routerUrl ? new URL(body.data.routerUrl).origin : null),
    programName: body.data.programName?.trim() || null,
    supportEmail: body.data.supportEmail?.trim() || null,
  };
  const now = new Date();
  // Upsert: preserves updatedAt semantics without a separate read.
  await db<ConfigRow>(TABLES.Config)
    .insert({ tenantId, key: CONFIG_KEY, value: next as unknown as never, updatedAt: now })
    .onConflict(['tenantId', 'key'])
    .merge({ value: next as unknown as never, updatedAt: now });
  // brandColor + programTermsUrl live on Tenant (column-typed, not blob).
  // Only patch when present so an unrelated POST doesn't clear them.
  const tenantPatch: Partial<Pick<TenantRow, 'brandColor' | 'programTermsUrl' | 'defaultCurrency' | 'updatedAt'>> = {};
  if (body.data.brandColor !== undefined) {
    tenantPatch.brandColor = body.data.brandColor.trim() || null;
  }
  if (body.data.programTermsUrl !== undefined) {
    tenantPatch.programTermsUrl = body.data.programTermsUrl.trim() || null;
  }
  // Changing it re-labels nothing already stored: every Event, Commission
  // and Payout row carries its own currency.
  if (body.data.defaultCurrency !== undefined) tenantPatch.defaultCurrency = body.data.defaultCurrency;
  if (Object.keys(tenantPatch).length > 0) {
    tenantPatch.updatedAt = now;
    await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).update(tenantPatch);
  }
  // Re-hydrate so the returned shape matches GET (includes logoUrl + brand fields).
  res.json(await readSettings(db, tenantId));
});

// ---------- Mail settings ----------

const mailSettingsSchema = z.object({
  kind: z.enum(['smtp', 'postmark', 'none']),
  from: z.string().trim().max(254).optional().or(z.literal('')),
  smtp: z
    .object({
      host: z.string().trim().max(253).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      secure: z.boolean().optional(),
      user: z.string().trim().max(320).optional(),
      // Password / token are write-only from the client. Undefined =
      // "keep existing"; empty string = "clear"; set = rotate.
      password: z.string().max(500).optional(),
    })
    .optional(),
  postmark: z
    .object({
      serverToken: z.string().max(500).optional(),
      messageStream: z.string().trim().max(120).optional(),
    })
    .optional(),
});

settingsRouter.get('/config/mail', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await getPublicMailSettings(db, tenantId));
});

settingsRouter.post('/config/mail', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = mailSettingsSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  try {
    await saveMailSettings(db, tenantId, {
      kind: body.data.kind as MailTransportKind,
      from: body.data.from === '' ? null : body.data.from ?? undefined,
      smtp: body.data.smtp,
      postmark: body.data.postmark,
    });
  } catch (err) {
    if (err instanceof MailSettingsValidationError) {
      return res.status(400).json({ error: err.code, field: err.field });
    }
    throw err;
  }
  res.json(await getPublicMailSettings(db, tenantId));
});

/**
 * Send a test message through the SAVED mail settings so a typo'd SMTP
 * host/password surfaces here — not when a partner invite silently fails
 * days later. Defaults to the signed-in admin's inbox; API-key admins
 * (no inbox on file) pass an explicit `to`.
 */
const mailTestSchema = z.object({ to: z.string().trim().email().max(254).optional() });
settingsRouter.post('/config/mail/test', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = mailTestSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  let to = body.data.to ?? null;
  if (!to && req.principal?.role === 'admin' && req.principal.source === 'session') {
    const admin = await db<AdminRow>(TABLES.Admin).where({ id: req.principal.adminId }).first(['email']);
    to = (admin?.email as string | undefined) ?? null;
  }
  if (!to) {
    return res.status(400).json({
      error: 'recipient_required',
      detail: 'No inbox on file for this credential — pass { "to": "you@example.com" }.',
    });
  }

  const settings = await getPublicMailSettings(db, tenantId);
  const transport = settings.kind ?? 'env fallback';
  try {
    await getMailer().send(
      { db, tenantId },
      {
        to,
        subject: 'Test email from your partner portal',
        text: [
          'This is a test message confirming your email delivery settings work.',
          '',
          `Transport: ${transport}`,
          '',
          'Partner invites and sign-in links will be delivered the same way.',
        ].join('\n'),
        tag: 'mail_test',
        metadata: { purpose: 'mail_test' },
      },
    );
  } catch (err) {
    // Surface the transport error verbatim — "ECONNREFUSED", "535 auth
    // failed", etc. is exactly what the admin needs to fix their config.
    return res.status(502).json({
      error: 'mail_test_failed',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  res.json({ ok: true, to, transport });
});

// ---------- Partner signup policy ----------

const partnerSignupSchema = z.object({
  policy: z.enum(['auto_approve', 'require_review']).optional(),
  disabled: z.boolean().optional(),
});

settingsRouter.get('/config/partner-signup', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const row = await db<ConfigRow>(TABLES.Config)
    .where({ tenantId, key: 'partner_signup' })
    .first();
  const value = (row?.value ?? {}) as { policy?: string; disabled?: boolean };
  res.json({
    policy: value.policy === 'require_review' ? 'require_review' : 'auto_approve',
    disabled: value.disabled === true,
  });
});

settingsRouter.post('/config/partner-signup', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = partnerSignupSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const current = await db<ConfigRow>(TABLES.Config).where({ tenantId, key: 'partner_signup' }).first();
  const currentValue = (current?.value ?? {}) as { policy?: string; disabled?: boolean };
  const next = {
    policy: body.data.policy ?? currentValue.policy ?? 'auto_approve',
    disabled: body.data.disabled ?? currentValue.disabled ?? false,
  };
  const now = new Date();
  await db<ConfigRow>(TABLES.Config)
    .insert({ tenantId, key: 'partner_signup', value: next as unknown as never, updatedAt: now })
    .onConflict(['tenantId', 'key'])
    .merge({ value: next as unknown as never, updatedAt: now });
  res.json(next);
});

// ---------- Partner portal access ----------

/** The tenant default for partners added without an invite
 *  (partner-portal-access.ts). Omitted fields keep their value. */
export const partnerAccessSchema = z.object({
  uninvitedPortalAccess: z.boolean().optional(),
});

settingsRouter.get('/config/partner-access', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await readPartnerAccessSettings(db, tenantId));
});

settingsRouter.post('/config/partner-access', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = partnerAccessSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  res.json(await savePartnerAccessSettings(db, tenantId, body.data));
});

// ---------- Payout statements ----------

/** Text printed on statements: `''` or null clears it. */
const statementText = (max: number) => z.string().trim().max(max).nullable().optional();

/** What payout statements print (payout-statements.ts). Omitted fields
 *  keep their value. */
export const payoutStatementSettingsSchema = z.object({
  legalName: statementText(200),
  address: statementText(500),
  footer: statementText(2000),
  numberPrefix: z
    .string()
    .trim()
    .max(20)
    .regex(/^[A-Za-z0-9/_.#-]*$/, 'use letters, digits and / _ . # -')
    .nullable()
    .optional(),
  taxLines: z
    .object({
      enabled: z.boolean().optional(),
      labels: z.array(z.string().trim().min(1).max(60)).min(1).max(5).optional(),
    })
    .optional(),
});

settingsRouter.get('/config/payout-statements', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await readStatementSettings(db, tenantId));
});

settingsRouter.post('/config/payout-statements', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = payoutStatementSettingsSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  res.json(await saveStatementSettings(db, tenantId, body.data));
});

// ---------- Payout settings ----------

/**
 * Per-tenant payout configuration: rail preference, minimum threshold,
 * cadence. Stored as columns on Tenant (not in Config) because the payout
 * runner + scheduler read these on every tick; column access is one less
 * join than a Config lookup.
 *
 * All three are nullable in the schema with null = legacy behavior; the
 * API surfaces the resolved value so the UI never has to special-case null.
 */

interface PayoutSettings {
  rail: PayoutRailPreference;
  /** Hundredths of a unit of `thresholdCurrency`. */
  thresholdCents: number;
  /** The tenant's default currency. The minimum applies to balances in
   *  it; balances in other currencies pay out at any amount. */
  thresholdCurrency: string;
  cadence: PayoutCadence;
}

/** Hundredths: 10,000,000 units of the default currency (₹1 crore,
 *  Rp 10M). Matches the DB CHECK constraint. */
export const MAX_PAYOUT_THRESHOLD_CENTS = 1_000_000_000;

const payoutSettingsSchema = z.object({
  rail: z.enum(PAYOUT_RAIL_PREFERENCES as readonly [PayoutRailPreference, ...PayoutRailPreference[]]).optional(),
  // UI sends hundredths of the default currency to match the column unit.
  // The cap only catches a misplaced digit: it has to fit currencies with
  // large unit counts (₹5,000 is 500,000 hundredths), and it matches the
  // DB CHECK constraint.
  thresholdCents: z.number().int().min(0).max(MAX_PAYOUT_THRESHOLD_CENTS).optional(),
  cadence: z.enum(PAYOUT_CADENCES as readonly [PayoutCadence, ...PayoutCadence[]]).optional(),
});

async function readPayoutSettings(db: Knex, tenantId: string): Promise<PayoutSettings> {
  const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first();
  return {
    rail: tenant?.payoutRailPreference ?? 'auto',
    thresholdCents: tenant?.payoutThresholdCents ?? 0,
    thresholdCurrency: tenant?.defaultCurrency ?? 'USD',
    cadence: tenant?.payoutCadence ?? 'weekly',
  };
}

settingsRouter.get('/config/payouts', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await readPayoutSettings(db, tenantId));
});

settingsRouter.post('/config/payouts', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = payoutSettingsSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const patch: Partial<Pick<TenantRow, 'payoutRailPreference' | 'payoutThresholdCents' | 'payoutCadence'>> = {};
  if (body.data.rail !== undefined) patch.payoutRailPreference = body.data.rail;
  if (body.data.thresholdCents !== undefined) patch.payoutThresholdCents = body.data.thresholdCents;
  if (body.data.cadence !== undefined) patch.payoutCadence = body.data.cadence;
  if (Object.keys(patch).length > 0) {
    await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).update(patch);
  }
  res.json(await readPayoutSettings(db, tenantId));
});

// ---------- Network membership ----------

/** White-label tenants are isolated from the OpenPartner Network. When one
 *  hits a federation-enabling route, send a 409 and return true so the
 *  handler bails. Data-plane pushes (dispatch/sendHeartbeat in
 *  network-client) are independently suppressed as defense in depth. */
async function blockNetworkForWhiteLabel(
  db: Knex,
  tenantId: string,
  res: import('express').Response,
): Promise<boolean> {
  if ((await getWhiteLabelState(db, tenantId)).effective) {
    res.status(409).json({
      error: 'white_label_network_conflict',
      detail: 'White-label tenants are isolated from the OpenPartner Network. Disable white-label before joining the Network.',
    });
    return true;
  }
  return false;
}

/** Same test as the onboarding status's `networkConnected`. */
function isConnected(m: { enabled: boolean; vendorTokenCiphertext: string } | null): boolean {
  return !!(m?.enabled && m.vendorTokenCiphertext);
}

export const networkMembershipSchema = z.object({
  enabled: z.boolean().optional(),
  networkUrl: z.string().url().optional().or(z.literal('')),
  /** Plaintext bearer issued by the Network on /vendors/register. Undefined keeps existing. */
  vendorToken: z.string().max(500).optional(),
  /** ApiKey.id of the scoped key the Network should call back with. */
  scopedKeyId: z.string().nullable().optional(),
  autoEnroll: z.boolean().optional(),
});

settingsRouter.get('/config/network', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await getPublicNetworkMembership(db, tenantId));
});

settingsRouter.post('/config/network', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = networkMembershipSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  if (body.data.enabled === true && (await blockNetworkForWhiteLabel(db, tenantId, res))) return;
  const wasConnected = isConnected(await getNetworkMembership(db, tenantId));
  await saveNetworkMembership(db, tenantId, {
    enabled: body.data.enabled,
    networkUrl: body.data.networkUrl === '' ? '' : body.data.networkUrl,
    vendorToken: body.data.vendorToken,
    scopedKeyId: body.data.scopedKeyId,
    autoEnroll: body.data.autoEnroll,
  });
  // Only an actual join counts. Toggling autoEnroll ("Offer the Network
  // to your partners") on a brand that skipped the listing leaves the skip.
  if (!wasConnected && isConnected(await getNetworkMembership(db, tenantId))) {
    await clearNetworkListingSkip(db, tenantId);
  }
  res.json(await getPublicNetworkMembership(db, tenantId));
});

/**
 * Re-sync opted-in partners with the Network ("Backfill" in older UIs).
 *
 * Pushes every partner with Network consent through /partners/upsert —
 * and nobody else: partners decide for themselves (network-consent.ts),
 * so this no longer sends the whole roster. The Network dedups on email,
 * so a creator already on the Network from another vendor returns the
 * existing networkCreatorId and is stamped preExisting=true.
 *
 * 409 network_not_offered while the brand doesn't offer the Network to
 * its partners: nothing would be allowed through.
 *
 * Synchronous (returns counts when done). Network-side failures land in
 * the outbox for the scheduler to retry.
 */
settingsRouter.post('/config/network/backfill', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  if (!(await isNetworkOfferedToPartners(db, tenantId))) {
    return res.status(409).json({
      error: 'network_not_offered',
      detail: 'Turn on "Offer the Network to your partners" first. Only partners who opt in are synced.',
    });
  }
  res.json(await resyncConsentedPartners(db, tenantId));
});

/**
 * Let the Network pay bonuses: add `bonuses:write` to the brand's existing
 * federation key (keys issued before Network bounties lack it). The admin
 * portal's Network page offers it as "Re-authorize to enable Network
 * bounties". An unscoped key can't use it: only a full admin decides what
 * the Network may do.
 */
settingsRouter.post('/config/network/authorize-bonuses', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  if (!(await grantFederationScope(db, tenantId, NETWORK_BONUS_SCOPE))) {
    return res.status(409).json({
      error: 'network_not_connected',
      detail: 'Connect to the OpenPartner Network first: there is no federation key to authorize.',
    });
  }
  res.json(await getPublicNetworkMembership(db, tenantId));
});

/** How many partners have opted in / out — for the admin Network page. */
settingsRouter.get('/config/network/partner-consent', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await summarizeNetworkConsent(db, tenantId));
});

// ---------- Network connect (self-serve onboarding) ----------

const startConnectSchema = z.object({
  /** Where the magic-link should send the admin back to. Defaults to
   *  the request's origin + tenant path + /admin/network/complete. */
  portalCallbackUrl: z.string().url().optional(),
  /** Email to receive the confirmation link. Defaults to the calling
   *  admin's email if a session-derived admin is calling; required for
   *  env-bearer admins. */
  contactEmail: z.string().email().optional(),
  contactName: z.string().max(120).optional(),
  /** Display name shown to creators. Defaults to tenantId on multi
   *  hosted; on self-host the admin should pass their brand. */
  displayName: z.string().min(1).max(120).optional(),
  /** Where the Network can reach this instance's API. Defaults to
   *  inferring from the request hostname + /api. */
  instanceUrl: z.string().url().optional(),
});

settingsRouter.post('/config/network/start-connect', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId, tenantSlug } = (() => {
    const t = tenantOf(req);
    return { ...t, tenantSlug: req.tenantSlug ?? null };
  })();
  const body = startConnectSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  if (await blockNetworkForWhiteLabel(db, tenantId, res)) return;
  const networkUrl = process.env.NETWORK_URL;
  if (!networkUrl) {
    return res.status(503).json({ error: 'network_url_not_configured', detail: 'set NETWORK_URL env to your network endpoint, e.g. https://network.openpartner.dev' });
  }

  // Resolve defaults from the request + tenant context.
  const protoHost = `${req.protocol}://${req.get('host') ?? ''}`;
  const tenantPath = tenantSlug ? `/t/${tenantSlug}` : '';
  // /api goes BEFORE /t/<slug> so the DO App Platform ingress
  // (/api → api component) actually routes to us. The tenant middleware
  // accepts both /t/<slug>/* and /api/t/<slug>/* in its regex, so the
  // api still resolves the tenant correctly.
  const inferredInstanceUrl = `${protoHost}${tenantSlug ? `/api/t/${tenantSlug}` : '/api'}`;
  const inferredCallback = `${protoHost}${tenantPath}/admin/network/complete`;

  // Mint a fresh scoped key with the federation scope set; store the
  // ApiKey id in network_membership so we can identify which key the
  // Network is using and rotate it later via /vendors/me/rotate-callback-key.
  const scoped = await createApiKeyRow(db, {
    tenantId,
    scopes: [...NETWORK_FEDERATION_SCOPES],
    label: 'network_federation',
  });

  let signup;
  try {
    signup = await signupWithNetwork({
      networkUrl,
      instanceUrl: body.data.instanceUrl ?? inferredInstanceUrl,
      scopedKey: scoped.plaintext,
      displayName: body.data.displayName ?? (tenantSlug ? tenantSlug : 'OpenPartner instance'),
      contactEmail: body.data.contactEmail ?? '',
      contactName: body.data.contactName,
      tier: process.env.OPENPARTNER_TENANCY === 'multi' ? 'hosted' : 'self_hosted',
      portalCallbackUrl: body.data.portalCallbackUrl ?? inferredCallback,
    });
  } catch (err) {
    return res.status(502).json({ error: 'network_signup_failed', detail: err instanceof Error ? err.message : String(err) });
  }

  // Stash the partial state — networkUrl + scopedKeyId + autoEnroll
  // default true (offer the Network to partners; each still opts in).
  // The vendorToken comes back from completeConnect.
  await saveNetworkMembership(db, tenantId, {
    enabled: false, // not active until verify lands
    networkUrl,
    scopedKeyId: scoped.id,
    autoEnroll: true,
  });

  // This is the manual "Connect to Network" button on the Settings page —
  // never uses adminAuthToken, so the result is always the email-verify
  // pending shape.
  const emailSent = signup.status === 'pending' ? signup.emailSent : true;
  res.status(202).json({ vendorId: signup.vendorId, status: 'pending', emailSent });
});

// One-click enroll for tenants that pre-date the auto-enroll-on-signup
// flow. Uses NETWORK_ADMIN_API_KEY to skip the email-verify round trip
// — the brand admin is already signed in here, no point re-confirming.
// Self-host deployments without NETWORK_ADMIN_API_KEY still use the
// /start-connect email-verify path.
settingsRouter.post('/config/network/auto-enroll', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId, tenantSlug } = (() => {
    const t = tenantOf(req);
    return { ...t, tenantSlug: req.tenantSlug ?? null };
  })();

  if (await blockNetworkForWhiteLabel(db, tenantId, res)) return;
  const networkUrl = process.env.NETWORK_URL;
  const adminToken = process.env.NETWORK_ADMIN_API_KEY;
  if (!networkUrl) return res.status(503).json({ error: 'network_url_not_configured' });
  if (!adminToken) return res.status(503).json({ error: 'admin_token_not_configured', detail: 'NETWORK_ADMIN_API_KEY required for auto-enroll' });

  const tenantRow = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first();
  if (!tenantRow) return res.status(404).json({ error: 'tenant_not_found' });

  // Need a session-derived admin so we have a real Admin row + email.
  // Env-bearer / scoped-key admins lack that, so they should use the
  // manual /start-connect flow which takes contactEmail explicitly.
  const principal = req.principal;
  const adminId = principal?.role === 'admin' && principal.source === 'session' ? principal.adminId : null;
  if (!adminId) return res.status(400).json({ error: 'session_admin_required', detail: 'Auto-enroll needs a logged-in admin; env/scoped admins should use start-connect with contactEmail.' });
  const adminRow = await db<AdminRow>(TABLES.Admin).where({ id: adminId }).first();
  const adminEmail = adminRow?.email;
  if (!adminEmail) return res.status(400).json({ error: 'admin_email_unresolvable' });

  const protoHost = `${req.protocol}://${req.get('host') ?? ''}`;
  const tenantPath = tenantSlug ? `/t/${tenantSlug}` : '';
  // /api goes BEFORE /t/<slug> so the DO App Platform ingress
  // (/api → api component) actually routes to us. The tenant middleware
  // accepts both /t/<slug>/* and /api/t/<slug>/* in its regex, so the
  // api still resolves the tenant correctly.
  const inferredInstanceUrl = `${protoHost}${tenantSlug ? `/api/t/${tenantSlug}` : '/api'}`;
  const inferredCallback = `${protoHost}${tenantPath}/admin/network/complete`;

  const scoped = await createApiKeyRow(db, {
    tenantId,
    scopes: [...NETWORK_FEDERATION_SCOPES],
    label: 'network_federation',
  });

  let signup;
  try {
    signup = await signupWithNetwork({
      networkUrl,
      instanceUrl: inferredInstanceUrl,
      scopedKey: scoped.plaintext,
      displayName: tenantRow.displayName,
      contactEmail: adminEmail,
      tier: 'hosted',
      portalCallbackUrl: inferredCallback,
      adminAuthToken: adminToken,
      reviewStatus: tenantRow.approvalStatus,
    });
  } catch (err) {
    return res.status(502).json({ error: 'network_signup_failed', detail: err instanceof Error ? err.message : String(err) });
  }

  if (signup.status !== 'active') {
    // Network refused the admin auth — fall back state. Shouldn't happen
    // in practice but surface clearly so the operator knows the env is wrong.
    return res.status(502).json({ error: 'admin_path_rejected', detail: 'Network signup did not return active; check NETWORK_ADMIN_API_KEY' });
  }

  await saveNetworkMembership(db, tenantId, {
    enabled: true,
    networkUrl,
    vendorToken: signup.vendorToken,
    scopedKeyId: scoped.id,
    autoEnroll: true,
    vendorId: signup.vendorId,
  });
  // Joining brings the listing back if the brand had said "Not now".
  await clearNetworkListingSkip(db, tenantId);

  res.json({ ok: true, vendorId: signup.vendorId });
});

const completeConnectSchema = z.object({ ntoken: z.string().min(20) });

settingsRouter.post('/config/network/complete-connect', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = completeConnectSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  if (await blockNetworkForWhiteLabel(db, tenantId, res)) return;
  const networkUrl = process.env.NETWORK_URL;
  if (!networkUrl) return res.status(503).json({ error: 'network_url_not_configured' });

  let result;
  try {
    result = await completeNetworkConnect(networkUrl, body.data.ntoken);
  } catch (err) {
    return res.status(502).json({ error: 'network_verify_failed', detail: err instanceof Error ? err.message : String(err) });
  }

  // Stamp networkUrl + vendorId explicitly on every complete-connect.
  // Without it, brands that hit the email-verify path *before* any
  // /start-connect call (e.g. auto-enroll fell back, then they
  // verified directly) ended up with networkUrl='' on their membership
  // row — and every subsequent proxy call 503'd with
  // network_not_configured.
  await saveNetworkMembership(db, tenantId, {
    enabled: true,
    networkUrl,
    vendorToken: result.vendorToken,
    vendorId: result.vendorId,
  });
  await clearNetworkListingSkip(db, tenantId);

  res.json({ ok: true, vendorId: result.vendorId, displayName: result.displayName });
});

// ---------- Network proxy: offerings + partnership requests ----------
// Admin manages their Network presence through these. Backend is the
// only thing that can hold the vendorToken (encrypted in network_membership
// Config), so the portal calls these routes which proxy to the Network.

import type { Request, Response } from 'express';

async function proxy(req: Request, res: Response, fn: (db: Knex, tenantId: string) => Promise<unknown>, successStatus = 200): Promise<void> {
  const { db, tenantId } = tenantOf(req);
  try {
    const out = await fn(db, tenantId);
    res.status(successStatus).json(out);
  } catch (err) {
    if (err instanceof NetworkProxyError) {
      res.status(err.status).json({ error: 'network_call_failed', detail: err.message });
      return;
    }
    throw err;
  }
}

settingsRouter.get('/admin/network/me', requireAuth, requireAdmin, async (req, res) =>
  proxy(req, res, async (db, tenantId) => {
    // Fire a heartbeat opportunistically so a brand admin who just
    // updated their logo / added a partner / etc. doesn't have to wait
    // until the next :07 cron. Fire-and-forget — don't block the page
    // load on a Network blip.
    sendHeartbeat(db, tenantId).catch((err) => {
      console.error('[admin/network/me] opportunistic heartbeat failed', err);
    });
    // Override the Network's stored partnerCount with the local truth.
    // Network's value updates via the hourly heartbeat job — between
    // ticks (or before the first tick after connecting) it lags reality.
    // The brand admin expects "active partners" to match the count they
    // see on /admin/partners, so reconcile here.
    const remote = await networkProxy.whoami(db, tenantId);
    const partnerRows = await db(TABLES.Partner)
      .where({ tenantId })
      .whereNull('revokedAt')
      .count<Array<{ count: string }>>({ count: '*' });
    const partnerCount = Number(partnerRows[0]?.count ?? 0);
    return { ...(remote as Record<string, unknown>), partnerCount };
  }),
);

// Diagnostic / on-demand fire. Returns the heartbeat result inline so
// the admin page can show "sent" or the failure reason — useful for
// debugging silent propagation failures (Network rejected the URL,
// migration not run, vendor token bad, etc.) without waiting for the
// hourly cron to run + log somewhere the admin can't reach.
settingsRouter.post('/admin/network/heartbeat', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const result = await sendHeartbeat(db, tenantId);
  res.json(result);
});

settingsRouter.get('/admin/network/offerings', requireAuth, requireAdmin, async (req, res) =>
  proxy(req, res, (db, tenantId) => networkProxy.listOfferings(db, tenantId)),
);

settingsRouter.post('/admin/network/offerings', requireAuth, requireAdmin, async (req, res) =>
  proxy(req, res, (db, tenantId) => networkProxy.createOffering(db, tenantId, req.body), 201),
);

settingsRouter.patch('/admin/network/offerings/:id', requireAuth, requireAdmin, async (req, res) =>
  proxy(req, res, (db, tenantId) => networkProxy.updateOffering(db, tenantId, req.params.id!, req.body)),
);

settingsRouter.delete('/admin/network/offerings/:id', requireAuth, requireAdmin, async (req, res) =>
  proxy(req, res, (db, tenantId) => networkProxy.deleteOffering(db, tenantId, req.params.id!)),
);

settingsRouter.get('/admin/network/requests', requireAuth, requireAdmin, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  return proxy(req, res, (db, tenantId) => networkProxy.listRequests(db, tenantId, status));
});

settingsRouter.post('/admin/network/requests/:id/approve', requireAuth, requireAdmin, async (req, res) =>
  proxy(req, res, (db, tenantId) => networkProxy.approveRequest(db, tenantId, req.params.id!, req.body ?? {})),
);

settingsRouter.post('/admin/network/requests/:id/reject', requireAuth, requireAdmin, async (req, res) =>
  proxy(req, res, (db, tenantId) => networkProxy.rejectRequest(db, tenantId, req.params.id!, req.body ?? {})),
);

// Brand-side creator discovery — vendor-authenticated proxy passes the
// browser's querystring straight through to Network's directory endpoint.
settingsRouter.get('/admin/network/discover/creators', requireAuth, requireAdmin, async (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
  return proxy(req, res, (db, tenantId) => networkProxy.discoverCreators(db, tenantId, qs));
});

// Brand admin invites a discovered creator to apply to an offering.
// Body is forwarded verbatim — Network validates the creatorId + offering
// ownership.
settingsRouter.post('/admin/network/offerings/:id/invite-creator', requireAuth, requireAdmin, async (req, res) =>
  proxy(req, res, (db, tenantId) => networkProxy.inviteCreator(db, tenantId, req.params.id!, req.body ?? {}), 201),
);

// Storefront bookings and conversations (openpartner-network
// docs/creator-storefront.md §8). The brand talks to creators in the app,
// books a package, pays upfront through Checkout on the creator's own Stripe
// account once they agree a price, and approves the delivered work. Every
// call that writes carries who at the brand is acting (the creator sees the
// name; the email is where the brand's notifications go) and the booking fee
// rate of the brand's plan (booking-fee.ts). The Network validates the rest.

/** The signed-in admin, for the Network's authorName/authorEmail. An API
 *  key has no person behind it, so it sends neither. */
async function actingAdmin(req: Request): Promise<{ authorName?: string; authorEmail?: string }> {
  const principal = req.principal;
  if (principal?.role !== 'admin' || principal.source !== 'session') return {};
  const { db, tenantId } = tenantOf(req);
  const admin = (await db(TABLES.Admin).where({ id: principal.adminId, tenantId }).first(['name', 'email'])) as
    | { name: string | null; email: string }
    | undefined;
  if (!admin) return {};
  return { ...(admin.name ? { authorName: admin.name.slice(0, 120) } : {}), authorEmail: admin.email };
}

async function feeRate(db: Knex, tenantId: string): Promise<{ bookingFeeBps?: number }> {
  const bps = await bookingFeeBpsFor(db, tenantId);
  return bps == null ? {} : { bookingFeeBps: bps };
}

function bodyOf(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
}

settingsRouter.get('/admin/network/bookings', requireAuth, requireAdmin, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  return proxy(req, res, (db, tenantId) => networkProxy.listBookings(db, tenantId, status));
});

settingsRouter.post('/admin/network/bookings', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  // A booking on one of the brand's offerings makes the creator its
  // partner when they accept, and adding partners needs an active plan
  // (trial-gate.ts). Refuse it here, not on the creator's accept.
  if (bodyOf(req).offeringId && !hasActivePlan(await getTenantBillingState(db, tenantId))) {
    return res.status(402).json({ error: 'plan_required', detail: 'Tracking a booking adds the creator as a partner, which needs an active plan.' });
  }
  return proxy(
    req,
    res,
    async (db, tenantId) =>
      networkProxy.createBooking(db, tenantId, { ...bodyOf(req), ...(await actingAdmin(req)), ...(await feeRate(db, tenantId)) }),
    201,
  );
});

settingsRouter.post('/admin/network/bookings/claim', requireAuth, requireAdmin, async (req, res) =>
  proxy(
    req,
    res,
    async (db, tenantId) =>
      networkProxy.claimBooking(db, tenantId, { token: bodyOf(req).token, ...(await actingAdmin(req)), ...(await feeRate(db, tenantId)) }),
    201,
  ),
);

settingsRouter.post('/admin/network/bookings/:id/checkout', requireAuth, requireAdmin, async (req, res) =>
  proxy(req, res, async (db, tenantId) => {
    const rate = await bookingFeeBpsFor(db, tenantId);
    return networkProxy.bookingAction(db, tenantId, req.params.id!, 'checkout', {
      returnPath: typeof bodyOf(req).returnPath === 'string' ? bodyOf(req).returnPath : undefined,
      ...(rate == null ? {} : { feeRateBps: rate }),
    });
  }),
);

for (const action of ['cancel', 'approve', 'recheck', 'sync'] as const) {
  settingsRouter.post(`/admin/network/bookings/:id/${action}`, requireAuth, requireAdmin, async (req, res) =>
    proxy(req, res, (db, tenantId) => networkProxy.bookingAction(db, tenantId, req.params.id!, action)),
  );
}

settingsRouter.post('/admin/network/bookings/:id/track', requireAuth, requireAdmin, async (req, res) =>
  proxy(req, res, (db, tenantId) => networkProxy.bookingAction(db, tenantId, req.params.id!, 'track', { offeringId: bodyOf(req).offeringId })),
);

settingsRouter.get('/admin/network/conversations', requireAuth, requireAdmin, async (req, res) =>
  proxy(req, res, (db, tenantId) => networkProxy.listConversations(db, tenantId)),
);

settingsRouter.post('/admin/network/conversations', requireAuth, requireAdmin, async (req, res) =>
  proxy(
    req,
    res,
    async (db, tenantId) =>
      networkProxy.startConversation(db, tenantId, {
        creatorId: bodyOf(req).creatorId,
        body: bodyOf(req).body,
        ...(await actingAdmin(req)),
      }),
    201,
  ),
);

settingsRouter.get('/admin/network/conversations/:id', requireAuth, requireAdmin, async (req, res) => {
  const before = typeof req.query.before === 'string' ? req.query.before : undefined;
  return proxy(req, res, (db, tenantId) => networkProxy.getConversation(db, tenantId, req.params.id!, before));
});

settingsRouter.post('/admin/network/conversations/:id/messages', requireAuth, requireAdmin, async (req, res) =>
  proxy(
    req,
    res,
    async (db, tenantId) =>
      networkProxy.postConversationMessage(db, tenantId, req.params.id!, { body: bodyOf(req).body, ...(await actingAdmin(req)) }),
    201,
  ),
);

// ---------- Network billing proxy ----------
// Self-hosted vendors subscribe to Network access ($29/mo + 3% metered)
// from this admin surface. Hosted vendors get bundled with their main
// Flex/Revshare subscription — the Network endpoint handles that gate
// and we just pass the response through.

settingsRouter.get('/admin/network/billing', requireAuth, requireAdmin, async (req, res) =>
  proxy(req, res, (db, tenantId) => networkProxy.getBilling(db, tenantId)),
);

settingsRouter.post('/admin/network/billing/checkout', requireAuth, requireAdmin, async (req, res) => {
  const body = z.object({
    successUrl: z.string().url(),
    cancelUrl: z.string().url(),
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  return proxy(req, res, (db, tenantId) => networkProxy.createCheckout(db, tenantId, body.data));
});

settingsRouter.post('/admin/network/billing/portal', requireAuth, requireAdmin, async (req, res) => {
  const body = z.object({ returnUrl: z.string().url() }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  return proxy(req, res, (db, tenantId) => networkProxy.openPortal(db, tenantId, body.data));
});
