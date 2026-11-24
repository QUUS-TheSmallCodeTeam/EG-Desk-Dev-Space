// L4 cycle 23: the briefing output bindings persist in the bridge's own data dir (ids, kinds, material-key hashes, versions, content hashes only).
// Synthetic: a temporary directory; no network, no Firefox.
import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BINDINGS_FILE, BINDINGS_LIMITS, cleanBinding, openBriefingBindings } from './egdesk-briefing-bindings.mjs'
import { continuedBriefingOutput } from './egdesk-briefing-flow.mjs'

const tmp = t => { const d = mkdtempSync(path.join(os.tmpdir(), 'egd-bind-')); t.after(() => rmSync(d, { recursive: true, force: true })); return path.join(d, 'briefing') }
const id = n => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`
const K = n => 'a'.repeat(31) + String(n % 10), FP = n => 't:' + 'b'.repeat(31) + String(n % 10)
const binding = (over = {}) => ({ keys: [K(1), FP(2)], trait: 'compare', component: 'result_compare', outputKey: 'briefing-0a1b2c3d4e', conversationId: 'conv-1', version: 1, hash: 'c'.repeat(64), ...over })
const quiet = () => {}

test('bindings survive a restart: the same Map after reopening; the version chain continues from the reopened store', t => {
  const dir = tmp(t)
  const a = openBriefingBindings({ dataDir: dir, log: quiet }); assert.equal(a.status, 'missing')
  a.set(id(1), binding()); a.set(id(2), binding({ trait: 'open_items', component: 'result_lines', outputKey: 'briefing-ffff000011', keys: [K(4)] }))
  const b = openBriefingBindings({ dataDir: dir, log: quiet }) // the bridge restarted
  assert.equal(b.status, 'saved'); assert.deepEqual([...b.keys()], [id(1), id(2)])
  assert.deepEqual({ ...b.get(id(1)), at: 0 }, { ...binding(), at: 0 })
  assert.deepEqual(continuedBriefingOutput(b, { materialKeys: [FP(2), K(9)], trait: 'compare', component: 'result_compare' }, 'conv-1'), { outputId: id(1), outputKey: 'briefing-0a1b2c3d4e' })
})
test('on disk: 0700 dir, 0600 file, ids / closed kinds / key hashes / versions / content hashes only; a row with text or an unknown field is never kept', t => {
  const dir = tmp(t), m = openBriefingBindings({ dataDir: dir, log: quiet })
  m.set(id(1), binding())
  m.set(id(2), { ...binding(), title: 'A사 견적서 v1 → v2' }); m.set(id(3), binding({ keys: ['A사 견적서 v1'] })); m.set(id(4), binding({ trait: 'table' })); m.set('not-an-id', binding())
  assert.deepEqual([...m.keys()], [id(1)], 'a title, a material text as a key, an unknown kind or a bad id: refused')
  assert.equal(statSync(dir).mode & 0o777, 0o700); assert.equal(statSync(path.join(dir, BINDINGS_FILE)).mode & 0o777, 0o600)
  const text = readFileSync(path.join(dir, BINDINGS_FILE), 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(text).bindings[0][1]).sort(), ['at', 'component', 'conversationId', 'hash', 'keys', 'outputKey', 'trait', 'version'])
  assert.doesNotMatch(text, /[가-힣]|title|markdown|text/); assert.deepEqual(readdirSync(dir), [BINDINGS_FILE], 'written atomically: no temporary file left')
  assert.equal(cleanBinding({ ...binding(), hash: 'not-a-hash' }).hash, null); assert.equal(cleanBinding({ ...binding(), version: 0 }).version, null)
})
test('bounded and pruned: per conversation, in total, by age; forgetConversation drops a conversation (also on disk)', async t => {
  const dir = tmp(t); let clock = 1_000_000_000_000
  const m = openBriefingBindings({ dataDir: dir, log: quiet, now: () => clock })
  for (let i = 1; i <= BINDINGS_LIMITS.perConversation + 5; i++) m.set(id(i), binding({ outputKey: `briefing-${String(i).padStart(4, '0')}` }))
  assert.equal(m.size, BINDINGS_LIMITS.perConversation); assert.ok(!m.has(id(1)) && m.has(id(BINDINGS_LIMITS.perConversation + 5)), 'the oldest of that conversation go first')
  for (let i = 0; i < 9; i++) for (let j = 0; j < 60; j++) m.set(id(1000 + i * 100 + j), binding({ conversationId: `conv-${i + 2}` }))
  assert.equal(m.size, BINDINGS_LIMITS.maxEntries)
  m.set(id(5000), binding({ conversationId: 'conv-z' }))
  assert.equal(m.forgetConversation('conv-z'), 1); assert.equal(m.has(id(5000)), false)
  assert.equal(openBriefingBindings({ dataDir: dir, log: quiet, now: () => clock }).has(id(5000)), false, 'pruned on disk too')
  clock += (BINDINGS_LIMITS.retentionDays + 1) * 86400000
  m.set(id(9999), binding({ conversationId: 'conv-late' })); assert.deepEqual([...m.keys()], [id(9999)], 'older than the retention: gone at the next write')
})
test('a broken, newer, foreign or unsafe file only means nothing is kept on disk; the Map still works in memory', t => {
  const dir = tmp(t); mkdirSync(dir, { recursive: true, mode: 0o700 }); const logged = []
  writeFileSync(path.join(dir, BINDINGS_FILE), '{not json', { mode: 0o600 })
  const broken = openBriefingBindings({ dataDir: dir, log: m => logged.push(m) }); assert.equal(broken.status, 'recovered'); assert.ok(readdirSync(dir).some(f => f.startsWith(`${BINDINGS_FILE}.corrupt-`)))
  broken.set(id(1), binding()); assert.equal(openBriefingBindings({ dataDir: dir, log: quiet }).size, 1)
  const newer = tmp(t); mkdirSync(newer, { recursive: true, mode: 0o700 }); writeFileSync(path.join(newer, BINDINGS_FILE), JSON.stringify({ version: 99, bindings: [] }), { mode: 0o600 })
  const n2 = openBriefingBindings({ dataDir: newer, log: quiet }); assert.equal(n2.status, 'unsupported'); n2.set(id(1), binding()); assert.equal(n2.size, 1)
  assert.equal(JSON.parse(readFileSync(path.join(newer, BINDINGS_FILE), 'utf8')).version, 99, 'a newer file is left as is')
  const open = tmp(t); mkdirSync(open, { recursive: true, mode: 0o700 }); writeFileSync(path.join(open, BINDINGS_FILE), JSON.stringify({ version: 1, bindings: [] })); chmodSync(path.join(open, BINDINGS_FILE), 0o644)
  assert.equal(openBriefingBindings({ dataDir: open, log: quiet }).status, 'recovered', 'a readable-by-others file is not trusted')
  const real = tmp(t); mkdirSync(real, { recursive: true, mode: 0o700 }); const link = `${real}-link`; symlinkSync(real, link); t.after(() => rmSync(link, { force: true }))
  const viaLink = openBriefingBindings({ dataDir: link, log: quiet }); assert.equal(viaLink.status, 'unavailable'); viaLink.set(id(1), binding()); assert.equal(viaLink.size, 1)
  assert.equal(existsSync(path.join(real, BINDINGS_FILE)), false)
  assert.equal(openBriefingBindings({ dataDir: 'relative/dir', log: quiet }).status, 'unavailable')
})
