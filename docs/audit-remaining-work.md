# Payment/subscription audit — remaining work (handoff)

This is a self-contained handoff for the **three items left** from the Aug 2026
payment/subscription + whole-app audit. Everything else the audit surfaced has
shipped as PRs #60–#71 (see the list at the bottom). The remaining three were
deliberately **not** rushed because they are money-path reworks or a
data-format design that deserve a focused, staged effort.

Read this top to bottom before touching code. All three are real (verified
twice by adversarial Codex review). Two of them move real money — treat them
accordingly.

---

## Ground truth you need first

- **Repo**: `getcoherence/openpartner`. Node 22 (after #65), TS, Express API,
  Stripe + Stripe Connect **Standard**, PostgreSQL with RLS.
- **Prod is live on the app role** (RLS enforced): DO app `openpartner`
  (`3aa2e624-df1c-4fc9-88bd-c723bdb2713f`), `OPENPARTNER_TENANCY=multi`,
  `OPENPARTNER_MODE=flat`. `doctl` is authenticated; prod run logs:
  `doctl apps logs 3aa2e624-... api --type run` (~36h buffer).
- **Prod migrations do NOT auto-run.** After merging any migration, run
  `pnpm migrate` against prod manually.
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
  clear body, tests included. End commit messages with
  `Co-Authored-By: Claude <noreply@anthropic.com>`.
- The full audit ledger lives in the session memory
  `payment-audit-2026-08` (`.claude/.../memory/project_payment_audit_2026_08.md`).

---

## Item A — #10: direct-Connect transfer fires before DB commit (double-pay)

**Severity:** HIGH (real money). **Where it bites:** self-host Connect payouts
and the unfunded-hosted override. Not behind the funding flag — this is a
*live* path for self-hosters.

### The bug
`apps/api/src/payouts.ts` (`runPayouts`, the `canTransfer` block, ~lines
246–297) calls `stripe.transfers.create({ ... }, { idempotencyKey: `payout_${payoutId}` })`
**inside the caller's DB transaction** (callers wrap `runPayouts` in a tenant
transaction — see `apps/api/src/tenancy.ts` `withTenantTransaction` and
`apps/api/src/scheduler.ts`). `payoutId` is a fresh ULID per run.

Two double-pay paths:
1. **Commit fails after the transfer succeeds** → the Payout insert +
   `status='paid'` roll back, the transfer already left Stripe, and the next
   run generates a **new** `payoutId` → **new idempotency key** → duplicate
   transfer.
2. **Ambiguous Stripe error** (network/timeout — the transfer may or may not
   have been created): the catch marks the Payout `failed`, commissions stay
   `approved`, and the next run retries with a **new** key → duplicate.

### Do NOT take the tempting shortcut
Making the idempotency key deterministic over the commission set (e.g.
`hash(sorted(commissionIds))`) is **fragile**: if any commission gets approved
for that partner **between** the failed attempt and the retry, the set changes
→ new key → a second transfer for the larger amount while the first already
paid the overlap → **double-pay of the overlap**. Rejected for that reason.

### The correct fix (mirror the funded path)
`apps/api/src/funding/executor.ts` **already implements exactly the right
pattern** for the funded path — read it first; it's the reference:
- A transfer-intent row is **created and COMMITTED before any Stripe call**,
  carrying a **frozen** idempotency key (`fbt:<intentId>`) and a frozen set of
  allocations.
- Stripe is called **outside** the DB transaction, one short transaction per
  step.
- An ambiguous outcome past Stripe's ~24h key-pruning window is resolved by
  **listing transfers by `transfer_group` + matching our metadata stamp** —
  never a blind re-POST. (This reconcile now paginates — PR #71.)

Apply the same shape to the legacy `payouts.ts` Connect path:
1. In a short committed transaction: create the `Payout` intent
   (`status='pending'`) with its **frozen** `payoutId` and link the exact
   commission set (they're already grouped). Set `transfer_group = payoutId`
   (or a stable id) and stamp `metadata.openpartner_payout_id`.
2. **Outside** that transaction, call `stripe.transfers.create` with
   `idempotencyKey = 'payout_' + payoutId` (now durable because the intent is
   committed and the same payoutId is reused on retry).
3. Before creating, if the intent is being retried, **reconcile**: page
   `stripe.transfers.list({ transfer_group })` for our
   `openpartner_payout_id` stamp; if found, finalize with it instead of
   re-POSTing.
4. Finalize (`status='paid'`, mark commissions `paid`, dispatch events) in a
   separate short transaction. On a definite 4xx, mark `failed`; on an
   ambiguous error, leave the intent for the reconcile path (don't re-POST
   blind).

Restructuring the transaction boundary is the crux — `runPayouts` currently
receives the transaction as its `db`. You'll need to split "create intents"
(inside a txn) from "execute transfers" (outside), like the executor's
`executePartnerTransfer`.

### Tests + staging
- Unit tests with a Stripe mock: commit-fails-after-transfer → retry reconciles
  (no second create); ambiguous error → retry reconciles; definite 4xx →
  failed, commissions stay approved; the set-change scenario → the frozen
  intent prevents a double-pay.
- **Staging**: exercise against Stripe test mode with an injected
  commit-failure and an injected timeout before enabling for any real payout.

---

## Item B — rest of #12: funding-pipeline races (flag OFF, pre-launch)

**Severity:** CRITICAL-when-enabled, but `HOSTED_FUNDING_ENABLED` is OFF, so
latent. The whole funding effort is already gated on a staging matrix + counsel
(see memory `project_payout_funding_gap`). The **pagination** subfix shipped
(PR #71); the rest belong to the holistic funding-hardening pass.

Three remaining races (all in `apps/api/src/funding/`):
1. **Ambiguous PaymentIntent creation re-creates instead of searching**
   (`collect.ts` ~125 create, ~225 the ambiguous→`funding_failed` demotion).
   After Stripe prunes the idempotency key (~24h), the retry can create a
   **second** charge to the brand. Fix: before re-creating, search for an
   existing PI by our funding-batch metadata (the executor's
   reconcile-by-listing is the model), like the transfer path does.
2. **Release-vs-in-flight-create race** (`release.ts` ~31 claim / ~72 free;
   `collect.ts` ~249 stamps the PI without a status predicate). Release can
   claim `invoicing`, see no persisted PI, and free allocations while a PI is
   mid-creation. Fix: the PI-stamp write needs a status predicate so it loses
   to a release that already moved the batch (CAS), and/or release must not
   free a batch that could still be mid-create.
3. **Inbox claim-before-process** (`funding/inbox.ts` ~18 marks `processedAt`
   before the handler runs; `funding/webhook.ts` ~68 processing is not in the
   same transaction). A crash after the claim makes every Stripe redelivery a
   **permanent replay** (the event is never handled). Fix: either process in
   the same transaction as the claim, or claim-then-process with the outcome
   stamped only on success (and redelivery re-runs unhandled events).

Also worth confirming during that pass: refunds/disputes/transfer-reversals
have no live-Stripe polling backstop (the daily reconcile only inspects locally
flagged intents) — a missed reversal webhook can leave a payout recorded paid
and its batch unfrozen.

**Do this as one coherent pass with the funding staging matrix**, not piecemeal
— partial patches to a money state machine give false confidence.

---

## Item C — #8: export portability is incomplete (violates the promise)

**Severity:** HIGH (product-promise gap), **not** money-risky. CLAUDE.md +
README promise every table exportable to CSV/JSON/SQL with a re-importable
round-trip.

### Gaps (`apps/api/src/export.ts`, `apps/api/src/routes/export.ts`)
- The exported table list (`export.ts` ~21) **omits** `PartnerProgram`,
  `Coupon`, and `PartnerCommission` — so partner↔program grants, coupon
  attribution, and snapshotted commission rules don't round-trip.
- Routes expose **JSON/CSV only** (`routes/export.ts` ~10) — no SQL dump,
  though the contract promises it.
- Import hardcodes the conflict key `id` (`export.ts` ~116), but
  `PartnerCommission`'s primary key is **`partnerId`** (see
  `packages/db/migrations/20260612000000_partner_commission.ts`), so naively
  adding it would break import.

### The work
- Add the missing tables with a **per-table primary-key** map and a correct
  **import order** (respect FKs: Tenant → Partner/Program → PartnerProgram/
  Coupon/PartnerCommission → Click → Identity → Event → Attribution →
  Commission → Payout).
- Bump the export `schemaVersion`.
- Define + implement a **tenant-scoped SQL dump** format that the self-host
  OSS build can re-import (the portability guarantee is architectural — see
  CLAUDE.md principle #2).
- Round-trip test: export a seeded tenant → wipe → import → assert every table
  (incl. the three added) matches.

---

## The 12 shipped audit PRs (context)

`#60` cancellation-sync · `#61` coupons/clicks authz · `#62` PartnerProgram RLS
· `#63` auto-approve SQL · `#64` SSRF guard · `#65` Node 22 · `#66` safe-fixes
(enterprise self-assign, delinquent white-label, future-click, upload ENOENT) ·
`#67` partial-refund stopgap · `#68` webhook secret-family binding · `#69`
usage exactly-once · `#70` metering billable-types · `#71` funding reconcile
pagination.

**Outstanding post-merge actions:** `#62` → run `pnpm migrate` on prod;
`#63` → run the auto-approve job once and check for the accrued-commission
backlog it was failing to clear.
