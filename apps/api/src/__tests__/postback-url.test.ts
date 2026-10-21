/**
 * Partner postback URLs sealed at rest (postback-url.ts): sealed on create
 * and update (once a rolling deploy's grace is over), opened only to fire,
 * to the partner who owns it, and in the export; masked everywhere else;
 * plaintext rows sealed by the sweep; re-sealed on JSON import, and sealed
 * by the sweep after a SQL restore; never in a log line or an error.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { ulid } from 'ulid';
import ipaddr from 'ipaddr.js';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { db } from '../db.js';
import { createApp } from '../app.js';
import { createSession } from '../auth-sessions.js';
import { __resetCryptoKeyForTests, encryptSecret } from '../crypto.js';
import { buildSqlDump, exportAll, exportColumnTypes, importBundle } from '../export.js';
import { __setOutboundPolicyForTests } from '../outbound-guard.js';
import { URL_UNREADABLE_ERROR, dispatchPartnerPostbacks } from '../partner-postback.js';
import {
  isPlaintextPostbackUrl,
  maskPostbackUrl,
  openPostbackUrl,
  postbackUrlPreview,
  runSealPostbackUrlsJob,
  sealPlaintextPostbackUrls,
  sealPostbackUrl,
} from '../postback-url.js';
import { SEAL_AFTER_UPTIME_S } from '../webhook-secret.js';

const ADMIN_KEY = 'op_test_postback_url_admin_0123456789abcdef';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_MODE = 'selfhost';
process.env.OPENPARTNER_TENANCY = 'single';

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';

const OTHER_TENANT_ID = 'tnt_pburl_other';
const SECRET = 'trk_s3cr3t_9f2a17c0';

const app = createApp({ enableLogger: false });
const admin = { Authorization: `Bearer ${ADMIN_KEY}` };

let receiver: Server;
let receiverBase: string;
const calls: string[] = [];

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

/** Past the deploy grace, as a process that has been up a while is. */
function afterGrace(): void {
  vi.spyOn(process, 'uptime').mockReturnValue(SEAL_AFTER_UPTIME_S + 1);
}

/** Inside it, as a process that just started is. */
function inGrace(): void {
  vi.spyOn(process, 'uptime').mockReturnValue(30);
}

/** A tracker URL with a secret in it, pointing at the capturing receiver. */
function trackerUrl(path = 'pb', secret = SECRET): string {
  return `${receiverBase}/${path}?cid={click_id}&amt={commission_amount}&secret=${secret}`;
}

async function insertPartner(tenantId = DEFAULT_TENANT_ID): Promise<string> {
  const id = ulid();
  await db(TABLES.Partner).insert({ id, tenantId, email: `${id.toLowerCase()}@pburl.test`, name: 'Postback URL' });
  return id;
}

async function partnerCookie(partnerId: string): Promise<string> {
  const session = await createSession(db, { tenantId: DEFAULT_TENANT_ID, principalKind: 'partner', principalId: partnerId });
  return `op_session=${session.plaintext}`;
}

async function insertPostback(partnerId: string, url: string, tenantId = DEFAULT_TENANT_ID): Promise<string> {
  const id = ulid();
  await db(TABLES.PartnerPostback).insert({
    id,
    tenantId,
    partnerId,
    url,
    events: JSON.stringify(['commission.accrued']),
    enabled: true,
  });
  return id;
}

const stored = async (id: string): Promise<{ url: string; urlPreview: string | null; lastError: string | null; failureCount: number; successCount: number }> =>
  (await db(TABLES.PartnerPostback).where({ id }).first())!;

async function waitFor<T>(check: () => Promise<T | null | undefined> | T | null | undefined, timeoutMs = 3000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('waitFor timeout');
}

/** Run a multi-statement script the way psql would. */
async function runSql(sql: string): Promise<void> {
  const conn = (await db.client.acquireConnection()) as { query: (q: string) => Promise<unknown> };
  try {
    await conn.query(sql);
  } finally {
    await db.client.releaseConnection(conn);
  }
}

async function wipe(): Promise<void> {
  await db(TABLES.PartnerPostback).del();
  await db(TABLES.Session).del();
  await db(TABLES.Partner).del();
  await db(TABLES.Tenant).where({ id: OTHER_TENANT_ID }).del();
}

describe('maskPostbackUrl', () => {
  it('keeps the host and each name={macro} pair; masks the path and every other pair', () => {
    expect(maskPostbackUrl('https://t.example/v1/pb?cid={click_id}&key=abc123&amt={commission_amount}')).toBe(
      'https://t.example/•••?cid={click_id}&•••&amt={commission_amount}',
    );
  });

  it('masks a secret wherever a tracker might put it', () => {
    // Keitaro-style key in the path, a bare token, a macro with text around it.
    expect(maskPostbackUrl('https://k.example/a1b2c3d/postback?subid={click_id}')).toBe('https://k.example/•••?subid={click_id}');
    expect(maskPostbackUrl('https://t.example/?TOKEN123&cid={click_id}')).toBe('https://t.example/?•••&cid={click_id}');
    expect(maskPostbackUrl('https://t.example/?tx=s3cr3t-{event_id}')).toBe('https://t.example/?•••');
    // A brace-wrapped name the dispatcher doesn't fill stays literal when
    // fired, so it may be the secret itself; so may a parameter name.
    expect(maskPostbackUrl('https://t.example/?secret={my_tracker_secret}')).toBe('https://t.example/?•••');
    expect(maskPostbackUrl(`https://t.example/?${SECRET}=1&cid={click_id}`)).toBe('https://t.example/?•••&cid={click_id}');
    expect(maskPostbackUrl(`https://t.example/?${SECRET}=`)).toBe('https://t.example/?•••');
    // A name that isn't plain (percent-encoded), the fragment, any userinfo.
    expect(maskPostbackUrl('https://t.example/?%73ecret={click_id}')).toBe('https://t.example/?•••');
    expect(maskPostbackUrl('https://t.example/pb#frag')).toBe('https://t.example/•••#•••');
    expect(maskPostbackUrl('https://user:pass@t.example/')).toBe('https://•••@t.example/');
  });

  it('keeps the port, and copes with no path or query', () => {
    expect(maskPostbackUrl('http://t.example:8080?sub=&x=1&st={status}')).toBe('http://t.example:8080/?•••&•••&st={status}');
    expect(maskPostbackUrl('https://t.example')).toBe('https://t.example/');
    expect(maskPostbackUrl('not a url')).toBe('•••');
  });

  it('never contains the secret', () => {
    for (const url of [
      `https://t.example/pb/${SECRET}?secret=${SECRET}&s2=${encodeURIComponent(SECRET)}#${SECRET}`,
      `https://t.example/?${SECRET}=1&k={${SECRET}}`,
      `https://t.example/?{${SECRET}}=1&${SECRET}`,
    ]) {
      expect(maskPostbackUrl(url)).not.toContain(SECRET);
    }
    // The one place a secret-shaped name survives: as the name of a known
    // macro's parameter, which is how trackers name their fields.
    expect(maskPostbackUrl('https://t.example/?clickid={click_id}')).toBe('https://t.example/?clickid={click_id}');
  });
});

describe('sealing', () => {
  it('seals to an envelope that opens to the URL, and tells the two apart', () => {
    const url = 'https://t.example/pb?secret=abc';
    const sealed = sealPostbackUrl(url);
    expect(isPlaintextPostbackUrl(url)).toBe(true);
    expect(isPlaintextPostbackUrl(sealed)).toBe(false);
    expect(sealed).not.toContain('abc');
    expect(openPostbackUrl(sealed)).toBe(url);
    expect(openPostbackUrl(url)).toBe(url);
    expect(openPostbackUrl('bm90IGFuIGVudmVsb3Bl')).toBeNull();
  });

  it("a plaintext row's preview is masked from what is stored, even if its stored preview is stale", () => {
    expect(postbackUrlPreview({ url: 'https://new.example/?k=1', urlPreview: 'https://old.example/?•••' })).toBe('https://new.example/?•••');
    expect(postbackUrlPreview({ url: sealPostbackUrl('https://t.example/?k=1'), urlPreview: 'https://t.example/?•••' })).toBe('https://t.example/?•••');
    expect(postbackUrlPreview({ url: sealPostbackUrl('https://t.example/?k=1'), urlPreview: null })).toBeNull();
  });
});

beforeAll(async () => {
  if (skipIntegration) return;
  // The receiver binds 127.0.0.1, and partner postbacks use the hardened
  // policy (no env escape hatch), as in partner-postback.integration.test.ts.
  __setOutboundPolicyForTests({ allowedPorts: null, privateCidrs: [ipaddr.parseCIDR('127.0.0.1/32')] });
  await new Promise<void>((resolve) => {
    receiver = createServer((req, res) => {
      calls.push(req.url ?? '');
      res.writeHead(200).end('ok');
    }).listen(0, '127.0.0.1', () => {
      receiverBase = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

beforeEach(async () => {
  if (skipIntegration) return;
  await wipe();
  calls.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  __setOutboundPolicyForTests(null);
  if (receiver) await new Promise<void>((r) => receiver.close(() => r()));
  if (!skipIntegration) await wipe();
  await db.destroy();
});

describe.skipIf(skipIntegration)('partner postback URLs at rest', () => {
  it('seals the URL on create; no response carries it', async () => {
    afterGrace();
    const partnerId = await insertPartner();
    const url = trackerUrl();
    const created = await request(app)
      .post(`/partners/${partnerId}/postbacks`)
      .set('Cookie', await partnerCookie(partnerId))
      .send({ url, events: ['commission.accrued'] });
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty('url');
    expect(created.text).not.toContain(SECRET);
    expect(created.body.urlPreview).toBe(`${receiverBase}/•••?cid={click_id}&amt={commission_amount}&•••`);

    const row = await stored(created.body.id);
    expect(isPlaintextPostbackUrl(row.url)).toBe(false);
    expect(row.url).not.toContain(SECRET);
    expect(openPostbackUrl(row.url)).toBe(url);
    expect(row.urlPreview).toBe(created.body.urlPreview);

    // An admin creating one on a partner's behalf gets it sealed the same way.
    const byAdmin = await request(app).post(`/partners/${partnerId}/postbacks`).set(admin).send({ url: trackerUrl('admin'), events: ['commission.paid'] });
    expect(byAdmin.status).toBe(201);
    expect(byAdmin.text).not.toContain(SECRET);
    expect(openPostbackUrl((await stored(byAdmin.body.id)).url)).toBe(trackerUrl('admin'));
  });

  it('seals a new URL on update, and leaves the URL alone when only events change', async () => {
    afterGrace();
    const partnerId = await insertPartner();
    const cookie = await partnerCookie(partnerId);
    const created = await request(app).post(`/partners/${partnerId}/postbacks`).set('Cookie', cookie).send({ url: trackerUrl(), events: ['commission.accrued'] });
    const id = created.body.id as string;

    const next = trackerUrl('v2', 'rotated_secret_77');
    const updated = await request(app).patch(`/partners/${partnerId}/postbacks/${id}`).set('Cookie', cookie).send({ url: next });
    expect(updated.status).toBe(200);
    expect(updated.body).not.toHaveProperty('url');
    expect(updated.text).not.toContain('rotated_secret_77');
    const row = await stored(id);
    expect(isPlaintextPostbackUrl(row.url)).toBe(false);
    expect(openPostbackUrl(row.url)).toBe(next);
    expect(row.urlPreview).toBe(maskPostbackUrl(next));

    const before = row.url;
    const events = await request(app).patch(`/partners/${partnerId}/postbacks/${id}`).set(admin).send({ events: ['commission.paid'] });
    expect(events.status).toBe(200);
    expect((await stored(id)).url).toBe(before);
  });

  it("doesn't seal while a rolling deploy's previous build may still be firing; the sweep does once it's over", async () => {
    const partnerId = await insertPartner();
    inGrace();
    const url = trackerUrl();
    const created = await request(app).post(`/partners/${partnerId}/postbacks`).set(admin).send({ url, events: ['commission.accrued'] });
    const id = created.body.id as string;
    // What a build from before sealing can fire as it is, with its preview.
    expect((await stored(id)).url).toBe(url);
    expect(created.body.urlPreview).toBe(maskPostbackUrl(url));
    expect(await runSealPostbackUrlsJob(db)).toEqual({ skipped: 'deploy_grace' });
    expect((await stored(id)).url).toBe(url);

    vi.restoreAllMocks();
    afterGrace();
    expect(await runSealPostbackUrlsJob(db)).toEqual({ sealed: 1 });
    expect(openPostbackUrl((await stored(id)).url)).toBe(url);
  });

  it('fires a sealed postback to the URL the partner entered, macros filled', async () => {
    afterGrace();
    const partnerId = await insertPartner();
    const created = await request(app).post(`/partners/${partnerId}/postbacks`).set(admin).send({ url: trackerUrl(), events: ['commission.accrued'] });
    const id = created.body.id as string;
    expect(isPlaintextPostbackUrl((await stored(id)).url)).toBe(false);

    const output = await consoleDuring(async () => {
      dispatchPartnerPostbacks(DEFAULT_TENANT_ID, partnerId, 'commission.accrued', { click_id: 'clk_1', commission_amount: '12.50' });
      await waitFor(() => (calls.length > 0 ? calls : null));
      await waitFor(async () => ((await stored(id)).successCount > 0 ? true : null));
    });
    expect(calls).toEqual([`/pb?cid=clk_1&amt=12.50&secret=${SECRET}`]);
    const row = await stored(id);
    expect(row).toMatchObject({ successCount: 1, failureCount: 0, lastError: null });
    // Firing doesn't change what is stored.
    expect(openPostbackUrl(row.url)).toBe(trackerUrl());
    expect(output).not.toContain(SECRET);
  });

  it('still fires a plaintext row the sweep has not reached', async () => {
    const partnerId = await insertPartner();
    const id = await insertPostback(partnerId, trackerUrl('legacy'));
    dispatchPartnerPostbacks(DEFAULT_TENANT_ID, partnerId, 'commission.accrued', { click_id: 'clk_2', commission_amount: '1.00' });
    await waitFor(() => (calls.length > 0 ? calls : null));
    expect(calls).toEqual([`/legacy?cid=clk_2&amt=1.00&secret=${SECRET}`]);
    expect((await stored(id)).url).toBe(trackerUrl('legacy'));
  });

  it("never fires a URL it can't open, and says to enter it again", async () => {
    const before = process.env.SECRETS_ENCRYPTION_KEY;
    process.env.SECRETS_ENCRYPTION_KEY = 'cd'.repeat(32);
    __resetCryptoKeyForTests();
    const foreign = encryptSecret(trackerUrl('elsewhere'));
    if (before === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
    else process.env.SECRETS_ENCRYPTION_KEY = before;
    __resetCryptoKeyForTests();

    const partnerId = await insertPartner();
    const id = await insertPostback(partnerId, foreign);
    const output = await consoleDuring(async () => {
      dispatchPartnerPostbacks(DEFAULT_TENANT_ID, partnerId, 'commission.accrued', { click_id: 'clk_3' });
      await waitFor(async () => ((await stored(id)).failureCount > 0 ? true : null));
    });
    expect(calls).toHaveLength(0);
    expect(await stored(id)).toMatchObject({ lastError: URL_UNREADABLE_ERROR, failureCount: 1, url: foreign });
    expect(output).not.toContain(foreign);

    // The list says so, and the partner's edit form gets a 409, not a URL.
    const listed = await request(app).get(`/partners/${partnerId}/postbacks`).set(admin);
    expect(listed.body.postbacks[0].urlPreview).toBeNull();
    const reveal = await request(app).get(`/partners/${partnerId}/postbacks/${id}/url`).set('Cookie', await partnerCookie(partnerId));
    expect(reveal.status).toBe(409);
    expect(reveal.body).toEqual({ error: 'url_unreadable' });
  });

  it("a failed fire's lastError never quotes the URL", async () => {
    // Nothing listens on port 9 here: connection refused.
    const partnerId = await insertPartner();
    const id = await insertPostback(partnerId, `http://127.0.0.1:9/pb?secret=${SECRET}`);
    dispatchPartnerPostbacks(DEFAULT_TENANT_ID, partnerId, 'commission.accrued', {});
    const row = await waitFor(async () => {
      const r = await stored(id);
      return r.failureCount > 0 ? r : null;
    });
    expect(row.lastError).toBeTruthy();
    expect(row.lastError).not.toContain(SECRET);
    expect(row.lastError).not.toContain('127.0.0.1:9');
  });

  describe('masking', () => {
    it("lists every postback masked, to its partner and to the brand's admins", async () => {
      afterGrace();
      const partnerId = await insertPartner();
      const cookie = await partnerCookie(partnerId);
      await request(app).post(`/partners/${partnerId}/postbacks`).set('Cookie', cookie).send({ url: trackerUrl(), events: ['commission.accrued'] });
      // And one left from before sealing.
      await insertPostback(partnerId, trackerUrl('legacy'));

      for (const auth of [{ Cookie: cookie }, admin]) {
        const res = await request(app).get(`/partners/${partnerId}/postbacks`).set(auth);
        expect(res.status).toBe(200);
        expect(res.text).not.toContain(SECRET);
        expect(res.body.postbacks).toHaveLength(2);
        for (const p of res.body.postbacks) {
          expect(p).not.toHaveProperty('url');
          expect(p.urlPreview).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/•••\?cid=\{click_id\}&amt=\{commission_amount\}&•••$/);
        }
      }
    });

    it('shows the URL itself to the partner who owns it, for editing, and to nobody else', async () => {
      afterGrace();
      const partnerId = await insertPartner();
      const otherPartnerId = await insertPartner();
      const cookie = await partnerCookie(partnerId);
      const created = await request(app).post(`/partners/${partnerId}/postbacks`).set('Cookie', cookie).send({ url: trackerUrl(), events: ['commission.accrued'] });
      const path = `/partners/${partnerId}/postbacks/${created.body.id}/url`;

      const own = await request(app).get(path).set('Cookie', cookie);
      expect(own.status).toBe(200);
      expect(own.body).toEqual({ url: trackerUrl() });
      expect(own.headers['cache-control']).toBe('no-store');

      // The brand's admin manages the postback but never reads the URL.
      const byAdmin = await request(app).get(path).set(admin);
      expect(byAdmin.status).toBe(403);
      expect(byAdmin.body).toEqual({ error: 'partner_only' });
      // Another partner can't even name it.
      const other = await request(app).get(path).set('Cookie', await partnerCookie(otherPartnerId));
      expect(other.status).toBe(403);
      expect(other.text).not.toContain(SECRET);
      // A postback of someone else's, under the partner's own path, is not found.
      const theirs = await request(app).post(`/partners/${otherPartnerId}/postbacks`).set(admin).send({ url: trackerUrl('theirs'), events: ['commission.accrued'] });
      const wrongPath = await request(app).get(`/partners/${partnerId}/postbacks/${theirs.body.id}/url`).set('Cookie', cookie);
      expect(wrongPath.status).toBe(404);
    });
  });

  it('the sweep seals every plaintext URL across tenants, once, writes its preview and logs none', async () => {
    await db(TABLES.Tenant).insert({ id: OTHER_TENANT_ID, slug: OTHER_TENANT_ID, displayName: 'Other', status: 'active' });
    const partnerId = await insertPartner();
    const otherPartnerId = await insertPartner(OTHER_TENANT_ID);
    const plain = [trackerUrl('one', 'sweep_one_1'), trackerUrl('two', 'sweep_two_2'), trackerUrl('three', 'sweep_three_3')];
    const ids = [
      await insertPostback(partnerId, plain[0]!),
      await insertPostback(partnerId, plain[1]!),
      await insertPostback(otherPartnerId, plain[2]!, OTHER_TENANT_ID),
    ];
    const alreadySealed = sealPostbackUrl(trackerUrl('sealed'));
    const sealedId = await insertPostback(partnerId, alreadySealed);

    let sealed = 0;
    // A batch of 2 makes it loop.
    const output = await consoleDuring(async () => {
      sealed = await sealPlaintextPostbackUrls(db, 2);
    });
    expect(sealed).toBe(3);
    for (const [i, id] of ids.entries()) {
      const row = await stored(id);
      expect(isPlaintextPostbackUrl(row.url)).toBe(false);
      expect(openPostbackUrl(row.url)).toBe(plain[i]);
      expect(row.urlPreview).toBe(maskPostbackUrl(plain[i]!));
    }
    expect((await stored(sealedId)).url).toBe(alreadySealed);
    for (const p of plain) expect(output).not.toContain(p);

    // Idempotent: nothing left to seal, nothing changes.
    const after = await db(TABLES.PartnerPostback).orderBy('id').pluck('url');
    expect(await sealPlaintextPostbackUrls(db)).toBe(0);
    expect(await db(TABLES.PartnerPostback).orderBy('id').pluck('url')).toEqual(after);
  });

  describe('export → import', () => {
    async function seedSealed(): Promise<{ partnerId: string; id: string; url: string }> {
      afterGrace();
      const partnerId = await insertPartner();
      const url = trackerUrl('export');
      const created = await request(app).post(`/partners/${partnerId}/postbacks`).set(admin).send({ url, events: ['commission.accrued'] });
      return { partnerId, id: created.body.id as string, url };
    }

    it('JSON: the bundle carries the URL opened, and the import seals it again and fires it', async () => {
      const { partnerId, id, url } = await seedSealed();
      const envelope = (await stored(id)).url;
      const bundle = await exportAll(db, DEFAULT_TENANT_ID);
      const [row] = bundle[TABLES.PartnerPostback] as Array<Record<string, unknown>>;
      // Opened, in the shape it had before sealing: no derived preview.
      expect(row!.url).toBe(url);
      expect(row).not.toHaveProperty('urlPreview');
      expect(JSON.stringify(bundle)).not.toContain(envelope);

      await wipe();
      const output = await consoleDuring(async () => {
        await importBundle(db, DEFAULT_TENANT_ID, {
          [TABLES.Partner]: bundle[TABLES.Partner] ?? [],
          [TABLES.PartnerPostback]: bundle[TABLES.PartnerPostback] ?? [],
        });
      });
      expect(output).not.toContain(SECRET);
      const restored = await stored(id);
      expect(isPlaintextPostbackUrl(restored.url)).toBe(false);
      expect(restored.url).not.toBe(envelope);
      expect(openPostbackUrl(restored.url)).toBe(url);
      expect(restored.urlPreview).toBe(maskPostbackUrl(url));

      dispatchPartnerPostbacks(DEFAULT_TENANT_ID, partnerId, 'commission.accrued', { click_id: 'clk_r', commission_amount: '3.00' });
      await waitFor(() => (calls.length > 0 ? calls : null));
      expect(calls).toEqual([`/export?cid=clk_r&amt=3.00&secret=${SECRET}`]);
    });

    it('JSON: a bundle from before sealing (no urlPreview) imports sealed with a preview', async () => {
      afterGrace();
      const partnerId = ulid();
      const id = ulid();
      const url = trackerUrl('old-bundle');
      await importBundle(db, DEFAULT_TENANT_ID, {
        [TABLES.Partner]: [{ id: partnerId, tenantId: 'source', email: 'old@pburl.test', name: 'Old' }],
        [TABLES.PartnerPostback]: [{ id, tenantId: 'source', partnerId, url, events: ['commission.accrued'], enabled: true }],
      });
      const restored = await stored(id);
      expect(openPostbackUrl(restored.url)).toBe(url);
      expect(isPlaintextPostbackUrl(restored.url)).toBe(false);
      expect(restored.urlPreview).toBe(maskPostbackUrl(url));
    });

    it('CSV: the URL travels opened, without the preview', async () => {
      const { url } = await seedSealed();
      const csv = await request(app).get(`/export/${TABLES.PartnerPostback}.csv`).set(admin);
      expect(csv.status).toBe(200);
      expect(csv.text).toContain(url);
      expect(csv.text.split('\n')[0]).not.toContain('urlPreview');
    });

    it('SQL: the dump writes the URL opened, and the sweep seals what the restore wrote', async () => {
      const { id, url } = await seedSealed();
      const dump = buildSqlDump(await exportAll(db, DEFAULT_TENANT_ID), {
        tenantId: DEFAULT_TENANT_ID,
        columnTypes: await exportColumnTypes(db),
      });
      expect(dump).toContain(url);
      expect(dump).toContain('-- Sealed at rest, written here opened');

      await wipe();
      await runSql(dump);
      const restored = await stored(id);
      expect(restored.url).toBe(url);
      expect(restored.urlPreview).toBeNull();
      // Until the sweep gets to it, it fires as it is and lists masked.
      const listed = await request(app).get(`/partners/${(await db(TABLES.PartnerPostback).where({ id }).first()).partnerId}/postbacks`).set(admin);
      expect(listed.body.postbacks[0].urlPreview).toBe(maskPostbackUrl(url));
      expect(listed.text).not.toContain(SECRET);

      expect(await sealPlaintextPostbackUrls(db)).toBe(1);
      const sealed = await stored(id);
      expect(isPlaintextPostbackUrl(sealed.url)).toBe(false);
      expect(openPostbackUrl(sealed.url)).toBe(url);
      expect(sealed.urlPreview).toBe(maskPostbackUrl(url));
    });
  });

  // The sweep's UPDATE binds the plaintext URL, and its errors are logged
  // (server.ts, the scheduler's job log). knex 3 on pg keeps `$n`
  // placeholders in a failed query's message, and the pg error carries no
  // bindings; this pins both, as webhook-secret.test.ts does for secrets.
  it("a failed sweep UPDATE's error doesn't carry the URL it bound", async () => {
    const { inspect } = await import('node:util');
    const url = trackerUrl('err');
    const err = await db(TABLES.PartnerPostback)
      .where({ id: ulid(), url })
      .update({ urlPreview: maskPostbackUrl(url), lastError: 'x'.repeat(501) })
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/value too long/);
    expect(err!.message).toContain('$');
    expect(`${err!.message}\n${inspect(err)}`).not.toContain(SECRET);
  });

  it('nothing logs the URL or its query while postbacks are created, edited, listed and fired', async () => {
    afterGrace();
    const partnerId = await insertPartner();
    const cookie = await partnerCookie(partnerId);
    const output = await consoleDuring(async () => {
      const created = await request(app).post(`/partners/${partnerId}/postbacks`).set('Cookie', cookie).send({ url: trackerUrl(), events: ['commission.accrued'] });
      // A refused destination and an invalid body are answered, not logged.
      await request(app).post(`/partners/${partnerId}/postbacks`).set('Cookie', cookie).send({ url: `http://10.0.0.5/pb?secret=${SECRET}`, events: ['commission.accrued'] });
      await request(app).post(`/partners/${partnerId}/postbacks`).set('Cookie', cookie).send({ url: `nope?secret=${SECRET}`, events: [] });
      await request(app).patch(`/partners/${partnerId}/postbacks/${created.body.id}`).set('Cookie', cookie).send({ url: trackerUrl('v2') });
      await request(app).get(`/partners/${partnerId}/postbacks`).set('Cookie', cookie);
      await request(app).get(`/partners/${partnerId}/postbacks/${created.body.id}/url`).set('Cookie', cookie);
      dispatchPartnerPostbacks(DEFAULT_TENANT_ID, partnerId, 'commission.accrued', { click_id: 'clk_log' });
      await waitFor(() => (calls.length > 0 ? calls : null));
    });
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain('cid=');
  });
});
