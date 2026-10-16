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
import { randomBytes } from 'node:crypto';

try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment.
}

const API = required('OPENPARTNER_API_URL').replace(/\/$/, ''); // tenant API base, e.g. https://app.openpartner.dev/api/t/acme
const KEY = required('OPENPARTNER_API_KEY'); // scoped key from setup.mjs; never sent to the browser
const PROGRAM_ID = required('OPENPARTNER_PROGRAM_ID');
const SHARE_BASE = required('OPENPARTNER_SHARE_URL_BASE').replace(/\/$/, ''); // e.g. https://app.openpartner.dev/r/acme
const PORT = Number(process.env.PORT ?? 3000);
const STATS_TTL_MS = 60_000;

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
  const json = text ? JSON.parse(text) : null;
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
  return DEMO_USERS[decodeURIComponent(cookie ?? '')] ?? DEMO_USERS['ada@example.com'];
}

// Stand-in for a column on your users table. Store the OpenPartner partner
// id and link key when you create them, so later page views skip the lookups.
const referralIds = new Map(); // user.id → { partnerId, linkKey }

// ------------------------------------------------------- referral account

/** The user's partner record, created on first visit. Idempotent: a race
 *  or a lost row id falls back to the email lookup. */
async function ensurePartner(user) {
  try {
    const partner = await op('POST', '/partners', {
      email: user.email,
      name: user.name,
      sendInvite: false, // active immediately, no OpenPartner email
      programIds: [PROGRAM_ID], // grant only the referral program
      metadata: { appUserId: user.id },
    });
    return partner.id;
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'email_taken')) throw err;
    const { partners } = await op('GET', `/partners?email=${encodeURIComponent(user.email)}`);
    if (!partners[0]) throw err;
    return partners[0].id;
  }
}

/** The user's share link on the referral program, created on first visit. */
async function ensureLink(partnerId, user) {
  const { links } = await op('GET', `/partners/${partnerId}/links`);
  const existing = links.find((l) => l.programId === PROGRAM_ID);
  if (existing) return existing.linkKey;

  const base = user.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'ref';
  for (let attempt = 0; attempt < 3; attempt++) {
    const linkKey = `${base}-${randomBytes(3).toString('hex')}`;
    try {
      const link = await op('POST', `/partners/${partnerId}/links`, { linkKey, programId: PROGRAM_ID });
      return link.linkKey;
    } catch (err) {
      if (!(err instanceof ApiError && err.code === 'linkKey_taken')) throw err;
    }
  }
  throw new Error('could not allocate a link key');
}

async function referralAccount(user) {
  let ids = referralIds.get(user.id);
  if (!ids) {
    const partnerId = await ensurePartner(user);
    const linkKey = await ensureLink(partnerId, user);
    ids = { partnerId, linkKey };
    referralIds.set(user.id, ids);
  }
  return ids;
}

// ------------------------------------------------------------- the page data

// All API calls from this server share one rate limit (600 requests per 5
// minutes per IP), so cache each user's stats briefly.
const statsCache = new Map(); // partnerId → { at, view }

async function referralView(user, { refresh = false } = {}) {
  const { partnerId, linkKey } = await referralAccount(user);
  const cached = statsCache.get(partnerId);
  if (!refresh && cached && Date.now() - cached.at < STATS_TTL_MS) return cached.view;

  const since = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const [dashboard, series, commissions, payouts] = await Promise.all([
    op('GET', `/partners/${partnerId}/dashboard?since=${since}`),
    op('GET', `/partners/${partnerId}/timeseries?since=${since}&programId=${PROGRAM_ID}`),
    op('GET', `/partners/${partnerId}/commissions?limit=20`),
    op('GET', `/partners/${partnerId}/payouts`),
  ]);

  const sum = (key) => series.buckets.reduce((n, b) => n + b[key], 0);
  const byStatus = dashboard.commissionByStatus;
  const view = {
    user: { name: user.name, email: user.email },
    shareUrl: `${SHARE_BASE}/${linkKey}`,
    stats: {
      clicks: dashboard.clicks,
      signups: sum('leads'),
      payments: sum('sales'),
      referredRevenue: dashboard.attributedRevenue,
      pending: (byStatus.accrued ?? 0) + (byStatus.approved ?? 0),
      paid: byStatus.paid ?? 0,
    },
    currency: commissions.commissions[0]?.currency ?? 'USD',
    commissions: commissions.commissions.map((c) => ({
      amount: c.amount,
      currency: c.currency,
      status: c.status,
      accruedAt: c.accruedAt,
      matureAt: c.matureAt,
    })),
    payouts: payouts.payouts.map((p) => ({
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      createdAt: p.createdAt,
      completedAt: p.completedAt,
    })),
    refreshedAt: new Date().toISOString(),
  };
  statsCache.set(partnerId, { at: Date.now(), view });
  return view;
}

// -------------------------------------------- what your backend does on events
//
// Demo-only HTTP hooks so you can drive the loop with curl (see README).
// In your app this code runs inside your own signup and billing handlers,
// not as public endpoints.

/** Signup: stitch the visitor's click (the `cref` the browser SDK captured)
 *  to the new user, then record the signup. */
async function onSignup({ userId, cref }) {
  if (cref) {
    // Public endpoint; no key needed. The SDK can also do this from the browser.
    const res = await fetch(`${API}/attribution/identify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cref, userId }),
    });
    // 404 click_not_found = a stale or forged cref: sign the user up anyway.
    if (!res.ok && res.status !== 404) throw new ApiError(res.status, await res.json().catch(() => null));
  }
  return op('POST', '/attribution/events', { userId, type: 'signup', externalEventId: `signup:${userId}` });
}

/** Payment: report it as invoice_paid, keyed by your invoice id. */
async function onInvoicePaid({ userId, invoiceId, amount, currency = 'USD' }) {
  return op('POST', '/attribution/events', {
    userId,
    type: 'invoice_paid',
    value: amount,
    currency,
    externalEventId: invoiceId,
  });
}

// --------------------------------------------------------------------- HTTP

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const indexHtml = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const as = url.searchParams.get('as');
      const headers = { 'content-type': 'text/html; charset=utf-8' };
      if (as && DEMO_USERS[as]) headers['set-cookie'] = `demo_user=${encodeURIComponent(as)}; Path=/; SameSite=Lax; HttpOnly`;
      res.writeHead(200, headers);
      return res.end(indexHtml);
    }
    if (req.method === 'GET' && url.pathname === '/api/referral') {
      return send(res, 200, await referralView(currentUser(req), { refresh: url.searchParams.has('refresh') }));
    }
    if (req.method === 'POST' && url.pathname === '/api/demo/signup') {
      return send(res, 200, await onSignup(await readJson(req)));
    }
    if (req.method === 'POST' && url.pathname === '/api/demo/invoice-paid') {
      return send(res, 200, await onInvoicePaid(await readJson(req)));
    }
    send(res, 404, { error: 'not_found' });
  } catch (err) {
    // Log the detail here; give the browser nothing it could leak.
    console.error(req.method, url.pathname, err instanceof ApiError ? { status: err.status, body: err.body } : err);
    send(res, 502, { error: 'referral_unavailable' });
  }
}).listen(PORT, () => {
  console.log(`In-app referral sample on http://localhost:${PORT} (OpenPartner API: ${API})`);
});
