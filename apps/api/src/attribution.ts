/**
 * Attribution engine — the core derivation from raw layers to commissioned revenue.
 *
 * Walks: Event.userId → Identity.clickId → Click → Campaign (rules).
 * Writes: Attribution (derived view), Commission (immutable ledger).
 *
 * Idempotent: the unique index on (eventId, model) means re-running this for
 * the same event is a no-op. This is what lets us safely re-trigger from any
 * event ingest path (identify stitch, event post, webhook) without dup rows.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import {
  TABLES,
  type AttributionModel,
  type AttributionRow,
  type CampaignRow,
  type ClickRow,
  type CommissionRule,
  type EventRow,
  type IdentityRow,
} from '@openpartner/db';

export interface AttributeResult {
  status: 'attributed' | 'no_identity' | 'no_click' | 'outside_window' | 'already_attributed';
  attributionId?: string;
  commissionId?: string;
}

export async function attributeEvent(
  db: Knex,
  event: EventRow,
  model: AttributionModel = 'last_click',
): Promise<AttributeResult> {
  const identity = await db<IdentityRow>(TABLES.Identity).where({ userId: event.userId }).first();
  if (!identity) return { status: 'no_identity' };

  const click = await db<ClickRow>(TABLES.Click).where({ id: identity.clickId }).first();
  if (!click) return { status: 'no_click' };
  if (click.fraudFlag) return { status: 'no_click' }; // flagged clicks don't earn commission

  const campaign = await db<CampaignRow>(TABLES.Campaign).where({ id: click.campaignId }).first();
  if (!campaign) return { status: 'no_click' };

  const windowMs = campaign.attributionWindowDays * 24 * 60 * 60 * 1000;
  if (new Date(event.ts).getTime() - new Date(click.ts).getTime() > windowMs) {
    return { status: 'outside_window' };
  }

  // Idempotent write — race-safe via unique (eventId, model).
  const attributionId = ulid();
  const insertResult = await db<AttributionRow>(TABLES.Attribution)
    .insert({
      id: attributionId,
      eventId: event.id,
      partnerId: click.partnerId,
      campaignId: click.campaignId,
      clickId: click.id,
      model,
      weight: '1.0000',
    })
    .onConflict(['eventId', 'model'])
    .ignore()
    .returning('id');

  if (insertResult.length === 0) {
    return { status: 'already_attributed' };
  }

  const commissionRule = parseCommissionRule(campaign.commissionRule);
  const amount = computeCommissionAmount(commissionRule, event);
  const commissionId = ulid();

  await db(TABLES.Commission).insert({
    id: commissionId,
    attributionId,
    partnerId: click.partnerId,
    amount: amount.toFixed(2),
    currency: event.currency ?? 'USD',
    status: 'accrued',
  });

  return { status: 'attributed', attributionId, commissionId };
}

/**
 * Retrigger attribution for any events already in the log for this user.
 * Called after an /attribution/identify stitch so late-binding identities
 * still get credit for events that arrived before the stitch.
 */
export async function attributeBacklogForUser(db: Knex, userId: string): Promise<number> {
  const events = await db<EventRow>(TABLES.Event).where({ userId }).orderBy('ts', 'asc');
  let attributed = 0;
  for (const event of events) {
    const result = await attributeEvent(db, event);
    if (result.status === 'attributed') attributed += 1;
  }
  return attributed;
}

function parseCommissionRule(raw: unknown): CommissionRule {
  // jsonb columns come back already parsed from pg.
  if (raw && typeof raw === 'object' && 'type' in raw) {
    return raw as CommissionRule;
  }
  throw new Error('Invalid commissionRule on Campaign');
}

export function computeCommissionAmount(rule: CommissionRule, event: Pick<EventRow, 'value'>): number {
  if (rule.type === 'fixed') {
    return rule.value;
  }
  const revenue = event.value ? Number(event.value) : 0;
  return Math.round(revenue * rule.value) / 100;
}
