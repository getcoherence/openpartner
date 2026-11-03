// Settle a PayPal SANDBOX dispute in the buyer's favour, so PayPal reverses
// the payment and OpenPartner records the chargeback (docs/paypal-payments.md,
// "Checking it against PayPal"). Sandbox only: the host is fixed, and the
// settle call (adjudicate) exists only there. No dependencies; Node 20+.
//
//   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node sandbox-dispute.mjs PP-D-…
//
// Run it in your own terminal with the sandbox app's credentials (the app
// needs Customer disputes). It escalates an inquiry to a claim, then settles
// it once PayPal shows it under review.

const API = 'https://api-m.sandbox.paypal.com';
const clientId = process.env.PAYPAL_CLIENT_ID ?? '';
const secret = process.env.PAYPAL_CLIENT_SECRET ?? '';
const disputeId = process.argv[2] ?? '';

if (!clientId || !secret || !/^PP-[A-Z0-9-]{4,60}$/.test(disputeId)) {
  console.error('Usage: PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node sandbox-dispute.mjs PP-D-…');
  process.exit(1);
}

async function call(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : {};
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
const path = `/v1/customer/disputes/${encodeURIComponent(disputeId)}`;
const show = async () => {
  const d = await call('GET', path, token);
  const links = (d.links ?? []).map((l) => l.rel);
  console.log(`${d.dispute_id}: status ${d.status}, stage ${d.dispute_life_cycle_stage}, can: ${links.join(', ') || 'nothing'}`);
  return { d, links };
};

let { d, links } = await show();
if (d.dispute_life_cycle_stage === 'INQUIRY' && links.includes('escalate')) {
  await call('POST', `${path}/escalate`, token, { note: 'Escalated for an end-to-end test.' });
  ({ d, links } = await show());
}
if (d.status === 'UNDER_REVIEW' && links.includes('adjudicate')) {
  await call('POST', `${path}/adjudicate`, token, { adjudication_outcome: 'BUYER_FAVOR' });
  await show();
  console.log('Settled for the buyer. PayPal reverses the payment; OpenPartner records the chargeback within a minute.');
} else {
  console.log('Not under review yet, so it can’t be settled. Run this again in a minute.');
}
