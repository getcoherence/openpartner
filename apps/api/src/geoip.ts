/**
 * IP → country, for the hosted platform's country access rules
 * (country-access.ts). Not used for attribution.
 *
 * Why not Cloudflare's cf-ipcountry header: DO App Platform sits behind
 * Cloudflare but never forwards it (every prod Click had a null country),
 * and a header a client could send itself is no basis for a sanctions
 * control.
 *
 * Source, in order:
 *   1. GEOIP_COUNTRY_DB — path to any GeoIP2/GeoLite2-Country-shaped .mmdb
 *      (uncompressed). Self-hosters with a MaxMind licence use this.
 *   2. Otherwise DB-IP's free "IP to Country Lite" database (CC BY 4.0 —
 *      attribution: "IP Geolocation by DB-IP", https://db-ip.com), fetched
 *      once a month into OPENPARTNER_GEOIP_DIR (default: the OS temp dir).
 *
 * A lookup that can't answer returns null — callers treat that as
 * "unknown", never as "allowed by IP" evidence, and still enforce the
 * declared country.
 */

import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import maxmind, { type CountryResponse, type Reader } from 'maxmind';

export type IpCountryLookup = (ip: string | null | undefined) => Promise<string | null>;

let reader: Reader<CountryResponse> | null = null;
let readerMonth: string | null = null;
let loading: Promise<void> | null = null;
let lastAttemptAt = 0;
let override: IpCountryLookup | null = null;

/** A failed download is retried at most this often. */
const RETRY_MS = 6 * 60 * 60 * 1000;

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function cacheDir(): string {
  return process.env.OPENPARTNER_GEOIP_DIR || path.join(tmpdir(), 'openpartner-geoip');
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).size > 0;
  } catch {
    return false;
  }
}

/** Fetch one month's DB-IP Lite file into the cache. Returns its path, or
 *  null when DB-IP doesn't have that month (yet). */
async function downloadDbIp(month: string): Promise<string | null> {
  const dir = cacheDir();
  const file = path.join(dir, `dbip-country-lite-${month}.mmdb`);
  if (await fileExists(file)) return file;
  const res = await fetch(`https://download.db-ip.com/free/dbip-country-lite-${month}.mmdb.gz`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`db-ip download ${month}: HTTP ${res.status}`);
  await mkdir(dir, { recursive: true });
  // DB-IP serves it gzipped; the reader wants the raw .mmdb. Write to a
  // temp name and rename, so a crash mid-download never leaves a truncated
  // file that later looks cached.
  const tmp = `${file}.${process.pid}.part`;
  await writeFile(tmp, gunzipSync(Buffer.from(await res.arrayBuffer())));
  await rename(tmp, file);
  return file;
}

async function load(): Promise<void> {
  lastAttemptAt = Date.now();
  const configured = process.env.GEOIP_COUNTRY_DB;
  if (configured) {
    reader = await maxmind.open<CountryResponse>(configured);
    readerMonth = 'configured';
    return;
  }
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  // DB-IP publishes on the 1st; early in a month the new file may not be
  // up yet, so fall back to last month's.
  for (const month of [monthKey(now), monthKey(prev)]) {
    const file = await downloadDbIp(month);
    if (file) {
      reader = await maxmind.open<CountryResponse>(file);
      readerMonth = month;
      return;
    }
  }
  throw new Error('db-ip: no country database for this or last month');
}

function needsLoad(): boolean {
  if (loading) return false;
  if (process.env.GEOIP_COUNTRY_DB) return reader === null && Date.now() - lastAttemptAt > RETRY_MS;
  const stale = readerMonth !== monthKey(new Date());
  return (reader === null || stale) && Date.now() - lastAttemptAt > RETRY_MS;
}

/** Start (or refresh) loading the database without waiting for it. Called
 *  at boot so the first sign-in of the day doesn't pay for the download. */
export function warmGeoIp(): void {
  if (override || process.env.NODE_ENV === 'test' || !needsLoad()) return;
  loading = load()
    .catch((err) => {
      console.error('[geoip] could not load a country database — IP checks are off until it loads', {
        message: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      loading = null;
    });
}

export const lookupIpCountry: IpCountryLookup = async (ip) => {
  if (override) return override(ip);
  if (!ip) return null;
  // Express gives IPv4 clients as ::ffff:a.b.c.d on a dual-stack socket.
  const addr = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (!maxmind.validate(addr)) return null;
  warmGeoIp();
  if (!reader && loading) await loading;
  if (!reader) return null;
  const hit = reader.get(addr);
  const code = hit?.country?.iso_code;
  return typeof code === 'string' && code.length === 2 ? code.toUpperCase() : null;
};

/** Tests: answer every lookup with `fn` (null restores the real reader). */
export function setIpCountryLookupForTesting(fn: IpCountryLookup | null): void {
  override = fn;
}
