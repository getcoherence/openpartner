// One-time setup for the in-app referral sample. Run with an ADMIN key; the
// admin key is used for these calls only and is never written to disk.
//
//   OPENPARTNER_API_URL=https://app.openpartner.dev/api/t/<slug> \
//   OPENPARTNER_ADMIN_KEY=op_... \
//   APP_SIGNUP_URL=https://yourapp.example.com/signup \
//   node setup.mjs
//
// It:
//   1. turns OFF OpenPartner Network auto-enroll, so creating a partner per
//      customer never pushes their name and email to the Network;
//   2. creates a private referral program (not listed on the marketplace);
//   3. mints a scoped key with only the scopes the referral page needs;
//   4. writes .env for server.mjs (unless one exists; then it prints it).

import { existsSync, writeFileSync } from 'node:fs';

const API = (process.env.OPENPARTNER_API_URL ?? '').replace(/\/$/, '');
const ADMIN = process.env.OPENPARTNER_ADMIN_KEY ?? '';
const SIGNUP_URL = process.env.APP_SIGNUP_URL ?? 'http://localhost:3000/signup';
if (!API || !ADMIN) {
  console.error('Set OPENPARTNER_API_URL (your tenant API base) and OPENPARTNER_ADMIN_KEY.');
  process.exit(1);
}

async function op(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// 1. Network auto-enroll off. Do this before the first partner exists.
const network = await op('GET', '/config/network');
if (network.autoEnroll) {
  await op('POST', '/config/network', { autoEnroll: false });
  console.log('✓ Network auto-enroll turned off');
} else {
  console.log('✓ Network auto-enroll already off');
}

// 2. A private program: 20% of every payment for the first 12 months.
const program = await op('POST', '/programs', {
  name: 'Refer & earn',
  destinationUrl: SIGNUP_URL,
  commissionRule: [{ trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 20, recurring: true, recurringMonths: 12 }],
  attributionWindowDays: 90,
  holdbackDays: 30,
  shareOnNetwork: false,
});
console.log(`✓ Program ${program.id} created`);

// 3. A scoped key: create partners + links, read stats/earnings, report events.
const key = await op('POST', '/api-keys/scoped', {
  label: 'in-app referral sample',
  scopes: ['partners:write', 'partners:read', 'links:write', 'links:read', 'commissions:read', 'payouts:read', 'events:write'],
});
console.log(`✓ Scoped key ${key.id} minted`);

// Share links: https://app.openpartner.dev/r/<slug>/<key> on Cloud; on a
// custom domain or self-host, override OPENPARTNER_SHARE_URL_BASE.
const slug = /\/api\/t\/([a-z0-9-]+)$/.exec(API)?.[1];
const shareBase =
  process.env.OPENPARTNER_SHARE_URL_BASE ??
  (slug ? `${new URL(API).origin}/r/${slug}` : API.endsWith('/api') ? `${new URL(API).origin}/r` : 'http://localhost:4701/r');

const env = [
  `OPENPARTNER_API_URL=${API}`,
  `OPENPARTNER_API_KEY=${key.plaintext}`,
  `OPENPARTNER_PROGRAM_ID=${program.id}`,
  `OPENPARTNER_SHARE_URL_BASE=${shareBase}`,
  'PORT=3000',
  '',
].join('\n');

if (existsSync('.env')) {
  console.log('\n.env exists; not overwriting. Use these values:\n');
  console.log(env);
} else {
  writeFileSync('.env', env, { mode: 0o600 });
  console.log('✓ Wrote .env. Start the sample with: node server.mjs');
}
