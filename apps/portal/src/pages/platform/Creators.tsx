import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { alpha, theme } from '../../theme.js';
import { Button, Card, ErrorBanner, Label, Page, Textarea, formatDate } from '../../ui.js';
import { ApprovalBadge } from './components.js';
import {
  papi,
  friendlyPlatformError,
  type ApprovalStatus,
  type NetworkCreator,
  type NetworkCreatorMessage,
  type PlatformOperator,
} from './lib.js';

type Filter = ApprovalStatus | 'all' | 'blocked' | 'incomplete' | 'imports';

const REVIEW_FILTERS: { key: Filter; label: string }[] = [
  { key: 'pending', label: 'Pending review' },
  { key: 'approved', label: 'Approved' },
  { key: 'rejected', label: 'Rejected' },
];

const OTHER_FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'incomplete', label: 'Incomplete' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'imports', label: 'Import conflicts' },
];

const hasImportConflict = (c: NetworkCreator) => (c.importConflicts ?? []).length > 0;

function matches(c: NetworkCreator, f: Filter): boolean {
  switch (f) {
    case 'pending':
    case 'approved':
    case 'rejected':
      return c.reviewStatus === f && c.status !== 'blocked';
    case 'blocked':
      return c.status === 'blocked';
    case 'incomplete':
      return !c.profileComplete;
    case 'imports':
      return hasImportConflict(c);
    default:
      return true;
  }
}

/** Where an imported storefront came from, as a link-like label. */
function importSourceLabel(source: string, sourceKey: string): string {
  return source === 'passionfroot' ? `passionfroot.me/${sourceKey}` : `${source}: ${sourceKey}`;
}

/** The note most non-English profiles need; the operator edits it before
 *  sending. */
function englishOnlyTemplate(name: string): string {
  return [
    `Hi ${name},`,
    ``,
    `Thanks for joining OpenPartner! The OpenPartner Network is an English-language platform, and brands review creator profiles in English.`,
    ``,
    `Please update your name and bio in English. We'll review your profile again as soon as you do.`,
  ].join('\n');
}

interface ReviewVars {
  status: ApprovalStatus;
  reason?: string;
  notifyCreator: boolean;
}

interface MessageVars {
  body: string;
  email: boolean;
}

/**
 * Network creators (partners). These live on the Network coordinator, not in
 * any one brand's database — a creator is ONE identity across every brand.
 *
 * Every new creator waits here for review: brands and the public don't see
 * them (discovery, public profile, storefront) and they can't apply to
 * programs until approved. Messages show in the creator's portal and are
 * emailed by default. Blocking is the stronger, network-wide takedown that
 * also signs them out. A brand removing a partner from just its own roster
 * is a separate, brand-level action.
 */
export function CreatorsPage({ operator }: { operator: PlatformOperator }) {
  const [filter, setFilter] = useState<Filter | null>(null);
  const qc = useQueryClient();
  const canWrite = operator.role === 'admin';

  const creators = useQuery({
    queryKey: ['platform-creators'],
    queryFn: () => papi<{ creators: NetworkCreator[] }>('/platform-admin/creators'),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['platform-creators'] });

  const block = useMutation({
    mutationFn: (v: { id: string; reason: string }) =>
      papi(`/platform-admin/creators/${v.id}/block`, { method: 'POST', body: { reason: v.reason } }),
    onSuccess: invalidate,
  });
  const unblock = useMutation({
    mutationFn: (id: string) => papi(`/platform-admin/creators/${id}/unblock`, { method: 'POST' }),
    onSuccess: invalidate,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const remind = useMutation({
    mutationFn: (c: NetworkCreator) =>
      papi<{ step: number }>(`/platform-admin/creators/${c.id}/remind`, { method: 'POST' }),
    onSuccess: (r, c) => {
      setNotice(`Profile reminder ${r.step} of 3 sent to ${c.email}.`);
      void invalidate();
    },
  });

  const review = useMutation({
    mutationFn: (v: ReviewVars & { creator: NetworkCreator }) =>
      papi<{ notified: boolean }>(`/platform-admin/creators/${v.creator.id}/review`, {
        method: 'POST',
        body: { status: v.status, reason: v.reason?.trim() || undefined, notifyCreator: v.notifyCreator },
      }),
    onSuccess: (r, v) => {
      const emailed = r.notified ? ' · creator emailed' : '';
      setNotice(
        v.status === 'approved'
          ? `${v.creator.name} approved — ${
              v.creator.profileComplete ? 'brands can find them now' : 'brands will find them once their profile is complete'
            }${emailed}.`
          : v.status === 'rejected'
            ? `${v.creator.name} rejected — hidden from brands and the public${emailed}.`
            : `${v.creator.name} is back in the review queue — hidden until approved.`,
      );
      void invalidate();
    },
  });

  const message = useMutation({
    mutationFn: (v: MessageVars & { creator: NetworkCreator }) =>
      papi<{ emailed: boolean }>(`/platform-admin/creators/${v.creator.id}/messages`, {
        method: 'POST',
        body: { body: v.body, email: v.email },
      }),
    onSuccess: (r, v) => {
      setNotice(
        `Message sent to ${v.creator.name}${
          r.emailed ? ' and emailed' : v.email ? ' — the email failed, but it’s in their portal' : ' (in their portal only)'
        }.`,
      );
      void invalidate();
      void qc.invalidateQueries({ queryKey: ['platform-creator-messages', v.creator.id] });
    },
  });

  // A storefront page imported by the wrong account: release it so the
  // owner can import it (the Network's docs/creator-storefront.md §7.3).
  const release = useMutation({
    mutationFn: (claimId: string) =>
      papi<{ released: { source: string; sourceKey: string } }>(`/platform-admin/storefront-imports/${claimId}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      setNotice(`Released ${importSourceLabel(r.released.source, r.released.sourceKey)}. The other account can import it now.`);
      void invalidate();
    },
  });

  const all = creators.data?.creators ?? [];
  // A Network from before creator review has no review state to filter on.
  const reviewSupported = all.some((c) => c.reviewStatus !== undefined);
  const active: Filter = filter ?? (reviewSupported ? 'pending' : 'all');
  const filters = reviewSupported ? [...REVIEW_FILTERS, ...OTHER_FILTERS] : OTHER_FILTERS;
  const rows = all.filter((c) => matches(c, active));
  // The queue leads with creators who finished their profile: approving
  // them is what puts them in front of brands.
  if (active === 'pending') rows.sort((a, b) => Number(b.profileComplete) - Number(a.profileComplete));
  const actionError = block.error ?? unblock.error ?? remind.error ?? release.error ?? review.error ?? message.error;

  return (
    <Page
      title="Creators"
      subtitle="New creators wait here for review: brands and the public don’t see them until you approve. Blocking removes a creator everywhere and signs them out."
    >
      <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
        {filters.map((f) => {
          const isActive = active === f.key;
          const count = all.filter((c) => matches(c, f.key)).length;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                padding: '7px 14px',
                borderRadius: 999,
                fontSize: 13,
                fontWeight: isActive ? 600 : 500,
                cursor: 'pointer',
                color: isActive ? theme.accentInk : theme.textMuted,
                background: isActive ? theme.accent : theme.surface2,
                border: `1px solid ${isActive ? theme.accent : theme.border}`,
              }}
            >
              {f.label} ({count})
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
          You’re signed in as a read-only operator. Reviews, messages and blocking are disabled.
        </div>
      )}

      <ErrorBanner error={actionError ? friendlyPlatformError(actionError) : creators.error} />
      {notice && !actionError && (
        <div style={{ fontSize: 13, color: theme.success, marginBottom: 12 }}>{notice}</div>
      )}

      {creators.isLoading ? (
        <Card>Loading…</Card>
      ) : rows.length === 0 ? (
        <Card style={{ textAlign: 'center', color: theme.textDim, fontSize: 14, padding: '40px 24px' }}>
          {active === 'pending' ? 'No creators waiting for review.' : `No ${active === 'all' ? '' : active} creators.`}
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map((c) => (
            <CreatorCard
              key={c.id}
              creator={c}
              canWrite={canWrite}
              busy={
                (block.isPending && block.variables?.id === c.id) ||
                (unblock.isPending && unblock.variables === c.id)
              }
              onBlock={(reason) => block.mutate({ id: c.id, reason })}
              onUnblock={() => unblock.mutate(c.id)}
              reminding={remind.isPending && remind.variables?.id === c.id}
              onRemind={() => remind.mutate(c)}
              reviewing={review.isPending && review.variables?.creator.id === c.id}
              onReview={(v) => review.mutate({ creator: c, ...v })}
              messaging={message.isPending && message.variables?.creator.id === c.id}
              onMessage={(v, done) => message.mutate({ creator: c, ...v }, { onSuccess: done })}
              releasing={release.isPending ? release.variables : null}
              onRelease={(claimId) => release.mutate(claimId)}
            />
          ))}
        </div>
      )}
    </Page>
  );
}

function CreatorCard({
  creator: c,
  canWrite,
  busy,
  onBlock,
  onUnblock,
  reminding,
  onRemind,
  reviewing,
  onReview,
  messaging,
  onMessage,
  releasing,
  onRelease,
}: {
  creator: NetworkCreator;
  canWrite: boolean;
  busy: boolean;
  onBlock: (reason: string) => void;
  onUnblock: () => void;
  reminding: boolean;
  onRemind: () => void;
  reviewing: boolean;
  onReview: (v: ReviewVars) => void;
  messaging: boolean;
  /** `done` runs once the message is sent, to close the form. */
  onMessage: (v: MessageVars, done: () => void) => void;
  /** The claim being released, if any. */
  releasing: string | null;
  onRelease: (claimId: string) => void;
}) {
  const [panel, setPanel] = useState<'reject' | 'message' | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [notifyOnApprove, setNotifyOnApprove] = useState(true);
  const blocked = c.status === 'blocked';
  const review = c.reviewStatus;
  // Reminders only go to creators who proved their email by signing in.
  const canRemind =
    !blocked && !c.profileComplete && !c.emailOptOutAt && !!c.lastSignInAt && (c.remindersSent ?? 0) < 3;
  const messageCount = c.messageCount ?? 0;
  const editedSinceMessage =
    !!c.lastMessageAt && !!c.profileUpdatedAt && new Date(c.profileUpdatedAt) > new Date(c.lastMessageAt);

  return (
    <Card>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Avatar url={c.avatarUrl} name={c.name} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* dir="auto": a right-to-left name or bio reads the right way round. */}
            <span dir="auto" style={{ fontSize: 15, fontWeight: 600 }}>{c.name}</span>
            {c.handle && (
              <span style={{ fontSize: 12.5, color: theme.textDim, fontFamily: theme.fontMono }}>@{c.handle}</span>
            )}
            {review && !blocked && <ApprovalBadge status={review} />}
            {blocked && <Pill tone="danger">Blocked</Pill>}
            {!c.profileComplete && !blocked && <Pill tone="warn">Incomplete — hidden from discovery</Pill>}
            {hasImportConflict(c) && <Pill tone="warn">Storefront import conflict</Pill>}
          </div>

          <div style={{ fontSize: 12.5, color: theme.textMuted, marginTop: 3 }}>{c.email}</div>

          {c.bio && (
            <div
              dir="auto"
              style={{
                fontSize: 12.5,
                color: theme.textDim,
                marginTop: 6,
                whiteSpace: 'pre-wrap',
                // A reviewer reads the whole bio; elsewhere two lines will do.
                ...(review === 'pending'
                  ? {}
                  : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
              }}
            >
              {c.bio}
            </div>
          )}

          <div style={{ fontSize: 11.5, color: theme.textDim, marginTop: 6 }}>
            {c.affiliationCount} brand{c.affiliationCount === 1 ? '' : 's'} · {c.platformCount} platform
            {c.platformCount === 1 ? '' : 's'} · joined {formatDate(c.createdAt)}
            {c.categories.length > 0 ? ` · ${c.categories.join(', ')}` : ''}
          </div>

          {/* Text only, never links: it's whatever the creator typed. */}
          {review === 'pending' && (c.platforms ?? []).length > 0 && (
            <div style={{ fontSize: 11.5, color: theme.textMuted, marginTop: 4, wordBreak: 'break-all' }}>
              {c.platforms!.map((p) => (
                <span key={`${p.platform}:${p.handle}`} style={{ marginRight: 12 }}>
                  {p.platform} <span style={{ fontFamily: theme.fontMono }}>{p.handle}</span>
                  {p.followerCount != null ? ` · ${p.followerCount.toLocaleString()} followers` : ''}
                  {p.verified ? ' · verified' : ''}
                </span>
              ))}
            </div>
          )}

          {!c.profileComplete && c.profileMissing.length > 0 && (
            <div style={{ fontSize: 11.5, color: theme.warn, marginTop: 6 }}>
              Missing: {c.profileMissing.map((m) => m.label).join(' · ')}
            </div>
          )}

          {!c.profileComplete && (
            <div style={{ fontSize: 11.5, color: theme.textDim, marginTop: 4 }}>
              {!c.lastSignInAt
                ? 'Never signed in, so no reminders (email unconfirmed)'
                : c.emailOptOutAt
                  ? `Unsubscribed from reminders ${formatDate(c.emailOptOutAt, { relative: true })}`
                  : (c.remindersSent ?? 0) > 0
                    ? `${c.remindersSent} of 3 reminders sent${c.lastRemindedAt ? `, last ${formatDate(c.lastRemindedAt, { relative: true })}` : ''}`
                    : 'No reminders sent yet'}
            </div>
          )}

          {c.reviewedAt && review !== 'pending' && (
            <div style={{ fontSize: 11.5, color: review === 'rejected' ? theme.danger : theme.textDim, marginTop: 4 }}>
              {review === 'approved' ? 'Approved' : 'Rejected'} {formatDate(c.reviewedAt, { relative: true })}
              {c.reviewedByEmail ? ` by ${c.reviewedByEmail}` : ''}
              {c.reviewReason ? ` · ${c.reviewReason}` : ''}
            </div>
          )}

          {messageCount > 0 && (
            <div style={{ fontSize: 11.5, color: theme.textDim, marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span>
                {messageCount} message{messageCount === 1 ? '' : 's'} sent
                {c.lastMessageAt ? `, last ${formatDate(c.lastMessageAt, { relative: true })}` : ''}
                {(c.unreadMessageCount ?? 0) > 0 ? ` · ${c.unreadMessageCount} unread` : ' · read'}
              </span>
              {editedSinceMessage && <span style={{ color: theme.success }}>Profile edited since your last message</span>}
              <button
                onClick={() => setShowHistory((s) => !s)}
                style={{ background: 'none', border: 'none', padding: 0, color: theme.accent, cursor: 'pointer', fontSize: 11.5 }}
              >
                {showHistory ? 'Hide messages' : 'Show messages'}
              </button>
            </div>
          )}

          {(c.importConflicts ?? []).map((x) => (
            <div
              key={`${x.role}:${x.source}:${x.sourceKey}:${x.otherCreatorId ?? ''}`}
              style={{ fontSize: 11.5, color: theme.warn, marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}
            >
              <span>
                {x.role === 'refused'
                  ? `Tried to import ${importSourceLabel(x.source, x.sourceKey)}, already imported by ${x.otherEmail ?? 'a deleted account'}`
                  : `Imported ${importSourceLabel(x.source, x.sourceKey)}; ${x.otherEmail ?? 'another account'} tried to import it too`}
                {` · ${x.attempts} attempt${x.attempts === 1 ? '' : 's'}, last ${formatDate(x.lastAttemptAt, { relative: true })}`}
              </span>
              {canWrite && x.claimId && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={releasing === x.claimId}
                  onClick={() => {
                    const holder = x.role === 'claimant' ? c.email : (x.otherEmail ?? 'the current holder');
                    if (
                      window.confirm(
                        `Release ${importSourceLabel(x.source, x.sourceKey)} from ${holder}? Another account can then import it. What was already imported stays with ${holder}.`,
                      )
                    ) {
                      onRelease(x.claimId!);
                    }
                  }}
                >
                  {releasing === x.claimId ? 'Releasing…' : 'Release claim'}
                </Button>
              )}
            </div>
          ))}

          {blocked && (
            <div style={{ fontSize: 11.5, color: theme.danger, marginTop: 6 }}>
              {c.blockedReason ? `Reason: ${c.blockedReason}` : 'Blocked'}
              {c.blockedByEmail ? ` · by ${c.blockedByEmail}` : ''}
              {c.blockedAt ? ` · ${formatDate(c.blockedAt)}` : ''}
            </div>
          )}
        </div>

        {canWrite && (
          <div style={{ flexShrink: 0, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {review && !blocked && review !== 'approved' && (
              <>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: theme.textMuted, cursor: 'pointer' }}>
                  <input type="checkbox" checked={notifyOnApprove} onChange={(e) => setNotifyOnApprove(e.target.checked)} />
                  Email creator
                </label>
                <Button size="sm" disabled={reviewing} onClick={() => onReview({ status: 'approved', notifyCreator: notifyOnApprove })}>
                  {reviewing ? 'Saving…' : 'Approve'}
                </Button>
              </>
            )}
            {review && !blocked && review !== 'rejected' && (
              <Button size="sm" variant="secondary" disabled={reviewing} onClick={() => setPanel((p) => (p === 'reject' ? null : 'reject'))}>
                {review === 'approved' ? 'Revoke approval' : 'Reject'}
              </Button>
            )}
            {blocked ? (
              <Button size="sm" disabled={busy} onClick={onUnblock}>
                {busy ? 'Working…' : 'Unblock'}
              </Button>
            ) : (
              <Button
                variant="danger"
                size="sm"
                disabled={busy}
                onClick={() => {
                  const reason = window.prompt(
                    `Block ${c.name}? They'll be removed from the marketplace across every brand and signed out.\n\nReason (required):`,
                    '',
                  );
                  if (reason && reason.trim()) onBlock(reason.trim());
                }}
              >
                {busy ? 'Working…' : 'Block'}
              </Button>
            )}
          </div>
        )}
      </div>

      {canWrite && !blocked && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12, paddingLeft: 52 }}>
          {review && (
            <Button size="sm" variant="ghost" onClick={() => setPanel((p) => (p === 'message' ? null : 'message'))}>
              Message
            </Button>
          )}
          {review === 'approved' && (
            <Button
              size="sm"
              variant="ghost"
              disabled={reviewing}
              onClick={() => {
                if (window.confirm(`Hold ${c.name} for review? Brands and the public stop seeing them until you approve again.`)) {
                  onReview({ status: 'pending', notifyCreator: false });
                }
              }}
            >
              Hold for review
            </Button>
          )}
          {canRemind && (
            <Button size="sm" variant="ghost" disabled={reminding} onClick={onRemind}>
              {reminding ? 'Sending…' : 'Send reminder'}
            </Button>
          )}
        </div>
      )}

      {panel === 'reject' && (
        <RejectForm
          busy={reviewing}
          revoking={review === 'approved'}
          onCancel={() => setPanel(null)}
          onSubmit={(reason, notifyCreator) => {
            onReview({ status: 'rejected', reason, notifyCreator });
            setPanel(null);
          }}
        />
      )}

      {panel === 'message' && (
        <MessageForm
          creator={c}
          busy={messaging}
          onCancel={() => setPanel(null)}
          onSubmit={(v) => onMessage(v, () => setPanel(null))}
        />
      )}

      {showHistory && <MessageHistory creatorId={c.id} />}
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
  onSubmit: (reason: string, notifyCreator: boolean) => void;
}) {
  const [reason, setReason] = useState('');
  const [notifyCreator, setNotifyCreator] = useState(false);
  return (
    <FormPanel>
      <div style={{ fontSize: 14, fontWeight: 600, color: theme.danger }}>
        {revoking ? 'Revoke this creator’s approval' : 'Reject this creator'}
      </div>
      <div style={{ fontSize: 12.5, color: theme.textMuted, lineHeight: 1.5 }}>
        They disappear from brand discovery, their public profile and the storefront directory, and can’t apply to programs.
        They can still sign in and keep their existing partnerships. To ask for changes instead, send a message and leave
        them pending.
      </div>
      <div>
        <Label>Reason (stored on the record; included if you email the creator)</Label>
        <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={notifyCreator} onChange={(e) => setNotifyCreator(e.target.checked)} />
        Email the creator (leave off for spam, so you don’t confirm a live inbox)
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="danger" disabled={busy} onClick={() => onSubmit(reason, notifyCreator)}>
          {busy ? 'Saving…' : revoking ? 'Revoke approval' : 'Reject creator'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </FormPanel>
  );
}

function MessageForm({
  creator,
  busy,
  onCancel,
  onSubmit,
}: {
  creator: NetworkCreator;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (v: MessageVars) => void;
}) {
  const [body, setBody] = useState('');
  const [email, setEmail] = useState(true);
  return (
    <FormPanel>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Message {creator.name}</div>
        <button
          onClick={() => setBody(englishOnlyTemplate(creator.name))}
          style={{ background: 'none', border: 'none', padding: 0, color: theme.accent, cursor: 'pointer', fontSize: 12.5 }}
        >
          Use the English-only note
        </button>
      </div>
      <div style={{ fontSize: 12.5, color: theme.textMuted, lineHeight: 1.5 }}>
        Shown in their OpenPartner account until they mark it read. Replies to the email go to the ops inbox. Sending a message
        doesn’t change their review status.
      </div>
      <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} placeholder="Write to the creator…" />
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
        <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} />
        Also email it to {creator.email}
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button disabled={busy || body.trim() === ''} onClick={() => onSubmit({ body: body.trim(), email })}>
          {busy ? 'Sending…' : 'Send message'}
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </FormPanel>
  );
}

function MessageHistory({ creatorId }: { creatorId: string }) {
  const messages = useQuery({
    queryKey: ['platform-creator-messages', creatorId],
    queryFn: () => papi<{ messages: NetworkCreatorMessage[] }>(`/platform-admin/creators/${creatorId}/messages`),
  });
  return (
    <FormPanel>
      <ErrorBanner error={messages.error ? friendlyPlatformError(messages.error) : null} />
      {messages.isLoading ? (
        <div style={{ fontSize: 13, color: theme.textDim }}>Loading…</div>
      ) : (
        (messages.data?.messages ?? []).map((m) => (
          <div
            key={m.id}
            style={{
              background: theme.surface2,
              border: `1px solid ${theme.borderSubtle}`,
              borderRadius: theme.radiusSm,
              padding: '10px 12px',
            }}
          >
            <div style={{ fontSize: 11.5, color: theme.textDim, marginBottom: 6 }}>
              {formatDate(m.createdAt, { relative: true })}
              {m.sentByEmail ? ` · ${m.sentByEmail}` : ''}
              {m.emailedAt ? ' · emailed' : ' · portal only'}
              {m.readAt ? ` · read ${formatDate(m.readAt, { relative: true })}` : ' · unread'}
            </div>
            <div style={{ fontSize: 13, color: theme.text, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{m.body}</div>
          </div>
        ))
      )}
    </FormPanel>
  );
}

function FormPanel({ children }: { children: React.ReactNode }) {
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
      {children}
    </div>
  );
}

function Avatar({ url, name }: { url: string | null; name: string }) {
  if (url) {
    return (
      <img
        src={url}
        alt=""
        style={{ width: 40, height: 40, borderRadius: '50%', objectFit: 'cover', background: theme.surface2 }}
      />
    );
  }
  return (
    <div
      aria-hidden
      style={{
        width: 40,
        height: 40,
        borderRadius: '50%',
        background: theme.surface2,
        color: theme.textDim,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 15,
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {(name.trim()[0] ?? '?').toUpperCase()}
    </div>
  );
}

function Pill({ tone, children }: { tone: 'danger' | 'warn'; children: React.ReactNode }) {
  const color = tone === 'danger' ? theme.danger : theme.warn;
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        color,
        background: `${color}1a`,
        borderRadius: 4,
        padding: '2px 6px',
      }}
    >
      {children}
    </span>
  );
}
