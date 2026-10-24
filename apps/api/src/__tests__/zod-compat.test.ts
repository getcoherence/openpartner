/**
 * The API moved from zod 3 to zod 4 (GHSA-mrhx-c7xc-m3w5). zod 4 rewords
 * every default validation message and tightens `.datetime()`, and both
 * reach integrations: `invalid_body` / `invalid_query` errors carry zod's
 * flattened issues as `detail`, and the portal shows those messages to
 * people. zod-compat.ts keeps them as zod 3 had them. These lock in:
 *   - zod 3's exact messages, per issue kind, captured from zod 3.25.76
 *   - the zod 3 datetime forms (seconds optional; +HHMM offsets)
 *   - the real route schemas' `detail` for representative bad requests
 *   - the `{ error, detail: { formErrors, fieldErrors } }` envelope over HTTP
 */

import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { offsetDateTime, utcDateTime, z } from '../zod.js';
import { schema as eventSchema } from '../routes/events.js';
import { conversionSchema } from '../routes/conversions.js';
import { refundSchema } from '../routes/refunds.js';
import { listQuerySchema } from '../routes/commissions.js';
import { parsePayoutDetails } from '../payout-profile.js';
import { db } from '../db.js';
import { createApp } from '../app.js';

const ADMIN_KEY = 'op_test_zod_compat_0123456789abcdef012345';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

afterAll(async () => {
  await db.destroy();
});

const flat = (r: { success: boolean; error?: z.ZodError }) => (r.success ? 'accepted' : r.error!.flatten());
const field = (key: string, ...messages: string[]) => ({ formErrors: [], fieldErrors: { [key]: messages } });

describe('zod 3 validation messages on zod 4', () => {
  const obj = z.object;
  const cases: Array<[string, z.ZodType, unknown, unknown]> = [
    ['a missing field', obj({ a: z.string() }), {}, field('a', 'Required')],
    ['a wrong type', obj({ a: z.string() }), { a: 5 }, field('a', 'Expected string, received number')],
    ['null', obj({ a: z.string() }), { a: null }, field('a', 'Expected string, received null')],
    ['a body that is not an object', obj({ a: z.string() }), 'x', { formErrors: ['Expected object, received string'], fieldErrors: {} }],
    ['an array body', obj({ a: z.string() }), [], { formErrors: ['Expected object, received array'], fieldErrors: {} }],
    ['a float for an int', obj({ n: z.number().int() }), { n: 1.5 }, field('n', 'Expected integer, received float')],
    ['NaN from coercion', obj({ n: z.coerce.number() }), { n: 'abc' }, field('n', 'Expected number, received nan')],
    ['a short string', obj({ s: z.string().min(3) }), { s: 'a' }, field('s', 'String must contain at least 3 character(s)')],
    ['a long string', obj({ s: z.string().max(2) }), { s: 'abc' }, field('s', 'String must contain at most 2 character(s)')],
    ['a fixed-length string', obj({ s: z.string().length(3) }), { s: 'ab' }, field('s', 'String must contain exactly 3 character(s)')],
    ['an empty array', obj({ l: z.array(z.string()).min(1) }), { l: [] }, field('l', 'Array must contain at least 1 element(s)')],
    ['a long array', obj({ l: z.array(z.string()).max(1) }), { l: ['a', 'b'] }, field('l', 'Array must contain at most 1 element(s)')],
    ['zero for positive', obj({ n: z.number().positive() }), { n: 0 }, field('n', 'Number must be greater than 0')],
    ['negative for nonnegative', obj({ n: z.number().nonnegative() }), { n: -1 }, field('n', 'Number must be greater than or equal to 0')],
    ['above max', obj({ n: z.number().max(10) }), { n: 11 }, field('n', 'Number must be less than or equal to 10')],
    ['not below lt', obj({ n: z.number().lt(10) }), { n: 10 }, field('n', 'Number must be less than 10')],
    ['an int below min', obj({ n: z.number().int().min(1) }), { n: 0 }, field('n', 'Number must be greater than or equal to 1')],
    ['not a multiple', obj({ n: z.number().multipleOf(5) }), { n: 3 }, field('n', 'Number must be a multiple of 5')],
    ['a bad email', obj({ e: z.string().email() }), { e: 'nope' }, field('e', 'Invalid email')],
    ['a bad url', obj({ u: z.string().url() }), { u: 'nope' }, field('u', 'Invalid url')],
    ['a bad datetime', obj({ t: utcDateTime() }), { t: 'yesterday' }, field('t', 'Invalid datetime')],
    ['a regex miss', obj({ r: z.string().regex(/^a$/) }), { r: 'b' }, field('r', 'Invalid')],
    ['a startsWith miss', obj({ k: z.string().startsWith('op_') }), { k: 'x' }, field('k', 'Invalid input: must start with "op_"')],
    ['a bad enum value', obj({ e: z.enum(['a', 'b']) }), { e: 'c' }, field('e', "Invalid enum value. Expected 'a' | 'b', received 'c'")],
    ['a number for an enum', obj({ e: z.enum(['a', 'b']) }), { e: 1 }, field('e', "Expected 'a' | 'b', received number")],
    ['a missing enum', obj({ e: z.enum(['a', 'b']) }), {}, field('e', 'Required')],
    ['a bad literal', obj({ l: z.literal('bank') }), { l: 'x' }, field('l', 'Invalid literal value, expected "bank"')],
    [
      'a bad discriminator',
      z.discriminatedUnion('method', [obj({ method: z.literal('paypal') }), obj({ method: z.literal('bank') })]),
      { method: 'x' },
      field('method', "Invalid discriminator value. Expected 'paypal' | 'bank'"),
    ],
    [
      'unknown keys on a strict object',
      obj({ a: z.string() }).strict(),
      { a: 'x', b: 1, c: 2 },
      { formErrors: ["Unrecognized key(s) in object: 'b', 'c'"], fieldErrors: {} },
    ],
    ['no union member', obj({ u: z.union([z.string(), z.number()]) }), { u: true }, field('u', 'Invalid input')],
    ['a refine without a message', obj({ r: z.string().refine(() => false) }), { r: 'x' }, field('r', 'Invalid input')],
    ['a refine with a message', obj({ r: z.string().refine(() => false, 'nope') }), { r: 'x' }, field('r', 'nope')],
    ["a schema's own message", obj({ s: z.string().min(3, 'too short') }), { s: 'a' }, field('s', 'too short')],
    ['a string for a boolean', obj({ b: z.boolean() }), { b: 'true' }, field('b', 'Expected boolean, received string')],
    ['a nested field', obj({ o: obj({ x: z.number() }) }), { o: { x: 'y' } }, field('o', 'Expected number, received string')],
    ['a string for a record', obj({ m: z.record(z.string(), z.number()) }), { m: 'x' }, field('m', 'Expected object, received string')],
    ['a bad record value', obj({ m: z.record(z.string(), z.number()) }), { m: { k: 'v' } }, field('m', 'Expected number, received string')],
    [
      'a superRefine issue',
      obj({ a: z.number(), b: z.number() }).superRefine((v, ctx) => {
        if (v.a > v.b) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a must not exceed b', path: ['a'] });
      }),
      { a: 2, b: 1 },
      field('a', 'a must not exceed b'),
    ],
  ];

  it.each(cases)('%s', (_name, schema, input, expected) => {
    expect(flat(schema.safeParse(input))).toEqual(expected);
  });

  it('refuses ±Infinity (JSON 1e400), which zod 3 let through a plain z.number()', () => {
    expect(flat(z.object({ n: z.number() }).safeParse({ n: JSON.parse('1e400') }))).toEqual(field('n', 'Number must be finite'));
  });
});

describe("zod 3's .datetime() forms", () => {
  const utc = utcDateTime();
  const offset = offsetDateTime();

  it.each([
    ['2026-10-16T10:00:00Z', true],
    ['2026-10-16T10:00:00.123Z', true],
    ['2026-10-16T10:00:00.123456789Z', true],
    // zod 4's own .datetime() refuses a time without seconds.
    ['2026-10-16T10:00Z', true],
    ['2026-10-16T10:00:00+00:00', false],
    ['2026-10-16T10:00:00', false],
    ['2026-10-16', false],
    ['2026-10-16t10:00:00z', false],
    ['2026-10-16T24:00:00Z', false],
    ['2026-02-30T10:00:00Z', false],
    ['2024-02-29T10:00:00Z', true],
  ])('utcDateTime %s → %s', (value, ok) => {
    expect(utc.safeParse(value).success).toBe(ok);
  });

  it.each([
    ['2026-10-16T10:00:00Z', true],
    ['2026-10-16T10:00:00+00:00', true],
    // zod 4's own offset form needs the colon.
    ['2026-10-16T10:00:00+0530', true],
    ['2026-10-16T10:00-05:00', true],
    ['2026-10-16T10:00:00+05', false],
    ['2026-10-16T10:00:00', false],
  ])('offsetDateTime %s → %s', (value, ok) => {
    expect(offset.safeParse(value).success).toBe(ok);
  });

  it('documents both as format: date-time, with zod 3 wording when refused', () => {
    expect(utc.safeParse('soon').error?.issues[0]).toMatchObject({ code: 'invalid_format', format: 'datetime', message: 'Invalid datetime' });
  });
});

describe('route schemas keep their zod 3 detail', () => {
  it('POST /attribution/events', () => {
    expect(flat(eventSchema.safeParse({ value: -1, ts: 'soon', metadata: 'x', externalEventId: 'y'.repeat(121) }))).toEqual({
      formErrors: [],
      fieldErrors: {
        userId: ['Required'],
        type: ['Required'],
        value: ['Number must be greater than or equal to 0'],
        metadata: ['Expected object, received string'],
        ts: ['Invalid datetime'],
        externalEventId: ['String must contain at most 120 character(s)'],
      },
    });
  });

  it('POST /attribution/events takes a minute-precision ts and a numeric externalEventId', () => {
    const r = eventSchema.safeParse({ userId: 'u', type: 'signup', ts: '2026-10-16T10:00Z', externalEventId: 42 });
    expect(r.success && r.data).toEqual({ userId: 'u', type: 'signup', ts: '2026-10-16T10:00Z', externalEventId: '42' });
  });

  it('POST /attribution/conversions', () => {
    expect(flat(conversionSchema.safeParse({ clickId: 'c', type: 't', currency: 'dollars' }))).toEqual({
      formErrors: [],
      fieldErrors: { currency: ['currency must be a 3-letter ISO 4217 code'], externalEventId: ['Required'] },
    });
  });

  it('POST /attribution/refunds runs both object-level refinements', () => {
    const r = refundSchema.safeParse({ externalEventId: 'r1', conversionEventId: 'e', conversionExternalEventId: 'x', amount: 0.001 });
    expect(flat(r)).toEqual({
      formErrors: [],
      fieldErrors: {
        conversionExternalEventId: ['Send exactly one of conversionExternalEventId or conversionEventId.'],
        amount: ['amount must be at least 0.01.'],
      },
    });
  });

  it('GET /commissions query', () => {
    expect(flat(listQuerySchema.safeParse({ limit: '0', status: 'pending' }))).toEqual({
      formErrors: [],
      fieldErrors: {
        status: ["Invalid enum value. Expected 'accrued' | 'approved' | 'paid' | 'reversed', received 'pending'"],
        limit: ['Number must be greater than or equal to 1'],
      },
    });
  });

  it('PUT payout-profile: an unknown method', () => {
    expect(parsePayoutDetails({ method: 'cheque' })).toEqual({
      ok: false,
      error: field('method', "Invalid discriminator value. Expected 'paypal' | 'bank' | 'upi' | 'other'"),
    });
  });

  it('PUT payout-profile: bank field errors come before the cross-field checks', () => {
    const base = { method: 'bank', accountHolderName: 'Siobhán', country: 'GB', currency: 'GBP' };
    expect(parsePayoutDetails({ ...base, accountHolderName: '=SUM(A1)', iban: 'GB00WEST12345698765432' })).toEqual({
      ok: false,
      error: { formErrors: [], fieldErrors: { accountHolderName: ['must not start with =, +, - or @'], iban: ['iban is not a valid IBAN'] } },
    });
    expect(parsePayoutDetails({ ...base, country: 'FR', iban: 'GB82WEST12345698765432', accountNumber: '12345678' })).toEqual({
      ok: false,
      error: {
        formErrors: [],
        fieldErrors: { accountNumber: ['give an iban or an accountNumber, not both'], iban: ['iban is for a different country'] },
      },
    });
  });

  it('PUT payout-profile: values are normalised, and absent fields stay absent', () => {
    const r = parsePayoutDetails({ method: 'bank', accountHolderName: 'Siobhán', country: 'GB', currency: 'gbp', iban: 'gb82 west 1234 5698 7654 32' });
    expect(r).toEqual({
      ok: true,
      details: { method: 'bank', accountHolderName: 'Siobhán', accountHolderType: 'person', country: 'GB', currency: 'GBP', iban: 'GB82WEST12345698765432' },
    });
    expect(r.ok && Object.keys(r.details)).not.toContain('bic');
  });
});

describe.skipIf(skipIntegration)('the error envelope over HTTP', () => {
  const app = createApp({ enableLogger: false });

  it('invalid_body: { error, detail: { formErrors, fieldErrors } }', async () => {
    const res = await request(app)
      .post('/attribution/events')
      .set('Authorization', `Bearer ${ADMIN_KEY}`)
      .send({ type: '', value: 'ten', extra: true });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'invalid_body',
      detail: {
        formErrors: [],
        fieldErrors: {
          userId: ['Required'],
          type: ['String must contain at least 1 character(s)'],
          value: ['Expected number, received string'],
        },
      },
    });
  });

  it('invalid_query: the same shape', async () => {
    const res = await request(app).get('/commissions?limit=abc').set('Authorization', `Bearer ${ADMIN_KEY}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_query', detail: field('limit', 'Expected number, received nan') });
  });
});
