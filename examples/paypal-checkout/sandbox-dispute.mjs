// Settle a PayPal SANDBOX dispute in the buyer's favour, so PayPal takes the
// payment back and OpenPartner records it (docs/paypal-payments.md, "Checking
// it against PayPal"). Sandbox only: the host is fixed, and the settle call
// (adjudicate) exists only there. No dependencies; Node 20+.
//
//   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node sandbox-dispute.mjs [PP-D-…]
//
// Run it in your own terminal with the sandbox app's credentials (the app
// needs Customer disputes). Start it with no id, then open the dispute as the
// sandbox buyer: it picks up the first dispute opened after it started.
// PayPal settles a dispute only while it offers adjudicate, so this checks
// every 10 seconds and settles as soon as it does. Don't escalate or answer
// the dispute first: a claim escalated and answered was never offered it.

const API = 'https://api-m.sandbox.paypal.com';
const clientId = process.env.PAYPAL_CLIENT_ID ?? '';
const secret = process.env.PAYPAL_CLIENT_SECRET ?? '';
const given = process.argv[2] ?? '';

if (!clientId || !secret || (given && !/^PP-[A-Z0-9-]{4,60}$/.test(given))) {
  console.error('Usage: PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node sandbox-dispute.mjs [PP-D-…]');
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (minutes) => Date.now() + minutes * 60_000;

let disputeId = given;
if (!disputeId) {
  const since = new Date().toISOString();
  console.log('Waiting for a new dispute: open one as the sandbox buyer now.');
  for (const end = until(20); !disputeId && Date.now() < end; ) {
    const { items = [] } = await call('GET', `/v1/customer/disputes?start_time=${encodeURIComponent(since)}`, token);
    disputeId = items[0]?.dispute_id ?? '';
    if (!disputeId) await sleep(10_000);
  }
  if (!disputeId) {
    console.log('No new dispute in 20 minutes.');
    process.exit(1);
  }
}

const path = `/v1/customer/disputes/${encodeURIComponent(disputeId)}`;
let last = '';
const show = async () => {
  const d = await call('GET', path, token);
  const links = (d.links ?? []).map((l) => l.rel).sort();
  const line = `${d.dispute_id}: status ${d.status}, stage ${d.dispute_life_cycle_stage}, can: ${links.join(', ') || 'nothing'}`;
  if (line !== last) console.log(line);
  last = line;
  return { d, links };
};

let { d, links } = await show();
for (const end = until(20); !links.includes('adjudicate') && d.status !== 'RESOLVED' && Date.now() < end; ) {
  await sleep(10_000);
  ({ d, links } = await show());
}
if (links.includes('adjudicate')) {
  await call('POST', `${path}/adjudicate`, token, { adjudication_outcome: 'BUYER_FAVOR' });
  await show();
  console.log('Settled for the buyer. PayPal takes the payment back; OpenPartner records it within a minute.');
} else if (d.status === 'RESOLVED') {
  console.log(`Already resolved: ${d.dispute_outcome?.outcome_code ?? 'outcome not shown'}.`);
} else {
  console.log('PayPal never offered to settle it (no adjudicate link) in 20 minutes.');
}
