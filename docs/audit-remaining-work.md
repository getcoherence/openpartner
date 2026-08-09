# Payment/subscription audit — remaining work (handoff)

**Status (2026-08-09): all three items are implemented.** #10 → PR #73,
#8 → PR #74, #12 → PR #75. What's left is not code: staging exercises
against Stripe test mode, and the two post-merge prod actions at the
bottom. The original briefs are kept below so the reasoning stays with
the record — read them before touching any of this code.

Everything the Aug 2026 payment/subscription + whole-app audit surfaced is
now covered by PRs #60–#75. Two of these three items move real money;
neither is proven until the staging checklist next to it passes.

---

## Ground truth you need first

- **Repo**: `getcoherence/openpartner`. Node 22 (after #65), TS, Express API,
  Stripe + Stripe Connect **Standard**, PostgreSQL with RLS.
- **Prod is live on the app role** (RLS enforced): DO app `openpartner`
  (`3aa2e624-df1c-4fc9-88bd-c723bdb2713f`), `OPENPARTNER_TENANCY=multi`,
  `OPENPARTNER_MODE=flat`. `doctl` is authenticated; prod run logs:
  `doctl apps logs 3aa2e624-... api --type run` (~36h buffer).
- **Prod migrations do NOT auto-run.** After merging any migration, run
  `pnpm migrate` against prod manually. (None of #73–#75 add one.)
- **Payouts in prod are on the MANUAL rail.** `HOSTED_FUNDING_ENABLED` is OFF
  and there's a fail-closed guard on unfunded hosted Connect payouts. So the
  funding pipeline (`apps/api/src/funding/*`) does not execute in prod today,
  and the direct-Connect transfer path only runs for **self-host** installs (or
  the deliberate `OPENPARTNER_ALLOW_UNFUNDED_CONNECT_PAYOUTS=1` override).
- **Commands**: `pnpm typecheck`, `pnpm lint`, and from `apps/api`
  `pnpm vitest run [file]`. DB-backed tests need `DATABASE_URL` (local docker:
  `docker compose up -d` then `pnpm migrate`). Tests skip themselves when
  `DATABASE_URL` is unset.
- **Branch/PR convention**: one focused branch per fix off `main`, a PR with a
  clear body, tests included.
- The full audit ledger lives in the session memory
  `payment-audit-2026-08` (`.claude/.../memory/project_payment_audit_2026_08.md`).

---

## Item A — #10: direct-Connect transfer fires before DB commit (double-pay)

**SHIPPED — PR #73** (`fix/payout-transfer-intent`). 16 tests, no migration.
Operator doc + staging checklist: `docs/direct-connect-payouts.md`.

**Severity:** HIGH (real money). **Where it bites:** self-host Connect payouts
and the unfunded-hosted override. Not behind the funding flag — this is a
*live* path for self-hosters.

### The bug
`apps/api/src/payouts.ts` (`runPayouts`, the `canTransfer` block) called
`stripe.transfers.create({ ... }, { idempotencyKey: `payout_${payoutId}` })`
**inside the caller's DB transaction**. `payoutId` was a fresh ULID per run.

Two double-pay paths:
1. **Commit fails after the transfer succeeds** → the Payout insert +
   `status='paid'` roll back, the transfer already left Stripe, and the next
   run generates a **new** `payoutId` → **new idempotency key** → duplicate
   transfer.
2. **Ambiguous Stripe error** (network/timeout — the transfer may or may not
   have been created): the catch marked the Payout `failed`, commissions stayed
   `approved`, and the next run retried with a **new** key → duplicate.

### The shortcut that was rejected
Making the idempotency key deterministic over the commission set (e.g.
`hash(sorted(commissionIds))`) is **fragile**: if any commission gets approved
for that partner **between** the failed attempt and the retry, the set changes
→ new key → a second transfer for the larger amount while the first already
paid the overlap → **double-pay of the overlap**.

### What shipped
`payouts.ts` is now a **planner** and `payout-transfers.ts` an **executor**,
mirroring `funding/executor.ts`:
- The Payout row is committed as an intent (`metadata.transferState='intent'`,
  frozen `amountMinor` + destination) before any Stripe call, so
  `payout_<payoutId>` is durable across retries.
- Its commission set is frozen by claiming the rows — `Commission.payoutId`
  stamped while `status` stays `approved`; every planner lookup filters
  `payoutId is null`, so a claimed commission can never be regrouped.
- Transfers post **outside** any transaction, with `transfer_group = payoutId`.
  Ambiguous outcomes stay `posted` (a retry inside 24h replays the frozen key);
  past the window the intent goes `reconcile_required` and is resolved by
  paging `transfers.list({transfer_group})` — never a blind re-POST.
- Definite 4xx fails the payout and releases the claims. A transfer that comes
  back reversed is never recorded paid.
- New `payout-transfers` scheduler job (*/15) retries and reconciles.

### Still to do (not code)
Run the 6-step staging checklist in `docs/direct-connect-payouts.md` against
Stripe **test mode** — injected commit failure, injected timeout, past-window
reconcile, set change, definite failure — before this pays anyone real money.

---

## Item B — rest of #12: funding-pipeline races (flag OFF, pre-launch)

**SHIPPED — PR #75** (`fix/funding-race-hardening`). 19 tests, no migration.
Staging scenarios: section **H** of `docs/payout-funding-staging-runbook.md`.

**Severity:** CRITICAL-when-enabled, but `HOSTED_FUNDING_ENABLED` is OFF, so
latent. The **pagination** subfix shipped earlier (PR #71).

Three races, all in `apps/api/src/funding/`, all now closed:
1. **Ambiguous PaymentIntent creation re-created instead of searching.** After
   Stripe prunes the idempotency key (~24h), the retry could create a **second**
   charge to the brand. Now: once a batch has attempted at all, the retry
   searches by funding-batch metadata and adopts what it finds. A create that
   throws *with* an intent attached (declines) now records that id so the retry
   confirms it instead of making another.
2. **Release-vs-in-flight-create.** Release could claim `invoicing`, see no
   persisted PI, and free allocations while a PI was mid-creation. Now: the PI
   stamp is status-predicated (losing that CAS cancels the orphaned PI, or
   freezes the batch `recovery_required` if Stripe won't cancel it), and release
   asks Stripe before freeing anything — a failed search means *don't know*,
   which means *don't free*.
3. **Inbox claim-before-process.** A crash after the claim made every Stripe
   redelivery a **permanent replay**. The claim is now a lease: only a stamped
   outcome is terminal, an unfinished claim older than 5 minutes can be taken
   over by a redelivery, and one still unfinished after an hour is alerted by
   the daily reconcile.

Also closed in the same pass: refunds/disputes/transfer-reversals had **no
live-Stripe polling backstop**, so a missed webhook left a payout recorded paid
and its batch unfrozen. The daily reconcile now sweeps settled money against
Stripe (bounded, and it logs what it didn't reach).

### Still to do (not code)
The whole funding effort remains gated on the staging matrix + counsel (see
memory `project_payout_funding_gap`). Section H of the runbook is the part
that proves these three races specifically.

---

## Item C — #8: export portability is incomplete (violates the promise)

**SHIPPED — PR #74** (`fix/export-portability`). 11 tests, no migration.
Format contract: `docs/data-portability.md`.

**Severity:** HIGH (product-promise gap), **not** money-risky. CLAUDE.md +
README promise every table exportable to CSV/JSON/SQL with a re-importable
round-trip.

### The gaps
- The exported table list **omitted** `PartnerProgram`, `Coupon`, and
  `PartnerCommission` — so partner↔program grants, coupon attribution, and
  snapshotted commission rules didn't round-trip.
- Routes exposed **JSON/CSV only** — no SQL dump, though the contract
  promises it.
- Import hardcoded the conflict key `id`, but `PartnerCommission`'s primary
  key is **`partnerId`**, so naively adding it would break import.

### What shipped
- All 14 tables with a per-table primary key and an FK-safe import order;
  `schemaVersion` 2, with v1 bundles still accepted.
- `GET /export.sql` + `GET /export/<Table>.sql`. Portable by default: rows are
  written under a psql variable, so
  `psql "$DATABASE_URL" -v tenant_id=default -f openpartner-export.sql`
  restores into any instance. Idempotent (`ON CONFLICT DO NOTHING`), sets
  `app.tenant_id` so it works on the RLS-scoped role too.
- Round-trip test: seed every table → export → wipe → import → compare, once
  through JSON and once through the SQL dump executed against Postgres.
- Two live bugs the round-trip test found: a JS array is ambiguous (`jsonb`
  array vs `text[]`), so **importing any program with compound commission
  rules failed**, and the dump mis-typed `text[]` as jsonb. Both paths now
  read the live column types.

---

## The audit PRs

`#60` cancellation-sync · `#61` coupons/clicks authz · `#62` PartnerProgram RLS
· `#63` auto-approve SQL · `#64` SSRF guard · `#65` Node 22 · `#66` safe-fixes
(enterprise self-assign, delinquent white-label, future-click, upload ENOENT) ·
`#67` partial-refund stopgap · `#68` webhook secret-family binding · `#69`
usage exactly-once · `#70` metering billable-types · `#71` funding reconcile
pagination · `#72` this doc · **`#73` payout transfer intent (#10)** ·
**`#74` export portability (#8)** · **`#75` funding race hardening (#12)**.

**Outstanding post-merge actions:** `#62` → run `pnpm migrate` on prod;
`#63` → run the auto-approve job once and check for the accrued-commission
backlog it was failing to clear.
