/**
 * Campaign lifecycle status — computed at read time from
 * (startsAt, endsAt). Single source of truth for every gate:
 *   - Link create
 *   - Application apply / approve
 *   - Offering visibility on the Network
 *   - Commission attribution at event time
 *
 * Time-bound semantics:
 *   - status pertains to NOW (or `at` if passed) — does the campaign
 *     accept new activity?
 *   - commissionEarnable(at) gates per-event accrual: an event timed
 *     after endsAt doesn't earn even if the campaign is still
 *     accepting writes (clock drift, retroactive imports, etc.)
 */

export type CampaignStatus = 'scheduled' | 'active' | 'ended';

interface LifecycleFields {
  startsAt: Date | string | null;
  endsAt: Date | string | null;
}

function asDate(d: Date | string | null): Date | null {
  if (!d) return null;
  return d instanceof Date ? d : new Date(d);
}

export function campaignStatus(c: LifecycleFields, at: Date = new Date()): CampaignStatus {
  const start = asDate(c.startsAt);
  const end = asDate(c.endsAt);
  if (start && at < start) return 'scheduled';
  if (end && at >= end) return 'ended';
  return 'active';
}

/** True if the campaign currently accepts new partner applications,
 *  new Link creation, and surfaces in creator discovery. */
export function campaignAcceptsNewActivity(c: LifecycleFields, at?: Date): boolean {
  return campaignStatus(c, at) === 'active';
}

/** True if a commission may accrue against this campaign for an event
 *  dated `at`. False once endsAt has passed. Lets existing Links keep
 *  redirecting (URLs intact) while quietly stopping earnings. */
export function commissionEarnable(c: LifecycleFields, at: Date): boolean {
  return campaignStatus(c, at) !== 'ended';
}
