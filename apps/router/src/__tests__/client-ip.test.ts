/**
 * Which address a click's ipHash (and so the velocity flag and the per-IP
 * cap) is keyed on. Unset, the router reads the left-most X-Forwarded-For
 * entry as it always has. With TRUST_PROXY=cloudflare (hosted: visitor →
 * Cloudflare → App Platform's ingress → router) it's the visitor behind the
 * edge, and a forged left-most entry doesn't move it.
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouterApp } from '../app.js';
import { fakeDb, type Row } from './fake-db.js';

// App Platform's ingress, as the router's socket sees it.
const INGRESS = { incoming: { socket: { remoteAddress: '::ffff:10.244.3.17' } } };
const EDGE = '172.71.30.204';

let tables: Record<string, Row[]>;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.TRUST_PROXY;
  tables = {
    Tenant: [
      { id: 't_acme', slug: 'acme', customDomain: null, status: 'active', approvalStatus: 'approved', pendingDeletionAt: null },
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
});

afterEach(() => {
  if (previous === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = previous;
});

const hash = (ip: string) => createHash('sha256').update(ip).digest('hex').slice(0, 32);

async function clickFrom(forwardedFor: string): Promise<unknown> {
  const app = createRouterApp(fakeDb(tables) as unknown as Parameters<typeof createRouterApp>[0]);
  const res = await app.request(
    '/r/acme/ada',
    { headers: { host: 'router.example.test', 'x-forwarded-for': forwardedFor } },
    INGRESS,
  );
  expect(res.status).toBe(302);
  return tables.Click!.at(-1)!.ipHash;
}

describe('router click IP, TRUST_PROXY=cloudflare', () => {
  beforeEach(() => {
    process.env.TRUST_PROXY = 'cloudflare';
  });

  it('is the visitor behind the Cloudflare edge', async () => {
    expect(await clickFrom(`203.0.113.7, ${EDGE}`)).toBe(hash('203.0.113.7'));
  });

  it("is whoever connected to Cloudflare, not the address they forged", async () => {
    expect(await clickFrom(`192.0.2.1, 198.51.100.9, ${EDGE}`)).toBe(hash('198.51.100.9'));
    expect(await clickFrom(`192.0.2.1, ${EDGE}, 198.51.100.9, ${EDGE}`)).toBe(hash('198.51.100.9'));
  });
});

describe('router click IP, TRUST_PROXY unset', () => {
  beforeEach(() => {
    delete process.env.TRUST_PROXY;
  });

  it('is the left-most entry, as before', async () => {
    expect(await clickFrom(`203.0.113.7, ${EDGE}`)).toBe(hash('203.0.113.7'));
  });
});

it('refuses to start with a TRUST_PROXY it does not know', () => {
  process.env.TRUST_PROXY = 'yes';
  expect(() => createRouterApp(fakeDb(tables) as unknown as Parameters<typeof createRouterApp>[0])).toThrow(
    /TRUST_PROXY/,
  );
});
