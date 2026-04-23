/**
 * Attribution engine.
 *
 * Walks: Event.userId → Identity[] → Click[] → Campaign (rules).
 *
 * The Identity table is multi-touch: every cref the SDK stitches against a
 * userId is recorded. For each event, we pull every click within the model's
 * window, then apply the model to distribute weight:
 *
 *   last_click  — 100% to the most-recent click
 *   first_click — 100% to the earliest click
 *   linear      — 1/N to each click
 *   position    — 40% first, 40% last, 20% split across the middle (U-shape)
 *
 * The attribution model comes from the Campaign of the most recent click
 * (rationale: the partner in "control" of the conversion is whichever one
 * the user most recently engaged with). Commission is accrued separately
 * per touch, proportional to the weight, using each click's own campaign's
 * commissionRule — partners don't subsidize each other.
 *
 * Idempotent: unique (eventId, model, clickId) blocks dup rows on retry.
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
  touches?: Array<{ clickId: string; partnerId: string; weight: number; attributionId: string; commissionId?: string }>;
  model?: AttributionModel;
}

interface ClickWithCampaign extends ClickRow {
  campaign: CampaignRow;
}

export async function attributeEvent(
  db: Knex,
  event: EventRow,
  modelOverride?: AttributionModel,
): Promise<AttributeResult> {
  const identities = await db<IdentityRow>(TABLES.Identity).where({ userId: event.userId });
  if (identities.length === 0) return { status: 'no_identity' };

  const clickIds = identities.map((i) => i.clickId);
  const clicks = await db<ClickRow>(TABLES.Click).whereIn('id', clickIds);
  const cleanClicks = clicks.filter((c) => !c.fraudFlag);
  if (cleanClicks.length === 0) return { status: 'no_click' };

  const campaignIds = Array.from(new Set(cleanClicks.map((c) => c.campaignId)));
  const campaigns = await db<CampaignRow>(TABLES.Campaign).whereIn('id', campaignIds);
  const campaignsById = new Map(campaigns.map((c) => [c.id, c]));

  // Clicks in-window relative to this event, with their campaign attached.
  const eligible: ClickWithCampaign[] = [];
  for (const click of cleanClicks) {
    const campaign = campaignsById.get(click.campaignId);
    if (!campaign) continue;
    const windowMs = campaign.attributionWindowDays * 24 * 60 * 60 * 1000;
    if (new Date(event.ts).getTime() - new Date(click.ts).getTime() > windowMs) continue;
    eligible.push({ ...click, campaign });
  }
  if (eligible.length === 0) return { status: 'outside_window' };

  eligible.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

  // Pick the model. Override wins; else use the most-recent click's campaign's model.
  const lastClick = eligible[eligible.length - 1]!;
  const model: AttributionModel = modelOverride ?? lastClick.campaign.attributionModel;

  const weights = applyModel(model, eligible.length);
  const touches = eligible.map((click, i) => ({ click, weight: weights[i]! }));

  const results: NonNullable<AttributeResult['touches']> = [];
  let allDup = true;

  for (const { click, weight } of touches) {
    if (weight === 0) continue;
    const attributionId = ulid();
    const insertRes = await db<AttributionRow>(TABLES.Attribution)
      .insert({
        id: attributionId,
        eventId: event.id,
        partnerId: click.partnerId,
        campaignId: click.campaignId,
        clickId: click.id,
        model,
        weight: weight.toFixed(4),
      })
      .onConflict(['eventId', 'model', 'clickId'])
      .ignore()
      .returning('id');

    if (insertRes.length === 0) continue; // dup — already attributed
    allDup = false;

    const rule = parseCommissionRule(click.campaign.commissionRule);
    const amount = computeCommissionAmount(rule, event) * weight;
    const commissionId = ulid();
    await db(TABLES.Commission).insert({
      id: commissionId,
      attributionId,
      partnerId: click.partnerId,
      amount: amount.toFixed(2),
      currency: event.currency ?? 'USD',
      status: 'accrued',
    });
    results.push({ clickId: click.id, partnerId: click.partnerId, weight, attributionId, commissionId });
  }

  if (allDup) return { status: 'already_attributed', model };
  return { status: 'attributed', touches: results, model };
}

export async function attributeBacklogForUser(db: Knex, userId: string): Promise<number> {
  const events = await db<EventRow>(TABLES.Event).where({ userId }).orderBy('ts', 'asc');
  let attributed = 0;
  for (const event of events) {
    const result = await attributeEvent(db, event);
    if (result.status === 'attributed') attributed += 1;
  }
  return attributed;
}

export function applyModel(model: AttributionModel, n: number): number[] {
  if (n === 0) return [];
  const w = new Array<number>(n).fill(0);

  if (model === 'last_click') {
    w[n - 1] = 1;
    return w;
  }
  if (model === 'first_click') {
    w[0] = 1;
    return w;
  }
  if (model === 'linear') {
    return w.map(() => 1 / n);
  }
  if (model === 'position') {
    if (n === 1) return [1];
    if (n === 2) return [0.5, 0.5];
    w[0] = 0.4;
    w[n - 1] = 0.4;
    const middle = 0.2 / (n - 2);
    for (let i = 1; i < n - 1; i += 1) w[i] = middle;
    return w;
  }
  // Unknown model — fall back to last click.
  w[n - 1] = 1;
  return w;
}

function parseCommissionRule(raw: unknown): CommissionRule {
  if (raw && typeof raw === 'object' && 'type' in raw) return raw as CommissionRule;
  throw new Error('Invalid commissionRule on Campaign');
}

export function computeCommissionAmount(rule: CommissionRule, event: Pick<EventRow, 'value'>): number {
  if (rule.type === 'fixed') return rule.value;
  const revenue = event.value ? Number(event.value) : 0;
  return Math.round(revenue * rule.value) / 100;
}
