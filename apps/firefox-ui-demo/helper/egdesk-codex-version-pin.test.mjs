// The engine-version pin of the command-gate hook path (c15): read from the app-server's initialize answer, compared with the
// builds the source check covered; a mismatch is recorded once per session and never changes the gate. Fakes only; nothing is run.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { CODEX_HOOK_SOURCE_CHECK, ENGINE_VERSION_NOTICE, checkEngineVersion, parseCodexUserAgent } from './egdesk-codex-version-pin.mjs'
import { AppServerRpc } from './codex-app-server-rpc.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { createGateHookBroker } from './egdesk-gate-hook-broker.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

test('the user agent the app-server returns carries the build version (login/src/auth/default_client.rs format)', () => {
  assert.deepEqual(parseCodexUserAgent('codex_cli_rs/0.172.0 (Mac OS 15.1.0; arm64) iTerm.app/3.5.0'), { originator: 'codex_cli_rs', version: '0.172.0' })
  assert.deepEqual(parseCodexUserAgent('egdesk-firefox-bridge/0.174.0-alpha.1 (Mac OS 15.1.0; arm64) unknown'), { originator: 'egdesk-firefox-bridge', version: '0.174.0-alpha.1' })
  for (const bad of [null, '', 'codex', 'codex_cli_rs/', 'codex_cli_rs/latest (x)', 42]) assert.equal(parseCodexUserAgent(bad), null, String(bad))
  assert.deepEqual(checkEngineVersion('codex_cli_rs/0.172.0 (Mac OS 15.1.0; arm64)'), { status: 'verified', version: '0.172.0' })
  assert.deepEqual(checkEngineVersion('codex_cli_rs/0.175.0 (Mac OS 15.1.0; arm64)'), { status: 'unverified', version: '0.175.0' })
  assert.deepEqual(checkEngineVersion('codex_cli_rs/0.0.0 (Mac OS 15.1.0; arm64)'), { status: 'unverified', version: '0.0.0' }, 'a local build from main reports 0.0.0 (Cargo.toml workspace version): not a checked release')
  assert.deepEqual(checkEngineVersion(undefined), { status: 'unverified', version: null })
  assert.equal(CODEX_HOOK_SOURCE_CHECK.commit, 'a0d5b0a661db3b34cd87bdf1c93736b90fd3694b')
})

test('initialize keeps only the user agent from InitializeResponse (not the codexHome path)', async () => {
  const sent = []
  const rpc = new AppServerRpc({ send: line => sent.push(JSON.parse(line)) })
  const init = rpc.initialize()
  rpc.receive(JSON.stringify({ id: sent[0].id, result: { userAgent: 'codex_cli_rs/0.172.0 (Mac OS 15.1.0; arm64) x', codexHome: '/home/synthetic/.codex', platformFamily: 'unix', platformOs: 'macos' } }))
  await init
  assert.deepEqual(rpc.serverInfo, { userAgent: 'codex_cli_rs/0.172.0 (Mac OS 15.1.0; arm64) x' })
  const old = new AppServerRpc({ send: line => sent.push(JSON.parse(line)) })
  const init2 = old.initialize()
  old.receive(JSON.stringify({ id: sent.at(-1).id, result: {} }))
  await init2
  assert.deepEqual(old.serverInfo, { userAgent: null })
  const bridge = readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'codex-bridge-server.mjs'), 'utf8')
  assert.match(bridge, /await connection\.initialize\(\)\n\s+if \(appServerSocket !== socket\) return\n[^\n]*\n\s+try \{ chat\.setEngineVersion\(\{ engineId: 'codex', userAgent: connection\.serverInfo\?\.userAgent \?\? null \}\) \}/, 'the bridge reports it right after initialize')
})

function runtime(t, { mode = 'on', hookBroker = null } = {}) {
  const root = createPrivateQaTempDirectory('egdesk-version-pin-test-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const calibrationLog = openCalibrationLog({ dataDir: root, log: () => {} })
  const state = { mode }
  const chat = new CodexChatRuntime({ request: async () => ({}), respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null,
    decisionContext: { mode: () => 'off', configured: () => false, client: null, calibrationLog, terminalGate: { mode: () => state.mode, home: '/home/synthetic', ...(hookBroker ? { hookBroker } : {}) } } })
  const notices = () => calibrationLog.entries().filter(e => e.feature === 'terminal_gate' && e.gate?.notice).map(e => [e.mode, e.gate.notice, e.gate.engine])
  return { chat, state, notices }
}

test('an unverified version is recorded once per session, only while a gate path is on, in closed words; a verified one never', async t => {
  const h = runtime(t, { mode: 'on' })
  h.chat.setEngineVersion({ engineId: 'codex', userAgent: 'codex_cli_rs/0.175.0 (Mac OS 15.1.0; arm64)' })
  for (let i = 0; i < 3; i++) h.chat.noteEngineVersionOnce()
  assert.deepEqual(h.notices(), [['on', ENGINE_VERSION_NOTICE, 'codex']])
  assert.doesNotMatch(JSON.stringify(h.notices()), /0\.175/, 'the version itself is not written: closed vocabulary only')
  h.chat.setEngineVersion({ engineId: 'codex', userAgent: 'codex_cli_rs/0.175.0 (Mac OS 15.1.0; arm64)' }) // reconnect = new session
  assert.equal(h.notices().length, 2)
  h.chat.setEngineVersion({ engineId: 'codex', userAgent: 'codex_cli_rs/0.172.0 (Mac OS 15.1.0; arm64)' })
  h.chat.noteEngineVersionOnce()
  assert.equal(h.notices().length, 2, 'verified: nothing')
  // flag off: nothing until the gate is turned on; then the first gate activity records it once
  const off = runtime(t, { mode: 'off' })
  off.chat.setEngineVersion({ engineId: 'codex', userAgent: null })
  off.chat.noteEngineVersionOnce()
  assert.deepEqual(off.notices(), [])
  off.state.mode = 'advisory'
  off.chat.noteEngineVersionOnce(); off.chat.noteEngineVersionOnce()
  assert.deepEqual(off.notices(), [['advisory', ENGINE_VERSION_NOTICE, 'codex']])
  // the hook path alone (broker present, gate flag off) counts as on; its checks reach the notice through onCheck
  let h2 = null
  const broker = createGateHookBroker({ mode: () => 'on', home: '/home/synthetic', onCheck: () => h2.chat.noteEngineVersionOnce() })
  h2 = runtime(t, { mode: 'off', hookBroker: broker })
  h2.chat.engineVersionCheck = { ...checkEngineVersion('codex_cli_rs/9.9.9 (x)'), noted: false }
  assert.equal((await broker.check({ turnId: 'T', cwd: '/work', command: 'git clean -fdx' })).decision, 'deny', 'the gate keeps working')
  await broker.check({ turnId: 'T', cwd: '/work', command: 'npm test' })
  assert.deepEqual(h2.notices(), [['on', ENGINE_VERSION_NOTICE, 'codex']])
})

test('the gate behaves the same with a verified, an unverified or an unknown engine version', async () => {
  const results = []
  for (const ua of ['codex_cli_rs/0.172.0 (x)', 'codex_cli_rs/0.175.0 (x)', null]) {
    const broker = createGateHookBroker({ mode: () => 'on', home: '/home/synthetic' })
    const chat = new CodexChatRuntime({ request: async () => ({}), respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null,
      decisionContext: { mode: () => 'off', configured: () => false, client: null, calibrationLog: { record: () => {} }, terminalGate: { mode: () => 'on', hookBroker: broker } } })
    chat.setEngineVersion({ engineId: 'codex', userAgent: ua })
    broker.turnStarted({ conversationId: 'c', turnId: 'T' })
    results.push(await Promise.all(['git clean -fdx', 'npm test', 'git push --force origin main'].map(command => broker.check({ sessionId: 'c', turnId: 'T', cwd: '/work', command }))))
  }
  assert.deepEqual(results[1], results[0]); assert.deepEqual(results[2], results[0])
})
