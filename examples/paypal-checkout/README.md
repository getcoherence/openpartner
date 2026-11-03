# PayPal checkout test page (sample)

One page that does what a brand's checkout does for [PayPal payments](../../docs/paypal-payments.md): the OpenPartner script captures the partner click, and the order or subscription carries it in `custom_id`. Use it as a program's destination to check the whole path against a real PayPal app.

It has no dependencies (Node 20+) and isn't part of the pnpm workspace, so nothing here is built or tested in CI.

```bash
cd examples/paypal-checkout

OPENPARTNER_API_URL=https://app.openpartner.dev/api/t/<your-slug> \
PAYPAL_CLIENT_ID=<your PayPal app's client id> \
PAYPAL_CLIENT_SECRET=<its secret> \
PAYPAL_PLAN_ID=P-...   # optional: a plan of the same app, for /?mode=subscription
node server.mjs        # http://localhost:3001
```

- Like a brand's own server, it creates and captures each order with the app's credentials (PayPal's standard integration), so run it in your own terminal. It listens on 127.0.0.1 only. OpenPartner gets the same credentials separately (Settings → Pay with PayPal, or Integrations → PayPal).
- Sandbox by default: pay with a sandbox Personal account. `PAYPAL_ENV=live` for a live app.
- Errors and cancelled payments show under the button.
- Set the program's destination to `http://localhost:3001/`. The router's redirect happens in your own browser, so a local page works. Only OpenPartner's webhook needs a public https address.
- `AMOUNT` (default `10.00`) and `CURRENCY` (default `USD`) change the one-time payment.

`sandbox-dispute.mjs` settles a sandbox dispute for the buyer: PayPal's sandbox-only adjudicate when PayPal offers it, otherwise by accepting the claim, which refunds the buyer. Run it in your own terminal with the sandbox app's client id and secret, then open the dispute as the sandbox buyer: it picks the dispute up.

The steps to run against it are in [docs/paypal-payments.md](../../docs/paypal-payments.md#checking-it-against-paypal).
