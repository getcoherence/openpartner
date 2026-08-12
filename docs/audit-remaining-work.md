# Payment/subscription audit — handoff

**Status (2026-08-11, updated): the code is written, reviewed five times, and
both money paths have now been exercised against Stripe test mode — #73's
matrix in full, #75's partially. Nothing is merged yet; merging is blocked by
a branch-protection rule that a sole maintainer cannot satisfy (§3a).**

Three PRs, seven commits each, all open off `main`:

| PR | Branch | What it is |
|----|--------|------------|
| **#73** | `fix/payout-transfer-intent` | Direct-Connect payouts: durable transfer intent (audit #10) |
| **#74** | `fix/export-portability` | Data portability: missing tables, SQL dump, real PKs (audit #8) |
| **#75** | `fix/funding-race-hardening` | Hosted funding: the three pipeline races (audit #12) |

In each, the **first** commit is the original implementation and the rest
are fixes from five adversarial Codex review rounds.

All three are green on CI (typecheck + test, docker api/portal/router, CodeQL,
semgrep) and all report `MERGEABLE`. CI provisions Postgres and sets
`DATABASE_URL`, so the DB-backed tests — including the round-5 invariant that
pins the lease above the Stripe request budget — really do run there. They
skip silently on a local checkout with no `DATABASE_URL`.

## Read this before you touch any of it

**Every review round found real defects, and from round 2 onward they were
almost always in the PREVIOUS round's fix, not the original code.**

- Round 1 found a 409 that released frozen commissions → double-pay.
- Round 2 found the fix for it had introduced a warm-lease steal.
- Round 3 found the fix for *that* reused a key Stripe still retained.
- Round 4 found the generations added in round 3 were a key suffix that
  nothing was fenced on.
- Round 5 found the lease was shorter than stripe-node's own default
  request budget (80s timeout, 2 network retries — up to 3 attempts), so a
  POST could outlive it. Confirmed against the installed stripe@20.4.1:
  `DEFAULT_TIMEOUT = 80000`, `maxNetworkRetries` default `2`. The fix does
  not rely on those defaults — it passes `timeout` and `maxNetworkRetries`
  explicitly on the transfer call and bounds the budget at 40s.

Two independent coverage mechanisms for the funding sweep (a per-day hash
shuffle, then a count-derived window) both *looked* like rotation without
guaranteeing it; only a persisted cursor did. Three separate tests were
found to pass with the fix they covered reverted.

The lesson to carry: **in this code, a fix that looks like the property is
not the property.** When you change any of it, ask what interleaving makes
your guarantee false, and write the test so it fails if your change is
reverted. Ask an adversarial reviewer to refute a specific claim rather
than to "review" — that framing is what produced every finding above.

---

## Ground truth you need first

- **Repo**: `getcoherence/openpartner`. Node 22 (after #65), TS, Express API,
  Stripe + Stripe Connect **Standard**, PostgreSQL with RLS.
- **Prod is live on the app role** (RLS enforced): DO app `openpartner`
  (`3aa2e624-df1c-4fc9-88bd-c723bdb2713f`), `OPENPARTNER_TENANCY=multi`,
  `OPENPARTNER_MODE=flat`. `doctl` is authenticated; prod run logs:
  `doctl apps logs 3aa2e624-... api --type run` (~36h buffer).
- **Prod migrations DO auto-run — the long-standing note to the contrary
  looks like a misdiagnosis (re-checked 2026-08-11).**
  `apps/api/docker-entrypoint.sh` runs `migrate.js latest` and then
  `ensure-app-role.js` on every boot, and *refuses to start* if either fails.
  `OPENPARTNER_SKIP_MIGRATIONS` is **not set** in the prod DO spec, so this is
  live. That entrypoint landed 2026-04-23, months before the two July
  incidents blamed on migration drift — and both of those were application
  code out of sync with the schema (`#52` stale table names after the
  Campaign→Program rename, `#53` router not stamping `tenantId`), not
  un-applied migrations. A migration failure here is loud, not silent.
  Running `pnpm migrate` against prod by hand is therefore belt-and-braces
  rather than required. The cheap way to settle it for good: merge #62 and
  read the deploy log for `[entrypoint] running migrations`.
  (None of #73–#75 add a migration anyway.)
- **Payouts in prod are on the MANUAL rail.** `HOSTED_FUNDING_ENABLED` is OFF
  and there's a fail-closed guard on unfunded hosted Connect payouts. So the
  funding pipeline (`apps/api/src/funding/*`) does not execute in prod today,
  and the direct-Connect transfer path only runs for **self-host** installs (or
  the deliberate `OPENPARTNER_ALLOW_UNFUNDED_CONNECT_PAYOUTS=1` override).
- **Commands**: `pnpm typecheck`, `pnpm lint`, and from `apps/api`
  `pnpm vitest run [file]`. DB-backed tests need `DATABASE_URL` (local docker:
  `docker compose up -d` then `pnpm migrate`). Tests skip themselves when
  `DATABASE_URL` is unset.
- **Check lint's real exit code.** `pnpm lint | tail && git commit` takes the
  exit status from `tail`, so a failing lint won't stop the commit. This bit
  me once in this very effort.
- The full audit ledger lives in the session memory `payment-audit-2026-08`.

---

## What must happen before merge

### 1. Merge order — #74 must land AFTER #62
Exports rely entirely on RLS for tenant scoping (`exportTable` is an
unfiltered `select *`). `PartnerProgram`, newly added to the export set,
has **no RLS policy and no app-role grant on `main`** — the rename
migration never created them under the new name and
`packages/db/scripts/ensure-app-role.ts` still lists `PartnerCampaign`.
Merging #74 first makes `/export.json` either 500 or return every tenant's
grants. **PR #62 adds exactly that policy + grant, and needs a prod
`pnpm migrate` after merge.**

### 2. #71 belongs with #75 — *not* with #73 (corrected 2026-08-11)
An earlier revision of this doc paired #71 with #73. That was wrong, and
the mistake is worth understanding before you trust the rest of the table.

The bug #71 fixes — a reconcile that lists only the first 100 transfers and
treats "not found" as proven absence — is in `apps/api/src/funding/executor.ts`,
which is the **hosted-funding** rail. That is #75's territory, not #73's:

- `#73` touches `funding/interlocks.ts` only, never `funding/executor.ts`.
- `#73`'s own reconcile (`payout-transfers.ts:609`) **already paginates**
  via `starting_after` / `has_more`. It does not need #71.
- `#75` still carries `main`'s unpaginated `limit: 100`
  (`funding/executor.ts:458`) — it never fixed this, because #71 owns it.

So **#75 without #71 ships the funding rail with the duplicate-transfer hole
that #75 exists to close.** Land them together.

Not urgent for prod *behaviour* — `HOSTED_FUNDING_ENABLED` is OFF, so this
rail doesn't execute — but it must be true before that flag ever flips.

Verified, rather than assumed: merging #71 and #75 in either order keeps
#71's paginating loop. I extracted the merged blob and read it, because a
clean `git merge-tree` only proves there was no textual conflict, not that
the fix survived. All the pairs that share files merge clean —
`#73×#74`, `#73×#75`, `#74×#75`, `#73×#71`, `#74×#62`.

### 3. The staging matrices — RUN on 2026-08-11, mostly clear

**Both money paths have now touched Stripe test mode.** This section used to
say neither ever had; that is no longer the status.

| Matrix | Result | Script |
|---|---|---|
| **#73** direct-Connect, all 6 scenarios | **37 assertions, 0 failures** | `apps/api/scripts/staging-direct-connect.ts` |
| **#75** funding races, H1/H5/H6/H7/H8/H9 (+H11) | **21 assertions, 0 failures** | `apps/api/scripts/staging-funding-races.ts` |

**Still not run: H2, H3, H4, H10, H12** — all time- or interleaving-dependent,
wanting either Stripe test clocks or a genuine two-process run. Neither script
exercises a real multi-process race; the leases are single-process only so far.

Both scripts refuse a live key or a non-local `DATABASE_URL`, and each doc
carries its own run instructions and fixture setup.

Three things the real API established that no mock could:

1. **Replaying a frozen idempotency key returns the SAME transfer.** The whole
   intent design rests on this and it had only ever been asserted against our
   own mock. It holds.
2. **`paymentIntents.search` is eventually consistent.** A PI is not findable
   the instant it is created, and #75's adoption path depends on that search —
   so a retry inside the indexing window will not find the intent. The frozen
   key is therefore the load-bearing defence inside 24h, with search as the
   fallback past it. That is what the design assumed; it is now confirmed
   rather than hoped.
3. **A real Stripe 400 for an unready destination** classifies as definite and
   releases the claims. The mock's 400 was our own invention.

The vindication of doing this at all: it is the same class of finding as round
5's (our lease vs stripe-node's defaults) — facts about the real system that
reading our own code cannot produce.

The originals, for reference:

- **`docs/direct-connect-payouts.md`** — six scenarios for #73: injected
  commit failure, injected timeout, past-window reconcile, commission-set
  change, definite failure, reversed transfer.
  *Lives only on the `fix/payout-transfer-intent` branch* — it is not on
  `main` or on this doc's branch, so check it out before going looking.
- **`docs/payout-funding-staging-runbook.md` section H** (`### H. Races`) —
  twelve scenarios for #75, each with how to force it.

**How this was run, and why no staging server was needed:**

There is **no openpartner staging environment** — `doctl apps list` shows only
`openpartner` (prod), `openpartner-network`, `openpartner-marketing`. That is
not a blocker, because "staging" here means *an instance talking to test-mode
Stripe*, not a deployed environment. Both matrices ran **locally**: Postgres in
Docker on `localhost:5433`, the code driven directly, real Stripe test mode.

Do **not** solve the missing-staging problem by putting test keys on the prod
app. That would leave a live client and a test client in one process against
real tenant data; any misrouting is real money.

Credentials and fixtures that already exist (test mode) — reuse them:

- **Key**: repo-root `.env` (`STRIPE_SECRET_KEY=sk_test…`), *not*
  `apps/api/.env`, which does not exist. Same file points `DATABASE_URL` at
  `localhost:5433`.
- **Platform account**: `acct_1TQ1rLLjeKaK2m8k`.
- **Connect destination, onboarded** (`transfers: active`,
  `payouts_enabled: true`): `acct_1TQH8tLte7Y6cCMU`.
- **Connect destination, NOT onboarded** (for the definite-failure case):
  `acct_1TQH3OLN2QQBjOXV`.
- **Funding customer + ACH PM**: created 2026-08-11 — a customer with a
  verified `us_bank_account` payment method and a mandate, built via
  SetupIntent + `verify_microdeposits` with the test amounts `32`/`45`. The
  exact ids are printed by the fixture commands in the header of
  `apps/api/scripts/staging-funding-races.ts`.
- **Platform balance**: transfers need available balance. Top up test mode with
  `stripe post /v1/charges -d amount=200000 -d currency=usd -d source=tok_bypassPending`
  (the bypass-pending test token lands straight in the available balance).

Still wanted for the five unrun scenarios: **Stripe test clocks** (test-mode
ACH settles almost immediately, which is *faster* than reality and hides the
timing these exercise) and a genuine two-process run for the lease races.

Round 5 is the argument for doing this: its worst finding was a mismatch
between our lease and *Stripe's client defaults* — a fact about the real
system that no amount of reading our own code surfaces, and that one
test-mode run with an injected delay would have caught immediately.

### 3a. Merging is blocked by a rule that cannot be satisfied (found 2026-08-11)
`main` protection requires **1 approving code-owner review**, and GitHub does
not let a PR author approve their own PR. With a single maintainer, that is
unsatisfiable — which is most of why 16 PRs have sat open. `enforce_admins` is
**false**, so the owner can merge with `gh pr merge --admin --squash`; the
required status checks have all passed regardless. Fix the rule or bypass it,
but know that "waiting for review" will never clear on its own.

`required_linear_history` is on, so merges must be squash or rebase.

### 3b. Two PRs conflict with the BATCH, not with `main`
Each PR reports `MERGEABLE` because GitHub only compares it against `main`.
Merged together, two collide. Verified by building the full combination:

- **#66 × #61/#64** — `apps/api/src/__tests__/integration.test.ts`. All three
  append a `describe` block at the end of the file. Resolution: keep both
  blocks, each closed with its own `});\n});`.
- **#70 × #69** — `.env.example`. Both document new vars in the same spot.
  Resolution: keep both blocks.

Neither is semantic. But they only appear *after* the first of each pair
lands, so expect them mid-merge rather than up front.

**The combination was validated on 2026-08-11**: all 11 non-money PRs merged
into one branch, conflicts resolved as above → `pnpm typecheck` clean,
`pnpm lint` clean, full API suite **42 files / 292 tests green**, and #62's
migration verified applied (`tenant_isolation` policy present on
`PartnerProgram`).

### 3c. #66 was RED — fixed 2026-08-11, don't trust the old "all green"
`fix/audit-safe-fixes` was failing `typecheck + test` (7 tests) and had been
since 2026-08-08. Two causes behind one symptom:

- **A real defect.** `#66`'s negative-age guard was `ageMs < 0`. `Event.ts`
  comes from `new Date(event.created * 1000)` and Stripe stamps `created` in
  whole **seconds**, so a conversion in the same second as its click truncates
  to up to 999ms *before* it; the click clock is also not the event clock.
  Both are ordinary, and the strict check dropped the attribution **silently**
  — no error, just an unpaid partner. Now `ageMs < -CLICK_AFTER_EVENT_GRACE_MS`
  (5 min), which still rejects backdated backlog events (hours-to-months off).
- **Stale fixtures.** `compound-rules.integration.test.ts` seeded the click at
  NOW against events backdated to January — correctly rejected. Fixed to put
  the click just before the first event, which also means the 60d window is
  genuinely exercised there for the first time.

A companion test asserts an event 2s before its click still attributes, and
it was **confirmed to fail when the grace is reverted**.

### 4. Post-merge prod actions (from the earlier batch)
- `#62` → run `pnpm migrate` against prod.
- `#63` → run the auto-approve job once and check for the accrued backlog
  it was failing to clear.

---

## Load-bearing invariants — do not casually break these

**#73, direct-Connect payouts** (`apps/api/src/payout-transfers.ts`):
- The `Payout` row IS the intent. It is committed before any Stripe call,
  and its commission set is frozen by stamping `Commission.payoutId` while
  status stays `approved`. Every planner lookup filters `payoutId is null`.
- `keyGeneration` is an **epoch**, not a key suffix. Every mutation after a
  Stripe call is fenced on it, transfers are stamped with it, and reconcile
  reads the stamp rather than assuming the row's current value.
- Two clocks: `postedAt` never moves (anchors Stripe's ~24h retention),
  `leaseAt` moves per attempt (the CAS token). Conflating them refreshes the
  window forever.
- `POST_COOLDOWN_MS` **must** exceed the bounded Stripe request budget
  (`TRANSFER_TIMEOUT_MS × (TRANSFER_MAX_RETRIES + 1)`). There is a test
  asserting the relationship — keep it that way, don't pin constants.
- 409 / 429 / idempotency errors are **ambiguous**, never "definite". A
  definite classification releases the frozen commissions.
- More than one transfer in a group, or one from a superseded generation,
  parks in `duplicate_review` — a state the executor does not scan.

**#75, hosted funding** (`apps/api/src/funding/*`):
- The sweep uses a **persisted cursor** that commits *after* the slice is
  processed. Anything cleverer has failed twice.
- The inbox claim is a **lease with an owner token**; "held by someone else"
  answers 409, never 2xx — acknowledging an unprocessed event ends Stripe's
  redelivery.
- Allocations are never freed while a PaymentIntent could be alive. A failed
  lookup means *don't know*, which means *don't free*.
- `casBatch` **raises** on the one-open-batch unique index. Never put a
  safety action downstream of it (that made round 1's orphan reclaim
  unreachable).
- A truncated reversal ledger records what it read but derives **no** payout
  status.

---

## Known gaps, deliberately not fixed

These are decisions, not oversights — each is documented where it lives.

- **No operator recovery transition** for a frozen funding batch, or for a
  `duplicate_review` payout. Releasing automatically could permit a second
  debit, so manual is the safe default — but the only tool today is SQL.
  This is the most valuable follow-up.
- **Zero-decimal currencies**: `amount * 100` is wrong for JPY. Pre-existing
  and platform-wide (`payouts.ts` and `funding/state.ts:toMinor`), so it
  wants its own PR.
- **`transfer.updated` ignores `amount_reversed`**, so a partial reversal can
  flip a payout back to `paid`. Pre-existing.
- **Export gaps**: `Tenant`, `Config`, `PartnerPostback`, `BrandAsset`,
  `WebhookEndpoint` and the hosted funding sidecars (incl. `PayoutReversal`,
  from which payout status is *derived*) are not exported. Blocked on an FK
  decision — `HostedFundingAuthorization.adminId` references `Admin`, which
  is deliberately never exported. Listed in `docs/data-portability.md`.
- **Import into a non-empty database** can throw on natural keys
  (`Link(tenantId,linkKey)`, `Identity(clickId,userId)`); the round-trip
  tests always wipe first.
- **Commission↔Allocation lock-order cycle** (pre-existing): Postgres aborts
  one side, so the symptom is a retried webhook, not corruption.
- **Tests simulate psql** rather than invoking it, so the `\if` conditional
  is not truly exercised. Needs psql in CI.

---

## The audit PRs

`#60` cancellation-sync · `#61` coupons/clicks authz · `#62` PartnerProgram RLS
· `#63` auto-approve SQL · `#64` SSRF guard · `#65` Node 22 · `#66` safe-fixes
· `#67` partial-refund stopgap · `#68` webhook secret-family binding · `#69`
usage exactly-once · `#70` metering billable-types · `#71` funding reconcile
pagination · `#72` this doc · **`#73` payout transfer intent (#10)** ·
**`#74` export portability (#8)** · **`#75` funding race hardening (#12)**.

All still open. Every branch is cut from `main`, so they don't stack —
except the two ordering constraints above.
