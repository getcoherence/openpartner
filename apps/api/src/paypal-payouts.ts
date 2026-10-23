/**
 * Pay with PayPal (docs/paypal-payouts.md): a run's pending manual payouts
 * sent through the PayPal Payouts API with the BRAND's own REST app
 * (paypal-connection.ts). It is the PayPal batch file of
 * manual-payout-files.ts without the upload: the same payouts, the same
 * rules (PayPal emails only, PayPal's currencies, no INR, 5,000 a batch,
 * PayPal's per-item limit, nothing on a do-not-pay hold), and the same
 * money flow, brand's PayPal balance → partner's PayPal account.
 * OpenPartner holds nothing and moves nothing; it makes the API call.
 *
 * ## One batch, at most once
 *
 * Sending mirrors the care payout-transfers.ts takes with Stripe:
 *
 *   - **The intent commits first.** One transaction stamps the payouts
 *     (`metadata.manualExport`, `via: 'api'`, compare-and-set, so a payout
 *     is in exactly one file or batch) and writes the PaypalPayoutBatch
 *     row with the request body frozen and sealed. Only after COMMIT does
 *     anything call PayPal, outside any transaction.
 *   - **One id, three uses.** The batch id is PayPal's `sender_batch_id`
 *     and the `PayPal-Request-Id`, and every retry re-sends the SAME
 *     bytes. PayPal "completes a payment only once for a sender_batch_id
 *     that is used within 30 days" and answers a repeated request id with
 *     the batch it already made; a duplicate sender_batch_id comes back
 *     as an error linking the original, which is read back and checked
 *     before it is trusted.
 *   - **Unknown means unknown.** A timeout, a reset, a 5xx, a 429 or a
 *     409 may have created the batch. The batch stays `posted` and the
 *     next pass re-sends it, which can only reach the same batch. Nothing
 *     is released on an unknown outcome.
 *   - **Never past the window.** A `posted` batch is re-sent only within
 *     29 days of its first POST (a day's margin on PayPal's 30). Past that
 *     a re-send could make a second batch, so it is held
 *     (`reconcile_required`) for the admin, who checks their PayPal
 *     account and either links the batch PayPal shows or releases the
 *     payouts.
 *   - **`intent` vs `posted`.** `intent` means no request so far could
 *     have created the batch; `posted` means one might have. A definite
 *     refusal (a 4xx other than 409/429) proves only that THAT request
 *     made nothing: from `intent` the batch fails and its payouts are
 *     released; from `posted` it is held, because an earlier attempt may
 *     have landed. A 401 (stale token) changes nothing and is retried.
 *   - **Lease.** Every post or sync is a compare-and-set on `leaseAt`, so
 *     the scheduler, a webhook and an admin click never act on one batch
 *     at once.
 *
 * ## Status
 *
 * PayPal processes a batch asynchronously. Its webhooks
 * (PAYMENT.PAYOUTSBATCH.*, PAYMENT.PAYOUTS-ITEM.*, verified with PayPal's
 * verify-webhook-signature against the webhook OpenPartner registered,
 * routes/paypal-webhook.ts) and a poll every few minutes both lead to the
 * same thing: a fresh read of the whole batch from PayPal (syncBatch).
 * Nothing acts on a webhook's payload. Per item, matched by
 * `sender_item_id` (the payout id) and only within this batch's payouts:
 *
 *   - SUCCESS: the payout is confirmed (`paid`), with PayPal's item and
 *     transaction ids on its stamp.
 *   - FAILED, RETURNED, BLOCKED, REFUNDED, REVERSED (and a DENIED or
 *     CANCELED batch): the payout goes back to `pending` with no stamp,
 *     free for a new file or batch, its history appended to
 *     `metadata.paypalReleases`; the brand's admins are emailed. A payout
 *     already `paid` whose item is later REFUNDED or REVERSED goes back
 *     to `pending` the same way: the money is back in the brand's
 *     account and the partner is owed again.
 *   - UNCLAIMED: PayPal emailed the partner, who has 30 days to claim it.
 *     The money has left the brand's balance, so the payout is NOT
 *     released (releasing it could pay the partner twice); admins are
 *     emailed. PayPal returns it after 30 days (RETURNED, then released),
 *     or the admin cancels it sooner (cancelUnclaimedPayout), which
 *     releases it once PayPal confirms the return.
 *   - PENDING, ONHOLD, anything else: wait.
 *
 * A batch is `completed` once none of its payouts is pending.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type PaypalBatchState,
  type PaypalConnectionRow,
  type PaypalPayoutBatchRow,
  type PayoutRow,
  type TenantRow,
  type AdminRow,
} from '@openpartner/db';
import { db as privilegedDb } from './db.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { resolveBrandName } from './brand-name.js';
import { majorToCents } from './stripe-amounts.js';
import { withTenantTransaction } from './tenancy.js';
import { getMailer } from './mailer.js';
import { getPortalBaseUrl } from './portal-url.js';
import { paypalBatchAttentionEmail } from './email-templates.js';
import {
  MAX_ROWS,
  PAYPAL_CURRENCIES,
  centsToString,
  paypalNote,
  pickReadyPayouts,
  plainText,
  stampManualPayouts,
  type ManualExportStamp,
  type PaypalItemStamp,
} from './manual-payout-files.js';
import type { PaypalDetails } from './payout-profile.js';
import {
  PaypalApiError,
  cancelPayoutItem,
  createPayoutBatch,
  duplicateBatchLink,
  getPayoutBatch,
  getWholePayoutBatch,
  type PaypalBatch,
  type PaypalBatchHeader,
  type PaypalBatchItem,
  type PaypalCreateBatchRequest,
} from './paypal-api.js';
import { PaypalConnectError, activePaypalConnection, connectionById, paypalAccessToken } from './paypal-connection.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Re-send a `posted` batch only this long after its first POST: PayPal
 *  dedupes a sender_batch_id for 30 days, less a day of margin for the
 *  gap between checking the age and the request arriving. */
export const REPOST_CUTOFF_MS = 29 * DAY_MS;
/** A batch someone is posting or syncing is left alone this long. A
 *  scheduling choice only: safety comes from re-sends reaching the same
 *  batch, not from the lease outliving a request. */
const LEASE_MS = 2 * 60 * 1000;

/** Batches that may still change a payout. */
export const OPEN_STATES: PaypalBatchState[] = ['intent', 'posted', 'submitted', 'reconcile_required'];
/** A webhook may still change these: a paid item can be REFUNDED later. */
const SYNCABLE_STATES: PaypalBatchState[] = ['submitted', 'completed'];

const ITEM_PAID = new Set(['SUCCESS']);
const ITEM_RETURNED = new Set(['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'DENIED', 'CANCELED']);
const BATCH_REFUSED = new Set(['DENIED', 'CANCELED']);

/** PayPal's id on the request: a retry is answered with the batch the
 *  first attempt created. */
export function requestIdFor(batchId: string): string {
  return `openpartner-payout-batch-${batchId}`;
}

/** PayPal's API amount: whole units where it takes no decimals (HUF, JPY,
 *  TWD; rounded, as the batch file does), two decimals otherwise, always
 *  a decimal point. */
export function paypalApiAmount(amount: string, currency: string): string {
  const n = Number(amount);
  return ['HUF', 'JPY', 'TWD'].includes(currency) ? String(Math.round(n)) : n.toFixed(2);
}

export interface PaypalBatchView {
  batchId: string;
  runId: string;
  environment: 'live' | 'sandbox';
  currency: string;
  itemCount: number;
  total: string;
  state: PaypalBatchState;
  /** PayPal's id and status for the batch, once PayPal has it. */
  payoutBatchId: string | null;
  batchStatus: string | null;
  /** Of the batch's payouts: confirmed paid, released back to pending,
   *  unclaimed at PayPal, and still processing. */
  summary: { paid: number; released: number; unclaimed: number; processing: number };
  lastError: string | null;
  createdAt: Date;
  createdBy: 'admin' | 'api';
  completedAt: Date | null;
  lastSyncedAt: Date | null;
}

function view(b: PaypalPayoutBatchRow): PaypalBatchView {
  const s = (b.itemSummary ?? {}) as Record<string, number>;
  return {
    batchId: b.id,
    runId: b.runId,
    environment: b.environment,
    currency: b.currency,
    itemCount: b.itemCount,
    total: Number(b.total).toFixed(2),
    state: b.state,
    payoutBatchId: b.payoutBatchId,
    batchStatus: b.batchStatus,
    summary: { paid: s.paid ?? 0, released: s.released ?? 0, unclaimed: s.unclaimed ?? 0, processing: s.processing ?? 0 },
    lastError: b.lastError,
    createdAt: b.createdAt,
    createdBy: b.createdBy,
    completedAt: b.completedAt,
    lastSyncedAt: b.lastSyncedAt,
  };
}

async function loadBatch(db: Knex, tenantId: string, batchId: string): Promise<PaypalPayoutBatchRow | null> {
  return ((await db<PaypalPayoutBatchRow>(TABLES.PaypalPayoutBatch).where({ tenantId, id: batchId }).first()) as PaypalPayoutBatchRow | undefined) ?? null;
}

export async function getPaypalBatch(db: Knex, tenantId: string, batchId: string): Promise<PaypalBatchView | null> {
  const b = await loadBatch(db, tenantId, batchId);
  return b ? view(b) : null;
}

/** A run's PayPal Payouts batches, newest first. */
export async function listRunPaypalBatches(db: Knex, tenantId: string, runId: string): Promise<PaypalBatchView[]> {
  const rows = (await db<PaypalPayoutBatchRow>(TABLES.PaypalPayoutBatch)
    .where({ tenantId, runId })
    .orderBy('createdAt', 'desc')
    .limit(50)) as PaypalPayoutBatchRow[];
  return rows.map(view);
}

/** What a pass did, for the scheduler log and the tests. */
export interface PaypalPassResult {
  posted: string[];
  submitted: string[];
  ambiguous: string[];
  failed: string[];
  held: string[];
  synced: string[];
  paid: string[];
  released: string[];
  skipped: number;
}

function emptyResult(): PaypalPassResult {
  return { posted: [], submitted: [], ambiguous: [], failed: [], held: [], synced: [], paid: [], released: [], skipped: 0 };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export type SendWithPaypalResult =
  | { ok: true; batch: PaypalBatchView }
  | { ok: false; error: 'paypal_not_connected' | 'nothing_to_send' | 'currency_not_supported' };

/**
 * Send the next PayPal batch of a run, in one currency: the first 5,000
 * pending payouts no file or batch holds whose partner gave a PayPal
 * email (the same payouts a PayPal file would take). Commits the intent,
 * then posts it outside any transaction. A batch whose POST had an
 * unknown outcome comes back `posted` and is retried by the scheduler.
 */
export async function sendRunWithPaypal(
  tenantId: string,
  runId: string,
  currency: string,
  by: 'admin' | 'api',
  opts: { now?: () => Date } = {},
): Promise<SendWithPaypalResult> {
  if (!PAYPAL_CURRENCIES.has(currency)) return { ok: false, error: 'currency_not_supported' };
  const now = opts.now ?? (() => new Date());

  const created = await withTenantTransaction(tenantId, async (trx): Promise<string | 'paypal_not_connected' | 'nothing_to_send'> => {
    const conn = await activePaypalConnection(trx, tenantId);
    if (!conn) return 'paypal_not_connected';
    const picked = await pickReadyPayouts(trx, tenantId, runId, 'paypal', currency, MAX_ROWS.paypal);
    if (picked.length === 0) return 'nothing_to_send';

    const id = ulid();
    const at = now();
    const stamp: ManualExportStamp = { exportId: id, provider: 'paypal', currency, at: at.toISOString(), by, via: 'api' };
    const stamped = await stampManualPayouts(
      trx,
      tenantId,
      picked.map((p) => p.payout.id),
      stamp,
    );
    const rows = picked.filter((p) => stamped.has(p.payout.id));
    if (rows.length === 0) return 'nothing_to_send';

    const brandName = await resolveBrandName(trx, tenantId);
    const note = paypalNote(brandName);
    const request: PaypalCreateBatchRequest = {
      sender_batch_header: {
        sender_batch_id: id,
        email_subject: plainText(brandName ? `You have a payout from ${brandName}` : 'You have a commission payout', 255),
        email_message: note,
      },
      items: rows.map((r) => ({
        recipient_type: 'EMAIL',
        receiver: (r.details as PaypalDetails).email,
        amount: { value: paypalApiAmount(r.payout.amount, currency), currency },
        sender_item_id: r.payout.id,
        note,
        recipient_wallet: 'PAYPAL',
        purpose: 'SERVICES',
      })),
    };
    await trx(TABLES.PaypalPayoutBatch).insert({
      id,
      tenantId,
      connectionId: conn.id,
      environment: conn.environment,
      runId,
      currency,
      itemCount: rows.length,
      total: centsToString(rows.reduce((s, r) => s + majorToCents(r.payout.amount), 0)),
      state: 'intent',
      requestEnc: encryptSecret(JSON.stringify(request)),
      itemSummary: { processing: rows.length },
      createdBy: by,
      createdAt: at,
      updatedAt: at,
    });
    return id;
  });
  if (created === 'paypal_not_connected' || created === 'nothing_to_send') return { ok: false, error: created };

  // The intent is committed: post it on the privileged pool, outside any
  // transaction, scoped to this tenant.
  try {
    await postBatch(privilegedDb, tenantId, created, now(), emptyResult());
  } catch (err) {
    // Left as it is: the scheduler picks it up. Never a reason to release.
    console.error(`[paypal] post of batch ${created} threw; the scheduler retries it`, err instanceof Error ? err.message : err);
  }
  return { ok: true, batch: (await getPaypalBatch(privilegedDb, tenantId, created))! };
}

// ---------------------------------------------------------------------------
// Post
// ---------------------------------------------------------------------------

/** Take the lease on a batch in one of `states`, or null if someone else
 *  holds it (or it moved on). */
async function lease(db: Knex, b: PaypalPayoutBatchRow, states: PaypalBatchState[], now: Date): Promise<PaypalPayoutBatchRow | null> {
  const [row] = (await db(TABLES.PaypalPayoutBatch)
    .where({ id: b.id, tenantId: b.tenantId })
    .whereIn('state', states)
    .andWhere((q) => q.whereNull('leaseAt').orWhere('leaseAt', '<', new Date(now.getTime() - LEASE_MS)))
    .update({ leaseAt: now, updatedAt: now })
    .returning('*')) as PaypalPayoutBatchRow[];
  return row ?? null;
}

/** Move a leased batch on, only if it is still in `from` under OUR lease. */
async function cas(
  db: Knex,
  b: PaypalPayoutBatchRow,
  from: PaypalBatchState[],
  leaseAt: Date,
  patch: Partial<Record<keyof PaypalPayoutBatchRow, unknown>>,
): Promise<PaypalPayoutBatchRow | null> {
  const [row] = (await db(TABLES.PaypalPayoutBatch)
    .where({ id: b.id, tenantId: b.tenantId, leaseAt })
    .whereIn('state', from)
    .update({ ...patch, updatedAt: new Date() })
    .returning('*')) as PaypalPayoutBatchRow[];
  return row ?? null;
}

function openSealed(envelope: string | null): string | null {
  if (!envelope) return null;
  try {
    return decryptSecret(envelope) || null;
  } catch {
    return null;
  }
}

/**
 * Send (or re-send) one batch in `intent` or `posted`. See the header for
 * the rules; every exit leaves the batch in a state the next pass can act
 * on safely.
 */
export async function postBatch(db: Knex, tenantId: string, batchId: string, now: Date, result: PaypalPassResult): Promise<void> {
  const current = await loadBatch(db, tenantId, batchId);
  if (!current || (current.state !== 'intent' && current.state !== 'posted')) return;

  // Past the duplicate window a re-send could make a second batch.
  if (current.state === 'posted' && current.postedAt && now.getTime() - current.postedAt.getTime() > REPOST_CUTOFF_MS) {
    const held = await lease(db, current, ['posted'], now);
    if (!held) return;
    await cas(db, held, ['posted'], now, {
      state: 'reconcile_required',
      requestEnc: null,
      leaseAt: null,
      lastError: 'PayPal never confirmed this batch, and it is too old to re-send safely. Check your PayPal account.',
    });
    result.held.push(batchId);
    await alertAdmins(db, tenantId, { kind: 'held', batch: held, items: [] });
    return;
  }

  const b = await lease(db, current, ['intent', 'posted'], now);
  if (!b) {
    result.skipped += 1;
    return;
  }
  const prior = b.state;
  const conn = await connectionById(db, tenantId, b.connectionId);

  let token: string;
  try {
    if (!conn) throw new PaypalConnectError('not_connected', 'The PayPal connection is gone');
    token = await paypalAccessToken(db, conn);
  } catch (err) {
    const credentials = err instanceof PaypalConnectError;
    const message = credentials ? err.message : 'Could not reach PayPal for a token; retrying.';
    if (credentials && prior === 'intent') {
      // Nothing was ever sent: fail it and free the payouts.
      await failBatch(db, b, now, `Not sent: ${message}`, result);
    } else {
      await cas(db, b, [prior], now, { lastError: message });
      result.ambiguous.push(batchId);
    }
    return;
  }

  const body = openSealed(b.requestEnc);
  if (!body) {
    if (prior === 'intent') await failBatch(db, b, now, 'Not sent: the frozen request can’t be read on this deployment.', result);
    else {
      await cas(db, b, ['posted'], now, {
        state: 'reconcile_required',
        leaseAt: null,
        lastError: 'The frozen request can’t be read, so it can’t be re-sent. Check your PayPal account.',
      });
      result.held.push(batchId);
      await alertAdmins(db, tenantId, { kind: 'held', batch: b, items: [] });
    }
    return;
  }

  // From here a request may land: the batch is `posted` before the POST,
  // and postedAt (first time only) anchors PayPal's 30-day window.
  const armed = await cas(db, b, [prior], now, {
    state: 'posted',
    attempts: db.raw('"attempts" + 1'),
    postedAt: db.raw('coalesce("postedAt", ?)', [now]),
  });
  if (!armed) return;
  result.posted.push(batchId);

  let header: PaypalBatchHeader;
  try {
    header = (await createPayoutBatch(armed.environment, token, requestIdFor(armed.id), body)).batch_header;
  } catch (err) {
    if (!(err instanceof PaypalApiError)) {
      await cas(db, armed, ['posted'], now, { lastError: 'Unexpected error sending the batch; retrying.' });
      result.ambiguous.push(batchId);
      throw err;
    }
    const linked = duplicateBatchLink(err);
    if (linked) {
      // A batch with our sender_batch_id exists. Never a reason to fail:
      // adopt it if it reads back as ours, retry if it can't be read, and
      // hold it if PayPal points at someone else's.
      const found = await readOwnBatch(armed, token, linked);
      if (found === 'unreadable') {
        await cas(db, armed, ['posted'], now, { lastError: 'PayPal says the batch exists but it couldn’t be read yet; retrying.' });
        result.ambiguous.push(batchId);
      } else if (found) {
        await markSubmitted(db, armed, now, found, result);
      } else {
        await cas(db, armed, ['posted'], now, {
          state: 'reconcile_required',
          leaseAt: null,
          lastError: 'PayPal says this batch id is already used, by a batch that isn’t this one. Check your PayPal account.',
        });
        result.held.push(batchId);
        await alertAdmins(db, tenantId, { kind: 'held', batch: armed, items: [] });
      }
      return;
    }
    if (err.transient) {
      await cas(db, armed, ['posted'], now, { lastError: `Outcome unknown, retrying: ${err.summary}` });
      result.ambiguous.push(batchId);
      return;
    }
    if (err.status === 401) {
      // A stale token: PayPal didn't authenticate the request, so it made
      // nothing. Back to where it was, with a fresh token next time.
      await db(TABLES.PaypalConnection).where({ id: armed.connectionId, tenantId }).update({ accessTokenEnc: null, accessTokenExpiresAt: null });
      await cas(db, armed, ['posted'], now, { state: prior, lastError: 'PayPal refused the token; retrying with a new one.' });
      result.ambiguous.push(batchId);
      return;
    }
    if (prior === 'intent') {
      await failBatch(db, armed, now, `PayPal refused the batch: ${err.summary}`, result);
    } else {
      await cas(db, armed, ['posted'], now, {
        state: 'reconcile_required',
        leaseAt: null,
        lastError: `PayPal refused a re-send (${err.summary}), and an earlier attempt may have gone through. Check your PayPal account.`,
      });
      result.held.push(batchId);
      await alertAdmins(db, tenantId, { kind: 'held', batch: armed, items: [] });
    }
    return;
  }
  await markSubmitted(db, armed, now, header, result);
}

/** Read the batch an error linked: its header if it is ours, null if it
 *  is someone else's, 'unreadable' if PayPal couldn't be asked. */
async function readOwnBatch(b: PaypalPayoutBatchRow, token: string, payoutBatchId: string): Promise<PaypalBatchHeader | null | 'unreadable'> {
  try {
    const found = await getPayoutBatch(b.environment, token, payoutBatchId);
    return found.batch_header?.sender_batch_header?.sender_batch_id === b.id ? found.batch_header : null;
  } catch {
    return 'unreadable';
  }
}

async function markSubmitted(db: Knex, b: PaypalPayoutBatchRow, leaseAt: Date, header: PaypalBatchHeader, result: PaypalPassResult): Promise<void> {
  const done = await cas(db, b, ['posted', 'reconcile_required'], leaseAt, {
    state: 'submitted',
    payoutBatchId: header.payout_batch_id,
    batchStatus: header.batch_status ?? null,
    requestEnc: null,
    leaseAt: null,
    lastError: null,
    nextSyncAt: new Date(Date.now() + 60_000),
  });
  if (!done) return;
  await db(TABLES.Payout)
    .where({ tenantId: b.tenantId })
    .whereRaw(`metadata->'manualExport'->>'exportId' = ?`, [b.id])
    .update({ metadata: db.raw(`jsonb_set(metadata, '{manualExport,payoutBatchId}', to_jsonb(?::text))`, [header.payout_batch_id]) });
  result.submitted.push(b.id);
}

/** A batch PayPal never got (or refused outright): fail it, THEN free its
 *  payouts. In that order: a batch still `intent`/`posted` with released
 *  payouts could be re-sent and pay them twice. A crash in between leaves
 *  stamps on a failed batch, which repairReleasedStamps frees. */
async function failBatch(db: Knex, b: PaypalPayoutBatchRow, leaseAt: Date, message: string, result: PaypalPassResult): Promise<void> {
  const failed = await cas(db, b, ['intent', 'posted'], leaseAt, { state: 'failed', requestEnc: null, leaseAt: null, lastError: message.slice(0, 500) });
  if (!failed) return;
  const released = await releaseAllPending(db, failed, 'not_sent', message);
  await updateSummary(db, failed);
  result.failed.push(b.id);
  await alertAdmins(db, b.tenantId, { kind: 'failed', batch: failed, items: released });
}

// ---------------------------------------------------------------------------
// Release and confirm
// ---------------------------------------------------------------------------

interface AlertItem {
  payoutId: string;
  partnerId: string;
  amount: string;
  currency: string;
  status: string;
  error: string | null;
}

function releaseRecord(batchId: string, reason: string, item: PaypalItemStamp | null, detail?: string): string {
  return JSON.stringify({
    batchId,
    reason,
    at: new Date().toISOString(),
    itemId: item?.itemId ?? null,
    status: item?.status ?? null,
    error: item?.error ?? null,
    ...(detail ? { detail: detail.slice(0, 300) } : {}),
  });
}

const RELEASE_SQL = `(metadata - 'manualExport') || jsonb_build_object('paypalReleases', coalesce(metadata->'paypalReleases', '[]'::jsonb) || jsonb_build_array(?::jsonb))`;

/** Every pending payout still stamped with this batch: unstamped, its
 *  history recorded. Idempotent. */
async function releaseAllPending(db: Knex, b: PaypalPayoutBatchRow, reason: string, detail?: string): Promise<AlertItem[]> {
  const rows = (await db(TABLES.Payout)
    .where({ tenantId: b.tenantId, method: 'manual', status: 'pending' })
    .whereRaw(`metadata->'manualExport'->>'exportId' = ?`, [b.id])
    .update({ metadata: db.raw(RELEASE_SQL, [releaseRecord(b.id, reason, null, detail)]) })
    .returning(['id', 'partnerId', 'amount', 'currency'])) as Array<Pick<PayoutRow, 'id' | 'partnerId' | 'amount' | 'currency'>>;
  return rows.map((r) => ({ payoutId: r.id, partnerId: r.partnerId, amount: r.amount, currency: r.currency, status: reason, error: null }));
}

/** One payout of this batch back to pending (from pending, or from paid
 *  when PayPal later refunded or reversed it). */
async function releaseOne(db: Knex, b: PaypalPayoutBatchRow, payout: PayoutRow, item: PaypalItemStamp, reason: string): Promise<boolean> {
  const n = await db(TABLES.Payout)
    .where({ id: payout.id, tenantId: b.tenantId, method: 'manual', status: payout.status })
    .whereRaw(`metadata->'manualExport'->>'exportId' = ?`, [b.id])
    .update({ status: 'pending', completedAt: null, metadata: db.raw(RELEASE_SQL, [releaseRecord(b.id, reason, item)]) });
  return n > 0;
}

async function confirmOne(db: Knex, b: PaypalPayoutBatchRow, payout: PayoutRow, item: PaypalItemStamp, at: Date): Promise<boolean> {
  const n = await db(TABLES.Payout)
    .where({ id: payout.id, tenantId: b.tenantId, method: 'manual', status: 'pending' })
    .whereRaw(`metadata->'manualExport'->>'exportId' = ?`, [b.id])
    .update({
      status: 'paid',
      completedAt: at,
      metadata: db.raw(`jsonb_set(metadata, '{manualExport,paypal}', ?::jsonb)`, [JSON.stringify(item)]),
    });
  return n > 0;
}

async function restamp(db: Knex, b: PaypalPayoutBatchRow, payout: PayoutRow, item: PaypalItemStamp): Promise<void> {
  await db(TABLES.Payout)
    .where({ id: payout.id, tenantId: b.tenantId })
    .whereRaw(`metadata->'manualExport'->>'exportId' = ?`, [b.id])
    .update({ metadata: db.raw(`jsonb_set(metadata, '{manualExport,paypal}', ?::jsonb)`, [JSON.stringify(item)]) });
}

function itemStamp(item: PaypalBatchItem): PaypalItemStamp {
  return {
    itemId: item.payout_item_id,
    status: item.transaction_status ?? 'PENDING',
    transactionId: item.transaction_id ?? null,
    amount: item.payout_item?.amount?.value ?? null,
    currency: item.payout_item?.amount?.currency ?? null,
    error: item.errors?.name ?? null,
  };
}

/** Recount the batch's payouts into itemSummary. */
async function updateSummary(db: Knex, b: PaypalPayoutBatchRow): Promise<{ pending: number; summary: PaypalBatchView['summary'] }> {
  const rows = (await db(TABLES.Payout)
    .where({ tenantId: b.tenantId })
    .whereRaw(`metadata->'manualExport'->>'exportId' = ?`, [b.id])
    .groupBy('status')
    .groupByRaw(`metadata->'manualExport'->'paypal'->>'status'`)
    .select('status', db.raw(`metadata->'manualExport'->'paypal'->>'status' as "itemStatus"`), db.raw('count(*)::int as n'))) as Array<{
    status: string;
    itemStatus: string | null;
    n: number;
  }>;
  let paid = 0;
  let unclaimed = 0;
  let processing = 0;
  for (const r of rows) {
    if (r.status === 'paid') paid += r.n;
    else if (r.status === 'pending' && r.itemStatus === 'UNCLAIMED') unclaimed += r.n;
    else if (r.status === 'pending') processing += r.n;
  }
  const summary = { paid, released: Math.max(0, b.itemCount - paid - unclaimed - processing), unclaimed, processing };
  await db(TABLES.PaypalPayoutBatch).where({ id: b.id, tenantId: b.tenantId }).update({ itemSummary: summary });
  return { pending: unclaimed + processing, summary };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** When to look again: soon while PayPal is working, rarely while only
 *  unclaimed items wait (they take up to 30 days). */
function nextSync(now: Date, b: PaypalPayoutBatchRow, processing: number): Date {
  const age = now.getTime() - (b.postedAt ?? b.createdAt).getTime();
  const wait = processing === 0 ? 6 * 60 * 60 * 1000 : age < 60 * 60 * 1000 ? 2 * 60 * 1000 : age < DAY_MS ? 15 * 60 * 1000 : 60 * 60 * 1000;
  return new Date(now.getTime() + wait);
}

/**
 * Read a submitted (or completed) batch back from PayPal and apply every
 * item's status to its payout (see the header). Only payouts stamped with
 * this batch, in this batch's tenant, are ever touched, whatever ids
 * PayPal lists.
 */
export async function syncBatch(db: Knex, tenantId: string, batchId: string, now: Date, result: PaypalPassResult): Promise<void> {
  const current = await loadBatch(db, tenantId, batchId);
  if (!current || !SYNCABLE_STATES.includes(current.state) || !current.payoutBatchId) return;
  const b = await lease(db, current, SYNCABLE_STATES, now);
  if (!b) {
    result.skipped += 1;
    return;
  }
  const conn = await connectionById(db, tenantId, b.connectionId);
  let remote: PaypalBatch;
  try {
    if (!conn) throw new PaypalConnectError('not_connected', 'The PayPal connection is gone');
    const token = await paypalAccessToken(db, conn);
    remote = await getWholePayoutBatch(b.environment, token, b.payoutBatchId!);
  } catch (err) {
    const message =
      err instanceof PaypalConnectError ? err.message : err instanceof PaypalApiError ? `Couldn’t read the batch from PayPal: ${err.summary}` : 'Couldn’t read the batch from PayPal';
    await cas(db, b, SYNCABLE_STATES, now, { leaseAt: null, lastError: message, nextSyncAt: new Date(now.getTime() + 15 * 60 * 1000) });
    return;
  }

  const senderBatchId = remote.batch_header?.sender_batch_header?.sender_batch_id;
  if (senderBatchId && senderBatchId !== b.id) {
    await cas(db, b, SYNCABLE_STATES, now, {
      state: 'reconcile_required',
      leaseAt: null,
      lastError: 'PayPal returned a different batch for this id. Check your PayPal account.',
    });
    result.held.push(b.id);
    await alertAdmins(db, tenantId, { kind: 'held', batch: b, items: [] });
    return;
  }

  const batchStatus = remote.batch_header?.batch_status ?? null;
  const items = new Map<string, PaypalBatchItem>();
  for (const it of remote.items ?? []) {
    const sid = it.payout_item?.sender_item_id;
    if (sid && it.payout_item_id) items.set(sid, it);
  }

  const ours = (await db<PayoutRow>(TABLES.Payout)
    .where({ tenantId, method: 'manual' })
    .whereIn('status', ['pending', 'paid'])
    .whereRaw(`metadata->'manualExport'->>'exportId' = ?`, [b.id])) as PayoutRow[];

  const attention: AlertItem[] = [];
  const refused = batchStatus !== null && BATCH_REFUSED.has(batchStatus);
  for (const p of ours) {
    const it = items.get(p.id);
    const before = ((p.metadata as { manualExport?: ManualExportStamp }).manualExport?.paypal ?? null) as PaypalItemStamp | null;
    const alertOf = (st: PaypalItemStamp): AlertItem => ({ payoutId: p.id, partnerId: p.partnerId, amount: p.amount, currency: p.currency, status: st.status, error: st.error });

    if (!it) {
      // A refused batch never paid anything, listed or not.
      if (refused && p.status === 'pending') {
        const st: PaypalItemStamp = { itemId: '', status: batchStatus!, transactionId: null, amount: null, currency: null, error: null };
        if (await releaseOne(db, b, p, st, 'batch_refused')) {
          result.released.push(p.id);
          attention.push(alertOf(st));
        }
      }
      continue;
    }
    const st = itemStamp(it);
    if (ITEM_PAID.has(st.status)) {
      if (p.status === 'pending') {
        const at = it.time_processed && !Number.isNaN(Date.parse(it.time_processed)) ? new Date(it.time_processed) : now;
        if (await confirmOne(db, b, p, st, at)) result.paid.push(p.id);
      } else if (before?.status !== st.status || before?.transactionId !== st.transactionId) {
        await restamp(db, b, p, st);
      }
    } else if (ITEM_RETURNED.has(st.status) || (refused && p.status === 'pending')) {
      if (await releaseOne(db, b, p, st, st.status.toLowerCase())) {
        result.released.push(p.id);
        attention.push(alertOf(st));
      }
    } else if (p.status === 'pending' && (before?.status !== st.status || before?.itemId !== st.itemId || before?.error !== st.error)) {
      await restamp(db, b, p, st);
      if (st.status === 'UNCLAIMED' && before?.status !== 'UNCLAIMED') attention.push(alertOf(st));
    }
  }

  const { pending, summary } = await updateSummary(db, b);
  const finished = pending === 0;
  await cas(db, b, SYNCABLE_STATES, now, {
    state: finished ? (refused ? 'denied' : 'completed') : b.state === 'completed' ? 'completed' : 'submitted',
    batchStatus,
    leaseAt: null,
    lastError: null,
    lastSyncedAt: now,
    completedAt: finished ? (b.completedAt ?? now) : null,
    nextSyncAt: finished ? null : nextSync(now, b, summary.processing),
  });
  result.synced.push(b.id);
  if (attention.length > 0) await alertAdmins(db, tenantId, { kind: 'items', batch: b, items: attention });
}

// ---------------------------------------------------------------------------
// Admin actions
// ---------------------------------------------------------------------------

export type CancelUnclaimedResult =
  | { ok: true; released: boolean; status: string }
  | { ok: false; error: 'payout_not_found' | 'not_unclaimed' | 'paypal_unreachable' | 'not_connected' };

/**
 * Cancel an UNCLAIMED item so PayPal returns the money to the brand now
 * rather than after 30 days, then release the payout. If PayPal says the
 * item isn't unclaimed any more (the partner just claimed it), the batch
 * is synced instead and the payout follows what PayPal says.
 */
export async function cancelUnclaimedPayout(tenantId: string, payoutId: string, opts: { now?: () => Date } = {}): Promise<CancelUnclaimedResult> {
  const db = privilegedDb;
  const now = (opts.now ?? (() => new Date()))();
  const payout = (await db<PayoutRow>(TABLES.Payout).where({ tenantId, id: payoutId, method: 'manual', status: 'pending' }).first()) as PayoutRow | undefined;
  const stamp = (payout?.metadata as { manualExport?: ManualExportStamp } | undefined)?.manualExport;
  if (!payout || stamp?.via !== 'api') return { ok: false, error: 'payout_not_found' };
  const b = await loadBatch(db, tenantId, stamp.exportId);
  if (!b || stamp.paypal?.status !== 'UNCLAIMED' || !stamp.paypal.itemId) return { ok: false, error: 'not_unclaimed' };
  const conn = await connectionById(db, tenantId, b.connectionId);
  if (!conn || conn.disconnectedAt) return { ok: false, error: 'not_connected' };

  let item: PaypalBatchItem;
  try {
    item = await cancelPayoutItem(b.environment, await paypalAccessToken(db, conn), stamp.paypal.itemId);
  } catch (err) {
    if (err instanceof PaypalApiError && err.kind === 'http' && !err.transient) {
      // ITEM_INCORRECT_STATUS / ITEM_ALREADY_CANCELLED: read what it is now.
      await syncBatch(db, tenantId, b.id, now, emptyResult());
      const after = (await db<PayoutRow>(TABLES.Payout).where({ tenantId, id: payoutId }).first()) as PayoutRow;
      const st = (after.metadata as { manualExport?: ManualExportStamp }).manualExport?.paypal?.status ?? after.status;
      return { ok: true, released: after.status === 'pending' && !(after.metadata as { manualExport?: unknown }).manualExport, status: st };
    }
    return { ok: false, error: 'paypal_unreachable' };
  }
  const st = itemStamp(item);
  const released = ITEM_RETURNED.has(st.status) && (await releaseOne(db, b, payout, st, 'unclaimed_canceled'));
  // Read the batch back either way: it may now be finished.
  await syncBatch(db, tenantId, b.id, now, emptyResult());
  return { ok: true, released, status: st.status };
}

export type ResolveAction = { action: 'retry' } | { action: 'release' } | { action: 'link'; payoutBatchId: string };
export type ResolveResult =
  | { ok: true; batch: PaypalBatchView }
  | { ok: false; error: 'batch_not_found' | 'not_resolvable' | 'not_retryable' | 'batch_not_ours' | 'paypal_unreachable' | 'not_connected' };

/**
 * The admin settles a batch OpenPartner couldn't (`reconcile_required`),
 * or abandons one that was never sent (`intent`):
 *
 *   - `retry`: re-send the same request. Only within 29 days of the first
 *     POST, where PayPal still dedupes it.
 *   - `link`: the admin found the batch in their PayPal account; it is
 *     read back and adopted only if its sender_batch_id is this batch's.
 *   - `release`: the admin checked PayPal and no such batch went out; the
 *     payouts go back to pending. Their word, recorded as such.
 */
export async function resolvePaypalBatch(tenantId: string, batchId: string, input: ResolveAction, opts: { now?: () => Date } = {}): Promise<ResolveResult> {
  const db = privilegedDb;
  const now = (opts.now ?? (() => new Date()))();
  const current = await loadBatch(db, tenantId, batchId);
  if (!current) return { ok: false, error: 'batch_not_found' };
  const allowed: PaypalBatchState[] = input.action === 'release' ? ['reconcile_required', 'intent'] : ['reconcile_required'];
  if (!allowed.includes(current.state)) return { ok: false, error: 'not_resolvable' };
  const b = await lease(db, current, allowed, now);
  if (!b) return { ok: false, error: 'not_resolvable' };

  if (input.action === 'release') {
    const released = await cas(db, b, allowed, now, { state: 'released', resolution: 'released', requestEnc: null, leaseAt: null, completedAt: now });
    if (!released) return { ok: false, error: 'not_resolvable' };
    await releaseAllPending(db, released, 'released_by_admin');
    await updateSummary(db, released);
  } else if (input.action === 'retry') {
    if (!b.requestEnc || (b.postedAt && now.getTime() - b.postedAt.getTime() > REPOST_CUTOFF_MS)) {
      await cas(db, b, allowed, now, { leaseAt: null });
      return { ok: false, error: 'not_retryable' };
    }
    await cas(db, b, allowed, now, { state: 'posted', leaseAt: null, lastError: null });
    await postBatch(db, tenantId, batchId, now, emptyResult());
  } else {
    const conn = await connectionById(db, tenantId, b.connectionId);
    if (!conn || conn.disconnectedAt) {
      await cas(db, b, allowed, now, { leaseAt: null });
      return { ok: false, error: 'not_connected' };
    }
    let header: PaypalBatchHeader | null;
    try {
      header = await readOwnBatchStrict(b, await paypalAccessToken(db, conn), input.payoutBatchId);
    } catch {
      await cas(db, b, allowed, now, { leaseAt: null });
      return { ok: false, error: 'paypal_unreachable' };
    }
    if (!header) {
      await cas(db, b, allowed, now, { leaseAt: null });
      return { ok: false, error: 'batch_not_ours' };
    }
    const r = emptyResult();
    await markSubmitted(db, b, now, header, r);
    await db(TABLES.PaypalPayoutBatch).where({ id: b.id, tenantId }).update({ resolution: 'linked' });
    await syncBatch(db, tenantId, batchId, now, r);
  }
  return { ok: true, batch: (await getPaypalBatch(db, tenantId, batchId))! };
}

/** Like readOwnBatch, but a failed read throws (the admin is told PayPal
 *  couldn't be reached) instead of reading as "not ours". */
async function readOwnBatchStrict(b: PaypalPayoutBatchRow, token: string, payoutBatchId: string): Promise<PaypalBatchHeader | null> {
  if (!/^[A-Za-z0-9]{1,64}$/.test(payoutBatchId)) return null;
  try {
    const found = await getPayoutBatch(b.environment, token, payoutBatchId);
    return found.batch_header?.sender_batch_header?.sender_batch_id === b.id ? found.batch_header : null;
  } catch (err) {
    if (err instanceof PaypalApiError && err.status === 404) return null;
    throw err;
  }
}

/** Sync one batch now (the admin's "Check status", or a webhook). */
export async function syncPaypalBatchNow(db: Knex, tenantId: string, batchId: string, opts: { now?: () => Date } = {}): Promise<PaypalBatchView | null> {
  const now = (opts.now ?? (() => new Date()))();
  const b = await loadBatch(db, tenantId, batchId);
  if (!b) return null;
  if (b.state === 'intent' || b.state === 'posted') await postBatch(db, tenantId, batchId, now, emptyResult());
  else await syncBatch(db, tenantId, batchId, now, emptyResult());
  return getPaypalBatch(db, tenantId, batchId);
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/**
 * Release pending payouts still stamped with a batch that ended without
 * paying them (failed, denied, released): the state moves first and the
 * payouts follow, so a crash in between leaves stamps to free here.
 */
async function repairReleasedStamps(db: Knex, now: Date): Promise<number> {
  const ended = (await db<PaypalPayoutBatchRow>(TABLES.PaypalPayoutBatch)
    .whereIn('state', ['failed', 'denied', 'released'])
    .where('updatedAt', '>', new Date(now.getTime() - 2 * DAY_MS))
    .limit(200)) as PaypalPayoutBatchRow[];
  let n = 0;
  for (const b of ended) n += (await releaseAllPending(db, b, b.state === 'released' ? 'released_by_admin' : 'not_sent')).length;
  return n;
}

/**
 * The `paypal-payouts` job: post batches waiting to go out (or whose last
 * attempt had an unknown outcome), sync batches PayPal is processing,
 * and free stamps a crash left behind. Runs on the privileged pool across
 * tenants; every query carries the batch's own tenantId.
 */
export async function runPaypalPayoutsJob(db: Knex = privilegedDb, opts: { now?: () => Date } = {}): Promise<PaypalPassResult & { repaired: number }> {
  const now = (opts.now ?? (() => new Date()))();
  const result = emptyResult();
  const stale = new Date(now.getTime() - LEASE_MS);

  const toPost = (await db<PaypalPayoutBatchRow>(TABLES.PaypalPayoutBatch)
    .whereIn('state', ['intent', 'posted'])
    .andWhere((q) => q.whereNull('leaseAt').orWhere('leaseAt', '<', stale))
    .orderByRaw('coalesce("leaseAt", "createdAt") asc')
    .limit(100)
    .select('id', 'tenantId')) as Array<{ id: string; tenantId: string }>;
  for (const b of toPost) {
    try {
      await postBatch(db, b.tenantId, b.id, now, result);
    } catch (err) {
      console.error(`[paypal] post pass error on batch ${b.id}`, err instanceof Error ? err.message : err);
    }
  }

  const toSync = (await db<PaypalPayoutBatchRow>(TABLES.PaypalPayoutBatch)
    .where({ state: 'submitted' })
    .andWhere((q) => q.whereNull('nextSyncAt').orWhere('nextSyncAt', '<=', now))
    .andWhere((q) => q.whereNull('leaseAt').orWhere('leaseAt', '<', stale))
    .orderByRaw('coalesce("nextSyncAt", "createdAt") asc')
    .limit(100)
    .select('id', 'tenantId')) as Array<{ id: string; tenantId: string }>;
  for (const b of toSync) {
    try {
      await syncBatch(db, b.tenantId, b.id, now, result);
    } catch (err) {
      console.error(`[paypal] sync pass error on batch ${b.id}`, err instanceof Error ? err.message : err);
    }
  }

  return { ...result, repaired: await repairReleasedStamps(db, now) };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

interface Alert {
  kind: 'failed' | 'held' | 'items';
  batch: PaypalPayoutBatchRow;
  items: AlertItem[];
}

/** Email the brand's active admins about a batch that needs a look. A
 *  mail failure is logged and never undoes what the sync did. */
async function alertAdmins(db: Knex, tenantId: string, alert: Alert): Promise<void> {
  try {
    const tenant = (await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first()) as TenantRow | undefined;
    const admins = (await db<AdminRow>(TABLES.Admin)
      .where({ tenantId })
      .whereNotNull('activatedAt')
      .whereNull('revokedAt')
      .select('id', 'email')) as Array<Pick<AdminRow, 'id' | 'email'>>;
    if (admins.length === 0) return;
    const partnerIds = [...new Set(alert.items.map((i) => i.partnerId))];
    const names = new Map(
      partnerIds.length > 0
        ? ((await db(TABLES.Partner).where({ tenantId }).whereIn('id', partnerIds.slice(0, 1000)).select('id', 'name')) as Array<{ id: string; name: string }>).map(
            (p) => [p.id, p.name],
          )
        : [],
    );
    const tmpl = paypalBatchAttentionEmail({
      brandName: await resolveBrandName(db, tenantId),
      kind: alert.kind,
      environment: alert.batch.environment,
      batchId: alert.batch.id,
      lastError: alert.kind === 'items' ? null : ((await loadBatch(db, tenantId, alert.batch.id))?.lastError ?? null),
      items: alert.items.map((i) => ({ partnerName: names.get(i.partnerId) ?? 'A partner', amount: i.amount, currency: i.currency, status: i.status, error: i.error })),
      payoutsUrl: `${getPortalBaseUrl(tenant ? { slug: tenant.slug, customDomain: tenant.customDomain } : null)}/payouts`,
    });
    for (const admin of admins) {
      try {
        await getMailer().send(
          { db, tenantId },
          { to: admin.email, subject: tmpl.subject, text: tmpl.text, html: tmpl.html, tag: 'paypal_payouts', metadata: { purpose: 'paypal_payouts', batchId: alert.batch.id, adminId: admin.id } },
        );
      } catch (err) {
        console.error('[paypal] admin alert failed', { batchId: alert.batch.id, adminId: admin.id, err: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    console.error('[paypal] admin alert failed', { batchId: alert.batch.id, err: err instanceof Error ? err.message : String(err) });
  }
}

export const __testing = { postBatch, syncBatch, emptyResult };
export type { PaypalConnectionRow };
