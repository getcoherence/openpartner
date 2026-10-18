// Stripe Payment Link → OpenPartner, for OpenPartner Cloud: a Stripe webhook
// endpoint that turns each paid Checkout Session into one conversion call.
// Subscribe it to checkout.session.completed and
// checkout.session.async_payment_succeeded. Zero dependencies; Node 22+.
// Guide: docs/headless-referral.md#stripe-payment-links-on-openpartner-cloud
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { fromStripeAmount } from './stripe-amount.mjs';

const { STRIPE_WEBHOOK_SECRET, OPENPARTNER_API_URL, OPENPARTNER_API_KEY, PORT = '3001' } = process.env;
if (!STRIPE_WEBHOOK_SECRET || !OPENPARTNER_API_URL || !OPENPARTNER_API_KEY) throw new Error('Set STRIPE_WEBHOOK_SECRET, OPENPARTNER_API_URL and OPENPARTNER_API_KEY');
const reply = (res, status, text) => res.writeHead(status, { 'content-type': 'text/plain' }).end(text);

// Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">, keyed with the whsec_ secret.
function fromStripe(raw, header = '') {
  const t = /(?:^|,)t=(\d+)/.exec(header)?.[1];
  const expected = Buffer.from(createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex'));
  const signed = [...header.matchAll(/(?:^|,)v1=([0-9a-f]{64})/g)].some(([, sig]) => timingSafeEqual(Buffer.from(sig), expected));
  return Boolean(t) && signed && Math.abs(Date.now() / 1000 - Number(t)) < 300;
}

createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8'); // verify the bytes as sent, before parsing
  if (!fromStripe(raw, req.headers['stripe-signature'])) return reply(res, 400, 'bad signature');

  const { type, data } = JSON.parse(raw);
  const session = data.object;
  const wanted = type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded';
  // No client_reference_id: not from a partner link. Not paid yet: async_payment_succeeded follows.
  if (!wanted || !session.client_reference_id || session.payment_status !== 'paid') return reply(res, 200, 'ignored');

  const currency = session.currency.toUpperCase();
  const conversion = { clickId: session.client_reference_id, type: 'invoice_paid', value: fromStripeAmount(session.amount_total, currency), currency, externalEventId: session.id };
  let answer;
  try {
    answer = await fetch(`${OPENPARTNER_API_URL}/attribution/conversions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${OPENPARTNER_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(conversion),
    });
  } catch {
    return reply(res, 503, 'OpenPartner unreachable'); // Stripe retries
  }
  const body = await answer.json().catch(() => ({}));
  console.log(session.id, answer.status, body.outcome ?? body.error, body.reason ?? '');
  // Retry what can succeed later (rate limit, outage, a key to fix). A 404, 409 or 422 never will.
  if (answer.status === 429 || answer.status >= 500 || answer.status === 401 || answer.status === 403) return reply(res, 503, 'retry');
  reply(res, 200, 'ok');
}).listen(Number(PORT), () => console.log(`forwarding Stripe checkouts on :${PORT}`));
