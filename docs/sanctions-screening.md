# Sanctions screening and payout holds

**Status:** built (Oct 2026). Hosted multi-tenant only, like
[country access](country-access.md). It does nothing until `CSL_API_KEY`
is set.

## Why

OpenPartner is run by a US company, so it may not pay or serve anyone on
the US sanctions lists, wherever they are. OFAC enforcement is strict
liability: a payment to a listed person is a violation whether or not
anyone knew. OFAC has fined rewards and payout platforms whose controls
missed what their own data showed: Tango Card (2022) and daVinci Payments
(2023) paid out to people in sanctioned jurisdictions. Country rules
([country-access.md](country-access.md)) cover where people are. Listed
people and companies can be based anywhere, so names are screened too.

## What is screened

Names are checked against the US **Consolidated Screening List** (CSL). The
CSL merges the federal government's export and sanctions lists, OFAC's SDN
list among them. The trade.gov search API takes a fuzzy name search.

| Who | Which names | When |
|---|---|---|
| Brand | display name, and the primary admin's name | at signup and add-brand, in the background so signup isn't slower; a brand never screened under its current name is picked up by the hourly sweep (brands from before screening, a signup whose screening failed or ran without a key, a rename) |
| Partner | name | the first time they have approved commissions (hourly sweep, and again right before each payout run), then at most once a day while they still have approved commissions |

An admin whose name is only their mailbox name isn't screened. This is
add-brand's fallback, and "jane" from jane@example.com says nothing about
who they are.

A list entry scoring **85 or more** out of 100 is a *possible match*
(`MATCH_SCORE_THRESHOLD`). An entry the list returns without a score counts
too. That threshold is the conservative end of common practice: it catches
transliterations and typos, at the cost of more false positives for ops to
clear.

The country declared on the subject is stored for the reviewer. It is
never sent as a search filter, because a listed party's address can be
anywhere.

## Review

Possible matches wait for an operator on the ops console's **Screening**
page. A brand's matches also show on its card on the **Brands** page.

- **Clear: not them** needs a note explaining why the listed entry isn't
  them. The note is the compliance record. Clearing releases the partner's
  held payouts on the brand's next run.
- **Confirm match** keeps a partner on hold for good. On a brand it rejects
  the brand through the usual reject flow: suspended, pulled off the
  Network, ops told, and the brand not emailed.

Both are written to the audit log (`screening.cleared`,
`screening.confirmed_match`). Only the latest answer for a subject and name
can be reviewed; an older one answers `409 superseded`.

**Rescreens keep decisions.** When a daily rescreen finds only list entries
an operator already decided on for that subject and name, the new row
inherits the decision (`decisionCarriedFromId`). Any new entry reopens the
review. When an entry leaves the list, the next rescreen comes back clear
and the hold lifts.

## Payout holds

The planner (`runPayouts` in `apps/api/src/payouts.ts`) holds a partner
when any of these is true:

| Reason | When |
|---|---|
| `country_not_supported` | their latest declared country is on the [country-access](country-access.md) list (the list can change after they joined) |
| `screening_confirmed` | an operator confirmed a match |
| `screening_review` | a possible match is waiting for review |
| `screening_pending` | screening is on but hasn't answered for their current name yet: never screened, only errors so far, or renamed since |

The check sits right after the planner resolves the partner's rail, before
anything is claimed, netted or reserved. Both executors check again before
they post (see *Holds that appear after planning* below):

- **Direct Connect and the funded rail:** no intent, no batch reservation,
  no Payout row. The commissions stay `approved` and unclaimed, the group
  is reported in the run's `heldForCompliance`, and the first run after the
  hold lifts pays it. A held partner with an unfinished Connect account
  gets no `failed` row either.
- **Manual rail:** the brand sends the money itself, so the payout is
  written as usual and carries `complianceWarning`.

A screening error doesn't lift a partner who was screened clear before:
the hold looks at the latest answer, and an error isn't one.

Brand admins see held partners on the Payouts page (`GET /payouts/holds`).
Ops see every held partner across brands on the Screening page.

### Holds that appear after planning

A payout can be planned before its partner is held: a daily rescreen or a
newly blocked country can land between planning and the transfer. Direct
intents usually execute within minutes, but a funded batch waits days for
the brand's payment to settle. So both executors check the hold again
before they post a transfer:

- **Direct Connect** (`executePayoutTransfers`,
  [direct-connect-payouts.md](direct-connect-payouts.md)): an intent that
  hasn't been posted fails preflight with `compliance_hold:<reason>`. The
  existing cancel path releases its claims, so the payout is `failed`, the
  intent `canceled`, and the commissions `approved` and unclaimed. That's
  where the planner would have left them, and the next run holds them.
- **Funded batch** (`runTransferExecutor`,
  [payout-funding.md](payout-funding.md)): while nothing for the partner
  has reached Stripe (no transfer intent yet, or one Stripe refused), their
  allocations go to `canceled`. Any intent is closed as `failed` with
  `compliance_hold:<reason>`. That's the existing residual path (§7.4): the
  rest of the batch transfers, the batch settles `settled_with_residual`,
  and `residualMinor` holds the partner's share for an operator to dispose
  of. Ops get one email per executor run listing every stopped partner,
  plus a console ALERT. The commissions stay `approved`. Reservation won't
  take them again until the batch's `residualDisposition` is `refund` or
  `credit_next_batch`. Re-batching earlier would charge the brand twice.
  Don't dispose of a held partner's residual as `manual_payout`, which
  pays them by hand and keeps the commissions out of batches for good.
- **Already posted, on either rail:** the transfer may exist at Stripe, so
  the intent can't be canceled and its commissions stay claimed. But a
  re-POST of the frozen key is the one call that could still create it, so
  none is made while the hold stands. If the hold lifts, the retry resumes
  on the same key. If it doesn't, the key window lapses and the intent
  reconciles by listing, as any ambiguous intent does: a transfer that
  landed is recorded; on the direct rail an empty listing is held for an
  operator, and on the funded rail it re-arms, which the hold check then
  stops.

What the executors can't stop is a transfer already posted: a hold that
appears after the POST is too late. The only unchecked window left is the
moment between an executor's hold check and its POST.

## Records

Every screening is a row in `SanctionsScreening`: subject, brand, the name
sent, the declared country, the result (`clear`, `possible_match`,
`error`, `skipped`), the top matches (list, name, score, entry id,
programs, countries), what triggered it, and the review. The table is:

- append-only, except the one-time review stamp;
- free of foreign keys, so a tenant purge or partner erasure neither
  removes it nor fails on it;
- kept for 10 years (OFAC record retention, 31 CFR 501.601);
- platform-scoped: the app role has no grant, and only the privileged pool
  reads it, even from the planner's tenant transaction;
- never exported ([data-portability.md](data-portability.md)).

## Setup

1. Get a free key at [developer.trade.gov](https://developer.trade.gov):
   subscribe to the Data Services Platform APIs and copy the key from your
   profile.
2. Set `CSL_API_KEY` in the API's environment (a secret, so env rather
   than the ops console).
3. The next hourly sweep (`sanctions-screening` job, :35 past the hour)
   screens every live brand and every payable partner. Expect a backlog of
   possible matches to review on the first day.

Without the key, nothing is screened and nothing is held for screening.
The API logs that once. A brand that signs up meanwhile gets a `skipped`
row, and the sweep screens it once the key is set.

**Turning it on holds partners until they're screened.** From the moment
the key is set, a partner on the Connect or funded rails with no screening
answer is `screening_pending`. The payouts job screens everyone due before
it plans, so this only bites when the list is unreachable at that moment.
A sweep stops after three errors in a row rather than waiting out every
timeout.

## Not covered yet

- Brands are screened once per name, not re-screened daily like payable
  partners.
- A transfer already posted when the hold appears (see *Holds that appear
  after planning*). It isn't re-posted, but it may already have landed.
- Residual dispositions have no ops-console action yet. An operator
  refunds the residual in Stripe and sets the batch's
  `residualDisposition` by hand, as for any other residual.
- The Network's own creator signup.
- The 85 threshold is a constant, not an ops setting.
