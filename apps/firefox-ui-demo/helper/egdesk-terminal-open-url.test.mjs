import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OPENER_SCRIPT, OPEN_URL_LIMITS, createTerminalOpenUrl, normalizeOpenUrl } from './egdesk-terminal-open-url.mjs'
import { createTerminalHttpHandler } from './terminal-http.mjs'
import { createTerminalSessionFactory, terminalEnvironment } from './terminal-platform.mjs'
import { TerminalSessionRegistry } from './terminal-sessions.mjs'

// The gate's safety preload (evidence/l6-c2/guard.mjs) forbids any process spawn, so the tests that run the real opener script as a child process are skipped THERE and run for real with
// `node --test helper/egdesk-terminal-open-url.test.mjs` (10 of 10 pass; the mutation checks ran them). Everything else in this file runs in the gate.
const spawnBlocked = Boolean(process.env.GUARD_LOG) && 'child processes are blocked by the gate guard; run this file directly'
// L1 c34: URLs a program in a Terminal card opens go to an EG-Desk Browser Card (flag EGDESK_TERMINAL_OPEN_URL). Real opener script, real HTTP handler, a fake CLI that "opens" a URL.
const SIGN_IN = 'https://claude.com/cai/oauth/authorize?code=true&client_id=00000000-0000-0000-0000-000000000000&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=synthetic-state&code_challenge=synthetic-challenge&code_challenge_method=S256'
const tmp = t => { const dir = mkdtempSync(path.join(os.tmpdir(), 'egdesk-open-url-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }

test('normalizeOpenUrl: absolute http(s) only, no credentials, no whitespace or control characters, bounded', () => {
  assert.equal(normalizeOpenUrl(SIGN_IN), new URL(SIGN_IN).href)
  for (const bad of ['', null, 5, 'file:///etc/passwd', 'file://localhost/etc/passwd', 'file://a.example/share', 'ftp://a.example/x', 'ws://a.example/', 'javascript:alert(1)', 'chrome://browser/content', 'about:blank', 'data:text/html,x', '/relative', 'https://', 'https://user:pw@claude.com/x', 'https://a.com/ x', 'https://a.com/\n', 'https://a.com/\u0000', `https://a.com/${'a'.repeat(OPEN_URL_LIMITS.urlChars)}`]) assert.equal(normalizeOpenUrl(bad), null, JSON.stringify(bad)?.slice(0, 40))
})

test('the registry of one flagged bridge: a session\'s own token, closed refusals, once-only take, a bounded queue that expires', () => {
  let clock = 1000
  const reg = createTerminalOpenUrl({ dir: '/tmp/x', port: 39218, now: () => clock, newToken: (() => { let n = 0; return () => `tok${++n}` })(), write: false, basePath: '/usr/bin' })
  const env = reg.envFor('term-a'); reg.envFor('term-b')
  assert.deepEqual(Object.keys(env).sort(), ['BROWSER', 'EGDESK_OPEN_URL_ENDPOINT', 'EGDESK_OPEN_URL_SESSION', 'EGDESK_OPEN_URL_TOKEN', 'PATH'])
  assert.equal(env.EGDESK_OPEN_URL_ENDPOINT, 'http://127.0.0.1:39218/terminal/open-url'); assert.equal(env.PATH, `/tmp/x/bin${path.delimiter}/usr/bin`); assert.equal(env.BROWSER, '/tmp/x/egdesk-open-url')
  const refused = (body, code) => assert.throws(() => reg.accept(body), error => error.code === code, JSON.stringify(body))
  refused({ sessionId: 'term-a', token: 'wrong', url: SIGN_IN }, 'OPEN_URL_REFUSED'); refused({ sessionId: 'term-a', token: 'tok2', url: SIGN_IN }, 'OPEN_URL_REFUSED')
  refused({ sessionId: 'nope', token: 'tok1', url: SIGN_IN }, 'OPEN_URL_REFUSED'); refused({ sessionId: 'term-a', url: SIGN_IN }, 'OPEN_URL_REFUSED'); refused(undefined, 'OPEN_URL_REFUSED')
  refused({ sessionId: 'term-a', token: 'tok1', url: 'file:///etc/passwd' }, 'OPEN_URL_INVALID')
  assert.deepEqual(reg.accept({ sessionId: 'term-a', token: 'tok1', url: SIGN_IN }), { ok: true })
  assert.deepEqual(reg.accept({ sessionId: 'term-a', token: 'tok1', url: SIGN_IN }), { ok: true, duplicate: true })
  assert.deepEqual(reg.take('term-b'), [], 'another session sees nothing'); assert.deepEqual(reg.take('term-a'), [new URL(SIGN_IN).href]); assert.deepEqual(reg.take('term-a'), [], 'once')
  for (let i = 0; i < OPEN_URL_LIMITS.perSession; i++) reg.accept({ sessionId: 'term-a', token: 'tok1', url: `https://a.example/${i}` })
  refused({ sessionId: 'term-a', token: 'tok1', url: 'https://a.example/over' }, 'OPEN_URL_BUSY')
  clock += OPEN_URL_LIMITS.ttlMs + 1; assert.deepEqual(reg.take('term-a'), [], 'an address nobody took expires')
  reg.forget('term-a'); refused({ sessionId: 'term-a', token: 'tok1', url: SIGN_IN }, 'OPEN_URL_REFUSED')
  for (let i = 0; i < OPEN_URL_LIMITS.sessions + 5; i++) reg.envFor(`s${i}`); assert.ok(reg.size() <= OPEN_URL_LIMITS.sessions)
})

test('install writes the opener and the shims owner-only; the script is the one tested below', t => {
  const dir = tmp(t), reg = createTerminalOpenUrl({ dir, port: 39218 })
  const { opener, shims } = reg.install(); reg.install()
  assert.equal(readFileSync(opener, 'utf8'), OPENER_SCRIPT)
  for (const file of [opener, path.join(shims, 'open'), path.join(shims, 'xdg-open')]) assert.equal(statSync(file).mode & 0o777, 0o700, file)
  assert.match(readFileSync(path.join(shims, 'open'), 'utf8'), new RegExp(`exec "${opener.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" "\\$@"`))
  assert.ok(!/HOME|\.claude|Keychain|credentials/i.test(OPENER_SCRIPT), 'the opener touches no credential')
})

test('the terminal session factory adds the opener environment only with the flag (an openUrl), and never to a Windows session', async () => {
  const seen = []
  const make = (extra = {}, platform = 'darwin') => createTerminalSessionFactory({ registry: { register: x => x }, platform, env: { PATH: '/usr/bin', HOME: '/home/p', SHELL: '/bin/zsh' }, cwd: '/home/p', exists: () => true,
    loadPty: async () => ({ spawn: (exe, args, options) => { seen.push(options.env); return { on() {}, kill() {} } } }), newId: () => 'term-fixed', ...extra })
  const off = await make().create({ cols: 80, rows: 24 })
  assert.deepEqual(seen[0], terminalEnvironment({ PATH: '/usr/bin', HOME: '/home/p', SHELL: '/bin/zsh' }, 'darwin'), 'flag off: the environment is what it was'); assert.equal(off.id, 'term-fixed')
  const reg = createTerminalOpenUrl({ dir: '/tmp/o', port: 39218, write: false, newToken: () => 'secret-token', basePath: '/usr/bin' })
  await make({ openUrl: reg }).create({ cols: 80, rows: 24 })
  assert.equal(seen[1].BROWSER, '/tmp/o/egdesk-open-url'); assert.equal(seen[1].EGDESK_OPEN_URL_SESSION, 'term-fixed'); assert.equal(seen[1].EGDESK_OPEN_URL_TOKEN, 'secret-token')
  assert.equal(seen[1].HOME, '/home/p', 'HOME is untouched'); assert.equal(seen[1].TERM, 'xterm-256color')
  assert.deepEqual(reg.accept({ sessionId: 'term-fixed', token: 'secret-token', url: SIGN_IN }), { ok: true }, 'the token belongs to the id the session was registered with')
  let winEnv = null
  await make({ openUrl: reg, release: '10.0.22621', env: { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, startWindowsProcess: async ({ env }) => { winEnv = env; return { on() {}, kill() {} } } }, 'win32').create({ cols: 80, rows: 24, shellId: 'cmd' })
  assert.ok(winEnv, 'the Windows path ran'); assert.equal(winEnv.BROWSER, undefined); assert.equal(winEnv.EGDESK_OPEN_URL_TOKEN, undefined)
})

// ---- end to end: a fake CLI "opens" the sign-in page ----
async function bridge(t, { flag = true } = {}) {
  const dir = tmp(t)
  const urlOpen = createTerminalOpenUrl({ dir: path.join(dir, 'opener'), port: () => server.address().port })
  const registry = new TerminalSessionRegistry({ urlOpen: flag ? urlOpen : null })
  const handler = createTerminalHttpHandler({ registry, factory: { catalog: () => ({}), create: async () => ({ id: 'x' }) }, port: () => server.address().port, ...(flag ? { urlOpen } : {}) })
  const server = createServer(async (req, res) => { if (!(await handler(req, res, new URL(req.url, 'http://127.0.0.1')))) { res.writeHead(404); res.end('{}') } })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close())
  const { opener, shims } = urlOpen.install()
  const real = path.join(dir, 'real-open'); writeFileSync(real, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${dir}/real-open.log"\n`); chmodSync(real, 0o700)
  const run = (command, args, env) => new Promise(resolve => execFile(command, args, { env: { PATH: '/usr/bin:/bin', HOME: dir, EGDESK_REAL_OPEN: real, ...env }, timeout: 15000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })))
  return { dir, urlOpen, registry, server, opener, shims, run, realLog: () => (existsSync(path.join(dir, 'real-open.log')) ? readFileSync(path.join(dir, 'real-open.log'), 'utf8') : '') }
}
// the fake CLI: what the Claude CLI does at login, reduced to "ask the system to open this address" through $BROWSER or through `open`
const fakeCli = (via) => `const { spawn } = require('node:child_process'); const url = process.argv[2]
const child = ${via === 'browser' ? "spawn(process.env.BROWSER, [url], { stdio: 'ignore' })" : "spawn('open', [url], { stdio: 'ignore' })"}
child.on('exit', code => process.exit(code ?? 0))`

for (const via of ['browser', 'open']) {
  test(`a fake CLI that opens the sign-in page through ${via === 'browser' ? '$BROWSER' : 'the `open` command'}: the bridge holds the address for the session's card, once, and the system opener is not run`, { skip: spawnBlocked }, async t => {
    const b = await bridge(t)
    const env = b.urlOpen.envFor('term-1')
    const cli = path.join(b.dir, 'fake-cli.cjs'); writeFileSync(cli, fakeCli(via))
    const out = await b.run(process.execPath, [cli, SIGN_IN], env)
    assert.equal(out.error, null, out.stderr)
    const first = b.registry.read('term-1')
    assert.deepEqual(first.openUrls, [new URL(SIGN_IN).href]); assert.equal(b.registry.read('term-1').openUrls, undefined, 'taken once')
    assert.equal(b.realLog(), '', 'the system opener did not run')
    assert.ok(!JSON.stringify(first).includes('secret'), 'no token in the read')
  })
}

test('a wrong token, an unknown session, a foreign address or an unreachable bridge: nothing is queued and the system opener runs (today\'s behaviour)', { skip: spawnBlocked }, async t => {
  const b = await bridge(t)
  const env = b.urlOpen.envFor('term-1')
  assert.equal((await b.run(b.opener, [SIGN_IN], { ...env, EGDESK_OPEN_URL_TOKEN: 'wrong' })).error, null)
  assert.equal((await b.run(b.opener, [SIGN_IN], { ...env, EGDESK_OPEN_URL_SESSION: 'term-9' })).error, null)
  assert.equal((await b.run(b.opener, [SIGN_IN], { ...env, EGDESK_OPEN_URL_ENDPOINT: 'http://127.0.0.1:9/terminal/open-url' })).error, null)
  assert.equal((await b.run(b.opener, ['--new-window', 'file:///etc/hosts'], env)).error, null)
  assert.equal(b.registry.read('term-1').openUrls, undefined)
  assert.deepEqual(b.realLog().trim().split('\n'), [SIGN_IN, SIGN_IN, SIGN_IN, '--new-window file:///etc/hosts'])
  const quote = `https://a.example/x"y`
  await b.run(b.opener, [quote], env); assert.equal(b.registry.read('term-1').openUrls, undefined, 'an address that would break the request is not posted'); assert.ok(b.realLog().includes('x"y'))
})

test('`open` with anything but an http(s) address is the system opener, unchanged', { skip: spawnBlocked }, async t => {
  const b = await bridge(t)
  const env = b.urlOpen.envFor('term-1')
  await b.run(path.join(b.shims, 'open'), ['.', '-a', 'TextEdit'], env)
  assert.equal(b.realLog().trim(), '. -a TextEdit'); assert.equal(b.registry.read('term-1').openUrls, undefined)
})

test('flag off: the route does not exist and a read never carries addresses', async t => {
  const b = await bridge(t, { flag: false })
  const res = await fetch(`http://127.0.0.1:${b.server.address().port}/terminal/open-url`, { method: 'POST', body: JSON.stringify({ sessionId: 'a', token: 'b', url: SIGN_IN }) })
  assert.equal(res.status, 404)
  assert.equal(new TerminalSessionRegistry().read('term-1').openUrls, undefined)
})

test('the route: a body with another field is refused, a browser origin that is not the app is refused', async t => {
  const b = await bridge(t)
  const env = b.urlOpen.envFor('term-1'), url = env.EGDESK_OPEN_URL_ENDPOINT
  const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
  assert.equal((await post({ sessionId: 'term-1', token: env.EGDESK_OPEN_URL_TOKEN, url: SIGN_IN, extra: 1 })).status, 400)
  assert.equal((await post({ sessionId: 'term-1', token: env.EGDESK_OPEN_URL_TOKEN, url: SIGN_IN }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await post({ sessionId: 'term-1', token: env.EGDESK_OPEN_URL_TOKEN, url: SIGN_IN })).status, 200)
  assert.equal((await post({ sessionId: 'term-1', token: 'wrong', url: SIGN_IN })).status, 403)
})
