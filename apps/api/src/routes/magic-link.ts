/**
 * Human-auth endpoints — magic-link signup/signin for creators AND
 * vendors, plus dev mailbox.
 *
 * Purpose strings encode BOTH the role (creator / vendor) and the
 * lifecycle stage (signup / signin), giving us four values:
 *   creator_signup  — claim carries handle + name → creates active NetworkCreator
 *   creator_signin  — returning active creator → new session
 *   vendor_signup   — claim carries full vendor profile → creates pending NetworkVendor
 *   vendor_signin   — returning active vendor → new session
 *
 * We deliberately use 'pending' status for vendor signup so an admin
 * still reviews the federation credentials before activating — unlike
 * creator signup where magic-link email verification is enough.
 *
 * Token consumption is single-use and atomic (conditional update on
 * consumedAt IS NULL). Tokens expire after 15 minutes.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  TABLES,
  type DevMessageRow,
  type MagicLinkCreatorClaim,
  type MagicLinkTokenRow,
  type MagicLinkVendorClaim,
  type NetworkCreatorRow,
  type NetworkVendorRow,
} from '@openpartner/db';
import { db } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { getMailer } from '../mailer.js';
import {
  SESSION_COOKIE_NAME,
  consumeMagicLink,
  createSession,
  issueMagicLink,
  revokeSession,
  sessionCookieOptions,
} from '../auth-sessions.js';
import { encryptKey } from '../network/crypto.js';
import {
  creatorSigninEmail,
  creatorSignupEmail,
  vendorSigninEmail,
  vendorSignupEmail,
} from '../email-templates.js';
import { NETWORK_FEDERATION_SCOPES } from './api-keys.js';
import { ipRateLimit } from '../middleware/rate-limit.js';

export const magicLinkRouter = Router();

// Shared bucket across every email-triggering auth endpoint — stops an
// attacker from rotating across /creator/signin, /vendor/signin, etc. to
// multiply the cap. 10/min per IP is loose for one real user, tight for
// a bot.
const mailAuthLimit = ipRateLimit({ name: 'magic-link-mail', max: 10, windowMs: 60_000 });

// Token verification is single-use already, but brute-forcing /verify
// across many IPs is still a theoretical risk. Modest cap — a legit
// user verifies once.
const verifyLimit = ipRateLimit({ name: 'magic-link-verify', max: 30, windowMs: 60_000 });

const creatorSignupSchema = z.object({
  email: z.string().email(),
  handle: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9_]+$/, 'handle must be lowercase letters, digits, or _'),
  name: z.string().min(2).max(80),
});

const vendorSignupSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase letters, digits, or -'),
  instanceUrl: z.string().url(),
  instanceKey: z.string().min(8),
  routerUrl: z.string().url().optional(),
  description: z.string().max(1000).optional(),
  websiteUrl: z.string().url().optional(),
  logoUrl: z.string().url().optional(),
});

const signinSchema = z.object({ email: z.string().email() });
const verifySchema = z.object({ token: z.string().min(8) });

function portalOrigin(): string {
  return (process.env.PORTAL_URL ?? 'http://localhost:5173').replace(/\/$/, '');
}

function magicUrl(token: string, purpose: string): string {
  return `${portalOrigin()}/auth/magic?token=${encodeURIComponent(token)}&purpose=${purpose}`;
}

// -------- Creator signup --------

magicLinkRouter.post('/auth/creator/signup', mailAuthLimit, async (req, res) => {
  const body = creatorSignupSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const email = body.data.email.toLowerCase();
  const handle = body.data.handle.toLowerCase();

  const existing = await db<NetworkCreatorRow>(TABLES.NetworkCreator)
    .where({ email })
    .orWhere({ handle })
    .first();
  if (existing) return res.status(409).json({ error: 'email_or_handle_taken' });

  const claim: MagicLinkCreatorClaim = { kind: 'creator', handle, name: body.data.name };
  const issued = await issueMagicLink({ email, purpose: 'creator_signup', claim });

  const tmpl = creatorSignupEmail(body.data.name, magicUrl(issued.plaintext, 'creator_signup'));
  await getMailer().send({
    to: email,
    subject: tmpl.subject,
    text: tmpl.text,
    html: tmpl.html,
    tag: tmpl.tag,
    metadata: { purpose: 'creator_signup', handle },
  });

  res.json({ ok: true });
});

// -------- Vendor signup --------
//
// We verify the vendor's scoped API key against their own instance BEFORE
// issuing the magic link — no point emailing them a verification link
// only to fail at admin-approval time because the key doesn't work.

magicLinkRouter.post('/auth/vendor/signup', mailAuthLimit, async (req, res) => {
  const body = vendorSignupSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const email = body.data.email.toLowerCase();

  const existing = await db<NetworkVendorRow>(TABLES.NetworkVendor).where({ slug: body.data.slug }).first();
  if (existing) return res.status(409).json({ error: 'slug_taken' });

  // Probe the instance's /auth/introspect with the pasted key. Reject if
  // the key can't reach the instance or doesn't have the federation
  // scopes (unrestricted admin keys are accepted but flagged in the UI).
  const introspectUrl = `${body.data.instanceUrl.replace(/\/$/, '')}/auth/introspect`;
  try {
    const response = await fetch(introspectUrl, {
      headers: { authorization: `Bearer ${body.data.instanceKey}` },
    });
    if (!response.ok) {
      const text = await response.text();
      return res.status(400).json({
        error: 'instance_rejected_key',
        status: response.status,
        detail: text.slice(0, 300),
      });
    }
    const intro = (await response.json()) as Record<string, unknown>;
    const scopes = Array.isArray(intro.scopes) ? (intro.scopes as string[]) : null;
    const unrestricted = intro.role === 'admin' && intro.unrestricted === true;
    const missing =
      scopes != null
        ? (NETWORK_FEDERATION_SCOPES as readonly string[]).filter((s) => !scopes.includes(s))
        : [];
    if (!unrestricted && (scopes == null || missing.length > 0)) {
      return res.status(400).json({
        error: 'missing_scopes',
        missing,
        have: scopes ?? [],
      });
    }
  } catch (err: unknown) {
    return res.status(400).json({
      error: 'instance_unreachable',
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  const claim: MagicLinkVendorClaim = {
    kind: 'vendor',
    name: body.data.name,
    slug: body.data.slug,
    instanceUrl: body.data.instanceUrl.replace(/\/$/, ''),
    instanceKey: body.data.instanceKey,
    ...(body.data.routerUrl ? { routerUrl: body.data.routerUrl } : {}),
    ...(body.data.description ? { description: body.data.description } : {}),
    ...(body.data.websiteUrl ? { websiteUrl: body.data.websiteUrl } : {}),
    ...(body.data.logoUrl ? { logoUrl: body.data.logoUrl } : {}),
  };
  const issued = await issueMagicLink({ email, purpose: 'vendor_signup', claim });

  const tmpl = vendorSignupEmail(body.data.name, magicUrl(issued.plaintext, 'vendor_signup'));
  await getMailer().send({
    to: email,
    subject: tmpl.subject,
    text: tmpl.text,
    html: tmpl.html,
    tag: tmpl.tag,
    metadata: { purpose: 'vendor_signup', slug: body.data.slug },
  });

  res.json({ ok: true });
});

// -------- Unified signin --------
//
// One endpoint for humans. Looks up creator first, then vendor; issues a
// link for whichever role matches. Response is identical regardless of
// which (or neither) matches, so the endpoint doesn't leak whether an
// email is registered on the Network.

magicLinkRouter.post('/auth/signin', mailAuthLimit, async (req, res) => {
  const body = signinSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const email = body.data.email.toLowerCase();

  const creator = await db<NetworkCreatorRow>(TABLES.NetworkCreator).where({ email }).first();
  if (creator && creator.status === 'active') {
    const issued = await issueMagicLink({ email, purpose: 'creator_signin' });
    const tmpl = creatorSigninEmail(magicUrl(issued.plaintext, 'creator_signin'));
    await getMailer().send({
      to: email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: tmpl.tag,
      metadata: { purpose: 'creator_signin' },
    });
    return res.json({ ok: true });
  }

  // Vendors use email too; we need a way to tie vendors to an email. For
  // now we assume vendor.description or a dedicated column — but we don't
  // have vendor.email yet. We infer via MagicLinkToken history: find the
  // most recent consumed vendor_signup token for this email and look up
  // the vendor created from it. That keeps migrations light for MVP.
  const vendor = await findVendorByEmail(email);
  if (vendor && vendor.status === 'active') {
    const issued = await issueMagicLink({ email, purpose: 'vendor_signin' });
    const tmpl = vendorSigninEmail(magicUrl(issued.plaintext, 'vendor_signin'));
    await getMailer().send({
      to: email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: tmpl.tag,
      metadata: { purpose: 'vendor_signin', vendorId: vendor.id },
    });
  }

  // No-op on unknown / inactive — don't reveal which.
  res.json({ ok: true });
});

// Deprecated alias for older clients still calling /auth/creator/signin.
// Scoped to creators only — matches the pre-unified contract.
magicLinkRouter.post('/auth/creator/signin', mailAuthLimit, async (req, res) => {
  const body = signinSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  const email = body.data.email.toLowerCase();

  const creator = await db<NetworkCreatorRow>(TABLES.NetworkCreator).where({ email }).first();
  if (creator && creator.status === 'active') {
    const issued = await issueMagicLink({ email, purpose: 'creator_signin' });
    const tmpl = creatorSigninEmail(magicUrl(issued.plaintext, 'creator_signin'));
    await getMailer().send({
      to: email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: tmpl.tag,
      metadata: { purpose: 'creator_signin' },
    });
  }
  res.json({ ok: true });
});

// -------- Verify --------

magicLinkRouter.post('/auth/magic/verify', verifyLimit, async (req, res) => {
  const body = verifySchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const result = await consumeMagicLink(body.data.token);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const token: MagicLinkTokenRow = result.token;

  if (token.purpose === 'creator_signup') {
    return verifyCreatorSignup(token, res);
  }
  if (token.purpose === 'creator_signin') {
    return verifyCreatorSignin(token, res);
  }
  if (token.purpose === 'vendor_signup') {
    return verifyVendorSignup(token, res);
  }
  if (token.purpose === 'vendor_signin') {
    return verifyVendorSignin(token, res);
  }
  res.status(400).json({ error: 'unknown_purpose' });
});

async function verifyCreatorSignup(token: MagicLinkTokenRow, res: Parameters<Parameters<typeof magicLinkRouter.post>[1]>[1]) {
  const claim = token.claim;
  if (!claim || claim.kind !== 'creator') {
    return res.status(400).json({ error: 'invalid_signup_claim' });
  }

  const collision = await db<NetworkCreatorRow>(TABLES.NetworkCreator)
    .where({ email: token.email })
    .orWhere({ handle: claim.handle })
    .first();
  if (collision) return res.status(409).json({ error: 'email_or_handle_taken' });

  const id = ulid();
  await db<NetworkCreatorRow>(TABLES.NetworkCreator).insert({
    id,
    name: claim.name,
    handle: claim.handle,
    email: token.email,
    bio: null,
    avatarUrl: null,
    platforms: JSON.stringify([]) as unknown as never,
    defaultPromoCode: null,
    status: 'active',
    activatedAt: new Date(),
  });
  const creator = (await db<NetworkCreatorRow>(TABLES.NetworkCreator).where({ id }).first())!;

  const session = await createSession({ principalKind: 'network_creator', principalId: creator.id });
  res.cookie(SESSION_COOKIE_NAME, session.plaintext, sessionCookieOptions());
  res.json({
    ok: true,
    role: 'network_creator',
    creator: {
      id: creator.id,
      name: creator.name,
      handle: creator.handle,
      email: creator.email,
      avatarUrl: creator.avatarUrl,
      defaultPromoCode: creator.defaultPromoCode,
      status: creator.status,
    },
  });
}

async function verifyCreatorSignin(token: MagicLinkTokenRow, res: Parameters<Parameters<typeof magicLinkRouter.post>[1]>[1]) {
  const creator = await db<NetworkCreatorRow>(TABLES.NetworkCreator).where({ email: token.email }).first();
  if (!creator) return res.status(404).json({ error: 'creator_not_found' });
  if (creator.status !== 'active') return res.status(403).json({ error: 'creator_not_active' });

  const session = await createSession({ principalKind: 'network_creator', principalId: creator.id });
  res.cookie(SESSION_COOKIE_NAME, session.plaintext, sessionCookieOptions());
  res.json({
    ok: true,
    role: 'network_creator',
    creator: {
      id: creator.id,
      name: creator.name,
      handle: creator.handle,
      email: creator.email,
      avatarUrl: creator.avatarUrl,
      defaultPromoCode: creator.defaultPromoCode,
      status: creator.status,
    },
  });
}

async function verifyVendorSignup(token: MagicLinkTokenRow, res: Parameters<Parameters<typeof magicLinkRouter.post>[1]>[1]) {
  const claim = token.claim;
  if (!claim || claim.kind !== 'vendor') {
    return res.status(400).json({ error: 'invalid_signup_claim' });
  }

  const collision = await db<NetworkVendorRow>(TABLES.NetworkVendor).where({ slug: claim.slug }).first();
  if (collision) return res.status(409).json({ error: 'slug_taken' });

  const id = ulid();
  const ciphertext = encryptKey(claim.instanceKey);
  await db<NetworkVendorRow>(TABLES.NetworkVendor).insert({
    id,
    name: claim.name,
    slug: claim.slug,
    websiteUrl: claim.websiteUrl ?? null,
    logoUrl: claim.logoUrl ?? null,
    description: claim.description ?? null,
    instanceUrl: claim.instanceUrl,
    instanceKeyCiphertext: ciphertext,
    instanceKeyPrefix: claim.instanceKey.slice(0, 8),
    routerUrl: claim.routerUrl ?? null,
    status: 'pending', // admin still reviews the federation relationship
  });

  // No session yet — the vendor is pending. Returning a helpful message
  // so the portal can show "admin is reviewing your application."
  res.json({
    ok: true,
    role: 'network_vendor',
    status: 'pending',
    vendor: { id, name: claim.name, slug: claim.slug },
  });
}

async function verifyVendorSignin(token: MagicLinkTokenRow, res: Parameters<Parameters<typeof magicLinkRouter.post>[1]>[1]) {
  const vendor = await findVendorByEmail(token.email);
  if (!vendor) return res.status(404).json({ error: 'vendor_not_found' });
  if (vendor.status !== 'active') return res.status(403).json({ error: 'vendor_not_active' });

  const session = await createSession({ principalKind: 'network_vendor', principalId: vendor.id });
  res.cookie(SESSION_COOKIE_NAME, session.plaintext, sessionCookieOptions());
  res.json({
    ok: true,
    role: 'network_vendor',
    vendor: {
      id: vendor.id,
      name: vendor.name,
      slug: vendor.slug,
      logoUrl: vendor.logoUrl,
      websiteUrl: vendor.websiteUrl,
      status: vendor.status,
    },
  });
}

/**
 * Map a vendor back to the email that signed them up. We don't store
 * email directly on NetworkVendor today (it's carried on the MagicLink
 * claim), so we look up the most recent consumed vendor_signup token for
 * this email and locate the vendor by the slug it held.
 */
async function findVendorByEmail(email: string): Promise<NetworkVendorRow | undefined> {
  const token = await db<MagicLinkTokenRow>(TABLES.MagicLinkToken)
    .where({ email, purpose: 'vendor_signup' })
    .whereNotNull('consumedAt')
    .orderBy('consumedAt', 'desc')
    .first();
  if (!token?.claim || token.claim.kind !== 'vendor') return undefined;
  return db<NetworkVendorRow>(TABLES.NetworkVendor).where({ slug: token.claim.slug }).first();
}

// -------- Signout --------

magicLinkRouter.post('/auth/signout', async (req, res) => {
  const plaintext = req.cookies?.[SESSION_COOKIE_NAME];
  if (plaintext) {
    const { resolveSession } = await import('../auth-sessions.js');
    const session = await resolveSession(plaintext);
    if (session) await revokeSession(session.id);
  }
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

// -------- Dev mailbox --------

magicLinkRouter.get('/dev/mailbox', requireAuth, requireAdmin, async (_req, res) => {
  const messages = await db<DevMessageRow>(TABLES.DevMessage).orderBy('createdAt', 'desc').limit(100);
  res.json({ messages });
});
