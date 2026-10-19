import type { Knex } from 'knex';

/**
 * Hosted funded-rail transfer intents get a `duplicate_review` state
 * (docs/payout-funding.md §4), the direct rail's parking state.
 *
 * Reconcile parks an intent here when its batch's transfer group shows more
 * than one transfer for it, one from an abandoned key generation, or one
 * that fails authentication against the frozen intent. The executor does
 * not scan this state, so a parked intent stops re-listing at Stripe and
 * re-alerting every tick. An operator leaves it through the
 * operator-recovery loop (`resolve_duplicate_review`, rail
 * `hosted_funding`), which verifies the outcome against Stripe.
 *
 * `reviewNonce` is that resolution's fence. The funding webhook moves it
 * to a fresh ULID whenever a transfer of a parked intent sees reversal
 * activity, and a resolution only commits on the nonce it read before
 * listing, so a reversal landing mid-resolution forces a re-verify.
 *
 * Hosted sidecar column (HostedFundingTransfer is not in the export).
 */
const OLD_STATES = ['pending', 'posted', 'confirmed', 'failed', 'reconcile_required'] as const;
const NEW_STATES = [...OLD_STATES, 'duplicate_review'] as const;

function checkIn(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`alter table "HostedFundingTransfer" drop constraint "HostedFundingTransfer_state_check"`);
  await knex.raw(
    `alter table "HostedFundingTransfer" add constraint "HostedFundingTransfer_state_check" check ("state" in (${checkIn(NEW_STATES)}))`,
  );
  await knex.raw(`alter table "HostedFundingTransfer" add column "reviewNonce" text null`);
}

export async function down(knex: Knex): Promise<void> {
  // Back to the old hold: a parked intent is `reconcile_required` again,
  // which the old executor lists and alerts on every tick. Its lastError
  // already says why.
  await knex.raw(
    `update "HostedFundingTransfer" set "state" = 'reconcile_required', "updatedAt" = now() where "state" = 'duplicate_review'`,
  );
  await knex.raw(`alter table "HostedFundingTransfer" drop constraint "HostedFundingTransfer_state_check"`);
  await knex.raw(
    `alter table "HostedFundingTransfer" add constraint "HostedFundingTransfer_state_check" check ("state" in (${checkIn(OLD_STATES)}))`,
  );
  await knex.raw(`alter table "HostedFundingTransfer" drop column "reviewNonce"`);
}
