import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, createLocalJWKSet, exportJWK } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig, createVerifier } from '../src/auth.js';
import { createApp } from '../src/server.js';
const config = { issuer: 'https://test.cloudflareaccess.com', audience: 'test-aud', owner: 'owner@example.test', publicOrigin: 'https://mcp.example.test' };
const keys = await generateKeyPair('RS256');
const jwk = await exportJWK(keys.publicKey); jwk.kid = 'test';
const verify = createVerifier(config, createLocalJWKSet({ keys: [jwk] }));
async function sign(overrides = {}, signer = keys.privateKey) {
  return new SignJWT({ email: config.owner, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(config.issuer).setAudience(config.audience).setSubject('owner').setIssuedAt().setExpirationTime('5m').sign(signer);
}
const token = await sign();
const authHeaders = { 'cf-access-jwt-assertion': token };
let reads = 0, writes = 0, edits = 0, searches = 0;
const app = createApp(config, { verify, client: { searchTransactions: async args => { searches++; return { transactions: [], ...args }; }, getWallets: async () => { reads++; return [{ id: 'fixture' }]; }, editTransaction: async args => { edits++; return { status: 'edited', edited: true, args }; }, getCategories: async () => [], getTransactions: async () => [], addTransaction: async () => { writes++; return { status: 'created', created: true }; } }, logger: () => {} });
await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.address().port}/mcp`;
test.after(() => new Promise(resolve => { app.close(resolve); app.closeAllConnections(); }));
async function post(body, headers = authHeaders) { return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(body) }); }
test('configuration fails closed', () => { assert.throws(() => loadConfig({})); assert.throws(() => loadConfig({ ACCESS_TEAM_DOMAIN: 'http://attacker' })); });
test('auth requires signature, issuer, audience, expiry and owner', async () => {
  const valid = await verify(token); assert.equal(valid.email, config.owner);
  for (const token of [undefined, 'forged', await sign({ email: 'other@example.test' }), await new SignJWT({ email: config.owner }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer('https://other.cloudflareaccess.com').setAudience(config.audience).setSubject('owner').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey), await new SignJWT({ email: config.owner }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(config.issuer).setAudience('other').setSubject('owner').setIssuedAt().setExpirationTime('5m').sign(keys.privateKey), await new SignJWT({ email: config.owner }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuer(config.issuer).setAudience(config.audience).setSubject('owner').setIssuedAt().setExpirationTime(1).sign(keys.privateKey)]) {
    await assert.rejects(() => verify(token));
  }
  const other = await generateKeyPair('RS256'); await assert.rejects(() => verifyToken(other));
  async function verifyToken(other) { return verify(await sign({}, other.privateKey)); }
});
test('all MCP requests require signed Access JWT before any upstream reads', async () => {
  const before = reads;
  for (const method of ['GET', 'POST', 'DELETE']) {
    assert.equal((await fetch(url, { method })).status, 401);
  }
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { 'cf-access-jwt-assertion': 'forged', 'cf-access-authenticated-user-email': config.owner })).status, 401);
  assert.equal((await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'add_transaction', arguments: { walletId: 'a', categoryId: 'b', amount: '1', date: '2026-10-19' } } }, {})).status, 401);
  assert.equal(writes, 0);
  assert.equal((await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_transactions', arguments: { query: 'rice' } } }, {})).status, 401);
  assert.equal(searches, 0);
  assert.equal(reads, before);
});
test('real SDK client initializes, lists preference rules plus four reads and two writes and calls a tool over HTTP', async () => {
  const client = new Client({ name: 'acceptance', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: authHeaders } }));
  const list = await client.listTools();
  assert.deepEqual(list.tools.map(t => t.name), ['get_expense_rules', 'get_wallets', 'get_categories', 'get_transactions', 'search_transactions', 'add_transaction', 'edit_transaction']);
  assert.ok(list.tools.slice(0, 5).every(t => t.annotations.readOnlyHint));
  assert.equal(list.tools[5].annotations.readOnlyHint, false);
  assert.equal(list.tools[5].annotations.idempotentHint, false);
  const rules = await client.callTool({ name: 'get_expense_rules', arguments: {} });
  assert.match(rules.structuredContent.rules, /Categorize by the \*purpose\*/);
  assert.match(rules.structuredContent.rules, /Asia\/Kuala_Lumpur/);
  assert.equal(writes, 0);
  assert.equal(reads, 0);
  assert.match(list.tools[5].description, /get_expense_rules/);
  assert.match(list.tools[6].description, /get_expense_rules/);
  const search = await client.callTool({ name: 'search_transactions', arguments: { query: 'rice' } });
  assert.deepEqual(search.structuredContent.search, { transactions: [], query: 'rice', limit: 50, offset: 0 });
  for (const invalid of [{ query: '' }, { query: 'rice', limit: 101 }, { query: 'rice', offset: -1 }, { query: 'rice', startDate: '2026-02-30' }, { query: 'rice', startDate: '2026-10-01', endDate: '2026-01-01' }, { query: 'rice', accounts: ['other'] }]) {
    assert.equal((await client.callTool({ name: 'search_transactions', arguments: invalid })).isError, true);
  }
  assert.equal(searches, 1);
  const result = await client.callTool({ name: 'get_wallets', arguments: {} });
  assert.deepEqual(result.structuredContent.wallets, [{ id: 'fixture' }]);
  for (const args of [{ walletId: 'a', startDate: '2026-02-30', endDate: '2026-03-01' }, { walletId: 'a', startDate: '2026-01-01', endDate: '2026-10-01' }, { walletId: 'a', startDate: '2026-01-02', endDate: '2026-01-01' }]) {
    assert.equal((await client.callTool({ name: 'get_transactions', arguments: args })).isError, true);
  }
  assert.equal((await client.callTool({ name: 'get_wallets', arguments: { password: 'never-accepted' } })).isError, true);
  assert.equal((await client.callTool({ name: 'add_transaction', arguments: {} })).isError, true);
  const writeArgs = { walletId: 'a', categoryId: 'b', amount: '1.20', date: '2026-10-19' };
  for (const invalid of [{ amount: '-1' }, { date: '2026-02-30' }, { password: 'forbidden' }]) {
    assert.equal((await client.callTool({ name: 'add_transaction', arguments: { ...writeArgs, ...invalid } })).isError, true);
  }
  assert.equal(writes, 0);
  assert.equal((await client.callTool({ name: 'add_transaction', arguments: writeArgs })).structuredContent.result.created, true);
  assert.equal(writes, 1);
  assert.equal(list.tools[6].annotations.destructiveHint, true);
  const editArgs = { walletId: 'a', transactionId: 'entry', expected: { categoryId: 'b', amount: '1.20', date: '2026-10-19', note: '' }, changes: { note: 'Fixed' } };
  for (const invalid of [{ expected: undefined }, { changes: {} }, { changes: { walletId: 'other' } }, { changes: { amount: 10 } }, { changes: { date: '2026-02-30' } }]) {
    assert.equal((await client.callTool({ name: 'edit_transaction', arguments: { ...editArgs, ...invalid } })).isError, true);
  }
  assert.equal(edits, 0);
  const edited = await client.callTool({ name: 'edit_transaction', arguments: editArgs });
  assert.deepEqual(edited.structuredContent.result.args, editArgs);
  assert.equal(edits, 1);
  await client.close();
});
test('rejects cross-origin calls, malformed and oversized bodies', async () => {
  assert.equal((await post({}, { ...authHeaders, origin: 'https://attacker.test' })).status, 403);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...authHeaders, 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await post({ value: 'x'.repeat(70000) })).status, 413);
});
