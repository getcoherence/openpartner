/**
 * "Continue with Google" — OpenID Connect authorization-code flow.
 *
 *   GET /auth/providers          { google, googleStartUrl } for the sign-in pages
 *   GET /auth/google/start       sets a state cookie, redirects to Google
 *   GET /auth/google/callback    Google redirects back here
 *
 * Google proving an address is treated exactly like a click on a link
 * mailed to it: the callback issues the token that sign-in email would
 * have carried and redirects to the landing URL it would have linked
 * (signin-handoff.ts). Sessions, bundles, activation, review / portal-
 * access / country checks — all still the verify endpoints'. Nothing about
 * the Google account is stored.
 *
 * Flows (?flow=):
 *   account / account_add   brand admin, platform identity (multi-tenant).
 *                           Any verified Google address may sign in; with no
 *                           brand yet, /workspaces sends them to create one —
 *                           which is "sign up with Google".
 *   ops                     ops console; operators only.
 *   portal                  one brand's admin or partner (?slug= on multi-tenant).
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
 * check issuer, audience, expiry, nonce and email_verified.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type CookieOptions, type Request, type Response } from 'express';
import { z } from 'zod';
import { DEFAULT_TENANT_ID, TABLES, type TenantRow } from '@openpartner/db';
import { db } from '../db.js';
import { clearSessionCookie } from '../auth-sessions.js';
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

type Flow = 'account' | 'account_add' | 'ops' | 'portal';
const PLATFORM_FLOWS = new Set<Flow>(['account', 'account_add', 'ops']);

const startSchema = z.object({
  flow: z.enum(['account', 'account_add', 'ops', 'portal']),
  slug: z
    .string()
    .regex(/^[a-z0-9-]{1,63}$/)
    .optional(),
});

interface OAuthState {
  /** state */
  s: string;
  /** nonce */
  n: string;
  f: Flow;
  /** tenant slug, portal flow on multi-tenant */
  t?: string;
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

/** Where a failed attempt goes back to, with ?error= for the page to show. */
async function failureUrl(flow: Flow | null, slug: string | undefined, error: string): Promise<string> {
  const base = getPortalBaseUrl();
  const q = `?error=${encodeURIComponent(error)}`;
  if (flow === 'ops') return `${base}/platform/login${q}`;
  if (flow === 'portal' || getTenancyMode() !== 'multi') {
    const tenant = slug ? await db<TenantRow>(TABLES.Tenant).where({ slug }).first(['slug', 'customDomain']) : null;
    return `${getPortalBaseUrl(tenant ?? (slug ? { slug } : null))}/login${q}`;
  }
  return `${base}/signin${q}`;
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
  if (!config) return res.redirect(await failureUrl(flow, slug, 'google_unavailable'));
  if (!parsed.success) return res.redirect(await failureUrl(null, undefined, 'google_failed'));

  const multi = getTenancyMode() === 'multi';
  if (PLATFORM_FLOWS.has(parsed.data.flow) && !multi) {
    return res.redirect(await failureUrl('portal', undefined, 'google_failed'));
  }
  if (parsed.data.flow === 'portal' && multi && !slug) {
    return res.redirect(await failureUrl(null, undefined, 'google_failed'));
  }

  const state: OAuthState = {
    s: randomBytes(24).toString('base64url'),
    n: randomBytes(16).toString('base64url'),
    f: parsed.data.flow,
    ...(parsed.data.flow === 'portal' && multi && slug ? { t: slug } : {}),
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
}

class GoogleAuthError extends Error {
  constructor(public code: 'google_failed' | 'google_unverified') {
    super(code);
  }
}

/** Exchange the code and return the verified, lower-cased address. */
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
  return claims.email.trim().toLowerCase();
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

  const query = callbackSchema.safeParse(req.query);
  if (!config || !state || !query.success) return res.redirect(await failureUrl(flow, slug, 'google_failed'));
  // Cancelled on Google's screen.
  if (query.data.error) return res.redirect(await failureUrl(flow, slug, 'google_cancelled'));
  if (!query.data.code || !query.data.state || !sameString(query.data.state, state.s)) {
    return res.redirect(await failureUrl(flow, slug, 'google_failed'));
  }

  let email: string;
  try {
    email = await verifiedEmailFromCode(config, query.data.code, state.n);
  } catch (err) {
    if (!(err instanceof GoogleAuthError)) console.error('[google-auth] callback failed', err);
    return res.redirect(await failureUrl(flow, slug, err instanceof GoogleAuthError ? err.code : 'google_failed'));
  }

  if (state.f === 'account' || state.f === 'account_add') {
    // → /auth/magic → POST /auth/platform-verify → /workspaces.
    const token = await platformSigninToken(db, email, state.f === 'account_add');
    return res.redirect(buildMagicLinkUrl(token));
  }

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
