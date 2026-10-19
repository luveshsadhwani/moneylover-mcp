import { readFileSync } from 'node:fs';
import { createRemoteJWKSet, jwtVerify } from 'jose';
function secret(env, key) {
  if (env[key] && env[`${key}_FILE`]) throw new Error(`Use ${key} or ${key}_FILE, not both`);
  return env[`${key}_FILE`] ? readFileSync(env[`${key}_FILE`], 'utf8').replace(/\r?\n$/, '') : env[key];
}
export function loadConfig(env = process.env) {
  const config = {
    email: secret(env, 'MONEYLOVER_EMAIL'), password: secret(env, 'MONEYLOVER_PASSWORD'),
    issuer: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, owner: env.ACCESS_OWNER_EMAIL,
    publicOrigin: env.PUBLIC_ORIGIN, port: Number(env.PORT || 3000)
  };
  if (Object.values(config).some(value => !value)) throw new Error('Required configuration missing');
  const issuer = new URL(config.issuer);
  if (issuer.protocol !== 'https:' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname) || issuer.origin !== config.issuer) throw new Error('Invalid Access team origin');
  const origin = new URL(config.publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== config.publicOrigin) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a trailing slash');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid port');
  return config;
}
export function createVerifier(config, keySet) {
  const keys = keySet ?? createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 });
  return async token => {
    if (typeof token !== 'string' || token.length > 16384) throw new Error('Unauthorized');
    const { payload } = await jwtVerify(token, keys, { issuer: config.issuer, audience: config.audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'email'] });
    if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== config.owner.toLowerCase()) throw new Error('Unauthorized');
    return payload;
  };
}
