// Settle a PayPal SANDBOX dispute for the buyer, so OpenPartner's handling of
// a lost dispute can be checked (docs/paypal-payments.md, "Checking it against
// PayPal"). Sandbox only: the host is fixed. No dependencies; Node 20+.
//
//   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node sandbox-dispute.mjs [PP-D-…]
//
// Run it in your own terminal with the sandbox app's credentials (the app
// needs Customer disputes). Start it with no id, then open the dispute as the
// sandbox buyer: it picks up the first dispute opened after it started.
//
// It settles the dispute the first way PayPal offers: the sandbox-only
// adjudicate (PayPal decides for the buyer) when that link is present,
// otherwise the seller accepting the claim, which refunds the buyer. In our
// checks PayPal never offered adjudicate, so expect the refund.

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
  // A new dispute takes a few minutes to show up.
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
  // PayPal returns the links in a different order on each read.
  const links = (d.links ?? []).map((l) => l.rel).sort();
  const line = `${d.dispute_id}: status ${d.status}, stage ${d.dispute_life_cycle_stage}, can: ${links.join(', ') || 'nothing'}${d.dispute_outcome ? `, outcome ${JSON.stringify(d.dispute_outcome)}` : ''}`;
  if (line !== last) console.log(line);
  last = line;
  return { d, links };
};

// Right after it opens, a dispute offers nothing for a minute or so.
let { d, links } = await show();
const ready = () => links.includes('adjudicate') || links.includes('accept_claim') || d.status === 'RESOLVED';
for (const end = until(10); !ready() && Date.now() < end; ) {
  await sleep(10_000);
  ({ d, links } = await show());
}
if (links.includes('adjudicate')) {
  await call('POST', `${path}/adjudicate`, token, { adjudication_outcome: 'BUYER_FAVOR' });
  console.log('Settled for the buyer by PayPal (adjudicate).');
} else if (links.includes('accept_claim')) {
  await call('POST', `${path}/accept-claim`, token, { note: 'Accepted for a sandbox end-to-end test.', accept_claim_type: 'REFUND' });
  console.log('Accepted the claim: PayPal refunds the buyer from the merchant account.');
} else if (d.status !== 'RESOLVED') {
  console.log('PayPal offered no way to settle it in 10 minutes.');
  process.exit(1);
}
for (const end = until(5); d.status !== 'RESOLVED' && Date.now() < end; ) {
  await sleep(10_000);
  ({ d, links } = await show());
}
