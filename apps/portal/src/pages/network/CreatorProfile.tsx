import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Save, Check } from 'lucide-react';
import { api } from '../../api.js';
import { theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Input, Label, Page, SectionHeading, Select } from '../../ui.js';

interface Platform {
  platform: 'youtube' | 'twitter' | 'instagram' | 'tiktok' | 'blog' | 'podcast' | 'other';
  url: string;
  followers?: number;
}

interface Creator {
  id: string;
  name: string;
  handle: string;
  email: string;
  bio: string | null;
  avatarUrl: string | null;
  platforms: Platform[];
  defaultPromoCode: string | null;
  status: string;
}

export function CreatorProfilePage() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['creator-me'],
    queryFn: () => api<{ creator: Creator }>('/network/creators/me'),
  });

  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [defaultPromoCode, setDefaultPromoCode] = useState('');
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data?.creator) return;
    setName(data.creator.name);
    setBio(data.creator.bio ?? '');
    setAvatarUrl(data.creator.avatarUrl ?? '');
    setDefaultPromoCode(data.creator.defaultPromoCode ?? '');
    setPlatforms(data.creator.platforms ?? []);
  }, [data?.creator]);

  const save = useMutation({
    mutationFn: () =>
      api<{ creator: Creator }>('/network/creators/me', {
        method: 'PATCH',
        body: {
          name: name.trim(),
          bio: bio.trim() || null,
          avatarUrl: avatarUrl.trim() || null,
          defaultPromoCode: defaultPromoCode.trim() || null,
          platforms: platforms.filter((p) => p.url.trim().length > 0),
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['creator-me'] });
      qc.invalidateQueries({ queryKey: ['whoami'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <Page title="Profile" subtitle="What vendors see when they browse creators.">
      <ErrorBanner error={error ?? save.error} />
      {isLoading || !data ? (
        <Card>Loading…</Card>
      ) : (
        <>
          <Card>
            <SectionHeadingInline>Identity</SectionHeadingInline>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              <div>
                <Label>Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <Label>Handle</Label>
                <Input value={data.creator.handle} disabled style={{ color: theme.textMuted }} />
                <div style={{ fontSize: 11, color: theme.textDim, marginTop: 4 }}>
                  Handle and email are fixed — they anchor your share links and sign-in.
                </div>
              </div>
            </div>
            <div style={{ marginBottom: 14 }}>
              <Label>Bio</Label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={3}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  fontSize: 14,
                  background: theme.surface2,
                  border: `1px solid ${theme.border}`,
                  borderRadius: theme.radiusSm,
                  color: theme.text,
                  fontFamily: theme.fontSans,
                  resize: 'vertical',
                }}
                placeholder="A sentence vendors will read before inviting you."
              />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div>
                <Label>Avatar URL</Label>
                <Input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://…" />
              </div>
              <div>
                <Label>Default share code</Label>
                <Input
                  value={defaultPromoCode}
                  onChange={(e) => setDefaultPromoCode(e.target.value)}
                  placeholder="graciefindsdeals"
                />
                <div style={{ fontSize: 11, color: theme.textDim, marginTop: 4 }}>
                  Pre-fills every new application. URL-safe, 3–40 chars.
                </div>
              </div>
            </div>
          </Card>

          <SectionHeading actions={<Button variant="secondary" size="sm" icon={<Plus size={12} />} onClick={() => setPlatforms([...platforms, { platform: 'youtube', url: '' }])}>Add platform</Button>}>
            Platforms
          </SectionHeading>
          {platforms.length === 0 ? (
            <Card>
              <div style={{ color: theme.textMuted, fontSize: 13 }}>
                Add the channels where you publish — vendors decide who to invite largely off this list.
              </div>
            </Card>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {platforms.map((p, i) => (
                <PlatformRow
                  key={i}
                  platform={p}
                  onChange={(next) => setPlatforms(platforms.map((x, j) => (i === j ? next : x)))}
                  onRemove={() => setPlatforms(platforms.filter((_, j) => j !== i))}
                />
              ))}
            </div>
          )}

          <div style={{ marginTop: 24, display: 'flex', gap: 10, alignItems: 'center' }}>
            <Button onClick={() => save.mutate()} disabled={save.isPending} icon={save.isPending ? undefined : <Save size={14} />}>
              {save.isPending ? 'Saving…' : 'Save profile'}
            </Button>
            {saved && (
              <span style={{ color: theme.success, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Check size={14} /> Saved
              </span>
            )}
          </div>
        </>
      )}
    </Page>
  );
}

function PlatformRow({
  platform,
  onChange,
  onRemove,
}: {
  platform: Platform;
  onChange: (p: Platform) => void;
  onRemove: () => void;
}) {
  return (
    <Card>
      <div style={{ display: 'grid', gridTemplateColumns: '140px 2fr 120px auto', gap: 10, alignItems: 'end' }}>
        <div>
          <Label>Platform</Label>
          <Select value={platform.platform} onChange={(e) => onChange({ ...platform, platform: e.target.value as Platform['platform'] })}>
            {['youtube', 'twitter', 'instagram', 'tiktok', 'blog', 'podcast', 'other'].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>URL</Label>
          <Input value={platform.url} onChange={(e) => onChange({ ...platform, url: e.target.value })} placeholder="https://…" />
        </div>
        <div>
          <Label>Followers</Label>
          <Input
            type="number"
            value={platform.followers ?? ''}
            onChange={(e) => onChange({ ...platform, followers: e.target.value ? Number(e.target.value) : undefined })}
          />
        </div>
        <Button variant="secondary" onClick={onRemove} icon={<Trash2 size={14} />} style={{ height: 38 }}>
          Remove
        </Button>
      </div>
    </Card>
  );
}

function SectionHeadingInline({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 600, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 14 }}>
      {children}
    </div>
  );
}
