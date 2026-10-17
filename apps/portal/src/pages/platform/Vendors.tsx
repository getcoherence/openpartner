import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { alpha, theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Label, Page, Textarea, formatDate } from '../../ui.js';
import { ApprovalBadge, StatusBadge } from './components.js';
import {
  papi,
  friendlyPlatformError,
  type ApprovalStatus,
  type NetworkVendorReview,
  type PlatformOperator,
} from './lib.js';

type Filter = ApprovalStatus | 'all';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'all', label: 'All' },
];

interface ReviewVars {
  id: string;
  status: 'approved' | 'rejected';
  reason?: string;
  notifyVendor: boolean;
}

/**
 * Network vendor review queue. Self-hosted openpartner instances that join
 * the Network wait here — nothing they publish is discoverable until an
 * operator approves them. Our own hosted brands are Network vendors too, but
 * their review follows brand approval (Brands tab), so they're hidden by
 * default and read-only when shown.
 */
export function VendorsPage({ operator }: { operator: PlatformOperator }) {
  const [filter, setFilter] = useState<Filter>('pending');
  const [showHosted, setShowHosted] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const qc = useQueryClient();
  const canWrite = operator.role === 'admin';

  const vendors = useQuery({
    queryKey: ['platform-network-vendors'],
    queryFn: () => papi<{ vendors: NetworkVendorReview[] }>('/platform-admin/network-vendors'),
  });

  const review = useMutation({
    mutationFn: (v: ReviewVars) =>
      papi<{ notified: boolean }>(`/platform-admin/network-vendors/${v.id}/review`, {
        method: 'POST',
        body: { status: v.status, reason: v.reason?.trim() || undefined, notifyVendor: v.notifyVendor },
      }),
    onSuccess: (r, v) => {
      const name = vendors.data?.vendors.find((x) => x.id === v.id)?.displayName ?? 'Vendor';
      setNotice(
        `${name} ${v.status === 'approved' ? 'approved — its published programs are now listed' : 'rejected — hidden from the marketplace'}${
          r.notified ? ' · vendor emailed' : ''
        }.`,
      );
      void qc.invalidateQueries({ queryKey: ['platform-network-vendors'] });
      void qc.invalidateQueries({ queryKey: ['platform-marketplace'] });
    },
  });

  const all = (vendors.data?.vendors ?? []).filter((v) => showHosted || !v.managedBy);
  const rows = all.filter((v) => filter === 'all' || v.reviewStatus === filter);

  return (
    <Page
      title="Network vendors"
      subtitle="Self-hosted brands that join the Network wait here. Nothing they publish is listed on the marketplace until you approve them."
    >
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const count = f.key === 'all' ? all.length : all.filter((v) => v.reviewStatus === f.key).length;
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
              {f.label} ({count})
            </button>
          );
        })}
        <label
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: theme.textMuted, marginLeft: 8, cursor: 'pointer' }}
        >
          <input type="checkbox" checked={showHosted} onChange={(e) => setShowHosted(e.target.checked)} />
          Include hosted brands
        </label>
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
          You’re signed in as a read-only operator. Approvals are disabled.
        </div>
      )}

      <ErrorBanner error={review.error ? friendlyPlatformError(review.error) : vendors.error ? friendlyPlatformError(vendors.error) : null} />
      {notice && !review.error && <div style={{ fontSize: 13, color: theme.success, marginBottom: 12 }}>{notice}</div>}

      {vendors.isLoading ? (
        <Card>Loading…</Card>
      ) : rows.length === 0 ? (
        <Card style={{ textAlign: 'center', color: theme.textDim, fontSize: 14, padding: '40px 24px' }}>
          {filter === 'pending' ? 'No vendors waiting for review.' : `No ${filter === 'all' ? '' : filter} vendors.`}
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((v) => (
            <VendorCard
              key={v.id}
              vendor={v}
              canWrite={canWrite}
              busy={review.isPending && review.variables?.id === v.id}
              onReview={(vars) => review.mutate({ id: v.id, ...vars })}
            />
          ))}
        </div>
      )}
    </Page>
  );
}

function VendorCard({
  vendor: v,
  canWrite,
  busy,
  onReview,
}: {
  vendor: NetworkVendorReview;
  canWrite: boolean;
  busy: boolean;
  onReview: (v: Omit<ReviewVars, 'id'>) => void;
}) {
  const [rejecting, setRejecting] = useState(false);
  const [notifyOnApprove, setNotifyOnApprove] = useState(true);
  const managed = !!v.managedBy;

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{v.displayName}</span>
            <ApprovalBadge status={v.reviewStatus} />
            {v.status !== 'active' && (
              <StatusBadge status={v.status === 'pending' ? 'email not verified' : v.status} />
            )}
            <span style={{ fontSize: 11.5, color: theme.textDim }}>{v.tier === 'hosted' ? 'hosted' : 'self-hosted'}</span>
          </div>
          {/* Plain text, never a link — it's whatever the vendor registered. */}
          <div style={{ fontSize: 12, color: theme.textDim, marginTop: 2, fontFamily: theme.fontMono, wordBreak: 'break-all' }}>
            {v.instanceUrl}
          </div>
        </div>

        {canWrite && !managed && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
            {v.reviewStatus !== 'approved' && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: theme.textMuted, cursor: 'pointer' }}>
                  <input type="checkbox" checked={notifyOnApprove} onChange={(e) => setNotifyOnApprove(e.target.checked)} />
                  Email vendor
                </label>
                <Button size="sm" disabled={busy} onClick={() => onReview({ status: 'approved', notifyVendor: notifyOnApprove })}>
                  {busy ? 'Saving…' : 'Approve'}
                </Button>
              </>
            )}
            {v.reviewStatus !== 'rejected' && (
              <Button variant="danger" size="sm" disabled={busy} onClick={() => setRejecting((r) => !r)}>
                {v.reviewStatus === 'approved' ? 'Revoke approval' : 'Reject'}
              </Button>
            )}
          </div>
        )}
      </div>

      {managed && (
        <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 10 }}>
          Hosted brand <span style={{ fontFamily: theme.fontMono }}>/t/{v.managedBy!.slug}/</span>. Its listing follows brand
          approval, so decide it on the Brands tab.
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: '10px 20px',
          marginTop: 14,
        }}
      >
        <Field label="Contact">
          {v.contactName ? `${v.contactName} · ` : ''}
          {v.contactEmail}
        </Field>
        <Field label="Joined">{formatDate(v.createdAt)}</Field>
        <Field label="Last seen">{v.lastHeartbeatAt ? formatDate(v.lastHeartbeatAt, { relative: true }) : 'never'}</Field>
        <Field label="Partners">{v.partnerCount}</Field>
        <Field label="Programs">
          {v.offeringCount} ({v.publishedOfferingCount} published)
        </Field>
        {v.reviewedAt && (
          <Field label="Reviewed">
            {formatDate(v.reviewedAt, { relative: true })}
            {v.reviewReason ? ` · ${v.reviewReason}` : ''}
          </Field>
        )}
        {v.suspensionReason && <Field label="Suspended">{v.suspensionReason}</Field>}
      </div>

      {rejecting && (
        <RejectForm
          busy={busy}
          revoking={v.reviewStatus === 'approved'}
          onCancel={() => setRejecting(false)}
          onSubmit={(reason, notifyVendor) => {
            onReview({ status: 'rejected', reason, notifyVendor });
            setRejecting(false);
          }}
        />
      )}

      <div style={{ marginTop: 14, borderTop: `1px solid ${theme.borderSubtle}`, paddingTop: 12 }}>
        {v.offerings.length === 0 ? (
          <div style={{ fontSize: 13, color: theme.textDim }}>No programs on the Network yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {v.offerings.map((o) => (
              <div
                key={o.id}
                style={{
                  background: theme.surface2,
                  border: `1px solid ${theme.borderSubtle}`,
                  borderRadius: theme.radiusSm,
                  padding: '10px 12px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13.5, fontWeight: 600 }}>{o.title}</span>
                  <span style={{ fontSize: 11, color: o.published ? theme.success : theme.textDim }}>
                    {o.published ? 'published' : 'draft'}
                  </span>
                </div>
                {/* The destination — the tell for funnelling creators elsewhere.
                    Text only, never a live link. */}
                <div
                  style={{ fontSize: 12, fontFamily: theme.fontMono, color: theme.text, marginTop: 4, wordBreak: 'break-all' }}
                >
                  {o.productUrl}
                </div>
                {o.description && (
                  <div
                    style={{
                      fontSize: 12.5,
                      color: theme.textMuted,
                      marginTop: 6,
                      lineHeight: 1.5,
                      display: '-webkit-box',
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {o.description}
                  </div>
                )}
              </div>
            ))}
            {v.offeringCount > v.offerings.length && (
              <div style={{ fontSize: 12, color: theme.textDim }}>
                + {v.offeringCount - v.offerings.length} more
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function RejectForm({
  busy,
  revoking,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  revoking: boolean;
  onCancel: () => void;
  onSubmit: (reason: string, notifyVendor: boolean) => void;
}) {
  const [reason, setReason] = useState('');
  const [notifyVendor, setNotifyVendor] = useState(false);
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
        {revoking ? 'Revoke this vendor’s approval' : 'Reject this vendor'}
      </div>
      <div style={{ fontSize: 12.5, color: theme.textMuted, lineHeight: 1.5 }}>
        Its programs disappear from the marketplace and creators can no longer apply. The vendor keeps its Network
        connection and existing partnerships.
      </div>
      <div>
        <Label>Reason (stored on the record; included if you email the vendor)</Label>
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={notifyVendor} onChange={(e) => setNotifyVendor(e.target.checked)} />
        Email the vendor (leave off for spam, so you don’t confirm a live inbox)
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="danger" disabled={busy} onClick={() => onSubmit(reason, notifyVendor)}>
          {busy ? 'Saving…' : revoking ? 'Revoke approval' : 'Reject vendor'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10.5, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, color: theme.text, wordBreak: 'break-word' }}>{children}</div>
    </div>
  );
}
