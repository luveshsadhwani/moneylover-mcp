import test from 'node:test';
import assert from 'node:assert/strict';
import { MoneyloverClient } from '../src/moneylover.js';
const wallets = [{ _id: 'a', name: 'Cash' }, { _id: 'b', name: 'Card' }, { _id: 'deleted', isDelete: true }];
const row = (id, account) => ({ _id: id, account: { _id: account }, displayDate: '2026-09-20T00:00:00Z', amount: 27, note: 'Synthetic chicken rice', category: { _id: 'food', name: 'Food' }, images: ['private-unused'], address: 'private-unused' });
function fixture({ data = [], status = 200, error = 0 } = {}) {
  const requests = [];
  const client = new MoneyloverClient({ email: 'test', password: 'test', fetchImpl: async (url, options) => {
    if (url.endsWith('/login-url')) return Response.json({ data: { request_token: 'test', login_url: 'https://oauth.moneylover.me/login?client=test' } });
    if (url.endsWith('/token')) return Response.json({ access_token: 'test' });
    requests.push({ url, payload: JSON.parse(options.body), headers: options.headers });
    if (url.endsWith('/wallet/list')) return Response.json({ data: wallets });
    return status === 200 ? Response.json({ data, error }) : new Response('private-body', { status });
  } });
  return { client, requests };
}
test('one native keyword request searches multiple wallets and returns compact records', async () => {
  const { client, requests } = fixture({ data: [row('one', 'a'), row('two', 'b')] });
  const result = await client.searchTransactions({ query: ' chicken rice ' });
  assert.equal(requests.length, 2);
  assert.ok(requests[1].url.endsWith('/transaction/search'));
  assert.deepEqual(requests[1].payload, { note: 'chicken rice', accounts: ['a', 'b'], limit: 50, offset: 0 });
  assert.equal(requests[1].headers.Authorization, 'AuthJWT test');
  assert.equal(result.transactions[0].date, '2026-09-20');
  assert.equal(result.transactions[0].amount, 27);
  assert.deepEqual(result.transactions.map(t => t.wallet.name), ['Cash', 'Card']);
  assert.equal(JSON.stringify(result).includes('private-unused'), false);
  assert.equal(result.nextOffset, null);
});
test('filters and offset pagination use native API fields', async () => {
  const { client, requests } = fixture({ data: [row('two', 'b')] });
  const result = await client.searchTransactions({ query: 'rice', walletId: 'b', categoryId: 'food', startDate: '2026-01-01', endDate: '2026-12-31', limit: 1, offset: 3 });
  assert.deepEqual(requests[1].payload, { note: 'rice', accounts: ['b'], categoryIDs: ['food'], startDate: '2026-01-01', endDate: '2026-12-31', limit: 1, offset: 3 });
  assert.equal(result.nextOffset, 4);
  const empty = fixture();
  assert.deepEqual(await empty.client.searchTransactions({ query: 'absent', limit: 1, offset: 4 }), { transactions: [], limit: 1, offset: 4, nextOffset: null });
});
test('invalid inputs fail before any login or upstream request', async () => {
  const { client, requests } = fixture();
  for (const args of [{}, { query: ' ' }, { query: 'x', limit: 0 }, { query: 'x', offset: -1 }, { query: 'x', startDate: '2026-02-30' }, { query: 'x', startDate: '2026-10-01', endDate: '2026-01-01' }]) await assert.rejects(() => client.searchTransactions(args), /invalid_arguments/);
  assert.equal(requests.length, 0);
});
test('unavailable wallets and malformed or cross-wallet results fail closed', async () => {
  await assert.rejects(() => fixture().client.searchTransactions({ query: 'x', walletId: 'deleted' }), /wallet_unavailable/);
  for (const data of [{ transactions: [] }, null, [row('one', 'foreign')], [{}], [row('one', 'a'), row('two', 'a')]]) {
    await assert.rejects(() => fixture({ data }).client.searchTransactions({ query: 'x', limit: 1 }), /unexpected_data_shape/);
  }
});
test('API and HTTP failures remain sanitized', async () => {
  for (const options of [{ status: 500 }, { status: 403 }, { error: 123 }]) {
    await assert.rejects(() => fixture(options).client.searchTransactions({ query: 'x' }), e => /transaction\/search: (http_error|api_error)/.test(e.message) && !e.message.includes('private'));
  }
});
