/**
 * Two-step sign-in (two-factor.ts, docs/two-step-sign-in.md).
 *
 * Signing in with two-step on (no requireAuth: the session isn't anyone's
 * until the code is in):
 *   POST /auth/two-factor/verify      a brand session waiting for its code
 *   POST /auth/platform-two-factor    an OpenPartner account session, the same
 *
 * The signed-in admin's own authenticator (a person's, so sessions only):
 *   GET  /auth/two-factor                 on or off, codes left, brand rule
 *   POST /auth/two-factor/setup           a new secret to scan
 *   POST /auth/two-factor/enable          its first code turns it on
 *   POST /auth/two-factor/disable         a code turns it off
 *   POST /auth/two-factor/recovery-codes  a code makes new recovery codes
 *
 * The brand's rule:
 *   GET/POST /config/admin-security  { requireTwoFactor }
 *
 * Turning it on or off ends the person's other sessions and mails them.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { Knex } from 'knex';
import { z } from '../zod.js';
import { DEFAULT_TENANT_ID, TABLES, type AdminRow } from '@openpartner/db';
import { db as platformDb } from '../db.js';
import { requireAdmin, requireAuth } from '../auth.js';
import { resolvePendingSession, SESSION_COOKIE_NAME } from '../auth-sessions.js';
import { recordSignin } from '../audit-log.js';
import { twoFactorChangedEmail } from '../email-templates.js';
import { getMailer } from '../mailer.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { failureKey } from '../passwords.js';
import { PLATFORM_SESSION_COOKIE, resolvePendingPlatformSession, resolvePlatformSession } from '../platform-sessions.js';
import { getTenancyMode, tenantOf } from '../tenancy.js';
import {
  checkCode,
  clearSecondFactor,
  codeFailures,
  confirmSetup,
  endOtherSessions,
  finishPendingSignIn,
  getAdminSecurity,
  passSecondFactor,
  regenerateRecoveryCodes,
  removeTwoFactor,
  reserveCodeAttempt,
  setAdminSecurity,
  startSetup,
  twoFactorStatus,
  wrongCode,
  type CodeKind,
  type SessionTable,
} from '../two-factor.js';

export const twoFactorRouter = Router();
export const platformTwoFactorRouter = Router();

const codeSchema = z.object({ code: z.string().trim().min(6).max(32) });
const verifyLimit = ipRateLimit({ name: 'two-factor-verify', max: 30, windowMs: 60_000 });

function cookieOf(req: Request, name: string): string | undefined {
  return (req as unknown as { cookies?: Record<string, string> }).cookies?.[name];
}

/** One key per person, whichever sessions or IPs the guesses come from. */
function failuresKey(email: string): string {
  return failureKey('two-factor', email);
}

/**
 * Check a code against a pending session. Both limits are spent before the
 * code is looked at (the person's in memory, the session's in its row), so
 * parallel guesses can't each slip in under them; a right code gives the
 * person's back. Answers the request unless the code was right.
 */
async function checkPendingCode(
  res: Response,
  db: Knex,
  table: SessionTable,
  sessionId: string,
  email: string,
  code: string,
): Promise<CodeKind | null> {
  if (!codeFailures.hit(failuresKey(email))) {
    res.status(429).json({ error: 'too_many_attempts' });
    return null;
  }
  const spent = await reserveCodeAttempt(db, table, sessionId);
  if (spent === null) {
    res.status(401).json({ error: 'too_many_attempts' });
    return null;
  }
  const kind = await checkCode(email, code);
  if (!kind) {
    const left = await wrongCode(db, table, sessionId, spent);
    if (left > 0) res.status(400).json({ error: 'invalid_code', attemptsLeft: left });
    else res.status(401).json({ error: 'too_many_attempts' });
    return null;
  }
  codeFailures.reset(failuresKey(email));
  if (!(await finishPendingSignIn(db, table, sessionId))) {
    res.status(401).json({ error: 'no_pending_sign_in' });
    return null;
  }
  return kind;
}

// ---------- Entering the code at sign-in ----------

twoFactorRouter.post('/auth/two-factor/verify', verifyLimit, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = codeSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body' });
  const cookie = cookieOf(req, SESSION_COOKIE_NAME);
  const session = cookie ? await resolvePendingSession(db, cookie, tenantId) : null;
  if (!session) return res.status(401).json({ error: 'no_pending_sign_in' });
  const admin = await db<AdminRow>(TABLES.Admin).where({ id: session.principalId, tenantId }).first();
  if (!admin || admin.revokedAt) return res.status(401).json({ error: 'no_pending_sign_in' });

  const kind = await checkPendingCode(res, db, TABLES.Session, session.id, admin.email, body.data.code);
  if (!kind) return;
  await recordSignin(db, { tenantId, adminId: admin.id, email: admin.email, ip: req.ip ?? null, via: 'link', secondFactor: kind });
  res.json({ ok: true, role: 'admin', admin: { id: admin.id, email: admin.email, name: admin.name }, usedRecoveryCode: kind === 'recovery_code' });
});

platformTwoFactorRouter.post('/auth/platform-two-factor', verifyLimit, async (req, res) => {
  const body = codeSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body' });
  const cookie = cookieOf(req, PLATFORM_SESSION_COOKIE);
  const session = cookie ? await resolvePendingPlatformSession(platformDb, cookie) : null;
  if (!session) return res.status(401).json({ error: 'no_pending_sign_in' });

  const kind = await checkPendingCode(res, platformDb, TABLES.PlatformSession, session.id, session.email, body.data.code);
  if (!kind) return;
  res.json({ ok: true, kind: 'platform', email: session.email, usedRecoveryCode: kind === 'recovery_code' });
});

// ---------- The admin's own authenticator ----------

/** Two-step belongs to a person: API keys get 403 here. */
function requireAdminSession(req: Request, res: Response, next: NextFunction): void {
  const p = req.principal;
  if (p?.role === 'admin' && p.source === 'session') return next();
  res.status(403).json({ error: 'session_required', detail: 'Two-step sign-in belongs to a person. Sign in to the portal to set it up.' });
}

async function signedInAdmin(req: Request): Promise<AdminRow> {
  const { db, tenantId } = tenantOf(req);
  const p = req.principal as Extract<NonNullable<Request['principal']>, { source: 'session'; role: 'admin' }>;
  const admin = await db<AdminRow>(TABLES.Admin).where({ id: p.adminId, tenantId }).first();
  if (!admin) throw new Error('signed-in admin not found');
  return admin;
}

function sessionIdOf(req: Request): string {
  return (req.principal as { sessionId: string }).sessionId;
}

/** Platform mail, like a password reset: the setting covers every brand
 *  the person admins, so no one brand's mail provider carries it. */
async function sendNotice(email: string, change: 'enabled' | 'disabled' | 'recovery_codes'): Promise<void> {
  try {
    const multi = getTenancyMode() === 'multi';
    const { resolveBrandName } = await import('../brand-name.js');
    const tmpl = twoFactorChangedEmail(change, multi ? null : await resolveBrandName(platformDb, DEFAULT_TENANT_ID));
    await getMailer().send({ db: platformDb, tenantId: DEFAULT_TENANT_ID }, {
      to: email,
      subject: tmpl.subject,
      text: tmpl.text,
      html: tmpl.html,
      tag: 'two_factor_changed',
      metadata: { purpose: 'two_factor_changed', change, email },
      platform: multi,
    });
  } catch (err) {
    console.error('[two-factor] notice mail failed', { email, change, err });
  }
}

const own = [requireAuth, requireAdmin, requireAdminSession] as const;

twoFactorRouter.get('/auth/two-factor', ...own, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const admin = await signedInAdmin(req);
  const p = req.principal as { secondFactor: boolean };
  res.json({
    ...(await twoFactorStatus(admin.email)),
    // This session proved a code.
    verified: p.secondFactor,
    requiredByBrand: (await getAdminSecurity(db, tenantId)).requireTwoFactor,
  });
});

twoFactorRouter.post('/auth/two-factor/setup', ...own, async (req, res) => {
  const admin = await signedInAdmin(req);
  const setup = await startSetup(admin.email);
  if (setup === 'already_enabled') return res.status(409).json({ error: 'already_enabled' });
  res.setHeader('Cache-Control', 'no-store');
  res.json(setup);
});

twoFactorRouter.post('/auth/two-factor/enable', ...own, async (req, res) => {
  const body = codeSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body' });
  const { db } = tenantOf(req);
  const admin = await signedInAdmin(req);
  // This browser's OpenPartner account session, read while two-step is
  // still off: once it's on, a session that never proved a code no longer
  // resolves.
  const platformCookie = cookieOf(req, PLATFORM_SESSION_COOKIE);
  const platform = platformCookie ? await resolvePlatformSession(platformDb, platformCookie) : null;
  const keepPlatform = platform?.email === admin.email.toLowerCase() ? platform : null;

  if (!codeFailures.hit(failuresKey(admin.email))) return res.status(429).json({ error: 'too_many_attempts' });
  const result = await confirmSetup(admin.email, body.data.code);
  if (result === 'invalid_code') return res.status(400).json({ error: 'invalid_code' });
  if (typeof result === 'string') return res.status(409).json({ error: result });
  codeFailures.reset(failuresKey(admin.email));

  // This browser just proved a code: its brand session, and its OpenPartner
  // account session when it has one for this person, count as two-step.
  await passSecondFactor(db, TABLES.Session, sessionIdOf(req));
  if (keepPlatform) await passSecondFactor(platformDb, TABLES.PlatformSession, keepPlatform.id);
  await endOtherSessions(admin.email, { sessionId: sessionIdOf(req), platformSessionId: keepPlatform?.id });
  await sendNotice(admin.email, 'enabled');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ recoveryCodes: result.recoveryCodes });
});

/** A code from the authenticator or a recovery code, for turning it off or
 *  making new recovery codes. Answers and returns false when it's wrong. */
async function provedCode(req: Request, res: Response, email: string): Promise<boolean> {
  const body = codeSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'invalid_body' });
    return false;
  }
  if (!(await twoFactorStatus(email)).enabled) {
    res.status(409).json({ error: 'not_enabled' });
    return false;
  }
  // Spent before the check, as at sign-in (checkPendingCode).
  if (!codeFailures.hit(failuresKey(email))) {
    res.status(429).json({ error: 'too_many_attempts' });
    return false;
  }
  if (!(await checkCode(email, body.data.code))) {
    res.status(400).json({ error: 'invalid_code' });
    return false;
  }
  codeFailures.reset(failuresKey(email));
  return true;
}

twoFactorRouter.post('/auth/two-factor/disable', ...own, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const admin = await signedInAdmin(req);
  // The brand's rule outranks the person's wish (another brand's rule asks
  // for setup there, below).
  if ((await getAdminSecurity(db, tenantId)).requireTwoFactor) return res.status(409).json({ error: 'required_by_brand' });
  if (!(await provedCode(req, res, admin.email))) return;
  await removeTwoFactor(admin.email);
  const platformCookie = cookieOf(req, PLATFORM_SESSION_COOKIE);
  const platform = platformCookie ? await resolvePlatformSession(platformDb, platformCookie) : null;
  const keepPlatform = platform?.email === admin.email.toLowerCase() ? platform : null;
  await endOtherSessions(admin.email, { sessionId: sessionIdOf(req), platformSessionId: keepPlatform?.id });
  // The sessions kept no longer count as two-step: entering a brand that
  // requires it asks for setup rather than taking their old proof.
  await clearSecondFactor(db, TABLES.Session, sessionIdOf(req));
  if (keepPlatform) await clearSecondFactor(platformDb, TABLES.PlatformSession, keepPlatform.id);
  await sendNotice(admin.email, 'disabled');
  res.json({ ok: true });
});

twoFactorRouter.post('/auth/two-factor/recovery-codes', ...own, async (req, res) => {
  const admin = await signedInAdmin(req);
  if (!(await provedCode(req, res, admin.email))) return;
  const recoveryCodes = await regenerateRecoveryCodes(admin.email);
  await sendNotice(admin.email, 'recovery_codes');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ recoveryCodes });
});

// ---------- The brand's rule ----------

const adminSecuritySchema = z.object({ requireTwoFactor: z.boolean() });

twoFactorRouter.get('/config/admin-security', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  res.json(await getAdminSecurity(db, tenantId));
});

twoFactorRouter.post('/config/admin-security', requireAuth, requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const body = adminSecuritySchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: 'invalid_body', detail: body.error.flatten() });
  // Whoever turns the rule on goes first, so they can't lock themselves
  // into setup by accident.
  const p = req.principal!;
  if (body.data.requireTwoFactor && p.role === 'admin' && p.source === 'session' && !p.secondFactor) {
    return res.status(409).json({ error: 'two_factor_not_enabled', detail: 'Turn on two-step sign-in for yourself first.' });
  }
  await setAdminSecurity(db, tenantId, body.data);
  res.json(body.data);
});
