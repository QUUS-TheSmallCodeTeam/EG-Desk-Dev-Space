import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { DECISION_CREDENTIAL_FILE, decisionKeyHint, openDecisionCredentialStore, validDecisionApiKey } from './egdesk-decision-credential.mjs'

const KEY = 'sk-proj-TESTKEY-0123456789abcdefWXYZ'
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX permissions' : false }

function fixture(t) {
  const root = createPrivateQaTempDirectory('egdesk-decision-credential-test-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dataDir = path.join(root, 'data')
  const logs = []
  const open = () => openDecisionCredentialStore({ dataDir, log: message => logs.push(message), now: () => 1_795_000_000_000 })
  const file = path.join(dataDir, DECISION_CREDENTIAL_FILE)
  const plant = (text, mode = 0o600) => { mkdirSync(dataDir, { recursive: true, mode: 0o700 }); writeFileSync(file, text, { mode }); chmodSync(file, mode) }
  return { root, dataDir, file, logs, open, plant }
}

test('key format and hint', () => {
  assert.equal(validDecisionApiKey(KEY), true)
  for (const bad of ['', 'short', 'has a space 0123456789abcdef', 'x'.repeat(513), 42, null, undefined]) assert.equal(validDecisionApiKey(bad), false)
  assert.equal(decisionKeyHint(KEY), '…WXYZ')
  assert.equal(decisionKeyHint('short'), null)
})

test('a saved key survives reopening, stays private and never reaches logs', posixOnly, t => {
  const { dataDir, file, logs, open } = fixture(t)
  const store = open()
  assert.equal(store.status, 'missing')
  assert.equal(store.getApiKey(), null)
  assert.equal(store.save(KEY), true)
  assert.equal(store.status, 'configured')
  assert.equal(store.hint(), '…WXYZ')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(statSync(dataDir).mode & 0o777, 0o700)
  const again = open()
  assert.equal(again.status, 'configured')
  assert.equal(again.getApiKey(), KEY)
  assert.equal(again.savedAt(), 1_795_000_000_000)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, provider: 'openai', apiKey: KEY, savedAt: 1_795_000_000_000 })
  assert.deepEqual(readdirSync(dataDir), [DECISION_CREDENTIAL_FILE])
  assert.equal(again.clear(), true)
  assert.equal(again.status, 'missing')
  assert.equal(open().getApiKey(), null)
  assert.ok(logs.every(line => !line.includes(KEY)))
})

test('an implausible key is refused with a fixed message', t => {
  const { open } = fixture(t)
  const store = open()
  for (const bad of ['', 'short', 'has a space 0123456789abcdef', 42]) {
    assert.throws(() => store.save(bad), error => error instanceof TypeError && error.message === 'Not a plausible decision model API key')
  }
  assert.equal(store.getApiKey(), null)
})

test('a damaged file is set aside and a newer version is left alone', posixOnly, t => {
  const { dataDir, file, logs, open, plant } = fixture(t)
  plant('not json')
  const recovered = open()
  assert.equal(recovered.status, 'recovered')
  assert.equal(recovered.getApiKey(), null)
  assert.ok(readdirSync(dataDir).some(name => name.startsWith(`${DECISION_CREDENTIAL_FILE}.corrupt-`)))
  plant(JSON.stringify({ version: 9, provider: 'openai', apiKey: KEY }))
  const newer = open()
  assert.equal(newer.status, 'unsupported')
  assert.equal(newer.writable, false)
  assert.equal(newer.save(KEY), false)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 9)
  assert.ok(logs.every(line => !line.includes(KEY)))
})

test('a group-readable file or a symlink is not trusted', posixOnly, t => {
  const { root, file, open, plant } = fixture(t)
  plant(JSON.stringify({ version: 1, provider: 'openai', apiKey: KEY, savedAt: 1 }), 0o644)
  const loose = open()
  assert.equal(loose.status, 'recovered')
  assert.equal(loose.getApiKey(), null)
  const elsewhere = path.join(root, 'elsewhere.json')
  writeFileSync(elsewhere, JSON.stringify({ version: 1, provider: 'openai', apiKey: KEY, savedAt: 1 }), { mode: 0o600 })
  rmSync(file, { force: true })
  symlinkSync(elsewhere, file)
  const linked = open()
  assert.equal(linked.getApiKey(), null)
  assert.notEqual(linked.status, 'configured')
})

test('a directory others can read keeps the decision model off', posixOnly, t => {
  const { dataDir, open } = fixture(t)
  mkdirSync(dataDir, { recursive: true, mode: 0o755 })
  chmodSync(dataDir, 0o755)
  const store = open()
  assert.equal(store.status, 'unavailable')
  assert.equal(store.writable, false)
  assert.equal(store.save(KEY), false)
  assert.equal(store.clear(), false)
})

test('default Gemini key file is found through a dataDir spelled with different case; symlinked key file is refused', posixOnly, t => {
  const root = createPrivateQaTempDirectory('egdesk-decision-keyfile-case-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const real = path.join(root, 'Data', 'settings')
  const wrong = path.join(root, 'data', 'settings')
  mkdirSync(real, { recursive: true, mode: 0o700 })
  let insensitive = true
  try { statSync(wrong) } catch { insensitive = false }
  const keyText = `GEMINI_API_KEY=${'A'.repeat(39)}\n`
  const name = 'gemini-decision-key.txt'
  if (insensitive) {
    writeFileSync(path.join(real, name), keyText, { mode: 0o600 }); chmodSync(path.join(real, name), 0o600)
    const store = openDecisionCredentialStore({ dataDir: wrong, provider: 'gemini', keyFileName: name, log: () => {} })
    assert.equal(store.status, 'configured')
    assert.equal(store.getApiKey(), 'A'.repeat(39))
  } else t.diagnostic('case-sensitive volume: case-mismatch part skipped')
  const linkDir = path.join(root, 'link-settings')
  mkdirSync(linkDir, { mode: 0o700 })
  const target = path.join(root, 'target.txt')
  writeFileSync(target, keyText, { mode: 0o600 })
  symlinkSync(target, path.join(linkDir, name))
  const refused = openDecisionCredentialStore({ dataDir: linkDir, provider: 'gemini', keyFileName: name, log: () => {} })
  assert.equal(refused.getApiKey(), null)
  // A user-provided non-canonical keyFile stays refused.
  if (insensitive) {
    const explicit = openDecisionCredentialStore({ dataDir: path.join(root, 'other'), provider: 'gemini', keyFile: path.join(wrong, name), log: () => {} })
    assert.equal(explicit.getApiKey(), null)
  }
})
