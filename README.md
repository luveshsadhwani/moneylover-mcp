# Money Lover: remote read-only MCP on Docker

Node **22**, an official MCP SDK Streamable HTTP transport (stateless JSON), and
Cloudflare Tunnel + Access Managed OAuth. Money Lover API calls originate from
**the DigitalOcean droplet**, not from Workers. The API is unofficial.

Only `get_wallets`, `get_categories`, and `get_transactions` are registered. No
login/write tools, tokens, or credentials are exposed through MCP arguments.
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
the stale token and retries once. 403 challenges and other upstream errors do NOT
trigger repeated login. Failed login/repeated authentication rejection uses a
30-second cooldown. Other undocumented Money Lover error codes are not guessed.

**Restart semantics:** restarting loses the in-memory token. The first data call
logs in once, subsequent calls reuse it. No login happens during startup or health
checks. Persisting tokens across restarts is deliberately not part of this design.
Use one replica; restarts/deployments may count as devices. `limitDevice` behavior
remains unverified. Financial responses are never cached or logged.

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
initialization/list/call; three read tools only; invalid dates/ranges/arguments;
concurrent token reuse, expiry, bounded 401 recovery, challenge behavior and restart
semantics. No test contacts your Money Lover account or requires real credentials.
The pinned SDK negotiates its supported protocol versions (2025-11-25 and legacy);
live ChatGPT compatibility must be tested after hostname/auth configuration.

Pause updates: `sudo touch /opt/moneylover/PAUSED`.
Rollback: `sudo /opt/moneylover/update.sh --rollback` (also pauses updates).
Resume: `sudo rm /opt/moneylover/PAUSED`.
A failed digest is suppressed in `rejected.env`; remove it deliberately to retry.
Use container logs only for sanitized stage/reason/status errors, never raw request
headers or API bodies. Disable the old Worker route only after live acceptance.

The original `index.js`, `test.mjs`, and `wrangler.toml` remain as the legacy Worker
implementation for rollback/reference; they are excluded from the container.
The port implements only the owner's read-only bridge. Client protocol reference:
https://github.com/ferdhika31/moneylover-mcp (ISC); no upstream server code, login
tool, or transaction write tool is included.
