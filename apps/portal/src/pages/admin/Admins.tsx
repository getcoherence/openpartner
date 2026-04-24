import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, UserCog } from 'lucide-react';
import { api } from '../../api.js';
import { theme } from '../../theme.js';
import { Avatar, Button, Card, EmptyState, ErrorBanner, Input, Label, Page, StatusPill, Table, formatDate } from '../../ui.js';

interface Admin {
  id: string;
  email: string;
  name: string;
  activatedAt: string | null;
  revokedAt: string | null;
  lastSignInAt: string | null;
  createdAt: string;
}

export function AdminAdmins() {
  const qc = useQueryClient();
  const [showInvite, setShowInvite] = useState(false);

  const admins = useQuery({ queryKey: ['admins'], queryFn: () => api<{ admins: Admin[] }>('/admins') });

  return (
    <Page
      title="Admins"
      subtitle="People who can manage this partner program. Invited via email, they set up their own credentials."
      actions={
        <Button icon={<Plus size={14} />} onClick={() => setShowInvite(true)}>
          Invite admin
        </Button>
      }
    >
      <ErrorBanner error={admins.error} />
      {showInvite && (
        <InviteAdmin
          onClose={() => setShowInvite(false)}
          onCreated={() => {
            setShowInvite(false);
            qc.invalidateQueries({ queryKey: ['admins'] });
          }}
        />
      )}
      {admins.isLoading ? (
        <Card>Loading…</Card>
      ) : (admins.data?.admins ?? []).length === 0 ? (
        <EmptyState title="No admins yet" hint="Invite your team." icon={<UserCog size={28} strokeWidth={1.25} />} />
      ) : (
        <Table
          columns={['Admin', 'Email', 'Status', 'Last sign-in', 'Created', 'Actions']}
          rows={(admins.data?.admins ?? []).map((a) => [
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Avatar name={a.name} size={28} />
              <span style={{ fontWeight: 500 }}>{a.name}</span>
            </div>,
            <a href={`mailto:${a.email}`} style={{ color: theme.textMuted, textDecoration: 'none' }}>
              {a.email}
            </a>,
            a.revokedAt ? <StatusPill status="revoked" /> : a.activatedAt ? <StatusPill status="active" /> : <StatusPill status="invited" />,
            a.lastSignInAt ? (
              <span style={{ color: theme.textMuted }}>{formatDate(a.lastSignInAt, { relative: true })}</span>
            ) : (
              <span style={{ color: theme.textDim }}>—</span>
            ),
            <span style={{ color: theme.textMuted }}>{formatDate(a.createdAt, { relative: true })}</span>,
            <AdminActions admin={a} />,
          ])}
        />
      )}
    </Page>
  );
}

function InviteAdmin({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const mut = useMutation({
    mutationFn: () => api<Admin>('/admins', { method: 'POST', body: { name, email } }),
    onSuccess: onCreated,
  });

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>Invite an admin</div>
      <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14 }}>
        They'll get an email with a one-time link to activate their account.
      </div>
      <ErrorBanner error={mut.error} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Taylor Admin" />
        </div>
        <div>
          <Label>Email</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="taylor@example.com" />
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

function AdminActions({ admin }: { admin: Admin }) {
  const qc = useQueryClient();
  const [sent, setSent] = useState(false);
  const revoke = useMutation({
    mutationFn: () => api(`/admins/${admin.id}/revoke`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admins'] }),
  });
  const reinstate = useMutation({
    mutationFn: () => api(`/admins/${admin.id}/reinstate`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admins'] }),
  });
  const resend = useMutation({
    mutationFn: () => api(`/admins/${admin.id}/invite`, { method: 'POST' }),
    onSuccess: () => {
      setSent(true);
      setTimeout(() => setSent(false), 2000);
    },
  });

  const isRevoked = !!admin.revokedAt;
  const isPending = !admin.activatedAt && !admin.revokedAt;

  function confirmRevoke() {
    const ok = window.confirm(`Revoke ${admin.name}? They'll be signed out and lose admin access.`);
    if (ok) revoke.mutate();
  }

  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {isPending && (
        <>
          <button
            onClick={() => resend.mutate()}
            disabled={resend.isPending}
            style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, color: theme.accent, cursor: 'pointer' }}
          >
            {sent ? 'Sent' : resend.isPending ? 'Sending…' : 'Resend invite'}
          </button>
          <span style={{ color: theme.border }}>·</span>
        </>
      )}
      {isRevoked ? (
        <button
          onClick={() => reinstate.mutate()}
          disabled={reinstate.isPending}
          style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, color: theme.accent, cursor: 'pointer' }}
        >
          {reinstate.isPending ? '…' : 'Reinstate'}
        </button>
      ) : (
        <button
          onClick={confirmRevoke}
          disabled={revoke.isPending}
          style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, color: theme.danger, cursor: 'pointer' }}
        >
          {revoke.isPending ? '…' : 'Revoke'}
        </button>
      )}
    </div>
  );
}
