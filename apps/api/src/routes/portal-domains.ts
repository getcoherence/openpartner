/**
 * White-label custom-domain endpoints (spec §4.1, §4.2).
 *
 * Two routers with very different trust models:
 *
 *   portalDomainGateRouter  — PUBLIC, unauthenticated, mounted BEFORE
 *     tenantMiddleware. `GET /portal-domain-allowed?domain=` is the
 *     server-to-server `ask` gate the Phase-3 Caddy droplet calls before
 *     minting a cert. 200 iff verified + fresh + white-label entitled.
 *     Runs on the privileged pool (cross-tenant domain → tenant lookup).
 *
 *   portalDomainsRouter — tenant-scoped admin CRUD under /config/domain.
 *     Runs on req.db (RLS), so a tenant physically cannot touch another
 *     tenant's rows. Every endpoint requires the EFFECTIVE white-label
 *     entitlement (§4.2 — a non-paying tenant cannot register, verify, or
 *     hold a domain: closes squatting).
 */

import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import { TABLES, type PortalCustomDomainRow, type TenantRow } from '@openpartner/db';
import { db } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { getWhiteLabelState } from '../white-label.js';
import { invalidateCustomDomainOrigins } from '../cors-origins.js';
import {
  checkDomainTxt,
  domainRegistrationError,
  expectedTxtValue,
  isDomainAllowed,
  newVerificationToken,
  txtRecordName,
} from '../portal-domains.js';

// ---------------------------------------------------------------------------
// Public allow-gate
// ---------------------------------------------------------------------------

export const portalDomainGateRouter = Router();

const gateLimit = ipRateLimit({ name: 'portal-domain-allowed', max: 120, windowMs: 60_000 });

portalDomainGateRouter.get('/portal-domain-allowed', gateLimit, async (req, res) => {
  const domain = String(req.query.domain ?? '')
    .toLowerCase()
    .trim();
  if (!domain) return res.status(400).type('text/plain').send('domain required');
  const { allowed, reason } = await isDomainAllowed(db, domain);
  // Caddy's on_demand_tls `ask` treats any non-2xx as "do not issue".
  if (!allowed) return res.status(404).type('text/plain').send(reason);
  res.status(200).type('text/plain').send('ok');
});

// ---------------------------------------------------------------------------
// Tenant-scoped admin endpoints
// ---------------------------------------------------------------------------

export const portalDomainsRouter = Router();

const registerSchema = z.object({
  domain: z.string().trim().toLowerCase().min(1).max(253),
  // MVP registrations are DO-native; the Phase-3 self-serve droplet flow
  // passes 'droplet' to get the on-demand-TLS CNAME target instead.
  edgeKind: z.enum(['do_native', 'droplet']).default('do_native'),
});

/** What the customer must put in DNS. The CNAME target depends on the
 *  edge: DO-native domains alias the App Platform app; droplet domains
 *  point at the dedicated white-label edge. The TXT is OpenPartner's OWN
 *  ongoing ownership proof (independent of DO's cert validation) and must
 *  REMAIN in place permanently — removal demotes the domain (§7.6). */
function dnsInstructions(row: Pick<PortalCustomDomainRow, 'domain' | 'verificationToken' | 'edgeKind'>) {
  const cnameTarget =
    row.edgeKind === 'droplet'
      ? (process.env.WHITELABEL_DROPLET_HOST ?? 'portal-router.openpartner.dev')
      : (process.env.DO_APP_DOMAIN_ALIAS ?? '<your-app>.ondigitalocean.app');
  return {
    cname: { name: row.domain, target: cnameTarget },
    txt: { name: txtRecordName(row.domain), value: expectedTxtValue(row.verificationToken) },
    note: 'The TXT record is your ongoing ownership proof and must remain in place permanently — removing it will disable the domain.',
  };
}

function publicRow(row: PortalCustomDomainRow) {
  return {
    id: row.id,
    domain: row.domain,
    status: row.status,
    edgeKind: row.edgeKind,
    verifiedAt: row.verifiedAt,
    lastCheckedAt: row.lastCheckedAt,
    createdAt: row.createdAt,
    dnsInstructions: dnsInstructions(row),
  };
}

/** 402 unless the tenant's EFFECTIVE white-label entitlement is live. */
async function requireEntitled(req: Parameters<typeof tenantOf>[0]): Promise<string | null> {
  const { db: tdb, tenantId } = tenantOf(req);
  const state = await getWhiteLabelState(tdb, tenantId);
  if (!state.effective) return 'white_label_not_entitled';
  return null;
}

portalDomainsRouter.get('/config/domain', requireAuth, requireAdmin, async (req, res) => {
  const { db: tdb } = tenantOf(req);
  const rows = await tdb<PortalCustomDomainRow>(TABLES.PortalCustomDomain).orderBy(
    'createdAt',
    'desc',
  );
  res.json({ domains: rows.map(publicRow) });
});

portalDomainsRouter.post('/config/domain', requireAuth, requireAdmin, async (req, res) => {
  const { db: tdb, tenantId } = tenantOf(req);
  const denied = await requireEntitled(req);
  if (denied) return res.status(402).json({ error: denied });

  const body = registerSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const { domain, edgeKind } = body.data;

  const invalid = domainRegistrationError(domain);
  if (invalid) return res.status(400).json({ error: invalid });

  // Global-uniqueness pre-check on the privileged pool (RLS hides other
  // tenants' rows from req.db). The unique constraint still backstops the
  // check-then-insert race — a concurrent duplicate surfaces as 23505.
  const taken = await db<PortalCustomDomainRow>(TABLES.PortalCustomDomain)
    .where({ domain })
    .first(['id', 'tenantId']);
  if (taken && taken.tenantId !== tenantId) return res.status(409).json({ error: 'domain_taken' });
  if (taken) {
    const existing = await tdb<PortalCustomDomainRow>(TABLES.PortalCustomDomain)
      .where({ id: taken.id })
      .first();
    return res.status(409).json({ error: 'domain_already_registered', domain: existing ? publicRow(existing) : undefined });
  }

  const now = new Date();
  let row: PortalCustomDomainRow;
  try {
    const [inserted] = await tdb<PortalCustomDomainRow>(TABLES.PortalCustomDomain)
      .insert({
        id: ulid(),
        tenantId,
        domain,
        verificationToken: newVerificationToken(),
        status: 'pending',
        edgeKind,
        createdAt: now,
        updatedAt: now,
      })
      .returning('*');
    row = inserted as PortalCustomDomainRow;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'domain_taken' });
    }
    throw err;
  }
  res.status(201).json(publicRow(row));
});

portalDomainsRouter.post('/config/domain/:id/verify', requireAuth, requireAdmin, async (req, res) => {
  const { db: tdb, tenantId } = tenantOf(req);
  const denied = await requireEntitled(req);
  if (denied) return res.status(402).json({ error: denied });

  const row = await tdb<PortalCustomDomainRow>(TABLES.PortalCustomDomain)
    .where({ id: req.params.id })
    .first();
  if (!row) return res.status(404).json({ error: 'not_found' });

  // ALWAYS re-check DNS — no {already:true} short-circuit. A verified row
  // that re-verifies just freshens lastCheckedAt; one that fails demotes.
  const now = new Date();
  const ok = await checkDomainTxt(row.domain, row.verificationToken);
  if (!ok) {
    // Rotate the token on failure so a stale value can't be replayed later.
    const [updated] = await tdb<PortalCustomDomainRow>(TABLES.PortalCustomDomain)
      .where({ id: row.id })
      .update({
        status: 'failed',
        verificationToken: newVerificationToken(),
        lastCheckedAt: now,
        updatedAt: now,
      })
      .returning('*');
    return res
      .status(422)
      .json({ error: 'verification_failed', domain: publicRow(updated as PortalCustomDomainRow) });
  }

  const [updated] = await tdb<PortalCustomDomainRow>(TABLES.PortalCustomDomain)
    .where({ id: row.id })
    .update({ status: 'verified', verifiedAt: now, lastCheckedAt: now, updatedAt: now })
    .returning('*');
  // First verified domain becomes the tenant's primary (the host-resolution
  // hot path reads Tenant.customDomain).
  const tenant = await tdb<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first(['customDomain']);
  if (!tenant?.customDomain) {
    await tdb<TenantRow>(TABLES.Tenant)
      .where({ id: tenantId })
      .update({ customDomain: row.domain, updatedAt: now });
  }
  invalidateCustomDomainOrigins();
  res.json(publicRow(updated as PortalCustomDomainRow));
});

portalDomainsRouter.delete('/config/domain/:id', requireAuth, requireAdmin, async (req, res) => {
  const { db: tdb, tenantId } = tenantOf(req);
  const row = await tdb<PortalCustomDomainRow>(TABLES.PortalCustomDomain)
    .where({ id: req.params.id })
    .first();
  if (!row) return res.status(404).json({ error: 'not_found' });
  await tdb<PortalCustomDomainRow>(TABLES.PortalCustomDomain).where({ id: row.id }).del();
  // If this was the primary, stop resolving it.
  await tdb<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId, customDomain: row.domain })
    .update({ customDomain: null, updatedAt: new Date() });
  invalidateCustomDomainOrigins();
  res.json({ ok: true });
});
