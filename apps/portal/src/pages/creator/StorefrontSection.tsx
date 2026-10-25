/**
 * A creator's storefront: their channels and the packages under each
 * (the Network's docs/creator-storefront.md).
 *
 * Two places render it in the app:
 * - `onBook`: a brand's view of a creator (pages/admin/CreatorStorefront
 *   .tsx). The buttons book the package as a tracked deal.
 * - `preview`: the creator's own editor and setup flow. The buttons are
 *   inert.
 *
 * Visitors without an account see the storefront, with its request form,
 * on the public site (lib/public-site.ts).
 */
import { ExternalLink, RefreshCw } from 'lucide-react';
import { Button, Card } from '../../ui.js';
import { theme } from '../../theme.js';
import { VerifiedBadge } from '../../lib/VerifiedBadge.js';
import {
  audienceNoun,
  formatCompact,
  formatPackagePrice,
  groupByChannel,
  PLATFORM_LABELS,
  type StorefrontChannel,
  type StorefrontPackage,
} from './storefront-shared.js';

export function StorefrontSection({
  creatorName,
  packages,
  channels = [],
  preview = false,
  onBook,
}: {
  creatorName: string;
  packages: StorefrontPackage[];
  /** The creator's platforms. Absent → a flat package list. */
  channels?: StorefrontChannel[];
  preview?: boolean;
  /** A brand booking from the app: called with the package (null = custom). */
  onBook?: (pkg: StorefrontPackage | null) => void;
}) {
  const firstName = creatorName.split(' ')[0] || creatorName;
  const groups = groupByChannel(packages, channels);
  const book = (pkg: StorefrontPackage | null) => {
    if (!preview) onBook?.(pkg);
  };

  return (
    <>
      {!preview && <div style={{ height: 14 }} />}
      <Card>
        <h3 style={{ marginTop: 0, marginBottom: 4, fontSize: 15, fontWeight: 500 }}>Work with {firstName}</h3>
        <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14 }}>
          {preview
            ? `Pick a package and send a request. You talk it through with ${firstName} on OpenPartner, and pay through the booking once you agree.`
            : `Request a package. ${firstName} accepts at a price, you pay upfront straight to their Stripe account, and you can track the post with a link of its own.`}
        </div>
        <div style={{ display: 'grid', gap: 18 }}>
          {groups.map((g) => (
            <div key={g.key}>
              {g.channel ? (
                <ChannelHeader channel={g.channel} />
              ) : (
                (groups.length > 1 || g.platform) && (
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                    {g.platform ? (PLATFORM_LABELS[g.platform] ?? g.platform) : 'Across channels'}
                  </div>
                )
              )}
              {g.packages.length > 0 && (
                <div style={{ display: 'grid', gap: 8, marginTop: g.channel ? 10 : 0 }}>
                  {g.packages.map((p) => (
                    <PackageRow key={p.id} pkg={p} action={preview ? 'Request →' : 'Book →'} onAction={() => book(p)} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginTop: groups.length > 0 ? 16 : 0,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ flex: 1, fontSize: 13, color: theme.textMuted }}>
            {packages.length > 0 ? 'Looking for something custom?' : `${firstName} takes collaboration requests.`}
          </span>
          <Button size="sm" variant="secondary" onClick={() => book(null)}>
            {preview ? 'Get in touch' : 'Book a custom deal'}
          </Button>
        </div>
      </Card>
    </>
  );
}

/**
 * A channel's block: platform, handle, audience and the creator's pitch.
 * A count synced from the platform says so; anything else is the creator's
 * own number.
 */
export function ChannelHeader({ channel }: { channel: StorefrontChannel }) {
  const label = PLATFORM_LABELS[channel.platform] ?? channel.platform;
  // Each number is followed by where it came from: the platform's API, or
  // the creator. (A channel that hides its subscriber count has a typed
  // count but synced views.)
  const facts: React.ReactNode[] = [];
  const strong = (n: number) => <strong style={{ color: theme.text, fontWeight: 600 }}>{formatCompact(n)}</strong>;
  const synced = (
    <span
      key="synced"
      title={channel.statsSyncedAt ? `Last read ${new Date(channel.statsSyncedAt).toLocaleDateString()}` : undefined}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: theme.success }}
    >
      <RefreshCw size={11} /> Synced from {label}
    </span>
  );
  if (channel.followerCount != null) {
    facts.push(<span key="audience">{strong(channel.followerCount)} {audienceNoun(channel.platform)}</span>);
    if (!channel.followerCountSynced) facts.push(<span key="self" style={{ color: theme.textDim }}>Self-reported</span>);
  }
  if (channel.viewsPerVideo != null) {
    facts.push(
      <span key="views" title="Median views of the latest 10 uploads">
        {strong(channel.viewsPerVideo)} views per video
      </span>,
    );
  }
  if (channel.followerCountSynced || channel.viewsPerVideo != null) facts.push(synced);
  if (channel.cadence) facts.push(<span key="cadence">{channel.cadence}</span>);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{label}</span>
        {channel.profileUrl ? (
          <a
            href={channel.profileUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontFamily: theme.fontMono, fontSize: 12.5, color: theme.textMuted, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            {channel.handle}
            <ExternalLink size={11} />
          </a>
        ) : (
          <span style={{ fontFamily: theme.fontMono, fontSize: 12.5, color: theme.textMuted }}>{channel.handle}</span>
        )}
        {channel.verified && <VerifiedBadge compact />}
      </div>
      {facts.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12.5, color: theme.textMuted, marginTop: 4 }}>
          {facts.map((f, i) => (
            // The dot trails its item, so a wrapped line never starts with one.
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
              {f}
              {i < facts.length - 1 && <span aria-hidden="true" style={{ color: theme.textDim }}>·</span>}
            </span>
          ))}
        </div>
      )}
      {channel.description && (
        <div style={{ fontSize: 13, color: theme.text, marginTop: 6, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {channel.description}
        </div>
      )}
    </div>
  );
}

function PackageRow({ pkg, action, onAction }: { pkg: StorefrontPackage; action: string; onAction: () => void }) {
  return (
    <div
      style={{
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radiusSm,
        padding: '12px 14px',
        background: theme.surface,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600 }}>{pkg.title}</div>
        <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>{formatPackagePrice(pkg)}</div>
      </div>
      {pkg.description && (
        <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {pkg.description}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <Button size="sm" onClick={onAction}>{action}</Button>
      </div>
    </div>
  );
}
