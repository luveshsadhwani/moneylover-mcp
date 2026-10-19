import test from 'node:test';
import assert from 'node:assert/strict';
import { MoneyloverClient } from '../src/moneylover.js';
function fixture({ fail = [], expiry = 3600 } = {}) {
  let logins = 0, queries = 0, now = Date.now();
  const client = new MoneyloverClient({ email: 'private-email', password: 'private-password', now: () => now, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (url.endsWith('/login-url')) return Response.json({ data: { request_token: 'private-request-token', login_url: 'https://oauth.moneylover.me/login?client=abc' } });
    if (url.endsWith('/token')) { logins++; return Response.json({ access_token: `opaque-${logins}`, expires_in: expiry }); }
    const status = fail[queries++] || 200;
    if (status !== 200) return new Response('private-body', { status, headers: status === 403 ? { 'cf-mitigated': 'challenge' } : {} });
    return Response.json({ data: [{ id: 'fixture' }] });
  } });
  return { client, logins: () => logins, queries: () => queries, advance: ms => { now += ms; } };
}
test('concurrent calls and subsequent calls share one login', async () => {
  const f = fixture(); await Promise.all(Array.from({ length: 8 }, () => f.client.getWallets()));
  await f.client.getCategories('wallet'); await f.client.getTransactions('wallet', '2026-01-01', '2026-01-02');
  assert.equal(f.logins(), 1); assert.equal(f.queries(), 10);
});
test('expiry causes one refresh, then reuse', async () => { const f = fixture({ expiry: 1 }); await f.client.getWallets(); f.advance(2000); await Promise.all([f.client.getWallets(), f.client.getWallets()]); assert.equal(f.logins(), 2); });
test('concurrent stale-token 401s share one refresh', async () => { const f = fixture({ fail: [401, 401, 401] }); await Promise.all([f.client.getWallets(), f.client.getWallets(), f.client.getWallets()]); assert.equal(f.logins(), 2); });
test('401 retry bounded; repeated rejection activates cooldown', async () => { const f = fixture({ fail: [401, 401] }); await assert.rejects(() => f.client.getWallets()); await assert.rejects(() => f.client.getWallets(), /cooldown/); assert.equal(f.logins(), 2); });
test('403 challenge and 500 do not cause fresh logins', async () => { for (const code of [403, 500]) { const f = fixture({ fail: [code] }); await assert.rejects(() => f.client.getWallets(), error => !error.message.includes('private-')); await f.client.getWallets(); assert.equal(f.logins(), 1); } });
test('restart creates a cold cache, not a login per call', async () => { const f = fixture(); await f.client.getWallets(); const restarted = fixture(); await restarted.client.getWallets(); await restarted.client.getWallets(); assert.equal(restarted.logins(), 1); });
test('upstream exceptions and bodies never appear in errors', async () => { const c = new MoneyloverClient({ email: 'e', password: 'p', fetchImpl: async () => { throw new Error('secret-password'); } }); await assert.rejects(() => c.getWallets(), error => error.message === 'login-url: network_error'); });
