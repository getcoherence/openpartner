/**
 * Sanctions screening against the US Consolidated Screening List
 * (docs/sanctions-screening.md).
 *
 * The CSL merges the federal government's export and sanctions lists,
 * OFAC's SDN list among them. OFAC enforcement is strict liability: paying
 * a listed person is a violation whether or not anyone knew, and listed
 * people can be based anywhere, so country rules alone don't cover it. So
 * the platform screens:
 *   - a brand's display name and its primary admin's name, at signup and
 *     add-brand (fire-and-forget: signup latency is unchanged);
 *   - a partner's name the first time they are payable, and again at most
 *     daily while they have approved commissions (the lists change daily).
 *
 * A possible match goes to an operator, who clears it or confirms it. Until
 * then the payout planner holds the partner's Connect and funded-rail
 * payouts (payouts.ts); a confirmed match on a brand rejects the brand.
 *
 * Every screening is kept as a SanctionsScreening row: platform-scoped,
 * append-only apart from the review, no foreign keys, never exported, and
 * kept for 10 years (31 CFR 501.601). Only the privileged pool reads or
 * writes it — the app role has no grant.
 *
 * Hosted multi-tenant only, like the country rules (country-access.ts): a
 * self-hosted install's operator runs its own compliance, and has no ops
 * console to clear a match. Without CSL_API_KEY (a free key from
 * developer.trade.gov) nothing is screened and nothing is held for
 * screening; that is logged once.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type AdminRow,
  type PartnerRow,
  type PayoutRailPreference,
  type SanctionsScreeningMatch,
  type SanctionsScreeningRow,
  type TenantRow,
} from '@openpartner/db';
import { getCountryAccessSettings, latestDeclaredCountries } from './country-access.js';
import { getTenancyMode } from './tenancy.js';
import { sendOpsEmail } from './platform-ops-mail.js';
import { opsScreeningReviewEmail } from './email-templates.js';
import { getPortalBaseUrl } from './portal-url.js';
import { resolvePayoutMethod } from './payout-method.js';

export const CSL_SEARCH_URL = 'https://data.trade.gov/consolidated_screening_list/v1/search';

/** Fuzzy scores run 0-100 (100 = exact). An entry at or above this is a
 *  possible match for an operator to review. 85 is the conservative end of
 *  common practice: it catches transliterations and typos, at the cost of
 *  more false positives to clear. An entry the list returns with no score
 *  counts as a possible match. */
export const MATCH_SCORE_THRESHOLD = 85;
const MAX_STORED_MATCHES = 5;
const CSL_TIMEOUT_MS = 10_000;
/** A payable partner is re-screened once this much time has passed: the
 *  lists change daily. */
export const RESCREEN_AFTER_MS = 24 * 60 * 60 * 1000;
/** Most partners one sweep screens, so a backlog drains over several
 *  ticks instead of one long one. */
const SWEEP_LIMIT = 300;
/** A sweep stops after this many errors in a row: the API is down, and
 *  each call would only wait out its timeout. */
const SWEEP_MAX_CONSECUTIVE_ERRORS = 3;

export type ScreeningSubjectKind = SanctionsScreeningRow['subjectKind'];
export type ScreeningTrigger = SanctionsScreeningRow['trigger'];
export type ScreeningDecision = NonNullable<SanctionsScreeningRow['decision']>;

/** Results that say something about the name. 'error' and 'skipped' rows
 *  record that screening was attempted, nothing more. */
const COMPLETED_RESULTS: ReadonlyArray<SanctionsScreeningRow['result']> = ['clear', 'possible_match'];

export function cslConfigured(): boolean {
  return (process.env.CSL_API_KEY ?? '').trim().length > 0;
}

/** Why a sweep did nothing, or null when screening is on. */
function sweepSkipReason(): SweepResult['skipped'] | null {
  if (getTenancyMode() !== 'multi') return 'single_tenant';
  if (!cslConfigured()) {
    warnNoKeyOnce();
    return 'no_key';
  }
  return null;
}

let warnedNoKey = false;
function warnNoKeyOnce(): void {
  if (warnedNoKey) return;
  warnedNoKey = true;
  console.warn(
    '[sanctions-screening] CSL_API_KEY is not set: brands and partners are NOT being screened against the Consolidated Screening List',
  );
}

type CslLookup = (name: string) => Promise<unknown[]>;
let lookupOverride: CslLookup | null = null;

/** Tests: answer CSL searches without the network (null restores it).
 *  CSL_API_KEY must still be set: it is what switches screening on. */
export function setCslLookupForTesting(fn: CslLookup | null): void {
  lookupOverride = fn;
}

/**
 * How fast this process calls the list. trade.gov rate-limits the API: the
 * first prod sweep (Oct 19 2026) got 429s after about 17 calls in 2
 * seconds. So calls are spaced out, and a 429 is retried after the wait it
 * asks for (Retry-After). A wait longer than `maxRetryWaitMs`, or a 429
 * that outlasts the retries, is an error: the sweep's error breaker stops
 * it, and the next hourly sweep picks up where it left off.
 */
export interface CslPacing {
  /** Gap between consecutive calls, across every caller in the process. */
  minIntervalMs: number;
  /** Retries of a 429 before it counts as an error. */
  maxRetries: number;
  /** The longest Retry-After we wait out. */
  maxRetryWaitMs: number;
  /** The wait when a 429 has no usable Retry-After. */
  defaultRetryWaitMs: number;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_PACING: CslPacing = {
  minIntervalMs: 500,
  maxRetries: 2,
  maxRetryWaitMs: 30_000,
  defaultRetryWaitMs: 2_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let pacing: CslPacing = DEFAULT_PACING;
/** When the next call may go out (epoch ms). */
let nextCallAt = 0;

/** Tests: change the pacing, or restore the defaults with null. Either way
 *  the spacing starts afresh. */
export function setCslPacingForTesting(overrides: Partial<CslPacing> | null): void {
  pacing = overrides ? { ...DEFAULT_PACING, ...overrides } : DEFAULT_PACING;
  nextCallAt = 0;
}

/** Hold this call until its slot. The slot is claimed before waiting, so
 *  concurrent callers (a sweep and a signup) queue up instead of bunching. */
async function waitForSlot(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextCallAt);
  nextCallAt = slot + pacing.minIntervalMs;
  if (slot > now) await pacing.sleep(slot - now);
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date. Null when
 *  absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** One fuzzy name search. Returns the raw result entries; throws on any
 *  non-2xx answer (a 429 only once its retries are spent), a timeout, or a
 *  body that isn't the documented shape. */
async function cslSearch(name: string): Promise<unknown[]> {
  if (lookupOverride) return lookupOverride(name);
  const url = new URL(CSL_SEARCH_URL);
  url.searchParams.set('name', name);
  url.searchParams.set('fuzzy_name', 'true');
  url.searchParams.set('size', '25');
  let res: Response;
  for (let attempt = 0; ; attempt += 1) {
    await waitForSlot();
    res = await fetch(url, {
      headers: {
        'subscription-key': (process.env.CSL_API_KEY ?? '').trim(),
        accept: 'application/json',
        'cache-control': 'no-cache',
      },
      signal: AbortSignal.timeout(CSL_TIMEOUT_MS),
    });
    if (res.status !== 429 || attempt >= pacing.maxRetries) break;
    const wait = retryAfterMs(res.headers.get('retry-after')) ?? pacing.defaultRetryWaitMs;
    if (wait > pacing.maxRetryWaitMs) break;
    // Let the connection go back to the pool before trying again.
    await res.body?.cancel().catch(() => {});
    // Every caller waits, not just this one: the limit is per key.
    nextCallAt = Math.max(nextCallAt, Date.now() + wait);
    console.warn(`[sanctions-screening] CSL rate limit (429); retrying in ${wait}ms`);
  }
  if (!res.ok) throw new Error(`csl_http_${res.status}`);
  const body = (await res.json()) as { results?: unknown };
  if (!Array.isArray(body.results)) throw new Error('csl_unexpected_body');
  return body.results;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** A CSL result entry, trimmed to what a reviewer needs. */
export function toMatch(raw: unknown): SanctionsScreeningMatch {
  const r = (raw ?? {}) as Record<string, unknown>;
  const score = typeof r.score === 'number' ? r.score : typeof r.score === 'string' ? Number(r.score) : null;
  const addresses = Array.isArray(r.addresses) ? (r.addresses as Array<Record<string, unknown>>) : [];
  const countries = [...new Set(addresses.map((a) => a?.country).filter((c): c is string => typeof c === 'string' && c.length > 0))];
  const entryId = typeof r.id === 'string' ? r.id : typeof r.entity_number === 'string' ? r.entity_number : null;
  return {
    source: typeof r.source === 'string' ? r.source : 'unknown',
    name: typeof r.name === 'string' ? r.name : '',
    score: score != null && Number.isFinite(score) ? score : null,
    entryId,
    type: typeof r.type === 'string' ? r.type : null,
    programs: strings(r.programs).slice(0, 10),
    countries: countries.slice(0, 10),
  };
}

/** Trim and collapse whitespace: the name as sent to the list. */
export function normalizeScreenedName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

function nameKey(name: string): string {
  return normalizeScreenedName(name).toLowerCase();
}

/** Stable identity of a list entry, for "has an operator already judged
 *  this one for this subject?". */
function matchFingerprint(m: SanctionsScreeningMatch): string {
  return `${m.source}|${m.entryId ?? m.name.toLowerCase()}`;
}

interface NameOutcome {
  result: SanctionsScreeningRow['result'];
  matches: SanctionsScreeningMatch[];
  errorDetail: string | null;
}

/** Screen one name. Never throws: an API failure is an 'error' outcome. */
export async function screenName(name: string): Promise<NameOutcome> {
  if (!cslConfigured()) {
    warnNoKeyOnce();
    return { result: 'skipped', matches: [], errorDetail: null };
  }
  try {
    const raw = await cslSearch(name);
    const matches = raw
      .map(toMatch)
      .filter((m) => m.score == null || m.score >= MATCH_SCORE_THRESHOLD)
      // Best match first; an entry without a score after the scored ones.
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
      .slice(0, MAX_STORED_MATCHES);
    return { result: matches.length > 0 ? 'possible_match' : 'clear', matches, errorDetail: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // The name stays out of the log; the row has it.
    console.error(`[sanctions-screening] CSL search failed: ${detail}`);
    return { result: 'error', matches: [], errorDetail: detail.slice(0, 200) };
  }
}

export interface ScreeningSubject {
  subjectKind: ScreeningSubjectKind;
  subjectId: string;
  tenantId: string;
  names: Array<string | null | undefined>;
  country: string | null;
}

/**
 * Screen a subject's names and record one row per distinct name.
 *
 * A possible match whose list entries are all ones an operator already
 * decided on for this subject and name inherits that decision (a daily
 * rescreen must not reopen a cleared false positive every morning). Any
 * new entry reopens the review.
 *
 * New possible matches are emailed to ops, unless `notifyOps` is false: a
 * sweep sends one summary for the whole run instead.
 */
export async function screenSubject(
  db: Knex,
  subject: ScreeningSubject,
  trigger: ScreeningTrigger,
  opts: { notifyOps?: boolean } = {},
): Promise<SanctionsScreeningRow[]> {
  const names = new Map<string, string>();
  for (const n of subject.names) {
    const name = n ? normalizeScreenedName(n) : '';
    if (name && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
  }
  const rows: SanctionsScreeningRow[] = [];
  for (const [key, name] of names) {
    const outcome = await screenName(name);
    let carried: Pick<SanctionsScreeningRow, 'decision' | 'reviewedByEmail' | 'reviewedAt' | 'reviewNote' | 'decisionCarriedFromId'> | null =
      null;
    if (outcome.result === 'possible_match') {
      const prior = await db<SanctionsScreeningRow>(TABLES.SanctionsScreening)
        .where({ subjectKind: subject.subjectKind, subjectId: subject.subjectId, result: 'possible_match' })
        .whereRaw('lower("screenedName") = ?', [key])
        .whereNotNull('decision')
        .orderBy('screenedAt', 'desc')
        .first();
      if (prior) {
        const judged = new Set((prior.matches ?? []).map(matchFingerprint));
        if (outcome.matches.every((m) => judged.has(matchFingerprint(m)))) {
          carried = {
            decision: prior.decision,
            reviewedByEmail: prior.reviewedByEmail,
            reviewedAt: prior.reviewedAt,
            reviewNote: prior.reviewNote,
            decisionCarriedFromId: prior.decisionCarriedFromId ?? prior.id,
          };
        }
      }
    }
    const row: SanctionsScreeningRow = {
      id: ulid(),
      subjectKind: subject.subjectKind,
      subjectId: subject.subjectId,
      tenantId: subject.tenantId,
      screenedName: name,
      country: subject.country,
      result: outcome.result,
      matches: outcome.matches,
      errorDetail: outcome.errorDetail,
      trigger,
      screenedAt: new Date(),
      decision: carried?.decision ?? null,
      reviewedByEmail: carried?.reviewedByEmail ?? null,
      reviewedAt: carried?.reviewedAt ?? null,
      reviewNote: carried?.reviewNote ?? null,
      decisionCarriedFromId: carried?.decisionCarriedFromId ?? null,
    };
    await db(TABLES.SanctionsScreening).insert({ ...row, matches: JSON.stringify(row.matches) as unknown as never });
    rows.push(row);
  }
  if (opts.notifyOps !== false) await notifyOpsOfMatches(db, [rows]);
  return rows;
}

/** Email ops about possible matches still waiting for a decision: one
 *  email, one entry per subject. Best-effort (sendOpsEmail never throws). */
async function notifyOpsOfMatches(db: Knex, perSubject: SanctionsScreeningRow[][]): Promise<void> {
  const open = perSubject
    .map((rows) => rows.filter((r) => r.result === 'possible_match' && !r.decision))
    .filter((rows) => rows.length > 0);
  if (open.length === 0) return;
  const tenantIds = [...new Set(open.map((rows) => rows[0]!.tenantId))];
  const tenants = await db<TenantRow>(TABLES.Tenant).whereIn('id', tenantIds).select('id', 'displayName', 'slug');
  const byId = new Map(tenants.map((t) => [t.id, t]));
  await sendOpsEmail(
    db,
    opsScreeningReviewEmail({
      items: open.map((rows) => ({
        subjectKind: rows[0]!.subjectKind,
        brandName: byId.get(rows[0]!.tenantId)?.displayName ?? rows[0]!.tenantId,
        slug: byId.get(rows[0]!.tenantId)?.slug ?? null,
        names: rows.map((r) => r.screenedName),
        topMatch: rows[0]!.matches[0] ?? null,
      })),
      reviewUrl: `${getPortalBaseUrl()}/platform/screening`,
    }),
    'sanctions_screening_review',
  );
}

/** An admin whose name is only their mailbox name (add-brand's fallback)
 *  isn't screened: "jane" from jane@example.com says nothing about who
 *  they are. */
function screenableAdminName(admin: Pick<AdminRow, 'name' | 'email'> | undefined): string | null {
  if (!admin) return null;
  const name = normalizeScreenedName(admin.name);
  return name && name.toLowerCase() !== admin.email.split('@')[0]!.toLowerCase() ? name : null;
}

/** Primary (oldest live) admin per tenant. */
async function primaryAdmins(db: Knex, tenantIds: string[]): Promise<Map<string, Pick<AdminRow, 'name' | 'email'>>> {
  const out = new Map<string, Pick<AdminRow, 'name' | 'email'>>();
  if (tenantIds.length === 0) return out;
  const admins = await db<AdminRow>(TABLES.Admin)
    .whereIn('tenantId', tenantIds)
    .whereNull('revokedAt')
    .orderBy('createdAt', 'asc')
    .select('tenantId', 'name', 'email');
  for (const a of admins) if (!out.has(a.tenantId)) out.set(a.tenantId, a);
  return out;
}

/** The brand's display name and its primary admin's name. */
export async function screenTenant(
  db: Knex,
  tenantId: string,
  trigger: ScreeningTrigger,
  opts: { notifyOps?: boolean } = {},
): Promise<SanctionsScreeningRow[]> {
  const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first(['id', 'displayName']);
  if (!tenant) return [];
  const adminName = screenableAdminName((await primaryAdmins(db, [tenantId])).get(tenantId));
  const country = (await latestDeclaredCountries(db, 'tenant', [tenantId])).get(tenantId)?.country ?? null;
  return screenSubject(
    db,
    { subjectKind: 'tenant', subjectId: tenantId, tenantId, names: [tenant.displayName, adminName], country },
    trigger,
    opts,
  );
}

const inFlight = new Set<Promise<unknown>>();

/** Signup and add-brand: screen without holding up the response. */
export function screenTenantInBackground(db: Knex, tenantId: string, trigger: ScreeningTrigger): void {
  const p = screenTenant(db, tenantId, trigger)
    .catch((err) => {
      console.error(`[sanctions-screening] brand screening failed for tenant ${tenantId}`, err);
    })
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
}

/** Tests: wait for background screenings to land before cleaning up. */
export async function settleBackgroundScreeningsForTesting(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

export interface SweepResult {
  skipped?: 'no_key' | 'single_tenant';
  due: number;
  screened: number;
  possibleMatches: number;
  errors: number;
  /** The sweep gave up after consecutive API errors. */
  stoppedEarly: boolean;
}

/**
 * Screen every partner who has approved commissions and either has never
 * been screened under their current name or was last screened over
 * RESCREEN_AFTER_MS ago. Run hourly by the scheduler (so a partner is
 * screened within the hour of first becoming payable, and re-screened at
 * most daily) and right before payouts are planned.
 *
 * Uses the privileged pool: SanctionsScreening is a platform table, and
 * the sweep spans tenants unless `tenantId` narrows it.
 */
export async function screenPayablePartners(
  db: Knex,
  opts: { tenantId?: string; now?: Date; limit?: number } = {},
): Promise<SweepResult> {
  const result: SweepResult = { due: 0, screened: 0, possibleMatches: 0, errors: 0, stoppedEarly: false };
  const skipped = sweepSkipReason();
  if (skipped) return { ...result, skipped };
  const now = opts.now ?? new Date();
  const payable = (await db({ p: TABLES.Partner })
    // Only live brands: payouts run for active tenants only.
    .whereExists(
      db({ t: TABLES.Tenant }).select(db.raw('1')).whereRaw('t.id = p."tenantId"').andWhere('t.status', 'active'),
    )
    .whereExists(
      db({ c: TABLES.Commission })
        .select(db.raw('1'))
        .whereRaw('c."partnerId" = p.id')
        .andWhereRaw('c."tenantId" = p."tenantId"')
        .andWhere('c.status', 'approved'),
    )
    .modify((q) => {
      if (opts.tenantId) q.where('p.tenantId', opts.tenantId);
    })
    .select('p.id', 'p.tenantId', 'p.name')) as Array<Pick<PartnerRow, 'id' | 'tenantId' | 'name'>>;
  if (payable.length === 0) return result;

  const lastScreened = await lastCompletedByName(
    db,
    payable.map((p) => p.id),
  );
  const due = payable
    .map((p) => ({ partner: p, last: lastScreened.get(`${p.id}|${nameKey(p.name)}`) ?? null }))
    .filter(({ last }) => !last || now.getTime() - last.getTime() >= RESCREEN_AFTER_MS)
    // Never-screened first, then the stalest.
    .sort((a, b) => (a.last?.getTime() ?? 0) - (b.last?.getTime() ?? 0));
  result.due = due.length;
  const batch = due.slice(0, opts.limit ?? SWEEP_LIMIT);
  const countries = await latestDeclaredCountries(
    db,
    'partner',
    batch.map((d) => d.partner.id),
  );

  let consecutiveErrors = 0;
  const screened: SanctionsScreeningRow[][] = [];
  for (const { partner, last } of batch) {
    const rows = await screenSubject(
      db,
      {
        subjectKind: 'partner',
        subjectId: partner.id,
        tenantId: partner.tenantId,
        names: [partner.name],
        country: countries.get(partner.id)?.country ?? null,
      },
      last ? 'rescreen' : 'first_payable',
      { notifyOps: false },
    );
    screened.push(rows);
    result.screened += 1;
    if (rows.some((r) => r.result === 'possible_match')) result.possibleMatches += 1;
    if (rows.some((r) => r.result === 'error')) {
      result.errors += 1;
      consecutiveErrors += 1;
      if (consecutiveErrors >= SWEEP_MAX_CONSECUTIVE_ERRORS) {
        result.stoppedEarly = true;
        break;
      }
    } else {
      consecutiveErrors = 0;
    }
  }
  await notifyOpsOfMatches(db, screened);
  return result;
}

/**
 * Screen live brands whose current display name (or screenable primary
 * admin name) has never been screened with an answer: brands from before
 * screening existed, signups whose screening errored or ran without a key,
 * and renamed brands. Brands are screened once per name; only payable
 * partners are re-screened daily.
 */
export async function screenUnscreenedBrands(db: Knex, opts: { limit?: number } = {}): Promise<SweepResult> {
  const result: SweepResult = { due: 0, screened: 0, possibleMatches: 0, errors: 0, stoppedEarly: false };
  const skipped = sweepSkipReason();
  if (skipped) return { ...result, skipped };
  const tenants = (await db<TenantRow>(TABLES.Tenant)
    .where({ status: 'active' })
    .whereNot({ approvalStatus: 'rejected' })
    .whereNull('pendingDeletionAt')
    .orderBy('createdAt', 'asc')
    .select('id', 'displayName')) as Array<Pick<TenantRow, 'id' | 'displayName'>>;
  if (tenants.length === 0) return result;
  const ids = tenants.map((t) => t.id);
  const admins = await primaryAdmins(db, ids);
  const screened = new Set(
    (
      (await db(TABLES.SanctionsScreening)
        .where({ subjectKind: 'tenant' })
        .whereIn('subjectId', ids)
        .whereIn('result', COMPLETED_RESULTS as string[])
        .distinct('subjectId', db.raw('lower("screenedName") as "nameKey"'))) as Array<{ subjectId: string; nameKey: string }>
    ).map((r) => `${r.subjectId}|${r.nameKey}`),
  );
  const due = tenants.filter((t) => {
    const adminName = screenableAdminName(admins.get(t.id));
    return (
      !screened.has(`${t.id}|${nameKey(t.displayName)}`) || (adminName != null && !screened.has(`${t.id}|${nameKey(adminName)}`))
    );
  });
  result.due = due.length;
  let consecutiveErrors = 0;
  const outcomes: SanctionsScreeningRow[][] = [];
  for (const t of due.slice(0, opts.limit ?? SWEEP_LIMIT)) {
    const rows = await screenTenant(db, t.id, 'backfill', { notifyOps: false });
    outcomes.push(rows);
    result.screened += 1;
    if (rows.some((r) => r.result === 'possible_match')) result.possibleMatches += 1;
    if (rows.some((r) => r.result === 'error')) {
      result.errors += 1;
      consecutiveErrors += 1;
      if (consecutiveErrors >= SWEEP_MAX_CONSECUTIVE_ERRORS) {
        result.stoppedEarly = true;
        break;
      }
    } else {
      consecutiveErrors = 0;
    }
  }
  await notifyOpsOfMatches(db, outcomes);
  return result;
}

/** The hourly scheduler job: payable partners, then unscreened brands. */
export async function runScreeningSweep(db: Knex): Promise<{ partners: SweepResult; brands: SweepResult }> {
  const partners = await screenPayablePartners(db);
  const brands = await screenUnscreenedBrands(db);
  return { partners, brands };
}

/** When each partner was last screened with an answer, per name. */
async function lastCompletedByName(db: Knex, partnerIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (partnerIds.length === 0) return out;
  const rows = (await db(TABLES.SanctionsScreening)
    .where({ subjectKind: 'partner' })
    .whereIn('subjectId', partnerIds)
    .whereIn('result', COMPLETED_RESULTS as string[])
    .groupByRaw('"subjectId", lower("screenedName")')
    .select('subjectId', db.raw('lower("screenedName") as "nameKey"'), db.raw('max("screenedAt") as "lastAt"'))) as Array<{
    subjectId: string;
    nameKey: string;
    lastAt: Date;
  }>;
  for (const r of rows) out.set(`${r.subjectId}|${r.nameKey}`, new Date(r.lastAt));
  return out;
}

/** The latest row with an answer for each of a subject's screened names. */
async function latestCompletedRows(
  db: Knex,
  subjectKind: ScreeningSubjectKind,
  subjectIds: string[],
): Promise<Map<string, SanctionsScreeningRow[]>> {
  const out = new Map<string, SanctionsScreeningRow[]>();
  if (subjectIds.length === 0) return out;
  const rows = await db<SanctionsScreeningRow>(TABLES.SanctionsScreening)
    .where({ subjectKind })
    .whereIn('subjectId', subjectIds)
    .whereIn('result', COMPLETED_RESULTS as string[])
    .orderBy('screenedAt', 'asc');
  const latest = new Map<string, SanctionsScreeningRow>();
  for (const r of rows) latest.set(`${r.subjectId}|${nameKey(r.screenedName)}`, r);
  for (const r of latest.values()) {
    const list = out.get(r.subjectId) ?? [];
    list.push(r);
    out.set(r.subjectId, list);
  }
  return out;
}

/** The latest row (any result) for each of a subject's screened names,
 *  newest first — what the ops brand card shows. */
export async function latestScreenings(
  db: Knex,
  subjectKind: ScreeningSubjectKind,
  subjectIds: string[],
): Promise<Map<string, SanctionsScreeningRow[]>> {
  const out = new Map<string, SanctionsScreeningRow[]>();
  if (subjectIds.length === 0) return out;
  const rows = await db<SanctionsScreeningRow>(TABLES.SanctionsScreening)
    .where({ subjectKind })
    .whereIn('subjectId', subjectIds)
    .orderBy('screenedAt', 'asc');
  const latest = new Map<string, SanctionsScreeningRow>();
  for (const r of rows) latest.set(`${r.subjectId}|${nameKey(r.screenedName)}`, r);
  for (const r of [...latest.values()].reverse()) {
    const list = out.get(r.subjectId) ?? [];
    list.push(r);
    out.set(r.subjectId, list);
  }
  return out;
}

// --------------------------------------------------------------------------
// Payout holds
// --------------------------------------------------------------------------

/** Why a partner may not be paid through the platform:
 *   - country_not_supported: their latest declared country is on the
 *     country-access list (hosted only);
 *   - screening_confirmed: an operator confirmed a list match;
 *   - screening_review: a possible match waits for an operator;
 *   - screening_pending: screening is on but hasn't answered for their
 *     current name yet (never screened, or only errors). */
export type PayoutHoldReason = 'country_not_supported' | 'screening_confirmed' | 'screening_review' | 'screening_pending';

export interface PayoutHold {
  reason: PayoutHoldReason;
  /** The blocked declared country, for country_not_supported. */
  country?: string;
}

/**
 * Which of these partners are on a compliance hold. The payout planner
 * leaves a held partner's Connect and funded-rail commissions approved and
 * unpaid; on the manual rail, where the brand sends the money itself, it
 * only warns. Hosted multi-tenant only: a self-host never holds.
 *
 * `db` MUST be the privileged pool: LocationDeclaration, SanctionsScreening
 * and PlatformSetting are platform tables the app role can't read.
 */
export async function partnerPayoutHolds(
  db: Knex,
  tenantId: string,
  partners: ReadonlyArray<Pick<PartnerRow, 'id' | 'name'>>,
): Promise<Map<string, PayoutHold>> {
  const out = new Map<string, PayoutHold>();
  // Both are hosted-platform controls; a self-host applies its own.
  if (partners.length === 0 || getTenancyMode() !== 'multi') return out;
  const ids = partners.map((p) => p.id);

  const settings = await getCountryAccessSettings(db);
  if (settings.enforce) {
    const blocked = new Set(settings.blocked.map((b) => b.code));
    for (const [partnerId, d] of await latestDeclaredCountries(db, 'partner', ids)) {
      if (d.tenantId === tenantId && blocked.has(d.country)) {
        out.set(partnerId, { reason: 'country_not_supported', country: d.country });
      }
    }
  }

  const completed = await latestCompletedRows(db, 'partner', ids);
  const screeningOn = cslConfigured();
  for (const p of partners) {
    if (out.has(p.id)) continue;
    const rows = (completed.get(p.id) ?? []).filter((r) => r.tenantId === tenantId);
    if (rows.some((r) => r.decision === 'confirmed_match')) {
      out.set(p.id, { reason: 'screening_confirmed' });
    } else if (rows.some((r) => r.result === 'possible_match' && r.decision == null)) {
      out.set(p.id, { reason: 'screening_review' });
    } else if (screeningOn && !rows.some((r) => nameKey(r.screenedName) === nameKey(p.name))) {
      out.set(p.id, { reason: 'screening_pending' });
    }
  }
  return out;
}

export interface HeldPartner {
  tenantId: string;
  partnerId: string;
  partnerName: string;
  partnerEmail: string;
  reason: PayoutHoldReason;
  country: string | null;
  /** 'held': their Connect / funded-rail payouts aren't made. 'warning':
   *  the brand pays them itself (manual rail), so nothing is held. */
  effect: 'held' | 'warning';
  /** Approved commissions not yet on a payout, per currency. */
  owed: Array<{ currency: string; amount: number }>;
}

/** Every partner with approved commissions who is on a hold, for the
 *  brand's payouts page (`tenantId` given) or the ops console (all
 *  tenants). Privileged pool; tenantId is filtered explicitly. */
export async function listHeldPartners(db: Knex, opts: { tenantId?: string } = {}): Promise<HeldPartner[]> {
  const owedRows = (await db(TABLES.Commission)
    .where({ status: 'approved' })
    .whereNull('payoutId')
    .modify((q) => {
      if (opts.tenantId) q.where({ tenantId: opts.tenantId });
    })
    .groupByRaw('"tenantId", "partnerId", upper("currency")')
    .select('tenantId', 'partnerId', db.raw('upper("currency") as currency'), db.raw('sum("amount") as amount'))) as Array<{
    tenantId: string;
    partnerId: string;
    currency: string;
    amount: string | number;
  }>;
  if (owedRows.length === 0) return [];

  const byTenant = new Map<string, Set<string>>();
  for (const r of owedRows) {
    const set = byTenant.get(r.tenantId) ?? new Set<string>();
    set.add(r.partnerId);
    byTenant.set(r.tenantId, set);
  }

  const out: HeldPartner[] = [];
  for (const [tenantId, partnerIds] of byTenant) {
    const partners = (await db<PartnerRow>(TABLES.Partner)
      .where({ tenantId })
      .whereIn('id', [...partnerIds])
      .select('id', 'name', 'email', 'stripeConnectAccountId')) as Array<
      Pick<PartnerRow, 'id' | 'name' | 'email' | 'stripeConnectAccountId'>
    >;
    const holds = await partnerPayoutHolds(db, tenantId, partners);
    if (holds.size === 0) continue;
    const tenant = await db<TenantRow>(TABLES.Tenant).where({ id: tenantId }).first(['payoutRailPreference']);
    const rail: PayoutRailPreference = tenant?.payoutRailPreference ?? 'auto';
    for (const p of partners) {
      const hold = holds.get(p.id);
      if (!hold) continue;
      out.push({
        tenantId,
        partnerId: p.id,
        partnerName: p.name,
        partnerEmail: p.email,
        reason: hold.reason,
        country: hold.country ?? null,
        effect: resolvePayoutMethod(rail, p) === 'stripe_connect' ? 'held' : 'warning',
        owed: owedRows
          .filter((r) => r.tenantId === tenantId && r.partnerId === p.id)
          .map((r) => ({ currency: r.currency, amount: Math.round(Number(r.amount) * 100) / 100 })),
      });
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Review
// --------------------------------------------------------------------------

/** Possible matches still waiting for an operator: the latest answer for
 *  each subject and name, undecided. */
export async function screeningReviewQueue(db: Knex, limit = 200): Promise<SanctionsScreeningRow[]> {
  const t = TABLES.SanctionsScreening;
  return db<SanctionsScreeningRow>({ s: t })
    .where('s.result', 'possible_match')
    .whereNull('s.decision')
    .whereNotExists(
      db({ n: t })
        .select(db.raw('1'))
        .whereRaw('n."subjectKind" = s."subjectKind"')
        .andWhereRaw('n."subjectId" = s."subjectId"')
        .andWhereRaw('lower(n."screenedName") = lower(s."screenedName")')
        .whereIn('n.result', COMPLETED_RESULTS as string[])
        .andWhereRaw('n."screenedAt" > s."screenedAt"'),
    )
    .orderBy('s.screenedAt', 'asc')
    .limit(limit)
    .select('s.*');
}

export type ReviewOutcome =
  | { ok: true; row: SanctionsScreeningRow }
  | { ok: false; error: 'not_found' | 'not_reviewable' | 'already_reviewed' | 'superseded' };

/**
 * An operator's decision on a possible match. Only the latest answer for
 * that subject and name can be reviewed (an older one has been superseded
 * by a rescreen), and only once. The caller writes the audit log, and
 * rejects the brand on a confirmed brand match.
 */
export async function reviewScreening(
  db: Knex,
  id: string,
  review: { decision: ScreeningDecision; reviewedByEmail: string; note: string | null },
): Promise<ReviewOutcome> {
  const row = await db<SanctionsScreeningRow>(TABLES.SanctionsScreening).where({ id }).first();
  if (!row) return { ok: false, error: 'not_found' };
  if (row.result !== 'possible_match') return { ok: false, error: 'not_reviewable' };
  if (row.decision) return { ok: false, error: 'already_reviewed' };
  const newer = await db(TABLES.SanctionsScreening)
    .where({ subjectKind: row.subjectKind, subjectId: row.subjectId })
    .whereRaw('lower("screenedName") = ?', [nameKey(row.screenedName)])
    .whereIn('result', COMPLETED_RESULTS as string[])
    .where('screenedAt', '>', row.screenedAt)
    .first('id');
  if (newer) return { ok: false, error: 'superseded' };
  const reviewedAt = new Date();
  const updated = await db(TABLES.SanctionsScreening)
    .where({ id })
    .whereNull('decision')
    .update({
      decision: review.decision,
      reviewedByEmail: review.reviewedByEmail,
      reviewedAt,
      reviewNote: review.note,
    });
  if (updated === 0) return { ok: false, error: 'already_reviewed' };
  return {
    ok: true,
    row: { ...row, decision: review.decision, reviewedByEmail: review.reviewedByEmail, reviewedAt, reviewNote: review.note },
  };
}
