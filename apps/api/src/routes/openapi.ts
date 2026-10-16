/**
 * Public API reference.
 *
 *   GET /openapi.json   the OpenAPI 3.1 document (openapi/index.ts)
 *   GET /docs           Redoc rendering of it
 *
 * Same document for every tenant, so no auth and no tenant scope. app.ts
 * mounts this router twice: before tenantMiddleware for the bare paths
 * (https://app.openpartner.dev/api/docs) and after it so the tenant-path
 * forms (/api/t/<slug>/docs) work too.
 *
 * /docs runs third-party JavaScript (Redoc) on the same origin as the
 * portal, which keeps an API key in localStorage and an admin session
 * cookie. So the page's CSP:
 *   - sandboxes the document into an opaque origin, so even a bug in Redoc
 *     can't read the portal's storage or make requests with its cookies;
 *   - allows exactly two scripts: the pinned Redoc file (also SRI-checked)
 *     and the one-line inline bootstrap, by hash;
 *   - allows no network requests at all (connect-src 'none'). The spec is
 *     embedded in the page as a JSON data block instead of fetched, which
 *     an opaque origin couldn't do reliably anyway.
 * helmet's default CSP still covers every other response. Redoc is
 * read-only — no "try it" console — so nobody pastes an API key into it.
 *
 * White-label custom domains get a 404: the reference is OpenPartner
 * branded, and those hosts must not show the platform's name
 * (docs/white-label-custom-domains.md §5). Their developers use the
 * platform host.
 *
 * Bumping REDOC_VERSION means recomputing REDOC_SRI:
 *   curl -sL <REDOC_SRC> | openssl dgst -sha384 -binary | openssl base64 -A
 */

import { createHash } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { TABLES } from '@openpartner/db';
import { getOpenApiDocument } from '../openapi/index.js';
import { getTenancyMode, inboundHost, isPlatformHost } from '../tenancy.js';

const REDOC_VERSION = '2.5.4';
const REDOC_SRC = `https://cdn.jsdelivr.net/npm/redoc@${REDOC_VERSION}/bundles/redoc.standalone.js`;
const REDOC_SRI = 'sha384-w447zOpYfw/1Tv/5AK9NfHTlQIqE3RVR6KY62jCyy9zNDgO64cMwGGP1Fj0zJVf5';

const REDOC_OPTIONS = {
  expandResponses: '200,201',
  jsonSampleExpandLevel: 2,
  theme: {
    colors: { primary: { main: '#0f766e' } },
    typography: { fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', headings: { fontFamily: 'inherit' } },
  },
};

// The inline bootstrap. Its exact text is what the CSP hash allows.
const BOOTSTRAP = `Redoc.init(JSON.parse(document.getElementById('openapi-spec').textContent),${JSON.stringify(REDOC_OPTIONS)},document.getElementById('redoc'));`;
const BOOTSTRAP_HASH = `'sha256-${createHash('sha256').update(BOOTSTRAP).digest('base64')}'`;

export const DOCS_CSP = [
  "default-src 'none'",
  // The pinned Redoc file by full URL (not every package on the CDN), and
  // the bootstrap by hash.
  `script-src ${REDOC_SRC} ${BOOTSTRAP_HASH}`,
  // Redoc's search index runs in a worker it builds from a blob.
  'worker-src blob:',
  // Redoc styles with styled-components, which injects <style> tags.
  "style-src 'unsafe-inline'",
  // Redoc's "API docs by Redocly" sidebar badge.
  "img-src data: https://cdn.redoc.ly",
  "font-src data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  // Opaque origin: no access to the portal's localStorage or cookies.
  // Popups for the description's external links; downloads for the
  // "Download" button.
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads',
].join('; ');

let docsHtml: string | null = null;

/** Built once: the spec is static for the life of the process. */
function renderDocsHtml(): string {
  if (docsHtml) return docsHtml;
  // A JSON data block isn't executed (so CSP doesn't apply to it), but its
  // text still ends at the first "</script" — escape every "<".
  const spec = JSON.stringify(getOpenApiDocument()).replace(/</g, '\\u003c');
  docsHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenPartner API reference</title>
<style>body{margin:0;background:#fff}</style>
</head>
<body>
<noscript><p style="font-family:sans-serif;padding:16px">This page needs JavaScript. The raw spec is at <a href="openapi.json">openapi.json</a>.</p></noscript>
<div id="redoc"></div>
<script type="application/json" id="openapi-spec">${spec}</script>
<script src="${REDOC_SRC}" integrity="${REDOC_SRI}" crossorigin="anonymous"></script>
<script>${BOOTSTRAP}</script>
</body>
</html>
`;
  return docsHtml;
}

/** True when the request arrived on a tenant's white-label custom domain. */
async function onCustomDomain(req: Request): Promise<boolean> {
  if (getTenancyMode() !== 'multi') return false;
  const host = inboundHost(req);
  if (isPlatformHost(host)) return false;
  const { db } = await import('../db.js');
  return Boolean(await db(TABLES.Tenant).where({ customDomain: host }).first('id'));
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' });
}

export const openapiRouter = Router();

openapiRouter.get('/openapi.json', async (req, res) => {
  if (await onCustomDomain(req)) return notFound(res);
  res.setHeader('Cache-Control', 'no-cache');
  // A public document: browser-based tooling (Swagger Editor, Postman web)
  // may read it from any origin. Never sent with credentials.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.removeHeader('Access-Control-Allow-Credentials');
  res.json(getOpenApiDocument());
});

openapiRouter.get('/docs', async (req, res) => {
  if (await onCustomDomain(req)) return notFound(res);
  // Express matches /docs/ here too; send it to the canonical URL. A
  // relative Location keeps any prefix (/api, /api/t/<slug>) the client used.
  if (req.path.endsWith('/')) return res.redirect(301, '../docs');
  res.setHeader('Content-Security-Policy', DOCS_CSP);
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(renderDocsHtml());
});
