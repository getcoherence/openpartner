/**
 * A booking's report (the Network's docs/campaign-reports.md): what was
 * delivered and what it drove. One view for the brand, the creator and a
 * shared link; the Network decides what each audience gets, so a field it
 * leaves out simply doesn't show.
 *
 * What came from YouTube and what OpenPartner tracked sit in separate
 * sections, so nobody reads the conversion numbers as YouTube's. A
 * creator's own numbers carry "Reported by the creator" and are never added
 * to verified ones. Prints to A4 (Save as PDF), like payout statements.
 */
import type { CSSProperties, ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { formatDate, money, moneyByCurrency } from '../ui.js';
import { theme } from '../theme.js';
import { PlatformMark } from './PlatformMark.js';

export type CreatorShare = 'none' | 'posts' | 'counts' | 'revenue';

export interface ReportPost {
  url: string;
  platform: 'youtube' | 'website' | 'instagram' | 'tiktok' | 'other';
  label: string;
  account: 'verified' | 'other_account' | 'unverified' | 'unsupported';
  reachable: boolean | null;
  publishedAt: string | null;
  publishedBeforeAccept: boolean | null;
  link: 'booking' | 'general' | 'both' | 'none' | 'unknown';
  youtube: { views: number | null; likes: number | null; comments: number | null } | null;
  /** Read from the creator's verified Instagram or TikTok; absent on an older Network. */
  social?: SocialStats | null;
  reported: { views: number | null; likes: number | null; comments: number | null; shares: number | null; reportedAt: string } | null;
  /** The brand's view only. */
  duplicate?: 'none' | 'same_brand' | 'other_brand';
  error?: string | null;
}

export interface ReportResults {
  scope: 'link' | 'partner';
  checkedAt: string;
  clicks: number;
  bySource: Array<{ host: string; clicks: number }>;
  leads: number;
  sales: number;
  refundedSales: number | null;
  revenueByCurrency: Record<string, number> | null;
  refundedByCurrency: Record<string, number> | null;
  netRevenueByCurrency: Record<string, number> | null;
  daily: Array<{ date: string; clicks: number; leads: number; sales: number }>;
  error: string | null;
}

export interface BookingReport {
  bookingId?: string;
  title: string;
  platform: string | null;
  /** The booking's currency: revenue in it is listed first. */
  currency: string | null;
  status: string;
  deliveredAt: string | null;
  completedAt: string | null;
  refunded: boolean;
  brand: { name: string; logoUrl: string | null } | null;
  creator: { name: string; handle: string | null; avatarUrl: string | null; storefrontUrl: string | null } | null;
  posts: ReportPost[];
  results: ReportResults | null;
  window: { clickSince: string; clickUntil: string; conversionUntil: string; closed: boolean; asOf: string | null } | null;
  spend: {
    currency: string;
    paid: number;
    refunded: number;
    net: number;
    costPerClick: number | null;
    costPerLead: number | null;
    costPerSale: number | null;
    returnOnSpend: number | null;
  } | null;
  price?: { amount: number; currency: string };
  sharing?: {
    creatorShare: CreatorShare | null;
    effective: CreatorShare;
    brandDefault: CreatorShare;
    /** Shown as verified work on the creator's storefront; absent on an older Network. */
    onCreatorStorefront?: boolean;
  };
  linkState?: 'none' | 'pending' | 'ready' | 'failed';
  trackedUrls?: string[];
}

/** A post's numbers from Instagram or TikTok (the Network's
 *  docs/campaign-reports.md §4). */
export interface SocialStats {
  platform: 'instagram' | 'tiktok';
  views: number | null;
  likes: number | null;
  comments: number | null;
  /** TikTok only. */
  shares: number | null;
}

export const SHARE_LABELS: Record<CreatorShare, string> = {
  none: 'No',
  posts: 'Posts only',
  counts: 'Posts and results',
  revenue: 'Also revenue',
};

/** A4 print rules: the report alone, no app chrome, no buttons. */
export const REPORT_PRINT_CSS = `
@media print {
  @page { size: A4; margin: 14mm; }
  body { background: #fff !important; }
  .op-report-noprint, nav, header, aside { display: none !important; }
  .op-report { box-shadow: none !important; border: none !important; }
  .op-report a[data-print-url]::after { content: " (" attr(href) ")"; font-size: 10px; color: #555; word-break: break-all; }
}
`;

const count = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString());

/** "Instagram 52,000 views 812 likes 46 comments": what its platform says. */
export function SocialStatsLine({ stats }: { stats: SocialStats }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: theme.text, fontWeight: 600 }}>
        <PlatformMark platform={stats.platform} size={16} />
        {stats.platform === 'instagram' ? 'Instagram' : 'TikTok'}
      </span>
      {stats.views != null && <span>{count(stats.views)} views</span>}
      {stats.likes != null && <span>{count(stats.likes)} likes</span>}
      {stats.comments != null && <span>{count(stats.comments)} comments</span>}
      {stats.shares != null && <span>{count(stats.shares)} shares</span>}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div style={{ background: theme.surface2, border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm, padding: '10px 12px', minWidth: 0 }}>
      <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, marginTop: 4, fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word' }}>{value}</div>
      {hint && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export function Tag({ children, tone = 'neutral', title }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn'; title?: string }) {
  const palette = {
    neutral: { bg: theme.surface3, fg: theme.textMuted },
    good: { bg: theme.successSoft, fg: theme.success },
    warn: { bg: theme.warnSoft, fg: theme.warn },
  }[tone];
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: palette.bg, color: palette.fg, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

const SECTION: CSSProperties = { fontSize: 12, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em', margin: '18px 0 8px' };
const GRID: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 };

function Party({ name, image, href, sub }: { name: string; image: string | null; href?: string | null; sub?: string | null }) {
  const face = image ? (
    <img src={image} alt="" style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover', background: theme.surface2 }} />
  ) : (
    <div style={{ width: 36, height: 36, borderRadius: 8, background: theme.surface3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600 }}>
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
  const text = (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontWeight: 600, color: theme.text }}>{name}</div>
      {sub && <div style={{ fontSize: 12, color: theme.textMuted }}>{sub}</div>}
    </div>
  );
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      {face}
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
          {text}
        </a>
      ) : (
        text
      )}
    </div>
  );
}

function PostRow({ p, editor }: { p: ReportPost; editor?: (p: ReportPost) => ReactNode }) {
  const tags: ReactNode[] = [];
  if (p.duplicate === 'same_brand') tags.push(<Tag key="dup" tone="warn">Also delivered for another of your bookings</Tag>);
  if (p.duplicate === 'other_brand') tags.push(<Tag key="dup" tone="warn">Also delivered for another booking</Tag>);
  if (p.account === 'verified') tags.push(<Tag key="acc" tone="good">✓ Verified account</Tag>);
  if (p.link === 'booking' || p.link === 'both') tags.push(<Tag key="link" tone="good">✓ Booking link</Tag>);
  else if (p.link === 'general') tags.push(<Tag key="link" tone="warn" title="Results count the booking's own link">General link</Tag>);
  else if (p.link === 'none') tags.push(<Tag key="link" tone="warn">No tracked link</Tag>);
  if (p.publishedBeforeAccept) tags.push(<Tag key="pub" tone="warn">Published before the booking</Tag>);
  else if (p.publishedAt) tags.push(<Tag key="pub">Published {formatDate(p.publishedAt)}</Tag>);

  return (
    <div style={{ padding: '10px 0', borderTop: `1px solid ${theme.borderSubtle}` }}>
      <a
        href={p.url}
        data-print-url
        target="_blank"
        rel="noopener noreferrer nofollow"
        style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: theme.accentText, wordBreak: 'break-all' }}
      >
        <ExternalLink size={12} style={{ flexShrink: 0 }} />
        {p.url}
      </a>
      {tags.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>{tags}</div>}
      <div style={{ marginTop: 8, fontSize: 13, color: theme.textMuted }}>
        {p.youtube ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <a href={p.url} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: theme.text, textDecoration: 'none', fontWeight: 600 }}>
              <PlatformMark platform="youtube" size={16} />
              YouTube
            </a>
            <span>{count(p.youtube.views)} views</span>
            <span>{p.youtube.likes == null ? 'Likes hidden' : `${count(p.youtube.likes)} likes`}</span>
            <span>{p.youtube.comments == null ? 'Comments hidden' : `${count(p.youtube.comments)} comments`}</span>
          </div>
        ) : p.social ? (
          <SocialStatsLine stats={p.social} />
        ) : p.reported ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <Tag>Reported by the creator · {formatDate(p.reported.reportedAt)}</Tag>
            {p.reported.views != null && <span>{count(p.reported.views)} {p.label === 'linkedin' || p.label === 'x' ? 'impressions' : 'views'}</span>}
            {p.reported.likes != null && <span>{count(p.reported.likes)} likes</span>}
            {p.reported.comments != null && <span>{count(p.reported.comments)} comments</span>}
            {p.reported.shares != null && <span>{count(p.reported.shares)} shares</span>}
          </div>
        ) : (
          <span>Not available</span>
        )}
      </div>
      {editor?.(p)}
    </div>
  );
}

export function BookingReportView({
  report,
  actions,
  postEditor,
  footer,
}: {
  report: BookingReport;
  /** Buttons above the report (share, refresh, print); hidden in print. */
  actions?: ReactNode;
  /** Under each post: the creator's own numbers. */
  postEditor?: (p: ReportPost) => ReactNode;
  /** Below the report: "Measured by OpenPartner" on a shared page. */
  footer?: ReactNode;
}) {
  const r = report.results;
  const hasYouTube = report.posts.some((p) => p.youtube);
  const primary = report.currency ?? Object.keys(r?.netRevenueByCurrency ?? {})[0] ?? 'USD';
  const w = report.window;
  return (
    <div className="op-report">
      <style>{REPORT_PRINT_CSS}</style>
      {actions && (
        <div className="op-report-noprint" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', marginBottom: 12 }}>
          {actions}
        </div>
      )}

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          {report.brand && <Party name={report.brand.name} image={report.brand.logoUrl} />}
          {report.brand && report.creator && <span style={{ color: theme.textDim }}>×</span>}
          {report.creator && (
            <Party
              name={report.creator.name}
              image={report.creator.avatarUrl}
              href={report.creator.storefrontUrl}
              sub={report.creator.handle ? `@${report.creator.handle}` : null}
            />
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {report.refunded && <Tag tone="warn">Refunded</Tag>}
          {r?.scope === 'partner' && (
            <Tag tone="warn" title="This booking has no link of its own: these are everything the creator drove to the program since delivery">
              Partner-wide
            </Tag>
          )}
          {w?.closed && <Tag>Closed</Tag>}
        </div>
      </div>
      <h2 style={{ fontSize: 18, margin: '14px 0 2px' }}>{report.title}</h2>
      <div style={{ fontSize: 13, color: theme.textMuted }}>
        Delivered {formatDate(report.deliveredAt)}
        {report.price && <> · {money(report.price.amount, report.price.currency)}</>}
      </div>

      {r && (
        <>
          <div style={SECTION}>Tracked by OpenPartner{hasYouTube && <span style={{ textTransform: 'none', letterSpacing: 0 }}> · not YouTube data</span>}</div>
          <div style={GRID}>
            <Tile label="Clicks" value={count(r.clicks)} />
            <Tile label="Signups" value={count(r.leads)} />
            <Tile label="Sales" value={count(r.sales)} hint={r.refundedSales ? `${r.refundedSales} refunded` : undefined} />
            {r.netRevenueByCurrency && (
              <Tile
                label="Revenue"
                value={moneyByCurrency(r.netRevenueByCurrency, primary)}
                hint={Object.keys(r.refundedByCurrency ?? {}).length > 0 ? `${moneyByCurrency(r.refundedByCurrency ?? {}, primary)} refunded` : undefined}
              />
            )}
          </div>
          {r.bySource.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {r.bySource.map((s) => (
                <Tag key={s.host}>
                  {s.host} · {count(s.clicks)}
                </Tag>
              ))}
            </div>
          )}
          {r.scope === 'partner' && <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 8 }}>Approximate</div>}
        </>
      )}

      {report.spend && (
        <>
          <div style={SECTION}>Spend</div>
          <div style={GRID}>
            <Tile
              label="Paid"
              value={money(report.spend.net, report.spend.currency)}
              hint={report.spend.refunded > 0 ? `${money(report.spend.refunded, report.spend.currency)} refunded` : undefined}
            />
            <Tile label="Per click" value={report.spend.costPerClick == null ? '—' : money(report.spend.costPerClick, report.spend.currency)} />
            <Tile label="Per signup" value={report.spend.costPerLead == null ? '—' : money(report.spend.costPerLead, report.spend.currency)} />
            <Tile label="Per sale" value={report.spend.costPerSale == null ? '—' : money(report.spend.costPerSale, report.spend.currency)} />
            {report.spend.returnOnSpend != null && <Tile label="Return" value={`${report.spend.returnOnSpend.toFixed(2)}×`} />}
          </div>
        </>
      )}

      <div style={SECTION}>Posts</div>
      <div>
        {report.posts.map((p) => (
          <PostRow key={p.url} p={p} editor={postEditor} />
        ))}
      </div>

      {w && (
        <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 16 }}>
          Clicks {formatDate(w.clickSince)} – {formatDate(w.clickUntil)} · Conversions through {formatDate(w.conversionUntil)}
          {w.asOf && <> · As of {formatDate(w.asOf)}</>}
        </div>
      )}
      {footer}
    </div>
  );
}
