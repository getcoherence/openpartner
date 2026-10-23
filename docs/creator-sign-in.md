# Creator sign-in — links, passwords, Google

**Status:** shipped (Oct 2026). Network creators get what brand admins and
partners got in PR #211: a password and "Continue with Google", alongside
the emailed link. Creator accounts live on the OpenPartner Network
(getcoherence/openpartner-network); its `docs/creator-auth.md` covers the
Network side: storage, throttles, deletion. This page covers the creator
portal (`/creator/*` on the platform origin) and the Google round trip, which
run here.

## The rule

A password or a Google ID token only **proves the address**. The Network
then issues the very token its sign-in email would have carried, and the
existing verify endpoint redeems it:

```
email link    POST /creators/signin ─ mail ─┐
password      POST /creators/signin/password ─┼─► token ─► POST /creators/verify ─► session
Google        google-auth.ts → POST /admin/creators/signin-token ┘
```

Sessions, the country check, takedowns (blocked creators) and deletion
state all stay in `/creators/verify` on the Network, the one audited place.
Nothing here mints a creator session.

## What creators see

| Page | What's new |
|---|---|
| `/creator/login` | Email + password, "Forgot password?", "Email me a sign-in link instead", "Continue with Google" (when Google is configured). |
| `/creator/signup` | "Sign up with Google". Coming back from Google with no account yet, the email is fixed ("✓ Verified by Google", with "Use a different email") and the form still asks for a name, handle and country. |
| `/creator/reset-password` | Where the Network's "forgot password" email lands. Choose a password, then sign in. |
| `/creator/profile` | A **Password** card: set a first password, or change it (current password required). Hidden while the account is scheduled for deletion. |

Passwords need at least 10 characters (no composition rules). A creator who
only ever used emailed links sets a first password either from the
Password card or through "Forgot password?".

- **Change:** signs the creator out on their other devices.
- **Reset:** signs them out everywhere, this browser included.
- **Emailed links:** keep working throughout.

## The proxy

The portal reaches the Network through `/api/creator-api/*`
(`apps/api/src/routes/creator-portal.ts`), an exact-path allowlist that
signs the browser's address into `x-openpartner-client-ip` for the
Network's country gate. Added:

```
POST /creators/signin/password
POST /creators/password/forgot
POST /creators/password/reset
GET|PUT /creators/me/password
```

The admin endpoints (`/admin/creators/*`) are not proxied, and never are:
only this server calls them, with `NETWORK_ADMIN_API_KEY`.

The Network refuses `GET|PUT /creators/me/password` to a brand acting for
its partner (`x-act-as-vendor-partner`). Only the creator's own session can
set the password that opens every brand they work with.

## Google: the `creator` flow

`apps/api/src/routes/google-auth.ts`, `?flow=creator`. Same OIDC client and
the single redirect URI on the platform origin as the other flows
(`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`,
`${PORTAL_URL}/api/auth/google/callback`). Multi-tenant only, and only when
`NETWORK_URL` and `NETWORK_ADMIN_API_KEY` are set; otherwise the button
leads back to `/creator/login?error=google_unavailable`.

After the usual ID-token checks (issuer, audience, expiry, nonce,
`email_verified`), the creator flow adds one more. **Google must be
authoritative for the address**: a `@gmail.com` / `@googlemail.com` address,
or a Workspace account (the ID token carries `hd`). A Google account opened on
another provider's address (say a Yahoo address added to a Google account)
proves only who could read that inbox when it was opened. If the address
has since changed hands, the former owner would get in. Google documents
this limit, so those creators land on
`/creator/login?error=google_not_authoritative` and use their password or an
emailed link instead. The brand flows from #211 don't apply this check yet
(see the PR's follow-up note).

Then the callback calls the Network server-to-server:

```
POST {NETWORK_URL}/admin/creators/signin-token     Authorization: Bearer NETWORK_ADMIN_API_KEY
{ "email": "<verified, lower-cased>" }             x-openpartner-client-ip: <browser address, signed>
```

| Network answer | Where the browser goes |
|---|---|
| *(not authoritative)* | `/creator/login?error=google_not_authoritative`; the Network isn't asked |
| `200 { token }` | `/creator/auth/magic?token=…` → `POST /creators/verify` → `/creator` |
| `404 no_creator` | `/creator/signup?google=1`, with the address in a signed cookie |
| `403 creator_not_active` / `country_not_supported` | `/creator/login?error=<code>` |
| anything else | `/creator/login?error=google_failed` |

The Network never creates an account at this endpoint.

### No account yet: signing up with Google

Google has just verified the address, so signup skips the confirmation
email. This is how it works:

1. The callback sets `op_creator_google_signup`. It holds the address and an
   expiry, MAC'd with `macValue('creator-google-signup', …)`
   (SECRETS_ENCRYPTION_KEY), and is `HttpOnly; Secure; SameSite=Lax`,
   15 minutes. The address never goes in the URL.
2. `/creator/signup?google=1` reads it with `GET /api/auth/google/creator-signup`
   to show the fixed email. "Use a different email" calls `DELETE` on the same
   path and falls back to the ordinary emailed-link signup.
3. Submitting sends only the form's fields (`name`, `handle?`, `country`,
   `outsideOccupiedRegions?`) to `POST /api/auth/google/creator-signup`. The
   schema is strict, so an `email` in the body is refused. The server takes
   the address from the cookie and calls the Network's
   `POST /admin/creators/signup`. That endpoint uses the same schema, country
   rules and location declaration as the public `/creators/signup`, and
   returns a token instead of mailing a link.
4. The page redeems the token at `/creators/verify`, the same as any other
   sign-in. The cookie is cleared once signup succeeds. A refusal (handle
   taken, country refused) leaves the cookie in place so the form can be fixed.
5. If the address has become a creator since the callback, the Network
   answers `409 creator_exists` with **no token**. The cookie is then
   cleared and the page tells the creator to sign in. This endpoint only
   ever signs in the account it just created, so a copied or replayed
   cookie can't open an existing account.

**Decision.** A Google-verified address may skip the confirmation email,
because Google has just done what that email does. The Network accepts this
**only over the admin key**. Its public `POST /creators/signup` still always
mails a link. This server already holds that key for everything else it
asks of the Network (moderation, the country list), so trusting it to
vouch for a Google-verified address adds no new trusted party.

### What's stored about the Google account

Nothing. The Network receives only the verified address. The signup cookie
lives in the browser for at most 15 minutes and is cleared on success. The
request log redacts the authorization code (`?code=`) and the magic-link
token in the callback's `Location` header (`request-log.ts`).

## Errors the pages show

`authErrorMessage` in `apps/portal/src/pages/auth/PasswordAuth.tsx`:

- `invalid_credentials`: also covers a creator with no password, without
  saying which.
- `too_many_attempts`: 10 wrong passwords per 15 minutes holds the address.
- `rate_limited`
- `current_password_incorrect`
- `invalid_or_expired_token`
- `creator_not_active`
- `pending_deletion`
- `google_signup_expired`, `google_not_authoritative`, `creator_exists`
- the Google round-trip codes
- the country codes, through `countryErrorMessage`

## Deploy order

1. **The Network PR** (passwords, `/admin/creators/signin-token`,
   `/admin/creators/signup`).
2. **This repo.** Against an older Network the new proxy paths and both
   admin calls 404: password sign-in fails and Google sends every creator
   to `/creator/login?error=google_failed`.

Nothing new to configure: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`,
`NETWORK_URL` and `NETWORK_ADMIN_API_KEY` are already set in prod, and the
redirect URI is unchanged.
