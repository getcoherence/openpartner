import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe } from 'lucide-react';
import { useNavigate } from 'react-router';
import { api, ApiError } from '../../api.js';
import { useTenantBase } from '../../tenant-base.js';
import { alpha, theme } from '../../theme.js';
import { Button, Card, ErrorBanner } from '../../ui.js';

export interface NetworkMembership {
  enabled: boolean;
  networkUrl: string;
  hasVendorToken: boolean;
  scopedKeyId: string | null;
  autoEnroll: boolean;
  /** The Network's key may pay bonuses (Network bounties). Absent on an
   *  API from before bonuses. */
  bonusesAuthorized?: boolean;
  /** How this instance is billed for the Network: hosted plans include
   *  it. Absent on an API from before the field. */
  tier?: 'hosted' | 'self_hosted';
}

export interface NetworkSelf {
  id: string;
  displayName: string;
  status: string;
  partnerCount: number;
  /** OpenPartner's review of this vendor. Only 'approved' vendors are
   *  discoverable on the marketplace. Absent on an older Network. */
  reviewStatus?: 'pending' | 'approved' | 'rejected';
}

interface ConsentSummary {
  partners: number;
  granted: number;
  withdrawn: number;
  declined: number;
}

interface BackfillResult {
  total: number;
  pushed: number;
  queued: number;
}

/** Connected once enabled AND the vendor token is saved. */
export function isNetworkConnected(m: NetworkMembership | undefined): boolean {
  return !!(m?.enabled && m.hasVendorToken);
}

/**
 * The brand's OpenPartner Network settings, on Admin → Settings: the
 * marketplace listing, whether partners are offered the Network, and (self-
 * host only) the Network address and a manual re-sync. Connecting happens
 * on Network → Get connected; this links there until the brand has.
 */
export function NetworkSettingsSection() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const tenantBase = useTenantBase();
  const { data: membership, isLoading, error } = useQuery({
    queryKey: ['network-membership'],
    queryFn: () => api<NetworkMembership>('/config/network'),
  });

  if (isLoading) return <Card>Loading…</Card>;
  const connected = isNetworkConnected(membership);

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <Globe size={18} style={{ color: theme.accentText }} />
        <div style={{ fontSize: 15, fontWeight: 500 }}>OpenPartner Network</div>
      </div>
      {error && <ErrorBanner error="Couldn't load Network settings." />}
      {membership && !connected && (
        <>
          <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6, marginBottom: 12, maxWidth: 560 }}>
            Not connected. List your brand on the OpenPartner Network so creators can find and apply to your
            programs.
          </div>
          <Button onClick={() => navigate(`${tenantBase}/admin/network`)}>Get connected</Button>
        </>
      )}
      {membership && connected && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <ListingStatus membership={membership} />
          {membership.bonusesAuthorized === false && <AuthorizeBonuses />}
          <Divider />
          <PartnerOffer
            membership={membership}
            onChange={() => qc.invalidateQueries({ queryKey: ['network-membership'] })}
          />
          {membership.tier !== 'hosted' && (
            <>
              <Divider />
              <Resync />
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function Divider() {
  return <div style={{ borderTop: `1px solid ${theme.borderSubtle}` }} />;
}

function SubHeading({ children }: { children: string }) {
  return <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 6 }}>{children}</div>;
}

function ListingStatus({ membership }: { membership: NetworkMembership }) {
  const { data: self, error, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['network-self'],
    queryFn: () => api<NetworkSelf>('/admin/network/me'),
    retry: 1,
  });
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6 }}>
      <SubHeading>Marketplace listing</SubHeading>
      {isLoading && <div style={{ color: theme.textMuted }}>Loading your listing…</div>}
      {!isLoading && self && (
        <div style={{ color: theme.textMuted }}>
          Listed as <strong style={{ color: theme.text }}>{self.displayName}</strong> · {self.partnerCount} active
          partners
          {self.status !== 'active' ? (
            <> · status: {self.status}</>
          ) : (
            self.reviewStatus !== 'pending' &&
            self.reviewStatus !== 'rejected' && <span style={{ color: theme.success }}> · live on the marketplace ✓</span>
          )}
        </div>
      )}
      {!isLoading && self?.reviewStatus === 'pending' && (
        <div style={{ color: theme.warn, marginTop: 6 }}>
          Waiting for OpenPartner review. Your published programs appear on the marketplace once your brand is
          approved, and you&rsquo;ll get an email when that happens.
        </div>
      )}
      {!isLoading && self?.reviewStatus === 'rejected' && (
        <div style={{ color: theme.danger, marginTop: 6 }}>
          Your brand isn&rsquo;t approved for the OpenPartner marketplace, so your programs aren&rsquo;t listed. Reply
          to the review email if you think this is a mistake.
        </div>
      )}
      {!isLoading && error && (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: theme.danger }}>
            Couldn&rsquo;t load your listing from the Network: {error instanceof Error ? error.message : String(error)}
          </div>
          <Button variant="secondary" onClick={() => refetch()} disabled={isRefetching} style={{ marginTop: 8 }}>
            {isRefetching ? 'Retrying…' : 'Retry'}
          </Button>
        </div>
      )}
      {membership.tier !== 'hosted' && (
        <div style={{ color: theme.textDim, fontSize: 12, marginTop: 6 }}>
          Network: <code>{membership.networkUrl}</code>
        </div>
      )}
    </div>
  );
}

/**
 * The stored `autoEnroll` flag means "offer the Network to my partners".
 * Partners decide for themselves (join-page checkbox, a one-time portal
 * prompt, a portal setting); nothing about a partner is shared until they
 * opt in. Off = they're never asked.
 */
function PartnerOffer({ membership, onChange }: { membership: NetworkMembership; onChange: () => void }) {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (autoEnroll: boolean) => api('/config/network', { method: 'POST', body: { autoEnroll } }),
    onSuccess: () => {
      onChange();
      qc.invalidateQueries({ queryKey: ['network-partner-consent'] });
    },
  });
  const { data: counts } = useQuery({
    queryKey: ['network-partner-consent'],
    queryFn: () => api<ConsentSummary>('/config/network/partner-consent'),
  });
  return (
    <div style={{ maxWidth: 640 }}>
      <SubHeading>Offer the Network to your partners</SubHeading>
      <ErrorBanner error={m.error} />
      <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6, marginBottom: 12 }}>
        Partners choose for themselves whether to join the OpenPartner Network. When this is on, they see an optional
        checkbox on your join page, a one-time question when they first sign in, and a setting they can change any
        time. Only partners who opt in have their name, email and partner profile shared with the Network. The
        Network dedups creators by email, so the same person joining you and another brand gets a single Network
        identity.
      </div>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 13, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={membership.autoEnroll}
          disabled={m.isPending}
          onChange={(e) => m.mutate(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span>
          <strong>Offer the Network to partners</strong>
          <span style={{ color: theme.textMuted, display: 'block' }}>
            Turn this off for programs whose partners are your customers (an in-app referral program, for example).
            They&rsquo;re then never asked and never shared.
          </span>
        </span>
      </label>
      {counts && (
        <div style={{ marginTop: 12, fontSize: 13, color: theme.textMuted }}>
          <strong style={{ color: theme.text }}>{counts.granted}</strong> of {counts.partners} active partners have
          opted in
          {counts.declined + counts.withdrawn > 0 && <> · {counts.declined + counts.withdrawn} said no</>}.
        </div>
      )}
    </div>
  );
}

/** Keys issued before Network bounties can't pay bonuses; one click adds
 *  the scope to the key the Network already holds. */
function AuthorizeBonuses() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: () => api<NetworkMembership>('/config/network/authorize-bonuses', { method: 'POST', body: {} }),
    onSuccess: (membership) => qc.setQueryData(['network-membership'], membership),
  });
  return (
    <div
      style={{
        border: `1px solid ${alpha(theme.info, 0.333)}`,
        borderRadius: theme.radiusMd,
        padding: '12px 14px',
        maxWidth: 640,
      }}
    >
      <SubHeading>Re-authorize to enable Network bounties</SubHeading>
      <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.5, marginBottom: 10 }}>
        Creators can earn bounties you post on the Network, such as a fee for an approved video. The Network pays them
        as bonuses through your program, so it needs permission to record a bonus. Your connection predates bounties
        and doesn&rsquo;t have it yet. Nothing else about the connection changes.
      </div>
      <ErrorBanner error={m.error} />
      <Button onClick={() => m.mutate()} disabled={m.isPending}>
        {m.isPending ? 'Authorizing…' : 'Re-authorize'}
      </Button>
    </div>
  );
}

/** Self-host only: a hosted brand's Network pushes are retried for it. */
function Resync() {
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api<BackfillResult>('/config/network/backfill', { method: 'POST', body: {} }),
    onSuccess: (r) => { setResult(r); setError(null); },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'failed'),
  });
  return (
    <div style={{ maxWidth: 640 }}>
      <SubHeading>Re-sync opted-in partners</SubHeading>
      <div style={{ fontSize: 13, color: theme.textMuted, lineHeight: 1.6, marginBottom: 12 }}>
        Sends the partners who opted in to the Network again — for example after a Network outage. Partners who
        haven&rsquo;t opted in are never sent. Creators already on the Network from another brand come back with a flag
        so you can see their cross-brand presence.
      </div>
      {error && <ErrorBanner error={error} />}
      <Button variant="secondary" onClick={() => m.mutate()} disabled={m.isPending}>
        {m.isPending ? 'Syncing…' : 'Re-sync now'}
      </Button>
      {result && (
        <div style={{ marginTop: 12, fontSize: 13, color: theme.textMuted }}>
          Pushed <strong style={{ color: theme.text }}>{result.pushed}</strong> of{' '}
          <strong style={{ color: theme.text }}>{result.total}</strong>.
          {result.queued > 0 && <> {result.queued} queued for retry.</>}
        </div>
      )}
    </div>
  );
}
