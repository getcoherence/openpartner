/**
 * Verified work on a creator's storefront (the Network's
 * docs/campaign-reports.md §10): finished bookings the creator picked to
 * show, each with what its brand lets them share. Brands see it on the
 * in-app storefront, the creator in the editor's preview. Never a price.
 */
import { ExternalLink } from 'lucide-react';
import { formatDate, moneyByCurrency } from '../../ui.js';
import { theme } from '../../theme.js';
import { PlatformMark } from '../../lib/PlatformMark.js';
import { SocialStatsLine, Tag, type SocialStats } from '../../lib/BookingReport.js';
import { PLATFORM_LABELS } from './storefront-shared.js';

export interface CaseStudyPost {
  url: string;
  platform: 'youtube' | 'website' | 'instagram' | 'tiktok' | 'other';
  label: string;
  publishedAt: string | null;
  verifiedAccount: boolean;
  youtube: { views: number | null; likes: number | null; comments: number | null } | null;
  /** From the creator's verified Instagram or TikTok; absent on an older Network. */
  social?: SocialStats | null;
  reported: { views: number | null; likes: number | null; comments: number | null; shares: number | null; reportedAt: string } | null;
}

export interface CaseStudy {
  title: string;
  platform: string | null;
  brand: { name: string; logoUrl: string | null };
  completedAt: string | null;
  posts: CaseStudyPost[];
  /** The booking's currency: revenue in it is listed first. */
  currency: string | null;
  /** Null when the brand shares the posts only. */
  results: {
    clicks: number;
    leads: number;
    sales: number;
    /** Null when the brand doesn't share revenue. */
    netRevenueByCurrency: Record<string, number> | null;
    asOf: string;
    final: boolean;
  } | null;
}

/** The brands shown verified, to leave out of the creator's own list. */
export function verifiedBrandNames(items: CaseStudy[] | undefined): Set<string> {
  return new Set((items ?? []).map((s) => s.brand.name.trim().toLowerCase()));
}

const count = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString());

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function PostLine({ p }: { p: CaseStudyPost }) {
  return (
    <div style={{ padding: '8px 0', borderTop: `1px solid ${theme.borderSubtle}`, display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <a
          href={p.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: theme.accentText, minWidth: 0, wordBreak: 'break-all' }}
        >
          <ExternalLink size={12} style={{ flexShrink: 0 }} />
          {hostOf(p.url)}
        </a>
        {p.verifiedAccount && <Tag tone="good">✓ Verified account</Tag>}
      </div>
      {p.youtube ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13, color: theme.textMuted }}>
          <a href={p.url} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: theme.text, textDecoration: 'none', fontWeight: 600 }}>
            <PlatformMark platform="youtube" size={16} />
            YouTube
          </a>
          <span>{count(p.youtube.views)} views</span>
          <span>{p.youtube.likes == null ? 'Likes hidden' : `${count(p.youtube.likes)} likes`}</span>
          <span>{p.youtube.comments == null ? 'Comments hidden' : `${count(p.youtube.comments)} comments`}</span>
        </div>
      ) : p.social ? (
        <div style={{ fontSize: 13, color: theme.textMuted }}>
          <SocialStatsLine stats={p.social} />
        </div>
      ) : (
        p.reported && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13, color: theme.textMuted }}>
            <Tag>Reported by the creator</Tag>
            {p.reported.views != null && <span>{count(p.reported.views)} {p.label === 'linkedin' || p.label === 'x' ? 'impressions' : 'views'}</span>}
            {p.reported.likes != null && <span>{count(p.reported.likes)} likes</span>}
            {p.reported.comments != null && <span>{count(p.reported.comments)} comments</span>}
            {p.reported.shares != null && <span>{count(p.reported.shares)} shares</span>}
          </div>
        )
      )}
    </div>
  );
}

function CaseStudyCard({ s }: { s: CaseStudy }) {
  const r = s.results;
  const hasYouTube = s.posts.some((p) => p.youtube);
  const facts = r
    ? [
        `${count(r.clicks)} clicks`,
        `${count(r.leads)} signups`,
        `${count(r.sales)} sales`,
        ...(r.netRevenueByCurrency && Object.keys(r.netRevenueByCurrency).length > 0
          ? [`${moneyByCurrency(r.netRevenueByCurrency, s.currency ?? Object.keys(r.netRevenueByCurrency)[0]!)} revenue`]
          : []),
      ]
    : [];
  return (
    <div style={{ background: theme.surface2, border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm, padding: '12px 14px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {s.brand.logoUrl ? (
          <img src={s.brand.logoUrl} alt="" style={{ width: 32, height: 32, borderRadius: 8, objectFit: 'cover', background: theme.surface, flexShrink: 0 }} />
        ) : (
          <div style={{ width: 32, height: 32, borderRadius: 8, background: theme.surface3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, flexShrink: 0 }}>
            {s.brand.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{s.brand.name}</span>
            <Tag tone="good" title="Booked, delivered and approved on OpenPartner">✓ Verified booking</Tag>
          </div>
          <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 2 }}>
            {[s.title, s.platform ? (PLATFORM_LABELS[s.platform] ?? s.platform) : null, s.completedAt ? formatDate(s.completedAt) : null].filter(Boolean).join(' · ')}
          </div>
        </div>
      </div>
      {s.posts.length > 0 && <div style={{ marginTop: 10 }}>{s.posts.map((p) => <PostLine key={p.url} p={p} />)}</div>}
      {r && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${theme.borderSubtle}` }}>
          <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Tracked by OpenPartner{hasYouTube && <span style={{ textTransform: 'none', letterSpacing: 0 }}> · not YouTube data</span>}
          </div>
          <div style={{ fontSize: 13.5, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
            {facts.join(' · ')}
            {!r.final && <span style={{ color: theme.textMuted }}> · as of {formatDate(r.asOf)}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export function CaseStudyList({ items }: { items: CaseStudy[] }) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {items.map((s, i) => (
        <CaseStudyCard key={`${s.brand.name}-${s.title}-${i}`} s={s} />
      ))}
    </div>
  );
}
