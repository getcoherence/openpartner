# Bonuses and performance bounties: design

**Status (Oct 18 2026): PR A (bonuses) and PR B (performance bounties) built. §11 and §12 record where the build differs from this design.** Two PRs in this repo:

- **PR A, bonuses.** A way to pay a partner a reward that isn't tied to an attributed sale. Includes a manual "Pay a bonus" action for admins.
- **PR B, performance bounties.** A goal on a program ("10 sales between Nov 1 and Dec 31 earns $500"), checked by a sweep and paid as a bonus.

Submission bounties, social-metrics bounties, social account verification and the public bounty board are Network features. They need hosted uploads and review, platform API credentials, and a creator identity shared across brands. They live in the Network service and pay out through the bonus API below (§6).

## 0. Words

"Bounty" already appears in fee copy and docs (`docs/platform-fee.md`, `ARCHITECTURE.md`, `AdminPrograms.tsx`) for a **fixed per-event commission**, such as $50 per booked demo. That meaning stays, and the fee copy ("flat bounties with no sale amount add 10% of the bounty") is just as true of the rewards below. In this doc:

- **Fixed commission:** a `fixed` sub-rule that pays on every matching event. Unchanged.
- **Bonus:** one payable reward, not tied to an event. New.
- **Performance bounty:** a goal that awards a bonus once a partner reaches it. New.

## 1. The gap

Every payable row is a `Commission`. `Commission.attributionId` is NOT NULL with a foreign key to `Attribution`, which requires an `Event` and a `Click`. So the only way to pay a partner today is through an attributed event. There is:

- no manual bonus endpoint (the `CommissionAdjustment` reason `admin_correction` is declared but nothing writes it);
- no reward for reaching a goal. Tiers change the rate per later event; they never pay a lump sum.

Faking it with a synthetic conversion through `POST /attribution/conversions` works, but it pollutes the raw event log, tier metrics and dashboard sales. Principle 1 rules it out: a reward is a derived decision, not a customer event.

## 2. Data model (PR A)

### `Bonus` (new core table)

The record of a decision to pay a partner a reward.

| column | type | notes |
|---|---|---|
| `id` | ULID | |
| `tenantId` | | RLS: plain `"tenantId" = current_setting('app.tenant_id', true)`, enabled and forced (pattern in `20261016000000_partner_network_consent.ts`, minus the OR that `20261017100000` removed; `tenant-policy-shape.test.ts` enforces it) |
| `partnerId` | FK Partner | |
| `programId` | FK Program, nullable | holdback and earnings-by-program come from here |
| `amount` | decimal | > 0 |
| `currency` | char(3) | upper-case |
| `source` | text | `manual` \| `performance_bounty` \| `network` (string, not enum) |
| `bountyId` | FK Bounty, nullable | set when `source = performance_bounty` |
| `externalRef` | text, nullable | idempotency key. Unique on (`tenantId`, `source`, `externalRef`) where not null. The Network sends its submission id here |
| `note` | text, nullable | shown to the partner |
| `createdBy` | text, nullable | admin id or API key id |
| `createdAt` | timestamptz | |

A bonus is immutable once written. Reversing it reverses its commission (§3).

### `Commission` changes

- `attributionId` becomes **nullable**.
- New nullable `bonusId` (FK `Bonus`), indexed.
- A CHECK constraint requires exactly one of `attributionId` and `bonusId` to be set.
- `metadata.rateType = 'fixed'` on bonus commissions, so fee and reporting code that reads `rateType` treats a bonus as a non-sale amount.

Each bonus gets exactly one commission, with the same amount and currency, so payouts, approval, reversal, netting and the partner's earnings all keep working on one table.

### Portability

- **New tables:** `Bonus` and `Bounty` (§7) go into `EXPORT_TABLES`, after Partner and Program and before Commission.
- **Version:** `SCHEMA_VERSION` 5 → 6. Append 6 to `SUPPORTED_IMPORT_VERSIONS`.
- **`Commission.bonusId`:** a nullable column, so it rides along under the same bump.
- **Older bundles:** import with no bonuses.
- **Other places to update:** the `TABLES` lists in `packages/db/src/index.ts` and `AdminExport.tsx`, a seeded row in `export-roundtrip.test.ts`, and the table and version history in `docs/data-portability.md`.

## 3. Lifecycle

A bonus commission is created `accrued`, like any other. When it becomes `approved` depends on where it came from:

- **Manual bonus.** The default is `approved` immediately, so it is paid in the next payout run. That matches how brands use a one-off bonus. The admin can choose "hold for the program's holdback" instead.
- **Performance bounty.** It is held for the program's holdback (`EFFECTIVE_HOLDBACK_SQL`, through `Bonus.programId`). At approval, the auto-approve sweep re-checks the bounty's goal (§8). If refunds have pushed the partner back under it, the commission is reversed with reason `bounty_requalification`.
- **Network bonus.** `approved` immediately. Review already happened on the Network side.

Reversal uses the existing `POST /commissions/:id/reverse`, with its funding interlocks. **Paid bonuses are not clawed back automatically** in v1. Refund clawback netting (`clawback-netting.ts`) only nets `refund_clawback` adjustments, and that is intended.

## 4. Code that assumes `attributionId` (all of it changes in PR A)

| Where | Today | Change |
|---|---|---|
| `routes/commissions.ts` `listQueryBase` | left join Attribution → Program | also left join Bonus, `coalesce(a.programId, b.programId)` for program and holdback. Add `source` and `bonus` to the response |
| `partner-commission.ts` `EFFECTIVE_HOLDBACK_SQL` | program through Attribution | program through Attribution or Bonus |
| `commission-auto-approve.ts` | **inner** join Attribution → Program, holdback > 0 only | include bonus commissions through Bonus → Program, plus the bounty re-check |
| `commission-events.ts` `dispatchCommissionEvents` | click and event origin through `attributionId` | bonus commissions take the `bonus.*` path (§5) |
| Network-facing `GET /partners/:id/commissions` and `/timeseries` (`docs/network-protocol.md`) | attribution-shaped rows | include bonus commissions with `source: 'bonus'`, and nulls where there is no event or click. Document the change in the protocol doc |
| Dashboard earnings sums (`routes/dashboard.ts`) | Σ Commission | unchanged sum. Revenue and sales metrics stay event-based, so bonuses never inflate "sales" |
| `refunds.ts` | finds commissions through Attribution | unchanged: bonuses aren't refundable sales |
| `commission-slabs.ts` tiers | count Attribution rows | unchanged: bonuses never count toward tiers |
| `usage-ledger.ts` fee meter | per attributed Event | bonus path (§6) |

## 5. API, scopes, webhooks

- **Endpoints:**
  - `POST /bonuses` takes { partnerId, programId?, amount, currency, note?, externalRef?, hold? }.
    - A replay with the same `externalRef` returns the original bonus with `replayed: true`.
    - Each call runs in one transaction that writes the bonus and its commission, and dispatches webhooks `onCommit`.
  - `GET /bonuses` (filter by partner, program, bounty, source) and `GET /bonuses/:id`.
- **Scope:** new `bonuses:write`. Admin sessions have it implicitly.
- **Network keys:** add the new scope to the Network's federation scope set. **Existing Network keys don't carry it**, so the Network has to ask the brand to re-issue its scoped key (`POST /api-keys/scoped`) before Network bounties pay out. The portal's Network settings page should show "Re-authorize to enable Network bounties".
- **Gates:** money-moving routes join `GO_LIVE_ROUTES` (`middleware/approval-gate.ts`) and the trial gate, the same as payouts.
- **OpenAPI:** register the routes in `apps/api/src/openapi`, then run `pnpm --filter @openpartner/api openapi:update`.
- **Webhooks: new `bonus.awarded`, `bonus.approved`, `bonus.paid`, `bonus.reversed`.**
  - Payload: { bonusId, commissionId, partnerId, programId, bountyId, source, amount, currency, note }.
  - The existing `commission.*` payloads require `attributionId` and (for `accrued`) `clickId` and `eventId`, and they are published contract. Bonus commissions don't emit them. Loosening those fields would break integrations that rely on them.
  - Add the new events to `KNOWN_EVENTS`, `WEBHOOK_PAYLOADS`, `WEBHOOK_DESCRIPTIONS`, the `WebhookEventType` union, `SYNTHETIC_PAYLOADS` and the list in `admin/Webhooks.tsx`.
  - `payout.created` is unchanged; it already lists every commission in the payout.
- **Partner postbacks:** add `bonus.awarded` and `bonus.paid` to `POSTBACK_EVENTS`, with macros `bonus_id`, `bounty_id`, `bonus_amount`, and the existing `currency`, `partner_id` and `program_id`.

## 6. Platform fee

- **Commission-floor rule (rule v2):** each bonus is billed `commissionRate × amount` (Revshare 10%, Flex 5%; `FEE_RULE_DEFAULTS`). That is the published "flat bounty" line.
- **Legacy revenue-only rule:** bonuses are not billed, because that rule bills revenue only. This is consistent with what those customers were told, and it stops when their notice period moves them to rule v2.
- **Meter (`usage-ledger.ts`):**
  - `UsageLedger.eventId` is NOT NULL today. Give it a nullable `bonusId` instead, with a CHECK that exactly one is set.
  - Keep #136's diff and carry-forward semantics: a reversed bonus credits like a refund.
  - `UsageLedger` is a hosted sidecar table (not exported), so this doesn't touch portability.
- **Self-hosted Network fee:** the 3% of marketplace payouts already counts *paid Payout rows* for Network-sourced partners (`aggregateNetworkOriginatedPayouts`), so bonuses paid to those partners are included with no change.

## 7. Performance bounties (PR B)

### `Bounty` (new core table)

| column | notes |
|---|---|
| `id`, `tenantId` | RLS as above |
| `programId` | FK Program. A bounty belongs to one program |
| `name`, `description` | `description` is shown to partners. Plain text, max 5,000 characters |
| `metric` | `conversions` \| `revenue` \| `leads` \| `commissions` |
| `eventType` | nullable. Restricts `conversions` and `revenue` to one event type |
| `threshold` | numeric > 0. For `revenue` and `commissions` it is in `currency` |
| `scope` | `new` (only activity inside the window) \| `lifetime` (all history, so partners who already qualify are awarded on the first sweep) |
| `startsAt`, `endsAt` | `endsAt` nullable (no end). `startsAt` defaults to now |
| `rewardAmount`, `currency` | |
| `partnerIds` | jsonb, nullable. Null means every partner in the program; otherwise an allowlist. There are no partner groups or tags in core |
| `status` | `draft` \| `active` \| `ended` \| `archived` |
| `createdAt`, `updatedAt`, `endedAt` | |

Once a bounty has awarded anything, its goal fields (`metric`, `eventType`, `threshold`, `scope`, `rewardAmount`, `currency`) are locked. Only `name`, `description`, `endsAt` (extend only) and `status` can change. A partner can earn a bounty **once**. Repeating bounties ("every 10 sales") are out of scope for v1.

### Metrics

These reuse the dashboard's definitions (`routes/dashboard.ts`) and the filters from tiers (`tierMetric` in `commission-slabs.ts`):

- **Which conversions count:** the partner's attributions in the bounty's program, weighted by the attribution share, with fraud-flagged clicks excluded and corrective events never counted.
- **`leads`:** `signup` and `trial_started` events.
- **`conversions`:** events with value > 0, or of `eventType`.
- **`revenue`:** Σ value × share, in the bounty currency only (the same rule as tiers; no FX).
- **`commissions`:** Σ the partner's **attribution** commissions in the program, not reversed. Bonus commissions are excluded, so a bounty can't feed itself.
- **Refunds:** a refunded conversion stops counting. Revenue and commissions count net of `refund` and `chargeback` (the corrective events link to their conversion through `metadata.conversionEventId`).

Factor the shared query out of `tierMetric` rather than copying it. It takes a [start, end) window instead of "strictly before this event".

### Evaluator

- **Schedule:** an hourly sweep, `sweepPerformanceBounties`, run through `forEachActiveTenant` with one transaction per tenant, like `commission-auto-approve`.
- **What it checks:** each `active` bounty, from `startsAt` until 7 days after `endsAt`. The grace period catches late conversions and backlog replays. It then marks the bounty `ended`.
- **How it awards:**
  - For each eligible partner without an award, compute the metric in the window. If it meets the threshold, call the same internal function as `POST /bonuses` with `source = 'performance_bounty'`, `bountyId`, and `externalRef = bounty:<bountyId>:<partnerId>`.
  - The unique `externalRef` makes this idempotent under overlapping sweeps. That matters because tiers deliberately have no per-partner lock (see the concurrency note in `docs/commission-slabs.md`).
- **Why not inline in `attributeEvent`:** that would put a cross-row aggregate on the conversion hot path, with the same race tiers have.
- **Re-check at approval:** recompute the metric. If it is now below the threshold, reverse with `bounty_requalification` and send `bonus.reversed`.

### Notifications

The emails reuse the existing templates and the opt-out scopes:

- **Bounty started:** to eligible partners.
- **Bonus awarded:** to the partner.
- **Ending soon:** 7 days before `endsAt`, stamped and idempotent like `sweepCampaignEndNotifications`.

### Portal

- **Admin:** a Bounties page per program (list, create, progress). Creation uses a sentence form: "When a partner's **new** **conversions** reach **10** between **Nov 1** and **Dec 31**, pay **$500**". The progress view shows each partner's metric against the threshold.
- **Partner:** a Bounties tab in the partner shell (`App.tsx` Shell routes) with a progress bar per bounty and its description. Data comes from a partner-scoped `GET /me/bounties`, which returns only bounties the partner is eligible for.
- **Partner Commissions page:** shows a source label ("Bonus: <bounty name>" / the note).
- **Conventions:** inline styles, `theme.ts` tokens, `useIsMobile`, primitives from `ui.tsx`. `StatusPill` gains the colours it needs.
- **Marketplace terms:** if a performance bounty is shown on a program's Network offering, the text is rendered from the bounty's structured fields, never from free text, the same as `commission-summary.ts`.

### Out of scope for v1

Repeating bounties, a click metric, leaderboards, partner groups or tags, and automatic clawback of paid bonuses.

## 8. Network bounties (separate repo)

The Network handles submission bounties, social-metrics bounties, verified social accounts and the public bounty board. Its design is in the Network repo. This repo only provides:

- `POST /bonuses` with `source = 'network'` and `externalRef = <network submission id>`. It needs a re-issued federation key (§5).
- Bonus commissions in `GET /partners/:id/commissions` and `/timeseries`, so creators see Network bounty earnings in the creator portal.
- Brand-side review screens in the portal. These proxy to the Network, the way `admin/NetworkRequests.tsx` does today, and render only when the tenant is connected to the Network.

## 9. Build order

1. **PR A: bonuses.** §2 to §6 plus the manual "Pay a bonus" action on the admin partner page. Includes export v6, the `bonus.*` webhooks, postbacks, OpenAPI, the fee meter path, and tests:
   - idempotent replay;
   - the CHECK constraint;
   - holdback through `Bonus.programId`;
   - fee on rule v2 vs legacy;
   - export round-trip;
   - RLS shape;
   - payouts picking up a bonus commission.
2. **PR B: performance bounties.** §7, with tests:
   - each metric;
   - `new` vs `lifetime` scope;
   - the window edges;
   - idempotent sweeps;
   - re-qualification after a refund;
   - fraud-flagged clicks excluded;
   - a bonus never counting toward `commissions`.
3. **Network:** after PR A is deployed, the Network uses `POST /bonuses`.

## 10. Open questions

- Should manual bonuses default to "pay next run" or to the program holdback? This doc proposes next run.
- Should paid performance-bounty bonuses ever be clawed back automatically? This doc proposes no for v1.
- Should a bounty's description allow light formatting (bold, links)? This doc proposes plain text for v1.

## 11. Implementation notes (PR A)

Where building PR A met the code, the code won. These are the differences from §2–§6:

- **Gates.** §5 says "the same as payouts", but no payout route is in either gate. `POST /bonuses` joins `GO_LIVE_ROUTES` (a brand pending review can't pay) and the trial gate's **plan-required** list, so it needs an active plan even during the trial. A bonus is billed through the plan's meter, so a brand without a plan has nothing to bill it against. Self-host is exempt, as with onboarding.
- **Re-authorizing the Network.** Nothing on this side can hand the Network a re-issued key: rotation is the Network's `POST /vendors/me/rotate-callback-key`. So `POST /config/network/authorize-bonuses` (admin only) adds `bonuses:write` to the federation key the Network already holds. The Network page shows "Re-authorize to enable Network bounties" while `GET /config/network` says `bonusesAuthorized: false`. New connections get the scope from `NETWORK_FEDERATION_SCOPES`.
- **Source comes from the caller, never the body.** The brand's federation key (`membership.scopedKeyId`) pays `network` bonuses. Every other caller pays `manual` ones, and only the bounty sweep pays `performance_bounty` ones. `externalRef` is unique per (tenant, source), so the same ref from an admin and from the Network is two bonuses.
- **Webhooks.** `bonus.awarded` carries `status` (`approved` or `accrued`). When a bonus is approved on award, `bonus.approved` follows at once, so a subscriber to approvals sees every bonus that will be paid. `bonus.approved`, `.paid` and `.reversed` go through `dispatchCommissionEvents`, which sends a bonus's commission down the `bonus.*` path. The bonus fields on those three are optional in the catalogue, as a commission's origin is: they're omitted only if the bonus lookup fails.
- **Postbacks.** A bonus has no click or event, so `{click_id}`, `{event_id}` and `{transaction_id}` stay literal on its postbacks, like any macro with no value. `{commission_id}` and `{commission_amount}` resolve too, since a bonus is paid through a commission.
- **Validation.** A revoked partner is `409 partner_revoked`: reinstate them first. An amount with more than two decimals is `400 invalid_amount`, checked outside zod because JSON Schema's `multipleOf: 0.01` rejects binary floats such as 0.07, so the published spec couldn't state the rule.
- **Holdback without a program.** A held bonus with no `programId` takes the partner-wide holdback (`PartnerCommission` with `programId` null). With none, it waits for an admin, like any commission with no holdback.
- **`Bonus.bountyId`** is a plain column in PR A. Its foreign key arrives with the `Bounty` table in PR B.
- **Fee estimates.** The ops console's fee estimate skipped a tenant with no conversions. It now keeps one whose bonuses carry a new-rule fee.
- **Database.** `Commission_bonusId_unique` (partial) keeps it one commission per bonus. `UsageLedger` gets the same last-line unique per report, (`tenantId`, `reportKey`, `bonusId`, `currency`), as it has for `eventId`.

§10, as decided for PR A: a manual bonus defaults to **approved, paid next run** (`hold: true` opts into the holdback), and **paid bonuses are not clawed back automatically**.

## 12. Implementation notes (PR B)

- **Export is schemaVersion 7, not 6.** PR A bumped to 6 for `Bonus`. PR B adds `Bounty`, and `export.ts` bumps the version whenever the table set changes, because A and B can deploy apart: a v6 instance would accept a bundle with bounties and silently drop them.
- **The shared metric query** is `performance-metric.ts`. `tierMetric` now calls it with its window ending at the accrued event (same-instant ties broken by id, as before), so tiers are unchanged: same filters, same share ratio, no refund netting. Bounties pass [startsAt, endsAt) and `netOfRefunds`. Events are a type list, `sales` (non-corrective with a value above 0), or `all` (non-corrective; the `commissions` metric uses it). The query groups by partner, so the sweep measures a program's partners in one statement per 1,000.
- **Refunds** come off through `metadata.conversionEventId`, as §7 says. A refund recorded only from Stripe's `charge.refunded` on self-host carries an invoice id instead, so it doesn't reduce a `conversions` or `revenue` bounty. It does reduce `commissions` (the refund reverses or claws back the commission). Matching those refunds the way the fee meter does (`usage-ledger.ts` STRIPE_SHARE) is a possible follow-up.
- **The `commissions` window** is the conversion's event time, like every other metric, not the commission's accrual time.
- **Eligibility** is a `PartnerProgram` grant for the bounty's program, not revoked, and the allowlist when there is one.
- **Status transitions:** draft → active or archived, active → ended or archived, and ended → active only once its end date is later than now.
- **What locks.** After the first award, `startsAt` and `partnerIds` lock along with the goal fields, which leaves only name, description, endsAt (later only) and status editable, as §7 says. A changed end date re-arms the "ending soon" email.
- **Emails.** The one opt-out scope that exists, `brand_setup`, covers platform mail. Brand-to-partner mail follows the campaign-ending rules instead: activated partners with portal access, not revoked.
  - "Started" goes out on the first sweep that sees the bounty active and started, so up to an hour after launch.
  - "Ending soon" goes out 7 days before the end, only for bounties that run longer than 7 days (otherwise the start email already says when it ends).
  - Both are stamped on the bounty and sent after the sweep's transaction commits.
- **The re-check at approval** happens in the auto-approve job, as §7 says. An admin's manual approve doesn't re-check: the admin decides.
- **Database.** `Bonus.bountyId` gets its FK, a CHECK that it is set exactly when `source = 'performance_bounty'`, and a unique (`bountyId`, `partnerId`).
- **Marketplace.** Bounties aren't pushed to Network offerings yet. When they are, `renderBountySummary` (packages/db) is the structured text to show. The portal and the emails already use it.
- **API surface.** The bounty routes are admin and portal routes, outside the published OpenAPI document, like the other admin-only screens. `GET /me/bounties` is listed in `HANDLER_GUARDED_ROUTES_OUTSIDE_SPEC`.

§10, as decided for PR B: a bounty's description is **plain text** (at most 5,000 characters, line breaks kept, no formatting).
