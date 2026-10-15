# Network federation over-grant — assessment + remediation (Oct 2026)

**Status:** assessment queries ready. **Nothing has been run against
production and no data has been changed.** The remediation below is a
proposal for Keith to decide on.

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

Partners approved between 2026-04-28 (scoping shipped) and the rename
deploy were scoped correctly. Admin-added grants (`source='admin'`) aren't
affected.

## Step 1: Network DB (read-only)

Exports, per brand Partner the Network provisioned, the programs the
brand actually approved it for:

```sql
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

## Step 2: Brand DB (read-only)

Paste step 1's `intended` value between the `$json$` markers. Run it as
the owner/migration role, because `openpartner_app` is under RLS and sees
one tenant at most.

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
         -- Approve mints exactly one Link, on the offering's program,
         -- right after POST /partners. Fallback for Partners with no
         -- Network Partnership row (approve failed after POST /partners).
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
              ELSE 'unknown' END                                      AS expected_source
  FROM fed f
),
extra AS (
  SELECT e.tenant_id, e.partner_id,
         array_agg(pp."programId" ORDER BY pp."programId") AS extra_program_ids
  FROM expected e
  JOIN "PartnerProgram" pp
    ON pp."tenantId" = e.tenant_id AND pp."partnerId" = e.partner_id
  WHERE pp.source = 'offering'
    AND NOT (pp."programId" = ANY (e.expected_program_ids))
  GROUP BY e.tenant_id, e.partner_id
)
SELECT t.slug                                    AS tenant_slug,
       e.tenant_id,
       e.partner_id,
       e.email,
       e.network_creator_id,
       e.created_at,
       e.revoked_at,
       e.expected_source,
       e.expected_program_ids,
       (SELECT array_agg(pp."programId" ORDER BY pp."programId")
          FROM "PartnerProgram" pp
         WHERE pp."tenantId" = e.tenant_id AND pp."partnerId" = e.partner_id) AS granted_program_ids,
       x.extra_program_ids,
       (SELECT count(*) FROM "Coupon" c
         WHERE c."tenantId" = e.tenant_id AND c."partnerId" = e.partner_id
           AND c."programId" = ANY (x.extra_program_ids)
           AND c."deactivatedAt" IS NULL)          AS active_extra_coupons,
       (SELECT count(*) FROM "Coupon" c
         WHERE c."tenantId" = e.tenant_id AND c."partnerId" = e.partner_id
           AND c."programId" = ANY (x.extra_program_ids)
           AND c."deactivatedAt" IS NULL
           AND c."stripePromotionCodeId" IS NOT NULL) AS live_extra_stripe_promos,
       (SELECT count(*) FROM "Link" l
         WHERE l."tenantId" = e.tenant_id AND l."partnerId" = e.partner_id
           AND l."programId" = ANY (x.extra_program_ids)) AS extra_links,
       (SELECT count(*) FROM "Commission" cm
          JOIN "Attribution" a ON a.id = cm."attributionId"
         WHERE cm."tenantId" = e.tenant_id AND cm."partnerId" = e.partner_id
           AND a."programId" = ANY (x.extra_program_ids)
           AND cm.status <> 'reversed')            AS extra_commissions,
       (SELECT count(*) FROM "Commission" cm
          JOIN "Attribution" a ON a.id = cm."attributionId"
         WHERE cm."tenantId" = e.tenant_id AND cm."partnerId" = e.partner_id
           AND a."programId" = ANY (x.extra_program_ids)
           AND cm.status = 'paid')                 AS extra_commissions_paid,
       (SELECT jsonb_object_agg(s.currency, s.total) FROM (
          SELECT cm.currency, sum(cm.amount) AS total
            FROM "Commission" cm
            JOIN "Attribution" a ON a.id = cm."attributionId"
           WHERE cm."tenantId" = e.tenant_id AND cm."partnerId" = e.partner_id
             AND a."programId" = ANY (x.extra_program_ids)
             AND cm.status <> 'reversed'
           GROUP BY cm.currency) s)                AS extra_commission_amount
FROM expected e
JOIN extra x    ON x.tenant_id = e.tenant_id AND x.partner_id = e.partner_id
JOIN "Tenant" t ON t.id = e.tenant_id
ORDER BY t.slug, e.created_at;
```

Each row is a Network-provisioned Partner holding at least one
`source='offering'` grant outside its expected scope. `expected_source`
says where the expected scope came from:

| `expected_source` | Meaning | Confidence |
|---|---|---|
| `network` | Step 1's Partnership/Offering rows | Authoritative |
| `first_link` | No Network row; the first Link the approve flow minted | Good, but verify. Usually an approve that failed after `POST /partners`. |
| `unknown` | No Network row and no Link; every `offering` grant is listed as extra | Manual review. Probably an orphan from a failed approve. |

Validated locally against seeded scenarios. Correctly scoped partners,
admin-added extra grants, admin-created partners and pre-window partners
are all excluded.

## Proposed remediation (not executed; Keith's call)

1. **Deploy order.** Ship the brand alias fix first: it stops new
   over-grants from every Network version. The Network change (send
   `programIds` + `campaignIds`) can ship in either order.
2. **Run steps 1 + 2** and review per tenant. Treat `unknown` rows by
   hand.
3. **Per extra (partner, program)**, in this order:
   1. **Coupons**: deactivate each active extra coupon through the
      existing `DELETE /partners/:id/coupons/:couponId` path (or the
      same code path in a script). It also disables the Stripe
      PromotionCode. A raw `UPDATE "Coupon"` would leave live promo codes
      redeemable at checkout.
   2. **Grant**: remove the `PartnerProgram` row
      (`DELETE /partners/:id/programs/:programId`). That stops new links
      and coupons. It doesn't touch existing ones.
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
4. **Orphans** (`unknown`, and `first_link` rows with no Partnership):
   the Network request is still `pending`. Every re-approve 409s on
   `email_taken`, because the Partner row already exists. Revoking the
   brand Partner and re-approving on the Network would re-provision it
   scoped correctly (after the fix).
5. **Brand comms**: affected brands saw creators listed under programs
   they never approved, and got webhooks with the wrong `programIds`.
   Whether to notify them is a separate decision.

The remediation itself should be a dry-run-by-default script that goes
through the app's code paths (Stripe sync, tenant scoping), not raw SQL.
Write it once the decisions above are made.
