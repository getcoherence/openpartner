import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Table, formatDate } from '../ui.js';

interface Partner {
  id: string;
  email: string;
  name: string;
  stripeConnectAccountId: string | null;
  createdAt: string;
}

interface ApiKey {
  id: string;
  prefix: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export function AdminPartners() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [issueKeyFor, setIssueKeyFor] = useState<Partner | null>(null);

  const partners = useQuery({ queryKey: ['partners'], queryFn: () => api<{ partners: Partner[] }>('/partners') });

  return (
    <Page title="Partners" actions={<Button onClick={() => setShowCreate(true)}>New partner</Button>}>
      <ErrorBanner error={partners.error} />
      {showCreate && (
        <CreatePartner
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['partners'] });
          }}
        />
      )}
      {issueKeyFor && <IssueKey partner={issueKeyFor} onClose={() => setIssueKeyFor(null)} />}
      {partners.isLoading ? (
        <Card>Loading…</Card>
      ) : (
        <Table
          columns={['Name', 'Email', 'Stripe', 'Created', 'Actions']}
          rows={(partners.data?.partners ?? []).map((p) => [
            <strong>{p.name}</strong>,
            <span style={{ color: '#666' }}>{p.email}</span>,
            p.stripeConnectAccountId ? <span style={{ color: '#065f46' }}>connected</span> : <span style={{ color: '#888' }}>—</span>,
            formatDate(p.createdAt),
            <div style={{ display: 'flex', gap: 6 }}>
              <Link to={`/links?partnerId=${p.id}`} style={{ fontSize: 12, color: '#2563eb' }}>Links</Link>
              <span style={{ color: '#ddd' }}>·</span>
              <Link to={`/payouts?partnerId=${p.id}`} style={{ fontSize: 12, color: '#2563eb' }}>Payouts</Link>
              <span style={{ color: '#ddd' }}>·</span>
              <button
                onClick={() => setIssueKeyFor(p)}
                style={{ background: 'none', border: 'none', padding: 0, fontSize: 12, color: '#2563eb', cursor: 'pointer' }}
              >
                Issue key
              </button>
            </div>,
          ])}
        />
      )}
    </Page>
  );
}

function CreatePartner({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const mut = useMutation({
    mutationFn: () => api<Partner>('/partners', { method: 'POST', body: { name, email } }),
    onSuccess: onCreated,
  });

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>New partner</div>
      <ErrorBanner error={mut.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Email</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Button onClick={() => mut.mutate()} disabled={!name || !email || mut.isPending}>
          {mut.isPending ? 'Creating…' : 'Create'}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

function IssueKey({ partner, onClose }: { partner: Partner; onClose: () => void }) {
  const [label, setLabel] = useState('');
  const mut = useMutation({
    mutationFn: () =>
      api<{ id: string; plaintext: string }>(`/partners/${partner.id}/api-keys`, {
        method: 'POST',
        body: { label },
      }),
  });

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>Issue API key for {partner.name}</div>
      <ErrorBanner error={mut.error} />
      {mut.data ? (
        <>
          <div style={{ marginBottom: 8, color: '#666', fontSize: 13 }}>
            Copy this key now — it won't be shown again.
          </div>
          <pre style={{ background: '#fef3c7', padding: 12, borderRadius: 4, fontSize: 13, wordBreak: 'break-all' }}>
            {mut.data.plaintext}
          </pre>
          <Button onClick={onClose} style={{ marginTop: 12 }}>Done</Button>
        </>
      ) : (
        <>
          <Label>Label (optional)</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. laptop" />
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
              {mut.isPending ? 'Issuing…' : 'Issue key'}
            </Button>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
