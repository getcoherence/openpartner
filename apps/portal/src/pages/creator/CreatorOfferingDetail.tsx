import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
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

interface Offering {
  id: string;
  title: string;
  description: string | null;
  productUrl: string;
  vendorId: string;
  vendorName: string;
  terms: {
    commissionDescription?: string;
    cookieWindowDays?: number;
    payoutCadence?: string;
    payoutHoldbackDays?: number;
    bonuses?: string[];
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
    <Page title={offering?.title ?? 'Program'} subtitle={offering?.vendorName}>
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
        <>
          <Card>
            {offering.terms.commissionDescription && (
              <p style={{ color: theme.textMuted, fontSize: 14 }}>{offering.terms.commissionDescription}</p>
            )}
            {offering.description && <p style={{ marginTop: 8 }}>{offering.description}</p>}
            <p style={{ marginTop: 12 }}>
              <a href={offering.productUrl} target="_blank" rel="noopener noreferrer">View product →</a>
            </p>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12, color: theme.textMuted, fontSize: 13 }}>
              {offering.terms.cookieWindowDays != null && <span>Cookie window: {offering.terms.cookieWindowDays} days</span>}
              {offering.terms.payoutCadence && <span>Payouts: {offering.terms.payoutCadence}</span>}
              {offering.terms.payoutHoldbackDays != null && offering.terms.payoutHoldbackDays > 0 && (
                <span title="Time after a customer converts before the brand can approve + pay your commission. Aligns with their refund window or trial.">
                  Holdback: {offering.terms.payoutHoldbackDays} days
                </span>
              )}
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
