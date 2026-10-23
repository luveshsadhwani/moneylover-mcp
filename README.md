# Money Lover: remote MCP on Docker

Node **22**, an official MCP SDK Streamable HTTP transport (stateless JSON), and
Cloudflare Tunnel + Access Managed OAuth. Money Lover API calls originate from
**the DigitalOcean droplet**, not from Workers. The API is unofficial.

`get_expense_rules`, `get_wallets`, `get_categories`, `get_transactions`, `add_transaction`, and `edit_transaction` are registered.
Tokens and credentials stay server-side; no login tool is exposed.
Transactions require valid calendar dates with an end-minus-start limit of 93 days.

## Architecture and authorization

ChatGPT → HTTPS / Access Managed OAuth → Tunnel → Node → Money Lover.

Access handles OAuth; Node independently verifies the signature of
`Cf-Access-Jwt-Assertion` with the team's cached remote JWKS, RS256 algorithm,
issuer, audience, expiration and required identity claims. It also requires the
signed email to match `ACCESS_OWNER_EMAIL`. Raw identity headers are never trusted.
Missing configuration prevents startup. Invalid/missing authentication rejects
all `/mcp` methods with 401 before upstream calls. `/healthz` is a minimal internal
liveness endpoint with no account data or login side effects.

No host ports are published. The MCP runs as UID 1000, read-only filesystem, no
capabilities, no Docker socket, 256 MB limit. Tunnel has a separate UID and 128 MB
limit. MongoDB networks/volumes are not mounted. Both services use their own
bridge. `deploy/firewall.sh` adds scoped rules for `172.30.90.0/24`, blocking
private/metadata/host access while allowing external HTTPS and Tunnel port 7844.
It does not flush or alter MongoDB's existing rules. Review subnet overlap first.
This setup assumes Docker's **iptables backend**; do not run the firewall script
unchanged with Docker's native nftables backend. Reapply the firewall service after
Docker/firewall reconfiguration. Docker DNS forwards queries via its embedded resolver.

## Token lifecycle / device limit

There is one shared in-memory token and one in-flight login promise per process.
Concurrent calls share login. JWT `exp` or `expires_in` controls cache expiry; an
opaque token stays cached until an authentication rejection. The decoded JWT is
only a cache hint, never an authorization decision. HTTP/API code 401 invalidates
the stale token and retries reads once; writes are never retried. 403 challenges and other upstream errors do NOT
trigger repeated login. Failed login/repeated authentication rejection uses a
30-second cooldown. Other undocumented Money Lover error codes are not guessed.

**Restart semantics:** restarting loses the in-memory token. The first data call
logs in once, subsequent calls reuse it. No login happens during startup or health
checks. Persisting tokens across restarts is deliberately not part of this design.
Use one replica; restarts/deployments may count as devices. `limitDevice` behavior
remains unverified. Financial responses are never cached or logged.

## Expense recording preferences

Call `get_expense_rules` before using `add_transaction` or `edit_transaction`.
The read-only tool returns a Markdown guide from `src/expense-rules.js` with the owner's observed categorization, note style, and operational safeguards. It makes no Money Lover API calls. Tool descriptions request this ordering, but clients may skip it; this is guidance, not server-side enforcement. Existing transaction validations remain authoritative.

Because this repository is public, sensitive wallet/transaction identifiers, personal examples and cross-app audit document identifiers are excluded. Confirm wallet mappings using authenticated live tools or private context; do not infer them from the public guide.

## Adding transactions

`add_transaction` takes `walletId`, `categoryId`, a positive decimal **string**
`amount` (up to two decimal places), `date` (`YYYY-MM-DD`) and optional `note`.
The amount uses the wallet currency; category type determines income or expense.
Resolve the wallet and its category first. Call only for an entry the user has
explicitly asked to save; show the proposed details when they are inferred from
an email and get the user's approval before saving. Refresh the ChatGPT connector's
tool list after deployment to enable the new write tool.

Active wallet and income/expense category validity are checked before writing.
`get_categories` uses the `/category/list-all` catalog, whose consolidated IDs
are accepted by writes. The catalog repeats those IDs in separate rows per wallet;
results are filtered by `account === walletId` before name/ID resolution and
write validation. Exactly one matching row within that wallet is required.
Explicit `exclude_accounts`
entries are conservatively blocked. Only API-provided `categories` alias IDs are
recognized; names are never used to guess alias relationships. Unknown IDs fail
validation. Alias inputs are normalized to the consolidated ID before dispatch
and duplicate checks recognize both ID forms.
The service checks the same day's transactions for an exact category/amount/note/date
match and returns `already_exists` without another write. Writes are serialized
in the single process. Deliberately identical entries need distinct notes.
Writes use `/transaction/add` with a numeric JSON amount, `Accept: application/json`,
`dataformat: json`, and the default fields from the owner's successful browser/local
request. Tool amounts remain decimal strings for validation. Wallet/category IDs
are resolved before calling the tool and remain part of duplicate matching. Writes are never
automatically retried, even on authentication errors. An ambiguous upstream
failure returns `outcome_unknown_check_wallet_before_retry`; inspect the wallet
before proceeding. Only SHA-256 fingerprints of ambiguous requests are retained
in memory (maximum 1,000). They disappear on restart; the upstream duplicate check
still runs. This is best-effort duplicate prevention, not an upstream idempotency
guarantee: API consistency, multiple replicas or other clients can cause races.
There are no edit/delete/transfer tools. Real writes have not been smoke-tested;
all automated write tests use synthetic data and make no financial changes.

## CI/CD

`.github/workflows/container.yml` runs Node 22 tests and builds/tests a non-root
container. On successful `main` builds it publishes:

- `ghcr.io/luveshsadhwani/moneylover-mcp:latest`
- `ghcr.io/luveshsadhwani/moneylover-mcp:sha-<commit>`

GitHub uses its built-in `GITHUB_TOKEN` with `packages:write`. No droplet SSH key,
Money Lover secret, or Tunnel token is sent to GitHub. Pull requests test only.
Actions are serialized per ref so an older build cannot overtake a newer one.

After the one-time server setup, a systemd timer checks GHCR every five minutes.
`update.sh` pulls latest, resolves an **immutable digest**, skips unchanged/rejected
digests, starts the candidate, checks health and a real unauthenticated 401, then
promotes it. Failure restores the previous image. The Tunnel stays separate;
brief MCP downtime during replacement is expected on this small host.
Deployment checks do not log in to Money Lover or prove end-to-end OAuth access.
Container/config updates are separate: review/reinstall deployment scripts when
these files change; the timer only updates the MCP image. It never prunes images,
restarts Docker, or touches MongoDB. Watch disk usage (25 GB droplet).

New GHCR packages can be private even for a public repository. Either set this
package public in GitHub, or run `sudo docker login ghcr.io` on the droplet with a
read-only `read:packages` credential. Never put that token in Git.

## One-time setup on the existing droplet

Prerequisites: Docker Engine with Compose v2 supporting `up --wait`, systemd,
iptables backend, and an unused `172.30.90.0/24` subnet. This repository does not
install/upgrade Docker or change the host's existing ingress rules.

1. Choose the public hostname (still pending). Create a remotely managed Cloudflare
   Tunnel. Set its published application route to `http://mcp:3000` for that hostname.
2. **Before publishing it**, create a self-hosted Access application protecting all
   paths at that hostname. Allow only your own email. Enable Managed OAuth and DCR.
   Allow the ChatGPT callback URI; if creation needs a callback-specific wildcard,
   narrow it to the exact callback once the connector is created. Record the new
   application's AUD. Keep the old Worker intact until the new connector passes.
3. Clone the repo on the droplet and run:
   ```sh
   git clone https://github.com/luveshsadhwani/moneylover-mcp.git
   cd moneylover-mcp
   sudo bash deploy/install.sh
   sudoedit /opt/moneylover/service.env
   ```
   Fill `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ACCESS_OWNER_EMAIL`, `PUBLIC_ORIGIN`.
   Origin must be `https://hostname` without a slash. The current team domain is
   shown in the example, but the new app's AUD must be supplied separately.
4. Create the three secret files **privately on the droplet**. Use hidden prompts
   instead of putting values in command history:
   ```sh
   sudo bash -c 'umask 077; read -r -s -p "Money Lover email: " value; printf "%s" "$value" > /opt/moneylover/secrets/moneylover_email; echo'
   sudo bash -c 'umask 077; read -r -s -p "Money Lover password: " value; printf "%s" "$value" > /opt/moneylover/secrets/moneylover_password; echo'
   sudo bash -c 'umask 077; read -r -s -p "Tunnel token: " value; printf "%s" "$value" > /opt/moneylover/secrets/tunnel_token; echo'
   sudo chown 1000:1000 /opt/moneylover/secrets/moneylover_email /opt/moneylover/secrets/moneylover_password
   sudo chown 65532:65532 /opt/moneylover/secrets/tunnel_token
   sudo chmod 400 /opt/moneylover/secrets/*
   ```
   Docker mounts files under the service UIDs; their parent directory stays 700
   root-only. Environment variables are also supported for credentials, but the
   supplied Compose setup uses files. Do not configure both methods together.
5. Inspect `docker network inspect` and `ip route` for subnet overlaps. If needed,
   change the subnet consistently in compose.yaml and firewall.sh before installing.
   The DigitalOcean firewall needs no new inbound ports for this service; preserve
   existing SSH/MongoDB rules. Tunnel requires outbound 7844 TCP/UDP and HTTPS.
   ```sh
   sudo systemctl enable --now moneylover-firewall.service
   sudo /opt/moneylover/update.sh
   sudo systemctl enable --now moneylover-update.timer
   sudo systemctl status moneylover-update.timer
   ```
6. Add `https://<hostname>/mcp` in ChatGPT with OAuth and run `get_wallets`. Verify
   the expected 23 wallets yourself. Then test categories and a small transaction
   range. Successful local tests do not establish ChatGPT/live account compatibility.

## Acceptance and operations

```sh
npm ci
npm test
# On the droplet:
sudo docker compose --env-file /opt/moneylover/active.env -f /opt/moneylover/compose.yaml ps
sudo journalctl -u moneylover-update.service -n 30 --no-pager
```

Tests use signed fixture JWTs and mock Money Lover responses. They cover missing,
forged, expired, wrong-issuer/audience/owner Access JWTs; actual MCP SDK HTTP client
initialization/list/call; three read tools and one write tool; invalid dates/ranges/arguments;
concurrent token reuse, expiry, bounded 401 recovery, challenge behavior and restart
semantics. No test contacts your Money Lover account or requires real credentials.
The pinned SDK negotiates its supported protocol versions (2025-11-25 and legacy);
live ChatGPT compatibility must be tested after hostname/auth configuration.

Pause updates: `sudo touch /opt/moneylover/PAUSED`.
Rollback: `sudo /opt/moneylover/update.sh --rollback` (also pauses updates).
Resume: `sudo rm /opt/moneylover/PAUSED`.
A failed digest is suppressed in `rejected.env`; remove it deliberately to retry.
Network failures also log allowlisted `error_name`, `network_code` and numeric
`elapsed_ms` fields (including failures while reading the response body). Unknown
names/codes are suppressed; exception messages and stacks are never copied.
Integration write logging is enabled: `moneylover_write_requested` records the
validated candidate payload, `moneylover_write_stopped` records validation/retry
blocks, and `moneylover_write_dispatch` records the exact outgoing JSON payload
plus allowlisted non-authentication headers. Events share a `request_id`.
Skipped duplicates, confirmed writes, and failures also emit lifecycle events.
These logs include transaction notes, amounts, dates and wallet/category IDs.
Credentials, Authorization headers, tokens, read responses and write response
bodies are excluded. Inspect with `docker logs --tail 100 --follow moneylover-mcp-1`. Disable the old Worker route only after live acceptance.

The original `index.js`, `test.mjs`, and `wrangler.toml` remain as the legacy Worker
implementation for rollback/reference; they are excluded from the container.
Client protocol reference: https://github.com/ferdhika31/moneylover-mcp (ISC).
The remote server is independently implemented; no upstream server or login tool is included.

## Editing transactions

`edit_transaction` edits amount, category, date or note on one ordinary income or
expense. It does not move wallets or support linked transfers/debts, recurring
entries, multiple images or unrecognized metadata. Read the transaction first and
provide `walletId`, `transactionId`, `expected` (current `categoryId`, positive
string `amount`, `date`, and `note`) and a nonempty `changes` object containing only
the fields requested by the user. An empty note clears the note.

```json
{
  "walletId": "wallet-id",
  "transactionId": "transaction-id",
  "expected": { "categoryId": "category-id", "amount": "10.20", "date": "2026-10-19", "note": "Original" },
  "changes": { "note": "Corrected" }
}
```

The server scopes categories to the wallet, checks the current transaction against
`expected`, preserves the web app's receipt/contact/event/location/reminder/report
fields, and refuses a duplicate of another entry. Writes share the add queue.
It sends POST `/api/transaction/edit` with `_id`, then verifies the requested values
by reading the transaction on its resulting date. A matching entry is a no-op.
An uncertain result is never automatically retried and blocks further edits to
that transaction for this process lifetime. Inspect the wallet after an unknown
outcome; a restart clears this in-memory guard. The upstream API offers no known
conditional update, so a concurrent external edit between read and write cannot
be prevented. Checks cover the expected core fields, not a full version token.

Protocol source: Money Lover public web bundle
`/static/js/app.5b4b1d6ce89b2d6a7178.js` inspected 2026-10-21
(`AddTransactionDialog` payload and `Transactions.edit` action). The upstream
spelling `longtitude` is intentional. Local tests use synthetic fixtures only;
a live edit has not been tested. Payload logs contain financial details, but no
credentials, authorization headers, tokens or response bodies.

### Keyword transaction search

Use `search_transactions` for questions about a purchase or a transaction note,
instead of retrieving wallet histories:

```json
{"query":"chicken rice","limit":50,"offset":0}
```

`query` is required, nonblank, and at most 500 characters. Optional filters are
`walletId`, `categoryId`, `startDate`, and `endDate` (`YYYY-MM-DD`). Dates are
filters passed to Money Lover; no default date window or 93-day history
restriction is imposed. `categoryId` is an exact upstream category ID, not a name
or an automatic expansion across equivalent wallet categories.

Without `walletId`, one `/wallet/list` call supplies all nondeleted, nonarchived
wallet IDs to a single `POST /transaction/search`. No wallet histories or search
configuration data are retrieved. With `walletId`, it must occur in that same
owner-authorized list. Search uses the existing AuthJWT login/token cache and
Cloudflare Access owner authorization. It performs no financial writes and does
not cache or log search queries or results.

The upstream payload maps `query` to `note`, wallets to `accounts`, and category
to `categoryIDs`. Matching (including case, accents, word order and substring
behavior) is controlled by Money Lover; this is note search, not fuzzy semantic
search. `limit` defaults to 50 (1–100); `offset` defaults to 0 (0–1,000,000).
Results are under `search`, containing compact `transactions` (ID, date, amount,
wallet ID/name/currency, note, category ID/name), `limit`, `offset`, and
`nextOffset`. Amounts remain in each wallet's currency. Use `nextOffset` with the
same filters to continue. A full last page can require one final empty request;
`nextOffset: null` indicates exhaustion. Offset pagination can shift if records
change between requests. Upstream errors and unexpected shapes fail explicitly;
there is no history-scan fallback.

Contract evidence: Money Lover's public web app bundle
`app.5b4b1d6ce89b2d6a7178.js`, `SearchTransaction.vue` and transaction store actions,
inspected 2026-10-23; the reference client in
https://github.com/juansebashr/moneylover-mcp also exposes this endpoint.
These are unofficial API contracts, not a supported API guarantee. Mocked tests
cover payloads, multiple wallets, empty results, pagination, errors, validation,
and MCP authorization. **Authenticated account verification and end-to-end
latency measurement are still pending**: after deploying a test branch, call
`search_transactions` with the keyword from issue #2 and confirm the expected
record privately. Do not commit live financial responses or credentials.
