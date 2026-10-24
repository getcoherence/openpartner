/**
 * OpenAPI registration helpers.
 *
 * The spec is generated from zod with @asteasolutions/zod-to-openapi. The
 * request bodies and query strings come from the SAME schema objects the
 * route handlers validate with (exported from routes/*.ts), so the spec
 * can't describe a request the API would reject, or miss a field it
 * accepts. Response shapes are written here in zod and checked against
 * real responses by __tests__/openapi-contract.test.ts.
 *
 * `operation()` adds what every OpenPartner route has in common: an
 * Express-style path (`/partners/:id`), the access rule, and the shared
 * error envelope. The access rule is checked against the route's real
 * middleware chain (grantScope / requireAdmin / requirePartnerOrAdmin) by
 * __tests__/openapi.test.ts, so the auth docs can't drift either.
 */

import { z } from '../zod.js';
import { OpenAPIRegistry, type RouteConfig, type ZodContentObject } from '@asteasolutions/zod-to-openapi';

/**
 * Who can call an operation.
 *
 *   public          no credential (the browser SDK's identify call)
 *   admin           an unscoped admin key, ADMIN_API_KEY, or an admin
 *                   portal session; plus a scoped key holding `scope`
 *                   (any one of them, when it's a list)
 *   partnerOrAdmin  as admin, plus the partner named by `:id` (partner key
 *                   or partner portal session)
 *   handler         any authenticated caller reaches the handler, which
 *                   decides; `rule` says how
 *   postbackToken   no API key: the handler checks the conversion postback
 *                   token in the `token` query parameter (GET /postback)
 */
export type Access =
  | { kind: 'public' }
  | { kind: 'admin'; scope?: string | string[] }
  | { kind: 'partnerOrAdmin'; scope?: string | string[] }
  | { kind: 'handler'; rule: string; scopes?: string[]; partner?: boolean }
  | { kind: 'postbackToken' };

export const SECURITY_SCHEMES = {
  adminKey: 'adminKey',
  scopedKey: 'scopedKey',
  partnerKey: 'partnerKey',
  postbackToken: 'postbackToken',
} as const;

export const ErrorResponse = z
  .object({
    error: z.string().openapi({ description: 'Stable machine-readable code, e.g. `invalid_body`, `email_taken`.' }),
    detail: z.unknown().optional().openapi({
      description: 'Human-readable cause, or zod `flatten()` output for `invalid_body` / `invalid_query`.',
    }),
  })
  .passthrough()
  .openapi('Error', {
    description:
      'Every non-2xx response. `error` is stable and safe to branch on; `detail` is for humans and may change. Some errors carry extra fields (e.g. `required` on `forbidden_scope`, `matureAt` on `holdback_active`).',
  });

export interface OperationSpec {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Express path, exactly as mounted: `/partners/:id/links`. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  access: Access;
  /** Overrides for path params; any `:param` not listed is a plain string. */
  params?: Record<string, z.ZodTypeAny>;
  query?: z.ZodObject;
  body?: z.ZodTypeAny;
  /** `body` may be left out entirely: every field in it is optional, and
   *  callers from before it existed send none. */
  optionalBody?: boolean;
  /** A non-JSON request body (e.g. text/csv), instead of `body`. */
  requestContent?: ZodContentObject;
  /** Success responses: status → schema (JSON) or a full response config. */
  responses: Record<number, { description: string; schema?: z.ZodTypeAny; content?: ZodContentObject }>;
  /** Error responses beyond the auth defaults: status → `error` codes. */
  errors?: Record<number, string[]>;
  /** Errors answer `text/plain` with the code as the body instead of the
   *  JSON envelope (GET /postback, for senders that can't parse JSON). The
   *  operation lists every code itself: no invalid_query or auth defaults. */
  textErrors?: boolean;
  operationId: string;
}

export interface DocumentedOperation {
  method: string;
  path: string;
  access: Access;
  operationId: string;
  /** Success status → JSON body schema (undefined for non-JSON bodies). */
  responses: Record<number, z.ZodTypeAny | undefined>;
  /** Error status → the `error` codes documented for it. */
  errors: Record<number, string[]>;
  /** Errors are `text/plain` codes, not the JSON envelope. */
  textErrors: boolean;
}

/** Express `/a/:b/c.:d` → OpenAPI `/a/{b}/c.{d}`. */
export function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
}

function scopeList(scope: string | string[] | undefined): string[] {
  if (scope === undefined) return [];
  return Array.isArray(scope) ? scope : [scope];
}

/** `a`, or `a` or `b`, for the access sentence. */
function scopeWords(scope: string | string[]): string {
  return scopeList(scope)
    .map((s) => `\`${s}\``)
    .join(' or ');
}

/** The access extension the drift test reads, and the scopes it grants. */
export function accessExtension(access: Access): { kind: Access['kind']; scopes: string[]; partner: boolean } {
  switch (access.kind) {
    case 'public':
      return { kind: 'public', scopes: [], partner: false };
    case 'admin':
      return { kind: 'admin', scopes: scopeList(access.scope), partner: false };
    case 'partnerOrAdmin':
      return { kind: 'partnerOrAdmin', scopes: scopeList(access.scope), partner: true };
    case 'handler':
      return { kind: 'handler', scopes: access.scopes ?? [], partner: access.partner ?? false };
    case 'postbackToken':
      return { kind: 'postbackToken', scopes: [], partner: false };
  }
}

function securityFor(access: Access): RouteConfig['security'] {
  if (access.kind === 'public') return [];
  if (access.kind === 'postbackToken') return [{ [SECURITY_SCHEMES.postbackToken]: [] }];
  const ext = accessExtension(access);
  return [
    { [SECURITY_SCHEMES.adminKey]: [] },
    ...(ext.partner ? [{ [SECURITY_SCHEMES.partnerKey]: [] }] : []),
    ...ext.scopes.map((s) => ({ [SECURITY_SCHEMES.scopedKey]: [s] })),
  ];
}

function accessSentence(access: Access): string {
  switch (access.kind) {
    case 'public':
      return '**Access:** public, no API key. Rate-limited per client IP.';
    case 'admin':
      return access.scope
        ? `**Access:** admin key, or a scoped key with ${scopeWords(access.scope)}.`
        : '**Access:** admin key only. Scoped keys get `403 forbidden`.';
    case 'partnerOrAdmin':
      return access.scope
        ? `**Access:** admin key, a scoped key with ${scopeWords(access.scope)}, or the partner's own key (\`:id\` must be that partner).`
        : "**Access:** admin key, or the partner's own key (`:id` must be that partner). Scoped keys get `403 forbidden`.";
    case 'handler':
      return `**Access:** ${access.rule}`;
    case 'postbackToken':
      return '**Access:** the conversion postback token in the `token` query parameter. API keys are not accepted, as a Bearer header or as `token`.';
  }
}

const AUTH_ERRORS: Record<number, string[]> = {
  401: ['unauthorized'],
  403: ['forbidden', 'forbidden_scope'],
};

export class OperationRegistry {
  readonly registry = new OpenAPIRegistry();
  readonly operations: DocumentedOperation[] = [];

  constructor() {
    this.registry.registerComponent('securitySchemes', SECURITY_SCHEMES.adminKey, {
      type: 'http',
      scheme: 'bearer',
      description:
        'An unscoped admin key (`POST /api-keys`), or the deployment\'s `ADMIN_API_KEY`. Full access to the tenant it was minted in. Server-side only.',
    });
    this.registry.registerComponent('securitySchemes', SECURITY_SCHEMES.scopedKey, {
      type: 'http',
      scheme: 'bearer',
      description:
        'A scoped key (`POST /api-keys/scoped`). Each operation lists the one scope that unlocks it; a key without it gets `403 forbidden_scope`. Operations that list no scope reject scoped keys.',
    });
    this.registry.registerComponent('securitySchemes', SECURITY_SCHEMES.partnerKey, {
      type: 'http',
      scheme: 'bearer',
      description:
        'A partner-scoped key (`POST /partners/{id}/api-keys`). Acts as that one partner: it can read and write only that partner\'s own resources.',
    });
    this.registry.registerComponent('securitySchemes', SECURITY_SCHEMES.postbackToken, {
      type: 'apiKey',
      in: 'query',
      name: 'token',
      description:
        'The conversion postback token (`opcp_…`), minted and rotated under Admin → Integrations. It travels in the URL, so proxies, browser history and the sender\'s own logs keep it. It is built to be cheap to leak: it records conversions and nothing else, is never accepted as a Bearer key, can be pinned to the sender\'s IPs, and rotating it kills the old URL at once. Only `GET /postback` takes it.',
    });
  }

  operation(spec: OperationSpec): void {
    const names = pathParamNames(spec.path);
    const params =
      names.length > 0
        ? z.object(Object.fromEntries(names.map((n) => [n, spec.params?.[n] ?? z.string().openapi({ description: `The ${n}.` })])))
        : undefined;

    // Every operation is tenant-scoped: on a multi-tenant install a URL
    // without /t/<slug> answers 400 tenant_slug_missing.
    const errors: Record<number, string[]> = { 400: ['tenant_slug_missing'] };
    if (!spec.textErrors) {
      if (spec.body || spec.query) errors[400]!.unshift(spec.body ? 'invalid_body' : 'invalid_query');
      if (spec.access.kind !== 'public') Object.assign(errors, structuredClone(AUTH_ERRORS));
    }
    for (const [status, codes] of Object.entries(spec.errors ?? {})) {
      const s = Number(status);
      errors[s] = [...new Set([...(errors[s] ?? []), ...codes])];
    }

    const responses: RouteConfig['responses'] = {};
    for (const [status, r] of Object.entries(spec.responses)) {
      responses[status] = {
        description: r.description,
        ...(r.content
          ? { content: r.content }
          : r.schema
            ? { content: { 'application/json': { schema: r.schema } } }
            : {}),
      };
    }
    for (const [status, codes] of Object.entries(errors).sort(([a], [b]) => Number(a) - Number(b))) {
      responses[status] = {
        description: codes.map((c) => `\`${c}\``).join(', '),
        content: spec.textErrors
          ? { 'text/plain': { schema: z.string().openapi({ description: 'The error code, e.g. `invalid_token`.' }) } }
          : { 'application/json': { schema: ErrorResponse } },
      };
    }

    const description = [spec.description?.trim(), accessSentence(spec.access)].filter(Boolean).join('\n\n');

    this.registry.registerPath({
      method: spec.method,
      path: toOpenApiPath(spec.path),
      operationId: spec.operationId,
      tags: [spec.tag],
      summary: spec.summary,
      description,
      security: securityFor(spec.access),
      request: {
        ...(params ? { params } : {}),
        ...(spec.query ? { query: spec.query } : {}),
        ...(spec.body ? { body: { required: !spec.optionalBody, content: { 'application/json': { schema: spec.body } } } } : {}),
        ...(spec.requestContent ? { body: { required: true, content: spec.requestContent } } : {}),
      },
      responses,
      'x-openpartner-access': accessExtension(spec.access),
    } as RouteConfig);
    this.operations.push({
      method: spec.method,
      path: spec.path,
      access: spec.access,
      operationId: spec.operationId,
      responses: Object.fromEntries(Object.entries(spec.responses).map(([status, r]) => [status, r.schema])),
      errors,
      textErrors: spec.textErrors ?? false,
    });
  }
}
