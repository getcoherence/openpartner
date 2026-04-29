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
import { z } from 'zod';
import { TABLES, type AdminRow, type ConfigRow, type TenantRow } from '@openpartner/db';
import { requireAdmin, requireAuth } from '../auth.js';
import {
  MailSettingsValidationError,
  getPublicMailSettings,
  saveMailSettings,
  type MailTransportKind,
} from '../mail-settings.js';
import {
  backfillPartners,
  completeNetworkConnect,
  getPublicNetworkMembership,
  NetworkProxyError,
  networkProxy,
  saveNetworkMembership,
  signupWithNetwork,
} from '../network-client.js';
import { createApiKeyRow } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { NETWORK_FEDERATION_SCOPES } from './api-keys.js';

export const settingsRouter = Router();

const CONFIG_KEY = 'program_settings';

const settingsSchema = z.object({
  programName: z.string().trim().max(120).optional(),
  supportEmail: z.string().trim().email().max(254).optional().or(z.literal('')),
});

export interface ProgramSettings {
  programName: string | null;
  supportEmail: string | null;
}

async function readSettings(db: Knex, tenantId: string): Promise<ProgramSettings> {
  const row = await db<ConfigRow>(TABLES.Config).where({ tenantId, key: CONFIG_KEY }).first();
  const value = (row?.value ?? {}) as Partial<ProgramSettings>;
  // Fall back to Tenant.displayName so brand admins don't have to re-type
  // the brand name they set at signup. Saving this page promotes the
  // value into program_settings; until then we just surface the signup
  // value so the UI is pre-populated and the onboarding checklist
  // doesn't keep nagging about a thing that's effectively already set.
  let programName = value.programName ?? null;
  if (!programName) {
    const tenant = await db('Tenant').where({ id: tenantId }).first(['displayName']);
    if (tenant?.displayName) programName = tenant.displayName as string;
  }
  return {
    programName,
    supportEmail: value.supportEmail ?? null,
  };
}

/** Any authenticated caller (admin OR partner) can read — not secret. */
settingsRouter.get('/config/program', requireAuth, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await readSettings(db, tenantId));
});

/** Only admins write. Empty strings clear fields. */
settingsRouter.post('/config/program', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = settingsSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const next: ProgramSettings = {
    programName: body.data.programName?.trim() || null,
    supportEmail: body.data.supportEmail?.trim() || null,
  };
  const now = new Date();
  // Upsert: preserves updatedAt semantics without a separate read.
  await db<ConfigRow>(TABLES.Config)
    .insert({ tenantId, key: CONFIG_KEY, value: next as unknown as never, updatedAt: now })
    .onConflict(['tenantId', 'key'])
    .merge({ value: next as unknown as never, updatedAt: now });
  res.json(next);
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

// ---------- Network membership ----------

const networkMembershipSchema = z.object({
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

  await saveNetworkMembership(db, tenantId, {
    enabled: body.data.enabled,
    networkUrl: body.data.networkUrl === '' ? '' : body.data.networkUrl,
    vendorToken: body.data.vendorToken,
    scopedKeyId: body.data.scopedKeyId,
    autoEnroll: body.data.autoEnroll,
  });
  res.json(await getPublicNetworkMembership(db, tenantId));
});

/**
 * Reconcile existing partners with the Network. Called when an admin
 * enables Network membership after already having a partner roster.
 *
 * Pushes every Partner row through /partners/upsert. The Network dedups
 * on email — so a creator who's already on the Network from another
 * vendor returns the existing networkCreatorId, and we stamp
 * Partner.metadata.network.preExisting=true so the admin sees who was
 * already known.
 *
 * Synchronous (returns counts when done). For very large rosters the
 * outbox + scheduler-drained retries handle Network-side timeouts so a
 * single backfill failure doesn't lose the work.
 */
settingsRouter.post('/config/network/backfill', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const partners = await db('Partner')
    .select<Array<{ id: string; email: string; name: string; createdAt: Date; activatedAt: Date | null; revokedAt: Date | null }>>(
      'id',
      'email',
      'name',
      'createdAt',
      'activatedAt',
      'revokedAt',
    );
  const result = await backfillPartners(db, tenantId, partners);
  res.json(result);
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
  // default true. The vendorToken comes back from completeConnect.
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

  res.json({ ok: true, vendorId: signup.vendorId });
});

const completeConnectSchema = z.object({ ntoken: z.string().min(20) });

settingsRouter.post('/config/network/complete-connect', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = completeConnectSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

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
  proxy(req, res, (db, tenantId) => networkProxy.whoami(db, tenantId)),
);

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
