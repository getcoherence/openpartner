import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { api, ApiError, type Principal } from '../../api.js';
import { TenantLink } from '../../tenant-link.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Textarea } from '../../ui.js';
import { countryErrorMessage } from '../../lib/CountryField.js';
import { theme } from '../../theme.js';
import { NetworkPortalLink } from '../../lib/network-portal.js';
import {
  ProfileIncompleteNotice,
  ProfileReviewNotice,
  missingFromProfile,
  notApprovedFrom,
  profileIncompleteFrom,
  type ProfileCompleteness,
} from '../../lib/profile-incomplete.js';

interface Offering {
  id: string;
  title: string;
  description: string | null;
  productUrl: string;
  vendorId: string;
  vendorName: string;
  terms: {
    commissionDescription?: string;
    cookieWindowDays?: number;
    payoutCadence?: string;
    bonuses?: string[];
  };
  createdAt: string;
}

/**
 * Whether `err` is the Network's 409 request_already_exists. The partner
 * proxy wraps the Network body as JSON text in `detail` (see
 * profile-incomplete.tsx), so match the code inside it.
 */
function alreadyAppliedFrom(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const wrapped = (err.detail as { detail?: unknown } | null | undefined)?.detail;
  return typeof wrapped === 'string' && wrapped.includes('"request_already_exists"');
}

export function OfferingDetailPage({ principal }: { principal: Principal }) {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const [preferredSlug, setPreferredSlug] = useState('');

  const { data: offering, isLoading, error } = useQuery({
    queryKey: ['network-offering', id],
    queryFn: () => api<Offering>(`/network/offerings/${id}`),
    enabled: !!id,
    retry: false,
  });

  const apply = useMutation({
    mutationFn: () =>
      api(`/network/offerings/${id}/apply`, {
        method: 'POST',
        body: { message: message || undefined, preferredSlug: preferredSlug || undefined },
      }),
    // No redirect to My applications: it only lists applications to this
    // brand (openpartner-network#28), and most offerings here are other
    // brands'. The card below confirms instead.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network-my-requests'] }),
  });

  const canApply = principal.role === 'partner';

  // The partner's Network profile (GET /creators/me via the brand proxy;
  // same cache entry as the Network profile page). An incomplete one can't
  // apply, so say so before they write a pitch.
  const { data: myProfile } = useQuery({
    queryKey: ['network-my-profile'],
    queryFn: () => api<ProfileCompleteness & { notFederated?: boolean; consentRequired?: boolean }>(`/network/me/profile`),
    enabled: canApply,
    retry: false,
  });
  // Applying acts as the partner on the Network, which they have to have
  // opted in to (the API answers 403 network_consent_required otherwise).
  const needsConsent =
    !!myProfile?.consentRequired || (apply.error instanceof ApiError && apply.error.message === 'network_consent_required');
  const profileMissing = myProfile?.notFederated ? null : missingFromProfile(myProfile);
  const refusedMissing = profileIncompleteFrom(apply.error);
  const missing = refusedMissing ?? profileMissing;
  const alreadyApplied = alreadyAppliedFrom(apply.error);
  // The brand's proxy doesn't carry the partner's Network review state, so
  // only the Network's refusal says it.
  const notApproved = notApprovedFrom(apply.error);

  return (
    <Page title={offering?.title ?? 'Program'} subtitle={offering?.vendorName}>
      <ErrorBanner error={error} />
      {isLoading && <Card>Loading…</Card>}
      {offering && (
        <>
          <Card>
            {offering.terms.commissionDescription && (
              <p style={{ color: theme.textMuted, fontSize: 14 }}>
                {offering.terms.commissionDescription}
              </p>
            )}
            {offering.description && <p style={{ marginTop: 8 }}>{offering.description}</p>}
            <p style={{ marginTop: 12 }}>
              <a href={offering.productUrl} target="_blank" rel="noopener noreferrer">
                View product →
              </a>
            </p>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12, color: theme.textMuted, fontSize: 13 }}>
              {offering.terms.cookieWindowDays != null && (
                <span>Cookie window: {offering.terms.cookieWindowDays} days</span>
              )}
              {offering.terms.payoutCadence && <span>Payouts: {offering.terms.payoutCadence}</span>}
            </div>
          </Card>

          <div style={{ height: 18 }} />

          <Card>
            {apply.isSuccess ? (
              <>
                <h3 style={{ marginTop: 0 }}>Application sent to {offering.vendorName}</h3>
                <p style={{ color: theme.textMuted, fontSize: 14, marginBottom: 0 }}>
                  {offering.vendorName} will review it. Track it in your Network portal, where all your applications
                  show.{' '}
                  <NetworkPortalLink page="requests">Open your Network portal ↗</NetworkPortalLink>
                </p>
              </>
            ) : (
              <>
                <h3 style={{ marginTop: 0 }}>Apply to promote</h3>
                {!canApply ? (
                  <p style={{ color: theme.textMuted }}>
                    Only partner accounts can apply. <TenantLink to="/login">Switch accounts</TenantLink>?
                  </p>
                ) : needsConsent ? (
                  <p style={{ color: theme.textMuted, fontSize: 14 }}>
                    To apply to programs from other brands, join the OpenPartner Network first.{' '}
                    <TenantLink to="/network/profile" style={{ color: theme.accentText, fontWeight: 500 }}>
                      See what&rsquo;s shared and join →
                    </TenantLink>
                  </p>
                ) : (
                  <>
                    {missing && (
                      <ProfileIncompleteNotice
                        missing={missing}
                        link={<TenantLink to="/network/profile" style={{ color: theme.accentText, fontWeight: 500 }}>Go to your profile →</TenantLink>}
                      />
                    )}
                    {notApproved && <ProfileReviewNotice />}
                    {!refusedMissing && !alreadyApplied && !notApproved && (
                      <ErrorBanner error={apply.error ? (countryErrorMessage(apply.error.message) ?? apply.error) : null} />
                    )}
                    {alreadyApplied && (
                      <p style={{ color: theme.textMuted, fontSize: 14 }}>
                        You&rsquo;ve already applied to this program, or you&rsquo;re already partnered on it. Track it in
                        your Network portal.{' '}
                        <NetworkPortalLink page="requests">Open your Network portal ↗</NetworkPortalLink>
                      </p>
                    )}
                    <div style={{ marginTop: 8 }}>
                      <Label>Preferred share-link slug (optional)</Label>
                      <Input
                        placeholder="your-handle"
                        value={preferredSlug}
                        onChange={(e) => setPreferredSlug(e.target.value)}
                      />
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <Label>Message to the vendor (optional)</Label>
                      <Textarea
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        rows={4}
                        placeholder="Why you'd be a great partner…"
                      />
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <Button onClick={() => apply.mutate()} disabled={apply.isPending || !!profileMissing}>
                        {apply.isPending ? 'Applying…' : 'Submit application'}
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </Card>
        </>
      )}
    </Page>
  );
}
