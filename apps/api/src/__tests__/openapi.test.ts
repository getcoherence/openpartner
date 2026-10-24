/**
 * The OpenAPI document can't drift from the API:
 *
 *   - every route on a documented router is in the spec, or listed in
 *     UNDOCUMENTED_ROUTES with a reason;
 *   - every operation in the spec is a real route;
 *   - each operation's documented access (public / admin / partner / the
 *     scope that unlocks it) matches the route's real middleware chain;
 *   - the document is valid OpenAPI 3.1;
 *   - the webhook catalogue covers every subscribable event, and the
 *     test-fire samples match it;
 *   - docs/openapi.json is the committed copy of the generated document.
 *     After an intended API change, refresh it with:
 *       pnpm --filter @openpartner/api openapi:update
 *
 * No database needed. Request bodies are generated from the routes' own
 * zod validators, so those can't drift; response shapes are checked
 * against real responses in openapi-contract.test.ts.
 */

import { describe, expect, it } from 'vitest';
import type { RequestHandler, Router } from 'express';
import { Validator } from '@seriousme/openapi-schema-validator';
import { expectShape } from './openapi-strict.js';

process.env.OPENPARTNER_TENANCY = 'single';

const { createApp } = await import('../app.js');
const {
  getDocumentedOperations,
  getOpenApiDocument,
  HANDLER_GUARDED_ROUTES_OUTSIDE_SPEC,
  SCOPED_ROUTES_OUTSIDE_SPEC,
  UNDOCUMENTED_ROUTES,
} = await import('../openapi/index.js');
const { WEBHOOK_PAYLOADS, envelopeSchema } = await import('../openapi/webhook-events.js');
const { payloadFor } = await import('../webhook-dispatcher.js');
const { KNOWN_EVENTS } = await import('../routes/webhooks.js');
const { accessExtension } = await import('../openapi/registry.js');

// The routers the integration kit documents. A new router that belongs to
// the public API goes here; the coverage test then holds it to the spec.
const DOCUMENTED_ROUTERS: Record<string, Router> = {
  partners: (await import('../routes/partners.js')).partnersRouter,
  partnerSigninLink: (await import('../routes/partner-signin-link.js')).partnerSigninLinkRouter,
  importPartners: (await import('../routes/import-partners.js')).importPartnersRouter,
  programs: (await import('../routes/programs.js')).programsRouter,
  partnerPrograms: (await import('../routes/partner-campaigns.js')).partnerCampaignsRouter,
  links: (await import('../routes/links.js')).linksRouter,
  identify: (await import('../routes/identify.js')).identifyRouter,
  events: (await import('../routes/events.js')).eventsRouter,
  conversions: (await import('../routes/conversions.js')).conversionsRouter,
  refunds: (await import('../routes/refunds.js')).refundsRouter,
  clicks: (await import('../routes/clicks.js')).clicksRouter,
  coupons: (await import('../routes/coupons.js')).couponsRouter,
  commissions: (await import('../routes/commissions.js')).commissionsRouter,
  bonuses: (await import('../routes/bonuses.js')).bonusesRouter,
  payouts: (await import('../routes/payouts.js')).payoutsRouter,
  paypal: (await import('../routes/paypal.js')).paypalRouter,
  payoutProfiles: (await import('../routes/payout-profiles.js')).payoutProfilesRouter,
  dashboard: (await import('../routes/dashboard.js')).dashboardRouter,
  funnel: (await import('../routes/funnel.js')).funnelRouter,
  referrals: (await import('../routes/referrals.js')).referralsRouter,
  webhooks: (await import('../routes/webhooks.js')).webhooksRouter,
  apiKeys: (await import('../routes/api-keys.js')).apiKeysRouter,
  export: (await import('../routes/export.js')).exportRouter,
  openapi: (await import('../routes/openapi.js')).openapiRouter,
};

// Guards are recognised by the tags auth.ts puts on them: express-async-errors
// wraps every route handler, so identity comparison doesn't work.
type Handler = RequestHandler & { guard?: string; grantsScopes?: string[]; partnerParam?: string };

interface RouteInfo {
  key: string;
  handlers: Handler[];
}

interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handler }> };
  name?: string;
  handle?: { stack?: Layer[] };
}

function routesOf(stack: Layer[]): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) {
        if (method === '_all') continue;
        out.push({ key: `${method.toUpperCase()} ${layer.route.path}`, handlers: layer.route.stack.map((s) => s.handle) });
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      out.push(...routesOf(layer.handle.stack));
    }
  }
  return out;
}

const app = createApp({ enableLogger: false }) as unknown as { _router: { stack: Layer[] } };
const appRoutes = new Map<string, RouteInfo>();
for (const r of routesOf(app._router.stack)) if (!appRoutes.has(r.key)) appRoutes.set(r.key, r);

const documentedRouterRoutes = Object.values(DOCUMENTED_ROUTERS).flatMap((router) =>
  routesOf((router as unknown as { stack: Layer[] }).stack),
);

const operations = getDocumentedOperations();
const opKey = (op: { method: string; path: string }) => `${op.method.toUpperCase()} ${op.path}`;
const documented = new Map(operations.map((op) => [opKey(op), op]));

describe('OpenAPI spec ↔ routes', () => {
  it('documents every route on the documented routers (or says why not)', () => {
    const missing = documentedRouterRoutes
      .map((r) => r.key)
      .filter((key) => !documented.has(key) && !(key in UNDOCUMENTED_ROUTES));
    expect(missing, 'add these to openapi/paths.ts, or to UNDOCUMENTED_ROUTES with a reason').toEqual([]);
  });

  it('documents only routes that exist', () => {
    const phantom = [...documented.keys()].filter((key) => !appRoutes.has(key));
    expect(phantom).toEqual([]);
    const staleExclusions = Object.keys(UNDOCUMENTED_ROUTES).filter((key) => !appRoutes.has(key));
    expect(staleExclusions).toEqual([]);
  });

  it("documents each operation's access exactly as the route enforces it", () => {
    const mismatches: string[] = [];
    for (const op of operations) {
      const route = appRoutes.get(opKey(op));
      if (!route) continue; // reported by the phantom test
      const actual = {
        auth: route.handlers.some((h) => h.guard === 'requireAuth'),
        admin: route.handlers.some((h) => h.guard === 'requireAdmin'),
        partnerParam: route.handlers.find((h) => h.partnerParam !== undefined)?.partnerParam ?? null,
        scopes: route.handlers.flatMap((h) => h.grantsScopes ?? []),
      };
      const ext = accessExtension(op.access);
      const expected = {
        // A postback-token route checks its token in the handler, not
        // through requireAuth: API keys must not reach it.
        auth: op.access.kind !== 'public' && op.access.kind !== 'postbackToken',
        admin: op.access.kind === 'admin',
        partnerParam: op.access.kind === 'partnerOrAdmin' ? 'id' : null,
        // 'handler' operations check their scopes inline, not via grantScope.
        scopes: op.access.kind === 'handler' ? [] : ext.scopes,
      };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        mismatches.push(`${opKey(op)}: documented ${JSON.stringify(expected)}, route has ${JSON.stringify(actual)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('documents every route that grants a scope (or names it)', () => {
    const scopedOutside = [...appRoutes.values()]
      .filter((r) => r.handlers.some((h) => h.grantsScopes) && !documented.has(r.key))
      .map((r) => r.key)
      .sort();
    expect(scopedOutside, 'document these, or list them in SCOPED_ROUTES_OUTSIDE_SPEC').toEqual(
      Object.keys(SCOPED_ROUTES_OUTSIDE_SPEC).sort(),
    );
  });

  // A route with requireAuth and no admin / partner / scope guard lets ANY
  // authenticated caller — every scoped key included — reach its handler.
  // Outside the spec, each one must be named, so a new one gets a look.
  it('names every undocumented route whose handler decides access', () => {
    const handlerGuarded = [...appRoutes.values()]
      .filter(
        (r) =>
          r.handlers.some((h) => h.guard === 'requireAuth') &&
          !r.handlers.some((h) => h.guard === 'requireAdmin' || h.partnerParam !== undefined || h.grantsScopes) &&
          !documented.has(r.key),
      )
      .map((r) => r.key)
      .sort();
    expect(handlerGuarded, 'document these, guard them, or list them in HANDLER_GUARDED_ROUTES_OUTSIDE_SPEC').toEqual(
      Object.keys(HANDLER_GUARDED_ROUTES_OUTSIDE_SPEC).sort(),
    );
  });

  // Presence isn't enough: `requireAdmin, grantScope(x)` would reject the
  // scoped key before the scope could grant it. Every route in the app,
  // documented or not, must order its guards requireAuth → grantScope →
  // requireAdmin / requirePartnerOrAdmin → handler.
  it('orders guards correctly on every route', () => {
    const rank = (h: Handler): number | null =>
      h.guard === 'requireAuth' ? 0 : h.grantsScopes ? 1 : h.guard === 'requireAdmin' || h.partnerParam !== undefined ? 2 : null;
    const misordered: string[] = [];
    for (const r of appRoutes.values()) {
      const ranks = r.handlers.map(rank);
      const guards = ranks.filter((x): x is number => x !== null);
      const sorted = [...guards].sort((a, b) => a - b);
      const lastIsGuard = ranks[ranks.length - 1] !== null;
      const needsAuth = guards.some((g) => g > 0) && !guards.includes(0);
      if (JSON.stringify(guards) !== JSON.stringify(sorted) || lastIsGuard || needsAuth) misordered.push(r.key);
    }
    expect(misordered).toEqual([]);
  });

  it('has unique operationIds', () => {
    const ids = operations.map((o) => o.operationId);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe('OpenAPI document', () => {
  it('is valid OpenAPI 3.1', async () => {
    const result = await new Validator().validate(structuredClone(getOpenApiDocument()) as unknown as Record<string, unknown>);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('matches the committed docs/openapi.json', async () => {
    await expect(`${JSON.stringify(getOpenApiDocument(), null, 2)}\n`).toMatchFileSnapshot('../../../../docs/openapi.json');
  });
});

describe('webhook catalogue', () => {
  const subscribable = KNOWN_EVENTS.filter((e) => e !== '*');

  it('documents every subscribable event, and nothing else', () => {
    expect(Object.keys(WEBHOOK_PAYLOADS).sort()).toEqual([...subscribable].sort());
    expect(Object.keys(getOpenApiDocument().webhooks ?? {}).sort()).toEqual([...subscribable].sort());
  });

  it.each(subscribable)('the %s test-fire sample has the documented shape', (event) => {
    const { _synthetic, _endpointId, ...data } = payloadFor(event, 'whe_test');
    expect(_synthetic).toBe(true);
    expectShape(envelopeSchema(event, WEBHOOK_PAYLOADS[event as keyof typeof WEBHOOK_PAYLOADS]), {
      id: 'evt_x',
      event,
      created: new Date().toISOString(),
      data,
    }, `${event} sample`);
  });
});
