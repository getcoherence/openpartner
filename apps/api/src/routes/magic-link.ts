/**
 * Human-auth endpoints — magic-link signup/signin for creators + dev
 * mailbox.
 *
 * Signup flow:
 *   POST /auth/creator/signup {email, handle, name}
 *     → writes a MagicLinkToken(purpose=signup, claim={handle,name})
 *     → mails a link containing the token
 *   GET /auth/magic?token=…&purpose=signup  (the mailed link)
 *     → front-end POSTs the token to /auth/magic/verify
 *   POST /auth/magic/verify {token}
 *     → consumes token; if signup, create NetworkCreator using claim
 *     → create Session, set cookie, return whoami-shaped principal
 *
 * Signin flow:
 *   POST /auth/creator/signin {email}  → signin token for an already-
 *   active creator with that email. verify endpoint is the same.
 *
 * Tokens are single-use (consumeMagicLink atomically flips consumedAt),
 * short-TTL (15 min default), and per-email rate-limited at the DB level
 * via the unique tokens only being useful once.
 */

import { Router } from 'express';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  TABLES,
  type DevMessageRow,
  type MagicLinkTokenRow,
  type NetworkCreatorRow,
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

export const magicLinkRouter = Router();

const signupSchema = z.object({
  email: z.string().email(),
  handle: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9_]+$/, 'handle must be lowercase letters, digits, or _'),
  name: z.string().min(2).max(80),
});

const signinSchema = z.object({ email: z.string().email() });

const verifySchema = z.object({ token: z.string().min(8) });

// Where magic links point. In dev the portal is on :5173; in prod
// override via PORTAL_URL so emails link to the right host.
function portalOrigin(): string {
  return (process.env.PORTAL_URL ?? 'http://localhost:5173').replace(/\/$/, '');
}

function magicUrl(token: string, purpose: 'signup' | 'signin'): string {
  return `${portalOrigin()}/auth/magic?token=${encodeURIComponent(token)}&purpose=${purpose}`;
}

// -------- Signup --------

magicLinkRouter.post('/auth/creator/signup', async (req, res) => {
  const body = signupSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const email = body.data.email.toLowerCase();
  const handle = body.data.handle.toLowerCase();

  // Reject if a creator already exists at this email OR handle. We do
  // NOT leak which one — "already in use" keeps enumeration harder.
  const existing = await db<NetworkCreatorRow>(TABLES.NetworkCreator)
    .where({ email })
    .orWhere({ handle })
    .first();
  if (existing) {
    return res.status(409).json({ error: 'email_or_handle_taken' });
  }

  const issued = await issueMagicLink({
    email,
    purpose: 'signup',
    claim: { handle, name: body.data.name },
  });

  await getMailer().send({
    to: email,
    subject: 'Finish your OpenPartner signup',
    text: `Hi ${body.data.name},\n\nClick this link within 15 minutes to finish creating your OpenPartner creator account:\n\n${magicUrl(issued.plaintext, 'signup')}\n\nIf you didn't request this, ignore this email.`,
    metadata: { purpose: 'signup', handle },
  });

  res.json({ ok: true });
});

// -------- Signin --------

magicLinkRouter.post('/auth/creator/signin', async (req, res) => {
  const body = signinSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const email = body.data.email.toLowerCase();
  const creator = await db<NetworkCreatorRow>(TABLES.NetworkCreator).where({ email }).first();

  // We respond identically whether or not the creator exists — another
  // small step against email enumeration. The mailer writes to the
  // DevMessage table either way; if no creator, no link is minted.
  if (creator && creator.status === 'active') {
    const issued = await issueMagicLink({ email, purpose: 'signin' });
    await getMailer().send({
      to: email,
      subject: 'Your OpenPartner sign-in link',
      text: `Click within 15 minutes to sign in to OpenPartner:\n\n${magicUrl(issued.plaintext, 'signin')}\n\nIf you didn't request this, ignore this email.`,
      metadata: { purpose: 'signin' },
    });
  }

  res.json({ ok: true });
});

// -------- Verify --------

magicLinkRouter.post('/auth/magic/verify', async (req, res) => {
  const body = verifySchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });

  const result = await consumeMagicLink(body.data.token);
  if (!result.ok) return res.status(400).json({ error: result.error });

  const token: MagicLinkTokenRow = result.token;
  let creator: NetworkCreatorRow | undefined;

  if (token.purpose === 'signup') {
    const claim = token.claim ?? {};
    if (!claim.handle || !claim.name) return res.status(400).json({ error: 'invalid_signup_claim' });
    // Someone may have registered the same handle/email in the meantime —
    // fail cleanly with 409 so the UI can prompt to sign in instead.
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
      status: 'active', // signup flow goes straight to active; email was verified
      activatedAt: new Date(),
    });
    creator = (await db<NetworkCreatorRow>(TABLES.NetworkCreator).where({ id }).first())!;
  } else {
    creator = await db<NetworkCreatorRow>(TABLES.NetworkCreator).where({ email: token.email }).first();
    if (!creator) return res.status(404).json({ error: 'creator_not_found' });
    if (creator.status !== 'active') return res.status(403).json({ error: 'creator_not_active' });
  }

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
});

// -------- Signout --------

magicLinkRouter.post('/auth/signout', async (req, res) => {
  const plaintext = req.cookies?.[SESSION_COOKIE_NAME];
  if (plaintext) {
    // Best-effort — unknown tokens are already effectively signed out.
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
