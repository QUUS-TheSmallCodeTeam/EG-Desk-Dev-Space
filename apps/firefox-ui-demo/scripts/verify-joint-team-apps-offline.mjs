#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loadTeamApps } from '../helper/egdesk-joint-miniapp-runner.mjs';

const base = dirname(fileURLToPath(import.meta.url));
const pkg = join(base, '../miniapps/joint-first-party');
const bin = join(pkg, 'bin/egdesk-team-apps.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'egdesk-first-party-smoke-'));
const descriptor = join(scratch, 'data', 'runner.json');
const config = join(scratch, 'empty.npmrc');
const env = {
  PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, npm_config_cache: join(scratch, 'cache'),
  npm_config_userconfig: config, npm_config_globalconfig: join(scratch, 'empty-global.npmrc'),
  npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:1',
  npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
};
const opts = { cwd: scratch, env, encoding: 'utf8', timeout: 8000 };
const header = 'x-egdesk-signature';
const mac = (secret, ...parts) => createHmac('sha256', Buffer.from(secret, 'hex')).update(parts.join('\n')).digest('hex');
let proc, finished, mock, runnerPid;

function raw(origin, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${origin}${path}`, { agent: false, method: 'POST', signal: AbortSignal.timeout(3000),
      headers: { Host: new URL(origin).host, Origin: origin, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body), ...headers } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(body);
  });
}

try {
  writeFileSync(config, '', { mode: 0o600 });
  writeFileSync(env.npm_config_globalconfig, '', { mode: 0o600 });
  const packed = spawnSync('npm', ['pack', '--offline', '--ignore-scripts', '--json',
    '--pack-destination', scratch], { ...opts, cwd: pkg });
  assert.equal(packed.status, 0, packed.stderr || String(packed.error));
  const [artifact] = JSON.parse(packed.stdout);
  assert.deepEqual(artifact.files.map(item => item.path).sort(), ['bin/egdesk-team-apps.mjs', 'package.json']);
  const tarball = join(scratch, artifact.filename);
  const pin=JSON.parse(readFileSync(join(base,'../miniapps/joint-first-party-release.json')));
  assert.equal(artifact.name,pin.name); assert.equal(artifact.version,pin.version); assert.equal(createHash('sha256').update(readFileSync(tarball)).digest('hex'),pin.sha256,'pack mismatch; refuse to launch');
  proc = spawn('npx', ['--offline', '--yes', '--ignore-scripts', '--package', tarball, '--', 'egdesk-team-apps', descriptor],
    { ...opts, detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  let out='';proc.stdout.on('data', b=>{out+=b;if(out.includes('\n')&&!runnerPid){const ready=JSON.parse(out.trim());if(ready.ready===true&&Number.isSafeInteger(ready.pid)&&ready.pid>1)runnerPid=ready.pid;}});
  finished = once(proc, 'exit');
  await Promise.race([finished.then(result => { throw Error(`npx exited early: ${result}`); }), (async () => {
    for (let i = 0; i < 200; i++) {
      if (existsSync(descriptor)&&runnerPid) return;
      await wait(25);
    }
    throw Error('Timed out waiting for descriptor');
  })()]);

  assert.equal(statSync(dirname(descriptor)).mode & 0o7777, 0o700);
  assert.equal(statSync(descriptor).mode & 0o7777, 0o600);
  assert.equal(statSync(descriptor).uid, process.getuid());
  const { origin, secret } = JSON.parse(readFileSync(descriptor, 'utf8'));
  assert.match(origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
  assert.match(secret, /^[a-f0-9]{64}$/);
  const adapter = loadTeamApps(descriptor);
  assert.deepEqual(adapter.catalog, ['shipment', 'inspection']);
  assert.equal(await adapter.verify(), true);
  const legal = new Set(['shipment:ready:picked', 'shipment:picked:delivered',
    'inspection:waiting:pass', 'inspection:waiting:hold', 'inspection:hold:pass']);
  const states = { shipment: ['ready', 'picked', 'delivered'], inspection: ['waiting', 'pass', 'hold'] };
  // Iterating without keeping per-job state also checks that independent transitions commute.
  for (const [type, domain] of Object.entries(states)) {
    for (const from of domain) {
      for (const to of domain) {
        if (legal.has(`${type}:${from}:${to}`)) {
          assert.deepEqual(await adapter.step({ type, from, to }), { type, state: to });
        } else {
          await assert.rejects(adapter.step({ type, from, to }), /HTTP 422/);
        }
      }
    }
  }
  const valid = { type: 'shipment', from: 'ready', to: 'picked' };
  const body = JSON.stringify(valid);
  assert.deepEqual(await adapter.step(valid), { type: 'shipment', state: 'picked' });
  await assert.rejects(adapter.step({ ...valid, id: 'not-permitted' }), /step fields/);
  await assert.rejects(adapter.step(valid, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(adapter.step({ ...valid, type: 'arbitrary' }), /step values/);
  await assert.rejects(adapter.step({ ...valid, to: 'pass' }), /step values/);
  const sign = (value) => ({ [header]: mac(secret, 'egdesk-request-v1', 'POST', '/v1/step', origin, value) });
  assert.equal(await raw(origin, '/v1/step', body), 401);
  assert.equal(await raw(origin, '/v1/step', body, { [header]: '0'.repeat(64) }), 401);
  assert.equal(await raw(origin, '/v1/step', body, { ...sign(body), Origin: 'http://localhost' }), 403);
  assert.equal(await raw(origin, '/v1/step', body, { ...sign(body), Host: 'localhost' }), 403);
  assert.equal(await raw(origin, '/v1/step', body, { ...sign(body), Cookie: 'unwanted=1' }), 400);
  assert.equal(await raw(origin, '/v1/step', body, { ...sign(body), 'Content-Type': 'text/plain' }), 400);
  assert.equal(await raw(origin, '/v1/step?x=1', body, sign(body)), 404);
  for (const bad of [JSON.stringify({ ...valid, id: 'extra' }), '{"type":"shipment",'+body.slice(1), '{}', 'null']) {
    assert.equal(await raw(origin, '/v1/step', bad, sign(bad)), 400);
  }
  const unknown = JSON.stringify({ ...valid, from: 'unknown' });
  assert.equal(await raw(origin, '/v1/step', unknown, sign(unknown)), 422);
  const arbitrary = JSON.stringify({ ...valid, type: 'arbitrary' });
  assert.equal(await raw(origin, '/v1/step', arbitrary, sign(arbitrary)), 422);
  const large = 'x'.repeat(257);
  assert.equal(await raw(origin, '/v1/step', large, sign(large)), 413);
  assert.equal(await raw(origin, '/v1/step', body, sign(body)), 200);

  const existing = spawnSync(process.execPath, [bin, descriptor], opts);
  assert.equal(existing.status, 1);
  assert.match(existing.stderr, /already exists/);
  assert.equal(await adapter.verify(), true);
  chmodSync(descriptor, 0o640);
  assert.throws(() => loadTeamApps(descriptor), /0600/);
  chmodSync(descriptor, 0o600);
  const alias = join(dirname(descriptor), 'symlink');
  symlinkSync(descriptor, alias);
  assert.throws(() => loadTeamApps(alias));
  const unsafe = join(scratch, 'unsafe');
  mkdirSync(unsafe, { mode: 0o755 });
  chmodSync(unsafe, 0o755);
  const unsafeFile = join(unsafe, 'runner.json');
  assert.equal(spawnSync(process.execPath, [bin, unsafeFile], opts).status, 1);
  assert.throws(() => loadTeamApps(unsafeFile), /0700/);
  assert.equal(existsSync(unsafeFile), false);

  process.kill(runnerPid, 'SIGTERM');
  await finished;runnerPid=null;
  for (let i = 0; i < 100 && existsSync(descriptor); i++) await wait(20);
  assert.equal(existsSync(descriptor), false);
  await assert.rejects(adapter.verify());
  proc = undefined;

  // Controlled loopback peer: do not follow redirects, accept cookies or trust a malformed response.
  const mockSecret = randomBytes(32).toString('hex');
  let mode, requests = 0;
  mock = createServer((req, res) => {
    requests++;
    if (mode === 'timeout') return;
    if (mode === 'redirect') return res.writeHead(302, { Location: '/redirect-target' }).end();
    const body = JSON.stringify({ catalog: ['shipment', 'inspection'] });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.setHeader(header, mode === 'signature' ? '0'.repeat(64) : mac(mockSecret, 'egdesk-response-v1', req.headers[header], body));
    if (mode === 'cookie') res.setHeader('Set-Cookie', 'no=1');
    res.end(mode === 'body' ? body.replace('shipment', 'otherxxx') : body);
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  writeFileSync(descriptor, JSON.stringify({ origin: `http://127.0.0.1:${mock.address().port}`, secret: mockSecret }), { mode: 0o600 });
  const mockAdapter = loadTeamApps(descriptor);
  assert.equal(await mockAdapter.verify(), true);
  for (mode of ['redirect', 'signature', 'cookie', 'body', 'timeout']) {
    const before = requests;
    await assert.rejects(mockAdapter.verify(), mode === 'timeout' ? { name: 'AbortError' } : /HTTP 302|Invalid runner response/);
    assert.equal(requests, before + 1);
  }
  console.log('PASS: offline pack+npx, transitions, authentication, private descriptor, shutdown, and checked adapter');
} finally {
  if(runnerPid)try{process.kill(runnerPid,'SIGTERM');}catch{}
  if (proc?.pid) {
    try { process.kill(-proc.pid, 'SIGTERM'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
    await finished.catch(() => {});
  }
  if (mock) { mock.close(); mock.closeAllConnections(); }
  rmSync(scratch, { recursive: true, force: true });
}
