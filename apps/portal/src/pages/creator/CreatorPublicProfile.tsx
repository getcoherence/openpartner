/**
 * /creators/:handle on the app: forwards to the creator's storefront on the
 * public site (openpartner.dev/creators/<handle>), where visitors without
 * an account browse it and send requests. Old links (bios, emails) keep
 * working.
 *
 * `location.replace`, so this page never becomes a history entry: Back
 * from the storefront returns to wherever the visitor came from.
 */
import { useEffect } from 'react';
import { useParams } from 'react-router';
import { theme } from '../../theme.js';
import { publicStorefrontUrl } from '../../lib/public-site.js';

export function CreatorPublicProfilePage() {
  const { handle } = useParams<{ handle: string }>();
  const target = publicStorefrontUrl(handle ?? '');

  useEffect(() => {
    window.location.replace(target);
  }, [target]);

  return (
    <div style={{ minHeight: '100vh', background: theme.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <a href={target} style={{ color: theme.accentText, fontSize: 14 }}>
        Opening @{handle}&rsquo;s storefront…
      </a>
    </div>
  );
}
