/**
 * What the router records on a Click from the inbound partner link: the
 * UTMs and the publisher's `sub_id`. Neither is forwarded to the
 * destination, which only ever gets our click id.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createRouterApp } from '../app.js';
import { fakeDb, NODE_BINDINGS, type Row } from './fake-db.js';

let tables: Record<string, Row[]>;
let app: ReturnType<typeof createRouterApp>;

beforeEach(() => {
  tables = {
    Tenant: [
      {
        id: 't_acme',
        slug: 'acme',
        customDomain: null,
        status: 'active',
        approvalStatus: 'approved',
        pendingDeletionAt: null,
      },
    ],
    Partner: [{ id: 'p_acme', tenantId: 't_acme', revokedAt: null }],
    Program: [
      { id: 'pr_acme', tenantId: 't_acme', destinationUrl: 'https://acme.example.test/landing', blockedAt: null },
    ],
    Link: [
      { id: 'l_acme', tenantId: 't_acme', linkKey: 'ada', partnerId: 'p_acme', programId: 'pr_acme', destinationUrl: null },
    ],
    Click: [],
  };
  app = createRouterApp(fakeDb(tables) as unknown as Parameters<typeof createRouterApp>[0]);
});

const get = (query: string) =>
  app.request(`/r/acme/ada${query}`, { headers: { host: 'router.example.test' } }, NODE_BINDINGS);

describe('router click capture', () => {
  it('stores ?sub_id on the click and keeps it off the destination', async () => {
    const res = await get('?sub_id=wct_9f2a-17&utm_source=newsletter');
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    const click = tables.Click![0]!;
    expect(location).toBe(`https://acme.example.test/landing?cref=${click.id}`);
    expect(location).not.toContain('sub_id');
    expect(click.subId).toBe('wct_9f2a-17');
    expect(click.utmSource).toBe('newsletter');
  });

  it('decodes, trims and caps sub_id at 255 characters', async () => {
    await get(`?sub_id=${encodeURIComponent('  a b&c=d  ')}`);
    await get(`?sub_id=${'x'.repeat(300)}`);
    expect(tables.Click!.map((c) => c.subId)).toEqual(['a b&c=d', 'x'.repeat(255)]);
  });

  it('stores null when sub_id is missing, empty or only whitespace', async () => {
    await get('');
    await get('?sub_id=');
    await get('?sub_id=%20%20');
    expect(tables.Click!.map((c) => c.subId)).toEqual([null, null, null]);
  });
});
