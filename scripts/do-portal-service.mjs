// One-off App Platform migration: run the portal as a service built from
// apps/portal/Dockerfile instead of as a static site, or back again
// (docs/portal-service-runbook.md).
//
//   doctl apps spec get "$OP_APP_ID" --format json > live.json
//   node scripts/do-portal-service.mjs to-service live.json > next.json
//   node scripts/do-portal-service.mjs to-static live.json > back.json
//
// Works on the LIVE spec and changes only the portal component. Domains,
// ingress, app-level envs and the other components pass through as they
// are, encrypted EV[...] values included, so no white-label domain is
// dropped. Never feed it .do/app.yaml.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NAME = 'portal';
const SOURCE_KEYS = ['git', 'github', 'gitlab', 'bitbucket', 'source_dir'];

// Keep these two in step with the portal in .do/app.yaml (service) and its
// static-site shape before the move.
const SERVICE = {
  dockerfile_path: 'apps/portal/Dockerfile',
  http_port: 8080,
  instance_count: 1,
  instance_size_slug: 'basic-xxs',
  health_check: {
    http_path: '/',
    initial_delay_seconds: 5,
    period_seconds: 30,
    timeout_seconds: 5,
    failure_threshold: 3,
  },
};
const API_UPSTREAM = { key: 'API_UPSTREAM', value: '127.0.0.1:4601', scope: 'RUN_TIME' };
const STATIC_SITE = {
  build_command: [
    'corepack enable',
    'corepack prepare pnpm@9.11.0 --activate',
    'NPM_CONFIG_PRODUCTION=false pnpm install --frozen-lockfile',
    'pnpm --filter @openpartner/db build',
    'pnpm --filter @openpartner/portal build',
    '',
  ].join('\n'),
  output_dir: 'apps/portal/dist',
  catchall_document: 'index.html',
};

function pick(component, keys) {
  return Object.fromEntries(keys.filter((k) => component[k] !== undefined).map((k) => [k, component[k]]));
}

function withoutPortal(list) {
  const rest = (list ?? []).filter((c) => c.name !== NAME);
  return rest.length ? rest : undefined;
}

function assertRouted(spec) {
  const rules = spec.ingress?.rules ?? [];
  if (!rules.some((r) => r.component?.name === NAME)) {
    throw new Error(`no ingress rule routes to "${NAME}": add a "/" rule for it first, or it gets no traffic`);
  }
}

/** The spec with the portal static site replaced by an equivalent service. */
export function toService(spec) {
  const site = spec.static_sites?.find((s) => s.name === NAME);
  if (!site) {
    if (spec.services?.some((s) => s.name === NAME)) throw new Error(`"${NAME}" is already a service`);
    throw new Error(`no "${NAME}" static site in this spec`);
  }
  assertRouted(spec);
  const envs = (site.envs ?? []).filter((e) => e.key !== API_UPSTREAM.key);
  const service = { name: NAME, ...pick(site, SOURCE_KEYS), ...structuredClone(SERVICE), envs: [API_UPSTREAM, ...envs] };
  const next = { ...spec, services: [...(spec.services ?? []), service], static_sites: withoutPortal(spec.static_sites) };
  if (!next.static_sites) delete next.static_sites;
  return next;
}

/** The spec with the portal service put back as the static site it replaced. */
export function toStatic(spec) {
  const service = spec.services?.find((s) => s.name === NAME);
  if (!service) {
    if (spec.static_sites?.some((s) => s.name === NAME)) throw new Error(`"${NAME}" is already a static site`);
    throw new Error(`no "${NAME}" service in this spec`);
  }
  assertRouted(spec);
  const envs = (service.envs ?? []).filter((e) => e.key !== API_UPSTREAM.key);
  const site = { name: NAME, ...pick(service, SOURCE_KEYS), ...STATIC_SITE, ...(envs.length ? { envs } : {}) };
  const next = { ...spec, services: withoutPortal(spec.services), static_sites: [...(spec.static_sites ?? []), site] };
  if (!next.services) delete next.services;
  return next;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, file] = process.argv.slice(2);
  const transform = { 'to-service': toService, 'to-static': toStatic }[mode];
  if (!transform || !file) {
    console.error('usage: node scripts/do-portal-service.mjs <to-service|to-static> <live-spec.json>');
    process.exit(2);
  }
  const spec = JSON.parse(readFileSync(file, 'utf8'));
  const next = transform(spec);
  for (const key of ['domains', 'ingress', 'envs']) {
    if (JSON.stringify(next[key]) !== JSON.stringify(spec[key])) throw new Error(`${key} changed: refusing`);
  }
  process.stdout.write(JSON.stringify(next, null, 2) + '\n');
  console.error(
    `${NAME}: ${mode === 'to-service' ? 'static site → service' : 'service → static site'}. ` +
      `Unchanged: ${(spec.domains ?? []).length} domain(s), ingress, app envs, ` +
      `${(spec.services ?? []).filter((s) => s.name !== NAME).map((s) => s.name).join(', ')}.`,
  );
}
