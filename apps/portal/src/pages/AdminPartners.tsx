import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Users, KeyRound, Copy, Check } from 'lucide-react';
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
}

export function AdminPartners() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [issueKeyFor, setIssueKeyFor] = useState<Partner | null>(null);

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
      {issueKeyFor && <IssueKey partner={issueKeyFor} onClose={() => setIssueKeyFor(null)} />}

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
            p.activatedAt ? <StatusPill status="active" /> : <StatusPill status="invited" />,
            p.stripeConnectAccountId ? <StatusPill status="connected" /> : <span style={{ color: theme.textDim }}>—</span>,
            <span style={{ color: theme.textMuted }}>{formatDate(p.createdAt, { relative: true })}</span>,
            <div style={{ display: 'flex', gap: 6 }}>
              <Link to={`/links?partnerId=${p.id}`} style={{ color: theme.accent, fontSize: 13 }}>Links</Link>
              <span style={{ color: theme.border }}>·</span>
              <Link to={`/payouts?partnerId=${p.id}`} style={{ color: theme.accent, fontSize: 13 }}>Payouts</Link>
              {!p.activatedAt && (
                <>
                  <span style={{ color: theme.border }}>·</span>
                  <ResendInvite partnerId={p.id} />
                </>
              )}
              <span style={{ color: theme.border }}>·</span>
              <button
                onClick={() => setIssueKeyFor(p)}
                style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, color: theme.accent, cursor: 'pointer' }}
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

function IssueKey({ partner, onClose }: { partner: Partner; onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [copied, setCopied] = useState(false);
  const mut = useMutation({
    mutationFn: () =>
      api<{ id: string; plaintext: string }>(`/partners/${partner.id}/api-keys`, {
        method: 'POST',
        body: { label },
      }),
  });

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <KeyRound size={18} color={theme.accent} />
        <div style={{ fontSize: 15, fontWeight: 500 }}>Issue API key for {partner.name}</div>
      </div>
      <ErrorBanner error={mut.error} />
      {mut.data ? (
        <>
          <div style={{ marginBottom: 10, color: theme.textMuted, fontSize: 13 }}>
            Copy this key now — it won't be shown again.
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: theme.warnSoft,
              border: `1px solid ${theme.warn}55`,
              padding: '10px 12px',
              borderRadius: theme.radiusSm,
              marginBottom: 12,
            }}
          >
            <code style={{ flex: 1, fontSize: 13, color: theme.text, wordBreak: 'break-all' }}>{mut.data.plaintext}</code>
            <Button
              size="sm"
              variant="secondary"
              icon={copied ? <Check size={14} /> : <Copy size={14} />}
              onClick={() => {
                navigator.clipboard.writeText(mut.data!.plaintext);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <Button onClick={onClose}>Done</Button>
        </>
      ) : (
        <>
          <Label>Label (optional)</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. production server" />
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
              {mut.isPending ? 'Issuing…' : 'Issue key'}
            </Button>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </>
      )}
    </Card>
  );
}
