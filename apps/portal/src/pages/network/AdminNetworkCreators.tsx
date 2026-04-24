import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Megaphone, Check, Copy } from 'lucide-react';
import { api } from '../../api.js';
import { theme } from '../../theme.js';
import { Avatar, Button, Card, EmptyState, ErrorBanner, Input, Label, Page, StatusPill, Table, formatDate } from '../../ui.js';

interface Creator {
  id: string;
  name: string;
  handle: string;
  email: string;
  bio: string | null;
  avatarUrl: string | null;
  platforms: Array<{ platform: string; url: string; followers?: number }>;
  status: string;
  createdAt: string;
  activatedAt: string | null;
}

export function AdminNetworkCreators() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newlyIssuedKey, setNewlyIssuedKey] = useState<string | null>(null);

  const creators = useQuery({
    queryKey: ['network-creators'],
    queryFn: () => api<{ creators: Creator[] }>('/network/creators'),
  });

  const activate = useMutation({
    mutationFn: (id: string) => api(`/network/creators/${id}/activate`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network-creators'] }),
  });

  return (
    <Page
      title="Network creators"
      subtitle="Promoters registered on the OpenPartner Network."
      actions={
        <Button icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
          Onboard creator
        </Button>
      }
    >
      <ErrorBanner error={creators.error ?? activate.error} />

      {newlyIssuedKey && (
        <Card style={{ marginBottom: 14, borderColor: `${theme.warn}55` }}>
          <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 6 }}>Creator key issued</div>
          <div style={{ color: theme.textMuted, fontSize: 13, marginBottom: 10 }}>
            Send this to the creator — won't be shown again.
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: theme.warnSoft,
              border: `1px solid ${theme.warn}33`,
              padding: '10px 12px',
              borderRadius: theme.radiusSm,
            }}
          >
            <code style={{ flex: 1, fontSize: 12, wordBreak: 'break-all' }}>{newlyIssuedKey}</code>
            <Button size="sm" variant="secondary" icon={<Copy size={12} />} onClick={() => navigator.clipboard.writeText(newlyIssuedKey)}>
              Copy
            </Button>
          </div>
          <Button size="sm" variant="ghost" style={{ marginTop: 10 }} onClick={() => setNewlyIssuedKey(null)}>
            Dismiss
          </Button>
        </Card>
      )}

      {showCreate && (
        <CreateCreator
          onClose={() => setShowCreate(false)}
          onCreated={(key) => {
            setShowCreate(false);
            setNewlyIssuedKey(key);
            qc.invalidateQueries({ queryKey: ['network-creators'] });
          }}
        />
      )}
      {creators.isLoading ? (
        <Card>Loading…</Card>
      ) : (creators.data?.creators ?? []).length === 0 ? (
        <EmptyState title="No creators yet" hint="Onboard one to populate the pool." icon={<Megaphone size={28} strokeWidth={1.25} />} />
      ) : (
        <Table
          columns={['Creator', 'Email', 'Platforms', 'Status', 'Actions']}
          rows={(creators.data?.creators ?? []).map((c) => [
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Avatar name={c.name} size={28} />
              <div>
                <div style={{ fontWeight: 500 }}>{c.name}</div>
                <div style={{ fontSize: 12, color: theme.textMuted }}>@{c.handle}</div>
              </div>
            </div>,
            <span style={{ color: theme.textMuted }}>{c.email}</span>,
            <span style={{ color: theme.textMuted, fontSize: 12 }}>
              {(c.platforms ?? []).map((p) => p.platform).join(', ') || '—'}
            </span>,
            <StatusPill status={c.status === 'active' ? 'connected' : c.status} />,
            c.status !== 'active' ? (
              <Button size="sm" onClick={() => activate.mutate(c.id)} icon={<Check size={12} />}>
                Activate
              </Button>
            ) : (
              <span style={{ color: theme.textMuted, fontSize: 12 }}>
                activated {formatDate(c.activatedAt, { relative: true })}
              </span>
            ),
          ])}
        />
      )}
    </Page>
  );
}

function CreateCreator({ onClose, onCreated }: { onClose: () => void; onCreated: (creatorKey: string) => void }) {
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [bio, setBio] = useState('');
  const [defaultPromoCode, setDefaultPromoCode] = useState('');
  const [platform, setPlatform] = useState('youtube');
  const [platformUrl, setPlatformUrl] = useState('');
  const [followers, setFollowers] = useState('');

  const mut = useMutation({
    mutationFn: () =>
      api<{ creator: Creator; apiKey: string }>('/network/creators', {
        method: 'POST',
        body: {
          name,
          handle,
          email,
          bio: bio || undefined,
          defaultPromoCode: defaultPromoCode || undefined,
          platforms: platformUrl
            ? [{ platform, url: platformUrl, followers: followers ? Number(followers) : undefined }]
            : [],
        },
      }),
    onSuccess: (data) => onCreated(data.apiKey),
  });

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>Onboard creator</div>
      <ErrorBanner error={mut.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Grace Hopper" />
        </div>
        <div>
          <Label>Handle</Label>
          <Input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="gracie" />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12, marginBottom: 12 }}>
        <div>
          <Label>Email</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="grace@example.com" />
        </div>
        <div>
          <Label>Bio (optional)</Label>
          <Input value={bio} onChange={(e) => setBio(e.target.value)} placeholder="What they publish about" />
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <Label>Default share code (optional)</Label>
        <Input
          value={defaultPromoCode}
          onChange={(e) => setDefaultPromoCode(e.target.value)}
          placeholder="graciefindsdeals"
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '120px 2fr 1fr', gap: 12, marginBottom: 14 }}>
        <div>
          <Label>Primary platform</Label>
          <select
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
            style={{
              padding: '10px 12px',
              fontSize: 14,
              background: theme.surface2,
              border: `1px solid ${theme.border}`,
              borderRadius: theme.radiusSm,
              color: theme.text,
              width: '100%',
            }}
          >
            {['youtube', 'twitter', 'instagram', 'tiktok', 'blog', 'podcast', 'other'].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div>
          <Label>Platform URL</Label>
          <Input value={platformUrl} onChange={(e) => setPlatformUrl(e.target.value)} placeholder="https://youtube.com/@gracie" />
        </div>
        <div>
          <Label>Followers</Label>
          <Input type="number" value={followers} onChange={(e) => setFollowers(e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => mut.mutate()} disabled={!name || !handle || !email || mut.isPending}>
          {mut.isPending ? 'Registering…' : 'Register'}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
