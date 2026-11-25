// Cycle 43: the owner's exclusion of private-folder conversations from simulation scenarios. SYNTHETIC names only (a made-up folder and a made-up term): no real folder or project name is in this file.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { main as examplesMain } from '../scripts/egdesk-conversation-examples.mjs'
import { EXCLUDE_ENV, createOwnerExclusions, defaultExcludeFile, loadOwnerExclusions } from './egdesk-scenario-exclusion.mjs'
import { createSeedGuard, loadSeedGuard, seedRefusal } from './egdesk-scenario-seed-guard.mjs'

const PRIVATE_DIR = '/work/zz-private-sandbox', TERM = 'zz-synthetic-term'
const tmp = t => { const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-excl-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
const put = (dir, name, value) => { const f = path.join(dir, name); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, typeof value === 'string' ? value : value.map(r => JSON.stringify(r)).join('\n') + '\n'); return f }
const codex = (cwd, tag, term = '') => [
  { type: 'session_meta', payload: { cwd, id: `s-${tag}` } },
  { type: 'response_item', timestamp: '2026-11-01T01:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${tag} 보드 정리 기능 만들어줘 ${term}` }] } },
  { type: 'response_item', timestamp: '2026-11-01T01:01:00Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${tag} 정리 기능을 넣었습니다. 진행할까요?` }] } },
  { type: 'response_item', timestamp: '2026-11-01T01:02:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${tag} 아니 그거 말고 다른 안으로 ${term}` }] } },
  { type: 'response_item', timestamp: '2026-11-01T01:03:00Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${tag} 다른 안으로 바꾸겠습니다. 계속할까요?` }] } },
  { type: 'response_item', timestamp: '2026-11-01T01:04:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${tag} 왜 또 물어? 그냥 진행해 ${term}` }] } },
]
const claude = (cwd, tag) => [
  { type: 'user', cwd, timestamp: '2026-11-02T01:00:00Z', message: { content: `${tag} 온톨로지 후보 정리해줘` } },
  { type: 'assistant', cwd, timestamp: '2026-11-02T01:01:00Z', message: { content: [{ type: 'text', text: `${tag} 후보 3건을 정리했습니다. A안과 B안 중 고르시면 됩니다.` }] } },
  { type: 'user', cwd, timestamp: '2026-11-02T01:02:00Z', message: { content: `${tag} a안 안보여. 무슨 대체 문구?` } },
  { type: 'assistant', cwd, timestamp: '2026-11-02T01:03:00Z', message: { content: [{ type: 'text', text: `${tag} 다시 보여 드리겠습니다.` }] } },
  { type: 'user', cwd, timestamp: '2026-11-02T01:04:00Z', message: { content: `${tag} 그래` } },
]
const run = async (argv, home) => { const lines = [], errors = []; const code = await examplesMain(argv, { print: l => lines.push(l), printError: l => errors.push(l), home }); return { code, errors, out: lines.length ? JSON.parse(lines.at(-1)) : null } }
const walkFiles = dir => readdirSync(dir).flatMap(n => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walkFiles(p) : [p] })

test('the exclusion object: a session folder at or under a prefix (path-segment boundary), a Claude project folder named for it, a term in any text (NFKC, case-insensitive)', () => {
  const ex = createOwnerExclusions({ excludeCwdPrefixes: [PRIVATE_DIR, '~/zz-home-private'], excludeTerms: [TERM] }, '/home/zz')
  assert.equal(ex.active, true); assert.deepEqual(ex.counts, { cwdPrefixes: 2, terms: 1 })
  assert.deepEqual([PRIVATE_DIR, `${PRIVATE_DIR}/app/src`, `${PRIVATE_DIR}-other`, '/work/zz-private', '/home/zz/zz-home-private/x', '/home/zz/other'].map(c => ex.cwdExcluded(c)), [true, true, false, false, true, false])
  assert.deepEqual([undefined, null, ''].map(c => ex.cwdExcluded(c)), [false, false, false])
  assert.deepEqual(['-work-zz-private-sandbox', '-work-zz-private-sandbox-EG-Desk-copy', '-work-zz-private-sandboxes', '-work-EG-Desk-Dev-Space', '-work-x-zz-synthetic-term-y'].map(n => ex.projectDirExcluded(n)), [true, true, false, false, true])
  assert.deepEqual([`about ${TERM.toUpperCase()} here`, 'ＺＺ-synthetic-term', 'nothing'].map(x => ex.textExcluded(x)), [true, true, false])
  assert.equal(createOwnerExclusions().active, false); assert.equal(createOwnerExclusions().textExcluded('anything'), false)
})

test('the local file: absent = nothing excluded, a path by option, by EGDESK_SCENARIO_EXCLUDE, or the default under the home folder; unreadable or malformed = an error that never prints the content', t => {
  const dir = tmp(t), file = put(dir, 'local/exclude.json', JSON.stringify({ excludeCwdPrefixes: [PRIVATE_DIR], excludeTerms: [TERM] }))
  assert.equal(loadOwnerExclusions({ env: {}, home: dir }).active, false, 'no file at the default path')
  assert.equal(loadOwnerExclusions({ env: {}, file, home: dir }).textExcluded(TERM), true)
  assert.equal(loadOwnerExclusions({ env: { [EXCLUDE_ENV]: file }, home: dir }).cwdExcluded(`${PRIVATE_DIR}/x`), true)
  const fileAtDefault = defaultExcludeFile(dir); mkdirSync(path.dirname(fileAtDefault), { recursive: true }); writeFileSync(fileAtDefault, JSON.stringify({ excludeTerms: [TERM] }))
  assert.equal(loadOwnerExclusions({ env: {}, home: dir }).textExcluded(TERM), true, 'the default path'); assert.ok(fileAtDefault.startsWith(dir), 'under the given home folder')
  for (const bad of ['{ nope', '[]', JSON.stringify({ excludeTerms: 'x' }), JSON.stringify({ excludeTerms: ['a'] }), JSON.stringify({ other: [] }), JSON.stringify({ excludeCwdPrefixes: [1] })]) {
    const f = put(dir, 'bad.json', bad)
    assert.throws(() => loadOwnerExclusions({ env: {}, file: f, home: dir }), error => { assert.doesNotMatch(error.message, new RegExp(TERM)); return /owner exclusion file/.test(error.message) }, bad)
  }
})

test('the extractor drops the sessions under the prefix and the examples with the term, counts them (counts only), and keeps nothing of them on disk', async t => {
  const dir = tmp(t), exclude = put(dir, 'local/exclude.json', JSON.stringify({ excludeCwdPrefixes: [PRIVATE_DIR], excludeTerms: [TERM] }))
  const sessions = (root, withPrivate) => {
    put(root, 'codex/2026/11/01/rollout-a.jsonl', codex('/work/EG-Desk-Dev-Space', 'A'))
    put(root, 'claude/-work-Taehwa-backup/d.jsonl', claude('/work/Taehwa_backup', 'D'))
    if (withPrivate) {
      put(root, 'codex/2026/11/01/rollout-b.jsonl', codex(`${PRIVATE_DIR}/app`, 'B'))
      put(root, 'codex/2026/11/01/rollout-c.jsonl', codex('/work/EG-Desk-Dev-Space', 'C', TERM))
      put(root, 'claude/-work-zz-private-sandbox-EG-Desk-copy/e.jsonl', claude(`${PRIVATE_DIR}/EG-Desk-copy`, 'E'))
    }
  }
  const all = path.join(dir, 'all'), clean = path.join(dir, 'clean'); sessions(all, true); sessions(clean, false)
  const args = (root, out, more = []) => ['--out', out, '--codex', path.join(root, 'codex'), '--claude', path.join(root, 'claude'), '--pinned', path.join(root, 'none'), ...more]
  const none = await run(args(all, path.join(dir, 'out-none'), ['--exclude', path.join(dir, 'does-not-exist.json')]), dir)
  assert.equal(none.code, 0, none.errors.join('\n')); assert.deepEqual(none.out.excludedByOwner, { sessions: 0, examples: 0 })
  const only = await run(args(clean, path.join(dir, 'out-clean')), dir)
  assert.equal(only.code, 0, only.errors.join('\n'))
  const out = path.join(dir, 'out-excl'), ex = await run(args(all, out, ['--exclude', exclude]), dir)
  assert.equal(ex.code, 0, ex.errors.join('\n'))
  assert.equal(ex.out.excludedByOwner.sessions, 3, 'the codex session under the prefix, the one that carries the term (a session that mentions it is dropped whole, file name included) and the Claude project folder under the prefix'); assert.equal(ex.out.excludedByOwner.examples, 0, 'nothing is left for the example filter, a backstop')
  assert.equal(ex.out.examples, only.out.examples, 'what is left is exactly what the clean sessions give'); assert.ok(none.out.examples > ex.out.examples)
  const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'))
  assert.deepEqual(manifest.excludedByOwner, ex.out.excludedByOwner); assert.deepEqual(Object.keys(manifest.excludedByOwner).sort(), ['examples', 'sessions'])
  // nothing of the excluded material anywhere in the output: not the folder, not the term, not the files they came from, not their text
  const written = walkFiles(out).map(f => `${f}\n${readFileSync(f, 'utf8')}`).join('\n')
  for (const word of ['zz-private-sandbox', TERM, 'rollout-b', 'rollout-c', 'e.jsonl', 'B 보드', 'C 보드', 'E 온톨로지']) assert.ok(!written.includes(word), word)
  assert.ok(manifest.sources.every(s => !/rollout-b|rollout-c|zz-private/.test(s.file)))
  // an option or file that is wrong is a refusal, not a silent "nothing excluded"
  const bad = put(dir, 'bad.json', '{ nope'), refused = await run(args(all, path.join(dir, 'out-bad'), ['--exclude', bad]), dir)
  assert.equal(refused.code, 2); assert.match(refused.errors.join(' '), /owner exclusion file/)
  // with exclusions in force, --since cannot re-check what an earlier run kept: refused when a manifest exists
  const since = await run(args(all, out, ['--exclude', exclude, '--since', '2026-01-01']), dir)
  assert.equal(since.code, 2); assert.match(since.errors.join(' '), /--since/)
})

test('the seed guard refuses a body that carries a term of the local file, without repeating the term; without the file nothing changes; a plan that declares owner-approved seeds is judged as before', t => {
  const dir = tmp(t), file = put(dir, 'local/exclude.json', JSON.stringify({ excludeTerms: [TERM] })), ex = loadOwnerExclusions({ env: {}, file, home: dir })
  const guard = createSeedGuard([], { exclusions: ex })
  const refusal = guard.check(JSON.stringify({ input: [{ role: 'user', content: `please look at ${TERM} now` }] }))
  assert.match(refusal, /owner excluded/); assert.ok(!refusal.includes(TERM))
  assert.equal(guard.check(JSON.stringify({ input: [{ role: 'user', content: 'a plain request' }] })), null)
  assert.match(guard.check('{}', [{ id: 'x', privacy: 'local-only' }]), /only owner-approved seeds/, 'the declared-seed rule is unchanged')
  assert.equal(createSeedGuard([]).check(`mentions ${TERM}`), null, 'no exclusions, no refusal')
  // loadSeedGuard: a guard exists whenever the exclusions are active, even with no seed directory; no seeds and no exclusions is still null
  assert.ok(loadSeedGuard({ env: {}, home: dir, dirs: [], exclusions: ex }))
  assert.equal(loadSeedGuard({ env: {}, home: dir, dirs: [] }), null)
  // seedRefusal reads the file named by the environment variable
  const before = process.env[EXCLUDE_ENV]; process.env[EXCLUDE_ENV] = file; t.after(() => { if (before === undefined) delete process.env[EXCLUDE_ENV]; else process.env[EXCLUDE_ENV] = before })
  assert.match(seedRefusal(`... ${TERM} ...`), /owner excluded/); assert.equal(seedRefusal('a plain body'), null)
})
