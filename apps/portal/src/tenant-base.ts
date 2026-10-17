import { useLocation } from 'react-router-dom';

/**
 * Returns the tenant URL prefix (`/t/<slug>`) when we're inside a
 * multi-tenant route, or `''` otherwise. Anything in the SPA that
 * builds an absolute path like `/links` should prepend this so the
 * route stays scoped to the right brand.
 */
export function useTenantBase(): string {
  const { pathname } = useLocation();
  const m = pathname.match(/^\/t\/([a-z0-9-]+)/);
  return m ? `/t/${m[1]}` : '';
}
