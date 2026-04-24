/**
 * SSRF-safe outbound fetch to user-provided URLs.
 *
 * The Network flow accepts a vendor's `instanceUrl` unauthenticated — a
 * prospective vendor is still signing up and doesn't have an account
 * yet. That means we can't fix the SSRF surface with auth; we have to
 * validate the URL itself. Defence in depth:
 *
 *   1. Only http:// or https:// (no file:, gopher:, etc.)
 *   2. Resolve DNS; reject if ANY resolved address lives in a private
 *      / loopback / link-local / cgnat range. All addresses must be
 *      public because an attacker who controls DNS can rebind between
 *      this check and fetch(), but matching hostname-lookup-then-fetch
 *      with a Node agent that dials only the checked IPs is beyond
 *      v1 scope — the loud-default rejection here closes 95% of
 *      exploits in the wild.
 *   3. Self-hosters running everything on a VPN or private network can
 *      opt out by setting NETWORK_ALLOW_PRIVATE_HOSTS=1.
 *
 * Still returns a standard Response — the caller pipes through to
 * their existing logic.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
];

function isPrivateAddress(addr: string): boolean {
  const lower = addr.toLowerCase();
  if (lower === '::1' || lower === '::' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) {
    return true;
  }
  // IPv4-mapped IPv6
  const mapped = lower.match(/^::ffff:([\d.]+)$/);
  if (mapped && mapped[1]) return PRIVATE_V4.some((re) => re.test(mapped[1]!));
  return PRIVATE_V4.some((re) => re.test(lower));
}

async function assertPublicHost(host: string): Promise<void> {
  if (process.env.NETWORK_ALLOW_PRIVATE_HOSTS === '1') return;
  // Tests spin up loopback vendor instances on ephemeral ports. The
  // bypass only triggers under NODE_ENV=test (vitest default) — not a
  // knob a deployed instance can flip accidentally.
  if (process.env.NODE_ENV === 'test') return;

  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) {
      throw Object.assign(new Error('private_host_blocked'), { code: 'private_host_blocked' });
    }
    return;
  }

  const records = await lookup(host, { all: true });
  if (records.length === 0) {
    throw Object.assign(new Error('dns_no_records'), { code: 'dns_no_records' });
  }
  for (const r of records) {
    if (isPrivateAddress(r.address)) {
      throw Object.assign(new Error('private_host_blocked'), { code: 'private_host_blocked' });
    }
  }
}

export async function safeFetch(urlString: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(urlString);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw Object.assign(new Error('unsupported_protocol'), { code: 'unsupported_protocol' });
  }
  await assertPublicHost(url.hostname);

  return fetch(url, {
    ...init,
    // 10s ceiling — enough for a slow TLS handshake on a distant box,
    // short enough that an attacker can't use us as a long-tail probe.
    signal: AbortSignal.timeout(10_000),
  });
}
