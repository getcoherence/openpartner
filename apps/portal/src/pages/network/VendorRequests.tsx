import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { api } from '../../api.js';
import { theme } from '../../theme.js';
import { Button, Card, EmptyState, ErrorBanner, Page, StatusPill, Table, formatDate, shortId } from '../../ui.js';

interface Request {
  id: string;
  offeringId: string;
  vendorId: string;
  creatorId: string;
  direction: 'creator_to_vendor' | 'vendor_to_creator';
  message: string | null;
  promoCode: string | null;
  status: string;
  createdAt: string;
  decidedAt: string | null;
}

export function VendorRequestsPage() {
  const qc = useQueryClient();
  const { data, error, isLoading } = useQuery({
    queryKey: ['network-requests-mine'],
    queryFn: () => api<{ requests: Request[] }>('/network/requests/mine'),
  });

  const approve = useMutation({
    mutationFn: (id: string) => api(`/network/requests/${id}/approve`, { method: 'POST', body: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['network-requests-mine'] });
      qc.invalidateQueries({ queryKey: ['network-partnerships-mine'] });
    },
  });
  const reject = useMutation({
    mutationFn: (id: string) => api(`/network/requests/${id}/reject`, { method: 'POST', body: {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network-requests-mine'] }),
  });

  const pending = (data?.requests ?? []).filter((r) => r.status === 'pending');
  const history = (data?.requests ?? []).filter((r) => r.status !== 'pending');

  return (
    <Page title="Incoming requests" subtitle={`${pending.length} pending`}>
      <ErrorBanner error={error ?? approve.error ?? reject.error} />

      {isLoading ? (
        <Card>Loading…</Card>
      ) : pending.length === 0 && history.length === 0 ? (
        <EmptyState title="No requests yet" hint="Creators who apply to your offerings show up here." icon={<Inbox size={28} strokeWidth={1.25} />} />
      ) : (
        <>
          {pending.length > 0 && (
            <>
              <div style={{ marginBottom: 10, fontSize: 13, color: theme.textMuted }}>Pending</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 }}>
                {pending.map((r) => (
                  <Card key={r.id}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                      <div>
                        <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 4 }}>
                          From creator <code>{shortId(r.creatorId)}</code>
                          <span style={{ marginLeft: 8 }}>• offering <code>{shortId(r.offeringId)}</code></span>
                        </div>
                        <div style={{ fontSize: 12, color: theme.textDim }}>
                          Received {formatDate(r.createdAt, { relative: true })}
                        </div>
                      </div>
                      <StatusPill status={r.status} />
                    </div>
                    {r.promoCode && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '10px 12px',
                          borderRadius: theme.radiusSm,
                          background: theme.accentSoft,
                          border: `1px solid ${theme.accent}33`,
                          marginBottom: 12,
                        }}
                      >
                        <span style={{ fontSize: 11, color: theme.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                          Requested share code
                        </span>
                        <code style={{ fontSize: 14, color: theme.accent, fontWeight: 600 }}>
                          /r/{r.promoCode}
                        </code>
                      </div>
                    )}
                    {r.message && (
                      <div
                        style={{
                          background: theme.bg,
                          border: `1px solid ${theme.borderSubtle}`,
                          padding: 12,
                          borderRadius: theme.radiusSm,
                          fontSize: 13,
                          color: theme.text,
                          marginBottom: 12,
                          lineHeight: 1.5,
                        }}
                      >
                        {r.message}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button size="sm" onClick={() => approve.mutate(r.id)} disabled={approve.isPending}>
                        Approve
                      </Button>
                      <Button size="sm" variant="danger" onClick={() => reject.mutate(r.id)} disabled={reject.isPending}>
                        Reject
                      </Button>
                    </div>
                  </Card>
                ))}
              </div>
            </>
          )}

          {history.length > 0 && (
            <>
              <div style={{ marginBottom: 10, fontSize: 13, color: theme.textMuted }}>History</div>
              <Table
                columns={['ID', 'Creator', 'Offering', 'Status', 'Decided']}
                rows={history.map((r) => [
                  <code style={{ color: theme.textDim, fontSize: 12 }}>{shortId(r.id)}</code>,
                  <code style={{ color: theme.textDim, fontSize: 12 }}>{shortId(r.creatorId)}</code>,
                  <code style={{ color: theme.textDim, fontSize: 12 }}>{shortId(r.offeringId)}</code>,
                  <StatusPill status={r.status} />,
                  <span style={{ color: theme.textMuted }}>{formatDate(r.decidedAt, { relative: true })}</span>,
                ])}
              />
            </>
          )}
        </>
      )}
    </Page>
  );
}
