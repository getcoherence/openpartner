// node --test scripts/do-portal-service.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toService, toStatic } from './do-portal-service.mjs';

const github = { repo: 'getcoherence/openpartner', branch: 'main', deploy_on_push: true };

// The live spec's shape, Oct 2026: the portal static site, app-level
// BUILD_TIME envs, a "/" ingress rule, and domains the console manages.
function liveSpec() {
  return {
    name: 'openpartner',
    services: [
      { name: 'api', github, dockerfile_path: 'apps/api/Dockerfile', source_dir: '/', http_port: 4601 },
      { name: 'router', github, dockerfile_path: 'apps/router/Dockerfile', source_dir: '/', http_port: 4701 },
    ],
    static_sites: [
      {
        name: 'portal',
        github,
        build_command:
          'corepack enable\ncorepack prepare pnpm@9.11.0 --activate\nNPM_CONFIG_PRODUCTION=false pnpm install --frozen-lockfile\npnpm --filter @openpartner/db build\npnpm --filter @openpartner/portal build\n',
        source_dir: '/',
        output_dir: 'apps/portal/dist',
        catchall_document: 'index.html',
      },
    ],
    domains: [
      { domain: 'app.openpartner.dev', type: 'PRIMARY', zone: 'openpartner.dev' },
      { domain: 'portal.brand.test', type: 'ALIAS' },
    ],
    region: 'nyc',
    envs: [
      { key: 'VITE_POSTHOG_KEY', scope: 'BUILD_TIME', type: 'SECRET', value: 'EV[1:abc:def]' },
      { key: 'VITE_POSTHOG_HOST', scope: 'BUILD_TIME', value: 'https://us.i.posthog.com' },
    ],
    ingress: {
      rules: [
        { match: { path: { prefix: '/api' } }, component: { name: 'api' } },
        { match: { path: { prefix: '/r' } }, component: { name: 'router' } },
        { match: { path: { prefix: '/' } }, component: { name: 'portal' } },
      ],
    },
  };
}

test('to-service builds the portal from its Dockerfile on port 8080', () => {
  const next = toService(liveSpec());
  const portal = next.services.find((s) => s.name === 'portal');
  assert.equal(next.static_sites, undefined);
  assert.equal(portal.dockerfile_path, 'apps/portal/Dockerfile');
  assert.equal(portal.http_port, 8080);
  assert.equal(portal.source_dir, '/');
  assert.deepEqual(portal.github, github);
  assert.deepEqual(portal.envs, [{ key: 'API_UPSTREAM', value: '127.0.0.1:4601', scope: 'RUN_TIME' }]);
  assert.equal(portal.build_command, undefined);
  assert.equal(portal.catchall_document, undefined);
});

test('to-service leaves domains, ingress, app envs and other services alone', () => {
  const live = liveSpec();
  const next = toService(liveSpec());
  for (const key of ['domains', 'ingress', 'envs', 'region', 'name']) assert.deepEqual(next[key], live[key]);
  assert.deepEqual(next.services.slice(0, 2), live.services);
});

test('component envs move with the portal', () => {
  const live = liveSpec();
  live.static_sites[0].envs = [{ key: 'VITE_POSTHOG_HOST', scope: 'BUILD_TIME', value: 'https://eu.i.posthog.com' }];
  const portal = toService(live).services.find((s) => s.name === 'portal');
  assert.deepEqual(portal.envs.map((e) => e.key), ['API_UPSTREAM', 'VITE_POSTHOG_HOST']);
});

test('to-static undoes to-service exactly', () => {
  assert.deepEqual(toStatic(toService(liveSpec())), liveSpec());
});

test('refuses a spec that is already converted, or has no portal', () => {
  assert.throws(() => toService(toService(liveSpec())), /already a service/);
  assert.throws(() => toStatic(liveSpec()), /already a static site/);
  const none = liveSpec();
  delete none.static_sites;
  assert.throws(() => toService(none), /no "portal" static site/);
});

test('refuses when no ingress rule routes to the portal', () => {
  const live = liveSpec();
  live.ingress.rules.pop();
  assert.throws(() => toService(live), /no ingress rule routes to "portal"/);
});
