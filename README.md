# Money Lover — read-only Cloudflare MCP bridge

Initial security-focused adaptation inspired by https://github.com/ferdhika31/moneylover-mcp (ISC license).

## Security boundary
- Only `get_wallets`, `get_categories`, `get_transactions` MCP tools are exposed.
- Does NOT expose `login`, write transactions, or tokens.
- Credentials are held in Cloudflare Worker secrets, not D1, code or MCP arguments.
- Bearer authorization is required on *every* request; there is no anonymous discovery endpoint.
- Date queries limited to 93 days, with no caching or logging of financial responses in application code.
- The Money Lover endpoints are **unofficial**; live compatibility and compliance with provider policies are unverified.
- The protocol implements stateless JSON responses for MCP Streamable HTTP; it has not passed a ChatGPT compatibility test. ChatGPT's custom connectors may require OAuth rather than a static bearer credential.

## Provision secrets privately
Run in this directory from a machine where you have Wrangler authenticated:

```sh
npx wrangler secret put MONEYLOVER_EMAIL
npx wrangler secret put MONEYLOVER_PASSWORD
npx wrangler secret put MCP_ACCESS_TOKEN
```

Generate a random 32+ byte token with a secure password manager; do **not** place secrets in GitHub, this chat or plain text config. Deploy with `npx wrangler deploy`.

## Local JSON-RPC smoke test (no real credentials)
Use Cloudflare's dashboard to verify the Worker is deployed, then confirm `/mcp` returns `503` until secrets are configured. Do not expose the MCP access token in a copied public terminal log. Once provisioned, authenticate with a Bearer token and post a JSON-RPC `tools/list` request.

## Next steps
1. Test wallet listing with real credentials and confirm response shape; fix any upstream drift.
2. Add real OAuth 2.1 authorization for ChatGPT remote connector compatibility, including per-user consent and scoped credentials.
3. Consider least-privilege provider-issued access tokens if Money Lover offers them; until then, treat account credentials as high sensitivity.
4. Add rate limiting, alerting, and an independent CSV-export backup process.
