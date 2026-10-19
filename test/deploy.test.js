import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const digest = `ghcr.io/luveshsadhwani/moneylover-mcp@sha256:${'a'.repeat(64)}`;
const old = `MCP_IMAGE=ghcr.io/luveshsadhwani/moneylover-mcp@sha256:${'b'.repeat(64)}\n`;
function fixture(fail = false, previous = true) {
 const dir = mkdtempSync(join(tmpdir(), 'ml-deploy-')); mkdirSync(join(dir, 'bin'));
 const script = readFileSync(new URL('../deploy/update.sh', import.meta.url), 'utf8').replaceAll('/opt/moneylover', dir).replace('/run/lock/moneylover-update.lock', `${dir}/lock`);
 writeFileSync(join(dir, 'update.sh'), script);
 if(previous) writeFileSync(join(dir, 'active.env'), old);
 writeFileSync(join(dir, 'bin/docker'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${dir}/calls'\nif [ "$1" = image ]; then echo '${digest}'; exit 0; fi\nif [ "$1" = compose ] && [ "$6" = up ] && [ '${fail}' = true ] && grep -q '${'a'.repeat(64)}' '${dir}/active.env'; then exit 1; fi\nexit 0\n`, { mode: 0o700 });
 const run = (...args) => spawnSync('bash', [join(dir, 'update.sh'), ...args], { env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}` }, encoding: 'utf8' });
 return { dir, run, read: name => readFileSync(join(dir, name), 'utf8'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
test('deployment promotes immutable digest; unchanged release is not restarted', () => {
 const f = fixture(); try { assert.equal(f.run().status, 0); assert.equal(f.read('active.env'), `MCP_IMAGE=${digest}\n`); assert.equal(f.read('previous.env'), old); const before=f.read('calls').split('\n').filter(x=>x.includes(' up ')).length; assert.equal(f.run().status,0); assert.equal(f.read('calls').split('\n').filter(x=>x.includes(' up ')).length,before); } finally { f.cleanup(); }
});
test('failed deployment restores previous digest and suppresses repeated bad rollout', () => {
 const f=fixture(true); try { assert.equal(f.run().status,1); assert.equal(f.read('active.env'),old); assert.equal(f.read('rejected.env'),`MCP_IMAGE=${digest}\n`); assert.equal(f.run().status,0); } finally { f.cleanup(); }
});
test('failed first deployment stops candidate; manual rollback pauses automation', () => {
 const f=fixture(true,false); try { assert.equal(f.run().status,1); assert.equal(existsSync(join(f.dir,'active.env')),false); assert.match(f.read('calls'),/stop mcp/); } finally { f.cleanup(); }
 const g=fixture(); try { assert.equal(g.run().status,0); assert.equal(g.run('--rollback').status,0); assert.equal(g.read('active.env'),old); assert.equal(existsSync(join(g.dir,'PAUSED')),true); } finally { g.cleanup(); }
});
