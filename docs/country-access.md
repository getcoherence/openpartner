# Country access — where the hosted platform doesn't serve

**Status:** shipped (Oct 2026). Hosted multi-tenant only; a self-hosted
install never applies these rules: its operator applies their own.

## The rule

The hosted platform refuses brands and partners **located** in certain
countries. Location means where the business is registered or the person
is based, plus where the request comes from. It never means nationality.

The list has two kinds of entry, and every surface labels them apart:

| Basis | Default entries | Why |
|---|---|---|
| US sanctions | Cuba (CU), Iran (IR), North Korea (KP), Russia (RU) | OpenPartner is operated by a US company. CU, IR and KP are comprehensively embargoed. For Russia, OFAC's 2024 determination under EO 14071 bars US persons from providing enterprise-management software (CRM included, FAQ 1187) as a service to anyone there. |
| Company policy | none | Countries an operator independently chooses not to serve. They are added in the ops console, so they live in that deployment's settings, not in this code. They are not a legal requirement and are never described as one. |

**Ukraine:** brands and partners declaring Ukraine (UA) must confirm they
are outside Crimea, Sevastopol and the Russian-occupied areas of Donetsk,
Luhansk, Kherson and Zaporizhzhia. US sanctions cover those regions, but
no country code can express them.

**Syria** is not on the list. The US embargo ended on July 1, 2025
(EO 14312). Stripe still prohibits Syria, so partners there can't be paid
through Stripe; they are paid through the brand's own payout method.

Operators edit the list and the enforcement switch in the ops console
under **Countries**. The setting lives in `PlatformSetting` (key
`countryAccess`), not env, because it changes when sanctions do. Every edit
is written to the audit log.

## Where it's checked

| Surface | Declared country | Request IP country |
|---|---|---|
| `POST /signup`, `POST /me/brands` | required, checked | checked |
| `POST /partner-signup` (join page) | required on hosted, checked | checked |
| `POST /signin`, `/auth/signin`, `/auth/magic/verify`, `/auth/platform-verify` | — | checked |
| `PUT /account/location` (existing brands' one-time prompt) | checked | checked |
| `POST /partners` (API-created partners) | optional, checked when sent | — (the caller is the brand's server) |

Refusals answer `403 country_not_supported`. A missing Ukraine
confirmation answers `400 occupied_region_confirmation_required`.
`POST /partners` answers both as `422` instead: it is an API call, and the
declared country is a field the caller sent. An accepted country there is
recorded with source `api`. The
portal shows a neutral message that gives no reason.

**Not gated:** the click router, `identify`, events, conversions. They
serve brands' own visitors and servers, not our customers, so blocking
them would break brands' links without protecting anything.

## Network creators

The Network applies the same list to creators (its `docs/country-access.md`):
creator signup requires a country, and signup, sign-in, the magic-link
verify and its one-time location prompt check it. The Network keeps its
own copy of the list, so it never depends on this platform at request
time; until the first push it applies the sanctions defaults above.

- **The copy** (`apps/api/src/country-access-sync.ts`): every console save
  sends the whole setting to the Network's `PUT /admin/country-access`
  with `NETWORK_ADMIN_API_KEY`, recording the operator who saved it. The
  daily `network-country-access-sync` job (03:45 UTC) sends it again, so a
  failed push heals, and **Push now** in the console sends it on demand.
  The console reads `GET /admin/country-access` back to show when the
  Network was last synced and whether its copy matches. A failed push
  never undoes the save here.
- **The creator's address:** creators reach the Network through
  `/api/creator-api/*` (`routes/creator-portal.ts`), so the Network sees
  this server as the caller. Every proxied request carries
  `x-openpartner-client-ip: <ip>;t=<unix seconds>;sig=<hex HMAC-SHA256(NETWORK_ADMIN_API_KEY, "<ip>.<t>")>`
  for the address the request came from. The Network ignores it when it's
  missing, stale (over five minutes) or wrongly signed. It isn't sent
  when `NETWORK_ADMIN_API_KEY` is unset.
- **The portal:** creator signup asks where they're based (with the
  Ukraine confirmation), creators from before that are asked once in the
  creator portal (`GET`/`PUT /creators/me/location`), and refusals show
  the same neutral message as for brands. A brand approving the request of
  a creator the Network no longer serves gets `409 creator_not_available`
  and is told the creator isn't available, without a reason.

## Records

Every declaration is kept in `LocationDeclaration`: subject, brand,
declared country, Ukraine confirmation, IP country at the time, source,
and declarant email. Refused declarations are kept too. The table is:

- append-only;
- free of foreign keys, so a tenant purge or partner erasure neither
  removes nor trips on it;
- kept for 10 years (OFAC record retention, 31 CFR 501.601);
- platform-scoped and never exported.

Brands from before country capture are asked once in the portal. A brand
that answers with a blocked country is refused and its declaration
recorded, and ops are emailed to reject it from the review console.

## IP geolocation

`apps/api/src/geoip.ts`:

- **Default source:** DB-IP's free *IP to Country Lite* database (CC BY 4.0,
  attribution shown in the ops console), downloaded monthly into
  `OPENPARTNER_GEOIP_DIR`.
- **Own database:** set `GEOIP_COUNTRY_DB` to a GeoIP2/GeoLite2-Country
  `.mmdb`.
- **Why not Cloudflare:** DO App Platform doesn't forward `cf-ipcountry`,
  and a client-settable header is no basis for a sanctions control.
- **Lookup failure:** a lookup that can't answer means "unknown", and the
  declared country is still enforced.

## Payouts

A partner whose latest declared country is on the list is held: their
Stripe payouts (direct Connect and the funded rail) aren't made, and a
manual payout carries a warning. A blocked partner, or a payout account or
address in a blocked country, is left out of the manual rail's PayPal and
Wise batch files ([manual-payout-files.md](manual-payout-files.md)). See
[sanctions-screening.md](sanctions-screening.md#payout-holds), which also
covers screening names against the US Consolidated Screening List.

## Not yet covered

- Re-checking live sessions. Sign-in is gated, but a session started
  elsewhere (up to 30 days) isn't re-checked on each request.
- Payouts already in flight when a hold appears
  ([sanctions-screening.md](sanctions-screening.md#payout-holds)).
- API-created partners without a `country`: there is nothing to hold on
  until one is declared.
