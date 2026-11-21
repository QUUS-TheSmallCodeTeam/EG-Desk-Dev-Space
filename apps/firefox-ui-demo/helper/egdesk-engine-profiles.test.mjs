import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { ENGINE_PROFILES_FILE, openEngineProfiles } from './egdesk-engine-profiles.mjs'
import { createEngineProfilesHttpHandler } from './egdesk-engine-profiles-http.mjs'

// SUB-11: Engine Profiles (one login slot per profile).
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX permissions' : false }

function fixture(t) {
  const root = createPrivateQaTempDirectory('egdesk-engine-profiles-test-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'settings')
  const logs = []
  let n = 0
  const open = (options = {}) => openEngineProfiles({ dataDir, log: line => logs.push(line), randomId: () => `abcdef0${++n}`, ...options })
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
  assert.throws(() => store.loginCommand(added.id), { code: 'ENGINE_PROFILE_NOT_FOUND' })
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

// HTTP routes the Settings screen uses.

async function call(handle, method, target, body = null, headers = {}) {
  const req = Readable.from(body == null ? [] : [Buffer.from(JSON.stringify(body))])
  Object.assign(req, { method, url: target, headers: { host: '127.0.0.1:39218', 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' } })
  const res = { headers: {}, setHeader(key, value) { this.headers[key] = value }, writeHead(status, h) { this.status = status; Object.assign(this.headers, h) }, end(text) { this.body = text ? JSON.parse(text) : null } }
  const handled = await handle(req, res, new URL(target, 'http://127.0.0.1:39218'))
  return { handled, status: res.status, body: res.body }
}

test('Settings routes add, switch, give the login line and remove profiles; a busy engine never switches', async t => {
  const { open } = fixture(t)
  const store = open()
  let busy = false, changes = 0
  const handle = createEngineProfilesHttpHandler({ profiles: store, busy: () => busy, onChange: () => { changes++ } })
  assert.equal((await call(handle, 'GET', '/v1/state')).handled, false)
  const listed = await call(handle, 'GET', '/settings/engine-profiles')
  assert.deepEqual(listed.body.profiles.map(row => row.id), ['codex-default', 'claude-default'])
  const added = await call(handle, 'POST', '/settings/engine-profiles', { engine: 'claude', label: '개인' })
  assert.equal(added.status, 200)
  assert.match(added.body.login.line, /^CLAUDE_CONFIG_DIR='.+claude-abcdef01' claude auth login --claudeai$/)
  busy = true
  const refused = await call(handle, 'POST', '/settings/engine-profiles/active', { engine: 'claude', id: added.body.profile.id })
  assert.deepEqual([refused.status, refused.body.code], [409, 'ENGINE_PROFILE_BUSY'])
  busy = false
  const switched = await call(handle, 'POST', '/settings/engine-profiles/active', { engine: 'claude', id: added.body.profile.id })
  assert.equal(switched.body.profiles.find(row => row.id === added.body.profile.id).active, true)
  const login = await call(handle, 'GET', `/settings/engine-profiles/login-command?id=${added.body.profile.id}&method=console`)
  assert.match(login.body.line, /--console$/)
  const active = await call(handle, 'DELETE', `/settings/engine-profiles?id=${added.body.profile.id}`)
  assert.deepEqual([active.status, active.body.code], [409, 'ENGINE_PROFILE_ACTIVE'])
  await call(handle, 'POST', '/settings/engine-profiles/active', { engine: 'claude', id: 'claude-default' })
  const removed = await call(handle, 'DELETE', `/settings/engine-profiles?id=${added.body.profile.id}`)
  assert.deepEqual(removed.body.profiles.map(row => row.id), ['codex-default', 'claude-default'])
  assert.equal(changes, 4)
  const foreign = await call(handle, 'GET', '/settings/engine-profiles', null, { origin: 'https://evil.example' })
  assert.equal(foreign.status, 403)
})

test('the bridge wires the profile store into Claude spawns, the static check, the Codex row and the Settings routes', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(source, /const engineProfiles = openEngineProfiles\(\{ dataDir: path\.join\(dataDir, 'settings'\), isolatedCodex: true \}\)/)
  assert.match(source, /createClaudeEngineAdapter\(\{[\s\S]*?profiles: claudeProfileRows,\n\}\)/)
  assert.match(source, /getProfileId: \(\) => engineProfiles\.active\('claude'\),\s*probe: profileId => probeClaudeEngine\(\{ env: claudeProfileEnv\(profileId\) \}\)/)
  assert.match(source, /extraProfiles: engineProfiles\.list\('codex'\)\.filter\(row => row\.owned\)/)
  assert.match(source, /busy: engine => engine === 'claude' && claudeEngine\.stats\(\)\.activeTurns > 0/)
  assert.match(source, /if \(await handleEngineProfilesHttp\(req, res, url\)\) return/)
  assert.match(source, /resolveHome: id => engineProfiles\.ownedCodexHome\(id\)/)
})

test('owned Codex slots remain Agent-only and produce separate checked login homes', posixOnly, async t => {
  const { open } = fixture(t)
  const store = open({ isolatedCodex: true })
  const seen = []
  const handle = createEngineProfilesHttpHandler({ profiles: store, refresh: async id => { seen.push(id); return { id: 'codex' } } })
  const addedA = await call(handle, 'POST', '/settings/engine-profiles', { engine: 'codex', label: 'One' })
  const addedB = await call(handle, 'POST', '/settings/engine-profiles', { engine: 'codex', label: 'Two' })
  const a = addedA.body.profile.id, b = addedB.body.profile.id
  assert.notEqual(a, b)
  for (const added of [addedA, addedB]) {
    const { profile, login } = added.body
    assert.equal(added.status, 200)
    assert.equal(profile.runnable, true)
    assert.equal(profile.active, false)
    const { home } = store.ownedCodexHome(profile.id)
    assert.deepEqual(login, { engine: 'codex', profileId: profile.id, env: 'CODEX_HOME', line: `env -i HOME="$HOME" PATH="$PATH" CODEX_HOME='${home}' codex -c cli_auth_credentials_store=file login` })
    assert.equal(JSON.stringify(profile).includes(home), false)
  }
  assert.equal(store.active('codex'), 'codex-default')
  assert.throws(() => store.setActive('codex', a), { code: 'ENGINE_PROFILE_AGENT_ONLY' })
  assert.throws(() => store.remove(a, { inUse: id => id === a }), { code: 'ENGINE_PROFILE_IN_USE' })
  const refreshed = await call(handle, 'POST', '/settings/engine-profiles/refresh', { id: a })
  assert.deepEqual(refreshed.body, { engine: { id: 'codex' } })
  assert.equal((await call(handle, 'POST', '/settings/engine-profiles/refresh', { id: 'codex-default' })).status, 404)
  assert.deepEqual(seen, [a])
  const stale = store.ownedCodexHome(a).home
  rmSync(stale, { recursive: true })
  symlinkSync(store.ownedCodexHome(b).home, stale)
  assert.throws(() => store.ownedCodexHome(a), { code: 'ENGINE_PROFILE_HOME_UNAVAILABLE' })
  assert.throws(() => store.loginCommand(a), { code: 'ENGINE_PROFILE_HOME_UNAVAILABLE' })
  assert.equal(store.get(a).runnable, false)
  assert.equal(store.get(b).runnable, true)
})

test('production add-and-login rejects missing intent and unsupported engines before provisioning', async t => {
  const { dataDir, open } = fixture(t)
  const store = open()
  let allowed = false, changes = 0
  const handle = createEngineProfilesHttpHandler({ profiles: store, canAddAndLogin: () => allowed, onChange: () => { changes++ } })
  const route = '/settings/engine-profiles'
  const claude = { engine: 'claude', label: '테스트' }
  assert.equal((await call(handle, 'POST', route, claude)).status, 409)
  assert.equal((await call(handle, 'POST', route, { ...claude, intent: 'add-and-login' })).status, 409)
  assert.equal(store.supportsAddAndLogin('codex'), false)
  allowed = true
  assert.equal((await call(handle, 'POST', route, { ...claude, intent: 'record-only' })).status, 409)
  assert.equal((await call(handle, 'POST', route, { ...claude, engine: 'codex', intent: 'add-and-login' })).status, 409)
  assert.equal((await call(handle, 'POST', route, { ...claude, label: ' ', intent: 'add-and-login' })).body.code, 'INVALID_PROFILE_LABEL')
  assert.equal(changes, 0)
  assert.equal(store.list().length, 2)
  assert.equal(existsSync(path.join(dataDir, 'engines')), false)
  const admitted = await call(handle, 'POST', route, { ...claude, intent: 'add-and-login' })
  assert.equal(admitted.status, 200)
  assert.equal(admitted.body.profile.runnable, true)
  assert.equal(admitted.body.login.profileId, admitted.body.profile.id)
  assert.equal(changes, 1)
})
