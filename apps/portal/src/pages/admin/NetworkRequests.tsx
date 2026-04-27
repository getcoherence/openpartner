import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api.js';
import { Button, Card, ErrorBanner, Label, Page } from '../../ui.js';

interface PartnershipRequest {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  message: string | null;
  preferredSlug: string | null;
  createdAt: string;
  creatorId: string;
  creatorEmail: string;
  creatorName: string;
  creatorHandle: string | null;
  creatorBio: string | null;
  offeringId: string;
  offeringTitle: string;
}

export function AdminNetworkRequests() {
  const [statusFilter, setStatusFilter] = useState<'pending' | 'approved' | 'rejected' | 'cancelled'>('pending');
  return (
    <Page
      title="Network requests"
      subtitle="Creators applying to promote your offerings. Approve to provision a Partner + Link automatically."
      actions={
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
          style={{ padding: '6px 10px', border: '1px solid #d0d0c8', borderRadius: 6, fontSize: 13 }}
        >
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="cancelled">Cancelled</option>
        </select>
      }
    >
      <RequestList statusFilter={statusFilter} />
    </Page>
  );
}

function RequestList({ statusFilter }: { statusFilter: string }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['network-requests', statusFilter],
    queryFn: () => api<{ requests: PartnershipRequest[] }>(`/admin/network/requests?status=${statusFilter}`),
    retry: false,
  });
  const [actionError, setActionError] = useState<string | null>(null);

  const approve = useMutation({
    mutationFn: ({ id, decisionNote }: { id: string; decisionNote?: string }) =>
      api(`/admin/network/requests/${id}/approve`, { method: 'POST', body: { decisionNote } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network-requests'] }),
    onError: (err) => setActionError(err instanceof ApiError ? err.message : 'failed'),
  });
  const reject = useMutation({
    mutationFn: ({ id, decisionNote }: { id: string; decisionNote?: string }) =>
      api(`/admin/network/requests/${id}/reject`, { method: 'POST', body: { decisionNote } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['network-requests'] }),
    onError: (err) => setActionError(err instanceof ApiError ? err.message : 'failed'),
  });

  if (error) {
    const msg = error instanceof ApiError && error.message.includes('network_not_configured')
      ? 'Connect to the Network first under Settings → Network.'
      : `Couldn't load requests: ${error instanceof Error ? error.message : String(error)}`;
    return <ErrorBanner error={msg} />;
  }
  if (isLoading) return <Card><p>Loading…</p></Card>;
  const requests = data?.requests ?? [];
  if (requests.length === 0) {
    return <Card><p style={{ color: '#6b7280' }}>No {statusFilter} requests.</p></Card>;
  }
  return (
    <>
      {actionError && <ErrorBanner error={actionError} />}
      {requests.map((r) => (
        <RequestRow
          key={r.id}
          request={r}
          onApprove={(note) => approve.mutate({ id: r.id, decisionNote: note })}
          onReject={(note) => reject.mutate({ id: r.id, decisionNote: note })}
          busy={approve.isPending || reject.isPending}
        />
      ))}
    </>
  );
}

function RequestRow({
  request,
  onApprove,
  onReject,
  busy,
}: {
  request: PartnershipRequest;
  onApprove: (note?: string) => void;
  onReject: (note?: string) => void;
  busy: boolean;
}) {
  const [note, setNote] = useState('');
  const isPending = request.status === 'pending';
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h3 style={{ marginTop: 0, marginBottom: 4, flex: 1 }}>
          {request.creatorName} {request.creatorHandle && <span style={{ color: '#6b7280', fontWeight: 400 }}>@{request.creatorHandle}</span>}
        </h3>
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          {new Date(request.createdAt).toLocaleDateString()}
        </span>
      </div>
      <p style={{ color: '#6b7280', fontSize: 13, margin: '0 0 8px' }}>
        {request.creatorEmail} · applying to <strong>{request.offeringTitle}</strong>
        {request.preferredSlug && <> · prefers slug <code>/{request.preferredSlug}</code></>}
      </p>
      {request.creatorBio && <p style={{ fontSize: 14 }}>{request.creatorBio}</p>}
      {request.message && (
        <blockquote style={{ borderLeft: '3px solid #d0d0c8', paddingLeft: 12, color: '#444', fontSize: 14 }}>
          {request.message}
        </blockquote>
      )}
      {isPending && (
        <div style={{ marginTop: 12 }}>
          <Label>Decision note (optional)</Label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Welcome to the program!"
            style={{ width: '100%', padding: '8px 10px', border: '1px solid #d0d0c8', borderRadius: 6, fontSize: 14, marginBottom: 12 }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => onApprove(note || undefined)} disabled={busy}>
              {busy ? 'Working…' : 'Approve + provision'}
            </Button>
            <Button onClick={() => onReject(note || undefined)} disabled={busy} variant="danger">
              Reject
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
