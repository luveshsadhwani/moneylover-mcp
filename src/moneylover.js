import { referenceId, validDate, validAmount, validId, categoryMatches, snapshotMatches, editPayload } from './edit.js';
import { createHash, randomUUID } from 'node:crypto';
// Protocol adapted from the owner's Worker bridge; financial responses are never cached.
const BASE = 'https://web.moneylover.me/api';
const TOKEN = 'https://oauth.moneylover.me/token';
// Never copy exception messages, stacks, URLs, hostnames or arbitrary codes.
const ERROR_NAMES = new Set(['Error', 'TypeError', 'TimeoutError', 'AbortError', 'SyntaxError', 'AggregateError']);
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER']);
function networkDiagnostics(error, started) {
  const code = [error?.cause?.code, error?.code].find(value => NETWORK_CODES.has(value));
  return { error_name: ERROR_NAMES.has(error?.name) ? error.name : 'OtherError', network_code: code ?? null, elapsed_ms: Math.max(0, Math.round(performance.now() - started)) };
}
export class UpstreamError extends Error {
  constructor(stage, reason, status = null, auth = false, apiCode = null, diagnostics = null) {
    super(`${stage}: ${reason}${status === null ? '' : ` (HTTP ${status})`}${apiCode === null ? '' : ` (API ${apiCode})`}`);
    Object.assign(this, { stage, reason, status, auth, apiCode, diagnostics });
  }
}
export class MoneyloverClient {
  #writeQueue = Promise.resolve(); #uncertain = new Set();
  #token; #expires = Infinity; #pending; #retryAfter = 0;
  constructor({ email, password, fetchImpl = fetch, now = Date.now, logger = () => {} }) {
    if (!email || !password) throw new Error('Money Lover credentials are required');
    Object.assign(this, { email, password, fetchImpl, now, logger });
  }
  async #json(stage, url, options) {
    let response;
    const started = performance.now();
    try { response = await this.fetchImpl(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20000) }); }
    catch (error) { throw new UpstreamError(stage, 'network_error', null, false, null, networkDiagnostics(error, started)); }
    if (!response.ok) {
      const challenge = response.headers.get('cf-mitigated') === 'challenge';
      throw new UpstreamError(stage, challenge ? 'cloudflare_challenge' : 'http_error', response.status, response.status === 401);
    }
    let data;
    try { data = await response.json(); } catch (error) { throw new UpstreamError(stage, 'invalid_json', response.status, false, null, networkDiagnostics(error, started)); }
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
  async #addTransaction({ walletId, categoryId, amount, date, note = '', excludeReport = false }) {
    const requestId = randomUUID();
    let dispatched = false;
    const log = fields => this.logger({ request_id: requestId, stage: 'transaction/add', ...fields });
    const reject = reason => {
      log({ event: 'moneylover_write_stopped', phase: dispatched ? 'after_dispatch' : 'before_dispatch', reason });
      throw new UpstreamError('transaction/add', reason);
    };
    if (![walletId, categoryId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256) ||
        typeof note !== 'string' || note.length > 2000 || typeof excludeReport !== 'boolean' ||
        typeof amount !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0 ||
        typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) reject('invalid_arguments');
    // Match the owner's successful browser/local request; retain dynamic IDs.
    const payload = {
      with: [], account: walletId, category: categoryId, amount: Number(amount),
      note, displayDate: date, event: '', exclude_report: excludeReport,
      longitude: 0, latitude: 0, addressName: '', addressDetails: '',
      addressIcon: '', image: ''
    };
    log({ event: 'moneylover_write_requested', payload });
    const wallets = await this.getWallets();
    const wallet = wallets.find(w => w._id === walletId);
    if (!wallet || wallet.isDelete || wallet.archived) reject('wallet_unavailable');
    const categories = await this.getCategories(walletId);
    // list-all repeats consolidated IDs per account. getCategories scopes the
    // rows to the requested wallet before we check for an unambiguous ID.
    // Accept aliases only when the API explicitly lists the relationship.
    const matches = categories.filter(c => c._id === categoryId ||
      (Array.isArray(c.categories) && c.categories.includes(categoryId)));
    const category = matches.length === 1 ? matches[0] : null;
    if (!category || typeof category._id !== 'string' || !category._id ||
        category.isDelete || category.archived || ![1, 2].includes(category.type)) reject('category_unavailable');
    // Conservatively refuse an explicit exclusion.
    if (Array.isArray(category.exclude_accounts) && category.exclude_accounts.includes(walletId)) reject('category_excluded');
    payload.category = category._id;
    const categoryIds = new Set([categoryId, category._id,
      ...(Array.isArray(category.categories) ? category.categories.filter(id => typeof id === 'string') : [])]);
    const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const result = await this.getTransactions(walletId, date, date);
    const transactions = Array.isArray(result) ? result : result?.transactions;
    if (!Array.isArray(transactions)) reject('duplicate_check_unavailable');
    const duplicate = transactions.some(t =>
      (categoryIds.has(typeof t.category === 'string' ? t.category : t.category?._id) ||
        (Array.isArray(t.category?.categories) && t.category.categories.some(id => categoryIds.has(id)))) &&
      Number(t.amount) === Number(amount) && (t.note ?? '') === note &&
      typeof t.displayDate === 'string' && t.displayDate.slice(0, 10) === date);
    if (duplicate) {
      log({ event: 'moneylover_write_skipped', reason: 'already_exists' });
      return { status: 'already_exists', created: false };
    }
    if (this.#uncertain.has(fingerprint)) reject('retry_blocked_previous_outcome_unknown_no_write_sent');
    if (this.#uncertain.size >= 1000) reject('uncertain_write_limit_check_wallet');
    const token = await this.#getToken();
    this.#uncertain.add(fingerprint);
    try {
      log({ event: 'moneylover_write_dispatch', method: 'POST', path: '/api/transaction/add',
        headers: { 'content-type': 'application/json', accept: 'application/json', dataformat: 'json', 'cache-control': 'no-store' },
        payload });
      dispatched = true;
      const response = await this.#json('transaction/add', `${BASE}/transaction/add`, {
        method: 'POST', headers: { Authorization: `AuthJWT ${token}`, 'content-type': 'application/json', accept: 'application/json', dataformat: 'json', 'cache-control': 'no-store' },
        body: JSON.stringify(payload)
      });
      // A missing/invalid response cannot prove whether the write committed.
      if (!Object.hasOwn(response ?? {}, 'data')) reject('unrecognized_response_missing_data');
      if (response.data === null || typeof response.data !== 'object') {
        const kind = response.data === null ? 'null' : typeof response.data;
        reject(`unrecognized_response_data_${kind}`);
      }
      log({ event: 'moneylover_write_confirmed' });
      this.#uncertain.delete(fingerprint);
      return { status: 'created', created: true, transaction: response.data };
    } catch (error) {
      log({ event: 'moneylover_write_failed', reason: error instanceof UpstreamError ? error.reason : 'internal_error' });
      // Fixed reason labels and numeric codes only; never expose upstream messages.
      if (error instanceof UpstreamError) {
        throw new UpstreamError('transaction/add', `outcome_unknown_${error.reason}_check_wallet_before_retry`, error.status, false, error.apiCode, error.diagnostics);
      }
      throw new UpstreamError('transaction/add', 'outcome_unknown_internal_error_check_wallet_before_retry');
    }
  }
  editTransaction(params) {
    const work = this.#writeQueue.then(() => this.#editTransaction(params));
    this.#writeQueue = work.catch(() => {});
    return work;
  }
  async #editTransaction(params) {
    const requestId = randomUUID();
    let dispatched = false;
    const log = fields => this.logger({ request_id: requestId, stage: 'transaction/edit', ...fields });
    const reject = reason => {
      log({ event: 'moneylover_write_stopped', phase: dispatched ? 'after_dispatch' : 'before_dispatch', reason });
      throw new UpstreamError('transaction/edit', reason);
    };
    const { walletId, transactionId, expected, changes } = params ?? {};
    const validSnapshot = v => v && validId(v.categoryId) && validAmount(v.amount) && validDate(v.date) && typeof v.note === 'string' && v.note.length <= 2000;
    if (!validId(walletId) || !validId(transactionId) || !validSnapshot(expected) || !changes ||
        !Object.keys(changes).length || Object.keys(changes).some(k => !['categoryId', 'amount', 'date', 'note', 'excludeReport'].includes(k)) ||
        !validSnapshot({ ...expected, ...changes }) ||
        (changes.excludeReport !== undefined && typeof changes.excludeReport !== 'boolean')) reject('invalid_arguments');
    const desired = { ...expected, ...changes };
    const wallet = (await this.getWallets()).find(w => w._id === walletId);
    if (!wallet || wallet.isDelete || wallet.archived) reject('wallet_unavailable');
    const categories = await this.getCategories(walletId);
    const matches = categories.filter(c => categoryMatches(c, desired.categoryId));
    const category = matches.length === 1 ? matches[0] : null;
    if (!category || !validId(category._id) || category.isDelete || category.archived || ![1, 2].includes(category.type)) reject('category_unavailable');
    if (category.exclude_accounts?.includes(walletId)) reject('category_excluded');
    if (/^IS_(DEBT|LOAN|REPAYMENT|TRANSFER)/.test(category.metadata ?? '')) reject('linked_transaction_unsupported');
    desired.categoryId = category._id;
    const read = async date => {
      const data = await this.getTransactions(walletId, date, date);
      const rows = Array.isArray(data) ? data : data?.transactions;
      if (!Array.isArray(rows)) reject('transaction_check_unavailable');
      return rows;
    };
    const rows = await read(expected.date);
    const targets = rows.filter(t => t._id === transactionId);
    const target = targets.length === 1 ? targets[0] : null;
    if (!target || target.isDelete || referenceId(target.account) !== walletId) reject('transaction_unavailable');
    if (snapshotMatches(target, desired) && (changes.excludeReport === undefined || target.exclude_report === changes.excludeReport)) return { status: 'already_matches', edited: false, transaction: target };
    if (!snapshotMatches(target, expected)) reject('transaction_changed_refresh_before_edit');
    const payload = editPayload(target, walletId, desired, reject);
    if (changes.excludeReport !== undefined) payload.exclude_report = changes.excludeReport;
    log({ event: 'moneylover_write_requested', payload });
    const destinationRows = desired.date === expected.date ? rows : await read(desired.date);
    if (destinationRows.some(t => t._id !== transactionId && snapshotMatches(t, desired))) reject('duplicate_transaction');
    // Block further edits to this record after an uncertain write, even if the
    // caller changes the desired payload. This guard lasts until process restart.
    const fingerprint = createHash('sha256').update(JSON.stringify(['edit', walletId, transactionId])).digest('hex');
    if (this.#uncertain.has(fingerprint)) reject('retry_blocked_previous_outcome_unknown_no_write_sent');
    if (this.#uncertain.size >= 1000) reject('uncertain_write_limit_check_wallet');
    const token = await this.#getToken();
    this.#uncertain.add(fingerprint);
    try {
      const headers = { 'content-type': 'application/json', accept: 'application/json', dataformat: 'json', 'cache-control': 'no-store' };
      log({ event: 'moneylover_write_dispatch', method: 'POST', path: '/api/transaction/edit', headers, payload });
      dispatched = true;
      await this.#json('transaction/edit', `${BASE}/transaction/edit`, {
        method: 'POST', headers: { ...headers, Authorization: `AuthJWT ${token}` }, body: JSON.stringify(payload)
      });
      const verified = (await read(desired.date)).filter(t => t._id === transactionId && referenceId(t.account) === walletId && !t.isDelete);
      if (verified.length !== 1 || !snapshotMatches(verified[0], desired) || verified[0].exclude_report !== payload.exclude_report) reject('verification_failed');
      this.#uncertain.delete(fingerprint);
      log({ event: 'moneylover_write_confirmed' });
      return { status: 'edited', edited: true, transaction: verified[0] };
    } catch (error) {
      log({ event: 'moneylover_write_failed', reason: error instanceof UpstreamError ? error.reason : 'internal_error' });
      throw new UpstreamError('transaction/edit', `outcome_unknown_${error instanceof UpstreamError ? error.reason : 'internal_error'}_check_wallet_before_retry`, error.status ?? null, false, error.apiCode ?? null, error.diagnostics ?? null);
    }
  }
  // Contract observed in Money Lover web app SearchTransaction.vue, 2026-10-23:
  // note, accounts, categoryIDs, startDate/endDate, limit and offset.
  async searchTransactions({ query, walletId, startDate, endDate, categoryId, limit = 50, offset = 0 } = {}) {
    const reject = reason => { throw new UpstreamError('transaction/search', reason); };
    if (typeof query !== 'string' || !query.trim() || query.length > 500 ||
        (walletId !== undefined && !validId(walletId)) || (categoryId !== undefined && !validId(categoryId)) ||
        (startDate !== undefined && !validDate(startDate)) || (endDate !== undefined && !validDate(endDate)) ||
        (startDate !== undefined && endDate !== undefined && startDate > endDate) ||
        !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) reject('invalid_arguments');
    // One wallet-list request supplies all accounts; never fetch wallet histories.
    const wallets = await this.getWallets();
    const available = wallets.filter(w => validId(w?._id) && !w.isDelete && !w.archived);
    const selected = walletId === undefined ? available : available.filter(w => w._id === walletId);
    if (walletId !== undefined && !selected.length) reject('wallet_unavailable');
    if (!selected.length) return { transactions: [], limit, offset, nextOffset: null };
    const payload = { note: query.trim(), accounts: selected.map(w => w._id), limit, offset,
      ...(categoryId === undefined ? {} : { categoryIDs: [categoryId] }),
      ...(startDate === undefined ? {} : { startDate }), ...(endDate === undefined ? {} : { endDate }) };
    const rows = await this.#query('/transaction/search', payload);
    if (rows.length > limit || rows.some(t => !t || typeof t !== 'object' || !validId(t._id) ||
        !selected.some(w => w._id === referenceId(t.account)) || typeof t.displayDate !== 'string' ||
        !validDate(t.displayDate.slice(0, 10)) || !Number.isFinite(Number(t.amount)) || t.amount == null)) reject('unexpected_data_shape');
    return {
      transactions: rows.map(t => {
        const wallet = selected.find(w => w._id === referenceId(t.account));
        return { id: t._id, date: t.displayDate.slice(0, 10), amount: t.amount,
          wallet: { id: wallet._id, name: wallet.name ?? null, currency: wallet.currency ?? null },
          note: typeof t.note === 'string' ? t.note : '',
          category: { id: referenceId(t.category) ?? null, name: t.category?.name ?? null } };
      }), limit, offset,
      // A full page may be the last page. Fetch once more to establish exhaustion.
      nextOffset: rows.length === limit ? offset + rows.length : null
    };
  }
  getWallets() { return this.#query('/wallet/list', {}); }
  async getCategories(walletId) {
    const categories = await this.#query('/category/list-all', {});
    return categories.filter(category => category?.account === walletId);
  }
  getTransactions(walletId, startDate, endDate) { return this.#query('/transaction/list', { walletId, startDate, endDate }); }
}
