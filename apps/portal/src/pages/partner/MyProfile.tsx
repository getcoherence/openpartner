import { useQuery } from '@tanstack/react-query';
import { api } from '../../api.js';
import { Card, ErrorBanner, Page } from '../../ui.js';
import {
  NetworkProfileEditor,
  type NetworkProfile,
  type NetworkProfileAdapter,
  type PlatformRow,
  type VerificationStart,
} from '../../lib/NetworkProfileEditor.js';
import type { CoverSource } from '../../lib/PlatformMark.js';
import { NetworkMembershipCard, useNetworkConsent } from './NetworkConsent.js';

interface ProfileResponse extends Partial<NetworkProfile> {
  notFederated?: boolean;
  /** The partner hasn't opted in to the Network (or has left it). */
  consentRequired?: boolean;
}

/**
 * A brand partner's Network profile, edited from inside the brand portal
 * through the brand's /network/me… proxies (which act as this partner on
 * the Network). Same editor as the creator portal, so a partner can finish
 * every item the Network's completeness bar checks and apply to programs.
 *
 * The membership setting sits on top: this is where a partner joins or
 * leaves the Network. The editor only appears once they're on it.
 */
const partnerProfileAdapter: NetworkProfileAdapter = {
  profileKey: ['network-my-profile'],
  platformsKey: ['network-my-platforms'],
  updateProfile: (body) => api('/network/me/profile', { method: 'PATCH', body }),
  uploadAvatar: (file) => api<{ avatarUrl: string }>('/network/me/uploads/avatar', { method: 'POST', body: file }),
  uploadCover: (file) => api<{ coverImageUrl: string }>('/network/me/uploads/cover', { method: 'POST', body: file }),
  copyYouTubeBanner: () =>
    api<{ coverImageUrl: string; coverSource: CoverSource | null }>('/network/me/cover/youtube', { method: 'POST', body: {} }),
  listPlatforms: () => api<{ platforms: PlatformRow[] }>('/network/me/platforms'),
  putPlatform: (platform, body) => api(`/network/me/platforms/${platform}`, { method: 'PUT', body }),
  deletePlatform: (platform) => api(`/network/me/platforms/${platform}`, { method: 'DELETE' }),
  startVerification: (platform) =>
    api<VerificationStart>(`/network/me/platforms/${platform}/verify/start`, { method: 'POST', body: {} }),
  checkVerification: (platform) =>
    api<{ ok: boolean; platform?: PlatformRow }>(`/network/me/platforms/${platform}/verify`, { method: 'POST', body: {} }),
};

export function MyProfilePage() {
  const consent = useNetworkConsent();
  const { data, isLoading, error } = useQuery({
    queryKey: ['network-my-profile'],
    queryFn: () => api<ProfileResponse>(`/network/me/profile`),
    retry: false,
  });

  return (
    <Page title="Network profile" subtitle="How vendors see you across the OpenPartner Network.">
      <ErrorBanner error={error ?? consent.error} />
      {consent.data && (
        <div style={{ marginBottom: 18 }}>
          <NetworkMembershipCard consent={consent.data} />
        </div>
      )}
      {isLoading ? (
        <Card>Loading…</Card>
      ) : data?.consentRequired ? null : data?.notFederated ? (
        <Card>
          <div style={{ fontSize: 14 }}>
            Your Network profile is being set up. It usually appears within a few minutes of joining — check back
            shortly.
          </div>
        </Card>
      ) : data ? (
        // /creators/:handle only exists on the multi-tenant platform host
        // (not on self-host), so the brand portal shows no public link.
        <NetworkProfileEditor adapter={partnerProfileAdapter} data={data as NetworkProfile} publicProfileHref={null} />
      ) : null}
    </Page>
  );
}
