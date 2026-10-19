import test from 'node:test';
import assert from 'node:assert/strict';
import { MoneyloverClient } from '../src/moneylover.js';
const args = { walletId: 'wallet', categoryId: 'category', amount: '12.30', date: '2026-10-19', note: 'Synthetic receipt' };
function fixture({ mode = 'success', wallet = {}, category = {}, data } = {}) {
  let writes = 0, logins = 0; const records = [], bodies = [];
  const client = new MoneyloverClient({ email: 'fixture', password: 'fixture', fetchImpl: async (url, options) => {
    if (url.endsWith('/login-url')) return Response.json({ data: { request_token: 'fixture', login_url: 'https://oauth.moneylover.me/login?client=fixture' } });
    if (url.endsWith('/token')) { logins++; return Response.json({ access_token: 'fixture' }); }
    if (url.endsWith('/wallet/list')) return Response.json({ data: [{ _id: 'wallet', ...wallet }] });
    if (url.endsWith('/category/list')) return Response.json({ data: [{ _id: 'category', account: 'wallet', type: 2, ...category }] });
    if (url.endsWith('/transaction/list')) return Response.json({ data: data ?? { daterange: {}, transactions: records } });
    assert.ok(url.endsWith('/transaction/add'));
    assert.equal(options.headers.Authorization, 'AuthJWT fixture');
    const body = JSON.parse(options.body); bodies.push(body); writes++;
    if (mode === 'timeout') throw new Error('secret upstream detail');
    if (mode === 'api-error') return Response.json({ error: 422, msg: 'private details', data: 'private' });
    if (mode === '401') return new Response('', { status: 401 });
    if (mode === 'malformed') return Response.json({});
    records.push({ category: { _id: body.category }, amount: Number(body.amount), note: body.note, displayDate: body.displayDate + 'T00:00:00.000Z' });
    if (mode === 'committed-timeout') throw new Error('secret');
    return Response.json({ error: 0, data: { _id: 'synthetic' } });
  } });
  return { client, records, bodies, writes: () => writes, logins: () => logins };
}
test('creates validated transaction using reference payload and reuses token', async () => {
  const f = fixture(); const result = await f.client.addTransaction(args);
  assert.equal(result.created, true);
  assert.deepEqual(f.bodies, [{ account: 'wallet', category: 'category', amount: '12.30', displayDate: '2026-10-19', note: 'Synthetic receipt', with: [] }]);
  assert.equal(f.logins(), 1);
});
test('concurrent duplicate writes serialize and matching entries are not added twice', async () => {
  const f = fixture(); const results = await Promise.all([f.client.addTransaction(args), f.client.addTransaction(args)]);
  assert.deepEqual(results.map(r => r.status), ['created', 'already_exists']); assert.equal(f.writes(), 1);
});
test('different notes remain distinct; existing records protect a cold process too', async () => {
  const f = fixture(); f.records.push({ category: 'category', amount: 12.3, note: args.note, displayDate: args.date });
  assert.equal((await f.client.addTransaction(args)).status, 'already_exists');
  await f.client.addTransaction({ ...args, note: 'Another receipt' }); assert.equal(f.writes(), 1);
});
test('ambiguous writes never retry automatically; identical unresolved requests are blocked', async () => {
  for (const mode of ['timeout', '401', 'malformed']) {
    const f = fixture({ mode });
    await assert.rejects(() => f.client.addTransaction(args), e => e.message.startsWith('transaction/add: outcome_unknown_') && !e.message.includes('secret'));
    await assert.rejects(() => f.client.addTransaction(args), /retry_blocked_previous_outcome_unknown_no_write_sent/);
    assert.equal(f.writes(), 1); assert.equal(f.logins(), 1);
  }
});
test('a committed timeout is found by subsequent duplicate check', async () => {
  const f = fixture({ mode: 'committed-timeout' }); await assert.rejects(() => f.client.addTransaction(args));
  assert.equal((await f.client.addTransaction(args)).status, 'already_exists'); assert.equal(f.writes(), 1);
});
test('invalid wallet/category and unrecognized duplicate-check shape fail before writes', async () => {
  for (const options of [{ wallet: { archived: true } }, { wallet: { _id: 'other' } }, { category: { account: 'other' } }, { category: { type: 3 } }, { category: { isDelete: true } }, { data: {} }]) {
    const f = fixture(options); await assert.rejects(() => f.client.addTransaction(args)); assert.equal(f.writes(), 0);
  }
});
test('invalid amounts and dates fail before any login', async () => {
  for (const invalid of [{ amount: '0' }, { amount: '-1' }, { amount: '1.001' }, { amount: '1e3' }, { amount: 12 }, { date: '2026-02-30' }, { note: 'x'.repeat(2001) }]) {
    const f = fixture(); await assert.rejects(() => f.client.addTransaction({ ...args, ...invalid })); assert.equal(f.writes(), 0); assert.equal(f.logins(), 0);
  }
});

test('write diagnostics preserve sanitized HTTP and numeric API codes', async () => {
  const unauthorized = fixture({ mode: '401' });
  await assert.rejects(() => unauthorized.client.addTransaction(args), e => e.message === 'transaction/add: outcome_unknown_http_error_check_wallet_before_retry (HTTP 401)');
  const invalid = fixture({ mode: 'api-error' });
  await assert.rejects(() => invalid.client.addTransaction(args), e => e.message === 'transaction/add: outcome_unknown_api_error_check_wallet_before_retry (HTTP 200) (API 422)' && e.apiCode === 422);
  const malformed = fixture({ mode: 'malformed' });
  await assert.rejects(() => malformed.client.addTransaction(args), /outcome_unknown_unrecognized_response_missing_data/);
});
