import test from 'node:test';
import assert from 'node:assert/strict';
import { MoneyloverClient } from '../src/moneylover.js';
const expected = { categoryId: 'food', amount: '10.20', date: '2026-10-19', note: 'Original' };
const args = { walletId: 'wallet', transactionId: 'entry', expected, changes: { note: 'Corrected' } };
function fixture({ target = {}, mode = 'success', categories, extra = [] } = {}) {
  const logs = [], bodies = [];
  let rows = [{ _id: 'entry', account: { _id: 'wallet' }, category: { _id: 'food', type: 2 }, amount: 10.2,
    displayDate: expected.date, note: 'Original', with: ['Friend'], images: ['receipt.png'],
    campaign: [{ _id: 'holiday', type: 6 }], exclude_report: true, remind: 123,
    longtitude: 101, latitude: 3, address: JSON.stringify({ name: 'Cafe', details: 'Street', icon: 'pin' }), ...target }, ...extra];
  const client = new MoneyloverClient({ email: 'secret-email', password: 'secret-password', logger: e => logs.push(e), fetchImpl: async (url, options) => {
    if (url.endsWith('/login-url')) return Response.json({ data: { request_token: 'secret-token', login_url: 'https://oauth.moneylover.me/login?client=fixture' } });
    if (url.endsWith('/token')) return Response.json({ access_token: 'secret-token' });
    if (url.endsWith('/wallet/list')) return Response.json({ data: [{ _id: 'wallet' }] });
    if (url.endsWith('/category/list-all')) return Response.json({ data: categories ?? [{ _id: 'food', account: 'wallet', type: 2 }, { _id: 'credit', account: 'wallet', type: 1 }] });
    if (url.endsWith('/transaction/list')) {
      const { startDate } = JSON.parse(options.body);
      return Response.json({ data: { transactions: rows.filter(t => t.displayDate.slice(0, 10) === startDate) } });
    }
    assert.ok(url.endsWith('/transaction/edit'));
    assert.equal(options.headers.dataformat, 'json');
    const body = JSON.parse(options.body); bodies.push(body);
    if (mode === 'timeout') throw new Error('secret-network');
    if (mode === '401') return new Response('', { status: 401 });
    if (mode !== 'no-change') rows = rows.map(t => t._id === body._id ? { ...t, amount: body.amount, note: body.note, category: body.category, displayDate: body.displayDate } : t);
    if (mode === 'committed-timeout') throw new Error('secret-network');
    return Response.json({ error: 0, msg: 'transaction_edit_success' });
  } });
  return { client, logs, bodies };
}
test('note-only edit preserves event, image, location, reminder, contacts and report setting; verifies readback', async () => {
  const f = fixture(); const result = await f.client.editTransaction(args);
  assert.equal(result.status, 'edited');
  assert.deepEqual(f.bodies, [{ _id: 'entry', with: ['Friend'], account: 'wallet', category: 'food', amount: 10.2,
    note: 'Corrected', displayDate: expected.date, event: 'holiday', exclude_report: true, longtitude: 101,
    latitude: 3, addressName: 'Cafe', addressDetails: 'Street', addressIcon: 'pin', remind: 123, image: 'receipt.png' }]);
  assert.deepEqual(f.logs.find(e => e.event === 'moneylover_write_dispatch').payload, f.bodies[0]);
  assert.equal(JSON.stringify(f.logs).includes('secret'), false);
});
test('amount/category/date changes and empty note reach edit endpoint, verified on new date', async () => {
  const f = fixture();
  await f.client.editTransaction({ ...args, changes: { amount: '32.20', categoryId: 'credit', date: '2026-10-20', note: '' } });
  assert.equal(f.bodies[0].amount, 32.2); assert.equal(f.bodies[0].category, 'credit'); assert.equal(f.bodies[0].note, '');
});
test('stale snapshot, wrong wallet, deleted/linked entries and ambiguous metadata block dispatch', async () => {
  for (const target of [{ amount: 12 }, { account: 'other' }, { isDelete: true }, { parent: 'parent' },
    { category: { _id: 'food', metadata: 'IS_DEBT_COLLECTION' } }, { images: ['a', 'b'] }, { campaign: [{ type: 1 }] }, { address: 'invalid' }]) {
    const f = fixture({ target }); await assert.rejects(() => f.client.editTransaction(args)); assert.equal(f.bodies.length, 0);
  }
});
test('invalid requests and unavailable/excluded/ambiguous categories block writes', async () => {
  for (const changes of [{}, { amount: '-1' }, { date: '2026-02-30' }, { walletId: 'other' }, { note: null }]) {
    const f = fixture(); await assert.rejects(() => f.client.editTransaction({ ...args, changes })); assert.equal(f.bodies.length, 0);
  }
  for (const categories of [[], [{ _id: 'food', account: 'other', type: 2 }],
    [{ _id: 'food', account: 'wallet', type: 2, exclude_accounts: ['wallet'] }]]) {
    const f = fixture({ categories }); await assert.rejects(() => f.client.editTransaction(args)); assert.equal(f.bodies.length, 0);
  }
});
test('duplicate matching excludes edited record and blocks another matching transaction', async () => {
  const f = fixture({ extra: [{ _id: 'other', category: 'food', amount: 10.2, displayDate: expected.date, note: 'Corrected' }] });
  await assert.rejects(() => f.client.editTransaction(args), /duplicate_transaction/); assert.equal(f.bodies.length, 0);
});
test('concurrent identical edits serialize; second call is a read-only no-op', async () => {
  const f = fixture();
  assert.deepEqual((await Promise.all([f.client.editTransaction(args), f.client.editTransaction(args)])).map(r => r.status), ['edited', 'already_matches']);
  assert.equal(f.bodies.length, 1);
});
test('timeout, 401 and failed verification never replay writes, even with a different desired change', async () => {
  for (const mode of ['timeout', '401', 'no-change']) {
    const f = fixture({ mode }); await assert.rejects(() => f.client.editTransaction(args), /outcome_unknown/);
    await assert.rejects(() => f.client.editTransaction({ ...args, changes: { note: 'Another' } }), /retry_blocked/);
    assert.equal(f.bodies.length, 1);
  }
});
test('committed timeout can be observed as a no-op without a second write', async () => {
  const f = fixture({ mode: 'committed-timeout' }); await assert.rejects(() => f.client.editTransaction(args), /outcome_unknown/);
  assert.equal((await f.client.editTransaction(args)).status, 'already_matches'); assert.equal(f.bodies.length, 1);
});
