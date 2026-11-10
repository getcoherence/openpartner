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

/** The longest one exchange may take. Every reply here is one short body;
 *  this only stops a stuck one from holding the tenant transaction. */
const EXCHANGE_TIMEOUT_MS = 60_000;

/** JSON-RPC methods this server refuses before the SDK sees them.
 *  subscriptions/listen opens a stream that stays open for as long as the
 *  client keeps it (the SDK serves it over SSE whatever the response
 *  mode), and each would hold a tenant transaction and its database
 *  connection. This server sends no notifications, so there is nothing to
 *  listen for. */
const REFUSED_METHODS = new Set(['subscriptions/listen']);

function refusedMessage(body: unknown): { id: unknown; method: string } | null {
  for (const m of Array.isArray(body) ? body : [body]) {
    if (m && typeof m === 'object' && REFUSED_METHODS.has((m as { method?: unknown }).method as string)) {
      return { id: (m as { id?: unknown }).id ?? null, method: (m as { method: string }).method };
    }
  }
  return null;
}

mcpRouter.post('/mcp', requireAuth, grantScope('reports:read'), requireAdmin, async (req, res) => {
  const refused = refusedMessage(req.body);
  if (refused) {
    return res.json({
      jsonrpc: '2.0',
      id: refused.id,
      error: { code: -32601, message: `${refused.method} is not supported: this server is stateless and sends no notifications` },
    });
  }

  const { db, tenantId } = tenantOf(req);
  const linkTenant = linkTenantOf(req);
  const requestId = (req as { id?: string }).id ?? null;
  const handler = createMcpHandler(
    () =>
      buildMcpServer({
        db,
        tenantId,
        linkTenant,
        onToolError: (tool, err) => req.log?.error({ err, tool, requestId }, 'mcp_tool_failed'),
        requestId,
      }),
    { responseMode: 'json', onerror: (err) => req.log?.warn({ err }, 'mcp_request_error') },
  );
  // Abort the exchange when the client goes away or it runs too long, so a
  // body that never ends can't keep this handler (and its transaction) alive.
  const abort = new AbortController();
  const onClose = () => abort.abort();
  res.on('close', onClose);
  const timer = setTimeout(() => abort.abort(), EXCHANGE_TIMEOUT_MS);
  try {
    const response = await handler.fetch(await toWebRequest(req, req.body, { signal: abort.signal }));
    // Buffered rather than piped: the tenant transaction commits on
    // res.send (tenancy.ts), and a stateless exchange is one short body.
    let body: string;
    try {
      body = await response.text();
    } catch (err) {
      if (!abort.signal.aborted) throw err;
      if (!res.headersSent && !res.writableEnded) res.status(504).json({ error: 'mcp_timeout' });
      return;
    }
    if (abort.signal.aborted) {
      if (!res.headersSent && !res.writableEnded) res.status(504).json({ error: 'mcp_timeout' });
      return;
    }
    res.status(response.status);
    response.headers.forEach((value, name) => {
      if (name !== 'content-length' && name !== 'transfer-encoding') res.setHeader(name, value);
    });
    res.send(body);
  } finally {
    clearTimeout(timer);
    res.off('close', onClose);
    await handler.close();
  }
});

mcpRouter.get('/mcp', (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ error: 'method_not_allowed', detail: 'This MCP server is stateless: POST JSON-RPC requests to it.' });
});
