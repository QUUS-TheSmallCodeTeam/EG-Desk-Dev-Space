import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'
import { BRIDGE_SETTINGS_FILE, MAX_BRIDGE_SETTINGS_BYTES, openBridgeSettings } from './egdesk-bridge-settings.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createComputerControlHttpHandler } from './codex-bridge-http.mjs'
import { DEFAULT_COMPUTER_CONTROL_POLICY } from './codex-computer-control.mjs'

// CU-01: the computer control choice outlives a bridge restart.
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX permissions' : false }

function fixture(t) {
  const root = createPrivateQaTempDirectory('egdesk-bridge-settings-test-')
  t.after(() => {
    try { chmodSync(path.join(root, 'settings'), 0o700) } catch {}
    rmSync(root, { recursive: true, force: true })
  })
  const dataDir = path.join(root, 'settings')
  const logs = []
  const open = () => openBridgeSettings({ dataDir, log: message => logs.push(message), now: () => 1_790_000_000_000 })
  const file = path.join(dataDir, BRIDGE_SETTINGS_FILE)
  const plant = (text, mode = 0o600) => { mkdirSync(dataDir, { recursive: true, mode: 0o700 }); writeFileSync(file, text, { mode }); chmodSync(file, mode) }
  const entries = () => readdirSync(dataDir).sort()
  return { root, dataDir, file, logs, open, plant, entries }
}

// A bridge restart: a new store on the same directory and a new Chat runtime.
function bridge(f, { changes = [] } = {}) {
  const settings = f.open()
  const chat = new CodexChatRuntime({ request: async () => ({}), respond: () => {}, verifyFile: async () => null, computerControlStore: settings.computerControl, onComputerControlChange: value => changes.push(value) })
  return { settings, chat, changes, handle: createComputerControlHttpHandler(chat, { port: 39218 }) }
}

async function post(handle, body) {
  const req = Readable.from([Buffer.from(body)])
  Object.assign(req, { method: 'POST', url: '/settings/computer-control', headers: { host: '127.0.0.1:39218', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } })
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) }, end(text) { this.body = text ? JSON.parse(text) : null } }
  await handle(req, res, new URL(req.url, 'http://127.0.0.1:39218'))
  return { status: res.status, body: res.body }
}

test('a first start has no file and uses the module default; a saved choice is a private 0600 file read back after a restart', posixOnly, async t => {
  const f = fixture(t)
  const first = bridge(f)
  assert.equal(first.settings.status, 'missing')
  assert.equal(first.settings.get('computerControlPolicy'), null)
  assert.deepEqual(first.chat.computerControlSnapshot(), { policy: DEFAULT_COMPUTER_CONTROL_POLICY, verified: null, persisted: true })
  assert.deepEqual(f.entries(), [], 'opening writes nothing')
  assert.deepEqual(await post(first.handle, '{"policy":"off"}'), { status: 200, body: { policy: 'off', verified: null, persisted: true } })
  assert.deepEqual(first.changes, [{ policy: 'off', verified: null, persisted: true }])
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), { version: 1, computerControlPolicy: 'off' })
  assert.equal(statSync(f.file).mode & 0o777, 0o600)
  assert.equal(statSync(f.dataDir).mode & 0o777, 0o700)
  assert.ok(isOwnedAndPrivate(f.file, lstatSync(f.file), 0o077))
  assert.deepEqual(f.entries(), [BRIDGE_SETTINGS_FILE], 'no temp file is left behind')

  // Restart: the choice comes back without any request.
  const second = bridge(f)
  assert.equal(second.settings.status, 'loaded')
  assert.deepEqual(second.chat.computerControlSnapshot(), { policy: 'off', verified: null, persisted: true })
  // Choosing the saved value again writes nothing; a change writes once more.
  const inode = statSync(f.file).ino
  assert.deepEqual(await post(second.handle, '{"policy":"off"}'), { status: 200, body: { policy: 'off', verified: null, persisted: true } })
  assert.equal(statSync(f.file).ino, inode)
  assert.deepEqual(second.changes, [])
  assert.deepEqual((await post(second.handle, '{"policy":"inherit"}')).body, { policy: 'inherit', verified: null, persisted: true })
  assert.notEqual(statSync(f.file).ino, inode, 'replaced by rename, not rewritten in place')
  assert.equal(bridge(f).chat.computerControlSnapshot().policy, 'inherit')
  assert.deepEqual(f.logs, [])
})

test('an explicit choice of the default is saved too, so a later default change does not override it', posixOnly, async t => {
  const f = fixture(t)
  const { handle } = bridge(f)
  assert.deepEqual((await post(handle, `{"policy":"${DEFAULT_COMPUTER_CONTROL_POLICY}"}`)).body.persisted, true)
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), { version: 1, computerControlPolicy: DEFAULT_COMPUTER_CONTROL_POLICY })
})

test('a damaged settings file is kept aside unchanged, logged by name only, and the bridge starts with defaults and can save again', posixOnly, async t => {
  const cases = [
    ['{"version":1,"computerControlPolicy":"off"', 'not JSON'],
    ['[]', 'not an object'],
    ['{"version":1,"computerControlPolicy":"sometimes"}', 'invalid computerControlPolicy'],
    ['{"computerControlPolicy":"off"}', 'unknown version'],
    ['{"version":"1","computerControlPolicy":"off"}', 'unknown version'],
    [`{"version":1,"pad":"${'x'.repeat(MAX_BRIDGE_SETTINGS_BYTES)}"}`, 'too large'],
    ['{"version":1,"computerControlPolicy":"off"}', 'not a private regular file', 0o644],
  ]
  for (const [index, [text, reason, mode]] of cases.entries()) {
    await t.test(`${index + 1}: ${reason}${mode ? ' (0644)' : ''}`, async t2 => {
      const f = fixture(t2)
      f.plant(text, mode)
      const { settings, chat, handle } = bridge(f)
      assert.equal(settings.status, 'recovered')
      assert.deepEqual(chat.computerControlSnapshot(), { policy: DEFAULT_COMPUTER_CONTROL_POLICY, verified: null, persisted: true })
      const aside = f.entries().filter(name => name.startsWith(`${BRIDGE_SETTINGS_FILE}.corrupt-1790000000000-`))
      assert.equal(aside.length, 1)
      assert.deepEqual(f.entries(), aside, 'the damaged file moved; nothing else was written')
      assert.equal(readFileSync(path.join(f.dataDir, aside[0]), 'utf8'), text, 'kept byte for byte')
      assert.equal(f.logs.length, 1)
      assert.ok(f.logs[0].includes(reason) && f.logs[0].includes(aside[0]), f.logs[0])
      assert.ok(!f.logs[0].includes('sometimes') && !f.logs[0].includes('xxxx'), 'file contents are never logged')
      assert.deepEqual((await post(handle, '{"policy":"off"}')).body, { policy: 'off', verified: null, persisted: true })
      assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), { version: 1, computerControlPolicy: 'off' })
      assert.ok(f.entries().includes(aside[0]), 'the kept file survives the next save')
    })
  }
})

test('a symbolic link in place of the settings file is set aside, never followed', posixOnly, async t => {
  const f = fixture(t)
  const target = path.join(f.root, 'elsewhere.json')
  writeFileSync(target, '{"version":1,"computerControlPolicy":"off"}', { mode: 0o600 })
  mkdirSync(f.dataDir, { mode: 0o700 })
  symlinkSync(target, f.file)
  const { settings, chat, handle } = bridge(f)
  assert.equal(settings.status, 'recovered')
  assert.equal(chat.computerControlSnapshot().policy, DEFAULT_COMPUTER_CONTROL_POLICY)
  await post(handle, '{"policy":"inherit"}')
  assert.equal(readFileSync(target, 'utf8'), '{"version":1,"computerControlPolicy":"off"}', 'the link target is untouched')
  assert.equal(lstatSync(f.file).isSymbolicLink(), false)
})

test('a file from a newer version is left untouched and choices are applied but not saved', posixOnly, async t => {
  const f = fixture(t)
  const newer = '{"version":2,"computerControlPolicy":"off","future":true}'
  f.plant(newer)
  const { settings, chat, handle, changes } = bridge(f)
  assert.equal(settings.status, 'unsupported')
  assert.deepEqual(chat.computerControlSnapshot(), { policy: DEFAULT_COMPUTER_CONTROL_POLICY, verified: null, persisted: false })
  assert.deepEqual(await post(handle, '{"policy":"off"}'), { status: 200, body: { policy: 'off', verified: null, persisted: false } })
  assert.deepEqual(changes, [{ policy: 'off', verified: null, persisted: false }])
  assert.equal(readFileSync(f.file, 'utf8'), newer)
  assert.deepEqual(f.entries(), [BRIDGE_SETTINGS_FILE])
  assert.equal(f.logs.length, 1)
})

test('fields a newer build added at the same version are kept when this build saves', posixOnly, async t => {
  const f = fixture(t)
  f.plant('{"version":1,"computerControlPolicy":"inherit","laterSetting":{"a":[1,2]}}')
  const { settings, handle } = bridge(f)
  assert.equal(settings.status, 'loaded')
  await post(handle, '{"policy":"off"}')
  assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')), { version: 1, computerControlPolicy: 'off', laterSetting: { a: [1, 2] } })
})

test('a failed save still applies the policy, answers 200 with persisted false, and a later save that works flips it back', posixOnly, async t => {
  const f = fixture(t)
  const { chat, handle, changes } = bridge(f)
  chmodSync(f.dataDir, 0o500)
  assert.deepEqual(await post(handle, '{"policy":"off"}'), { status: 200, body: { policy: 'off', verified: null, persisted: false } })
  assert.deepEqual(chat.computerControlSnapshot(), { policy: 'off', verified: null, persisted: false })
  assert.equal(f.logs.length, 1)
  assert.match(f.logs[0], /could not be saved \(EACCES\)/)
  chmodSync(f.dataDir, 0o700)
  assert.deepEqual(f.entries(), [], 'no temp file is left behind')
  // Same policy again: the save is retried and the screen hears persisted change.
  assert.deepEqual((await post(handle, '{"policy":"off"}')).body, { policy: 'off', verified: null, persisted: true })
  assert.deepEqual(changes, [{ policy: 'off', verified: null, persisted: false }, { policy: 'off', verified: null, persisted: true }])
  assert.equal(bridge(f).chat.computerControlSnapshot().policy, 'off')
})

test('a store that throws while saving is reported as not persisted instead of failing the request', async () => {
  const chat = new CodexChatRuntime({ request: async () => ({}), respond: () => {}, computerControlStore: { policy: 'off', persisted: true, save() { throw new Error('disk gone') } } })
  assert.deepEqual(chat.computerControlSnapshot(), { policy: 'off', verified: null, persisted: true })
  assert.deepEqual(chat.setComputerControlPolicy('inherit'), { policy: 'inherit', verified: null, persisted: false })
  // An explicit policy still wins over the saved one; without a store the shape stays { policy, verified }.
  assert.equal(new CodexChatRuntime({ request: async () => ({}), respond: () => {}, computerControlPolicy: 'inherit', computerControlStore: { policy: 'off', persisted: true, save: () => true } }).computerControlSnapshot().policy, 'inherit')
  assert.deepEqual(new CodexChatRuntime({ request: async () => ({}), respond: () => {} }).computerControlSnapshot(), { policy: DEFAULT_COMPUTER_CONTROL_POLICY, verified: null })
})

test('an unreadable file or an unsafe directory starts with defaults and never overwrites anything', posixOnly, async t => {
  await t.test('unreadable file', async t2 => {
    const f = fixture(t2)
    f.plant('{"version":1,"computerControlPolicy":"off"}', 0o000)
    const { settings, chat, handle } = bridge(f)
    assert.equal(settings.status, 'unreadable')
    assert.deepEqual(chat.computerControlSnapshot(), { policy: DEFAULT_COMPUTER_CONTROL_POLICY, verified: null, persisted: false })
    assert.equal((await post(handle, '{"policy":"inherit"}')).body.persisted, false)
    chmodSync(f.file, 0o600)
    assert.equal(readFileSync(f.file, 'utf8'), '{"version":1,"computerControlPolicy":"off"}')
    assert.match(f.logs[0], /could not be read \(EACCES\)/)
  })
  await t.test('shared directory', async t2 => {
    const f = fixture(t2)
    mkdirSync(f.dataDir, { mode: 0o755 }); chmodSync(f.dataDir, 0o755)
    const { settings, chat, handle } = bridge(f)
    assert.equal(settings.status, 'unavailable')
    assert.deepEqual(chat.computerControlSnapshot(), { policy: DEFAULT_COMPUTER_CONTROL_POLICY, verified: null, persisted: false })
    assert.equal((await post(handle, '{"policy":"off"}')).body.persisted, false)
    assert.deepEqual(f.entries(), [])
    assert.match(f.logs[0], /directory unavailable \(NOT_PRIVATE\)/)
  })
  const logs = []
  assert.equal(openBridgeSettings({ dataDir: 'relative/settings', log: message => logs.push(message) }).status, 'unavailable')
  assert.match(logs[0], /INVALID_DATA_DIR/)
  assert.throws(() => openBridgeSettings({ dataDir: 'relative', log: () => {} }).set('computerControlPolicy', 'sometimes'), TypeError)
})

test('the bridge opens settings before Chat and hands the computer control adapter to the runtime', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const at = text => { const index = source.indexOf(text); assert.notEqual(index, -1, `missing server marker: ${text}`); return index }
  at("import { openBridgeSettings } from './egdesk-bridge-settings.mjs'")
  const opened = at("const bridgeSettings = openBridgeSettings({ dataDir: path.join(dataDir, 'settings') })")
  const chat = source.slice(at('const chat = new CodexChatRuntime({'), at('if (chatStore) {'))
  assert.ok(opened < at('const chat = new CodexChatRuntime({'))
  assert.match(chat, /computerControlStore: bridgeSettings\.computerControl,/)
  assert.doesNotMatch(chat, /computerControlPolicy:/, 'the default still comes from codex-computer-control.mjs')
})
