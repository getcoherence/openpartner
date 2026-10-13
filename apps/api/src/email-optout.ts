/**
 * Opt-outs for platform-sent, non-essential email (setup reminders), plus the
 * signed one-click unsubscribe link those emails carry.
 *
 * The token is `base64url(email) . mac` — self-contained, so unsubscribing
 * needs no session and no lookup table, and a forged or edited token fails
 * the MAC. Scoped: opting out of setup reminders never silences sign-in
 * links, billing notices, or anything a brand sends its own partners.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { TABLES, type EmailOptOutRow } from '@openpartner/db';
import { macValue, verifyMac } from './crypto.js';

export type OptOutScope = EmailOptOutRow['scope'];

const MAC_PURPOSE = 'email-unsubscribe';

const normalize = (email: string): string => email.trim().toLowerCase();

export function unsubscribeToken(email: string, scope: OptOutScope): string {
  const payload = `${scope}:${normalize(email)}`;
  return `${Buffer.from(payload).toString('base64url')}.${macValue(MAC_PURPOSE, payload)}`;
}

/** The (email, scope) a token was minted for, or null if it's forged/garbled. */
export function readUnsubscribeToken(token: string): { email: string; scope: OptOutScope } | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  let payload: string;
  try {
    payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!verifyMac(MAC_PURPOSE, payload, token.slice(dot + 1))) return null;
  const sep = payload.indexOf(':');
  const scope = payload.slice(0, sep);
  const email = payload.slice(sep + 1);
  if (scope !== 'brand_setup' || !email.includes('@')) return null;
  return { email, scope };
}

/** Public URL of the unsubscribe page for an address + scope. Served by the
 *  api under the same `/api` prefix the portal uses for platform routes. */
export function unsubscribeUrl(email: string, scope: OptOutScope): string {
  const base = (process.env.PORTAL_URL ?? 'http://localhost:5673').replace(/\/$/, '');
  return `${base}/api/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(email, scope))}`;
}

export async function isOptedOut(db: Knex, email: string, scope: OptOutScope): Promise<boolean> {
  const row = await db<EmailOptOutRow>(TABLES.EmailOptOut).where({ email: normalize(email), scope }).first('id');
  return !!row;
}

/** Idempotent. */
export async function optOut(db: Knex, email: string, scope: OptOutScope): Promise<void> {
  await db(TABLES.EmailOptOut)
    .insert({ id: ulid(), email: normalize(email), scope, createdAt: new Date() })
    .onConflict(['email', 'scope'])
    .ignore();
}
