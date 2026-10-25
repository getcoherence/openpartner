/**
 * Tell the ops inbox when Network creators are ready for review.
 *
 * Every new creator waits for an operator's approval before brands or the
 * public see them (the Network's creator-review.ts), and most never finish
 * their profile, which hides them anyway. So the alert is for creators who
 * are pending AND complete: approving them is what puts them in front of
 * brands, and nothing else would tell an operator they're waiting.
 *
 * A creator is announced once when they're first ready, and again when they
 * edit their profile after an operator wrote to them: "please write your
 * profile in English" promises another look once they do.
 *
 * Same shape as the self-serve vendor alert (network-review-reconcile.ts):
 * one email per batch, what was reported remembered in PlatformSetting
 * (creator id → when we last announced them), and nothing recorded when the
 * send fails, so the next run retries.
 *
 * Hosted multi-tenant only, like the rest of the ops console.
 */

import { TABLES, type PlatformSettingRow } from '@openpartner/db';
import { db } from './db.js';
import { getTenancyMode } from './tenancy.js';
import { adminListCreators, platformNetworkUrl, type NetworkCreatorSummary } from './network-client.js';
import { opsNetworkCreatorsPendingEmail } from './email-templates.js';
import { sendOpsEmail } from './platform-ops-mail.js';
import { getPortalBaseUrl } from './portal-url.js';

export interface CreatorReviewAlertResult {
  skipped?: string;
  /** Pending creators with a complete profile. */
  ready: number;
  /** Newly reported to the ops inbox this run (first time, or edited
   *  since a message). */
  alerted: number;
}

const ALERTED_KEY = 'network_creator_review_alerted';
/** Remember at most this many creators (least recently announced dropped). */
const ALERTED_MEMORY = 1000;

type Alerted = Record<string, string>;

/** Edited their profile after the operator's last message, and after we
 *  last announced them. */
function updatedAfterMessage(c: NetworkCreatorSummary, alertedAt: string): boolean {
  if (!c.lastMessageAt || !c.profileUpdatedAt) return false;
  const edited = new Date(c.profileUpdatedAt).getTime();
  return edited > new Date(c.lastMessageAt).getTime() && edited > new Date(alertedAt).getTime();
}

export async function alertOpsToCreatorsAwaitingReview(now = new Date()): Promise<CreatorReviewAlertResult> {
  if (getTenancyMode() !== 'multi') return { skipped: 'single_tenant', ready: 0, alerted: 0 };
  const networkUrl = platformNetworkUrl();
  if (!networkUrl || !process.env.NETWORK_ADMIN_API_KEY) {
    return { skipped: 'network_admin_not_configured', ready: 0, alerted: 0 };
  }

  const pending = await adminListCreators(networkUrl, { review: 'pending', complete: true });
  // A Network that predates the review gate ignores the filters and
  // returns everyone without the field.
  if (pending.length > 0 && pending.every((c) => c.reviewStatus === undefined)) {
    return { skipped: 'network_predates_review_gate', ready: 0, alerted: 0 };
  }
  const ready = pending.filter((c) => c.reviewStatus === 'pending' && c.status === 'active' && c.profileComplete);
  if (ready.length === 0) return { ready: 0, alerted: 0 };

  const row = await db<PlatformSettingRow>(TABLES.PlatformSetting).where({ key: ALERTED_KEY }).first();
  const alerted: Alerted = { ...((row?.value as { creators?: Alerted } | undefined)?.creators ?? {}) };
  const fresh = ready.filter((c) => !alerted[c.id]);
  const updated = ready.filter((c) => alerted[c.id] && updatedAfterMessage(c, alerted[c.id]!));
  if (fresh.length === 0 && updated.length === 0) return { ready: ready.length, alerted: 0 };

  const label = (c: NetworkCreatorSummary) => ({ name: c.name, handle: c.handle });
  const tmpl = opsNetworkCreatorsPendingEmail(fresh.map(label), `${getPortalBaseUrl()}/platform/creators`, updated.map(label));
  const sent = await sendOpsEmail(db, tmpl, 'ops_network_creators_pending');
  if (!sent) return { ready: ready.length, alerted: 0 };

  for (const c of [...fresh, ...updated]) alerted[c.id] = now.toISOString();
  const creators = Object.fromEntries(
    Object.entries(alerted)
      .sort(([, a], [, b]) => a.localeCompare(b))
      .slice(-ALERTED_MEMORY),
  );
  await db(TABLES.PlatformSetting)
    .insert({ key: ALERTED_KEY, value: { creators } as unknown as never, updatedByEmail: null, updatedAt: now })
    .onConflict('key')
    .merge({ value: { creators } as unknown as never, updatedAt: now });
  return { ready: ready.length, alerted: fresh.length + updated.length };
}
