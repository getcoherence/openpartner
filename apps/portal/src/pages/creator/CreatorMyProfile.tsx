import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, ErrorBanner, Input, Label, Page } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';

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
      creatorApi('/creators/me', {
        method: 'PATCH',
        body: {
          name: name || undefined,
          handle: handle || null,
          avatarUrl: avatarUrl || null,
          bio: bio || null,
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['creator-my-profile'] }),
  });

  return (
    <Page title="Profile" subtitle="How vendors see you across the Network.">
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
              <p style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>
                Email is the join key across vendors and can&rsquo;t be changed here.
              </p>
            </div>
            <div>
              <Label>Display name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label>Handle</Label>
              <Input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="your-handle" />
              <p style={{ color: theme.textMuted, fontSize: 12, marginTop: 4 }}>
                Used as your default share-link slug.
              </p>
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
                  padding: '10px 12px',
                  background: theme.surface2,
                  border: `1px solid ${theme.border}`,
                  borderRadius: theme.radiusSm,
                  color: theme.text,
                  fontFamily: 'inherit',
                  fontSize: 14,
                  resize: 'vertical',
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
      <div style={{ height: 18 }} />
      <CreatorDangerZone email={data?.email ?? ''} pendingDeletionAt={(data as Profile & { pendingDeletionAt?: string | null })?.pendingDeletionAt ?? null} />
    </Page>
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
