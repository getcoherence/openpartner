import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Copy, Megaphone } from 'lucide-react';
import { Button, Card, EmptyState, ErrorBanner, Input, Label, Page, formatDate, money } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi } from './creator-api.js';

interface Coupon {
  id: string;
  code: string;
  programId: string;
  redemptions90d: number;
  revenue90d: number;
  /** True when the bound program has partnersMayCustomizeCode=on. Gates
   *  the "Add another code" + per-card "Deactivate" affordances. */
  canEdit: boolean;
  /** ISO timestamp when this code was retired. Null = active. */
  deactivatedAt: string | null;
}

interface Partnership {
  id: string;
  vendorId: string;
  offeringId: string;
  creatorSlug: string;
  publicShareUrl: string;
  status: string;
  createdAt: string;
  vendorName: string;
  offeringTitle: string | null;
  shareUrl: string;
  customDomain: string | null;
  coupons: Coupon[];
}

export function CreatorShareLinksPage() {
  const list = useQuery({
    queryKey: ['creator-partnerships'],
    queryFn: () => creatorApi<{ partnerships: Partnership[] }>('/creators/me/partnerships'),
    retry: false,
  });

  const verified = list.data?.partnerships ?? [];
  const customDomain = verified[0]?.customDomain ?? null;

  return (
    <Page
      title="Share links"
      subtitle={
        customDomain
          ? `Branded with your domain ${customDomain}. Edit the slug per program below.`
          : 'Default openpartner.dev URLs. Add a custom domain in Domains to brand them.'
      }
    >
      <ErrorBanner error={list.error} />
      {list.isLoading ? (
        <Card>Loading…</Card>
      ) : verified.length === 0 ? (
        <EmptyState
          title="No share links yet"
          hint="Apply to a program to get your first share link."
          icon={<Megaphone size={28} strokeWidth={1.25} />}
        />
      ) : (
        verified.map((p) => <PartnershipRow key={p.id} partnership={p} />)
      )}
    </Page>
  );
}

function PartnershipRow({ partnership }: { partnership: Partnership }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [slug, setSlug] = useState(partnership.creatorSlug);
  const [copied, setCopied] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      creatorApi(`/creators/me/partnerships/${partnership.id}`, {
        method: 'PATCH',
        body: { creatorSlug: slug.trim().toLowerCase() },
      }),
    onSuccess: () => {
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['creator-partnerships'] });
    },
  });

  function copy() {
    navigator.clipboard.writeText(partnership.shareUrl).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {/* ignore */},
    );
  }

  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <h3 style={{ marginTop: 0, marginBottom: 0, flex: 1 }}>
          <Link to={`/creator/vendors/${partnership.vendorId}`}>{partnership.vendorName}</Link>
        </h3>
        <Link
          to={`/creator/programs/${partnership.id}`}
          style={{
            fontSize: 12,
            color: theme.accent,
            textDecoration: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          View dashboard →
        </Link>
        <span style={{ color: theme.textMuted, fontSize: 12 }}>
          {formatDate(partnership.createdAt, { relative: true })}
        </span>
      </div>
      {partnership.offeringTitle && (
        <p style={{ color: theme.textMuted, fontSize: 13, margin: '0 0 12px' }}>
          {partnership.offeringTitle}
        </p>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: theme.surface2,
          border: `1px solid ${theme.borderSubtle}`,
          borderRadius: theme.radiusSm,
          padding: '10px 12px',
          marginBottom: 8,
        }}
      >
        <code style={{ flex: 1, fontSize: 13, wordBreak: 'break-all' }}>{partnership.shareUrl}</code>
        <button
          onClick={copy}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            border: `1px solid ${theme.borderSubtle}`,
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 12,
            color: copied ? theme.success : theme.textMuted,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          <Copy size={12} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <CouponSection partnership={partnership} />
      {/* slug editor block follows below */}
      {editing ? (
        <div style={{ marginTop: 12 }}>
          <Label>Slug (path under your domain)</Label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder="program-name"
              style={{ fontFamily: theme.fontMono, flex: 1 }}
            />
            <Button onClick={() => save.mutate()} disabled={save.isPending || !slug.trim() || slug === partnership.creatorSlug}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="secondary" onClick={() => { setEditing(false); setSlug(partnership.creatorSlug); }}>
              Cancel
            </Button>
          </div>
          {save.error && (
            <div style={{ color: theme.danger, fontSize: 12, marginTop: 6 }}>
              {save.error instanceof Error ? save.error.message : 'Failed to save'}
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 14, alignItems: 'baseline' }}>
          <span style={{ color: theme.textMuted, fontSize: 12 }}>
            slug: <code>{partnership.creatorSlug}</code>
          </span>
          <button
            onClick={() => setEditing(true)}
            style={{ background: 'transparent', border: 'none', color: theme.accent, cursor: 'pointer', fontSize: 12, padding: 0 }}
          >
            Edit
          </button>
        </div>
      )}
    </Card>
  );
}

/**
 * Coupon section under each partnership. Three responsibilities:
 *   1. List the partner's ACTIVE codes (deactivated codes are hidden;
 *      they're still in the API response for analytics, but cluttering
 *      the active-codes list with retired ones isn't useful here).
 *   2. Render a "+ Add another code" affordance when the brand allows
 *      partner-customization. Inline input — no modal.
 *   3. Per-row Deactivate when canEdit. Old code keeps redeeming until
 *      the partner clicks Deactivate, so links/posts already shared
 *      don't break the moment they iterate.
 */
function CouponSection({ partnership }: { partnership: Partnership }) {
  const active = partnership.coupons.filter((c) => !c.deactivatedAt);
  // canEdit comes from per-coupon flags (the program owns the toggle, all
  // coupons for a given program inherit the same value). Use the union
  // across all coupons so the add affordance still shows when the only
  // active coupon got deactivated.
  const canEdit = partnership.coupons.some((c) => c.canEdit);
  const [adding, setAdding] = useState(false);

  if (active.length === 0 && !canEdit) return null;

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 11, color: theme.textDim, textTransform: 'uppercase', letterSpacing: '0.05em', flex: 1 }}>
          Coupon code{active.length === 1 ? '' : 's'}
        </div>
        {canEdit && !adding && (
          <button
            onClick={() => setAdding(true)}
            style={{
              background: 'transparent',
              border: 'none',
              color: theme.accent,
              cursor: 'pointer',
              fontSize: 11,
              padding: 0,
            }}
          >
            + Add another
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {active.map((c) => (
          <CouponRow key={c.id} partnershipId={partnership.id} coupon={c} />
        ))}
        {adding && (
          <CouponAddRow partnershipId={partnership.id} onClose={() => setAdding(false)} />
        )}
      </div>
      <CouponHelp coupons={active} />
    </div>
  );
}

function CouponRow({ partnershipId, coupon }: { partnershipId: string; coupon: Coupon }) {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const deactivate = useMutation({
    mutationFn: () =>
      creatorApi(`/creators/me/partnerships/${partnershipId}/coupons/${coupon.id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      setConfirming(false);
      qc.invalidateQueries({ queryKey: ['creator-partnerships'] });
    },
  });

  function copy() {
    navigator.clipboard.writeText(coupon.code).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => {/* ignore */},
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        background: theme.surface2,
        border: `1px solid ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
        padding: '6px 10px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <code style={{ flex: 1, fontSize: 13, fontWeight: 500, color: theme.text, fontFamily: theme.fontMono }}>{coupon.code}</code>
        <span style={{ color: theme.textMuted, fontSize: 11, whiteSpace: 'nowrap' }}>
          {coupon.redemptions90d > 0
            ? `${coupon.redemptions90d.toLocaleString()} redemption${coupon.redemptions90d === 1 ? '' : 's'} · ${money(coupon.revenue90d, 'USD')}`
            : 'No redemptions yet (90d)'}
        </span>
        {coupon.canEdit && (
          <button
            onClick={() => setConfirming((v) => !v)}
            style={{
              background: 'transparent',
              border: `1px solid ${theme.borderSubtle}`,
              borderRadius: 6,
              padding: '4px 8px',
              fontSize: 11,
              color: theme.textMuted,
              cursor: 'pointer',
            }}
          >
            {confirming ? 'Cancel' : 'Deactivate'}
          </button>
        )}
        <button
          onClick={copy}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'transparent',
            border: `1px solid ${theme.borderSubtle}`,
            borderRadius: 6,
            padding: '4px 8px',
            fontSize: 11,
            color: copied ? theme.success : theme.textMuted,
            cursor: 'pointer',
          }}
        >
          <Copy size={11} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {confirming && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4, borderTop: `1px solid ${theme.borderSubtle}`, marginTop: 4 }}>
          <span style={{ fontSize: 11, color: theme.textMuted, flex: 1 }}>
            Anyone using <code style={{ fontFamily: theme.fontMono }}>{coupon.code}</code> at
            checkout after this will see an invalid-code error.
          </span>
          <Button onClick={() => deactivate.mutate()} disabled={deactivate.isPending}>
            {deactivate.isPending ? 'Working…' : 'Confirm'}
          </Button>
        </div>
      )}
      {deactivate.error && (
        <p style={{ color: theme.danger, fontSize: 12, margin: 0 }}>
          {couponErrorMessage(deactivate.error)}
        </p>
      )}
    </div>
  );
}

/** Inline "+ Add another code" form. Rendered as a virtual coupon row
 *  so it slots into the same vertical stack as the existing codes. */
function CouponAddRow({
  partnershipId,
  onClose,
}: {
  partnershipId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');

  const create = useMutation({
    mutationFn: () =>
      creatorApi(`/creators/me/partnerships/${partnershipId}/coupons`, {
        method: 'POST',
        // Empty draft sends no `code` so the server applies its
        // email-derived default. Useful for partners who want a second
        // code for tracking but don't care about vanity.
        body: draft.trim() ? { code: draft.trim().toUpperCase() } : {},
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['creator-partnerships'] });
      onClose();
    },
  });

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: theme.surface2,
        border: `1px dashed ${theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
        padding: '8px 10px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40))}
          placeholder="GRACIE15 (or leave blank for an auto-generated code)"
          style={{ fontFamily: theme.fontMono, flex: 1 }}
        />
        <Button
          onClick={() => create.mutate()}
          disabled={create.isPending || (draft.length > 0 && draft.length < 3)}
        >
          {create.isPending ? 'Adding…' : 'Add'}
        </Button>
        <Button variant="secondary" onClick={() => { onClose(); create.reset(); }}>
          Cancel
        </Button>
      </div>
      {create.error && (
        <p style={{ color: theme.danger, fontSize: 12, margin: 0 }}>
          {couponErrorMessage(create.error)}
        </p>
      )}
    </div>
  );
}

/** Map the API error envelopes from the add/deactivate flows into
 *  partner-readable strings. The Network forwards the vendor's body
 *  verbatim, so error codes match what the vendor returns. */
function couponErrorMessage(err: unknown): string {
  if (!err) return 'Something went wrong';
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('code_taken')) return 'That code is already in use. Pick another.';
  if (raw.includes('active_codes_cap_reached')) {
    return 'You already have the maximum number of active codes for this program. Deactivate one first.';
  }
  if (raw.includes('partner_customization_disabled')) {
    return 'The brand turned off partner-customizable codes. Contact them to enable.';
  }
  if (raw.includes('verification_required')) {
    return 'The brand needs to verify their checkout integration before more codes can be minted. Contact them.';
  }
  if (raw.includes('invalid_body')) return 'Code must be 3–40 chars: A–Z, 0–9, hyphens.';
  return raw.length > 200 ? 'Something went wrong' : raw;
}

/** Footnote that adapts to whether the creator's coupons are seeing
 *  redemptions. If they've shared codes but seen 0 redemptions in 90
 *  days, surface a hint that the brand may not have the integration
 *  wired up — closes the trust gap from the creator side. */
function CouponHelp({ coupons }: { coupons: Coupon[] }) {
  const totalRedemptions = coupons.reduce((sum, c) => sum + c.redemptions90d, 0);
  const allZero = coupons.length > 0 && totalRedemptions === 0;
  if (allZero) {
    return (
      <p style={{ fontSize: 11, color: theme.textMuted, margin: '6px 0 0' }}>
        No redemptions yet. If you&rsquo;ve been sharing codes, the brand may not have wired up
        the OpenPartner integration on their checkout. Reach out to confirm.
      </p>
    );
  }
  return (
    <p style={{ fontSize: 11, color: theme.textDim, margin: '6px 0 0' }}>
      Customers who enter a code at checkout get attributed to you, same commission as the share link.
    </p>
  );
}
