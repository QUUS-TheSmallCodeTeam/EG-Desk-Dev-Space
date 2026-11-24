// L1 c22: each Agent-profile app-server is probed on its OWN binary (dynamicTools, ephemeral, turn/steer, thread/delete), never inheriting the shared
// server's probe; thread/delete goes to the app-server that owns the thread and only when that binary has it. Also pinned: which pure-engine launch
// overrides a profile server gets next to the shared one. Mocks only: the child processes are fakes and the probe is injected.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { createCodexProfileAppServers } from './codex-profile-app-servers.mjs'
import { buildCodexAppServerLaunch, capabilitiesOf, createNativeCapabilityCache, resolveCodexExecutable } from './egdesk-native-capabilities.mjs'

const A = 'codex-11111111', B = 'codex-22222222'
const PROOF = 'a'.repeat(64)
// what inspectNativeCapabilities returns for a build: A's binary has everything, B's only dynamic tools
const BINARIES = { '/bin/codex-a': { executable: '/bin/codex-a', version: '0.162.1', schemaMatch: true, dynamicTools: true, boardPeerContract: PROOF, threadDelete: true },
  '/bin/codex-b': { executable: '/bin/codex-b', version: '0.150.0', schemaMatch: false, dynamicTools: false, boardPeerContract: null, threadDelete: false } }

function rig({ env = { PATH: '/system/bin', HOME: '/user' }, sharedDelete = false, inspectLog = [], probe = null, signedOut = [] } = {}) {
  const homes = new Map([[A, { home: '/private/one', identity: 'one' }], [B, { home: '/private/two', identity: 'two' }]])
  const children = [], shared = []
  const binaryOf = id => (id === A ? '/bin/codex-a' : '/bin/codex-b')
  const pool = createCodexProfileAppServers({ env, cwd: '/workspace', executable: id => binaryOf(id),
    inspectCapabilities: probe ?? (bin => { inspectLog.push(bin); return capabilitiesOf(BINARIES[bin]) }),
    // the shared server's contract would have been inherited before: it must not matter now
    getBoardPeerContract: () => 'f'.repeat(64),
    resolveHome: id => { if (!homes.has(id)) throw new Error('No slot'); return homes.get(id) },
    spawnChild(executable, args, options) {
      const child = new EventEmitter()
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), sent: [], executable, args, options })
      child.emitRpc = message => child.stdout.write(`${JSON.stringify(message)}\n`)
      child.stdin = new Writable({ write(data, _, done) {
        const message = JSON.parse(data.toString()); child.sent.push(message)
        if (message.method && message.id) queueMicrotask(() => child.emitRpc({ id: message.id, result: message.method === 'account/read' ? { account: signedOut.includes(options.env.CODEX_HOME) ? null : { type: 'chatgpt', email: `${options.env.CODEX_HOME.split('/').pop()}@example.org`, planType: 'plus' } }
          : message.method === 'model/list' ? { data: [], nextCursor: null } : {} }))
        done()
      } })
      child.kill = () => { queueMicrotask(() => child.emit('close')); return true }
      children.push(child); return child
    } })
  const adapter = createCodexEngineAdapter({ profiles: pool, getThreadDelete: () => sharedDelete, getBoardPeerContract: () => 'e'.repeat(64),
    request: (...args) => { shared.push(args); return {} }, respond() {}, getOwnerKey: () => 'shared-owner' })
  return { pool, adapter, children, shared, inspectLog }
}
const sentMethods = child => child.sent.map(m => m.method).filter(Boolean)

test('(b) each profile server reports the capabilities of its OWN binary; the shared probe and a shared contract are never inherited', async () => {
  for (const sharedDelete of [true, false]) {
    const { pool, adapter } = rig({ sharedDelete })
    await adapter.ensureReady(A); await adapter.ensureReady(B)
    assert.deepEqual({ ...pool.capabilities(A) }, { version: '0.162.1', dynamicTools: true, ephemeral: true, turnSteer: true, threadDelete: true, boardPeerContract: PROOF, executable: '/bin/codex-a' })
    assert.deepEqual({ ...pool.capabilities(B) }, { version: '0.150.0', dynamicTools: false, ephemeral: false, turnSteer: false, threadDelete: false, boardPeerContract: null, executable: '/bin/codex-b' })
    assert.equal(adapter.boardPeerContract(A), PROOF, 'the steer proof is the binary\'s own, not the shared one')
    assert.equal(adapter.boardPeerContract(B), null, 'another build: no steer proof, whatever the shared server has')
    assert.equal(adapter.boardPeerContract('codex-default'), 'e'.repeat(64), 'the shared slot answers from the shared server\'s own contract: a separate answer')
    assert.deepEqual([adapter.threadDeleteSupported(A), adapter.threadDeleteSupported(B)], [true, false], `shared delete ${sharedDelete} changes nothing for a profile`)
    assert.equal(adapter.slotCapabilities(A).threadDelete, true); assert.equal(adapter.slotCapabilities('codex-default'), null)
    assert.equal(adapter.threadDeleteSupported('codex-default'), sharedDelete, 'the shared slot follows the shared probe, as before')
  }
  const sharedOn = rig({ sharedDelete: true })
  assert.equal(sharedOn.adapter.threadDeleteSupported(undefined), true, 'the shared slot still answers from the shared probe')
  assert.equal(rig({ sharedDelete: false }).adapter.threadDeleteSupported(undefined), false)
})

test('(b) a profile that is not ready claims nothing; a failed probe claims nothing and borrows no shared contract; without a probe configured the legacy hook is unchanged', async () => {
  const { pool, adapter } = rig()
  assert.deepEqual({ ...pool.capabilities(A) }, { version: null, dynamicTools: false, ephemeral: false, turnSteer: false, threadDelete: false, boardPeerContract: null, executable: null })
  assert.equal(adapter.threadDeleteSupported(A), false)
  const legacy = rig({ probe: () => { throw new Error('probe failed') } })
  await legacy.adapter.ensureReady(A)
  assert.equal(legacy.pool.capabilities(A).threadDelete, false); assert.equal(legacy.pool.capabilities(A).dynamicTools, false)
  assert.equal(legacy.adapter.boardPeerContract(A), null, 'a failed probe borrows nothing from the shared server')
  // no probe configured at all (older callers): exactly the previous behaviour
  const homes = { [A]: { home: '/private/one', identity: 'one' } }
  const old = createCodexProfileAppServers({ env: { PATH: '/p' }, cwd: '/w', executable: () => '/bin/codex-a', getBoardPeerContract: () => 'c'.repeat(64), resolveHome: id => homes[id],
    spawnChild(executable, args, options) {
      const child = new EventEmitter()
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough() })
      child.stdin = new Writable({ write(data, _, done) { const m = JSON.parse(data.toString()); if (m.method && m.id) queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: m.id, result: m.method === 'account/read' ? { account: { type: 'chatgpt', email: 'one@example.org', planType: 'plus' } } : m.method === 'model/list' ? { data: [], nextCursor: null } : {} })}\n`)); done() } })
      child.kill = () => { queueMicrotask(() => child.emit('close')); return true }
      return child
    } })
  await old.ensureReady(A)
  assert.equal(old.boardPeerContract(A), 'c'.repeat(64)); assert.equal(old.capabilities(A).threadDelete, false, 'and it claims no capability it did not probe')
  await old.dispose()
})

test('(a) thread/delete goes to the app-server that owns the thread, only where its binary has it; the other server and the shared one see nothing', async () => {
  const { adapter, children, shared } = rig({ sharedDelete: true })
  await adapter.ensureReady(A); await adapter.ensureReady(B)
  const [a, b] = children
  const before = [a.sent.length, b.sent.length]
  await adapter.deleteThread('thread-on-a', A)
  assert.deepEqual(a.sent.slice(before[0]).map(m => [m.method, m.params]), [['thread/delete', { threadId: 'thread-on-a' }]])
  assert.equal(b.sent.length, before[1], 'the other profile\'s server was not asked'); assert.equal(shared.length, 0, 'nor the shared one')
  assert.throws(() => adapter.deleteThread('thread-on-b', B), { code: 'THREAD_DELETE_UNSUPPORTED' })
  assert.equal(b.sent.length, before[1], 'that binary has no thread/delete: nothing is sent')
  assert.equal(shared.length, 0)
})

test('probe cache: one probe per binary, again when the binary is replaced; a failed probe is not remembered', () => {
  const calls = []
  let size = 10, fail = false
  const cache = createNativeCapabilityCache({ stat: () => ({ size, mtimeMs: 1000 }), inspect: ({ executable }) => { calls.push(executable); if (fail) throw new Error('x'); return BINARIES['/bin/codex-a'] } })
  assert.equal(cache('/bin/codex-a').threadDelete, true); assert.equal(cache('/bin/codex-a').threadDelete, true)
  assert.deepEqual(calls, ['/bin/codex-a'], 'probed once')
  size = 11; cache('/bin/codex-a'); assert.equal(calls.length, 2, 'a replaced binary (size/mtime) is probed again')
  size = 12; fail = true; assert.equal(cache('/bin/codex-a'), null); assert.equal(cache('/bin/codex-a'), null); assert.equal(calls.length, 4, 'a failure is retried, not remembered')
  assert.equal(createNativeCapabilityCache({ stat: () => { throw new Error('gone') } })('/missing'), null)
  assert.equal(cache(''), null)
  assert.equal(capabilitiesOf(null), null)
})

test('the probe runs once per binary through the profile pool (two launches of one binary, one probe)', async () => {
  const log = []
  const { adapter } = rig({ inspectLog: log, probe: (() => { const c = createNativeCapabilityCache({ stat: () => ({ size: 1, mtimeMs: 1 }), inspect: ({ executable }) => { log.push(executable); return BINARIES[executable] } }); return bin => c(bin) })() })
  await adapter.ensureReady(A); await adapter.ensureReady(B)
  assert.deepEqual(log, ['/bin/codex-a', '/bin/codex-b'])
})

test('(c) pure-engine launch overrides: a profile server gets the SAME model/effort/memory flags as the shared one (one builder), plus the file credential store; its environment is the OS whitelist plus its own CODEX_HOME', async () => {
  const env = { PATH: '/system/bin', HOME: '/user', CODEX_HOME: '/default', OPENAI_API_KEY: 'fake', EGDESK_CODEX_MODEL: 'model-x', EGDESK_CODEX_EFFORT: 'low', EGDESK_CODEX_DISABLE_MEMORIES: '1' }
  const { pool, children } = rig({ env })
  void pool.refresh(A).catch(() => {}); await new Promise(r => setImmediate(r))
  const shared = buildCodexAppServerLaunch({ env, listen: 'ws://127.0.0.1:1' }).args, profile = children[0].args
  assert.deepEqual(profile, [...shared.slice(0, -2), '--listen', 'stdio://', '-c', 'cli_auth_credentials_store=file'], 'same builder: a flag added there (L5\'s pure-engine config) reaches both servers')
  assert.deepEqual(shared.filter(a => a === '-c').length, 3)
  assert.deepEqual(children[0].options.env, { PATH: '/system/bin', HOME: '/user', CODEX_HOME: '/private/one' })
  assert.equal(children[0].options.shell, false); assert.equal(children[0].options.cwd, '/workspace')
  // what differs, as of this cycle: the shared server runs with the whole bridge environment and its default CODEX_HOME; no server has an mcp_servers override
  for (const args of [shared, profile]) assert.equal(args.some(a => /mcp_servers/.test(a)), false, 'no MCP override on either server yet (lane L5)')
  assert.equal(resolveCodexExecutable.length >= 0, true)
})

test('(b) a profile whose launch worked but is signed out claims nothing, though its binary probed fine; signing in is what turns the capabilities on', async () => {
  const inspectLog = [], { pool, adapter } = rig({ signedOut: ['/private/two'], inspectLog, probe: bin => { inspectLog.push(bin); return capabilitiesOf(BINARIES['/bin/codex-a']) } }) // every binary is fully capable: only the sign-in can switch it off
  await adapter.ensureReady(A)
  await assert.rejects(adapter.ensureReady(B), { code: 'ENGINE_LOGIN_REQUIRED' })
  assert.ok(inspectLog.includes('/bin/codex-b'), 'its binary was probed at launch')
  assert.deepEqual([pool.capabilities(B).threadDelete, pool.capabilities(B).dynamicTools, pool.capabilities(B).turnSteer], [false, false, false])
  assert.equal(pool.capabilities(A).threadDelete, true)
  assert.equal(adapter.threadDeleteSupported(B), false)
})
