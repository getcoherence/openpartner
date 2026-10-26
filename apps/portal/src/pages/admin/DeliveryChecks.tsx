/**
 * Badges for a tracked booking's delivered posts: is each post on the
 * creator's verified account, does it carry their tracked link, when was it
 * published, has it been delivered for another booking — plus clicks on the
 * tracked link since delivery. Computed by the Network (delivery-checks.ts
 * there); they inform the brand's approval and never block it.
 */
import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button, formatDate } from '../../ui.js';
import { theme } from '../../theme.js';

export interface DeliveryUrlCheck {
  url: string;
  platform: 'youtube' | 'website' | 'other';
  label: string;
  account: 'verified' | 'other_account' | 'unverified' | 'unsupported';
  trackedLink: 'found' | 'missing' | 'unknown';
  reachable: boolean | null;
  publishedAt: string | null;
  publishedBeforeAccept: boolean | null;
  duplicates: Array<{ bookingId: string; sameBrand: boolean }>;
  views: number | null;
  error: string | null;
}

export interface DeliveryChecks {
  checkedAt: string;
  urls: DeliveryUrlCheck[];
  clicks: { since: string; total: number; bySource: Array<{ source: string; clicks: number }> } | null;
  clicksError: string | null;
}

type Tone = 'good' | 'warn' | 'bad' | 'neutral';

const PLATFORM_NAMES: Record<string, string> = {
  linkedin: 'LinkedIn',
  x: 'X',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  facebook: 'Facebook',
  threads: 'Threads',
  twitch: 'Twitch',
  bluesky: 'Bluesky',
  pinterest: 'Pinterest',
  reddit: 'Reddit',
  snapchat: 'Snapchat',
  discord: 'Discord',
};

function Badge({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  const palette = {
    good: { bg: theme.successSoft, fg: theme.success },
    warn: { bg: theme.warnSoft, fg: theme.warn },
    bad: { bg: theme.dangerSoft, fg: theme.danger },
    neutral: { bg: theme.surface3, fg: theme.textMuted },
  }[tone];
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: palette.bg,
        color: palette.fg,
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function errorText(error: string): string {
  if (error === 'youtube_not_configured') return 'YouTube checks aren’t set up';
  if (error === 'video_not_found') return 'Video not found or not public';
  if (error.startsWith('http_')) return `Page returned ${error.slice(5)}`;
  if (error.startsWith('blocked:')) return 'Page can’t be fetched safely';
  if (error.startsWith('youtube_api_error')) return 'YouTube didn’t answer';
  if (error === 'invalid_url') return 'Not a valid URL';
  return 'Page didn’t load';
}

/** The badges for one delivered URL, most important first. */
export function urlBadges(c: DeliveryUrlCheck): Array<{ tone: Tone; text: string; title?: string }> {
  const out: Array<{ tone: Tone; text: string; title?: string }> = [];
  if (c.duplicates.length > 0) {
    out.push({
      tone: 'bad',
      text: c.duplicates.some((d) => d.sameBrand) ? 'Also delivered for another of your bookings' : 'Also delivered for another booking',
    });
  }
  if (c.reachable === false) out.push({ tone: 'bad', text: c.error ? errorText(c.error) : 'Not reachable' });
  else if (c.error) out.push({ tone: 'neutral', text: `Couldn’t check: ${errorText(c.error)}` });

  if (c.account === 'verified') {
    out.push({ tone: 'good', text: c.platform === 'youtube' ? '✓ Verified YouTube channel' : `✓ Verified site (${c.label})` });
  } else if (c.account === 'other_account') {
    out.push({ tone: 'bad', text: 'Not their verified YouTube channel' });
  } else if (c.account === 'unverified' && !c.error) {
    out.push({
      tone: 'neutral',
      text: c.platform === 'youtube' ? 'YouTube channel not verified' : 'Not on a verified site',
      title: 'The creator hasn’t verified an account this post could be matched to.',
    });
  } else if (c.account === 'unsupported') {
    out.push({ tone: 'neutral', text: `${PLATFORM_NAMES[c.label] ?? 'This platform'} can’t be verified yet` });
  }

  if (c.trackedLink === 'found') out.push({ tone: 'good', text: '✓ Includes tracked link' });
  else if (c.trackedLink === 'missing') {
    out.push({ tone: 'warn', text: 'Tracked link not found', title: 'A shortened link (bit.ly etc.) can hide it.' });
  }

  if (c.publishedBeforeAccept) out.push({ tone: 'warn', text: `Published before the booking (${formatDate(c.publishedAt)})` });
  else if (c.publishedAt) out.push({ tone: 'neutral', text: `Published ${formatDate(c.publishedAt)}` });

  if (c.views != null) out.push({ tone: 'neutral', text: `${c.views.toLocaleString()} views` });
  return out;
}

export function DeliveryChecksPanel({
  urls,
  checks,
  onRecheck,
  rechecking,
}: {
  urls: string[];
  /** Undefined: the Network doesn't run delivery checks yet. */
  checks: DeliveryChecks | null | undefined;
  onRecheck: () => void;
  rechecking: boolean;
}) {
  const byUrl = new Map((checks?.urls ?? []).map((c) => [c.url, c]));
  return (
    <div
      style={{
        marginTop: 12,
        background: theme.surface2,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
        padding: '10px 12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em', flex: 1 }}>Published</div>
        {checks !== undefined && (
          <>
            <span style={{ fontSize: 12, color: theme.textDim }}>
              {checks ? `Checked ${formatDate(checks.checkedAt, { relative: true })}` : 'Checking the posts…'}
            </span>
            <Button size="sm" variant="ghost" onClick={onRecheck} disabled={rechecking}>
              {rechecking ? 'Checking…' : 'Re-check'}
            </Button>
          </>
        )}
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {urls
          .filter((u) => /^https?:\/\//i.test(u))
          .map((u) => {
            const c = byUrl.get(u);
            return (
              <div key={u}>
                <a
                  href={u}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: theme.accentText, wordBreak: 'break-all' }}
                >
                  <ExternalLink size={12} style={{ flexShrink: 0 }} />
                  {u}
                </a>
                {c && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    {urlBadges(c).map((b) => (
                      <Badge key={b.text} tone={b.tone} title={b.title}>
                        {b.text}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
      </div>
      {checks && <ClicksLine checks={checks} />}
    </div>
  );
}

function ClicksLine({ checks }: { checks: DeliveryChecks }) {
  if (!checks.clicks) {
    return checks.clicksError ? (
      <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 10 }}>Clicks since delivery aren’t available right now.</div>
    ) : null;
  }
  const { total, bySource } = checks.clicks;
  return (
    <div style={{ fontSize: 13, marginTop: 10, color: theme.textMuted }}>
      <strong style={{ color: total > 0 ? theme.text : theme.textMuted }}>{total.toLocaleString()}</strong>{' '}
      {total === 1 ? 'click' : 'clicks'} on their tracked link since delivery
      {bySource.length > 0 && <> · {bySource.map((s) => `${s.source} ${s.clicks.toLocaleString()}`).join(' · ')}</>}
    </div>
  );
}
