/**
 * Brand-initiated partner sign-in: the brand's backend signs one of its
 * users in to the partner portal, so a customer who is already logged in to
 * the brand's app never meets a second login.
 *
 *   POST /partners/:id/signin-link   by partner id
 *   POST /partners/signin-link       by email, or by one metadata value the
 *                                    brand stored on the partner (the
 *                                    in-app example's `appUserId`)
 *
 * Both answer a short-lived, single-use URL for the brand to redirect the
 * browser to. It's the URL the sign-in email would have carried: the token
 * is issueMagicLink's, purpose 'partner_signin_link', so the session,
 * portal-access, review and served-country checks all stay in
 * POST /auth/magic/verify (signin-handoff.ts does the same for password and
 * Google sign-in). It lands on the brand's white-label domain when one is
 * verified (getPortalBaseUrl), because the session cookie is host-only.
 *
 * Who may mint one:
 *   - an admin API key (an ApiKey row or ADMIN_API_KEY), or a scoped key
 *     holding `partners:signin`. Nothing else grants it, `partners:write`
 *     included, so the OpenPartner Network's federation key can't; and that
 *     key is refused by id too, in case a scope list ever grows to include it.
 *   - not a portal session. This is a server-to-server call, and an admin
 *     clicking through the portal has no business opening a partner session
 *     with a cookie a cross-site page could ride on.
 *
 * Who it signs in: an active partner with portal access, exactly who
 * POST /auth/signin would mail a link to. A brand still in review can't
 * mint links (approval-gate.ts). Every mint is rate-limited per key and per
 * partner, and recorded in PartnerSigninLinkLog.
 *
 * A link signs in whoever opens it, so the response carries Cache-Control:
 * no-store and the brand should redirect at once rather than render the
 * URL into a page.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  NEXT_PATH_MAX_LENGTH,
  TABLES,
  safePortalPath,
  type PartnerRow,
  type PartnerSigninLinkLogRow,
} from '@openpartner/db';
import { grantScope, requireAdmin, requireAuth } from '../auth.js';
import { issueMagicLink } from '../auth-sessions.js';
import { buildMagicLinkUrl } from '../email-templates.js';
import { KeyedLimiter } from '../middleware/rate-limit.js';
import { getNetworkMembership } from '../network-client.js';
import { isPendingReview } from '../partner-review.js';
import { linkTenantOf } from '../portal-url.js';
import { tenantOf } from '../tenancy.js';

export const PARTNER_SIGNIN_SCOPE = 'partners:signin';

/** Five minutes: enough for a redirect, short for a URL that may sit in
 *  browser history or a proxy log. */
export const SIGNIN_LINK_TTL_MS = 5 * 60 * 1000;

/** Per calling key: a busy in-app program signs in many users a minute. */
const keyLimiter = new KeyedLimiter(600, 60_000);
/** Per partner: a person clicking "Refer & earn" a few times, not a loop. */
const partnerLimiter = new KeyedLimiter(10, 60_000);

/** Portal path to land on after sign-in (`/links`, `/commissions`), carried
 *  as ?next= on the link. Omitted, the partner lands on their dashboard. */
const returnToField = z
  .string()
  .max(NEXT_PATH_MAX_LENGTH)
  // What a JSON Schema can say (the published spec carries it); the
  // refine adds what it can't, such as dot segments that resolve to //.
  .regex(/^\/(?!\/)[\x21-\x5b\x5d-\x7e]*$/, 'returnTo must be a path inside the partner portal, like /links')
  .refine((v) => safePortalPath(v) !== null, { message: 'returnTo must be a path inside the partner portal, like /links' })
  .optional();

export const signinLinkSchema = z.object({ returnTo: returnToField }).strict();

/** By email, unique per brand. Send only addresses your app has verified. */
const lookupByEmailSchema = z.object({ email: z.string().email(), returnTo: returnToField }).strict();

/** By one key and value from the partner's stored `metadata`, e.g.
 *  `{ "appUserId": "u_123" }`. Matched as stored, so a number only matches
 *  a number. */
const lookupByMetadataSchema = z
  .object({
    metadata: z
      .record(z.string().min(1).max(64), z.union([z.string().min(1).max(200), z.number()]))
      .refine((m) => Object.keys(m).length === 1, { message: 'metadata names exactly one key and value' }),
    returnTo: returnToField,
  })
  .strict();

/** Exactly one of the two. */
export const signinLinkLookupSchema = z.union([lookupByEmailSchema, lookupByMetadataSchema]);

const LOOKUP_HINT = 'Name the partner with exactly one of "email" or "metadata" (one key and value).';

/** The lookup body, parsed by the branch its keys pick, so a bad
 *  `returnTo` is reported as that rather than as a union mismatch. */
function parseLookup(raw: unknown): { lookup: Lookup; returnTo?: string } | { detail: unknown } {
  const b = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if ('email' in b === 'metadata' in b) return { detail: LOOKUP_HINT };
  if ('email' in b) {
    const parsed = lookupByEmailSchema.safeParse(b);
    if (!parsed.success) return { detail: parsed.error.flatten() };
    return { lookup: { by: 'email', email: parsed.data.email }, returnTo: parsed.data.returnTo };
  }
  const parsed = lookupByMetadataSchema.safeParse(b);
  if (!parsed.success) return { detail: parsed.error.flatten() };
  const [key, value] = Object.entries(parsed.data.metadata)[0]!;
  return { lookup: { by: 'metadata', key, value }, returnTo: parsed.data.returnTo };
}

export const partnerSigninLinkRouter = Router();

type Lookup = { by: 'id'; id: string } | { by: 'email'; email: string } | { by: 'metadata'; key: string; value: string | number };

/** The calling credential, for the limiter and the log. Null for a portal
 *  session, which may not mint links. */
function actorOf(req: Request): { kind: PartnerSigninLinkLogRow['actorKind']; id: string | null } | null {
  const p = req.principal;
  if (p?.role !== 'admin') return null;
  if (p.source === 'env') return { kind: 'operator_key', id: null };
  if (p.source === 'db') return { kind: 'api_key', id: p.apiKeyId };
  return null;
}

/** API keys only, never the Network's federation key; counted per key. */
async function admitCaller(req: Request, res: Response, next: NextFunction): Promise<void> {
  const actor = actorOf(req);
  if (!actor) {
    res.status(403).json({
      error: 'api_key_required',
      detail: 'Sign-in links are minted by your backend: call with an API key, not a portal session.',
    });
    return;
  }
  const { db, tenantId } = tenantOf(req);
  if (actor.id) {
    const network = await getNetworkMembership(db, tenantId);
    if (network?.scopedKeyId === actor.id) {
      res.status(403).json({ error: 'forbidden', detail: 'The OpenPartner Network key cannot sign partners in.' });
      return;
    }
  }
  if (!keyLimiter.hit(`${tenantId}|${actor.id ?? 'operator'}`)) {
    res.setHeader('Retry-After', '60');
    res.status(429).json({ error: 'rate_limited', detail: 'limit 600 sign-in links per 60s per key' });
    return;
  }
  next();
}

async function findPartner(req: Request, lookup: Lookup): Promise<PartnerRow[]> {
  const { db, tenantId } = tenantOf(req);
  const q = db<PartnerRow>(TABLES.Partner).where({ tenantId });
  if (lookup.by === 'id') q.where({ id: lookup.id });
  else if (lookup.by === 'email') q.where({ email: lookup.email.toLowerCase() });
  else q.whereRaw('"metadata" @> ?::jsonb', [JSON.stringify({ [lookup.key]: lookup.value })]);
  return q.limit(2);
}

async function mintSigninLink(req: Request, res: Response, lookup: Lookup, returnToRaw: string | undefined): Promise<void> {
  const { db, tenantId } = tenantOf(req);
  const matches = await findPartner(req, lookup);
  if (matches.length === 0) {
    res.status(404).json({ error: 'partner_not_found' });
    return;
  }
  if (matches.length > 1) {
    res.status(409).json({ error: 'ambiguous_partner', detail: 'More than one partner carries that metadata value.' });
    return;
  }
  const partner = matches[0]!;

  // Exactly who POST /auth/signin would mail a link to (tenantSigninCandidates),
  // with each refusal named: the caller is the brand, not an anonymous form.
  if (partner.revokedAt) {
    res.status(409).json({ error: 'partner_revoked' });
    return;
  }
  if (isPendingReview(partner)) {
    res.status(409).json({ error: 'pending_review', detail: 'Approve the application first (POST /partners/{id}/invite).' });
    return;
  }
  if (!partner.portalAccess) {
    res.status(409).json({ error: 'portal_access_disabled', detail: 'Turn portal access on first (PATCH /partners/{id}).' });
    return;
  }
  if (!partner.activatedAt) {
    res.status(409).json({
      error: 'partner_not_activated',
      detail: 'The partner has not accepted their invite. Partners created with "sendInvite": false are active at once.',
    });
    return;
  }

  if (!partnerLimiter.hit(`${tenantId}|${partner.id}`)) {
    res.setHeader('Retry-After', '60');
    res.status(429).json({ error: 'rate_limited', detail: 'limit 10 sign-in links per 60s per partner' });
    return;
  }

  const returnTo = safePortalPath(returnToRaw);
  const issued = await issueMagicLink(db, {
    tenantId,
    email: partner.email,
    purpose: 'partner_signin_link',
    principalKind: 'partner',
    principalId: partner.id,
    ttlMs: SIGNIN_LINK_TTL_MS,
  });
  const actor = actorOf(req)!;
  await db<PartnerSigninLinkLogRow>(TABLES.PartnerSigninLinkLog).insert({
    id: ulid(),
    tenantId,
    partnerId: partner.id,
    magicLinkTokenId: issued.id,
    actorKind: actor.kind,
    actorId: actor.id,
    returnTo,
    ip: req.ip ?? null,
    expiresAt: issued.expiresAt,
  });

  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({
    url: buildMagicLinkUrl(issued.plaintext, linkTenantOf(req), returnTo),
    expiresAt: issued.expiresAt.toISOString(),
    partnerId: partner.id,
  });
}

partnerSigninLinkRouter.post(
  '/partners/signin-link',
  requireAuth,
  grantScope(PARTNER_SIGNIN_SCOPE),
  requireAdmin,
  admitCaller,
  async (req, res) => {
    const parsed = parseLookup(req.body);
    if ('detail' in parsed) return res.status(400).json({ error: 'invalid_body', detail: parsed.detail });
    await mintSigninLink(req, res, parsed.lookup, parsed.returnTo);
  },
);

partnerSigninLinkRouter.post(
  '/partners/:id/signin-link',
  requireAuth,
  grantScope(PARTNER_SIGNIN_SCOPE),
  requireAdmin,
  admitCaller,
  async (req, res) => {
    const body = signinLinkSchema.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
    await mintSigninLink(req, res, { by: 'id', id: req.params.id! }, body.data.returnTo);
  },
);
