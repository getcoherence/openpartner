/**
 * POST /mcp: the brand's read-only MCP server (docs/mcp.md), over the
 * Streamable HTTP transport, stateless.
 *
 * Auth is the REST API's: requireAuth (an admin API key, a scoped key
 * holding reports:read, the operator's ADMIN_API_KEY, or an admin's
 * session) then requireAdmin, inside the request's tenant transaction, so
 * the tools see exactly what the brand's own API sees. Partner keys and
 * scoped keys without reports:read are refused. reports:read unlocks
 * nothing else: a key minted for an agent can't write.
 *
 * Every request builds a fresh server bound to req.db. The SDK answers the
 * 2026-07-28 protocol with a single JSON body, and 2025-era clients through
 * its stateless fallback. Nothing is kept between requests, so there is no
 * session to resume: GET (a 2025 client opening a notification stream) is
 * answered 405, as the spec asks of a server that offers none.
 */

import { Router } from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toWebRequest } from '@modelcontextprotocol/node';
import { grantScope, requireAdmin, requireAuth } from '../auth.js';
import { tenantOf } from '../tenancy.js';
import { linkTenantOf } from '../portal-url.js';
import { buildMcpServer } from '../mcp/server.js';

export const mcpRouter = Router();

mcpRouter.post('/mcp', requireAuth, grantScope('reports:read'), requireAdmin, async (req, res) => {
  const { db, tenantId } = tenantOf(req);
  const linkTenant = linkTenantOf(req);
  const handler = createMcpHandler(() => buildMcpServer({ db, tenantId, linkTenant }), {
    responseMode: 'json',
    onerror: (err) => req.log?.warn({ err }, 'mcp_request_error'),
  });
  try {
    const response = await handler.fetch(await toWebRequest(req, req.body));
    // Buffered rather than piped: the tenant transaction commits on
    // res.send (tenancy.ts), and a stateless exchange is one short body.
    const body = await response.text();
    res.status(response.status);
    response.headers.forEach((value, name) => {
      if (name !== 'content-length' && name !== 'transfer-encoding') res.setHeader(name, value);
    });
    res.send(body);
  } finally {
    await handler.close();
  }
});

mcpRouter.get('/mcp', (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ error: 'method_not_allowed', detail: 'This MCP server is stateless: POST JSON-RPC requests to it.' });
});
