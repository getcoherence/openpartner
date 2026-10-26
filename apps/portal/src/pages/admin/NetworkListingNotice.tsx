import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { api } from '../../api.js';
import { TenantLink } from '../../tenant-link.js';
import { alpha, theme } from '../../theme.js';
import { isNetworkConnected, type NetworkMembership, type NetworkSelf } from './NetworkSettingsSection.js';

/**
 * On the brand's Network pages: says so while OpenPartner hasn't approved
 * the brand's marketplace listing, or has turned it down, so an empty
 * Requests queue isn't a mystery. Renders nothing once approved.
 */
export function NetworkListingNotice({ isMobile }: { isMobile: boolean }) {
  const { data: membership } = useQuery({
    queryKey: ['network-membership'],
    queryFn: () => api<NetworkMembership>('/config/network'),
    staleTime: 60_000,
    retry: false,
  });
  const connected = isNetworkConnected(membership);
  const { data: self } = useQuery({
    queryKey: ['network-self'],
    queryFn: () => api<NetworkSelf>('/admin/network/me'),
    enabled: connected,
    // Each fetch also sends the Network a heartbeat; once per page visit
    // within five minutes is plenty.
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (!connected || (self?.reviewStatus !== 'pending' && self?.reviewStatus !== 'rejected')) return null;
  const rejected = self.reviewStatus === 'rejected';
  const tone = rejected ? theme.danger : theme.warn;

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: isMobile ? '16px 16px 0' : '24px 40px 0' }}>
      <div
        role="status"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          background: rejected ? theme.dangerSoft : theme.warnSoft,
          border: `1px solid ${alpha(tone, 0.333)}`,
          borderRadius: theme.radiusMd,
          padding: '12px 14px',
        }}
      >
        <AlertTriangle size={18} style={{ color: tone, flexShrink: 0, marginTop: 1 }} />
        <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.5, color: theme.text }}>
          {rejected ? (
            <>
              <strong style={{ color: tone }}>Your brand isn&rsquo;t listed on the marketplace.</strong>{' '}
              OpenPartner didn&rsquo;t approve the listing, so creators can&rsquo;t find your programs. Reply to the
              review email if you think this is a mistake.
            </>
          ) : (
            <>
              <strong style={{ color: tone }}>Your marketplace listing is waiting for review.</strong>{' '}
              Your published programs appear to creators once OpenPartner approves your brand. You&rsquo;ll get an
              email when that happens.
            </>
          )}{' '}
          <TenantLink to="/admin/settings#network" style={{ color: theme.accentText }}>
            Network settings
          </TenantLink>
        </div>
      </div>
    </div>
  );
}
