/**
 * Vendor-side Network payout aggregation + report-to-Network flow.
 *
 * Spins up a local HTTP receiver acting as the Network's
 * /vendors/me/report-payouts endpoint, configures network_membership,
 * seeds Payout + Partner rows (some Network-originated, some not),
 * and verifies aggregateNetworkOriginatedPayouts + the
 * reportNetworkPayoutsToNetwork glue.
 *
 * Skipped if DATABASE_URL isn't set.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { aggregateNetworkOriginatedPayouts } from '../usage-billing.js';
import { reportNetworkPayoutsToNetwork } from '../network-client.js';
import { encryptSecret } from '../crypto.js';
import { CONFIG_KEYS, getConfig } from '../config.js';

process.env.OPENPARTNER_MODE = process.env.OPENPARTNER_MODE ?? 'selfhost';
process.env.OPENPARTNER_TENANCY = process.env.OPENPARTNER_TENANCY ?? 'single';
process.env.PORTAL_URL = process.env.PORTAL_URL ?? 'http://localhost:5673';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

interface ReceivedPayout {
  amountUsd: number;
  sinceIso: string | null;
  untilIso: string;
  authorization: string | undefined;
}

let receiver: Server;
let receiverUrl: string;
const received: ReceivedPayout[] = [];
let mockResponse: { status: number; body: unknown } = { status: 202, body: { accepted: true } };

beforeAll(async () => {
  if (skipIntegration) return;
  await db.raw('select 1');
  await new Promise<void>((resolve) => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
        if (req.url === '/vendors/me/report-payouts' && req.method === 'POST') {
          received.push({
            amountUsd: (body as { amountUsd: number }).amountUsd,
            sinceIso: (body as { sinceIso: string | null }).sinceIso,
            untilIso: (body as { untilIso: string }).untilIso,
            authorization: req.headers.authorization,
          });
        }
        res.writeHead(mockResponse.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(mockResponse.body));
      });
    }).listen(0, '127.0.0.1', () => {
      const addr = receiver.address() as AddressInfo;
      receiverUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  if (receiver) await new Promise<void>((r) => receiver.close(() => r()));
  await db.destroy();
});

const TABLES_TO_CLEAN = [
  TABLES.Payout,
  TABLES.Partner,
  TABLES.Config,
];

beforeEach(async () => {
  if (skipIntegration) return;
  for (const t of TABLES_TO_CLEAN) {
    await db(t).whereIn('tenantId', [DEFAULT_TENANT_ID]).del();
  }
  received.length = 0;
  mockResponse = { status: 202, body: { accepted: true } };
});

async function configureNetwork(opts: { enabled: boolean; url?: string }): Promise<void> {
  const value = {
    enabled: opts.enabled,
    networkUrl: opts.url ?? receiverUrl,
    vendorTokenCiphertext: encryptSecret('vntok_test'),
    scopedKeyId: null,
    autoEnroll: true,
  };
  await db(TABLES.Config)
    .insert({ tenantId: DEFAULT_TENANT_ID, key: 'network_membership', value: value as unknown as never, updatedAt: new Date() })
    .onConflict(['tenantId', 'key'])
    .merge({ value: value as unknown as never, updatedAt: new Date() });
}

async function seedPartner(opts: { id?: string; networkCreatorId: string | null }): Promise<string> {
  const id = opts.id ?? ulid();
  const metadata = opts.networkCreatorId
    ? { network: { creatorId: opts.networkCreatorId, preExisting: false, syncedAt: new Date().toISOString() } }
    : {};
  await db(TABLES.Partner).insert({
    id,
    tenantId: DEFAULT_TENANT_ID,
    email: `${id}@example.test`,
    name: 'P',
    metadata: metadata as unknown as never,
    activatedAt: new Date(),
  });
  return id;
}

async function seedPayout(opts: {
  partnerId: string;
  amount: number;
  status: 'paid' | 'pending' | 'failed';
  completedAt?: Date | null;
}): Promise<void> {
  await db(TABLES.Payout).insert({
    id: ulid(),
    tenantId: DEFAULT_TENANT_ID,
    partnerId: opts.partnerId,
    amount: opts.amount.toFixed(2),
    currency: 'USD',
    method: 'manual',
    status: opts.status,
    metadata: {} as unknown as never,
    completedAt: opts.completedAt ?? (opts.status === 'paid' ? new Date() : null),
  });
}

describe.skipIf(skipIntegration)('aggregateNetworkOriginatedPayouts', () => {
  it('sums only paid payouts whose Partner has metadata.network.creatorId', async () => {
    const networkPartner = await seedPartner({ networkCreatorId: 'crt_alice' });
    const directPartner = await seedPartner({ networkCreatorId: null });
    await seedPayout({ partnerId: networkPartner, amount: 100, status: 'paid' });
    await seedPayout({ partnerId: networkPartner, amount: 250, status: 'paid' });
    // Pending: doesn't count.
    await seedPayout({ partnerId: networkPartner, amount: 999, status: 'pending', completedAt: null });
    // Direct partner: doesn't count even if paid.
    await seedPayout({ partnerId: directPartner, amount: 500, status: 'paid' });

    const total = await aggregateNetworkOriginatedPayouts(db, null, new Date());
    expect(total).toBe(350);
  });

  it('respects since (exclusive) + until (inclusive) bounds', async () => {
    const p = await seedPartner({ networkCreatorId: 'crt_x' });
    const earlier = new Date(Date.now() - 60_000);
    const later = new Date();
    await seedPayout({ partnerId: p, amount: 50, status: 'paid', completedAt: earlier });
    await seedPayout({ partnerId: p, amount: 75, status: 'paid', completedAt: later });

    // Window: (earlier, later] — first payout is excluded by since.
    const total = await aggregateNetworkOriginatedPayouts(db, earlier, later);
    expect(total).toBe(75);
  });

  it('returns 0 when no payouts in range', async () => {
    const total = await aggregateNetworkOriginatedPayouts(db, null, new Date());
    expect(total).toBe(0);
  });
});

describe.skipIf(skipIntegration)('reportNetworkPayoutsToNetwork', () => {
  it('skips when network membership not enabled', async () => {
    // No config row → reason='network_not_configured'.
    const r = await reportNetworkPayoutsToNetwork(db, DEFAULT_TENANT_ID);
    expect(r.reported).toBe(false);
    expect(r.reason).toBe('network_not_configured');
    expect(received).toHaveLength(0);
  });

  it('skips + advances high-water mark when amount is zero', async () => {
    await configureNetwork({ enabled: true });
    const r = await reportNetworkPayoutsToNetwork(db, DEFAULT_TENANT_ID);
    expect(r.reported).toBe(false);
    expect(r.reason).toBe('no_network_payouts_in_range');
    expect(r.amountUsd).toBe(0);
    // High-water mark advanced.
    const mark = await getConfig<string>(db, DEFAULT_TENANT_ID, CONFIG_KEYS.LastNetworkPayoutsReportedAt);
    expect(mark).toBeTruthy();
  });

  it('reports the right total + sets bearer + advances high-water mark on success', async () => {
    await configureNetwork({ enabled: true });
    const p = await seedPartner({ networkCreatorId: 'crt_z' });
    await seedPayout({ partnerId: p, amount: 1000, status: 'paid' });
    await seedPayout({ partnerId: p, amount: 234.56, status: 'paid' });

    const r = await reportNetworkPayoutsToNetwork(db, DEFAULT_TENANT_ID);
    expect(r.reported).toBe(true);
    expect(r.amountUsd).toBe(1234.56);
    expect(received).toHaveLength(1);
    expect(received[0]!.amountUsd).toBe(1234.56);
    expect(received[0]!.authorization).toBe('Bearer vntok_test');

    // Mark advanced.
    const mark = await getConfig<string>(db, DEFAULT_TENANT_ID, CONFIG_KEYS.LastNetworkPayoutsReportedAt);
    expect(mark).toBeTruthy();
  });

  it('on Network 5xx: does NOT advance high-water mark (so next tick re-reports)', async () => {
    await configureNetwork({ enabled: true });
    const p = await seedPartner({ networkCreatorId: 'crt_q' });
    await seedPayout({ partnerId: p, amount: 100, status: 'paid' });

    mockResponse = { status: 503, body: { error: 'unavailable' } };
    const r = await reportNetworkPayoutsToNetwork(db, DEFAULT_TENANT_ID);
    expect(r.reported).toBe(false);
    expect(r.reason).toContain('network 503');
    const mark = await getConfig<string>(db, DEFAULT_TENANT_ID, CONFIG_KEYS.LastNetworkPayoutsReportedAt);
    expect(mark).toBeNull();
  });

  it('second consecutive successful run only includes payouts after the first run', async () => {
    await configureNetwork({ enabled: true });
    const p = await seedPartner({ networkCreatorId: 'crt_r' });
    await seedPayout({ partnerId: p, amount: 50, status: 'paid' });

    const r1 = await reportNetworkPayoutsToNetwork(db, DEFAULT_TENANT_ID);
    expect(r1.amountUsd).toBe(50);

    // Add a new payout post-mark, then re-run.
    await seedPayout({ partnerId: p, amount: 25, status: 'paid' });
    const r2 = await reportNetworkPayoutsToNetwork(db, DEFAULT_TENANT_ID);
    expect(r2.amountUsd).toBe(25);
  });
});
