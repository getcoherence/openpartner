# Network federation over-grant — assessment + remediation (Oct 2026)

**Status:** assessment queries ready. **Nothing has been run against
production and no data has been changed.** The remediation below is a
proposal for Keith to decide on.

**Steps 1 and 2 are read-only.** They're plain `SELECT`s and CTEs with
no data-modifying statements, and each session starts with
`SET default_transaction_read_only = on`, so an accidental write in that
session errors instead of running. Only the remediation section changes
data, and none of it is written yet.

## What happened

The Network's approve flow (`openpartner-network` `src/routes/partnerships.ts`
→ `createPartnerOnVendor`) provisions the creator on the brand with
`POST /partners`, scoping the grant via `campaignIds: [offering.vendorProgramId]`.
The Campaign → Program rename (6d1ead0, 2026-05-09) renamed the brand's
zod field to `programIds`. zod strips unknown keys, so `body.data.programIds`
came back undefined and the handler fell into its "grant ALL current
programs" default.

From the first brand deploy containing 6d1ead0 until the alias fix
deploys, every Network-approved creator got:

- a `PartnerProgram` row (`source='offering'`) for **every** program the
  brand had at approval time, instead of just the offering's;
- an auto-minted `Coupon` per extra program. Where the program has a
  `customerReward`, that coupon also provisioned a **live Stripe
  PromotionCode**;
- the ability to mint share links and coupons on those programs, since
  the grant check runs only at link and coupon creation.
- `partner.created` / `partnership.approved` webhooks whose `programIds`
  listed every program, so subscribers (Zapier etc.) got the wrong scope.

Commissions on an extra program were priced at the **offering's
snapshot** (`PartnerCommission` is per-partner, not per-program), not that
program's own rule.

**A brand that already removed the extra grants isn't cleaned up.**
`DELETE /partners/:id/programs/:programId` deletes only the
`PartnerProgram` row. The auto-minted coupon stays active
(`findCouponByCode` checks only `deactivatedAt`), and so does its Stripe
PromotionCode. Links on that program keep redirecting and attributing.
That's why Step 2 looks at coupons, links and attributions too, not just
surviving grants.

Partners approved between 2026-04-28 (scoping shipped) and the rename
deploy were scoped correctly. Admin-added grants (`source='admin'`) aren't
affected.

**Pre-rename brand instances** (a self-hosted brand still on a build
before 6d1ead0) are a different failure. They read `campaignIds`, so the
grant is scoped correctly, but their `POST /partners/:id/links` requires
`campaignId` and the Network sends `programId`. Approve 400s at the link
step after the Partner row already exists, which leaves an orphan (see
remediation step 4). Sending both `programIds` and `campaignIds` doesn't
fix that. It only keeps the orphan scoped to one program. Those brands
have to upgrade to be approvable at all. The Network's comment on
`CreatePartnerInput.programIds` (`src/federation.ts`) says the same
(getcoherence/openpartner-network#6).

## Step 1: Network DB (read-only)

Exports, per brand Partner the Network provisioned, the programs the
brand actually approved it for:

```sql
SET default_transaction_read_only = on;  -- any write in this session now errors

SELECT coalesce(json_agg(t ORDER BY t."partnerId"), '[]'::json) AS intended
FROM (
  SELECT p."vendorPartnerId"                     AS "partnerId",
         array_agg(DISTINCT o."vendorProgramId") AS "programIds"
  FROM "Partnership" p
  JOIN "Offering" o ON o.id = p."offeringId"
  WHERE p."createdAt" >= '2026-05-09'
  GROUP BY p."vendorPartnerId"
) t;
```

`Partnership.vendorPartnerId` is the brand's `Partner.id` (a ULID, unique
across tenants), so you don't need a tenant mapping.

`Partnership` doesn't record which program was approved, so this reads
the Offering's **current** `vendorProgramId`. The brand can change that
after approval (`PATCH /vendors/me/offerings/:id` accepts
`vendorProgramId`). If it did, Step 1 names the wrong program. Step 2
cross-checks it against the approve-time Link and flags the mismatches
(`network_program_mismatch`).

## Step 2: Brand DB (read-only)

Run it as the role in the API's `DATABASE_URL`, the one the privileged
pool and the migrator use. That pool already runs with
`row_security = off`, which only works for a superuser or `BYPASSRLS`
role. Don't use `openpartner_app`, and don't assume "owns the tables" is
enough. `Partner`, `Link`, `Attribution`, `Commission`, `PartnerProgram`
and `Tenant` all have `FORCE ROW LEVEL SECURITY`, so an owner without
`BYPASSRLS` sees **zero rows** when `app.tenant_id` is unset. That
output looks exactly like "no affected partners".

The `SET row_security = off` line below turns that silent filtering into
an error (`query would be affected by row-level security policy`). If
you get that error, switch roles. Don't delete the line. Then check the
sanity count before running the query.

```sql
-- Session setup. Run in the same session as the query below.
SET default_transaction_read_only = on;  -- any write in this session now errors
SET row_security = off;                  -- error, not silent filtering, if this role can't bypass RLS

-- Sanity check: must be > 0. Zero means wrong DB or RLS-filtered role,
-- NOT "no affected partners". Don't run the query until this is right.
SELECT count(*) AS partners, count(DISTINCT "tenantId") AS tenants FROM "Partner";
```

Paste step 1's `intended` value between the `$json$` markers.

```sql
WITH network AS (
  -- Paste step 1's `intended` value between the $json$ markers.
  -- Leaving it as [] falls back to the first-Link heuristic below.
  SELECT n->>'partnerId' AS partner_id,
         ARRAY(SELECT jsonb_array_elements_text(n->'programIds')) AS program_ids
  FROM jsonb_array_elements($json$[]$json$::jsonb) n
),
fed AS (
  SELECT pa."tenantId"                     AS tenant_id,
         pa.id                             AS partner_id,
         pa.email,
         pa.metadata->>'networkCreatorId'  AS network_creator_id,
         pa."createdAt"                    AS created_at,
         pa."revokedAt"                    AS revoked_at,
         n.program_ids                     AS network_program_ids,
         -- Approve mints exactly one Link, on the approved program, right
         -- after POST /partners. Links are never edited or deleted, so the
         -- first one is the approve-time program.
         (SELECT l."programId" FROM "Link" l
           WHERE l."tenantId" = pa."tenantId" AND l."partnerId" = pa.id
           ORDER BY l."createdAt", l.id
           LIMIT 1)                        AS first_link_program_id
  FROM "Partner" pa
  LEFT JOIN network n ON n.partner_id = pa.id
  WHERE pa.metadata->>'source' = 'openpartner_network'
    AND pa."createdAt" >= '2026-05-09'
),
expected AS (
  SELECT f.*,
         coalesce(f.network_program_ids,
                  array_remove(ARRAY[f.first_link_program_id], NULL)) AS expected_program_ids,
         CASE WHEN f.network_program_ids IS NOT NULL THEN 'network'
              WHEN f.first_link_program_id IS NOT NULL THEN 'first_link'
              ELSE 'unknown' END                                      AS expected_source,
         -- Step 1 reads the Offering's CURRENT vendorProgramId, which the
         -- brand can re-point after approval. True = the approve-time Link
         -- is on a program Step 1 doesn't list. Review these by hand.
         coalesce(f.network_program_ids IS NOT NULL
                  AND f.first_link_program_id IS NOT NULL
                  AND NOT (f.first_link_program_id = ANY (f.network_program_ids)),
                  false)                                              AS network_program_mismatch
  FROM fed f
),
seen AS (
  -- Every program the partner shows up on, not only surviving grants.
  -- DELETE /partners/:id/programs/:programId drops the grant row and
  -- nothing else: the coupon, its Stripe promo code and the links stay live.
  SELECT e.tenant_id, e.partner_id, s.program_id
  FROM expected e
  CROSS JOIN LATERAL (
    SELECT pp."programId" AS program_id FROM "PartnerProgram" pp
     WHERE pp."tenantId" = e.tenant_id AND pp."partnerId" = e.partner_id
       AND pp.source = 'offering'
    UNION
    SELECT c."programId" FROM "Coupon" c
     WHERE c."tenantId" = e.tenant_id AND c."partnerId" = e.partner_id
    UNION
    SELECT l."programId" FROM "Link" l
     WHERE l."tenantId" = e.tenant_id AND l."partnerId" = e.partner_id
    UNION
    SELECT a."programId" FROM "Attribution" a
     WHERE a."tenantId" = e.tenant_id AND a."partnerId" = e.partner_id
  ) s
),
pairs AS (
  SELECT e.*, s.program_id
  FROM expected e
  JOIN seen s ON s.tenant_id = e.tenant_id AND s.partner_id = e.partner_id
  WHERE NOT (s.program_id = ANY (e.expected_program_ids))
    -- An admin grant on the program is the brand's own decision.
    AND NOT EXISTS (
      SELECT 1 FROM "PartnerProgram" pp
       WHERE pp."tenantId" = e.tenant_id AND pp."partnerId" = e.partner_id
         AND pp."programId" = s.program_id AND pp.source = 'admin')
)
SELECT t.slug                     AS tenant_slug,
       p.tenant_id,
       p.partner_id,
       p.email,
       p.network_creator_id,
       p.created_at,
       p.revoked_at,
       p.expected_source,
       p.expected_program_ids,
       p.network_program_mismatch,
       p.program_id               AS extra_program_id,
       pr.name                    AS extra_program_name,
       EXISTS (SELECT 1 FROM "PartnerProgram" pp
                WHERE pp."tenantId" = p.tenant_id AND pp."partnerId" = p.partner_id
                  AND pp."programId" = p.program_id) AS grant_present,
       cp.minted_at_approval,
       cp.active_coupons,
       cp.live_promo_codes,
       (SELECT count(*) FROM "Link" l
         WHERE l."tenantId" = p.tenant_id AND l."partnerId" = p.partner_id
           AND l."programId" = p.program_id)         AS links,
       cm.commissions,
       cm.commissions_paid,
       cm.commission_amount,
       cm.commission_paid_amount
FROM pairs p
JOIN "Tenant" t ON t.id = p.tenant_id
LEFT JOIN "Program" pr ON pr.id = p.program_id AND pr."tenantId" = p.tenant_id
CROSS JOIN LATERAL (
  SELECT -- POST /partners auto-mints in the same transaction as the Partner
         -- insert, so an approval-time coupon has the Partner's createdAt.
         coalesce(bool_or(c."createdAt" <= p.created_at + interval '1 minute'), false)
                                                                 AS minted_at_approval,
         count(*) FILTER (WHERE c."deactivatedAt" IS NULL)       AS active_coupons,
         count(*) FILTER (WHERE c."deactivatedAt" IS NULL
                            AND c."stripePromotionCodeId" IS NOT NULL) AS live_promo_codes
  FROM "Coupon" c
  WHERE c."tenantId" = p.tenant_id AND c."partnerId" = p.partner_id
    AND c."programId" = p.program_id
) cp
CROSS JOIN LATERAL (
  SELECT coalesce(sum(s.n), 0)                                     AS commissions,
         coalesce(sum(s.n_paid), 0)                                AS commissions_paid,
         jsonb_object_agg(s.currency, s.amount) FILTER (WHERE s.n > 0)
                                                                   AS commission_amount,
         jsonb_object_agg(s.currency, s.amount_paid) FILTER (WHERE s.n_paid > 0)
                                                                   AS commission_paid_amount
  FROM (
    SELECT cm.currency,
           count(*)       FILTER (WHERE cm.status <> 'reversed') AS n,
           count(*)       FILTER (WHERE cm.status = 'paid')      AS n_paid,
           sum(cm.amount) FILTER (WHERE cm.status <> 'reversed') AS amount,
           sum(cm.amount) FILTER (WHERE cm.status = 'paid')      AS amount_paid
    FROM "Commission" cm
    JOIN "Attribution" a ON a.id = cm."attributionId"
    WHERE cm."tenantId" = p.tenant_id AND cm."partnerId" = p.partner_id
      AND a."programId" = p.program_id
    GROUP BY cm.currency
  ) s
) cm
ORDER BY t.slug, p.created_at, p.partner_id, p.program_id;
```

Each row is one **(partner, extra program)** pair. The program shows up
for that Network-provisioned Partner in a grant, coupon, link or
attribution, sits outside its expected scope, and isn't covered by an
`admin` grant. `expected_source` says where the expected scope came from:

| `expected_source` | Meaning | Confidence |
|---|---|---|
| `network` | Step 1's Partnership/Offering rows | Authoritative, unless `network_program_mismatch` |
| `first_link` | No Network row; the first Link the approve flow minted | Good, but verify. Usually an approve that failed after `POST /partners`. |
| `unknown` | No Network row and no Link; every program the partner touches is listed as extra | Manual review. Probably an orphan from a failed approve. |

The other columns:

| Column | Meaning |
|---|---|
| `network_program_mismatch` | True when the approve-time Link is on a program Step 1 doesn't list, i.e. the offering was probably re-pointed after approval. Expected scope is suspect. **Review these rows by hand**, and don't act on them until you know which program was actually approved. |
| `grant_present` | False = the brand already removed the grant, but whatever the other columns show is still live. |
| `minted_at_approval` | True = a coupon on this program was minted by the `POST /partners` call itself, i.e. the over-grant. False on a `grant_present = false` row means the program came from something later, such as an admin grant since removed or an admin-minted coupon. Check those before treating them as over-grants. |
| `active_coupons` / `live_promo_codes` | Coupons with no `deactivatedAt`, and those of them with a Stripe PromotionCode, which is still redeemable at checkout. |
| `links` | Links on the program. They redirect and attribute regardless of the grant. |
| `commissions` / `commissions_paid` | Non-reversed commissions on the program, and the paid subset. |
| `commission_amount` / `commission_paid_amount` | Same, summed per currency (major units). |

A pair with every count at zero has already been fully cleaned up. It's
listed so the brand's earlier cleanup is visible.

Validated locally against seeded scenarios on a scratch database. These
come back: an over-granted partner; a partner whose extra grants the
brand already deleted (with a live coupon, promo code, link and paid
commission); a `first_link` orphan; an `unknown` orphan; and a re-pointed
offering, which is flagged. These are excluded: correctly scoped
partners, admin-added extra grants, admin-created partners and
pre-window partners. Also checked: under `openpartner_app` the
`row_security = off` line errors instead of returning zero rows, and the
read-only setting rejects an `UPDATE`.

## Proposed remediation (not executed; Keith's call)

1. **Deploy order.** Ship the brand alias fix first: it stops new
   over-grants from every Network version. The Network change (send
   `programIds` + `campaignIds`) can ship in either order. Neither fixes
   a pre-rename brand instance (see "What happened"); those need to
   upgrade.
2. **Run steps 1 + 2** and review per tenant. Treat `unknown` rows and
   `network_program_mismatch` rows by hand.
3. **Per extra (partner, program)**, in this order. That includes pairs
   with `grant_present = false`:
   1. **Coupons**: deactivate each active coupon on the pair through the
      existing `DELETE /partners/:id/coupons/:couponId` path (or the
      same code path in a script). It also disables the Stripe
      PromotionCode. A raw `UPDATE "Coupon"` would leave live promo codes
      redeemable at checkout.
   2. **Grant**: if `grant_present`, remove the `PartnerProgram` row
      (`DELETE /partners/:id/programs/:programId`). That stops new links
      and coupons. It doesn't touch existing ones, which is why the
      coupon step comes first.
   3. **Links**: existing links on extra programs keep redirecting and
      attributing. There's no deactivation column on `Link`, and
      deleting would orphan raw `Click` rows (raw data is immutable).
      **Decision:** leave them, or add a link-deactivation path first.
   4. **Commissions**: accrued on extra programs at the offering's
      snapshot rate. **Decision:** honor them (the creator drove real
      sales through a grant our system issued), or reverse the
      unpaid ones via the existing reversal path and handle paid ones
      with the brand. Leaning: honor paid, review accrued/approved per
      brand.
4. **Orphans** (`unknown` and `first_link` rows, which have no
   Partnership on the Network once Step 1's output is pasted in). The
   approve failed after `POST /partners` succeeded. The Network request
   is still `pending`, and every re-approve fails. `POST /partners` 409s
   `email_taken` because the Partner row already exists, and the Network
   surfaces that as 422 `federation_failed`. Nothing on the brand API
   clears it. `Partner.email` is unique per tenant, the pre-check
   doesn't exclude revoked partners, and there's no delete-partner
   route.

   **Do not revoke the brand Partner as a fix.** Revoke only sets
   `revokedAt`. The email stays taken, so the re-approve still 409s.
   Meanwhile the revoke kills the creator's sessions and API keys, emails
   them a revocation notice (unless `notify: false`), and pushes a
   `revoked` status for them to the Network.

   **Decision:** the orphan needs a different mechanism. Options:
   - **Network adopts the existing Partner on 409.** Change the approve
     flow so that on `email_taken` it looks up the existing brand
     Partner (`GET /partners?email=`, which needs `partners:read` on the
     Network's key). It checks `metadata.networkCreatorId` matches the
     creator, reuses that `vendorPartnerId`, mints a Link if there isn't
     one, then writes the Partnership as usual. This is a Network code
     change and deploy, and it also covers future orphans.
   - **Hand-inserted Partnership row on the Network.** For a
     `first_link` orphan, insert a `Partnership` with `vendorPartnerId`
     set to the brand Partner id and `vendorLinkKey` / `publicShareUrl`
     from its first Link, and flip the `PartnershipRequest` to
     `approved`. `unknown` orphans have no Link, so one has to be minted
     first (`POST /partners/:id/links` on the brand). It's a manual write
     to the Network DB. It has to fill `creatorSlug` (NOT NULL) and the
     terms-snapshot columns the way approve does. The brand side already
     has its `PartnerCommission` snapshot, because the orphan's
     `POST /partners` succeeded.

   Either way, fix the orphan's over-grant first (step 3). It holds
   every program the brand had. For an `unknown` orphan, Step 2 lists
   every program as extra, including the one it applied for. Get that
   program from its pending `PartnershipRequest` on the Network
   (`creatorId` = `network_creator_id`, then the request's Offering's
   `vendorProgramId`) before stripping anything.
5. **Brand comms**: affected brands saw creators listed under programs
   they never approved, and got webhooks with the wrong `programIds`.
   Whether to notify them is a separate decision.

The remediation itself should be a dry-run-by-default script that goes
through the app's code paths (Stripe sync, tenant scoping), not raw SQL.
Write it once the decisions above are made.
