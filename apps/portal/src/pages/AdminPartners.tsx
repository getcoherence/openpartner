import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Users } from 'lucide-react';
import { audienceSizeLabel, isHttpUrl } from '@openpartner/db';
import { api } from '../api.js';
import { alpha, theme } from '../theme.js';
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
  metadata?: { review?: { status?: string }; application?: unknown } | null;
}

/** Join-page answers (Partner.metadata.application, written by
 *  POST /partner-signup). */
interface PartnerApplicationView {
  websiteUrl: string;
  socialUrls: string[];
  audienceSize: string;
  pitch: string;
  submittedAt: string | null;
}

/** Applied through the public join page and waiting for an admin (see
 *  apps/api/src/partner-review.ts). Can't sign in until approved. */
function isPendingReview(p: Partner): boolean {
  return !p.activatedAt && !p.revokedAt && p.metadata?.review?.status === 'pending';
}

/** The partner's application, or null when there's none on file (invited
 *  partners, and applicants from before the join page asked for one).
 *  Metadata is admin-editable JSON, so read it defensively. */
function applicationOf(p: Partner): PartnerApplicationView | null {
  const a = p.metadata?.application;
  if (!a || typeof a !== 'object') return null;
  const r = a as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    websiteUrl: str(r.websiteUrl),
    socialUrls: Array.isArray(r.socialUrls) ? r.socialUrls.filter((u): u is string => typeof u === 'string') : [],
    audienceSize: str(r.audienceSize),
    pitch: str(r.pitch),
    submittedAt: typeof r.submittedAt === 'string' ? r.submittedAt : null,
  };
}

export function AdminPartners() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [revoking, setRevoking] = useState<Partner | null>(null);
  const [viewing, setViewing] = useState<Partner | null>(null);

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
      {viewing && <ApplicationPanel partner={viewing} onClose={() => setViewing(null)} />}

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
                : isPendingReview(p)
                  ? <StatusPill status="pending review" />
                  : <StatusPill status="invited" />,
            p.stripeConnectAccountId ? <StatusPill status="connected" /> : <span style={{ color: theme.textDim }}>—</span>,
            <span style={{ color: theme.textMuted }}>{formatDate(p.createdAt, { relative: true })}</span>,
            <div style={{ display: 'flex', gap: 6 }}>
              <TenantLink to={`/links?partnerId=${p.id}`} style={{ color: theme.accentText, fontSize: 13 }}>Links</TenantLink>
              <span style={{ color: theme.border }}>·</span>
              <TenantLink to={`/admin/partners/${p.id}/programs`} style={{ color: theme.accentText, fontSize: 13 }}>Programs</TenantLink>
              <span style={{ color: theme.border }}>·</span>
              <TenantLink to={`/admin/partners/${p.id}/coupons`} style={{ color: theme.accentText, fontSize: 13 }}>Coupons</TenantLink>
              <span style={{ color: theme.border }}>·</span>
              <TenantLink to={`/admin/partners/${p.id}/commission`} style={{ color: theme.accentText, fontSize: 13 }}>Commission</TenantLink>
              <span style={{ color: theme.border }}>·</span>
              <TenantLink to={`/payouts?partnerId=${p.id}`} style={{ color: theme.accentText, fontSize: 13 }}>Payouts</TenantLink>
              {applicationOf(p) ? (
                <>
                  <span style={{ color: theme.border }}>·</span>
                  <button
                    onClick={() => setViewing(p)}
                    style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, color: theme.accentText, cursor: 'pointer', whiteSpace: 'nowrap' }}
                  >
                    View application
                  </button>
                </>
              ) : isPendingReview(p) ? (
                <>
                  <span style={{ color: theme.border }}>·</span>
                  <span style={{ fontSize: 13, color: theme.textDim, whiteSpace: 'nowrap' }}>No application on file</span>
                </>
              ) : null}
              {!p.activatedAt && !p.revokedAt && (
                <>
                  <span style={{ color: theme.border }}>·</span>
                  {isPendingReview(p) ? <ApproveApplication partner={p} /> : <ResendInvite partnerId={p.id} />}
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

interface CreateProgramOption {
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
    queryFn: () => api<{ programs: CreateProgramOption[] }>('/me/programs'),
  });

  const mut = useMutation({
    mutationFn: () =>
      api<Partner>('/partners', {
        method: 'POST',
        body: {
          name,
          email,
          // Only send programIds when admin scoped explicitly. Omitting
          // it preserves the legacy "grant all current campaigns"
          // default the backend already implements.
          programIds: grantAll ? undefined : Array.from(picked),
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
      <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
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
            {(campaigns.data?.programs ?? []).length === 0 ? (
              <div style={{ fontSize: 13, color: theme.textDim }}>No campaigns yet — create one in Campaigns first.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(campaigns.data?.programs ?? []).map((c) => (
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
        color: isRevoked ? theme.accentText : theme.danger,
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
    <Card style={{ marginBottom: 14, borderColor: alpha(theme.danger, 0.267) }}>
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

/** Read-only view of a partner's join-page answers. Approve / Revoke stay
 *  on the row. */
function ApplicationPanel({ partner, onClose }: { partner: Partner; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // The row's link is often far below the panel; bring it into view.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [partner.id]);
  const application = applicationOf(partner);

  return (
    <div ref={ref}>
      <Card style={{ marginBottom: 14 }}>
        <div role="region" aria-label={`${partner.name}'s application`}>
          <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 4 }}>{partner.name}&rsquo;s application</div>
          {!application ? (
            <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14 }}>No application on file.</div>
          ) : (
            <>
              <div style={{ fontSize: 13, color: theme.textMuted, marginBottom: 14 }}>
                {application.submittedAt
                  ? `Applied ${formatDate(application.submittedAt)} (${formatDate(application.submittedAt, { relative: true })})`
                  : 'Application date unknown'}
                {' · '}
                <a href={`mailto:${partner.email}`} style={{ color: theme.textMuted }}>{partner.email}</a>
              </div>
              <div
                className="op-grid-collapse"
                style={{ display: 'grid', gridTemplateColumns: '180px 1fr', columnGap: 16, rowGap: 12, fontSize: 13, marginBottom: 16 }}
              >
                <AnswerLabel>Website or main channel</AnswerLabel>
                <div style={{ minWidth: 0 }}><ExternalUrl url={application.websiteUrl} /></div>

                <AnswerLabel>Social profiles</AnswerLabel>
                <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {application.socialUrls.length === 0
                    ? <span style={{ color: theme.textDim }}>—</span>
                    : application.socialUrls.map((u) => <ExternalUrl key={u} url={u} />)}
                </div>

                <AnswerLabel>Audience size</AnswerLabel>
                <div>{audienceSizeLabel(application.audienceSize) ?? <span style={{ color: theme.textDim }}>—</span>}</div>

                <AnswerLabel>How they&rsquo;d promote you</AnswerLabel>
                <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.55, color: theme.text }}>
                  {application.pitch || <span style={{ color: theme.textDim }}>—</span>}
                </div>
              </div>
            </>
          )}
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </Card>
    </div>
  );
}

function AnswerLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ color: theme.textMuted, fontWeight: 500 }}>{children}</div>;
}

/** Applicant-supplied link. Only http(s) becomes an anchor (metadata is
 *  editable JSON, so never trust it into an href); opens in a new tab. */
function ExternalUrl({ url }: { url: string }) {
  if (!url) return <span style={{ color: theme.textDim }}>—</span>;
  if (!isHttpUrl(url)) return <span style={{ overflowWrap: 'anywhere' }}>{url}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: theme.accentText, overflowWrap: 'anywhere' }}>
      {url}
    </a>
  );
}

/** Approving = the invite endpoint: it records the approval and emails the
 *  applicant their sign-in link. Declining is Revoke. */
function ApproveApplication({ partner }: { partner: Partner }) {
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: () => api(`/partners/${partner.id}/invite`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['partners'] }),
  });
  return (
    <button
      onClick={() => {
        if (
          window.confirm(
            `Approve ${partner.name}? We'll email them a link to sign in. Give them access to programs under Programs so they can create links.`,
          )
        ) {
          mut.mutate();
        }
      }}
      disabled={mut.isPending}
      title={mut.error instanceof Error ? mut.error.message : undefined}
      style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, color: theme.success, cursor: 'pointer', fontWeight: 600 }}
    >
      {mut.isPending ? 'Approving…' : mut.isError ? 'Approve (retry)' : 'Approve'}
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
      style={{ background: 'none', border: 'none', padding: 0, fontSize: 13, color: theme.accentText, cursor: 'pointer' }}
    >
      {sent ? 'Sent' : mut.isPending ? 'Sending…' : 'Resend invite'}
    </button>
  );
}

