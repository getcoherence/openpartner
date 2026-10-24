/**
 * Countries the hosted platform does not serve (docs/country-access.md).
 *
 * Two kinds of entry, kept apart because they mean different things:
 *   - `sanctions`: US embargoes OpenPartner must follow as a US company
 *     (Cuba, Iran, North Korea) and Russia, where OFAC's 2024 determination
 *     bars US persons from providing enterprise software as a service.
 *     Crimea, Sevastopol and the occupied areas of Donetsk, Luhansk, Kherson
 *     and Zaporizhzhia have no country code: Ukrainians confirm they are
 *     outside them instead (`outsideOccupiedRegions`).
 *   - `policy`: countries the operator has independently chosen not to
 *     serve. Not a legal requirement, and never described as one. None
 *     ship as defaults: an operator adds them in the console, so they live
 *     in that deployment's settings rather than in this code.
 *
 * Rules are by LOCATION only — where the business is registered or the
 * person is based, plus where the request comes from — never nationality.
 *
 * Enforced only on the hosted multi-tenant platform. A self-hosted install
 * is the brand's own deployment, so its operator applies their own rules.
 * The list is an operator setting (PlatformSetting 'countryAccess', edited
 * in the /platform console), not env: it changes when sanctions do.
 */

import type { Knex } from 'knex';
import type { RequestHandler } from 'express';
import { ulid } from 'ulid';
import { z } from './zod.js';
import {
  OCCUPIED_REGION_COUNTRY,
  TABLES,
  isCountryCode,
  type LocationDeclarationRow,
  type PlatformSettingRow,
} from '@openpartner/db';
import { lookupIpCountry } from './geoip.js';
import { getTenancyMode } from './tenancy.js';

export type BlockBasis = 'sanctions' | 'policy';

export interface BlockedCountry {
  code: string;
  basis: BlockBasis;
}

export interface CountryAccessSettings {
  /** Master switch. Off = nothing is refused (declarations are still kept). */
  enforce: boolean;
  blocked: BlockedCountry[];
}

export const COUNTRY_ACCESS_DEFAULTS: CountryAccessSettings = {
  enforce: true,
  blocked: [
    { code: 'CU', basis: 'sanctions' },
    { code: 'IR', basis: 'sanctions' },
    { code: 'KP', basis: 'sanctions' },
    { code: 'RU', basis: 'sanctions' },
  ],
};

const SETTINGS_KEY = 'countryAccess';

function parseBlocked(v: unknown): BlockedCountry[] | null {
  if (!Array.isArray(v)) return null;
  const seen = new Set<string>();
  const out: BlockedCountry[] = [];
  for (const e of v) {
    const code = typeof e?.code === 'string' ? e.code.toUpperCase() : null;
    const basis = e?.basis === 'sanctions' || e?.basis === 'policy' ? (e.basis as BlockBasis) : null;
    if (!code || !isCountryCode(code) || !basis || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, basis });
  }
  return out;
}

export async function getCountryAccessSettings(db: Knex): Promise<CountryAccessSettings> {
  const row = await db<PlatformSettingRow>(TABLES.PlatformSetting).where({ key: SETTINGS_KEY }).first();
  const v = (row?.value ?? {}) as Partial<CountryAccessSettings>;
  return {
    enforce: typeof v.enforce === 'boolean' ? v.enforce : COUNTRY_ACCESS_DEFAULTS.enforce,
    blocked: parseBlocked(v.blocked) ?? COUNTRY_ACCESS_DEFAULTS.blocked,
  };
}

/** The operator who last saved the list, or null while the defaults stand. */
export async function getCountryAccessUpdatedBy(db: Knex): Promise<string | null> {
  const row = await db<PlatformSettingRow>(TABLES.PlatformSetting).where({ key: SETTINGS_KEY }).first();
  return row?.updatedByEmail ?? null;
}

export async function setCountryAccessSettings(
  db: Knex,
  patch: Partial<CountryAccessSettings>,
  operatorEmail: string,
): Promise<CountryAccessSettings> {
  const current = await getCountryAccessSettings(db);
  const next: CountryAccessSettings = {
    enforce: patch.enforce ?? current.enforce,
    blocked: patch.blocked ? (parseBlocked(patch.blocked) ?? current.blocked) : current.blocked,
  };
  await db(TABLES.PlatformSetting)
    .insert({ key: SETTINGS_KEY, value: next as unknown as never, updatedByEmail: operatorEmail, updatedAt: new Date() })
    .onConflict('key')
    .merge({ value: next as unknown as never, updatedByEmail: operatorEmail, updatedAt: new Date() });
  return next;
}

/** An ISO 3166-1 alpha-2 code, normalised to upper case, for request
 *  bodies that declare where a brand or partner is based. */
export function countryCodeSchema() {
  return z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine(isCountryCode, 'country must be an ISO 3166-1 alpha-2 code');
}

export type CountryAccessError = 'country_not_supported' | 'occupied_region_confirmation_required';

export type CountryCheck =
  | { ok: true; ipCountry: string | null }
  | { ok: false; error: CountryAccessError; ipCountry: string | null; via: 'declared' | 'ip' | 'region' };

/**
 * Decide whether a brand or partner may be served. `declared` is the
 * country they told us; `ip` is where the request comes from. Either one
 * landing on the list refuses. A Ukrainian declaration also needs the
 * occupied-regions confirmation.
 */
export async function checkCountryAccess(
  db: Knex,
  input: { declared?: string | null; ip?: string | null; outsideOccupiedRegions?: boolean | null },
): Promise<CountryCheck> {
  if (getTenancyMode() !== 'multi') return { ok: true, ipCountry: null };
  const settings = await getCountryAccessSettings(db);
  const ipCountry = await lookupIpCountry(input.ip);
  if (!settings.enforce) return { ok: true, ipCountry };
  const blocked = new Set(settings.blocked.map((b) => b.code));
  const declared = input.declared?.toUpperCase() ?? null;
  if (declared && blocked.has(declared)) {
    return { ok: false, error: 'country_not_supported', ipCountry, via: 'declared' };
  }
  if (ipCountry && blocked.has(ipCountry)) {
    return { ok: false, error: 'country_not_supported', ipCountry, via: 'ip' };
  }
  if (declared === OCCUPIED_REGION_COUNTRY && input.outsideOccupiedRegions !== true) {
    return { ok: false, error: 'occupied_region_confirmation_required', ipCountry, via: 'region' };
  }
  return { ok: true, ipCountry };
}

/** HTTP status for a refusal: a missing confirmation is a fixable form
 *  error, a blocked country is not. */
export function countryAccessStatus(error: CountryAccessError): 400 | 403 {
  return error === 'occupied_region_confirmation_required' ? 400 : 403;
}

/**
 * Sign-in gate: refuse requests coming from a blocked country. Mounted on
 * the endpoints that start or complete a sign-in — not on tracking (the
 * click router, identify, events), which serve brands' own visitors and
 * servers, not our customers.
 */
export function requireServedCountry(db: Knex, name: string): RequestHandler {
  return async (req, res, next) => {
    const check = await checkCountryAccess(db, { ip: req.ip });
    if (check.ok) return next();
    // Country only — never the IP or email — so the log holds no personal data.
    console.warn(`[country-access] ${name} refused`, { ipCountry: check.ipCountry });
    res.status(403).json({ error: check.error });
  };
}

export async function recordLocationDeclaration(
  db: Knex,
  row: Omit<LocationDeclarationRow, 'id' | 'createdAt' | 'outsideOccupiedRegions'> & {
    outsideOccupiedRegions?: boolean | null;
  },
): Promise<void> {
  const country = row.country.toUpperCase();
  await db<LocationDeclarationRow>(TABLES.LocationDeclaration).insert({
    id: ulid(),
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    tenantId: row.tenantId,
    country,
    outsideOccupiedRegions: country === OCCUPIED_REGION_COUNTRY ? (row.outsideOccupiedRegions ?? null) : null,
    ipCountry: row.ipCountry,
    source: row.source,
    declaredByEmail: row.declaredByEmail,
  });
}

/** The latest declared country for each subject, or nothing for a
 *  subject that never declared one. */
export async function latestDeclaredCountries(
  db: Knex,
  subjectKind: LocationDeclarationRow['subjectKind'],
  subjectIds: string[],
): Promise<Map<string, LocationDeclarationRow>> {
  if (subjectIds.length === 0) return new Map();
  const rows = await db<LocationDeclarationRow>(TABLES.LocationDeclaration)
    .whereIn('subjectId', subjectIds)
    .andWhere({ subjectKind })
    .orderBy('createdAt', 'asc');
  const out = new Map<string, LocationDeclarationRow>();
  for (const r of rows) out.set(r.subjectId, r);
  return out;
}
