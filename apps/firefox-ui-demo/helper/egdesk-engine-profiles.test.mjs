import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { ENGINE_PROFILES_FILE, openEngineProfiles } from './egdesk-engine-profiles.mjs'

// SUB-11: Engine Profiles (one login slot per profile).
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX permissions' : false }

function fixture(t) {
  const root = createPrivateQaTempDirectory('egdesk-engine-profiles-test-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'settings')
  const logs = []
  let n = 0
  const open = () => openEngineProfiles({ dataDir, log: line => logs.push(line), randomId: () => `abcdef0${++n}` })
  return { dataDir, logs, open }
}

test('defaults use the shared login and need no file', t => {
  const { open } = fixture(t)
  const store = open()
  assert.equal(store.status, 'missing')
  assert.deepEqual(store.list().map(row => [row.id, row.owned, row.active, row.status]), [
    ['codex-default', false, true, 'available'], ['claude-default', false, true, 'available'],
  ])
  assert.equal(store.configDir('claude-default'), null)
  assert.equal(store.active('claude'), 'claude-default')
  assert.equal(store.loginCommand('claude-default').line, 'claude auth login --claudeai')
})

test('an added Claude profile gets a private 0700 folder, persists and can be made active', posixOnly, t => {
  const { dataDir, open } = fixture(t)
  const store = open()
  const added = store.add({ engine: 'claude', label: '  회사   계정 ' })
  assert.equal(added.id, 'claude-abcdef01')
  assert.equal(added.label, '회사 계정')
  assert.equal(added.owned, true)
  assert.equal(added.runnable, true)
  const dir = store.configDir(added.id)
  assert.equal(dir, path.join(dataDir, 'engines', added.id))
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(path.join(dataDir, ENGINE_PROFILES_FILE)).mode & 0o777, 0o600)
  const login = store.loginCommand(added.id, 'console')
  assert.equal(login.env, 'CLAUDE_CONFIG_DIR')
  assert.equal(login.line, `CLAUDE_CONFIG_DIR='${dir}' claude auth login --console`)
  assert.equal(store.setActive('claude', added.id), added.id)
  const again = open()
  assert.equal(again.status, 'loaded')
  assert.equal(again.active('claude'), added.id)
  assert.deepEqual(again.list('claude').map(row => [row.id, row.active]), [['claude-default', false], [added.id, true]])
})

test('a running Run never moves: switching while busy is refused', t => {
  const { open } = fixture(t)
  const store = open()
  const added = store.add({ engine: 'claude', label: '개인' })
  assert.throws(() => store.setActive('claude', added.id, { busy: () => true }), { code: 'ENGINE_PROFILE_BUSY' })
  assert.equal(store.active('claude'), 'claude-default')
})

test('Codex added profiles are kept but not runnable yet', t => {
  const { open } = fixture(t)
  const store = open()
  const added = store.add({ engine: 'codex', label: '회사 ChatGPT' })
  assert.equal(added.status, 'notYet')
  assert.equal(added.runnable, false)
  assert.throws(() => store.setActive('codex', added.id), { code: 'ENGINE_PROFILE_NOT_YET' })
  assert.match(store.loginCommand(added.id).line, /^CODEX_HOME='.+' codex login$/)
})

test('remove refuses defaults and the active profile, then deletes the private folder', t => {
  const { open } = fixture(t)
  const store = open()
  assert.throws(() => store.remove('claude-default'), { code: 'ENGINE_PROFILE_DEFAULT' })
  const added = store.add({ engine: 'claude', label: 'x' })
  store.setActive('claude', added.id)
  assert.throws(() => store.remove(added.id), { code: 'ENGINE_PROFILE_ACTIVE' })
  store.setActive('claude', 'claude-default')
  assert.throws(() => store.remove(added.id, { inUse: () => true }), { code: 'ENGINE_PROFILE_IN_USE' })
  const dir = store.configDir(added.id)
  assert.equal(store.remove(added.id), true)
  assert.equal(existsSync(dir), false)
  assert.equal(open().list('claude').length, 1)
})

test('labels and engines are validated', t => {
  const { open } = fixture(t)
  const store = open()
  assert.throws(() => store.add({ engine: 'gemini', label: 'x' }), { code: 'INVALID_ENGINE' })
  assert.throws(() => store.add({ engine: 'claude', label: '' }), { code: 'INVALID_PROFILE_LABEL' })
  assert.throws(() => store.add({ engine: 'claude', label: 'a\u0001b' }), { code: 'INVALID_PROFILE_LABEL' })
  assert.throws(() => store.add({ engine: 'claude', label: 'x'.repeat(61) }), { code: 'INVALID_PROFILE_LABEL' })
  assert.throws(() => store.setActive('codex', 'claude-default'), { code: 'ENGINE_PROFILE_NOT_FOUND' })
})

test('a damaged file is set aside and defaults apply; a newer file is left alone', posixOnly, t => {
  const { dataDir, logs, open } = fixture(t)
  open()
  const file = path.join(dataDir, ENGINE_PROFILES_FILE)
  writeFileSync(file, '{"version":1,"profiles":[{"id":"claude-../x","engine":"claude","label":"x","owned":true}]}', { mode: 0o600 })
  const store = open()
  assert.equal(store.status, 'recovered')
  assert.ok(readdirSync(dataDir).some(name => name.startsWith(`${ENGINE_PROFILES_FILE}.corrupt-`)))
  assert.ok(logs.some(line => line.includes('not valid')))
  writeFileSync(file, '{"version":9}', { mode: 0o600 })
  const newer = open()
  assert.equal(newer.status, 'unsupported')
  assert.throws(() => newer.add({ engine: 'claude', label: 'x' }), { code: 'ENGINE_PROFILES_UNAVAILABLE' })
  chmodSync(file, 0o644)
  assert.equal(open().status, 'recovered')
})
