/**
 * A creator's profile as brands see it: cover + avatar, bio, their
 * storefront (channels and packages, while bookings are open) or their
 * channels, audience, sample work and past collaborations. From the
 * Network's public GET /creators/by-handle/:handle, through the
 * openpartner proxy (anonymous for that route).
 *
 * Brands on OpenPartner see it at Network → Discover creators → a creator
 * (pages/admin/CreatorStorefront.tsx), where the storefront books tracked
 * deals. Visitors without an account see the same storefront on the
 * public site (lib/public-site.ts).
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { audienceSizeLabel } from '@openpartner/db';
import { Card } from '../../ui.js';
import { theme } from '../../theme.js';
import { VerifiedBadge } from '../../lib/VerifiedBadge.js';
import { creatorApi } from './creator-api.js';
import { ListingBanner } from './ListingBanner.js';
import { PLATFORM_LABELS, type StorefrontChannel, type StorefrontPackage } from './storefront-shared.js';

export interface PublicProfile {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  /** Wide banner; null or absent (older Network) → washed from the avatar. */
  coverImageUrl?: string | null;
  bio: string | null;
  categories: string[];
  audienceLocations: string[];
  audienceAgeRange: string | null;
  /** Bucket slug (see AUDIENCE_SIZES); absent on an older Network. */
  audienceSize?: string | null;
  portfolioLinks: string[];
  pastBrands: string[];
  platforms: StorefrontChannel[];
  /** Storefront (the Network's docs/creator-storefront.md); absent on an
   *  older Network. Packages only come back while bookings are open. */
  bookingsOpen?: boolean;
  packages?: StorefrontPackage[];
}

export function useCreatorProfile(handle: string | undefined) {
  return useQuery({
    queryKey: ['creator-public', handle],
    queryFn: () => creatorApi<PublicProfile>(`/creators/by-handle/${encodeURIComponent(handle ?? '')}`),
    enabled: !!handle,
    retry: false,
  });
}

/** `storefront` renders while the creator has bookings open; otherwise the
 *  profile lists their channels on their own. */
export function CreatorProfileView({ data, storefront }: { data: PublicProfile; storefront?: ReactNode }) {
  const totalReach = data.platforms.reduce((sum, p) => sum + (p.followerCount ?? 0), 0);
  const allSynced = data.platforms.length > 0 && data.platforms.every((p) => p.followerCount == null || p.followerCountSynced);
  const audienceSize = audienceSizeLabel(data.audienceSize);

  return (
    <>
      <Card style={{ overflow: 'hidden' }}>
        {/* Cover (or a wash of the avatar), bleeding over the Card's 20px
            padding; the avatar sits half over it, profile style. */}
        <ListingBanner coverUrl={data.coverImageUrl} logoUrl={data.avatarUrl} style={{ margin: '-20px -20px 0' }} />
        <div style={{ position: 'relative', marginTop: -40 }}>
          {data.avatarUrl ? (
            <img
              src={data.avatarUrl}
              alt={data.name}
              style={{ width: 80, height: 80, borderRadius: '50%', objectFit: 'cover', background: theme.surface2, border: `4px solid ${theme.surface}`, display: 'block' }}
            />
          ) : (
            <div style={{ width: 80, height: 80, borderRadius: '50%', background: theme.accent, color: theme.accentInk, border: `4px solid ${theme.surface}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 600 }}>
              {data.name.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
        <div style={{ marginTop: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 22 }}>{data.name}</h1>
            <div style={{ color: theme.textMuted, fontSize: 13, fontFamily: theme.fontMono, marginTop: 4 }}>@{data.handle}</div>
            {data.categories.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                {data.categories.map((c) => (
                  <span key={c} style={{ background: theme.surface2, color: theme.textMuted, fontSize: 11, padding: '2px 8px', borderRadius: 12 }}>
                    {c}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        {data.bio && <p style={{ marginTop: 16, fontSize: 14, color: theme.text, lineHeight: 1.5 }}>{data.bio}</p>}
      </Card>

      {data.bookingsOpen && storefront}

      {/* The storefront shows each channel with its packages; otherwise list them here. */}
      {!data.bookingsOpen && (data.platforms.length > 0 || totalReach > 0) && (
        <>
          <div style={{ height: 14 }} />
          <Card>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>Platforms</h3>
              {totalReach > 0 && (
                <span style={{ color: theme.textMuted, fontSize: 13 }}>
                  {allSynced ? 'Total reach' : 'Total self-reported reach'}: <strong style={{ color: theme.text }}>{totalReach.toLocaleString()}</strong>
                </span>
              )}
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {data.platforms.map((p) => (
                <a
                  key={p.id}
                  href={p.profileUrl ?? '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 12px',
                    background: theme.surface2,
                    border: `1px solid ${theme.borderSubtle}`,
                    borderRadius: theme.radiusSm,
                    textDecoration: 'none',
                    color: theme.text,
                  }}
                >
                  <div style={{ width: 100, fontSize: 13, color: theme.textMuted }}>
                    {PLATFORM_LABELS[p.platform] ?? p.platform}
                  </div>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: theme.fontMono, fontSize: 13 }}>{p.handle}</span>
                    {p.verified && <VerifiedBadge />}
                  </div>
                  {p.followerCount != null && (
                    <div style={{ fontSize: 13, color: theme.textMuted }}>
                      {p.followerCount.toLocaleString()} followers
                    </div>
                  )}
                  <ExternalLink size={14} style={{ color: theme.textDim }} />
                </a>
              ))}
            </div>
          </Card>
        </>
      )}

      {(data.audienceLocations.length > 0 || data.audienceAgeRange || audienceSize) && (
        <>
          <div style={{ height: 14 }} />
          <Card>
            <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 15, fontWeight: 500 }}>Audience</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
              {audienceSize && <Stat label="Audience size" value={audienceSize} />}
              {data.audienceLocations.length > 0 && (
                <Stat label="Top countries" value={data.audienceLocations.join(' · ')} />
              )}
              {data.audienceAgeRange && (
                <Stat label="Age range" value={data.audienceAgeRange} />
              )}
            </div>
          </Card>
        </>
      )}

      {data.portfolioLinks.length > 0 && (
        <>
          <div style={{ height: 14 }} />
          <Card>
            <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 15, fontWeight: 500 }}>Sample work</h3>
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.portfolioLinks.map((u) => (
                <li key={u} style={{ fontSize: 13, wordBreak: 'break-all' }}>
                  <a href={u} target="_blank" rel="noopener noreferrer" style={{ color: theme.accentText }}>{u}</a>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}

      {data.pastBrands.length > 0 && (
        <>
          <div style={{ height: 14 }} />
          <Card>
            <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 15, fontWeight: 500 }}>Past collaborations</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {data.pastBrands.map((b) => (
                <span key={b} style={{ background: theme.surface2, color: theme.text, fontSize: 13, padding: '4px 10px', borderRadius: 12, border: `1px solid ${theme.borderSubtle}` }}>
                  {b}
                </span>
              ))}
            </div>
          </Card>
        </>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 14, color: theme.text }}>{value}</div>
    </div>
  );
}
