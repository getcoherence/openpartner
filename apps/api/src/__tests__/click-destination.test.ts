/**
 * The {click_id} destination macro.
 *
 * A Stripe Payment Link reads the referral only from client_reference_id,
 * so a link straight to buy.stripe.com lost attribution when the router
 * could only append ?cref=. These lock in:
 *   - the router's substitution (clickDestination, shared via @openpartner/db)
 *   - no macro → cref appended exactly as before
 *   - the API refuses destinations the macro would break: misspellings, the
 *     macro in the host — on Program.destinationUrl and Link overrides
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES, clickDestination, clickDestinationProblem, hasClickIdMacro } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';

const ADMIN_KEY = 'op_test_click_destination_0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const CLICK_ID = '01K7ZQ3M5X8V2N4P6R8T0W2Y4A';

describe('clickDestination', () => {
  it('substitutes the click id for {click_id} and appends no cref', () => {
    const url = clickDestination('https://buy.stripe.com/abc123?client_reference_id={click_id}', CLICK_ID);
    expect(url).toBe(`https://buy.stripe.com/abc123?client_reference_id=${CLICK_ID}`);
    expect(new URL(url).searchParams.has('cref')).toBe(false);
  });

  it('appends cref when there is no macro, as before', () => {
    expect(clickDestination('https://example.com/signup?plan=pro', CLICK_ID)).toBe(
      `https://example.com/signup?plan=pro&cref=${CLICK_ID}`,
    );
  });

  it('substitutes every occurrence, in the path and fragment too', () => {
    expect(clickDestination('https://example.com/r/{click_id}?a={click_id}#{click_id}', CLICK_ID)).toBe(
      `https://example.com/r/${CLICK_ID}?a=${CLICK_ID}#${CLICK_ID}`,
    );
  });

  it('substitutes a macro a client percent-encoded', () => {
    expect(clickDestination('https://example.com/r/%7Bclick_id%7D', CLICK_ID)).toBe(`https://example.com/r/${CLICK_ID}`);
    expect(hasClickIdMacro('https://example.com/r/%7bclick_id%7d')).toBe(true);
  });

  it('a click id fits Stripe client_reference_id (alphanumerics, dash, underscore, ≤200)', () => {
    const value = new URL(clickDestination('https://buy.stripe.com/x?client_reference_id={click_id}', ulid())).searchParams.get(
      'client_reference_id',
    )!;
    expect(value).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
  });
});

describe('clickDestinationProblem', () => {
  it('accepts the macro in the query, path or fragment, and URLs without it', () => {
    for (const ok of [
      'https://buy.stripe.com/abc?client_reference_id={click_id}',
      'https://example.com/r/{click_id}',
      'https://example.com/#ref={click_id}',
      'https://example.com/signup',
      // Unrelated brace text is the brand's business.
      'https://example.com/search?q={term}',
    ]) {
      expect(clickDestinationProblem(ok), ok).toBeNull();
    }
  });

  it('rejects near-miss spellings rather than sending them through as literal text', () => {
    for (const typo of ['{clickid}', '{CLICK_ID}', '{click-id}', '{ClickId}', '{cref}', '%7Bclickid%7D']) {
      expect(clickDestinationProblem(`https://buy.stripe.com/abc?client_reference_id=${typo}`), typo).toMatch(
        /\{click_id\}/,
      );
    }
  });

  it('rejects the macro in the host', () => {
    expect(clickDestinationProblem('https://{click_id}.example.com/')).toMatch(/not the host/);
    expect(clickDestinationProblem('https://user:{click_id}@example.com/')).toMatch(/not the host/);
  });

  it('catches an encoded near miss, and stays linear on many unclosed encoded braces', () => {
    expect(clickDestinationProblem('https://x.test/?a=%7Bclickid%7D')).toMatch(/Unknown macro/);
    const started = Date.now();
    expect(clickDestinationProblem(`https://x.test/?a=${'%7ba'.repeat(50_000)}`)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const TABLES_TO_CLEAN = [TABLES.Commission, TABLES.Attribution, TABLES.Event, TABLES.Identity, TABLES.Click, TABLES.Link, TABLES.PartnerProgram, TABLES.Program, TABLES.Partner];

async function clean(): Promise<void> {
  for (const t of TABLES_TO_CLEAN) await db(t).del();
  // Network membership makes shareOnNetwork default on, so POST /programs
  // would demand a marketplaceDescription. Other files leave it set.
  await db(TABLES.Config).where({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership' }).del();
}

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
});

afterAll(async () => {
  // Leave nothing behind: a later file that deletes Partner without
  // knowing about Link would trip over this file's last links.
  if (!skipIntegration) await clean();
  await db.destroy();
});

beforeEach(async () => {
  if (skipIntegration) return;
  await clean();
});

describe.skipIf(skipIntegration)('destination validation on programs and links', () => {
  const admin = () => ({ Authorization: `Bearer ${ADMIN_KEY}` });

  function createProgram(destinationUrl: string, extra: Record<string, unknown> = {}) {
    return request(app)
      .post('/programs')
      .set(admin())
      .send({ name: 'Payment Link', destinationUrl, commissionRule: { type: 'percent', value: 10 }, ...extra });
  }

  it('saves a Stripe Payment Link destination with the macro', async () => {
    const res = await createProgram('https://buy.stripe.com/abc123?client_reference_id={click_id}');
    expect(res.status).toBe(201);
    expect(res.body.destinationUrl).toBe('https://buy.stripe.com/abc123?client_reference_id={click_id}');
  });

  it('refuses a misspelled macro on create and update', async () => {
    const bad = await createProgram('https://buy.stripe.com/abc123?client_reference_id={clickid}');
    expect(bad.status).toBe(400);
    expect(bad.body.detail.fieldErrors.destinationUrl[0]).toMatch(/\{click_id\}/);

    const ok = await createProgram('https://example.com/signup');
    const patch = await request(app)
      .patch(`/programs/${ok.body.id}`)
      .set(admin())
      .send({ destinationUrl: 'https://{click_id}.example.com/' });
    expect(patch.status).toBe(400);
    expect(patch.body.detail.fieldErrors.destinationUrl[0]).toMatch(/not the host/);
  });

  it('a deep-link override may carry the macro; a misspelled one is refused', async () => {
    const program = await createProgram('https://example.com/signup', { deepLinkAllowedDomains: 'buy.stripe.com' });
    const partner = await request(app).post('/partners').set(admin()).send({ email: `p+${ulid()}@example.com`, name: 'P' });

    const good = await request(app)
      .post(`/partners/${partner.body.id}/links`)
      .set(admin())
      .send({
        linkKey: `pl-${ulid().toLowerCase()}`,
        programId: program.body.id,
        destinationUrl: 'https://buy.stripe.com/abc?client_reference_id={click_id}',
      });
    expect(good.status).toBe(201);
    expect(good.body.destinationUrl).toBe('https://buy.stripe.com/abc?client_reference_id={click_id}');

    const bad = await request(app)
      .post(`/partners/${partner.body.id}/links`)
      .set(admin())
      .send({
        linkKey: `pl-${ulid().toLowerCase()}`,
        programId: program.body.id,
        destinationUrl: 'https://buy.stripe.com/abc?client_reference_id={CLICK_ID}',
      });
    expect(bad.status).toBe(400);
  });
});
