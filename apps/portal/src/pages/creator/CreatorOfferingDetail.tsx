import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Button, Card, ErrorBanner, Input, Label, Page, Textarea } from '../../ui.js';
import { theme } from '../../theme.js';
import { creatorApi, ApiError } from './creator-api.js';
import { categoryLabel } from '@openpartner/db';

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

interface CustomerReward {
  type: 'percent_off' | 'amount_off' | 'free_months';
  value: number;
  currency?: string;
  duration: 'once' | 'forever' | 'repeating';
  durationInMonths?: number;
}

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
    /** Customer-side reward (dual-sided incentive). Drives the gift
     *  icon in the Rewards quick-info cell + a row in the Rewards
     *  card. */
    customerReward?: CustomerReward | null;
    /** Curated category slugs. First one renders in the Category
     *  quick-info cell; the rest live in a "+N" tooltip. */
    categories?: string[];
    /** ISO timestamp when the bound vendor  Program expires. Null =
     *  indefinite (no end date). Absent = legacy offering. */
    campaignEndsAt?: string | null;
  };
  createdAt: string;
  myStatus: MyStatus;
}

function partnerOnlySummary(full: string | undefined): string {
  if (!full) return '';
  const idx = full.indexOf(' — customers get ');
  return idx >= 0 ? full.slice(0, idx) : full;
}

function formatCustomerReward(r: CustomerReward): string {
  const base = (() => {
    if (r.type === 'percent_off') return `${r.value}% off`;
    if (r.type === 'amount_off') {
      const cur = r.currency && r.currency.toUpperCase() !== 'USD' ? ` ${r.currency.toUpperCase()}` : '';
      return `$${r.value}${cur} off`;
    }
    return `${r.value} ${r.value === 1 ? 'month' : 'months'} free`;
  })();
  if (r.type === 'free_months') return base;
  if (r.duration === 'once') return `${base} on first invoice`;
  if (r.duration === 'forever') return `${base} forever`;
  if (r.duration === 'repeating' && r.durationInMonths) return `${base} for ${r.durationInMonths} months`;
  return base;
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function firstParagraph(s: string): string {
  const blocks = s.split(/\n\s*\n/);
  return blocks[0]?.trim() ?? s.trim();
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
        <OfferingDetailBody
          offering={offering}
          whoami={whoami}
          message={message}
          setMessage={setMessage}
          preferredSlug={preferredSlug}
          setPreferredSlug={setPreferredSlug}
          apply={apply}
        />
      )}
    </Page>
  );
}

/**
 * Main body of the offering detail page — Dub-style layout matching
 * the public marketplace's per-program page on openpartner.dev.
 *
 *   - Brand header: logo + vendor name + tagline (first paragraph of
 *     description). Vendor name links to the vendor's full profile.
 *   - Quick-info row: Rewards icons (with hover tooltips), Category
 *     (first label + "+N" tooltip), Website link.
 *   - Two-column body: left = "Join the X" intro + apply form +
 *     Rewards card + program details; right = full About text.
 */
function OfferingDetailBody({
  offering,
  whoami,
  message,
  setMessage,
  preferredSlug,
  setPreferredSlug,
  apply,
}: ApplyOrStatusProps) {
  const cats = offering.terms.categories ?? [];
  return (
    <>
      <header style={{ display: 'flex', gap: 18, alignItems: 'flex-start', marginBottom: 18 }}>
        <BrandMark logoUrl={offering.vendorLogoUrl ?? null} name={offering.vendorName} size={56} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Link
            to={`/creator/vendors/${offering.vendorId}`}
            style={{
              fontSize: 26,
              fontWeight: 700,
              color: theme.text,
              textDecoration: 'none',
              lineHeight: 1.15,
              display: 'block',
            }}
          >
            {offering.vendorName}
          </Link>
          {offering.description && (
            <p
              style={{
                fontSize: 14,
                color: theme.textMuted,
                lineHeight: 1.5,
                margin: '6px 0 0',
                maxWidth: 640,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {firstParagraph(offering.description)}
            </p>
          )}
        </div>
      </header>

      {/* Quick-info row — Rewards / Category / Website at-a-glance */}
      <div
        style={{
          display: 'flex',
          gap: 32,
          flexWrap: 'wrap',
          padding: '14px 0',
          marginBottom: 18,
          borderTop: `1px solid ${theme.borderSubtle}`,
          borderBottom: `1px solid ${theme.borderSubtle}`,
        }}
      >
        <QuickCell label="Rewards">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {offering.terms.commissionDescription && (
              <Tooltip text={partnerOnlySummary(offering.terms.commissionDescription)}>
                <RewardIcon kind="commission" />
              </Tooltip>
            )}
            {offering.terms.customerReward && (
              <Tooltip text={`Customers get ${formatCustomerReward(offering.terms.customerReward)}`}>
                <RewardIcon kind="customer" />
              </Tooltip>
            )}
          </div>
        </QuickCell>
        {cats.length > 0 && (
          <QuickCell label="Category">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: theme.text }}>
                {categoryLabel(cats[0]!)}
              </span>
              {cats.length > 1 && (
                <Tooltip text={cats.slice(1).map(categoryLabel).join('\n')} stacked>
                  <span style={{ fontSize: 12, color: theme.textMuted, cursor: 'help', padding: '2px 6px' }}>
                    +{cats.length - 1}
                  </span>
                </Tooltip>
              )}
            </div>
          </QuickCell>
        )}
        {offering.productUrl && (
          <QuickCell label="Website">
            <a
              href={offering.productUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 14, color: theme.accent, textDecoration: 'none' }}
            >
              {hostnameOf(offering.productUrl)} ↗
            </a>
          </QuickCell>
        )}
      </div>

      {/* Two-column body */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: 24,
        }}
      >
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card>
            <h2 style={{ fontSize: 18, margin: '0 0 8px', color: theme.text }}>
              Join the {offering.vendorName} partner program
            </h2>
            <p style={{ fontSize: 14, color: theme.textMuted, lineHeight: 1.55, margin: '0 0 16px' }}>
              Share {offering.vendorName} with your audience. For each customer you refer,
              you earn the commission below — paid directly to your Stripe account.
            </p>

            <ApplyOrStatusCard
              offering={offering}
              whoami={whoami}
              message={message}
              setMessage={setMessage}
              preferredSlug={preferredSlug}
              setPreferredSlug={setPreferredSlug}
              apply={apply}
              embedded
            />
          </Card>

          <Card>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: theme.textDim,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                marginBottom: 10,
              }}
            >
              Rewards
            </div>
            {offering.terms.commissionDescription && (
              <RewardCardRow
                icon="commission"
                text={partnerOnlySummary(offering.terms.commissionDescription)}
              />
            )}
            {offering.terms.customerReward && (
              <RewardCardRow
                icon="customer"
                text={`New customers get ${formatCustomerReward(offering.terms.customerReward)}`}
              />
            )}
          </Card>

          <Card>
            <div
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: theme.textDim,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                marginBottom: 10,
              }}
            >
              Program details
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '8px 16px' }}>
              {offering.terms.attributionModel && (
                <>
                  <span style={{ fontSize: 13, color: theme.textMuted }}>Attribution</span>
                  <span style={{ fontSize: 13, color: theme.text }}>{MODEL_LABELS[offering.terms.attributionModel]}</span>
                </>
              )}
              {offering.terms.attributionWindowDays != null && (
                <>
                  <span style={{ fontSize: 13, color: theme.textMuted }}>Attribution window</span>
                  <span style={{ fontSize: 13, color: theme.text }}>{offering.terms.attributionWindowDays} days</span>
                </>
              )}
              {offering.terms.cookieWindowDays != null && (
                <>
                  <span style={{ fontSize: 13, color: theme.textMuted }}>Cookie window</span>
                  <span style={{ fontSize: 13, color: theme.text }}>{offering.terms.cookieWindowDays} days</span>
                </>
              )}
              {offering.terms.payoutHoldbackDays != null && offering.terms.payoutHoldbackDays > 0 && (
                <>
                  <span style={{ fontSize: 13, color: theme.textMuted }}>Payout holdback</span>
                  <span style={{ fontSize: 13, color: theme.text }}>{offering.terms.payoutHoldbackDays} days</span>
                </>
              )}
              {offering.terms.payoutCadence && (
                <>
                  <span style={{ fontSize: 13, color: theme.textMuted }}>Payouts</span>
                  <span style={{ fontSize: 13, color: theme.text }}>{offering.terms.payoutCadence}</span>
                </>
              )}
              {(() => {
                const d = formatOfferingDuration(offering.terms.campaignEndsAt);
                return d ? (
                  <>
                    <span style={{ fontSize: 13, color: theme.textMuted }}>Duration</span>
                    <span style={{ fontSize: 13, color: theme.text }}>{d}</span>
                  </>
                ) : null;
              })()}
            </div>
          </Card>
        </div>

        {offering.description && (
          <div style={{ minWidth: 0 }}>
            <Card>
              <h2 style={{ fontSize: 18, margin: '0 0 12px', color: theme.text }}>
                About {offering.vendorName}
              </h2>
              <div style={{ fontSize: 14, color: theme.textMuted, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
                {offering.description}
              </div>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}

/** Quick-info row cell — label-above-content. */
function QuickCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: theme.textDim,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function RewardIcon({ kind }: { kind: 'commission' | 'customer' }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 28,
        height: 28,
        borderRadius: 6,
        background: theme.surface2,
        border: `1px solid ${theme.borderSubtle}`,
        color: theme.textMuted,
        cursor: 'help',
      }}
    >
      {kind === 'commission' ? <DollarIcon /> : <GiftIcon />}
    </span>
  );
}

/** Inline lucide-style line icons. Matches the marketing-site marketplace
 *  so the brand-mark / reward-icon visual language is shared. */
function DollarIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="2" x2="12" y2="22" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  );
}

function GiftIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 12 20 22 4 22 4 12" />
      <rect x="2" y="7" width="20" height="5" />
      <line x1="12" y1="22" x2="12" y2="7" />
      <path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z" />
      <path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z" />
    </svg>
  );
}

function RewardCardRow({ icon, text }: { icon: 'commission' | 'customer'; text: string }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '6px 0' }}>
      <RewardIcon kind={icon} />
      <span style={{ fontSize: 14, color: theme.text, lineHeight: 1.5, paddingTop: 3 }}>{text}</span>
    </div>
  );
}

/**
 * Custom CSS-only tooltip — sits above the trigger on hover. We avoid
 * the browser's `title` attribute everywhere on this page so the tooltip
 * styling is consistent and the 1s+ system delay doesn't make the UI
 * feel sluggish. `stacked` flag switches to a multi-line list layout
 * for the "+N" categories popover.
 */
function Tooltip({
  text,
  children,
  stacked,
}: {
  text: string;
  children: React.ReactNode;
  stacked?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const lines = stacked ? text.split('\n').filter(Boolean) : null;
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {children}
      <span
        style={{
          position: 'absolute',
          bottom: 'calc(100% + 8px)',
          left: '50%',
          transform: 'translateX(-50%)',
          background: theme.surface,
          color: theme.text,
          fontSize: 12,
          fontWeight: 500,
          padding: stacked ? '8px 12px' : '6px 10px',
          borderRadius: 6,
          border: `1px solid ${theme.borderSubtle}`,
          boxShadow: '0 4px 12px rgba(15, 23, 42, 0.25)',
          whiteSpace: stacked ? 'normal' : 'nowrap',
          maxWidth: 280,
          pointerEvents: 'none',
          opacity: hovered ? 1 : 0,
          transition: 'opacity 0.12s',
          zIndex: 30,
        }}
      >
        {lines ? (
          <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {lines.map((l, i) => (
              <span key={i} style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{l}</span>
            ))}
          </span>
        ) : (
          text
        )}
      </span>
    </span>
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

/** Brand mark used in the offering header. Sizable so the same component
 *  works at 36px for compact headers and 56px for the page-top header. */
function BrandMark({ logoUrl, name, size = 36 }: { logoUrl: string | null; name: string; size?: number }) {
  const initial = name.charAt(0).toUpperCase() || '?';
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size >= 48 ? 10 : 8,
        background: logoUrl ? theme.surface2 : theme.accent,
        color: theme.accentInk,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
        fontSize: Math.round(size * 0.4),
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

function ApplyOrStatusCard({ offering, whoami, message, setMessage, preferredSlug, setPreferredSlug, apply, embedded }: ApplyOrStatusProps & { embedded?: boolean }) {
  // `embedded` skips the outer <Card> wrapper — the caller has already
  // wrapped this in their own Card so we just render bare contents.
  const Wrap: React.FC<{ children: React.ReactNode }> = embedded
    ? ({ children }) => <>{children}</>
    : ({ children }) => <Card>{children}</Card>;

  // Show approved share link when active partnership exists. Hide the
  // apply form for pending/cancelled (cancelled is rare; the creator
  // can still re-apply through the rejected path if needed).
  if (!whoami?.creator) {
    return (
      <Wrap>
        {!embedded && <h3 style={{ marginTop: 0 }}>Apply to promote</h3>}
        <p style={{ color: theme.textMuted, margin: 0 }}>
          <Link to="/creator/signup" style={{ color: theme.accent }}>Sign up</Link> or <Link to="/creator/login" style={{ color: theme.accent }}>sign in</Link> to apply.
        </p>
      </Wrap>
    );
  }

  if (offering.myStatus === 'approved') {
    return <ApprovedCard offering={offering} embedded={embedded} />;
  }

  if (offering.myStatus === 'pending') {
    return (
      <Wrap>
        {!embedded && <h3 style={{ marginTop: 0 }}>Application pending</h3>}
        <p style={{ color: theme.textMuted, fontSize: 13, margin: 0 }}>
          {embedded && <strong style={{ color: theme.text }}>Application pending. </strong>}
          You&rsquo;ve applied to {offering.vendorName}. They&rsquo;ll review and you&rsquo;ll get an email when they decide.
          Track it on <Link to="/creator/requests" style={{ color: theme.accent }}>My applications</Link>.
        </p>
      </Wrap>
    );
  }

  return (
    <Wrap>
      {!embedded && <h3 style={{ marginTop: 0 }}>{offering.myStatus === 'rejected' ? 'Re-apply' : 'Apply to promote'}</h3>}
      {offering.myStatus === 'rejected' && (
        <p style={{ color: theme.textMuted, fontSize: 13, marginTop: 0 }}>
          Your previous application was declined. You can try again with a different pitch.
        </p>
      )}
      <ErrorBanner error={apply.error} />
      {apply.error instanceof ApiError && apply.error.message === 'request_already_exists' && (
        <p style={{ color: theme.textMuted, fontSize: 13 }}>You already have a pending or active request for this program.</p>
      )}
      <div>
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
    </Wrap>
  );
}

/** Active partnership — fetch the share URL from /creators/me/partnerships
 *  and show it inline with a copy button. The flat partnerships endpoint
 *  already computes shareUrl (custom domain when verified, else the
 *  openpartner default). */
function ApprovedCard({ offering, embedded }: { offering: Offering; embedded?: boolean }) {
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

  const Wrap: React.FC<{ children: React.ReactNode }> = embedded
    ? ({ children }) => <>{children}</>
    : ({ children }) => <Card>{children}</Card>;

  return (
    <Wrap>
      {!embedded && <h3 style={{ marginTop: 0 }}>You&rsquo;re approved to promote this</h3>}
      {embedded && (
        <div style={{ fontSize: 14, fontWeight: 600, color: theme.success, marginBottom: 6 }}>
          ✓ Approved — your share link is ready
        </div>
      )}
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
    </Wrap>
  );
}
