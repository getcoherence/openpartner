/**
 * The click router only records clicks for a brand that is active,
 * approved and not pending deletion. A brand that asked to be deleted
 * stops collecting attribution data at once, on every URL shape: the
 * slug route, a white-label custom domain, and the key-only fallback
 * (which used to skip the tenant check entirely).
 *
 * Runs against an in-memory stand-in for the few knex calls the router
 * makes, not Postgres: `pnpm test` runs packages in parallel, and the API
 * suite wipes and counts the same tables in the shared database.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { createRouterApp } from '../app.js';

type Row = Record<string, unknown>;

/** `db(table).where({...}).first(cols?)` and `db(table).insert(row)`. */
function fakeDb(tables: Record<string, Row[]>) {
  return (name: string) => {
    const rows = (tables[name] ??= []);
    const filters: Row[] = [];
    const builder = {
      where(filter: Row) {
        filters.push(filter);
        return builder;
      },
      async first(cols?: string[]) {
        const row = rows.find((r) => filters.every((f) => Object.entries(f).every(([k, v]) => r[k] === v)));
        return row && cols ? Object.fromEntries(cols.map((c) => [c, row[c]])) : row;
      },
      async insert(row: Row) {
        rows.push(row);
      },
    };
    return builder;
  };
}

// What @hono/node-server hands the app; resolveLink reads the socket IP.
const NODE_BINDINGS = { incoming: { socket: { remoteAddress: '203.0.113.7' } } };

interface Brand {
  tenantId: string;
  slug: string;
  linkKey: string;
  domain: string;
}

let tables: Record<string, Row[]>;
let app: ReturnType<typeof createRouterApp>;

function seedBrand(name: string, tenant: Row = {}): Brand {
  const brand: Brand = {
    tenantId: `t_${name}`,
    slug: name,
    linkKey: `key-${name}`,
    domain: `${name}.example.test`,
  };
  tables.Tenant!.push({
    id: brand.tenantId,
    slug: brand.slug,
    customDomain: brand.domain,
    status: 'active',
    approvalStatus: 'approved',
    pendingDeletionAt: null,
    ...tenant,
  });
  tables.Partner!.push({ id: `p_${name}`, tenantId: brand.tenantId, revokedAt: null });
  tables.Program!.push({
    id: `pr_${name}`,
    tenantId: brand.tenantId,
    destinationUrl: 'https://brand.example.test/landing',
    blockedAt: null,
  });
  tables.Link!.push({
    id: `l_${name}`,
    tenantId: brand.tenantId,
    linkKey: brand.linkKey,
    partnerId: `p_${name}`,
    programId: `pr_${name}`,
    destinationUrl: null,
  });
  return brand;
}

const clicks = (tenantId: string) => tables.Click!.filter((c) => c.tenantId === tenantId).length;

const get = (path: string, host = 'router.example.test') =>
  app.request(path, { headers: { host } }, NODE_BINDINGS);

beforeEach(() => {
  tables = { Tenant: [], Partner: [], Program: [], Link: [], Click: [] };
  app = createRouterApp(fakeDb(tables) as unknown as Parameters<typeof createRouterApp>[0]);
});

describe('router tenant gate', () => {
  it('records and redirects for a live brand on every URL shape', async () => {
    const live = seedBrand('live');
    for (const [path, host] of [
      [`/r/${live.slug}/${live.linkKey}`, undefined],
      [`/${live.slug}/${live.linkKey}`, undefined],
      [`/r/${live.linkKey}`, live.domain],
      [`/r/${live.linkKey}`, undefined],
    ] as const) {
      const res = await get(path, host);
      expect(res.status, `${host ?? ''}${path}`).toBe(302);
      expect(res.headers.get('location')).toMatch(/^https:\/\/brand\.example\.test\/landing\?cref=/);
      expect(res.headers.get('set-cookie')).toMatch(/^_cref=/);
    }
    expect(clicks(live.tenantId)).toBe(4);
  });

  it('refuses a brand pending deletion on every URL shape, recording nothing', async () => {
    const deleting = seedBrand('deleting', { pendingDeletionAt: new Date() });
    for (const [path, host] of [
      [`/r/${deleting.slug}/${deleting.linkKey}`, undefined],
      [`/${deleting.slug}/${deleting.linkKey}`, undefined],
      // Its own custom domain, and the key-only fallback on an unknown host.
      [`/r/${deleting.linkKey}`, deleting.domain],
      [`/${deleting.linkKey}`, deleting.domain],
      [`/r/${deleting.linkKey}`, undefined],
      [`/${deleting.linkKey}`, undefined],
    ] as const) {
      const res = await get(path, host);
      expect(res.status, `${host ?? ''}${path}`).toBe(404);
      expect(await res.text()).toBe('Tenant not found');
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(clicks(deleting.tenantId)).toBe(0);
  });

  it("a pending-deletion brand's domain never falls through to another brand's link", async () => {
    const deleting = seedBrand('deleting', { pendingDeletionAt: new Date() });
    // Another brand uses the same key; the global lookup would find it.
    seedBrand('other');
    tables.Link!.find((l) => l.tenantId === 't_other')!.linkKey = deleting.linkKey;
    tables.Link = tables.Link!.filter((l) => l.tenantId !== deleting.tenantId);

    const res = await get(`/r/${deleting.linkKey}`, deleting.domain);
    expect(res.status).toBe(404);
    expect(tables.Click).toHaveLength(0);
  });

  it('the key-only fallback applies the approval and status checks the slug route already had', async () => {
    const pending = seedBrand('pending', { approvalStatus: 'pending' });
    const suspended = seedBrand('suspended', { status: 'suspended' });
    for (const brand of [pending, suspended]) {
      const res = await get(`/r/${brand.linkKey}`);
      expect(res.status).toBe(404);
    }
    expect(tables.Click).toHaveLength(0);
  });
});
