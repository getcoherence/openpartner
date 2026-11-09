/**
 * The brand's audit log (docs/audit-log.md): what its admins and API keys
 * did, and when.
 *
 * requireAuth calls auditRequest for every request it lets through. A write
 * (and each read in AUDITED_READS) queues one AuditLog row, written in the
 * request's own transaction just before it commits (tenancy.ts
 * beforeCommit) and only when the response succeeded, so a change can't
 * land without its entry and a refused one leaves none. Partners' own
 * requests aren't logged; neither is NOT_AUDITED, the traffic that isn't an
 * admin's decision (conversion data, message threads, previews).
 *
 * Every write route behind requireAuth has a label here or a reason in
 * NOT_AUDITED; __tests__/audit-log.test.ts walks the app and fails on a
 * route with neither.
 *
 * Bodies are never stored: only the names of their top-level fields, since
 * they carry passwords, secrets and payout details. A route that wants the
 * values of a change on record calls auditChanges with the row as it was.
 */

import type { Request, Response } from 'express';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { TABLES, type AdminRow, type ApiKeyRow, type AuditActorKind, type AuditLogRow } from '@openpartner/db';
import { beforeCommit } from './tenancy.js';
import { routeKey } from './view-only.js';

/** What each logged action reads as, keyed on the route as registered (or
 *  an event name). Past tense, from the actor's side. */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  signin: 'Signed in',
  'PUT /auth/password': 'Changed their password',

  'POST /admins': 'Added an admin',
  'PATCH /admins/:id': 'Changed an admin',
  'POST /admins/:id/invite': 'Resent an admin invite',
  'POST /admins/:id/revoke': 'Removed an admin',
  'POST /admins/:id/reinstate': 'Reinstated an admin',
  'POST /api-keys': 'Created an API key',
  'POST /api-keys/scoped': 'Created a scoped API key',
  'DELETE /api-keys/:keyId': 'Revoked an API key',

  'POST /programs': 'Created a program',
  'PATCH /programs/:id': 'Updated a program',
  'DELETE /programs/:id': 'Deleted a program',
  'POST /bounties': 'Created a bounty',
  'PATCH /bounties/:id': 'Updated a bounty',
  'POST /bonuses': 'Awarded a bonus',

  'POST /partners': 'Added a partner',
  'PATCH /partners/:id': 'Updated a partner',
  'POST /partners/:id/invite': 'Invited a partner',
  'POST /partners/:id/revoke': 'Revoked a partner',
  'POST /partners/:id/reinstate': 'Reinstated a partner',
  'POST /partners/:id/programs': 'Added a partner to a program',
  'DELETE /partners/:id/programs/:programId': 'Removed a partner from a program',
  'PUT /partners/:id/programs/:programId/commission': "Set a partner's program commission",
  'DELETE /partners/:id/programs/:programId/commission': "Cleared a partner's program commission",
  'PUT /partners/:id/commission-snapshot': "Set a partner's commission",
  'DELETE /partners/:id/commission-snapshot': "Cleared a partner's commission",
  'POST /partners/backfill-commission-snapshots': 'Snapshotted partner commissions',
  'POST /partners/:id/links': 'Created a link',
  'POST /partners/:id/coupons': 'Added a coupon code',
  'DELETE /partners/:id/coupons/:couponId': 'Removed a coupon code',
  'POST /partners/:id/api-keys': 'Created a partner API key',
  'POST /partners/:id/connect/start': 'Started Stripe Connect for a partner',
  'POST /partners/:id/connect/update': "Opened a partner's Stripe payout details",
  'PUT /partners/:id/payout-profile': "Changed a partner's payout details",
  'DELETE /partners/:id/payout-profile': "Removed a partner's payout details",
  'POST /partners/:id/postbacks': 'Added a partner postback',
  'PATCH /partners/:id/postbacks/:postbackId': 'Changed a partner postback',
  'DELETE /partners/:id/postbacks/:postbackId': 'Removed a partner postback',
  'POST /import/partners-csv': 'Imported partners',

  'POST /commissions/:id/approve': 'Approved a commission',
  'POST /commissions/:id/reverse': 'Reversed a commission',
  'POST /clicks/:id/flag': 'Flagged a click',
  'POST /clicks/:id/unflag': 'Cleared a click flag',

  'POST /payouts/run': 'Ran payouts',
  'POST /payouts/confirm': 'Marked payouts sent',
  'POST /payouts/:id/confirm': 'Marked a payout sent',
  'POST /payouts/runs/:runId/exports': 'Made a payout file',
  'POST /payouts/exports/:exportId/confirm': 'Confirmed a payout file',
  'POST /payouts/exports/:exportId/discard': 'Discarded a payout file',
  'POST /payouts/runs/:runId/paypal-batches': 'Sent payouts with PayPal',
  'POST /payouts/paypal-batches/:batchId/resolve': 'Resolved a PayPal batch',
  'POST /payouts/:id/paypal-cancel': 'Cancelled a PayPal payout',
  'POST /payouts/:id/recovery': 'Asked to recover a payout',
  'POST /funding/batches/:id/recovery': 'Asked to recover a funding batch',
  'POST /funding/transfers/:id/recovery': 'Asked to recover a funding transfer',
  'POST /billing/funding/setup': 'Started payout funding setup',
  'POST /billing/funding/complete': 'Set up payout funding',
  'POST /billing/funding/revoke': 'Turned off payout funding',

  'POST /webhooks': 'Added a webhook',
  'PATCH /webhooks/:id': 'Changed a webhook',
  'DELETE /webhooks/:id': 'Deleted a webhook',
  'POST /webhooks/:id/secret': 'Rotated a webhook secret',
  'POST /webhooks/:id/deliveries/:deliveryId/retry': 'Retried a webhook delivery',
  'PATCH /conversion-postback': 'Changed the conversion postback',
  'POST /conversion-postback/token': 'Rotated the postback token',
  'DELETE /conversion-postback/token': 'Retired the postback token',
  'POST /stripe-app/connection/start': 'Started connecting Stripe',
  'POST /stripe-app/connection/complete': 'Connected Stripe',
  'DELETE /stripe-app/connection': 'Disconnected Stripe',
  'POST /config/paypal': 'Connected a PayPal app',
  'DELETE /config/paypal/:environment': 'Disconnected a PayPal app',
  'POST /config/paypal/:environment/activate': 'Switched the PayPal environment',
  'POST /config/paypal/:environment/verify': 'Checked a PayPal app',
  'POST /config/paypal/:environment/payments': 'Changed PayPal payment tracking',
  'POST /config/paypal-payments': 'Connected PayPal payments',
  'DELETE /config/paypal-payments/:environment': 'Disconnected PayPal payments',
  'POST /config/paypal-payouts': 'Changed Pay with PayPal',

  'POST /config/program': 'Changed program settings',
  'POST /config/partner-signup': 'Changed the join page',
  'POST /config/partner-access': 'Changed partner portal access',
  'POST /config/payouts': 'Changed payout settings',
  'POST /config/stripe-connect': 'Changed Stripe Connect settings',
  'POST /config/payout-statements': 'Changed payout statements',
  'POST /config/referrals': 'Changed referral stages',
  'POST /config/tracking-alerts': 'Changed tracking alerts',
  'POST /config/mail': 'Changed email settings',
  'POST /config/onboarding': 'Changed onboarding',
  'POST /config/domain': 'Added a custom domain',
  'POST /config/domain/:id/verify': 'Verified a custom domain',
  'DELETE /config/domain/:id': 'Removed a custom domain',
  'POST /uploads/logo': 'Changed the logo',
  'POST /uploads/favicon': 'Changed the favicon',
  'POST /uploads/program-cover': 'Changed a program cover',
  'POST /uploads/brand-asset': 'Uploaded a brand image',
  'POST /brand-resources/images': 'Added a brand image',
  'POST /brand-resources/snippets': 'Added a text snippet',
  'PATCH /brand-resources/:id': 'Changed a brand resource',
  'DELETE /brand-resources/:id': 'Deleted a brand resource',
  'POST /brand-resources/reorder': 'Reordered brand resources',

  'POST /billing/plan': 'Changed the plan',
  'POST /billing/invoice-subscription': 'Switched to paying by invoice',
  'PUT /billing/tax-details': 'Changed tax details',
  'POST /billing/white-label': 'Added white label',
  'DELETE /billing/white-label': 'Removed white label',
  'PUT /account/location': 'Set the business location',
  'POST /account/delete': 'Asked to delete the account',
  'POST /account/restore': 'Cancelled the account deletion',
  'POST /import': 'Imported data',

  'POST /config/network': 'Changed Network settings',
  'POST /config/network/start-connect': 'Started connecting the Network',
  'POST /config/network/complete-connect': 'Connected the Network',
  'POST /config/network/auto-enroll': 'Changed Network auto-enroll',
  'POST /config/network/authorize-bonuses': 'Authorized Network bonuses',
  'POST /config/network/backfill': 'Sent partners to the Network',
  'POST /admin/network/offerings': 'Created a Network listing',
  'PATCH /admin/network/offerings/:id': 'Changed a Network listing',
  'DELETE /admin/network/offerings/:id': 'Deleted a Network listing',
  'POST /admin/network/offerings/:id/invite-creator': 'Invited a creator to a listing',
  'POST /admin/network/creator-invites': 'Invited a creator',
  'DELETE /admin/network/creator-invites/:id': 'Withdrew a creator invite',
  'POST /admin/network/requests/:id/approve': 'Approved a creator application',
  'POST /admin/network/requests/:id/reject': 'Declined a creator application',
  'POST /admin/network/bookings': 'Asked to book a creator',
  'POST /admin/network/bookings/claim': 'Claimed a booking',
  'POST /admin/network/bookings/:id/approve': 'Approved a booking',
  'POST /admin/network/bookings/:id/cancel': 'Cancelled a booking',
  'POST /admin/network/bookings/:id/track': 'Started tracking a booking',
  'POST /admin/network/bookings/:id/schedule': 'Proposed new booking dates',
  'POST /admin/network/bookings/:id/schedule/accept': 'Accepted new booking dates',
  'POST /admin/network/bookings/:id/schedule/decline': 'Declined new booking dates',
  'DELETE /admin/network/bookings/:id/schedule': 'Withdrew proposed booking dates',
  'POST /admin/network/bookings/:id/draft/approve': 'Approved a booking draft',
  'POST /admin/network/bookings/:id/draft/changes': 'Asked for changes to a booking draft',
  'PATCH /admin/network/bookings/:id/report-sharing': "Changed a booking report's sharing",
  'POST /admin/network/bookings/:id/report/shares': 'Shared a booking report',
  'POST /admin/network/bookings/:id/report/shares/:shareId/revoke': 'Revoked a booking report link',
  'PATCH /admin/network/report-sharing': 'Changed report sharing',

  'GET /export.json': 'Downloaded the data export',
  'GET /export.sql': 'Downloaded the SQL export',
  'GET /export/:table.:format': 'Downloaded a table export',
  'GET /payouts/exports/:exportId.csv': 'Downloaded a payout file',
  'GET /partners/:id/payout-profile': "Viewed a partner's payout details",
  'GET /partners/:id/postbacks/:postbackId/url': "Revealed a partner's postback URL",
  'GET /audit-log.csv': 'Downloaded the audit log',
};

/** Reads that are logged: they hand over bulk data or credentials rather
 *  than show what the portal shows. */
export const AUDITED_READS: ReadonlySet<string> = new Set([
  'GET /export.json',
  'GET /export.sql',
  'GET /export/:table.:format',
  'GET /payouts/exports/:exportId.csv',
  'GET /partners/:id/payout-profile',
  'GET /partners/:id/postbacks/:postbackId/url',
  'GET /audit-log.csv',
]);

const PARTNERS_OWN = "a partner's own profile and applications; admins don't reach it";

/** Writes behind requireAuth that aren't logged, and why. */
export const NOT_AUDITED: Readonly<Record<string, string>> = {
  'POST /attribution/events': 'conversion data, kept as Event rows',
  'POST /attribution/conversions': 'conversion data, kept as Event rows',
  'POST /attribution/refunds': 'refund data, kept as Event rows',
  'POST /clicks': 'click data, kept as Click rows',
  'POST /coupons/redeem': 'conversion data, kept as Event rows',
  'POST /billing/report-usage': 'usage metering',
  'POST /network/notify-recipients': 'the Network asking who to notify; changes nothing',
  'POST /partners/signin-link': 'kept in PartnerSigninLinkLog, one per partner portal visit',
  'POST /partners/:id/signin-link': 'kept in PartnerSigninLinkLog, one per partner portal visit',
  'POST /admin/network/heartbeat': 'keeps the Network listing current',
  'POST /admin/network/conversations': 'a message thread with a creator, kept on the Network',
  'POST /admin/network/conversations/:id/messages': 'a message to a creator, kept on the Network',
  'POST /admin/network/conversations/:id/attachments': 'a message to a creator, kept on the Network',
  'POST /admin/network/conversations/:id/realtime': 'opens live updates for a thread',
  'POST /admin/network/bookings/:id/sync': 'refreshes a booking from the Network',
  'POST /admin/network/bookings/:id/recheck': 'refreshes a booking from the Network',
  'POST /admin/network/bookings/:id/report/refresh': 'refreshes a booking report',
  'POST /payouts/paypal-batches/:batchId/sync': "refreshes a batch from PayPal's status",
  'POST /payouts/runs/:runId/paypal-batches/quote': 'a quote; changes nothing',
  'POST /billing/checkout': 'opens Stripe Checkout; the plan changes only once paid',
  'POST /billing/portal': 'opens the Stripe billing portal',
  'POST /admin/network/billing/checkout': 'opens Stripe Checkout; the plan changes only once paid',
  'POST /admin/network/billing/portal': 'opens the Stripe billing portal',
  'POST /admin/network/bookings/:id/checkout': 'opens Stripe Checkout for a booking',
  'POST /config/mail/test': 'sends a test email',
  'POST /webhooks/:id/test': 'sends a test delivery',
  'POST /admin/tracking-health/test-click': 'a test click, never partner traffic',
  'POST /network/me/consent': PARTNERS_OWN,
  'PATCH /network/me/profile': PARTNERS_OWN,
  'POST /network/me/cover/youtube': PARTNERS_OWN,
  'POST /network/me/uploads/avatar': PARTNERS_OWN,
  'POST /network/me/uploads/cover': PARTNERS_OWN,
  'PUT /network/me/platforms/:platform': PARTNERS_OWN,
  'DELETE /network/me/platforms/:platform': PARTNERS_OWN,
  'POST /network/me/platforms/:platform/verify': PARTNERS_OWN,
  'POST /network/me/platforms/:platform/verify/start': PARTNERS_OWN,
  'POST /network/me/requests/:id/cancel': PARTNERS_OWN,
  'POST /network/offerings/:id/apply': PARTNERS_OWN,
};

/** At most this many field names per entry, each cut to FIELD_NAME_MAX. */
const MAX_FIELDS = 50;
const FIELD_NAME_MAX = 64;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set once auditRequest has queued this request's entry. */
      auditQueued?: boolean;
      /** What changed, for the entry (auditChanges). */
      auditChangeSource?: { table: string; where: Record<string, unknown>; before: Record<string, unknown> | null };
    }
  }
}

interface Actor {
  kind: AuditActorKind;
  id: string | null;
}

/** The admin or key behind `req`; null for a partner. Read when the entry
 *  is written, after grantScope has had its say. */
function actorOf(req: Request): Actor | null {
  const p = req.principal;
  if (!p) return null;
  if (p.role === 'admin' && p.source === 'session') return { kind: 'admin', id: p.adminId };
  if (p.role === 'admin' && p.source === 'env') return { kind: 'operator_key', id: null };
  if ((p.role === 'admin' || p.role === 'scoped') && p.source === 'db') return { kind: 'api_key', id: p.apiKeyId };
  return null;
}

async function labelOf(trx: Knex, tenantId: string, actor: Actor): Promise<string | null> {
  if (actor.kind === 'admin') {
    const admin = await trx<AdminRow>(TABLES.Admin).where({ id: actor.id!, tenantId }).first('email');
    return admin?.email ?? null;
  }
  if (actor.kind === 'api_key') {
    const key = await trx<ApiKeyRow>(TABLES.ApiKey).where({ id: actor.id!, tenantId }).first('label', 'prefix');
    return key ? key.label || `${key.prefix}…` : null;
  }
  return null;
}

/** Called by requireAuth with the principal resolved. Queues the entry for
 *  a write or an audited read. */
export function auditRequest(req: Request, res: Response): void {
  if (req.auditQueued) return;
  const key = routeKey(req);
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (isRead ? !AUDITED_READS.has(key) : key in NOT_AUDITED) return;
  req.auditQueued = true;
  beforeCommit(req, async (trx, body) => {
    if (res.statusCode >= 400) return;
    const actor = actorOf(req);
    if (!actor) return;
    const tenantId = req.tenantId!;
    const params = Object.keys(req.params).length > 0 ? { ...req.params } : null;
    await insertEntry(trx, {
      tenantId,
      actor,
      actorLabel: await labelOf(trx, tenantId, actor),
      action: key,
      targetId: firstParam(req) ?? createdId(req, body),
      params,
      fields: isRead ? null : fieldNames(req.body),
      detail: await changesOf(trx, req),
      status: res.statusCode,
      ip: req.ip ?? null,
    });
  });
}

/**
 * Put the values of a change on record: `before` is the row as the handler
 * read it (null when there was none). The entry re-reads the row just
 * before commit and keeps, for each field the body named, its old and new
 * value where they differ. Only for rows without secrets or personal data.
 */
export function auditChanges(
  req: Request,
  table: string,
  where: Record<string, unknown>,
  before: object | null | undefined,
): void {
  req.auditChangeSource = { table, where, before: (before as Record<string, unknown> | null | undefined) ?? null };
}

async function changesOf(trx: Knex, req: Request): Promise<Record<string, unknown> | null> {
  const source = req.auditChangeSource;
  const named = fieldNames(req.body);
  if (!source || !named) return null;
  const after = ((await trx(source.table).where(source.where).first()) ?? null) as Record<string, unknown> | null;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of named) {
    const from = source.before?.[field] ?? null;
    const to = after?.[field] ?? null;
    if (!(field in (source.before ?? {})) && !(field in (after ?? {}))) continue;
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[field] = { from, to };
  }
  return Object.keys(changes).length > 0 ? { changes } : null;
}

/** Record an admin's sign-in to this tenant. `db` is a transaction with
 *  the tenant pinned (or the privileged pool). */
export async function recordSignin(
  db: Knex,
  params: { tenantId: string; adminId: string; email: string; ip: string | null; via: 'link' | 'workspace' | 'claim' },
): Promise<void> {
  await insertEntry(db, {
    tenantId: params.tenantId,
    actor: { kind: 'admin', id: params.adminId },
    actorLabel: params.email,
    action: 'signin',
    targetId: null,
    params: null,
    fields: null,
    detail: { via: params.via },
    status: null,
    ip: params.ip,
  });
}

async function insertEntry(
  db: Knex,
  e: Omit<AuditLogRow, 'id' | 'actorKind' | 'actorId' | 'createdAt'> & { actor: Actor },
): Promise<void> {
  const { actor, params, fields, detail, ...rest } = e;
  await db(TABLES.AuditLog).insert({
    id: ulid(),
    ...rest,
    actorKind: actor.kind,
    actorId: actor.id,
    params: params ? JSON.stringify(params) : null,
    fields: fields ? JSON.stringify(fields) : null,
    detail: detail ? JSON.stringify(detail) : null,
  });
}

/** The route's first parameter: the record the path names. */
function firstParam(req: Request): string | null {
  const first = Object.values(req.params)[0];
  return typeof first === 'string' && first.length > 0 ? first.slice(0, 200) : null;
}

/** The id a create handed back: `id` on the body, or on its first object. */
function createdId(req: Request, body: unknown): string | null {
  if (req.method !== 'POST' || !body || typeof body !== 'object' || Array.isArray(body)) return null;
  const top = body as Record<string, unknown>;
  if (typeof top.id === 'string') return top.id.slice(0, 200);
  for (const value of Object.values(top)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const id = (value as Record<string, unknown>).id;
      if (typeof id === 'string') return id.slice(0, 200);
    }
  }
  return null;
}

function fieldNames(body: unknown): string[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const names = Object.keys(body).slice(0, MAX_FIELDS).map((k) => k.slice(0, FIELD_NAME_MAX));
  return names.length > 0 ? names.sort() : null;
}
