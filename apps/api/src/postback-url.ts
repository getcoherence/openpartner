/**
 * Partner postback URLs, sealed at rest.
 *
 * A PartnerPostback's `url` is the partner's tracker callback, and partners
 * are told to put the tracker's shared secret in it (`?secret=…`), since
 * classic postbacks aren't signed (partner-postback.ts). Firing needs the
 * URL itself, so a hash won't do: it is sealed with AES-256-GCM under
 * SECRETS_ENCRYPTION_KEY (crypto.ts), the same envelope as partner payout
 * details and webhook signing secrets.
 *
 *   - Opened in three places only: the dispatcher, to fire it; GET
 *     /partners/:id/postbacks/:postbackId/url, for the partner who owns it
 *     (never an admin) to edit it; and the export, which carries it opened
 *     (docs/data-portability.md "Partner postback URLs").
 *   - Every other response carries `urlPreview` instead (maskPostbackUrl:
 *     scheme, host and `name={macro}` pairs; the path and everything else
 *     masked), which is stored in the clear so listing never opens a URL.
 *   - Nothing here logs, and opening never throws: a failure reads as
 *     "unreadable" and says nothing else.
 *
 * A stored `url` is one of:
 *   - a sealed envelope (base64), the normal case;
 *   - a plaintext URL: a row from before sealing, one a SQL-dump restore
 *     wrote, or one written while this process was in its deploy grace
 *     (storedPostbackUrl). The dispatcher fires it as it is, and the sweep
 *     seals it (sealPlaintextPostbackUrls: ten minutes after startup, then
 *     hourly). An absolute URL always has a `:` after its scheme and base64
 *     never does, so the two can't be confused;
 *   - an envelope this deployment can't open (sealed under another key).
 *     That postback fails every fire until the partner enters the URL
 *     again.
 */

import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';
import { decryptSecret, encryptSecret } from './crypto.js';
import { sealDelaySeconds } from './webhook-secret.js';

export function sealPostbackUrl(url: string): string {
  return encryptSecret(url);
}

/** Is this stored value still in the clear? */
export function isPlaintextPostbackUrl(stored: string): boolean {
  return stored.includes(':');
}

/**
 * The URL a stored `url` holds, or null when it can't be opened (sealed
 * under another key, or damaged). Never throws.
 */
export function openPostbackUrl(stored: string): string | null {
  if (isPlaintextPostbackUrl(stored)) return stored;
  try {
    const url = decryptSecret(stored);
    return isPlaintextPostbackUrl(url) ? url : null;
  } catch {
    return null;
  }
}

const MASK = '•••';

/**
 * Every {macro} the dispatcher fills (PostbackContext in
 * partner-postback.ts, which checks the two lists match). Only these count
 * as template in a preview: an unknown {name} stays literal when the
 * postback fires, so it could be the partner's own secret.
 */
export const POSTBACK_MACROS = [
  'click_id',
  'partner_id',
  'commission_id',
  'commission_amount',
  'currency',
  'event_id',
  'event_type',
  'program_id',
  'payout_id',
  'transaction_id',
  'bonus_id',
  'bounty_id',
  'bonus_amount',
  'sub_id',
  'status',
  'sale_amount',
] as const;

const KNOWN_MACRO = new Set<string>(POSTBACK_MACROS.map((m) => `{${m}}`));
/** A parameter name shown as it is. Anything else (percent-encoded, long,
 *  odd characters) could be a token posing as a name. */
const PLAIN_NAME = /^[A-Za-z0-9_.[\]-]{1,40}$/;

/**
 * A postback URL with whatever could be the tracker's secret masked, for
 * anyone but its partner to look at:
 *
 *   https://t.example/v1/pb?cid={click_id}&key=abc123&TOKEN#x
 *     → https://t.example/•••?cid={click_id}&•••&•••#•••
 *
 * The scheme and host show which tracker it is, and each `name={macro}`
 * pair for a macro the dispatcher fills shows how the template maps them.
 * Everything else is masked: the whole path, because some trackers
 * (Keitaro, webhook catchers) put their key there; every other query pair,
 * name and all, because a tracker key can be a parameter name as easily as
 * a value; any userinfo; and the fragment.
 */
export function maskPostbackUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return MASK;
  }
  const userinfo = parsed.username || parsed.password ? `${MASK}@` : '';
  const path = parsed.pathname === '/' || parsed.pathname === '' ? '/' : `/${MASK}`;

  // The query as written, not as URL re-encodes it, so {macros} stay
  // readable.
  const hashAt = raw.indexOf('#');
  const queryAt = raw.indexOf('?');
  const hasQuery = queryAt !== -1 && (hashAt === -1 || queryAt < hashAt);
  const query = hasQuery
    ? raw
        .slice(queryAt + 1, hashAt === -1 ? undefined : hashAt)
        .split('&')
        .map((pair) => {
          if (pair === '') return '';
          const eq = pair.indexOf('=');
          const name = pair.slice(0, eq);
          return eq !== -1 && PLAIN_NAME.test(name) && KNOWN_MACRO.has(pair.slice(eq + 1)) ? pair : MASK;
        })
        .join('&')
    : null;

  return `${parsed.protocol}//${userinfo}${parsed.host}${path}${query === null ? '' : `?${query}`}${hashAt === -1 ? '' : `#${MASK}`}`;
}

/**
 * A row's preview. For a sealed row, the stored one. For a plaintext row
 * the sweep hasn't reached yet, the mask of what is stored (no opening
 * involved), since its stored preview may be stale: a build from before
 * sealing edits `url` and leaves `urlPreview` alone. Null for an envelope
 * with no preview (one imported from another deployment).
 */
export function postbackUrlPreview(row: { url: string; urlPreview?: string | null }): string | null {
  if (isPlaintextPostbackUrl(row.url)) return maskPostbackUrl(row.url);
  return row.urlPreview ?? null;
}

/**
 * The `url` and `urlPreview` columns to write for a URL a partner (or an
 * import) just gave. Sealed, unless this process is in its deploy grace
 * (webhook-secret.ts SEAL_AFTER_UPTIME_S): the previous build may still be
 * serving, and it fires whatever `url` holds, so a sealed value would go
 * out as a broken request. Then the plaintext is stored and the deferred
 * startup sweep seals it.
 *
 * Process uptime stands for "the previous build has stopped" because the
 * API runs as one instance replaced in place (.do/app.yaml instance_count
 * 1; Compose stops the old container first). A rollout that kept an old
 * replica serving for longer than the grace would need a deployment-wide
 * switch instead.
 */
export function storedPostbackUrl(url: string): { url: string; urlPreview: string } {
  return {
    url: sealDelaySeconds() > 0 ? url : sealPostbackUrl(url),
    urlPreview: maskPostbackUrl(url),
  };
}

/** SQL for "this stored value is plaintext" (isPlaintextPostbackUrl). */
const PLAINTEXT_SQL = `position(':' in "url") > 0`;

/**
 * Seal every plaintext postback URL on this deployment, across tenants,
 * `batch` rows at a time, and write its preview, so no partner's tracker
 * secret stays in the clear for long after a SQL-dump restore (or the
 * deploy that introduced sealing). Run ten minutes after startup
 * (server.ts) and hourly (scheduler.ts, via runSealPostbackUrlsJob).
 * Conditional on `url` being unchanged, so an edit that landed in between
 * is kept. Idempotent: a sealed value never matches again. `db` must be
 * the privileged pool: it reads every tenant. Returns how many rows it
 * sealed; logs nothing.
 */
export async function sealPlaintextPostbackUrls(db: Knex, batch = 500): Promise<number> {
  let sealed = 0;
  for (;;) {
    const rows = (await db(TABLES.PartnerPostback)
      .whereRaw(PLAINTEXT_SQL)
      .limit(batch)
      .select('id', 'url')) as Array<{ id: string; url: string }>;
    for (const row of rows) {
      sealed += await db(TABLES.PartnerPostback)
        .where({ id: row.id, url: row.url })
        .update({ url: sealPostbackUrl(row.url), urlPreview: maskPostbackUrl(row.url) });
    }
    if (rows.length < batch) return sealed;
  }
}

/** The hourly `seal-postback-urls` job: the sweep, unless this process is
 *  too young to seal (SEAL_AFTER_UPTIME_S). */
export async function runSealPostbackUrlsJob(db: Knex): Promise<{ sealed: number } | { skipped: 'deploy_grace' }> {
  if (sealDelaySeconds() > 0) return { skipped: 'deploy_grace' };
  return { sealed: await sealPlaintextPostbackUrls(db) };
}

// ---------------------------------------------------------------------------
// Portability (export.ts)
// ---------------------------------------------------------------------------

/**
 * Export: `url` opened, because a sealed envelope is useless anywhere but
 * this deployment, and the URL is the partner's data. `urlPreview` stays
 * out: it is derived, and the import derives it again, so the row has the
 * shape it had before sealing. A URL that can't be opened travels as
 * stored.
 */
export function openPostbackForExport(row: Record<string, unknown>): Record<string, unknown> {
  const { urlPreview: _derived, ...rest } = row;
  if (typeof rest.url !== 'string') return rest;
  const url = openPostbackUrl(rest.url);
  return url ? { ...rest, url } : rest;
}

/**
 * JSON import: seal `url` again under this deployment's key (as a
 * partner's own write would be, deploy grace included) and derive its
 * preview. A value that isn't a plaintext URL (an envelope from another
 * deployment) is kept as it came, with no preview, and reads as
 * unreadable.
 */
export function sealPostbackForImport(row: Record<string, unknown>): Record<string, unknown> {
  const { urlPreview: _derived, ...rest } = row;
  if (typeof rest.url !== 'string' || !isPlaintextPostbackUrl(rest.url)) return { ...rest, urlPreview: null };
  return { ...rest, ...storedPostbackUrl(rest.url) };
}
