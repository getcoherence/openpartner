/**
 * An admin's test click (/r/_test/<token>, and /_test/<token> behind DO's
 * ingress). The router claims the TestClick row the API created, once and
 * before it expires, and redirects to the program's destination exactly as
 * a partner's click would. It never writes a Click: nothing that reads
 * clicks may see a test.
 */

import { createHash, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRouterApp } from '../app.js';
import { fakeDb, NODE_BINDINGS, type Row } from './fake-db.js';

let tables: Record<string, Row[]>;
let app: ReturnType<typeof createRouterApp>;

const token = () => randomBytes(32).toString('base64url');
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

function addTest(t: string, over: Row = {}): Row {
  const row: Row = {
    id: `tc_${tables.TestClick!.length + 1}`,
    tenantId: 't_acme',
    programId: 'pr_acme',
    tokenHash: hash(t),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 30 * 60_000),
    clickId: null,
    clickedAt: null,
    destination: null,
    landedAt: null,
    landingHost: null,
    identifiedAt: null,
    ...over,
  };
  tables.TestClick!.push(row);
  return row;
}

beforeEach(() => {
  tables = {
    Tenant: [
      { id: 't_acme', slug: 'acme', customDomain: null, status: 'active', approvalStatus: 'approved', pendingDeletionAt: null },
    ],
    Partner: [{ id: 'p_acme', tenantId: 't_acme', revokedAt: null }],
    Program: [
      { id: 'pr_acme', tenantId: 't_acme', destinationUrl: 'https://acme.example.test/landing', blockedAt: null },
      { id: 'pr_pay', tenantId: 't_acme', destinationUrl: 'https://acme.example.test/buy?ref={click_id}', blockedAt: null },
    ],
    Link: [
      { id: 'l_acme', tenantId: 't_acme', linkKey: 'ada', partnerId: 'p_acme', programId: 'pr_acme', destinationUrl: null },
    ],
    Click: [],
    TestClick: [],
  };
  app = createRouterApp(fakeDb(tables) as unknown as Parameters<typeof createRouterApp>[0]);
});

const get = (path: string) => app.request(path, { headers: { host: 'router.example.test' } }, NODE_BINDINGS);

describe('router test clicks', () => {
  it('claims the test, redirects with the click id and sets the cookie, without a Click', async () => {
    const t = token();
    const row = addTest(t);
    const res = await get(`/r/_test/${t}`);
    expect(res.status).toBe(302);
    expect(row.clickId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(row.clickedAt).toBeInstanceOf(Date);
    expect(res.headers.get('location')).toBe(`https://acme.example.test/landing?cref=${row.clickId}`);
    expect(row.destination).toBe(res.headers.get('location'));
    expect(res.headers.get('set-cookie')).toContain(`_cref=${row.clickId};`);
    expect(tables.Click).toEqual([]);
  });

  it('serves the prefix-stripped path the DO ingress forwards', async () => {
    const t = token();
    const row = addTest(t);
    const res = await get(`/_test/${t}`);
    expect(res.status).toBe(302);
    expect(row.clickedAt).not.toBeNull();
    expect(tables.Click).toEqual([]);
  });

  it('puts the click id where the destination’s {click_id} macro says', async () => {
    const t = token();
    const row = addTest(t, { programId: 'pr_pay' });
    const res = await get(`/r/_test/${t}`);
    expect(res.headers.get('location')).toBe(`https://acme.example.test/buy?ref=${row.clickId}`);
  });

  it('is single-use: a second open records nothing and says the link is spent', async () => {
    const t = token();
    const row = addTest(t);
    await get(`/r/_test/${t}`);
    const first = row.clickId;
    const again = await get(`/r/_test/${t}`);
    expect(again.status).toBe(410);
    expect(await again.text()).toContain('Send a new test click');
    expect(again.headers.get('set-cookie')).toBeNull();
    expect(row.clickId).toBe(first);
    expect(tables.Click).toEqual([]);
  });

  it('refuses an expired link', async () => {
    const t = token();
    const row = addTest(t, { expiresAt: new Date(Date.now() - 1000) });
    const res = await get(`/r/_test/${t}`);
    expect(res.status).toBe(410);
    expect(row.clickedAt).toBeNull();
  });

  it('refuses a token nobody issued, or one of the wrong shape, without a click of any kind', async () => {
    addTest(token());
    for (const path of [`/r/_test/${token()}`, '/r/_test/short', `/_test/${'!'.repeat(43)}`]) {
      const res = await get(path);
      expect(res.status).toBe(404);
    }
    expect(tables.TestClick!.every((r) => r.clickedAt === null)).toBe(true);
    expect(tables.Click).toEqual([]);
  });

  it('a partner link carrying a token stays a normal click: only the test path reads tokens', async () => {
    const t = token();
    const row = addTest(t);
    const res = await get(`/r/acme/ada?op_test=${t}&token=${t}`);
    expect(res.status).toBe(302);
    expect(tables.Click).toHaveLength(1);
    expect(tables.Click![0]!.fraudFlag).toBeNull();
    expect(row.clickedAt).toBeNull();
  });

  it('honours the brand gate and a blocked program, and leaves the test unclaimed', async () => {
    const t1 = token();
    const pending = addTest(t1);
    tables.Tenant![0]!.approvalStatus = 'pending';
    expect((await get(`/r/_test/${t1}`)).status).toBe(404);
    expect(pending.clickedAt).toBeNull();

    tables.Tenant![0]!.approvalStatus = 'approved';
    tables.Program![0]!.blockedAt = new Date();
    const t2 = token();
    const blocked = addTest(t2);
    expect((await get(`/r/_test/${t2}`)).status).toBe(410);
    expect(blocked.clickedAt).toBeNull();
    expect(tables.Click).toEqual([]);
  });

  it('only reads the program inside the test’s own tenant', async () => {
    tables.Program!.push({ id: 'pr_other', tenantId: 't_other', destinationUrl: 'https://other.example.test/', blockedAt: null });
    const t = token();
    const row = addTest(t, { programId: 'pr_other' });
    const res = await get(`/r/_test/${t}`);
    expect(res.status).toBe(410);
    expect(row.clickedAt).toBeNull();
  });
});
