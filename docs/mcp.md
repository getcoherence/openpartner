# MCP server for agents

OpenPartner runs a read-only [Model Context Protocol](https://modelcontextprotocol.io)
server, so an AI agent such as Claude can read a brand's own attribution
data: programs, partners, tracking links, and what each link, utm_campaign,
partner and program earned. The agent can join that with ad-platform data
it already reads elsewhere (for example from Meta's ads MCP server), by link
URL, utm_campaign or click id.

It reads only. It changes nothing in OpenPartner, and it calls no ad platform.

## Endpoint

The MCP server is at `/mcp` on the brand's API base, the same base as the REST API:

| Deployment | URL |
|---|---|
| Hosted | `https://app.openpartner.dev/api/t/<your-slug>/mcp` |
| Hosted, white-label domain | `https://<your-portal-domain>/api/mcp` |
| Self-hosted | `https://<your-portal>/api/mcp` (or `http://<api-host>:<port>/mcp` direct) |

It uses the Streamable HTTP transport and keeps no state between requests.
Clients on the 2026-07-28 protocol and 2025-era clients both work. The
server sends no notifications, so it refuses `subscriptions/listen` (method
not found) and `GET` answers 405: there's no stream to open. An exchange
that takes longer than 60 seconds is cut off with `504`.

## Authentication

Send an API key as a bearer token:

```
Authorization: Bearer op_…
```

Use a key with only the `reports:read` scope. It unlocks `/mcp` and
nothing else: it can't write, and other routes refuse it. (Like any key, it
can call `GET /auth/introspect`, which only describes the key itself.) Create one in
Admin → Integrations → API keys: untick the default scopes, tick
`reports:read`, and generate. Or call `POST /api-keys/scoped` with
`{ "scopes": ["reports:read"], "label": "Claude" }`. Give each agent its own
key, so you can revoke one without affecting the others (`DELETE /api-keys/:keyId`).

The server checks credentials exactly as the REST API does
(`requireAuth`, `grantScope('reports:read')`, then `requireAdmin`):

- A brand's key works only on that brand's URL. A key from another brand
  gets `401`.
- A full admin key works too, but it can also write elsewhere, so prefer a
  `reports:read` key.
- Partner keys get `403 forbidden`, so a partner can't read the brand's
  numbers here. A scoped key without `reports:read` gets
  `403 forbidden_scope`.
- A signed-in admin's session cookie also works, including a
  [view-only seat](view-only-seats.md). `POST /mcp` is on the viewer
  allow-list because its tools only read.
- On a self-hosted install, the operator's `ADMIN_API_KEY` works too.

Every query runs in the request's tenant transaction, under the same
row-level security as the REST API.

**Audit log.** Tool calls aren't recorded in the [audit log](audit-log.md).
`POST /mcp` is on `NOT_AUDITED` because it only reads, and the log keeps reads
only when they hand over bulk data or credentials. The tools return the
same reports the dashboard shows. Each request still appears in the API's
request log, and revoking the key cuts the agent off.

## Connect a client

**Claude Code**

```bash
claude mcp add --transport http openpartner https://app.openpartner.dev/api/t/<your-slug>/mcp --header "Authorization: Bearer op_…"
```

**Any client with a JSON config** (Cursor, VS Code, the MCP Inspector):

```json
{
  "mcpServers": {
    "openpartner": {
      "type": "http",
      "url": "https://app.openpartner.dev/api/t/<your-slug>/mcp",
      "headers": { "Authorization": "Bearer op_…" }
    }
  }
}
```

**Claude.ai and Claude Desktop custom connectors** sign in with OAuth, which
this server doesn't offer yet. Use a client that can send a header, as above.

**Your own agent**, with the TypeScript SDK:

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client({ name: 'my-agent', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(new URL('https://app.openpartner.dev/api/t/<your-slug>/mcp'), {
    requestInit: { headers: { Authorization: `Bearer ${process.env.OPENPARTNER_API_KEY}` } },
  }),
);
const { structuredContent } = await client.callTool({ name: 'get_performance', arguments: { groupBy: 'link' } });
```

## Tools

Every tool returns JSON as `structuredContent`, described by an output
schema, plus the same JSON as text. Every tool is annotated `readOnlyHint: true`.

| Tool | Returns |
|---|---|
| `list_programs` | Every program, newest first: id, name, status (`scheduled` / `active` / `ended`), destination URL, attribution model and window. Also the brand's default currency. |
| `list_partners` | Partners, newest first: id, name, email, status (`active` / `invited` / `revoked`). Filter by `programId` (enrolled) or `status`. Use `nextCursor` to get the next page. |
| `list_links` | Tracking links, newest first: `linkId`, `linkKey`, `shareUrl` (the URL partners share), `destinationUrl` (where it lands), partner and program. Filter by `partnerId` or `programId`. |
| `get_performance` | Rows grouped by `link`, `utm_campaign`, `partner` or `program` over a window: clicks, signups, paid conversions, attributed revenue and commission. Filter by `programId`, `partnerId` or `linkId`. Sort by `revenue` (default), `clicks`, `conversions` or `commission`. Pages with `limit` / `offset`. |
| `recent_conversions` | One partner's or one link's attributed conversions, newest first, each with the click it came through: `clickId`, utm parameters, landing page, referer, sub-id. Pages with `limit` / `offset`, up to offset 10,000; narrow the window with `since` / `until` to go further back. |

### What `get_performance` counts

A window is `[since, until)`. `until` defaults to now and `since` to 30 days
before it. One call covers at most 366 days.

Everything is counted as the admin dashboard and the Programs page count it
(`GET /admin/overview`, `GET /programs/stats`, both in `reporting.ts`). So a
program row shows that program's stats, and partner rows add up to the
dashboard totals. Amounts here are rounded to the cent per row, and the
dashboard's aren't. Where attribution is split (linear weights such as
0.3333), a row can differ from the dashboard, or rows from their total, by
a cent.

| Field | |
|---|---|
| `clicks` | Clicks in the window, by click time. |
| `attributedEvents` | Attribution rows computed in the window. The dashboard counts conversions this way. |
| `signups` | Distinct `signup` / `trial_started` events among them. |
| `paidConversions` | Distinct events with a value above 0 among them. |
| `revenue[]` | Per currency: `gross` = Σ value × attribution weight. `refunded` = the refunds recorded so far against those conversions. `net` = gross − refunded. A refund named by `POST /attribution/refunds` and a Stripe `charge.refunded` are both counted, as commission tiers and bounties count them. |
| `commission[]` | Per currency, commission accrued in the window, by its status now: `accrued`, `approved`, `paid`, `reversed`. |

Amounts are never converted between currencies. `sort: revenue` and
`sort: commission` rank by the brand's default currency.

Which commission a row holds:

- `link` and `utm_campaign` rows hold all commission paid on their
  conversions, including a recruiter's [two-tier](two-tier-commissions.md)
  share. Bonuses belong to no click, so they appear in no link or
  utm_campaign row.
- `partner` rows hold the partner's own earnings, bonuses included.
- `program` rows assign a bonus to its program, as the Programs page does.

Clicks from a coupon code or `POST /clicks` have no link. Under `link`,
each partner and program gets one row for them, with `linkId: null`.

## Joining with ad data

| Ad-side value | OpenPartner field |
|---|---|
| The ad's destination URL | `shareUrl` (or `linkKey`, its last path segment), from `list_links` or a `link` row |
| `utm_campaign` on the ad's URL | `utmCampaign`, from a `utm_campaign` row or a conversion's `click` |
| The click id your landing page received | `click.clickId`. The router appends it as `cref=<clickId>`, or puts it in a `{click_id}` macro in the destination URL. |

Ad platforms usually date a conversion by the ad click. OpenPartner dates a
conversion by when it was attributed. For a close match on a short window,
pull `recent_conversions` and group by `click.ts`.

## Privacy

The tools return what the brand's own admin API already returns. Conversions
carry the brand's own `userId` for the customer, and a `referralId`. They
carry no customer name or email. Partner email addresses come back, as from
`GET /partners`. No tool returns credentials, payout details or postback
URLs.

## Deployment modes

The server behaves the same in `selfhost`, `flat` and `revshare`. It adds no
table and no column. Single-tenant installs serve it at `/mcp`;
multi-tenant installs serve it at `/t/<slug>/mcp`.

`shareUrl` is the address partners see in the brand's own portal:

- A brand with a verified custom domain gets `https://<domain>/r/<key>`. Its
  links also resolve at `<PORTAL_URL>/r/<slug>/<key>`, the form an admin
  sees when opening the portal through the platform address.
- Other hosted brands get `<PORTAL_URL>/r/<slug>/<key>`.
- A self-hosted single-tenant install gets `<router URL>/r/<key>`, or `null`
  until Admin → Settings → Public router URL is set.

An ad's destination might use either form, so match it on `linkKey`, the
URL's last path segment.

## Not in this version

- Writes of any kind: creating links, approving commissions, paying partners.
- OAuth sign-in. The server takes API keys and sessions only.
- `reports:read` on the REST reports (`GET /admin/overview`, `GET /programs/stats`). It unlocks `/mcp` only.
- Partner-facing access: a partner reading their own numbers.
- Pushing anything to ad platforms, or fetching from them.
- Daily time series. `get_performance` returns one total per row; for a
  series, call it once per day.
