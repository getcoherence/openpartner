// Create a PayPal SANDBOX subscription plan for the checkout test page's
// /?mode=subscription (docs/paypal-payments.md, "Checking it against PayPal").
// Sandbox only: the host is fixed. No dependencies; Node 20+.
//
//   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node sandbox-plan.mjs
//
// Run it in your own terminal with the same app's credentials as the page.
// The plan bills daily, three times, so a renewal arrives a day after
// subscribing and the subscription ends by itself. It prints the plan id
// alone, for PAYPAL_PLAN_ID. AMOUNT (default 5.00) and CURRENCY (default
// USD) set the price.

import { randomUUID } from 'node:crypto';

const API = 'https://api-m.sandbox.paypal.com';
const clientId = process.env.PAYPAL_CLIENT_ID ?? '';
const secret = process.env.PAYPAL_CLIENT_SECRET ?? '';
const amount = process.env.AMOUNT ?? '5.00';
const currency = process.env.CURRENCY ?? 'USD';

if (!clientId || !secret) {
  console.error('Usage: PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node sandbox-plan.mjs');
  process.exit(1);
}

async function post(path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': randomUUID(),
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

const tokenRes = await fetch(`${API}/v1/oauth2/token`, {
  method: 'POST',
  headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'grant_type=client_credentials',
});
if (!tokenRes.ok) {
  console.error(`PayPal refused the credentials (${tokenRes.status}). Are they the sandbox app's?`);
  process.exit(1);
}
const { access_token: token } = await tokenRes.json();

try {
  const product = await post('/v1/catalogs/products', token, {
    name: 'OpenPartner subscription check',
    type: 'SERVICE',
    category: 'SOFTWARE',
  });
  const plan = await post('/v1/billing/plans', token, {
    product_id: product.id,
    name: `Daily, three payments (${new Date().toISOString().slice(0, 10)})`,
    status: 'ACTIVE',
    billing_cycles: [{
      frequency: { interval_unit: 'DAY', interval_count: 1 },
      tenure_type: 'REGULAR',
      sequence: 1,
      total_cycles: 3,
      pricing_scheme: { fixed_price: { value: amount, currency_code: currency } },
    }],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 1 },
  });
  console.error(`Plan ${plan.id}: ${currency} ${amount} a day, three payments (product ${product.id}).`);
  console.log(plan.id);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
