import type { Knex } from 'knex';

/**
 * Durable operator-recovery requests — decision B (audit handoff §0.4).
 *
 * Both money rails deliberately FREEZE on ambiguity ("empty is not
 * absent") and wait for a human. The four operator functions that release
 * a freeze (releaseIntentForRetry / disposeIntent / resolveDuplicateReview
 * on the direct-Connect rail, forceReleaseBatch on the hosted funding
 * rail) verify everything verifiable against Stripe themselves — but until
 * now the only way to call them was ad-hoc SQL/scripts at 2am. This table
 * makes the operator's decision DURABLE and AUDITABLE: insert a request,
 * and the existing scheduler machinery applies it under the functions' own
 * fences. The request row is also the tombstone for the prove-absence
 * limit: who accepted the risk, when, on what evidence.
 *
 * Append-only discipline: terminal rows (applied/refused/failed/canceled)
 * are never edited into a new decision — a new decision is a new row. The
 * lease/recheck columns are operational scheduling state, not decisions.
 *
 * Operational sidecar (CLAUDE.md §2): tenant-scoped and RLS'd like every
 * tenant table, but NOT part of the portable export set — listed with the
 * other export gaps in docs/data-portability.md.
 */

const RAILS = ['direct_connect', 'hosted_funding'] as const;
const KINDS = [
  'release_intent_for_retry',
  'dispose_intent',
  'resolve_duplicate_review',
  'force_release_batch',
] as const;
const STATUSES = ['pending', 'applied', 'refused', 'failed', 'canceled'] as const;

function checkIn(values: readonly string[]): string {
  return values.map((v) => `'${v}'`).join(', ');
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('OperatorRecoveryRequest', (t) => {
    t.string('id', 32).primary(); // ulid
    t.string('tenantId', 32).notNullable().references('id').inTable('Tenant').onDelete('CASCADE');
    t.string('rail', 32).notNullable();
    t.string('kind', 64).notNullable();
    /** payoutId (direct_connect) or batchId (hosted_funding). Polymorphic —
     *  no FK; the apply loop re-reads the target and refuses on mismatch. */
    t.string('targetId', 32).notNullable();
    t.jsonb('params').notNullable().defaultTo('{}');
    t.text('requestedBy').notNullable();
    t.text('note').nullable();
    t.string('status', 16).notNullable().defaultTo('pending');
    /** The operator function's literal return value from the last attempt
     *  (or an apply-loop verdict such as tenant_mismatch / invalid_request). */
    t.text('outcome').nullable();
    t.integer('attempts').notNullable().defaultTo(0);
    /** Retry pacing for retryable outcomes (cannot_verify / review_moved /
     *  too_recent). Null = due immediately. */
    t.timestamp('nextAttemptAt', { useTz: true }).nullable();
    /** Claim lease (round-10 sweep-claim pattern, DB clock on both sides):
     *  the apply loop and the post-apply recheck both take it before any
     *  Stripe call, and every write back is fenced on the token. */
    t.timestamp('leaseAt', { useTz: true }).nullable();
    t.text('leaseToken').nullable();
    /** Post-apply group re-check (prove-absence close, handoff §0.2) —
     *  direct_connect kinds only. Null = no re-check pending. */
    t.timestamp('recheckDueAt', { useTz: true }).nullable();
    t.integer('recheckAttempts').notNullable().defaultTo(0);
    t.text('recheckOutcome').nullable();
    t.timestamp('appliedAt', { useTz: true }).nullable();
    t.timestamp('createdAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updatedAt', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.index(['status', 'rail']); // apply-loop claim scan
    t.index(['tenantId', 'createdAt']); // admin listing
    t.index(['targetId']); // duplicate-pending guard + per-target history
  });
  await knex.raw(
    `alter table "OperatorRecoveryRequest" add constraint "OperatorRecoveryRequest_rail_check" check ("rail" in (${checkIn(RAILS)}))`,
  );
  await knex.raw(
    `alter table "OperatorRecoveryRequest" add constraint "OperatorRecoveryRequest_kind_check" check ("kind" in (${checkIn(KINDS)}))`,
  );
  await knex.raw(
    `alter table "OperatorRecoveryRequest" add constraint "OperatorRecoveryRequest_status_check" check ("status" in (${checkIn(STATUSES)}))`,
  );

  // Tenant isolation — the canonical pattern (20260613000000_partner_postback.ts
  // / 20260710000000_hosted_funding.ts) — but the app-role grant is
  // deliberately NARROWER than the usual full DML: SELECT + INSERT only.
  // The API inserts and lists; every UPDATE (claims, settles, rechecks)
  // happens in the apply loop on the privileged pool. Withholding UPDATE
  // and DELETE from the app role makes the append-only discipline a
  // database property, not a convention: no tenant-scoped code path can
  // rewrite a terminal decision or erase the audit trail.
  await knex.raw(`alter table "OperatorRecoveryRequest" enable row level security`);
  await knex.raw(`alter table "OperatorRecoveryRequest" force row level security`);
  await knex.raw(`
    create policy tenant_isolation on "OperatorRecoveryRequest"
      using ("tenantId" = current_setting('app.tenant_id', true))
      with check ("tenantId" = current_setting('app.tenant_id', true))
  `);
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'grant select, insert on "OperatorRecoveryRequest" to openpartner_app';
      end if;
    end
    $$;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'openpartner_app') then
        execute 'revoke all privileges on "OperatorRecoveryRequest" from openpartner_app';
      end if;
    end
    $$;
  `);
  await knex.schema.dropTableIfExists('OperatorRecoveryRequest');
}
