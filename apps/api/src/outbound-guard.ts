/**
 * SSRF guard for server-side outbound HTTP — webhook deliveries
 * (webhook-dispatcher.ts), partner postbacks (partner-postback.ts) and the
 * setup checks' fetch of a program's destination (setup-checks.ts), which
 * follows redirects itself, one guarded hop at a time.
 * Both fetch attacker-influenced URLs (a tenant admin sets webhook URLs; a
 * PARTNER sets postback URLs) and are usable as scan oracles (the webhook
 * test route returns status/error; postbacks store lastStatus/lastError).
 *
 * Design (block-by-default):
 *   1. Parse the URL; allow only http/https, no embedded credentials, and a
 *      port on the policy's allowlist.
 *   2. Resolve the host to EVERY address and reject unless each is globally
 *      routable public unicast (or explicitly allowed via the self-host
 *      private-CIDR escape hatch). Special-use hostnames are rejected too.
 *   3. Connect only to the pre-validated address by pinning it into a
 *      per-request undici dispatcher's `connect.lookup`, so DNS can't rebind
 *      between the check and the socket. The original URL still supplies
 *      Host/SNI/cert identity — only address resolution is substituted.
 *   4. Never follow redirects (redirect: 'manual'); a 3xx is a non-delivery.
 *
 * The policy is deployment-scoped, not tenant-scoped: identical guard for
 * admin webhooks and partner postbacks (an admin key can be compromised).
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';
import ipaddr from 'ipaddr.js';
import { getMode } from './stripe.js';
import { getTenancyMode } from './tenancy.js';

/** Thrown when a destination is refused by policy — before any socket is
 *  opened. `.message` is a stable code safe to surface to tenants/partners
 *  (no raw socket/DNS detail). */
export class OutboundBlockedError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'OutboundBlockedError';
  }
}

interface Pin {
  address: string;
  family: 4 | 6;
}

type Cidr = [ipaddr.IPv4 | ipaddr.IPv6, number];

export interface OutboundPolicy {
  /** Exact ports permitted. `null` = any port (self-host default). */
  allowedPorts: ReadonlySet<number> | null;
  /** CIDRs allowed despite being non-public (self-host escape hatch). */
  privateCidrs: readonly Cidr[];
}

let cached: OutboundPolicy | null = null;
let testOverride: OutboundPolicy | null = null;

/** Build (once) and return the deployment's outbound policy. Throws on
 *  misconfiguration — call once at boot (server.ts) so a bad config fails
 *  startup rather than every delivery. */
export function outboundPolicy(): OutboundPolicy {
  if (!cached) cached = buildPolicy();
  return cached;
}

/**
 * Partner-controlled destinations (postbacks) get a hardened view of the
 * policy: the private-CIDR escape hatch is stripped (a partner must never
 * reach operator-allowlisted internal ranges — that would hand every
 * partner a scan oracle), and ports are never left unrestricted (fall back
 * to 80/443 when the operator set no explicit allowlist). Admin-managed
 * webhook endpoints keep the full deployment policy.
 */
function partnerStrict(base: OutboundPolicy): OutboundPolicy {
  return {
    allowedPorts: base.allowedPorts ?? new Set([80, 443]),
    privateCidrs: [],
  };
}

/** Test hook: drop the cached policy so a test can rebuild it after changing
 *  the relevant env vars. */
export function __resetOutboundPolicyForTests(): void {
  cached = null;
}

/** Test hook: force the effective policy for every safeFetch (both trust
 *  levels), so an app-level integration test can reach a localhost receiver.
 *  Pass null to clear. */
export function __setOutboundPolicyForTests(policy: OutboundPolicy | null): void {
  testOverride = policy;
}

function buildPolicy(): OutboundPolicy {
  const selfhostSingle = getMode() === 'selfhost' && getTenancyMode() === 'single';

  const rawPorts = process.env.OPENPARTNER_OUTBOUND_ALLOWED_PORTS?.trim();
  let allowedPorts: ReadonlySet<number> | null;
  if (rawPorts) {
    const ports = new Set<number>();
    for (const p of rawPorts.split(',').map((s) => s.trim()).filter(Boolean)) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`Invalid OPENPARTNER_OUTBOUND_ALLOWED_PORTS entry: ${p}`);
      }
      ports.add(n);
    }
    if (ports.size === 0) throw new Error('OPENPARTNER_OUTBOUND_ALLOWED_PORTS lists no valid ports');
    allowedPorts = ports;
  } else {
    // Hosted: lock to 80/443. Self-host single-tenant: no port restriction
    // (operators legitimately hit local services on arbitrary ports).
    allowedPorts = selfhostSingle ? null : new Set([80, 443]);
  }

  const rawCidrs = process.env.OPENPARTNER_OUTBOUND_ALLOW_PRIVATE_CIDRS?.trim();
  const privateCidrs: Cidr[] = [];
  if (rawCidrs) {
    if (!selfhostSingle) {
      throw new Error(
        'OPENPARTNER_OUTBOUND_ALLOW_PRIVATE_CIDRS is only honored on selfhost+single deployments; unset it.',
      );
    }
    for (const c of rawCidrs.split(',').map((s) => s.trim()).filter(Boolean)) {
      try {
        privateCidrs.push(ipaddr.parseCIDR(c) as Cidr);
      } catch {
        throw new Error(`Invalid CIDR in OPENPARTNER_OUTBOUND_ALLOW_PRIVATE_CIDRS: ${c}`);
      }
    }
  }

  return { allowedPorts, privateCidrs };
}

/** Strip IPv6 brackets, a trailing dot, and lowercase — the form ipaddr.js
 *  and the pinned-lookup comparison both expect. */
function canonicalHost(host: string): string {
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return unbracketed.replace(/\.$/, '').toLowerCase();
}

/** Globally-routable public unicast only. IPv4: ipaddr's `unicast` range
 *  excludes loopback/private/CGNAT/link-local/multicast/reserved/etc. IPv6:
 *  require 2000::/3 AND unicast, and reject IPv4-mapped forms outright. */
function isPublicUnicast(addressText: string): boolean {
  const address = ipaddr.parse(addressText);
  if (address.kind() === 'ipv4') {
    return address.range() === 'unicast';
  }
  const v6 = address as ipaddr.IPv6;
  if (v6.isIPv4MappedAddress()) return false;
  return v6.match(ipaddr.parseCIDR('2000::/3') as [ipaddr.IPv6, number]) && v6.range() === 'unicast';
}

const BLOCKED_SUFFIXES = ['.local', '.internal', '.home.arpa'];

/** Special-use names that must never leave the box (defense-in-depth — we
 *  still resolve + validate the IP for everything that passes). */
function isBlockedHostname(host: string): boolean {
  if (ipaddr.isValid(host)) return false; // IP literal — validated by IP rules
  if (host === 'localhost') return true;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (!host.includes('.')) return true; // single-label / unqualified
  return false;
}

function matchesAllowedCidr(parsed: ipaddr.IPv4 | ipaddr.IPv6, cidrs: readonly Cidr[]): boolean {
  return cidrs.some(([net, prefix]) => net.kind() === parsed.kind() && parsed.match(net, prefix));
}

function validateUrl(input: string, policy: OutboundPolicy): URL {
  if (input.length > 4096) throw new OutboundBlockedError('url_too_long');
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OutboundBlockedError('invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OutboundBlockedError('scheme_not_allowed');
  }
  if (url.username || url.password) throw new OutboundBlockedError('credentials_not_allowed');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (policy.allowedPorts && !policy.allowedPorts.has(port)) {
    throw new OutboundBlockedError('port_not_allowed');
  }
  return url;
}

async function resolveAndValidate(url: URL, policy: OutboundPolicy): Promise<Pin[]> {
  const host = canonicalHost(url.hostname);
  if (isBlockedHostname(host)) throw new OutboundBlockedError('blocked_hostname');

  // WHATWG URL already normalizes octal/hex/decimal/shortened IPv4 to dotted
  // form, so an IP-literal host is safe to parse directly; only names go to DNS.
  let answers: Array<{ address: string; family: number }>;
  if (ipaddr.isValid(host)) {
    answers = [{ address: host, family: ipaddr.parse(host).kind() === 'ipv4' ? 4 : 6 }];
  } else {
    answers = await dnsLookup(host, { all: true, verbatim: true });
    if (answers.length === 0) throw new OutboundBlockedError('dns_no_addresses');
  }

  const pins: Pin[] = [];
  for (const { address, family } of answers) {
    if (family !== 4 && family !== 6) throw new OutboundBlockedError('dns_invalid_family');
    const parsed = ipaddr.parse(address);
    const allowed = matchesAllowedCidr(parsed, policy.privateCidrs) || isPublicUnicast(address);
    // Every resolved address must pass: if a name resolves to a mix of public
    // and private, connecting to any of them is a bypass, so refuse outright.
    if (!allowed) throw new OutboundBlockedError('destination_not_public');
    pins.push({ address: parsed.toString(), family });
  }
  return pins;
}

/** undici `connect.lookup` that returns ONLY the pre-validated address and
 *  refuses any other hostname — the load-bearing anti-rebinding control. */
function pinnedLookup(expectedHost: string, pin: Pin) {
  const expected = canonicalHost(expectedHost);
  return (hostname: string, options: { all?: boolean }, callback: (err: NodeJS.ErrnoException | null, address: string | Array<{ address: string; family: number }>, family?: number) => void): void => {
    if (canonicalHost(hostname) !== expected) {
      const err = new Error('pinned_lookup_host_mismatch') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      callback(err, '', 0);
      return;
    }
    if (options.all) callback(null, [pin]);
    else callback(null, pin.address, pin.family);
  };
}

export interface SafeFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Trust level of whoever configured the URL. 'partner' (default) gets the
   *  hardened policy; 'admin' gets the full deployment policy (may use the
   *  private-CIDR escape hatch). */
  trust?: 'admin' | 'partner';
  /** Read at most this many bytes of the response body into `body`.
   *  Unset: the body is never read. */
  readBody?: number;
}

export interface SafeFetchResult {
  status: number;
  ok: boolean;
  /** The response's headers (a 3xx's Location is here, not followed). */
  headers: Headers;
  /** The first `readBody` bytes of the body, as UTF-8, when asked for. */
  body?: string;
}

/**
 * Validate + resolve + pin, then fetch. Throws OutboundBlockedError (with a
 * stable code) for policy violations before any socket opens; propagates
 * genuine network errors from the request itself. Never follows redirects:
 * a caller that does validates every hop by calling this again. The
 * response body is never read unless `readBody` asks for its first bytes.
 */
export async function safeFetch(
  rawUrl: string,
  init: SafeFetchInit = {},
  policyArg?: OutboundPolicy,
): Promise<SafeFetchResult> {
  // Precedence: explicit arg (unit tests) > test override (app-level e2e) >
  // trust-derived (production). Default trust is the hardened partner policy.
  const policy =
    policyArg ??
    testOverride ??
    (init.trust === 'admin' ? outboundPolicy() : partnerStrict(outboundPolicy()));
  const url = validateUrl(rawUrl, policy);
  const pins = await resolveAndValidate(url, policy);
  const pin = pins[0]!;
  const timeout = init.timeoutMs ?? 10_000;

  const dispatcher = new Agent({
    connections: 1,
    pipelining: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    connect: { lookup: pinnedLookup(url.hostname, pin) as any, timeout },
  });

  let res: Awaited<ReturnType<typeof undiciFetch>> | undefined;
  try {
    res = await undiciFetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dispatcher: dispatcher as any,
    });
    const status = res.status;
    const body = init.readBody && res.body ? await readCapped(res.body, init.readBody) : undefined;
    // A 3xx (or opaque redirect status 0) is a non-delivery: we never follow.
    return { status, ok: status >= 200 && status < 300, headers: res.headers, ...(body !== undefined ? { body } : {}) };
  } finally {
    try {
      await res?.body?.cancel();
    } catch {
      // body may already be consumed/absent
    }
    await dispatcher.destroy();
  }
}

/** Up to `max` bytes of a body, then the rest is dropped unread. */
async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}

/** Why a destination was refused, in words a tenant or partner can act on. */
function refusalDetail(code: string, policy: OutboundPolicy): string {
  switch (code) {
    case 'destination_not_public':
      return 'The URL points at a private, loopback or otherwise non-public address. Deliveries only go to hosts on the public internet.';
    case 'blocked_hostname':
      return 'localhost, single-label names and .local, .internal or .home.arpa hosts are not reachable from OpenPartner. Use a public hostname.';
    case 'port_not_allowed':
      return `That port is not allowed. Use ${[...(policy.allowedPorts ?? [])].join(' or ')}.`;
    case 'scheme_not_allowed':
      return 'Only http and https URLs are allowed.';
    case 'credentials_not_allowed':
      return 'Remove the username and password from the URL.';
    case 'url_too_long':
      return 'The URL is too long.';
    default:
      return 'This URL is not an allowed destination.';
  }
}

/**
 * Registration-time check for a webhook or postback URL: the same URL and
 * address validation safeFetch runs before every delivery, so a URL that
 * every delivery would refuse (a private address, a blocked port) is
 * rejected when it is saved instead of failing every delivery after.
 *
 * Advisory only — DNS can change after this, so safeFetch still validates
 * and pins on every delivery. A name that doesn't resolve right now is
 * accepted: it may just not be live yet.
 */
export async function checkOutboundDestination(
  rawUrl: string,
  trust: 'admin' | 'partner',
): Promise<{ reason: string; detail: string } | null> {
  // Same precedence as safeFetch, minus the explicit-policy argument.
  const policy = testOverride ?? (trust === 'admin' ? outboundPolicy() : partnerStrict(outboundPolicy()));
  try {
    await resolveAndValidate(validateUrl(rawUrl, policy), policy);
    return null;
  } catch (err) {
    if (err instanceof OutboundBlockedError) return { reason: err.message, detail: refusalDetail(err.message, policy) };
    return null;
  }
}

/** Test hook: run the pre-flight validation without opening a socket. */
export async function __assertAllowedForTests(rawUrl: string, policy?: OutboundPolicy): Promise<void> {
  const p = policy ?? outboundPolicy();
  const url = validateUrl(rawUrl, p);
  await resolveAndValidate(url, p);
}
