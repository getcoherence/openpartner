import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, UserCog } from 'lucide-react';
import { api, ApiError, type Principal } from '../../api.js';
import { theme } from '../../theme.js';
import { Avatar, Button, Card, EmptyState, ErrorBanner, Input, Label, Page, Select, StatusPill, Table, formatDate } from '../../ui.js';
import { EditOnly, useViewOnly, ViewOnlyBadge } from '../../lib/viewOnly.js';

type Role = 'admin' | 'viewer';

interface Admin {
  id: string;
  email: string;
  name: string;
  role: Role;
  activatedAt: string | null;
  revokedAt: string | null;
  lastSignInAt: string | null;
  createdAt: string;
}

/** The guards' refusals (routes/admins.ts), said plainly. */
const GUARD_MESSAGES: Record<string, string> = {
  cannot_revoke_last_active_admin: 'Someone has to stay a full admin.',
  cannot_demote_last_active_admin: 'Someone has to stay a full admin.',
  cannot_change_own_role: "You can't change your own role.",
  cannot_revoke_self: "You can't revoke yourself.",
};

function guardMessage(error: unknown): string | null {
  if (!error) return null;
  const code = error instanceof ApiError ? (error.detail as { error?: string } | undefined)?.error : undefined;
  return (code && GUARD_MESSAGES[code]) ?? (error instanceof Error ? error.message : String(error));
}

export function AdminAdmins() {
  const qc = useQueryClient();
  const viewOnly = useViewOnly();
  const [showInvite, setShowInvite] = useState(false);

  const admins = useQuery({ queryKey: ['admins'], queryFn: () => api<{ admins: Admin[] }>('/admins') });
  const me = useQuery({ queryKey: ['whoami'], queryFn: () => api<Principal>('/auth/whoami'), staleTime: 60_000 });

  return (
    <Page
      title="Admins"
      actions={
        <EditOnly>
          <Button icon={<Plus size={14} />} onClick={() => setShowInvite(true)}>
            Invite admin
          </Button>
        </EditOnly>
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
          columns={['Admin', 'Email', 'Role', 'Status', 'Last sign-in', 'Created', ...(viewOnly ? [] : ['Actions'])]}
          rows={(admins.data?.admins ?? []).map((a) => [
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Avatar name={a.name} size={28} />
              <span style={{ fontWeight: 500 }}>{a.name}</span>
            </div>,
            <a href={`mailto:${a.email}`} style={{ color: theme.textMuted, textDecoration: 'none' }}>
              {a.email}
            </a>,
            a.role === 'viewer' ? <ViewOnlyBadge /> : <span style={{ color: theme.textMuted }}>Admin</span>,
            a.revokedAt ? <StatusPill status="revoked" /> : a.activatedAt ? <StatusPill status="active" /> : <StatusPill status="invited" />,
            a.lastSignInAt ? (
              <span style={{ color: theme.textMuted }}>{formatDate(a.lastSignInAt, { relative: true })}</span>
            ) : (
              <span style={{ color: theme.textDim }}>—</span>
            ),
            <span style={{ color: theme.textMuted }}>{formatDate(a.createdAt, { relative: true })}</span>,
            ...(viewOnly ? [] : [<AdminActions admin={a} isSelf={me.data?.admin?.id === a.id} />]),
          ])}
        />
      )}
    </Page>
  );
}

function InviteAdmin({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('admin');
  const mut = useMutation({
    mutationFn: () => api<Admin>('/admins', { method: 'POST', body: { name, email, role } }),
    onSuccess: onCreated,
  });

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>Invite an admin</div>
      <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14 }}>
        They'll get an email with a one-time link to activate their account.
      </div>
      <ErrorBanner error={mut.error} />
      <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 160px', gap: 14, marginBottom: 14 }}>
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Taylor Admin" />
        </div>
        <div>
          <Label>Email</Label>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="taylor@example.com" />
        </div>
        <div>
          <Label>Role</Label>
          <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="admin">Admin</option>
            <option value="viewer">View only</option>
          </Select>
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

function AdminActions({ admin, isSelf }: { admin: Admin; isSelf: boolean }) {
  const qc = useQueryClient();
  const [sent, setSent] = useState(false);
  const changeRole = useMutation({
    mutationFn: (role: Role) => api<Admin>(`/admins/${admin.id}`, { method: 'PATCH', body: { role } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admins'] }),
  });
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

  const error = guardMessage(changeRole.error ?? revoke.error);
  const nextRole: Role = admin.role === 'viewer' ? 'admin' : 'viewer';

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {!isSelf && !isRevoked && (
        <>
          <button
            onClick={() => changeRole.mutate(nextRole)}
            disabled={changeRole.isPending}
            style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, color: theme.accentText, cursor: 'pointer' }}
          >
            {changeRole.isPending ? '…' : nextRole === 'viewer' ? 'Make view only' : 'Make admin'}
          </button>
          <span style={{ color: theme.border }}>·</span>
        </>
      )}
      {isPending && (
        <>
          <button
            onClick={() => resend.mutate()}
            disabled={resend.isPending}
            style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, color: theme.accentText, cursor: 'pointer' }}
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
          style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, color: theme.accentText, cursor: 'pointer' }}
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
      {error && <span style={{ fontSize: 12, color: theme.danger }}>{error}</span>}
    </div>
  );
}
