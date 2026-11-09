# Two-step sign-in

Brand admins can add a second step to signing in: a six-digit code from an
authenticator app (Google Authenticator, 1Password, Authy, and so on),
after the email link, password or Google. A brand can require it of every
admin. Admin → Admins → Two-step sign-in.

Partners and the OpenPartner operator console don't have it yet.

## The authenticator belongs to the person

It is keyed to the email, like the password (`TwoFactorCredential`, kept the
way `PasswordCredential` is: principalKind `platform`, principalId the
lower-cased email, tenantId `DEFAULT_TENANT_ID`). One authenticator covers
every brand the person admins and their OpenPartner account.

- The TOTP secret is stored sealed (crypto.ts, `SECRETS_ENCRYPTION_KEY`).
- RFC 6238 codes: HMAC-SHA1, six digits, 30-second steps, one step of drift
  either way (apps/api/src/totp.ts). A code is only taken for a later step
  than the last one accepted, so no code works twice.
- Ten recovery codes (12 characters, Crockford base32, shown as
  `XXXX-XXXX-XXXX`), stored as salted SHA-256, each good once. Making new
  ones replaces the old.
- Privileged pool only: not granted to `openpartner_app`, no RLS, not
  exported. It is deleted 30 days after the email's last admin seat ends,
  on the same rule as the platform password (scheduler.ts).

## Signing in

Every session is made by `createSession` (a brand) or
`createPlatformSession` (an OpenPartner account). When the person has
two-step on, the new session starts **pending**:

- `resolveSession` and `resolvePlatformSession` never return a pending
  session, so it reaches nothing. A way of signing in that forgets about
  two-step still can't hand out a working session.
- They also refuse, for someone with two-step on, any session that hasn't
  proved a code since it was turned on (`lacksRequiredCode`: no
  `secondFactorAt`, or one older than `enabledAt`), however it was made.
  One created in the instant two-step was being turned on would otherwise
  miss both the pending flag and the turn-on's sweep, and one carrying a
  proof from before two-step was turned off and on again would outlive the
  new authenticator.
- A late wrong code checked in parallel with a right one never ends the
  sign-in the right one finished.
- The verify endpoints say `twoFactorRequired: true`, and a request with a
  pending brand session gets `401 two_factor_required`, so the portal asks
  for the code whichever way in the person took (or after a reload).
- `POST /auth/two-factor/verify` (brand) and `POST /auth/platform-two-factor`
  (account) take the code or a recovery code. A right one makes the session
  work and records the sign-in in the [audit log](audit-log.md) with
  `secondFactor: "totp"` or `"recovery_code"`.
- Five wrong codes end the pending session; it also lapses after 10
  minutes. Codes are also limited per person, 10 tries per 15 minutes,
  across sessions and IPs. Both tries are spent before the code is checked
  (the session's by one conditional update of its row), so parallel
  guesses get no more; a right code gives the person's back.
- Entering a brand from an OpenPartner account that proved a code needs no
  second code (`secondFactorAt` carries over).
- A pending identity can't be switched to from the account switcher.

## Setting it up

The signed-in admin's own sessions only: an API key gets
`403 session_required`. View-only seats can set up their own.

| Route | |
|---|---|
| `GET /auth/two-factor` | on or off, recovery codes left, whether this session proved a code, whether the brand requires it |
| `POST /auth/two-factor/setup` | a new secret and its `otpauth://` URI (the portal shows a QR code); replaces only a secret that isn't on yet, in one statement, so it can't race the first code |
| `POST /auth/two-factor/enable` `{ code }` | the first code turns it on; returns the recovery codes, once |
| `POST /auth/two-factor/disable` `{ code }` | turns it off (refused with `required_by_brand` while this brand requires it) |
| `POST /auth/two-factor/recovery-codes` `{ code }` | new recovery codes |

Turning it on or off ends every other session the person holds (the
OpenPartner account and each brand) and emails them. New recovery codes
email them too. Turning it on also counts this browser's sessions as
having proved a code; turning it off clears that, so a brand that
requires two-step asks for setup instead of taking the old proof.

## Requiring it

`GET/POST /config/admin-security { requireTwoFactor }`, full admins. The
`admin_security` Config key travels in the export bundle.

- Whoever turns the rule on must have two-step on themselves
  (`409 two_factor_not_enabled`), so they can't lock themselves into
  setup.
- `requireAuth` then refuses an admin session that hasn't proven a code
  with `403 two_factor_setup_required`, except on `TWO_FACTOR_SETUP_ROUTES`
  (whoami and the setup routes). The portal shows the setup screen.
- API keys aren't people and aren't affected.

## Lost phone

Sign in with a recovery code, then turn two-step off and on again (or make
new recovery codes). Without one, the person can't get in on their own:

- **OpenPartner Cloud:** contact support.
- **Self-hosted:** an operator deletes the person's credential, which turns
  two-step off for them:

  ```sql
  DELETE FROM "TwoFactorCredential"
   WHERE "principalKind" = 'platform' AND "principalId" = lower('person@example.com');
  ```

## Audit log

Turning it on or off, new recovery codes and the brand rule are logged as
admin actions. They write to the privileged pool outside the brand's
request transaction (like a password change), so the entry is written
alongside the change rather than in the same commit.
