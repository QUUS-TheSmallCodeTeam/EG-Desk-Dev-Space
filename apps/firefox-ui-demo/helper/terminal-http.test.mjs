import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { TerminalSessionRegistry } from './terminal-sessions.mjs'
import { createTerminalHttpHandler } from './terminal-http.mjs'

function harness({ createError = null } = {}) {
  const calls = []
  const registry = {
    authorizeLocal: () => null,
    snapshot: id => ({ ok: true, sessionId: id, status: 'RUNNING', transport: 'conpty',
      usePty: true, degraded: false, shellId: 'powershell', cols: 80, rows: 24 }),
    read: id => ({ ok: false, code: 'UNKNOWN_SESSION', sessionId: id, status: 'UNKNOWN' }),
    write: (id, data) => { calls.push(['write', id, data]); return { ok: true } },
    resize: (id, cols, rows) => { calls.push(['resize', id, cols, rows]); return { ok: true, resized: true } },
    kill: id => { calls.push(['kill', id]); return { ok: true, exitConfirmed: false, status: 'STOP_REQUESTED' } },
  }
  const factory = {
    catalog: () => ({ ok: true, platform: 'win32', defaultShellId: 'powershell',
      shells: [{ id: 'powershell', label: 'Windows PowerShell', available: true }, { id: 'cmd', label: 'CMD', available: true }],
      transport: 'conpty', ptyRequired: true }),
    create: async body => { calls.push(['create', body]); if (createError) throw createError; return { id: 'http-test' } },
  }
  const handle = createTerminalHttpHandler({ registry, factory, port: () => 41001 })
  const request = async (route, body = {}, method = 'POST', headers = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    Object.assign(req, { url: route, method,
      headers: { host: '127.0.0.1:41001', 'content-type': 'application/json', ...headers } })
    let result
    const res = { setHeader() {}, writeHead(status) { this.status = status },
      end(text) { result = { status: this.status, body: JSON.parse(text) } } }
    const handled = await handle(req, res, new URL(route, 'http://127.0.0.1:41001'))
    return { handled, ...result }
  }
  return { request, calls }
}

test('production terminal HTTP exposes typed catalog and ConPTY session metadata on an injected port', async () => {
  const h = harness()
  assert.equal((await h.request('/terminal/shells', {}, 'GET')).body.defaultShellId, 'powershell')
  const created = await h.request('/terminal/spawn', { shellId: 'cmd', cols: 100, rows: 30 })
  assert.equal(created.status, 200)
  assert.equal(created.body.transport, 'conpty')
  assert.deepEqual(h.calls[0], ['create', { shellId: 'cmd', cols: 100, rows: 30 }])
  const input = await h.request('/terminal/write', { sessionId: 'http-test', data: '\u0003한글' })
  assert.equal(input.status, 200)
  assert.deepEqual(h.calls[1], ['write', 'http-test', '\u0003한글'])
  assert.equal((await h.request('/terminal/read', { sessionId: 'missing' })).status, 404)
  const killed = await h.request('/terminal/kill', { sessionId: 'http-test' })
  assert.equal(killed.body.exitConfirmed, false)
})

test('HTTP rejects cross-origin, unknown fields, malformed dimensions and nontext input before native spawn/write', async () => {
  const h = harness()
  assert.equal((await h.request('/terminal/spawn', {}, 'POST', { origin: 'https://untrusted.test' })).status, 403)
  assert.equal((await h.request('/terminal/spawn', {}, 'POST', { origin: 'null' })).status, 403)
  assert.equal((await h.request('/terminal/spawn', {}, 'POST', { host: 'untrusted.test:41001' })).status, 403)
  assert.equal((await h.request('/terminal/spawn', {}, 'POST', { 'sec-fetch-site': 'same-site' })).status, 403)
  assert.equal((await h.request('/terminal/spawn', { shellId: 'cmd', args: ['/C', 'unwanted'] })).status, 400)
  assert.equal((await h.request('/terminal/resize', { sessionId: 's', cols: 0, rows: 10 })).status, 400)
  assert.equal((await h.request('/terminal/write', { sessionId: 's', data: { arbitrary: true } })).status, 400)
  assert.equal((await h.request('/terminal/write', { sessionId: 's', data: 'x'.repeat(65536) })).status, 413)
  assert.equal(h.calls.length, 0)
  assert.equal((await h.request('/terminal/shells')).status, 405)
  assert.equal((await h.request('/not-a-terminal-route')).handled, false)
})

test('ConPTY failure is an explicit unavailable error rather than a false session', async () => {
  const h = harness({ createError: Object.assign(new Error('Windows ConPTY could not start'), {
    code: 'WINDOWS_PTY_UNAVAILABLE', httpStatus: 503, transport: 'unavailable', usePty: false, degraded: false,
  }) })
  const response = await h.request('/terminal/spawn', { shellId: 'powershell' })
  assert.equal(response.status, 503)
  assert.equal(response.body.code, 'WINDOWS_PTY_UNAVAILABLE')
  assert.equal(response.body.usePty, false)
  assert.ok(!response.body.sessionId)
})

test('local lifecycle HTTP scopes the original PTY data channel without opening sockets', async () => {
  const { randomUUID } = await import('node:crypto')
  const registry = new TerminalSessionRegistry()
  let spawns = 0, kills = 0, onOutput, onExit
  const writes = []
  const handler = createTerminalHttpHandler({ registry, port: 39218, factory: {
    catalog: () => ({}), create: async () => {
      spawns++
      return registry.register({ id: 'original-pty', shellId: 'default', usePty: true, cols: 80, rows: 24,
        process: { onData(fn) { onOutput = fn }, onExit(fn) { onExit = fn }, kill() { kills++ }, write(text) { writes.push(text) } } })
    },
  } })
  const owner = randomUUID(), other = randomUUID(), first = randomUUID(), second = randomUUID()
  const request = async (route, body, scope, view, extras = {}) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      url: `/terminal/${route}`, method: 'POST', socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:39218', 'content-type': 'application/json',
        ...(scope ? { 'x-egdesk-terminal-owner': scope, 'x-egdesk-terminal-view': view } : {}), ...extras.headers }, ...extras.request,
    })
    const res = { setHeader() {}, writeHead(status) { this.status = status }, end(text) { this.data = JSON.parse(text) } }
    assert.equal(await handler(req, res), true)
    return { status: res.status, ...res.data }
  }
  const spawned = await request('spawn', {}, owner, first)
  const ref = { sessionId: spawned.sessionId, bridgeInstance: spawned.bridgeInstance }
  const session = { sessionId: ref.sessionId }
  assert.equal(spawned.detachSupported, true)
  assert.ok(!JSON.stringify(spawned).includes(owner) && !JSON.stringify(spawned).includes(first))
  assert.equal((await request('detach', ref)).code, 'TERMINAL_SCOPE_REQUIRED')
  assert.equal((await request('detach', ref, owner, first, { headers: { origin: 'http://127.0.0.1:39218' } })).code, 'TERMINAL_SCOPE_REQUIRED')
  const held = await request('detach', ref, owner, first)
  assert.equal(held.ok, true); assert.equal(held.exitConfirmed, false)
  onOutput('synthetic output')
  assert.equal((await request('read', session, owner, first)).code, 'TERMINAL_NOT_ATTACHED')
  assert.equal((await request('attach', ref, other, second)).code, 'TERMINAL_IDENTITY_CHANGED')
  assert.equal((await request('attach', ref, owner, second, { request: { socket: { remoteAddress: '192.0.2.7' } } })).code, 'LOOPBACK_REQUIRED')
  assert.equal((await request('attach', ref, owner, second)).sessionId, ref.sessionId)
  assert.equal((await request('write', { ...session, data: 'stale input' }, owner, first)).code, 'TERMINAL_IDENTITY_CHANGED')
  assert.equal((await request('read', session, owner, second)).data, 'synthetic output')
  assert.deepEqual(writes, [])
  assert.equal((await request('write', { ...session, data: 'explicit input' }, owner, second)).ok, true)
  assert.deepEqual(writes, ['explicit input'])
  assert.equal(spawns, 1); assert.equal(kills, 0)
  assert.equal((await request('kill', session, owner, second)).exitConfirmed, false)
  onExit({ exitCode: 0 })
  assert.equal((await request('read', session, owner, second)).exitConfirmed, true)
  assert.equal(registry.active.size, 0)
})
