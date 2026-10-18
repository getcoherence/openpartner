/**
 * The {click_id} destination macro.
 *
 * A Stripe Payment Link reads the referral only from client_reference_id,
 * so a link straight to buy.stripe.com lost attribution when the router
 * could only append ?cref=. These lock in:
 *   - the router's substitution (clickDestination, shared via @openpartner/db)
 *   - no macro → cref appended exactly as before
 *   - the API refuses destinations the macro would break: misspellings,
 *     double braces, any other brace token, the macro in the host — on
 *     Program.destinationUrl and Link overrides
 *   - validation and substitution agree: every accepted form yields a value
 *     Stripe keeps in client_reference_id
 *   - a Stripe checkout link without the macro saves, with a warning
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import {
  DEFAULT_TENANT_ID,
  TABLES,
  clickDestination,
  clickDestinationProblem,
  clickDestinationWarning,
  hasClickIdMacro,
} from '@openpartner/db';
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
      'https://buy.stripe.com/abc?client_reference_id=%7Bclick_id%7D',
      'https://example.com/r/{click_id}',
      'https://example.com/#ref={click_id}',
      'https://example.com/signup',
      // Encoded JSON isn't a brace token: its body always holds a %.
      'https://example.com/?state=%7B%22plan%22%3A%22pro%22%7D',
    ]) {
      expect(clickDestinationProblem(ok), ok).toBeNull();
    }
  });

  it('rejects near-miss spellings rather than sending them through as literal text', () => {
    for (const typo of ['{clickid}', '{CLICK_ID}', '{click-id}', '{ClickId}', '{cref}', '%7Bclickid%7D', '{ click_id }', '%7B%20click_id%20%7D']) {
      expect(clickDestinationProblem(`https://buy.stripe.com/abc?client_reference_id=${typo}`), typo).toMatch(
        /exactly as \{click_id\}/,
      );
    }
  });

  // The router replaces only the exact macro. Each of these used to pass
  // validation and then reach Stripe as `{01J…}` or `{subid}`, which Stripe
  // drops from client_reference_id without an error.
  it('rejects double braces, other macros and stray braces', () => {
    const base = 'https://buy.stripe.com/abc?client_reference_id=';
    expect(clickDestinationProblem(`${base}{{click_id}}`)).toMatch(/single braces/);
    expect(clickDestinationProblem(`${base}%7B%7Bclick_id%7D%7D`)).toMatch(/single braces/);
    expect(clickDestinationProblem(`${base}{subid}`)).toMatch(/"\{subid\}" isn't a macro/);
    expect(clickDestinationProblem('https://example.com/search?q={term}')).toMatch(/"\{term\}" isn't a macro/);
    expect(clickDestinationProblem(`${base}%7Bsub_id%7D`)).toMatch(/isn't a macro/);
    expect(clickDestinationProblem(`${base}{click_id`)).toMatch(/unmatched "\{"/);
    expect(clickDestinationProblem(`${base}{click_id}}`)).toMatch(/unmatched "\}"/);
  });

  // Validation and substitution must agree: whatever the API lets a brand
  // save, the router must turn into a value Stripe keeps. A destination
  // without the macro is fine only if nothing in it looks like one.
  it('every accepted form substitutes to a value Stripe accepts', () => {
    const wrappers = ['', '{', '{{', '{ ', '{+', '%7B', '%7b', '%7B%7B', '%7B%20', '%7B+'];
    const closers = ['', '}', '}}', ' }', '+}', '%7D', '%7d', '%7D%7D', '%20%7D', '+%7D'];
    const names = ['click_id', 'CLICK_ID', 'clickid', 'click-id', 'cref', 'subid', ''];
    const macros: string[] = [];
    for (const open of wrappers) {
      for (const name of names) {
        for (const close of closers) {
          const destination = `https://buy.stripe.com/abc?client_reference_id=${open}${name}${close}`;
          if (clickDestinationProblem(destination) !== null) continue;
          const value = new URL(clickDestination(destination, ulid())).searchParams.get('client_reference_id') ?? '';
          if (hasClickIdMacro(destination)) {
            macros.push(`${open}${name}${close}`);
            expect(value, destination).toMatch(/^[A-Za-z0-9_-]+$/);
          } else {
            // No macro: the router appends cref and leaves this as typed.
            expect(value, destination).not.toMatch(/[{}]/);
          }
        }
      }
    }
    // Exactly the two documented spellings, in either hex case.
    expect(macros.sort()).toEqual(['%7Bclick_id%7D', '%7Bclick_id%7d', '%7bclick_id%7D', '%7bclick_id%7d', '{click_id}'].sort());
  });

  it('rejects the macro in the host', () => {
    expect(clickDestinationProblem('https://{click_id}.example.com/')).toMatch(/not the host/);
    expect(clickDestinationProblem('https://user:{click_id}@example.com/')).toMatch(/not the host/);
  });

  it('catches an encoded near miss, and stays linear on hostile brace runs', () => {
    expect(clickDestinationProblem('https://x.test/?a=%7Bclickid%7D')).toMatch(/isn't replaced/);
    for (const hostile of [
      '%7ba'.repeat(50_000),
      '{a'.repeat(50_000),
      `{${'%'.repeat(100_000)}`,
      `${'%7B%25'.repeat(20_000)}${'%7D'.repeat(20_000)}`,
    ]) {
      const started = Date.now();
      expect(clickDestinationProblem(`https://x.test/?a=${hostile}`)).toMatch(/unmatched/);
      expect(Date.now() - started).toBeLessThan(1000);
    }
  });
});

describe('clickDestinationWarning', () => {
  it('warns about a Stripe checkout link with no click id in client_reference_id', () => {
    for (const url of [
      'https://buy.stripe.com/abc123',
      'https://buy.stripe.com/abc123?prefilled_email=a%40b.c',
      'https://BUY.stripe.com/abc123?client_reference_id=fixed',
      'https://checkout.stripe.com/c/pay/cs_test_abc',
      // The macro elsewhere doesn't help: Stripe reads only this parameter.
      'https://buy.stripe.com/abc123/{click_id}',
    ]) {
      expect(clickDestinationWarning(url), url).toMatch(/client_reference_id=\{click_id\}/);
    }
  });

  it('warns when the substituted value would fall outside Stripe’s alphabet', () => {
    expect(clickDestinationWarning('https://buy.stripe.com/abc?client_reference_id=ref:{click_id}')).toMatch(/Stripe ignores/);
  });

  it('is quiet for the macro, and for anything that is not a Stripe checkout', () => {
    for (const url of [
      'https://buy.stripe.com/abc?client_reference_id={click_id}',
      'https://buy.stripe.com/abc?client_reference_id=%7Bclick_id%7D',
      'https://buy.stripe.com/abc?client_reference_id=op_{click_id}',
      'https://example.com/signup',
      'https://stripe.com/pricing',
      'not a url',
    ]) {
      expect(clickDestinationWarning(url), url).toBeNull();
    }
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
    expect(res.body).not.toHaveProperty('warnings');
  });

  it('refuses double braces and other macros, which the router would never fill in', async () => {
    for (const bad of ['{{click_id}}', '{ click_id }', '{subid}']) {
      const res = await createProgram(`https://buy.stripe.com/abc123?client_reference_id=${bad}`);
      expect(res.status, bad).toBe(400);
      expect(res.body.detail.fieldErrors.destinationUrl[0], bad).toMatch(/\{click_id\}/);
    }
  });

  it('saves a Stripe Payment Link without the macro, with a warning', async () => {
    const created = await createProgram('https://buy.stripe.com/abc123');
    expect(created.status).toBe(201);
    expect(created.body.warnings).toEqual([
      { field: 'destinationUrl', message: expect.stringMatching(/client_reference_id=\{click_id\}/) },
    ]);

    // Every save of the program says so until it's fixed.
    const renamed = await request(app).patch(`/programs/${created.body.id}`).set(admin()).send({ name: 'Renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.warnings).toHaveLength(1);

    const fixed = await request(app)
      .patch(`/programs/${created.body.id}`)
      .set(admin())
      .send({ destinationUrl: 'https://buy.stripe.com/abc123?client_reference_id={click_id}' });
    expect(fixed.status).toBe(200);
    expect(fixed.body).not.toHaveProperty('warnings');
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
    expect(good.body).not.toHaveProperty('warnings');

    const unmarked = await request(app)
      .post(`/partners/${partner.body.id}/links`)
      .set(admin())
      .send({ linkKey: `pl-${ulid().toLowerCase()}`, programId: program.body.id, destinationUrl: 'https://buy.stripe.com/abc' });
    expect(unmarked.status).toBe(201);
    expect(unmarked.body.warnings?.[0]?.message).toMatch(/client_reference_id/);

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
