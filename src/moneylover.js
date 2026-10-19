import { createHash } from 'node:crypto';
// Protocol adapted from the owner's Worker bridge; financial responses are never cached.
const BASE = 'https://web.moneylover.me/api';
const TOKEN = 'https://oauth.moneylover.me/token';
export class UpstreamError extends Error {
  constructor(stage, reason, status = null, auth = false, apiCode = null) {
    super(`${stage}: ${reason}${status === null ? '' : ` (HTTP ${status})`}${apiCode === null ? '' : ` (API ${apiCode})`}`);
    Object.assign(this, { stage, reason, status, auth, apiCode });
  }
}
export class MoneyloverClient {
  #writeQueue = Promise.resolve(); #uncertain = new Set();
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
    if (code) throw new UpstreamError(stage, 'api_error', response.status, Number(code) === 401, typeof code === 'number' && Number.isSafeInteger(code) ? code : null);
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
        // Transactions may use an object envelope; preserve it (including metadata)
        // like the reference client, without guessing or flattening its fields.
        const data = result?.data;
        const transactionObject = route === '/transaction/list' && data !== null && typeof data === 'object';
        if (!Array.isArray(data) && !transactionObject) throw new UpstreamError(route.slice(1), 'unexpected_data_shape');
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
  // Serialize writes across stateless MCP requests. Never retry a POST that may
  // already have committed. Only hashes of ambiguous requests are retained.
  addTransaction(params) {
    const work = this.#writeQueue.then(() => this.#addTransaction(params));
    this.#writeQueue = work.catch(() => {});
    return work;
  }
  async #addTransaction({ walletId, categoryId, amount, date, note = '' }) {
    const reject = reason => { throw new UpstreamError('transaction/add', reason); };
    if (![walletId, categoryId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256) ||
        typeof note !== 'string' || note.length > 2000 ||
        typeof amount !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 ||
        typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) reject('invalid_arguments');
    const wallets = await this.getWallets();
    const wallet = wallets.find(w => w._id === walletId);
    if (!wallet || wallet.isDelete || wallet.archived) reject('wallet_unavailable');
    const categories = await this.getCategories(walletId);
    const category = categories.find(c => c._id === categoryId);
    if (!category || category.isDelete || ![1, 2].includes(category.type) || (category.account && category.account !== walletId)) reject('category_unavailable');
    const payload = { account: walletId, category: categoryId, amount: Number(amount).toFixed(2), displayDate: date, note, with: [] };
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const result = await this.getTransactions(walletId, date, date);
    const transactions = Array.isArray(result) ? result : result?.transactions;
    if (!Array.isArray(transactions)) reject('duplicate_check_unavailable');
    const duplicate = transactions.some(t =>
      (typeof t.category === 'string' ? t.category : t.category?._id) === categoryId &&
      Number(t.amount) === Number(amount) && (t.note ?? '') === note &&
      typeof t.displayDate === 'string' && t.displayDate.slice(0, 10) === date);
    if (duplicate) return { status: 'already_exists', created: false };
    if (this.#uncertain.has(fingerprint)) reject('retry_blocked_previous_outcome_unknown_no_write_sent');
    if (this.#uncertain.size >= 1000) reject('uncertain_write_limit_check_wallet');
    const token = await this.#getToken();
    this.#uncertain.add(fingerprint);
    try {
      const response = await this.#json('transaction/add', `${BASE}/transaction/add`, {
        method: 'POST', headers: { Authorization: `AuthJWT ${token}`, 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify(payload)
      });
      // A missing/invalid response cannot prove whether the write committed.
      if (!Object.hasOwn(response ?? {}, 'data')) reject('unrecognized_response_missing_data');
      if (response.data === null || typeof response.data !== 'object') {
        const kind = response.data === null ? 'null' : typeof response.data;
        reject(`unrecognized_response_data_${kind}`);
      }
      this.#uncertain.delete(fingerprint);
      return { status: 'created', created: true, transaction: response.data };
    } catch (error) {
      // Fixed reason labels and numeric codes only; never expose upstream messages.
      if (error instanceof UpstreamError) {
        throw new UpstreamError('transaction/add', `outcome_unknown_${error.reason}_check_wallet_before_retry`, error.status, false, error.apiCode);
      }
      throw new UpstreamError('transaction/add', 'outcome_unknown_internal_error_check_wallet_before_retry');
    }
  }
  getWallets() { return this.#query('/wallet/list', {}); }
  getCategories(walletId) { return this.#query('/category/list', { walletId }, true); }
  getTransactions(walletId, startDate, endDate) { return this.#query('/transaction/list', { walletId, startDate, endDate }); }
}
