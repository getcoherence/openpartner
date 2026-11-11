import { Card } from '../../ui.js';
import { NetworkPortalLink, type NetworkPortalPage } from '../../lib/network-portal.js';

/**
 * For a partner who has their own Network account. The Network lets a
 * brand act only for a creator who never signed in to it themselves (or
 * who applied to that brand on their own), so for everyone else the
 * brand's /network/me… reads answer `ownNetworkAccount: true` and its
 * writes 403 `network_own_account` (docs/network-protocol.md, "Acting as
 * a partner"). Those partners manage the Network side in their own
 * portal; this is the pointer to it.
 */
export function OwnNetworkAccountNotice({
  children,
  page,
  linkLabel = 'Open your Network portal ↗',
}: {
  children: string;
  page: NetworkPortalPage;
  linkLabel?: string;
}) {
  return (
    <Card>
      <div style={{ fontSize: 14 }}>
        {children} <NetworkPortalLink page={page}>{linkLabel}</NetworkPortalLink>
      </div>
    </Card>
  );
}
