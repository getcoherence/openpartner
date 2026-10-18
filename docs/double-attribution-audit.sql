-- Double-attribution audit — READ ONLY.
--
-- Finds events credited more than once: Attribution weight per event summing
-- past 1. Before fix/identify-backlog-reattribution, a backlog replay (a new
-- identify() stitch, or POST /clicks/:id/unflag over a paid commission) could
-- add a second last_click row at weight 1 for a different click — and a
-- second full Commission. Linear/position events could gain an extra
-- fractional row without the old ones being rescaled.
--
-- Weight is summed across ALL models: every Attribution row accrues its own
-- Commission, so an event attributed under two models is paid twice too.
-- The 0.005 slack absorbs 4-dp weight rounding (6 × 0.1667 = 1.0002;
-- position with 3 middles = 1.0001) and still catches one extra linear
-- touch on events with up to ~200 touches.
--
-- RLS is FORCED on these tables (owner included), so the session turns
-- row security off to see every tenant: run it as the privileged role
-- the API's cross-tenant pool uses (BYPASSRLS or superuser). Any other role
-- gets an error instead of a silently empty result. (The app.platform_admin
-- override these files used to set no longer widens any policy, since
-- 20261017100000_rls_plain_tenant_policies.) Running inside a READ ONLY
-- transaction guarantees nothing is written. Run with psql:
--   psql "$DATABASE_URL" -f docs/double-attribution-audit.sql

BEGIN TRANSACTION READ ONLY;
SET LOCAL row_security = off;

-- 1. Counts per tenant.
WITH over AS (
  SELECT "eventId", SUM(weight) AS total_weight
  FROM "Attribution"
  GROUP BY "eventId"
  HAVING SUM(weight) > 1.005
)
SELECT t.slug AS tenant,
       COUNT(*) AS affected_events,
       MAX(o.total_weight) AS worst_total_weight
FROM over o
JOIN "Event" e ON e.id = o."eventId"
JOIN "Tenant" t ON t.id = e."tenantId"
GROUP BY t.slug
ORDER BY affected_events DESC;

-- 2. Money on the affected events, split into the ORIGINAL credit (rows from
-- the event's first attribution pass) and the LATE credit (rows a later
-- replay added — the overpayment). Attribution.computedAt defaults to the
-- inserting transaction's start time, so one pass shares one computedAt.
WITH over AS (
  SELECT "eventId", MIN("computedAt") AS first_pass
  FROM "Attribution"
  GROUP BY "eventId"
  HAVING SUM(weight) > 1.005
)
SELECT t.slug AS tenant,
       CASE WHEN a."computedAt" > o.first_pass THEN 'late' ELSE 'original' END AS credit,
       c.status,
       c.currency,
       COUNT(c.id) AS commissions,
       SUM(c.amount) AS amount
FROM over o
JOIN "Attribution" a ON a."eventId" = o."eventId"
JOIN "Commission" c ON c."attributionId" = a.id
JOIN "Tenant" t ON t.id = a."tenantId"
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3, 4;

-- 3. Detail: one row per (attribution, commission) on every affected event,
-- with partner, click and ledger state. Attributions with no commission
-- (program ended, sub-rule miss) appear with NULL commission columns.
WITH over AS (
  SELECT "eventId", SUM(weight) AS total_weight, COUNT(*) AS attribution_rows,
         COUNT(DISTINCT model) AS models, MIN("computedAt") AS first_pass
  FROM "Attribution"
  GROUP BY "eventId"
  HAVING SUM(weight) > 1.005
)
SELECT t.slug AS tenant,
       e.id AS event_id, e."userId", e.type AS event_type, e.value, e.currency, e.ts AS event_ts,
       o.total_weight, o.attribution_rows, o.models,
       a.id AS attribution_id, a.model, a.weight, a."computedAt",
       CASE WHEN a."computedAt" > o.first_pass THEN 'late' ELSE 'original' END AS credit,
       a."partnerId", p.name AS partner_name,
       a."clickId", k.ts AS click_ts, k."landingUrl",
       c.id AS commission_id, c.amount, c.currency AS commission_currency,
       c.status, c."accruedAt", c."paidAt", c."payoutId"
FROM over o
JOIN "Event" e ON e.id = o."eventId"
JOIN "Tenant" t ON t.id = e."tenantId"
JOIN "Attribution" a ON a."eventId" = o."eventId"
LEFT JOIN "Partner" p ON p.id = a."partnerId"
LEFT JOIN "Click" k ON k.id = a."clickId"
LEFT JOIN "Commission" c ON c."attributionId" = a.id
ORDER BY t.slug, e.ts, e.id, a."computedAt", a.weight DESC, c."accruedAt";

ROLLBACK;
