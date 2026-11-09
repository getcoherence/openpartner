# Product commissions

A commission sub-rule can be limited to some products. For example: 30% on Pro, 10% on add-ons, and a $50 bonus on a customer's first Team subscription.

There are two parts:

- **What a sale was for** is raw data on the Event: `metadata.products`, one item per product line. It's written when the sale is recorded and never changed.
- **Which products a rule pays on** is a `products` list on the sub-rule, in `Program.commissionRule` or `PartnerCommission.commissionRules`. A rule without the list pays on every sale, as before.

Commissions stay derived. Change a rule's products and re-derive, and the raw sales still say what they were for.

Code:
- Matching and the share: `packages/db/src/event-products.ts`. These are pure functions shared by the engine and the portal.
- Engine: `evaluateSubRule` and `productScope` in `apps/api/src/attribution.ts`.
- Ingest, validation and Stripe line items: `apps/api/src/product-commissions.ts`, and `stripeProducts` in `routes/stripe-webhook.ts`.
- Editor: `ProductsRow` in `apps/portal/src/lib/CompoundRuleEditor.tsx`. Its suggestions come from `GET /programs/products`.

## The rule

```jsonc
{
  "trigger": "every", "eventType": "invoice_paid", "type": "percent", "value": 30,
  "products": [{ "id": "prod_Pro123", "name": "Pro" },   // a product id…
               { "id": "price_TeamYearly" }]               // …or a price id
}
```

- Each `id` is matched against both the product id and the price id of each of the sale's items. A rule can therefore pay differently on monthly and annual prices of the same product.
- `name` is for display only.
- The list holds 1 to 50 entries, with no duplicates and at most 120 characters each.
- To cover every product, omit the field. An empty list is refused, and so is `products` on the legacy single-object form of `commissionRule` (which would drop it).
- Only an omitted field means every product. A stored list that can't be read (null, empty, an entry without an id) pays on nothing, and its summary says "(no products)". Only an import can store one: imports don't validate rules. That includes a legacy single-object rule carrying `products`: the engine keeps the field when it reads that shape, so it's checked the same way.

What the rule pays depends on its type:

| Rule | Pays |
| --- | --- |
| Percent | The rate on the matching products' **share** of the sale's value (below). |
| Fixed | The amount once per sale that includes a matching product, whatever its share or quantity. |
| `first` / `subsequent` | "First" means the first sale **of these products** to that customer through that partner. Earlier sales of other products don't count. |
| `recurringMonths` | Counted from the customer's first sale of these products. |
| Value bands | The bands are compared with the products' share, not the whole sale. |
| Performance tiers | The partner's volume is counted as before, over the whole event type. The rate it picks then applies to the share. |

A sale with no matching product pays nothing on the rule. The rule still counts as taking the event type, so a conversion reports `attributed` with `no_commission`, not `no_matching_rule`.

The commission records what it was paid on: `Commission.metadata.products = { ruleIndex, matched, basis }`. `matched` lists the rule's own ids that matched (a price id for a rule on a price), and `basis` is the share.

## The share

A percent rule pays on the sale's `value` split in proportion to its items' `amount`s:

```
share = value × (sum of matching items' amounts) ÷ (sum of all items' amounts)
```

The share is rounded to the cent and never more than `value`. Some consequences:

- A sale where every item matches pays on the whole value, exactly what an unscoped rule would pay. Tax and invoice-level discounts are spread across the items in the same proportion.
- A share that comes out negative is 0. For example, a downgrade's credit on Pro alongside a charge for Basic.
- A sale with two or more items where one has no `amount` can't be split, so a percent rule pays nothing on it. The API requires amounts on every item when there's more than one, so only stored data written some other way gets here.
- A list marked `metadata.productsIncomplete: true` pays nothing on percent rules: its share can't be known. Fixed rules still pay when a matching item is present.

## Where products come from

**Stripe.** Products are read as the sale is recorded, on both `/webhooks/stripe` and the Stripe App:

| Stripe event | Products from |
| --- | --- |
| `invoice.paid` | The invoice's lines, from the payload. Stripe includes ten; an invoice with more is read in full (`invoices.listLineItems`, up to 1,000). |
| `customer.subscription.created` | The subscription's items, from the payload: price × quantity. A metered or tiered price has no unit amount. |
| One-time Checkout revenue (`mode=payment`) | The session's line items (`checkout.sessions.listLineItems`, with `data.taxes` expanded), since webhooks don't carry them. |

How each line is read:

- **Amount:** the line's amount after its own discounts and any billing credits applied to it (`pretax_credit_amounts` other than discounts), before tax. A tax-inclusive price's tax is in the line's amount, so it's taken out: `taxes` with `tax_behavior: inclusive` from basil, `tax_amounts` marked `inclusive` before, and a Checkout line item's `taxes` at an inclusive rate.
- **Product and price:** from `pricing.price_details` on API version 2025-03-31.basil and later. Before that, from `price` or `plan`. The Stripe App's endpoints still deliver the older shape.
- **Name:** taken from a description like "1 × Pro (at $49.00 / month)". Proration lines get none.
- **Merging:** lines for the same product and price are merged. Past 100 items, the list is cut short and marked incomplete.

Each Stripe read happens only for a sale not already recorded. A read refused for good (a permission or a missing object) marks the list incomplete. A transient failure answers 500, so Stripe redelivers the event.

PayPal payments and the `GET /postback` conversion link don't carry products.

**The API.** `POST /attribution/events` and `POST /attribution/conversions` take a `products` field, and the server SDK (`trackEvent`, `trackConversion`) passes it through:

```jsonc
"products": [
  { "id": "sku_pro", "price": "sku_pro_annual", "name": "Pro", "amount": 60, "quantity": 1 },
  { "id": "sku_mug", "name": "Mug", "amount": 40 }
]
```

- Each item needs an `id`; `price`, `name`, `amount` and `quantity` are optional.
- `amount` is the item's part of `value`, in the event's currency. It's required on every item when there's more than one.
- The list holds up to 100 items.
- The field is stored as `metadata.products` and replaces a `products` key sent inside `metadata`.

## The editor

Each rule row has a **Products** control: **All products** or **Only these products**.

- Ids can be picked from the brand's recent sales or typed by hand. A product not sold yet works too.
- Save waits for at least one product.
- The suggestions come from `GET /programs/products`: up to 200 product and price ids, with their latest names. They're taken from the latest 5,000 sales with products in the last 180 days.

The partner override screen warns about stages a new override leaves unpaid (`rulesLeftUnpaid`). That check counts products too: an override for Pro only leaves a program's Team rule unpaid.

Summaries say which products a rule is limited to, for example "30% on every invoice (Pro and Team only)". That covers the portal, the partner portal, and the Network's `commissionDescription`.

## The Network

`buildTermsPayload` sends rules verbatim, so `products` goes with them. The Network's offering schema passes unknown sub-rule fields through, so its approval snapshots come back with the list. `POST /partners` keeps `products` on a snapshot and vets it (`vetApprovalSnapshot`) as it does slab tables:

- A snapshot whose product list doesn't pass the program-rule checks isn't stored. The partner then earns on the live rule.
- A snapshot that is exactly a granted program's rule with its product lists removed isn't stored either. That's what a Network that dropped the field would send back, and stored, it would pay the partner on every product. The legacy single-rule mirror of a product-limited program counts too.

## Data portability

Nothing extra, and no version bump:

- `products` is JSON inside the rule columns, and `metadata.products` is JSON inside `Event.metadata`. Both are already in the bundle.
- `Commission.metadata.products` travels the same way.

An older instance imports the rules and ignores `products`, so it pays them on every product. Upgrade before importing a bundle that uses them.
