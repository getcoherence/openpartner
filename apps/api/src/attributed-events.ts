/**
 * Attributed conversions, newest first: each Attribution row with its
 * Event and the Click (and Link) it came through. Behind
 * GET /partners/:id/events and the MCP `recent_conversions` tool, so both
 * read the same rows.
 *
 * Every join names tenantId itself rather than leaving tenant scope to RLS
 * (see reporting.ts).
 */

import type { Knex } from 'knex';
import { TABLES } from '@openpartner/db';

export interface AttributedEventFilter {
  tenantId: string;
  /** At least one of partnerId and linkId. */
  partnerId?: string;
  linkId?: string;
  programId?: string;
  /** Only this event type. */
  type?: string;
  /** Only these event types (a partner's view: the brand's referral stages). */
  types?: readonly string[] | null;
  /** Event.ts window, both ends inclusive. */
  since?: Date;
  until?: Date;
  limit: number;
  offset?: number;
}

export interface AttributedEventRow {
  attributionId: string;
  attributionWeight: string;
  attributionModel: string;
  partnerId: string;
  programId: string;
  eventId: string;
  eventType: string;
  eventValue: string | null;
  eventCurrency: string | null;
  eventTs: Date;
  userId: string;
  clickId: string | null;
  clickReferer: string | null;
  clickLandingUrl: string | null;
  clickTs: Date | null;
  clickSubId: string | null;
  clickUtmSource: string | null;
  clickUtmMedium: string | null;
  clickUtmCampaign: string | null;
  clickUtmTerm: string | null;
  clickUtmContent: string | null;
  linkId: string | null;
  linkKey: string | null;
}

export async function attributedEvents(db: Knex, f: AttributedEventFilter): Promise<AttributedEventRow[]> {
  const { tenantId } = f;
  if (!f.partnerId && !f.linkId) throw new Error('[attributed-events] needs a partnerId or a linkId');
  return (await db(`${TABLES.Attribution} as a`)
    .join(`${TABLES.Event} as e`, 'e.id', 'a.eventId')
    .leftJoin(`${TABLES.Click} as cl`, (j) => j.on('cl.id', 'a.clickId').andOnVal('cl.tenantId', tenantId))
    .leftJoin(`${TABLES.Link} as l`, (j) => j.on('l.id', 'cl.linkId').andOnVal('l.tenantId', tenantId))
    .where('a.tenantId', tenantId)
    .andWhere('e.tenantId', tenantId)
    .modify((qb) => {
      if (f.partnerId) qb.andWhere('a.partnerId', f.partnerId);
      if (f.linkId) qb.andWhere('cl.linkId', f.linkId);
      if (f.types) qb.whereIn('e.type', f.types as string[]);
      if (f.programId) qb.andWhere('a.programId', f.programId);
      if (f.type) qb.andWhere('e.type', f.type);
      if (f.since) qb.andWhere('e.ts', '>=', f.since);
      if (f.until) qb.andWhere('e.ts', '<=', f.until);
    })
    .orderBy('e.ts', 'desc')
    .limit(f.limit)
    .offset(f.offset ?? 0)
    .select(
      'a.id as attributionId',
      'a.weight as attributionWeight',
      'a.model as attributionModel',
      'a.partnerId as partnerId',
      'a.programId as programId',
      'e.id as eventId',
      'e.type as eventType',
      'e.value as eventValue',
      'e.currency as eventCurrency',
      'e.ts as eventTs',
      'e.userId as userId',
      'cl.id as clickId',
      'cl.referer as clickReferer',
      'cl.landingUrl as clickLandingUrl',
      'cl.ts as clickTs',
      'cl.subId as clickSubId',
      'cl.utmSource as clickUtmSource',
      'cl.utmMedium as clickUtmMedium',
      'cl.utmCampaign as clickUtmCampaign',
      'cl.utmTerm as clickUtmTerm',
      'cl.utmContent as clickUtmContent',
      'l.id as linkId',
      'l.linkKey as linkKey',
    )) as AttributedEventRow[];
}
