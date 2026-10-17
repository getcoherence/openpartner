/**
 * One-click unsubscribe for platform-sent, non-essential email (brand setup
 * reminders). Public, no session: the signed token in the link IS the
 * credential (see email-optout.ts).
 *
 *   GET  /email/unsubscribe?t=…  — a confirm page. Never unsubscribes by
 *                                  itself: mail scanners prefetch links.
 *   POST /email/unsubscribe?t=…  — records the opt-out. Also the RFC 8058
 *                                  target the List-Unsubscribe-Post header
 *                                  points mail clients at (they POST
 *                                  `List-Unsubscribe=One-Click`).
 *
 * Mounted before tenantMiddleware; uses the privileged db (EmailOptOut is
 * platform-scoped). Multi- and single-tenant alike — a link already sent
 * keeps working whatever the deployment does next.
 */

import express, { Router, type Response } from 'express';
import { db } from '../db.js';
import { ipRateLimit } from '../middleware/rate-limit.js';
import { optOut, readUnsubscribeToken } from '../email-optout.js';

export const emailPreferencesRouter = Router();

const limit = ipRateLimit({ name: 'email-unsubscribe', max: 30, windowMs: 60_000 });

const SCOPE_COPY = { brand_setup: 'OpenPartner setup reminder emails' } as const;

function page(res: Response, status: number, title: string, body: string, form?: { label: string }): void {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  res
    .status(status)
    .type('html')
    .send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex">
    <title>${esc(title)}</title>
  </head>
  <body style="margin:0; background:#f4f4f5; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color:#1f2937;">
    <div style="max-width:440px; margin:64px auto; padding:0 16px;">
      <div style="background:#fff; border-radius:10px; padding:28px 28px 24px; box-shadow:0 1px 3px rgba(0,0,0,.08);">
        <div style="font-weight:700; font-size:15px; margin-bottom:14px;">OpenPartner</div>
        <h1 style="font-size:19px; margin:0 0 8px;">${esc(title)}</h1>
        <p style="font-size:14px; line-height:1.55; color:#4b5563; margin:0;">${esc(body)}</p>
        ${
          form
            ? `<form method="post" style="margin-top:20px;"><button type="submit" style="background:#2dd4bf; color:#041115; border:0; border-radius:6px; padding:10px 18px; font-weight:600; font-size:14px; cursor:pointer;">${esc(form.label)}</button></form>`
            : ''
        }
      </div>
    </div>
  </body>
</html>`);
}

function tokenOf(req: express.Request): string {
  const q = typeof req.query.t === 'string' ? req.query.t : '';
  const b = req.body && typeof req.body === 'object' && typeof (req.body as { t?: unknown }).t === 'string' ? (req.body as { t: string }).t : '';
  return q || b;
}

emailPreferencesRouter.get('/email/unsubscribe', limit, (req, res) => {
  const parsed = readUnsubscribeToken(tokenOf(req));
  if (!parsed) {
    return page(res, 400, 'This link isn’t valid', 'The unsubscribe link is incomplete or has been changed. Use the link from the most recent email, or reply to that email and we’ll take you off the list.');
  }
  page(
    res,
    200,
    `Unsubscribe from ${SCOPE_COPY[parsed.scope]}?`,
    `${parsed.email} will stop receiving ${SCOPE_COPY[parsed.scope]}. Sign-in links, billing notices, and messages about your account aren’t affected.`,
    { label: 'Unsubscribe' },
  );
});

emailPreferencesRouter.post(
  '/email/unsubscribe',
  limit,
  express.urlencoded({ extended: false, limit: '4kb' }),
  async (req, res) => {
    const parsed = readUnsubscribeToken(tokenOf(req));
    if (!parsed) {
      return page(res, 400, 'This link isn’t valid', 'The unsubscribe link is incomplete or has been changed. Reply to the most recent email and we’ll take you off the list.');
    }
    await optOut(db, parsed.email, parsed.scope);
    page(res, 200, 'You’re unsubscribed', `${parsed.email} won’t receive ${SCOPE_COPY[parsed.scope]} any more.`);
  },
);
