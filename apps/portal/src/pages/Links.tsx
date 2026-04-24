import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Plus, ArrowRight } from 'lucide-react';
import { api, type Principal } from '../api.js';
import { theme } from '../theme.js';
import { Avatar, Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select, Table, formatDate } from '../ui.js';

interface LinkRow {
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
  const isAdmin = principal.role === 'admin';

  if (isAdmin && !partnerId) {
    return <AdminLinksHub />;
  }
  return <PartnerLinks partnerId={partnerId!} readOnly={isAdmin} />;
}

function AdminLinksHub() {
  const { data, error, isLoading } = useQuery({
    queryKey: ['partners'],
    queryFn: () => api<{ partners: Array<{ id: string; name: string; email: string }> }>('/partners'),
  });

  return (
    <Page title="Links" subtitle="Pick a partner to see the links they've created.">
      <ErrorBanner error={error} />
      {isLoading ? (
        <Card>Loading…</Card>
      ) : data?.partners.length === 0 ? (
        <EmptyState title="No partners yet" hint="Invite a partner — they create their own links." icon={<Link2 size={28} strokeWidth={1.25} />} />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {data?.partners.map((p) => (
            <Link
              key={p.id}
              to={`/links?partnerId=${p.id}`}
              style={{
                display: 'block',
                background: theme.surface,
                border: `1px solid ${theme.border}`,
                borderRadius: theme.radiusMd,
                padding: 16,
                transition: 'all 120ms',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = theme.accent)}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = theme.border)}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Avatar name={p.name} size={32} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: theme.textMuted }}>{p.email}</div>
                </div>
                <ArrowRight size={14} color={theme.textDim} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </Page>
  );
}

function PartnerLinks({ partnerId, readOnly }: { partnerId: string; readOnly: boolean }) {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);

  const links = useQuery({
    queryKey: ['links', partnerId],
    queryFn: () => api<{ links: LinkRow[] }>(`/partners/${partnerId}/links`),
  });

  const campaigns = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api<{ campaigns: Campaign[] }>('/campaigns').catch(() => ({ campaigns: [] })),
    enabled: !readOnly,
  });

  return (
    <Page
      title="Links"
      subtitle={
        readOnly
          ? "Links this partner has created. Partners manage their own; admins view only."
          : "Your share links — the router turns /r/<key> into an attributed click."
      }
      actions={
        readOnly ? undefined : (
          <Button icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
            New link
          </Button>
        )
      }
    >
      <ErrorBanner error={links.error} />
      {showCreate && !readOnly && (
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
      ) : (links.data?.links ?? []).length === 0 ? (
        <EmptyState
          title="No links yet"
          hint={readOnly ? "This partner hasn't created any links yet." : 'Create one to start capturing clicks.'}
          icon={<Link2 size={28} strokeWidth={1.25} />}
        />
      ) : (
        <Table
          columns={['Key', 'Destination', 'Campaign', 'Created']}
          rows={(links.data?.links ?? []).map((l) => [
            <code style={{ color: theme.accent }}>/r/{l.linkKey}</code>,
            <span style={{ color: theme.textMuted }}>{l.destinationUrl}</span>,
            <code style={{ color: theme.textDim, fontSize: 12 }}>{l.campaignId.slice(0, 8)}…</code>,
            <span style={{ color: theme.textMuted }}>{formatDate(l.createdAt, { relative: true })}</span>,
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

  const mut = useMutation({
    mutationFn: () =>
      api(`/partners/${partnerId}/links`, {
        method: 'POST',
        body: { linkKey, destinationUrl, campaignId },
      }),
    onSuccess: onCreated,
  });

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 16 }}>New link</div>
      <ErrorBanner error={mut.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 14, marginBottom: 14 }}>
        <div>
          <Label>Link key</Label>
          <Input value={linkKey} onChange={(e) => setLinkKey(e.target.value)} placeholder="ada" />
        </div>
        <div>
          <Label>Destination URL</Label>
          <Input value={destinationUrl} onChange={(e) => setDestinationUrl(e.target.value)} placeholder="https://…" />
        </div>
      </div>
      <div style={{ marginBottom: 16 }}>
        <Label>Campaign</Label>
        {campaigns.length === 0 ? (
          <Input value={campaignId} onChange={(e) => setCampaignId(e.target.value)} placeholder="campaign id (ULID)" />
        ) : (
          <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => mut.mutate()} disabled={!linkKey || !destinationUrl || !campaignId || mut.isPending}>
          {mut.isPending ? 'Creating…' : 'Create link'}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
