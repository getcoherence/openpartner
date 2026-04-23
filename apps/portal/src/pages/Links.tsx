import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Principal } from '../api.js';
import { Button, Card, ErrorBanner, Input, Label, Page, Table, formatDate } from '../ui.js';

interface Link {
  id: string;
  linkKey: string;
  destinationUrl: string;
  campaignId: string;
  partnerId: string;
  createdAt: string;
}

interface Campaign {
  id: string;
  name: string;
}

export function LinksPage({ principal }: { principal: Principal }) {
  const queryPartnerId = new URLSearchParams(window.location.search).get('partnerId');
  const partnerId = principal.partnerId ?? queryPartnerId;

  if (principal.role === 'admin' && !partnerId) {
    return <AdminLinksHub />;
  }
  return <PartnerLinks partnerId={partnerId!} isAdmin={principal.role === 'admin'} />;
}

function AdminLinksHub() {
  const { data, error, isLoading } = useQuery({
    queryKey: ['partners'],
    queryFn: () => api<{ partners: Array<{ id: string; name: string }> }>('/partners'),
  });

  return (
    <Page title="Links">
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : (
        <Card>
          <div style={{ marginBottom: 12, color: '#666', fontSize: 13 }}>Pick a partner to manage their links.</div>
          <Table
            columns={['Partner', 'Open']}
            rows={(data?.partners ?? []).map((p) => [
              p.name,
              <a href={`/links?partnerId=${p.id}`} style={{ color: '#2563eb' }}>Open →</a>,
            ])}
          />
        </Card>
      )}
    </Page>
  );
}

function PartnerLinks({ partnerId, isAdmin }: { partnerId: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);

  const links = useQuery({
    queryKey: ['links', partnerId],
    queryFn: () => api<{ links: Link[] }>(`/partners/${partnerId}/links`),
  });

  const campaigns = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api<{ campaigns: Campaign[] }>('/campaigns'),
    enabled: isAdmin,
  });

  return (
    <Page title="Links" actions={<Button onClick={() => setShowCreate(true)}>New link</Button>}>
      <ErrorBanner error={links.error} />
      {showCreate && (
        <CreateLink
          partnerId={partnerId}
          campaigns={campaigns.data?.campaigns ?? []}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['links', partnerId] });
          }}
        />
      )}
      {links.isLoading ? (
        <Card>Loading…</Card>
      ) : (
        <Table
          columns={['Key', 'Destination', 'Campaign', 'Created']}
          rows={(links.data?.links ?? []).map((l) => [
            <code>{l.linkKey}</code>,
            <span style={{ color: '#555' }}>{l.destinationUrl}</span>,
            <code style={{ color: '#888' }}>{l.campaignId.slice(0, 10)}…</code>,
            formatDate(l.createdAt),
          ])}
        />
      )}
    </Page>
  );
}

function CreateLink({
  partnerId,
  campaigns,
  onClose,
  onCreated,
}: {
  partnerId: string;
  campaigns: Campaign[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [linkKey, setLinkKey] = useState('');
  const [destinationUrl, setDestinationUrl] = useState('');
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? '');

  const createLink = useMutation({
    mutationFn: () =>
      api(`/partners/${partnerId}/links`, {
        method: 'POST',
        body: { linkKey, destinationUrl, campaignId },
      }),
    onSuccess: onCreated,
  });

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>Create link</div>
      <ErrorBanner error={createLink.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
        <div>
          <Label>Link key</Label>
          <Input value={linkKey} onChange={(e) => setLinkKey(e.target.value)} placeholder="e.g. ada" />
        </div>
        <div>
          <Label>Destination URL</Label>
          <Input value={destinationUrl} onChange={(e) => setDestinationUrl(e.target.value)} placeholder="https://…" />
        </div>
      </div>
      <div style={{ marginTop: 12 }}>
        <Label>Campaign</Label>
        {campaigns.length === 0 ? (
          <Input value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="campaign id" />
        ) : (
          <select
            value={campaignId}
            onChange={(e) => setCampaignId(e.target.value)}
            style={{ padding: '8px 10px', fontSize: 14, border: '1px solid #ddd', borderRadius: 4, width: '100%' }}
          >
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.id.slice(0, 10)}…
              </option>
            ))}
          </select>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <Button onClick={() => createLink.mutate()} disabled={!linkKey || !destinationUrl || !campaignId || createLink.isPending}>
          {createLink.isPending ? 'Creating…' : 'Create'}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
