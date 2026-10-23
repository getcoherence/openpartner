/**
 * "Continue with Google" — OpenID Connect authorization-code flow.
 *
 *   GET /auth/providers          { google, googleStartUrl } for the sign-in pages
 *   GET /auth/google/start       sets a state cookie, redirects to Google
 *   GET /auth/google/callback    Google redirects back here
 *   GET|POST|DELETE /auth/google/creator-signup
 *                                a Google-verified address with no creator yet:
 *                                read it, finish signup, or drop it (creator flow)
 *
 * Google proving an address is treated exactly like a click on a link
 * mailed to it: the callback issues the token that sign-in email would
 * have carried and redirects to the landing URL it would have linked
 * (signin-handoff.ts). Sessions, bundles, activation, review / portal-
 * access / country checks — all still the verify endpoints'. Nothing about
 * the Google account is stored.
 *
 * Every flow takes Google's word only for addresses Google is authoritative
 * for: Gmail, or a Workspace account (`hd`). A Google account opened on
 * another provider's address proves only who could read that inbox when it
 * was opened; if the address has changed hands since, the old owner would
 * sign in as the new one. Those land on the flow's sign-in page with
 * ?error=google_not_authoritative, to use a password or an emailed link.
 *
 * Flows (?flow=):
 *   account / account_add   brand admin, platform identity (multi-tenant).
 *                           Any address Google vouches for may sign in; with no
 *                           brand yet, /workspaces sends them to create one —
 *                           which is "sign up with Google". ?next= (a path
 *                           inside the workspace, safeNextPath) rides the
 *                           state cookie onto the magic link, as it rides
 *                           /signin's emailed one.
 *   ops                     ops console; operators only.
 *   portal                  one brand's admin or partner (?slug= on multi-tenant).
 *   creator                 an OpenPartner Network creator (multi-tenant; the
 *                           creator portal at /creator). The Network owns
 *                           creators, so the callback asks it, over
 *                           NETWORK_ADMIN_API_KEY, for the token its sign-in
 *                           email would carry (POST /admin/creators/signin-
 *                           token) and lands on /creator/auth/magic. With no
 *                           creator yet, it lands on /creator/signup instead,
 *                           holding the verified address in a signed 15-minute
 *                           cookie (never the URL); that form still asks for a
 *                           name, handle and country, then POST
 *                           /auth/google/creator-signup has the Network create
 *                           the creator without a confirmation email — which
 *                           the Network accepts only over the admin key
 *                           (docs/creator-sign-in.md).
 *
 * One redirect URI for the whole deployment, on the platform origin
 * (GOOGLE_OAUTH_REDIRECT_URI, default PORTAL_URL/api/auth/google/callback):
 * a white-label portal starts the flow on the platform origin too (the
 * start URL /auth/providers hands out is absolute), so the state cookie and
 * callback share a host; the final redirect to the custom domain's
 * /auth/magic sets the session there, as an emailed link would.
 *
 * Off unless GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
 *
 * The ID token comes straight from Google's token endpoint over TLS, so
 * per OIDC Core §3.1.3.7 TLS stands in for checking its signature; we still
 * check issuer, audience, expiry, nonce, email_verified and authority.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type CookieOptions, type Request, type Response } from 'express';
import { z } from 'zod';
import { DEFAULT_TENANT_ID, TABLES, safeNextPath, type TenantRow } from '@openpartner/db';
import { db } from '../db.js';
import { clearSessionCookie } from '../auth-sessions.js';
import { macValue, verifyMac } from '../crypto.js';
import { adminCreatorSignup, adminCreatorSigninToken, NetworkAdminError, platformNetworkUrl } from '../network-client.js';
import { buildMagicLinkUrl } from '../email-templates.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { getPortalBaseUrl } from '../portal-url.js';
import { getTenancyMode } from '../tenancy.js';
import {
  opsSigninToken,
  platformSigninToken,
  tenantSigninCandidates,
  tenantSigninToken,
} from '../signin-handoff.js';
import { isAllowedOperator } from './platform-admin.js';

export const googleAuthRouter = Router();

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
export const GOOGLE_STATE_COOKIE = 'op_google_oauth';
const STATE_TTL_MS = 10 * 60 * 1000;

interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function googleConfig(): GoogleConfig | null {
  const clientId = (process.env.GOOGLE_CLIENT_ID ?? '').trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  const redirectUri =
    (process.env.GOOGLE_OAUTH_REDIRECT_URI ?? '').trim() || `${getPortalBaseUrl()}/api/auth/google/callback`;
  return { clientId, clientSecret, redirectUri };
}

type Flow = 'account' | 'account_add' | 'ops' | 'portal' | 'creator';
const PLATFORM_FLOWS = new Set<Flow>(['account', 'account_add', 'ops', 'creator']);

const startSchema = z.object({
  flow: z.enum(['account', 'account_add', 'ops', 'portal', 'creator']),
  slug: z
    .string()
    .regex(/^[a-z0-9-]{1,63}$/)
    .optional(),
  next: z.string().optional(),
});

interface OAuthState {
  /** state */
  s: string;
  /** nonce */
  n: string;
  f: Flow;
  /** tenant slug, portal flow on multi-tenant */
  t?: string;
  /** next path, account flows (checked again with safeNextPath on use) */
  x?: string;
}

/**
 * The state cookie's attributes, for clearing it. Setting it spells them
 * out at the res.cookie call so code scanning can see the flags.
 *
 * Secure even outside production, unlike the session cookies: Google only
 * accepts HTTPS redirect URIs (localhost aside, which browsers treat as a
 * secure context), so this cookie never exists on a plain-http origin.
 */
const STATE_COOKIE_SCOPE: CookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };

function readState(req: Request): OAuthState | null {
  const raw = (req as unknown as { cookies?: Record<string, string> }).cookies?.[GOOGLE_STATE_COOKIE];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<OAuthState>;
    if (typeof parsed.s !== 'string' || typeof parsed.n !== 'string' || !startSchema.shape.flow.safeParse(parsed.f).success) {
      return null;
    }
    return parsed as OAuthState;
  } catch {
    return null;
  }
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Where a failed attempt goes back to, with ?error= for the page to show
 *  (and ?next= back to /signin, so trying again still lands there). */
async function failureUrl(flow: Flow | null, slug: string | undefined, error: string, next?: string | null): Promise<string> {
  const base = getPortalBaseUrl();
  const q = `?error=${encodeURIComponent(error)}`;
  if (flow === 'ops') return `${base}/platform/login${q}`;
  if (flow === 'creator') return `${base}/creator/login${q}`;
  if (flow === 'portal' || getTenancyMode() !== 'multi') {
    const tenant = slug ? await db<TenantRow>(TABLES.Tenant).where({ slug }).first(['slug', 'customDomain']) : null;
    return `${getPortalBaseUrl(tenant ?? (slug ? { slug } : null))}/login${q}`;
  }
  return `${base}/signin${q}${next ? `&next=${encodeURIComponent(next)}` : ''}`;
}

// -------- Which providers are on --------

googleAuthRouter.get('/auth/providers', (_req, res) => {
  const google = googleConfig();
  res.json({
    google: !!google,
    // Absolute, on the platform origin — see the header comment.
    googleStartUrl: google ? `${getPortalBaseUrl()}/api/auth/google/start` : null,
  });
});

// -------- Start --------

const startLimit = ipRateLimit({ name: 'google-start', max: 30, windowMs: 60_000 });

googleAuthRouter.get('/auth/google/start', startLimit, async (req, res) => {
  const config = googleConfig();
  const parsed = startSchema.safeParse(req.query);
  const flow = parsed.success ? parsed.data.flow : null;
  const slug = parsed.success ? parsed.data.slug : undefined;
  const next = parsed.success && (flow === 'account' || flow === 'account_add') ? safeNextPath(parsed.data.next) : null;
  if (!config) return res.redirect(await failureUrl(flow, slug, 'google_unavailable', next));
  if (!parsed.success) return res.redirect(await failureUrl(null, undefined, 'google_failed'));

  const multi = getTenancyMode() === 'multi';
  if (PLATFORM_FLOWS.has(parsed.data.flow) && !multi) {
    return res.redirect(await failureUrl('portal', undefined, 'google_failed'));
  }
  if (parsed.data.flow === 'portal' && multi && !slug) {
    return res.redirect(await failureUrl(null, undefined, 'google_failed'));
  }
  // Creators live on the Network: no Network to ask, no creator sign-in.
  if (parsed.data.flow === 'creator' && !creatorNetworkUrl()) {
    return res.redirect(await failureUrl('creator', undefined, 'google_unavailable'));
  }

  const state: OAuthState = {
    s: randomBytes(24).toString('base64url'),
    n: randomBytes(16).toString('base64url'),
    f: parsed.data.flow,
    ...(parsed.data.flow === 'portal' && multi && slug ? { t: slug } : {}),
    ...(next ? { x: next } : {}),
  };
  res.cookie(GOOGLE_STATE_COOKIE, Buffer.from(JSON.stringify(state)).toString('base64url'), {
    httpOnly: true,
    secure: true,
    // Lax, not Strict: the cookie has to ride the top-level redirect back
    // from accounts.google.com.
    sameSite: 'lax',
    path: '/',
    maxAge: STATE_TTL_MS,
  });

  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state.s);
  url.searchParams.set('nonce', state.n);
  url.searchParams.set('prompt', 'select_account');
  res.redirect(url.toString());
});

// -------- Callback --------

export interface GoogleIdClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean | string;
  /** Google Workspace hosted domain — present only for Workspace accounts. */
  hd?: string;
}

/** Google's own rule for when it is authoritative for an address
 *  (developers.google.com/identity/sign-in/web/backend-auth): it owns the
 *  address (Gmail) or hosts its domain (Workspace, `hd`), so `email_verified`
 *  means the address is the account holder's now. For any other domain it
 *  only means they could read that inbox once. */
function googleIsAuthoritative(email: string, hd: unknown): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return domain === 'gmail.com' || domain === 'googlemail.com' || (typeof hd === 'string' && hd.length > 0);
}

class GoogleAuthError extends Error {
  constructor(public code: 'google_failed' | 'google_unverified' | 'google_not_authoritative') {
    super(code);
  }
}

/** Exchange the code and return the verified, lower-cased address — one
 *  Google is authoritative for. */
async function verifiedEmailFromCode(config: GoogleConfig, code: string, nonce: string): Promise<string> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    console.warn('[google-auth] token exchange failed', { status: response.status });
    throw new GoogleAuthError('google_failed');
  }
  const idToken = ((await response.json()) as { id_token?: unknown }).id_token;
  const payload = typeof idToken === 'string' ? idToken.split('.')[1] : undefined;
  if (!payload) throw new GoogleAuthError('google_failed');
  let claims: GoogleIdClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as GoogleIdClaims;
  } catch {
    throw new GoogleAuthError('google_failed');
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (
    !claims.iss ||
    !GOOGLE_ISSUERS.has(claims.iss) ||
    !audiences.includes(config.clientId) ||
    typeof claims.exp !== 'number' ||
    claims.exp * 1000 <= Date.now() ||
    typeof claims.nonce !== 'string' ||
    !sameString(claims.nonce, nonce) ||
    typeof claims.email !== 'string'
  ) {
    throw new GoogleAuthError('google_failed');
  }
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new GoogleAuthError('google_unverified');
  const email = claims.email.trim().toLowerCase();
  if (!googleIsAuthoritative(email, claims.hd)) throw new GoogleAuthError('google_not_authoritative');
  return email;
}

const callbackSchema = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(256).optional(),
  error: z.string().max(256).optional(),
});

googleAuthRouter.get('/auth/google/callback', async (req: Request, res: Response) => {
  const config = googleConfig();
  const state = readState(req);
  // Single use, whatever happens next.
  clearSessionCookie(res, GOOGLE_STATE_COOKIE, STATE_COOKIE_SCOPE);
  const flow = state?.f ?? null;
  const slug = state?.t;
  const next = safeNextPath(state?.x);

  const query = callbackSchema.safeParse(req.query);
  if (!config || !state || !query.success) return res.redirect(await failureUrl(flow, slug, 'google_failed', next));
  // Cancelled on Google's screen.
  if (query.data.error) return res.redirect(await failureUrl(flow, slug, 'google_cancelled', next));
  if (!query.data.code || !query.data.state || !sameString(query.data.state, state.s)) {
    return res.redirect(await failureUrl(flow, slug, 'google_failed', next));
  }

  let email: string;
  try {
    email = await verifiedEmailFromCode(config, query.data.code, state.n);
  } catch (err) {
    if (!(err instanceof GoogleAuthError)) console.error('[google-auth] callback failed', err);
    return res.redirect(await failureUrl(flow, slug, err instanceof GoogleAuthError ? err.code : 'google_failed', next));
  }

  if (state.f === 'account' || state.f === 'account_add') {
    // → /auth/magic → POST /auth/platform-verify → /workspaces.
    const token = await platformSigninToken(db, email, state.f === 'account_add');
    return res.redirect(buildMagicLinkUrl(token, null, next));
  }

  if (state.f === 'creator') return res.redirect(await creatorLanding(req, res, email));

  if (state.f === 'ops') {
    if (!(await isAllowedOperator(email))) return res.redirect(await failureUrl('ops', undefined, 'not_an_operator'));
    const token = await opsSigninToken(db, email);
    return res.redirect(`${getPortalBaseUrl()}/platform/auth?token=${encodeURIComponent(token)}`);
  }

  // portal — the privileged pool, so every lookup names the tenant.
  const tenant =
    getTenancyMode() === 'multi'
      ? await db<TenantRow>(TABLES.Tenant).where({ slug, status: 'active' }).first()
      : await db<TenantRow>(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).first();
  if (!tenant) return res.redirect(await failureUrl('portal', slug, 'google_failed'));
  const candidates = await tenantSigninCandidates(db, tenant.id, email);
  const principal = candidates.admin
    ? ({ kind: 'admin', row: candidates.admin } as const)
    : candidates.partner
      ? ({ kind: 'partner', row: candidates.partner } as const)
      : null;
  if (!principal) return res.redirect(await failureUrl('portal', slug, 'google_no_account'));
  const token = await tenantSigninToken(db, tenant.id, principal);
  // The brand's own host when it has a custom domain — the session cookie
  // is host-only (portal-url.ts).
  res.redirect(buildMagicLinkUrl(token, { slug: tenant.slug, customDomain: tenant.customDomain }));
});

// -------- Creator flow (the Network's creators) --------

export const GOOGLE_CREATOR_SIGNUP_COOKIE = 'op_creator_google_signup';
const CREATOR_SIGNUP_TTL_MS = 15 * 60 * 1000;
const CREATOR_SIGNUP_MAC = 'creator-google-signup';
const CREATOR_SIGNUP_COOKIE_SCOPE: CookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };

/** Where creators live, when this deployment can ask it on their behalf. */
function creatorNetworkUrl(): string | null {
  const url = platformNetworkUrl();
  return url && process.env.NETWORK_ADMIN_API_KEY ? url : null;
}

/** The Network's refusals worth showing as-is on /creator/login. */
const CREATOR_ERRORS = new Set(['creator_not_active', 'country_not_supported']);

/**
 * After Google: an existing creator → the Network's sign-in token on
 * /creator/auth/magic (POST /creators/verify through the proxy makes the
 * session). No creator → /creator/signup, the verified address held in a
 * signed cookie for the signup form. Nothing about the Google account is
 * stored anywhere.
 */
async function creatorLanding(req: Request, res: Response, email: string): Promise<string> {
  const base = getPortalBaseUrl();
  const networkUrl = creatorNetworkUrl();
  if (!networkUrl) return failureUrl('creator', undefined, 'google_unavailable');
  try {
    const token = await adminCreatorSigninToken(networkUrl, email, req.ip);
    return `${base}/creator/auth/magic?token=${encodeURIComponent(token)}`;
  } catch (err) {
    if (err instanceof NetworkAdminError && err.code === 'no_creator') {
      const exp = Date.now() + CREATOR_SIGNUP_TTL_MS;
      const value = `${Buffer.from(email).toString('base64url')}.${exp}`;
      res.cookie(GOOGLE_CREATOR_SIGNUP_COOKIE, `${value}.${macValue(CREATOR_SIGNUP_MAC, value)}`, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: CREATOR_SIGNUP_TTL_MS,
      });
      return `${base}/creator/signup?google=1`;
    }
    if (err instanceof NetworkAdminError && err.code && CREATOR_ERRORS.has(err.code)) {
      return failureUrl('creator', undefined, err.code);
    }
    console.error('[google-auth] creator token request failed', err);
    return failureUrl('creator', undefined, 'google_failed');
  }
}

/** The Google-verified address the signup cookie holds, if it's ours and
 *  still fresh. */
function creatorSignupEmail(req: Request): string | null {
  const raw = (req as unknown as { cookies?: Record<string, string> }).cookies?.[GOOGLE_CREATOR_SIGNUP_COOKIE];
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [emailPart, expPart, mac] = parts as [string, string, string];
  if (!verifyMac(CREATOR_SIGNUP_MAC, `${emailPart}.${expPart}`, mac)) return null;
  if (!/^\d{1,15}$/.test(expPart) || Number(expPart) <= Date.now()) return null;
  const email = Buffer.from(emailPart, 'base64url').toString('utf8');
  return z.string().email().max(254).safeParse(email).success ? email : null;
}

googleAuthRouter.get('/auth/google/creator-signup', (req, res) => {
  const email = creatorSignupEmail(req);
  if (!email) return res.status(404).json({ error: 'google_signup_expired' });
  res.json({ email });
});

// Only the form's own fields: the address is the cookie's, never the body's.
const creatorSignupSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    handle: z.string().trim().min(1).max(40).optional(),
    country: z.string().trim().length(2),
    outsideOccupiedRegions: z.boolean().optional(),
  })
  .strict();

const creatorSignupLimit = ipRateLimit({ name: 'google-creator-signup', max: 10, windowMs: 60_000 });

googleAuthRouter.post('/auth/google/creator-signup', creatorSignupLimit, async (req, res) => {
  const email = creatorSignupEmail(req);
  if (!email) return res.status(401).json({ error: 'google_signup_expired' });
  const body = creatorSignupSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: 'invalid_body' });
  const networkUrl = creatorNetworkUrl();
  if (!networkUrl) return res.status(503).json({ error: 'google_unavailable' });
  try {
    const { token } = await adminCreatorSignup(networkUrl, { ...body.data, email }, req.ip);
    clearSessionCookie(res, GOOGLE_CREATOR_SIGNUP_COOKIE, CREATOR_SIGNUP_COOKIE_SCOPE);
    // Redeemed at POST /creators/verify through the proxy, like the link.
    res.json({ ok: true, token });
  } catch (err) {
    // The Network's own answer (handle_taken, country_not_supported, …).
    // creator_exists: the address has an account now; this proof is spent.
    // The Network never signs an existing account in from here, so a
    // replayed cookie can't open one.
    if (err instanceof NetworkAdminError && err.code && err.status >= 400 && err.status < 500) {
      if (err.code === 'creator_exists') clearSessionCookie(res, GOOGLE_CREATOR_SIGNUP_COOKIE, CREATOR_SIGNUP_COOKIE_SCOPE);
      return res.status(err.status).json({ error: err.code });
    }
    console.error('[google-auth] creator signup failed', err);
    res.status(502).json({ error: 'network_unreachable' });
  }
});

googleAuthRouter.delete('/auth/google/creator-signup', (_req, res) => {
  clearSessionCookie(res, GOOGLE_CREATOR_SIGNUP_COOKIE, CREATOR_SIGNUP_COOKIE_SCOPE);
  res.json({ ok: true });
});
