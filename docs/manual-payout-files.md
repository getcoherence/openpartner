# Manual payout files: PayPal and Wise batches

On the manual payout rail the brand pays partners itself. A payout run
records a `manual` Payout per partner and currency, `pending`, with its
commissions already marked paid (apps/api/src/payouts.ts). The brand then
sends the money and confirms each payout.

This feature makes that practical in countries Stripe Connect can't reach.
Partners store where they want to be paid, and the brand downloads files it
uploads to **its own** PayPal or Wise account. Money moves from the brand's
account straight to the partner. OpenPartner never holds, forwards or
initiates the transfer, which is the same principle as Connect Standard
(CLAUDE.md principle 4). Managed payout providers (Trolley, Tipalti,
Payoneer) are out of scope: they would put OpenPartner in the flow of funds.

The Connect and funded rails are unchanged.

## Payout details

One `PartnerPayoutProfile` row per partner
(migration `20261020010000_partner_payout_profile`).

| `method` | What it holds | Goes in |
|---|---|---|
| `paypal` | the PayPal account email; optionally the account's country | the PayPal file |
| `bank` | account holder name and type (person or business), the bank's country, the account currency, and an IBAN or a local account number plus its routing: `sortCode` (GBP), `routingNumber` + `accountType` (USD), `ifsc` (INR), or `bic` + address (any other currency, by SWIFT). The holder's address is also required for a USD, PHP, THB or TRY account, with the state or province in the US, Canada or Brazil (Wise's rules). Optional notice email. | the Wise file |
| `upi` | an Indian UPI ID and optional name | no file: the brand pays it one at a time |
| `other` | free-text instructions | no file: the brand pays it one at a time |

Validation runs before anything is stored: IBAN mod-97, ABA checksum, IFSC
shape, sort code, the routing each currency needs, and an IBAN that matches
the bank's country. Names, emails and address lines that would start with
`=`, `+`, `-` or `@` are refused, because a spreadsheet opening the file
would run them as formulas. The usual guard (a leading quote) would change
the name the bank checks.

**Who edits them**

- The partner, in the portal (Payout details).
- A brand admin, on the partner's behalf (Admin → Partners → Payout details).
- A headless brand, from its own app: `PUT /partners/{id}/payout-profile`
  with a scoped key holding `payout_profiles:write`, and
  `GET /partners/{id}/payout-profile` with `payout_profiles:read`.

Every change and removal emails the partner a masked notice saying who made
it ("from your partner account" or "by {brand}"). A quietly redirected
payout is the classic account-takeover fraud. Partners without portal access
(headless programs) aren't emailed: the brand's own app owns that
conversation. The batch page also flags details changed in the last 7 days.

**Stored sensitively**

- Everything except `method` and `country` is sealed with AES-256-GCM under
  `SECRETS_ENCRYPTION_KEY` (apps/api/src/crypto.ts), the same envelope the
  SMTP password uses. `method` and `country` stay in the clear so files can
  be sorted and the country list checked without opening every row.
- Nothing logs a detail. Validation errors name fields, never values, and
  a parse failure is swallowed rather than rethrown, because `JSON.parse`
  quotes its input in the message.
- Everywhere except the profile itself and the batch files, details are
  masked (`PayPal j•••@pay.test`, `Bank IBAN GB •••• 5432 (GBP)`).
- A row sealed under another key (a different deployment's
  `SECRETS_ENCRYPTION_KEY`) reads as unreadable, not an error. The partner
  enters their details again.
- The tenant purge deletes the rows (`TENANT_PURGE_ORDER` in
  apps/api/src/scheduler.ts). They also cascade with the partner and the
  tenant.

**Portability.** `PartnerPayoutProfile` is in the export bundle from
schemaVersion 9 with `details` **opened**, because a sealed envelope means
nothing on another deployment. Leaving it out would make every partner
re-enter their bank details after a migration. A JSON import seals them
again under the destination's key. A SQL dump can't encrypt, so it writes
them opened; the API seals each row the first time it reads it, and a sweep
seals every remaining one at startup and hourly
(`sealPlaintextPayoutProfiles`, the `seal-payout-details` job), so none
stays in the clear at rest. Treat an export file as you would your
partners' bank details. See
[data-portability.md](data-portability.md#payout-details).

## Batch files

Flow, on the admin Payouts page ("Manual payouts to send"):

1. **Run payouts** (or let the cadence run them).
2. Pick the run. Under "Ready for a new file", **Make file** for each
   provider and currency. The file downloads at once.
3. Upload it to your own account: PayPal (Send Money → Make a Mass Payment)
   or Wise (Payments → Batch → "Send to bank accounts").
4. Once the batch has gone out, **Mark sent** for that file under "Files
   made". If you never uploaded it, **Discard** it instead. Payouts in no
   file have their own Mark sent button once you've paid them some other
   way, which asks for the payment's reference
   ([Paying one at a time](#paying-one-at-a-time)).

### A file is fixed when it's made

Making a file (`POST /payouts/runs/{runId}/exports`) picks its payouts,
stamps each one with the file's `exportId` (`Payout.metadata.manualExport`)
and builds the CSV from those same rows, in one request. From then on:

- **Mark sent confirms exactly the file's payouts**
  (`POST /payouts/exports/{exportId}/confirm`). A partner who adds payout
  details while you upload doesn't get recorded as paid with that file.
- **A stamped payout is in no other file.** If a partner in an uploaded
  PayPal file switches to a bank account before you mark it sent, they don't
  turn up in a Wise file as well. The batch page flags it ("Payout details
  changed since this file was made", `changedCount`).
- **There are no live parts.** Each new file takes the next payouts no file
  holds, in id order, up to 5,000 (PayPal) or 1,000 (Wise). A partner who
  adds details later can't push an already-exported payout into the next
  file.
- **Download again** (`GET /payouts/exports/{exportId}.csv`) rebuilds the
  file's unconfirmed payouts with the partners' current details. A payout
  whose details no longer fit the file, or that is now on a do-not-pay hold,
  is left out. Don't upload it if the first copy went through: mark the file
  sent instead.
- **Discard** (`POST /payouts/exports/{exportId}/discard`) releases the
  file's unconfirmed payouts for a new file. It's only for a file that never
  went out.

PayPal also warns when the same file is uploaded twice within 30 days.
Confirming stays the brand's call: only the brand knows whether its upload
went through.

### Why a payout is in no file

| `excluded` | Meaning |
|---|---|
| `no_payout_details` | the partner hasn't given any |
| `details_unreadable` | sealed under another deployment's key |
| `pay_individually` | UPI or `other`: pay it yourself, then mark it sent |
| `currency_not_supported` | PayPal can't send the payout currency (INR, for one); Wise can't send from it, or can't pay the account's currency yet (INR) |
| `details_incomplete` | Wise needs the holder's address for a payout sent in USD or AUD, and the bank details have none |
| `country_not_supported` | OpenPartner Cloud: the partner's declared country, or the account's or address's country, is on the country list ([country-access.md](country-access.md)) |
| `screening_confirmed` | OpenPartner Cloud: an operator confirmed a sanctions-list match ([sanctions-screening.md](sanctions-screening.md)) |

**Do not pay.** The last two are `doNotPay` on the payout. They are in no
file, the page offers no Mark sent for them, and **every confirm path
refuses them** with `409 not_confirmable` and a `reason`: the single
`POST /payouts/{id}/confirm`, bulk `POST /payouts/confirm`, and a file's
confirm, which reports them and confirms the rest. A hold that appears after
a file was made counts too (`doNotPayCount` on the file). A partner whose
screening is waiting for review (`screening_review`) or hasn't run yet
(`screening_pending`) stays payable, with `complianceWarning` shown next to
them, as the manual rail has always done: it's the brand's own money, and
pending screening usually clears within the hour. The country list and
screening are hosted-platform controls, so a self-host refuses nothing for
them.

### Paying one at a time

A payout in no file (UPI, `other`, INR to a bank account, no details yet)
is paid however the brand pays it, and confirmed on its own: **Mark sent**
on its row, or `POST /payouts/{id}/confirm`. The confirm can carry the
payment's reference, `{ "reference": "…" }`: the bank's UTR for a NEFT,
RTGS or IMPS transfer, the UPI transaction ID, a cheque number. It's
optional, trimmed, and at most 100 characters on one line. It's kept on the
payout as `Payout.metadata.externalReference`, and the payout's statement
prints it as the **Payment reference** (docs/payout-statements.md). A
payout that is also in a file prints the file's PayPal Customer ID or Wise
payment reference instead, while that still holds.

The reference is fixed once the payout is confirmed: a second confirm is
`409 not_confirmable`. It isn't written to the request log, which keeps no
request bodies (apps/api/src/request-log.ts).

The bulk `POST /payouts/confirm` takes no references, by design. It confirms
many payouts in one call, mostly a file's, and those already print the
file's reference. A payment sent one at a time has a reference of its own,
so it's confirmed with its own call.

### Scale

A run is read in id order, 1,000 payouts at a time, so no query binds more
than 1,000 ids (Postgres caps a statement at 65,535), and only pending manual
payouts are read: the partial index `Payout_tenantId_id_manual_pending_index`
covers them. The run summary reads the run once per view, and the payout list
is paged (`GET /payouts/runs/{runId}/payouts`, 100 a page by default), as is
the run list (`GET /payouts/runs`, 50 a page).

### PayPal Payouts file

Checked 2026-10-19 against
[Payouts Web UI](https://developer.paypal.com/payouts/use-payouts/send-money/use-web-ui)
and [currency codes](https://developer.paypal.com/api/rest/reference/currency-codes/).

- No header row. Ten columns in a fixed order, every row the same width:
  recipient (the PayPal email), amount, currency, Customer ID (the payout id,
  26 characters; the limit is 30, no spaces), note to recipient
  (`Commission payout from {brand}`, 400 max), recipient wallet `PAYPAL`,
  three empty Venmo-only columns (social feed privacy, Holler URL, logo URL),
  purpose `SERVICES` (PayPal's default is `GOODS`; a commission pays for
  marketing).
- One currency per file. Amounts use a decimal comma for EUR and BRL,
  quoted (`"100,50"`), as PayPal's current page says. HUF, JPY and TWD are
  rounded to whole units (PayPal rejects decimals there; a HUF or TWD payout
  can move by under one unit). Everything else uses a point, with no
  thousands separator. **Check the total PayPal shows before you send**: an
  older PayPal page says the decimal separator follows the sender's locale.
- Supported currencies: AUD, BRL, CAD, CNY, CZK, DKK, EUR, HKD, HUF, ILS,
  JPY, MYR, MXN, TWD, NZD, NOK, PHP, PLN, GBP, RUB, SGD, SEK, CHF, THB, USD.
  No INR: since April 2021 Indian PayPal accounts receive international
  payments in USD only. Pay Indian PayPal partners in USD. They need a
  verified PAN and a purpose code on their side.
- 5,000 rows per file. PayPal's default per-item cap is USD 20,000. The
  account needs Payouts enabled by PayPal.

### Wise batch file

Checked 2026-10-19 and 2026-10-20 against Wise's help centre and API docs:
[filling in the template](https://wise.com/help/articles/2663302/how-do-i-fill-in-my-batch-template),
[template options](https://wise.com/help/articles/2942721/what-are-the-different-batch-template-options),
[upload errors](https://wise.com/help/articles/2942777/why-do-i-get-an-error-when-i-upload-my-batch-file),
[exact amounts](https://wise.com/help/articles/5iWcIUdYHyTQMnezSzx4n3/how-do-i-send-exact-amounts-with-batch-payments),
[multiple currencies](https://wise.com/help/articles/2663303/can-i-pay-for-different-currencies-in-a-single-batch),
[send to and from](https://wise.com/help/articles/2571907/what-currencies-can-i-send-to-and-from),
[INR](https://wise.com/help/articles/2932151/guide-to-inr-transfers),
[INR purpose codes](https://wise.com/help/articles/6hAFdOM3eAYMyvnOQ0c1g/inr-purpose-codes),
[recipient create](https://docs.wise.com/api-reference/recipient/recipientcreate).

- A header row, UTF-8 without a BOM, at most 1,000 rows per file.
- One **source** currency per file: the payout currency, what the brand
  pays in. Each row's `targetCurrency` is the partner's account currency, so
  one file can pay into several.
- **Source currencies:** AUD, CAD, CHF, CZK, DKK, EUR, GBP, HKD, HUF, IDR,
  ILS, JPY, MYR, NOK, NZD, PHP, PLN, RON, SEK, SGD, THB, TRY, USD. That is
  Wise's "send to and from" list less three it rules out for a business
  batch:
  - INR: "You can't send INR from a business bank account".
  - BRL: only Brazilian tax residents hold it, and batches aren't available
    to Brazilian businesses.
  - MXN: only Mexican citizens sending from their own Mexican account.

  Wise also limits holding HKD, IDR, ILS, MYR and PHP by where the business
  is. An ineligible brand's upload is refused by Wise, never paid wrongly.
- **No INR targets yet.** Every INR transfer needs a purpose of payment, and
  the file has no column for one until a real template shows how Wise takes
  it.
- **Addresses.** Wise needs the account holder's address when the target is
  USD, PHP, THB or TRY, or the source is USD or AUD, with the state or
  province for an address in the US, Canada or Brazil. The account-currency
  and state rules are checked when the details are saved; the source side
  when the file is made (`details_incomplete`).
- `amountCurrency`: `target` when source and target match, so the partner
  receives exactly what they're owed and Wise's fee is the brand's.
  `source` when they differ, because the payout is denominated in what the
  brand pays; Wise's fee and conversion come out of it.
- `paymentReference`: the payout id's last 10 characters (letters and
  digits). That fits Wise's strictest route (US ACH), and the batch page
  shows it next to each payout. JPY and COP take none.
- `recipientType`: `person` or `institution`.

#### Wise columns

Wise's help centre names `recipientEmail`, `sourceCurrency`,
`targetCurrency`, `amountCurrency` (with values `source` / `target`) and
`recipientType` (a person or an institution). The **bank-detail and address
columns aren't on any public Wise page**: the "Send to bank accounts"
template comes from a builder that needs a Wise login. The file uses the
field names of Wise's recipient API, which the builder's columns follow:

```
name,recipientEmail,paymentReference,recipientType,amountCurrency,amount,sourceCurrency,targetCurrency,IBAN,BIC,accountNumber,sortCode,abartn,accountType,ifscCode,addressCountryCode,addressCity,addressFirstLine,addressPostCode,addressState
```

Wise lets columns be reordered but not renamed, so a wrong header fails the
upload outright rather than paying anyone wrongly. **Before relying on it**,
build one bank-account template in a Wise Business account covering GBP,
EUR, USD and INR. Compare its header row with `WISE_COLUMNS`
(apps/api/src/manual-payout-files.ts) and fix any name there; the test pins
the header. The same template shows how Wise takes the INR **purpose of
payment** a batch row needs, which this file doesn't send yet.

## API

| Operation | Access |
|---|---|
| `GET /partners/{id}/payout-profile` | the partner, an admin, or `payout_profiles:read` / `:write` |
| `PUT /partners/{id}/payout-profile` | the partner, an admin, or `payout_profiles:write` |
| `DELETE /partners/{id}/payout-profile` | the partner, an admin, or `payout_profiles:write` |
| `GET /payouts/runs?cursor=&limit=` | admin |
| `GET /payouts/runs/{runId}` | admin |
| `GET /payouts/runs/{runId}/payouts?cursor=&limit=` | admin |
| `POST /payouts/runs/{runId}/exports` (`{ provider, currency }`) | admin |
| `GET /payouts/exports/{exportId}.csv` | admin |
| `POST /payouts/exports/{exportId}/confirm` | admin |
| `POST /payouts/exports/{exportId}/discard` | admin |
| `POST /payouts/{id}/confirm` (optional `{ reference }`) | admin |
| `POST /payouts/confirm` (`{ payoutIds }`, up to 5,000) | admin |

The files carry full payout details, so every file route is admin-only and
`Cache-Control: no-store`. No confirm fires webhooks: `payout.created` and
`commission.paid` fired when the run wrote the payouts.

Every payout also has a statement, with the details masked: see
docs/payout-statements.md. A payout in a file prints that file's PayPal
Customer ID or Wise payment reference as its reference; a payout paid one
at a time prints the reference given when it was confirmed.

## Not yet

- Sending through the PayPal Payouts API with the brand's own credentials,
  so the brand clicks once instead of uploading. It would keep the same
  money flow.
- Letting a brand choose which methods its partners may pick.
- INR targets in the Wise file, once the purpose of payment has a column
  (see [Wise columns](#wise-columns)).
