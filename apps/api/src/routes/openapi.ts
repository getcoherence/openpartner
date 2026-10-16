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
 * Redoc is loaded from jsDelivr at a pinned version with Subresource
 * Integrity, under a CSP scoped to this one page. helmet's default CSP
 * (script-src 'self') still covers every other response. Redoc is
 * read-only — no "try it" console — so nobody pastes an API key into it.
 * Bumping REDOC_VERSION means recomputing REDOC_SRI:
 *   curl -sL <REDOC_SRC> | openssl dgst -sha384 -binary | openssl base64 -A
 */

import { Router } from 'express';
import { getOpenApiDocument } from '../openapi/index.js';

const REDOC_VERSION = '2.5.4';
const REDOC_SRC = `https://cdn.jsdelivr.net/npm/redoc@${REDOC_VERSION}/bundles/redoc.standalone.js`;
const REDOC_SRI = 'sha384-w447zOpYfw/1Tv/5AK9NfHTlQIqE3RVR6KY62jCyy9zNDgO64cMwGGP1Fj0zJVf5';

const DOCS_CSP = [
  "default-src 'none'",
  'script-src https://cdn.jsdelivr.net',
  // Redoc's search index runs in a worker it builds from a blob.
  'worker-src blob:',
  // Redoc styles with styled-components, which injects <style> tags.
  "style-src 'unsafe-inline'",
  // Redoc's "API docs by Redocly" sidebar badge.
  "img-src 'self' data: https://cdn.redoc.ly",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const REDOC_THEME = JSON.stringify({
  colors: { primary: { main: '#0f766e' } },
  typography: { fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', headings: { fontFamily: 'inherit' } },
});

// Relative spec-url: resolves next to this page whatever prefix the
// request came through (/docs, /api/docs, /api/t/<slug>/docs).
const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenPartner API reference</title>
<style>body{margin:0;background:#fff}</style>
</head>
<body>
<noscript><p style="font-family:sans-serif;padding:16px">This page needs JavaScript. The raw spec is at <a href="openapi.json">openapi.json</a>.</p></noscript>
<redoc spec-url="openapi.json" expand-responses="200,201" json-sample-expand-level="2" theme='${REDOC_THEME}'></redoc>
<script src="${REDOC_SRC}" integrity="${REDOC_SRI}" crossorigin="anonymous"></script>
</body>
</html>
`;

export const openapiRouter = Router();

openapiRouter.get('/openapi.json', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json(getOpenApiDocument());
});

openapiRouter.get('/docs', (_req, res) => {
  res.setHeader('Content-Security-Policy', DOCS_CSP);
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(DOCS_HTML);
});
