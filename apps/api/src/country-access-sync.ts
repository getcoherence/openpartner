/**
 * The Network's copy of the country list (docs/country-access.md).
 *
 * One list for both services: the operator edits it in the ops console,
 * this platform stores it (country-access.ts), and we push the whole of it
 * to the Network's PUT /admin/country-access, which checks creators against
 * its own copy. The Network applies its sanctions defaults until the first
 * push, and never calls us, so a creator signing up while we're down is
 * still checked against the last list it was sent.
 *
 * Pushed on every console save and daily from the scheduler, so a push
 * that failed heals itself. The console reads the Network's copy back to
 * show when it was last synced and whether it still matches.
 */

import type { Knex } from 'knex';
import {
  getCountryAccessSettings,
  getCountryAccessUpdatedBy,
  type CountryAccessSettings,
} from './country-access.js';
import {
  adminGetCountryAccess,
  adminSetCountryAccess,
  NetworkAdminError,
  platformNetworkUrl,
} from './network-client.js';

export type CountryAccessPush =
  | { status: 'synced'; syncedAt: string | null }
  /** No NETWORK_URL or NETWORK_ADMIN_API_KEY: nothing to push to. */
  | { status: 'not_configured' }
  | { status: 'failed'; error: string; detail: string };

export type NetworkCountryAccessStatus =
  | { configured: false }
  | {
      configured: true;
      ok: true;
      /** Null = never pushed; the Network applies its sanctions defaults. */
      syncedAt: string | null;
      updatedByEmail: string | null;
      /** The Network's copy is the list stored here. */
      matches: boolean;
      creatorsWithoutCountry: number | null;
    }
  /** `not_supported`: a Network from before country access (404). */
  | { configured: true; ok: false; error: string; detail: string };

function networkAdminUrl(): string | null {
  const url = platformNetworkUrl();
  return url && process.env.NETWORK_ADMIN_API_KEY ? url : null;
}

function failure(err: unknown): { error: string; detail: string } {
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof NetworkAdminError && err.status === 404) return { error: 'not_supported', detail };
  return { error: err instanceof NetworkAdminError && err.code ? err.code : 'network_call_failed', detail };
}

/** Send the Network the list as stored here, with the operator who last
 *  saved it. Never throws: the list here is the source of truth, and the
 *  daily re-push retries. */
export async function pushCountryAccessToNetwork(db: Knex): Promise<CountryAccessPush> {
  const networkUrl = networkAdminUrl();
  if (!networkUrl) return { status: 'not_configured' };
  const [settings, updatedByEmail] = await Promise.all([getCountryAccessSettings(db), getCountryAccessUpdatedBy(db)]);
  try {
    const res = await adminSetCountryAccess(networkUrl, settings, updatedByEmail);
    return { status: 'synced', syncedAt: res?.syncedAt ?? null };
  } catch (err) {
    const f = failure(err);
    console.error('[country-access-sync] push to the Network failed', f);
    return { status: 'failed', ...f };
  }
}

/** The Network's copy, compared with `local`. */
export async function networkCountryAccessStatus(local: CountryAccessSettings): Promise<NetworkCountryAccessStatus> {
  const networkUrl = networkAdminUrl();
  if (!networkUrl) return { configured: false };
  try {
    const remote = await adminGetCountryAccess(networkUrl);
    return {
      configured: true,
      ok: true,
      syncedAt: remote.syncedAt ?? null,
      updatedByEmail: remote.updatedByEmail ?? null,
      matches: sameCountryAccess(local, remote.settings),
      creatorsWithoutCountry: typeof remote.creatorsWithoutCountry === 'number' ? remote.creatorsWithoutCountry : null,
    };
  } catch (err) {
    return { configured: true, ok: false, ...failure(err) };
  }
}

/** Same switch and the same countries on the same basis, in any order. */
export function sameCountryAccess(a: CountryAccessSettings, b: CountryAccessSettings | undefined): boolean {
  if (!b || a.enforce !== b.enforce || !Array.isArray(b.blocked)) return false;
  const key = (s: CountryAccessSettings) =>
    s.blocked
      .map((x) => `${String(x.code).toUpperCase()}:${x.basis}`)
      .sort()
      .join(',');
  return key(a) === key(b);
}
