/**
 * Import a storefront from Passionfroot (the Network's
 * docs/creator-storefront.md §7.3). The creator pastes their page, sees
 * what was found against what they already have, ticks what to bring over,
 * and the Network applies it: new channels, blanks filled, packages as
 * unpublished drafts, bio and photo only where empty. Used as the optional
 * import step of the guided setup.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download } from 'lucide-react';
import { Button, Card, Input, Label } from '../../ui.js';
import { theme } from '../../theme.js';
import { ApiError, creatorApi } from './creator-api.js';
import { PLATFORMS_KEY, PROFILE_KEY, STOREFRONT_KEY } from './CreatorStorefront.js';
import { formatPackagePrice, PLATFORM_LABELS } from './storefront-shared.js';

interface PlanPackage {
  key: string;
  title: string;
  description: string | null;
  platform: string | null;
  priceAmount: number | null;
  currency: string;
  action: 'create' | 'exists';
  note: string | null;
}

interface PlanChannel {
  key: string;
  platform: string | null;
  sourceLabel: string;
  handle: string | null;
  profileUrl: string | null;
  description: string | null;
  cadence: string | null;
  followerCount: number | null;
  action: 'create' | 'fill' | 'keep' | 'none';
  note: string | null;
  packages: PlanPackage[];
}

export interface ImportPlan {
  source: 'passionfroot';
  sourceKey: string;
  sourceUrl: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  channels: PlanChannel[];
  pastBrands: string[];
  portfolioLinks: string[];
  room: number;
  unreadableSections?: number;
}

export interface ImportResult {
  channelsCreated: number;
  channelsFilled: number;
  packagesCreated: number;
  packagesOverLimit: number;
  bioSet: boolean;
  avatarSet: boolean;
  brandsAdded: number;
  linksAdded: number;
}

const ACTION_LABELS: Record<PlanChannel['action'], string> = {
  create: 'New channel',
  fill: 'Fills in what’s empty',
  keep: 'Keeping yours',
  none: 'Packages only',
};

/** The Network's own wording when it has some, without the error code. */
function importError(err: unknown): string | null {
  if (!err) return null;
  if (err instanceof ApiError) {
    const d = err.detail as { error?: string; detail?: unknown; retryAfterSeconds?: number } | null;
    if (err.status === 429) {
      const mins = Math.max(1, Math.ceil((d?.retryAfterSeconds ?? 60) / 60));
      return `That’s a lot of imports for one hour. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`;
    }
    if (typeof d?.detail === 'string') return d.detail;
  }
  return err instanceof Error ? err.message : String(err);
}

export function PassionfrootImport({
  onDone,
  onImported,
}: {
  /** Continue after a successful import. */
  onDone: (result: ImportResult | null) => void;
  /** The import landed (the summary is showing). */
  onImported?: () => void;
}) {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [channels, setChannels] = useState<Set<string>>(new Set());
  const [packages, setPackages] = useState<Set<string>>(new Set());
  const [profile, setProfile] = useState(true);
  const [pastWork, setPastWork] = useState(true);

  const preview = useMutation({
    mutationFn: () => creatorApi<{ plan: ImportPlan }>('/creators/me/storefront/import/preview', { method: 'POST', body: { url: url.trim() } }),
    onSuccess: ({ plan: p }) => {
      setPlan(p);
      // Everything new is ticked, packages up to the room left.
      setChannels(new Set(p.channels.filter((c) => c.action === 'create' || c.action === 'fill').map((c) => c.key)));
      setPackages(
        new Set(
          p.channels
            .flatMap((c) => c.packages)
            .filter((x) => x.action === 'create')
            .slice(0, p.room)
            .map((x) => x.key),
        ),
      );
      setProfile(!!(p.bio || p.avatarUrl));
      setPastWork(p.pastBrands.length + p.portfolioLinks.length > 0);
    },
  });

  const apply = useMutation({
    mutationFn: () =>
      creatorApi<ImportResult & { ok: true }>('/creators/me/storefront/import/apply', {
        method: 'POST',
        body: { url: url.trim(), channels: [...channels], packages: [...packages], profile, pastWork },
      }),
    onSuccess: async () => {
      onImported?.();
      await Promise.all([
        qc.invalidateQueries({ queryKey: STOREFRONT_KEY }),
        qc.invalidateQueries({ queryKey: PLATFORMS_KEY }),
        qc.invalidateQueries({ queryKey: PROFILE_KEY }),
      ]);
    },
  });

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setter(next);
  };

  const itemCount = useMemo(() => {
    if (!plan) return 0;
    const ch = plan.channels.filter((c) => channels.has(c.key) && (c.action === 'create' || c.action === 'fill')).length;
    return ch + packages.size + (profile && (plan.bio || plan.avatarUrl) ? 1 : 0) + (pastWork && plan.pastBrands.length + plan.portfolioLinks.length > 0 ? 1 : 0);
  }, [plan, channels, packages, profile, pastWork]);

  if (apply.isSuccess) {
    const r = apply.data;
    const parts = [
      r.channelsCreated && `${r.channelsCreated} channel${r.channelsCreated === 1 ? '' : 's'}`,
      r.packagesCreated && `${r.packagesCreated} draft package${r.packagesCreated === 1 ? '' : 's'}`,
      r.bioSet && 'your bio',
      r.avatarSet && 'your photo',
      r.brandsAdded && `${r.brandsAdded} past brand${r.brandsAdded === 1 ? '' : 's'}`,
    ].filter(Boolean) as string[];
    return (
      <Card>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <CheckCircle2 size={22} style={{ color: theme.success, flexShrink: 0, marginTop: 2 }} />
          <div>
            <div style={{ fontSize: 15, fontWeight: 500 }}>
              {parts.length ? `Imported ${joinList(parts)}.` : 'Nothing new to import. You already have all of it.'}
            </div>
            {r.packagesCreated > 0 && (
              <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 4 }}>
                Packages come in as drafts. Check the prices, then publish them in the next steps or the editor.
              </div>
            )}
            {r.packagesOverLimit > 0 && (
              <div style={{ fontSize: 13, color: theme.warn, marginTop: 4 }}>
                {r.packagesOverLimit} package{r.packagesOverLimit === 1 ? '' : 's'} didn’t fit under the package limit.
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <Button onClick={() => onDone(r)}>Continue</Button>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6 }}>
          <Download size={18} style={{ color: theme.accentText }} />
          <div style={{ fontSize: 15, fontWeight: 500 }}>Coming from Passionfroot?</div>
        </div>
        <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14, lineHeight: 1.5 }}>
          Paste your Passionfroot page and we’ll bring over your channels, packages and past collaborations, so you don’t
          retype them. We read your public page once. Nothing is saved until you choose what to import, and packages come in
          as drafts.
        </div>
        <Label>Your Passionfroot page</Label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px' }}>
            <Input
              aria-label="Your Passionfroot page"
              value={url}
              placeholder="passionfroot.me/your-name"
              onChange={(e) => {
                setUrl(e.target.value);
                if (plan) setPlan(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && url.trim() && !preview.isPending) preview.mutate();
              }}
            />
          </div>
          <Button onClick={() => preview.mutate()} disabled={!url.trim() || preview.isPending}>
            {preview.isPending ? 'Reading…' : plan ? 'Read again' : 'Find my storefront'}
          </Button>
        </div>
        {preview.error ? <div style={{ fontSize: 13, color: theme.danger, marginTop: 10 }}>{importError(preview.error)}</div> : null}
        <div style={{ fontSize: 12, color: theme.textDim, marginTop: 10 }}>
          Bookings, conversations and payouts stay in Passionfroot: they’re behind your login there, not on your public page.
        </div>
      </Card>

      {plan && (
        <div style={{ display: 'grid', gap: 14, marginTop: 14 }}>
          {!!plan.unreadableSections && (
            <div style={{ fontSize: 13, color: theme.warn, background: theme.warnSoft, borderRadius: theme.radiusSm, padding: '10px 12px' }}>
              We couldn’t read {plan.unreadableSections} section{plan.unreadableSections === 1 ? '' : 's'} of your page, so{' '}
              {plan.unreadableSections === 1 ? 'it’s' : 'they’re'} left out. You can add {plan.unreadableSections === 1 ? 'it' : 'them'} by hand.
            </div>
          )}

          {plan.channels.length === 0 && (
            <Card>
              <div style={{ fontSize: 13, color: theme.textMuted }}>That page has no channels or packages we can import.</div>
            </Card>
          )}

          {plan.channels.map((ch) => (
            <Card key={ch.key}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                {ch.action === 'create' || ch.action === 'fill' ? (
                  <input
                    type="checkbox"
                    aria-label={`Import the ${ch.platform ? (PLATFORM_LABELS[ch.platform] ?? ch.platform) : ch.sourceLabel} channel`}
                    checked={channels.has(ch.key)}
                    onChange={() => toggle(channels, setChannels, ch.key)}
                    style={{ marginTop: 3 }}
                  />
                ) : (
                  <span style={{ width: 13, flexShrink: 0 }} />
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>
                      {ch.platform ? (PLATFORM_LABELS[ch.platform] ?? ch.platform) : ch.sourceLabel}
                    </span>
                    {ch.handle && <span style={{ fontSize: 12.5, fontFamily: theme.fontMono, color: theme.textMuted }}>{ch.handle}</span>}
                    <span style={{ fontSize: 11.5, color: theme.textDim, border: `1px solid ${theme.border}`, borderRadius: 999, padding: '1px 8px' }}>
                      {ACTION_LABELS[ch.action]}
                    </span>
                  </div>
                  {(ch.followerCount != null || ch.cadence) && ch.action !== 'none' && (
                    <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 3 }}>
                      {[ch.followerCount != null && `${ch.followerCount.toLocaleString()} audience (self-reported)`, ch.cadence].filter(Boolean).join(' · ')}
                    </div>
                  )}
                  {ch.description && ch.action !== 'none' && ch.action !== 'keep' && (
                    <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 4 }}>{ch.description}</div>
                  )}
                  {ch.note && <div style={{ fontSize: 12.5, color: theme.warn, marginTop: 4 }}>{ch.note}</div>}

                  {ch.packages.length > 0 && (
                    <div style={{ display: 'grid', gap: 6, marginTop: 10 }}>
                      {ch.packages.map((p) => {
                        const exists = p.action === 'exists';
                        const full = !packages.has(p.key) && packages.size >= plan.room;
                        return (
                          <label
                            key={p.key}
                            style={{
                              display: 'flex',
                              gap: 10,
                              alignItems: 'flex-start',
                              padding: '8px 10px',
                              borderRadius: theme.radiusSm,
                              border: `1px solid ${packages.has(p.key) ? theme.accent : theme.borderSubtle}`,
                              opacity: exists || full ? 0.6 : 1,
                              cursor: exists || full ? 'default' : 'pointer',
                            }}
                          >
                            <input
                              type="checkbox"
                              aria-label={`Import ${p.title}`}
                              checked={exists || packages.has(p.key)}
                              disabled={exists || full}
                              onChange={() => toggle(packages, setPackages, p.key)}
                              style={{ marginTop: 2 }}
                            />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
                                <span style={{ flex: 1, fontSize: 13.5, fontWeight: 500 }}>{p.title}</span>
                                <span style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>{formatPackagePrice({ ...p, priceIsFrom: false })}</span>
                              </div>
                              {p.description && <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 2 }}>{p.description}</div>}
                              {p.note && <div style={{ fontSize: 12, color: exists ? theme.textDim : theme.warn, marginTop: 2 }}>{p.note}</div>}
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </Card>
          ))}

          {(plan.bio || plan.avatarUrl || plan.pastBrands.length > 0 || plan.portfolioLinks.length > 0) && (
            <Card>
              <div style={{ display: 'grid', gap: 10, fontSize: 13.5 }}>
                {(plan.bio || plan.avatarUrl) && (
                  <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                    <input type="checkbox" aria-label="Import bio and photo" checked={profile} onChange={(e) => setProfile(e.target.checked)} style={{ marginTop: 2 }} />
                    <span>
                      <strong style={{ fontWeight: 500 }}>{plan.bio && plan.avatarUrl ? 'Your bio and photo' : plan.bio ? 'Your bio' : 'Your photo'}</strong>
                      <span style={{ color: theme.textMuted }}> (yours are empty, so these fill them in)</span>
                      {plan.bio && <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 2 }}>{plan.bio}</div>}
                    </span>
                  </label>
                )}
                {plan.pastBrands.length + plan.portfolioLinks.length > 0 && (
                  <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
                    <input type="checkbox" aria-label="Import past collaborations" checked={pastWork} onChange={(e) => setPastWork(e.target.checked)} style={{ marginTop: 2 }} />
                    <span>
                      <strong style={{ fontWeight: 500 }}>Past collaborations</strong>
                      <span style={{ color: theme.textMuted }}>
                        {plan.pastBrands.length > 0 ? `: ${plan.pastBrands.join(', ')}` : ''}
                        {plan.portfolioLinks.length > 0
                          ? `${plan.pastBrands.length ? ', plus ' : ': '}${plan.portfolioLinks.length} post link${plan.portfolioLinks.length === 1 ? '' : 's'}`
                          : ''}
                      </span>
                    </span>
                  </label>
                )}
              </div>
            </Card>
          )}

          {plan.room <= 0 && (
            <div style={{ fontSize: 13, color: theme.warn }}>You’re at the package limit, so packages can’t be imported. Delete some in the editor first.</div>
          )}
          {apply.error ? <div style={{ fontSize: 13, color: theme.danger }}>{importError(apply.error)}</div> : null}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button onClick={() => apply.mutate()} disabled={itemCount === 0 || apply.isPending}>
              {apply.isPending ? 'Importing…' : `Import ${itemCount} item${itemCount === 1 ? '' : 's'}`}
            </Button>
            <span style={{ fontSize: 12.5, color: theme.textDim }}>
              {packages.size} of {plan.room} package slot{plan.room === 1 ? '' : 's'} used
            </span>
          </div>
        </div>
      )}
    </>
  );
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
