/**
 * Product-specific commissions (docs/product-commissions.md): what a sale
 * was for, and the validation for the two places products are written.
 *
 *   - A commission sub-rule's `products` (ruleProductsSchema): product or
 *     price ids the rule is limited to.
 *   - An Event's `metadata.products` (raw, written once at ingest): from
 *     Stripe's line items (the parsers below, called by
 *     routes/stripe-webhook.ts), or the `products` field of
 *     /attribution/events and /attribution/conversions
 *     (eventProductsInputSchema).
 *
 * The matching and the share a rule pays on are pure functions in
 * @openpartner/db (event-products.ts), shared with the portal. The engine
 * applies them in attribution.ts evaluateSubRule.
 */

import type { Knex } from 'knex';
import {
  MAX_EVENT_PRODUCTS,
  MAX_RULE_PRODUCTS,
  PRODUCT_TEXT_MAX,
  TABLES,
  type EventProduct,
} from '@openpartner/db';
import { fromStripeMinor } from './stripe-amounts.js';
import { z } from './zod.js';

/** A commission rule's product list. Omit the field for "every product";
 *  an empty list is refused rather than read as either. */
export const ruleProductsSchema = z
  .array(
    z.object({
      id: z.string().trim().min(1).max(PRODUCT_TEXT_MAX),
      name: z.string().trim().min(1).max(PRODUCT_TEXT_MAX).optional(),
    }),
  )
  .min(1)
  .max(MAX_RULE_PRODUCTS)
  .superRefine((refs, ctx) => {
    const seen = new Set<string>();
    refs.forEach((ref, i) => {
      if (seen.has(ref.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `product ${ref.id} is listed twice`, path: [i, 'id'] });
      }
      seen.add(ref.id);
    });
  });

/**
 * The `products` field of an event or conversion: one item per product
 * line. `amount` is the line's part of the event's value; with more than
 * one product every item needs one, since that's how a product-scoped
 * percent rule's share is worked out. A lone product is the whole sale.
 */
export const eventProductsInputSchema = z
  .array(
    z.object({
      id: z
        .string()
        .min(1)
        .max(PRODUCT_TEXT_MAX)
        .openapi({ description: 'Your product id, or a Stripe `prod_…`. Rules match on it.' }),
      price: z
        .string()
        .min(1)
        .max(PRODUCT_TEXT_MAX)
        .optional()
        .openapi({ description: 'A price, plan or SKU id. Rules can match on it instead.' }),
      name: z
        .string()
        .min(1)
        .max(PRODUCT_TEXT_MAX)
        .optional()
        .openapi({ description: 'Shown when the brand picks products for a rule.' }),
      amount: z
        .number()
        .nonnegative()
        .finite()
        .optional()
        .openapi({
          description: "This product's part of `value`, in the event's currency. Required on every item when there's more than one.",
        }),
      quantity: z.number().positive().finite().optional(),
    }),
  )
  .min(1)
  .max(MAX_EVENT_PRODUCTS)
  .openapi({
    description:
      "What was bought, one item per product, for commission rules limited to products. A percent rule pays on the matching products' share of `value`, split by the items' amounts. Stored as `metadata.products`. See docs/product-commissions.md.",
  })
  .superRefine((items, ctx) => {
    if (items.length < 2) return;
    items.forEach((item, i) => {
      if (item.amount === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'with more than one product, each needs its amount',
          path: [i, 'amount'],
        });
      }
    });
  });

export type EventProductsInput = z.infer<typeof eventProductsInputSchema>;

/** An event's stored metadata with the request's `products` field in it.
 *  The field wins over a `products` key sent inside `metadata`. */
export function metadataWithProducts(
  metadata: Record<string, unknown> | undefined,
  products: EventProductsInput | undefined,
): Record<string, unknown> {
  if (!products) return metadata ?? {};
  const { productsIncomplete: _ignored, ...rest } = metadata ?? {};
  return { ...rest, products: products.map(compactProduct) };
}

function compactProduct(p: EventProduct): EventProduct {
  const out: EventProduct = {};
  if (p.id !== undefined) out.id = p.id;
  if (p.price !== undefined) out.price = p.price;
  if (p.name !== undefined) out.name = p.name;
  if (p.amount !== undefined) out.amount = p.amount;
  if (p.quantity !== undefined) out.quantity = p.quantity;
  return out;
}

/**
 * SQL for "this Event (aliased "Event") has an item matching one of
 * `ids`", the same match as matchingProducts in @openpartner/db: an
 * object item whose string `id` or `price` is one of them. Used for the
 * earlier-sale lookups behind `first` / `subsequent` and recurringMonths.
 */
export function productMatchSql(db: Knex, ids: string[]): Knex.Raw {
  return db.raw(
    `exists (
      select 1
        from jsonb_array_elements(
          case when jsonb_typeof("Event"."metadata"->'products') = 'array'
               then "Event"."metadata"->'products' else '[]'::jsonb end
        ) as item
       where jsonb_typeof(item) = 'object'
         and ((jsonb_typeof(item->'id') = 'string' and item->>'id' = any(?::text[]))
           or (jsonb_typeof(item->'price') = 'string' and item->>'price' = any(?::text[])))
    )`,
    [ids, ids],
  );
}

// ── Stripe line items → products ──────────────────────────────────────────

type Loose = Record<string, unknown>;

/** The fields a product list adds to an Event's metadata. */
export interface ProductFields {
  products?: EventProduct[];
  productsIncomplete?: true;
}

function idOf(v: unknown): string | undefined {
  if (typeof v === 'string' && v.length > 0) return v;
  if (v && typeof v === 'object' && typeof (v as Loose).id === 'string') return (v as Loose).id as string;
  return undefined;
}

function obj(v: unknown): Loose | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : undefined;
}

function int(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A line before merging: ids, name, minor amount, quantity. */
interface RawLine {
  id?: string;
  price?: string;
  name?: string;
  minor?: number;
  quantity?: number;
}

/** Product and price of a Stripe price-like field: a Price object (with
 *  `product`), or a bare price id. */
function priceIds(price: unknown): { id?: string; price?: string } {
  if (typeof price === 'string') return { price };
  const p = obj(price);
  return p ? { id: idOf(p.product), price: idOf(p) } : {};
}

/** "1 × Pro (at $49.00 / month)" → "Pro". */
const QUANTITY_LINE = /^\d+(?:\.\d+)? × (.+?) \(at .+\)$/;

function lineName(description: unknown, proration: boolean): string | undefined {
  if (typeof description !== 'string' || description.length === 0) return undefined;
  const m = QUANTITY_LINE.exec(description);
  if (m) return m[1]!.slice(0, PRODUCT_TEXT_MAX);
  // "Unused time on Pro after 9 Nov 2026" names a credit, not a product.
  return proration ? undefined : description.slice(0, PRODUCT_TEXT_MAX);
}

function sumOf(list: unknown, amountOf: (entry: Loose) => number | undefined): number {
  if (!Array.isArray(list)) return 0;
  return list.reduce((s: number, entry) => s + (amountOf(obj(entry) ?? {}) ?? 0), 0);
}

/**
 * An invoice line (Stripe.InvoiceLineItem, any API version). From
 * 2025-03-31.basil the product and price are under
 * `pricing.price_details`; before it, `price` (a Price object) or `plan`.
 * The OpenPartner Stripe App's endpoints still deliver the older shape.
 * The amount is the line's after its discounts and credits, before tax: a tax-inclusive
 * price's tax is in `amount`, so it comes out (`taxes` with
 * tax_behavior inclusive from basil, `tax_amounts` marked inclusive
 * before).
 */
export function invoiceLine(line: unknown): RawLine {
  const l = obj(line) ?? {};
  const details = obj(obj(l.pricing)?.price_details);
  const ids = details
    ? { id: idOf(details.product), price: idOf(details.price) }
    : l.price != null
      ? priceIds(l.price)
      : priceIds(l.plan);
  const parent = obj(l.parent);
  const proration =
    l.proration === true ||
    obj(parent?.subscription_item_details)?.proration === true ||
    obj(parent?.invoice_item_details)?.proration === true;
  const amount = int(l.amount);
  const discounts = sumOf(l.discount_amounts, (d) => int(d.amount));
  // From basil, pretax_credit_amounts lists the line's discounts again
  // (counted above) and any credit grant applied to it, which also isn't
  // money paid for the product.
  const credits = sumOf(l.pretax_credit_amounts, (c) => (c.type === 'discount' ? 0 : int(c.amount)));
  const inclusiveTax =
    sumOf(l.taxes, (t) => (t.tax_behavior === 'inclusive' ? int(t.amount) : 0)) +
    sumOf(l.tax_amounts, (t) => (t.inclusive === true ? int(t.amount) : 0));
  return {
    ...ids,
    name: lineName(l.description, proration),
    minor: amount === undefined ? undefined : amount - discounts - credits - inclusiveTax,
    quantity: int(l.quantity),
  };
}

/** A Checkout Session line item (Stripe.LineItem): after discounts, before
 *  tax. A tax-inclusive rate's tax (`taxes[].rate.inclusive`) comes out. */
export function checkoutLine(item: unknown): RawLine {
  const i = obj(item) ?? {};
  const subtotal = int(i.amount_subtotal);
  const inclusiveTax = sumOf(i.taxes, (t) => (obj(t.rate)?.inclusive === true ? int(t.amount) : 0));
  return {
    ...priceIds(i.price),
    name: typeof i.description === 'string' && i.description ? i.description.slice(0, PRODUCT_TEXT_MAX) : undefined,
    minor: subtotal === undefined ? undefined : subtotal - (int(i.amount_discount) ?? 0) - inclusiveTax,
    quantity: int(i.quantity),
  };
}

/** A subscription item (Stripe.SubscriptionItem): its price × quantity. A
 *  tiered or metered price has no unit amount, so no amount. */
export function subscriptionLine(item: unknown): RawLine {
  const i = obj(item) ?? {};
  const unit = int(obj(i.price)?.unit_amount);
  const quantity = int(i.quantity);
  return {
    ...priceIds(i.price),
    minor: unit === undefined ? undefined : unit * (quantity ?? 1),
    quantity,
  };
}

/**
 * Lines → an Event's product fields. Lines with the same product and price
 * are merged (a renewal plus its proration, or one product across several
 * lines), amounts summed. More than MAX_EVENT_PRODUCTS left, or `complete`
 * false (Stripe had more lines than were read), marks the list incomplete:
 * a percent rule limited to products then pays nothing on the sale, rather
 * than a share worked out from part of it.
 */
export function productFields(lines: RawLine[], currency: string | null | undefined, complete = true): ProductFields {
  const merged = new Map<string, RawLine>();
  for (const line of lines) {
    const key = `${line.id ?? ''}\u0000${line.price ?? ''}`;
    const prev = merged.get(key);
    if (!prev) {
      merged.set(key, { ...line });
      continue;
    }
    prev.minor = prev.minor === undefined || line.minor === undefined ? undefined : prev.minor + line.minor;
    prev.quantity = prev.quantity === undefined || line.quantity === undefined ? prev.quantity ?? line.quantity : prev.quantity + line.quantity;
    prev.name ??= line.name;
  }
  const all = [...merged.values()];
  if (all.length === 0) return complete ? {} : { productsIncomplete: true };
  const products = all.slice(0, MAX_EVENT_PRODUCTS).map((line): EventProduct => {
    const p: EventProduct = {};
    if (line.id) p.id = line.id;
    if (line.price) p.price = line.price;
    if (line.name) p.name = line.name;
    if (line.minor !== undefined) p.amount = fromStripeMinor(line.minor, currency);
    if (line.quantity !== undefined) p.quantity = line.quantity;
    return p;
  });
  return complete && all.length <= MAX_EVENT_PRODUCTS ? { products } : { products, productsIncomplete: true };
}

// ── Products seen, for the rule editor ────────────────────────────────────

export interface SeenProduct {
  /** A product id, or a price id (kind 'price'). */
  id: string;
  kind: 'product' | 'price';
  /** The latest name a sale gave it, if any. */
  name: string | null;
  /** For a price: the product it belongs to. */
  productId: string | null;
  sales: number;
  lastSeenAt: string;
}

/** How far back the editor looks for products, and how many sales it reads. */
const SEEN_WINDOW_DAYS = 180;
const SEEN_SCAN_LIMIT = 5000;
const SEEN_RESULT_LIMIT = 200;

/**
 * Products and prices on this tenant's recent sales, newest first: the
 * suggestions the rule editor offers. Reads the latest SEEN_SCAN_LIMIT
 * Events with products in the last SEEN_WINDOW_DAYS.
 */
export async function seenProducts(db: Knex, tenantId: string): Promise<SeenProduct[]> {
  const rows = (await db.raw(
    `with recent as (
       select e.ts, e.metadata->'products' as products
         from ${q(TABLES.Event)} e
        where e."tenantId" = ?
          and e.ts > now() - make_interval(days => ?)
          and jsonb_typeof(e.metadata->'products') = 'array'
        order by e.ts desc
        limit ?
     ), items as (
       select r.ts, item
         from recent r, jsonb_array_elements(r.products) as item
        where jsonb_typeof(item) = 'object'
     ), keyed as (
       select ts, item->>'id' as id, 'product' as kind, item->>'name' as name, null::text as "productId"
         from items where jsonb_typeof(item->'id') = 'string'
       union all
       select ts, item->>'price', 'price', item->>'name', case when jsonb_typeof(item->'id') = 'string' then item->>'id' end
         from items where jsonb_typeof(item->'price') = 'string'
     )
     select id, kind,
            (array_agg(name order by ts desc) filter (where name is not null))[1] as name,
            (array_agg("productId" order by ts desc) filter (where "productId" is not null))[1] as "productId",
            count(*)::int as sales,
            max(ts) as "lastSeenAt"
       from keyed
      where id <> ''
      group by id, kind
      order by max(ts) desc, kind desc, id
      limit ?`,
    [tenantId, SEEN_WINDOW_DAYS, SEEN_SCAN_LIMIT, SEEN_RESULT_LIMIT],
  )) as { rows: Array<Omit<SeenProduct, 'lastSeenAt'> & { lastSeenAt: Date }> };
  return rows.rows.map((r) => ({ ...r, lastSeenAt: new Date(r.lastSeenAt).toISOString() }));
}

function q(table: string): string {
  return `"${table}"`;
}
