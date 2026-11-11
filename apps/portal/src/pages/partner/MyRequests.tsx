import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { api } from '../../api.js';
import { TenantLink } from '../../tenant-link.js';
import { Button, Card, EmptyState, ErrorBanner, Page, StatusPill, formatDate } from '../../ui.js';
import { theme } from '../../theme.js';
import { ConfirmAction } from '../../lib/ConfirmAction.js';
import { useBrand } from '../../lib/useBrand.js';
import { NetworkPortalLink } from '../../lib/network-portal.js';
import { OwnNetworkAccountNotice } from './OwnNetworkAccount.js';

interface RequestRow {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  message: string | null;
  preferredSlug: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  offeringId: string;
  offeringTitle: string;
  vendorId: string;
  vendorName: string;
}

// Only applications to this brand: the Network hides the partner's
// applications to other brands from it (openpartner-network#28). Those are
// tracked in the partner's own Network portal.
export function MyRequestsPage() {
  const { programName } = useBrand();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['network-my-requests'],
    queryFn: () => api<{ requests: RequestRow[]; ownNetworkAccount?: boolean }>(`/network/me/requests`),
    retry: false,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api(`/network/me/requests/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network-my-requests'] }),
  });

  // Their own Network account holds their applications; the brand can't
  // list them for a partner it may not act for.
  if (data?.ownNetworkAccount) {
    return (
      <Page title="My applications" subtitle={`Your applications to ${programName} on the OpenPartner Network.`}>
        <OwnNetworkAccountNotice page="requests">Your applications are in your own Network account.</OwnNetworkAccountNotice>
      </Page>
    );
  }

  return (
    <Page title="My applications" subtitle={`Your applications to ${programName} on the OpenPartner Network.`}>
      <p style={{ color: theme.textMuted, fontSize: 14, marginTop: 0 }}>
        Only applications to {programName} show here. Applications to other brands, including ones you send from
        Discover, are tracked in your Network portal.{' '}
        <NetworkPortalLink page="requests">Open your Network portal ↗</NetworkPortalLink>
      </p>
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : !data || data.requests.length === 0 ? (
        <EmptyState
          title="No applications yet"
          hint={`Your applications to ${programName} show here.`}
          icon={<Inbox size={28} strokeWidth={1.25} />}
        />
      ) : (
        data.requests.map((r) => (
          <Card key={r.id}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <h3 style={{ marginTop: 0, marginBottom: 4, flex: 1 }}>
                <TenantLink to={`/network/offerings/${r.offeringId}`}>{r.offeringTitle}</TenantLink>{' '}
                <span style={{ color: theme.textMuted, fontWeight: 'normal', fontSize: 14 }}>· {r.vendorName}</span>
              </h3>
              <StatusPill status={r.status} />
            </div>
            <p style={{ color: theme.textMuted, fontSize: 13 }}>
              Applied {formatDate(r.createdAt, { relative: true })}
              {r.decidedAt && <> · decided {formatDate(r.decidedAt, { relative: true })}</>}
            </p>
            {r.decisionNote && (
              <p style={{ color: theme.text, fontSize: 14, marginTop: 8 }}>
                <strong>Vendor note:</strong> {r.decisionNote}
              </p>
            )}
            {r.status === 'pending' && (
              <div style={{ marginTop: 12 }}>
                <ConfirmAction
                  prompt={`Cancel your application to ${r.vendorName}?`}
                  confirmLabel="Yes, cancel it"
                  cancelLabel="Keep it"
                  onConfirm={() => cancel.mutate(r.id)}
                  error={cancel.variables === r.id && cancel.error}
                >
                  {(ask) => (
                    <Button variant="secondary" onClick={ask} disabled={cancel.isPending}>
                      Cancel application
                    </Button>
                  )}
                </ConfirmAction>
              </div>
            )}
          </Card>
        ))
      )}
    </Page>
  );
}
