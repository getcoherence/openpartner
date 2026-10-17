import { createApp } from './app.js';
import { startScheduler } from './scheduler.js';
import { outboundPolicy } from './outbound-guard.js';

const PORT = Number(process.env.API_PORT ?? 4601);
const MODE = process.env.OPENPARTNER_MODE ?? 'selfhost';

// Boot probe — log presence/length of every secret env so the run logs
// surface which ones actually populated in the runtime container. App
// Platform silently leaves SECRET envs empty when the cipher-text blob
// can't decrypt (e.g. after a spec-pull-and-reapply); the only reliable
// way to spot that is at startup. Lengths only, never values.
console.log(JSON.stringify({
  msg: 'secrets_probe',
  app: 'openpartner',
  tenancy: process.env.OPENPARTNER_TENANCY ?? 'single',
  // Stripe
  stripeSecretLen: (process.env.STRIPE_SECRET_KEY ?? '').length,
  webhookSecretLen: (process.env.STRIPE_WEBHOOK_SECRET ?? '').length,
  flatPriceIdLen: (process.env.STRIPE_FLAT_PRICE_ID ?? '').length,
  flatUsagePriceIdLen: (process.env.STRIPE_FLAT_USAGE_PRICE_ID ?? '').length,
  revsharePriceIdLen: (process.env.STRIPE_REVSHARE_USAGE_PRICE_ID ?? '').length,
  whitelabelAddOnPriceIdLen: (process.env.STRIPE_WHITELABEL_ADD_ON_PRICE_ID ?? '').length,
  networkPriceIdLen: (process.env.STRIPE_NETWORK_PRICE_ID ?? '').length,
  networkUsagePriceIdLen: (process.env.STRIPE_NETWORK_USAGE_PRICE_ID ?? '').length,
  // Mail
  postmarkTokenLen: (process.env.POSTMARK_SERVER_TOKEN ?? '').length,
  mailFromLen: (process.env.MAIL_FROM ?? '').length,
  // Other
  adminApiKeyLen: (process.env.ADMIN_API_KEY ?? '').length,
  secretsEncryptionKeyLen: (process.env.SECRETS_ENCRYPTION_KEY ?? '').length,
  metricsTokenLen: (process.env.METRICS_TOKEN ?? '').length,
  networkUrlLen: (process.env.NETWORK_URL ?? '').length,
  networkAdminKeyLen: (process.env.NETWORK_ADMIN_API_KEY ?? '').length,
  databaseUrlLen: (process.env.DATABASE_URL ?? '').length,
  databaseUrlAppLen: (process.env.DATABASE_URL_APP ?? '').length,
  portalUrlLen: (process.env.PORTAL_URL ?? '').length,
  // White-label DO domain automation
  doApiTokenLen: (process.env.DO_API_TOKEN ?? '').length,
  doAppIdLen: (process.env.DO_APP_ID ?? '').length,
}));

// Validate the outbound (SSRF) guard config now so a bad
// OPENPARTNER_OUTBOUND_* value fails startup rather than every delivery.
outboundPolicy();

const app = createApp();
app.listen(PORT, () => {
  console.log(`[api] listening on :${PORT} (mode=${MODE})`);
  startScheduler();
});
