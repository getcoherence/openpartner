#!/usr/bin/env node
/**
 * Provision the Stripe products + prices OpenPartner needs.
 *
 *   STRIPE_SECRET_KEY=sk_test_... node apps/api/scripts/setup-stripe.mjs
 *
 * Idempotent: each product is keyed by a metadata tag; re-running after a
 * partial failure won't create duplicates. Outputs the env var values you
 * need to add to your .env at the end.
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
    statementDescriptor: 'OPENPARTNER FLEX',
  },
  {
    key: 'network_access',
    name: 'OpenPartner Network access',
    description: '$29/mo for self-hosted customers tapping into the OpenPartner Network. 90-day free trial. 3% on Network-originated payouts.',
    monthlyPrice: 2900, // $29.00 in cents
    statementDescriptor: 'OPENPARTNER NET',
  },
  {
    key: 'revshare',
    name: 'OpenPartner Revshare',
    description: '3% of attributed GMV, no monthly fee. Hosted, fully managed.',
    monthlyPrice: null, // metered/usage-based, no fixed monthly
    statementDescriptor: 'OPENPARTNER REV',
  },
];

const results = [];

for (const p of PRODUCTS) {
  // Look up existing by metadata so re-runs are safe.
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
      tax_code: 'txcd_10000000', // SaaS — General — Electronically supplied services
    });
    console.log(`  + Created ${p.name}: ${product.id}`);
  }

  // Prices: idempotent via metadata. Skip the monthly price if this product
  // is purely metered (revshare).
  let priceId = null;
  if (p.monthlyPrice != null) {
    const existingPrices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
    const found = existingPrices.data.find(
      (x) =>
        x.metadata?.openpartner_price_kind === 'monthly' &&
        x.unit_amount === p.monthlyPrice &&
        x.currency === 'usd' &&
        x.recurring?.interval === 'month',
    );
    if (found) {
      priceId = found.id;
      console.log(`    ✓ Monthly price already exists: ${priceId}`);
    } else {
      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: p.monthlyPrice,
        currency: 'usd',
        recurring: { interval: 'month' },
        tax_behavior: 'exclusive',
        metadata: { openpartner_price_kind: 'monthly' },
      });
      priceId = price.id;
      console.log(`    + Created monthly price: ${priceId} ($${(p.monthlyPrice / 100).toFixed(2)}/mo)`);
    }
  } else {
    console.log(`    · Skipping monthly price (metered/usage product)`);
  }

  results.push({ key: p.key, productId: product.id, priceId });
}

console.log('\n────────────────────────────────────────────────────────────');
console.log('Done. Add these to your OpenPartner .env:\n');

const flex = results.find((r) => r.key === 'flex');
if (flex?.priceId) {
  console.log(`STRIPE_FLAT_PRICE_ID=${flex.priceId}`);
}

console.log(`\nFor reference (not yet read by code, but useful when revshare/network billing is wired):`);
const network = results.find((r) => r.key === 'network_access');
if (network?.priceId) {
  console.log(`# Network access monthly: ${network.priceId}`);
}
const revshare = results.find((r) => r.key === 'revshare');
if (revshare?.productId) {
  console.log(`# Revshare product (metered, add usage price later): ${revshare.productId}`);
}

console.log('\nMode:', isLive ? 'LIVE' : 'TEST');
console.log('Next: copy the env line(s) into your .env, restart the api.\n');
