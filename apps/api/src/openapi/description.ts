/**
 * The spec's introduction (info.description), rendered as the top of the
 * reference page. The scope table is generated from the registered
 * operations, which the drift test checks against the routes, so it can't
 * list a scope a route doesn't honour.
 */

import { NETWORK_FEDERATION_SCOPES } from '../routes/api-keys.js';
import { accessExtension, toOpenApiPath, type DocumentedOperation } from './registry.js';

function scopeTable(operations: DocumentedOperation[]): string {
  const byScope = new Map<string, string[]>();
  for (const op of operations) {
    for (const scope of accessExtension(op.access).scopes) {
      const list = byScope.get(scope) ?? [];
      list.push(`\`${op.method.toUpperCase()} ${toOpenApiPath(op.path)}\``);
      byScope.set(scope, list);
    }
  }
  const rows = [...byScope.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scope, ops]) => `| \`${scope}\` | ${ops.join('<br>')} |`);
  return ['| Scope | Unlocks |', '| --- | --- |', ...rows].join('\n');
}

export function buildDescription(operations: DocumentedOperation[]): string {
  return `
The OpenPartner tenant API: partners, programs, links, attribution, commissions, payouts, reporting, webhooks and export. Use it to run a referral or affiliate program from your own backend, for example an in-app "Refer & earn" page with no separate OpenPartner login. Walkthrough: [Build an in-app referral page](https://github.com/getcoherence/openpartner/blob/main/docs/headless-referral.md).

This document is generated from the API's own request validators. It is served at \`/openapi.json\`, and the rendered reference at \`/docs\`, on every deployment. White-label custom domains don't serve them; use the platform host, e.g. \`https://app.openpartner.dev/api/docs\`.

## Base URL and tenancy

Every path below is relative to your tenant's API base:

| Deployment | API base | Share links |
| --- | --- | --- |
| OpenPartner Cloud | \`https://app.openpartner.dev/api/t/<tenant-slug>\` | \`https://app.openpartner.dev/r/<tenant-slug>/<linkKey>\` |
| Cloud with a white-label domain | \`https://<your-domain>/api\` | \`https://<your-domain>/r/<linkKey>\` |
| Self-hosted, single tenant | your API origin, e.g. \`https://api.example.com\` (or \`<portal>/api\` behind the bundled proxy) | \`<router origin>/r/<linkKey>\` |
| Self-hosted, multi-tenant | \`<api origin>/t/<tenant-slug>\` (or \`<portal>/api/t/<tenant-slug>\`) | \`<router origin>/r/<tenant-slug>/<linkKey>\` |

The slug comes **after** \`/api\`. \`https://app.openpartner.dev/t/<slug>/api/...\` reaches the portal's static site, not the API, and returns HTML. On a multi-tenant deployment a request with no \`/t/<slug>\` prefix fails with \`400 tenant_slug_missing\`, and an unknown slug gets a plain \`404\`. Your slug is the \`/t/<slug>/\` segment in your admin portal's address.

Keys minted through the API are bound to their tenant. A key sent to another tenant's path is \`401 unauthorized\`.

## Authentication

Send a key as a bearer token: \`Authorization: Bearer op_…\`. Keys are server-side credentials: never ship one to a browser or mobile app. There are three kinds:

- **Admin key.** Unscoped, full access to the tenant. Minted with \`POST /api-keys\`, or the deployment's \`ADMIN_API_KEY\` (self-host). The admin portal's session cookie is accepted wherever an admin key is.
- **Scoped key.** Minted with \`POST /api-keys/scoped\` and a list of scopes. It can call only the operations its scopes unlock, and it acts on any partner in the tenant. Calling something it lacks the scope for returns \`403 forbidden_scope\` with the \`required\` scope; calling an operation with no scope returns \`403 forbidden\`. Use one for every integration so a leaked key can't do everything.
- **Partner key.** Minted with \`POST /partners/{id}/api-keys\` by an admin or the partner. It acts as that one partner and can only reach that partner's own resources (\`/partners/{its id}/…\`). Revoking the partner revokes its keys.

Each operation says which of these it accepts. Scopes:

${scopeTable(operations)}

\`partners:read\` also unlocks \`GET /brand-resources\` (brand logo, colours and shareable assets), which this reference doesn't cover yet. The OpenPartner Network federation key holds ${NETWORK_FEDERATION_SCOPES.map((s) => `\`${s}\``).join(', ')}.

**Scoped reads that don't exist yet:** \`GET /partners/{id}/funnel\`, \`/coupons\` and \`/commission-snapshot\` accept no scope. Read them with an admin key from your server, or use \`/timeseries\` (which has \`partners:read\`) for funnel-like counts.

## Requests and responses

- JSON bodies (\`content-type: application/json\`), up to 1 MB. \`POST /import\` takes up to 256 MB on single-tenant installs.
- Errors are \`{ "error": "<code>", "detail": … }\`. Branch on \`error\`; \`detail\` is for humans.
- **Timestamps are ISO-8601 in UTC and must end in \`Z\`**: \`2026-10-16T10:00:00Z\`. An offset such as \`+00:00\` (Python's \`isoformat()\` default) is rejected with \`400 invalid_body\` / \`invalid_query\`.
- Money in major units. Commission and payout amounts, and \`eventValue\` in webhook payloads, are decimal **strings** such as \`"12.50"\`. Report endpoints (dashboard, timeseries, a partner's events list) return JSON numbers.
- Fields may be added to any response at any time. Ignore fields you don't know.
- Send \`X-Request-Id\` to correlate a call; every response echoes one back (generated if you didn't send it). Quote it in support requests.

## Idempotency

\`POST /attribution/events\`, \`POST /attribution/conversions\`, \`POST /attribution/refunds\` and \`POST /coupons/redeem\` take an \`externalEventId\`: your stable id for that one event (required on conversions and refunds). A retry with the same key replays the original result (\`replayed: true\`) and records nothing, even when the duplicates arrive at the same moment. A key reused for a different event is \`409 external_event_id_conflict\`. \`POST /clicks\` is idempotent on the click \`id\`. Other writes are not idempotent: \`POST /partners\` answers a duplicate email with \`409 email_taken\`, so look the partner up with \`GET /partners?email=\`.

## Pagination

\`GET /partners\` and the commission lists are keyset-paginated: pass the response's \`nextCursor\` as \`cursor\` until it is \`null\`. Cursors are opaque. \`GET /partners/{id}/events\` and \`/customers\` use \`limit\` + \`offset\`. \`GET /partners/{id}/payouts\` returns the 200 most recent, and \`GET /webhooks/{id}/deliveries\` the 100 most recent.

## Rate limits

The API shares one limit of **600 requests per 5 minutes per client IP** across its routes (a few infrastructure paths are exempt). A backend calls from one IP, so that is your whole integration's budget, event ingest included: at four calls per page view, about 150 uncached page views per 5 minutes. Cache partner stats for a few minutes, don't let users force a refresh, and report events from a queue that backs off on \`429\`. Over the limit you get \`429 rate_limited\` with the IETF \`RateLimit\` and \`RateLimit-Policy\` headers.

\`POST /attribution/identify\` has its own limit of 120 per minute per IP, answered with \`429 rate_limited\` and \`Retry-After\`. When the browser SDK calls it, that is each visitor's IP; when your backend calls it, every stitch counts against your backend's IP, so prefer the browser for identify at volume.

## Webhooks

Subscribe with \`POST /webhooks\`; the event catalogue is under **Webhook events**. Each delivery is a JSON \`POST\` of an envelope \`{ id, event, created, data }\` with:

| Header | Value |
| --- | --- |
| \`X-OpenPartner-Signature\` | hex HMAC-SHA256 of \`<timestamp>.<raw body>\`, keyed with the endpoint's secret (the whole \`whsec_…\` string) |
| \`X-OpenPartner-Timestamp\` | Unix seconds when the attempt was signed |
| \`X-OpenPartner-Event\` | the event type |
| \`X-OpenPartner-Delivery\` | the envelope \`id\` |

To verify a delivery, recompute the HMAC over the **raw** request body, before any JSON parsing, and compare it in constant time. Reject timestamps more than 5 minutes from now. Then dedupe on \`id\`:

\`\`\`js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, headers, secret) {
  const ts = headers['x-openpartner-timestamp'];
  const sig = headers['x-openpartner-signature'] ?? '';
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(\`\${ts}.\${rawBody}\`).digest('hex'));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
\`\`\`

Delivery is at most once per trigger: a non-2xx answer, a redirect, or no answer within 10 seconds marks the delivery failed, and **failed deliveries are not retried automatically**. Find them with \`GET /webhooks/{id}/deliveries\` and resend with \`POST /webhooks/{id}/deliveries/{deliveryId}/retry\`. A resend carries the same \`id\` and a fresh signature. Treat webhooks as notifications and the list endpoints as the record: reconcile from \`GET /commissions\` if you can't afford to miss one.

Endpoints must be publicly reachable. Private, loopback and link-local destinations are refused at delivery time, and OpenPartner Cloud delivers only to ports 80 and 443. A single-tenant self-host can allow specific private ranges with \`OPENPARTNER_OUTBOUND_ALLOW_PRIVATE_CIDRS\`.
`.trim();
}
