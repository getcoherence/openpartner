import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button, Card, EmptyState, ErrorBanner, Page, StatusPill, formatDate } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';

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

export function CreatorMyRequestsPage() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['creator-my-requests'],
    queryFn: () => creatorApi<{ requests: RequestRow[] }>('/creators/me/requests'),
    retry: false,
  });
  const cancel = useMutation({
    mutationFn: (id: string) => creatorApi(`/creators/me/requests/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['creator-my-requests'] }),
  });

  return (
    <Page title="My applications" subtitle="Programs you&rsquo;ve applied to across the Network.">
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : !data || data.requests.length === 0 ? (
        <EmptyState title="No applications yet" hint="Browse programs to apply." icon={<Inbox size={28} strokeWidth={1.25} />} />
      ) : (
        data.requests.map((r) => (
          <Card key={r.id} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <h3 style={{ marginTop: 0, marginBottom: 4, flex: 1 }}>
                <Link to={`/creator/offerings/${r.offeringId}`}>{r.offeringTitle}</Link>{' '}
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
                <Button variant="secondary" onClick={() => cancel.mutate(r.id)} disabled={cancel.isPending}>
                  Cancel application
                </Button>
              </div>
            )}
          </Card>
        ))
      )}
    </Page>
  );
}
