import type { ReactNode } from 'react';
import { theme } from '../theme.js';

/**
 * "Complete your profile to apply."
 *
 * The Network refuses POST /offerings/:id/apply with
 *   409 { error: 'profile_incomplete', missing: [{ field, label }] }
 * while the creator's profile is incomplete (handle, avatar, bio,
 * categories, platforms). Two shapes reach the portal:
 *   - the creator proxy (/api/creator-api) passes the Network body through;
 *   - the brand's partner proxy (/network/offerings/:id/apply) wraps it as
 *     { error: 'network_call_failed', detail: '<Network body as JSON text>' }.
 */

export interface MissingProfileField {
  field: string;
  label: string;
}

function isMissingField(v: unknown): v is MissingProfileField {
  return !!v && typeof v === 'object' && typeof (v as MissingProfileField).label === 'string';
}

/** The missing fields when `err` is a profile_incomplete refusal, else
 *  null. An empty array means "incomplete, but no list came back". */
export function profileIncompleteFrom(err: unknown): MissingProfileField[] | null {
  if (!err || typeof err !== 'object') return null;
  const { status, detail } = err as { status?: unknown; detail?: unknown };
  if (status !== 409 || !detail || typeof detail !== 'object') return null;
  let body: unknown = detail;
  const wrapped = (detail as { detail?: unknown }).detail;
  if ((detail as { error?: unknown }).error === 'network_call_failed' && typeof wrapped === 'string') {
    try {
      body = JSON.parse(wrapped);
    } catch {
      // The proxy truncates long upstream bodies; still recognise the code.
      return wrapped.includes('"profile_incomplete"') ? [] : null;
    }
  }
  if (!body || typeof body !== 'object' || (body as { error?: unknown }).error !== 'profile_incomplete') return null;
  const missing = (body as { missing?: unknown }).missing;
  return Array.isArray(missing) ? missing.filter(isMissingField) : [];
}

/**
 * True when `err` is the Network's review refusal:
 *   403 { error: 'creator_not_approved' }
 * A new creator can't apply until an OpenPartner operator approves their
 * profile. Same two shapes as profile_incomplete above.
 */
export function notApprovedFrom(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { status, detail } = err as { status?: unknown; detail?: unknown };
  if (status !== 403 || !detail || typeof detail !== 'object') return false;
  if ((detail as { error?: unknown }).error === 'creator_not_approved') return true;
  const wrapped = (detail as { detail?: unknown }).detail;
  return (
    (detail as { error?: unknown }).error === 'network_call_failed' &&
    typeof wrapped === 'string' &&
    wrapped.includes('"creator_not_approved"')
  );
}

/** Subset of GET /creators/me the apply pages read up front. */
export interface ProfileCompleteness {
  profileComplete?: boolean;
  profileMissing?: MissingProfileField[];
  profileChecklist?: Array<MissingProfileField & { done: boolean }>;
  /** Operator review. Only the creator's own session gets it (a brand
   *  acting for its partner doesn't), and an older Network has none. */
  reviewStatus?: 'pending' | 'approved' | 'rejected';
}

/** The creator's own profile says the Network will refuse an application
 *  until an operator approves them. */
export function awaitingApproval(profile: ProfileCompleteness | null | undefined): boolean {
  return !!profile?.reviewStatus && profile.reviewStatus !== 'approved';
}

/** What's left before this profile can apply, or null when it can (or
 *  when the Network predates the checklist; the apply call still says). */
export function missingFromProfile(profile: ProfileCompleteness | null | undefined): MissingProfileField[] | null {
  if (!profile || profile.profileComplete !== false) return null;
  const fromChecklist = profile.profileChecklist?.filter((i) => !i.done).map(({ field, label }) => ({ field, label }));
  return fromChecklist ?? profile.profileMissing ?? [];
}

export function ProfileIncompleteNotice({ missing, link }: { missing: MissingProfileField[]; link: ReactNode }) {
  return (
    <div
      role="status"
      style={{
        border: `1px solid ${theme.border}`,
        borderLeft: `3px solid ${theme.warn}`,
        background: theme.warnSoft,
        borderRadius: theme.radiusSm,
        padding: 12,
        margin: '0 0 12px',
        fontSize: 13,
        lineHeight: 1.55,
      }}
    >
      <div style={{ fontWeight: 600, color: theme.text }}>Complete your profile to apply</div>
      <div style={{ color: theme.textMuted, marginTop: 2 }}>
        Brands only review applications from complete profiles.
        {missing.length > 0 ? <> Still missing: {missing.map((m) => m.label).join(', ')}.</> : null}
      </div>
      <div style={{ marginTop: 6 }}>{link}</div>
    </div>
  );
}

/** "You can apply once your profile is approved." For a rejected creator
 *  too: "hasn't been approved" is true either way, and the reason reaches
 *  them by email or as a message in their Network portal. */
export function ProfileReviewNotice() {
  return (
    <div
      role="status"
      style={{
        border: `1px solid ${theme.border}`,
        borderLeft: `3px solid ${theme.info}`,
        background: theme.infoSoft,
        borderRadius: theme.radiusSm,
        padding: 12,
        margin: '0 0 12px',
        fontSize: 13,
        lineHeight: 1.55,
      }}
    >
      <div style={{ fontWeight: 600, color: theme.text }}>Your profile hasn&rsquo;t been approved yet</div>
      <div style={{ color: theme.textMuted, marginTop: 2 }}>
        OpenPartner checks every new creator profile before brands see it. You can apply to programs once yours is
        approved.
      </div>
    </div>
  );
}
