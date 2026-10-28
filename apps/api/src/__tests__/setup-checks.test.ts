/**
 * Setup checks (setup-checks.ts) and their route:
 *
 *   partners     a program someone can share passes; one a week old with
 *                no partner, or partners without a link or a code, fails;
 *                a newer one waits; a revoked partner's link doesn't count
 *   destination  fetched from a local server with a marked user agent and
 *                no Click recorded: a page that keeps ?cref= (through
 *                redirects, or in a cookie the final page gets) passes,
 *                cookies going with later hops; a redirect that drops
 *                it, a 404, a loop or a refused connection fails; bot
 *                protection and a redirect into an app can't be checked; a
 *                Stripe Payment Link is judged on client_reference_id
 *                without a fetch
 *   script       never landed (in the window, or over the last year when
 *                it's quiet), stopped landing, and the destination page's
 *                op.js as the hint; linked clicks pass without landings;
 *                bots, flagged and day-old clicks don't count
 *   linking      never linked, stopped being linked, linked, too few
 *   stripe       a connection waiting for a reconnect or uninstalled fails;
 *                a settled payment with no payment event since fails;
 *                other events don't count, nor do zero-value invoices or
 *                unpaid Checkouts; an unreadable Stripe can't be checked;
 *                no connection, no check
 *   codes        a code Stripe refused fails and quotes Stripe's answer
 *                (recorded by provisionCustomerReward); a fresh one, or one
 *                mapped onto the brand's own promo, doesn't; codes don't
 *                pass until a hosted connection has verified them; no
 *                Stripe to create them in can't be checked
 *   route        GET /admin/tracking-health/setup, admin-only
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import ipaddr from 'ipaddr.js';
import { ulid } from 'ulid';
import { DEFAULT_TENANT_ID, TABLES } from '@openpartner/db';
import { encryptSecret } from '../crypto.js';

const stub = vi.hoisted(() => ({
  delivery: 'stripe' as 'stripe' | 'brand' | 'unconfigured',
  /** What brandStripeAccess returns. */
  access: { ok: false, reason: 'not_connected' } as unknown,
}));

// The brand's own key (single-tenant self-host): every coupon it's asked
// for is refused the way Stripe refuses a name over 40 characters.
vi.mock('../stripe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stripe.js')>()),
  stripe: {
    coupons: {
      create: vi.fn(async () => {
        throw Object.assign(
          new Error('Invalid string: OpenPartner — A program with a long name (ALPHA15); must be at most 40 characters'),
          { type: 'StripeInvalidRequestError' },
        );
      }),
    },
    promotionCodes: { create: vi.fn(), list: vi.fn(async () => ({ data: [] })) },
  },
}));
vi.mock('../stripe-reconciliation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stripe-reconciliation.js')>()),
  brandStripeAccess: vi.fn(async () => stub.access),
}));
vi.mock('../customer-rewards.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../customer-rewards.js')>()),
  customerRewardDelivery: vi.fn(async () => stub.delivery),
}));

const { db } = await import('../db.js');
const { createApp } = await import('../app.js');
const { __setOutboundPolicyForTests } = await import('../outbound-guard.js');
const { provisionCustomerReward } = await import('../customer-rewards.js');
const {
  SETUP_CHECK_CLICK_ID,
  __clearSetupProbeCache,
  __setProbeRetryDelayForTests,
  computeSetupChecks,
  describeSetupCheck,
  probeDestination,
} = await import('../setup-checks.js');
type SetupCheck = Awaited<ReturnType<typeof computeSetupChecks>>['checks'][number];

const ADMIN_KEY = 'op_test_setup_checks_0123456789abcdef01';
process.env.ADMIN_API_KEY = ADMIN_KEY;
process.env.OPENPARTNER_TENANCY = 'single';

const TABLES_TO_CLEAN = [
  TABLES.TrackingIssue,
  TABLES.StripeEventLog,
  TABLES.TenantStripeConnection,
  TABLES.Identity,
  TABLES.ClickLanding,
  TABLES.Click,
  TABLES.Coupon,
  TABLES.Link,
  TABLES.PartnerProgram,
  TABLES.Program,
  TABLES.Partner,
];

const skipIntegration = !process.env.DATABASE_URL || process.env.INTEGRATION === 'skip';
const app = createApp({ enableLogger: false });

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const BOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T = DEFAULT_TENANT_ID;
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let server: Server;
let base = '';
let closedBase = '';
const seen: Array<{ path: string; ua: string | undefined }> = [];

async function cleanup() {
  for (const t of TABLES_TO_CLEAN) await db(t).where({ tenantId: T }).del();
}

async function insertAll(table: string, rows: object[]) {
  for (let i = 0; i < rows.length; i += 500) await db(table).insert(rows.slice(i, i + 500));
}

async function program(o: { name?: string; destinationUrl?: string; createdAt?: Date; customerReward?: object } = {}) {
  const id = ulid();
  await db(TABLES.Program).insert({
    id,
    tenantId: T,
    name: o.name ?? 'Main',
    attributionModel: 'last_click',
    attributionWindowDays: 90,
    commissionRule: { type: 'percent', value: 10 },
    destinationUrl: o.destinationUrl ?? `${base}/ok`,
    customerReward: o.customerReward ? JSON.stringify(o.customerReward) : null,
    createdAt: o.createdAt ?? ago(30),
  });
  return id;
}

async function partner(programId: string, o: { link?: boolean; code?: string; enrolled?: boolean; revoked?: boolean } = {}) {
  const id = ulid();
  await db(TABLES.Partner).insert({
    id,
    tenantId: T,
    name: `Partner ${id.slice(-4)}`,
    email: `${id.toLowerCase()}@partner.test`,
    revokedAt: o.revoked ? ago(1) : null,
  });
  if (o.enrolled) await db(TABLES.PartnerProgram).insert({ id: ulid(), tenantId: T, partnerId: id, programId, source: 'admin' });
  let linkId: string | null = null;
  if (o.link !== false) {
    linkId = ulid();
    await db(TABLES.Link).insert({ id: linkId, tenantId: T, partnerId: id, programId, linkKey: `lk-${linkId}` });
  }
  if (o.code) await db(TABLES.Coupon).insert({ id: `cpn_${ulid()}`, tenantId: T, partnerId: id, programId, code: o.code });
  return { id, linkId: linkId! };
}

/** `n` link clicks spread from `from` to `to` days ago. The first `landed`
 *  land a minute after the click, and the first `linked` are linked. */
async function clicks(
  programId: string,
  p: { id: string; linkId: string },
  o: { n: number; from: number; to: number; landed?: number; linked?: number; ua?: string; fraud?: string },
) {
  const rows: object[] = [];
  const landings: object[] = [];
  const identities: object[] = [];
  for (let i = 0; i < o.n; i++) {
    const id = ulid();
    const ts = ago(o.from + ((o.to - o.from) * (i + 0.5)) / o.n);
    rows.push({
      id,
      tenantId: T,
      linkId: p.linkId,
      partnerId: p.id,
      programId,
      landingUrl: 'https://brand.example/',
      userAgent: o.ua ?? CHROME,
      fraudFlag: o.fraud ?? null,
      ts,
    });
    if (i < (o.landed ?? 0)) landings.push({ clickId: id, tenantId: T, landedAt: new Date(ts.getTime() + 60_000), host: 'brand.example' });
    if (i < (o.linked ?? 0)) identities.push({ id: ulid(), tenantId: T, clickId: id, userId: `u_${id}`, stitchedAt: new Date(ts.getTime() + HOUR) });
  }
  await insertAll(TABLES.Click, rows);
  await insertAll(TABLES.ClickLanding, landings);
  await insertAll(TABLES.Identity, identities);
}

async function run(): Promise<SetupCheck[]> {
  return (await computeSetupChecks(db, T, { refresh: true })).checks;
}

function find(checks: SetupCheck[], id: SetupCheck['id'], subject = 'account'): SetupCheck | undefined {
  return checks.find((c) => c.id === id && c.subject === subject);
}

beforeAll(async () => {
  __setProbeRetryDelayForTests(10);
  __setOutboundPolicyForTests({ allowedPorts: null, privateCidrs: [ipaddr.parseCIDR('127.0.0.1/32')] });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    seen.push({ path: url.pathname, ua: req.headers['user-agent'] });
    const html = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head>${body}</head><body>Hello</body></html>`);
    };
    const redirect = (to: string, headers: Record<string, string> = {}) => {
      res.writeHead(302, { location: to, ...headers });
      res.end();
    };
    switch (url.pathname) {
      case '/ok':
        return html('<script src="https://app.openpartner.test/op.js" data-api-url="https://api.test"></script>');
      case '/plain':
      case '/signup':
        return html('<title>No script</title>');
      case '/hop':
        return redirect(`/ok${url.search}`);
      case '/strip':
        return redirect('/plain');
      case '/cookie':
        return redirect('/plain', { 'set-cookie': `op_ref=${url.searchParams.get('cref')}; Path=/; HttpOnly` });
      case '/loop':
        return redirect('/loop');
      case '/gate':
        // Lets a visitor in once its cookie comes back, as consent and geo
        // gates do.
        if (!(req.headers.cookie ?? '').includes('gate=1')) return redirect(`/gate${url.search}`, { 'set-cookie': 'gate=1; Path=/' });
        return html('<title>Gated</title>');
      case '/forget':
        return redirect('/forget2', { 'set-cookie': `op_ref=${url.searchParams.get('cref')}; Path=/` });
      case '/forget2':
        return redirect('/plain', { 'set-cookie': 'op_ref=; Max-Age=0; Path=/' });
      case '/app':
        return redirect('brandapp://open');
      case '/blocked':
        res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
        return res.end('Just a moment...');
      default:
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end('Not found');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const closed = createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
  closedBase = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  await new Promise((r) => closed.close(r));
  if (!skipIntegration) await cleanup();
});

afterAll(async () => {
  __setOutboundPolicyForTests(null);
  __setProbeRetryDelayForTests(1_500);
  await new Promise((r) => server.close(r));
  if (!skipIntegration) await cleanup();
  await db.destroy();
});

beforeEach(async () => {
  __clearSetupProbeCache();
  stub.delivery = 'stripe';
  stub.access = { ok: false, reason: 'not_connected' };
  process.env.OPENPARTNER_MODE = 'selfhost';
  seen.length = 0;
  if (!skipIntegration) await cleanup();
});

describe.skipIf(skipIntegration)('partners', () => {
  it('passes once someone can share the program, by link or by code', async () => {
    const pid = await program();
    await partner(pid, { link: true });
    await partner(pid, { link: false, code: 'ALPHA15' });
    const c = find(await run(), 'partners', pid)!;
    expect(c).toMatchObject({ status: 'pass', program: { id: pid, name: 'Main' } });
    expect(c.summary).toBe('2 partners can share it (1 partner with a link, 1 partner with a code).');
  });

  it('fails a program a week old with nobody to share it; a newer one waits', async () => {
    const old = await program({ name: 'Old' });
    const young = await program({ name: 'Young', createdAt: ago(2) });
    const enrolled = await program({ name: 'Enrolled' });
    await partner(enrolled, { link: false, enrolled: true });
    // A suspended partner's link shares nothing.
    await partner(old, { link: true, revoked: true });

    const checks = await run();
    expect(find(checks, 'partners', old)).toMatchObject({ status: 'fail', summary: 'No partners in this program yet, so nobody can send it traffic.' });
    expect(find(checks, 'partners', young)?.status).toBe('waiting');
    expect(find(checks, 'partners', enrolled)).toMatchObject({
      status: 'fail',
      summary: '1 partner is in this program, but none has a link or a code to share.',
    });
  });

  it('leaves out ended and blocked programs', async () => {
    const ended = await program({ name: 'Ended' });
    await db(TABLES.Program).where({ id: ended }).update({ endsAt: ago(1) });
    const blocked = await program({ name: 'Blocked' });
    await db(TABLES.Program).where({ id: blocked }).update({ blockedAt: ago(1) });
    const checks = await run();
    expect(checks.filter((c) => c.program)).toEqual([]);
  });
});

describe.skipIf(skipIntegration)('destination', () => {
  async function destination(path: string): Promise<SetupCheck> {
    const pid = await program({ destinationUrl: `${base}${path}` });
    return find(await run(), 'destination', pid)!;
  }

  it('passes a page that keeps ?cref= through its redirects, fetched as the setup check and never as a click', async () => {
    const c = await destination('/hop');
    expect(c).toMatchObject({ status: 'pass', summary: `${base}/ok answers after 1 redirect and keeps the click.` });
    expect(c.detail).toMatchObject({ outcome: 'ok', status: 200, redirects: 1, scriptTag: true });
    expect(seen.map((s) => s.path)).toEqual(['/hop', '/ok']);
    expect(seen.every((s) => s.ua?.includes('OpenPartner-SetupCheck/1'))).toBe(true);
    expect(await db(TABLES.Click).where({ tenantId: T }).count({ n: '*' })).toEqual([{ n: '0' }]);
  });

  it('fails a redirect that drops ?cref=, unless a cookie set on the way keeps the click', async () => {
    const lost = await destination('/strip');
    expect(lost.status).toBe('fail');
    expect(lost.summary).toBe(
      `The click is lost on the way: ${new URL(base).host} redirects to ${base}/plain without ?cref=, so the page can’t tell which partner sent the visitor.`,
    );
    expect(lost.fix).toContain(`${base}/plain`);

    __clearSetupProbeCache();
    await cleanup();
    expect((await destination('/cookie')).status).toBe('pass');
  });

  it('sends cookies set on the way with later hops, as a browser would', async () => {
    const c = await destination('/gate');
    expect(c).toMatchObject({ status: 'pass', summary: `${base}/gate answers after 1 redirect and keeps the click.` });
    // A cookie that's cleared again doesn't keep the click.
    const probe = await probeDestination(`${base}/forget`);
    expect(probe.outcome).toBe('lost_click');
  });

  it('follows the {click_id} macro wherever it puts the click', async () => {
    const pid = await program({ destinationUrl: `${base}/signup?ref={click_id}` });
    const c = find(await run(), 'destination', pid)!;
    expect(c.status).toBe('pass');
    const probe = await probeDestination(`${base}/strip?ref={click_id}`);
    expect(probe).toMatchObject({ outcome: 'lost_click', finalUrl: `${base}/plain` });
    expect(SETUP_CHECK_CLICK_ID).toMatch(/^0{26}$/);
  });

  it('fails an error page, a redirect loop and a refused connection', async () => {
    const gone = await destination('/gone');
    expect(gone).toMatchObject({ status: 'fail', summary: `${base}/gone answers HTTP 404, so partner clicks land on an error.` });

    await cleanup();
    __clearSetupProbeCache();
    const loop = await destination('/loop');
    expect(loop).toMatchObject({ status: 'fail', summary: `${new URL(base).host} redirects more than 6 times, probably in a loop.` });

    await cleanup();
    const pid = await program({ destinationUrl: `${closedBase}/` });
    const refused = find(await run(), 'destination', pid)!;
    expect(refused).toMatchObject({
      status: 'fail',
      summary: `OpenPartner couldn’t reach ${new URL(closedBase).host}: the connection was refused.`,
    });
  });

  it("can't check a page behind bot protection or a redirect into an app", async () => {
    const blocked = await destination('/blocked');
    expect(blocked).toMatchObject({ status: 'unknown' });
    expect(blocked.summary).toContain('turned OpenPartner’s check away (HTTP 403)');

    await cleanup();
    __clearSetupProbeCache();
    const app = await destination('/app');
    expect(app).toMatchObject({ status: 'unknown', summary: `${new URL(base).host} redirects to a brandapp: link, which only a device can open.` });
  });

  it('judges a Stripe Payment Link on client_reference_id, without fetching it', async () => {
    const bare = await program({ name: 'Bare', destinationUrl: 'https://buy.stripe.com/test_abc' });
    const macro = await program({ name: 'Macro', destinationUrl: 'https://buy.stripe.com/test_abc?client_reference_id={click_id}' });
    const checks = await run();
    expect(find(checks, 'destination', bare)).toMatchObject({ status: 'fail' });
    expect(find(checks, 'destination', bare)!.fix).toContain('client_reference_id={click_id}');
    expect(find(checks, 'destination', macro)?.status).toBe('pass');
    // Nothing lands on Stripe's page, so there's no script to check.
    expect(find(checks, 'script', bare)).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

describe.skipIf(skipIntegration)('script', () => {
  it('fails a program whose clicks never landed, and says the page lacks op.js', async () => {
    const pid = await program({ destinationUrl: `${base}/plain` });
    const p = await partner(pid);
    await clicks(pid, p, { n: 12, from: 30, to: 2 });
    const c = find(await run(), 'script', pid)!;
    expect(c.status).toBe('fail');
    expect(c.summary).toBe(
      'None of the 12 partner clicks in the last 90 days reached a page running the OpenPartner script, and none was linked to a customer. The destination page doesn’t load op.js.',
    );
    expect(c.fix).toContain('Add the script tag from Integrations');
  });

  it('looks back a year when the window is quiet', async () => {
    const pid = await program({ createdAt: ago(300) });
    const p = await partner(pid);
    await clicks(pid, p, { n: 15, from: 200, to: 100 });
    const c = find(await run(), 'script', pid)!;
    expect(c.status).toBe('fail');
    expect(c.summary).toMatch(/^None of the 15 partner clicks over the last year reached a page running the OpenPartner script/);
    // The page loads op.js, so the tag is there and something else is wrong.
    expect(c.summary).toContain('loads op.js, so the script is there but not reporting');
    expect(c.fix).toContain('data-api-url');
  });

  it('counts only clicks from browsers, unflagged, a day old', async () => {
    const pid = await program();
    const p = await partner(pid);
    await clicks(pid, p, { n: 9, from: 30, to: 2 });
    await clicks(pid, p, { n: 20, from: 30, to: 2, ua: BOT });
    await clicks(pid, p, { n: 5, from: 30, to: 2, fraud: 'velocity' });
    await clicks(pid, p, { n: 5, from: 0.5, to: 0.1 });
    expect(find(await run(), 'script', pid)).toMatchObject({
      status: 'waiting',
      summary: '9 partner clicks so far, none reported landing; judged at 10.',
    });
  });

  it('passes landing clicks, and linked ones without landing reports', async () => {
    const landing = await program({ name: 'Landing' });
    await clicks(landing, await partner(landing), { n: 20, from: 30, to: 2, landed: 15 });
    const server = await program({ name: 'Server side' });
    await clicks(server, await partner(server), { n: 20, from: 30, to: 2, linked: 3 });
    const checks = await run();
    expect(find(checks, 'script', landing)).toMatchObject({
      status: 'pass',
      summary: '75% of the 20 partner clicks in the last 90 days reached a page running the script.',
    });
    expect(find(checks, 'script', server)?.status).toBe('pass');
    expect(find(checks, 'script', server)?.summary).toContain('so the click reaches you another way');
  });

  it('fails clicks that stopped landing, measured against the rate before', async () => {
    const pid = await program();
    const p = await partner(pid);
    await clicks(pid, p, { n: 40, from: 60, to: 30, landed: 40 });
    await clicks(pid, p, { n: 25, from: 25, to: 2 });
    const c = find(await run(), 'script', pid)!;
    expect(c.status).toBe('fail');
    expect(c.summary).toMatch(/^No partner click has reached a page running the script since .+: 25 clicks since, where 62% used to\./);

    // A few misses could be chance.
    await cleanup();
    const quiet = await program();
    const q = await partner(quiet);
    await clicks(quiet, q, { n: 40, from: 60, to: 30, landed: 40 });
    await clicks(quiet, q, { n: 5, from: 25, to: 2 });
    expect(find(await run(), 'script', quiet)?.status).toBe('pass');
  });

  it('fails a program whose clicks stopped landing two windows ago', async () => {
    const pid = await program({ createdAt: ago(300) });
    const p = await partner(pid);
    await clicks(pid, p, { n: 10, from: 250, to: 200, landed: 10 });
    await clicks(pid, p, { n: 15, from: 170, to: 100 });
    await clicks(pid, p, { n: 10, from: 80, to: 2 });
    // Flagged clicks that landed don't count as the program's landings.
    await clicks(pid, p, { n: 3, from: 80, to: 2, landed: 3, fraud: 'velocity' });
    expect(find(await run(), 'script', pid)?.summary).toMatch(/^None of the 10 partner clicks in the last 90 days reached a page running the script, though earlier ones did\./);
  });

  it('fails a program whose landings stopped before the window began', async () => {
    const pid = await program({ createdAt: ago(200) });
    const p = await partner(pid);
    await clicks(pid, p, { n: 30, from: 170, to: 100, landed: 24 });
    await clicks(pid, p, { n: 12, from: 80, to: 2 });
    const c = find(await run(), 'script', pid)!;
    expect(c.status).toBe('fail');
    expect(c.summary).toMatch(/^None of the 12 partner clicks in the last 90 days reached a page running the script, though earlier ones did\./);
  });
});

describe.skipIf(skipIntegration)('linking', () => {
  it('fails when clicks reach the site and none has ever been linked', async () => {
    const pid = await program();
    await clicks(pid, await partner(pid), { n: 110, from: 80, to: 10, landed: 100 });
    expect(find(await run(), 'linking')).toMatchObject({
      status: 'fail',
      subject: 'account',
      program: null,
      summary: 'None of the 100 partner clicks that reached your site in the last 90 days was linked to a customer, and no partner click ever has been.',
    });
  });

  it('waits for enough clicks, and for clicks to reach the site at all', async () => {
    const pid = await program();
    const p = await partner(pid);
    await clicks(pid, p, { n: 30, from: 80, to: 10 });
    expect(find(await run(), 'linking')).toMatchObject({
      status: 'waiting',
      summary: 'Waiting for partner clicks to reach a page running the script.',
    });
    await clicks(pid, p, { n: 30, from: 80, to: 10, landed: 30 });
    expect(find(await run(), 'linking')).toMatchObject({
      status: 'waiting',
      summary: '30 partner clicks that reached your site in the last 90 days, none linked to a customer yet; judged at 100.',
    });
  });

  it('passes linked clicks, and fails when the links stop', async () => {
    const pid = await program();
    const p = await partner(pid);
    await clicks(pid, p, { n: 60, from: 80, to: 40, landed: 60, linked: 30 });
    await clicks(pid, p, { n: 10, from: 35, to: 20, landed: 10, linked: 10 });
    // Younger than a week: not judged yet.
    await clicks(pid, p, { n: 40, from: 6, to: 1, landed: 40 });
    expect(find(await run(), 'linking')).toMatchObject({
      status: 'pass',
      summary: '57% of the 70 partner clicks that reached your site in the last 90 days were linked to a customer.',
    });

    await clicks(pid, p, { n: 30, from: 18, to: 8, landed: 30 });
    const c = find(await run(), 'linking')!;
    expect(c.status).toBe('fail');
    expect(c.summary).toMatch(/^None of the 30 partner clicks that reached your site since .+ was linked to a customer, where 40% used to be\.$/);
    expect(c.fix).toContain('identify()');
  });
});

describe.skipIf(skipIntegration)('stripe', () => {
  async function connection(o: { refreshFailedAt?: Date; disconnectedAt?: Date; disconnectReason?: string } = {}) {
    const id = ulid();
    await db(TABLES.TenantStripeConnection).insert({
      id,
      tenantId: T,
      stripeAccountId: 'acct_setupcheck',
      livemode: true,
      keyMode: 'live',
      permissionsVersion: 1,
      connectedAt: ago(30),
      eventLogSince: ago(30),
      // Never used: brandStripeAccess is stubbed.
      refreshTokenEnc: o.disconnectedAt ? null : encryptSecret('rt_unused'),
      refreshFailedAt: o.refreshFailedAt ?? null,
      refreshError: o.refreshFailedAt ? 'invalid_grant' : null,
      disconnectedAt: o.disconnectedAt ?? null,
      disconnectReason: o.disconnectReason ?? null,
    });
    return id;
  }

  const sec = (d: Date) => Math.floor(d.getTime() / 1000);

  /** A Stripe whose paid invoice was paid `invoiceDaysAgo` (or none), and
   *  whose Checkouts are `sessions`. */
  function stripeWith(o: { invoiceDaysAgo?: number; amountPaid?: number; sessions?: object[]; error?: string }) {
    const list = async () => {
      if (o.error) throw Object.assign(new Error('not allowed'), { type: o.error });
      if (o.invoiceDaysAgo == null) return { data: [] };
      const paid = sec(ago(o.invoiceDaysAgo));
      return { data: [{ created: paid - 3600, amount_paid: o.amountPaid ?? 4900, status_transitions: { paid_at: paid } }] };
    };
    stub.access = {
      ok: true,
      stripe: { invoices: { list }, checkout: { sessions: { list: async () => ({ data: o.sessions ?? [] }) } } },
      livemode: true,
      identity: 'test',
    };
  }

  const event = (type: string, daysAgo: number) =>
    db(TABLES.StripeEventLog).insert({ stripeEventId: `evt_${ulid()}`, tenantId: T, type, via: 'webhook', receivedAt: ago(daysAgo) });

  beforeEach(() => {
    process.env.OPENPARTNER_MODE = 'flat';
  });

  it('fails a connection waiting for a reconnect, or an uninstalled app; a disconnect by an admin is no check', async () => {
    await connection({ refreshFailedAt: ago(3) });
    expect(find(await run(), 'stripe')).toMatchObject({ status: 'fail', fix: 'Reconnect Stripe under Integrations.' });
    expect(find(await run(), 'stripe')!.summary).toMatch(/^Stripe stopped accepting OpenPartner’s connection to acct_setupcheck on /);

    await cleanup();
    await connection({ disconnectedAt: ago(2), disconnectReason: 'deauthorized' });
    expect(find(await run(), 'stripe')!.summary).toMatch(/^The OpenPartner Stripe App was removed from acct_setupcheck on /);

    await cleanup();
    await connection({ disconnectedAt: ago(2), disconnectReason: 'admin' });
    expect(find(await run(), 'stripe')).toBeUndefined();
  });

  it('fails a settled payment whose event never arrived; other events prove nothing', async () => {
    await connection();
    stripeWith({ invoiceDaysAgo: 2 });
    await event('customer.created', 1);
    await event('invoice.paid', 4);
    const c = find(await run(), 'stripe')!;
    expect(c.status).toBe('fail');
    expect(c.summary).toMatch(/^Stripe shows payments from the last 7 days \(the latest on .+\), but their events never reached OpenPartner: the last arrived .+\.$/);

    stripeWith({});
    expect(find(await run(), 'stripe')).toMatchObject({
      status: 'pass',
      summary: 'Connected to acct_setupcheck (live mode). No payments in the last 7 days to expect events from.',
    });

    stripeWith({ invoiceDaysAgo: 2 });
    await event('invoice.paid', 2);
    expect(find(await run(), 'stripe')?.summary).toMatch(/^Connected to acct_setupcheck \(live mode\)\. Payment events are arriving: the last on /);
  });

  it("doesn't count a zero-value invoice, an unpaid Checkout, or one too recent to have completed", async () => {
    await connection();
    stripeWith({
      invoiceDaysAgo: 2,
      amountPaid: 0,
      sessions: [
        { created: sec(ago(3)), payment_status: 'no_payment_required', amount_total: 0 },
        { created: sec(ago(3)), payment_status: 'unpaid', amount_total: 2000 },
      ],
    });
    expect(find(await run(), 'stripe')?.status).toBe('pass');
    stripeWith({ sessions: [{ created: sec(ago(3)), payment_status: 'paid', amount_total: 2000 }] });
    expect(find(await run(), 'stripe')?.status).toBe('fail');
  });

  it("doesn't count payments from before the connection's event log began", async () => {
    await connection();
    await db(TABLES.TenantStripeConnection).where({ tenantId: T }).update({ eventLogSince: ago(1) });
    stripeWith({ invoiceDaysAgo: 2 });
    expect(find(await run(), 'stripe')?.status).toBe('pass');
  });

  it("can't check a Stripe it can't read", async () => {
    await connection();
    stripeWith({ invoiceDaysAgo: 2, error: 'StripePermissionError' });
    expect(find(await run(), 'stripe')).toMatchObject({ status: 'unknown', fix: 'Reconnect Stripe under Integrations.' });
  });
});

describe.skipIf(skipIntegration)('codes', () => {
  const REWARD = { type: 'percent_off', value: 20, duration: 'once' };

  it("fails a code Stripe refused and quotes Stripe's answer", async () => {
    process.env.OPENPARTNER_MODE = 'selfhost';
    const pid = await program({ customerReward: REWARD });
    await partner(pid, { code: 'ALPHA15' });
    await partner(pid, { code: 'BETA15' });
    await db(TABLES.Coupon).where({ tenantId: T }).update({ createdAt: ago(1) });
    await db(TABLES.Coupon).where({ tenantId: T, code: 'BETA15' }).update({ stripePromotionCodeId: 'promo_beta' });

    // The mint's Stripe call is refused, and the refusal is counted.
    expect(await provisionCustomerReward(T, REWARD as never, 'ALPHA15', 'A program with a long name')).toBeNull();
    const [issue] = await db(TABLES.TrackingIssue).where({ tenantId: T, kind: 'reward_code_refused' });
    expect(issue).toMatchObject({ count: 1, sampleRef: 'ALPHA15' });
    expect(issue.detail).toContain('must be at most 40 characters');

    const c = find(await run(), 'codes')!;
    expect(c.status).toBe('fail');
    expect(c.summary).toBe(
      '1 of the 2 partner codes has no discount in your Stripe, so customers who enter it pay full price. Stripe’s last answer, for ALPHA15: “Invalid string: OpenPartner — A program with a long name (ALPHA15); must be at most 40 characters”',
    );
    expect(c.fix).toContain('retire each code and issue it again');
  });

  it("passes codes with their discount, leaves out codes mapped onto the brand's own promo, and waits for new ones", async () => {
    const pid = await program({ customerReward: REWARD });
    await partner(pid, { code: 'ALPHA15' });
    await partner(pid, { code: 'BRANDS10' });
    await db(TABLES.Coupon).where({ tenantId: T, code: 'ALPHA15' }).update({ stripePromotionCodeId: 'promo_alpha', createdAt: ago(3) });
    await db(TABLES.Coupon).where({ tenantId: T, code: 'BRANDS10' }).update({ brandChosen: true, createdAt: ago(3) });
    expect(find(await run(), 'codes')).toMatchObject({ status: 'pass', summary: 'The partner code has its customer discount in your Stripe.' });

    // Issued a moment ago: the hourly retry hasn't had its turn.
    await partner(pid, { code: 'GAMMA15' });
    expect(find(await run(), 'codes')).toMatchObject({ status: 'waiting', summary: 'Creating partner codes’ discounts in your Stripe: 1 to go.' });
  });

  it("doesn't pass codes before a hosted connection has verified them against its account", async () => {
    process.env.OPENPARTNER_MODE = 'flat';
    const pid = await program({ customerReward: REWARD });
    await partner(pid, { code: 'ALPHA15' });
    await db(TABLES.Coupon).where({ tenantId: T }).update({ stripePromotionCodeId: 'promo_alpha', createdAt: ago(3) });
    const conn = ulid();
    await db(TABLES.TenantStripeConnection).insert({
      id: conn,
      tenantId: T,
      stripeAccountId: 'acct_codes',
      livemode: true,
      keyMode: 'live',
      refreshTokenEnc: encryptSecret('rt_unused'),
      permissionsVersion: 1,
      connectedAt: ago(0.5),
      eventLogSince: ago(0.5),
    });
    expect(find(await run(), 'codes')).toMatchObject({ status: 'waiting', summary: 'Checking partner codes’ discounts against your Stripe.' });

    await db(TABLES.TenantStripeConnection).where({ id: conn }).update({ connectedAt: ago(3) });
    expect(find(await run(), 'codes')).toMatchObject({ status: 'unknown' });

    await db(TABLES.TenantStripeConnection).where({ id: conn }).update({ rewardsVerifiedAt: ago(2) });
    expect(find(await run(), 'codes')?.status).toBe('pass');
  });

  it("can't check codes with no Stripe to create them in; no reward, no check", async () => {
    const pid = await program({ customerReward: REWARD });
    await partner(pid, { code: 'ALPHA15' });
    stub.delivery = 'brand';
    expect(find(await run(), 'codes')?.status).toBe('unknown');

    await db(TABLES.Program).where({ id: pid }).update({ customerReward: null });
    expect(find(await run(), 'codes')).toBeUndefined();
  });
});

describe.skipIf(skipIntegration)('describeSetupCheck', () => {
  it("names the program, then what's wrong and what to do", async () => {
    const pid = await program({ name: 'Spring', destinationUrl: `${base}/gone` });
    const c = find(await run(), 'destination', pid)!;
    expect(describeSetupCheck(c)).toBe(
      `Spring: ${base}/gone answers HTTP 404, so partner clicks land on an error. Point the program’s destination (Programs → Edit) at a page that loads.`,
    );
  });
});

describe.skipIf(skipIntegration)('route', () => {
  const admin = (r: request.Test) => r.set('Authorization', `Bearer ${ADMIN_KEY}`);

  it('serves the checks to admins only, from the cache until asked to read again', async () => {
    const pid = await program({ destinationUrl: `${base}/ok` });
    await partner(pid);
    const res = await admin(request(app).get('/admin/tracking-health/setup'));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['checks', 'computedAt']);
    // The Stripe check here reads this instance's own key, and depends on
    // when this database was migrated; the stripe tests cover it.
    const ids = res.body.checks.filter((c: SetupCheck) => c.id !== 'stripe').map((c: SetupCheck) => `${c.id}:${c.status}`);
    expect(ids).toEqual(['partners:pass', 'destination:pass', 'script:waiting', 'linking:waiting']);
    expect(seen).toHaveLength(1);

    await admin(request(app).get('/admin/tracking-health/setup'));
    expect(seen).toHaveLength(1);
    await admin(request(app).get('/admin/tracking-health/setup?refresh=1'));
    expect(seen).toHaveLength(2);

    expect((await admin(request(app).get('/admin/tracking-health/setup?refresh=yes'))).status).toBe(400);
    expect((await request(app).get('/admin/tracking-health/setup')).status).toBe(401);
  });
});
