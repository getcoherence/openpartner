/**
 * DigitalOcean App Platform domain automation (spec §6.3 Phase-2 wiring).
 *
 * DO-native white-label domains must exist in TWO places: our
 * PortalCustomDomain table (tenant resolution + entitlement) and the DO
 * app's domain list (TLS termination). This module keeps the DO side in
 * sync automatically: verify → register the domain on the app; revoke →
 * remove it.
 *
 * The DO API has no per-domain endpoint for apps — domains are part of the
 * app spec, updated via read-modify-write (GET /v2/apps/:id → mutate
 * spec.domains → PUT). Two consequences:
 *   1. This is exactly why `.do/app.yaml` must never declare `domains:` —
 *      a declarative spec push would clobber what we manage here.
 *   2. A spec PUT creates a new DO deployment record. Domain-only changes
 *      don't rebuild the components, but keep volume in mind (fine at
 *      white-label scale — dozens, not thousands).
 *
 * Unconfigured (no DO_API_TOKEN / DO_APP_ID) → every call returns
 * 'skipped' and the operator falls back to the console, per the runbook.
 * Failures are logged and reported, never thrown — a DO hiccup must not
 * fail domain verification; the operator can re-run verify or fix by hand.
 */

const DO_API = 'https://api.digitalocean.com';

export interface DoAppDomainSpec {
  domain: string;
  type?: string;
  zone?: string;
  minimum_tls_version?: string;
  [k: string]: unknown;
}

export interface DoAppSpec {
  domains?: DoAppDomainSpec[];
  [k: string]: unknown;
}

export type DoDomainResult = 'added' | 'exists' | 'removed' | 'absent' | 'skipped' | 'failed';

function config(): { token: string; appId: string } | null {
  const token = process.env.DO_API_TOKEN;
  const appId = process.env.DO_APP_ID;
  if (!token || !appId) return null;
  return { token, appId };
}

/** Pure spec mutation — append the customer domain as a plain ALIAS (no
 *  zone: the customer owns the DNS and points the CNAME themselves). */
export function addDomainToSpec(
  spec: DoAppSpec,
  domain: string,
): { spec: DoAppSpec; changed: boolean } {
  const domains = spec.domains ?? [];
  if (domains.some((d) => d.domain.toLowerCase() === domain)) return { spec, changed: false };
  return { spec: { ...spec, domains: [...domains, { domain, type: 'ALIAS' }] }, changed: true };
}

export function removeDomainFromSpec(
  spec: DoAppSpec,
  domain: string,
): { spec: DoAppSpec; changed: boolean } {
  const domains = spec.domains ?? [];
  const next = domains.filter((d) => d.domain.toLowerCase() !== domain);
  if (next.length === domains.length) return { spec, changed: false };
  return { spec: { ...spec, domains: next }, changed: true };
}

async function doFetch(path: string, init: RequestInit, token: string): Promise<Response> {
  return fetch(`${DO_API}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
}

interface DoApp {
  spec: DoAppSpec;
  default_ingress?: string;
  live_url?: string;
}

async function fetchApp(cfg: { token: string; appId: string }): Promise<DoApp> {
  const res = await doFetch(`/v2/apps/${cfg.appId}`, { method: 'GET' }, cfg.token);
  if (!res.ok) throw new Error(`DO GET app ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { app: DoApp };
  return body.app;
}

async function putSpec(cfg: { token: string; appId: string }, spec: DoAppSpec): Promise<void> {
  const res = await doFetch(`/v2/apps/${cfg.appId}`, { method: 'PUT', body: JSON.stringify({ spec }) }, cfg.token);
  if (!res.ok) throw new Error(`DO PUT app ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function mutateDomains(
  domain: string,
  mutate: (spec: DoAppSpec, domain: string) => { spec: DoAppSpec; changed: boolean },
  unchanged: DoDomainResult,
  changed: DoDomainResult,
): Promise<DoDomainResult> {
  const cfg = config();
  if (!cfg) {
    console.warn(
      `[do-domains] DO_API_TOKEN/DO_APP_ID not set — ${changed === 'added' ? 'add' : 'remove'} ${domain} on the DO app manually (console → Settings → Domains)`,
    );
    return 'skipped';
  }
  const normalized = domain.toLowerCase();
  try {
    const app = await fetchApp(cfg);
    const result = mutate(app.spec, normalized);
    if (!result.changed) return unchanged;
    await putSpec(cfg, result.spec);
    console.log(`[do-domains] ${changed} ${normalized} on DO app ${cfg.appId}`);
    return changed;
  } catch (err) {
    console.error(`[do-domains] failed to ${changed === 'added' ? 'add' : 'remove'} ${normalized}`, err);
    return 'failed';
  }
}

/** Idempotently register a customer domain on the DO app (DO then
 *  validates ownership via the customer's CNAME and provisions the cert). */
export async function registerAppDomain(domain: string): Promise<DoDomainResult> {
  return mutateDomains(domain, addDomainToSpec, 'exists', 'added');
}

/** Idempotently remove a customer domain from the DO app (cert stops
 *  renewing; host stops resolving at the edge). */
export async function removeAppDomain(domain: string): Promise<DoDomainResult> {
  return mutateDomains(domain, removeDomainFromSpec, 'absent', 'removed');
}

let cachedAlias: string | null | undefined;

/**
 * The app's `<app-id>.ondigitalocean.app` hostname — the CNAME target we
 * hand customers. DO_APP_DOMAIN_ALIAS overrides; otherwise derived once
 * from the DO API (default_ingress) and cached for the process lifetime.
 */
export async function getDoNativeCnameTarget(): Promise<string> {
  const override = process.env.DO_APP_DOMAIN_ALIAS;
  if (override) return override;
  if (cachedAlias !== undefined) return cachedAlias ?? '<your-app>.ondigitalocean.app';
  const cfg = config();
  if (!cfg) {
    cachedAlias = null;
    return '<your-app>.ondigitalocean.app';
  }
  try {
    const app = await fetchApp(cfg);
    const ingress = app.default_ingress ?? app.live_url ?? '';
    cachedAlias = ingress ? new URL(ingress).hostname : null;
  } catch (err) {
    console.error('[do-domains] could not derive app alias', err);
    // Leave uncached so a later call retries.
    return '<your-app>.ondigitalocean.app';
  }
  return cachedAlias ?? '<your-app>.ondigitalocean.app';
}
