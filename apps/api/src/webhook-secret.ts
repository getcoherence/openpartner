/**
 * Outbound webhook signing secrets, sealed at rest.
 *
 * A WebhookEndpoint's `secret` is the HMAC key every delivery is signed
 * with (webhook-dispatcher.ts). A hash won't do, because signing needs the
 * key itself. So it is sealed with AES-256-GCM under SECRETS_ENCRYPTION_KEY
 * (crypto.ts), the same envelope as the SMTP password and partner payout
 * details, and opened only when the dispatcher signs a delivery.
 *
 *   - The plaintext leaves the API in two responses only: the one that
 *     creates the endpoint and the one that rotates its secret. Never in a
 *     list or get, an export, a log line or an error message.
 *   - `secretPrefix` (`whsec_` plus 6 characters) stays in the clear so the
 *     admin Webhooks page can tell secrets apart.
 *   - Nothing here logs, and opening never throws: a failure reads as
 *     "unreadable" and says nothing else.
 *
 * A stored `secret` is one of:
 *   - a sealed envelope (base64), the normal case;
 *   - plaintext `whsec_…`: a row from before sealing, or one a SQL-dump
 *     restore wrote (the dump can't encrypt: the key is the app's). The
 *     dispatcher signs with it as it is, and the sweep seals it
 *     (sealPlaintextWebhookSecrets: ten minutes after startup, then
 *     hourly; see SEAL_AFTER_UPTIME_S). Base64 has no `_`, so no envelope
 *     starts with `whsec_`;
 *   - an envelope this deployment can't open (sealed under another key).
 *     Deliveries to that endpoint fail until the brand rotates its secret.
 */

import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';
import { decryptSecret, encryptSecret } from './crypto.js';

/** Every secret this API mints starts with it; no sealed envelope does. */
const PLAINTEXT_PREFIX = 'whsec_';

/** A fresh secret: the plaintext to show once, and its display prefix. */
export function makeSecret(): { plaintext: string; prefix: string } {
  const plaintext = `${PLAINTEXT_PREFIX}${randomBytes(24).toString('base64url')}`;
  return { plaintext, prefix: plaintext.slice(0, 12) };
}

/** A fresh secret plus the sealed form to store. */
export function mintSecret(): { plaintext: string; prefix: string; sealed: string } {
  const secret = makeSecret();
  return { ...secret, sealed: sealSecret(secret.plaintext) };
}

export function sealSecret(plaintext: string): string {
  return encryptSecret(plaintext);
}

/** Is this stored value still in the clear? */
export function isPlaintextSecret(stored: string): boolean {
  return stored.startsWith(PLAINTEXT_PREFIX);
}

/**
 * The signing key for a stored `secret`, or null when it can't be opened
 * (sealed under another key, or damaged). Never throws.
 */
export function openSecret(stored: string): string | null {
  if (isPlaintextSecret(stored)) return stored;
  try {
    return decryptSecret(stored) || null;
  } catch {
    return null;
  }
}

/**
 * How long this process waits after starting before it seals plaintext
 * secrets. In a rolling deploy the previous build keeps serving until the
 * new one is healthy, and a build from before sealing signs with whatever
 * is stored: a secret sealed under it would sign deliveries no receiver
 * can verify. Ten minutes outlasts that overlap. Until then plaintext
 * secrets stay as they are, and this build signs with either form.
 * Partner postback URLs wait out the same grace (postback-url.ts): a build
 * from before they were sealed fires whatever `url` holds.
 */
export const SEAL_AFTER_UPTIME_S = 600;

/** Seconds left before this process may seal (0 once it may). */
export function sealDelaySeconds(): number {
  return Math.max(0, SEAL_AFTER_UPTIME_S - process.uptime());
}

/**
 * Seal one endpoint's plaintext secret in place. Conditional on the value
 * still being `stored`, so a rotation that landed in between is kept.
 * Returns how many rows it sealed (0 or 1).
 */
export async function sealStoredSecret(db: Knex, endpointId: string, stored: string): Promise<number> {
  if (!isPlaintextSecret(stored)) return 0;
  return db(TABLES.WebhookEndpoint)
    .where({ id: endpointId, secret: stored })
    .update({ secret: sealSecret(stored) });
}

/**
 * Seal every plaintext secret on this deployment, across tenants, `batch`
 * rows at a time, so no endpoint's secret stays in the clear for long
 * after a SQL-dump restore (or the deploy that introduced sealing). Run
 * ten minutes after startup (server.ts) and hourly (scheduler.ts, via
 * runSealWebhookSecretsJob). Idempotent: a sealed value never matches
 * again. `db` must be the privileged pool: it reads every tenant. Returns
 * how many rows it sealed; logs nothing.
 */
export async function sealPlaintextWebhookSecrets(db: Knex, batch = 500): Promise<number> {
  let sealed = 0;
  for (;;) {
    const rows = (await db(TABLES.WebhookEndpoint)
      .whereRaw('left("secret", ?) = ?', [PLAINTEXT_PREFIX.length, PLAINTEXT_PREFIX])
      .limit(batch)
      .select('id', 'secret')) as Array<{ id: string; secret: string }>;
    for (const row of rows) sealed += await sealStoredSecret(db, row.id, row.secret);
    if (rows.length < batch) return sealed;
  }
}

/** The hourly `seal-webhook-secrets` job: the sweep, unless this process
 *  is too young to seal (SEAL_AFTER_UPTIME_S). */
export async function runSealWebhookSecretsJob(db: Knex): Promise<{ sealed: number } | { skipped: 'deploy_grace' }> {
  if (sealDelaySeconds() > 0) return { skipped: 'deploy_grace' };
  return { sealed: await sealPlaintextWebhookSecrets(db) };
}
