-- Corrective-event attribution audit — READ ONLY.
--
-- Finds Attribution / Commission rows on corrective events (refund,
-- dispute_created, invoice_payment_failed). These events are never meant to
-- be attributed: the Stripe webhook records them with a NEGATIVE value and
-- skips attribution. Before fix/backlog-skip-corrective-events, a backlog
-- replay (a new identify() stitch, or POST /clicks/:id/unflag) selected them
-- anyway, because they have no Attribution row, and ran them through the
-- commission rules:
--   percent rule → NEGATIVE accrued commission (a second clawback on top of
--                  the refund's reversal of the original commission)
--   fixed rule   → POSITIVE bounty paid on a refund / dispute / failed payment
-- A merchant could also send these types to POST /attribution/events or
-- /coupons/redeem, which attributed them live (value is non-negative on
-- those routes, so a percent rule paid a positive commission too).
--
-- `origin` separates the two sources: Stripe-webhook events can only have
-- been attributed by a backlog replay; API / coupon ones may have been
-- attributed live by the merchant's own call.
--
-- RLS is FORCED on these tables (owner included), so the session turns
-- row security off to see every tenant: run it as the privileged role
-- the API's cross-tenant pool uses (BYPASSRLS or superuser). Any other role
-- gets an error instead of a silently empty result. (The app.platform_admin
-- override these files used to set no longer widens any policy, since
-- 20261017100000_rls_plain_tenant_policies.) Running inside a READ ONLY
-- transaction guarantees nothing is written. Run with psql:
--   psql "$DATABASE_URL" -f docs/corrective-attribution-audit.sql

BEGIN TRANSACTION READ ONLY;
SET LOCAL row_security = off;

-- 1. Money per tenant: commissions on corrective events by event type,
-- origin, sign and ledger status. A paid/approved negative row has already
-- reduced (or will reduce) a partner's payout; a paid positive row was cash
-- out the door for a refund.
WITH corrective AS (
  SELECT e.*,
         CASE
           WHEN e.metadata ? 'stripeEventId' THEN 'stripe_webhook'
           WHEN e.metadata->>'source' = 'coupon' THEN 'coupon_redeem'
           ELSE 'api_or_other'
         END AS origin
  FROM "Event" e
  WHERE e.type IN ('refund', 'dispute_created', 'invoice_payment_failed')
)
SELECT t.slug AS tenant,
       ce.type AS event_type,
       ce.origin,
       CASE WHEN c.amount < 0 THEN 'negative' ELSE 'positive' END AS sign,
       c.status,
       c.currency,
       COUNT(DISTINCT ce.id) AS events,
       COUNT(DISTINCT c."partnerId") AS partners,
       COUNT(c.id) AS commissions,
       SUM(c.amount) AS amount
FROM corrective ce
JOIN "Tenant" t ON t.id = ce."tenantId"
JOIN "Attribution" a ON a."eventId" = ce.id
JOIN "Commission" c ON c."attributionId" = a.id
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY 1, 2, 3, 4, 5, 6;

-- 2. Detail: one row per (attribution, commission) on every attributed
-- corrective event, with partner, ledger state and — for refunds — what the
-- webhook already did to the original invoice's commissions (from the
-- refund Event's metadata). Attributions with no commission (program ended,
-- sub-rule miss) appear with NULL commission columns: analytics noise only.
SELECT t.slug AS tenant,
       e.id AS event_id, e."userId", e.type AS event_type, e.value, e.currency, e.ts AS event_ts,
       CASE
         WHEN e.metadata ? 'stripeEventId' THEN 'stripe_webhook'
         WHEN e.metadata->>'source' = 'coupon' THEN 'coupon_redeem'
         ELSE 'api_or_other'
       END AS origin,
       e.metadata->>'stripeInvoiceId' AS stripe_invoice_id,
       e.metadata->>'fullRefund' AS full_refund,
       e.metadata->>'reversedCommissions' AS webhook_reversed_commissions,
       e.metadata->>'alreadyPaidCommissions' AS webhook_already_paid_commissions,
       a.id AS attribution_id, a.model, a.weight, a."computedAt",
       a."partnerId", p.name AS partner_name, p.email AS partner_email,
       a."programId", a."clickId",
       c.id AS commission_id, c.amount, c.currency AS commission_currency,
       c.status, c."accruedAt", c."paidAt", c."payoutId"
FROM "Event" e
JOIN "Tenant" t ON t.id = e."tenantId"
JOIN "Attribution" a ON a."eventId" = e.id
LEFT JOIN "Partner" p ON p.id = a."partnerId"
LEFT JOIN "Commission" c ON c."attributionId" = a.id
WHERE e.type IN ('refund', 'dispute_created', 'invoice_payment_failed')
ORDER BY t.slug, e.ts, e.id, a."computedAt", c."accruedAt";

-- 3. Cross-check: negative commissions on ANY other event type. Only
-- corrective events carry negative values today (the API routes reject
-- negative `value`), so this should return no rows; anything here is a
-- path this audit's type list doesn't cover.
SELECT t.slug AS tenant, e.id AS event_id, e.type AS event_type, e.value,
       c.id AS commission_id, c."partnerId", c.amount, c.currency, c.status, c."payoutId"
FROM "Commission" c
JOIN "Attribution" a ON a.id = c."attributionId"
JOIN "Event" e ON e.id = a."eventId"
JOIN "Tenant" t ON t.id = c."tenantId"
WHERE c.amount < 0
  AND e.type NOT IN ('refund', 'dispute_created', 'invoice_payment_failed')
ORDER BY t.slug, c."accruedAt";

ROLLBACK;
