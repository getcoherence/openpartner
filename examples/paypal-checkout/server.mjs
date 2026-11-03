// A one-page PayPal checkout for checking PayPal payments end to end
// (docs/paypal-payments.md): the OpenPartner script captures the partner
// click, and the PayPal button puts it in custom_id. No dependencies; Node 20+.
//
//   OPENPARTNER_API_URL=https://app.openpartner.dev/api/t/<your-slug> \
//   PAYPAL_CLIENT_ID=<your app's client id> \
//   node server.mjs            # http://localhost:3001
//
// The client id is PayPal's public app identifier. The secret never goes
// here: it belongs in OpenPartner (Settings → Pay with PayPal, or
// Integrations → PayPal).

import { createServer } from 'node:http';

const apiUrl = (process.env.OPENPARTNER_API_URL ?? '').replace(/\/$/, '');
const clientId = process.env.PAYPAL_CLIENT_ID ?? '';
const planId = process.env.PAYPAL_PLAN_ID ?? '';
const currency = process.env.CURRENCY ?? 'USD';
const amount = process.env.AMOUNT ?? '10.00';
const port = Number(process.env.PORT ?? 3001);

if (!apiUrl || !clientId) {
  console.error('Set OPENPARTNER_API_URL and PAYPAL_CLIENT_ID.');
  process.exit(1);
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
document.getElementById('ref').textContent = referral() || 'none: open this page from a partner link or a test click';
const subscription = ${json(subscription)};
paypal.Buttons(subscription ? {
  createSubscription: (data, actions) => actions.subscription.create({ plan_id: ${json(planId)}, custom_id: referral() }),
  onApprove: (data) => status('Subscribed: ' + data.subscriptionID),
} : {
  createOrder: (data, actions) => actions.order.create({
    purchase_units: [{ amount: { currency_code: ${json(currency)}, value: ${json(amount)} }, custom_id: referral() }],
  }),
  onApprove: (data, actions) => actions.order.capture().then((order) =>
    status('Paid: capture ' + order.purchase_units[0].payments.captures[0].id)),
}).render('#paypal-button');
</script>
</body>
</html>`;
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (url.pathname !== '/') {
    res.writeHead(404).end();
    return;
  }
  const subscription = url.searchParams.get('mode') === 'subscription';
  if (subscription && !planId) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('Set PAYPAL_PLAN_ID to test a subscription.');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page(subscription));
}).listen(port, () => console.log(`PayPal checkout test on http://localhost:${port}`));
