import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { Button, Card, ErrorBanner, Input, Label, Page, Textarea } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi, ApiError } from './creator-api.js';

interface InvitationContext {
  id: string;
  offeringId: string;
  offeringTitle: string | null;
  vendorDisplayName: string | null;
  message: string | null;
  status: 'pending' | 'consumed' | 'expired';
  expiresAt: string;
}

type MyStatus = 'none' | 'pending' | 'approved' | 'rejected' | 'cancelled';

const MODEL_LABELS: Record<'last_click' | 'first_click' | 'linear' | 'position', string> = {
  last_click: 'Last click',
  first_click: 'First click',
  linear: 'Linear',
  position: 'Position',
};

interface Offering {
  id: string;
  title: string;
  description: string | null;
  productUrl: string;
  vendorId: string;
  vendorName: string;
  vendorLogoUrl?: string | null;
  terms: {
    commissionDescription?: string;
    cookieWindowDays?: number;
    payoutCadence?: string;
    payoutHoldbackDays?: number;
    bonuses?: string[];
    /** Attribution model — last_click (most common), first_click,
     *  linear, position. Snapshotted from the  Program at offering
     *  create. Absent for legacy offerings or campaigns that didn't
     *  set one. */
    attributionModel?: 'last_click' | 'first_click' | 'linear' | 'position';
    /** How long after a click the brand still attributes a conversion. */
    attributionWindowDays?: number;
    /** True when commission pays on every renewal of a subscription. */
    recurring?: boolean;
    /** ISO timestamp when the bound vendor  Program expires. Null =
     *  indefinite (no end date). Absent = legacy offering. */
    campaignEndsAt?: string | null;
  };
  createdAt: string;
  myStatus: MyStatus;
}

interface PartnershipForOffering {
  id: string;
  offeringId: string;
  shareUrl: string;
}

interface Whoami {
  creator: { id: string; handle: string | null } | null;
}

export function CreatorOfferingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const invitationToken = searchParams.get('invitation');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [message, setMessage] = useState('');
  const [preferredSlug, setPreferredSlug] = useState('');

  const { data: offering, isLoading, error } = useQuery({
    queryKey: ['creator-offering', id],
    queryFn: () => creatorApi<Offering>(`/offerings/${id}`),
    enabled: !!id,
    retry: false,
  });

  const { data: whoami } = useQuery({
    queryKey: ['creator-whoami'],
    queryFn: () => creatorApi<Whoami>('/creators/whoami'),
    retry: false,
  });

  // Resolve the invitation token if present in the URL — gives us the
  // brand's pitch + offering context so we can show a banner +
  // pre-fill the apply form.
  const { data: invitation } = useQuery({
    queryKey: ['creator-invitation', invitationToken],
    queryFn: () => creatorApi<InvitationContext>(`/invitations/${invitationToken}`),
    enabled: !!invitationToken,
    retry: false,
  });

  // When an invitation lands and the apply form is empty, drop the
  // brand's message into the pitch field as a starting point. The
  // creator can edit before submitting.
  useEffect(() => {
    if (invitation?.message && !message) {
      setMessage(`Replying to your invitation: ${invitation.message}`);
    }
  }, [invitation?.message, message]);

  const apply = useMutation({
    mutationFn: () =>
      creatorApi(`/offerings/${id}/apply`, {
        method: 'POST',
        body: { message: message || undefined, preferredSlug: preferredSlug || undefined },
      }),
    onSuccess: async () => {
      // Best-effort consume the invitation if we came in via one — so
      // the brand sees "Application received" status on their side.
      // Failure here doesn't fail the application; it just leaves the
      // invitation pending.
      if (invitationToken && invitation?.status === 'pending') {
        try {
          await creatorApi(`/invitations/${invitationToken}/consume`, { method: 'POST' });
        } catch {
          /* fire-and-forget */
        }
      }
      qc.invalidateQueries({ queryKey: ['creator-my-requests'] });
      navigate('/creator/requests');
    },
  });

  return (
    <Page title={offering?.title ?? 'Program'}>
      <ErrorBanner error={error} />
      {isLoading && <Card>Loading…</Card>}
      {offering && (
        <Link
          to={`/creator/vendors/${offering.vendorId}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 14px',
            background: theme.surface,
            border: `1px solid ${theme.borderSubtle}`,
            borderRadius: theme.radiusSm,
            marginBottom: 14,
            textDecoration: 'none',
            color: theme.text,
          }}
        >
          <BrandMark logoUrl={offering.vendorLogoUrl ?? null} name={offering.vendorName} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, color: theme.textDim, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              Brand
            </div>
            <div style={{ fontSize: 15, fontWeight: 500, marginTop: 2, color: theme.text }}>
              {offering.vendorName}
            </div>
          </div>
          <span style={{ fontSize: 12, color: theme.accent, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            View profile <ChevronRight size={14} />
          </span>
        </Link>
      )}
      {invitation && invitation.status === 'pending' && (
        <Card style={{ marginBottom: 14, background: `${theme.accent}10`, borderColor: `${theme.accent}55` }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: theme.accent, marginBottom: 4 }}>
            ✓ {invitation.vendorDisplayName ?? 'A brand'} invited you to apply
          </div>
          {invitation.message && (
            <p style={{ fontSize: 13, color: theme.textMuted, margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>
              "{invitation.message}"
            </p>
          )}
          <p style={{ fontSize: 12, color: theme.textDim, margin: '8px 0 0' }}>
            Your pitch is pre-filled below. Edit + submit to apply.
          </p>
        </Card>
      )}
      {invitation && invitation.status === 'expired' && (
        <Card style={{ marginBottom: 14, background: `${theme.danger}10`, borderColor: `${theme.danger}55` }}>
          <div style={{ fontSize: 13, color: theme.danger }}>
            This invitation expired. You can still apply normally below.
          </div>
        </Card>
      )}
      {offering && (
        <>
          <Card>
            {offering.terms.commissionDescription && (
              <TermLine label="Commission" value={offering.terms.commissionDescription} />
            )}
            {offering.description && (
              <TermLine label="About" value={offering.description} multiline />
            )}
            <TermLine
              label="Product"
              value={
                <a href={offering.productUrl} target="_blank" rel="noopener noreferrer" style={{ color: theme.accent }}>
                  {offering.productUrl} ↗
                </a>
              }
            />
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 16, paddingTop: 14, borderTop: `1px solid ${theme.borderSubtle}`, color: theme.textMuted, fontSize: 13 }}>
              {offering.terms.attributionModel && (
                <LabeledChip
                  label="Attribution"
                  value={MODEL_LABELS[offering.terms.attributionModel]}
                  hint="Which click gets the credit when a customer touches several creator links before converting. Last click = the most recent referrer (most common); first click = the discoverer; linear/position split across all touches."
                />
              )}
              {offering.terms.attributionWindowDays != null && (
                <LabeledChip
                  label="Attribution window"
                  value={`${offering.terms.attributionWindowDays} days`}
                  hint="The longest gap between someone's click on your link and their eventual purchase that still pays you. Bigger window = more conversions credited to you, especially for products with long evaluation cycles."
                />
              )}
              {offering.terms.cookieWindowDays != null && (
                <LabeledChip label="Cookie window" value={`${offering.terms.cookieWindowDays} days`} />
              )}
              {offering.terms.recurring && (
                <LabeledChip
                  label="Recurring"
                  value="Every renewal"
                  hint="Commission pays on every renewal of a subscription, not just the first invoice. Best for SaaS / membership products."
                />
              )}
              {offering.terms.payoutCadence && (
                <LabeledChip label="Payouts" value={offering.terms.payoutCadence} />
              )}
              {offering.terms.payoutHoldbackDays != null && offering.terms.payoutHoldbackDays > 0 && (
                <LabeledChip
                  label="Holdback"
                  value={`${offering.terms.payoutHoldbackDays} days`}
                  hint="Time after a customer converts before the brand can approve + pay your commission. Aligns with their refund window or trial."
                />
              )}
              {(() => {
                const d = formatOfferingDuration(offering.terms.campaignEndsAt);
                return d ? <LabeledChip label="Duration" value={d} /> : null;
              })()}
            </div>
          </Card>

          <div style={{ height: 18 }} />

          <ApplyOrStatusCard
            offering={offering}
            whoami={whoami}
            message={message}
            setMessage={setMessage}
            preferredSlug={preferredSlug}
            setPreferredSlug={setPreferredSlug}
            apply={apply}
          />
        </>
      )}
    </Page>
  );
}

interface ApplyOrStatusProps {
  offering: Offering;
  whoami: Whoami | undefined;
  message: string;
  setMessage: (v: string) => void;
  preferredSlug: string;
  setPreferredSlug: (v: string) => void;
  apply: ReturnType<typeof useMutation<unknown, Error, void>>;
}

/** Label-on-top, value-below row used inside the offering terms card.
 *  Replaces the former unlabeled paragraph that left freeform values
 *  like "50%" floating without context. */
function TermLine({
  label,
  value,
  multiline,
}: {
  label: string;
  value: React.ReactNode;
  multiline?: boolean;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: theme.textDim, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: multiline ? 14 : 15, color: theme.text, whiteSpace: multiline ? 'pre-wrap' : 'normal', lineHeight: multiline ? 1.55 : 1.4 }}>
        {value}
      </div>
    </div>
  );
}

/** 36px brand mark used inside the Brand strip above the terms card.
 *  Smaller than the vendor profile page header (which sits at the
 *  top of its own page); same fallback behavior. */
function BrandMark({ logoUrl, name }: { logoUrl: string | null; name: string }) {
  const initial = name.charAt(0).toUpperCase() || '?';
  return (
    <div
      style={{
        width: 36,
        height: 36,
        borderRadius: 8,
        background: logoUrl ? theme.surface2 : theme.accent,
        color: theme.accentInk,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
        fontSize: 14,
        overflow: 'hidden',
        flexShrink: 0,
        border: `1px solid ${theme.borderSubtle}`,
      }}
    >
      {logoUrl ? (
        <img src={logoUrl} alt={name} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      ) : (
        initial
      )}
    </div>
  );
}

/** Renders the offering's runway as a single string for the Duration
 *  chip. Indefinite → "Ongoing". Bounded near-term → "Ends in Nd".
 *  Bounded far-term → "Ends MMM D". Unknown (legacy offering, field
 *  absent) → null so the chip is omitted instead of guessing. */
function formatOfferingDuration(endsAt: string | null | undefined): string | null {
  if (endsAt === undefined) return null;
  if (endsAt === null) return 'Ongoing';
  const end = new Date(endsAt);
  if (Number.isNaN(end.getTime())) return null;
  const ms = end.getTime() - Date.now();
  if (ms <= 0) return null;
  const days = Math.ceil(ms / (24 * 60 * 60 * 1000));
  if (days <= 60) return `Ends in ${days} ${days === 1 ? 'day' : 'days'}`;
  const now = new Date();
  return `Ends ${end.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(end.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })}`;
}

/** Compact label/value pair used for the secondary terms row (cookie
 *  window, holdback, payout cadence). Kept inline so they fit
 *  side-by-side on desktop and wrap on mobile. */
function LabeledChip({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint ?? undefined} style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ fontSize: 11, color: theme.textDim, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontSize: 13, color: theme.text }}>{value}</span>
    </div>
  );
}

function ApplyOrStatusCard({ offering, whoami, message, setMessage, preferredSlug, setPreferredSlug, apply }: ApplyOrStatusProps) {
  // Show approved share link when active partnership exists. Hide the
  // apply form for pending/cancelled (cancelled is rare; the creator
  // can still re-apply through the rejected path if needed).
  if (!whoami?.creator) {
    return (
      <Card>
        <h3 style={{ marginTop: 0 }}>Apply to promote</h3>
        <p style={{ color: theme.textMuted }}>
          <Link to="/creator/signup" style={{ color: theme.accent }}>Sign up</Link> or <Link to="/creator/login" style={{ color: theme.accent }}>sign in</Link> to apply.
        </p>
      </Card>
    );
  }

  if (offering.myStatus === 'approved') {
    return <ApprovedCard offering={offering} />;
  }

  if (offering.myStatus === 'pending') {
    return (
      <Card>
        <h3 style={{ marginTop: 0 }}>Application pending</h3>
        <p style={{ color: theme.textMuted, fontSize: 13 }}>
          You&rsquo;ve applied to {offering.vendorName} for this program. They&rsquo;ll review and you&rsquo;ll get an email when they decide.
          You can track it on <Link to="/creator/requests" style={{ color: theme.accent }}>My applications</Link>.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>{offering.myStatus === 'rejected' ? 'Re-apply' : 'Apply to promote'}</h3>
      {offering.myStatus === 'rejected' && (
        <p style={{ color: theme.textMuted, fontSize: 13, marginTop: 0 }}>
          Your previous application was declined. You can try again with a different pitch.
        </p>
      )}
      <ErrorBanner error={apply.error} />
      {apply.error instanceof ApiError && apply.error.message === 'request_already_exists' && (
        <p style={{ color: theme.textMuted, fontSize: 13 }}>You already have a pending or active request for this program.</p>
      )}
      <div style={{ marginTop: 8 }}>
        <Label>Preferred share-link slug (optional)</Label>
        <Input
          placeholder={whoami.creator.handle ?? 'your-handle'}
          value={preferredSlug}
          onChange={(e) => setPreferredSlug(e.target.value)}
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <Label>Message to the vendor (optional)</Label>
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={4}
          placeholder="Why you'd be a great partner…"
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
          {apply.isPending ? 'Applying…' : 'Submit application'}
        </Button>
      </div>
    </Card>
  );
}

/** Active partnership — fetch the share URL from /creators/me/partnerships
 *  and show it inline with a copy button. The flat partnerships endpoint
 *  already computes shareUrl (custom domain when verified, else the
 *  openpartner default). */
function ApprovedCard({ offering }: { offering: Offering }) {
  const [copied, setCopied] = useState(false);
  const { data } = useQuery({
    queryKey: ['creator-partnerships'],
    queryFn: () => creatorApi<{ partnerships: PartnershipForOffering[] }>('/creators/me/partnerships'),
    retry: false,
  });
  const partnership = data?.partnerships.find((p) => p.offeringId === offering.id);

  function copy() {
    if (!partnership) return;
    navigator.clipboard.writeText(partnership.shareUrl).then(
      () => { setCopied(true); setTimeout(() => setCopied(false), 1500); },
      () => {/* ignore */},
    );
  }

  return (
    <Card>
      <h3 style={{ marginTop: 0 }}>You&rsquo;re approved to promote this</h3>
      <p style={{ color: theme.textMuted, fontSize: 13 }}>
        Drop this share link on socials, in your newsletter, anywhere your audience hangs out.
      </p>
      {partnership ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            background: theme.surface2,
            border: `1px solid ${theme.borderSubtle}`,
            borderRadius: theme.radiusSm,
            padding: '10px 12px',
            marginTop: 12,
          }}
        >
          <code style={{ flex: 1, fontSize: 13, wordBreak: 'break-all' }}>{partnership.shareUrl}</code>
          <button
            onClick={copy}
            style={{
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
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : (
        <p style={{ color: theme.textDim, fontSize: 13, marginTop: 12 }}>Loading share link…</p>
      )}
      <p style={{ marginTop: 12, fontSize: 12 }}>
        <Link to="/creator/links" style={{ color: theme.accent }}>Edit slug or copy from My share links →</Link>
      </p>
    </Card>
  );
}
