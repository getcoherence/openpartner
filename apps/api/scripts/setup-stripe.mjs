#!/usr/bin/env node
/**
 * Provision the Stripe products + prices + meters OpenPartner needs.
 *
 *   STRIPE_SECRET_KEY=sk_test_... node apps/api/scripts/setup-stripe.mjs
 *
 * Idempotent: each product is keyed by a metadata tag; meters by event_name;
 * metered prices by their meter + product. Re-running after a partial failure
 * won't create duplicates. Outputs the env var values you need to add to your
 * .env at the end.
 *
 * Use a test-mode key first (sk_test_...) and verify, then re-run with the
 * live key when you're ready.
 */
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error('Set STRIPE_SECRET_KEY before running.');
  process.exit(1);
}
const isLive = key.startsWith('sk_live_');
const isTest = key.startsWith('sk_test_');
if (!isLive && !isTest) {
  console.error('STRIPE_SECRET_KEY should start with sk_test_ or sk_live_.');
  process.exit(1);
}

const stripe = new Stripe(key);

console.log(`\nProvisioning OpenPartner products in ${isLive ? 'LIVE' : 'TEST'} mode...\n`);

const PRODUCTS = [
  {
    key: 'flex',
    name: 'OpenPartner Flex',
    description: '$49/mo + 1.5% of attributed GMV. Hosted, fully managed.',
    monthlyPrice: 4900, // $49.00 in cents
    // 1.5% of GMV = $0.015 per dollar = 1.5 cents per dollar.
    // Stripe Prices on metered usage are in cents per unit; we report
    // usage in dollars (Event.value), so unit_amount = 1.5 cents.
    meteredCentsPerUnit: 1.5,
    statementDescriptor: 'OPENPARTNER FLEX',
  },
  {
    key: 'network_access',
    name: 'OpenPartner Network access',
    description: '$29/mo for self-hosted customers tapping into the OpenPartner Network. 90-day free trial. 3% on Network-originated payouts.',
    monthlyPrice: 2900, // $29.00 in cents
    meteredCentsPerUnit: 3, // 3% on Network-originated payouts
    statementDescriptor: 'OPENPARTNER NET',
  },
  {
    key: 'revshare',
    name: 'OpenPartner Revshare',
    description: '3% of attributed GMV, no monthly fee. Hosted, fully managed.',
    monthlyPrice: null,
    meteredCentsPerUnit: 3, // 3% of GMV
    statementDescriptor: 'OPENPARTNER REV',
  },
];

// Meters: usage signals OpenPartner reports per merchant. Reporting goes via
// stripe.billing.meterEvents.create with the matching event_name.
const METERS = [
  {
    eventName: 'openpartner_attributed_gmv',
    displayName: 'OpenPartner attributed GMV',
    purpose: 'Attributed GMV in dollars (used for Flex 1.5% and Revshare 3%)',
  },
  {
    eventName: 'openpartner_network_payouts',
    displayName: 'OpenPartner Network-originated payouts',
    purpose: 'Network-originated payouts in dollars (used for Network access 3%)',
  },
];

// Each product binds to one meter for its metered price.
const PRODUCT_METERS = {
  flex: 'openpartner_attributed_gmv',
  revshare: 'openpartner_attributed_gmv',
  network_access: 'openpartner_network_payouts',
};

// ────────────────────────── Meters ──────────────────────────
console.log('Meters:');
const metersByEventName = new Map();
for (const m of METERS) {
  const existingMeters = await stripe.billing.meters.list({ status: 'active', limit: 100 });
  const found = existingMeters.data.find((x) => x.event_name === m.eventName);
  if (found) {
    console.log(`  ✓ ${m.eventName} already exists: ${found.id}`);
    metersByEventName.set(m.eventName, found);
  } else {
    const created = await stripe.billing.meters.create({
      display_name: m.displayName,
      event_name: m.eventName,
      default_aggregation: { formula: 'sum' },
      value_settings: { event_payload_key: 'value' },
      customer_mapping: { event_payload_key: 'stripe_customer_id', type: 'by_id' },
    });
    console.log(`  + Created meter ${m.eventName}: ${created.id}`);
    metersByEventName.set(m.eventName, created);
  }
}

// ────────────────────────── Products + Prices ──────────────────────────
console.log('\nProducts + prices:');
const results = [];

for (const p of PRODUCTS) {
  // Product: keyed by metadata.
  const existing = await stripe.products.search({
    query: `metadata['openpartner_product']:'${p.key}' AND active:'true'`,
  });

  let product;
  if (existing.data.length > 0) {
    product = existing.data[0];
    console.log(`  ✓ ${p.name} already exists: ${product.id}`);
  } else {
    product = await stripe.products.create({
      name: p.name,
      description: p.description,
      statement_descriptor: p.statementDescriptor,
      metadata: { openpartner_product: p.key },
      tax_code: 'txcd_10000000',
    });
    console.log(`  + Created ${p.name}: ${product.id}`);
  }

  const existingPrices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });

  // Monthly recurring price (skip if metered-only product).
  let monthlyPriceId = null;
  if (p.monthlyPrice != null) {
    const found = existingPrices.data.find(
      (x) =>
        x.metadata?.openpartner_price_kind === 'monthly' &&
        x.unit_amount === p.monthlyPrice &&
        x.currency === 'usd' &&
        x.recurring?.interval === 'month' &&
        x.recurring?.usage_type !== 'metered',
    );
    if (found) {
      monthlyPriceId = found.id;
      console.log(`    ✓ Monthly price already exists: ${monthlyPriceId}`);
    } else {
      const created = await stripe.prices.create({
        product: product.id,
        unit_amount: p.monthlyPrice,
        currency: 'usd',
        recurring: { interval: 'month' },
        tax_behavior: 'exclusive',
        metadata: { openpartner_price_kind: 'monthly' },
      });
      monthlyPriceId = created.id;
      console.log(`    + Created monthly price: ${monthlyPriceId} ($${(p.monthlyPrice / 100).toFixed(2)}/mo)`);
    }
  }

  // Metered price linked to the product's meter.
  let meteredPriceId = null;
  if (p.meteredCentsPerUnit != null) {
    const meterEventName = PRODUCT_METERS[p.key];
    const meter = metersByEventName.get(meterEventName);
    if (!meter) throw new Error(`Missing meter for ${p.key} (event_name=${meterEventName})`);

    const meteredCents = p.meteredCentsPerUnit;
    const found = existingPrices.data.find(
      (x) =>
        x.metadata?.openpartner_price_kind === 'metered' &&
        x.recurring?.meter === meter.id &&
        x.currency === 'usd',
    );
    if (found) {
      meteredPriceId = found.id;
      console.log(`    ✓ Metered price already exists: ${meteredPriceId}`);
    } else {
      // Use unit_amount_decimal for fractional cents (1.5 cents per unit, etc.).
      const created = await stripe.prices.create({
        product: product.id,
        currency: 'usd',
        unit_amount_decimal: meteredCents.toString(),
        recurring: { interval: 'month', usage_type: 'metered', meter: meter.id },
        tax_behavior: 'exclusive',
        metadata: { openpartner_price_kind: 'metered' },
      });
      meteredPriceId = created.id;
      console.log(`    + Created metered price: ${meteredPriceId} (${meteredCents}¢ per unit, meter=${meter.id})`);
    }
  }

  results.push({ key: p.key, productId: product.id, monthlyPriceId, meteredPriceId });
}

// ────────────────────────── Summary ──────────────────────────
console.log('\n────────────────────────────────────────────────────────────');
console.log('Done. Add these to your OpenPartner .env:\n');

const flex = results.find((r) => r.key === 'flex');
const revshare = results.find((r) => r.key === 'revshare');
const network = results.find((r) => r.key === 'network_access');

if (flex?.monthlyPriceId) console.log(`STRIPE_FLAT_PRICE_ID=${flex.monthlyPriceId}`);
if (flex?.meteredPriceId) console.log(`STRIPE_FLAT_USAGE_PRICE_ID=${flex.meteredPriceId}`);
if (revshare?.meteredPriceId) console.log(`STRIPE_REVSHARE_USAGE_PRICE_ID=${revshare.meteredPriceId}`);
if (network?.monthlyPriceId) console.log(`STRIPE_NETWORK_PRICE_ID=${network.monthlyPriceId}`);
if (network?.meteredPriceId) console.log(`STRIPE_NETWORK_USAGE_PRICE_ID=${network.meteredPriceId}`);

console.log('\nMode:', isLive ? 'LIVE' : 'TEST');
console.log('Next: copy the env line(s) into your .env, restart the api.\n');
