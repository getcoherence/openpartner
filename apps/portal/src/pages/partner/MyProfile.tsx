import { useQuery } from '@tanstack/react-query';
import { api } from '../../api.js';
import { Card, ErrorBanner, Page } from '../../ui.js';
import {
  NetworkProfileEditor,
  type NetworkProfile,
  type NetworkProfileAdapter,
  type PlatformRow,
} from '../../lib/NetworkProfileEditor.js';

interface ProfileResponse extends Partial<NetworkProfile> {
  notFederated?: boolean;
}

/**
 * A brand partner's Network profile, edited from inside the brand portal
 * through the brand's /network/me… proxies (which act as this partner on
 * the Network). Same editor as the creator portal, so a partner can finish
 * every item the Network's completeness bar checks and apply to programs.
 */
const partnerProfileAdapter: NetworkProfileAdapter = {
  profileKey: ['network-my-profile'],
  platformsKey: ['network-my-platforms'],
  updateProfile: (body) => api('/network/me/profile', { method: 'PATCH', body }),
  uploadAvatar: (file) => api<{ avatarUrl: string }>('/network/me/uploads/avatar', { method: 'POST', body: file }),
  listPlatforms: () => api<{ platforms: PlatformRow[] }>('/network/me/platforms'),
  putPlatform: (platform, body) => api(`/network/me/platforms/${platform}`, { method: 'PUT', body }),
  deletePlatform: (platform) => api(`/network/me/platforms/${platform}`, { method: 'DELETE' }),
};

export function MyProfilePage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['network-my-profile'],
    queryFn: () => api<ProfileResponse>(`/network/me/profile`),
    retry: false,
  });

  return (
    <Page title="Network profile" subtitle="How vendors see you across the OpenPartner Network.">
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : data?.notFederated ? (
        <Card>
          <div style={{ fontSize: 14 }}>
            Your brand hasn&rsquo;t pushed you to the Network yet. Ask the brand admin to enable
            <strong> auto-enroll</strong> on Settings → Network and run <strong>Backfill</strong>;
            once that&rsquo;s done your Network profile will appear here.
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
