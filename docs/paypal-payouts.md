# Pay with PayPal: one-click PayPal payouts from the brand's own account

On the manual rail the brand pays partners itself
([manual-payout-files.md](manual-payout-files.md)). For partners who gave a
PayPal email, the brand can download a PayPal batch file and upload it to
its PayPal account. **Pay with PayPal** does the same thing in one click:
OpenPartner calls PayPal's Payouts API **as the brand's own PayPal app**,
with the client id and secret the brand connected.

The money flow doesn't change. The brand's PayPal balance pays the
partner's PayPal account. OpenPartner never holds, forwards or receives the
money; it makes the API call the brand's own script would make. That is the
same principle as Connect Standard (CLAUDE.md principle 4), and the reason
this uses the brand's credentials rather than a PayPal account of
OpenPartner's.

Code: `apps/api/src/paypal-api.ts` (the PayPal client),
`paypal-connection.ts` (credentials), `paypal-payouts.ts` (batches),
`paypal-send-as.ts` (INR sent in USD), `routes/paypal.ts`,
`routes/paypal-webhook.ts`; portal `pages/admin/PaypalPayoutsCard.tsx`,
`pages/ManualPayoutFiles.tsx` and `pages/payout-sent.tsx`.

## What the brand needs

- A **PayPal Business account with Payouts enabled.** PayPal turns Payouts
  on per account: the brand requests access on PayPal's Payouts page. Until
  then PayPal refuses every batch.
- A **REST app** in the PayPal developer dashboard (Apps & Credentials):
  one under Live, and one under Sandbox to test with if it wants.
- Partners whose payout details are a **PayPal email**
  ([manual-payout-files.md](manual-payout-files.md#payout-details)).
- Enough **balance** in the payout currency in its PayPal account.

## Connecting (Settings → Pay with PayPal)

The admin pastes the app's client id and secret for one environment.

- **Verified first.** A client-credentials token call proves the pair
  works in that environment before anything is stored. A refused pair
  answers `422 credentials_refused` and nothing is saved. The token's
  scopes say whether PayPal has given the app Payouts (`payoutsEnabled`);
  if not, the card says so.
- **Sealed.** The secret, the cached access token and the webhook id are
  AES-256-GCM envelopes under `SECRETS_ENCRYPTION_KEY`
  (`apps/api/src/crypto.ts`), the same envelope as SMTP passwords and
  payout details. The client id stays in the clear (it is PayPal's public
  app identifier) and is shown as its first 6 and last 4 characters.
- **Never shown, logged or exported.** The secret is accepted once, on
  connect. No response, export, log line or error carries it, or the token,
  or the webhook id (see [Portability](#portability-and-credentials)).
- **One environment sends.** Live and sandbox can both be connected. The
  first one connected is the one Pay with PayPal sends with; switching is
  the admin's explicit choice ("Send from live"), never automatic, so a
  sandbox setup can't quietly turn into live payments.
- **Sandbox sends are rehearsals.** PayPal's sandbox moves test money, so a
  sandbox batch never marks a payout paid. It runs the real flow (the same
  payouts, PayPal's real sandbox API, statuses, alerts), and once PayPal
  has settled every item the outcome is kept on the batch (`rehearsal`:
  paid, unclaimed, failed) and every payout goes back to send. A sandbox
  batch can also be released at any time. The button reads **Test with
  PayPal sandbox** and asks first in those words.
- **Webhook.** On connect, OpenPartner registers a webhook on the brand's
  app for the Payouts events (`PAYMENT.PAYOUTSBATCH.*`,
  `PAYMENT.PAYOUTS-ITEM.*`) at
  `${PORTAL_URL}/api/webhooks/paypal/<connection id>`. PayPal only posts to
  public https addresses, so a deployment whose `PORTAL_URL` is local or
  plain http registers none, and batches are polled instead. If the app
  already has PayPal's maximum of 10 webhooks, the card says so.
- **In-flight batches pin their app.** A batch's status can only be read
  with the app that sent it. So disconnecting, or connecting a different
  app for the same environment, is refused (`409 open_batches`) while a
  batch sent with the current one is in flight. A new secret for the
  **same** app (a rotation) is accepted and takes every batch over,
  finished ones included (a paid item can still be refunded).
- **Disconnect** removes OpenPartner's webhook from the app (best effort)
  and wipes the secret, token and webhook id. The row stays as history.
  It is never blocked by finished batches (a brand whose secret leaked
  must be able to cut it at once), but it stops the daily check of those
  batches for late refunds. Connecting the **same** app again (same PayPal
  app id) picks every batch sent with it back up, finished ones included.

## Sending

On the Payouts page, **Manual payouts to send** lists a run's pending
manual payouts (the section is always there, with a short explanation, even
before the first run). Under **Ready to send**, a PayPal group shows **Pay
with PayPal** next to **Make file** once an app is connected. The button
asks first, naming the number of payouts, the total and the environment.

A batch takes exactly the payouts a PayPal file would
([manual-payout-files.md](manual-payout-files.md#why-a-payout-is-in-no-file)):

- the partner's details are a PayPal email that can be read;
- the currency is one PayPal sends (the file's list: no INR), or, with
  [INR in USD](#balances-paypal-cant-send-inr) turned on, INR sent in USD
  at a quoted rate;
- the amount is within PayPal's per-payment limit for that currency
  (`over_paypal_limit` otherwise; USD 60,000, EUR 55,000, GBP 50,000…, the
  "Payout transaction limits" table on developer.paypal.com/payouts/fees,
  checked 2026-10-22). A recipient **without** a PayPal account can receive
  about a third of that; PayPal refuses a larger item for them and returns
  the money, and the batch releases it. The same limit now applies to
  PayPal files;
- nothing on a do-not-pay hold (OpenPartner Cloud: a blocked country or a
  confirmed sanctions match);
- no file or other batch holds it;
- up to 5,000 per batch, in id order. A run with more is sent in several
  batches.

Each item is `recipient_type: EMAIL`, the partner's email, the amount
(whole units for HUF, JPY and TWD, two decimals otherwise, as the file
rounds), `sender_item_id` = the payout id, the note "Commission payout from
{brand}", `recipient_wallet: PAYPAL` and `purpose: SERVICES`.

## At most once

Every send mirrors the care `payout-transfers.ts` takes with Stripe.

1. **The intent commits first.** One transaction stamps the payouts
   (`Payout.metadata.manualExport` with `via: "api"`, compare-and-set, so a
   payout is in exactly one file or batch) and writes a `PaypalPayoutBatch`
   row holding the request body, frozen and sealed (it contains partners'
   emails). Only after COMMIT does anything call PayPal, outside any
   transaction.
2. **One id, three uses.** The batch id is the payouts' export id, PayPal's
   `sender_batch_id` and the `PayPal-Request-Id`, and a re-send sends the
   same bytes. PayPal "completes a payment only once for a sender_batch_id
   that is used within 30 days" and answers a repeated request id with the
   batch it already made. A duplicate sender_batch_id comes back as an
   error linking the original batch, which is read back and adopted only if
   its sender_batch_id is ours.
3. **Unknown means unknown.** A timeout, a reset, a 5xx, a 429, a 409, or a
   2xx whose body can't be read may have created the batch. It stays
   `posted`, and the next pass (every 5 minutes, or **Check status**)
   re-sends it, which can only reach the same batch. Nothing is released on
   an unknown outcome.
4. **Never past the window.** A `posted` batch is re-sent only within 29
   days of its first send (a day's margin on PayPal's 30). Past that a
   re-send could create a second batch, so it is held for the admin
   (`reconcile_required`).
5. **A refusal frees payouts only when nothing could have landed.** From
   `intent` (no request so far could have created the batch), a definite
   refusal (`INSUFFICIENT_FUNDS`, `VALIDATION_ERROR`, a refused secret…)
   fails the batch and releases its payouts. From `posted` the same refusal
   is held instead, because an earlier attempt may have gone through. A 401
   (a stale token) is retried with a fresh one.
6. **Lease.** Every post or sync takes a compare-and-set lease, so the
   scheduler, a webhook and an admin click never act on one batch at once.
   The batch's state moves before its payouts are released; a crash in
   between is repaired by the next pass, however long ago it was.
7. **Marking sent by hand can't overtake a batch.** The confirm decides on
   the payout row as it updates it: a batch that stamped the payout after
   the confirm read it (or is stamping it at that moment) wins.

| State | Meaning |
|---|---|
| `intent` | Committed, not sent yet (or only refused before PayPal authenticated it). |
| `posted` | Sent; PayPal's answer isn't in yet. Re-sent automatically. |
| `submitted` | PayPal has it and is paying. |
| `completed` | Every payout paid or released. |
| `failed` | Refused outright before anything was made; payouts released. |
| `denied` | PayPal denied or cancelled the whole batch; payouts released. |
| `released` | The admin released it after checking PayPal. |
| `reconcile_required` | OpenPartner can't tell whether it went out. The admin decides. |

## Status

PayPal pays a batch in the background. Two things prompt OpenPartner to
read it back: the webhook (when registered) and a poll every few minutes
(2 minutes for the first hour, then 15, then hourly; every 6 hours once
only unclaimed items are left). A finished live batch with paid items is
still read once a day for 90 days, so a later refund or reversal is caught
even without webhooks; a read that fails is retried daily within those 90
days, and not at all once the app is disconnected. **Nothing acts on a webhook's payload.** A
verified event only names the batch, which is then read back in full from
PayPal and applied to that batch's own payouts, matched by
`sender_item_id`, in that brand's workspace only.

| PayPal item status | What happens to the payout |
|---|---|
| `SUCCESS` | Confirmed: `paid`, `completedAt` = PayPal's processing time, PayPal's item and transaction ids on its stamp. |
| `PENDING`, `ONHOLD` | Waits. |
| `UNCLAIMED` | Waits, and the admins are emailed. PayPal emailed the partner (no PayPal account at that email yet), who has 30 days to claim it. The money has already left the brand's balance, so the payout is **not** released: paying it again could pay the partner twice. The admin can **Cancel and get it back** (PayPal returns it now, then the payout is released), or wait for PayPal to return it after 30 days. |
| `FAILED`, `RETURNED`, `BLOCKED`, `REFUNDED`, `REVERSED`, or a `DENIED`/`CANCELED` batch | Released: back to pending with no stamp, free for a new file or batch, and the admins are emailed. The history is kept in `Payout.metadata.paypalReleases`. A payout already paid whose item is later refunded or reversed goes back to pending the same way: the money is back with the brand and the partner is owed again. |

**Alerts** go to the brand's active admins by email: items that failed,
were returned or are unclaimed (partner name, amount, PayPal's error
name, never the partner's email), a batch that wasn't sent, and a batch
held for review.

**Marking sent by hand is refused** for a payout in a batch that is still
open (`409 not_confirmable`, `reason: "in_paypal_batch"`), and the file
routes (download again, confirm, discard) can't reach an API batch:
PayPal's answer decides.

## When OpenPartner can't tell

A `reconcile_required` batch keeps its payouts out of every file and batch
until the admin settles it, after looking in the PayPal account
(Activity, a payout batch with the batch id as its sender batch id):

- **Link PayPal batch**: the admin pastes PayPal's payout batch id. It is
  read back and adopted only if its sender_batch_id is this batch's id;
  then it is followed like any other.
- **Try again**: re-send the same request. Only within 29 days of the first
  send, while PayPal still refuses a duplicate.
- **Release**: no such batch went out. The payouts go back to pending.
  This is the admin's word, recorded as `resolution: released`. A batch
  still in `intent` can be released the same way.

## Portability and credentials

- `PaypalConnection` is credentials for one deployment, like
  `TenantStripeConnection`: never exported, in any format.
- `PaypalPayoutBatch` is delivery state for those credentials, like
  `WebhookDelivery`: not exported either. Everything worth keeping is on the
  payouts, which are exported: `manualExport` (`via: "api"`,
  `payoutBatchId`, `paypal.itemId`, `paypal.transactionId`,
  `paypal.status`, and `conversion` for INR sent in USD) and
  `paypalReleases`.
- The INR-in-USD setting is the `paypal_payouts` Config key, exported
  with the brand's other settings.
- A bundle restored onto another deployment carries payouts stamped with a
  batch that doesn't exist there. PayPal may still pay that batch, so those
  payouts are never released: they stay out of files and new batches, and
  once checked in PayPal they can be marked sent (`POST /payouts/confirm`);
  one PayPal didn't pay is paid another way and then marked sent. Settle
  every batch before you migrate to avoid this.
- The tenant purge deletes both tables (`TENANT_PURGE_ORDER`).

See [data-portability.md](data-portability.md#credentials).

## Balances PayPal can't send (INR)

PayPal can't send INR: it isn't a PayPal API currency (developer.paypal.com
currency codes, checked 2026-10-23). Indian PayPal accounts take
international payments in the sender's currency, and PayPal converts them
to INR on the way to the partner's Indian bank (a daily sweep under Indian
rules). A payout's currency is its commissions' currency, so an INR program's payouts are
`currency_not_supported` for PayPal files and batches, unless the brand
turns on **Pay INR balances with PayPal in USD** (Settings → Pay with
PayPal; `POST /config/paypal-payouts` `{"sendUnsupportedAs": "USD"}`; the
`paypal_payouts` Config key, off by default). Code:
`apps/api/src/paypal-send-as.ts` and `quotePaypalConversion` /
`sendRunWithPaypal` in `paypal-payouts.ts`.

With it on:

- **Ready, for PayPal only.** An INR payout whose partner gave a PayPal
  email is ready for a PayPal batch "INR → USD" (`ready[].sendAs` and
  `sendAs` on the run's payouts). No file takes it: a file would need the
  rate too, and the brand's PayPal would then convert it again.
- **Quote first.** **Pay with PayPal in USD** asks for a quote
  (`POST /payouts/runs/{runId}/paypal-batches/quote`
  `{"currency": "INR", "sendAs": "USD"}`): the European Central Bank
  reference rate (`fx.ts`, the same feed as the usage meter, crossed
  through EUR), its date, each payout's USD amount, the INR and USD totals,
  and a signed `quoteId` valid for 15 minutes. Nothing is held.
- **Rounded per payout.** Each payout's USD amount is its INR amount × the
  rate, rounded half up to the cent on its own (integer arithmetic on the
  12-decimal rate, so the same inputs always give the same cents). The USD
  total is the sum of those, which can differ by a few cents from the INR
  total × the rate. PayPal's per-payment limit (USD 60,000) applies to the
  USD amount; a payout over it, or under a cent, is listed in `leftOut`
  and stays out of the batch (when that's all of them, the quote is
  `404 nothing_to_send` with the `leftOut` list and why). The run still
  shows those payouts as ready, since only a rate says whether they fit.
- **Confirm, then send at that rate.** The confirm names both totals, the
  full rate (every digit the amounts are computed from) and its date, and
  says whose the later conversion to INR is. The
  send (`POST …/paypal-batches` `{"currency": "INR", "sendAs": "USD",
  `"quoteId": "…"}`) freezes exactly the quoted rate into the batch and
  each payout, and sends exactly the quoted payouts. The stamp itself
  re-checks each payout's amount and release count, and the expiry is
  checked again just before the batch is committed. Refused, with nothing
  stamped: an expired quote (`409 quote_expired`), one whose payouts or
  amounts or PayPal accounts changed since (`409 quote_changed`: another
  batch took one, a partner changed their PayPal email, PayPal gave one
  back), one made for a
  PayPal app that is no longer the active one (also `quote_changed`, so a
  sandbox test the brand confirmed never goes out from live; the quote
  says which, `environment`), a forged or other run's quote
  (`400 invalid_quote`), or the setting turned off in between
  (`409 conversion_not_enabled`). Quote again. A quote can't be spent
  twice: its payouts are stamped by the first send.
- **Fails closed.** If the ECB feed can't be read, or has no INR rate,
  there is no quote (`503 fx_unavailable`). No rate is ever guessed, and a
  send never reads the feed: the quote's rate is the rate.
- **The ledger stays INR.** `Payout.amount` and `currency` don't change,
  so commissions, clawback netting and reporting are unchanged. The batch
  is in USD (`currency`, `total`) with `conversion` (`sourceCurrency`,
  `sourceTotal`, `rate`, `rateSource: "ecb"`, `rateDate`, `quotedAt`).
  Each payout's stamp records its own (`manualExport.conversion`:
  `sourceAmount`, `sourceCurrency`, `sentAmount`, `sentCurrency`, `rate`,
  `rateSource`, `rateDate`), which travels in exports. The PayPal item's
  note says the same: "INR 1,500.00, sent as USD 17.94 at the ECB
  reference rate of 22 Oct 2026".
- **The partner sees both.** `GET /partners/{id}/payouts` and
  `GET /payouts` add `sent` (`amount`, `currency`, `rate`, `rateSource`,
  `rateDate`), and the partner's Payouts page reads "₹1,500.00, sent as
  $17.94 at the ECB rate of 22 Oct".
- **Returned money is re-quoted.** A converted payout PayPal fails,
  returns, refunds or reverses goes back to pending like any other, its
  conversion kept in `metadata.paypalReleases`. Its next send takes a fresh
  quote at the day's rate: a quote made before the release no longer
  matches (`quote_changed`).
- **Sandbox** batches are rehearsals as before: converted payouts come
  back to send, never paid.

**Whose conversion is whose.** The brand pays the ECB mid-market amount in
USD from its PayPal balance (PayPal charges the brand its usual Payouts
fee, and a currency-conversion fee if the brand's balance isn't in USD).
PayPal then converts the USD to INR for the partner's Indian bank at its
own rate; that is between the partner and PayPal, and every place that
shows a converted amount says so. Indian PayPal recipients may also
need a verified PAN and a purpose code on their side to receive.

Other currencies PayPal can't send are not converted:
`PAYPAL_CONVERTIBLE_CURRENCIES` lists INR only. Add one only after
checking that PayPal really can't send it, how its recipients' accounts
receive, and that the ECB publishes it. Without the setting, an INR
program pays partners who give a UPI ID or bank details from its own bank
and marks them sent (`pay_individually`); the Wise file can't help yet
(Wise doesn't send from INR, and INR targets need a purpose-of-payment
column the file doesn't have).

## API

All admin-only (no scope grants them); see `/docs` for the schemas.

| Operation | What it does |
|---|---|
| `GET /config/paypal` | the connected apps, live and/or sandbox |
| `POST /config/paypal` (`{ environment, clientId, clientSecret }`) | connect or replace one environment's app |
| `POST /config/paypal/{environment}/verify` | a fresh token call |
| `POST /config/paypal/{environment}/activate` | send with this environment |
| `DELETE /config/paypal/{environment}` | disconnect |
| `POST /payouts/runs/{runId}/paypal-batches` (`{ currency }`, or `{ currency, sendAs, quoteId }`) | send the next batch of a run |
| `POST /payouts/runs/{runId}/paypal-batches/quote` (`{ currency: "INR", sendAs: "USD" }`) | quote sending INR balances in USD |
| `GET /config/paypal-payouts`, `POST /config/paypal-payouts` (`{ sendUnsupportedAs: "USD" \| null }`) | INR in USD on or off |
| `GET /payouts/runs/{runId}/paypal-batches` | a run's batches |
| `GET /payouts/paypal-batches/{batchId}` | one batch |
| `POST /payouts/paypal-batches/{batchId}/sync` | read it from PayPal now |
| `POST /payouts/paypal-batches/{batchId}/resolve` (`{ action: retry \| release \| link, payoutBatchId? }`) | settle a held batch |
| `POST /payouts/{id}/paypal-cancel` | cancel an unclaimed item |
| `POST /webhooks/paypal/{connectionId}` | PayPal's webhook (public, verified by PayPal) |

## Running it

- **Scheduler.** Retries of `posted` batches and the status poll run in the
  `paypal-payouts` job (every 5 minutes), so they need
  `OPENPARTNER_ENABLE_SCHEDULER=1` ([deploy.md](deploy.md)). Without it, a
  batch only moves when an admin clicks **Check status** or a webhook
  arrives.
- **Webhooks** need `PORTAL_URL` to be the deployment's public https
  address, with the ingress forwarding `/api/webhooks/paypal/*` to the API
  (as for `/api/webhooks/stripe-app`). The route is rate-limited per IP and
  never fetches PayPal's certificate URL itself: PayPal's
  `verify-webhook-signature` checks the signature against the webhook id
  OpenPartner registered.
- **No new environment variables.** Credentials live in the database,
  entered in Settings.
- **Rollback.** The migration only adds two tables, but a build from before
  this one reads an API batch's stamp as a PayPal **file**: its Payouts page
  would offer "Download again" (a CSV of payouts PayPal may already have
  paid), "Mark sent" and "Discard" for it. Roll back only with no batch in
  flight (every batch `completed`, `failed`, `denied` or `released`), or
  tell admins not to touch those rows until they're settled in PayPal.

## Testing in the PayPal sandbox

The automated tests run against a fake PayPal
(`apps/api/src/__tests__/fake-paypal.ts`). To check against PayPal's real
sandbox:

1. Sign in at developer.paypal.com. Under **Testing Tools → Sandbox
   Accounts** there is a sandbox Business account (the brand) and a
   Personal account (a partner). Note the Personal account's email.
2. Under **Apps & Credentials → Sandbox**, create a REST app on the
   Business account. In the app's features, make sure **Payouts** is on.
   Copy its client id and secret.
3. On a staging deployment (https, so the webhook registers) or locally
   (polled), open **Settings → Pay with PayPal → Connect sandbox app** and
   paste them. Expect "Pay with PayPal sends from here" and no Payouts
   warning. On staging, the app's Webhooks list in the PayPal dashboard now
   shows `…/api/webhooks/paypal/<id>`.
4. Create a partner whose payout details are the sandbox Personal email,
   give them an approved commission in USD, set the payout rail to manual
   (or leave them without Stripe Connect) and **Run payouts**.
5. On **Payouts**, press **Test with PayPal sandbox**. The batch shows
   "PayPal is paying". Within a few minutes (or after **Check status**) the
   item reads paid, the sandbox Personal account (sandbox.paypal.com) shows
   the payment, and, once every item is settled, the batch reads "Sandbox
   test: 1 paid…" and the payout is back to send, **not** marked paid.
6. Unclaimed: a second partner with an email that has no sandbox account.
   Expect "Unclaimed" and an admin email. (In sandbox the batch settles and
   releases it; on live it waits, and **Cancel and get it back** releases
   it.)
7. Refusal: send more than the sandbox Business balance. Expect the batch
   to fail (or its item to fail), the payouts to come back to send, and an
   admin email naming PayPal's error.
8. To see paid payouts recorded, repeat with a small **live** batch to an
   account you control, after switching to the live app.
9. Webhook (staging): in the dashboard's webhook simulator, send a
   `PAYMENT.PAYOUTSBATCH.SUCCESS` to the registered URL. Expect `200`. A
   request with a changed body must answer `400 invalid_signature`.
10. Check `GET /export.json` contains no `PaypalConnection` and not the
    secret, and that the secret appears nowhere in the API logs.
11. INR in USD: turn on **Pay INR balances with PayPal in USD**, give a
    partner an approved INR commission and the sandbox Personal email,
    **Run payouts**. The group reads "PayPal · INR → USD". Press **Test
    with PayPal sandbox in USD**: the confirm shows the ECB rate and date
    and both totals (compare with the ECB's own page for that date). The
    sandbox Personal account receives the USD amount, with a note naming
    both amounts; the payout comes back to send once settled. Leave a
    quote open for more than 15 minutes before confirming: the send says
    the quote expired.
