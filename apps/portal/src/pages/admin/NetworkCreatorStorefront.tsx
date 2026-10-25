/**
 * A creator's storefront inside the brand's portal: Network → Discover
 * creators → a creator (/admin/network/creators/:handle). The profile and
 * storefront visitors see on the public site, but each package books as a
 * tracked deal (BookCreatorDialog): the creator accepts, becomes your
 * partner with a tracked link, delivers the post, and you pay once you
 * approve it on Network → Bookings.
 */
import { useState } from 'react';
import { useParams } from 'react-router';
import { ExternalLink, Globe } from 'lucide-react';
import { Card, EmptyState, ErrorBanner, Page } from '../../ui.js';
import { theme } from '../../theme.js';
import { TenantLink } from '../../tenant-link.js';
import { publicStorefrontUrl } from '../../lib/public-site.js';
import { ApiError } from '../creator/creator-api.js';
import { CreatorProfileView, useCreatorProfile } from '../creator/CreatorProfileView.js';
import { StorefrontSection } from '../creator/StorefrontSection.js';
import type { StorefrontPackage } from '../creator/storefront-shared.js';
import { BookCreatorDialog } from './BookCreatorDialog.js';

export function NetworkCreatorStorefrontPage() {
  const { handle } = useParams<{ handle: string }>();
  const { data, isLoading, error } = useCreatorProfile(handle);
  // undefined = closed; null = a custom deal; else the package's id.
  const [booking, setBooking] = useState<string | null | undefined>(undefined);

  const back = (
    <TenantLink to="/admin/network/creators" style={{ color: theme.textMuted, fontSize: 13, textDecoration: 'none' }}>
      ← Discover creators
    </TenantLink>
  );

  if (error instanceof ApiError && error.status === 404) {
    return (
      <Page title="Creator not found" back={back}>
        <EmptyState
          title={`No creator @${handle}`}
          hint="They may have changed their handle, or their profile isn’t public right now."
          icon={<Globe size={28} strokeWidth={1.25} />}
        />
      </Page>
    );
  }
  if (isLoading || !data) {
    return (
      <Page title={handle ? `@${handle}` : 'Creator'} back={back}>
        {isLoading ? <Card>Loading…</Card> : <ErrorBanner error={error} />}
      </Page>
    );
  }

  return (
    <Page
      title={data.name}
      back={back}
      subtitle={
        <>
          {data.bookingsOpen && 'Book a package as a tracked deal, paid once you approve the post. '}
          <a
            href={publicStorefrontUrl(data.handle)}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: theme.accentText, display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}
          >
            Public page <ExternalLink size={12} />
          </a>
        </>
      }
    >
      <div style={{ maxWidth: 760 }}>
        {!data.bookingsOpen && (
          <div
            style={{
              marginBottom: 14,
              padding: '10px 12px',
              fontSize: 13,
              color: theme.textMuted,
              background: theme.surface2,
              border: `1px solid ${theme.borderSubtle}`,
              borderRadius: theme.radiusSm,
            }}
          >
            {data.name.split(' ')[0]} isn&rsquo;t taking bookings right now. You can still invite them to apply to your program from
            Discover creators.
          </div>
        )}
        <CreatorProfileView
          data={data}
          storefront={
            <StorefrontSection
              creatorName={data.name}
              packages={data.packages ?? []}
              channels={data.platforms}
              onBook={(pkg: StorefrontPackage | null) => setBooking(pkg?.id ?? null)}
            />
          }
        />
      </div>
      {booking !== undefined && (
        <BookCreatorDialog
          creator={{ id: data.id, name: data.name, handle: data.handle }}
          initialPackageId={booking}
          onClose={() => setBooking(undefined)}
        />
      )}
    </Page>
  );
}
