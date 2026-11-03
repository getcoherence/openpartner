# View-only seats

A brand can add someone who sees everything in the admin portal and
changes nothing: a teammate reading reports, an investor, a client. Until
now every Admin could change everything, payouts and settings included.

## Role

`Admin.role` is `admin` (full) or `viewer`. The column defaults to
`admin`, so every existing admin, and every admin that signup, install,
add-brand and booking claims create, is a full admin. The role is per
Admin row, so per workspace: one sign-in that spans several brands
(Workspaces) can be a full admin in one and a viewer in another, and
`GET /me/workspaces` returns the role of each.

The role is read from the Admin row on every request (the session lookup
already loads it), so a change takes effect on the viewer's next request.
Sessions survive a role change; revoking still ends them.

API keys have no role. The bootstrap `ADMIN_API_KEY`, admin keys and
scoped keys behave as before; a viewer can't mint or revoke one.

## Who manages seats

Full admins, from Admin → Admins:

- `POST /admins { email, name, role? }` invites; `role` defaults to `admin`.
- `PATCH /admins/:id { role }` changes a seat's role.
- Revoke, reinstate and resend invite work as before, for both roles.

Guards, checked under `FOR UPDATE` on the tenant's active admins as revoke
already does:

- The last active full admin can't be revoked (`cannot_revoke_last_active_admin`,
  now counting full admins only) or made a viewer (`cannot_demote_last_active_admin`).
  Viewers don't count towards "someone can still manage this brand".
- A signed-in admin can't change their own role (`cannot_change_own_role`),
  as they can't revoke themselves.

## Enforcement

One gate, in `requireAuth` (apps/api/src/view-only.ts). Every tenant
route that acts on a signed-in principal passes through it, whatever guard
follows (requireAdmin, requirePartnerOrAdmin, a check in the handler).
For a viewer's session it keys on the method and the matched route
pattern (`req.route.path`):

- Writes (anything but GET and HEAD) are refused with
  `403 { "error": "read_only" }`, unless the route is on
  `VIEWER_ALLOWED_WRITES`: the viewer's own account. Today that is
  `PUT /auth/password`. Sign-out, the platform identity routes (own
  password, workspace switching) and signed unsubscribe links don't go
  through `requireAuth`, so they work for viewers as for anyone. A future
  per-admin profile or notification setting goes on the list.
- Reads are allowed, except `VIEWER_DENIED_READS`, refused the same way:
  - `GET /export.json`, `GET /export.sql`, `GET /export/:table.:format`:
    the full data export, every customer and partner at once.
  - `GET /payouts/exports/:exportId.csv`: a payout file, with partners'
    full bank and PayPal details.
  - `GET /partners/:id/payout-profile`: a partner's full payout details.
  - `GET /partners/:id/postbacks/:postbackId/url`: a partner's sealed
    postback URL (already partner-only; listed so it stays shut).

Not on the deny list, because they hand over nothing a viewer couldn't
see on the page anyway: API key and webhook lists (prefixes only), mail,
PayPal, Stripe and Network settings (their public views), payout
statements (payout details masked). The secrets that do exist (API key
plaintext, webhook signing secrets, the conversion postback token,
partner sign-in links, report share links) are only ever returned by the
POST that mints or rotates them, which a viewer can't make.

Reads with a side effect stay allowed, as for any admin:
`GET /admin/network/me` also sends the Network the brand's heartbeat.

`__tests__/view-only.test.ts` walks every route in the app and sends each
one a viewer's request. Every write behind `requireAuth` must answer
`read_only` unless it is on the allow list, every denied read must too,
and every write that doesn't use `requireAuth` must be named in the test
with its reason (the ops console's `/platform-admin/*` routes, which have
their own operator auth, are taken as a group). A new route therefore
fails the test until it's classified, and a list entry naming no route
fails it as well.

## Email

A viewer gets the mail addressed to them as a person: the invite (which
says they're invited to view the brand), sign-in links, password resets. Brand mail that asks someone to act goes to full
admins only: partner applications, Tracking health alerts, setup and
tracking-gate reminders, PayPal batch alerts, platform-fee notices, brand
review decisions, campaign-end notices, sanctions notices, the Stripe
invoice address, and the reply-to fallback on partner mail. The Network's
recipient check (`POST /network/notify-recipients`) counts full admins
only.

A viewer seat doesn't count as running a brand either: add-brand's
auto-approval and the free-mail exemption look at full admin seats on
approved brands.

## Portal

- `GET /auth/whoami` returns the admin's `role`. The sidebar shows a
  "View only" badge under the signed-in name, and Workspaces shows it per
  brand.
- Editing controls are hidden (add, invite, run, approve, delete). A page
  that is mostly forms (Settings, Integrations, Webhooks, Billing, a
  partner's programs, coupons and commission) passes `edits` to `Page`:
  its header actions go and its controls are disabled. Export / import
  leaves the nav and its route sends a viewer to the dashboard.
- A refused request shows "You have view-only access." in the page's
  error banner, from the `read_only` code, so anything missed still says
  why.
- Admins shows each seat's role, invites with a role, and lets a full
  admin switch another seat between Admin and View only.
- Network: a viewer reads bookings, booking reports and message threads,
  without the refresh, sharing level and share link controls, the booking
  actions or the composer. Threads poll instead of opening the live
  socket, whose ticket is a POST.

## Export and import

`Admin` isn't in the export bundle: it's authentication data
([data-portability.md](data-portability.md#what-is-deliberately-not-in-the-bundle)).
So the role doesn't travel and the schema version stays at 13. A
restored instance starts with the admin who installed it, who invites
viewers again. If the admin roster ever joins the bundle, `role` travels
with it as an ordinary column; bundles from before it would restore every
admin as `admin`, the column default.
