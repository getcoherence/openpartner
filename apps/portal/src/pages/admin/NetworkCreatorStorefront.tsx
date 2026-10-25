/**
 * A creator's storefront inside the brand's portal: Network → Discover
 * creators → a creator (/admin/network/creators/:handle). The profile and
 * storefront visitors see on the public site. Message the creator, or
 * request a package (BookCreatorDialog): it goes into your conversation
 * with them (Network → Messages), they accept at a price, you pay upfront
 * through Stripe on their own account, they deliver, you approve.
 */
import { useState } from 'react';
import { useParams } from 'react-router';
import { ExternalLink, Globe } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBanner, Page } from '../../ui.js';
import { theme } from '../../theme.js';
import { TenantLink } from '../../tenant-link.js';
import { publicStorefrontUrl } from '../../lib/public-site.js';
import { ApiError } from '../creator/creator-api.js';
import { CreatorProfileView, useCreatorProfile } from '../creator/CreatorProfileView.js';
import { StorefrontSection } from '../creator/StorefrontSection.js';
import type { StorefrontPackage } from '../creator/storefront-shared.js';
import { BookCreatorDialog } from './BookCreatorDialog.js';
import { MessageCreatorDialog } from './NetworkMessages.js';

export function NetworkCreatorStorefrontPage() {
  const { handle } = useParams<{ handle: string }>();
  const { data, isLoading, error } = useCreatorProfile(handle);
  // undefined = closed; null = a custom deal; else the package's id.
  const [booking, setBooking] = useState<string | null | undefined>(undefined);
  const [messaging, setMessaging] = useState(false);

  const back = (
    <TenantLink to="/admin/network/creators" style={{ color: theme.textMuted, fontSize: 13, textDecoration: 'none' }}>
      ← Discover creators
    </TenantLink>
  );

  if (error instanceof ApiError && error.status === 404) {
    return (
      <Page title="Creator not found" actions={back}>
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
      <Page title={handle ? `@${handle}` : 'Creator'} actions={back}>
        {isLoading ? <Card>Loading…</Card> : <ErrorBanner error={error} />}
      </Page>
    );
  }

  return (
    <Page
      title={data.name}
      subtitle={data.bookingsOpen ? 'Message them, or request a package. You pay upfront once they accept, straight to their Stripe account.' : undefined}
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          {back}
          {data.bookingsOpen && (
            <Button variant="secondary" onClick={() => setMessaging(true)}>
              Message
            </Button>
          )}
          <a
            href={publicStorefrontUrl(data.handle)}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: theme.accentText, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4, textDecoration: 'none' }}
          >
            Public page <ExternalLink size={12} />
          </a>
        </div>
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
      {messaging && <MessageCreatorDialog creator={{ id: data.id, name: data.name }} onClose={() => setMessaging(false)} />}
    </Page>
  );
}
