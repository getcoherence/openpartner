# In-app referral page (sample)

A minimal "Refer & earn" page inside your own app, built on the OpenPartner API. Your customer sees their share link, clicks, sign-ups, payments and earnings, and never signs in to OpenPartner.

- `server.mjs` is your backend. It holds the API key, creates each user's partner and link on first visit, and serves their stats. It has no dependencies; Node 22+.
- `public/index.html` is the page. It calls only `server.mjs`, never OpenPartner.
- `setup.mjs` is a one-time step run with an admin key: it turns off Network auto-enroll, creates a private program, and mints a scoped key.

The full walkthrough is [docs/headless-referral.md](../../docs/headless-referral.md). This folder is not part of the pnpm workspace, so nothing here is built or tested in CI.

## Run it

You need an OpenPartner tenant (OpenPartner Cloud or a local self-host) and an admin key.

```bash
cd examples/in-app-referral

OPENPARTNER_API_URL=https://app.openpartner.dev/api/t/<your-slug> \
OPENPARTNER_ADMIN_KEY=op_... \
APP_SIGNUP_URL=https://yourapp.example.com/signup \
node setup.mjs        # writes .env with a scoped key; the admin key isn't saved

node server.mjs       # http://localhost:3000
```

For a local self-host, use `OPENPARTNER_API_URL=http://localhost:4601` and `OPENPARTNER_SHARE_URL_BASE=http://localhost:4701/r`. On a white-label domain, set `OPENPARTNER_SHARE_URL_BASE=https://<your-domain>/r`. See `.env.example`.

Open http://localhost:3000. The first visit creates the demo user's partner (`sendInvite: false`, so no email) and share link. Switch between the two demo users with the links in the header; the cookie stands in for your real login.

## Make some activity

Follow the share link in a private window. The router redirects to your `APP_SIGNUP_URL` with `?cref=<click id>` appended; copy that id. Then play your backend's part:

```bash
# Your signup handler: stitch the click, record the signup.
curl -s -X POST localhost:3000/api/demo/signup -H 'content-type: application/json' \
  -d '{"userId":"friend_1","cref":"<click id>"}'

# Your billing handler: each payment, keyed by invoice id.
curl -s -X POST localhost:3000/api/demo/invoice-paid -H 'content-type: application/json' \
  -d '{"userId":"friend_1","invoiceId":"in_1001","amount":49}'
```

Send the same invoice twice and the second call replays (`"replayed": true`) instead of paying twice. Press **Refresh** on the page: stats are cached for a minute, because all of your server's API calls share one rate limit.

The two `/api/demo/*` routes exist only so you can drive the loop with curl. In your app, that code (`onSignup`, `onInvoicePaid` in `server.mjs`) runs inside your own signup and billing handlers, not as public endpoints. In the browser, `@openpartner/sdk` captures the `cref` for you:

```js
import { OpenPartner } from '@openpartner/sdk';
const op = OpenPartner.init({ apiUrl: 'https://app.openpartner.dev/api/t/<your-slug>' });
// After signup:
await op.identify(user.id);
```

## What to change for production

- Replace the demo session (`currentUser`) with your own auth, and store `partnerId` and `linkKey` on your users table instead of the in-memory map.
- Decide which partner to show from the signed-in user only. The scoped key can read every partner.
- Keep the key in your secret store. It is never sent to the browser.
- Put the stats cache somewhere shared (Redis, your DB) if you run more than one server.
