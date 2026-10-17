/**
 * Every documented tenant-API operation.
 *
 * Request schemas are imported from the route modules that validate with
 * them. The few query parameters a route reads without a zod schema
 * (dashboard/funnel `since`, webhook `hard`, export `tenantId`) are
 * described here and marked as such.
 *
 * Adding a route to one of the documented routers fails
 * __tests__/openapi.test.ts until it is registered here or listed in
 * UNDOCUMENTED_ROUTES with a reason.
 */

import { z } from 'zod';
import * as partners from '../routes/partners.js';
import * as programs from '../routes/programs.js';
import * as assignments from '../routes/partner-campaigns.js';
import * as links from '../routes/links.js';
import * as identify from '../routes/identify.js';
import * as events from '../routes/events.js';
import * as clicks from '../routes/clicks.js';
import * as coupons from '../routes/coupons.js';
import * as commissions from '../routes/commissions.js';
import * as dashboard from '../routes/dashboard.js';
import * as webhooks from '../routes/webhooks.js';
import * as apiKeys from '../routes/api-keys.js';
import * as exportRoutes from '../routes/export.js';
import * as settings from '../routes/settings.js';
import { EXPORTABLE_TABLES } from '../export.js';
import type { OperationRegistry } from './registry.js';
import * as S from './schemas.js';

/** Routes outside the documented routers that still honour a scoped key.
 *  The drift test fails on any other scoped route missing from the spec,
 *  so the generated scope table can't silently omit one. */
export const SCOPED_ROUTES_OUTSIDE_SPEC: Record<string, string> = {
  'GET /brand-resources': 'partners:read: brand logo, colours and shareable assets, read by Network creator dashboards.',
};

/** Authenticated routes outside the spec that carry no admin, partner or
 *  scope guard: the handler decides who may call them, so a scoped key
 *  reaches the handler. The drift test fails on any route of that shape
 *  that isn't listed here, so a new one shows up in review. */
const NETWORK_PROXY = 'Partner-facing OpenPartner Network proxy for the portal; the handler checks the caller.';
export const HANDLER_GUARDED_ROUTES_OUTSIDE_SPEC: Record<string, string> = {
  'GET /auth/whoami': 'Who the current session or key is; any authenticated caller.',
  'GET /config/program': 'Program branding the portal renders; any authenticated caller.',
  'GET /network/discover': NETWORK_PROXY,
  'GET /network/offerings/:id': NETWORK_PROXY,
  'POST /network/offerings/:id/apply': NETWORK_PROXY,
  'GET /network/vendors/:id': NETWORK_PROXY,
  'GET /network/me/profile': NETWORK_PROXY,
  'PATCH /network/me/profile': NETWORK_PROXY,
  'GET /network/me/platforms': NETWORK_PROXY,
  'PUT /network/me/platforms/:platform': NETWORK_PROXY,
  'DELETE /network/me/platforms/:platform': NETWORK_PROXY,
  'GET /network/me/requests': NETWORK_PROXY,
  'POST /network/me/requests/:id/cancel': NETWORK_PROXY,
  'GET /network/me/affiliations': NETWORK_PROXY,
  'GET /network/me/affiliations/:id/earnings': NETWORK_PROXY,
  'POST /network/me/uploads/avatar': NETWORK_PROXY,
};

/** Routes on documented routers that are deliberately left out of the spec. */
export const UNDOCUMENTED_ROUTES: Record<string, string> = {
  'POST /partners/backfill-commission-snapshots': 'One-shot maintenance job for pre-snapshot partners, not an integration surface.',
  'GET /openapi.json': 'The spec itself.',
  'GET /docs': 'The rendered reference page.',
};

const sinceQuery = z.object({
  since: z.string().datetime().optional().openapi({ description: 'ISO-8601 start of the window. Default: 30 days ago. Not validated by the route: send a valid timestamp.' }),
});

export function registerPaths(r: OperationRegistry): void {
  // ---------------------------------------------------------------- Partners
  r.operation({
    method: 'post',
    path: '/partners',
    tag: 'Partners',
    operationId: 'createPartner',
    summary: 'Create a partner',
    description: `
Creates a partner and grants it programs.

- \`sendInvite: false\` creates the partner **active immediately** and sends no email. Use this when your own app is the partner's UI (headless / in-app referral). The default sends a magic-link invite.
- \`programIds\` omitted grants **every current program**. Pass an explicit list (even \`[]\`) to control access.
- A coupon is auto-minted per granted program.
- Fires \`partner.created\`.

**Email and portal access.** A \`sendInvite: false\` partner is active, so anyone who knows its email can request a sign-in link on the hosted partner portal (\`POST /auth/signin\`): OpenPartner then emails that address, and the partner can use the portal. There is no setting to turn that off per partner yet. If that matters, give headless partners an address that can't receive mail.

**OpenPartner Network:** this call shares nothing with the OpenPartner Network. A partner's name and email reach it only if the partner opts in themselves, while the tenant offers the Network (\`autoEnroll\` on, \`GET /config/network\`): they're asked on the join page, once on first portal sign-in, and in a portal setting. \`metadata\` is never sent. To keep customer-referral partners from being asked, turn offering off: \`POST /config/network {"autoEnroll": false}\`.

On OpenPartner Cloud the brand needs an active plan (\`402 plan_required\`) and an approved account (\`403 brand_pending_review\`).`,
    access: { kind: 'admin', scope: 'partners:write' },
    body: partners.createSchema.openapi('CreatePartnerRequest'),
    responses: { 201: { description: 'Created.', schema: S.PartnerCreated } },
    errors: { 400: ['unknown_campaign_ids'], 402: ['plan_required'], 403: ['brand_pending_review'], 409: ['email_taken'] },
  });

  r.operation({
    method: 'get',
    path: '/partners',
    tag: 'Partners',
    operationId: 'listPartners',
    summary: 'List or search partners',
    description:
      'Newest first, keyset-paginated. `email` is an exact match ("find by email"); `q` is a case-insensitive substring match on name or email. Filters keep the same order and cursor scheme.',
    access: { kind: 'admin', scope: 'partners:read' },
    query: partners.listQuerySchema,
    responses: { 200: { description: 'One page.', schema: S.PartnerPage } },
    errors: { 400: ['invalid_cursor'] },
  });

  r.operation({
    method: 'get',
    path: '/partners/:id',
    tag: 'Partners',
    operationId: 'getPartner',
    summary: 'Get a partner',
    access: { kind: 'partnerOrAdmin', scope: 'partners:read' },
    responses: { 200: { description: 'The partner.', schema: S.Partner } },
    errors: { 404: ['not_found'] },
  });

  r.operation({
    method: 'post',
    path: '/import/partners-csv',
    tag: 'Partners',
    operationId: 'importPartnersCsv',
    summary: 'Bulk-create partners from CSV',
    description: `
Creates many partners in one request: the way to load an existing customer base without spending your rate limit on one \`POST /partners\` per row.

Send \`text/csv\` with a header row: \`email\` and \`name\` (required), \`activatedAt\` (ISO-8601, default now) and \`metadata\` (a JSON object string, e.g. \`"{""appUserId"":""u_1""}"\`). Quoted fields may contain commas but not line breaks. Tools that can't send \`text/csv\` can POST \`{"csv": "..."}\` as JSON instead.

Unlike \`POST /partners\`, an import:
- grants every partner **every current program** (there is no \`programIds\`),
- sends no email, mints no coupons, fires no \`partner.created\` webhooks,
- shares nothing with the OpenPartner Network: as with \`POST /partners\`, only a partner's own opt-in does.

Rows whose email already exists are reported as \`skipped_email_taken\` with the existing \`partnerId\`, so re-running an import is safe. \`?dryRun=true\` validates and reports without writing. Rows are processed one by one in a single transaction; send large rosters in batches of a few thousand rows.`,
    access: { kind: 'admin', scope: 'partners:write' },
    query: z.object({
      dryRun: z.enum(['true', '1', 'false', '0']).optional().openapi({ description: 'Validate and report without writing. Not validated by the route: only `true` and `1` switch it on.' }),
    }),
    requestContent: {
      'text/csv': { schema: z.string().openapi({ example: 'email,name,metadata\nada@example.com,Ada Lovelace,"{""appUserId"":""u_1""}"\n' }) },
      'application/json': { schema: z.object({ csv: z.string() }) },
    },
    responses: {
      200: {
        description: 'Per-row results.',
        schema: z.object({
          dryRun: z.boolean(),
          summary: z.object({ total: z.number().int(), created: z.number().int(), skipped: z.number().int(), invalid: z.number().int() }),
          report: z.array(
            z.object({
              row: z.number().int().openapi({ description: 'Line number in the file, counting the header as 1.' }),
              email: z.string(),
              status: z.enum(['created', 'skipped_email_taken', 'invalid']),
              reason: z.enum(['invalid_email', 'missing_name', 'metadata_not_valid_json', 'invalid_activatedAt']).optional(),
              partnerId: z.string().optional(),
            }),
          ),
        }),
      },
    },
    errors: { 400: ['empty_body', 'invalid_csv', 'no_rows'], 402: ['trial_expired'], 403: ['brand_pending_review'] },
  });

  r.operation({
    method: 'post',
    path: '/partners/:id/invite',
    tag: 'Partners',
    operationId: 'invitePartner',
    summary: 'Send or resend the invite email',
    description: 'For a partner who has not activated yet. For an applicant held for review, this is also the approval.',
    access: { kind: 'admin', scope: 'partners:write' },
    responses: { 200: { description: 'Sent.', schema: z.object({ ok: z.literal(true), approved: z.boolean() }) } },
    errors: { 404: ['not_found'], 409: ['already_activated'], 422: ['mail_send_failed'] },
  });

  r.operation({
    method: 'post',
    path: '/partners/:id/revoke',
    tag: 'Partners',
    operationId: 'revokePartner',
    summary: 'Suspend a partner',
    description:
      "Ends the partner's sessions and partner keys and stops future attribution to them. Existing links keep redirecting (clicks are flagged `revoked`); past commissions are untouched.",
    access: { kind: 'admin', scope: 'partners:write' },
    body: partners.revokeSchema.openapi('RevokePartnerRequest'),
    responses: {
      200: {
        description: 'Revoked.',
        schema: z.object({ ok: z.literal(true), revokedAt: z.string().datetime(), notified: z.boolean(), notifyError: z.string().nullable() }),
      },
    },
    errors: { 404: ['not_found'], 409: ['already_revoked'] },
  });

  r.operation({
    method: 'post',
    path: '/partners/:id/reinstate',
    tag: 'Partners',
    operationId: 'reinstatePartner',
    summary: 'Undo a revoke',
    access: { kind: 'admin' },
    responses: { 200: { description: 'Reinstated.', schema: S.Ok } },
    errors: { 404: ['not_found'], 409: ['not_revoked'] },
  });

  // One request body, two scopes: partner-wide and per-program.
  const commissionOverrideRequest = partners.overrideSchema.openapi('CommissionOverrideRequest');

  r.operation({
    method: 'get',
    path: '/partners/:id/commission-snapshot',
    tag: 'Partners',
    operationId: 'getPartnerCommissionOverride',
    summary: "Get a partner's commission override",
    access: { kind: 'partnerOrAdmin' },
    responses: { 200: { description: 'The override, or null.', schema: z.object({ snapshot: S.orNull(S.CommissionSnapshot) }) } },
  });

  r.operation({
    method: 'put',
    path: '/partners/:id/commission-snapshot',
    tag: 'Partners',
    operationId: 'setPartnerCommissionOverride',
    summary: "Set a partner's commission override",
    description:
      "Replaces the program's commission rule for this partner's future commissions on every program that has no program-scoped terms for them (see `setPartnerProgramCommission`). Omitting `commissionRules` clears any compound rules.",
    access: { kind: 'admin' },
    body: commissionOverrideRequest,
    responses: { 200: { description: 'Saved.', schema: z.object({ snapshot: S.CommissionSnapshot }) } },
    errors: { 404: ['partner_not_found'] },
  });

  r.operation({
    method: 'delete',
    path: '/partners/:id/commission-snapshot',
    tag: 'Partners',
    operationId: 'clearPartnerCommissionOverride',
    summary: "Clear a partner's commission override",
    description: 'Clears the partner-wide terms only. Program-scoped terms stay.',
    access: { kind: 'admin' },
    responses: { 200: { description: 'Cleared.', schema: S.Ok } },
    errors: { 404: ['partner_not_found'] },
  });

  r.operation({
    method: 'get',
    path: '/partners/:id/programs/:programId/commission',
    tag: 'Partners',
    operationId: 'getPartnerProgramCommission',
    summary: "Get a partner's commission terms on one program",
    access: { kind: 'partnerOrAdmin' },
    responses: { 200: { description: 'The program-scoped terms, or null.', schema: z.object({ snapshot: S.orNull(S.CommissionSnapshot) }) } },
  });

  r.operation({
    method: 'put',
    path: '/partners/:id/programs/:programId/commission',
    tag: 'Partners',
    operationId: 'setPartnerProgramCommission',
    summary: "Set a partner's commission terms on one program",
    description:
      "Same body as `setPartnerCommissionOverride`, for one program. On that program these terms beat the partner-wide override and set the holdback too (omitted = the program's own). The partner doesn't need a grant on the program: terms can be agreed before access, and outlive a revoked grant.",
    access: { kind: 'admin' },
    body: commissionOverrideRequest,
    responses: { 200: { description: 'Saved.', schema: z.object({ snapshot: S.CommissionSnapshot }) } },
    errors: { 404: ['partner_not_found', 'program_not_found'] },
  });

  r.operation({
    method: 'delete',
    path: '/partners/:id/programs/:programId/commission',
    tag: 'Partners',
    operationId: 'clearPartnerProgramCommission',
    summary: "Clear a partner's commission terms on one program",
    description: "Commissions on the program fall back to the partner-wide override, or the program's rule.",
    access: { kind: 'admin' },
    responses: { 200: { description: 'Cleared.', schema: S.Ok } },
    errors: { 404: ['partner_not_found'] },
  });

  // ---------------------------------------------------------------- Programs
  r.operation({
    method: 'get',
    path: '/programs',
    tag: 'Programs',
    operationId: 'listPrograms',
    summary: 'List programs',
    access: { kind: 'admin' },
    responses: { 200: { description: 'All programs, newest first.', schema: S.ProgramList } },
  });

  r.operation({
    method: 'get',
    path: '/me/programs',
    tag: 'Programs',
    operationId: 'listMyPrograms',
    summary: 'Programs the caller can create links for',
    description: "A partner sees its granted programs that are currently active. An admin sees every program. Commission terms aren't included.",
    access: { kind: 'handler', rule: 'admin key or a partner key. Scoped keys get `403 forbidden`.', partner: true },
    responses: { 200: { description: 'Programs.', schema: z.object({ programs: z.array(S.PartnerVisibleProgram) }) } },
  });

  r.operation({
    method: 'post',
    path: '/programs',
    tag: 'Programs',
    operationId: 'createProgram',
    summary: 'Create a program',
    description:
      "A program is one set of terms: commission rule, attribution window and model, destination URL.\n\n`shareOnNetwork` defaults to **true** when the tenant is on the OpenPartner Network, which lists the program on the public marketplace and makes `marketplaceDescription` required. Pass `shareOnNetwork: false` for a private program such as customer referral.\n\n`holdbackDays` above 0 means commissions are **approved automatically** that many days after they accrue (by the scheduled jobs), and then paid by the next payout run. 0 or omitted means every commission waits for `POST /commissions/{id}/approve`.",
    access: { kind: 'admin' },
    body: programs.createSchema.openapi('CreateProgramRequest'),
    responses: { 201: { description: 'Created.', schema: S.Program } },
    errors: { 402: ['trial_expired'] },
  });

  r.operation({
    method: 'patch',
    path: '/programs/:id',
    tag: 'Programs',
    operationId: 'updateProgram',
    summary: 'Update a program',
    description: 'Changes apply to future commissions. Partners with a commission override keep it.',
    access: { kind: 'admin' },
    body: programs.updateSchema.openapi('UpdateProgramRequest'),
    responses: { 200: { description: 'The updated program.', schema: S.Program } },
    errors: { 404: ['not_found'] },
  });

  // ------------------------------------------------------ Program assignments
  r.operation({
    method: 'get',
    path: '/partners/:id/programs',
    tag: 'Program assignments',
    operationId: 'listPartnerPrograms',
    summary: "List programs with this partner's grant state",
    access: { kind: 'admin' },
    responses: { 200: { description: 'Every program, flagged granted or not.', schema: z.object({ programs: z.array(S.ProgramGrant) }) } },
    errors: { 404: ['partner_not_found'] },
  });

  r.operation({
    method: 'post',
    path: '/partners/:id/programs',
    tag: 'Program assignments',
    operationId: 'grantPartnerPrograms',
    summary: 'Grant programs to a partner',
    description: 'Idempotent. Unknown program ids are skipped. Mints a coupon per newly granted program.',
    access: { kind: 'admin' },
    body: assignments.addSchema.openapi('GrantProgramsRequest'),
    responses: { 201: { description: 'The program ids granted.', schema: z.object({ added: z.array(z.string()) }) } },
    errors: { 404: ['partner_not_found', 'no_valid_campaigns'] },
  });

  r.operation({
    method: 'delete',
    path: '/partners/:id/programs/:programId',
    tag: 'Program assignments',
    operationId: 'revokePartnerProgram',
    summary: 'Revoke a program grant',
    description: "Blocks new links on that program and retires the partner's coupons on it. Existing links keep redirecting.",
    access: { kind: 'admin' },
    responses: { 200: { description: 'Revoked.', schema: z.object({ ok: z.literal(true), retiredCoupons: z.array(z.string()) }) } },
    errors: { 404: ['grant_not_found'] },
  });

  // ------------------------------------------------------------------- Links
  r.operation({
    method: 'get',
    path: '/partners/:id/links',
    tag: 'Links',
    operationId: 'listPartnerLinks',
    summary: "List a partner's links",
    access: { kind: 'partnerOrAdmin', scope: 'links:read' },
    responses: { 200: { description: 'Newest first.', schema: z.object({ links: z.array(S.Link) }) } },
  });

  r.operation({
    method: 'post',
    path: '/partners/:id/links',
    tag: 'Links',
    operationId: 'createPartnerLink',
    summary: 'Create a share link',
    description:
      "`linkKey` is the short code in the share URL and is unique per tenant. A partner caller must hold a grant for the program; admin and scoped callers don't. `destinationUrl` overrides the program's destination only when the program allows deep links to that host.",
    access: { kind: 'partnerOrAdmin', scope: 'links:write' },
    body: links.createSchema.openapi('CreateLinkRequest'),
    responses: { 201: { description: 'Created.', schema: S.Link } },
    errors: {
      400: ['destination_override_not_allowed'],
      403: ['campaign_not_granted'],
      404: ['partner_not_found', 'campaign_not_found'],
      409: ['linkKey_taken', 'campaign_not_active'],
    },
  });

  // ------------------------------------------------------------- Attribution
  r.operation({
    method: 'post',
    path: '/attribution/identify',
    tag: 'Attribution',
    operationId: 'identify',
    summary: 'Stitch a click to a user',
    description: `
Links the click id (\`cref\`) a visitor arrived with to your user id. The browser SDK calls this on signup and login; your backend can call it instead if it receives the \`cref\`.

Repeat calls for the same pair are no-ops. Events already recorded for the user are attributed when the stitch lands (\`backfilledAttributions\`). Calling it on login too stitches a user who clicked on another device; until a pending fix ships, a second click stitched to a user with already-attributed events can credit those events again, so prefer calling it at signup.

Unauthenticated by design. It accepts any origin (CORS) and is limited to 120 requests per minute per client IP. Use the same \`userId\` you later send to \`POST /attribution/events\`.`,
    access: { kind: 'public' },
    body: identify.schema.openapi('IdentifyRequest'),
    responses: { 200: { description: 'Stitched (or already stitched).', schema: S.IdentifyResult } },
    errors: { 404: ['click_not_found'], 429: ['rate_limited'] },
  });

  r.operation({
    method: 'post',
    path: '/attribution/events',
    tag: 'Attribution',
    operationId: 'recordEvent',
    summary: 'Record a conversion event',
    description: `
Server-to-server conversion ingest. The event is attributed to the partner whose click the user was stitched to (within the program's window and model) and commissions accrue.

**Event types.** Any string is accepted. Two have built-in meaning:
- \`signup\` is the funnel's *signups* stage (\`signup\` and \`trial_started\` are *leads* in the timeseries).
- \`invoice_paid\` is the funnel's *paid* stage, and on OpenPartner Cloud it is billable GMV, as is \`subscription_created\`. Report payments as \`invoice_paid\`. Other types with a value still accrue commission but are not counted as GMV.

\`value\` is in major units (\`49.99\`), defaulting to no value; \`currency\` defaults to USD.

**Idempotency.** Always send \`externalEventId\`: your system's stable id for this one event (invoice id, order id, deal id + stage). A retry with the same key returns \`200\` with \`replayed: true\` and the original result, writing nothing. Reusing a key for a different userId, type, value or currency returns \`409 external_event_id_conflict\`. Keys are per tenant, up to 120 characters, and shared with \`POST /coupons/redeem\`.

**Don't report a payment twice.** If your Stripe account also sends webhooks to this deployment (\`/webhooks/stripe\`, self-host), those payments are already recorded, keyed by the Stripe event id. Reporting the same payment here under your own invoice id records it a second time.`,
    access: { kind: 'admin', scope: 'events:write' },
    body: events.schema.openapi('RecordEventRequest'),
    responses: { 200: { description: 'Recorded (or replayed).', schema: S.EventResult } },
    errors: { 409: ['external_event_id_conflict'] },
  });

  r.operation({
    method: 'post',
    path: '/clicks',
    tag: 'Attribution',
    operationId: 'ingestClick',
    summary: 'Ingest a click recorded elsewhere',
    description:
      "For callers that run their own redirect (the OpenPartner Network's creator domains use it). Partner and program are derived from `linkKey`, never trusted from the caller. Idempotent on `id`. Most integrations don't need this: the click router records clicks itself.",
    access: { kind: 'admin', scope: 'clicks:write' },
    body: clicks.ingestSchema.openapi('IngestClickRequest'),
    responses: {
      201: { description: 'Recorded.', schema: S.ClickIngestResult },
      200: { description: 'Already recorded (`replayed: true`).', schema: S.ClickIngestResult },
    },
    errors: { 404: ['link_not_found'] },
  });

  // ----------------------------------------------------------------- Coupons
  r.operation({
    method: 'get',
    path: '/partners/:id/coupons',
    tag: 'Coupons',
    operationId: 'listPartnerCoupons',
    summary: "List a partner's coupon codes",
    description: 'Includes deactivated codes, with 90-day redemption counts and revenue.',
    access: { kind: 'partnerOrAdmin' },
    responses: { 200: { description: 'Oldest first.', schema: z.object({ coupons: z.array(S.CouponWithStats) }) } },
  });

  r.operation({
    method: 'post',
    path: '/partners/:id/coupons',
    tag: 'Coupons',
    operationId: 'createPartnerCoupon',
    summary: 'Mint a coupon code',
    description:
      'Admins can mint any code. Partners and `partners:write` keys can mint only on programs with `partnersMayCustomizeCode`, up to 5 active and 10 per day per program, and never a code that already exists in Stripe. `code` defaults to a generated one.',
    access: {
      kind: 'handler',
      rule: "admin key; the partner's own key when the program has `partnersMayCustomizeCode` and the partner holds a grant; or a scoped key with `partners:write` when the program has `partnersMayCustomizeCode`.",
      scopes: ['partners:write'],
      partner: true,
    },
    body: coupons.createSchema.openapi('CreateCouponRequest'),
    responses: { 201: { description: 'Minted.', schema: S.Coupon } },
    errors: {
      402: ['trial_expired'],
      403: ['partner_customization_disabled', 'campaign_not_granted'],
      404: ['partner_not_found', 'program_not_found'],
      409: ['verification_required', 'active_codes_cap_reached', 'code_taken', 'campaign_not_active'],
      429: ['daily_code_limit_reached'],
      503: ['code_check_unavailable'],
    },
  });

  r.operation({
    method: 'delete',
    path: '/partners/:id/coupons/:couponId',
    tag: 'Coupons',
    operationId: 'deactivatePartnerCoupon',
    summary: 'Deactivate a coupon code',
    description: 'Idempotent. Users the code already stitched keep attributing; new redemptions of it stop.',
    access: {
      kind: 'handler',
      rule: 'same as minting: admin key, or the partner / a `partners:write` key when the program has `partnersMayCustomizeCode`.',
      scopes: ['partners:write'],
      partner: true,
    },
    responses: { 200: { description: 'The deactivated coupon.', schema: S.Coupon } },
    errors: { 403: ['partner_customization_disabled', 'campaign_not_granted'], 404: ['coupon_not_found', 'program_not_found'] },
  });

  r.operation({
    method: 'post',
    path: '/coupons/redeem',
    tag: 'Coupons',
    operationId: 'redeemCoupon',
    summary: 'Record a coupon redemption',
    description:
      'Call from your checkout when a customer uses a partner code. Records the conversion and stitches the user to the partner, so their later events attribute too. `externalEventId` is required and works as on `POST /attribution/events` (same namespace).',
    access: { kind: 'admin', scope: 'events:write' },
    body: coupons.redeemSchema.openapi('RedeemCouponRequest'),
    responses: {
      201: { description: 'Recorded.', schema: S.CouponRedeemResult },
      200: { description: 'Replayed (`replayed: true`).', schema: S.CouponRedeemResult },
    },
    errors: { 404: ['coupon_not_found'], 409: ['external_event_id_conflict'] },
  });

  // ------------------------------------------------------------- Commissions
  const commissionListDescription =
    'Newest accrual first, keyset-paginated: pass `nextCursor` back as `cursor`. Lifecycle: `accrued` → `approved` → `paid`, or `reversed`.';
  r.operation({
    method: 'get',
    path: '/partners/:id/commissions',
    tag: 'Commissions',
    operationId: 'listPartnerCommissions',
    summary: "List a partner's commissions",
    description: commissionListDescription,
    access: { kind: 'partnerOrAdmin', scope: 'commissions:read' },
    query: commissions.listQuerySchema,
    responses: { 200: { description: 'One page.', schema: S.CommissionPage } },
    errors: { 400: ['invalid_cursor'] },
  });

  r.operation({
    method: 'get',
    path: '/commissions',
    tag: 'Commissions',
    operationId: 'listCommissions',
    summary: 'List all commissions',
    description: commissionListDescription,
    access: { kind: 'admin', scope: 'commissions:read' },
    query: commissions.listQuerySchema,
    responses: { 200: { description: 'One page.', schema: S.CommissionPage } },
    errors: { 400: ['invalid_cursor'] },
  });

  r.operation({
    method: 'post',
    path: '/commissions/:id/approve',
    tag: 'Commissions',
    operationId: 'approveCommission',
    summary: 'Approve an accrued commission',
    description:
      "Refused while the holdback is running. Fires `commission.approved`. With a holdback above 0 the scheduled jobs approve matured commissions on their own; with none, this is the only way they're approved.",
    access: { kind: 'admin' },
    responses: { 200: { description: 'Approved.', schema: z.object({ commission: S.Commission }) } },
    errors: { 404: ['not_found'], 409: ['holdback_active', 'not_approvable'] },
  });

  r.operation({
    method: 'post',
    path: '/commissions/:id/reverse',
    tag: 'Commissions',
    operationId: 'reverseCommission',
    summary: 'Reverse an accrued or approved commission',
    description: 'Fires `commission.reversed` with `reason: "manual"`.',
    access: { kind: 'admin' },
    responses: { 200: { description: 'Reversed.', schema: z.object({ commission: S.Commission }) } },
    errors: { 409: ['commission_in_transfer', 'not_reversible'] },
  });

  // ----------------------------------------------------------------- Payouts
  r.operation({
    method: 'post',
    path: '/payouts/run',
    tag: 'Payouts',
    operationId: 'runPayouts',
    summary: 'Run a payout batch now',
    description:
      "Groups approved commissions per partner and currency. Stripe Connect partners are transferred. Everyone else (every headless partner) gets a `manual` payout: the Payout is `pending` and its commissions are marked `paid` right away, before any money moves. You send the money yourself, then `POST /payouts/{id}/confirm`. Totals under the payout threshold carry over. The scheduled jobs run this on the tenant's payout cadence (weekly by default; set it to Manual to run it only yourself).",
    access: { kind: 'admin' },
    responses: { 200: { description: 'What happened to each payout.', schema: S.PayoutRunResult } },
  });

  r.operation({
    method: 'post',
    path: '/payouts/:id/confirm',
    tag: 'Payouts',
    operationId: 'confirmManualPayout',
    summary: 'Mark a manual payout as sent',
    access: { kind: 'admin' },
    responses: { 200: { description: 'Confirmed.', schema: z.object({ payout: S.Payout }) } },
    errors: { 404: ['payout_not_found'], 409: ['not_confirmable'] },
  });

  r.operation({
    method: 'get',
    path: '/partners/:id/payouts',
    tag: 'Payouts',
    operationId: 'listPartnerPayouts',
    summary: "List a partner's payouts",
    description: 'The 200 most recent, newest first.',
    access: { kind: 'partnerOrAdmin', scope: 'payouts:read' },
    responses: { 200: { description: 'Payouts.', schema: z.object({ payouts: z.array(S.Payout) }) } },
  });

  // ------------------------------------------------------- Partner reporting
  r.operation({
    method: 'get',
    path: '/partners/:id/dashboard',
    tag: 'Partner reporting',
    operationId: 'getPartnerDashboard',
    summary: 'Headline stats for a partner',
    description: 'Clicks, attributed events and revenue, and commission totals by status, since `since`.',
    access: { kind: 'partnerOrAdmin', scope: 'partners:read' },
    query: sinceQuery.extend({
      includeLinks: z.enum(['true', '1', 'false', '0']).optional().openapi({ description: 'Add a per-link breakdown.' }),
    }),
    responses: { 200: { description: 'Stats.', schema: S.PartnerDashboard } },
  });

  r.operation({
    method: 'get',
    path: '/partners/:id/timeseries',
    tag: 'Partner reporting',
    operationId: 'getPartnerTimeseries',
    summary: 'Daily or weekly series for charts',
    description:
      "Dense buckets (zero-filled). Defaults to the last 30 days, bucketed by day, or by week past 90 days. Event counts are per attribution: an event credited through two of this partner's clicks (a multi-touch model) counts twice. `leads` counts `signup` and `trial_started`; `sales` counts any event with a value above 0.",
    access: { kind: 'partnerOrAdmin', scope: 'partners:read' },
    query: dashboard.timeseriesQuerySchema,
    responses: { 200: { description: 'Series.', schema: S.PartnerTimeseries } },
  });

  r.operation({
    method: 'get',
    path: '/partners/:id/events',
    tag: 'Partner reporting',
    operationId: 'listPartnerEvents',
    summary: 'Attributed events for a partner',
    description: 'Newest first, offset-paginated (default 50, max 200), with the click each event was credited through.',
    access: { kind: 'partnerOrAdmin', scope: 'partners:read' },
    query: dashboard.eventsQuerySchema,
    responses: { 200: { description: 'Events.', schema: S.PartnerEventList } },
  });

  r.operation({
    method: 'get',
    path: '/partners/:id/customers',
    tag: 'Partner reporting',
    operationId: 'listPartnerCustomers',
    summary: 'Customers a partner brought in',
    description: 'One row per attributed userId, by attributed revenue. Offset-paginated (default 50, max 200).',
    access: { kind: 'partnerOrAdmin', scope: 'partners:read' },
    query: dashboard.customersQuerySchema,
    responses: { 200: { description: 'Customers.', schema: S.PartnerCustomerList } },
  });

  r.operation({
    method: 'get',
    path: '/partners/:id/breakdowns',
    tag: 'Partner reporting',
    operationId: 'getPartnerBreakdown',
    summary: 'Top click sources by one dimension',
    access: { kind: 'partnerOrAdmin', scope: 'partners:read' },
    query: dashboard.breakdownQuerySchema,
    responses: { 200: { description: 'Top values.', schema: S.PartnerBreakdown } },
  });

  r.operation({
    method: 'get',
    path: '/partners/:id/funnel',
    tag: 'Partner reporting',
    operationId: 'getPartnerFunnel',
    summary: 'Click → identity → signup → paid funnel',
    description:
      'Stages count distinct users. `signups` counts only `signup` events and `paid` only `invoice_paid` events, so report conversions under those types for this view to fill in. Rates are step over step.',
    access: { kind: 'partnerOrAdmin' },
    query: sinceQuery,
    responses: { 200: { description: 'Funnel.', schema: S.PartnerFunnel } },
  });

  // ---------------------------------------------------------------- Webhooks
  r.operation({
    method: 'post',
    path: '/webhooks',
    tag: 'Webhooks',
    operationId: 'createWebhookEndpoint',
    summary: 'Subscribe a webhook endpoint',
    description:
      'Returns the signing `secret` once. The URL must be publicly reachable over HTTP(S); private and loopback addresses are refused at delivery time. See **Webhook events** for the catalogue.',
    access: { kind: 'admin', scope: 'webhooks:write' },
    body: webhooks.createSchema.openapi('CreateWebhookRequest'),
    responses: {
      201: { description: 'Subscribed.', schema: z.object({ endpoint: S.WebhookEndpoint, secret: z.string().openapi({ description: '`whsec_…`. Shown once.' }) }) },
    },
  });

  r.operation({
    method: 'get',
    path: '/webhooks',
    tag: 'Webhooks',
    operationId: 'listWebhookEndpoints',
    summary: 'List webhook endpoints',
    access: { kind: 'admin' },
    responses: { 200: { description: 'Endpoints, including inactive ones.', schema: z.object({ endpoints: z.array(S.WebhookEndpoint) }) } },
  });

  r.operation({
    method: 'get',
    path: '/webhooks/:id',
    tag: 'Webhooks',
    operationId: 'getWebhookEndpoint',
    summary: 'Get a webhook endpoint',
    access: { kind: 'admin' },
    responses: { 200: { description: 'The endpoint.', schema: z.object({ endpoint: S.WebhookEndpoint }) } },
    errors: { 404: ['not_found'] },
  });

  r.operation({
    method: 'patch',
    path: '/webhooks/:id',
    tag: 'Webhooks',
    operationId: 'updateWebhookEndpoint',
    summary: 'Update a webhook endpoint',
    access: { kind: 'admin' },
    body: webhooks.updateSchema.openapi('UpdateWebhookRequest'),
    responses: { 200: { description: 'The updated endpoint.', schema: z.object({ endpoint: S.WebhookEndpoint }) } },
    errors: { 404: ['not_found'] },
  });

  r.operation({
    method: 'delete',
    path: '/webhooks/:id',
    tag: 'Webhooks',
    operationId: 'deleteWebhookEndpoint',
    summary: 'Unsubscribe a webhook endpoint',
    description: 'Deactivates it and keeps its delivery log. `?hard=1` deletes the endpoint and its log.',
    access: { kind: 'admin', scope: 'webhooks:write' },
    query: z.object({ hard: z.enum(['1']).optional().openapi({ description: 'Not validated by the route: only `1` has an effect.' }) }),
    responses: { 200: { description: 'Done.', schema: S.Ok } },
  });

  r.operation({
    method: 'get',
    path: '/webhooks/:id/deliveries',
    tag: 'Webhooks',
    operationId: 'listWebhookDeliveries',
    summary: "List an endpoint's recent deliveries",
    description:
      'The 100 most recent, newest first. Failed deliveries are not retried automatically; use this to find them. Needs an admin key (`webhooks:write` only covers subscribing and unsubscribing).',
    access: { kind: 'admin' },
    responses: { 200: { description: 'Deliveries.', schema: z.object({ deliveries: z.array(S.WebhookDelivery) }) } },
  });

  r.operation({
    method: 'post',
    path: '/webhooks/:id/test',
    tag: 'Webhooks',
    operationId: 'testWebhookEndpoint',
    summary: 'Send a signed test event',
    description:
      'Sends a sample payload for `event` (or a generic `webhook.test`) to this endpoint regardless of its subscriptions, and returns the delivery. Samples have the real payload shape plus `_synthetic: true` and `_endpointId`.',
    access: { kind: 'admin' },
    query: webhooks.testQuerySchema,
    responses: {
      200: { description: 'The delivery attempt.', schema: z.object({ delivery: S.orNull(S.WebhookDelivery), event: z.string() }) },
    },
    errors: { 400: ['endpoint_inactive'], 404: ['not_found'] },
  });

  r.operation({
    method: 'post',
    path: '/webhooks/:id/deliveries/:deliveryId/retry',
    tag: 'Webhooks',
    operationId: 'retryWebhookDelivery',
    summary: 'Redeliver a delivery',
    description: 'Resends the same envelope (same `id`), freshly signed.',
    access: { kind: 'admin' },
    responses: { 200: { description: 'The delivery after the attempt.', schema: z.object({ delivery: S.WebhookDelivery }) } },
    errors: { 400: ['endpoint_mismatch'], 404: ['not_found'] },
  });

  // ---------------------------------------------------------------- API keys
  r.operation({
    method: 'post',
    path: '/api-keys',
    tag: 'API keys',
    operationId: 'createAdminKey',
    summary: 'Mint an unscoped admin key',
    description: 'Full tenant access. Prefer a scoped key for integrations.',
    access: { kind: 'admin' },
    body: apiKeys.createSchema.openapi('CreateKeyRequest'),
    responses: { 201: { description: 'Minted.', schema: S.CreatedKey } },
  });

  r.operation({
    method: 'post',
    path: '/api-keys/scoped',
    tag: 'API keys',
    operationId: 'createScopedKey',
    summary: 'Mint a scoped key',
    description:
      'A key that can call only the operations its scopes unlock (see **Authentication** in the introduction for the table). Scope strings are not validated: a misspelt scope silently unlocks nothing.',
    access: { kind: 'admin' },
    body: apiKeys.scopedCreateSchema.openapi('CreateScopedKeyRequest'),
    responses: { 201: { description: 'Minted.', schema: S.CreatedKey.extend({ scopes: z.array(z.string()) }) } },
  });

  r.operation({
    method: 'get',
    path: '/api-keys',
    tag: 'API keys',
    operationId: 'listScopedKeys',
    summary: 'List scoped keys',
    description: 'Scoped keys only (admin keys are not listed), including revoked ones. Never returns the key itself.',
    access: { kind: 'admin' },
    query: apiKeys.listQuerySchema,
    responses: { 200: { description: 'Keys.', schema: z.object({ apiKeys: z.array(S.ApiKeySummary) }) } },
  });

  r.operation({
    method: 'post',
    path: '/partners/:id/api-keys',
    tag: 'API keys',
    operationId: 'createPartnerKey',
    summary: 'Mint a partner key',
    description: "A key that acts as this one partner: it reads and writes only that partner's own resources. Revoking the partner revokes its keys.",
    access: { kind: 'partnerOrAdmin' },
    body: apiKeys.createSchema,
    responses: { 201: { description: 'Minted.', schema: S.CreatedKey } },
    errors: { 404: ['partner_not_found'] },
  });

  r.operation({
    method: 'get',
    path: '/partners/:id/api-keys',
    tag: 'API keys',
    operationId: 'listPartnerKeys',
    summary: "List a partner's keys",
    access: { kind: 'partnerOrAdmin' },
    responses: { 200: { description: 'Keys.', schema: z.object({ apiKeys: z.array(S.ApiKeySummary) }) } },
  });

  r.operation({
    method: 'get',
    path: '/auth/introspect',
    tag: 'API keys',
    operationId: 'introspectKey',
    summary: 'Describe the calling key',
    description: 'What the credential you sent can do: its scopes, the partner it is bound to, or unrestricted admin access. Useful when a call answers `403 forbidden_scope`.',
    access: { kind: 'handler', rule: 'any key or session.', partner: true },
    responses: {
      200: {
        description: 'The caller.',
        schema: z.union([
          z.object({ role: z.literal('scoped'), scopes: z.array(z.string()) }),
          z.object({ role: z.literal('admin'), unrestricted: z.literal(true) }),
          z.object({ role: z.literal('partner'), restrictedTo: z.object({ partnerId: z.string() }) }),
        ]),
      },
    },
  });

  r.operation({
    method: 'delete',
    path: '/api-keys/:keyId',
    tag: 'API keys',
    operationId: 'revokeKey',
    summary: 'Revoke a key',
    access: { kind: 'handler', rule: "admin key (any key), or a partner key (that partner's own keys). Scoped keys get `403 forbidden`.", partner: true },
    responses: { 200: { description: 'Revoked.', schema: S.Ok } },
    errors: { 404: ['not_found'] },
  });

  // ------------------------------------------------------------------ Export
  r.operation({
    method: 'get',
    path: '/export/:table.:format',
    tag: 'Export',
    operationId: 'exportTable',
    summary: 'Export one table',
    description: 'JSON (array of rows), CSV, or a SQL dump. `tenantId` applies to `sql` only.',
    access: { kind: 'admin' },
    params: {
      table: z.enum(EXPORTABLE_TABLES as unknown as [string, ...string[]]).openapi({ description: 'Table name.' }),
      format: z.enum(['json', 'csv', 'sql']),
    },
    query: z.object({
      tenantId: z.string().optional().openapi({ description: 'SQL only. Bake this literal tenant id into the dump instead of the portable `:tenant_id` psql variable.' }),
    }),
    responses: {
      200: {
        description: 'The table.',
        content: {
          'application/json': { schema: z.array(z.record(z.unknown())) },
          'text/csv': { schema: z.string() },
          'application/sql': { schema: z.string() },
        },
      },
    },
    errors: { 400: ['unsupported_format', 'invalid_tenant_id'], 404: ['table_not_exportable'] },
  });

  r.operation({
    method: 'get',
    path: '/export.json',
    tag: 'Export',
    operationId: 'exportAllJson',
    summary: 'Export the whole tenant (JSON)',
    access: { kind: 'admin' },
    responses: { 200: { description: 'Every exportable table.', schema: S.ExportBundle } },
  });

  r.operation({
    method: 'get',
    path: '/export.sql',
    tag: 'Export',
    operationId: 'exportAllSql',
    summary: 'Export the whole tenant (SQL)',
    description: 'Restore with `psql "$DATABASE_URL" -v tenant_id=<destination tenant id> -f openpartner-export.sql`.',
    access: { kind: 'admin' },
    query: z.object({ tenantId: z.string().optional().openapi({ description: 'Bake a literal tenant id instead of the psql variable.' }) }),
    responses: { 200: { description: 'SQL dump.', content: { 'application/sql': { schema: z.string() } } } },
    errors: { 400: ['invalid_tenant_id'] },
  });

  r.operation({
    method: 'post',
    path: '/import',
    tag: 'Export',
    operationId: 'importBundle',
    summary: 'Import an export bundle (self-host only)',
    description: 'Idempotent: rows whose primary key exists are skipped. Accepts bundles up to 256 MB on single-tenant installs (1 MB under a `/t/<slug>` path).',
    access: { kind: 'admin' },
    body: exportRoutes.importSchema.openapi('ImportRequest'),
    responses: { 200: { description: 'Rows inserted and skipped per table.', schema: S.ImportResult } },
    errors: { 400: ['unsupported_schema_version'], 403: ['import_disabled_on_hosted'] },
  });

  // ----------------------------------------------------- Network settings
  r.operation({
    method: 'get',
    path: '/config/network',
    tag: 'Network settings',
    operationId: 'getNetworkMembership',
    summary: "Get the tenant's OpenPartner Network membership",
    description:
      '`enabled && autoEnroll` means the tenant offers the Network to its partners: each is asked whether to join, and only those who opt in are shared. Nothing is shared for a partner who hasn\'t.',
    access: { kind: 'admin' },
    responses: { 200: { description: 'Membership.', schema: S.NetworkMembership } },
  });

  r.operation({
    method: 'post',
    path: '/config/network',
    tag: 'Network settings',
    operationId: 'updateNetworkMembership',
    summary: 'Update Network membership (e.g. stop offering the Network to partners)',
    description:
      '`autoEnroll` is the stored name for "offer the Network to my partners". Send `{"autoEnroll": false}` to stop asking partners and stop sharing anyone, whatever they chose. Partners already on the Network stay on it. Reconnecting the Network later (Admin → Network → Connect) turns `autoEnroll` back on, so re-check after any reconnect.',
    access: { kind: 'admin' },
    body: settings.networkMembershipSchema.openapi('UpdateNetworkMembershipRequest'),
    responses: { 200: { description: 'The saved membership.', schema: S.NetworkMembership } },
    errors: { 403: ['brand_pending_review'], 409: ['white_label_network_conflict'] },
  });
}
