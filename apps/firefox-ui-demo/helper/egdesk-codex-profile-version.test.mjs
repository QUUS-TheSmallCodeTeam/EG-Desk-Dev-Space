// c16: the command gate's engine-version pin for the per-profile Codex app-servers (codex-profile-app-servers.mjs).
// Fake child processes only: no Codex binary is run, no real CODEX_HOME is read.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createCodexProfileAppServers, isolatedCodexEnv } from './codex-profile-app-servers.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { runGateHook, GATE_HOOK_ENV } from './egdesk-gate-hook-core.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const HOMES = new Map([['codex-11111111', '/private/one'], ['codex-22222222', '/private/two']])
const AGENTS = new Map([['/private/one', 'codex_cli_rs/0.172.0 (Mac OS 15.1.0; arm64) x'], ['/private/two', 'codex_cli_rs/0.175.0 (Mac OS 15.1.0; arm64) x']])
function pool({ env = { PATH: '/system/bin', HOME: '/user' } } = {}) {
  const children = [], versions = []
  const servers = createCodexProfileAppServers({ env, cwd: '/workspace', executable: () => '/synthetic/codex',
    resolveHome: id => ({ home: HOMES.get(id), identity: id }),
    spawnChild(executable, args, options) {
      const child = new EventEmitter(), home = options.env.CODEX_HOME
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), args, options, kills: [] })
      child.stdin = new Writable({ write(data, _, done) {
        const message = JSON.parse(data.toString())
        if (message.method && message.id) queueMicrotask(() => {
          const result = message.method === 'initialize' ? { userAgent: AGENTS.get(home), codexHome: home, platformFamily: 'unix', platformOs: 'macos' }
            : message.method === 'account/read' ? { account: { type: 'chatgpt', email: `${home.split('/').pop()}@example.org`, planType: 'plus' } }
            : message.method === 'model/list' ? { data: [{ id: 'm', model: 'm', displayName: 'm' }], nextCursor: null } : {}
          child.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`)
        })
        done()
      } })
      child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit('close')); return true }
      children.push(child)
      return child
    },
    onVersion: (id, info) => versions.push([id, info]),
  })
  return { servers, children, versions }
}

test('hooks can run in a profile app-server: no hooks switch at launch, an owned CODEX_HOME and the project cwd (Codex loads hooks from those layers)', async () => {
  const { servers, children } = pool()
  try {
    await servers.ensureReady('codex-11111111')
    const [child] = children
    assert.deepEqual(child.args, ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store=file'])
    assert.ok(!child.args.some(arg => /hooks/.test(arg)), 'EG-Desk does not pass features.hooks=false: hooks are on by default (hooks page, "Turn hooks off")')
    assert.equal(child.options.env.CODEX_HOME, '/private/one', 'the User layer is the profile\'s own home: $CODEX_HOME/hooks.json and [hooks] there')
    assert.equal(child.options.cwd, '/workspace', 'a trusted project .codex/hooks.json from the cwd up')
    // The /etc/codex system layer does not depend on CODEX_HOME at all (codex-rs hooks/src/engine/discovery.rs:157-180 loops every config layer).
  } finally { servers.dispose?.() }
  // ...but EG-Desk's own gate hook would be inert there today: the profile environment is isolated, so the hook's address never arrives
  const isolated = isolatedCodexEnv({ PATH: '/system/bin', HOME: '/user', [GATE_HOOK_ENV.url]: 'http://127.0.0.1:9/egdesk/gate-hook/check', [GATE_HOOK_ENV.token]: 'synthetic-hook-token-0123456789' }, '/private/one')
  assert.deepEqual(Object.keys(isolated).sort(), ['CODEX_HOME', 'HOME', 'PATH'])
  const stdin = JSON.stringify({ session_id: 's', cwd: '/workspace', hook_event_name: 'PreToolUse', model: 'm', permission_mode: 'default', turn_id: 't', tool_name: 'Bash', tool_use_id: 'c', transcript_path: null, tool_input: { command: 'git reset --hard HEAD~5' } })
  let called = 0
  assert.deepEqual(await runGateHook({ stdin, env: isolated, fetchImpl: async () => { called++; return Response.json({ decision: 'deny', note: 'x' }) } }), { exitCode: 0, stdout: '' })
  assert.equal(called, 0, 'silent, not fail-closed: a profile hook path must be wired explicitly (the address added to the isolated env) before it can act')
})

test('each profile process reports its build once at initialize (userAgent only); a replacement process reports again', async () => {
  const { servers, children, versions } = pool()
  try {
    await servers.ensureReady('codex-11111111'); await servers.ensureReady('codex-22222222')
    assert.deepEqual(versions, [['codex-11111111', { userAgent: AGENTS.get('/private/one') }], ['codex-22222222', { userAgent: AGENTS.get('/private/two') }]])
    assert.doesNotMatch(JSON.stringify(versions), /private\/one|codexHome/, 'the home path from InitializeResponse is not passed on')
    children[0].emit('close') // the process is lost
    await new Promise(resolve => setImmediate(resolve))
    await servers.ensureReady('codex-11111111')
    assert.equal(versions.length, 3); assert.equal(versions[2][0], 'codex-11111111')
  } finally { servers.dispose?.() }
  const bridge = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'codex-bridge-server.mjs'), 'utf8')
  assert.match(bridge, /onVersion: \(id, info\) => \{ try \{ chat\.setEngineVersion\(\{ engineId: 'codex', engineProfileId: id, userAgent: info\?\.userAgent \?\? null \}\) \}/)
})

test('one session per app-server: the shared one and each profile record an unverified build once each; activity notes only its own session', async t => {
  const root = createPrivateQaTempDirectory('egdesk-profile-version-test-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calibrationLog = openCalibrationLog({ dataDir: root, log: () => {} })
  const state = { mode: 'off' }
  const chat = new CodexChatRuntime({ request: async () => ({}), respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null,
    decisionContext: { mode: () => 'off', configured: () => false, client: null, calibrationLog, terminalGate: { mode: () => state.mode, home: '/home/synthetic' } } })
  const notices = () => calibrationLog.entries().filter(e => e.gate?.notice).map(e => e.gate.engineScope)
  chat.setEngineVersion({ engineId: 'codex', userAgent: 'codex_cli_rs/0.0.0 (x)' }) // the shared app-server: a local main build
  chat.setEngineVersion({ engineId: 'codex', engineProfileId: 'codex-11111111', userAgent: AGENTS.get('/private/one') }) // verified
  chat.setEngineVersion({ engineId: 'codex', engineProfileId: 'codex-22222222', userAgent: AGENTS.get('/private/two') }) // unverified
  assert.deepEqual(notices(), [], 'flag off: nothing yet')
  state.mode = 'advisory'
  chat.threadEngineProfiles.set('conv-two', 'codex-22222222')
  chat.noteEngineVersionOnce({ conversationId: 'conv-two' })
  assert.deepEqual(notices(), ['profile'], 'activity in a profile-two conversation notes profile two only')
  chat.noteEngineVersionOnce({ conversationId: 'conv-unknown' }) // a conversation on the shared app-server
  assert.deepEqual(notices(), ['profile', 'shared'])
  chat.noteEngineVersionOnce(); chat.noteEngineVersionOnce({ conversationId: 'conv-two' })
  assert.deepEqual(notices(), ['profile', 'shared'], 'once per session; profile one is verified')
  chat.setEngineVersion({ engineId: 'codex', engineProfileId: 'codex-22222222', userAgent: AGENTS.get('/private/two') }) // a new process of profile two
  assert.deepEqual(notices(), ['profile', 'shared', 'profile'])
  assert.doesNotMatch(JSON.stringify(calibrationLog.entries()), /codex-2222|0\.175|0\.0\.0/, 'closed words only: no profile id, no version')
})

test('the repeatable source check is in the repository and the pin points to it', () => {
  const dir = path.dirname(new URL(import.meta.url).pathname)
  const script = readFileSync(path.join(dir, '..', 'scripts', 'codex-hooks', 'source-facts-check.sh'), 'utf8')
  assert.equal((script.match(/^fact /gm) || []).length, 11, 'the ten c14 facts and the userAgent field the version is read from')
  assert.doesNotMatch(script, /\bcodex (?:app-server|exec|--)|CODEX_HOME=|~\/\.codex/, 'it downloads source text only: no Codex binary, no Codex configuration')
  assert.match(readFileSync(path.join(dir, 'egdesk-codex-version-pin.mjs'), 'utf8'), /scripts\/codex-hooks\/source-facts-check\.sh/)
})
