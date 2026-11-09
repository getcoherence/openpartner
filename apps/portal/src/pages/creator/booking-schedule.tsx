/**
 * A booking's delivery dates (the Network's docs/creator-storefront.md §9),
 * shared by the creator's and the brand's booking cards and dialogs.
 *
 * A booking can carry a go-live date, an optional draft date before it and
 * a number of revision rounds. The brand may propose them with its request;
 * the creator sets them on accepting or offering, and paying agrees them.
 * After that, dates move only when the other side accepts new ones. A date
 * is due by the end of that day anywhere, and a missed one is shown and
 * reminded about, nothing more.
 *
 * Every field is optional: a Network from before dates sends none of them,
 * and the cards then show nothing here.
 */
import { useState, type ReactNode } from 'react';
import { Button, Input, Label, Select, Textarea } from '../../ui.js';
import { theme } from '../../theme.js';

export interface BookingSchedule {
  goLiveBy: string | null;
  draftDueBy: string | null;
  revisionRounds: number | null;
  revisionsRequested: number;
  draftState: 'shared' | 'changes_requested' | 'approved' | null;
  draftSharedAt: string | null;
  draftApprovedAt: string | null;
  /** New dates one side proposed, waiting for the other. */
  proposal: { goLiveBy: string; draftDueBy: string | null; by: 'creator' | 'vendor'; at: string } | null;
  /** Paid, and a date passed with its step not done. */
  overdue: 'go_live' | 'draft' | null;
  /** Agreed but unpaid, and a date already passed: payment waits for new dates. */
  datesPassed: boolean;
  goLive: { onTime: boolean; daysLate: number } | null;
  draft: { onTime: boolean; daysLate: number } | null;
}

export const MAX_REVISION_ROUNDS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Today's calendar date, plus `days`. */
export function dateInDays(days: number, now = new Date()): string {
  return new Date(now.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** "Fri, Nov 20", with the year when it isn't this one. A calendar date
 *  reads the same everywhere, so it's formatted in UTC. */
export function formatDay(date: string, now = new Date()): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(d.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: 'numeric' }),
  });
}

export function roundsText(n: number): string {
  return n === 1 ? '1 revision round' : `${n} revision rounds`;
}

function lateText(l: { onTime: boolean; daysLate: number }): string {
  return l.onTime ? 'On time' : l.daysLate === 1 ? '1 day late' : `${l.daysLate} days late`;
}

// ----- the inputs, for accepting, offering and requesting -----

export interface ScheduleDraft {
  goLiveBy: string;
  draftDueBy: string;
  /** '' = none agreed. */
  revisionRounds: string;
}

export function scheduleDraftFrom(
  s: Partial<Pick<BookingSchedule, 'goLiveBy' | 'draftDueBy' | 'revisionRounds'>> | null | undefined,
  pkg?: { turnaroundDays?: number | null; revisionRounds?: number | null } | null,
): ScheduleDraft {
  const goLiveBy = s?.goLiveBy ?? (pkg?.turnaroundDays ? dateInDays(pkg.turnaroundDays) : '');
  const rounds = s?.revisionRounds ?? pkg?.revisionRounds ?? null;
  return { goLiveBy, draftDueBy: s?.draftDueBy ?? '', revisionRounds: rounds == null ? '' : String(rounds) };
}

/** Has the date ended everywhere? The Network's rule: a date is due by the
 *  end of that day at UTC−12, which is noon UTC the day after. */
export function datePassed(date: string, now = new Date()): boolean {
  return now.getTime() >= new Date(`${date}T12:00:00Z`).getTime() + DAY_MS;
}

/** What's wrong with the dates, in a few words; null when they can be sent. */
export function scheduleDraftProblem(d: ScheduleDraft, opts: { requireGoLive: boolean }): string | null {
  if (!d.goLiveBy) return opts.requireGoLive ? 'Pick a go-live date.' : d.draftDueBy ? 'A draft date needs a go-live date.' : null;
  if (datePassed(d.goLiveBy)) return 'That go-live date has passed.';
  if (d.goLiveBy > dateInDays(365)) return 'Pick a go-live date within a year.';
  if (d.draftDueBy && d.draftDueBy >= d.goLiveBy) return 'The draft is due before go-live.';
  if (d.draftDueBy && datePassed(d.draftDueBy)) return 'That draft date has passed.';
  return null;
}

/** The fields for the Network: all three, so a cleared one clears. */
export function scheduleBody(d: ScheduleDraft): { goLiveBy: string | null; draftDueBy: string | null; revisionRounds: number | null } {
  return {
    goLiveBy: d.goLiveBy || null,
    draftDueBy: d.goLiveBy && d.draftDueBy ? d.draftDueBy : null,
    revisionRounds: d.revisionRounds === '' ? null : Number(d.revisionRounds),
  };
}

export function ScheduleInputs({
  value,
  onChange,
  goLiveLabel = 'Goes live by',
  showRounds = true,
}: {
  value: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
  goLiveLabel?: string;
  showRounds?: boolean;
}) {
  // Today still lasts somewhere west of here.
  const min = dateInDays(-1);
  return (
    <div className="op-grid-collapse" style={{ display: 'grid', gridTemplateColumns: showRounds ? '1fr 1fr 1fr' : '1fr 1fr', gap: 10 }}>
      <div>
        <Label>{goLiveLabel}</Label>
        <Input type="date" aria-label={goLiveLabel} value={value.goLiveBy} min={min} onChange={(e) => onChange({ ...value, goLiveBy: e.target.value })} />
      </div>
      <div>
        <Label>Draft by (optional)</Label>
        <Input
          type="date"
          aria-label="Draft by"
          value={value.draftDueBy}
          min={min}
          max={value.goLiveBy || undefined}
          onChange={(e) => onChange({ ...value, draftDueBy: e.target.value })}
        />
      </div>
      {showRounds && (
        <div>
          <Label>Revision rounds</Label>
          <Select aria-label="Revision rounds" value={value.revisionRounds} onChange={(e) => onChange({ ...value, revisionRounds: e.target.value })}>
            <option value="">Not set</option>
            {Array.from({ length: MAX_REVISION_ROUNDS + 1 }, (_, n) => (
              <option key={n} value={String(n)}>{n}</option>
            ))}
          </Select>
        </div>
      )}
    </div>
  );
}

// ----- what both cards show -----

function Pill({ tone, children, title }: { tone: 'warn' | 'danger' | 'success' | 'muted'; children: ReactNode; title?: string }) {
  const c = {
    warn: { bg: theme.warnSoft, fg: theme.warn },
    danger: { bg: theme.dangerSoft, fg: theme.danger },
    success: { bg: theme.successSoft, fg: theme.success },
    muted: { bg: theme.surface2, fg: theme.textMuted },
  }[tone];
  return (
    <span title={title} style={{ display: 'inline-flex', alignItems: 'center', background: c.bg, color: c.fg, borderRadius: 999, padding: '1px 8px', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

/** "Overdue" or "Draft overdue", for lists. Nothing when on track. */
export function OverduePill({ schedule }: { schedule?: BookingSchedule | null }) {
  if (!schedule?.overdue) return null;
  return (
    <Pill tone="danger" title={schedule.overdue === 'draft' ? `Draft was due ${formatDay(schedule.draftDueBy ?? '')}` : `Was due to go live ${formatDay(schedule.goLiveBy ?? '')}`}>
      {schedule.overdue === 'draft' ? 'Draft overdue' : 'Overdue'}
    </Pill>
  );
}

/** The dates in one line, with where the booking stands against them. */
export function ScheduleLine({ schedule }: { schedule?: BookingSchedule | null }) {
  if (!schedule || (!schedule.goLiveBy && !schedule.draftDueBy && schedule.revisionRounds == null)) return null;
  const parts: ReactNode[] = [];
  if (schedule.goLiveBy) {
    parts.push(
      <span key="live">
        Goes live by <strong style={{ fontWeight: 500, color: theme.text }}>{formatDay(schedule.goLiveBy)}</strong>
        {schedule.goLive && <> · <LateText l={schedule.goLive} /></>}
      </span>,
    );
  }
  if (schedule.draftDueBy) {
    parts.push(
      <span key="draft">
        Draft by <strong style={{ fontWeight: 500, color: theme.text }}>{formatDay(schedule.draftDueBy)}</strong>
        {schedule.draft && <> · <LateText l={schedule.draft} /></>}
      </span>,
    );
  }
  if (schedule.revisionRounds != null) {
    parts.push(
      <span key="rounds">
        {roundsText(schedule.revisionRounds)}
        {schedule.revisionsRequested > 0 && ` (${schedule.revisionsRequested} used)`}
      </span>,
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, color: theme.textMuted, marginTop: 8 }}>
      {parts.map((p, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {i > 0 && <span aria-hidden="true">·</span>}
          {p}
        </span>
      ))}
      <OverduePill schedule={schedule} />
      {schedule.datesPassed && <Pill tone="warn">Dates passed</Pill>}
    </div>
  );
}

function LateText({ l }: { l: { onTime: boolean; daysLate: number } }) {
  return <span style={{ color: l.onTime ? theme.success : theme.warn }}>{lateText(l)}</span>;
}

// ----- changing the dates -----

/**
 * A waiting proposal (accept or decline it, or take back your own), and a
 * "Change dates" form that proposes new ones. Shown while the booking is
 * agreed and not yet delivered.
 */
export function ScheduleChange({
  schedule,
  side,
  otherName,
  pending,
  onPropose,
  onAnswer,
  onWithdraw,
}: {
  schedule: BookingSchedule;
  side: 'creator' | 'vendor';
  /** Who the other side is: "Acme", or the creator's name. */
  otherName: string;
  pending: boolean;
  onPropose: (dates: { goLiveBy: string; draftDueBy: string | null }) => void;
  onAnswer: (accept: boolean) => void;
  onWithdraw: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const draftFixed = schedule.draftSharedAt != null;
  const [value, setValue] = useState<ScheduleDraft>(() => scheduleDraftFrom(schedule));
  const p = schedule.proposal;
  const problem = scheduleDraftProblem(value, { requireGoLive: true });
  const unchanged = value.goLiveBy === (schedule.goLiveBy ?? '') && value.draftDueBy === (schedule.draftDueBy ?? '');

  return (
    <div style={{ marginTop: 8 }}>
      {p && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 13, background: theme.surface2, borderRadius: theme.radiusSm, padding: '8px 10px' }}>
          <span style={{ flex: 1, minWidth: 180 }}>
            {p.by === side ? 'You proposed' : `${otherName} proposed`}: go live by <strong style={{ fontWeight: 500 }}>{formatDay(p.goLiveBy)}</strong>
            {p.draftDueBy && (
              <>, draft by <strong style={{ fontWeight: 500 }}>{formatDay(p.draftDueBy)}</strong></>
            )}
          </span>
          {p.by === side ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={onWithdraw}>
              Withdraw
            </Button>
          ) : (
            <>
              <Button size="sm" disabled={pending} onClick={() => onAnswer(true)}>
                Accept dates
              </Button>
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => onAnswer(false)}>
                Decline
              </Button>
            </>
          )}
        </div>
      )}
      {editing ? (
        <div style={{ marginTop: 8 }}>
          <ScheduleInputs
            value={draftFixed ? { ...value, draftDueBy: schedule.draftDueBy ?? '' } : value}
            onChange={(v) => setValue(draftFixed ? { ...v, draftDueBy: schedule.draftDueBy ?? '' } : v)}
            goLiveLabel="New go-live date"
            showRounds={false}
          />
          {problem && value.goLiveBy && <div style={{ fontSize: 12, color: theme.danger, marginTop: 4 }}>{problem}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button
              size="sm"
              disabled={pending || !!problem || unchanged}
              onClick={() => {
                onPropose({ goLiveBy: value.goLiveBy, draftDueBy: value.draftDueBy || null });
                setEditing(false);
              }}
            >
              Propose dates
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        !p && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)} style={{ marginTop: 4, paddingLeft: 0 }}>
            {schedule.goLiveBy ? 'Change dates' : 'Set dates'}
          </Button>
        )
      )}
    </div>
  );
}

// ----- the draft (a checklist inside "paid") -----

/** Does this booking have a draft step to show? */
export function hasDraftStep(s?: BookingSchedule | null): s is BookingSchedule {
  return !!s && (s.draftDueBy != null || s.revisionRounds != null || s.draftState != null);
}

export function draftStatusText(s: BookingSchedule, side: 'creator' | 'vendor', otherName: string): string {
  switch (s.draftState) {
    case 'shared':
      return side === 'creator' ? `Draft shared. Waiting for ${otherName} to review it.` : 'Draft shared for your review.';
    case 'changes_requested':
      return side === 'creator' ? `${otherName} asked for changes.` : 'You asked for changes.';
    case 'approved':
      return 'Draft approved.';
    default:
      return side === 'creator' ? 'Share a draft for review before it goes live.' : `${otherName} shares a draft before it goes live.`;
  }
}

/** The creator shares a draft: a note with links, posted in the thread. */
export function ShareDraft({ pending, onShare, again }: { pending: boolean; onShare: (body: string) => void; again: boolean }) {
  const [body, setBody] = useState('');
  return (
    <div style={{ marginTop: 8 }}>
      <Textarea value={body} rows={2} maxLength={4000} onChange={(e) => setBody(e.target.value)} placeholder="A link to the draft, and anything to look at" aria-label="Draft" />
      <Button
        size="sm"
        disabled={pending || !body.trim()}
        onClick={() => {
          onShare(body.trim());
          setBody('');
        }}
        style={{ marginTop: 6 }}
      >
        {again ? 'Share new draft' : 'Share draft'}
      </Button>
    </div>
  );
}

/** The brand reviews a shared draft: approve it, or ask for changes. */
export function ReviewDraft({
  schedule,
  pending,
  onApprove,
  onChanges,
}: {
  schedule: BookingSchedule;
  pending: boolean;
  onApprove: () => void;
  onChanges: (body: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [body, setBody] = useState('');
  const left = schedule.revisionRounds == null ? null : Math.max(0, schedule.revisionRounds - schedule.revisionsRequested);
  return (
    <div style={{ marginTop: 8 }}>
      {asking ? (
        <>
          <Textarea value={body} rows={2} maxLength={4000} onChange={(e) => setBody(e.target.value)} placeholder="What to change" aria-label="Changes" />
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <Button
              size="sm"
              disabled={pending || !body.trim()}
              onClick={() => {
                onChanges(body.trim());
                setBody('');
                setAsking(false);
              }}
            >
              Send changes
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button size="sm" disabled={pending} onClick={onApprove}>
            Approve draft
          </Button>
          <Button size="sm" variant="secondary" disabled={pending || left === 0} onClick={() => setAsking(true)}>
            Ask for changes
          </Button>
          {left != null && <span style={{ fontSize: 12, color: theme.textDim }}>{left === 1 ? '1 round left' : `${left} rounds left`}</span>}
        </div>
      )}
    </div>
  );
}

/** The thread's one-line notes for the date and draft events. */
export function scheduleEventText(
  event: string,
  by: string | null,
  body: string | null,
  names: { creator: string; brand: string },
): string | null {
  const dates = body ? body.replace(/go live (\d{4}-\d{2}-\d{2})/, (_, d: string) => `go live by ${formatDay(d)}`).replace(/draft (\d{4}-\d{2}-\d{2})/, (_, d: string) => `draft by ${formatDay(d)}`) : null;
  switch (event) {
    case 'schedule_proposed':
      return `${by ?? 'Someone'} proposed new dates${dates ? `: ${dates}` : ''}`;
    case 'schedule_changed':
      return `${by ?? 'Someone'} accepted the new dates${dates ? `: ${dates}` : ''}`;
    case 'schedule_declined':
      return `${by ?? 'Someone'} declined the new dates`;
    case 'schedule_withdrawn':
      return `${by ?? 'Someone'} withdrew the new dates`;
    case 'draft_shared':
      return `${by ?? names.creator} shared a draft`;
    case 'changes_requested':
      return `${by ?? names.brand} asked for changes`;
    case 'draft_approved':
      return `${by ?? names.brand} approved the draft`;
    case 'draft_overdue':
      return `The draft was due ${body ? formatDay(body) : 'earlier'}`;
    case 'overdue':
      return `Overdue: it was due to go live ${body ? formatDay(body) : 'earlier'}`;
    default:
      return null;
  }
}
