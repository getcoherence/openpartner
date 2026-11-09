/**
 * Products on an Event, and the share of its value a product-scoped
 * commission rule pays on (docs/product-commissions.md).
 *
 * An Event can say what was bought in `metadata.products`: one item per
 * product line, written at ingest and never changed (raw data). Stripe
 * invoices, subscriptions and one-time Checkout sessions fill it in from
 * their line items; /attribution/events and /attribution/conversions take a
 * validated `products` field. A sub-rule's `products` list names product or
 * price ids, and the rule only pays on an Event with a matching item.
 *
 * A percent rule pays on the Event's value split in proportion to the
 * items' amounts. The split is of `value` (what was actually paid) rather
 * than a sum of the items' own amounts, so a sale of only matching
 * products pays exactly what an unscoped rule would.
 *
 * Pure functions, no I/O: the engine (apps/api/src/attribution.ts) and the
 * portal both import them. The engine's SQL for earlier sales
 * (productMatchSql in apps/api/src/product-commissions.ts) matches items
 * the same way matchingProducts does.
 */

/** One product line of an Event. `id` is the product (a Stripe `prod_…`,
 *  or the brand's own id); `price` is the Stripe price or plan it was sold
 *  at. `amount` is that line's part of the sale in the Event's currency,
 *  after line discounts and before tax; it may be negative (a proration
 *  credit). */
export interface EventProduct {
  id?: string;
  price?: string;
  name?: string;
  amount?: number;
  quantity?: number;
}

/** A product a commission rule is limited to: a product id or a price id.
 *  `name` is only for display (summaries, the editor). */
export interface CommissionProductRef {
  id: string;
  name?: string;
}

/** Most product lines an Event keeps. Stripe lines for the same product
 *  and price are merged first; past this the list is cut short and marked
 *  `productsIncomplete`. */
export const MAX_EVENT_PRODUCTS = 100;

/** Most products one commission rule can name. */
export const MAX_RULE_PRODUCTS = 50;

/** Longest product id, price id or name accepted. */
export const PRODUCT_TEXT_MAX = 120;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * The products recorded on an Event, or null when it records none.
 * Tolerant on purpose: `metadata` predates this field, and a brand may have
 * sent its own `products` key in it. An entry this code can't read becomes
 * an empty item: it matches nothing and has no amount, so the sale can't be
 * split and a percent rule limited to products pays nothing on it.
 */
export function eventProducts(metadata: unknown): EventProduct[] | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as { products?: unknown }).products;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.map((entry): EventProduct => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return {};
    const e = entry as Record<string, unknown>;
    const item: EventProduct = {};
    const id = str(e.id);
    if (id) item.id = id;
    const price = str(e.price);
    if (price) item.price = price;
    const name = str(e.name);
    if (name) item.name = name;
    const amount = finite(e.amount);
    if (amount !== undefined) item.amount = amount;
    const quantity = finite(e.quantity);
    if (quantity !== undefined) item.quantity = quantity;
    return item;
  });
}

/** True when the Event's product list is known to be short of the sale's
 *  lines (more than MAX_EVENT_PRODUCTS, or Stripe's could not all be read). */
export function eventProductsIncomplete(metadata: unknown): boolean {
  return Boolean(
    metadata && typeof metadata === 'object' && (metadata as { productsIncomplete?: unknown }).productsIncomplete === true,
  );
}

/**
 * A rule's `products` as stored, or null when it's present but can't be
 * read (not a list, empty, an entry without a string id). Only an omitted
 * field means "every product": a rule whose list is unreadable — say from
 * an import, which doesn't validate rules — matches nothing rather than
 * everything.
 */
export function readProductRefs(products: unknown): CommissionProductRef[] | null {
  if (!Array.isArray(products) || products.length === 0) return null;
  const refs: CommissionProductRef[] = [];
  for (const p of products) {
    if (!p || typeof p !== 'object') return null;
    const { id, name } = p as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || id.length === 0) return null;
    refs.push(typeof name === 'string' && name.length > 0 ? { id, name } : { id });
  }
  return refs;
}

/** The ids a rule matches: product ids and price ids alike. */
export function ruleProductIds(refs: readonly CommissionProductRef[] | undefined): string[] {
  return (refs ?? []).map((r) => r.id);
}

/** The Event's items a rule's product list matches (by product or price). */
export function matchingProducts(
  refs: readonly CommissionProductRef[],
  items: readonly EventProduct[],
): EventProduct[] {
  const ids = new Set(ruleProductIds(refs));
  return items.filter((item) => (item.id != null && ids.has(item.id)) || (item.price != null && ids.has(item.price)));
}

/**
 * The part of `value` the matching items account for, rounded to the cent.
 * Every item matching is the whole value. Otherwise every item needs an
 * amount: the value splits in proportion to them, and a share that comes
 * out negative (a credit on the matching product) is zero. With an item
 * lacking an amount, or nothing positive to split, it's 0.
 */
export function productShare(value: number, items: readonly EventProduct[], matched: readonly EventProduct[]): number {
  if (!(value > 0) || matched.length === 0) return 0;
  if (matched.length === items.length) return value;
  if (items.some((i) => i.amount === undefined)) return 0;
  const cents = (n: number) => Math.round(n * 100);
  const total = items.reduce((s, i) => s + cents(i.amount!), 0);
  const part = matched.reduce((s, i) => s + cents(i.amount!), 0);
  if (total <= 0 || part <= 0) return 0;
  const valueCents = cents(value);
  return Math.min(valueCents, Math.round((valueCents * part) / total)) / 100;
}

/** "Pro", "Pro and Team", "Pro, Team and Agency", "Pro, Team and 3 more". */
export function formatProductList(refs: readonly CommissionProductRef[]): string {
  const names = refs.map((r) => r.name?.trim() || r.id);
  if (names.length <= 1) return names[0] ?? '';
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}
