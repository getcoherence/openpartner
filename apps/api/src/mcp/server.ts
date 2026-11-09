/**
 * The brand's MCP server (docs/mcp.md): read-only tools over the brand's
 * own attribution data, for an AI agent to join with ad-platform data.
 *
 * One McpServer per request (POST /mcp is stateless), bound to that
 * request's tenant transaction, so every query runs under the same tenant
 * scope and RLS as the REST API. Tools only read; none writes anything.
 *
 * Joining with ad data:
 *   - a link's `shareUrl` is the URL a partner puts in an ad or post;
 *   - `utmCampaign` is the utm_campaign the click arrived with;
 *   - `clickId` is the click the router passed to the landing page, as
 *     `cref=<clickId>` or in place of a `{click_id}` macro.
 */

import { McpServer } from '@modelcontextprotocol/server';
import type { Knex } from 'knex';
import { TABLES, type LinkRow, type PartnerRow, type ProgramRow } from '@openpartner/db';
import { offsetDateTime, z } from '../zod.js';
import { campaignStatus } from '../campaign-lifecycle.js';
import { tenantDefaultCurrency } from '../currency.js';
import { cursorTimestamp, decodeCursor, takePage, whereAfterCursor } from '../pagination.js';
import { shareUrlBase, type PortalLinkTenant } from '../portal-url.js';
import { attributedEvents } from '../attributed-events.js';
import { referralIdFor } from '../referrals.js';
import { REPORT_GROUPS, REPORT_SORTS, performanceReport, sortReport } from './report.js';

export const MCP_SERVER_NAME = 'openpartner';
/** Bumped when a tool's input or output changes meaning. */
export const MCP_SERVER_VERSION = '1.0.0';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The longest window get_performance reads at once. */
export const MAX_WINDOW_DAYS = 366;

export interface McpContext {
  db: Knex;
  tenantId: string;
  /** For building link URLs (portal-url.ts). */
  linkTenant: PortalLinkTenant;
}

const INSTRUCTIONS = `OpenPartner partner attribution data for one brand, read-only.
Programs contain partners; partners share tracking links. Clicks on a link lead to signups and paid conversions (Stripe invoices included), which earn the partner commission.
To join with ad-platform data: match a link's shareUrl (or linkKey) to the ad's destination URL, utmCampaign to the ad's utm_campaign, or clickId to the cref / {click_id} value the landing page received.
Amounts are per currency and never converted. Revenue is attributed revenue: the conversion's value times the partner's attribution weight; "net" subtracts refunds recorded so far.
Start with list_programs, then get_performance; use recent_conversions to inspect individual conversions.`;

const id = z.string().min(1).max(64);
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function result<T extends Record<string, unknown>>(out: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(out) }], structuredContent: out };
}

function failure(error: string, detail: string) {
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error, detail }) }] };
}

function partnerStatus(p: Pick<PartnerRow, 'revokedAt' | 'activatedAt'>): 'revoked' | 'invited' | 'active' {
  if (p.revokedAt) return 'revoked';
  return p.activatedAt ? 'active' : 'invited';
}

async function routerUrlOf(db: Knex, tenantId: string): Promise<string | null> {
  const row = await db(TABLES.Config).where({ tenantId, key: 'program_settings' }).first('value');
  const value = (row?.value ?? {}) as { routerUrl?: string | null };
  return value.routerUrl ?? null;
}

const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

// ---------- schemas ----------

const programOut = z.object({
  programId: z.string(),
  name: z.string(),
  status: z.enum(['scheduled', 'active', 'ended']),
  destinationUrl: z.string(),
  attributionModel: z.string(),
  attributionWindowDays: z.number(),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  createdAt: z.string(),
});

const partnerOut = z.object({
  partnerId: z.string(),
  name: z.string(),
  email: z.string(),
  status: z.enum(['active', 'invited', 'revoked']),
  createdAt: z.string(),
});

const linkOut = z.object({
  linkId: z.string(),
  linkKey: z.string(),
  shareUrl: z.string().nullable().describe('The URL partners share; null when a self-hosted brand has no router URL set'),
  destinationUrl: z.string().describe("Where the link lands: the link's override or the program's destination"),
  partnerId: z.string(),
  partnerName: z.string().nullable(),
  programId: z.string(),
  programName: z.string().nullable(),
  createdAt: z.string(),
});

const revenueOut = z.object({ currency: z.string(), gross: z.number(), refunded: z.number(), net: z.number() });
const commissionOut = z.object({
  currency: z.string(),
  accrued: z.number(),
  approved: z.number(),
  paid: z.number(),
  reversed: z.number(),
});

const performanceRowOut = z.object({
  linkId: z.string().nullable().optional(),
  linkKey: z.string().nullable().optional(),
  shareUrl: z.string().nullable().optional(),
  destinationUrl: z.string().nullable().optional(),
  utmCampaign: z.string().nullable().optional(),
  partnerId: z.string().nullable().optional(),
  partnerName: z.string().nullable().optional(),
  programId: z.string().nullable().optional(),
  programName: z.string().nullable().optional(),
  clicks: z.number(),
  attributedEvents: z.number().describe('Attribution rows, as the dashboard counts conversions'),
  signups: z.number(),
  paidConversions: z.number(),
  revenue: z.array(revenueOut),
  commission: z.array(commissionOut),
});

const conversionOut = z.object({
  eventId: z.string(),
  type: z.string(),
  value: z.number().nullable(),
  currency: z.string().nullable(),
  ts: z.string(),
  userId: z.string().describe("The brand's own id for the customer"),
  referralId: z.string(),
  partnerId: z.string(),
  programId: z.string(),
  attribution: z.object({ id: z.string(), model: z.string(), weight: z.number() }),
  click: z
    .object({
      clickId: z.string(),
      linkId: z.string().nullable(),
      linkKey: z.string().nullable(),
      ts: z.string().nullable(),
      landingUrl: z.string().nullable(),
      referer: z.string().nullable(),
      subId: z.string().nullable(),
      utmSource: z.string().nullable(),
      utmMedium: z.string().nullable(),
      utmCampaign: z.string().nullable(),
      utmTerm: z.string().nullable(),
      utmContent: z.string().nullable(),
    })
    .nullable(),
});

// ---------- server ----------

export function buildMcpServer(ctx: McpContext): McpServer {
  const { db, tenantId } = ctx;
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { instructions: INSTRUCTIONS });

  const programExists = async (programId: string) =>
    Boolean(await db(TABLES.Program).where({ id: programId, tenantId }).first('id'));
  const partnerExists = async (partnerId: string) =>
    Boolean(await db(TABLES.Partner).where({ id: partnerId, tenantId }).first('id'));
  const linkExists = async (linkId: string) => Boolean(await db(TABLES.Link).where({ id: linkId, tenantId }).first('id'));

  /** "not found" for the first filter naming nothing in this brand. */
  const checkFilters = async (f: { programId?: string; partnerId?: string; linkId?: string }) => {
    if (f.programId && !(await programExists(f.programId))) return failure('program_not_found', f.programId);
    if (f.partnerId && !(await partnerExists(f.partnerId))) return failure('partner_not_found', f.partnerId);
    if (f.linkId && !(await linkExists(f.linkId))) return failure('link_not_found', f.linkId);
    return null;
  };

  server.registerTool(
    'list_programs',
    {
      title: 'List programs',
      description: "The brand's partner programs, newest first, with each one's status, landing page and attribution rules.",
      inputSchema: z.object({}),
      outputSchema: z.object({ currency: z.string().describe("The brand's default currency"), programs: z.array(programOut) }),
      annotations: READ_ONLY,
    },
    async () => {
      const programs = (await db<ProgramRow>(TABLES.Program)
        .where({ tenantId })
        .orderBy([
          { column: 'createdAt', order: 'desc' },
          { column: 'id', order: 'desc' },
        ])
        .select('*')) as ProgramRow[];
      return result({
        currency: await tenantDefaultCurrency(db, tenantId),
        programs: programs.map((p) => ({
          programId: p.id,
          name: p.name,
          status: campaignStatus(p),
          destinationUrl: p.destinationUrl,
          attributionModel: String(p.attributionModel),
          attributionWindowDays: p.attributionWindowDays,
          startsAt: iso(p.startsAt),
          endsAt: iso(p.endsAt),
          createdAt: iso(p.createdAt)!,
        })),
      });
    },
  );

  server.registerTool(
    'list_partners',
    {
      title: 'List partners',
      description: "The brand's partners, newest first. Filter by program (enrolled partners) or status. Pages with nextCursor.",
      inputSchema: z.object({
        programId: id.optional().describe('Only partners enrolled in this program'),
        status: z.enum(['active', 'invited', 'revoked']).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 100'),
        cursor: z.string().max(200).optional().describe('nextCursor from the previous page'),
      }),
      outputSchema: z.object({ partners: z.array(partnerOut), nextCursor: z.string().nullable() }),
      annotations: READ_ONLY,
    },
    async (args) => {
      const limit = args.limit ?? 100;
      const notFound = await checkFilters({ programId: args.programId });
      if (notFound) return notFound;
      const query = db<PartnerRow>(`${TABLES.Partner} as p`)
        .where('p.tenantId', tenantId)
        .select('p.id', 'p.name', 'p.email', 'p.revokedAt', 'p.activatedAt', 'p.createdAt', cursorTimestamp(db, 'p.createdAt'))
        .orderBy([
          { column: 'p.createdAt', order: 'desc' },
          { column: 'p.id', order: 'desc' },
        ]);
      if (args.programId) {
        query.whereExists(
          db(TABLES.PartnerProgram)
            .where({ tenantId, programId: args.programId })
            .whereRaw('"partnerId" = "p"."id"')
            .select(db.raw('1')),
        );
      }
      if (args.status === 'revoked') query.whereNotNull('p.revokedAt');
      if (args.status === 'active') query.whereNull('p.revokedAt').whereNotNull('p.activatedAt');
      if (args.status === 'invited') query.whereNull('p.revokedAt').whereNull('p.activatedAt');
      if (args.cursor) {
        const decoded = decodeCursor(args.cursor);
        if (!decoded) return failure('invalid_cursor', 'Pass nextCursor from the previous page');
        whereAfterCursor(query, 'p.createdAt', 'p.id', decoded);
      }
      const { page, nextCursor } = takePage(
        (await query.limit(limit + 1)) as Array<PartnerRow & { _cursorTs: string }>,
        limit,
      );
      return result({
        partners: page.map((p) => ({
          partnerId: p.id,
          name: p.name,
          email: p.email,
          status: partnerStatus(p),
          createdAt: iso(p.createdAt)!,
        })),
        nextCursor,
      });
    },
  );

  /** Link rows with the URL a partner shares and the names around them. */
  const describeLinks = async (links: LinkRow[]) => {
    const base = shareUrlBase(ctx.linkTenant, await routerUrlOf(db, tenantId));
    const programs = new Map(
      ((await db(TABLES.Program)
        .where({ tenantId })
        .whereIn('id', [...new Set(links.map((l) => l.programId))])
        .select('id', 'name', 'destinationUrl')) as Array<{ id: string; name: string; destinationUrl: string }>).map((p) => [p.id, p]),
    );
    const partners = new Map(
      ((await db(TABLES.Partner)
        .where({ tenantId })
        .whereIn('id', [...new Set(links.map((l) => l.partnerId))])
        .select('id', 'name')) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]),
    );
    return links.map((l) => ({
      linkId: l.id,
      linkKey: l.linkKey,
      shareUrl: base ? `${base}/${encodeURIComponent(l.linkKey)}` : null,
      destinationUrl: l.destinationUrl ?? programs.get(l.programId)?.destinationUrl ?? '',
      partnerId: l.partnerId,
      partnerName: partners.get(l.partnerId) ?? null,
      programId: l.programId,
      programName: programs.get(l.programId)?.name ?? null,
      createdAt: iso(l.createdAt)!,
    }));
  };

  server.registerTool(
    'list_links',
    {
      title: 'List tracking links',
      description:
        "Partners' tracking links, newest first, each with the URL partners share (shareUrl) and where it lands. Filter by partner or program. Pages with nextCursor.",
      inputSchema: z.object({
        partnerId: id.optional(),
        programId: id.optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 100'),
        cursor: z.string().max(200).optional().describe('nextCursor from the previous page'),
      }),
      outputSchema: z.object({ links: z.array(linkOut), nextCursor: z.string().nullable() }),
      annotations: READ_ONLY,
    },
    async (args) => {
      const limit = args.limit ?? 100;
      const notFound = await checkFilters({ programId: args.programId, partnerId: args.partnerId });
      if (notFound) return notFound;
      const query = db<LinkRow>(TABLES.Link)
        .where({ tenantId })
        .select('*', cursorTimestamp(db, 'createdAt'))
        .orderBy([
          { column: 'createdAt', order: 'desc' },
          { column: 'id', order: 'desc' },
        ]);
      if (args.partnerId) query.where({ partnerId: args.partnerId });
      if (args.programId) query.where({ programId: args.programId });
      if (args.cursor) {
        const decoded = decodeCursor(args.cursor);
        if (!decoded) return failure('invalid_cursor', 'Pass nextCursor from the previous page');
        whereAfterCursor(query, 'createdAt', 'id', decoded);
      }
      const { page, nextCursor } = takePage((await query.limit(limit + 1)) as Array<LinkRow & { _cursorTs: string }>, limit);
      return result({ links: await describeLinks(page as LinkRow[]), nextCursor });
    },
  );

  server.registerTool(
    'get_performance',
    {
      title: 'Get performance',
      description: [
        'Clicks, signups, paid conversions, attributed revenue (gross, refunded, net) and commission (accrued, approved, paid, reversed) over a window, grouped by tracking link, utm_campaign, partner or program.',
        'Counts match the admin dashboard: clicks by click time, conversions by when they were attributed, commission by when it accrued. Refunds are those recorded so far.',
        'Link rows carry shareUrl and linkKey to join with ad destination URLs; a row with linkId null holds coupon and API clicks.',
        'Default window: the 30 days before until (default now). At most 366 days.',
      ].join(' '),
      inputSchema: z.object({
        groupBy: z.enum(REPORT_GROUPS),
        since: offsetDateTime().optional().describe('ISO 8601, inclusive'),
        until: offsetDateTime().optional().describe('ISO 8601, exclusive; default now'),
        programId: id.optional(),
        partnerId: id.optional(),
        linkId: id.optional(),
        sort: z.enum(REPORT_SORTS).optional().describe("Default revenue (net, in the brand's default currency)"),
        limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
        offset: z.number().int().min(0).optional(),
      }),
      outputSchema: z.object({
        groupBy: z.enum(REPORT_GROUPS),
        since: z.string(),
        until: z.string(),
        currency: z.string().describe("The brand's default currency, which sort ranks by"),
        totalRows: z.number(),
        nextOffset: z.number().nullable(),
        rows: z.array(performanceRowOut),
      }),
      annotations: READ_ONLY,
    },
    async (args) => {
      const until = args.until ? new Date(args.until) : new Date();
      const since = args.since ? new Date(args.since) : new Date(until.getTime() - 30 * DAY_MS);
      if (since >= until) return failure('invalid_window', 'since must be before until');
      if (until.getTime() - since.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
        return failure('window_too_long', `At most ${MAX_WINDOW_DAYS} days per call`);
      }
      const notFound = await checkFilters(args);
      if (notFound) return notFound;

      const currency = await tenantDefaultCurrency(db, tenantId);
      const all = sortReport(
        await performanceReport(db, {
          tenantId,
          since,
          until,
          programId: args.programId,
          partnerId: args.partnerId,
          linkId: args.linkId,
          groupBy: args.groupBy,
        }),
        args.sort ?? 'revenue',
        currency,
      );
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      const page = all.slice(offset, offset + limit);

      // Names and URLs for the page's rows.
      const linkIds = [...new Set(page.map((r) => r.key.linkId).filter((v): v is string => Boolean(v)))];
      const links = new Map(
        (await describeLinks(
          linkIds.length ? ((await db<LinkRow>(TABLES.Link).where({ tenantId }).whereIn('id', linkIds)) as LinkRow[]) : [],
        )).map((l) => [l.linkId, l]),
      );
      const partnerIds = [...new Set(page.map((r) => r.key.partnerId).filter((v): v is string => Boolean(v)))];
      const programIds = [...new Set(page.map((r) => r.key.programId).filter((v): v is string => Boolean(v)))];
      const partnerNames = new Map(
        (partnerIds.length
          ? ((await db(TABLES.Partner).where({ tenantId }).whereIn('id', partnerIds).select('id', 'name')) as Array<{ id: string; name: string }>)
          : []
        ).map((p) => [p.id, p.name]),
      );
      const programNames = new Map(
        (programIds.length
          ? ((await db(TABLES.Program).where({ tenantId }).whereIn('id', programIds).select('id', 'name')) as Array<{ id: string; name: string }>)
          : []
        ).map((p) => [p.id, p.name]),
      );

      const rows = page.map(({ key, ...measures }) => {
        const named: Record<string, string | null> = { ...key };
        if ('linkId' in key) {
          const link = key.linkId ? links.get(key.linkId) : undefined;
          named.linkKey = link?.linkKey ?? null;
          named.shareUrl = link?.shareUrl ?? null;
          named.destinationUrl = link?.destinationUrl ?? null;
        }
        if ('partnerId' in key) named.partnerName = key.partnerId ? (partnerNames.get(key.partnerId) ?? null) : null;
        if ('programId' in key) named.programName = key.programId ? (programNames.get(key.programId) ?? null) : null;
        return { ...named, ...measures };
      });

      return result({
        groupBy: args.groupBy,
        since: since.toISOString(),
        until: until.toISOString(),
        currency,
        totalRows: all.length,
        nextOffset: offset + limit < all.length ? offset + limit : null,
        rows,
      });
    },
  );

  server.registerTool(
    'recent_conversions',
    {
      title: 'Recent conversions',
      description:
        "One partner's or one tracking link's attributed conversions, newest first, each with the click it came through (clickId, utm parameters, landing page) for joining with ad data.",
      inputSchema: z.object({
        partnerId: id.optional().describe('Give partnerId, linkId or both'),
        linkId: id.optional(),
        programId: id.optional(),
        type: z.string().min(1).max(64).optional().describe('Only this event type, e.g. signup or invoice_paid'),
        since: offsetDateTime().optional().describe('Event time, ISO 8601, inclusive'),
        until: offsetDateTime().optional().describe('Event time, ISO 8601, inclusive'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 25'),
        offset: z.number().int().min(0).optional(),
      }),
      outputSchema: z.object({ conversions: z.array(conversionOut), nextOffset: z.number().nullable() }),
      annotations: READ_ONLY,
    },
    async (args) => {
      if (!args.partnerId && !args.linkId) return failure('partner_or_link_required', 'Give partnerId, linkId or both');
      const notFound = await checkFilters(args);
      if (notFound) return notFound;
      const limit = args.limit ?? 25;
      const offset = args.offset ?? 0;
      const rows = await attributedEvents(db, {
        tenantId,
        partnerId: args.partnerId,
        linkId: args.linkId,
        programId: args.programId,
        type: args.type,
        since: args.since ? new Date(args.since) : undefined,
        until: args.until ? new Date(args.until) : undefined,
        limit: limit + 1,
        offset,
      });
      const page = rows.slice(0, limit);
      return result({
        conversions: page.map((r) => ({
          eventId: r.eventId,
          type: r.eventType,
          value: r.eventValue != null ? Number(r.eventValue) : null,
          currency: r.eventCurrency,
          ts: iso(r.eventTs)!,
          userId: r.userId,
          referralId: referralIdFor(tenantId, r.userId),
          partnerId: r.partnerId,
          programId: r.programId,
          attribution: { id: r.attributionId, model: r.attributionModel, weight: Number(r.attributionWeight) },
          click: r.clickId
            ? {
                clickId: r.clickId,
                linkId: r.linkId,
                linkKey: r.linkKey,
                ts: iso(r.clickTs),
                landingUrl: r.clickLandingUrl,
                referer: r.clickReferer,
                subId: r.clickSubId,
                utmSource: r.clickUtmSource,
                utmMedium: r.clickUtmMedium,
                utmCampaign: r.clickUtmCampaign,
                utmTerm: r.clickUtmTerm,
                utmContent: r.clickUtmContent,
              }
            : null,
        })),
        nextOffset: rows.length > limit ? offset + limit : null,
      });
    },
  );

  return server;
}
