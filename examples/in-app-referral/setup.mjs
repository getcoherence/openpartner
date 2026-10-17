// One-time setup for the in-app referral sample. Run with an ADMIN key; the
// admin key is used for these calls only and is never written to disk.
//
//   OPENPARTNER_API_URL=https://app.openpartner.dev/api/t/<slug> \
//   OPENPARTNER_ADMIN_KEY=op_... \
//   APP_SIGNUP_URL=https://yourapp.example.com/signup \
//   node setup.mjs
//
// It:
//   1. stops offering the OpenPartner Network to partners, so customers
//      aren't asked to join it (nobody is shared without opting in anyway);
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

// Share links are <router>/r[/<slug>]/<linkKey>. Only OpenPartner Cloud's
// layout is known from the API URL; anywhere else the router lives where
// you deployed it (a self-host's portal origin does NOT serve /r), so say so.
const cloud = /^https:\/\/app\.openpartner\.dev\/api\/t\/([a-z0-9-]+)$/.exec(API);
const SHARE_BASE = process.env.OPENPARTNER_SHARE_URL_BASE ?? (cloud ? `https://app.openpartner.dev/r/${cloud[1]}` : null);
if (!SHARE_BASE) {
  console.error(
    'Set OPENPARTNER_SHARE_URL_BASE to where share links live, e.g. https://<your-domain>/r on a white-label domain,\n' +
      'or your router origin + /r (single tenant) or + /r/<slug> (multi-tenant) on a self-host.',
  );
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

// 1. Stop offering the Network to partners (stored as autoEnroll). Do this
//    before the first partner exists.
const network = await op('GET', '/config/network');
if (network.autoEnroll) {
  await op('POST', '/config/network', { autoEnroll: false });
  console.log('✓ Network no longer offered to partners');
} else {
  console.log('✓ Network already not offered to partners');
}

// 1b. Keep customers out of the hosted partner portal: partners created
//     without an invite can't request a sign-in link. Also before the first
//     partner exists; existing partners keep what they have.
const access = await op('GET', '/config/partner-access');
if (access.uninvitedPortalAccess) {
  await op('POST', '/config/partner-access', { uninvitedPortalAccess: false });
  console.log('✓ Partners added without an invite can no longer sign in to the portal');
} else {
  console.log('✓ Partners added without an invite already have no portal access');
}

// 2. A private program: 20% of every payment for the first 12 months.
// holdbackDays: commissions auto-approve 30 days after accruing (your refund
// window), then the next payout run pays them. Use 0 to approve by hand.
// Re-running setup reuses the program instead of creating a second one.
const PROGRAM_NAME = 'Refer & earn';
const { programs } = await op('GET', '/programs');
let program = programs.find((p) => p.name === PROGRAM_NAME);
if (program) {
  console.log(`✓ Program ${program.id} already exists; reusing it`);
} else {
  program = await op('POST', '/programs', {
    name: PROGRAM_NAME,
    destinationUrl: SIGNUP_URL,
    commissionRule: [{ trigger: 'every', eventType: 'invoice_paid', type: 'percent', value: 20, recurring: true, recurringMonths: 12 }],
    attributionWindowDays: 90,
    holdbackDays: 30,
    shareOnNetwork: false,
  });
  console.log(`✓ Program ${program.id} created`);
}

// 3. A scoped key: create partners + links, read stats/earnings, report events.
// partners:create, not partners:write: it can't invite, revoke or set
// commission terms, so neither a bug nor a leak can email your customers.
const key = await op('POST', '/api-keys/scoped', {
  label: 'in-app referral sample',
  scopes: ['partners:create', 'partners:read', 'links:write', 'links:read', 'commissions:read', 'payouts:read', 'events:write'],
});
console.log(`✓ Scoped key ${key.id} minted`);

const env = [
  `OPENPARTNER_API_URL=${API}`,
  `OPENPARTNER_API_KEY=${key.plaintext}`,
  `OPENPARTNER_PROGRAM_ID=${program.id}`,
  `OPENPARTNER_SHARE_URL_BASE=${SHARE_BASE}`,
  'PORT=3000',
  '',
].join('\n');

if (existsSync('.env')) {
  console.log('\n.env exists; not overwriting. Use these values (the key is shown only this once):\n');
  console.log(env);
} else {
  writeFileSync('.env', env, { mode: 0o600 });
  console.log('✓ Wrote .env. Start the sample with: node server.mjs');
}
