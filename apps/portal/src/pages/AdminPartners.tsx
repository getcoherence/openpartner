import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Users } from 'lucide-react';
import { api } from '../api.js';
import { theme } from '../theme.js';
import { Avatar, Button, Card, EmptyState, ErrorBanner, Input, Label, Page, StatusPill, Table, formatDate } from '../ui.js';

interface Partner {
  id: string;
  email: string;
  name: string;
  stripeConnectAccountId: string | null;
  createdAt: string;
  activatedAt: string | null;
  revokedAt: string | null;
}

export function AdminPartners() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);

  const partners = useQuery({ queryKey: ['partners'], queryFn: () => api<{ partners: Partner[] }>('/partners') });

  return (
    <Page
      title="Partners"
      subtitle="Invite partners — they set up their own dashboard via an emailed magic link."
      actions={
        <Button icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
          Invite partner
        </Button>
      }
    >
      <ErrorBanner error={partners.error} />
      {showCreate && (
        <CreatePartner
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['partners'] });
            qc.invalidateQueries({ queryKey: ['admin-overview'] });
          }}
        />
      )}

      {partners.isLoading ? (
        <Card>Loading…</Card>
      ) : (partners.data?.partners ?? []).length === 0 ? (
        <EmptyState title="No partners yet" hint="Invite one to start tracking attributed revenue." icon={<Users size={28} strokeWidth={1.25} />} />
      ) : (
        <Table
          columns={['Partner', 'Email', 'Status', 'Stripe', 'Created', 'Actions']}
          rows={(partners.data?.partners ?? []).map((p) => [
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Avatar name={p.name} size={28} />
              <span style={{ fontWeight: 500 }}>{p.name}</span>
            </div>,
            <span style={{ color: theme.textMuted }}>{p.email}</span>,
            p.revokedAt
              ? <StatusPill status="revoked" />
              : p.activatedAt
                ? <StatusPill status="active" />
                : <StatusPill status="invited" />,
            p.stripeConnectAccountId ? <StatusPill status="connected" /> : <span style={{ color: theme.textDim }}>—</span>,
            <span style={{ color: theme.textMuted }}>{formatDate(p.createdAt, { relative: true })}</span>,
            <div style={{ display: 'flex', gap: 6 }}>
              <Link to={`/links?partnerId=${p.id}`} style={{ color: theme.accent, fontSize: 13 }}>Links</Link>
              <span style={{ color: theme.border }}>·</span>
              <Link to={`/payouts?partnerId=${p.id}`} style={{ color: theme.accent, fontSize: 13 }}>Payouts</Link>
              {!p.activatedAt && !p.revokedAt && (
                <>
                  <span style={{ color: theme.border }}>·</span>
                  <ResendInvite partnerId={p.id} />
                </>
              )}
              <span style={{ color: theme.border }}>·</span>
              <RevokeAction partner={p} />
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
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>Invite a partner</div>
      <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14 }}>
        They'll get an email with a one-time link to set up their dashboard.
      </div>
      <ErrorBanner error={mut.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
        </div>
        <div>
          <Label>Email</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@example.com" />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => mut.mutate()} disabled={!name || !email || mut.isPending}>
          {mut.isPending ? 'Sending…' : 'Send invite'}
        </Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Card>
  );
}

function RevokeAction({ partner }: { partner: Partner }) {
  const qc = useQueryClient();
  const isRevoked = !!partner.revokedAt;
  const mut = useMutation({
    mutationFn: () => api(`/partners/${partner.id}/${isRevoked ? 'reinstate' : 'revoke'}`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['partners'] });
      qc.invalidateQueries({ queryKey: ['admin-overview'] });
    },
  });

  function onClick() {
    if (!isRevoked) {
      const ok = window.confirm(
        `Revoke ${partner.name}?\n\nThey'll be signed out immediately and new clicks to their links will be flagged. Historical commissions are kept. You can reinstate later.`,
      );
      if (!ok) return;
    }
    mut.mutate();
  }

  return (
    <button
      onClick={onClick}
      disabled={mut.isPending}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        fontSize: 13,
        color: isRevoked ? theme.accent : theme.danger,
        cursor: 'pointer',
      }}
    >
      {mut.isPending ? '…' : isRevoked ? 'Reinstate' : 'Revoke'}
    </button>
  );
}

function ResendInvite({ partnerId }: { partnerId: string }) {
  const [sent, setSent] = useState(false);
  const mut = useMutation({
    mutationFn: () => api(`/partners/${partnerId}/invite`, { method: 'POST' }),
    onSuccess: () => {
      setSent(true);
      setTimeout(() => setSent(false), 2000);
    },
  });
  return (
    <button
      onClick={() => mut.mutate()}
      disabled={mut.isPending}
      style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, color: theme.accent, cursor: 'pointer' }}
    >
      {sent ? 'Sent' : mut.isPending ? 'Sending…' : 'Resend invite'}
    </button>
  );
}

