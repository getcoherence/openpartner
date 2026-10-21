import { Navigate, useParams } from 'react-router';
import { withNext } from '../lib/signin-next.js';

/**
 * /go/creators/:handle — a creator's in-app storefront for whichever brand
 * workspace the visitor uses, for links from outside the app that can't
 * know it (the public storefront's "Book as a tracked deal" on
 * openpartner.dev/creators/<handle>).
 *
 * Multi-tenant: /workspaces with ?next=, which sends a signed-out visitor
 * to /signin and back, enters a single workspace or offers the picker,
 * then opens /t/<slug>/admin/network/creators/<handle>.
 * Single-tenant or a custom-domain portal: the Shell is at the root, so
 * it's that path directly; the Shell sends a signed-out visitor to /login.
 */
export function GoCreatorPage({ multiTenant }: { multiTenant: boolean }) {
  const { handle = '' } = useParams<{ handle: string }>();
  const storefront = `/admin/network/creators/${encodeURIComponent(handle)}`;
  return <Navigate to={multiTenant ? withNext('/workspaces', storefront) : storefront} replace />;
}
