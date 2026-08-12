# Hosted Payout Funding — Staging Test Matrix & Rollout Runbook

Operational companion to [`payout-funding.md`](./payout-funding.md) §11. Run this
matrix on staging before flipping `HOSTED_FUNDING_ENABLED=1` anywhere that touches
real money. Every scenario maps to code shipped in builds 1–5 (#47–#51).

## Prerequisites

- Staging deployment with `HOSTED_FUNDING_ENABLED=1`, Stripe **test mode** keys,
  and the webhook endpoint registered for:
  `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`,
  `charge.refunded`, `charge.dispute.created`, `transfer.reversed`, plus the existing
  subscription/Connect events.
- A test tenant on Flex or RevShare with an **active** test subscription
  (funding eligibility requires the HostedBillingState mirror to be
  `active`/`trialing` — subscribe once via test Checkout).
- A test partner with a Connect account where `payouts_enabled=true`
  (use Stripe test-mode Connect onboarding).
- Funding authorization completed in admin → Billing → Commission funding, using
  Stripe's ACH test account (`000123456789` routing `110000000`, instant verification).
- `stripe listen --forward-to <staging>/webhooks/stripe` if staging isn't publicly
  reachable, or Stripe CLI `trigger` for synthetic events.
- Stripe **test clocks** for time-dependent scenarios: create the tenant's Customer
  under a test clock so PI settlement and dunning can be advanced without waiting
  ACH's 4-business-day settlement.

Seed helper: approve ≥ $25 of commissions for the test partner (the batch floor),
then `POST /payouts/run` (or wait for the Monday scheduler tick).

## Matrix

Every row: state before → action → expected state after. Verify in DB
(`HostedFundingBatch`, `HostedFundingAllocation`, `HostedFundingTransfer`,
`StripeWebhookInbox`) and in Stripe dashboard.

### A. Happy path
| # | Scenario | Expected |
|---|---|---|
| A1 | Approved commissions ≥ floor, payout run | Batch `reserved`, allocations `reserved`, commissions stay `approved`, no Payout rows |
| A2 | Collector tick | Batch → `payment_processing`, PI created (`fbpi:<batchId>` key, `us_bank_account`, off-session) |
| A3 | Advance test clock until ACH settles → `payment_intent.succeeded` | Inbox row; batch → `funded` with `stripeChargeId` + `actualStripeFeeMinor` |
| A4 | Executor tick | Transfer intent committed → `transfers.create` with `source_transaction` = funding charge, `transfer_group` = batch id → Payout `paid`, allocations `transferred`, commissions `paid`, batch `settled`; `commission.paid` webhooks fired |
| A5 | Below-floor commissions ($< 25) | No batch (`below_floor`); commissions roll to next run |
| A6 | Second payout run while a batch is open | `open_batch_exists` — no second batch, no double reservation |

### B. Failure + dunning
| # | Scenario | Expected |
|---|---|---|
| B1 | PI fails (test account `000111111113` = insufficient funds) | `payment_intent.payment_failed` → batch `funding_failed` with reason |
| B2 | Collector after backoff (advance clock ~1d) | Retry **confirms the same PI** (`fbpc:<batch>:<attempt>` key), not a new PI |
| B3 | Retries exhausted / 10 days pass | Release protocol: PI canceled first, allocations `released`, batch `released`, commissions selectable again |
| B4 | Payment succeeds while release in flight (cancel races success) | Release LOSES: batch → `funded`, allocations intact, transfer proceeds |
| B5 | Authorization revoked mid-dunning | Retry skips (`authorization revoked` log); timeout releases the batch |

### C. Webhook robustness
| # | Scenario | Expected |
|---|---|---|
| C1 | Redeliver `payment_intent.succeeded` (Stripe CLI resend) | `inbox_replay` — no state change |
| C2 | Deliver `payment_intent.succeeded` with tampered/mismatched amount (edit DB `grossChargeMinor` on a test batch first) | `verification_failed`; batch does NOT fund |
| C3 | `payment_intent.canceled` after our own release | `canceled_noop:released` |
| C4 | Webhook lost entirely (disable endpoint, let PI succeed) | Collector backstop poll confirms funding within 5 min of re-enable |

### D. Transfer-side edge cases
| # | Scenario | Expected |
|---|---|---|
| D1 | Kill the API mid-executor (after intent commit, before Stripe responds) | Intent `posted`; next tick retries the frozen key; no duplicate transfer in Stripe |
| D2 | Ambiguous post older than 24h (set `postedAt` back manually) | Intent → `reconcile_required` → transfer_group listing finds/doesn't find it → `confirmed` or reset to `pending`; **never a blind re-POST** |
| D3 | Partner loses `payouts_enabled` between funding and transfer | Allocation held; deadline alert at 14d; residual disposition path |
| D4 | `transfer.reversed` (partial, then full) | PayoutReversal rows; payout `partially_reversed` → `reversed`; CommissionAdjustment entries on full; commissions stay `paid` |

### E. Interlocks (finding 5)
| # | Scenario | Expected |
|---|---|---|
| E1 | Admin reverses a commission in a `reserved` batch | Allocation `released`, batch principal shrinks, commission `reversed`; batch releases if emptied |
| E2 | Admin reverses while batch `payment_processing` | Allocation `canceled`, charge amount unchanged; batch later settles `settled_with_residual` with `residualMinor` |
| E3 | Admin reverses while allocation `transfer_pending` | 409 `commission_in_transfer`; commission untouched |
| E4 | Merchant refund (`charge.refunded` on the MERCHANT invoice) hits allocated commissions | Same interlock behavior via `reverseCommissionsForInvoice`; held ones surface in the refund event metadata |
| E5 | `charge.refunded` / dispute on the FUNDING charge | Batch → `funding_disputed`, executor stops consuming it, ops alert |

### F. Eligibility gates
| # | Scenario | Expected |
|---|---|---|
| F1 | Tenant subscription → `past_due` (fail a renewal with a test clock) | Service stays up (`hasActivePlan` true) but NO new funding batches |
| F2 | Tenant has a `funding_failed`/`funding_disputed` batch | No new batches until it terminalizes |
| F3 | No funding authorization | Groups stay on the fail-closed guard (`skippedUnfunded`), commissions remain `approved` |
| F4 | Manual rail tenant (`payoutRailPreference=manual`) | Payouts bypass funding entirely; `POST /payouts/:id/confirm` flips pending→paid exactly once (repeat = 409) |

### G. Reconciliation
| # | Scenario | Expected |
|---|---|---|
| G1 | Clean staging ledger, run `funding-reconcile` | Zero violations |
| G2 | Manually corrupt an allocation (delete a row) | Invariant violation alert names the batch |
| G3 | Batch stuck `transferring` past 14d | Stuck alert |
| G4 | Inbox row with `outcome IS NULL` older than 1h | `unfinishedInboxEvents` alert names the event id (replay it from the Stripe dashboard) |

### H. Races (audit #12)

The three scenarios below are the ones that cost real money, and none of
them can be observed by reading the happy path. Each has unit coverage in
`funding-races.test.ts`; staging is where the Stripe half gets proven.

> **Partially run 2026-08-11 against real Stripe test mode — 21 assertions,
> 0 failures.** `apps/api/scripts/staging-funding-races.ts` automates
> **H1, H5, H6, H7, H8, H9** (and H11 incidentally — see below).
> **H2, H3, H4, H10, H12 have NOT been run.**
>
> ```bash
> cd apps/api
> set -a && . ../../.env && set +a
> export HOSTED_FUNDING_ENABLED=1 OPENPARTNER_TENANCY=single
> export STAGING_CUSTOMER=cus_... STAGING_PM=pm_... STAGING_PARTNER_ACCT=acct_...
> pnpm exec tsx scripts/staging-funding-races.ts
> ```
>
> The script header documents the one-off Stripe fixture setup (customer +
> verified `us_bank_account` PM + mandate via SetupIntent microdeposits with
> test amounts `32`/`45`).
>
> What the real API taught us that the mocks could not:
>
> - **H1 is sound.** The PI really was created, the response really was lost,
>   the batch went `funding_failed` unstamped, and the retry **adopted the
>   existing intent** — `create` was never called a second time (asserted by
>   counting calls on a wrapped client). Exactly one PI existed throughout.
> - **`paymentIntents.search` is eventually consistent.** The adoption path in
>   H1/H5 depends on it, and a PI is not findable the instant it is created —
>   the script polls up to 120s for the index to catch up. A retry that fires
>   inside that window will not find the intent by search. This is a real
>   property of Stripe, not of our code, and it is the argument for the
>   frozen idempotency key remaining the *first* line of defence: inside 24h
>   the key saves us, and search is the fallback past it.
> - **H5 and H11 are the same race resolved two ways**, and both were observed
>   across runs. When the release reached the PI first it was `canceled`, then
>   allocations were freed. When test-mode ACH settled first the payment won,
>   and the batch went to transfer with `stripeChargeId` and `fundedAt`
>   stamped rather than bare-CAS'd to `funded`.
> - **H6 holds.** With `search` throwing, release returned `pi_not_terminal`,
>   left every allocation `reserved`, and parked the batch `release_requested`
>   for the collector to resume. "Don't know" did not free anything.
>
> Note that test-mode ACH settles far faster than the ~4 business days of the
> real rail, which is why H2/H4/H10 (all time- or interleaving-dependent) still
> want either test clocks or a genuine two-process run.

| # | Scenario | How to force it | Expected |
|---|---|---|---|
| H1 | **Ambiguous PI create.** Response lost after Stripe made the intent | Point the API at a proxy that drops the response to `POST /v1/payment_intents`; let the collector run | Batch `funding_failed`, no PI stamped. Then: set `updatedAt` back a day so the retry is due, restore the proxy. The retry must **search** and adopt the existing PI — `create` must NOT be called again, and **Stripe must show exactly one PaymentIntent for the batch** |
| H2 | Same, but past the idempotency window | As H1, then advance the test clock >24h before the retry | Still one PI. (Inside 24h the frozen key would have saved us; past it, only the search does) |
| H3 | **Create that fails with an intent** (declined bank account) | Use a test account that declines | Batch `funding_failed` **with `stripePaymentIntentId` stamped**; the next retry CONFIRMS that intent (`fbpc:` key), never creates a second |
| H4 | **Release vs in-flight create.** Batch released while a PI creation is in flight | Add a breakpoint/sleep inside the create call (or use a slow proxy), and trigger a release from another process while it hangs | The PI is **canceled** and never stamped on the released batch. If Stripe refuses to cancel (already `processing`), batch → `recovery_required` with `failureReason=orphan_payment_intent:<pi>` and an ALERT |
| H5 | **Release with an unstamped PI at Stripe** | Blank `stripePaymentIntentId` on a batch that has a real PI, then run a release | Release searches, finds it, terminalizes it, and only then frees allocations. Allocations must NOT be `released` while the PI lives |
| H6 | Same, but Stripe search is down | Block `/v1/payment_intents/search` | Release returns `pi_not_terminal` and **leaves allocations reserved** — never frees on "I don't know" |
| H7 | **Webhook crash mid-handler** | Kill the API between the inbox claim and the handler finishing (breakpoint, then SIGKILL) | The inbox row exists with `outcome IS NULL`. Stripe's redelivery (after the 5-minute lease) must **process it**, not `inbox_replay` it. Before this fix the event was lost forever |
| H8 | Concurrent delivery of the same event | Fire two deliveries at once (Stripe CLI `resend` twice) | One processes; the other gets **409 `event_in_flight`** — NOT a 2xx — so Stripe redelivers rather than considering it done. Exactly one state transition |
| H9 | **Crash + redelivery inside the lease** | As H7, but replay from the dashboard within 5 minutes | The redelivery is refused with 409 (the lease is still held), and the delivery *after* the lease expires takes over and processes it. A 2xx here was the residual hole in the first version of this fix: it ended delivery for an event nobody had processed |
| H10 | **Release stopped halfway** | Block `/v1/payment_intents/search` and trigger a timeout release | Batch sits `release_requested` with allocations still `reserved`; the **next collector tick resumes it** once Stripe is reachable. A batch still `release_requested` a day later is alerted by the daily reconcile |
| H11 | **Payment wins the release** | Let the PI succeed while a release is in flight | Batch → `funded` **with `stripeChargeId` and `fundedAt` stamped** (it goes through the verified confirm path). A bare CAS left the charge id null and the executor froze it as `recovery_required` on the next tick |
| H12 | **Batch frozen mid-transfer** | While the executor is working through a multi-partner batch, fire `charge.refunded` on the funding charge | The executor re-reads the batch status before each partner and **stops**; no further transfers leave the frozen batch |

## Known gaps at launch (accept knowingly, or close first)

Found by adversarial review and deliberately NOT auto-resolved, because
the safe automatic behaviour would be worse than the manual one:

- **No operator recovery transition.** A batch frozen `funding_disputed`
  or `recovery_required` — including one frozen from `reserved` or
  `invoicing` by an out-of-order clawback — keeps its allocations, and the
  live-allocation index stops those commissions being re-reserved. That is
  the SAFE default (releasing could permit a second debit against a charge
  we can't prove absent), but it means the partner isn't paid until a
  human acts, and the only tool today is SQL. A supported
  "dispose of this batch" endpoint is the gap to close.
- **Commission↔Allocation lock-order cycle (pre-existing).** The executor
  locks Commission then updates Allocation; the reversal interlock updates
  Allocation then Commission. Postgres aborts one side, so the symptom is
  a retried webhook or a delayed executor tick, not corruption — but it
  will show up in logs under load.
- **A batch frozen while `reserved` is a correlation failure, not a
  normal clawback**: a funding charge shouldn't exist before the collector
  moves the batch to `invoicing`. Treat one as a signal that a PI was
  created without its batch being advanced, and verify against Stripe
  before disposing of it.

## Rollout order (founder-approved)

1. Staging matrix above passes end to end.
2. **Counsel review** of the funding terms + custodial questions (spec §11) —
   gates the production flag only; nothing else waits on it.
3. Production: set `HOSTED_FUNDING_ENABLED=1`; xispark stays on the **manual rail**
   until their (GBP/Bacs) rail ships — first funded tenant should be a US/USD brand.
4. Two supervised production funding cycles with daily reconciliation reviewed.
5. Remove `OPENPARTNER_ALLOW_UNFUNDED_CONNECT_PAYOUTS` escape hatch + collapse the
   #44 guard into the funding router (guard becomes unreachable).

## Quick reference

- Flag: `HOSTED_FUNDING_ENABLED=1` (API service). The ONLY funding env var.
- Jobs: `funding-collector` (*/5), `funding-executor` (*/5), `funding-reconcile` (05:30 UTC daily).
- Admin surface: Billing → Commission funding (authorize / revoke / batch history).

**Invariants worth re-reading before touching this pipeline** (each one is a
race that was found in review, not a hypothetical):

- A PaymentIntent is never created for a batch that has attempted one until
  Stripe has been **asked** whether one exists. "No id on the row" is not
  evidence of "no charge at Stripe".
- Allocations are never freed while a PaymentIntent could be alive —
  including one whose id was never stamped. A failed lookup means *don't
  know*, and *don't know* means *don't free*.
- The PI stamp is status-predicated. Losing that CAS means a release took
  the batch, and the intent we just created must be canceled (or the batch
  frozen for an operator).
- The webhook inbox is a **lease**, not a tombstone: only a stamped outcome
  makes an event terminal, so a crashed handler is retried rather than
  swallowed. "Someone else holds it" is answered with a **409, never a
  2xx** — acknowledging an event nobody has processed ends Stripe's
  redelivery, which is the same loss with extra steps. The claim carries an
  owner token so a resurrected predecessor can't stamp or delete the new
  owner's work.
- Reconciliation is bounded by the **dispute horizon**, not by a page
  number, and it reports the ids of anything the per-run cap left
  unchecked. A cap that silently truncates makes an unchecked batch look
  like a clean one.
- Terms version constant: `FUNDING_TERMS_VERSION` in `apps/api/src/funding/state.ts`.
