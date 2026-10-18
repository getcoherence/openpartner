-- Read-only audit: platform-fee usage already reported to Stripe that
-- included revenue which has since been refunded, charged back, or had all
-- of its commissions reversed.
--
-- Before the UsageLedger (migration 20261017010000_usage_ledger), the usage
-- reporter billed the full value of every attributed revenue event up to a
-- tenant's last report and never took anything back. On its first run after
-- deploy, the ledger opens each tenant at the conversions' billable value AS
-- OF THEN (usage-ledger.ts openLedger), so refunds and reversals recorded
-- before the cutover are NOT credited automatically. This lists them so the
-- credits can be decided by hand (a Stripe customer balance credit for the
-- fee on overbilled_gmv).
--
-- "Already reported" approximates the old reporter: an event with
-- ts <= the tenant's last report that was first attributed by then. The
-- basis expression mirrors basisSql in apps/api/src/usage-ledger.ts; keep
-- the two in step.
--
-- Run with default_transaction_read_only=on. Brand tables FORCE RLS, so as
-- doadmin start with: SET row_security = off;
-- Billable event types: invoice_paid, subscription_created, plus
-- OPENPARTNER_BILLABLE_EVENT_TYPES_EXTRA if the app spec sets it (add them
-- to billable_types below).

SET row_security = off;

-- 1. Who has been reporting usage, and from when.
SELECT
  t.id AS tenant_id,
  t."billingPlan",
  t."stripeCustomerId" IS NOT NULL AS has_customer,
  (SELECT c.value #>> '{}' FROM "Config" c
    WHERE c."tenantId" = t.id AND c.key = 'stripe.merchant.lastUsageReportedAt') AS last_reported_at,
  EXISTS (SELECT 1 FROM "Config" c
    WHERE c."tenantId" = t.id AND c.key = 'stripe.merchant.pendingUsageReport') AS has_pending_report
FROM "Tenant" t
WHERE t."billingPlan" IN ('flex', 'revshare', 'enterprise')
ORDER BY 1;

-- 2. Corrective events and reversed commissions on record at all.
SELECT 'event:' || e.type AS kind, e."tenantId", count(*) AS n, sum(e.value) AS total_value
FROM "Event" e
WHERE e.type IN ('refund', 'chargeback', 'dispute_created', 'invoice_payment_failed')
GROUP BY 1, 2
UNION ALL
SELECT 'commission:reversed', c."tenantId", count(*), sum(c.amount)
FROM "Commission" c
WHERE c.status = 'reversed'
GROUP BY 1, 2
ORDER BY 1, 2;

-- 3. Per conversion: reported at full value, billable now for less.
WITH billable_types(t) AS (VALUES ('invoice_paid'), ('subscription_created')),
reported AS (
  SELECT c."tenantId", (c.value #>> '{}')::timestamptz AS last_reported_at
  FROM "Config" c
  WHERE c.key = 'stripe.merchant.lastUsageReportedAt'
),
api AS (
  SELECT r."tenantId", r.metadata->>'conversionEventId' AS id,
    sum(greatest(-coalesce(r.value, 0), 0)) AS refunded,
    bool_or(r.value IS NULL) AS null_refund
  FROM "Event" r
  WHERE r.type IN ('refund', 'chargeback') AND r.metadata->>'conversionEventId' IS NOT NULL
  GROUP BY 1, 2
),
stripe_refund AS (
  SELECT r."tenantId", r.metadata->>'stripeInvoiceId' AS invoice_id, r.metadata->>'stripePaymentIntentId' AS pi_id,
    CASE
      WHEN r.metadata->>'fullRefund' = 'true' THEN 1
      WHEN coalesce(jsonb_typeof(r.metadata->'amountRefunded'), '') <> 'number'
        OR coalesce(jsonb_typeof(r.metadata->'chargeCollected'), '') <> 'number' THEN 0
      WHEN (r.metadata->>'chargeCollected')::numeric <= 0 THEN 0
      ELSE least(1, greatest(0, (r.metadata->>'amountRefunded')::numeric / (r.metadata->>'chargeCollected')::numeric))
    END AS share
  FROM "Event" r
  WHERE r.type = 'refund' AND r.metadata->>'conversionEventId' IS NULL
),
cm AS (
  SELECT a."eventId", count(c.id) AS n, count(c.id) FILTER (WHERE c.status <> 'reversed') AS live
  FROM "Attribution" a JOIN "Commission" c ON c."attributionId" = a.id
  GROUP BY 1
),
conv AS (
  SELECT e."tenantId", e.id AS event_id, e.type, e.ts, upper(coalesce(e.currency, 'USD')) AS currency,
    e.value AS gross,
    coalesce(api.refunded, 0) AS api_refunded,
    coalesce(api.null_refund, false) AS api_null_refund,
    CASE WHEN e.type = 'invoice_paid' THEN coalesce((
      SELECT max(s.share) FROM stripe_refund s
      WHERE s."tenantId" = e."tenantId"
        AND ((s.invoice_id IS NOT NULL AND s.invoice_id = e.metadata->>'stripeInvoiceId')
          OR (s.pi_id IS NOT NULL AND s.pi_id = e.metadata->>'stripePaymentIntentId'))
    ), 0) ELSE 0 END AS stripe_share,
    coalesce(cm.n, 0) > 0 AND coalesce(cm.live, 0) = 0 AS reversed
  FROM "Event" e
  JOIN reported rp ON rp."tenantId" = e."tenantId"
  LEFT JOIN api ON api."tenantId" = e."tenantId" AND api.id = e.id
  LEFT JOIN cm ON cm."eventId" = e.id
  WHERE e.type IN (SELECT t FROM billable_types)
    AND e.ts <= rp.last_reported_at
    AND (SELECT min(a."computedAt") FROM "Attribution" a WHERE a."eventId" = e.id) <= rp.last_reported_at
),
scored AS (
  SELECT conv.*,
    CASE
      WHEN gross IS NULL OR gross <= 0 OR reversed OR api_null_refund THEN 0
      ELSE greatest(0, round(least(gross - api_refunded, gross * (1 - stripe_share)), 2))
    END AS basis_now
  FROM conv
)
SELECT "tenantId", event_id, type, ts, currency, gross AS reported_gmv, basis_now,
  coalesce(gross, 0) - basis_now AS overbilled_gmv,
  CASE WHEN reversed THEN 'reversed' WHEN api_refunded > 0 OR api_null_refund OR stripe_share > 0 THEN 'refunded' END AS why
FROM scored
WHERE coalesce(gross, 0) - basis_now > 0
ORDER BY 1, ts;

-- 4. Totals per tenant and currency, with the fee at the plan's rate
-- (Flex 1.5%, Revshare 3%; Enterprise is contract-priced, so 0 here).
-- Run 3's CTEs with this final SELECT in place of 3's:
--
-- SELECT s."tenantId", t."billingPlan", s.currency,
--   count(*) AS conversions,
--   sum(coalesce(s.gross, 0) - s.basis_now) AS overbilled_gmv,
--   round(sum(coalesce(s.gross, 0) - s.basis_now)
--     * CASE t."billingPlan" WHEN 'flex' THEN 0.015 WHEN 'revshare' THEN 0.03 ELSE 0 END, 2) AS fee_to_credit
-- FROM scored s JOIN "Tenant" t ON t.id = s."tenantId"
-- WHERE coalesce(s.gross, 0) - s.basis_now > 0
-- GROUP BY 1, 2, 3
-- ORDER BY 1, 3;
