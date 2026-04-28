import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api.js';
import { Button, Card, ErrorBanner, Input, Label, Page } from '../../ui.js';
import { theme } from '../../theme.js';

interface Profile {
  id: string;
  email: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  bio: string | null;
  profile: Record<string, unknown> | null;
  createdAt: string;
}

export function MyProfilePage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['network-my-profile'],
    queryFn: () => api<Profile>(`/network/me/profile`),
    retry: false,
  });

  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [bio, setBio] = useState('');

  useEffect(() => {
    if (data) {
      setName(data.name ?? '');
      setHandle(data.handle ?? '');
      setAvatarUrl(data.avatarUrl ?? '');
      setBio(data.bio ?? '');
    }
  }, [data]);

  const save = useMutation({
    mutationFn: () =>
      api(`/network/me/profile`, {
        method: 'PATCH',
        body: {
          name: name || undefined,
          handle: handle || null,
          avatarUrl: avatarUrl || null,
          bio: bio || null,
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network-my-profile'] }),
  });

  return (
    <Page title="Network profile" subtitle="How vendors see you across the OpenPartner Network.">
      <ErrorBanner error={error} />
      <ErrorBanner error={save.error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : data ? (
        <Card>
          <div style={{ display: 'grid', gap: 12, maxWidth: 520 }}>
            <div>
              <Label>Email</Label>
              <Input value={data.email} disabled readOnly />
              <p style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>Email is the join key across vendors and can&rsquo;t be changed here.</p>
            </div>
            <div>
              <Label>Display name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label>Handle</Label>
              <Input
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="your-handle"
              />
              <p style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>Used as your default share-link slug.</p>
            </div>
            <div>
              <Label>Avatar URL</Label>
              <Input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} placeholder="https://…" />
            </div>
            <div>
              <Label>Bio</Label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={4}
                style={{
                  width: '100%',
                  padding: '8px 10px',
                  border: `1px solid ${theme.border}`,
                  borderRadius: 6,
                  fontFamily: 'inherit',
                  fontSize: 14,
                }}
              />
            </div>
            <div>
              <Button onClick={() => save.mutate()} disabled={save.isPending}>
                {save.isPending ? 'Saving…' : save.isSuccess ? 'Saved' : 'Save changes'}
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </Page>
  );
}
