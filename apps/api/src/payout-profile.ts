/**
 * Partner payout details for the manual rail (docs/manual-payout-files.md).
 *
 * On the manual rail the brand pays partners itself, from its own PayPal or
 * Wise account. A PartnerPayoutProfile says where one partner wants the
 * money: a PayPal email, a bank account, a UPI ID, or free-text
 * instructions. The brand turns pending payouts into a PayPal or Wise batch
 * file (manual-payout-files.ts) and uploads it to its own account, so money
 * never passes through OpenPartner.
 *
 * Bank and PayPal details are sensitive, so:
 *   - everything but the method and the account's country is sealed with
 *     AES-256-GCM under SECRETS_ENCRYPTION_KEY (crypto.ts) before it is
 *     stored;
 *   - nothing here logs a detail, and an error never carries one: a JSON
 *     parse error's message quotes its input, so parse failures are
 *     swallowed rather than rethrown;
 *   - only the partner, the brand's admins and scoped keys holding
 *     `payout_profiles:*` can read them back (routes/payout-profiles.ts).
 *
 * A stored `details` is one of:
 *   - a sealed envelope (base64, never starts with "{"), the normal case;
 *   - plaintext JSON ("{…}"), only after a SQL-dump restore (the dump can't
 *     encrypt: the key is the app's), until the first read or the seal
 *     sweep (sealPlaintextPayoutProfiles, at startup and hourly) seals it;
 *   - an envelope this deployment can't open (sealed under another key).
 *     It reads as unreadable, and the partner has to enter their details
 *     again.
 */

import type { Knex } from 'knex';
import { z } from './zod.js';
import {
  TABLES,
  isCountryCode,
  type PartnerPayoutProfileRow,
  type PayoutProfileMethod,
  type PayoutProfileUpdatedBy,
} from '@openpartner/db';
import { decryptSecret, encryptSecret } from './crypto.js';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const trimmed = (max: number) => z.string().trim().min(1).max(max);
/** A name that lands in a payment file. A spreadsheet opening the file
 *  would run a leading =, +, - or @ as a formula, and the usual guard (a
 *  leading quote) would change the name the bank checks, so such names are
 *  refused instead. */
const fileSafeName = (max: number) =>
  trimmed(max).refine((v) => !/^[=+\-@]/.test(v), 'must not start with =, +, - or @');
// .optional() goes last so zod 4 types the key optional, as it is at
// runtime: an absent key stays absent.
const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v ? v : undefined))
    .optional();

const countrySchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .refine(isCountryCode, 'country must be an ISO 3166-1 alpha-2 code');

const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter ISO 4217 code')
  .transform((c) => c.toUpperCase());

/** Upper case, no spaces or dashes: how banks print an IBAN is not how
 *  payment files want it. */
const compact = (v: string) => v.replace(/[\s-]+/g, '').toUpperCase();

/** ISO 13616 mod-97 check. Catches a mistyped digit before a batch file
 *  is rejected, or worse, accepted for someone else's account. */
export function isValidIban(raw: string): boolean {
  const iban = compact(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const digits = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) remainder = (remainder * 10 + Number(d)) % 97;
  }
  return remainder === 1;
}

/** ABA routing number: 9 digits with the 3-7-1 checksum. */
export function isValidAbaRouting(raw: string): boolean {
  if (!/^\d{9}$/.test(raw)) return false;
  const d = raw.split('').map(Number);
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0;
}

/** Wise needs the account holder's address for an account in these
 *  currencies (docs.wise.com recipient create, checked 2026-10-20:
 *  "required only if target currency is USD, PHP, THB or TRY, or if the
 *  source currency is USD or AUD"; the source side is the payout's,
 *  checked when the file is made). */
export const ADDRESS_REQUIRED_CURRENCIES: ReadonlySet<string> = new Set(['USD', 'PHP', 'THB', 'TRY']);
/** Wise needs the state or province in a recipient address in these
 *  countries (same page: "State (required for US, Canada, Brazil)"). */
export const STATE_REQUIRED_COUNTRIES: ReadonlySet<string> = new Set(['US', 'CA', 'BR']);

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254)
  .refine((v) => !/^[=+\-@]/.test(v), 'must not start with =, +, - or @');

export const paypalDetailsSchema = z.object({
  method: z.literal('paypal'),
  /** The email the partner's PayPal account is registered to. */
  email: emailSchema,
  /** Where the PayPal account is registered. Optional: the file doesn't
   *  need it, but a blocked country keeps the partner out of the file. */
  country: countrySchema.optional(),
});

export const bankDetailsSchema = z
  .object({
    method: z.literal('bank'),
    /** The name on the account, as the bank has it. */
    accountHolderName: fileSafeName(140),
    /** Personal or business account; Wise asks for it. */
    accountHolderType: z.enum(['person', 'business']).default('person'),
    /** Where the bank is. */
    country: countrySchema,
    /** The account's currency: what the partner receives. */
    currency: currencySchema,
    iban: z
      .string()
      .transform((v) => (v ? compact(v) : undefined))
      .refine((v) => v === undefined || isValidIban(v), 'iban is not a valid IBAN')
      .optional(),
    bic: z
      .string()
      .transform((v) => (v ? compact(v) : undefined))
      .refine((v) => v === undefined || /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v), 'bic must be an 8 or 11 character SWIFT/BIC code')
      .optional(),
    accountNumber: z
      .string()
      .transform((v) => (v ? v.replace(/[\s-]+/g, '') : undefined))
      .refine((v) => v === undefined || /^[A-Za-z0-9]{4,34}$/.test(v), 'accountNumber must be 4-34 letters or digits')
      .optional(),
    /** UK sort code (6 digits). */
    sortCode: z
      .string()
      .transform((v) => (v ? v.replace(/[\s-]+/g, '') : undefined))
      .refine((v) => v === undefined || /^\d{6}$/.test(v), 'sortCode must be 6 digits')
      .optional(),
    /** US ABA routing number (9 digits). */
    routingNumber: z
      .string()
      .transform((v) => (v ? v.replace(/[\s-]+/g, '') : undefined))
      .refine((v) => v === undefined || isValidAbaRouting(v), 'routingNumber is not a valid ABA routing number')
      .optional(),
    /** US accounts: checking or savings. */
    accountType: z.enum(['checking', 'savings']).optional(),
    /** Indian Financial System Code (11 characters, 5th is 0). */
    ifsc: z
      .string()
      .transform((v) => (v ? compact(v) : undefined))
      .refine((v) => v === undefined || /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v), 'ifsc must be an 11 character IFSC')
      .optional(),
    /** Where Wise sends the partner its transfer notice. Optional. */
    email: emailSchema.optional(),
    /** The account holder's address. Some currencies need it (USD, for one). */
    address: z
      .object({
        line1: fileSafeName(140),
        city: fileSafeName(80),
        postCode: optionalTrimmed(20).refine((v) => !v || /^[A-Za-z0-9 ]+$/.test(v), 'postCode must be letters, digits and spaces'),
        state: optionalTrimmed(40).refine((v) => !v || !/^[=+\-@]/.test(v), 'must not start with =, +, - or @'),
        country: countrySchema,
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    const need = (path: string | string[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: Array.isArray(path) ? path : [path], message });
    // What Wise asks of a recipient's address, whatever the route.
    if (!v.address && ADDRESS_REQUIRED_CURRENCIES.has(v.currency)) {
      need('address', `a ${v.currency} account needs the holder’s address`);
    }
    if (v.address && STATE_REQUIRED_COUNTRIES.has(v.address.country) && !v.address.state) {
      need(['address', 'state'], `an address in ${v.address.country} needs its state or province`);
    }
    // An account is reachable by IBAN, or by a local account number plus
    // what routes to its bank in that currency (bankRoute).
    if (v.iban) {
      if (v.accountNumber) need('accountNumber', 'give an iban or an accountNumber, not both');
      if (v.iban.slice(0, 2) !== v.country) need('iban', 'iban is for a different country');
      return;
    }
    if (!v.accountNumber) return need('iban', 'give an iban or an accountNumber');
    switch (bankRoute(v)) {
      case 'gbp_local':
        if (!v.sortCode) need('sortCode', 'a GBP account number needs its sortCode');
        return;
      case 'usd_local':
        if (!v.routingNumber) need('routingNumber', 'a USD account number needs its routingNumber');
        if (!v.accountType) need('accountType', 'a USD account number needs its accountType');
        return;
      case 'inr_local':
        if (!v.ifsc) need('ifsc', 'an INR account number needs its ifsc');
        if (!/^\d{5,20}$/.test(v.accountNumber)) need('accountNumber', 'an INR account number is 5-20 digits');
        return;
      case 'swift':
        if (!v.bic) need('bic', 'an account number in this currency needs the bank’s bic (SWIFT)');
        if (!v.address) need('address', 'an international (SWIFT) transfer needs the holder’s address');
        return;
      case 'iban':
        return;
    }
  });

/**
 * How a bank account is reached. IBAN wherever there is one; otherwise the
 * local scheme for the three currencies with one here (UK sort code, US
 * ACH, Indian IFSC), and SWIFT for the rest.
 */
export type BankRoute = 'iban' | 'gbp_local' | 'usd_local' | 'inr_local' | 'swift';

export function bankRoute(v: { iban?: string; currency: string }): BankRoute {
  if (v.iban) return 'iban';
  if (v.currency === 'GBP') return 'gbp_local';
  if (v.currency === 'USD') return 'usd_local';
  if (v.currency === 'INR') return 'inr_local';
  return 'swift';
}

export const upiDetailsSchema = z.object({
  method: z.literal('upi'),
  /** The UPI ID (virtual payment address), e.g. name@okaxis. */
  vpa: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$/, 'vpa must look like name@bank'),
  /** The name the UPI ID resolves to, for checking before paying. */
  name: optionalTrimmed(140),
});

/** How a UPI ID's country is stored: UPI is Indian. */
const UPI_COUNTRY = 'IN';

export const otherDetailsSchema = z.object({
  method: z.literal('other'),
  /** How the partner wants to be paid, in their own words. */
  instructions: trimmed(1000),
  country: countrySchema.optional(),
});

/** PUT /partners/:id/payout-profile body. */
export const payoutDetailsSchema = z.discriminatedUnion('method', [
  paypalDetailsSchema,
  // The fields alone: parsePayoutDetails runs the cross-field checks once
  // these pass, as it did when zod 3's union couldn't take a refined object.
  z.object(bankDetailsSchema.shape),
  upiDetailsSchema,
  otherDetailsSchema,
]);

export type PaypalDetails = z.infer<typeof paypalDetailsSchema>;
export type BankDetails = z.infer<typeof bankDetailsSchema>;
export type UpiDetails = z.infer<typeof upiDetailsSchema>;
export type OtherDetails = z.infer<typeof otherDetailsSchema>;
export type PayoutDetails = PaypalDetails | BankDetails | UpiDetails | OtherDetails;

/**
 * Validate a payout-details body. Returns zod's flattened errors on
 * failure: field names and messages only, never the values.
 */
export function parsePayoutDetails(
  body: unknown,
): { ok: true; details: PayoutDetails } | { ok: false; error: z.core.$ZodFlattenedError<unknown> } {
  const first = payoutDetailsSchema.safeParse(body);
  if (!first.success) return { ok: false, error: first.error.flatten() };
  if (first.data.method !== 'bank') return { ok: true, details: first.data };
  const bank = bankDetailsSchema.safeParse(body);
  if (!bank.success) return { ok: false, error: bank.error.flatten() };
  return { ok: true, details: bank.data };
}

/** The account's country, stored in the clear for the country-access
 *  check. UPI is Indian by definition. */
function countryOf(details: PayoutDetails): string | null {
  if (details.method === 'upi') return UPI_COUNTRY;
  return details.country ?? null;
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

/** Seal details for storage. The method travels in its own column. */
export function sealDetails(details: PayoutDetails): string {
  const { method: _method, ...rest } = details;
  return encryptSecret(JSON.stringify(rest));
}

function isPlaintext(stored: string): boolean {
  return stored.trimStart().startsWith('{');
}

/** JSON.parse without its error: the message quotes the input. */
function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Open a stored `details` value: the fields as stored (method excluded),
 * or null when it can't be opened (sealed under another key, or damaged).
 * Never throws, and never says why beyond that.
 */
export function openDetails(stored: string): Record<string, unknown> | null {
  if (isPlaintext(stored)) return parseObject(stored);
  try {
    return parseObject(decryptSecret(stored));
  } catch {
    return null;
  }
}

/** A stored row's details, re-validated, or null when unreadable or no
 *  longer valid (a restored row from an older or hand-edited bundle). */
function detailsOf(row: Pick<PartnerPayoutProfileRow, 'method' | 'details'>): PayoutDetails | null {
  const fields = openDetails(row.details);
  if (!fields) return null;
  const parsed = parsePayoutDetails({ ...fields, method: row.method });
  return parsed.ok ? parsed.details : null;
}

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
}

function lastFour(v: string): string {
  return `•••• ${v.slice(-4)}`;
}

/** A one-line description that is safe to show anywhere: no full account
 *  number, email or UPI ID. */
export function summarizeDetails(details: PayoutDetails): string {
  switch (details.method) {
    case 'paypal':
      return `PayPal ${maskEmail(details.email)}`;
    case 'bank': {
      const account = details.iban
        ? `IBAN ${details.iban.slice(0, 2)} ${lastFour(details.iban)}`
        : `account ${lastFour(details.accountNumber ?? '')}`;
      return `Bank ${account} (${details.currency})`;
    }
    case 'upi': {
      const [handle = '', bank = ''] = details.vpa.split('@');
      return `UPI ${handle.slice(0, 1)}•••@${bank}`;
    }
    case 'other':
      return 'Other instructions';
  }
}

// ---------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------

export interface OpenedPayoutProfile {
  partnerId: string;
  method: PayoutProfileMethod;
  country: string | null;
  /** Null when the stored details can't be opened or no longer validate:
   *  the partner has to enter them again. */
  details: PayoutDetails | null;
  updatedBy: PayoutProfileUpdatedBy;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Seal opened fields for storage. Fields that no longer validate are
 * sealed as they are, never kept in the clear; they read as unreadable
 * and the partner enters their details again.
 */
function sealFields(method: unknown, fields: Record<string, unknown>): string {
  const parsed = parsePayoutDetails({ ...fields, method });
  return parsed.ok ? sealDetails(parsed.details) : encryptSecret(JSON.stringify(fields));
}

/** The sealed form of a stored plaintext value. Text that isn't even a
 *  JSON object is sealed as it is: nothing stays in the clear. */
function sealStored(method: unknown, stored: string): string {
  const fields = openDetails(stored);
  return fields ? sealFields(method, fields) : encryptSecret(stored);
}

/**
 * Seal any plaintext rows among these (a SQL-dump restore writes them; see
 * the header): one UPDATE per plaintext row, nothing for sealed ones.
 */
async function sealPlaintext(db: Knex, tenantId: string, rows: PartnerPayoutProfileRow[]): Promise<void> {
  for (const row of rows) {
    if (!isPlaintext(row.details)) continue;
    const sealed = sealStored(row.method, row.details);
    await db(TABLES.PartnerPayoutProfile)
      .where({ tenantId, partnerId: row.partnerId, details: row.details })
      .update({ details: sealed });
    row.details = sealed;
  }
}

/** SQL for "this stored value is plaintext JSON" (isPlaintext). */
const PLAINTEXT_SQL = `"details" ~ '^\\s*\\{'`;

/**
 * Seal every plaintext row on this deployment, across tenants, `batch`
 * rows at a time. Reads seal the rows they touch; this seals the rest, so
 * a SQL-dump restore leaves no partner's details in the clear for long.
 * Run at startup (server.ts) and hourly (scheduler.ts). Idempotent: a
 * sealed value never matches again. `db` must be the privileged pool: it
 * reads every tenant. Returns how many rows it sealed; logs nothing else.
 */
export async function sealPlaintextPayoutProfiles(db: Knex, batch = 500): Promise<number> {
  let sealed = 0;
  for (;;) {
    const rows = (await db<PartnerPayoutProfileRow>(TABLES.PartnerPayoutProfile)
      .whereRaw(PLAINTEXT_SQL)
      .limit(batch)
      .select('partnerId', 'method', 'details')) as Array<Pick<PartnerPayoutProfileRow, 'partnerId' | 'method' | 'details'>>;
    for (const row of rows) {
      sealed += await db(TABLES.PartnerPayoutProfile)
        .where({ partnerId: row.partnerId, details: row.details })
        .update({ details: sealStored(row.method, row.details) });
    }
    if (rows.length < batch) return sealed;
  }
}

function opened(row: PartnerPayoutProfileRow): OpenedPayoutProfile {
  return {
    partnerId: row.partnerId,
    method: row.method,
    country: row.country,
    details: detailsOf(row),
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getPayoutProfile(
  db: Knex,
  tenantId: string,
  partnerId: string,
): Promise<OpenedPayoutProfile | null> {
  const row = await db<PartnerPayoutProfileRow>(TABLES.PartnerPayoutProfile).where({ tenantId, partnerId }).first();
  if (!row) return null;
  await sealPlaintext(db, tenantId, [row]);
  return opened(row);
}

/** Payout profiles for these partners, keyed by partner id. */
export async function getPayoutProfiles(
  db: Knex,
  tenantId: string,
  partnerIds: readonly string[],
): Promise<Map<string, OpenedPayoutProfile>> {
  if (partnerIds.length === 0) return new Map();
  const rows = await db<PartnerPayoutProfileRow>(TABLES.PartnerPayoutProfile)
    .where({ tenantId })
    .whereIn('partnerId', [...partnerIds]);
  await sealPlaintext(db, tenantId, rows);
  return new Map(rows.map((r) => [r.partnerId, opened(r)]));
}

/** Insert or replace a partner's payout profile. */
export async function savePayoutProfile(
  db: Knex,
  tenantId: string,
  partnerId: string,
  details: PayoutDetails,
  updatedBy: PayoutProfileUpdatedBy,
): Promise<OpenedPayoutProfile> {
  const now = new Date();
  const values = {
    method: details.method,
    country: countryOf(details),
    details: sealDetails(details),
    updatedBy,
    updatedAt: now,
  };
  const [row] = (await db(TABLES.PartnerPayoutProfile)
    .insert({ partnerId, tenantId, ...values, createdAt: now })
    .onConflict('partnerId')
    .merge(values)
    .returning('*')) as PartnerPayoutProfileRow[];
  return opened(row!);
}

export async function deletePayoutProfile(db: Knex, tenantId: string, partnerId: string): Promise<boolean> {
  const n = await db(TABLES.PartnerPayoutProfile).where({ tenantId, partnerId }).del();
  return n > 0;
}

// ---------------------------------------------------------------------------
// Portability (export.ts)
// ---------------------------------------------------------------------------

/**
 * Export: `details` opened to its JSON object, because a sealed envelope
 * is useless anywhere but this deployment (docs/data-portability.md
 * "Payout details"). What can't be opened travels as stored.
 */
export function openForExport(row: Record<string, unknown>): Record<string, unknown> {
  if (typeof row.details !== 'string') return row;
  const fields = openDetails(row.details);
  return fields ? { ...row, details: fields } : row;
}

/**
 * JSON import: seal `details` again under this deployment's key. Accepts
 * the opened object an export writes, or a JSON string of one; anything
 * else (an envelope from another deployment) is kept as it came and reads
 * as unreadable.
 */
export function sealForImport(row: Record<string, unknown>): Record<string, unknown> {
  const raw = row.details;
  const fields =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : typeof raw === 'string' && isPlaintext(raw)
        ? parseObject(raw)
        : null;
  return fields ? { ...row, details: sealFields(row.method, fields) } : row;
}
