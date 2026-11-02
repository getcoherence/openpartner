import { useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router';
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
import { publicStorefrontUrl } from '../../lib/public-site.js';
import type { CoverSource } from '../../lib/PlatformMark.js';
import { PasswordSection, type PasswordBody } from '../Account.js';
import { creatorErrorCode } from './CreatorSignin.js';
import { CreatorMessagesCard } from './CreatorReview.js';

/** The creator portal talks to the Network through /api/creator-api. */
export const creatorProfileAdapter: NetworkProfileAdapter = {
  profileKey: ['creator-my-profile'],
  platformsKey: ['creator-my-platforms'],
  updateProfile: (body) => creatorApi('/creators/me', { method: 'PATCH', body }),
  uploadAvatar: (file) => creatorApi<{ avatarUrl: string }>('/creators/me/uploads/avatar', { method: 'POST', body: file }),
  uploadCover: (file) => creatorApi<{ coverImageUrl: string }>('/creators/me/uploads/cover', { method: 'POST', body: file }),
  copyYouTubeBanner: () =>
    creatorApi<{ coverImageUrl: string; coverSource: CoverSource | null }>('/creators/me/cover/youtube', { method: 'POST', body: {} }),
  listPlatforms: () => creatorApi<{ platforms: PlatformRow[] }>('/creators/me/platforms'),
  putPlatform: (platform, body) => creatorApi(`/creators/me/platforms/${platform}`, { method: 'PUT', body }),
  deletePlatform: (platform) => creatorApi(`/creators/me/platforms/${platform}`, { method: 'DELETE' }),
  startVerification: (platform) =>
    creatorApi<VerificationStart>(`/creators/me/platforms/${platform}/verify/start`, { method: 'POST', body: {} }),
  checkVerification: (platform) =>
    creatorApi<{ ok: boolean; platform?: PlatformRow }>(`/creators/me/platforms/${platform}/verify`, { method: 'POST', body: {} }),
};

/**
 * Three tabs, so Save profile ends the Profile tab: Profile (the editor),
 * Password, and Account (data download + deletion).
 */
export function CreatorMyProfilePage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['creator-my-profile'],
    queryFn: () => creatorApi<NetworkProfile & { pendingDeletionAt?: string | null }>('/creators/me'),
    retry: false,
  });
  const pendingDeletionAt = data?.pendingDeletionAt ?? null;

  return (
    <Page title="Profile" subtitle="How vendors see you across the Network. Richer profile = better matches.">
      <ErrorBanner error={error} />
      <ProfileTabs />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : (
        <Routes>
          <Route
            index
            element={
              <>
                <CreatorMessagesCard />
                {data && (
                  <NetworkProfileEditor
                    adapter={creatorProfileAdapter}
                    data={data}
                    publicProfileHref={data.handle ? publicStorefrontUrl(data.handle) : null}
                  />
                )}
              </>
            }
          />
          <Route
            path="password"
            element={
              pendingDeletionAt ? (
                <Card>
                  <div style={{ fontSize: 13, color: theme.textMuted }}>
                    Your account is scheduled for deletion.{' '}
                    <Link to="/creator/profile/account" style={{ color: theme.accentText }}>Recover it</Link> to change your password.
                  </div>
                </Card>
              ) : (
                <CreatorPasswordCard pendingDeletion={false} />
              )
            }
          />
          <Route path="account" element={<CreatorDangerZone email={data?.email ?? ''} pendingDeletionAt={pendingDeletionAt} />} />
          {/* Absolute, like CreatorShell's redirects (a splat route). */}
          <Route path="*" element={<Navigate to="/creator/profile" replace />} />
        </Routes>
      )}
    </Page>
  );
}

function ProfileTabs() {
  const tabs: Array<{ to: string; label: string; end?: boolean }> = [
    { to: '/creator/profile', label: 'Profile', end: true },
    { to: '/creator/profile/password', label: 'Password' },
    { to: '/creator/profile/account', label: 'Account' },
  ];
  return (
    <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${theme.borderSubtle}`, marginBottom: 14 }}>
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          style={({ isActive }) => ({
            padding: '8px 14px',
            fontSize: 13,
            color: isActive ? theme.text : theme.textMuted,
            borderBottom: `2px solid ${isActive ? theme.accent : 'transparent'}`,
            marginBottom: -1,
            fontWeight: isActive ? 500 : 400,
            textDecoration: 'none',
          })}
        >
          {t.label}
        </NavLink>
      ))}
    </div>
  );
}

/**
 * Set or change the creator's Network password (GET|PUT /creators/me/password,
 * the creator's own session only). The current password is required once one
 * is set; changing it signs out the creator's other devices.
 */
export function CreatorPasswordCard({ pendingDeletion }: { pendingDeletion: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['creator-password'],
    queryFn: () => creatorApi<{ hasPassword: boolean }>('/creators/me/password'),
    retry: false,
  });
  // Mid-deletion the account takes recovery actions only.
  if (pendingDeletion) return null;
  if (!q.data) return q.isLoading ? <Card>Loading…</Card> : <ErrorBanner error={q.error} />;
  return (
    <PasswordSection
      hasPassword={q.data.hasPassword}
      sharedNote="Changing it signs you out on your other devices."
      onSave={async (body: PasswordBody) => {
        try {
          await creatorApi('/creators/me/password', { method: 'PUT', body });
        } catch (e) {
          throw creatorErrorCode(e);
        }
        await qc.invalidateQueries({ queryKey: ['creator-password'] });
      }}
    />
  );
}

function CreatorDangerZone({ email, pendingDeletionAt }: { email: string; pendingDeletionAt: string | null }) {
  const qc = useQueryClient();
  const [confirmEmail, setConfirmEmail] = useState('');
  const [showForm, setShowForm] = useState(false);

  const del = useMutation({
    mutationFn: () => creatorApi('/creators/me/delete', { method: 'POST', body: { confirmEmail } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: creatorProfileAdapter.profileKey });
      setShowForm(false);
      setConfirmEmail('');
    },
  });

  const restore = useMutation({
    mutationFn: () => creatorApi('/creators/me/restore', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: creatorProfileAdapter.profileKey }),
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
