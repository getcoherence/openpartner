/**
 * Which proxy hops to believe when working out a visitor's address — the
 * API's `trust proxy` and the router's click IP. Set by TRUST_PROXY at
 * deploy time:
 *
 *   unset       One hop. The server in front of the app (Caddy in
 *               docker-compose, App Platform's ingress) appends the address
 *               it saw to X-Forwarded-For, so the last entry is the visitor.
 *
 *   cloudflare  That hop plus one Cloudflare edge in front of it. On DO App
 *               Platform the chain is visitor → Cloudflare → ingress → app,
 *               so X-Forwarded-For reads "visitor, cf-edge" and one hop
 *               yields the edge. The ingress appended the edge's address
 *               itself, so it is checked against Cloudflare's ranges; the
 *               entry before it is whoever connected to Cloudflare. Nothing
 *               further left is believed, not even another Cloudflare
 *               address: a Worker connects from Cloudflare's ranges and can
 *               send any X-Forwarded-For it likes.
 *
 * CF-Connecting-IP and the left-most X-Forwarded-For entry are never read:
 * a client can send either, and the *.ondigitalocean.app origin is
 * reachable without going through our domain.
 *
 * The Network service has the same rule and ranges (openpartner-network
 * src/trusted-proxy.ts); change both together.
 */

import type { BlockList } from 'node:net';

/**
 * Cloudflare's published edge ranges, checked 2026-11-01. Refresh from
 * https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6
 * (or https://api.cloudflare.com/client/v4/ips). A range missing here only
 * means visitors behind it are seen as the edge, as they were before.
 */
export const CLOUDFLARE_IP_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
] as const;

/** Same shape as an Express `trust proxy` function: hop 0 is the socket
 *  peer, hop 1 the last X-Forwarded-For entry, and so on leftwards. */
export type TrustProxy = (addr: string, hop: number) => boolean;

// node:net is fetched on first use rather than imported: the portal bundles
// this package for the browser and never calls it.
function nodeNet(): typeof import('node:net') {
  if (typeof process.getBuiltinModule !== 'function') {
    throw new Error('Matching Cloudflare addresses needs Node 22.3 or later (process.getBuiltinModule)');
  }
  return process.getBuiltinModule('node:net');
}
let cloudflareList: BlockList | undefined;

function cloudflareRanges(): BlockList {
  if (cloudflareList) return cloudflareList;
  const net = nodeNet();
  const list = new net.BlockList();
  for (const range of CLOUDFLARE_IP_RANGES) {
    const [prefix, bits] = range.split('/') as [string, string];
    list.addSubnet(prefix, Number(bits), net.isIPv6(prefix) ? 'ipv6' : 'ipv4');
  }
  return (cloudflareList = list);
}

/** A dotted-quad or IPv6 address (IPv4-mapped too) inside Cloudflare's
 *  ranges. Loose forms some parsers accept, like `2890342092` or
 *  `0xac.71.30.204` for 172.71.30.204, don't count. */
export function isCloudflareAddress(addr: string): boolean {
  const family = nodeNet().isIP(addr);
  if (family === 0) return false;
  return cloudflareRanges().check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

function trustCloudflareHop(addr: string, hop: number): boolean {
  return hop === 0 || (hop === 1 && isCloudflareAddress(addr));
}

/** The TRUST_PROXY setting, or null when unset (callers keep their one-hop
 *  default). Anything else is a typo that would leave the visitor's
 *  address wrong, so it refuses to start, as does a Node too old to match
 *  addresses. */
export function trustProxyFromEnv(value: string | undefined): TrustProxy | null {
  if (value === undefined || value === '') return null;
  if (value === 'cloudflare') {
    cloudflareRanges();
    return trustCloudflareHop;
  }
  throw new Error(`TRUST_PROXY must be unset or "cloudflare", not "${value}"`);
}

/** The client's address, as Express's `req.ip` works it out: walk from the
 *  socket leftwards through X-Forwarded-For and stop at the first hop that
 *  isn't trusted. For the router, which isn't Express. Entries are split
 *  the way Express's `forwarded` package does it: on commas, with only
 *  spaces trimmed and empty entries dropped. */
export function forwardedClientAddress(
  socketAddr: string,
  forwardedFor: string | undefined,
  trust: TrustProxy,
): string {
  const hops = [
    socketAddr,
    ...(forwardedFor ?? '')
      .split(',')
      .map((s) => s.replace(/^ +| +$/g, ''))
      .filter(Boolean)
      .reverse(),
  ];
  for (let hop = 0; hop < hops.length - 1; hop += 1) {
    if (!trust(hops[hop]!, hop)) return hops[hop]!;
  }
  return hops[hops.length - 1]!;
}
