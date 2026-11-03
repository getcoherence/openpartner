/**
 * View-only seats (docs/view-only-seats.md): what an Admin with role
 * 'viewer' may do. The one enforcement point; requireAuth calls
 * viewerRefusal for every request a viewer's session makes.
 *
 * Keyed on the method and the matched route pattern (`req.route.path`),
 * so each entry names one route exactly as it's registered. HEAD is GET's
 * route. __tests__/view-only.test.ts sends every route in the app a
 * viewer's request and fails on a list entry that names no route.
 */

import type { Request } from 'express';

/** Writes a viewer may make: their own account. */
export const VIEWER_ALLOWED_WRITES: Readonly<Record<string, string>> = {
  'PUT /auth/password': 'their own password',
};

/** Reads a viewer may not make: they hand over credentials or bulk
 *  personal data rather than show what the portal shows. */
export const VIEWER_DENIED_READS: Readonly<Record<string, string>> = {
  'GET /export.json': 'the full data export',
  'GET /export.sql': 'the full data export',
  'GET /export/:table.:format': 'the full data export, one table',
  'GET /payouts/exports/:exportId.csv': "a payout file, with partners' full payout details",
  'GET /partners/:id/payout-profile': "a partner's full payout details",
  'GET /partners/:id/postbacks/:postbackId/url': "a partner's sealed postback URL",
};

/** The route key for `req`: "METHOD /pattern". Falls back to the path for
 *  a request that reached requireAuth outside a route (none today). */
export function routeKey(req: Request): string {
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const pattern = typeof req.route?.path === 'string' ? req.route.path : req.path;
  return `${method} ${pattern}`;
}

/** Null when a viewer may make this request, else the error code to send
 *  with a 403. */
export function viewerRefusal(req: Request): 'read_only' | null {
  const key = routeKey(req);
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (isRead) return key in VIEWER_DENIED_READS ? 'read_only' : null;
  return key in VIEWER_ALLOWED_WRITES ? null : 'read_only';
}
