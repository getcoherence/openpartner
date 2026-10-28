import { currentTenantSlug } from '../api.js';
import { useBrand, usePublicBrand } from './useBrand.js';

/**
 * Where the router answers for this brand, without the tenant slug:
 *   platform origin (path-based tenant) → https://app…/r
 *   white-label custom domain           → https://portal.brand.com/r
 *   single-tenant self-host             → configured public router origin
 *     (the portal origin does not necessarily serve /r)
 * Null when a self-host hasn't set its router URL. Test links
 * (Tracking health → Send a test click) hang off this: /r/_test/<token>.
 */
export function useShareUrlRoot(): string | null {
  const pathSlug = currentTenantSlug();
  const { tenantSlug } = usePublicBrand();
  const { routerUrl } = useBrand();
  if (pathSlug) return `${window.location.origin}/r`;
  if (tenantSlug && tenantSlug !== 'default') return `${window.location.origin}/r`;
  return routerUrl ? `${routerUrl}/r` : null;
}

/**
 * The full share URL for a link key is this + `/<key>`, matching how the
 * router resolves it: https://app…/r/<slug>/<key> on the platform origin,
 * the root alone on a white-label domain or a self-host.
 */
export function useShareUrlBase(): string | null {
  const root = useShareUrlRoot();
  const pathSlug = currentTenantSlug();
  return pathSlug && root ? `${root}/${pathSlug}` : root;
}
