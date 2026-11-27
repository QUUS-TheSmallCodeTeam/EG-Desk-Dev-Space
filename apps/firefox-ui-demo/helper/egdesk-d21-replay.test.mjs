// u7 (D21, a real window run): after "응 그렇게 해" Claude added a start script to package.json with EG-Desk's edit tool (the file really changed), then said it had. The check read package.json as the turn-start text the
// context step had put in front of the engine (without the script), took the true "추가했습니다" for a contradiction, and the revision said the change could not be seen. A file EG-Desk's own edit tool changed in the
// turn is read as it is NOW. Replays on lane L5's world (real runtime, adapter and tools; the CLI is a script; the Decision model is a scripted fetch that judges from the evidence it is shown). Nothing real runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { harnessWorld, result, text, toolUse, userResult } from './egdesk-claude-harness.fixture.mjs'
import { readNowWorkspaceFile } from './egdesk-prefetch.mjs'

const BEFORE = '{\n  "name": "demo",\n  "scripts": { "test": "node --test" }\n}\n'
const SENTENCE = 'package.json에 start 스크립트를 추가했습니다.'
const edit = { path: 'package.json', mode: 'replace', oldString: '"test": "node --test"', newString: '"test": "node --test", "start": "node index.js"' }
const settle = async (w, a) => { await w.settled(a); await new Promise(r => setTimeout(r, 500)); await w.drain() }
const supAsks = w => w.sup ?? []
/** Supported only when a word of the sentence is in the evidence the check is shown ("start" is in the file after the edit, not before). */
function evidenceJudge(w) {
  w.sup = []
  const base = w.chat.decisionContext.client
  w.chat.decisionContext.client = Object.create(base, { decide: { enumerable: true, value: async req => {
    if (!req.questions.some(q => /^sup_/.test(q.name))) return base.decide(req)
    w.sup.push({ questions: req.questions, input: req.input })
    const evidence = req.input.map(m => String(m.content)).filter(c => c.startsWith('Evidence:')).join('\n')
    return { answers: Object.fromEntries(req.questions.map(q => [q.name, { name: q.name, type: 'predicate', probability: /^sup_/.test(q.name) ? (/start/.test(evidence) ? 0.96 : 0.03) : 0.02 }])), usage: { input_tokens: 10 } }
  } } })
}
const world = (t, script, extra = {}) => {
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on' }, judge: {}, project: { 'package.json': BEFORE, 'NOTES.md': '# 메모\n일반 메모입니다.\n' }, turnMemory: { prefetch: 'files' }, script, ...extra })
  w.chat.decisionContext.draftCheck.fileText = () => true; evidenceJudge(w); return w
}
const editedTurn = n => [toolUse('toolu_1', 'egdesk_edit_file', edit), { tool: { name: 'egdesk_edit_file', arguments: edit } }, userResult('toolu_1'), ...text(n, SENTENCE), ...result()]
const evidenceShown = w => JSON.stringify(supAsks(w).at(-1)?.input ?? [])

test('D21: the file EG-Desk edited in this turn is read as it is NOW: "추가했습니다" is supported by the new text and posted as written (the turn-start text without the script is not evidence)', async t => {
  const w = world(t, n => (n === 1 ? editedTurn(n) : [...text(n, 'x'), ...result()]))
  const a = await w.send('package.json에 start 스크립트 추가해 줘'); await settle(w, a)
  assert.ok(fs.readFileSync(path.join(w.root, 'package.json'), 'utf8').includes('"start"'), 'the file really changed')
  assert.deepEqual(w.posted().map(p => p[1]), [SENTENCE]); const shown = evidenceShown(w)
  assert.match(shown, /as it is now, after the edit made in this turn/); assert.match(shown, /node index\.js/); assert.equal((shown.match(/package\.json — /g) ?? []).length, 1, 'one item for the file: the stale one is replaced, not kept beside it')
})

test('control (before the fix this is what happened): the same turn with the turn-start text as evidence cuts the true sentence, here by keeping the stale item (the edit refresh off)', async t => {
  const w = world(t, n => (n === 1 ? editedTurn(n) : [...text(n, 'x'), ...result()]))
  w.chat.refreshEditedFiles = async (run, evidence) => evidence // the old behavior
  const a = await w.send('package.json에 start 스크립트 추가해 줘'); await settle(w, a)
  assert.deepEqual(w.posted(), [], 'unsupported by the stale text: cut'); assert.doesNotMatch(evidenceShown(w), /"start"/)
})

test('a turn without an edit is exactly as before: the turn-start text is the evidence, and a sentence about it is judged against it', async t => {
  const w = world(t, n => [...text(n, 'package.json에는 test 스크립트가 있습니다. 이 스크립트는 start를 쓰지 않습니다.'), ...result()])
  const a = await w.send('package.json 설명해 줘'); await settle(w, a)
  const shown = evidenceShown(w); assert.doesNotMatch(shown, /as it is now/); assert.match(shown, /node --test/)
})

test('an edit to ANOTHER file leaves this file\'s item alone, and the edited file\'s item is the one refreshed', async t => {
  const notes = { path: 'NOTES.md', mode: 'replace', oldString: '일반 메모입니다.', newString: '일반 메모입니다. 수정됨.' }
  const w = world(t, n => (n === 1 ? [toolUse('toolu_1', 'egdesk_edit_file', notes), { tool: { name: 'egdesk_edit_file', arguments: notes } }, userResult('toolu_1'), ...text(n, 'package.json에는 test 스크립트가 있고 NOTES.md를 수정했습니다.'), ...result()] : [...text(n, 'x'), ...result()]))
  const a = await w.send('NOTES.md 고치고 package.json도 설명해 줘'); await settle(w, a)
  const shown = evidenceShown(w); assert.match(shown, /node --test/, 'package.json: turn-start text kept'); assert.match(shown, /수정됨/, 'NOTES.md: as it is now')
  assert.equal((shown.match(/as it is now/g) ?? []).length <= 1, true)
})

test('an edited file that cannot be read now is dropped from the evidence, never kept stale; and the refresh is for the file evidence only (flag off: no file item at all)', async t => {
  const w = world(t, n => [...text(n, 'x'), ...result()])
  const item = { id: 'workspace:gone.txt', kind: 'file', text: 'gone.txt — 4 bytes\nold' }, other = { id: 'doc:a', kind: 'document', text: 'a' }
  const run = { ownFolder: w.root, ownEdits: [{ path: 'gone.txt', state: 'applied' }] }
  assert.deepEqual(await w.chat.refreshEditedFiles(run, [item, other]), [other])
  assert.deepEqual(await w.chat.refreshEditedFiles({ ownFolder: w.root, ownEdits: [] }, [item, other]), [item, other], 'no edit: untouched')
  assert.deepEqual(await w.chat.refreshEditedFiles({ ownEdits: [{ path: 'gone.txt' }] }, [item]), [item], 'no bound folder: untouched')
  assert.deepEqual(await w.chat.refreshEditedFiles(run, [other]), [other])
})

test('readNowWorkspaceFile: inside the folder only, regular text files only, the first bytes', async t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR ?? '/tmp'), 'egdesk-d21-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'a.txt'), '본문'); fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([65, 0, 66])); fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), '하위')
  fs.writeFileSync(path.join(path.dirname(dir), `${path.basename(dir)}-outside.txt`), 'outside'); t.after(() => fs.rmSync(path.join(path.dirname(dir), `${path.basename(dir)}-outside.txt`), { force: true }))
  assert.equal(await readNowWorkspaceFile(dir, 'a.txt'), '본문'); assert.equal(await readNowWorkspaceFile(dir, './sub/b.txt'), '하위')
  assert.equal(await readNowWorkspaceFile(dir, 'bin.dat'), null); assert.equal(await readNowWorkspaceFile(dir, `../${path.basename(dir)}-outside.txt`), null); assert.equal(await readNowWorkspaceFile(dir, 'sub'), null); assert.equal(await readNowWorkspaceFile(dir, 'nope.txt'), null); assert.equal(await readNowWorkspaceFile(dir, ''), null)
  fs.symlinkSync(path.join(path.dirname(dir), `${path.basename(dir)}-outside.txt`), path.join(dir, 'link.txt')); assert.equal(await readNowWorkspaceFile(dir, 'link.txt'), null, 'a link out of the folder')
})
