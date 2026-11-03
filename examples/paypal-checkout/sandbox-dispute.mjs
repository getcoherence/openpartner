// Settle a PayPal SANDBOX dispute in the buyer's favour, so PayPal reverses
// the payment and OpenPartner records the chargeback (docs/paypal-payments.md,
// "Checking it against PayPal"). Sandbox only: the host is fixed, and the
// settle call (adjudicate) exists only there. No dependencies; Node 20+.
//
//   PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node sandbox-dispute.mjs PP-D-…
//
// Run it in your own terminal with the sandbox app's credentials (the app
// needs Customer disputes). It escalates an inquiry to a claim, answers the
// claim with test evidence so PayPal puts it under review (waiting up to five
// minutes for each step), then settles it.

const API = 'https://api-m.sandbox.paypal.com';
const clientId = process.env.PAYPAL_CLIENT_ID ?? '';
const secret = process.env.PAYPAL_CLIENT_SECRET ?? '';
const disputeId = process.argv[2] ?? '';

if (!clientId || !secret || !/^PP-[A-Z0-9-]{4,60}$/.test(disputeId)) {
  console.error('Usage: PAYPAL_CLIENT_ID=… PAYPAL_CLIENT_SECRET=… node sandbox-dispute.mjs PP-D-…');
  process.exit(1);
}

async function call(method, path, token, body) {
  const form = body instanceof FormData;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(form ? {} : { 'Content-Type': 'application/json' }) },
    body: form ? body : body ? JSON.stringify(body) : undefined,
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
// PayPal turns the escalated dispute into a claim in its own time. The claim
// then waits for the seller: answering it puts it under review.
const settleable = () => d.status === 'UNDER_REVIEW' && links.includes('adjudicate');
let answered = false;
for (let i = 0; i < 20 && !settleable() && d.status !== 'RESOLVED'; i++) {
  if (!answered && d.dispute_life_cycle_stage === 'CHARGEBACK' && links.includes('provide_evidence')) {
    const form = new FormData();
    form.append('input', new Blob([JSON.stringify({
      evidences: [{
        evidence_type: 'PROOF_OF_FULFILLMENT',
        evidence_info: { tracking_info: [{ carrier_name: 'FEDEX', tracking_number: '122533485' }] },
        notes: 'Sandbox end-to-end test.',
      }],
    })], { type: 'application/json' }));
    await call('POST', `${path}/provide-evidence`, token, form);
    answered = true;
  } else {
    await new Promise((r) => setTimeout(r, 15_000));
  }
  ({ d, links } = await show());
}
if (settleable()) {
  await call('POST', `${path}/adjudicate`, token, { adjudication_outcome: 'BUYER_FAVOR' });
  await show();
  console.log('Settled for the buyer. PayPal reverses the payment; OpenPartner records the chargeback within a minute.');
} else {
  console.log('PayPal hasn’t made it settleable. Run this again later.');
}
