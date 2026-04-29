import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { Button, Card, ErrorBanner, Input, Label, Page, Select, Textarea } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';

type AgeRange = '13-17' | '18-24' | '25-34' | '35-44' | '45-54' | '55+';

interface Profile {
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
  portfolioLinks: string[];
  pastBrands: string[];
  createdAt: string;
}

type Platform = 'tiktok' | 'instagram' | 'youtube' | 'twitter' | 'linkedin' | 'substack' | 'twitch' | 'podcast' | 'website';

interface PlatformRow {
  id: string;
  platform: Platform;
  handle: string;
  profileUrl: string | null;
  followerCount: number | null;
  verified: boolean;
}

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

export function CreatorMyProfilePage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['creator-my-profile'],
    queryFn: () => creatorApi<Profile>('/creators/me'),
    retry: false,
  });

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
      return creatorApi('/creators/me', {
        method: 'PATCH',
        body: {
          name: name || undefined,
          handle: handle || null,
          avatarUrl: avatarUrl || null,
          bio: bio || null,
          categories,
          audienceLocations,
          audienceAgeRange: audienceAgeRange || null,
          portfolioLinks: portfolioLinks.filter((u) => u.trim()),
          pastBrands,
        },
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['creator-my-profile'] }),
  });

  return (
    <Page title="Profile" subtitle="How vendors see you across the Network. Richer profile = better matches.">
      <ErrorBanner error={error} />
      <ErrorBanner error={save.error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : data ? (
        <>
          <Card>
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>Basics</div>
            <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
              <Field label="Email" hint="Email is the join key across vendors and can't be changed here.">
                <Input value={data.email} disabled readOnly />
              </Field>
              <Field label="Display name">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Handle" hint="Used as your default share-link slug and your /creators/<handle> URL.">
                <Input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="your-handle" />
              </Field>
              <Field label="Avatar URL">
                <Input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://…" />
              </Field>
              <Field label="Bio">
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
              <Field label="Categories" hint="Pick the niches you create in. Brands filter by these.">
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

          <PlatformsCard />

          <div style={{ height: 14 }} />

          <Card>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved' : 'Save profile'}
              </Button>
              {data.handle && (
                <a
                  href={`/creators/${data.handle}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: theme.accent, fontSize: 13, marginLeft: 4 }}
                >
                  View public profile →
                </a>
              )}
            </div>
          </Card>
        </>
      ) : null}
      <div style={{ height: 18 }} />
      <CreatorDangerZone email={data?.email ?? ''} pendingDeletionAt={(data as Profile & { pendingDeletionAt?: string | null })?.pendingDeletionAt ?? null} />
    </Page>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
      {hint && <p style={{ color: theme.textMuted, fontSize: 12, marginTop: 4, marginBottom: 0 }}>{hint}</p>}
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
              background: on ? `${theme.accent}22` : theme.surface2,
              color: on ? theme.accent : theme.textMuted,
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

/** Platforms gets its own data lifecycle — each row is a separate
 *  PUT/DELETE on Network rather than a bulk PATCH, since users add /
 *  remove platforms one at a time and we want optimistic per-row save
 *  feedback. */
function PlatformsCard() {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['creator-my-platforms'],
    queryFn: () => creatorApi<{ platforms: PlatformRow[] }>('/creators/me/platforms'),
    retry: false,
  });

  return (
    <Card>
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Platforms</div>
      <p style={{ fontSize: 13, color: theme.textMuted, margin: '0 0 14px' }}>
        Where you publish + your audience size on each. Self-reported &mdash; verified numbers
        come when you connect platforms (coming soon).
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
                platform={p.kind}
                label={p.label}
                placeholder={p.placeholder}
                existing={existing}
                onChanged={() => qc.invalidateQueries({ queryKey: ['creator-my-platforms'] })}
              />
            );
          })}
        </div>
      )}
    </Card>
  );
}

function PlatformRowEditor({
  platform,
  label,
  placeholder,
  existing,
  onChanged,
}: {
  platform: Platform;
  label: string;
  placeholder: string;
  existing?: PlatformRow;
  onChanged: () => void;
}) {
  const [handle, setHandle] = useState(existing?.handle ?? '');
  const [followerCount, setFollowerCount] = useState<number | ''>(existing?.followerCount ?? '');

  useEffect(() => {
    setHandle(existing?.handle ?? '');
    setFollowerCount(existing?.followerCount ?? '');
  }, [existing?.handle, existing?.followerCount]);

  const save = useMutation({
    mutationFn: () =>
      creatorApi(`/creators/me/platforms/${platform}`, {
        method: 'PUT',
        body: { handle: handle.trim(), followerCount: followerCount === '' ? null : Number(followerCount) },
      }),
    onSuccess: onChanged,
  });
  const remove = useMutation({
    mutationFn: () => creatorApi(`/creators/me/platforms/${platform}`, { method: 'DELETE' }),
    onSuccess: onChanged,
  });

  const dirty = handle.trim() !== (existing?.handle ?? '') || (followerCount === '' ? null : Number(followerCount)) !== (existing?.followerCount ?? null);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 140px auto', gap: 8, alignItems: 'center' }}>
      <div style={{ fontSize: 13, color: theme.text }}>{label}</div>
      <Input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder={placeholder} style={{ fontFamily: theme.fontMono, fontSize: 13 }} />
      <Input
        type="number"
        value={followerCount}
        onChange={(e) => setFollowerCount(e.target.value === '' ? '' : Number(e.target.value))}
        placeholder="followers"
        style={{ fontSize: 13 }}
      />
      <div style={{ display: 'flex', gap: 6 }}>
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
      </div>
    </div>
  );
}

function CreatorDangerZone({ email, pendingDeletionAt }: { email: string; pendingDeletionAt: string | null }) {
  const qc = useQueryClient();
  const [confirmEmail, setConfirmEmail] = useState('');
  const [showForm, setShowForm] = useState(false);

  const del = useMutation({
    mutationFn: () => creatorApi('/creators/me/delete', { method: 'POST', body: { confirmEmail } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network-my-profile'] });
      setShowForm(false);
      setConfirmEmail('');
    },
  });

  const restore = useMutation({
    mutationFn: () => creatorApi('/creators/me/restore', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network-my-profile'] }),
  });

  const pending = !!pendingDeletionAt;
  const hardDeleteAt = pendingDeletionAt
    ? new Date(new Date(pendingDeletionAt).getTime() + 30 * 24 * 60 * 60 * 1000)
    : null;

  return (
    <Card>
      <div style={{ fontSize: 15, fontWeight: 500, color: theme.danger, marginBottom: 12 }}>
        Danger zone
      </div>

      {pending ? (
        <>
          <div style={{ background: `${theme.danger}15`, border: `1px solid ${theme.danger}55`, padding: 14, borderRadius: 6, marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: theme.danger }}>
              Account scheduled for deletion
            </div>
            <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 6 }}>
              Permanent deletion on{' '}
              <strong>{hardDeleteAt ? hardDeleteAt.toLocaleDateString() : '—'}</strong>.
              You can recover any time before then.
            </div>
          </div>
          <ErrorBanner error={restore.error} />
          <Button onClick={() => restore.mutate()} disabled={restore.isPending}>
            {restore.isPending ? 'Restoring…' : 'Recover account'}
          </Button>
        </>
      ) : !showForm ? (
        <>
          <p style={{ color: theme.textMuted, fontSize: 13, margin: '0 0 14px' }}>
            Deleting permanently removes your Network profile and revokes all your vendor partnerships
            after a 30-day grace period. Past commissions on each brand stay with that brand&rsquo;s books.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <a
              href="/api/creator-api/creators/me/export"
              style={{
                background: 'transparent',
                color: theme.text,
                border: `1px solid ${theme.borderSubtle}`,
                borderRadius: theme.radiusSm,
                padding: '8px 14px',
                fontSize: 13,
                textDecoration: 'none',
              }}
            >
              Download my data
            </a>
            <Button variant="secondary" onClick={() => setShowForm(true)}>Delete my account</Button>
          </div>
        </>
      ) : (
        <>
          <p style={{ color: theme.textMuted, fontSize: 13, margin: '0 0 12px' }}>
            Type your email to confirm. This locks you out immediately.
          </p>
          <div style={{ marginBottom: 14 }}>
            <Label>Confirm email</Label>
            <Input type="email" name="confirmEmail" value={confirmEmail} onChange={(e) => setConfirmEmail(e.target.value)} placeholder={email} />
          </div>
          <ErrorBanner error={del.error} />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => del.mutate()} disabled={del.isPending || !confirmEmail}>
              {del.isPending ? 'Deleting…' : 'Permanently delete'}
            </Button>
            <Button variant="secondary" onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </>
      )}
    </Card>
  );
}
