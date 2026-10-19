/**
 * The OpenAPI 3.1 document for the tenant API, served at GET /openapi.json
 * and rendered at GET /docs (routes/openapi.ts). Built once, on first use.
 *
 * docs/openapi.json is a committed copy kept identical by
 * __tests__/openapi.test.ts — regenerate it with
 *   pnpm --filter @openpartner/api openapi:update
 */

import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { buildDescription } from './description.js';
import { registerPaths } from './paths.js';
import { OperationRegistry, type DocumentedOperation } from './registry.js';
import { registerWebhooks } from './webhook-events.js';

export { HANDLER_GUARDED_ROUTES_OUTSIDE_SPEC, SCOPED_ROUTES_OUTSIDE_SPEC, UNDOCUMENTED_ROUTES } from './paths.js';

type OpenApiDocument = ReturnType<OpenApiGeneratorV31['generateDocument']>;

const TAGS: Array<{ name: string; description: string }> = [
  { name: 'Partners', description: 'The people (or customers) who refer. Create them headless with `sendInvite: false`.' },
  { name: 'Programs', description: 'Commission terms, attribution window and model, destination URL.' },
  { name: 'Program assignments', description: 'Which programs a partner may create links for.' },
  { name: 'Links', description: 'Share links. The click router records a click and appends `?cref=<click id>` to the destination.' },
  { name: 'Attribution', description: 'Stitch clicks to users, then report conversions server-side.' },
  { name: 'Coupons', description: 'Code-based attribution, for checkouts where a link can\'t be followed.' },
  { name: 'Commissions', description: 'The commission ledger: accrued → approved → paid, or reversed.' },
  { name: 'Bonuses', description: 'Rewards not tied to a sale. Each is paid through one commission.' },
  { name: 'Payouts', description: 'Paying approved commissions, via Stripe Connect or a manual rail.' },
  { name: 'Partner reporting', description: 'Per-partner stats for your own UI.' },
  { name: 'Webhooks', description: 'Subscribe endpoints to the events under **Webhook events**.' },
  { name: 'API keys', description: 'Admin, scoped and partner keys.' },
  { name: 'Export', description: 'Your data, in formats a self-hosted instance re-imports.' },
  { name: 'Network settings', description: "The tenant's OpenPartner Network membership, including whether partners are offered the Network." },
  { name: 'Webhook events', description: 'What OpenPartner POSTs to your webhook endpoints.' },
];

let cached: { document: OpenApiDocument; operations: DocumentedOperation[] } | null = null;

/** The 3.1 generator emits `z.union([Ref, z.null()])` as
 *  `anyOf: [$ref, {type: null}, {type: null}]`. Drop repeated branches. */
function dedupeAnyOf(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(dedupeAnyOf);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.anyOf)) {
    const seen = new Set<string>();
    obj.anyOf = obj.anyOf.filter((branch) => {
      const key = JSON.stringify(branch);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  Object.values(obj).forEach(dedupeAnyOf);
}

/** Walk every schema-ish object in the document. */
function visit(node: unknown, fn: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((n) => visit(n, fn));
    return;
  }
  if (!node || typeof node !== 'object') return;
  fn(node as Record<string, unknown>);
  Object.values(node as Record<string, unknown>).forEach((n) => visit(n, fn));
}

/**
 * Corrections where the generator's JSON Schema would disagree with zod:
 *
 *   - `z.enum([...]).nullable()` comes out as `type: [string, null]` with an
 *     `enum` that lacks null, so a null value fails the published schema
 *     while the route (or response) allows it. Add null to the enum.
 *   - `z.string().datetime()` comes out as `format: date-time`, which allows
 *     any RFC 3339 offset; zod 3 accepts only UTC with a `Z`
 *     (`2026-10-16T10:00:00+00:00` is a 400). Say so with a pattern.
 */
function alignWithZod(document: OpenApiDocument): void {
  visit(document, (obj) => {
    if (Array.isArray(obj.type) && obj.type.includes('null') && Array.isArray(obj.enum) && !obj.enum.includes(null)) {
      obj.enum = [...obj.enum, null];
    }
    if (obj.format === 'date-time' && obj.pattern === undefined) obj.pattern = 'Z$';
  });
}

/**
 * Request fields whose zod schema can't be rendered faithfully, described
 * by hand. Each entry throws if its target disappears, so a renamed field
 * fails the build instead of silently keeping a stale override.
 */
function applyOverrides(document: OpenApiDocument): void {
  const schemas = document.components?.schemas as Record<string, { properties?: Record<string, unknown> }> | undefined;
  const set = (schema: string, property: string, value: unknown) => {
    const props = schemas?.[schema]?.properties;
    if (!props || !(property in props)) throw new Error(`openapi override target missing: ${schema}.${property}`);
    props[property] = value;
  };
  // routes/events.ts runs externalEventId through z.preprocess: null and ""
  // (an unmapped Zapier/Make field) mean "no key", and a number is its string.
  set('RecordEventRequest', 'externalEventId', {
    anyOf: [{ type: 'string', maxLength: 120 }, { type: 'number' }, { type: 'null' }],
    description:
      'Idempotency key: your stable id for this one event, up to 120 characters. A number is used as its string. `null`, `""` or a blank string mean no key.',
  });
  // routes/conversions.ts: required, and a number is its string.
  set('RecordConversionRequest', 'externalEventId', {
    anyOf: [{ type: 'string', minLength: 1, maxLength: 120 }, { type: 'number' }],
    description: 'Idempotency key: your stable id for this one conversion (a loan or transaction id), up to 120 characters. A number is used as its string.',
  });
  // routes/refunds.ts: same preprocess on both ids.
  set('RecordRefundRequest', 'externalEventId', {
    anyOf: [{ type: 'string', minLength: 1, maxLength: 120 }, { type: 'number' }],
    description: 'Idempotency key: your stable id for this one refund (a refund or credit-note id), up to 120 characters. A number is used as its string.',
  });
  set('RecordRefundRequest', 'conversionExternalEventId', {
    anyOf: [{ type: 'string', minLength: 1, maxLength: 120 }, { type: 'number' }],
    description:
      'The `externalEventId` you sent with the conversion being refunded. Send this or `conversionEventId`, not both. A number is used as its string.',
  });
  // Its two .refine() checks, which the generator drops.
  set('RecordRefundRequest', 'amount', {
    type: 'number',
    minimum: 0.01,
    description: 'Major units. Omit to refund everything not yet refunded.',
  });
  const refund = schemas?.RecordRefundRequest as Record<string, unknown> | undefined;
  if (!refund) throw new Error('openapi override target missing: RecordRefundRequest');
  refund.oneOf = [{ required: ['conversionExternalEventId'] }, { required: ['conversionEventId'] }];
}

function build() {
  const r = new OperationRegistry();
  registerPaths(r);
  registerWebhooks(r.registry);
  const document = new OpenApiGeneratorV31(r.registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'OpenPartner API',
      version: '1.0.0',
      description: buildDescription(r.operations),
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [
      {
        url: 'https://app.openpartner.dev/api/t/{tenantSlug}',
        description: 'OpenPartner Cloud',
        variables: { tenantSlug: { default: 'your-tenant-slug', description: 'The `/t/<slug>/` segment of your admin portal address.' } },
      },
      {
        url: 'https://{customDomain}/api',
        description: 'OpenPartner Cloud on a white-label custom domain',
        variables: { customDomain: { default: 'partners.example.com' } },
      },
      {
        url: '{apiOrigin}',
        description: 'Self-hosted, single tenant',
        variables: { apiOrigin: { default: 'http://localhost:4601' } },
      },
    ],
    tags: TAGS,
  });
  dedupeAnyOf(document);
  alignWithZod(document);
  applyOverrides(document);
  return { document, operations: r.operations };
}

export function getOpenApiDocument(): OpenApiDocument {
  cached ??= build();
  return cached.document;
}

/** The operations behind the document, for the drift test. */
export function getDocumentedOperations(): DocumentedOperation[] {
  cached ??= build();
  return cached.operations;
}
