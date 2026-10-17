import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, X } from 'lucide-react';
import { api } from '../../api.js';
import { alpha, theme } from '../../theme.js';
import { Button, Card, ErrorBanner, formatDate } from '../../ui.js';
import { useBrand } from '../../lib/useBrand.js';

/**
 * The partner's own choice about joining the OpenPartner Network
 * (GET/POST /network/me/consent). Nothing about a partner reaches the
 * Network until they opt in — on the join page, the one-time prompt here,
 * or the setting on their Network profile page. The brand can only offer
 * it (`offered`); it can't decide for them.
 */
export interface NetworkConsentState {
  offered: boolean;
  status: 'granted' | 'withdrawn' | 'declined' | null;
  source: 'join_page' | 'portal_prompt' | 'portal_setting' | 'network_offering' | 'grandfathered' | null;
  consentedAt: string | null;
  withdrawnAt: string | null;
  declinedAt: string | null;
}

export const NETWORK_CONSENT_KEY = ['network-consent'];

export function useNetworkConsent(enabled = true) {
  return useQuery({
    queryKey: NETWORK_CONSENT_KEY,
    queryFn: () => api<NetworkConsentState>('/network/me/consent'),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * For partners: whether the Network section of the portal applies at all.
 * It does when the brand offers the Network, or the partner is opted in
 * (they can always reach the setting to opt out). White-label and a
 * self-host that hides the Network keep it off, as before.
 */
export function usePartnerNetworkAccess(isPartner: boolean): { show: boolean; loading: boolean; consent: NetworkConsentState | undefined } {
  const { whiteLabel, partnerNetworkVisible } = useBrand();
  const eligible = isPartner && !whiteLabel && partnerNetworkVisible;
  const q = useNetworkConsent(eligible);
  if (!eligible) return { show: false, loading: false, consent: undefined };
  // A failed check falls back to showing the section, as before this
  // existed; the pages themselves still gate on consent server-side.
  const show = q.isError ? true : !!q.data && (q.data.offered || q.data.status === 'granted');
  return { show, loading: q.isLoading, consent: q.data };
}

type Decision = { decision: 'grant' | 'decline' | 'withdraw'; via: 'prompt' | 'setting' };

function useConsentMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Decision) => api<NetworkConsentState>('/network/me/consent', { method: 'POST', body }),
    onSuccess: (state) => {
      qc.setQueryData(NETWORK_CONSENT_KEY, state);
      // Every Network page answers differently once consent changes.
      for (const key of ['network-my-profile', 'network-my-platforms', 'network-my-affiliations', 'network-my-requests']) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

/** Plain-language: what the Network is, exactly what's shared, optional. */
export function NetworkSharingExplainer({ programName }: { programName: string }) {
  return (
    <>
      The OpenPartner Network is a directory where other brands look for creators to invite to their
      partner programs. If you join, {programName} shares your <strong>name</strong>, <strong>email address</strong>{' '}
      and <strong>partner profile</strong> (the website, social profiles and audience size you gave when you
      applied) with the Network. Joining is optional: your {programName} partnership works the same either way,
      and you can leave whenever you like.
    </>
  );
}

/**
 * The one-time first-login prompt. Shown until the partner answers; the
 * X only hides it for this visit. Never shown once they've decided, and
 * never when the brand doesn't offer the Network.
 */
export function NetworkConsentPrompt({ isMobile }: { isMobile: boolean }) {
  const { programName } = useBrand();
  const decide = useConsentMutation();
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: isMobile ? '16px 16px 0' : '24px 40px 0' }}>
      <div
        role="region"
        aria-label="Join the OpenPartner Network"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          background: theme.accentSoft,
          border: `1px solid ${alpha(theme.accent, 0.333)}`,
          borderRadius: theme.radiusMd,
          padding: '14px 16px',
        }}
      >
        <Globe size={18} style={{ color: theme.accentText, flexShrink: 0, marginTop: 2 }} />
        <div style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.55, color: theme.text }}>
          <strong>Join the OpenPartner Network?</strong>
          <p style={{ margin: '4px 0 10px' }}>
            <NetworkSharingExplainer programName={programName} />
          </p>
          {decide.error ? <ErrorBanner error={decide.error} /> : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button onClick={() => decide.mutate({ decision: 'grant', via: 'prompt' })} disabled={decide.isPending}>
              Join the Network
            </Button>
            <Button variant="secondary" onClick={() => decide.mutate({ decision: 'decline', via: 'prompt' })} disabled={decide.isPending}>
              No thanks
            </Button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: theme.textMuted }}>
            You can change this later on your Network profile page.
          </div>
        </div>
        <button
          onClick={() => setHidden(true)}
          aria-label="Decide later"
          title="Decide later"
          style={{ background: 'transparent', border: 'none', color: theme.textMuted, cursor: 'pointer', padding: 2, display: 'inline-flex', flexShrink: 0 }}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

const SOURCE_LABEL: Record<NonNullable<NetworkConsentState['source']>, string> = {
  join_page: 'when you applied',
  portal_prompt: 'in your partner portal',
  portal_setting: 'in your partner portal',
  network_offering: 'by joining this program through the Network',
  grandfathered: 'automatically, before partners were asked',
};

/** The persistent setting, at the top of the Network profile page. */
export function NetworkMembershipCard({ consent }: { consent: NetworkConsentState }) {
  const { programName } = useBrand();
  const decide = useConsentMutation();
  const [confirmLeave, setConfirmLeave] = useState(false);
  const on = consent.status === 'granted';

  return (
    <Card>
      <h3 style={{ marginTop: 0, fontSize: 15, fontWeight: 500 }}>OpenPartner Network</h3>
      {on ? (
        <>
          <p style={{ fontSize: 13, color: theme.text, margin: '0 0 6px' }}>
            <strong>You&rsquo;re on the Network.</strong> {programName} shares your name, email address and partner
            profile with it, so other brands can find you and you can apply to their programs from here.
          </p>
          {consent.source && consent.consentedAt && (
            <p style={{ fontSize: 12, color: theme.textMuted, margin: '0 0 10px' }}>
              You joined {SOURCE_LABEL[consent.source]} on {formatDate(consent.consentedAt)}.
              {consent.source === 'grandfathered' && ' You can leave below if you didn’t mean to be listed.'}
            </p>
          )}
          {decide.error ? <ErrorBanner error={decide.error} /> : null}
          {!confirmLeave ? (
            <Button variant="secondary" onClick={() => setConfirmLeave(true)}>
              Leave the Network
            </Button>
          ) : (
            <div style={{ fontSize: 13, color: theme.text }}>
              <p style={{ margin: '0 0 8px' }}>
                {programName} will stop sharing your details with the Network and ask it to remove what was shared.
                Your {programName} partnership, links and earnings aren&rsquo;t affected.
                {consent.source === 'network_offering' &&
                  ' You joined through the Network, so your Network account itself stays — manage it on the OpenPartner Network.'}
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button onClick={() => decide.mutate({ decision: 'withdraw', via: 'setting' })} disabled={decide.isPending}>
                  {decide.isPending ? 'Leaving…' : 'Leave the Network'}
                </Button>
                <Button variant="secondary" onClick={() => setConfirmLeave(false)} disabled={decide.isPending}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </>
      ) : consent.offered ? (
        <>
          <p style={{ fontSize: 13, color: theme.text, margin: '0 0 10px', lineHeight: 1.55 }}>
            <strong>You&rsquo;re not on the Network.</strong> <NetworkSharingExplainer programName={programName} />
          </p>
          {consent.status === 'withdrawn' && consent.withdrawnAt && (
            <p style={{ fontSize: 12, color: theme.textMuted, margin: '0 0 10px' }}>
              You left on {formatDate(consent.withdrawnAt)}.
            </p>
          )}
          {decide.error ? <ErrorBanner error={decide.error} /> : null}
          <Button onClick={() => decide.mutate({ decision: 'grant', via: 'setting' })} disabled={decide.isPending}>
            {decide.isPending ? 'Joining…' : 'Join the Network'}
          </Button>
        </>
      ) : (
        <p style={{ fontSize: 13, color: theme.textMuted, margin: 0 }}>
          {programName} doesn&rsquo;t offer the OpenPartner Network to its partners, so nothing about you is shared with it.
        </p>
      )}
    </Card>
  );
}
