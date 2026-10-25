/**
 * Tell the ops inbox when Network creators are ready for review.
 *
 * Every new creator waits for an operator's approval before brands or the
 * public see them (the Network's creator-review.ts), and most never finish
 * their profile, which hides them anyway. So the alert is for creators who
 * are pending AND complete: approving them is what puts them in front of
 * brands, and nothing else would tell an operator they're waiting.
 *
 * Same shape as the self-serve vendor alert (network-review-reconcile.ts):
 * one email per batch of newly ready creators, the reported ids remembered
 * in PlatformSetting so a creator waiting several runs isn't re-announced,
 * and nothing recorded when the send fails, so the next run retries.
 *
 * Hosted multi-tenant only, like the rest of the ops console.
 */

import { TABLES, type PlatformSettingRow } from '@openpartner/db';
import { db } from './db.js';
import { getTenancyMode } from './tenancy.js';
import { adminListCreators, platformNetworkUrl } from './network-client.js';
import { opsNetworkCreatorsPendingEmail } from './email-templates.js';
import { sendOpsEmail } from './platform-ops-mail.js';
import { getPortalBaseUrl } from './portal-url.js';

export interface CreatorReviewAlertResult {
  skipped?: string;
  /** Pending creators with a complete profile. */
  ready: number;
  /** Newly reported to the ops inbox this run. */
  alerted: number;
}

const ALERTED_KEY = 'network_creator_review_alerted';
/** Remember at most this many alerted creator ids (oldest dropped first). */
const ALERTED_MEMORY = 1000;

export async function alertOpsToCreatorsAwaitingReview(): Promise<CreatorReviewAlertResult> {
  if (getTenancyMode() !== 'multi') return { skipped: 'single_tenant', ready: 0, alerted: 0 };
  const networkUrl = platformNetworkUrl();
  if (!networkUrl || !process.env.NETWORK_ADMIN_API_KEY) {
    return { skipped: 'network_admin_not_configured', ready: 0, alerted: 0 };
  }

  const pending = await adminListCreators(networkUrl, { review: 'pending' });
  // A Network that predates the review gate ignores ?review= and returns
  // everyone without the field.
  if (pending.length > 0 && pending.every((c) => c.reviewStatus === undefined)) {
    return { skipped: 'network_predates_review_gate', ready: 0, alerted: 0 };
  }
  const ready = pending.filter((c) => c.reviewStatus === 'pending' && c.status === 'active' && c.profileComplete);
  if (ready.length === 0) return { ready: 0, alerted: 0 };

  const row = await db<PlatformSettingRow>(TABLES.PlatformSetting).where({ key: ALERTED_KEY }).first();
  const seen = new Set(((row?.value as { creatorIds?: string[] } | undefined)?.creatorIds ?? []).filter(Boolean));
  const fresh = ready.filter((c) => !seen.has(c.id));
  if (fresh.length === 0) return { ready: ready.length, alerted: 0 };

  const tmpl = opsNetworkCreatorsPendingEmail(
    fresh.map((c) => ({ name: c.name, handle: c.handle })),
    `${getPortalBaseUrl()}/platform/creators`,
  );
  const sent = await sendOpsEmail(db, tmpl, 'ops_network_creators_pending');
  if (!sent) return { ready: ready.length, alerted: 0 };

  const creatorIds = [...seen, ...fresh.map((c) => c.id)].slice(-ALERTED_MEMORY);
  await db(TABLES.PlatformSetting)
    .insert({ key: ALERTED_KEY, value: { creatorIds } as unknown as never, updatedByEmail: null, updatedAt: new Date() })
    .onConflict('key')
    .merge({ value: { creatorIds } as unknown as never, updatedAt: new Date() });
  return { ready: ready.length, alerted: fresh.length };
}
