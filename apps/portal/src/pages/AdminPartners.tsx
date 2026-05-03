import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Users } from 'lucide-react';
import { api } from '../api.js';
import { theme } from '../theme.js';
import { TenantLink } from '../tenant-link.js';
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

      <ToolsCard />

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
              <TenantLink to={`/links?partnerId=${p.id}`} style={{ color: theme.accent, fontSize: 13 }}>Links</TenantLink>
              <span style={{ color: theme.border }}>·</span>
              <TenantLink to={`/admin/partners/${p.id}/programs`} style={{ color: theme.accent, fontSize: 13 }}>Programs</TenantLink>
              <span style={{ color: theme.border }}>·</span>
              <TenantLink to={`/admin/partners/${p.id}/coupons`} style={{ color: theme.accent, fontSize: 13 }}>Coupons</TenantLink>
              <span style={{ color: theme.border }}>·</span>
              <TenantLink to={`/admin/partners/${p.id}/commission`} style={{ color: theme.accent, fontSize: 13 }}>Commission</TenantLink>
              <span style={{ color: theme.border }}>·</span>
              <TenantLink to={`/payouts?partnerId=${p.id}`} style={{ color: theme.accent, fontSize: 13 }}>Payouts</TenantLink>
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

interface BackfillResult {
  scanned: number;
  inserted: number;
  ambiguous: number;
  alreadyHadSnapshot: number;
  noCampaignRule: number;
}

/**
 * Tools panel — currently just the commission-snapshot backfill.
 * Idempotent + safe to run repeatedly. Lives here (rather than a
 * separate Settings → Maintenance page) because the operation is
 * partner-scoped and admins looking at the partner list are the
 * audience.
 */
function ToolsCard() {
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const backfill = useMutation({
    mutationFn: () => api<BackfillResult>('/partners/backfill-commission-snapshots', { method: 'POST' }),
    onSuccess: (r) => setResult(r),
  });
  return (
    <Card style={{ marginBottom: 14 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          cursor: 'pointer',
        }}
        onClick={() => setShowDetails((s) => !s)}
      >
        <div style={{ fontSize: 14, fontWeight: 500, flex: 1, minWidth: 0 }}>
          Tools <span style={{ color: theme.textDim, fontSize: 12, fontWeight: 400 }}>{showDetails ? '▾' : '▸'}</span>
        </div>
      </div>
      {showDetails && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${theme.borderSubtle}` }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>Backfill commission snapshots</div>
          <p style={{ fontSize: 12, color: theme.textMuted, margin: '4px 0 10px', lineHeight: 1.5 }}>
            Stamps a <code>PartnerCommission</code> row for partners that predate snapshot
            federation, using their bound campaign&rsquo;s current rule + holdback. After
            running, edits to that campaign no longer retroactively re-price these partners&rsquo;
            commissions. Idempotent — safe to run repeatedly. Only touches single-campaign
            partners (multi-campaign rows have no unambiguous &ldquo;the rate&rdquo; to snapshot).
          </p>
          <Button onClick={() => backfill.mutate()} disabled={backfill.isPending} variant="secondary">
            {backfill.isPending ? 'Running…' : 'Run backfill'}
          </Button>
          {backfill.error && (
            <div style={{ marginTop: 8, fontSize: 12, color: theme.danger }}>
              Failed: {backfill.error instanceof Error ? backfill.error.message : String(backfill.error)}
            </div>
          )}
          {result && (
            <div style={{ marginTop: 10, fontSize: 12, color: theme.textMuted }}>
              Scanned <strong>{result.scanned}</strong> · backfilled{' '}
              <strong style={{ color: theme.success }}>{result.inserted}</strong> · already had
              snapshot {result.alreadyHadSnapshot} · multi-campaign skipped {result.ambiguous} ·
              no parseable campaign rule {result.noCampaignRule}
            </div>
          )}
        </div>
      )}
    </Card>
  );
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

