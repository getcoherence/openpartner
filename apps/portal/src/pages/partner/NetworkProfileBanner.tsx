import { useQuery } from '@tanstack/react-query';
import { api } from '../../api.js';
import { TenantLink } from '../../tenant-link.js';
import { ProfileCompletionBanner } from '../../lib/ProfileCompletionBanner.js';
import type { ProfileCompleteness } from '../../lib/profile-incomplete.js';

/**
 * The creator-portal "complete your profile" banner, for a brand partner on
 * the brand's Network pages. GET /network/me/profile proxies the Network's
 * GET /creators/me (checklist included) and shares its cache entry with the
 * Network profile page, whose save invalidates it. A partner the brand
 * hasn't pushed to the Network yet (notFederated) has no profile to finish.
 */
export function NetworkProfileBanner({ isMobile }: { isMobile: boolean }) {
  const { data } = useQuery({
    queryKey: ['network-my-profile'],
    queryFn: () => api<ProfileCompleteness & { notFederated?: boolean }>('/network/me/profile'),
    retry: false,
    staleTime: 60_000,
  });
  return (
    <ProfileCompletionBanner
      profile={data?.notFederated ? null : data}
      isMobile={isMobile}
      dismissKey="op:network-profile-banner-dismissed"
      renderLink={(style, children) => <TenantLink to="/network/profile" style={style}>{children}</TenantLink>}
    />
  );
}
