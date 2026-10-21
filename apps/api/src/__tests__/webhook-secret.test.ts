/**
 * Webhook signing secrets sealed at rest (webhook-secret.ts): sealed on
 * create and rotation, opened only to sign a delivery, plaintext rows
 * sealed by the dispatcher and the sweep, a fresh sealed secret on import,
 * and never a secret in a response it doesn't belong in, a log line or an
 * error message.
 */

import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { generateApiKey } from '../auth.js';
import { __resetCryptoKeyForTests, encryptSecret } from '../crypto.js';
import { exportAll, importBundle } from '../export.js';
import { SECRET_UNREADABLE_ERROR } from '../webhook-dispatcher.js';
import { isPlaintextSecret, openSecret, sealPlaintextWebhookSecrets, sealSecret } from '../webhook-secret.js';

const ADMIN_KEY = 'op_test_webhook_secret_admin_0123456789abcd';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';
// The receiver binds 127.0.0.1 (self-host-only escape hatch, as in
// webhooks.test.ts).
process.env.OPENPARTNER_OUTBOUND_ALLOW_PRIVATE_CIDRS = '127.0.0.1/32,::1/128';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

const OTHER_TENANT_ID = 'tnt_whsec_other';
const TABLES_TO_CLEAN = [TABLES.WebhookDelivery, TABLES.WebhookEndpoint, TABLES.ApiKey];

const app = createApp({ enableLogger: false });
const auth = { Authorization: `Bearer ${ADMIN_KEY}` };

interface Capture {
  headers: Record<string, string>;
  body: string;
}

let receiver: { url: string; captures: Capture[]; close: () => Promise<void> } | null = null;

function startReceiver(): Promise<NonNullable<typeof receiver>> {
  const captures: Capture[] = [];
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        captures.push({
          headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v ?? '')])),
          body,
        });
        res.statusCode = 200;
        res.end('ok');
      });
    });
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        captures,
        close: () => new Promise<void>((r, j) => server.close((err) => (err ? j(err) : r()))),
      });
    });
  });
}

/** What a receiver does with the docs' recipe. */
function verifies(capture: Capture, secret: string): boolean {
  const ts = capture.headers['x-openpartner-timestamp']!;
  const expected = createHmac('sha256', secret).update(`${ts}.${capture.body}`).digest('hex');
  return capture.headers['x-openpartner-signature'] === expected;
}

/** Everything written to the console while `fn` runs. */
async function consoleDuring(fn: () => Promise<unknown>): Promise<string> {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined),
  );
  try {
    await fn();
    return spies.flatMap((s) => s.mock.calls.flat().map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : String(a)))).join('\n');
  } finally {
    for (const s of spies) s.mockRestore();
  }
}

async function createEndpoint(url: string): Promise<{ id: string; secret: string }> {
  const res = await request(app).post('/webhooks').set(auth).send({ url, events: ['*'] });
  expect(res.status).toBe(201);
  return { id: res.body.endpoint.id as string, secret: res.body.secret as string };
}

async function insertEndpoint(secret: string, tenantId = DEFAULT_TENANT_ID): Promise<string> {
  const id = ulid();
  await db(TABLES.WebhookEndpoint).insert({
    id,
    tenantId,
    url: receiver?.url ?? 'https://hooks.x.test/openpartner',
    secretPrefix: secret.startsWith('whsec_') ? secret.slice(0, 12) : 'whsec_xxxxxx',
    secret,
    events: JSON.stringify(['*']),
    label: null,
    active: true,
  });
  return id;
}

const stored = async (id: string): Promise<{ secret: string; secretPrefix: string }> =>
  (await db(TABLES.WebhookEndpoint).where({ id }).first())!;

async function wipe(): Promise<void> {
  for (const t of TABLES_TO_CLEAN) await db(t).del();
  await db(TABLES.Tenant).where({ id: OTHER_TENANT_ID }).del();
}

beforeEach(async () => {
  if (skipIntegration) return;
  await wipe();
  receiver = await startReceiver();
});

afterEach(async () => {
  await receiver?.close();
  receiver = null;
});

afterAll(async () => {
  if (!skipIntegration) await wipe();
  await db.destroy();
});

describe.skipIf(skipIntegration)('webhook signing secrets at rest', () => {
  it('seals the secret on create; the response is the only place it appears', async () => {
    const { id, secret } = await createEndpoint(receiver!.url);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{32}$/);

    const row = await stored(id);
    expect(isPlaintextSecret(row.secret)).toBe(false);
    expect(row.secret).not.toContain(secret);
    expect(openSecret(row.secret)).toBe(secret);
    expect(row.secretPrefix).toBe(secret.slice(0, 12));

    const listed = await request(app).get('/webhooks').set(auth);
    const one = await request(app).get(`/webhooks/${id}`).set(auth);
    for (const res of [listed, one]) {
      expect(res.text).not.toContain(secret);
      expect(res.text).not.toContain(row.secret);
    }
    expect(one.body.endpoint).not.toHaveProperty('secret');
    expect(one.body.endpoint.secretPrefix).toBe(secret.slice(0, 12));
  });

  it('signs deliveries with the opened secret: X-OpenPartner-Signature verifies', async () => {
    const { id, secret } = await createEndpoint(receiver!.url);
    const fired = await request(app).post(`/webhooks/${id}/test?event=commission.paid`).set(auth);
    expect(fired.body.delivery.status).toBe('delivered');
    expect(receiver!.captures).toHaveLength(1);
    expect(verifies(receiver!.captures[0]!, secret)).toBe(true);
    // Not signed with the stored envelope.
    expect(verifies(receiver!.captures[0]!, (await stored(id)).secret)).toBe(false);
    // The delivery log doesn't hold the secret either.
    const log = await request(app).get(`/webhooks/${id}/deliveries`).set(auth);
    expect(log.text).not.toContain(secret);
  });

  it('rotation returns a new secret once, seals it, and the old one stops verifying', async () => {
    const { id, secret: old } = await createEndpoint(receiver!.url);
    const res = await request(app).post(`/webhooks/${id}/secret`).set(auth);
    expect(res.status).toBe(200);
    const fresh = res.body.secret as string;
    expect(fresh).toMatch(/^whsec_/);
    expect(fresh).not.toBe(old);
    expect(res.body.endpoint).not.toHaveProperty('secret');
    expect(res.body.endpoint.secretPrefix).toBe(fresh.slice(0, 12));

    const row = await stored(id);
    expect(isPlaintextSecret(row.secret)).toBe(false);
    expect(openSecret(row.secret)).toBe(fresh);
    expect(row.secretPrefix).toBe(fresh.slice(0, 12));

    await request(app).post(`/webhooks/${id}/test`).set(auth);
    const capture = receiver!.captures.at(-1)!;
    expect(verifies(capture, fresh)).toBe(true);
    expect(verifies(capture, old)).toBe(false);

    expect((await request(app).post(`/webhooks/${ulid()}/secret`).set(auth)).status).toBe(404);
  });

  it("a webhooks:write key can create endpoints but can't rotate one's secret", async () => {
    const { id } = await createEndpoint(receiver!.url);
    const key = generateApiKey();
    await db(TABLES.ApiKey).insert({
      id: ulid(),
      tenantId: DEFAULT_TENANT_ID,
      label: 'zapier',
      prefix: key.prefix,
      keyHash: key.hash,
      scopes: JSON.stringify(['webhooks:write']),
    });
    const created = await request(app)
      .post('/webhooks')
      .set('Authorization', `Bearer ${key.plaintext}`)
      .send({ url: receiver!.url, events: ['*'] });
    expect(created.status).toBe(201);
    const rotated = await request(app).post(`/webhooks/${id}/secret`).set('Authorization', `Bearer ${key.plaintext}`);
    expect(rotated.status).toBe(403);
    expect(rotated.body).not.toHaveProperty('secret');
  });

  it('signs with a plaintext secret left from before sealing, and seals it on the way', async () => {
    const legacy = 'whsec_legacy_plaintext_secret_00000001';
    const id = await insertEndpoint(legacy);
    const output = await consoleDuring(async () => {
      const fired = await request(app).post(`/webhooks/${id}/test`).set(auth);
      expect(fired.body.delivery.status).toBe('delivered');
    });
    expect(verifies(receiver!.captures[0]!, legacy)).toBe(true);
    const row = await stored(id);
    expect(isPlaintextSecret(row.secret)).toBe(false);
    expect(openSecret(row.secret)).toBe(legacy);
    expect(row.secretPrefix).toBe(legacy.slice(0, 12));
    expect(output).not.toContain(legacy);
  });

  it("never sends a delivery whose secret it can't open, and says to rotate", async () => {
    // Sealed under some other deployment's key.
    const before = process.env.SECRETS_ENCRYPTION_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = 'ab'.repeat(32);
    __resetCryptoKeyForTests();
    const foreign = encryptSecret('whsec_sealed_elsewhere_000000000000001');
    if (before === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = before;
    __resetCryptoKeyForTests();

    const id = await insertEndpoint(foreign);
    expect(openSecret(foreign)).toBeNull();
    const output = await consoleDuring(async () => {
      const fired = await request(app).post(`/webhooks/${id}/test`).set(auth);
      expect(fired.status).toBe(200);
      expect(fired.body.delivery).toMatchObject({ status: 'failed', error: SECRET_UNREADABLE_ERROR, attempts: 1 });
    });
    expect(receiver!.captures).toHaveLength(0);
    expect((await stored(id)).secret).toBe(foreign);
    expect(output).not.toContain(foreign);

    // Rotating is the way out.
    const fresh = (await request(app).post(`/webhooks/${id}/secret`).set(auth)).body.secret as string;
    await request(app).post(`/webhooks/${id}/test`).set(auth);
    expect(verifies(receiver!.captures[0]!, fresh)).toBe(true);
  });

  it('the sweep seals every plaintext secret across tenants, once, and logs none', async () => {
    await db(TABLES.Tenant).insert({ id: OTHER_TENANT_ID, slug: OTHER_TENANT_ID, displayName: 'Other', status: 'active' });
    const plain = ['whsec_sweep_one_0000000000000000000001', 'whsec_sweep_two_0000000000000000000002', 'whsec_sweep_three_00000000000000000003'];
    const ids = [
      await insertEndpoint(plain[0]!),
      await insertEndpoint(plain[1]!),
      await insertEndpoint(plain[2]!, OTHER_TENANT_ID),
    ];
    const alreadySealed = sealSecret('whsec_already_sealed_0000000000000004');
    const sealedId = await insertEndpoint(alreadySealed);

    let sealed = 0;
    // A batch of 2 makes it loop.
    const output = await consoleDuring(async () => {
      sealed = await sealPlaintextWebhookSecrets(db, 2);
    });
    expect(sealed).toBe(3);
    for (const [i, id] of ids.entries()) {
      const row = await stored(id);
      expect(isPlaintextSecret(row.secret)).toBe(false);
      expect(openSecret(row.secret)).toBe(plain[i]);
      expect(row.secretPrefix).toBe(plain[i]!.slice(0, 12));
    }
    expect((await stored(sealedId)).secret).toBe(alreadySealed);
    for (const p of plain) expect(output).not.toContain(p);

    // Idempotent: nothing left to seal, nothing changes.
    const after = await db(TABLES.WebhookEndpoint).orderBy('id').pluck('secret');
    expect(await sealPlaintextWebhookSecrets(db)).toBe(0);
    expect(await db(TABLES.WebhookEndpoint).orderBy('id').pluck('secret')).toEqual(after);
  });

  it("export → import: the bundle has no secret, the import's new one is sealed and signs", async () => {
    const { id, secret: original } = await createEndpoint(receiver!.url);
    const sealedOriginal = (await stored(id)).secret;
    const bundle = await exportAll(db, DEFAULT_TENANT_ID);
    const text = JSON.stringify(bundle);
    expect(text).not.toContain(original);
    expect(text).not.toContain(sealedOriginal);
    expect(text).not.toContain(original.slice(0, 12));

    await wipe();
    const report = await importBundle(db, DEFAULT_TENANT_ID, { [TABLES.WebhookEndpoint]: bundle[TABLES.WebhookEndpoint] ?? [] });
    const [shown] = report.credentials[TABLES.WebhookEndpoint] as Array<{ id: string; secret: string }>;
    expect(shown!.id).toBe(id);
    expect(shown!.secret).not.toBe(original);

    const row = await stored(id);
    expect(isPlaintextSecret(row.secret)).toBe(false);
    expect(openSecret(row.secret)).toBe(shown!.secret);
    expect(row.secretPrefix).toBe(shown!.secret.slice(0, 12));

    // Paused until the receiver has the new secret; turned back on, its
    // deliveries verify with the one the report showed.
    expect((await request(app).post(`/webhooks/${id}/test`).set(auth)).body.error).toBe('endpoint_inactive');
    await request(app).patch(`/webhooks/${id}`).set(auth).send({ active: true });
    await request(app).post(`/webhooks/${id}/test`).set(auth);
    expect(verifies(receiver!.captures.at(-1)!, shown!.secret)).toBe(true);
    expect(verifies(receiver!.captures.at(-1)!, original)).toBe(false);
  });

  // Error messages get logged (the API's 500 handler, job logs), and the
  // sweep's and the dispatcher's UPDATEs bind a plaintext secret. knex 3
  // on pg keeps `$1` placeholders in a failed query's message; this pins
  // that, so an upgrade that starts inlining values fails here.
  it("a failed query's error message doesn't carry its bound values", async () => {
    const id = await insertEndpoint(sealSecret('whsec_first_000000000000000000000001'));
    const value = 'whsec_must_not_appear_in_errors_00001';
    const err = await db(TABLES.WebhookEndpoint)
      .insert({ id, tenantId: DEFAULT_TENANT_ID, url: 'https://x.test', secretPrefix: value.slice(0, 12), secret: value, events: '[]', active: true })
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/duplicate key/);
    expect(err!.message).not.toContain(value);
    expect(err!.message).toContain('$');
  });
});
