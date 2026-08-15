/**
 * Public creator profile at /creators/:handle. No signin required —
 * brands and the open web can browse before/without applying. Hits
 * the Network's /creators/by-handle/:handle through the openpartner
 * proxy (which runs anonymously for that route).
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ExternalLink, Globe } from 'lucide-react';
import { Card, ErrorBanner, EmptyState } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi, ApiError } from './creator-api.js';

interface PlatformRow {
  id: string;
  platform: string;
  handle: string;
  profileUrl: string | null;
  followerCount: number | null;
  verified: boolean;
}

interface PublicProfile {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  bio: string | null;
  categories: string[];
  audienceLocations: string[];
  audienceAgeRange: string | null;
  portfolioLinks: string[];
  pastBrands: string[];
  platforms: PlatformRow[];
}

const PLATFORM_LABELS: Record<string, string> = {
  tiktok: 'TikTok',
  instagram: 'Instagram',
  youtube: 'YouTube',
  twitter: 'X / Twitter',
  linkedin: 'LinkedIn',
  substack: 'Substack',
  twitch: 'Twitch',
  podcast: 'Podcast',
  website: 'Website',
};

export function CreatorPublicProfilePage() {
  const { handle } = useParams<{ handle: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ['creator-public', handle],
    queryFn: () => creatorApi<PublicProfile>(`/creators/by-handle/${encodeURIComponent(handle ?? '')}`),
    enabled: !!handle,
    retry: false,
  });

  if (error instanceof ApiError && error.status === 404) {
    return (
      <Shell>
        <EmptyState title={`No creator @${handle}`} hint="Maybe a typo? Or they haven't filled in a handle yet." icon={<Globe size={28} strokeWidth={1.25} />} />
      </Shell>
    );
  }
  if (isLoading) {
    return <Shell><Card>Loading…</Card></Shell>;
  }
  if (!data) {
    return <Shell><ErrorBanner error={error} /></Shell>;
  }

  const totalReach = data.platforms.reduce((sum, p) => sum + (p.followerCount ?? 0), 0);

  return (
    <Shell>
      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          {data.avatarUrl ? (
            <img
              src={data.avatarUrl}
              alt={data.name}
              style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover', background: theme.surface2 }}
            />
          ) : (
            <div style={{ width: 72, height: 72, borderRadius: '50%', background: theme.accent, color: theme.accentInk, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 600 }}>
              {data.name.charAt(0).toUpperCase()}
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
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

      {(data.platforms.length > 0 || totalReach > 0) && (
        <>
          <div style={{ height: 14 }} />
          <Card>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>Platforms</h3>
              {totalReach > 0 && (
                <span style={{ color: theme.textMuted, fontSize: 13 }}>
                  Total self-reported reach: <strong style={{ color: theme.text }}>{totalReach.toLocaleString()}</strong>
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
                  <div style={{ flex: 1, fontFamily: theme.fontMono, fontSize: 13 }}>{p.handle}</div>
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

      {(data.audienceLocations.length > 0 || data.audienceAgeRange) && (
        <>
          <div style={{ height: 14 }} />
          <Card>
            <h3 style={{ marginTop: 0, marginBottom: 12, fontSize: 15, fontWeight: 500 }}>Audience</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
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
                  <a href={u} target="_blank" rel="noopener noreferrer" style={{ color: theme.accent }}>{u}</a>
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
    </Shell>
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

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', background: theme.bg, padding: '40px 20px' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <div style={{ marginBottom: 24, fontSize: 13 }}>
          <Link to="/" style={{ color: theme.textMuted, textDecoration: 'none' }}>← OpenPartner</Link>
        </div>
        {children}
      </div>
    </div>
  );
}
