/**
 * Test clicks: an admin proves a program's tracking chain works before any
 * partner traffic arrives (Admin → Tracking health → Send a test click).
 * The setup checks (setup-checks.ts) judge the chain from real partner
 * clicks, so a brand that just installed the script can't see it work
 * until a partner sends one.
 *
 *   POST /admin/tracking-health/test-click      creates one: a TestClick row
 *                                               holding sha256 of a random
 *                                               single-use token
 *   GET  /r/_test/<token>                       the router (apps/router)
 *                                               claims it and redirects to
 *                                               the program's destination
 *                                               with a fresh click id, as
 *                                               for a partner's click
 *   POST /attribution/landing, /identify        the brand's script and
 *                                               signup report it as usual;
 *                                               on their click-not-found
 *                                               path they find it here
 *   Stripe checkout, conversion call            either carrying the click id
 *                                               links it too, on the same
 *                                               path: a brand whose site
 *                                               never calls identify() (a
 *                                               Payment Link, a lender's
 *                                               postback) can still pass
 *   GET  /admin/tracking-health/test-click/:id  how far it got
 *
 * A test click is never a Click. Attribution, payouts, every click count,
 * the funnel, the fraud queue, partner views and the export all read Click,
 * so none of them can see one, and no Identity is written for the tester's
 * signup. No partner is involved either: the test needs no partner link, so
 * it works before the first partner joins. A checkout that carries one is
 * recorded as if it carried no click, and a conversion call naming one
 * records nothing. Neither is counted as dropped input (tracking-issues.ts).
 *
 * Expiry (TEST_CLICK): the link works once, for linkTtlMinutes; landing and
 * identify count for stepWindowHours after the click; rows are deleted
 * after retentionDays (the test-click-purge job), by when the click id the
 * SDK stored in the tester's browser has expired too. While a row exists,
 * that stored id is recognised, so a later signup in the same browser isn't
 * counted as an unknown click.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { TABLES, type ProgramRow, type TenantRow, type TestClickLinkedVia, type TestClickRow } from '@openpartner/db';
import { campaignStatus } from './campaign-lifecycle.js';
import { LINKING_FIX, SCRIPT_FIX_ADD, SCRIPT_FIX_CHECK, isStripeCheckout } from './setup-checks.js';
import { markTrackingTestPassed } from './tracking-verification.js';

export const TEST_CLICK = {
  /** The link must be opened this soon after it's made. */
  linkTtlMinutes: 30,
  /** Landing and identify count this long after the click. */
  stepWindowHours: 24,
  /** Rows are deleted this long after they're made. */
  retentionDays: 90,
  /** Tests a brand may make in any 24 hours. */
  perDay: 20,
  /** A landing should be reported this soon after the click. */
  landingGraceSeconds: 60,
  /** Time to sign up or log in, after the landing (or the click). */
  identifyGraceSeconds: 180,
  /** Time to pay on Stripe's page, when the link goes straight there. */
  checkoutGraceSeconds: 600,
} as const;

/** The tester's own browser can hold the script back: with data-consent=
 *  "pending", the SDK's regional mode and many consent banners count a
 *  Global Privacy Control or Do Not Track signal as declining, and an
 *  Accept may not undo it. Only a test has one browser to blame, so the
 *  setup checks don't say it. */
export const PRIVACY_SIGNAL_FIX =
  'If the tag waits for consent (data-consent="pending"), a browser that sends Global Privacy Control or Do Not Track (Brave does by default) can stop it reporting even after you accept: send the test from a browser that doesn’t.';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type CreateTestClickResult =
  | { ok: true; id: string; path: string; expiresAt: string }
  | {
      ok: false;
      status: 404 | 409 | 422 | 429;
      error: 'program_not_found' | 'program_not_active' | 'links_paused' | 'too_many_test_clicks';
    };

export async function createTestClick(
  db: Knex,
  tenantId: string,
  programId: string,
  now = new Date(),
): Promise<CreateTestClickResult> {
  const program = (await db<ProgramRow>(TABLES.Program)
    .where({ id: programId, tenantId })
    .first('id', 'destinationUrl', 'startsAt', 'endsAt', 'blockedAt')) as
    | Pick<ProgramRow, 'id' | 'destinationUrl' | 'startsAt' | 'endsAt' | 'blockedAt'>
    | undefined;
  if (!program) return { ok: false, status: 404, error: 'program_not_found' };
  if (program.blockedAt || campaignStatus(program, now) !== 'active') {
    return { ok: false, status: 409, error: 'program_not_active' };
  }
  // The router serves no test link for such a brand (its servesTestClicks),
  // so a test would only ever 404. A brand still in review can test: that is
  // how it verifies its tracking before approval (tracking-verification.ts).
  const tenant = (await db<TenantRow>(TABLES.Tenant)
    .where({ id: tenantId })
    .first('status', 'approvalStatus', 'pendingDeletionAt')) as
    | Pick<TenantRow, 'status' | 'approvalStatus' | 'pendingDeletionAt'>
    | undefined;
  if (!tenant || tenant.status !== 'active' || tenant.approvalStatus === 'rejected' || tenant.pendingDeletionAt != null) {
    return { ok: false, status: 409, error: 'links_paused' };
  }
  return db.transaction(async (trx) => {
    // One at a time per brand, so concurrent requests can't all count under
    // the allowance and each make one.
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`test_click:${tenantId}`]);
    const [recent] = (await trx(TABLES.TestClick)
      .where({ tenantId })
      .where('createdAt', '>', new Date(now.getTime() - DAY))
      .count({ n: '*' })) as Array<{ n: string | number }>;
    if (Number(recent?.n ?? 0) >= TEST_CLICK.perDay) return { ok: false, status: 429, error: 'too_many_test_clicks' } as const;

    const token = randomBytes(32).toString('base64url');
    const id = ulid();
    const expiresAt = new Date(now.getTime() + TEST_CLICK.linkTtlMinutes * MINUTE);
    await trx<TestClickRow>(TABLES.TestClick).insert({
      id,
      tenantId,
      programId,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      createdAt: now,
      expiresAt,
    });
    return { ok: true, id, path: `/_test/${token}`, expiresAt: expiresAt.toISOString() } as const;
  });
}

export type TestClickStepId = 'click' | 'landing' | 'identify';
/**
 *   done     it happened
 *   waiting  it may still happen; nothing to fix yet
 *   missing  it should have happened by now (or the test expired), with
 *            what to fix. A late arrival still turns it done.
 *   pending  waits on the step before
 *   skipped  doesn't apply: nothing lands on a Stripe-hosted checkout
 */
export type TestClickStepStatus = 'done' | 'waiting' | 'missing' | 'pending' | 'skipped';

export interface TestClickStep {
  id: TestClickStepId;
  title: string;
  status: TestClickStepStatus;
  at: string | null;
  summary: string;
  fix: string | null;
}

export interface TestClickResult {
  id: string;
  program: { id: string; name: string };
  createdAt: string;
  expiresAt: string;
  /** `waiting` while a step can still happen; the portal polls until then. */
  state: 'waiting' | 'passed' | 'expired';
  /** Where the router sent it, click id included. */
  destination: string | null;
  steps: TestClickStep[];
}

export const TEST_CLICK_STEP_TITLES: Record<TestClickStepId, string> = {
  click: 'Link opened',
  landing: 'Reached the script',
  identify: 'Linked to a customer',
};

const LINKED_SUMMARY: Record<TestClickLinkedVia, string> = {
  identify: 'Your site linked it to a signup or login.',
  checkout: 'A Stripe checkout carried it.',
  conversion: 'A conversion call sent it.',
  paypal: 'A PayPal payment carried it.',
};

/** Why a link that goes straight to Stripe's checkout wasn't linked. */
const CHECKOUT_LINKING_FIX =
  'Check that Stripe is connected under Integrations and that the destination carries client_reference_id={click_id}, then complete the checkout in the tab the link opened.';

/** A test click's progress, or null when the brand has none by that id. */
export async function testClickResult(
  db: Knex,
  tenantId: string,
  id: string,
  now = new Date(),
): Promise<TestClickResult | null> {
  const row = (await db(`${TABLES.TestClick} as t`)
    .join(`${TABLES.Program} as p`, (j) => j.on('p.id', 't.programId').andOn('p.tenantId', 't.tenantId'))
    .where({ 't.id': id, 't.tenantId': tenantId })
    .first('t.*', 'p.name as programName', 'p.destinationUrl as programDestination')) as
    | (TestClickRow & { programName: string; programDestination: string })
    | undefined;
  if (!row) return null;
  // Partners' links go straight to Stripe's checkout: no page of the
  // brand's runs the script, and only the checkout can link the click.
  const toStripe = isStripeCheckout(row.destination ?? row.programDestination);

  const at = (d: Date | null) => (d ? new Date(d).toISOString() : null);
  const clickedAt = row.clickedAt ? new Date(row.clickedAt) : null;
  const linkExpired = !clickedAt && now.getTime() > new Date(row.expiresAt).getTime();
  const windowOver = !!clickedAt && now.getTime() > clickedAt.getTime() + TEST_CLICK.stepWindowHours * HOUR;
  const over = linkExpired || windowOver;
  const since = (d: Date | null) => (d ? (now.getTime() - new Date(d).getTime()) / 1000 : 0);

  const click: TestClickStep = clickedAt
    ? step('click', 'done', at(clickedAt), 'The router sent it to your destination.')
    : linkExpired
      ? step(
          'click',
          'missing',
          null,
          'The test link wasn’t opened in time.',
          `Send another test click and open its link within ${TEST_CLICK.linkTtlMinutes} minutes. It works once.`,
        )
      : step('click', 'waiting', null, 'Waiting for the test link to be opened. It works once.');

  let landing: TestClickStep;
  if (toStripe && !row.landedAt) {
    landing = step('landing', 'skipped', null, 'Not needed: the link goes straight to Stripe’s checkout.');
  } else if (!clickedAt) {
    landing = step('landing', 'pending', null, 'Waits for the link to be opened.');
  } else if (row.landedAt) {
    landing = step(
      'landing',
      'done',
      at(row.landedAt),
      row.landingHost ? `The script on ${row.landingHost} reported it.` : 'The script reported it.',
    );
  } else if (row.identifiedAt) {
    // As the script check has it: a click linked anyway reaches the brand
    // another way (its server reads ?cref=).
    landing = step('landing', 'done', null, 'No landing report, but it was linked to a customer, so the click reaches you another way.');
  } else if (!over && since(clickedAt) < TEST_CLICK.landingGraceSeconds) {
    landing = step('landing', 'waiting', null, 'Waiting for the page to report the click.');
  } else {
    landing = step(
      'landing',
      'missing',
      null,
      'The page hasn’t reported the click.',
      `If the page’s address lost the click id (?cref=) on the way, fix the redirect that drops it. Otherwise: ${SCRIPT_FIX_ADD} ${SCRIPT_FIX_CHECK} ${PRIVACY_SIGNAL_FIX}`,
    );
  }

  let identify: TestClickStep;
  if (!clickedAt) {
    identify = step('identify', 'pending', null, 'Waits for the link to be opened.');
  } else if (row.identifiedAt) {
    identify = step('identify', 'done', at(row.identifiedAt), LINKED_SUMMARY[row.linkedVia ?? 'identify']);
  } else if (
    !over &&
    since(row.landedAt ?? clickedAt) < (toStripe ? TEST_CLICK.checkoutGraceSeconds : TEST_CLICK.identifyGraceSeconds)
  ) {
    identify = step(
      'identify',
      'waiting',
      null,
      toStripe
        ? 'Complete the checkout in the tab the link opened. It’s a real purchase: use a discount code of your own, or refund it afterwards.'
        : 'Sign up, log in or check out on your site in the tab the link opened (a private window helps if you’re already signed in).',
    );
  } else {
    identify = step(
      'identify',
      'missing',
      null,
      over ? 'Nothing linked it to a customer.' : 'Nothing has linked it to a customer yet.',
      toStripe ? CHECKOUT_LINKING_FIX : LINKING_FIX,
    );
  }

  const reached = (s: TestClickStep) => s.status === 'done' || s.status === 'skipped';
  const passed = reached(click) && reached(landing) && reached(identify);
  return {
    id: row.id,
    program: { id: row.programId, name: row.programName },
    createdAt: at(row.createdAt)!,
    expiresAt: at(row.expiresAt)!,
    state: passed ? 'passed' : over ? 'expired' : 'waiting',
    destination: row.destination,
    steps: [click, landing, identify],
  };
}

function step(
  id: TestClickStepId,
  status: TestClickStepStatus,
  at: string | null,
  summary: string,
  fix: string | null = null,
): TestClickStep {
  return { id, title: TEST_CLICK_STEP_TITLES[id], status, at, summary, fix };
}

/** A click id as the router mints it: a ULID. */
const CLICK_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The live test click carrying this click id, if any. */
async function findTestClick(db: Knex, tenantId: string, clickId: string) {
  // Anything else can't be one, and isn't sent to Postgres: a NUL byte in
  // it would fail the query, and with it the caller's savepoint.
  if (!CLICK_ID_RE.test(clickId)) return undefined;
  return (await db<TestClickRow>(TABLES.TestClick)
    .where({ tenantId, clickId })
    .first('id', 'clickedAt', 'landedAt', 'identifiedAt')) as
    | Pick<TestClickRow, 'id' | 'clickedAt' | 'landedAt' | 'identifiedAt'>
    | undefined;
}

/** Whether this id is a test click of the brand's (tracking-issues.ts). */
export async function isTestClick(db: Knex, tenantId: string, clickId: string): Promise<boolean> {
  return !!(await findTestClick(db, tenantId, clickId));
}

const inWindow = (clickedAt: Date | null, now: Date) =>
  !!clickedAt && now.getTime() <= new Date(clickedAt).getTime() + TEST_CLICK.stepWindowHours * HOUR;

/**
 * POST /attribution/landing for a test click: the first report within the
 * window is kept. Null when `clickId` isn't a test click of the brand's.
 */
export async function recordTestLanding(
  db: Knex,
  tenantId: string,
  clickId: string,
  host: string | null,
  now = new Date(),
): Promise<{ first: boolean } | null> {
  const test = await findTestClick(db, tenantId, clickId);
  if (!test) return null;
  if (test.landedAt || !inWindow(test.clickedAt, now)) return { first: false };
  const n = await db(TABLES.TestClick)
    .where({ id: test.id, tenantId })
    .whereNull('landedAt')
    .update({ landedAt: now, landingHost: host });
  return { first: n > 0 };
}

/**
 * A test click linked to a customer: by POST /attribution/identify, a
 * Stripe checkout carrying it, or a conversion call naming it. The first
 * within the window is kept, and nothing else is written (no Identity, no
 * Event, no attribution). The user id isn't stored. The first link also
 * verifies the brand's tracking (tracking-verification.ts). Null when
 * `clickId` isn't a test click of the brand's.
 */
export async function recordTestLink(
  db: Knex,
  tenantId: string,
  clickId: string,
  via: TestClickLinkedVia,
  now = new Date(),
): Promise<{ first: boolean } | null> {
  const test = await findTestClick(db, tenantId, clickId);
  if (!test) return null;
  if (test.identifiedAt || !inWindow(test.clickedAt, now)) return { first: false };
  const n = await db(TABLES.TestClick)
    .where({ id: test.id, tenantId })
    .whereNull('identifiedAt')
    .update({ identifiedAt: now, linkedVia: via });
  if (n > 0) await markTrackingTestPassed(db, tenantId, now);
  return { first: n > 0 };
}

/** POST /attribution/identify for a test click (recordTestLink). */
export function recordTestIdentify(
  db: Knex,
  tenantId: string,
  clickId: string,
  now = new Date(),
): Promise<{ first: boolean } | null> {
  return recordTestLink(db, tenantId, clickId, 'identify', now);
}

/** Delete test clicks past retention, every tenant's (privileged pool). */
export async function purgeTestClicks(db: Knex, now = new Date()): Promise<number> {
  return db(TABLES.TestClick)
    .where('createdAt', '<', new Date(now.getTime() - TEST_CLICK.retentionDays * DAY))
    .del();
}
