# PayPal checkout test page (sample)

One page that does what a brand's checkout does for [PayPal payments](../../docs/paypal-payments.md): the OpenPartner script captures the partner click, and PayPal's button puts it in `custom_id`, for a one-time payment or a subscription. Use it as a program's destination to check the whole path against a real PayPal app.

It has no dependencies (Node 20+) and isn't part of the pnpm workspace, so nothing here is built or tested in CI.

```bash
cd examples/paypal-checkout

OPENPARTNER_API_URL=https://app.openpartner.dev/api/t/<your-slug> \
PAYPAL_CLIENT_ID=<your PayPal app's client id> \
PAYPAL_PLAN_ID=P-...   # optional: a plan of the same app, for /?mode=subscription
node server.mjs        # http://localhost:3001
```

- The client id is PayPal's public app identifier. The app's secret never goes here: paste it into OpenPartner (Settings → Pay with PayPal, or Integrations → PayPal).
- A sandbox app's client id gives PayPal's sandbox checkout: pay with a sandbox Personal account.
- Set the program's destination to `http://localhost:3001/`. The router's redirect happens in your own browser, so a local page works. Only OpenPartner's webhook needs a public https address.
- `AMOUNT` (default `10.00`) and `CURRENCY` (default `USD`) change the one-time payment.

The steps to run against it are in [docs/paypal-payments.md](../../docs/paypal-payments.md#checking-it-against-paypal).
