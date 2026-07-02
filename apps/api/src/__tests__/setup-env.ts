/**
 * Vitest setup — runs before every test file.
 *
 * CI runs the suite with OPENPARTNER_MODE unset, which resolves to
 * 'selfhost' (getMode()'s default). A developer's local .env, loaded by
 * env.js via dotenv, typically says 'flat' for manual hosted-mode testing —
 * which flips billing gates (the §13 plan-required gate 402s partner
 * onboarding) and fails suites that pass in CI. Pin the CI default here;
 * test files that exercise hosted billing set their own mode at module
 * scope, which runs after this.
 */
// Top-level await needs module status, and dynamic import() alone doesn't
// confer it (TS1375).
export {};

process.env.OPENPARTNER_MODE = 'selfhost';

// The DB-backed suites share one Postgres and already wipe product tables
// in their own beforeEach — but none of them owned the DEFAULT TENANT's
// billing columns. A leftover billingPlan (from manual dev work or a
// hosted-billing test) flips planToMode() to hosted for every later file
// and the plan-required gate 402s partner onboarding. Reset the seeded
// tenant to its fresh-migration state so every file starts hermetic.
// Skipped (with a warning) when Postgres isn't reachable — the DB-backed
// suites skip themselves in that case anyway.
// Load .env first — DATABASE_URL comes from dotenv, which the test files
// only trigger via their own db.js import (after this setup runs).
await import('../env.js');
if (process.env.DATABASE_URL && process.env.INTEGRATION !== 'skip') {
  try {
    const { DEFAULT_TENANT_ID, TABLES } = await import('@openpartner/db');
    const { db } = await import('../db.js');
    await db(TABLES.Tenant).where({ id: DEFAULT_TENANT_ID }).update({
      billingPlan: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      trialEndsAt: null,
      firstTrialActivatedAt: null,
      whiteLabel: false,
      customDomain: null,
    });
  } catch (err) {
    console.warn(
      '[test-setup] could not reset default tenant billing state (DB unreachable?) — DB-backed suites will self-skip',
      err instanceof Error ? err.message : err,
    );
  }
}
