/**
 * Usage-based billing reporter.
 *
 * The Hosted Flex plan bills $49/mo + 1.5% of attributed GMV. The 1.5% portion
 * is a Stripe metered price tied to a Stripe Meter ("openpartner_attributed_gmv");
 * we report usage via meterEvents.create on whatever cadence makes sense for
 * the merchant — daily cron, manual admin trigger, end-of-billing-period job.
 *
 * Hosted Revshare uses the same meter (3% of GMV instead of 1.5%) — it just
 * has a different metered price. The reporter is mode-aware and picks the
 * correct meter event_name for each tier.
 *
 * What is billed, per attributed conversion (usage-ledger.ts has the exact
 * definition, docs/platform-fee.md the reasoning): on the old rule, its
 * revenue less refunds; on the commission-floor rule, which a tenant moves
 * to at its effective date (fee-terms.ts),
 *
 *   max(revenueRate × revenue, commissionRate × commissions) / meterRate
 *
 * — the fee in revenue-equivalent units, so the one meter and its existing
 * prices still bill exactly the fee. Each report diffs every conversion's
 * billable value against what the UsageLedger says was already billed for
 * it, and records the difference: new usage is billed, usage refunded,
 * charged back or reversed after it was billed is credited. Stripe meters
 * reject negative usage, so the report sends the net, and a net credit is
 * carried forward (Config UsageCarryUsd) and netted against the next report. A refund in the same window as its
 * conversion just never gets billed.
 *
 * Idempotency: Stripe's Meter Event API accepts an optional `identifier` so
 * the same period reported twice is a no-op. We key it on the high-water
 * mark (the last report's time), and the report's ledger rows carry it. A
 * re-run diffs against the ledger, so it finds nothing left to bill or
 * credit. If the report fails we DO NOT advance the high-water mark or
 * keep the ledger rows, so the next run picks up from the same point.
 *
 * Multi-tenant: each tenant has its own Stripe customer + high-water mark
 * (Config rows are tenant-scoped). The scheduler iterates tenants and calls
 * this once per tenant; the billing route passes the request's tenant.
 *
 * Currency: the metered prices are USD, and GMV is in whatever currency the
 * brand's customers paid. GMV is summed per currency (never across) and
 * converted to USD at the ECB reference rate (fx.ts); the rates are frozen
 * into the report. A currency with no published rate is held out of the
 * meter and alerted on, never billed at a guess. If the rate feed is down
 * the run is skipped and the high-water mark stays put, so the next run
 * bills the window.
 */

import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { TABLES } from '@openpartner/db';
import { CONFIG_KEYS, deleteConfig, getConfig, setConfig } from './config.js';
import { requireStripe } from './stripe.js';
import { getTenantBillingState } from './billing-plan.js';
import { convertToUsd, FxUnavailableError, type FxSnapshot } from './fx.js';
import {
  compareRules,
  deltaTotals,
  insertLedgerEntries,
  ledgerDeltas,
  OLD_RULE,
  openLedger,
  priceDeltas,
  round6,
  sumBillableBasis,
  type LedgerDelta,
  type PricedRun,
} from './usage-ledger.js';
import { resolveTenantFee, type TenantFee } from './fee-terms.js';
import { db as platformDb } from './db.js';
import { getFeeRuleSettings } from './platform-settings.js';

// Revenue event types are invoice_paid / subscription_created plus what each
// program declares (Program.revenueEventTypes). The platform-wide
// OPENPARTNER_BILLABLE_EVENT_TYPES_EXTRA env var this replaced was copied
// onto every program by migration 20261017020000_platform_fee_rule, and is
// no longer read (server.ts warns while it is still set).

// Mode → meter event_name. Network access uses a separate meter for
// Network-originated payouts; that's reported by the payout runner, not here.
const MODE_TO_METER: Record<string, string> = {
  flat: 'openpartner_attributed_gmv',
  revshare: 'openpartner_attributed_gmv',
};

/** Amounts keyed by upper-case ISO 4217 code. */
export type AmountsByCurrency = Record<string, number>;

export interface UsageReportResult {
  mode: string;
  meterEventName: string;
  customerId: string;
  /** USD sent to the meter: new GMV converted, less credits and any carried
   *  credit; held-out currencies excluded. */
  amount: number;
  /** Attributed GMV billed for the first time (or newly billable), per
   *  currency, before conversion. */
  gmvByCurrency?: AmountsByCurrency;
  /** Rates the conversion used, when any GMV wasn't USD. */
  fx?: FxSnapshot;
  /** GMV in currencies with no published rate: not metered, alerted. */
  heldOut?: AmountsByCurrency;
  /** Previously billed GMV credited back (refunds, chargebacks, reversed
   *  commissions), per currency, negative. */
  creditsByCurrency?: AmountsByCurrency;
  /** Those credits in USD, at the rates they were billed at (negative). */
  creditUsd?: number;
  /** Credit carried in from earlier reports (negative). */
  carriedInUsd?: number;
  /** What's left to net against the next report: negative is credit still
   *  owed to the brand, positive is a fraction of a cent still to bill. */
  carriedForwardUsd?: number;
  /** The fee terms new conversions were billed under. */
  feeRule?: FeeRuleAudit;
  rangeStart: Date | null;
  rangeEnd: Date;
  reported: boolean;
  reason?: string;
}

/**
 * Partner.metadata.source value the Network's partnership-approve
 * federation sets when it provisions a Partner on the brand (POST
 * /partners). It has been sent since the Network's first release, so it
 * marks every Network-originated partner, old or new.
 */
export const NETWORK_ORIGIN_SOURCE = 'openpartner_network';

/**
 * Sum payout amounts, per currency, for payouts whose Partner came from
 * the OpenPartner Network — i.e., Partner.metadata.source is
 * NETWORK_ORIGIN_SOURCE, set when the Network's approve flow created
 * the Partner.
 *
 * NOT Partner.metadata.network.creatorId: that is a sync stamp written
 * whenever a partner is pushed TO the Network — including a partner the
 * brand recruited itself who then opted in to the Network
 * (network-consent.ts), and everyone the old brand-level auto-enroll
 * pushed. Billing on it charged the Network fee on direct recruits. Nor
 * PartnerNetworkConsent: consent is the partner choosing to be listed,
 * not the Network having found them. PartnerProgram.source='offering'
 * isn't usable either: grants that predate it were backfilled as
 * 'admin', and the brand can revoke them.
 *
 * This is what the Network bills the vendor on (3% metered). Only
 * 'paid' payouts count — pending / failed don't generate Network fee
 * because no money actually moved to the partner.
 *
 * Tenant scope: caller provides db + GUC.
 */
export async function aggregateNetworkOriginatedPayouts(
  db: Knex,
  since: Date | null,
  until: Date,
): Promise<AmountsByCurrency> {
  const q = db(TABLES.Payout)
    .join(TABLES.Partner, `${TABLES.Partner}.id`, `${TABLES.Payout}.partnerId`)
    .where(`${TABLES.Payout}.status`, 'paid')
    .andWhere(`${TABLES.Payout}.completedAt`, '<=', until)
    .andWhereRaw(`"${TABLES.Partner}"."metadata"->>'source' = ?`, [NETWORK_ORIGIN_SOURCE]);
  if (since) q.andWhere(`${TABLES.Payout}.completedAt`, '>', since);
  return sumByCurrency(db, q, `"${TABLES.Payout}"."currency"`, `"${TABLES.Payout}"."amount"`);
}

/**
 * Billable attributed GMV on the old rule, per currency, for conversions with
 * `ts > since` and `ts <= until`, as of now: the value of revenue events
 * (invoice_paid, subscription_created, and the types their program
 * declares) that have at least one Attribution row (a partner was
 * credited), less what has been refunded or charged back where the partner
 * gave the commission back too, and nothing for a conversion whose
 * commissions were all reversed (see usage-ledger.ts). Refund, chargeback
 * and dispute events never count themselves. Currencies are never added
 * together:
 * 963,377 INR and 85,000 USD are two amounts, not 1,048,377 of anything.
 *
 * The reporter doesn't use this window sum — it diffs against the
 * UsageLedger, which also catches changes to conversions outside a window.
 *
 * Tenant scope is provided by the caller (req.db with app.tenant_id set, or
 * a transaction the scheduler opened with the GUC pinned).
 */
export async function aggregateAttributedGmv(db: Knex, since: Date | null, until: Date): Promise<AmountsByCurrency> {
  return sumBillableBasis(db, since, until);
}

/**
 * Group a money query by currency. Codes are compared upper-cased, so "inr"
 * and "INR" are one currency, and a null currency is USD, which is what
 * every reader of these rows has always taken it to mean.
 */
async function sumByCurrency(
  db: Knex,
  q: Knex.QueryBuilder,
  currencyCol: string,
  amountCol: string,
): Promise<AmountsByCurrency> {
  const code = `upper(coalesce(${currencyCol}, 'USD'))`;
  const rows = (await q
    .select(db.raw(`${code} as currency`), db.raw(`sum(${amountCol}) as total`))
    .groupByRaw(code)) as Array<{ currency: string; total: string | null }>;
  const out: AmountsByCurrency = {};
  for (const r of rows) {
    const total = Number(r.total ?? 0);
    if (total !== 0) out[r.currency] = total;
  }
  return out;
}

/**
 * Report aggregated GMV to Stripe via the Meter Events API. The meter
 * (openpartner_attributed_gmv) must exist in the platform's Stripe account
 * and the merchant's subscription must include the metered price tied to
 * the same meter. Both are provisioned by `scripts/setup-stripe.mjs`.
 */
export async function reportUsageToStripe(db: Knex, tenantId: string): Promise<UsageReportResult> {
  const state = await getTenantBillingState(db, tenantId);
  const mode = state.mode;
  const meterEventName = MODE_TO_METER[mode];
  if (!meterEventName) {
    return {
      mode,
      meterEventName: '',
      customerId: '',
      amount: 0,
      rangeStart: null,
      rangeEnd: new Date(),
      reported: false,
      reason: `usage reporting is not configured for mode=${mode}`,
    };
  }

  // Read Stripe customer from Tenant column (canonical) — fall back to
  // the legacy Config key for tenants that subscribed before the
  // billingPlan migration backfilled it. Both should be equivalent
  // post-migration.
  const customerId =
    state.stripeCustomerId ??
    (await getConfig<string>(db, tenantId, CONFIG_KEYS.StripeMerchantCustomerId));
  if (!customerId) {
    return {
      mode,
      meterEventName,
      customerId: '',
      amount: 0,
      rangeStart: null,
      rangeEnd: new Date(),
      reported: false,
      reason: 'no Stripe merchant customer configured (subscribe via /billing/checkout first)',
    };
  }

  const stripe = requireStripe();

  // Serialise runs for this tenant (scheduler + a manual trigger, or two
  // replicas): the second waits, then diffs against the first's committed
  // ledger rows and finds nothing to bill twice. Outside a transaction the
  // lock wouldn't outlive this statement; both callers (the scheduler and
  // the request middleware) always open one.
  if ((db as Knex.Transaction).isTransaction) {
    await db.raw('select pg_advisory_xact_lock(hashtext(?))', [`openpartner.usage-report.${tenantId}`]);
  }

  // Recovery path: a report was frozen but the run crashed before advancing
  // the high-water mark. Re-send it VERBATIM (same identifier ⇒ Stripe's
  // Meter Events API dedupes, so no double-count) rather than aggregating a
  // fresh — and overlapping — window.
  const pending = await getConfig<PendingUsageReport>(db, tenantId, CONFIG_KEYS.PendingUsageReport);
  if (pending) {
    // Staleness guard: Stripe rejects meter events with a timestamp beyond
    // its ~35-day window, so a pending row left by a multi-week outage can
    // never be resent — it would block this tenant's reporting forever. And
    // past Stripe's ≥24h dedup guarantee a resend risks double-billing. Once
    // it's this old, abandon it: advance past the window and ALERT for manual
    // reconciliation rather than double-bill or wedge the tenant. (Trades a
    // rare, loud under-report for a silent double-charge — the safe direction
    // for billing.)
    const STALE_PENDING_MS = 30 * 24 * 60 * 60 * 1000;
    if (Date.now() - new Date(pending.rangeEndIso).getTime() > STALE_PENDING_MS) {
      console.error(
        `[usage] ALERT: abandoning stale pending usage report tenant=${tenantId} ` +
          `rangeEnd=${pending.rangeEndIso} amount=${pending.amount} — reconcile in Stripe manually`,
      );
      // Its ledger rows stay: they're treated as billed, like the window.
      await finishReport(db, tenantId, pending);
      return { mode, ...pendingResult(pending), reported: false, reason: 'stale_pending_abandoned' };
    }
    await stripe.billing.meterEvents.create({
      event_name: pending.meterEventName,
      payload: { stripe_customer_id: pending.customerId, value: pending.amount.toFixed(2) },
      identifier: pending.identifier,
      timestamp: Math.floor(new Date(pending.rangeEndIso).getTime() / 1000),
    });
    await finishReport(db, tenantId, pending);
    return { mode, ...pendingResult(pending), reported: true, reason: 'resent frozen report (crash recovery)' };
  }

  const lastReportedAtIso = await getConfig<string>(db, tenantId, CONFIG_KEYS.LastUsageReportedAt);
  const rangeStart = lastReportedAtIso ? new Date(lastReportedAtIso) : null;
  const rangeEnd = new Date();
  // The identifier is Stripe's dedup key, keyed on the period START (the
  // high-water mark), NOT rangeEnd: rangeStart is identical for two runs
  // racing the same period, so they produce the SAME identifier and Stripe
  // dedupes the double-submit; distinct periods have distinct starts.
  const identifier = `op-usage-${mode}-${tenantId}-${rangeStart ? rangeStart.toISOString() : 'genesis'}`;
  // The report's ledger rows: its identifier plus this run's end, so a
  // mark that ever repeats (a wiped Config row puts it back to genesis)
  // can't collide with an earlier report's rows and wedge the tenant.
  const reportKey = `${identifier}@${rangeEnd.toISOString()}`;

  const feeSettings = await getFeeRuleSettings(platformDb);
  const fee = await resolveTenantFee(db, tenantId, state, { settings: feeSettings });
  let deltas: LedgerDelta[] = [];
  let run: PricedRun;
  try {
    await openLedger(db, tenantId, rangeStart);
    deltas = await ledgerDeltas(db, tenantId, rangeEnd, fee ?? OLD_RULE, rangeStart);
    run = await priceDeltas(deltas);
  } catch (err) {
    if (!(err instanceof FxUnavailableError)) throw err;
    // Nothing billed or credited and the mark stays (an opening balance,
    // if this run recorded one, is kept): the next run converts and bills.
    const { gmvByCurrency } = deltaTotals(deltas);
    console.error(
      `[usage] ALERT: usage not reported, no FX rates tenant=${tenantId} ` +
        `gmv=${JSON.stringify(gmvByCurrency)}: ${err.message}`,
    );
    return {
      mode,
      meterEventName,
      customerId,
      amount: 0,
      gmvByCurrency,
      rangeStart,
      rangeEnd,
      reported: false,
      reason: 'fx_rates_unavailable',
    };
  }

  // Stripe meters reject negative usage: credits are netted against this
  // report's new GMV, and whatever they don't cover waits for the next one.
  const carriedInUsd = Number((await getConfig<number>(db, tenantId, CONFIG_KEYS.UsageCarryUsd)) ?? 0);
  const net = round6(run.usd + carriedInUsd);
  const amount = net > 0 ? Math.round(net * 100) / 100 : 0;
  const carryOutUsd = round6(net - amount);
  const heldOut = Object.keys(run.heldOut).length > 0 ? run.heldOut : undefined;
  const credited = Object.keys(run.creditsByCurrency).length > 0;
  const audit: ReportAudit = {
    gmvByCurrency: run.gmvByCurrency,
    ...(run.fx ? { fx: run.fx } : {}),
    ...(heldOut ? { heldOut } : {}),
    ...(credited ? { creditsByCurrency: run.creditsByCurrency, creditUsd: run.creditUsd } : {}),
    ...(carriedInUsd !== 0 ? { carriedInUsd } : {}),
    ...(carryOutUsd !== 0 ? { carriedForwardUsd: carryOutUsd } : {}),
    ...(fee ? { feeRule: feeRuleAudit(fee, run) } : {}),
  };
  // Shadow: what the new rule would have billed, for a tenant still on the
  // old one. Never blocks or changes the report.
  const shadow =
    feeSettings.shadow && fee && (fee.effectiveAt === null || fee.effectiveAt > rangeEnd)
      ? await shadowComparison(db, tenantId, fee, rangeStart, rangeEnd)
      : null;
  if (heldOut) {
    // The window still advances (a currency the ECB doesn't publish would
    // wedge the tenant forever otherwise), so this line is the record:
    // invoice the held-out GMV by hand.
    console.error(
      `[usage] ALERT: GMV held out of the meter, no reference rate tenant=${tenantId} ` +
        `range=${rangeStart ? rangeStart.toISOString() : 'genesis'}..${rangeEnd.toISOString()} ` +
        `heldOut=${JSON.stringify(heldOut)}: bill it manually`,
    );
  }
  if (credited) {
    console.log(
      `[usage] crediting refunded/reversed GMV tenant=${tenantId} credits=${JSON.stringify(run.creditsByCurrency)} ` +
        `creditUsd=${run.creditUsd} carriedIn=${carriedInUsd} carriedForward=${carryOutUsd}`,
    );
  }

  if (amount <= 0) {
    // Nothing for the meter. Still record the rows and advance the mark, so
    // credits aren't re-derived and the carry is what's left. No Stripe
    // call, so no exactly-once concern here.
    await db.transaction(async (trx) => {
      await insertLedgerEntries(trx, tenantId, reportKey, run.entries);
      if (shadow) await insertShadow(trx, tenantId, fee!.mode, reportKey, rangeStart, rangeEnd, shadow);
      await setCarry(trx, tenantId, carryOutUsd);
      await setConfig(trx, tenantId, CONFIG_KEYS.LastUsageReportedAt, rangeEnd.toISOString());
    });
    return {
      mode,
      meterEventName,
      customerId,
      amount: 0,
      ...audit,
      rangeStart,
      rangeEnd,
      reported: false,
      reason:
        run.creditUsd < 0 || carriedInUsd < 0
          ? 'refund credits cover the new GMV; the rest is carried forward'
          : heldOut
            ? 'only GMV with no reference rate in range'
            : 'no attributed GMV in range',
    };
  }

  // Freeze the report BEFORE calling Stripe: its ledger rows and the
  // frozen bounds+amount+identifier+carry commit together, so a crash
  // after Stripe accepts (but before the mark advances) re-sends this exact
  // row above, and the rows already say what it billed.
  const frozen: PendingUsageReport = {
    rangeStartIso: rangeStart ? rangeStart.toISOString() : null,
    rangeEndIso: rangeEnd.toISOString(),
    amount,
    identifier,
    meterEventName,
    customerId,
    carryOutUsd,
    ...audit,
  };
  await db.transaction(async (trx) => {
    await insertLedgerEntries(trx, tenantId, reportKey, run.entries);
    if (shadow) await insertShadow(trx, tenantId, fee!.mode, reportKey, rangeStart, rangeEnd, shadow);
    await setConfig(trx, tenantId, CONFIG_KEYS.PendingUsageReport, frozen);
  });

  await stripe.billing.meterEvents.create({
    event_name: meterEventName,
    payload: { stripe_customer_id: customerId, value: amount.toFixed(2) },
    identifier,
    timestamp: Math.floor(rangeEnd.getTime() / 1000),
  });

  await finishReport(db, tenantId, frozen);
  return {
    mode,
    meterEventName,
    customerId,
    amount,
    ...audit,
    rangeStart,
    rangeEnd,
    reported: true,
  };
}

/** The meter has the frozen report (or it was abandoned): carry what it
 *  left, advance the mark, clear the outbox. */
async function finishReport(db: Knex, tenantId: string, report: PendingUsageReport): Promise<void> {
  await db.transaction(async (trx) => {
    // Reports frozen before carry existed left none.
    if (report.carryOutUsd !== undefined) await setCarry(trx, tenantId, report.carryOutUsd);
    await setConfig(trx, tenantId, CONFIG_KEYS.LastUsageReportedAt, report.rangeEndIso);
    await deleteConfig(trx, tenantId, CONFIG_KEYS.PendingUsageReport);
  });
}

async function setCarry(db: Knex, tenantId: string, carryUsd: number): Promise<void> {
  if (carryUsd === 0) await deleteConfig(db, tenantId, CONFIG_KEYS.UsageCarryUsd);
  else await setConfig(db, tenantId, CONFIG_KEYS.UsageCarryUsd, carryUsd);
}

function pendingResult(p: PendingUsageReport): Omit<UsageReportResult, 'mode' | 'reported' | 'reason'> {
  return {
    meterEventName: p.meterEventName,
    customerId: p.customerId,
    amount: p.amount,
    gmvByCurrency: p.gmvByCurrency,
    fx: p.fx,
    heldOut: p.heldOut,
    creditsByCurrency: p.creditsByCurrency,
    creditUsd: p.creditUsd,
    carriedInUsd: p.carriedInUsd,
    carriedForwardUsd: p.carriedForwardUsd,
    feeRule: p.feeRule,
    rangeStart: p.rangeStartIso ? new Date(p.rangeStartIso) : null,
    rangeEnd: new Date(p.rangeEndIso),
  };
}

/** How a report's amount was reached. Absent fields on reports frozen
 *  before currencies were metered apart, or before refunds were credited. */
interface ReportAudit {
  gmvByCurrency?: AmountsByCurrency;
  fx?: FxSnapshot;
  heldOut?: AmountsByCurrency;
  creditsByCurrency?: AmountsByCurrency;
  creditUsd?: number;
  carriedInUsd?: number;
  carriedForwardUsd?: number;
  feeRule?: FeeRuleAudit;
}

/** The fee terms of a report's new conversions. */
export interface FeeRuleAudit {
  /** Conversions first attributed at or after this are on the new rule. */
  effectiveAt: string | null;
  revenueRate: number;
  commissionRate: number;
  meterRate: number;
  contract: boolean;
  /** The part of the report's USD from conversions on the new rule. */
  newRuleUsd: number;
}

function feeRuleAudit(fee: TenantFee, run: PricedRun): FeeRuleAudit {
  return {
    effectiveAt: fee.effectiveAt ? fee.effectiveAt.toISOString() : null,
    revenueRate: fee.revenueRate,
    commissionRate: fee.commissionRate,
    meterRate: fee.meterRate,
    contract: fee.contract,
    newRuleUsd: run.newRuleUsd,
  };
}

/** Old rule vs new rule for the conversions first attributed in a window,
 *  in USD. */
export interface ShadowComparison {
  conversions: number;
  oldBasisUsd: number;
  newBasisUsd: number;
  oldFeeUsd: number;
  newFeeUsd: number;
  floorConversions: number;
  renamedSaleConversions: number;
  heldOut: AmountsByCurrency | null;
}

/**
 * What the new rule would bill for the conversions first attributed in
 * (rangeStart, rangeEnd], next to what the old rule bills, at the tenant's
 * rates. Null when the rate feed is down: a shadow row is never worth
 * failing a report for.
 */
export async function shadowComparison(
  db: Knex,
  tenantId: string | null,
  fee: Pick<TenantFee, 'revenueRate' | 'commissionRate' | 'meterRate'>,
  rangeStart: Date | null,
  rangeEnd: Date,
): Promise<ShadowComparison | null> {
  const rows = await compareRules(db, {
    tenantId,
    attributedAfter: rangeStart,
    attributedBy: rangeEnd,
    revenueRate: fee.revenueRate,
    commissionRate: fee.commissionRate,
  });
  const oldByCurrency: AmountsByCurrency = {};
  const newByCurrency: AmountsByCurrency = {};
  let conversions = 0;
  let floorConversions = 0;
  let renamedSaleConversions = 0;
  for (const r of rows) {
    if (r.oldBasis) oldByCurrency[r.currency] = r.oldBasis;
    if (r.newFee) newByCurrency[r.currency] = r.newFee;
    conversions += r.conversions;
    floorConversions += r.floorConversions;
    renamedSaleConversions += r.renamedSaleConversions;
  }
  try {
    const oldUsd = await convertToUsd(oldByCurrency);
    const newUsd = await convertToUsd(newByCurrency);
    const heldOut: AmountsByCurrency = {};
    for (const [c, a] of Object.entries(oldUsd.heldOut)) heldOut[`${c}:oldBasis`] = a;
    for (const [c, a] of Object.entries(newUsd.heldOut)) heldOut[`${c}:newFee`] = a;
    return {
      conversions,
      oldBasisUsd: oldUsd.amountUsd,
      oldFeeUsd: round6(oldUsd.amountUsd * fee.meterRate),
      newFeeUsd: newUsd.amountUsd,
      newBasisUsd: fee.meterRate > 0 ? round6(newUsd.amountUsd / fee.meterRate) : 0,
      floorConversions,
      renamedSaleConversions,
      heldOut: Object.keys(heldOut).length > 0 ? heldOut : null,
    };
  } catch (err) {
    if (!(err instanceof FxUnavailableError)) throw err;
    console.warn(`[usage] shadow comparison skipped, no FX rates tenant=${tenantId}: ${err.message}`);
    return null;
  }
}

async function insertShadow(
  db: Knex,
  tenantId: string,
  mode: string,
  reportKey: string,
  rangeStart: Date | null,
  rangeEnd: Date,
  s: ShadowComparison,
): Promise<void> {
  await db(TABLES.UsageFeeShadow)
    .insert({
      id: ulid(),
      tenantId,
      reportKey,
      rangeStart,
      rangeEnd,
      mode,
      conversions: s.conversions,
      oldBasisUsd: s.oldBasisUsd.toFixed(6),
      newBasisUsd: s.newBasisUsd.toFixed(6),
      oldFeeUsd: s.oldFeeUsd.toFixed(6),
      newFeeUsd: s.newFeeUsd.toFixed(6),
      floorConversions: s.floorConversions,
      renamedSaleConversions: s.renamedSaleConversions,
      heldOut: s.heldOut ? JSON.stringify(s.heldOut) : null,
      createdAt: new Date(),
    })
    .onConflict(['tenantId', 'reportKey'])
    .ignore();
}

interface PendingUsageReport extends ReportAudit {
  rangeStartIso: string | null;
  rangeEndIso: string;
  /** USD, as sent to the meter. */
  amount: number;
  identifier: string;
  meterEventName: string;
  customerId: string;
  /** The carry once this report is on the meter. */
  carryOutUsd?: number;
}
