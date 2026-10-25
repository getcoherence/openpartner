import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info, Mail, X } from 'lucide-react';
import { alpha, theme } from '../../theme.js';
import { Button, Card, ErrorBanner, formatDate } from '../../ui.js';
import { creatorApi } from './creator-api.js';

/**
 * Operator review on the creator side (the Network's creator-review.ts).
 *
 * Every new creator waits for an OpenPartner operator to approve them
 * before brands or the public see them. While they wait, the portal says
 * so, and shows anything the operator wrote to them ("please write your
 * profile in English") until they mark it read. Both read GET /creators/me,
 * sharing the ['creator-my-profile'] cache with the profile page and the
 * completion banner.
 */

/** Subset of GET /creators/me these read. Absent on an older Network. */
export interface CreatorReviewState {
  reviewStatus?: 'pending' | 'approved' | 'rejected';
  unreadMessageCount?: number;
  profileComplete?: boolean;
}

export interface CreatorMessage {
  id: string;
  body: string;
  createdAt: string;
  readAt: string | null;
}

const MESSAGES_KEY = ['creator-messages'];

function useMyProfile() {
  return useQuery({
    queryKey: ['creator-my-profile'],
    queryFn: () => creatorApi<CreatorReviewState>('/creators/me'),
    retry: false,
    staleTime: 60_000,
  });
}

function useMessages(enabled: boolean) {
  return useQuery({
    queryKey: MESSAGES_KEY,
    queryFn: () => creatorApi<{ messages: CreatorMessage[] }>('/creators/me/messages'),
    enabled,
    retry: false,
  });
}

function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => creatorApi(`/creators/me/messages/${id}/read`, { method: 'POST', body: {} }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: MESSAGES_KEY });
      void qc.invalidateQueries({ queryKey: ['creator-my-profile'] });
    },
  });
}

/**
 * Site-wide: unread messages from OpenPartner, then the review state once
 * the profile is complete (before that, the completion banner is the
 * blocker and says so). Messages stay until marked read; the review note
 * can be dismissed for the browser session.
 */
export function CreatorReviewBanners({ isMobile }: { isMobile: boolean }) {
  const { data: me } = useMyProfile();
  const unread = me?.unreadMessageCount ?? 0;
  const messages = useMessages(unread > 0);
  const markRead = useMarkRead();
  const [dismissed, setDismissed] = useState(() => readDismissed());

  const unreadMessages = (messages.data?.messages ?? []).filter((m) => !m.readAt);
  const review = me?.reviewStatus;
  const showReview = !dismissed && me?.profileComplete === true && (review === 'pending' || review === 'rejected');
  if (unreadMessages.length === 0 && !showReview) return null;

  function dismiss() {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* storage blocked: dismiss for this page view only */
    }
    setDismissed(true);
  }

  return (
    <div
      style={{
        maxWidth: 1280,
        margin: '0 auto',
        padding: isMobile ? '16px 16px 0' : '24px 40px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* Oldest first, so a conversation reads in order. */}
      {[...unreadMessages].reverse().map((m) => (
        <div
          key={m.id}
          role="region"
          aria-label="Message from OpenPartner"
          style={{
            display: 'flex',
            gap: 10,
            background: theme.infoSoft,
            border: `1px solid ${alpha(theme.info, 0.333)}`,
            borderLeft: `3px solid ${theme.info}`,
            borderRadius: theme.radiusMd,
            padding: '12px 14px',
            fontSize: 13,
            lineHeight: 1.55,
          }}
        >
          <Mail size={18} style={{ color: theme.info, flexShrink: 0, marginTop: 1 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, color: theme.text }}>
              Message from OpenPartner{' '}
              <span style={{ fontWeight: 400, color: theme.textMuted }}>· {formatDate(m.createdAt, { relative: true })}</span>
            </div>
            <div style={{ color: theme.text, marginTop: 4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</div>
            <div style={{ marginTop: 10 }}>
              <Button size="sm" variant="secondary" disabled={markRead.isPending && markRead.variables === m.id} onClick={() => markRead.mutate(m.id)}>
                Mark as read
              </Button>
            </div>
          </div>
        </div>
      ))}
      {markRead.error && <ErrorBanner error={markRead.error} />}

      {showReview && (
        <div
          role="region"
          aria-label="Profile review"
          style={{
            display: 'flex',
            gap: 10,
            background: review === 'rejected' ? theme.dangerSoft : theme.surface,
            border: `1px solid ${theme.border}`,
            borderLeft: `3px solid ${review === 'rejected' ? theme.danger : theme.accent}`,
            borderRadius: theme.radiusMd,
            padding: '12px 14px',
            fontSize: 13,
            lineHeight: 1.55,
            position: 'relative',
          }}
        >
          <Info size={18} style={{ color: review === 'rejected' ? theme.danger : theme.accent, flexShrink: 0, marginTop: 1 }} />
          <div style={{ flex: 1, minWidth: 0, color: theme.text, paddingRight: 24 }}>
            {review === 'pending' ? (
              <>
                <strong>Your profile is in review.</strong> OpenPartner checks every new creator profile before brands can
                see it. You can keep setting up in the meantime; this note goes away once you&rsquo;re approved.
              </>
            ) : (
              <>
                <strong style={{ color: theme.danger }}>Your profile wasn&rsquo;t approved for the OpenPartner Network.</strong>{' '}
                Brands can&rsquo;t find you and you can&rsquo;t apply to programs.
              </>
            )}
          </div>
          <button
            onClick={dismiss}
            aria-label="Dismiss the review note for this session"
            style={{
              position: 'absolute',
              top: 10,
              right: 10,
              background: 'transparent',
              border: 'none',
              color: theme.textMuted,
              cursor: 'pointer',
              padding: 2,
              display: 'inline-flex',
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Every message OpenPartner sent, for the profile page, with the gap
 *  below it. Nothing renders until there's at least one. */
export function CreatorMessagesCard() {
  const { data: me } = useMyProfile();
  // The count only covers unread ones, so ask once regardless; an older
  // Network answers 404 and the card stays hidden.
  const messages = useMessages(!!me);
  const markRead = useMarkRead();
  const list = messages.data?.messages ?? [];
  if (list.length === 0) return null;
  return (
    <Card style={{ marginBottom: 18 }}>
      <h3 style={{ marginTop: 0 }}>Messages from OpenPartner</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {list.map((m) => (
          <div
            key={m.id}
            style={{
              border: `1px solid ${theme.borderSubtle}`,
              background: m.readAt ? 'transparent' : theme.infoSoft,
              borderRadius: theme.radiusSm,
              padding: '10px 12px',
              fontSize: 13,
              lineHeight: 1.55,
            }}
          >
            <div style={{ color: theme.textMuted, fontSize: 12, marginBottom: 4 }}>
              {formatDate(m.createdAt, { relative: true })}
              {m.readAt ? '' : ' · unread'}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</div>
            {!m.readAt && (
              <div style={{ marginTop: 8 }}>
                <Button size="sm" variant="secondary" disabled={markRead.isPending && markRead.variables === m.id} onClick={() => markRead.mutate(m.id)}>
                  Mark as read
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

const DISMISS_KEY = 'op:creator-review-banner-dismissed';

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}
