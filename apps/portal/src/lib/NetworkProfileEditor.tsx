import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { Check, CheckCircle2, Circle, Copy, ExternalLink, Plus, X } from 'lucide-react';
import { AUDIENCE_SIZES, AUDIENCE_SIZE_LABELS, type AudienceSize } from '@openpartner/db';
import { Button, Card, ErrorBanner, Input, Label, Select, Textarea } from '../ui.js';
import { alpha, theme } from '../theme.js';
import { useIsMobile } from './useMediaQuery.js';
import { VerifiedBadge } from './VerifiedBadge.js';

/**
 * The Network profile editor: completeness checklist, basics, audience,
 * portfolio and platforms. Shared by the creator portal
 * (pages/creator/CreatorMyProfile.tsx, via /api/creator-api/creators/me…)
 * and the brand-partner Network profile (pages/partner/MyProfile.tsx, via
 * the brand's /network/me… proxies). The adapter is the only difference:
 * which endpoints to call and which query keys hold the data, so banners
 * and apply gates reading the same keys update on save.
 */
export interface NetworkProfileAdapter {
  /** Holds GET /creators/me (or its proxy). Invalidated on save. */
  profileKey: QueryKey;
  platformsKey: QueryKey;
  updateProfile: (body: Record<string, unknown>) => Promise<unknown>;
  uploadAvatar: (file: File) => Promise<{ avatarUrl: string }>;
  listPlatforms: () => Promise<{ platforms: PlatformRow[] }>;
  putPlatform: (
    platform: Platform,
    body: { handle: string; followerCount: number | null; profileUrl?: string },
  ) => Promise<unknown>;
  deletePlatform: (platform: Platform) => Promise<unknown>;
  /** Account verification on the Network (YouTube, website). Absent → no
   *  Verify button. start issues (or re-shows) the code; check looks for it. */
  startVerification?: (platform: Platform) => Promise<VerificationStart>;
  checkVerification?: (platform: Platform) => Promise<{ ok: boolean; platform?: PlatformRow }>;
}

export type AgeRange = '13-17' | '18-24' | '25-34' | '35-44' | '45-54' | '55+';

export interface NetworkProfile {
  id: string;
  email: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  bio: string | null;
  profile: Record<string, unknown> | null;
  categories: string[];
  audienceLocations: string[];
  audienceAgeRange: AgeRange | null;
  /** Absent on a Network that predates the field. */
  audienceSize?: AudienceSize | null;
  portfolioLinks: string[];
  pastBrands: string[];
  createdAt: string;
  /** The discovery bar (Network-computed). Absent on an older Network. */
  profileComplete?: boolean;
  profileMissing?: Array<{ field: string; label: string }>;
  /** Every requirement with its state, in display order. */
  profileChecklist?: Array<{ field: string; label: string; done: boolean }>;
}

/** Minimum bio length the Network's discovery bar requires. */
const MIN_BIO_LENGTH = 40;

export type Platform = 'tiktok' | 'instagram' | 'youtube' | 'twitter' | 'linkedin' | 'substack' | 'twitch' | 'podcast' | 'website';

export interface PlatformRow {
  id: string;
  platform: Platform;
  handle: string;
  profileUrl: string | null;
  followerCount: number | null;
  verified: boolean;
  /** Absent on a Network that predates account verification. */
  verifiedAt?: string | null;
  verificationMethod?: 'bio_code' | 'dns' | 'oauth' | 'post_code' | null;
}

/** POST /creators/me/platforms/:platform/verify/start on the Network. */
export interface VerificationStart {
  platform: Platform;
  method: 'bio_code' | 'dns';
  code: string;
  expiresAt: string;
  instructions:
    | { kind: 'youtube_description'; editUrl: string; channelUrl: string | null; text: string }
    | { kind: 'dns_txt'; host: string; type: 'TXT'; value: string };
}

/** Platforms the Network can verify today. TikTok and Instagram follow via OAuth. */
const VERIFIABLE: ReadonlySet<Platform> = new Set<Platform>(['youtube', 'website']);

// Curated category list — covers the most-searched niches across
// existing creator marketplaces. Brands filter on these in Tier 3.
const CATEGORIES = [
  'tech', 'business', 'finance', 'productivity', 'marketing', 'design',
  'lifestyle', 'fitness', 'health', 'beauty', 'fashion', 'food', 'travel',
  'gaming', 'music', 'art', 'photography', 'education', 'parenting',
  'entertainment', 'news', 'sports',
] as const;

const AGE_RANGES: AgeRange[] = ['13-17', '18-24', '25-34', '35-44', '45-54', '55+'];

const PLATFORMS: { kind: Platform; label: string; placeholder: string }[] = [
  { kind: 'tiktok', label: 'TikTok', placeholder: 'your-handle' },
  { kind: 'instagram', label: 'Instagram', placeholder: 'your-handle' },
  { kind: 'youtube', label: 'YouTube', placeholder: 'your-handle' },
  { kind: 'twitter', label: 'X / Twitter', placeholder: 'your-handle' },
  { kind: 'linkedin', label: 'LinkedIn', placeholder: 'your-handle' },
  { kind: 'substack', label: 'Substack', placeholder: 'subdomain' },
  { kind: 'twitch', label: 'Twitch', placeholder: 'your-handle' },
  { kind: 'podcast', label: 'Podcast', placeholder: 'https://feeds…' },
  { kind: 'website', label: 'Website', placeholder: 'https://…' },
];

export function NetworkProfileEditor({
  adapter,
  data,
  publicProfileHref,
}: {
  adapter: NetworkProfileAdapter;
  data: NetworkProfile;
  /** "View public profile" link next to Save; null hides it. */
  publicProfileHref: string | null;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [bio, setBio] = useState('');
  const [categories, setCategories] = useState<string[]>([]);
  // Audience locations is kept as a raw text string while the user is
  // typing; we only split + normalize at save. Otherwise mid-keystroke
  // values like "U" get filtered out as not-yet-2-chars and the input
  // wipes itself.
  const [audienceLocationsRaw, setAudienceLocationsRaw] = useState('');
  const [audienceAgeRange, setAudienceAgeRange] = useState<AgeRange | ''>('');
  const [audienceSize, setAudienceSize] = useState<AudienceSize | ''>('');
  const [portfolioLinks, setPortfolioLinks] = useState<string[]>([]);
  const [pastBrandsRaw, setPastBrandsRaw] = useState('');

  useEffect(() => {
    if (data) {
      setName(data.name ?? '');
      setHandle(data.handle ?? '');
      setAvatarUrl(data.avatarUrl ?? '');
      setBio(data.bio ?? '');
      setCategories(data.categories ?? []);
      setAudienceLocationsRaw((data.audienceLocations ?? []).join(', '));
      setAudienceAgeRange((data.audienceAgeRange ?? '') as AgeRange | '');
      setAudienceSize((data.audienceSize ?? '') as AudienceSize | '');
      setPortfolioLinks(data.portfolioLinks ?? []);
      setPastBrandsRaw((data.pastBrands ?? []).join(', '));
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () => {
      const pastBrands = pastBrandsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const audienceLocations = audienceLocationsRaw
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z]{2}$/.test(s))
        .slice(0, 5);
      return adapter.updateProfile({
        name: name || undefined,
        handle: handle || null,
        avatarUrl: avatarUrl || null,
        bio: bio || null,
        categories,
        audienceLocations,
        audienceAgeRange: audienceAgeRange || null,
        // Only when the Network reports the field, so a save never
        // depends on an older Network tolerating the unknown key.
        ...(data && 'audienceSize' in data ? { audienceSize: audienceSize || null } : {}),
        portfolioLinks: portfolioLinks.filter((u) => u.trim()),
        pastBrands,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: adapter.profileKey }),
  });

  return (
    <>
      <ErrorBanner error={save.error} />
      <ProfileChecklistCard profile={data} />

      <div style={{ height: 14 }} />

      <Card>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>Basics</div>
        <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
          <Field label="Email" hint="Email is the join key across vendors and can't be changed here.">
            <Input value={data.email} disabled readOnly />
          </Field>
          <Field label="Display name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Handle" hint="Required. Used as your default share-link slug and your /creators/<handle> URL.">
            <Input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="your-handle" />
          </Field>
          <Field label="Avatar">
            <AvatarUploader value={avatarUrl} onChange={setAvatarUrl} name={name} upload={adapter.uploadAvatar} />
          </Field>
          <Field
            label="Bio"
            hint={`Required, at least ${MIN_BIO_LENGTH} characters. Brands read this first: who you create for and what you make. (${bio.trim().length}/${MIN_BIO_LENGTH})`}
          >
            <Textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={4} />
          </Field>
        </div>
      </Card>

      <div style={{ height: 14 }} />

      <Card>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Audience</div>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 14px' }}>
          Help brands decide whether you&rsquo;re a fit. Self-reported for now &mdash; verified
          numbers come once you connect platforms (coming soon).
        </p>
        <div style={{ display: 'grid', gap: 14 }}>
          <Field label="Categories" hint="Required, pick at least one. Brands filter by these.">
            <CategoryChips selected={categories} onChange={setCategories} />
          </Field>
          <Field label="Audience locations" hint="Top countries your audience comes from. ISO-3166 alpha-2 codes (e.g. US, CA, GB), max 5, comma-separated. Validated on save.">
            <Input
              value={audienceLocationsRaw}
              onChange={(e) => setAudienceLocationsRaw(e.target.value)}
              placeholder="US, CA, GB"
              style={{ fontFamily: theme.fontMono }}
            />
          </Field>
          <Field label="Audience age range" hint="Single bucket — finer slicing comes with verified platform connections.">
            <Select
              value={audienceAgeRange}
              onChange={(e) => setAudienceAgeRange(e.target.value as AgeRange | '')}
            >
              <option value="">— pick a range —</option>
              {AGE_RANGES.map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
          </Field>
          {'audienceSize' in data && (
            <Field label="Audience size" hint="Your total reach across platforms. Brands filter by this.">
              <Select
                aria-label="Audience size"
                value={audienceSize}
                onChange={(e) => setAudienceSize(e.target.value as AudienceSize | '')}
              >
                <option value="">Not set</option>
                {AUDIENCE_SIZES.map((s) => <option key={s} value={s}>{AUDIENCE_SIZE_LABELS[s]}</option>)}
              </Select>
            </Field>
          )}
        </div>
      </Card>

      <div style={{ height: 14 }} />

      <Card>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Portfolio</div>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 14px' }}>
          A handful of links + past brand collaborations. Brands skim these to gauge fit and credibility.
        </p>
        <div style={{ display: 'grid', gap: 14 }}>
          <Field label="Sample links (max 6)" hint="Best posts / videos / case studies. URLs only.">
            <UrlList value={portfolioLinks} onChange={setPortfolioLinks} max={6} placeholder="https://…" />
          </Field>
          <Field label="Past brand collaborations" hint="Comma-separated. Free text — no need to be exhaustive.">
            <Input
              value={pastBrandsRaw}
              onChange={(e) => setPastBrandsRaw(e.target.value)}
              placeholder="Notion, Linear, MongoDB"
            />
          </Field>
        </div>
      </Card>

      <div style={{ height: 14 }} />

      <PlatformsCard adapter={adapter} />

      <div style={{ height: 14 }} />

      <Card>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved' : 'Save profile'}
          </Button>
          {publicProfileHref && (
            <a
              href={publicProfileHref}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: theme.accentText, fontSize: 13, marginLeft: 4 }}
            >
              View public profile →
            </a>
          )}
        </div>
      </Card>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
      {hint && <p style={{ color: theme.textMuted, fontSize: 12, marginTop: 4, marginBottom: 0 }}>{hint}</p>}
    </div>
  );
}

function AvatarUploader({
  value,
  onChange,
  name,
  upload: uploadAvatar,
}: {
  value: string;
  onChange: (v: string) => void;
  name: string;
  upload: NetworkProfileAdapter['uploadAvatar'];
}) {
  const [error, setError] = useState<string | null>(null);
  const upload = useMutation({
    mutationFn: (file: File) => uploadAvatar(file),
    onSuccess: (r) => {
      setError(null);
      onChange(r.avatarUrl);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'upload failed'),
  });

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError('Image too large — max 2 MB.');
      return;
    }
    upload.mutate(file);
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: '50%',
          background: theme.surface,
          border: `1px solid ${theme.borderSubtle}`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        {value ? (
          <img src={value} alt={name || 'Avatar'} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ fontSize: 24, fontWeight: 600, color: theme.accentText }}>
            {name?.charAt(0).toUpperCase() || '?'}
          </span>
        )}
      </div>
      <div style={{ flex: 1 }}>
        <label>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={onPick}
            style={{ display: 'none' }}
            disabled={upload.isPending}
          />
          <span
            style={{
              display: 'inline-block',
              padding: '6px 12px',
              background: theme.surface,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radiusSm,
              fontSize: 13,
              color: theme.text,
              cursor: upload.isPending ? 'wait' : 'pointer',
              opacity: upload.isPending ? 0.6 : 1,
            }}
          >
            {upload.isPending ? 'Uploading…' : value ? 'Replace' : 'Upload'}
          </span>
        </label>
        {value && (
          <button
            onClick={() => onChange('')}
            style={{ marginLeft: 8, background: 'transparent', border: 'none', color: theme.textMuted, fontSize: 12, cursor: 'pointer' }}
          >
            Remove
          </button>
        )}
        <p style={{ fontSize: 12, color: theme.textMuted, margin: '6px 0 0' }}>PNG, JPEG, or WebP. Max 2 MB.</p>
        {error && <p style={{ fontSize: 12, color: theme.danger, margin: '4px 0 0' }}>{error}</p>}
      </div>
    </div>
  );
}

function CategoryChips({ selected, onChange }: { selected: string[]; onChange: (v: string[]) => void }) {
  function toggle(c: string) {
    onChange(selected.includes(c) ? selected.filter((x) => x !== c) : [...selected, c]);
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {CATEGORIES.map((c) => {
        const on = selected.includes(c);
        return (
          <button
            key={c}
            type="button"
            onClick={() => toggle(c)}
            style={{
              padding: '5px 10px',
              borderRadius: 14,
              border: `1px solid ${on ? theme.accent : theme.borderSubtle}`,
              background: on ? `${theme.accentA22}` : theme.surface2,
              color: on ? theme.accentText : theme.textMuted,
              fontSize: 12,
              cursor: 'pointer',
              fontWeight: on ? 500 : 400,
            }}
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}

function UrlList({ value, onChange, max, placeholder }: { value: string[]; onChange: (v: string[]) => void; max: number; placeholder: string }) {
  function update(i: number, v: string) {
    onChange(value.map((x, j) => (j === i ? v : x)));
  }
  function remove(i: number) {
    onChange(value.filter((_, j) => j !== i));
  }
  function add() {
    if (value.length >= max) return;
    onChange([...value, '']);
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {value.map((v, i) => (
        <div key={i} style={{ display: 'flex', gap: 6 }}>
          <Input value={v} onChange={(e) => update(i, e.target.value)} placeholder={placeholder} />
          <button
            type="button"
            onClick={() => remove(i)}
            style={{
              background: 'transparent',
              border: `1px solid ${theme.borderSubtle}`,
              borderRadius: theme.radiusSm,
              padding: '0 10px',
              color: theme.textMuted,
              cursor: 'pointer',
            }}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      {value.length < max && (
        <button
          type="button"
          onClick={add}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            border: `1px dashed ${theme.borderSubtle}`,
            borderRadius: theme.radiusSm,
            padding: '8px 12px',
            color: theme.textMuted,
            cursor: 'pointer',
            fontSize: 13,
            alignSelf: 'flex-start',
          }}
        >
          <Plus size={14} /> Add link
        </button>
      )}
    </div>
  );
}

/**
 * What stands between this creator and being discoverable. Brands only see
 * complete profiles (handle, photo, bio, a category, a platform) in Network
 * discovery and on public profile pages, so an incomplete profile is
 * effectively invisible. This card says so plainly and lists exactly what's
 * left. Driven by the Network's own rules via GET /creators/me.
 */
function ProfileChecklistCard({ profile }: { profile: NetworkProfile }) {
  const items =
    profile.profileChecklist ??
    (profile.profileMissing ?? []).map((m) => ({ ...m, done: false }));
  if (profile.profileComplete === undefined && items.length === 0) return null;

  if (profile.profileComplete) {
    return (
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <CheckCircle2 size={18} style={{ color: theme.success }} />
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Your profile is live</div>
            <div style={{ fontSize: 13, color: theme.textMuted }}>
              Brands can find you in Network discovery and on your public profile page.
            </div>
          </div>
        </div>
      </Card>
    );
  }

  const left = items.filter((i) => !i.done).length;
  return (
    <Card style={{ border: `1px solid ${alpha(theme.warn, 0.333)}`, background: theme.warnSoft }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: theme.text }}>
        Your profile is hidden from brands
      </div>
      <p style={{ fontSize: 13, color: theme.textMuted, margin: '4px 0 14px', lineHeight: 1.55 }}>
        Brands only see complete profiles when they search the Network for creators. Finish the{' '}
        {left === 1 ? 'last step' : `${left} steps`} below, save, and you&rsquo;ll show up right away.
        You&rsquo;ll need a complete profile to apply to programs, too.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((i) => (
          <div key={i.field} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5 }}>
            {i.done ? <CheckCircle2 size={16} style={{ color: theme.success }} /> : <Circle size={16} style={{ color: theme.warn }} />}
            <span
              style={{
                color: i.done ? theme.textMuted : theme.text,
                textDecoration: i.done ? 'line-through' : 'none',
              }}
            >
              {i.label}
            </span>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 12, color: theme.textDim, marginTop: 12 }}>
        Basics and categories save with the Save button at the bottom. Platforms save as you add them.
      </div>
    </Card>
  );
}

/** Platforms gets its own data lifecycle — each row is a separate
 *  PUT/DELETE on Network rather than a bulk PATCH, since users add /
 *  remove platforms one at a time and we want optimistic per-row save
 *  feedback. */
function PlatformsCard({ adapter }: { adapter: NetworkProfileAdapter }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: adapter.platformsKey,
    queryFn: () => adapter.listPlatforms(),
    retry: false,
  });

  return (
    <Card>
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Platforms</div>
      <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 14px' }}>
        Where you publish + your audience size on each. Follower counts are self-reported.
        {adapter.startVerification && (
          <> Verify your YouTube channel or website to show brands a verified badge.</>
        )}
      </p>
      {list.isLoading ? (
        <p style={{ color: theme.textMuted, fontSize: 13 }}>Loading…</p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {PLATFORMS.map((p) => {
            const existing = list.data?.platforms.find((r) => r.platform === p.kind);
            return (
              <PlatformRowEditor
                key={p.kind}
                adapter={adapter}
                platform={p.kind}
                label={p.label}
                placeholder={p.placeholder}
                existing={existing}
                onChanged={() => {
                  void qc.invalidateQueries({ queryKey: adapter.platformsKey });
                  // Platforms count toward the discovery checklist.
                  void qc.invalidateQueries({ queryKey: adapter.profileKey });
                }}
              />
            );
          })}
        </div>
      )}
    </Card>
  );
}

function PlatformRowEditor({
  adapter,
  platform,
  label,
  placeholder,
  existing,
  onChanged,
}: {
  adapter: NetworkProfileAdapter;
  platform: Platform;
  label: string;
  placeholder: string;
  existing?: PlatformRow;
  onChanged: () => void;
}) {
  const [handle, setHandle] = useState(existing?.handle ?? '');
  const [followerCount, setFollowerCount] = useState<number | ''>(existing?.followerCount ?? '');
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    setHandle(existing?.handle ?? '');
    setFollowerCount(existing?.followerCount ?? '');
  }, [existing?.handle, existing?.followerCount]);

  const save = useMutation({
    mutationFn: () => {
      const nextHandle = handle.trim();
      return adapter.putPlatform(platform, {
        handle: nextHandle,
        followerCount: followerCount === '' ? null : Number(followerCount),
        // Keep the stored profile URL when only the count changes: the
        // Network would otherwise rebuild it from the handle, and a
        // changed URL unverifies the account.
        ...(existing?.profileUrl && nextHandle === existing.handle ? { profileUrl: existing.profileUrl } : {}),
      });
    },
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => adapter.deletePlatform(platform),
    onSuccess: onChanged,
  });

  const dirty = handle.trim() !== (existing?.handle ?? '') || (followerCount === '' ? null : Number(followerCount)) !== (existing?.followerCount ?? null);
  const canVerify = !!existing && !existing.verified && VERIFIABLE.has(platform) && !!adapter.startVerification && !!adapter.checkVerification;

  return (
    <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '110px 1fr 140px auto', gap: 8, alignItems: 'center' }}>
      <div style={{ fontSize: 13, color: theme.text }}>{label}</div>
      <Input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder={placeholder} style={{ fontFamily: theme.fontMono, fontSize: 13 }} />
      <Input
        type="number"
        value={followerCount}
        onChange={(e) => setFollowerCount(e.target.value === '' ? '' : Number(e.target.value))}
        placeholder="followers"
        style={{ fontSize: 13 }}
      />
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button
          onClick={() => save.mutate()}
          disabled={!handle.trim() || !dirty || save.isPending}
          variant="secondary"
        >
          {save.isPending ? '…' : existing ? 'Update' : 'Add'}
        </Button>
        {existing && (
          <Button
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            variant="danger"
          >
            <X size={14} />
          </Button>
        )}
        {existing?.verified && <VerifiedBadge />}
        {canVerify && (
          <Button
            variant="secondary"
            onClick={() => setVerifying(true)}
            // A pending edit changes which account would be verified; save it first.
            disabled={dirty}
          >
            Verify
          </Button>
        )}
      </div>
      {verifying && existing && (
        <VerifyAccountDialog
          adapter={adapter}
          platform={platform}
          label={label}
          handle={existing.handle}
          onClose={() => setVerifying(false)}
          onVerified={onChanged}
        />
      )}
    </div>
  );
}

// ---------- Account verification ----------

/**
 * Three steps: copy the code, put it where only the account owner can (the
 * YouTube channel description, or a DNS TXT record), then ask the Network
 * to check. The Network does the lookup; the code stays valid for 24h and
 * reopening the dialog shows the same one.
 */
function VerifyAccountDialog({
  adapter,
  platform,
  label,
  handle,
  onClose,
  onVerified,
}: {
  adapter: NetworkProfileAdapter;
  platform: Platform;
  label: string;
  handle: string;
  onClose: () => void;
  onVerified: () => void;
}) {
  const isMobile = useIsMobile();
  const start = useQuery({
    queryKey: ['network-platform-verification', platform, ...adapter.platformsKey],
    queryFn: () => adapter.startVerification!(platform),
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const check = useMutation({
    mutationFn: () => adapter.checkVerification!(platform),
    onSuccess: () => onVerified(),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const data = start.data;
  const youtube = data?.instructions.kind === 'youtube_description' ? data.instructions : null;
  const dns = data?.instructions.kind === 'dns_txt' ? data.instructions : null;
  const checkError = check.error ? verificationError(check.error) : null;
  const startError = start.error ? verificationError(start.error) : null;
  const title = platform === 'youtube' ? 'Verify YouTube account' : `Verify ${label.toLowerCase()}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        background: theme.overlay,
        display: 'flex',
        alignItems: isMobile ? 'flex-end' : 'center',
        justifyContent: 'center',
        zIndex: 50,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: theme.surface,
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: isMobile ? `${theme.radiusSm} ${theme.radiusSm} 0 0` : theme.radiusSm,
          padding: isMobile ? 18 : 24,
          width: isMobile ? '100%' : '92%',
          maxWidth: isMobile ? undefined : 520,
          maxHeight: '90vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 500, flex: 1 }}>{title}</div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ background: 'transparent', border: 'none', color: theme.textMuted, cursor: 'pointer', padding: 2 }}
          >
            <X size={16} />
          </button>
        </div>
        <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 16px' }}>
          Prove <span style={{ fontFamily: theme.fontMono }}>{handle}</span> is yours and brands see a verified badge on your profile.
        </p>

        {check.isSuccess ? (
          <>
            <div style={{ background: theme.successSoft, border: `1px solid ${alpha(theme.success, 0.333)}`, borderRadius: theme.radiusSm, padding: 12, fontSize: 13, color: theme.success, marginBottom: 14 }}>
              {platform === 'youtube'
                ? 'Your YouTube account is verified. You can remove the code from your channel description now.'
                : 'Your website is verified. You can remove the TXT record now.'}
            </div>
            <Button onClick={onClose}>Done</Button>
          </>
        ) : start.isLoading ? (
          <p style={{ fontSize: 13, color: theme.textMuted }}>Getting your code…</p>
        ) : startError ? (
          <>
            <ErrorBanner error={startError.message} />
            <Button variant="secondary" onClick={onClose}>Close</Button>
          </>
        ) : data ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <VerifyStep n={1} title={youtube ? 'Copy your code' : 'Copy the TXT record value'}>
              <CopyBox value={youtube ? data.code : dns!.value} large={!!youtube} />
              <div style={{ fontSize: 12, color: theme.textDim, marginTop: 6 }}>
                Valid until {new Date(data.expiresAt).toLocaleString()}.
              </div>
            </VerifyStep>

            {youtube ? (
              <VerifyStep n={2} title="Add it to your channel description">
                <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 10px', lineHeight: 1.5 }}>
                  In YouTube Studio, open <strong style={{ color: theme.text }}>Customization → Basic info</strong>,
                  paste the code anywhere in your description, and click <strong style={{ color: theme.text }}>Publish</strong>.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <ExternalButton href={youtube.editUrl}>Open YouTube Studio</ExternalButton>
                  {youtube.channelUrl && <ExternalButton href={youtube.channelUrl}>View channel</ExternalButton>}
                </div>
              </VerifyStep>
            ) : (
              <VerifyStep n={2} title="Add a TXT record at your DNS provider">
                <p style={{ fontSize: 13, color: theme.textMuted, margin: 0, lineHeight: 1.5 }}>
                  Create a <strong style={{ color: theme.text }}>TXT</strong> record on{' '}
                  <span style={{ fontFamily: theme.fontMono, color: theme.text }}>{dns!.host}</span>{' '}
                  (often entered as <span style={{ fontFamily: theme.fontMono }}>@</span>) with the value above.
                </p>
              </VerifyStep>
            )}

            <VerifyStep n={3} title="Verify">
              <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 10px', lineHeight: 1.5 }}>
                {youtube
                  ? 'Once the description is published, check it here. YouTube can take a minute to show the change.'
                  : 'Once the record is saved, check it here. DNS changes can take a few minutes to appear.'}
              </p>
              {checkError && <ErrorBanner error={checkError.message} />}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {checkError?.code === 'code_expired' ? (
                  <Button onClick={() => { check.reset(); void start.refetch(); }}>Get a new code</Button>
                ) : (
                  <Button onClick={() => check.mutate()} disabled={check.isPending}>
                    {check.isPending ? 'Checking…' : 'Verify'}
                  </Button>
                )}
                <Button variant="secondary" onClick={onClose}>Close</Button>
              </div>
            </VerifyStep>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function VerifyStep({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr', gap: 10 }}>
      <div
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: theme.accentA22,
          color: theme.accentText,
          fontSize: 12,
          fontWeight: 600,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {n}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 8, lineHeight: '22px' }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function CopyBox({ value, large }: { value: string; large?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => {/* clipboard blocked: the value is still selectable */});
  };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: theme.surface2,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
        padding: '8px 10px',
      }}
    >
      <code
        style={{
          flex: 1,
          fontFamily: theme.fontMono,
          fontSize: large ? 20 : 13,
          letterSpacing: large ? '0.12em' : undefined,
          wordBreak: 'break-all',
          userSelect: 'all',
        }}
      >
        {value}
      </code>
      <button
        onClick={copy}
        aria-label="Copy"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          background: 'transparent',
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: 6,
          padding: '5px 9px',
          fontSize: 12,
          color: copied ? theme.success : theme.textMuted,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function ExternalButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '7px 12px',
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: theme.radiusSm,
        fontSize: 13,
        color: theme.text,
        textDecoration: 'none',
      }}
    >
      {children} <ExternalLink size={13} style={{ color: theme.textDim }} />
    </a>
  );
}

/**
 * The Network's error code and a sentence for the creator. The creator
 * portal relays the Network body as-is; the brand partner proxy wraps it
 * as `{ error: 'network_call_failed', detail: '<Network JSON>' }`.
 */
function verificationError(err: unknown): { code: string; message: string } {
  let body = (err as { detail?: unknown } | null)?.detail as Record<string, unknown> | null | undefined;
  if (body?.error === 'network_call_failed' && typeof body.detail === 'string') {
    try {
      body = JSON.parse(body.detail) as Record<string, unknown>;
    } catch {
      /* not JSON: keep the wrapper */
    }
  }
  const code = typeof body?.error === 'string' ? body.error : 'unknown';
  const detail = typeof body?.detail === 'string' ? body.detail : null;
  switch (code) {
    case 'too_many_attempts': {
      const minutes = Math.max(1, Math.ceil(Number(body?.retryAfterSeconds ?? 60) / 60));
      return { code, message: `Too many checks for now. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` };
    }
    case 'account_already_verified':
      return { code, message: 'Another creator has already verified this account. If it’s yours, contact support.' };
    case 'already_verified':
      return { code, message: 'This account is already verified.' };
    case 'youtube_unavailable':
    case 'dns_lookup_failed':
      return { code, message: 'We couldn’t complete the check just now. Try again in a minute.' };
    default:
      return { code, message: detail ?? (err instanceof Error ? err.message : 'Verification failed.') };
  }
}

