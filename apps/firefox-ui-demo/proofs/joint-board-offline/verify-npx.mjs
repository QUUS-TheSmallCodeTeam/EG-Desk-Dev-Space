// Narrow feasibility check, not an installer/gateway. Only the package authored in this file is executed.
// No npm registry, user npmrc/cache, external dependency, real token, public listener or shell command input.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-miniapp-proof-'));
const pkg = path.join(tmp, 'src'),
  home = path.join(tmp, 'home'),
  use = path.join(tmp, 'consume');
await Promise.all([pkg, home, use].map((p) => fs.mkdir(p, { mode: 0o700 })));
const view = randomBytes(32).toString('base64url'),
  edit = randomBytes(32).toString('base64url');
const base = {
  PATH: process.env.PATH,
  HOME: home,
  TMPDIR: tmp,
  npm_config_cache: path.join(tmp, 'cache'),
  npm_config_globalconfig: path.join(tmp, 'global-npmrc'),
  npm_config_userconfig: path.join(tmp, 'user-npmrc'),
  npm_config_offline: 'true',
  npm_config_registry: 'http://127.0.0.1:1/',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_update_notifier: 'false',
  npm_config_ignore_scripts: 'true',
  ...(process.platform === 'win32' ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
};
const name = 'egdesk-sh42-offline-proof';
await fs.writeFile(
  path.join(pkg, 'package.json'),
  JSON.stringify({ name, version: '1.0.0', type: 'module', bin: { [name]: 'app.mjs' }, files: ['app.mjs'] }),
);
await fs.writeFile(
  path.join(pkg, 'app.mjs'),
  `#!/usr/bin/env node
import http from 'node:http'; import {randomUUID} from 'node:crypto';
const instance=randomUUID();let picked=false;const server=http.createServer((req,res)=>{const bearer=req.headers.authorization;const canWrite=bearer==='Bearer '+process.env.QA_WRITE;const canRead=canWrite||bearer==='Bearer '+process.env.QA_READ;const send=(s,b)=>{res.writeHead(s,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(b));};if(!canRead)return send(401,{});if(req.url!=='/items/SH-42')return send(404,{});if(req.method==='POST'){if(!canWrite)return send(403,{});picked=true;}else if(req.method!=='GET')return send(405,{});send(200,{instance,item:'SH-42',picked});});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port})));const end=()=>{server.closeAllConnections();server.close(()=>process.exit(0));};process.stdin.resume();process.stdin.on('end',end);setTimeout(end,12000).unref();`,
  { mode: 0o700 },
);
let proc;
try {
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--offline', '--ignore-scripts', '--pack-destination', tmp], {
      cwd: pkg,
      env: base,
      encoding: 'utf8',
      timeout: 18000,
    }),
  )[0];
  assert.match(packed.integrity, /^sha512-/);
  const filename = path.join(tmp, packed.filename);
  proc = spawn('npx', ['--offline', '--yes', '--ignore-scripts', '--package=' + filename, '--', name], {
    cwd: use,
    env: { ...base, QA_READ: view, QA_WRITE: edit },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: proc.stdout });
  let errorText = '';
  proc.stderr.on('data', (s) => {
    errorText += String(s).slice(0, 1000);
  });
  const finished = once(proc, 'close');
  const line = await Promise.race([
    once(lines, 'line').then(([l]) => l),
    finished.then(() => {
      throw Error('npx did not start the fixture: ' + errorText);
    }),
  ]);
  const { port } = JSON.parse(line);
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  const endpoint = `http://127.0.0.1:${port}/items/SH-42`;
  const read = (key, method = 'GET') =>
    fetch(endpoint, {
      method,
      headers: key ? { Authorization: 'Bearer ' + key } : {},
      redirect: 'error',
      credentials: 'omit',
      signal: AbortSignal.timeout(3000),
    });
  assert.equal((await read(null)).status, 401);
  const before = await (await read(view)).json();
  assert.equal(before.picked, false);
  assert.equal((await read(view, 'POST')).status, 403);
  assert.equal((await (await read(edit)).json()).picked, false);
  const changed = await (await read(edit, 'POST')).json();
  const after = await (await read(view)).json();
  assert.deepEqual(changed, after);
  assert.equal(after.picked, true);
  assert.equal(before.instance, after.instance);
  proc.stdin.end();
  const [exit] = await finished;
  assert.equal(exit, 0);
  console.log(
    JSON.stringify({
      runner: 'npx --offline',
      package: name + '@1.0.0',
      integrity: packed.integrity,
      syntheticClients: 2,
      instances: 1,
      readerWriteStatus: 403,
      unauthenticatedStatus: 401,
      sharedUpdate: true,
      registryUsed: false,
      productInstaller: false,
    }),
  );
} finally {
  if (proc && proc.exitCode === null) proc.stdin.end();
  await fs.rm(tmp, { recursive: true, force: true });
}
