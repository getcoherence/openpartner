import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, ErrorBanner, Input, Label, Page } from '../../ui.js';
import { alpha, theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';
import {
  NetworkProfileEditor,
  type NetworkProfile,
  type NetworkProfileAdapter,
  type PlatformRow,
  type VerificationStart,
} from '../../lib/NetworkProfileEditor.js';

/** The creator portal talks to the Network through /api/creator-api. */
const creatorProfileAdapter: NetworkProfileAdapter = {
  profileKey: ['creator-my-profile'],
  platformsKey: ['creator-my-platforms'],
  updateProfile: (body) => creatorApi('/creators/me', { method: 'PATCH', body }),
  uploadAvatar: (file) => creatorApi<{ avatarUrl: string }>('/creators/me/uploads/avatar', { method: 'POST', body: file }),
  listPlatforms: () => creatorApi<{ platforms: PlatformRow[] }>('/creators/me/platforms'),
  putPlatform: (platform, body) => creatorApi(`/creators/me/platforms/${platform}`, { method: 'PUT', body }),
  deletePlatform: (platform) => creatorApi(`/creators/me/platforms/${platform}`, { method: 'DELETE' }),
  startVerification: (platform) =>
    creatorApi<VerificationStart>(`/creators/me/platforms/${platform}/verify/start`, { method: 'POST', body: {} }),
  checkVerification: (platform) =>
    creatorApi<{ ok: boolean; platform?: PlatformRow }>(`/creators/me/platforms/${platform}/verify`, { method: 'POST', body: {} }),
};

export function CreatorMyProfilePage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['creator-my-profile'],
    queryFn: () => creatorApi<NetworkProfile>('/creators/me'),
    retry: false,
  });

  return (
    <Page title="Profile" subtitle="How vendors see you across the Network. Richer profile = better matches.">
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : data ? (
        <NetworkProfileEditor
          adapter={creatorProfileAdapter}
          data={data}
          publicProfileHref={data.handle ? `/creators/${data.handle}` : null}
        />
      ) : null}
      <div style={{ height: 18 }} />
      <CreatorDangerZone email={data?.email ?? ''} pendingDeletionAt={(data as NetworkProfile & { pendingDeletionAt?: string | null })?.pendingDeletionAt ?? null} />
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
          <div style={{ background: alpha(theme.danger, 0.082), border: `1px solid ${alpha(theme.danger, 0.333)}`, padding: 14, borderRadius: 6, marginBottom: 14 }}>
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
