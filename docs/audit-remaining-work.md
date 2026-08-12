# Payment/subscription audit — handoff

**Status (2026-08-11): the code is written and reviewed five times. Nothing
here is merged, and neither money path has ever run against Stripe.**

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

### 3. The staging matrices — the actual gate
Neither money path has touched Stripe. These are written and waiting:

- **`docs/direct-connect-payouts.md`** — six scenarios for #73: injected
  commit failure, injected timeout, past-window reconcile, commission-set
  change, definite failure, reversed transfer.
  *Lives only on the `fix/payout-transfer-intent` branch* — it is not on
  `main` or on this doc's branch, so check it out before going looking.
- **`docs/payout-funding-staging-runbook.md` section H** (`### H. Races`) —
  twelve scenarios for #75, each with how to force it.

**What is actually blocking this (checked 2026-08-11):**

There is **no openpartner staging environment**. `doctl apps list` shows
`openpartner` (prod), `openpartner-network`, `openpartner-marketing` — and
nothing else. "Run it on staging" is not a task someone forgot to do; it is
a task with no environment to run in.

You do not need to build one. The runbook's own prerequisites allow
`stripe listen --forward-to <host>/webhooks/stripe` when the target isn't
publicly reachable, so a **local** run covers the matrices. Local tooling is
already in place: Stripe CLI 1.40.8, Docker 29.0.1 running, `docker-compose.yml`
present.

What is genuinely missing is credentials and fixtures, not infrastructure:

- A Stripe **test-mode** secret key (there is no `apps/api/.env` at all today).
- The fixtures in the runbook's Prerequisites: a test tenant with an active
  test subscription, a test Connect partner with `payouts_enabled=true`, a
  completed ACH funding authorization, and **test clocks** for anything
  time-dependent (ACH settles in ~4 business days otherwise).

Round 5 is the argument for doing this: its worst finding was a mismatch
between our lease and *Stripe's client defaults* — a fact about the real
system that no amount of reading our own code surfaces, and that one
test-mode run with an injected delay would have caught immediately.

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
