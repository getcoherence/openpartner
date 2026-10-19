import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { alpha, theme } from '../../theme.js';
import { countryName } from '../../lib/CountryField.js';
import { Button, Card, ErrorBanner, Label, Page, Select, Textarea, formatDate } from '../../ui.js';
import { ApprovalBadge, StatusBadge } from './components.js';
import {
  papi,
  friendlyPlatformError,
  type ApprovalStatus,
  type PlatformBrand,
  type PlatformOperator,
  type PlatformProgram,
} from './lib.js';

type Filter = ApprovalStatus | 'all';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
];

interface RejectVars {
  id: string;
  reason: string;
  notifyBrand: boolean;
  banEmail: boolean;
  banDomain: boolean;
}

/**
 * Brand review queue. Operators approve/reject pending brands, retroactively
 * remove approved ones, or reinstate rejected ones. Write actions are
 * admin-only; a read-only operator sees the list without action buttons.
 */
export function BrandsPage({ operator }: { operator: PlatformOperator }) {
  const [filter, setFilter] = useState<Filter>('pending');
  const qc = useQueryClient();
  const canWrite = operator.role === 'admin';

  const brands = useQuery({
    queryKey: ['platform-brands', filter],
    queryFn: () => papi<{ brands: PlatformBrand[] }>(`/platform-admin/brands?status=${filter}`),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['platform-brands'] });

  const approve = useMutation({
    mutationFn: (id: string) => papi(`/platform-admin/brands/${id}/approve`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  const reinstate = useMutation({
    mutationFn: (id: string) => papi(`/platform-admin/brands/${id}/reinstate`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  const reject = useMutation({
    mutationFn: (v: RejectVars) =>
      papi(`/platform-admin/brands/${v.id}/reject`, {
        method: 'POST',
        body: {
          reason: v.reason.trim() || undefined,
          notifyBrand: v.notifyBrand,
          banEmail: v.banEmail,
          banDomain: v.banDomain,
        },
      }),
    onSuccess: invalidate,
  });

  const actionError = approve.error ?? reinstate.error ?? reject.error;
  const rows = brands.data?.brands ?? [];

  return (
    <Page
      title="Brand review"
      subtitle="Approve new brands, remove abusive ones, and manage the sign-up blocklist."
    >
      <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                padding: '7px 14px',
                borderRadius: 999,
                fontSize: 13,
                fontWeight: active ? 600 : 500,
                cursor: 'pointer',
                color: active ? theme.accentInk : theme.textMuted,
                background: active ? theme.accent : theme.surface2,
                border: `1px solid ${active ? theme.accent : theme.border}`,
              }}
            >
              {f.label}
            </button>
          );
        })}
      </div>

      {!canWrite && (
        <div
          style={{
            background: theme.infoSoft,
            border: `1px solid ${alpha(theme.info, 0.267)}`,
            color: theme.info,
            padding: '10px 14px',
            borderRadius: theme.radiusSm,
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          You’re signed in as a read-only operator. Approvals, rejections, and blocklist changes are
          disabled.
        </div>
      )}

      <ErrorBanner error={actionError ? friendlyPlatformError(actionError) : brands.error} />

      {brands.isLoading ? (
        <Card>Loading…</Card>
      ) : rows.length === 0 ? (
        <Card style={{ textAlign: 'center', color: theme.textDim, fontSize: 14, padding: '40px 24px' }}>
          No {filter === 'all' ? '' : filter} brands.
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((b) => (
            <BrandCard
              key={b.id}
              brand={b}
              canWrite={canWrite}
              approveBusy={approve.isPending && approve.variables === b.id}
              reinstateBusy={reinstate.isPending && reinstate.variables === b.id}
              rejectBusy={reject.isPending && reject.variables?.id === b.id}
              onApprove={() => approve.mutate(b.id)}
              onReinstate={() => reinstate.mutate(b.id)}
              onReject={(v, opts) => reject.mutate({ id: b.id, ...v }, opts)}
            />
          ))}
        </div>
      )}
    </Page>
  );
}

function BrandCard({
  brand,
  canWrite,
  approveBusy,
  reinstateBusy,
  rejectBusy,
  onApprove,
  onReinstate,
  onReject,
}: {
  brand: PlatformBrand;
  canWrite: boolean;
  approveBusy: boolean;
  reinstateBusy: boolean;
  rejectBusy: boolean;
  onApprove: () => void;
  onReinstate: () => void;
  onReject: (v: Omit<RejectVars, 'id'>, opts?: { onSuccess?: () => void }) => void;
}) {
  // 'reject' for a pending brand, 'remove' for a retroactive takedown of an
  // already-approved brand — both hit the reject endpoint. 'warn' is the
  // marketplace policy warning.
  const [form, setForm] = useState<null | 'reject' | 'remove' | 'warn'>(null);
  const [showPrograms, setShowPrograms] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['platform-brands'] });

  const remind = useMutation({
    mutationFn: () =>
      papi<{ step: number; to: string }>(`/platform-admin/brands/${brand.id}/setup-reminder`, { method: 'POST' }),
    onSuccess: (r) => {
      setNotice(`Setup reminder ${r.step} of 3 sent to ${r.to}.`);
      void refresh();
    },
  });
  const warn = useMutation({
    mutationFn: (v: { details: string; deadlineDays: number }) =>
      papi<{ sentTo: string; deadline: string }>(`/platform-admin/brands/${brand.id}/policy-warning`, {
        method: 'POST',
        body: v,
      }),
    onSuccess: (r) => {
      setForm(null);
      setNotice(`Policy warning sent to ${r.sentTo}. Deadline ${formatDate(r.deadline)}.`);
      void refresh();
    },
  });
  const live = brand.approvalStatus !== 'rejected';

  return (
    <Card>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{brand.displayName}</span>
            <ApprovalBadge status={brand.approvalStatus} />
            <StatusBadge status={brand.status} />
          </div>
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 2, fontFamily: theme.fontMono }}>
            /t/{brand.slug}/
          </div>
        </div>
        {canWrite && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
            {live && !brand.setupComplete && (
              <Button size="sm" variant="ghost" disabled={remind.isPending} onClick={() => remind.mutate()}>
                {remind.isPending ? 'Sending…' : 'Send setup reminder'}
              </Button>
            )}
            {live && (
              <Button size="sm" variant="secondary" onClick={() => setForm(form === 'warn' ? null : 'warn')}>
                Policy warning
              </Button>
            )}
            {brand.approvalStatus === 'pending' && (
              <>
                <Button onClick={onApprove} disabled={approveBusy} size="sm">
                  {approveBusy ? 'Approving…' : 'Approve'}
                </Button>
                <Button variant="danger" size="sm" onClick={() => setForm(form === 'reject' ? null : 'reject')}>
                  Reject
                </Button>
              </>
            )}
            {brand.approvalStatus === 'approved' && (
              <Button variant="danger" size="sm" onClick={() => setForm(form === 'remove' ? null : 'remove')}>
                Remove
              </Button>
            )}
            {brand.approvalStatus === 'rejected' && (
              <Button size="sm" onClick={onReinstate} disabled={reinstateBusy}>
                {reinstateBusy ? 'Reinstating…' : 'Reinstate'}
              </Button>
            )}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: '10px 20px',
          marginTop: 14,
        }}
      >
        <Field label="Admin">
          {brand.adminName ? `${brand.adminName} · ` : ''}
          {brand.adminEmail ?? '—'}
        </Field>
        <Field label="Created">{formatDate(brand.createdAt)}</Field>
        <Field label="Created via">{brand.createdBy ?? '—'}</Field>
        <Field label="Based in">
          {brand.country ? (
            <>
              {countryName(brand.country)}
              {brand.ipCountryAtDeclaration && brand.ipCountryAtDeclaration !== brand.country && (
                <span style={{ color: theme.warn }}> · signed up from {countryName(brand.ipCountryAtDeclaration)}</span>
              )}
            </>
          ) : (
            'Not asked yet'
          )}
        </Field>
        <Field label="Plan">{brand.billingPlan ?? '—'}</Field>
        {brand.reviewedByEmail && (
          <Field label="Reviewed by">
            {brand.reviewedByEmail}
            {brand.reviewedAt ? ` · ${formatDate(brand.reviewedAt, { relative: true })}` : ''}
          </Field>
        )}
        {brand.approvalReason && <Field label="Reason on file">{brand.approvalReason}</Field>}
        <Field label="Setup">
          {brand.setupComplete ? (
            <span style={{ color: theme.success }}>Complete</span>
          ) : (
            <span style={{ color: theme.warn }}>
              {brand.setupMissing.length} step{brand.setupMissing.length === 1 ? '' : 's'} left
            </span>
          )}
          {brand.setupRemindersSent > 0 &&
            ` · ${brand.setupRemindersSent} reminder${brand.setupRemindersSent === 1 ? '' : 's'}${
              brand.lastSetupReminderAt ? `, last ${formatDate(brand.lastSetupReminderAt, { relative: true })}` : ''
            }`}
        </Field>
        {brand.lastPolicyWarningAt && (
          <Field label="Policy warning">
            <span style={{ color: theme.danger }}>Sent {formatDate(brand.lastPolicyWarningAt, { relative: true })}</span>
            {brand.policyWarningDeadline ? ` · deadline ${formatDate(brand.policyWarningDeadline)}` : ''}
          </Field>
        )}
      </div>

      {!brand.setupComplete && brand.setupMissing.length > 0 && (
        <div style={{ fontSize: 12, color: theme.textDim, marginTop: 8 }}>Missing: {brand.setupMissing.join(' · ')}</div>
      )}

      {notice && <div style={{ fontSize: 12.5, color: theme.success, marginTop: 10 }}>{notice}</div>}
      {(remind.error || warn.error) && (
        <div style={{ marginTop: 10 }}>
          <ErrorBanner error={friendlyPlatformError(remind.error ?? warn.error)} />
        </div>
      )}

      {form === 'warn' && (
        <PolicyWarningForm
          brandName={brand.displayName}
          adminEmail={brand.adminEmail}
          busy={warn.isPending}
          onCancel={() => setForm(null)}
          onSubmit={(v) => warn.mutate(v)}
        />
      )}

      {(form === 'reject' || form === 'remove') && (
        <RejectForm
          mode={form}
          busy={rejectBusy}
          onCancel={() => setForm(null)}
          onSubmit={(v) => onReject(v, { onSuccess: () => setForm(null) })}
        />
      )}

      <div style={{ marginTop: 14, borderTop: `1px solid ${theme.borderSubtle}`, paddingTop: 12 }}>
        <button
          onClick={() => setShowPrograms((v) => !v)}
          style={{
            background: 'transparent',
            border: 'none',
            color: theme.textMuted,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 500,
            padding: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          {showPrograms ? '▾' : '▸'} Programs ({brand.programCount})
          {brand.blockedProgramCount > 0 && (
            <span style={{ color: theme.danger, fontWeight: 600 }}>· {brand.blockedProgramCount} blocked</span>
          )}
        </button>
        {showPrograms && <ProgramsSection brandId={brand.id} canWrite={canWrite} />}
      </div>
    </Card>
  );
}

/**
 * Lazy-loaded list of a brand's programs. The destination URL is shown as
 * plain text (never a live link — it may point at a phishing page) so the
 * operator can judge intent. Admins can block/unblock a single program
 * without touching the brand.
 */
function ProgramsSection({ brandId, canWrite }: { brandId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const programs = useQuery({
    queryKey: ['platform-brand-programs', brandId],
    queryFn: () => papi<{ programs: PlatformProgram[] }>(`/platform-admin/brands/${brandId}/programs`),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['platform-brand-programs', brandId] });
    void qc.invalidateQueries({ queryKey: ['platform-brands'] }); // keep the blocked count fresh
  };

  const block = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      papi(`/platform-admin/programs/${v.id}/block`, { method: 'POST', body: { reason: v.reason || undefined } }),
    onSuccess: refresh,
  });
  const unblock = useMutation({
    mutationFn: (id: string) => papi(`/platform-admin/programs/${id}/unblock`, { method: 'POST' }),
    onSuccess: refresh,
  });

  if (programs.isLoading) {
    return <div style={{ padding: '10px 0', fontSize: 13, color: theme.textDim }}>Loading programs…</div>;
  }
  if (programs.isError) {
    return <ErrorBanner error={friendlyPlatformError(programs.error)} />;
  }
  const rows = programs.data?.programs ?? [];
  if (rows.length === 0) {
    return <div style={{ padding: '10px 0', fontSize: 13, color: theme.textDim }}>No programs yet.</div>;
  }

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {(block.error || unblock.error) && (
        <ErrorBanner error={friendlyPlatformError(block.error ?? unblock.error)} />
      )}
      {rows.map((p) => {
        const blocked = !!p.blockedAt;
        const busy =
          (block.isPending && block.variables?.id === p.id) || (unblock.isPending && unblock.variables === p.id);
        return (
          <div
            key={p.id}
            style={{
              background: theme.surface2,
              border: `1px solid ${blocked ? alpha(theme.danger, 0.333) : theme.borderSubtle}`,
              borderRadius: theme.radiusSm,
              padding: '10px 12px',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600 }}>{p.name}</span>
                  {blocked && (
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        color: theme.danger,
                        background: alpha(theme.danger, 0.102),
                        borderRadius: 4,
                        padding: '2px 6px',
                      }}
                    >
                      Blocked
                    </span>
                  )}
                  {p.shareOnNetwork && !blocked && (
                    <span style={{ fontSize: 11, color: theme.textDim }}>· on marketplace</span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    fontFamily: theme.fontMono,
                    color: blocked ? theme.textDim : theme.text,
                    marginTop: 4,
                    wordBreak: 'break-all',
                    textDecoration: blocked ? 'line-through' : 'none',
                  }}
                >
                  {p.destinationUrl}
                </div>
                <div style={{ fontSize: 11.5, color: theme.textDim, marginTop: 4 }}>
                  {p.linkCount} link{p.linkCount === 1 ? '' : 's'}
                  {blocked && p.blockedReason ? ` · reason: ${p.blockedReason}` : ''}
                  {blocked && p.blockedByEmail ? ` · by ${p.blockedByEmail}` : ''}
                </div>
                {/* Marketplace media — images are an easy way to slip spam
                    text past a text-only review, so show the cover itself. */}
                {(p.marketplaceCoverUrl || p.marketplaceVideoUrl) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
                    {p.marketplaceCoverUrl && (
                      <a href={p.marketplaceCoverUrl} target="_blank" rel="noopener noreferrer" title="Open cover image">
                        <img
                          src={p.marketplaceCoverUrl}
                          alt="Marketplace cover"
                          style={{
                            width: 150,
                            height: 50,
                            objectFit: 'cover',
                            borderRadius: 4,
                            border: `1px solid ${theme.borderSubtle}`,
                            display: 'block',
                          }}
                        />
                      </a>
                    )}
                    {p.marketplaceVideoUrl && (
                      <a
                        href={p.marketplaceVideoUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: 12, color: theme.accentText, wordBreak: 'break-all' }}
                      >
                        Video: {p.marketplaceVideoUrl}
                      </a>
                    )}
                  </div>
                )}
              </div>
              {canWrite && (
                <div style={{ flexShrink: 0 }}>
                  {blocked ? (
                    <Button size="sm" disabled={busy} onClick={() => unblock.mutate(p.id)}>
                      {busy ? 'Working…' : 'Unblock'}
                    </Button>
                  ) : (
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        const reason = window.prompt(
                          `Block "${p.name}"? Its partner links will stop redirecting.\n\nReason (optional, stored on the record):`,
                          '',
                        );
                        // null = cancelled; empty string = block with no reason.
                        if (reason !== null) block.mutate({ id: p.id, reason });
                      }}
                    >
                      {busy ? 'Working…' : 'Block'}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Marketplace policy warning, for a listing that funnels creators to a
 * different affiliate platform. The operator describes what they found; the
 * server wraps it in the standard notice (free listing means creators must
 * join and be tracked through OpenPartner; fix by the deadline or the
 * listing is removed). Removal itself stays a manual block/remove.
 */
function PolicyWarningForm({
  brandName,
  adminEmail,
  busy,
  onCancel,
  onSubmit,
}: {
  brandName: string;
  adminEmail: string | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (v: { details: string; deadlineDays: number }) => void;
}) {
  const [details, setDetails] = useState('');
  const [deadlineDays, setDeadlineDays] = useState(7);
  const tooShort = details.trim().length < 10;

  return (
    <div
      style={{
        marginTop: 16,
        paddingTop: 16,
        borderTop: `1px solid ${theme.borderSubtle}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: theme.warn }}>Send a marketplace policy warning</div>
      <div style={{ fontSize: 12.5, color: theme.textMuted, lineHeight: 1.55 }}>
        Emails {adminEmail ?? 'the brand’s admin'} from OpenPartner: listings are free because creators join and are
        tracked through OpenPartner, so sending them to another affiliate platform isn’t allowed. Fix it by the
        deadline or the listing is removed. Replies go to the ops inbox. Removing the listing afterwards is still up
        to you (block the program, or remove the brand).
      </div>
      <div>
        <Label>What you found (goes into the email)</Label>
        <Textarea
          rows={4}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          placeholder={`e.g. The ${brandName} listing tells creators to apply at partners.example.com (Rewardful) instead of joining through OpenPartner.`}
          maxLength={2000}
        />
      </div>
      <div style={{ maxWidth: 220 }}>
        <Label>Deadline</Label>
        <Select value={String(deadlineDays)} onChange={(e) => setDeadlineDays(Number(e.target.value))}>
          <option value="3">3 days</option>
          <option value="7">7 days</option>
          <option value="14">14 days</option>
        </Select>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button disabled={busy || tooShort} onClick={() => onSubmit({ details: details.trim(), deadlineDays })}>
          {busy ? 'Sending…' : 'Send warning'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function RejectForm({
  mode,
  busy,
  onCancel,
  onSubmit,
}: {
  mode: 'reject' | 'remove';
  busy: boolean;
  onCancel: () => void;
  onSubmit: (v: Omit<RejectVars, 'id'>) => void;
}) {
  const [reason, setReason] = useState('');
  const [notifyBrand, setNotifyBrand] = useState(false);
  const [banEmail, setBanEmail] = useState(false);
  const [banDomain, setBanDomain] = useState(false);

  return (
    <div
      style={{
        marginTop: 16,
        paddingTop: 16,
        borderTop: `1px solid ${theme.borderSubtle}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600, color: theme.danger }}>
        {mode === 'remove' ? 'Remove this brand' : 'Reject this brand'}
      </div>
      <div>
        <Label>Reason (internal — stored on the record)</Label>
        <Textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this brand being rejected?"
          maxLength={1000}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Check checked={notifyBrand} onChange={setNotifyBrand}>
          Email the brand a rejection notice
        </Check>
        <Check checked={banEmail} onChange={setBanEmail}>
          Ban this email from signing up again
        </Check>
        <Check checked={banDomain} onChange={setBanDomain}>
          Ban this whole domain
        </Check>
      </div>

      <div style={{ fontSize: 12, color: theme.textDim, lineHeight: 1.5 }}>
        Reject spam or phishing <strong>silently</strong> — leave the notice unchecked so you don’t confirm
        a live inbox, and optionally ban the email or domain to block re-signups.
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => onSubmit({ reason, notifyBrand, banEmail, banDomain })}
        >
          {busy ? 'Working…' : mode === 'remove' ? 'Remove brand' : 'Reject brand'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer', color: theme.text }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 10.5,
          color: theme.textDim,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 13, color: theme.text, wordBreak: 'break-word' }}>{children}</div>
    </div>
  );
}
