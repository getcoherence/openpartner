# Payment/subscription audit — handoff

**Status (2026-08-13, after ROUND 10): Keith answered §0.4 — the decision is
B (durable operator-recovery requests). All ten round-9 findings are FIXED
and pushed. A round-10 Codex pass then refuted six of seven claims about
those fixes (15 findings, 9 CRITICAL); thirteen were fixed and pushed the
same day, two are the documented prove-absence limit with a new alarm (§0.2).
PRs #73 and #75 each carry three/three new commits, all suites green locally
(325 tests, twice — see the flakiness note before trusting one red run).
NOTHING IS MERGED; §3a's branch-protection blocker still stands and only
Keith can clear it. The next work, in order, is §0.3.**

---

## §0. START HERE — round 10: what happened, what remains

### 0.1 The decision and where its implementation stands

Keith chose **B — fast unfreeze**: operators insert an append-only recovery
request; the EXISTING executor/collector machinery applies it under its own
fences. Round 10 then did two things:

1. **Fixed all ten round-9 findings** across #73/#75 (commits `d9258c3`,
   `6b8317f`, `df730fd` / `40d7228`, `7798763`, `4d1544d`). The four
   operator functions now verify everything verifiable themselves — group
   membership by immutable `transfer_group`, frozen
   amount/currency/destination authentication, the quiet gate + own search
   on `forceReleaseBatch`, ghost-stamp fallback, the `duplicateReviewNonce`
   fence against mid-resolution reversals, per-object sweep scheduling.
   **B's apply step calls these functions unchanged — they ARE its
   verification layer.** What B still adds: durability, auditability, an
   admin API, and serialization with the machinery.
2. **Did NOT build B's queue.** Deliberately: the apply step calls
   functions that exist only on the two unmerged branches, and `main`
   requires linear history — the PRs will land squashed, and a B branch
   stacked on pre-squash commits needs history surgery afterwards. **Land
   #73/#74/#75 first (per §3a, `gh pr merge --admin --squash`), then build
   B as one new PR on main.** The full design — table shape, apply
   semantics, outcome mapping, the tenancy check that stands between an
   admin of tenant A and tenant B's payouts, the inline-apply-for-feedback
   pattern — is in §0.4.

### 0.2 Round 10's own findings — fixed, and the two that remain by design

Codex's round-10 pass (adversarial, refute-these-claims framing) found 15.
Thirteen are fixed and pushed; verify by reading the two `round 10` commits.
The important shapes, because they will recur:

- **The nonce was an ABA.** Connect events return before the event-id
  dedupe, so a REDELIVERED old event wrote its event-id nonce back and a
  stale resolution fenced on it committed. The nonce is now a fresh ulid
  per write — no observed value can return. General rule worth keeping:
  **a fence value must be unforgeable AND unrepeatable.**
- **Group membership is unauthenticated.** Anything on the Stripe account
  can set `transfer_group` to our payout ULID. Refusing-on-any-member is
  fail-closed and fine; FINALIZING a member is not — reconcile now
  authenticates amount/currency/destination against the frozen intent plus
  an immutable time bound (`transfer.created` cannot predate the current
  generation's `postedAt`), which also defeats forged generation stamps.
- **PaymentIntents have no transfer_group equivalent**, so the funding
  rail's metadata search gets a metadata-independent backstop: the tenant
  customer's PI LIST, matched on exact amount+currency since batch
  creation (decisive because of one-open-batch-per-tenant+currency).
- **Clocks:** sweep leases now use the DATABASE clock on both sides, and
  a never-swept row's eligibility hint is clamped with `least(..., now())`.

**Still open, by design — the prove-absence limit.** Two findings reduce to
the same fact: an unbounded in-flight POST can land AFTER a verified action
(a dispose on an empty listing; a keep-X resolution while a superseded
generation's POST is still out there). No fence observes a CREATION, so
these cannot be closed the way reversals were. What round 10 shipped is the
ALARM: a new `transfer.created` webhook handler (detector only, no state
writes) raises `transfer_created_orphan` when a transfer lands for a payout
no longer expecting one. **Register `transfer.created` on the Stripe
webhook destination or it never rings.** B closes the loop properly: the
request row is the tombstone (who accepted the risk, when, on what
evidence), and a post-action group re-check belongs in B's apply machinery.
Also frozen by design: a transfer group larger than the 20-page budget
(2000+ transfers for one payout) still refuses everything — that scale
means a catastrophe upstream, and raw SQL is the honest tool there.

Residual accepted behaviours, so nobody re-finds them: a foreign transfer
in our group can DoS the refusal guards (fail-closed, operator sees why); a
sweep row whose lease expires mid-run can be READ twice by two live runs
(handlers idempotent, ack is token-fenced); reversal-webhook identification
now prefers `transfer_group`, so a group-less legacy transfer still falls
back to metadata.

### 0.3 The next work, in order

1. **Keith merges the batch** — §3a (`--admin`), order per §1/§2 (#62
   before #74; #71 with #75). **#75 now ADDS a migration**
   (`20260813000000_funding_sweep_per_object`) — prod migrations auto-run
   on deploy (see ground truth), a manual `pnpm migrate` is belt-and-braces.
2. **Add `transfer.created`** to the Stripe webhook destination (§0.2).
3. **Build B on main** per §0.4's design, as one PR; then a round-11 Codex
   pass on it. Codex's standing caveat applies: review count is not
   operational safety.
4. The still-unrun staging scenarios (H2/H3/H4/H10/H12 — test clocks, true
   two-process races) remain from before; unchanged.

### 0.4 Option B — the full design (drafted round 10, execute after merge)

**Table `OperatorRecoveryRequest`** (new migration; operational sidecar,
listed with the export gaps): `id` ulid PK, `tenantId`, `rail`
(`direct_connect` | `hosted_funding`), `kind` (`release_intent_for_retry` |
`dispose_intent` | `resolve_duplicate_review` | `force_release_batch`),
`targetId` (payoutId/batchId), `params` jsonb ({ observedGeneration } /
{ reason } / { keptTransferId } | { allReversed: true } / { reason }),
`requestedBy`, `note`, `status` (`pending` | `applied` | `refused` |
`failed` | `canceled`), `outcome` (the function's literal return value),
`attempts`, `createdAt`, `appliedAt`, `updatedAt`. Append-only discipline:
terminal rows are never edited; a new decision is a new row.

**Apply loop** `applyRecoveryRequests(db, { rail, stripe, tenantId? })`:
claim pending oldest-first with `for update skip locked` (the round-10
sweep-claim pattern); **check the target row's tenantId equals the
request's tenantId before anything else** — the apply runs on the
privileged pool and this is the only tenant boundary; call the existing
function; map outcomes: success → `applied`; definitive refusals
(`money_with_partner`, `kept_transfer_invalid`, `transfers_still_live`,
`transfer_exists`, `has_payment_intent`, `generation_moved`, `not_held`,
`not_in_duplicate_review`, `not_disposable`, `not_stuck`) → `refused` with
the outcome recorded; retryable (`cannot_verify`, `review_moved`,
`too_recent`) → stays `pending`, `attempts += 1`, cap ~10 → `failed` +
alert. Wire the apply at the top of the existing scheduler jobs
(direct-Connect 15-minute executor job; funding collector tick) so a
released intent is executed by the same tick that released it.

**API** (admin-authed, tenant-scoped, one route file):
`POST /payouts/:id/recovery`, `POST /funding/batches/:id/recovery` —
validate kind/params, insert, run ONE inline apply scoped to the new
request, return its outcome synchronously (instant 2am feedback;
durability is the insert, not the response); `GET /recovery-requests`.

**Plus B's half of the prove-absence close (§0.2):** after applying any
empty-listing-based request, schedule a group re-check (reuse the
per-object sweep pattern) for the target, so a late-landing transfer is
found even if the `transfer.created` webhook is missed.

---

### Round 8 — ten findings, all fixed and pushed

Round 8's theme was that **round 7 built operator paths that act on an
unverified human assertion**, which is strictly weaker than the "empty search
is not proof" rule round 6 had just imposed on the automatic paths. A human
typo is silent where a Stripe read is not.

- `disposeIntent` released on `status !== 'paid'`, but the finalizer records
  `confirmed+failed` for ANY non-zero `amount_reversed` — so a $10 clawback
  on a $50 transfer released commissions the partner had mostly been paid
  for. It now retrieves the transfer and refuses unless fully reversed.
- `resolveDuplicateReview` validated nothing: `{allReversed}` while transfers
  were live double-paid, and a typo'd `{keptTransferId}` recorded a payout
  paid against a transfer that does not exist AND wedged the row. Both
  dispositions are now checked against the transfer group.
- The listing guard on `releaseIntentForRetry` only ran `if (stripe)`, and
  the documented runbook call omitted it — so it was absent in the one usage
  operators would copy. Required now, and exhausting the page budget returns
  `cannot_verify` rather than being read as absence.
- On #75: the `reserved` fast path read a stale snapshot; `forceReleaseBatch`
  freed allocations before its CAS; the retry set could starve the sweep; the
  `updatedAt` ordering premise was false; and an unlinked intent could
  redeliver forever then vanish.
- On #74: `resolveSession` had the identical hole round 7 fixed for API keys —
  tenant A's cookie authenticated against tenant B.

### Round 7 — the fixes bred the defects, again, and where

Round 6 concluded that its changes were "mostly deletions of unsound logic,
so less new surface to breed a round 7". **That prediction was wrong in a
specific, checkable direction.** The deletions held up — the
hold-instead-of-re-arm and empty-search-is-unknown changes produced no
findings at all. Every serious round-7 finding is in something round 6
*added*: the operator functions, the webhook fallback, the retry set.

If you take one thing from this file, take that: in this code, **the
dangerous change is the one that adds a mechanism**, and "I removed unsound
logic" is not a reason to expect a clean next round.

What round 7 found, by shape:

- **A fix that reintroduced its own bug one statement later.** Round 6 added
  a metadata fallback so a reversal arriving before finalization could still
  match. The exact-id match and the fallback are two statements, and the
  executor could stamp the id between them — both miss, event acknowledged,
  reversal lost. Fixed with a row lock so there is no in-between.
- **A new operator tool that double-paid.** `disposeIntent` accepted
  `duplicate_review` and released the claims, but a duplicate is disposed of
  by keeping one transfer — those commissions are paid. No concurrency
  needed; it was simply wrong. Split into `resolveDuplicateReview`, which
  takes the operator's actual disposition.
- **A guard that used a stale read.** The funding `reserved` fast path was
  gated on the caller's snapshot while the CAS accepted four source states.
  Now a dedicated `reserved` CAS proves the state it claims.
- **A starvation fix that starved.** The sweep retry set took the whole
  budget, so `limit` failing rows meant the cursor never advanced — the exact
  poison-item failure the retry set was added to prevent.
- **An ordering key that was not eligibility time.** `postedAt` is stamped
  before the Stripe call, so a late-confirming intent still landed behind the
  cursor. Fixed with a key that moves forward at confirmation, so a row can
  only be re-visited, never skipped.
- **A tenant filter that did not bind credentials.** #74's export filter was
  correct but the claim around it was not: `requireAuth` matched an API key
  with no tenant predicate, so on the privileged pool another tenant's key
  authenticated and the filter faithfully served *their* data. That is
  broader than export and is now fixed in `auth.ts`.

### Round 6 — what it found, and the one structural conclusion

The pattern from rounds 2–5 held: most findings were in the previous round's
fixes. The important one is that **round 5's fix was built on an assumption
that was never true.**

`POST_COOLDOWN_MS > TRANSFER_TIMEOUT_MS × attempts` was supposed to guarantee
the lease outlived the request. It cannot: stripe-node implements `timeout`
as `req.setTimeout`, a socket-**inactivity** timeout that resets after each
request stage — its own source says so. A slow-but-progressing POST has no
wall-clock bound at all. Nor can a local deadline help, because aborting the
await does not retract a request Stripe already received.

So the executor **no longer re-arms on elapsed time**, and `POST_COOLDOWN_MS`
is documented as carrying no correctness weight. The same shape appeared
independently on the funding rail: an empty `paymentIntents.search` was
treated as proof no PaymentIntent existed, but that API is eventually
consistent. Both rails now treat "I did not see it" as **unknown**, never
**absent**.

That costs liveness, not money — a genuinely-lost POST or an unindexed PI
waits for a human — so both rails gained an operator disposition path
(`releaseIntentForRetry` / `disposeIntent`, `forceReleaseBatch`). The
handoff previously listed operator tooling as "the most valuable follow-up";
under this design it is a **prerequisite**, because a hold with no release
is a leak.

Two Codex runs from deliberately opposite framings agreed on every fix and
disagreed only on scope. The smaller plan won on the merits: the fixes are
mostly *deletions of unsound logic plus missing fences*, which is less new
surface to breed a round 7 than the alternative (a new PaymentIntent
lifecycle and a new work queue) would have been.

Three of my own artefacts were wrong and are corrected: the
cooldown-arithmetic test (deleted — it asserted a guarantee that does not
exist and passed at the old constant anyway), and both staging scripts,
which could report success while the property under test was false.

Three PRs, all open off `main` (#73 and #75 gained three round-9/10
commits each on 2026-08-13):

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

- Round 6 found the round-5 fix rested on an assumption that was never true
  (see the status block above), plus the same "prove a negative" shape on the
  funding rail, a first-attempt reversal believed from a stale response, an
  unfenced quarantine, and a sweep that acknowledged its own failures.

**Four** coverage mechanisms for the funding sweep have now looked like
rotation without being it: a per-day hash shuffle, a count-derived window, a
cursor that committed before the work, and a cursor ordered by **creation**
id when rows join the sweep at **eligibility** time. Only the last of those
is fixed by ordering on an immutable eligibility timestamp.

The lesson to carry: **in this code, a fix that looks like the property is
not the property.** When you change any of it, ask what interleaving makes
your guarantee false, and write the test so it fails if your change is
reverted. Ask an adversarial reviewer to refute a specific claim rather
than to "review" — that framing is what produced every finding above.

**And apply that to your own tests, because they are the usual culprit.**
Round 6's revert checks caught three of mine mid-flight:

- a payout-lock test that passed with the lock removed, because the handler
  still blocked eventually — at its UPDATE. Blocking was never the property;
  *summing after acquiring* is. It only discriminated once the blocker
  mutated the ledger while holding the lock.
- a sweep-coverage test that passed under both orderings, because with three
  rows and nothing arriving the cursor wraps and covers everything anyway.
  It needed genuine churn — fresh eligible rows before every run — before it
  could reproduce the starvation.
- a staging scenario that reported success when the planner produced no
  payout at all, making a misconfiguration indistinguishable from the Stripe
  rejection it was supposed to test.

Running the suite is not the check. Reverting the fix and watching the test
fail is the check.

**Nine rounds of evidence on where defects come from.** Findings per round:
R6 ten, R7 twelve, R8 ten, R9 eleven. No round has come back clean, and the
count is not trending down. But the LOCATION has stabilised, and that is the
useful signal:

- Rounds 1–5 found defects in the core money protocol. Those areas have been
  quiet for four rounds.
- Rounds 6–9 findings are almost entirely in the operator-recovery surface
  and the reconcile sweep — both of which exist to support round 6's decision
  that ambiguity must freeze and wait for a human.
- Across every round, changes that DELETED unsound logic produced no
  follow-on findings. Changes that ADDED a mechanism produced them nearly
  every time.

Read that as a warning about which changes need the most scrutiny, **not** as
an argument for minimising code. See §0.4: the metric that matters is
operational safety, not next-round finding count.

**Also record: several rounds' findings were in the author's own tests, not
the production code.** Round 8 found four; round 9 found that a round-8 edit
had *degraded* a previously-good test by changing its limit so it no longer
discriminated. When you fix something here, check the test still fails with
the fix reverted — including tests you did not intend to touch.

**The suite is mildly flaky under parallel files sharing one Postgres.** Two
runs failed different files (`export-roundtrip`, then `compound-rules`), and
two consecutive runs then passed 276/276. Pre-existing. Do not trust a single
red run; re-run before investigating.

Round 7 caught four more of mine the same way, and the failure modes repeat
often enough to be worth naming as a checklist:

- **The early guard short-circuits before the code under test.** A
  `forceReleaseBatch` test flipped the state up front, so the function
  returned at its status check and never reached the ordering being tested.
  Fixed with a seam that stages the race *between* the read and the CAS.
- **The cursor wraps and covers everything by accident.** Twice now. Any
  coverage test needs genuine churn — fresh eligible rows arriving before
  every run — or the wrap hides the starvation.
- **The value under test is already valid.** A JSONB test used the number
  `42`; pg prepares that as the text `"42"`, which is valid JSON either way.
  A *string* is the mutation killer.
- **Array indexing where order is not guaranteed.** `payouts[0]` passed
  locally and failed in CI once an earlier step returned a second partner's
  commission to the pool. Select by the key you mean.

And once more, from round 7's own fixes: **a lock test that asserts "it
blocked" proves nothing** — it will block eventually at some later write.
Assert the *value* that the lock protects.

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
  (Since round 10, **#75 adds a migration** —
  `20260813000000_funding_sweep_per_object`, four sweep-scheduling columns
  on the two hosted sidecar tables. #73 and #74 still add none.)
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
