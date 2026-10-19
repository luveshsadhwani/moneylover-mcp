// Protocol adapted from the owner's Worker bridge; financial responses are never cached.
const BASE = 'https://web.moneylover.me/api';
const TOKEN = 'https://oauth.moneylover.me/token';
export class UpstreamError extends Error {
  constructor(stage, reason, status = null, auth = false) {
    super(`${stage}: ${reason}${status === null ? '' : ` (HTTP ${status})`}`);
    Object.assign(this, { stage, reason, status, auth });
  }
}
export class MoneyloverClient {
  #token; #expires = Infinity; #pending; #retryAfter = 0;
  constructor({ email, password, fetchImpl = fetch, now = Date.now }) {
    if (!email || !password) throw new Error('Money Lover credentials are required');
    Object.assign(this, { email, password, fetchImpl, now });
  }
  async #json(stage, url, options) {
    let response;
    try { response = await this.fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20000) }); }
    catch { throw new UpstreamError(stage, 'network_error'); }
    if (!response.ok) {
      const challenge = response.headers.get('cf-mitigated') === 'challenge';
      throw new UpstreamError(stage, challenge ? 'cloudflare_challenge' : 'http_error', response.status, response.status === 401);
    }
    let data;
    try { data = await response.json(); } catch { throw new UpstreamError(stage, 'invalid_json', response.status); }
    const code = data?.error ?? data?.e ?? 0;
    if (code) throw new UpstreamError(stage, 'api_error', response.status, Number(code) === 401);
    return data;
  }
  async #login() {
    const initial = await this.#json('login-url', `${BASE}/user/login-url`, { method: 'POST' });
    const { request_token: requestToken, login_url: loginUrl } = initial?.data ?? {};
    let url;
    try { url = new URL(loginUrl); } catch { throw new UpstreamError('login-url', 'invalid_login_url'); }
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.moneylover.me') || !url.searchParams.get('client') || typeof requestToken !== 'string') {
      throw new UpstreamError('login-url', 'invalid_login_fields');
    }
    const data = await this.#json('token', TOKEN, {
      method: 'POST', headers: { Authorization: `Bearer ${requestToken}`, Client: url.searchParams.get('client'), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: this.email, password: this.password }).toString()
    });
    if (typeof data?.access_token !== 'string' || !data.access_token) throw new UpstreamError('token', 'missing_access_token');
    let expires = Infinity;
    // Decode only as a cache-expiry hint, NEVER as authentication/authorization.
    try {
      const claims = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64url').toString());
      if (Number.isFinite(claims.exp)) expires = claims.exp * 1000;
    } catch { /* opaque token: reuse until an authentication error */ }
    if (Number.isFinite(Number(data.expires_in)) && Number(data.expires_in) > 0) expires = Math.min(expires, this.now() + Number(data.expires_in) * 1000);
    if (expires <= this.now()) throw new UpstreamError('token', 'expired_access_token');
    this.#token = data.access_token; this.#expires = expires;
    return this.#token;
  }
  async #getToken() {
    if (this.#token && this.now() < this.#expires) return this.#token;
    if (this.#pending) return this.#pending;
    if (this.now() < this.#retryAfter) throw new UpstreamError('token', 'login_cooldown');
    this.#pending = this.#login().catch(error => { this.#retryAfter = this.now() + 30000; throw error; }).finally(() => { this.#pending = null; });
    return this.#pending;
  }
  async #query(route, payload, form = false) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.#getToken();
      try {
        const result = await this.#json(route.slice(1), `${BASE}${route}`, {
          method: 'POST', headers: { Authorization: `AuthJWT ${token}`, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', 'cache-control': 'no-store' },
          body: form ? new URLSearchParams(payload).toString() : JSON.stringify(payload)
        });
        if (!Array.isArray(result?.data)) throw new UpstreamError(route.slice(1), 'unexpected_data_shape');
        return result.data;
      } catch (error) {
        if (!error.auth) throw error; // A 403 challenge must NOT trigger repeated device logins.
        if (this.#token === token) {
          this.#token = null;
          if (attempt === 1) this.#retryAfter = this.now() + 30000;
        }
        if (attempt === 1) throw error;
      }
    }
  }
  getWallets() { return this.#query('/wallet/list', {}); }
  getCategories(walletId) { return this.#query('/category/list', { walletId }, true); }
  getTransactions(walletId, startDate, endDate) { return this.#query('/transaction/list', { walletId, startDate, endDate }); }
}
