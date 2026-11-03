import test from 'node:test';
import assert from 'node:assert/strict';
import { MoneyloverClient } from '../src/moneylover.js';
const args = { walletId: 'wallet', categoryId: 'category', amount: '12.30', date: '2026-10-19', note: 'Synthetic receipt' };
function fixture({ mode = 'success', wallet = {}, category = {}, categoryRows, data } = {}) {
  let writes = 0, logins = 0; const records = [], bodies = [], logs = [];
  const client = new MoneyloverClient({ email: 'fixture-email', password: 'fixture-password', logger: event => logs.push(event), fetchImpl: async (url, options) => {
    if (url.endsWith('/login-url')) return Response.json({ data: { request_token: 'fixture', login_url: 'https://oauth.moneylover.me/login?client=fixture' } });
    if (url.endsWith('/token')) { logins++; return Response.json({ access_token: 'fixture' }); }
    if (url.endsWith('/wallet/list')) return Response.json({ data: [{ _id: 'wallet', ...wallet }] });
    if (url.endsWith('/category/list-all')) {
      assert.deepEqual(JSON.parse(options.body), {});
      return Response.json({ data: categoryRows ?? [{ _id: 'category', account: 'wallet', type: 2, ...category }] });
    }
    if (url.endsWith('/transaction/list')) return Response.json({ data: data ?? { daterange: {}, transactions: records } });
    assert.ok(url.endsWith('/transaction/add'));
    assert.equal(options.headers.Authorization, 'AuthJWT fixture');
    assert.equal(options.headers['content-type'], 'application/json');
    assert.equal(options.headers.accept, 'application/json');
    assert.equal(options.headers.dataformat, 'json');
    const body = JSON.parse(options.body); bodies.push(body); writes++;
    if (mode === 'timeout') throw new DOMException('secret upstream detail', 'TimeoutError');
    if (mode === 'reset') throw new TypeError('secret host', { cause: Object.assign(new Error('secret body'), { code: 'ECONNRESET' }) });
    if (mode === 'api-error') return Response.json({ error: 422, msg: 'private details', data: 'private' });
    if (mode === '401') return new Response('', { status: 401 });
    if (mode === 'malformed') return Response.json({});
    records.push({ category: { _id: body.category }, amount: Number(body.amount), note: body.note, displayDate: body.displayDate + 'T00:00:00.000Z' });
    if (mode === 'committed-timeout') throw new Error('secret');
    return Response.json({ error: 0, data: { _id: 'synthetic' } });
  } });
  return { client, records, bodies, logs, writes: () => writes, logins: () => logins };
}
test('creates validated transaction using successful browser payload and reuses token', async () => {
  const f = fixture(); const result = await f.client.addTransaction(args);
  assert.equal(result.created, true);
  assert.deepEqual(f.bodies, [{
    with: [], account: 'wallet', category: 'category', amount: 12.3,
    note: 'Synthetic receipt', displayDate: '2026-10-19', event: '',
    exclude_report: false, longitude: 0, latitude: 0, addressName: '',
    addressDetails: '', addressIcon: '', image: ''
  }]);
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
  for (const options of [{ wallet: { archived: true } }, { wallet: { _id: 'other' } }, { category: { type: 3 } }, { category: { isDelete: true } }, { category: { archived: true } }, { category: { exclude_accounts: ['wallet'] } }, { data: {} }]) {
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

test('write network diagnostics survive wrapping without copying sensitive exceptions', async () => {
  for (const [mode, name, code] of [['timeout', 'TimeoutError', null], ['reset', 'TypeError', 'ECONNRESET']]) {
    const f = fixture({ mode });
    await assert.rejects(() => f.client.addTransaction(args), error => {
      assert.equal(error.diagnostics.error_name, name);
      assert.equal(error.diagnostics.network_code, code);
      assert.ok(Number.isInteger(error.diagnostics.elapsed_ms) && error.diagnostics.elapsed_ms >= 0);
      assert.equal(JSON.stringify(error).includes('secret'), false);
      return true;
    });
    assert.equal(f.writes(), 1);
  }
});

test('category IDs remain part of duplicate matching', async () => {
  const f = fixture();
  f.records.push({ category: 'different-category', amount: 12.3, note: args.note, displayDate: args.date });
  assert.equal((await f.client.addTransaction(args)).status, 'created');
  assert.equal(f.writes(), 1);
});
test('dynamic entry values reach the write payload', async () => {
  const f = fixture();
  await f.client.addTransaction({ ...args, amount: '32.20', date: '2026-10-20', note: 'Different synthetic entry' });
  assert.equal(f.bodies[0].amount, 32.2);
  assert.equal(f.bodies[0].displayDate, '2026-10-20');
  assert.equal(f.bodies[0].note, 'Different synthetic entry');
});

test('write logs correlate exact numeric payload and dispatch without credentials or response bodies', async () => {
  const f = fixture();
  await f.client.addTransaction(args);
  const requested = f.logs.find(e => e.event === 'moneylover_write_requested');
  const sent = f.logs.find(e => e.event === 'moneylover_write_dispatch');
  assert.deepEqual(sent.payload, f.bodies[0]);
  assert.deepEqual(requested.payload, sent.payload);
  assert.equal(typeof sent.payload.amount, 'number');
  assert.ok(f.logs.every(e => e.request_id === requested.request_id));
  assert.ok(f.logs.some(e => e.event === 'moneylover_write_confirmed'));
  for (const secret of ['fixture-email', 'fixture-password', 'AuthJWT', 'Authorization', 'synthetic']) {
    assert.equal(JSON.stringify(f.logs).includes(secret), false);
  }
});
test('category rejection logs requested payload and never logs a dispatch', async () => {
  const f = fixture({ category: { _id: 'different' } });
  await assert.rejects(() => f.client.addTransaction(args), /category_unavailable/);
  assert.ok(f.logs.some(e => e.event === 'moneylover_write_requested' && e.payload.category === args.categoryId));
  assert.ok(f.logs.some(e => e.event === 'moneylover_write_stopped' && e.reason === 'category_unavailable' && e.phase === 'before_dispatch'));
  assert.equal(f.logs.some(e => e.event === 'moneylover_write_dispatch'), false);
  assert.equal(f.writes(), 0);
});

test('consolidated categories support income and expense in the selected wallet', async () => {
  for (const type of [1, 2]) {
    const f = fixture({ category: { type, account: 'wallet', exclude_accounts: [] } });
    assert.equal((await f.client.addTransaction(args)).created, true);
    assert.equal(f.bodies[0].category, 'category');
  }
});
test('explicit aliases normalize writes and block duplicates across both ID forms', async () => {
  const f = fixture({ category: { categories: ['wallet-category'] } });
  const aliasArgs = { ...args, categoryId: 'wallet-category' };
  assert.equal((await f.client.addTransaction(aliasArgs)).created, true);
  assert.equal(f.bodies[0].category, 'category');
  assert.equal((await f.client.addTransaction(args)).status, 'already_exists');
  assert.equal((await f.client.addTransaction(aliasArgs)).status, 'already_exists');
  assert.equal(f.writes(), 1);
});
test('duplicate detection recognizes wallet IDs and consolidated transaction aliases', async () => {
  const f = fixture({ category: { categories: ['wallet-category'] } });
  f.records.push({ category: 'wallet-category', amount: 12.3, note: args.note, displayDate: args.date });
  assert.equal((await f.client.addTransaction(args)).status, 'already_exists');
  const g = fixture();
  g.records.push({ category: { _id: 'response-category', categories: ['category'] }, amount: 12.3, note: args.note, displayDate: args.date });
  assert.equal((await g.client.addTransaction(args)).status, 'already_exists');
  assert.equal(f.writes() + g.writes(), 0);
});
test('unverified category IDs are rejected before dispatch', async () => {
  const f = fixture();
  await assert.rejects(() => f.client.addTransaction({ ...args, categoryId: 'unknown' }), /category_unavailable/);
  assert.equal(f.writes(), 0);
});

test('list-all repeated consolidated IDs are scoped by wallet before validation', async () => {
  const categoryRows = Array.from({ length: 23 }, (_, i) => ({
    _id: 'category', name: 'Food & Beverage', type: 2,
    account: i === 14 ? 'wallet' : `other-wallet-${i}`, exclude_accounts: []
  }));
  const f = fixture({ categoryRows });
  assert.deepEqual(await f.client.getCategories('wallet'), [categoryRows[14]]);
  assert.equal((await f.client.addTransaction(args)).created, true);
  assert.equal(f.writes(), 1);
  assert.equal(f.bodies[0].category, 'category');
  assert.equal(f.bodies[0].account, 'wallet');
});
test('other wallet rows cannot authorize a write or override selected wallet restrictions', async () => {
  const other = { _id: 'category', name: 'Food & Beverage', account: 'other', type: 2 };
  for (const categoryRows of [[other], [other, { ...other, account: 'wallet', isDelete: true }],
    [other, { ...other, account: 'wallet', exclude_accounts: ['wallet'] }],
    [other, { ...other, account: 'wallet' }, { ...other, account: 'wallet' }]]) {
    const f = fixture({ categoryRows });
    await assert.rejects(() => f.client.addTransaction(args), /category_(unavailable|excluded)/);
    assert.equal(f.writes(), 0);
  }
});

test('optional report exclusion reaches add payload and invalid values are rejected', async () => {
  const f = fixture();
  await f.client.addTransaction({ ...args, excludeReport: true });
  assert.equal(f.bodies[0].exclude_report, true);
  const bad = fixture();
  await assert.rejects(() => bad.client.addTransaction({ ...args, excludeReport: 'true' }), /invalid_arguments/);
  assert.equal(bad.writes(), 0);
});
