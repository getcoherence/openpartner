// A one-page PayPal checkout for checking PayPal payments end to end
// (docs/paypal-payments.md): the OpenPartner script captures the partner
// click, and the order this server creates carries it in custom_id. No
// dependencies; Node 20+.
//
//   OPENPARTNER_API_URL=https://app.openpartner.dev/api/t/<your-slug> \
//   PAYPAL_CLIENT_ID=<your app's client id> \
//   PAYPAL_CLIENT_SECRET=<its secret> \
//   node server.mjs            # http://localhost:3001
//
// Like a brand's own server, it creates and captures orders with the app's
// credentials (PayPal's standard integration), so run it in your own
// terminal. It listens on 127.0.0.1 only. Sandbox by default: PAYPAL_ENV=live
// for a live app.

import { createServer } from 'node:http';

const apiUrl = (process.env.OPENPARTNER_API_URL ?? '').replace(/\/$/, '');
const clientId = process.env.PAYPAL_CLIENT_ID ?? '';
const secret = process.env.PAYPAL_CLIENT_SECRET ?? '';
const paypalApi = process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const planId = process.env.PAYPAL_PLAN_ID ?? '';
const currency = process.env.CURRENCY ?? 'USD';
const amount = process.env.AMOUNT ?? '10.00';
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';

if (!apiUrl || !clientId || !secret) {
  console.error('Set OPENPARTNER_API_URL, PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.');
  process.exit(1);
}

// Only orders this server created can be captured through it.
const orders = new Set();

async function accessToken() {
  const res = await fetch(`${paypalApi}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal refused the credentials (${res.status}). For a live app, set PAYPAL_ENV=live.`);
  return (await res.json()).access_token;
}

async function paypalPost(path, body) {
  const res = await fetch(`${paypalApi}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal ${res.status}: ${data.details?.[0]?.issue ?? data.name ?? 'error'}`);
  return data;
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) throw new Error('Body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

function page(subscription) {
  const sdk = new URL('https://www.paypal.com/sdk/js');
  sdk.searchParams.set('client-id', clientId);
  if (subscription) {
    sdk.searchParams.set('vault', 'true');
    sdk.searchParams.set('intent', 'subscription');
  } else {
    sdk.searchParams.set('currency', currency);
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PayPal checkout test</title>
<script src="${attr(new URL(apiUrl).origin)}/op.js" data-api-url="${attr(apiUrl)}"></script>
<script src="${attr(sdk.toString())}"></script>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px}code{background:#f3f4f6;padding:1px 5px;border-radius:4px}</style>
</head>
<body>
<h1>PayPal checkout test</h1>
<p>${subscription ? `Subscribe to <code>${attr(planId)}</code>` : `Pay ${attr(currency)} ${attr(amount)}`}. <a href="${subscription ? '/' : '/?mode=subscription'}">${subscription ? 'One-time payment' : 'Subscription'} instead</a></p>
<p>Partner click: <code id="ref"></code></p>
<div id="paypal-button"></div>
<p id="status"></p>
<script>
const referral = () => (window.openpartner && window.openpartner.getReferral()) || undefined;
const status = (text) => { document.getElementById('status').textContent = text; };
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  .then(async (r) => { const data = await r.json(); if (!r.ok) throw new Error(data.error); return data; });
document.getElementById('ref').textContent = referral() || 'none: open this page from a partner link or a test click';
const subscription = ${json(subscription)};
const outcome = {
  onCancel: () => status('Cancelled: nothing was paid.'),
  onError: (err) => status('PayPal error: ' + ((err && err.message) || err)),
};
paypal.Buttons(subscription ? {
  createSubscription: (data, actions) => actions.subscription.create({ plan_id: ${json(planId)}, custom_id: referral() }),
  onApprove: (data) => status('Subscribed: ' + data.subscriptionID),
  ...outcome,
} : {
  createOrder: () => post('/orders', { referral: referral() }).then((order) => order.id),
  onApprove: (data) => post('/orders/' + encodeURIComponent(data.orderID) + '/capture')
    .then((capture) => status('Paid: capture ' + capture.id + ' (' + capture.status + ')'))
    .catch((err) => status('Not paid: ' + err.message)),
  ...outcome,
}).render('#paypal-button');
</script>
</body>
</html>`;
}

async function route(req, res, url) {
  const reply = (code, body) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  if (req.method === 'POST' && url.pathname === '/orders') {
    const { referral } = await readJson(req);
    const order = await paypalPost('/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: currency, value: amount },
        custom_id: typeof referral === 'string' && referral.length <= 127 ? referral : undefined,
      }],
    });
    orders.add(order.id);
    return reply(200, { id: order.id });
  }
  const capture = req.method === 'POST' && /^\/orders\/([A-Z0-9]{1,36})\/capture$/.exec(url.pathname);
  if (capture) {
    if (!orders.has(capture[1])) return reply(404, { error: 'Not an order this page created.' });
    const order = await paypalPost(`/v2/checkout/orders/${capture[1]}/capture`, {});
    const done = order.purchase_units?.[0]?.payments?.captures?.[0];
    return reply(200, { id: done?.id, status: done?.status ?? order.status });
  }
  if (url.pathname !== '/') return res.writeHead(404).end();
  const subscription = url.searchParams.get('mode') === 'subscription';
  if (subscription && !planId) {
    return res.writeHead(400, { 'content-type': 'text/plain' }).end('Set PAYPAL_PLAN_ID to test a subscription.');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page(subscription));
}

await accessToken().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  route(req, res, url).catch((err) => {
    console.error(err.message);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
  });
}).listen(port, host, () => console.log(`PayPal checkout test on http://localhost:${port}`));
