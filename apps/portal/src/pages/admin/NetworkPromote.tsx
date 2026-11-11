import { useEffect, useMemo, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Select } from '../../ui.js';
import { theme } from '../../theme.js';
import { useViewOnly } from '../../lib/viewOnly.js';
import { TenantLink } from '../../tenant-link.js';
import { useTenantBase } from '../../tenant-base.js';
import { NetworkProfileEditor, type NetworkProfile } from '../../lib/NetworkProfileEditor.js';
import { publicStorefrontUrl } from '../../lib/public-site.js';
import { networkErrorCode } from './BookCreatorDialog.js';
import { creatorApi } from '../creator/creator-api.js';
import { CreatorDiscoverPage } from '../creator/CreatorDiscover.js';
import { CreatorOfferingDetailPage } from '../creator/CreatorOfferingDetail.js';
import { CreatorVendorDetailPage } from '../creator/CreatorVendorDetail.js';
import { CreatorMyAffiliationsPage } from '../creator/CreatorMyAffiliations.js';
import { CreatorProgramDetailPage } from '../creator/CreatorProgramDetail.js';
import { CreatorShareLinksPage } from '../creator/CreatorShareLinks.js';
import { CreatorMyRequestsPage } from '../creator/CreatorMyRequests.js';
import { creatorProfileAdapter } from '../creator/CreatorMyProfile.js';

/**
 * Promote: this brand joining other brands' programs (docs/network-protocol.md).
 *
 * The Network keeps a promoter profile for the brand, and the brand works
 * it here and nowhere else: there is no creator account to register and no
 * creator portal to visit. Until an admin sets the profile up, this is the
 * one-step setup. After that it is the pages a promoter needs (programs,
 * partnerships, links and codes, applications, the profile), which are the
 * creator portal's own pages talking to this brand's API (see
 * pages/creator/creator-api.ts).
 */

export interface BrandProfile {
  creatorId: string;
  email: string;
  name: string;
  handle: string | null;
  avatarUrl: string | null;
  profileComplete: boolean;
  profileMissing: Array<{ field: string; label: string }>;
  active: boolean;
}

export interface PromoteState {
  profile: BrandProfile | null;
  /** This brand's full admins: the addresses a profile can be made with. */
  contacts: Array<{ email: string; name: string }>;
  suggestedWebsite: string | null;
}

/** Shared with the sidebar, which shows the Promote section once set up. */
export const PROMOTE_STATE_KEY = ['network-brand-profile'];
export const fetchPromoteState = (): Promise<PromoteState> => api<PromoteState>('/admin/network/brand-profile');

const ERROR_TEXT: Record<string, string> = {
  network_not_configured: 'Connect to the Network first.',
  email_taken: 'That address already has a creator account. Pick another admin.',
  email_not_admin: 'Pick the address of one of your admins.',
  email_fixed: 'Your profile already exists with another address.',
  country_not_supported: "The Network isn't available where your brand is based.",
  vendor_pending_review: 'Available once your brand is approved.',
  admin_session_required: 'Sign in as an admin to do this.',
};

function errorText(err: unknown): string {
  const code = networkErrorCode(err);
  if (code && ERROR_TEXT[code]) return ERROR_TEXT[code]!;
  if (err instanceof ApiError && err.message.includes('network_not_configured')) return ERROR_TEXT.network_not_configured!;
  if (err instanceof ApiError) {
    const d = err.detail as { detail?: unknown } | null;
    if (code === 'tracking_not_verified' && typeof d?.detail === 'string') return d.detail;
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export function AdminNetworkPromote() {
  const { data, isLoading, error } = useQuery({ queryKey: PROMOTE_STATE_KEY, queryFn: fetchPromoteState, retry: false });
  if (error) {
    return (
      <Page title="Promote" subtitle="Join other brands' programs as your brand and earn commission.">
        <ErrorBanner error={errorText(error)} />
        {error instanceof ApiError && error.message.includes('network_not_configured') && (
          <Card>
            <TenantLink to="/admin/network" style={{ fontSize: 13, color: theme.accentText }}>Get connected</TenantLink>
          </Card>
        )}
      </Page>
    );
  }
  if (isLoading || !data) {
    return (
      <Page title="Promote">
        <Card>Loading…</Card>
      </Page>
    );
  }
  if (!data.profile) {
    return (
      <Page edits title="Promote" subtitle="Join other brands' programs as your brand and earn commission.">
        <SetupCard state={data} />
      </Page>
    );
  }
  if (!data.profile.active) {
    return (
      <Page title="Promote">
        <Card>
          <span style={{ color: theme.textMuted, fontSize: 13 }}>On hold. Contact support.</span>
        </Card>
      </Page>
    );
  }
  return <PromoteArea />;
}

function SetupCard({ state }: { state: PromoteState }) {
  const qc = useQueryClient();
  const viewOnly = useViewOnly();
  const [email, setEmail] = useState(state.contacts[0]?.email ?? '');
  const [website, setWebsite] = useState(state.suggestedWebsite ?? '');
  useEffect(() => {
    setEmail((current) => current || (state.contacts[0]?.email ?? ''));
  }, [state.contacts]);

  const create = useMutation({
    mutationFn: () =>
      api<{ profile: BrandProfile }>('/admin/network/brand-profile', {
        method: 'PUT',
        body: { email, ...(website.trim() ? { websiteUrl: website.trim() } : {}) },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: PROMOTE_STATE_KEY }),
  });

  if (viewOnly || state.contacts.length === 0) {
    return (
      <Card>
        <span style={{ color: theme.textMuted, fontSize: 13 }}>Not set up yet.</span>
      </Card>
    );
  }
  return (
    <Card>
      {create.error && <ErrorBanner error={errorText(create.error)} />}
      <div style={{ display: 'grid', gap: 14, maxWidth: 420 }}>
        <div>
          <Label htmlFor="promote-email">Contact email</Label>
          <Select id="promote-email" value={email} onChange={(e) => setEmail(e.target.value)}>
            {state.contacts.map((c) => (
              <option key={c.email} value={c.email}>
                {c.email}
              </option>
            ))}
          </Select>
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 6 }}>
            Brands you promote write to this address. It can&rsquo;t be changed later.
          </div>
        </div>
        <div>
          <Label htmlFor="promote-website">Website</Label>
          <Input
            id="promote-website"
            type="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://"
          />
        </div>
        <div>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !email}>
            {create.isPending ? 'Setting up…' : 'Start promoting'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * The promoter's pages. They keep their own query cache, one per brand:
 * they use the creator portal's cache keys, and what this browser tab read
 * as a signed-in creator, or as another brand, must never show up here.
 */
function PromoteArea() {
  const base = useTenantBase();
  const client = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } } }),
    // One cache per brand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base],
  );
  const home = `${base}/admin/network/promote/discover`;
  return (
    <QueryClientProvider client={client}>
      {/* Absolute redirects: this sits on a splat route, where a relative
          one resolves against the whole URL and loops. */}
      <Routes>
        <Route index element={<Navigate to={home} replace />} />
        <Route path="discover" element={<CreatorDiscoverPage />} />
        <Route path="offerings/:id" element={<CreatorOfferingDetailPage />} />
        <Route path="vendors/:id" element={<CreatorVendorDetailPage />} />
        <Route path="affiliations" element={<CreatorMyAffiliationsPage />} />
        <Route path="programs/:partnershipId/*" element={<CreatorProgramDetailPage />} />
        <Route path="links" element={<CreatorShareLinksPage />} />
        <Route path="requests" element={<CreatorMyRequestsPage />} />
        <Route path="profile" element={<PromoteProfilePage />} />
        <Route path="*" element={<Navigate to={home} replace />} />
      </Routes>
    </QueryClientProvider>
  );
}

/** The profile other brands see: the creator portal's editor, for a brand. */
function PromoteProfilePage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['creator-my-profile'],
    queryFn: () => creatorApi<NetworkProfile>('/creators/me'),
    retry: false,
  });
  return (
    <Page edits title="Promoter profile" subtitle="How other brands see yours.">
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : (
        data && (
          <NetworkProfileEditor
            adapter={creatorProfileAdapter}
            data={data}
            publicProfileHref={data.handle ? publicStorefrontUrl(data.handle) : null}
          />
        )
      )}
    </Page>
  );
}
