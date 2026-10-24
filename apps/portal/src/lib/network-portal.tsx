import type { ReactNode } from 'react';
import { theme } from '../theme.js';

/**
 * The creator's own Network portal: the hosted app's /creator/* pages
 * (pages/creator/*, which reach the Network through /api/creator-api with
 * the creator's own session). The Network's sign-in links land there (its
 * PORTAL_URL), so that is where a partner is signed in as a creator,
 * whichever brand's portal (hosted, custom domain or self-hosted) sent
 * them.
 *
 * A brand's partner pages only see that brand's side of the creator
 * (openpartner-network#28): its partnership, its applications. Everything
 * across brands lives in the Network portal, so those pages link here.
 *
 * VITE_NETWORK_PORTAL_URL points a local or staging portal at its own copy.
 */
export const NETWORK_PORTAL_URL = (
  (import.meta.env.VITE_NETWORK_PORTAL_URL as string | undefined) ?? 'https://app.openpartner.dev'
).replace(/\/$/, '');

export type NetworkPortalPage = 'affiliations' | 'requests';

export const networkPortalUrl = (page: NetworkPortalPage) => `${NETWORK_PORTAL_URL}/creator/${page}`;

/** Opens in a new tab: it's another app, with its own sign-in. */
export function NetworkPortalLink({ page, children }: { page: NetworkPortalPage; children: ReactNode }) {
  return (
    <a
      href={networkPortalUrl(page)}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: theme.accentText, fontWeight: 500 }}
    >
      {children}
    </a>
  );
}
