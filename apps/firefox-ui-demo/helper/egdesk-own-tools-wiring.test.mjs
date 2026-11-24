// c19: the bridge's wiring of EG-Desk's own tools. Off by default (null: nothing changes); on, an empty engine folder under EG-Desk's data
// folder, the providers, the ledger and a group kill. A temp data folder and fakes only; nothing is spawned.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createOwnToolsWiring, prepareEngineFolder, processGroupKill, ownToolsEnabled } from './egdesk-own-tools-wiring.mjs'
import { COMMAND_TOOL_NAME } from './egdesk-command-executor.mjs'
import { FILE_TOOL_NAMES } from './egdesk-file-tools.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

test('off by default: no flag (or any other value) wires nothing', () => {
  for (const env of [{}, { EGDESK_OWN_TOOLS: '1' }, { EGDESK_OWN_TOOLS: 'true' }, { EGDESK_OWN_TOOLS: 'advisory' }]) {
    assert.equal(ownToolsEnabled(env), false)
    assert.equal(createOwnToolsWiring({ env, dataDir: '/nowhere', spawn: () => { throw new Error('never') }, getChat: () => null }), null)
  }
})

test('the engine folder is an empty owner-only folder under EG-Desk\'s data folder; refused when not empty or not absolute', t => {
  const dataDir = fs.realpathSync(createPrivateQaTempDirectory('egdesk-own-tools-wiring-test-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const folder = prepareEngineFolder(dataDir)
  assert.equal(folder, path.join(dataDir, 'engine-folders', 'empty'))
  assert.equal(fs.statSync(folder).mode & 0o777, 0o700)
  assert.equal(prepareEngineFolder(dataDir), folder, 'stable')
  fs.writeFileSync(path.join(folder, 'stray.txt'), 'x')
  assert.equal(prepareEngineFolder(dataDir), null, 'Codex must see an empty folder')
  assert.equal(prepareEngineFolder('relative/dir'), null)
})

test('group kill: the negative pid (the detached child\'s group), the child alone only as a fallback', () => {
  const calls = [], child = { pid: 4242, killed: [], kill(sig) { this.killed.push(sig) } }
  processGroupKill((pid, sig) => calls.push([pid, sig]))(child, 'SIGTERM')
  assert.deepEqual([calls, child.killed], [[[-4242, 'SIGTERM']], []])
  processGroupKill(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })(child, 'SIGKILL')
  assert.deepEqual(child.killed, ['SIGKILL'])
  const noPid = { killed: [], kill(sig) { this.killed.push(sig) } }
  processGroupKill(() => { throw new Error('must not be called without a pid') })(noPid, 'SIGTERM')
  assert.deepEqual(noPid.killed, ['SIGTERM'])
})

test('on: the providers share one ledger; the gate config keeps the person\'s flag and adds the ledger; the bridge passes nothing when off', t => {
  const dataDir = fs.realpathSync(createPrivateQaTempDirectory('egdesk-own-tools-wiring-test-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const wiring = createOwnToolsWiring({ env: { EGDESK_OWN_TOOLS: 'on', PATH: '/usr/bin' }, dataDir, spawn: () => { throw new Error('not in this test') }, getChat: () => null })
  assert.deepEqual(wiring.toolProviders.flatMap(p => p.specs().map(s => s.name)), [COMMAND_TOOL_NAME, FILE_TOOL_NAMES.read, FILE_TOOL_NAMES.search, FILE_TOOL_NAMES.edit, FILE_TOOL_NAMES.undo])
  assert.equal(wiring.ownTools.mode(), 'on'); assert.equal(wiring.ownTools.neutralFolder(), path.join(dataDir, 'engine-folders', 'empty'))
  const base = { mode: () => 'advisory', inspect: () => null, method: 'predicates' }
  const merged = wiring.terminalGate(base)
  assert.deepEqual([merged.mode(), merged.method, merged.inspect, merged.hookBroker], ['advisory', 'predicates', base.inspect, wiring.ledger])
  assert.equal(wiring.terminalGate(null).mode(), 'on', 'own tools need the gate on when the person set no gate flag')
  const bridge = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'codex-bridge-server.mjs'), 'utf8')
  assert.match(bridge, /const ownToolsWiring = createOwnToolsWiring\(\{ env: process\.env, dataDir, spawn, getChat: \(\) => chat, inspect: createGitTargetInspector\(\) \}\)/)
  assert.match(bridge, /toolProviders: \[browserProvider, planProvider, annotationProvider\]\.concat\(ownToolsWiring \? ownToolsWiring\.toolProviders : \[\]\),\n  \.\.\.\(ownToolsWiring \? \{ ownTools: ownToolsWiring\.ownTools \} : \{\}\),/)
  assert.match(bridge, /\.\.\.\(ownToolsWiring \? \{ terminalGate: ownToolsWiring\.terminalGate\(terminalGateConfig\) \} : terminalGateConfig \? \{ terminalGate: terminalGateConfig \} : \{\}\),/,
    'off: exactly the c11 terminal gate configuration as before')
})
