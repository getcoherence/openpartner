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
- Terms version constant: `FUNDING_TERMS_VERSION` in `apps/api/src/funding/state.ts`.
