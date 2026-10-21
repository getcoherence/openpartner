/**
 * /creator/storefront — the creator's storefront editor. Turn bookings on,
 * pitch each channel, and add priced packages under it (from templates or
 * from scratch), with a live preview of the public section beside the form.
 * Packages show on the public profile (/creators/:handle) while bookings
 * are on; brands request them from there and the requests land in
 * /creator/bookings. First-timers get the guided setup at
 * /creator/storefront/setup.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Download, ExternalLink, Plus, Sparkles } from 'lucide-react';
import { Button, Card, ErrorBanner, Input, Label, Page, Select, StatusPill, Textarea } from '../../ui.js';
import { theme } from '../../theme.js';
import { useMediaQuery } from '../../lib/useMediaQuery.js';
import { MARKETPLACE_CREATORS_URL, publicStorefrontUrl } from '../../lib/public-site.js';
import type { NetworkProfile } from '../../lib/NetworkProfileEditor.js';
import { creatorApi } from './creator-api.js';
import { ChannelHeader } from './StorefrontSection.js';
import { PreviewColumn, StorefrontPreview } from './StorefrontPreview.js';
import {
  formatPackagePrice,
  groupByChannel,
  parsePackagePrice,
  PACKAGE_CURRENCIES,
  PLATFORM_LABELS,
  templatesFor,
  type ChannelGroup,
  type OwnPackage,
  type PackageTemplate,
  type StorefrontChannel,
  type StorefrontPackage,
} from './storefront-shared.js';

export interface Storefront {
  bookingsOpen: boolean;
  handle: string | null;
  profileComplete: boolean;
  maxPackages: number;
  packages: OwnPackage[];
  /** The creator's platforms; absent on a Network before channel pitches. */
  platforms?: StorefrontChannel[];
}

export const STOREFRONT_KEY = ['creator-storefront'];
/** GET /creators/me, shared with the profile page. */
export const PROFILE_KEY = ['creator-my-profile'];
/** GET /creators/me/platforms, shared with the profile page's Platforms card. */
export const PLATFORMS_KEY = ['creator-my-platforms'];

/** A package as its form holds it, before it's saved. */
export type PackageDraft = Omit<OwnPackage, 'id' | 'position'>;
/** A channel's pitch as its form holds it. */
export interface ChannelDraft {
  description: string;
  cadence: string;
}

type Editing =
  | { kind: 'package'; id: string }
  | { kind: 'new'; platform: string | null; template: PackageTemplate | null }
  | { kind: 'channel'; platform: string }
  | null;

export function CreatorStorefrontPage() {
  const qc = useQueryClient();
  const sf = useQuery({
    queryKey: STOREFRONT_KEY,
    queryFn: () => creatorApi<Storefront>('/creators/me/storefront'),
    retry: false,
  });
  const profile = useQuery({
    queryKey: PROFILE_KEY,
    queryFn: () => creatorApi<NetworkProfile>('/creators/me'),
    retry: false,
  });
  const stacked = useMediaQuery('(max-width: 1100px)');
  const [view, setView] = useState<'edit' | 'preview'>('edit');
  const [editing, setEditingState] = useState<Editing>(null);
  const [packageDraft, setPackageDraft] = useState<PackageDraft | null>(null);
  const [channelDraft, setChannelDraft] = useState<ChannelDraft | null>(null);

  function setEditing(next: Editing) {
    setEditingState(next);
    setPackageDraft(null);
    setChannelDraft(null);
  }
  function done() {
    setEditing(null);
    void qc.invalidateQueries({ queryKey: STOREFRONT_KEY });
  }

  const toggle = useMutation({
    mutationFn: (bookingsOpen: boolean) => creatorApi('/creators/me/storefront', { method: 'PUT', body: { bookingsOpen } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: STOREFRONT_KEY }),
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => creatorApi('/creators/me/packages/order', { method: 'POST', body: { ids } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: STOREFRONT_KEY }),
  });

  const data = sf.data;
  const packages = useMemo(() => data?.packages ?? [], [data]);
  const channels = useMemo(() => data?.platforms ?? [], [data]);
  const atCap = !!data && packages.length >= data.maxPackages;

  // Every channel, then "across channels" so there's always somewhere to
  // add a bundle.
  const groups = useMemo(() => {
    const g = groupByChannel(packages, channels);
    return g.some((x) => x.key === 'any') ? g : [...g, { key: 'any', platform: null, channel: null, packages: [] } as ChannelGroup<OwnPackage>];
  }, [packages, channels]);
  // Channel blocks follow their first package, so moving a block moves its packages.
  const movableKeys = groups.filter((g) => g.channel && g.packages.length > 0).map((g) => g.key);

  function moveWithinGroup(group: ChannelGroup<OwnPackage>, index: number, delta: -1 | 1) {
    const a = group.packages[index];
    const b = group.packages[index + delta];
    if (!a || !b) return;
    const ids = packages.map((p) => p.id);
    const i = ids.indexOf(a.id);
    const j = ids.indexOf(b.id);
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    reorder.mutate(ids);
  }
  function moveGroup(key: string, delta: -1 | 1) {
    const order = [...movableKeys];
    const i = order.indexOf(key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    const byKey = new Map(groups.map((g) => [g.key, g]));
    const rest = groups.filter((g) => !order.includes(g.key));
    const ids = [...order.map((k) => byKey.get(k)!), ...rest].flatMap((g) => g.packages.map((p) => p.id));
    reorder.mutate(ids);
  }

  // What the preview shows: saved state with the open form's edits on top.
  const previewPackages = useMemo((): StorefrontPackage[] => {
    let list: Array<StorefrontPackage & { published: boolean }> = packages.map((p) =>
      editing?.kind === 'package' && editing.id === p.id && packageDraft ? { ...p, ...packageDraft } : p,
    );
    if (editing?.kind === 'new' && packageDraft) list = [...list, { id: 'draft', ...packageDraft }];
    return list.filter((p) => p.published && p.title.trim());
  }, [packages, editing, packageDraft]);
  const previewChannels = useMemo(
    () =>
      channels.map((c) =>
        editing?.kind === 'channel' && editing.platform === c.platform && channelDraft
          ? { ...c, description: channelDraft.description.trim() || null, cadence: channelDraft.cadence.trim() || null }
          : c,
      ),
    [channels, editing, channelDraft],
  );

  const firstRun = !!data && packages.length === 0 && !data.bookingsOpen;
  const editor = data && (
    <div style={{ display: 'grid', gap: 14, minWidth: 0 }}>
      {firstRun && (
        <Card style={{ background: theme.accentSoft, border: `1px solid ${theme.border}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <Sparkles size={20} style={{ color: theme.accentText, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 15, fontWeight: 500 }}>Set up your storefront step by step</div>
              <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 2 }}>
                Add your channels, pick packages from templates, set your prices and preview it before brands see it.
                On Passionfroot already?{' '}
                <Link to="/creator/storefront/setup?step=import" style={{ color: theme.accentText }}>
                  Import your storefront
                </Link>
                .
              </div>
            </div>
            <Link to="/creator/storefront/setup" style={{ textDecoration: 'none' }}>
              <Button>Start setup</Button>
            </Link>
          </div>
        </Card>
      )}
      <BookingsCard storefront={data} pending={toggle.isPending} onToggle={() => toggle.mutate(!data.bookingsOpen)} />
      {channels.length === 0 && (
        <Card>
          <div style={{ fontSize: 13, color: theme.textMuted }}>
            Add the channels you publish on so brands can see your audience on each.{' '}
            <Link to="/creator/profile" style={{ color: theme.accentText }}>Add channels on your profile</Link>
          </div>
        </Card>
      )}
      {groups.map((g) => (
        <GroupCard
          key={g.key}
          group={g}
          editing={editing}
          setEditing={setEditing}
          onDone={done}
          onPackageDraft={setPackageDraft}
          onChannelDraft={setChannelDraft}
          atCap={atCap}
          busy={reorder.isPending}
          onMovePackage={(i, d) => moveWithinGroup(g, i, d)}
          groupMove={
            movableKeys.length > 1 && movableKeys.includes(g.key)
              ? {
                  first: movableKeys[0] === g.key,
                  last: movableKeys[movableKeys.length - 1] === g.key,
                  onMove: (d) => moveGroup(g.key, d),
                }
              : null
          }
        />
      ))}
      {atCap && (
        <p style={{ color: theme.textMuted, fontSize: 13, margin: 0 }}>
          That&rsquo;s the maximum of {data.maxPackages} packages. Delete one to add another.
        </p>
      )}
    </div>
  );
  const preview = data && (
    <StorefrontPreview profile={profile.data} packages={previewPackages} channels={previewChannels} bookingsOpen={data.bookingsOpen} />
  );

  return (
    <Page
      title="Storefront"
      subtitle="Pitch your channels, list what you offer brands with your prices, and take booking requests from your public profile."
      actions={
        <>
          <Link to="/creator/storefront/setup?step=import" style={{ textDecoration: 'none' }}>
            <Button variant="ghost" icon={<Download size={14} />}>Import from Passionfroot</Button>
          </Link>
          <Link to="/creator/storefront/setup" style={{ textDecoration: 'none' }}>
            <Button variant="secondary" icon={<Sparkles size={14} />}>Guided setup</Button>
          </Link>
        </>
      }
    >
      <ErrorBanner error={sf.error ?? toggle.error ?? reorder.error} />
      {sf.isLoading ? (
        <Card>Loading…</Card>
      ) : !data ? null : stacked ? (
        <>
          <div role="tablist" style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {(['edit', 'preview'] as const).map((v) => (
              <Button key={v} size="sm" variant={view === v ? 'primary' : 'secondary'} onClick={() => setView(v)}>
                {v === 'edit' ? 'Edit' : 'Preview'}
              </Button>
            ))}
          </div>
          {view === 'edit' ? editor : preview}
        </>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(340px, 440px)', gap: 24, alignItems: 'start' }}>
          {editor}
          <PreviewColumn>{preview}</PreviewColumn>
        </div>
      )}
    </Page>
  );
}

function BookingsCard({ storefront, pending, onToggle }: { storefront: Storefront; pending: boolean; onToggle: () => void }) {
  // The storefront lives on the public site; the marketplace lists it there
  // while the creator has a public profile, bookings on and a published
  // package (the Network decides).
  const publicUrl = storefront.handle ? publicStorefrontUrl(storefront.handle) : null;
  const hasPublished = storefront.packages.some((p) => p.published);
  const marketplace = (
    <a href={MARKETPLACE_CREATORS_URL} target="_blank" rel="noopener noreferrer" style={{ color: theme.accentText }}>
      OpenPartner marketplace
    </a>
  );
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15, fontWeight: 500 }}>Booking requests</span>
            <StatusPill status={storefront.bookingsOpen ? 'active' : 'paused'} />
          </div>
          <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 4 }}>
            {!storefront.bookingsOpen ? (
              <>Turn on to show your packages and a request form on your public profile, and to list your storefront in the {marketplace} for brands to find.</>
            ) : !hasPublished ? (
              <>Bookings are on. Publish a package to show it on your public profile and list your storefront in the {marketplace}.</>
            ) : !storefront.profileComplete ? (
              <>Your packages and a request form go on your public profile, and into the {marketplace}, once your profile is complete.</>
            ) : (
              <>Your packages and a request form are on your public profile, and your storefront is listed in the {marketplace}. Brands confirm their email before a request reaches you.</>
            )}
          </div>
        </div>
        <Button variant={storefront.bookingsOpen ? 'secondary' : 'primary'} onClick={onToggle} disabled={pending}>
          {storefront.bookingsOpen ? 'Pause bookings' : 'Turn on bookings'}
        </Button>
      </div>
      {!storefront.profileComplete ? (
        <div style={{ marginTop: 14, fontSize: 13, color: theme.warn, background: theme.warnSoft, borderRadius: theme.radiusSm, padding: '10px 12px' }}>
          Your profile isn&rsquo;t complete, so it has no public page yet and brands can&rsquo;t see your storefront.{' '}
          <Link to="/creator/profile" style={{ color: theme.warn, fontWeight: 600 }}>Finish your profile</Link>
        </div>
      ) : (
        publicUrl && (
          <div style={{ marginTop: 14, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ color: theme.textMuted }}>Your public page:</span>
            <a
              href={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontFamily: theme.fontMono, color: theme.accentText, display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              {publicUrl.replace(/^https?:\/\//, '')}
              <ExternalLink size={12} />
            </a>
          </div>
        )
      )}
    </Card>
  );
}

/** One channel (or "across channels"): its pitch, its packages, and adding more from templates. */
function GroupCard({
  group,
  editing,
  setEditing,
  onDone,
  onPackageDraft,
  onChannelDraft,
  atCap,
  busy,
  onMovePackage,
  groupMove,
}: {
  group: ChannelGroup<OwnPackage>;
  editing: Editing;
  setEditing: (e: Editing) => void;
  onDone: () => void;
  onPackageDraft: (d: PackageDraft) => void;
  onChannelDraft: (d: ChannelDraft) => void;
  atCap: boolean;
  busy: boolean;
  onMovePackage: (index: number, delta: -1 | 1) => void;
  groupMove: { first: boolean; last: boolean; onMove: (delta: -1 | 1) => void } | null;
}) {
  const label = group.platform ? (PLATFORM_LABELS[group.platform] ?? group.platform) : 'Across channels';
  const editingPitch = editing?.kind === 'channel' && editing.platform === group.platform;
  const adding = editing?.kind === 'new' && editing.platform === group.platform ? editing : null;
  const templates = templatesFor(group.platform);

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          {group.channel ? (
            <ChannelHeader channel={group.channel} />
          ) : (
            <>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{label}</div>
              <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 2 }}>
                {group.platform ? (
                  <>
                    You haven&rsquo;t added your {label} account, so brands don&rsquo;t see your audience there.{' '}
                    <Link to="/creator/profile" style={{ color: theme.accentText }}>Add it on your profile</Link>
                  </>
                ) : (
                  'Bundles and work that isn’t tied to one channel.'
                )}
              </div>
            </>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          {groupMove && (
            <>
              <Button size="sm" variant="ghost" onClick={() => groupMove.onMove(-1)} disabled={groupMove.first || busy} icon={<ArrowUp size={14} />}>
                <span style={{ position: 'absolute', left: -10000 }}>Move {label} up</span>
              </Button>
              <Button size="sm" variant="ghost" onClick={() => groupMove.onMove(1)} disabled={groupMove.last || busy} icon={<ArrowDown size={14} />}>
                <span style={{ position: 'absolute', left: -10000 }}>Move {label} down</span>
              </Button>
            </>
          )}
          {group.channel && !editingPitch && (
            <Button size="sm" variant="secondary" onClick={() => setEditing({ kind: 'channel', platform: group.platform! })}>
              {group.channel.description || group.channel.cadence ? 'Edit pitch' : 'Add pitch'}
            </Button>
          )}
        </div>
      </div>

      {editingPitch && group.channel && (
        <div style={{ marginTop: 14 }}>
          <ChannelPitchForm channel={group.channel} onDraft={onChannelDraft} onDone={onDone} onCancel={() => setEditing(null)} />
        </div>
      )}

      {group.packages.length > 0 && (
        <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
          {group.packages.map((p, i) =>
            editing?.kind === 'package' && editing.id === p.id ? (
              <PackageForm key={p.id} existing={p} onDraft={onPackageDraft} onDone={onDone} onCancel={() => setEditing(null)} />
            ) : (
              <PackageCard
                key={p.id}
                pkg={p}
                first={i === 0}
                last={i === group.packages.length - 1}
                busy={busy}
                onEdit={() => setEditing({ kind: 'package', id: p.id })}
                onMove={(d) => onMovePackage(i, d)}
                onDeleted={onDone}
              />
            ),
          )}
        </div>
      )}

      {adding ? (
        <div style={{ marginTop: 14 }}>
          <PackageForm
            initial={{ platform: group.platform, title: adding.template?.title ?? '', description: adding.template?.description ?? null }}
            onDraft={onPackageDraft}
            onDone={onDone}
            onCancel={() => setEditing(null)}
          />
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 14 }}>
          <span style={{ fontSize: 12.5, color: theme.textMuted, marginRight: 2 }}>Add:</span>
          {templates.map((t) => (
            <TemplateChip
              key={t.title}
              disabled={atCap}
              onClick={() => setEditing({ kind: 'new', platform: group.platform, template: t })}
            >
              {t.title}
            </TemplateChip>
          ))}
          <TemplateChip disabled={atCap} onClick={() => setEditing({ kind: 'new', platform: group.platform, template: null })}>
            Custom
          </TemplateChip>
        </div>
      )}
    </Card>
  );
}

export function TemplateChip({ children, onClick, disabled }: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: 'transparent',
        border: `1px dashed ${theme.border}`,
        borderRadius: 999,
        padding: '4px 10px',
        fontSize: 12.5,
        color: theme.text,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Plus size={12} /> {children}
    </button>
  );
}

function PackageCard({
  pkg,
  first,
  last,
  busy,
  onEdit,
  onMove,
  onDeleted,
}: {
  pkg: OwnPackage;
  first: boolean;
  last: boolean;
  busy: boolean;
  onEdit: () => void;
  onMove: (delta: -1 | 1) => void;
  onDeleted: () => void;
}) {
  const remove = useMutation({
    mutationFn: () => creatorApi(`/creators/me/packages/${pkg.id}`, { method: 'DELETE' }),
    onSuccess: onDeleted,
  });
  return (
    <div style={{ border: `1px solid ${theme.border}`, borderRadius: theme.radiusSm, padding: '12px 14px', background: theme.surface }}>
      <ErrorBanner error={remove.error} />
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 500 }}>{pkg.title}</span>
            {!pkg.published && <StatusPill status="draft" />}
          </div>
          {pkg.description && (
            <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 4, whiteSpace: 'pre-wrap' }}>{pkg.description}</div>
          )}
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap' }}>{formatPackagePrice(pkg)}</div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
        <Button size="sm" variant="secondary" onClick={onEdit}>Edit</Button>
        <Button size="sm" variant="ghost" onClick={() => onMove(-1)} disabled={first || busy} icon={<ArrowUp size={14} />}>Up</Button>
        <Button size="sm" variant="ghost" onClick={() => onMove(1)} disabled={last || busy} icon={<ArrowDown size={14} />}>Down</Button>
        <div style={{ flex: 1 }} />
        <Button
          size="sm"
          variant="danger"
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(`Delete “${pkg.title}”? Requests already sent for it keep what was asked for.`)) remove.mutate();
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

/** Ideas for the cadence field; anything up to 40 characters works. */
const CADENCE_OPTIONS = ['Daily', 'Several times a week', 'Weekly', 'Every other week', 'Monthly'];

/**
 * A channel's pitch: what it covers and how often it publishes. Saved with
 * PUT /creators/me/platforms/:platform, sending the stored handle, URL and
 * count back so nothing else changes (a changed handle or URL would
 * unverify the account).
 */
export function ChannelPitchForm({
  channel,
  onDraft,
  onDone,
  onCancel,
}: {
  channel: StorefrontChannel;
  onDraft?: (d: ChannelDraft) => void;
  onDone?: () => void;
  /** Absent → the form stays open (the setup flow). */
  onCancel?: () => void;
}) {
  const qc = useQueryClient();
  const [description, setDescription] = useState(channel.description ?? '');
  const [cadence, setCadence] = useState(channel.cadence ?? '');
  const label = PLATFORM_LABELS[channel.platform] ?? channel.platform;

  useEffect(() => {
    onDraft?.({ description, cadence });
    // onDraft is a state setter from the parent; only the fields drive this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [description, cadence]);

  const save = useMutation({
    mutationFn: () =>
      creatorApi(`/creators/me/platforms/${channel.platform}`, {
        method: 'PUT',
        body: {
          handle: channel.handle,
          followerCount: channel.followerCount,
          ...(channel.profileUrl ? { profileUrl: channel.profileUrl } : {}),
          description: description.trim(),
          cadence: cadence.trim(),
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: STOREFRONT_KEY }),
        qc.invalidateQueries({ queryKey: PLATFORMS_KEY }),
      ]);
      onDone?.();
    },
  });
  const dirty = description.trim() !== (channel.description ?? '') || cadence.trim() !== (channel.cadence ?? '');
  const listId = `cadence-${channel.platform}`;

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <ErrorBanner error={save.error} />
      <div>
        <Label>What your {label} covers</Label>
        <Textarea
          aria-label={`What your ${label} covers`}
          value={description}
          maxLength={300}
          rows={2}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Who watches or reads it and what you make for them."
        />
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ width: 220 }}>
          <Label>How often you publish</Label>
          <Input
            aria-label="How often you publish"
            value={cadence}
            maxLength={40}
            list={listId}
            onChange={(e) => setCadence(e.target.value)}
            placeholder="Weekly"
          />
          <datalist id={listId}>
            {CADENCE_OPTIONS.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </div>
        <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
          {save.isPending ? 'Saving…' : save.isSuccess && !dirty ? 'Saved' : 'Save'}
        </Button>
        {onCancel && (
          <Button size="sm" variant="secondary" onClick={onCancel}>Cancel</Button>
        )}
      </div>
    </div>
  );
}

function PackageForm({
  existing,
  initial,
  onDraft,
  onDone,
  onCancel,
}: {
  existing?: OwnPackage;
  /** A new package's starting values (a template). */
  initial?: Partial<Pick<StorefrontPackage, 'title' | 'description' | 'platform'>>;
  onDraft?: (d: PackageDraft) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const start = existing ?? initial;
  const [title, setTitle] = useState(start?.title ?? '');
  const [description, setDescription] = useState(start?.description ?? '');
  const [platform, setPlatform] = useState(start?.platform ?? '');
  const [price, setPrice] = useState(existing?.priceAmount != null ? String(existing.priceAmount) : '');
  const [priceIsFrom, setPriceIsFrom] = useState(existing?.priceIsFrom ?? false);
  const [currency, setCurrency] = useState(existing?.currency ?? 'USD');
  const [published, setPublished] = useState(existing?.published ?? true);

  const parsed = parsePackagePrice(price);
  const priceValid = parsed.valid;
  const draft: PackageDraft = {
    title: title.trim(),
    description: description.trim() || null,
    platform: platform || null,
    priceAmount: parsed.amount,
    priceIsFrom: parsed.amount == null ? false : priceIsFrom,
    currency,
    published,
  };
  const draftKey = JSON.stringify(draft);
  useEffect(() => {
    onDraft?.(draft);
    // The serialized draft is the dependency; onDraft is a state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  const save = useMutation({
    mutationFn: () =>
      existing
        ? creatorApi(`/creators/me/packages/${existing.id}`, { method: 'PATCH', body: draft })
        : creatorApi('/creators/me/packages', { method: 'POST', body: draft }),
    onSuccess: onDone,
  });

  const currencies = PACKAGE_CURRENCIES.includes(currency as (typeof PACKAGE_CURRENCIES)[number])
    ? PACKAGE_CURRENCIES
    : [currency, ...PACKAGE_CURRENCIES];

  return (
    <div style={{ border: `1px solid ${theme.accent}`, borderRadius: theme.radiusSm, padding: 14, background: theme.surface }}>
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>{existing ? 'Edit package' : 'New package'}</div>
      <ErrorBanner error={save.error} />
      <div style={{ display: 'grid', gap: 12 }}>
        <div>
          <Label>Title</Label>
          <Input aria-label="Title" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Sponsored LinkedIn post" />
        </div>
        <div>
          <Label>Description</Label>
          <Textarea
            aria-label="Description"
            value={description}
            maxLength={600}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What the brand gets: format, length, links, timing."
          />
        </div>
        <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <div>
            <Label>Platform</Label>
            <Select aria-label="Platform" value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="">Any</option>
              {Object.entries(PLATFORM_LABELS).map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Price</Label>
            <Input aria-label="Price" value={price} inputMode="numeric" onChange={(e) => setPrice(e.target.value)} placeholder="On request" />
          </div>
          <div>
            <Label>Currency</Label>
            <Select aria-label="Currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {currencies.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </div>
        </div>
        {!priceValid && <div style={{ fontSize: 13, color: theme.danger }}>Use a whole number up to 10,000,000, like 500.</div>}
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13 }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: price.trim() === '' ? 0.5 : 1 }}>
            <input type="checkbox" checked={priceIsFrom} disabled={price.trim() === ''} onChange={(e) => setPriceIsFrom(e.target.checked)} />
            Show as &ldquo;From&rdquo; price
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} />
            Show on my public page
          </label>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <Button onClick={() => save.mutate()} disabled={!title.trim() || !priceValid || save.isPending}>
          {save.isPending ? 'Saving…' : existing ? 'Save' : 'Add package'}
        </Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
