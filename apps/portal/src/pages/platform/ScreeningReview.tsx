import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { alpha, theme } from '../../theme.js';
import { countryName } from '../../lib/CountryField.js';
import { Button, ErrorBanner, Label, Textarea, formatDate } from '../../ui.js';
import { Pill } from './components.js';
import {
  papi,
  friendlyPlatformError,
  type PayoutHoldReason,
  type PlatformScreening,
  type ScreeningDecision,
} from './lib.js';

/** How a hold reads in the ops console. */
export const HOLD_REASON_LABEL: Record<PayoutHoldReason, string> = {
  country_not_supported: 'Country not served',
  screening_review: 'Possible match: needs review',
  screening_confirmed: 'Confirmed match',
  screening_pending: 'Not screened yet',
};

/** One word for a screening's state, and its colour. */
export function ScreeningBadge({ screening }: { screening: Pick<PlatformScreening, 'result' | 'decision'> }) {
  const { result, decision } = screening;
  if (result === 'possible_match') {
    if (decision === 'cleared') return <Pill label="cleared" tone={{ bg: theme.successSoft, fg: theme.success }} />;
    if (decision === 'confirmed_match') return <Pill label="confirmed match" tone={{ bg: theme.dangerSoft, fg: theme.danger }} />;
    return <Pill label="possible match" tone={{ bg: theme.dangerSoft, fg: theme.danger }} />;
  }
  if (result === 'clear') return <Pill label="clear" tone={{ bg: theme.successSoft, fg: theme.success }} />;
  if (result === 'error') return <Pill label="error" tone={{ bg: theme.warnSoft, fg: theme.warn }} />;
  return <Pill label="not screened" tone={{ bg: theme.surface2, fg: theme.textMuted }} />;
}

/** The worst of a brand's latest screenings, for the card's summary line. */
export function screeningSummary(screenings: PlatformScreening[]): { text: string; color: string } {
  if (screenings.length === 0) return { text: 'Not screened yet', color: theme.textDim };
  if (screenings.some((s) => s.decision === 'confirmed_match')) return { text: 'Confirmed match', color: theme.danger };
  if (screenings.some((s) => s.result === 'possible_match' && !s.decision)) {
    return { text: 'Possible match: review below', color: theme.danger };
  }
  if (screenings.some((s) => s.result === 'error')) return { text: 'Screening failed: retry below', color: theme.warn };
  if (screenings.some((s) => s.result === 'skipped')) return { text: 'Not screened (no CSL key)', color: theme.textDim };
  if (screenings.some((s) => s.decision === 'cleared')) return { text: 'Cleared after review', color: theme.success };
  return { text: 'Clear', color: theme.success };
}

/**
 * A screening's matches, its review if it has one, and — for an admin on
 * an undecided possible match — the Clear / Confirm match form. Clearing
 * needs a note: it is the record of why the listed entry isn't them.
 */
export function ScreeningDetail({
  screening,
  canWrite,
  onReviewed,
}: {
  screening: PlatformScreening;
  canWrite: boolean;
  onReviewed: () => void;
}) {
  const [note, setNote] = useState('');
  const review = useMutation({
    mutationFn: (decision: ScreeningDecision) =>
      papi(`/platform-admin/screenings/${screening.id}/review`, {
        method: 'POST',
        body: { decision, note: note.trim() || undefined },
      }),
    onSuccess: onReviewed,
  });
  const open = screening.result === 'possible_match' && !screening.decision;

  function confirmMatch() {
    const consequence =
      screening.subjectKind === 'tenant'
        ? 'This rejects the brand and suspends it, without emailing them.'
        : 'Their Stripe payouts stay on hold.';
    if (window.confirm(`Confirm "${screening.screenedName}" is the listed party? ${consequence}`)) {
      review.mutate('confirmed_match');
    }
  }

  return (
    <div
      style={{
        background: theme.surface2,
        border: `1px solid ${open ? alpha(theme.danger, 0.333) : theme.borderSubtle}`,
        borderRadius: theme.radiusSm,
        padding: '10px 12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{screening.screenedName}</span>
        <ScreeningBadge screening={screening} />
        <span style={{ fontSize: 11.5, color: theme.textDim }}>
          {formatDate(screening.screenedAt, { relative: true })} · {screening.trigger.replace('_', ' ')}
          {screening.country ? ` · based in ${countryName(screening.country)}` : ''}
        </span>
      </div>

      {screening.matches.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {screening.matches.map((m, i) => (
            <div key={`${m.source}-${m.entryId ?? i}`} style={{ fontSize: 12.5, lineHeight: 1.45 }}>
              <span style={{ fontWeight: 600 }}>{m.name}</span>
              {m.score != null && <span style={{ color: theme.textMuted }}> · score {m.score}</span>}
              {m.type && <span style={{ color: theme.textMuted }}> · {m.type}</span>}
              <div style={{ fontSize: 11.5, color: theme.textDim }}>
                {m.source}
                {m.programs.length > 0 ? ` · ${m.programs.join(', ')}` : ''}
                {m.countries.length > 0 ? ` · ${m.countries.join(', ')}` : ''}
              </div>
            </div>
          ))}
        </div>
      )}

      {screening.result === 'error' && screening.errorDetail && (
        <div style={{ fontSize: 12, color: theme.warn, marginTop: 6 }}>The list didn’t answer: {screening.errorDetail}</div>
      )}

      {screening.decision && (
        <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 8 }}>
          {screening.decision === 'cleared' ? 'Cleared' : 'Confirmed'} by {screening.reviewedByEmail ?? 'an operator'}
          {screening.reviewedAt ? `, ${formatDate(screening.reviewedAt)}` : ''}
          {screening.decisionCarried ? ' (an earlier review of the same list entries)' : ''}
          {screening.reviewNote ? `: “${screening.reviewNote}”` : ''}
        </div>
      )}

      {open && canWrite && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <Label>Why (required to clear; stored on the record)</Label>
            <Textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Listed entry is an individual born 1958 in Tehran; this partner is a UK company registered in 2019."
              maxLength={2000}
            />
          </div>
          {review.error && <ErrorBanner error={friendlyPlatformError(review.error)} />}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button size="sm" disabled={review.isPending || note.trim().length < 3} onClick={() => review.mutate('cleared')}>
              {review.isPending && review.variables === 'cleared' ? 'Clearing…' : 'Clear: not them'}
            </Button>
            <Button size="sm" variant="danger" disabled={review.isPending} onClick={confirmMatch}>
              {review.isPending && review.variables === 'confirmed_match' ? 'Confirming…' : 'Confirm match'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
