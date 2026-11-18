import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { createCodexProfileAppServers } from './codex-profile-app-servers.mjs'

function fixture() {
  const homes = new Map([['codex-11111111', { home: '/private/one', identity: 'one' }], ['codex-22222222', { home: '/private/two', identity: 'two' }]])
  const accounts = new Map([['/private/one', 'one@example.org'], ['/private/two', null]])
  const children = [], events = [], shared = []
  let adapter
  const env = { PATH: '/system/bin', HOME: '/user', CODEX_HOME: '/default', OPENAI_API_KEY: 'fake', CODEX_ACCESS_TOKEN: 'fake', CODEX_API_KEY: 'fake', OPENAI_BASE_URL: 'fake', OTHER_TOKEN: 'fake' }
  const pool = createCodexProfileAppServers({ env, cwd: '/workspace', executable: () => '/synthetic/codex',
    resolveHome: id => { if (!homes.has(id)) throw Object.assign(new Error('No slot'), { code: 'NOT_FOUND' }); return homes.get(id) },
    spawnChild(executable, args, options) {
      const child = new EventEmitter(), home = options.env.CODEX_HOME
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), sent: [], kills: [], executable, args, options })
      child.emitRpc = message => child.stdout.write(`${JSON.stringify(message)}\n`)
      child.stdin = new Writable({ write(data, _, done) {
        const message = JSON.parse(data.toString())
        child.sent.push(message)
        if (message.method && message.id) queueMicrotask(() => {
          const email = accounts.get(home)
          const result = message.method === 'account/read' ? { account: email ? { type: 'chatgpt', email, planType: 'plus' } : null }
            : message.method === 'model/list' ? { data: [{ id: home.split('/').pop(), model: home.split('/').pop(), displayName: email }], nextCursor: null }
            : message.method === 'thread/start' ? { thread: { id: home } } : {}
          child.emitRpc({ id: message.id, result })
        })
        done()
      } })
      child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit('close')); return true }
      children.push(child)
      return child
    },
    onNotification: (id, message) => adapter.notify(message, id),
    onServerRequest: (id, message) => adapter.serverRequest(message, id),
    onConnection: (id, state) => adapter.connection(state, id),
  })
  adapter = createCodexEngineAdapter({ profiles: pool, request: (...args) => { shared.push(args); return 'default' }, respond: (...args) => shared.push(args), getOwnerKey: () => 'shared-owner', getModels: () => [{ id: 'shared-model' }] })
  adapter.subscribe({ notification: (...args) => events.push(args), serverRequest: (...args) => events.push(args), connection: (...args) => events.push(args) })
  return { pool, adapter, homes, accounts, children, events, env, shared }
}

const A = 'codex-11111111', B = 'codex-22222222'

test('two owned stdio transports have exact auth/models, isolated environment, and correlated responses', async () => {
  const { pool, adapter, accounts, env, children, events, shared } = fixture()
  try {
    await Promise.all([adapter.ensureReady(A), assert.rejects(adapter.ensureReady(B), { code: 'ENGINE_LOGIN_REQUIRED' })])
    assert.equal(children.length, 2)
    assert.equal(adapter.isReady(A), true)
    assert.equal(adapter.isReady(B), false)
    assert.equal(adapter.ownerKey(A), 'email:one@example.org')
    assert.equal(adapter.ownerKey(B), null)
    assert.equal(adapter.ownerKey('codex-default'), 'shared-owner')
    assert.equal(adapter.models(A)[0].id, 'one')
    assert.equal(adapter.models(B), null)
    assert.equal(adapter.models('codex-default')[0].id, 'shared-model')
    assert.deepEqual(children.map(c => c.options.env), ['/private/one', '/private/two'].map(CODEX_HOME => ({ PATH: '/system/bin', HOME: '/user', CODEX_HOME })))
    assert.equal(env.CODEX_HOME, '/default')
    assert.equal(env.OPENAI_API_KEY, 'fake')
    for (const child of children) {
      assert.deepEqual(child.args, ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store=file'])
      assert.deepEqual(child.options.stdio, ['pipe', 'pipe', 'pipe'])
      assert.equal(child.options.shell, false)
      assert.equal(child.sent[2].method, 'account/read')
      assert.deepEqual(child.sent[2].params, { refreshToken: false })
    }
    accounts.set('/private/two', 'two@example.org')
    await adapter.refresh(B)
    assert.equal(children.length, 3)
    assert.deepEqual(children[1].kills, ['SIGTERM'])
    assert.equal(adapter.ownerKey(B), 'email:two@example.org')
    assert.equal(adapter.models(B)[0].id, 'two')
    assert.deepEqual(await adapter.startThread({ cwd: '/workspace' }, A), { thread: { id: '/private/one' } })
    assert.deepEqual(await adapter.startThread({ cwd: '/workspace' }, B), { thread: { id: '/private/two' } })
    assert.equal(adapter.startThread({}, 'codex-default'), 'default')
    for (const child of [children[0], children[2]]) child.emitRpc({ id: 77, method: 'approval', params: {} })
    const [a, b] = events.filter(([, state]) => state.method === 'approval')
    assert.equal(a[2], A)
    assert.equal(b[2], B)
    assert.notEqual(a[1].id, b[1].id)
    assert.throws(() => adapter.respond(a[1].id, {}, undefined, B), { code: 'ENGINE_PROFILE_MISMATCH' })
    assert.throws(() => adapter.respond(a[1].id, {}), { code: 'ENGINE_PROFILE_NOT_FOUND' })
    adapter.respond(a[1].id, { decision: 'allow' }, undefined, A)
    assert.deepEqual(children[0].sent.at(-1), { id: 77, result: { decision: 'allow' } })
    assert.equal(children[2].sent.at(-1).method, 'thread/start')
    assert.equal(shared.length, 1)
  } finally { await adapter.dispose() }
  assert.equal(pool.residentCount(), 0)
  assert.deepEqual(children.map(c => c.kills), [['SIGTERM'], ['SIGTERM'], ['SIGTERM']])
})

test('stale, missing, revoked, and replaced homes fail closed instead of selecting shared Codex', async () => {
  const { adapter, accounts, homes, events, children, shared } = fixture()
  try {
    await assert.rejects(adapter.ensureReady('missing'), { code: 'NOT_FOUND' })
    await adapter.ensureReady(A)
    const old = children[0]
    homes.set(A, { home: '/private/one', identity: 'replacement' })
    assert.equal(adapter.isReady(A), false)
    assert.throws(() => adapter.startThread({}, A), { code: 'ENGINE_PROFILE_HOME_UNAVAILABLE' })
    old.emitRpc({ method: 'thread/started', params: {} })
    assert.equal(events.some(([, event]) => event.method === 'thread/started'), false)
    assert.ok(events.some(([, event, id]) => event.processLost && id === A))
    await adapter.ensureReady(A)
    accounts.set('/private/one', 'different@example.org')
    await assert.rejects(adapter.ensureReady(A), { code: 'ENGINE_LOGIN_REQUIRED' })
    assert.equal(adapter.ownerKey(A), null)
    assert.throws(() => adapter.startThread({}, A), { code: 'ENGINE_UNAVAILABLE' })
    await adapter.ensureReady(A)
    homes.delete(A)
    assert.throws(() => adapter.startThread({}, A), { code: 'NOT_FOUND' })
    assert.equal(shared.length, 0)
  } finally { await adapter.dispose() }
})

test('send authentication prepares only the durable scoped slot and refuses a changed route', async () => {
  const { createChatEngineAuth } = await import('./codex-bridge-engine-auth.mjs')
  const { adapter, children, shared } = fixture()
  let selected = A, rewritten = null, legacyChecks = 0
  const chat = {
    requestEngineRoute: (_body, { verifyAccount, useAgent }) => ({ engineId: 'codex', engineProfileId: verifyAccount && rewritten ? rewritten : useAgent ? selected : A }),
    assertEngineContext: () => {},
    assertReady: () => { legacyChecks++ },
    engines: { get: () => adapter },
  }
  const ensure = createChatEngineAuth({ chat, refreshCodexAccount: async () => { legacyChecks++ }, getCodexAuth: () => null })
  try {
    await assert.rejects(ensure({}), { code: 'ENGINE_PROFILE_MISMATCH' })
    assert.equal(children.length, 0)
    assert.equal(await ensure({}, { useAgent: true }), 'codex')
    rewritten = B
    await assert.rejects(ensure({}, { useAgent: true }), { code: 'ENGINE_PROFILE_MISMATCH' })
    rewritten = null
    selected = B
    await assert.rejects(ensure({}, { useAgent: true }), { code: 'ENGINE_LOGIN_REQUIRED' })
    assert.equal(shared.length, 0)
    assert.equal(legacyChecks, 0)
  } finally { await adapter.dispose() }
})
