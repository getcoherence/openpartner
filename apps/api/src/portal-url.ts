/**
 * Per-tenant portal base URL — the single place that decides which origin
 * a tenant's emailed links (magic links, invites) point at (spec §4.4).
 *
 * Resolution order:
 *   1. Tenant has a verified custom domain → https://<customDomain>.
 *      The magic-link redeem endpoint sets a HOST-ONLY session cookie, so
 *      the link's host must be the host the user will use — a xispark
 *      partner emailed an app.openpartner.dev link would authenticate on
 *      the wrong origin and never be signed in on portal.xispark.com.
 *   2. Tenant slug known → PORTAL_URL + /t/<slug> (path-based portal).
 *   3. Otherwise → PORTAL_URL (platform / pre-tenant surfaces).
 *
 * Stripe Checkout/Connect redirect URLs are deliberately NOT built here —
 * they are client-supplied from window.location.origin and already land on
 * the right host. Server-building them from PORTAL_URL would bounce a
 * white-label user to the platform origin and break the cookie-host match.
 *
 * Takes a plain tenant shape (not a req) so scheduler-driven sends can
 * resolve the host straight from the Tenant row.
 */

import type { Request } from 'express';

export interface PortalLinkTenant {
  slug?: string | null;
  customDomain?: string | null;
}

export function getPortalBaseUrl(tenant?: PortalLinkTenant | null): string {
  const env = (process.env.PORTAL_URL ?? 'http://localhost:5673').replace(/\/$/, '');
  if (tenant?.customDomain) return `https://${tenant.customDomain}`;
  if (tenant?.slug) return `${env}/t/${tenant.slug}`;
  return env;
}

/**
 * The link-tenant for the current request. tenantMiddleware stashes the
 * Tenant row's customDomain during resolution (host- AND path-based), so
 * links built inside a tenant-scoped handler always target the tenant's
 * custom domain when it has one — even when the admin who triggered the
 * email is working from the path-based platform URL.
 */
export function linkTenantOf(req: Request): PortalLinkTenant {
  return { slug: req.tenantSlug ?? null, customDomain: req.tenantCustomDomain ?? null };
}
