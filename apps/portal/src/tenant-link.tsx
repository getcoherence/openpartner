import { Link, type LinkProps } from 'react-router-dom';
import { useTenantBase } from './tenant-base.js';

/**
 * Drop-in replacement for react-router's `<Link>` that prepends the
 * current `/t/<slug>` prefix to absolute paths. Use this anywhere
 * inside the brand workspace UI so navigation stays tenant-scoped —
 * a bare `<Link to="/links">` would land on the global router and
 * 404 (the routes only exist under `/t/:slug/*`).
 *
 * External links and relative paths pass through unchanged. All other
 * props (className, style, onMouseEnter, etc.) forward to the
 * underlying Link unchanged.
 */
export function TenantLink({ to, ...rest }: Omit<LinkProps, 'to'> & { to: string }) {
  const tenantBase = useTenantBase();
  const href = to.startsWith('/') ? `${tenantBase}${to === '/' ? '' : to}` || '/' : to;
  return <Link to={href} {...rest} />;
}
