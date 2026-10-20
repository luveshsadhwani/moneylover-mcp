import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { loadConfig, createVerifier } from './auth.js';
import { MoneyloverClient, UpstreamError } from './moneylover.js';
const id = z.string().min(1).max(256);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Invalid calendar date');
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
function rpcServer(client, logger) {
  const server = new McpServer({ name: 'moneylover', version: '1.1.0' });
  const call = async (key, fn) => {
    try { const data = { [key]: await fn() }; return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }; }
    catch (error) {
      const message = error instanceof UpstreamError ? error.message : 'Request failed';
      if (error instanceof UpstreamError) logger({ event: 'moneylover_upstream_error', stage: error.stage, reason: error.reason, status: error.status, api_code: error.apiCode, ...(error.diagnostics ?? {}) });
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  };
  server.registerTool('get_wallets', { description: 'List the owner’s Money Lover wallets. Read only.', inputSchema: z.object({}).strict(), annotations }, () => call('wallets', () => client.getWallets()));
  server.registerTool('get_categories', { description: 'List categories for the selected wallet from category/list-all, filtered by account. Returns consolidated category IDs used for writes. Read only.', inputSchema: z.object({ walletId: id }).strict(), annotations }, ({ walletId }) => call('categories', () => client.getCategories(walletId)));
  server.registerTool('get_transactions', { description: 'Read transactions in a wallet; date difference at most 93 days. Read only.', inputSchema: z.object({ walletId: id, startDate: date, endDate: date }).strict(), annotations }, ({ walletId, startDate, endDate }) => {
    const days = (Date.parse(endDate) - Date.parse(startDate)) / 86400000;
    if (days < 0 || days > 93) return { content: [{ type: 'text', text: 'Date range must be 0 to 93 days' }], isError: true };
    return call('transactions', () => client.getTransactions(walletId, startDate, endDate));
  });
  server.registerTool('add_transaction', {
    description: 'Create one income or expense in Money Lover. Use only when the user explicitly asks to save this entry; resolve wallet/category first. Amount is positive in wallet currency, category determines income/expense. Exact date/category/amount/note matches return already_exists. Never blindly retry an unknown outcome: inspect the wallet first.',
    inputSchema: z.object({ walletId: id, categoryId: id, amount: z.string().regex(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/).refine(v => Number(v) > 0), date, note: z.string().max(2000).default('') }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, args => call('result', () => client.addTransaction(args)));
  return server;
}
export function createApp(config, { logger = value => console.warn(JSON.stringify(value)), client = new MoneyloverClient({ ...config, logger }), verify = createVerifier(config) } = {}) {
  let active = 0;
  return createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/healthz' && req.method === 'GET') return reply(200, { status: 'ok' }); // no credentials or upstream calls
    if (path !== '/mcp') return reply(404, { error: 'Not found' });
    if (active >= 8) return reply(503, { error: 'Server busy' });
    active++;
    try {
      try { await verify(req.headers['cf-access-jwt-assertion']); }
      catch { return reply(401, { error: 'Unauthorized' }); }
      if (req.headers.origin && req.headers.origin !== config.publicOrigin) return reply(403, { error: 'Origin not allowed' });
      if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return reply(405, { error: 'Method not allowed' }); }
      if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return reply(415, { error: 'JSON required' });
      let raw = ''; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 65536) return reply(413, { error: 'Request too large' });
        raw += chunk;
      }
      let body;
      try { body = JSON.parse(raw); } catch { return reply(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const mcp = rpcServer(client, logger);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) reply(500, { error: 'Request failed' }); else res.end();
    } finally { active--; }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = loadConfig();
    const server = createApp(config);
    server.requestTimeout = 30000; server.headersTimeout = 10000;
    server.listen(config.port, '0.0.0.0', () => console.info('Money Lover MCP ready'));
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
      server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 25000).unref();
    });
  } catch { console.error('Startup failed: check required configuration and secret files'); process.exitCode = 1; }
}
