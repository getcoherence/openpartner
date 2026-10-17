// In-app referral page: a minimal backend that renders a user's OpenPartner
// referral link, stats and earnings inside "your" app, with no OpenPartner
// login. Zero dependencies; Node 22+.
//
//   node setup.mjs     # once, with an admin key: program + scoped key
//   node server.mjs    # then open http://localhost:3000
//
// The OpenPartner API key lives only here, on the server. The browser talks
// to this server, never to OpenPartner directly (except the SDK's public
// identify call on your signup page). Walkthrough: docs/headless-referral.md.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const API = required('OPENPARTNER_API_URL').replace(/\/$/, ''); // tenant API base, e.g. https://app.openpartner.dev/api/t/acme
const KEY = required('OPENPARTNER_API_KEY'); // scoped key from setup.mjs; never sent to the browser
const PROGRAM_ID = required('OPENPARTNER_PROGRAM_ID');
const SHARE_BASE = required('OPENPARTNER_SHARE_URL_BASE').replace(/\/$/, ''); // e.g. https://app.openpartner.dev/r/acme
// Your OpenPartner default currency (Settings → Brand info). Payments are
// reported in it unless the caller names one, and an empty balance shows in it.
const CURRENCY = (process.env.OPENPARTNER_CURRENCY || 'USD').toUpperCase();
const PORT = Number(process.env.PORT ?? 3000);
// Loopback by default: the demo hooks below must not be reachable from the network.
const HOST = process.env.HOST ?? '127.0.0.1';
const DEMO_HOOKS = process.env.NODE_ENV !== 'production';

// All of this server's API calls share one rate limit (600 requests per
// 5 minutes per IP, event ingest included), so stats are cached, and a
// user can't force a refresh more than once per REFRESH_MIN_MS.
const STATS_TTL_MS = 5 * 60_000;
const REFRESH_MIN_MS = 30_000;

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Run \`node setup.mjs\` or copy .env.example to .env.`);
    process.exit(1);
  }
  return v;
}

// ---------------------------------------------------------------- API client

class ApiError extends Error {
  constructor(status, body) {
    super(`OpenPartner ${status}: ${body?.error ?? 'error'}`);
    this.status = status;
    this.code = body?.error;
    this.body = body;
  }
}

async function op(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // An HTML page here almost always means a wrong base URL. On
    // OpenPartner Cloud the tenant slug goes after /api: .../api/t/<slug>.
    throw new ApiError(res.status, { error: 'non_json_response', detail: `Check OPENPARTNER_API_URL (${API}).` });
  }
  if (!res.ok) throw new ApiError(res.status, json);
  return json;
}

// ------------------------------------------------- "your app" stand-ins

// Stand-in for your real session: the signed-in user. Switch users with
// ?as=<email> (sets a cookie). Your app uses its own auth instead.
const DEMO_USERS = {
  'ada@example.com': { id: 'user_ada', name: 'Ada Lovelace', email: 'ada@example.com' },
  'grace@example.com': { id: 'user_grace', name: 'Grace Hopper', email: 'grace@example.com' },
};

function currentUser(req) {
  const cookie = /(?:^|;\s*)demo_user=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  let email = '';
  try {
    email = decodeURIComponent(cookie ?? '');
  } catch {
    // Malformed cookie: fall back to the default demo user.
  }
  return DEMO_USERS[email] ?? DEMO_USERS['ada@example.com'];
}

// Stand-in for columns on your users table. Store the OpenPartner partner
// id, link key and creation date when you create them, so later page views
// skip the lookups.
const referralIds = new Map(); // user.id → { partnerId, linkKey, since }
const pending = new Map(); // user.id → Promise, so concurrent first visits create once

// ------------------------------------------------------- referral account

/** The user's partner record, created on first visit. */
async function ensurePartner(user) {
  try {
    return await op('POST', '/partners', {
      email: user.email, // use addresses your app has verified
      name: user.name,
      sendInvite: false, // active immediately, no OpenPartner email
      programIds: [PROGRAM_ID], // grant only the referral program
      metadata: { appUserId: user.id },
    });
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'email_taken')) throw err;
    const { partners } = await op('GET', `/partners?email=${encodeURIComponent(user.email)}`);
    const partner = partners[0];
    // Only adopt the existing partner if it's this user's. Otherwise the
    // address belongs to someone else (another user, or a partner in
    // another of your programs) and linking it would show them this page.
    if (!partner || partner.metadata?.appUserId !== user.id) {
      throw new ApiError(409, { error: 'email_belongs_to_another_partner' });
    }
    return partner;
  }
}

/** The user's share link on the referral program, created on first visit.
 *  The first key tried is derived from the user id, so two app servers
 *  racing on the same first visit try the same key and one of them reuses
 *  the other's link instead of creating a second one. */
async function ensureLink(partnerId, user) {
  const existing = async () =>
    (await op('GET', `/partners/${partnerId}/links`)).links.find((l) => l.programId === PROGRAM_ID)?.linkKey;

  const found = await existing();
  if (found) return found;

  const base = user.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ref';
  const stable = createHash('sha256').update(user.id).digest('hex').slice(0, 6);
  const candidates = [`${base}-${stable}`, `${base}-${randomBytes(3).toString('hex')}`, `${base}-${randomBytes(3).toString('hex')}`];
  for (const linkKey of candidates) {
    try {
      return (await op('POST', `/partners/${partnerId}/links`, { linkKey, programId: PROGRAM_ID })).linkKey;
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'linkKey_taken')) throw err;
      const raced = await existing(); // a concurrent request may have just created ours
      if (raced) return raced;
    }
  }
  throw new Error('could not allocate a link key');
}

function referralAccount(user) {
  const known = referralIds.get(user.id);
  if (known) return Promise.resolve(known);
  if (!pending.has(user.id)) {
    pending.set(
      user.id,
      (async () => {
        const partner = await ensurePartner(user);
        const linkKey = await ensureLink(partner.id, user);
        const ids = { partnerId: partner.id, linkKey, since: partner.createdAt };
        referralIds.set(user.id, ids);
        return ids;
      })().finally(() => pending.delete(user.id)),
    );
  }
  return pending.get(user.id);
}

// ------------------------------------------------------------- the page data

const statsCache = new Map(); // partnerId → { at, view }

/** Major-unit decimal strings ("9.80") → integer cents, so sums don't drift. */
const cents = (amount) => Math.round(Number(amount) * 100);

/** Every commission on the referral program (lists are newest first). */
async function allCommissions(partnerId) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 20; page++) {
    const q = `limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await op('GET', `/partners/${partnerId}/commissions?${q}`);
    out.push(...res.commissions);
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return out.filter((c) => c.programId === PROGRAM_ID);
}

async function buildView(user, { partnerId, linkKey, since }) {
  const [series, commissions, { payouts }] = await Promise.all([
    // Clicks, sign-ups and payments for the referral program, lifetime.
    op('GET', `/partners/${partnerId}/timeseries?since=${encodeURIComponent(since)}&programId=${PROGRAM_ID}`),
    allCommissions(partnerId),
    // Payouts aren't per program; for a partner granted only the referral
    // program they're all referral payouts.
    op('GET', `/partners/${partnerId}/payouts`),
  ]);

  const sum = (key) => series.buckets.reduce((n, b) => n + b[key], 0);
  const payoutStatus = new Map(payouts.map((p) => [p.id, p.status]));

  // Per currency: never add amounts in different currencies together.
  const totals = {};
  const bucket = (currency) => (totals[currency] ??= { pending: 0, processing: 0, paidOut: 0 });
  for (const c of commissions) {
    if (c.status === 'accrued' || c.status === 'approved') bucket(c.currency).pending += cents(c.amount);
    // `paid` on a commission means "in a payout". On the manual rail that
    // happens before the money is sent, so it's processing until the
    // payout itself is `paid`.
    if (c.status === 'paid' && payoutStatus.get(c.payoutId) !== 'paid') bucket(c.currency).processing += cents(c.amount);
  }
  for (const p of payouts) if (p.status === 'paid') bucket(p.currency).paidOut += cents(p.amount);

  return {
    user: { name: user.name, email: user.email },
    shareUrl: `${SHARE_BASE}/${linkKey}`,
    // What a balance with nothing in it is shown in.
    currency: CURRENCY,
    stats: {
      clicks: sum('clicks'),
      // Per attribution: signups and trials, and events with a value.
      signups: sum('leads'),
      payments: sum('sales'),
    },
    totals: Object.fromEntries(
      Object.entries(totals).map(([cur, t]) => [cur, { pending: t.pending / 100, processing: t.processing / 100, paidOut: t.paidOut / 100 }]),
    ),
    commissions: commissions.slice(0, 20).map((c) => ({
      amount: c.amount,
      currency: c.currency,
      status: c.status === 'paid' && payoutStatus.get(c.payoutId) !== 'paid' ? 'processing' : c.status,
      accruedAt: c.accruedAt,
      matureAt: c.matureAt,
    })),
    payouts: payouts.map((p) => ({
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      createdAt: p.createdAt,
      completedAt: p.completedAt,
    })),
    refreshedAt: new Date().toISOString(),
  };
}

async function referralView(user, { refresh = false } = {}) {
  const account = await referralAccount(user);
  const cached = statsCache.get(account.partnerId);
  const age = cached ? Date.now() - cached.at : Infinity;
  if (cached && age < (refresh ? REFRESH_MIN_MS : STATS_TTL_MS)) return cached.view;
  try {
    const view = await buildView(user, account);
    statsCache.set(account.partnerId, { at: Date.now(), view });
    return view;
  } catch (err) {
    // Rate-limited or OpenPartner briefly unavailable: an older page beats an error.
    if (cached && err instanceof ApiError && (err.status === 429 || err.status >= 500)) return { ...cached.view, stale: true };
    throw err;
  }
}

// -------------------------------------------- what your backend does on events
//
// Demo-only HTTP hooks so you can drive the loop with curl (see README).
// In your app this code runs inside your own signup and billing handlers,
// not as public endpoints. They're off when NODE_ENV=production.

/** Signup: stitch the visitor's click (the `cref` the browser SDK captured)
 *  to the new user, then record the signup. A failed stitch never fails the
 *  signup. Server-side identify counts against this server's IP limit
 *  (120/min); at volume, let the browser SDK make the call instead. */
async function onSignup({ userId, cref }) {
  if (cref) {
    try {
      const res = await fetch(`${API}/attribution/identify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cref, userId }),
      });
      // 404 click_not_found = a stale or forged cref.
      if (!res.ok) console.warn('identify failed', res.status, await res.text());
    } catch (err) {
      console.warn('identify failed', err);
    }
  }
  return op('POST', '/attribution/events', { userId, type: 'signup', externalEventId: `signup:${userId}` });
}

/** Payment: report it as invoice_paid, keyed by your invoice id. In a real
 *  app, send this from a job queue and retry on 429 / network errors with
 *  the same externalEventId; a retry can never pay twice. */
async function onInvoicePaid({ userId, invoiceId, amount, currency = CURRENCY }) {
  return op('POST', '/attribution/events', {
    userId,
    type: 'invoice_paid',
    value: amount,
    currency,
    externalEventId: invoiceId,
  });
}

// --------------------------------------------------------------------- HTTP

class BadRequest extends Error {}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new BadRequest('body too large');
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new BadRequest('invalid JSON');
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const indexHtml = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');

createServer(async (req, res) => {
  let pathname = '/';
  try {
    // A fixed base, never the client's Host header: a malformed Host would
    // otherwise throw here.
    const url = new URL(req.url ?? '/', 'http://localhost');
    pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/') {
      const as = url.searchParams.get('as');
      const headers = { 'content-type': 'text/html; charset=utf-8' };
      // Only known demo users, so nothing from the query reaches the header.
      if (as && DEMO_USERS[as]) headers['set-cookie'] = `demo_user=${encodeURIComponent(as)}; Path=/; SameSite=Lax; HttpOnly`;
      res.writeHead(200, headers);
      return res.end(indexHtml);
    }
    if (req.method === 'GET' && pathname === '/api/referral') {
      return send(res, 200, await referralView(currentUser(req), { refresh: url.searchParams.has('refresh') }));
    }
    if (DEMO_HOOKS && req.method === 'POST' && pathname === '/api/demo/signup') {
      return send(res, 200, await onSignup(await readJson(req)));
    }
    if (DEMO_HOOKS && req.method === 'POST' && pathname === '/api/demo/invoice-paid') {
      return send(res, 200, await onInvoicePaid(await readJson(req)));
    }
    send(res, 404, { error: 'not_found' });
  } catch (err) {
    if (err instanceof BadRequest) return send(res, 400, { error: 'bad_request' });
    // Log the detail here; give the browser nothing it could leak.
    console.error(req.method, pathname, err instanceof ApiError ? { status: err.status, body: err.body } : err);
    send(res, 502, { error: 'referral_unavailable' });
  }
}).listen(PORT, HOST, () => {
  console.log(`In-app referral sample on http://${HOST}:${PORT} (OpenPartner API: ${API})`);
});
