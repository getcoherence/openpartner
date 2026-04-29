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
  const [revoking, setRevoking] = useState<Partner | null>(null);
  const [managingPrograms, setManagingPrograms] = useState<Partner | null>(null);

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
      {revoking && (
        <RevokeDialog
          partner={revoking}
          onClose={() => setRevoking(null)}
          onDone={() => {
            setRevoking(null);
            qc.invalidateQueries({ queryKey: ['partners'] });
          }}
        />
      )}
      {managingPrograms && (
        <ProgramsDialog
          partner={managingPrograms}
          onClose={() => setManagingPrograms(null)}
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
            <a href={`mailto:${p.email}`} style={{ color: theme.textMuted, textDecoration: 'none' }}>
              {p.email}
            </a>,
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
              <button
                onClick={() => setManagingPrograms(p)}
                style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, color: theme.accent, cursor: 'pointer' }}
              >
                Programs
              </button>
              <span style={{ color: theme.border }}>·</span>
              <Link to={`/payouts?partnerId=${p.id}`} style={{ color: theme.accent, fontSize: 13 }}>Payouts</Link>
              {!p.activatedAt && !p.revokedAt && (
                <>
                  <span style={{ color: theme.border }}>·</span>
                  <ResendInvite partnerId={p.id} />
                </>
              )}
              <span style={{ color: theme.border }}>·</span>
              <RevokeAction partner={p} openDialog={() => setRevoking(p)} />
            </div>,
          ])}
        />
      )}
    </Page>
  );
}

interface CreateCampaignOption {
  id: string;
  name: string;
}

function CreatePartner({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [grantAll, setGrantAll] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const campaigns = useQuery({
    queryKey: ['me-campaigns-for-invite'],
    queryFn: () => api<{ campaigns: CreateCampaignOption[] }>('/me/campaigns'),
  });

  const mut = useMutation({
    mutationFn: () =>
      api<Partner>('/partners', {
        method: 'POST',
        body: {
          name,
          email,
          // Only send campaignIds when admin scoped explicitly. Omitting
          // it preserves the legacy "grant all current campaigns"
          // default the backend already implements.
          campaignIds: grantAll ? undefined : Array.from(picked),
        },
      }),
    onSuccess: onCreated,
  });

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.text, marginBottom: 8 }}>
          <input type="checkbox" checked={grantAll} onChange={(e) => setGrantAll(e.target.checked)} />
          Grant access to all current campaigns (default)
        </label>
        {!grantAll && (
          <div style={{ marginTop: 8, padding: 12, background: theme.surface2, border: `1px solid ${theme.borderSubtle}`, borderRadius: theme.radiusSm }}>
            <div style={{ fontSize: 12, color: theme.textMuted, marginBottom: 8 }}>
              Pick the programs this partner can create share-links for. You can change this later from the partner&rsquo;s row.
            </div>
            {(campaigns.data?.campaigns ?? []).length === 0 ? (
              <div style={{ fontSize: 13, color: theme.textDim }}>No campaigns yet — create one in Campaigns first.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(campaigns.data?.campaigns ?? []).map((c) => (
                  <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.text }}>
                    <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                    {c.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          onClick={() => mut.mutate()}
          disabled={!name || !email || mut.isPending || (!grantAll && picked.size === 0)}
        >
          {mut.isPending ? 'Sending…' : 'Send invite'}
        </Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Card>
  );
}

function RevokeAction({ partner, openDialog }: { partner: Partner; openDialog: () => void }) {
  const qc = useQueryClient();
  const isRevoked = !!partner.revokedAt;
  // Reinstate is single-click (no email, no reason). Revoke opens the
  // dialog so the admin can set a reason + opt out of notification.
  const reinstate = useMutation({
    mutationFn: () => api(`/partners/${partner.id}/reinstate`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['partners'] });
      qc.invalidateQueries({ queryKey: ['admin-overview'] });
    },
  });

  return (
    <button
      onClick={() => (isRevoked ? reinstate.mutate() : openDialog())}
      disabled={reinstate.isPending}
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        fontSize: 13,
        color: isRevoked ? theme.accent : theme.danger,
        cursor: 'pointer',
      }}
    >
      {reinstate.isPending ? '…' : isRevoked ? 'Reinstate' : 'Revoke'}
    </button>
  );
}

function RevokeDialog({
  partner,
  onClose,
  onDone,
}: {
  partner: Partner;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(true);
  const mut = useMutation({
    mutationFn: () =>
      api(`/partners/${partner.id}/revoke`, {
        method: 'POST',
        body: { reason: reason.trim() || undefined, notify },
      }),
    onSuccess: onDone,
  });

  return (
    <Card style={{ marginBottom: 14, borderColor: `${theme.danger}44` }}>
      <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6, color: theme.danger }}>
        Revoke {partner.name}?
      </div>
      <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14 }}>
        They're signed out immediately and new clicks on their links stop accruing commission.
        Historical commissions are kept. You can reinstate at any time.
      </div>
      <ErrorBanner error={mut.error} />
      <div style={{ marginBottom: 14 }}>
        <Label>Reason (optional, included in their email)</Label>
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Ending partnership — no longer active"
          maxLength={500}
        />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.textMuted, marginBottom: 16 }}>
        <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
        Email the partner about the suspension
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
          {mut.isPending ? 'Revoking…' : 'Revoke partner'}
        </Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
    </Card>
  );
}

interface CampaignGrant {
  id: string;
  name: string;
  destinationUrl: string;
  granted: boolean;
  grantSource: 'admin' | 'offering' | null;
}

function ProgramsDialog({ partner, onClose }: { partner: Partner; onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ['partner-campaigns', partner.id],
    queryFn: () => api<{ campaigns: CampaignGrant[] }>(`/partners/${partner.id}/campaigns`),
  });

  const add = useMutation({
    mutationFn: (campaignId: string) =>
      api(`/partners/${partner.id}/campaigns`, { method: 'POST', body: { campaignIds: [campaignId] } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner-campaigns', partner.id] }),
  });
  const remove = useMutation({
    mutationFn: (campaignId: string) =>
      api(`/partners/${partner.id}/campaigns/${campaignId}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['partner-campaigns', partner.id] }),
  });

  const busyId = add.isPending ? add.variables : remove.isPending ? remove.variables : null;

  return (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <div style={{ fontSize: 15, fontWeight: 500, flex: 1 }}>Programs for {partner.name}</div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: theme.textMuted, cursor: 'pointer', fontSize: 13 }}>
          Close
        </button>
      </div>
      <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14 }}>
        Toggle which programs this partner can create share-links for. Revoking a program doesn&rsquo;t remove
        existing links — those keep working until the partner deletes them.
      </div>
      <ErrorBanner error={error ?? add.error ?? remove.error} />
      {isLoading ? (
        <div style={{ color: theme.textMuted }}>Loading…</div>
      ) : !data || data.campaigns.length === 0 ? (
        <div style={{ color: theme.textMuted }}>No campaigns exist yet — create one in Campaigns.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {data.campaigns.map((c) => {
            const busy = busyId === c.id;
            return (
              <label
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 12px',
                  background: c.granted ? `${theme.success}10` : theme.surface2,
                  border: `1px solid ${c.granted ? `${theme.success}44` : theme.borderSubtle}`,
                  borderRadius: theme.radiusSm,
                  cursor: busy ? 'wait' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={c.granted}
                  disabled={busy}
                  onChange={(e) => (e.target.checked ? add.mutate(c.id) : remove.mutate(c.id))}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500 }}>{c.name}</div>
                  <div style={{ fontSize: 12, color: theme.textMuted, fontFamily: theme.fontMono }}>{c.destinationUrl}</div>
                </div>
                {c.grantSource === 'offering' && (
                  <span style={{ fontSize: 11, color: theme.accent, padding: '3px 8px', background: `${theme.accent}15`, borderRadius: 12 }}>
                    via Network
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}
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

