// c30b: the edits EG-Desk made are readable evidence for the check of the answer (Main's check-20ct: the fix sentence of a true answer was rejected because the edit records were opaque,
// and the rewrite hedged a true fact). Exact record shape from the real file tool provider, the evidence text, the rule on edit claims with its negatives, and the runtime.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createFileToolsProvider } from './egdesk-file-tools.mjs'
import { OWN_EDIT_LIMITS, ownEditEvidence, ownEditFact } from './egdesk-own-edit-evidence.mjs'
import { claimsEdit, editClaimFindings, runFactFindings } from './egdesk-draft-run-facts.mjs'
import { checkDraft } from './egdesk-draft-check.mjs'
import { createOwnToolsWiring } from './egdesk-own-tools-wiring.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const SECRET_LINE = 'return Math.floor(SECRET_CODE_LINE_77)'
const tmp = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-own-edit-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }

async function realProvider(t) {
  const root = tmp(t); fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src', 'price.mjs'), `export function f(a) {\n  ${SECRET_LINE}\n}\n`); fs.writeFileSync(path.join(root, 'notes.txt'), 'x\n')
  const facts = [], provider = createFileToolsProvider({ mode: () => 'on', workspaceOf: () => root, onEdit: (run, fact) => facts.push(fact) })
  const run = { answerId: 'a1', runId: 'r1', conversationId: 'c1' }
  const call = (arguments_, tool = 'egdesk_edit_file', callId = `c${facts.length}-${Math.random()}`) => provider.dispatch(run, { callId, tool, arguments: arguments_ })
  return { root, facts, call, provider }
}

test('the fact of each edit tool call is read from the tool\'s own response: preview, applied (with the undo record id), undone, and the calls that changed nothing', async t => {
  const w = await realProvider(t)
  const edit = { path: 'src/price.mjs', mode: 'replace', oldString: 'Math.floor(SECRET_CODE_LINE_77)', newString: 'Math.round(SECRET_CODE_LINE_77)' }
  await w.call({ ...edit, dryRun: true }); await w.call(edit); await w.call({}, 'egdesk_undo_edit')
  await w.call({ path: 'src/price.mjs', mode: 'replace', oldString: 'nothing like this', newString: 'x' })  // refused or stale: not applied
  await w.call({}, 'egdesk_undo_edit', 'c-undo-2') // nothing left to undo
  await w.call({ path: 'src/price.mjs' }, 'egdesk_read_file') // a read is no edit
  assert.deepEqual(w.facts.map(f => [f.tool, f.state, f.status, f.path, f.kind, f.editId, f.added, f.removed, f.hunks]), [
    ['egdesk_edit_file', 'previewed', 'preview', 'src/price.mjs', 'update', null, 1, 1, 1],
    ['egdesk_edit_file', 'applied', 'edited', 'src/price.mjs', 'update', 'edit-1', 1, 1, 1],
    ['egdesk_undo_edit', 'undone', 'undone', 'src/price.mjs', null, 'edit-1', 0, 0, 0],
    ['egdesk_edit_file', 'not_applied', 'refused', null, null, null, 0, 0, 0],
    ['egdesk_undo_edit', 'not_undone', 'nothing_to_undo', null, null, null, 0, 0, 0],
  ]); assert.ok(w.facts.every(f => Object.isFrozen(f)))
  assert.equal(JSON.stringify(w.facts).includes('SECRET_CODE_LINE_77'), false, 'no line of the file or of the diff is in a fact'); assert.equal(fs.readFileSync(path.join(w.root, 'src', 'price.mjs'), 'utf8').includes('Math.floor'), true, 'undone: the file is back')
  assert.deepEqual(Object.keys(w.facts[1]).sort(), ['added', 'editId', 'hunks', 'kind', 'path', 'removed', 'restored', 'state', 'status', 'tool'])
  // shapes that are not an edit tool's own answer give nothing
  assert.equal(ownEditFact('egdesk_read_file', { success: true, contentItems: [{ type: 'inputText', text: '{"status":"read"}' }] }), null); assert.equal(ownEditFact('egdesk_edit_file', { success: false, contentItems: [] }), null)
  assert.equal(ownEditFact('egdesk_edit_file', { success: true, contentItems: [{ type: 'inputText', text: 'not json' }] }), null); assert.equal(ownEditFact('egdesk_edit_file', null), null)
  assert.equal(ownEditFact('egdesk_edit_file', { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ status: 'edited', path: 'a\nb', editId: 'bad id!' }) }] }).path, null, 'an odd path or id is dropped')
  assert.ok(OWN_EDIT_LIMITS.edits >= 8)
})

const fact = (state, extra = {}) => ({ tool: state === 'undone' ? 'egdesk_undo_edit' : 'egdesk_edit_file', state, status: state === 'applied' ? 'edited' : state, path: 'src/price.mjs', kind: 'update', editId: 'edit-1', added: 1, removed: 1, hunks: 1, restored: null, ...extra })
const items = (...facts) => facts.map((f, i) => ownEditEvidence(f, i, facts))

test('the evidence text says what each call did, and for an applied edit whether it was taken back; the item is readable run state with the facts beside it', () => {
  const [applied] = items(fact('applied'))
  assert.deepEqual([applied.id, applied.kind, applied.time, applied.source, applied.pinned], ['edit1', 'run_state', 'present', 'run', true]); assert.deepEqual(applied.facts, { kind: 'own_edit', tool: 'egdesk_edit_file', state: 'applied', path: 'src/price.mjs', editId: 'edit-1', added: 1, removed: 1 })
  assert.equal(applied.text, 'In this turn the assistant changed `src/price.mjs` with EG-Desk\'s own edit tool (update: 1 line added, 1 line removed, 1 hunk); the change was written to the file and an undo record (edit-1) exists, and it was not undone afterwards in this turn.')
  assert.match(items(fact('previewed'))[0].text, /previewed a change to `src\/price\.mjs` with the dryRun option \(update: 1 line added, 1 line removed, 1 hunk\); a preview writes nothing: the file was not changed by this call\./)
  assert.match(items(fact('applied'), fact('undone'))[0].text, /and a later undo in this turn took it back\./); assert.match(items(fact('applied'), fact('undone'))[1].text, /undid the earlier edit edit-1 of `src\/price\.mjs`; the file was restored/)
  assert.match(items(fact('not_applied', { status: 'stale' }))[0].text, /it was not applied \(stale\): the file was not changed by this call\./); assert.match(items(fact('not_undone', { status: 'nothing_to_undo', path: null }))[0].text, /tried to undo an edit and it was not undone \(nothing_to_undo\)/)
  assert.match(items(fact('applied', { added: 3, removed: 0, hunks: 2, kind: 'create', editId: null }))[0].text, /\(create: 3 lines added, 0 lines removed, 2 hunks\); the change was written to the file, and it was not undone/)
})

const ev = (...facts) => items(...facts), claims = (...texts) => texts.map(text => ({ text }))
const FIX = '`src/price.mjs`의 내림을 반올림으로 수정했습니다.'

test('edit claims: a true claim is not a finding; a claim of an edit that was only previewed, undone, failed, made to another file, or never made is', () => {
  assert.deepEqual(runFactFindings({ claims: claims(FIX), evidence: ev(fact('previewed'), fact('applied')) }), [], 'previewed, then applied: true')
  assert.deepEqual(runFactFindings({ claims: claims('price.mjs를 고쳤습니다.'), evidence: ev(fact('applied')) }), [], 'the file name alone is enough')
  assert.deepEqual(runFactFindings({ claims: claims('내림을 반올림으로 고쳤습니다.'), evidence: ev(fact('applied')) }), [], 'no file named: an applied edit exists')
  const bad = (evidence, text = FIX) => runFactFindings({ claims: claims('파일을 읽었습니다.', text), evidence }).map(f => [f.kind, f.span, f.reason])
  assert.deepEqual(bad(ev(fact('previewed'))), [['contradicted', 1, 'run_facts']], 'only previewed')
  assert.deepEqual(bad(ev(fact('applied'), fact('undone'))), [['contradicted', 1, 'run_facts']], 'applied and then undone')
  assert.deepEqual(bad(ev(fact('not_applied', { status: 'stale' }))), [['contradicted', 1, 'run_facts']], 'refused or stale')
  assert.deepEqual(bad(ev(fact('applied')), '`src/other.mjs`를 수정했습니다.'), [['contradicted', 1, 'run_facts']], 'another file than the one edited')
  assert.deepEqual(bad(ev(fact('applied')), 'test/price.test.mjs를 고쳤습니다.'), [['contradicted', 1, 'run_facts']], 'a test file nobody edited')
  assert.deepEqual(bad(ev(fact('previewed')), '버그를 고쳤습니다.'), [['contradicted', 1, 'run_facts']], 'no file named and nothing was applied')
  assert.deepEqual(bad(ev(fact('applied'), fact('undone'), fact('applied', { editId: 'edit-2' }))), [], 'applied again after the undo: true')
  assert.deepEqual(bad(ev(fact('applied', { path: 'a.mjs' }), fact('previewed', { path: 'b.mjs' })), 'a.mjs와 b.mjs를 수정했습니다.'), [], 'two files named, one applied: not flagged (ambiguous)')
})

test('sentences that are not a claim of a change are never flagged: negations, plans, previews, undo, questions; and no edit facts means nothing to compare', () => {
  for (const text of ['테스트 파일은 변경하지 않았습니다.', 'dryRun 미리보기로 수정 내용을 확인했습니다.', '`src/other.mjs`도 수정할 예정입니다.', '필요하면 `src/other.mjs`를 고칠 수 있습니다.', '수정을 되돌렸습니다.', 'I did not change src/other.mjs.', 'Do you want me to edit src/other.mjs?', 'The preview shows a change to src/other.mjs.']) {
    assert.equal(claimsEdit(text), false, text); assert.deepEqual(runFactFindings({ claims: claims(text), evidence: ev(fact('previewed')) }), [], text)
  }
  for (const text of ['`src/price.mjs`를 수정했습니다.', 'I changed src/price.mjs.', 'Fixed src/price.mjs.', '반올림으로 바꿨습니다.']) assert.equal(claimsEdit(text), true, text)
  assert.deepEqual(editClaimFindings({ claims: claims('`src/other.mjs`를 수정했습니다.'), evidence: [] }), []); assert.deepEqual(editClaimFindings({ claims: claims(FIX), evidence: [{ id: 'x', kind: 'run_state', text: 'changed', opaque: false }] }), [], 'text alone is no fact')
})

const answers = (names, p) => names.map(name => ({ name, type: 'predicate', probability: p(name) }))
const model = () => ({ decide: async request => ({ answers: answers(request.questions.map(q => q.name), name => (/^sup_/.test(name) ? 0.95 : 0.03)), usage: { input_tokens: 10 } }) })

test('checkDraft: the true fix sentence passes untouched with the edit evidence; a claim of an edit that was only previewed or undone is revised, even when the model says supported', async () => {
  const read = { id: 'tool1', kind: 'tool', time: 'present', source: 'tool:dynamicToolCall', opaque: true }
  const sentence = `${FIX} 다시 돌린 테스트는 모두 통과했습니다.`
  const ok = await checkDraft({ draft: sentence, evidence: [read, ...ev(fact('previewed'), fact('applied', { editId: 'edit-2' }))], mode: 'on', client: model(), revise: async () => 'x' })
  assert.equal(ok.outcome, 'passed'); assert.equal(ok.text, sentence)
  const previewed = await checkDraft({ draft: FIX, evidence: [read, ...ev(fact('previewed'))], mode: 'on', client: model(), revise: async () => '수정은 미리보기만 했고 파일에는 적용하지 않았습니다.' })
  assert.equal(previewed.outcome, 'revised'); assert.deepEqual(previewed.findings.map(f => f.reason), ['run_facts']); assert.match(previewed.text, /미리보기만/)
  const undone = await checkDraft({ draft: FIX, evidence: [read, ...ev(fact('applied'), fact('undone'))], mode: 'on', client: model(), revise: async () => null })
  assert.equal(undone.outcome, 'withheld', 'no honest rewrite, nothing posted as if checked')
  const stubborn = await checkDraft({ draft: FIX, evidence: [read, ...ev(fact('previewed'))], mode: 'on', client: model(), revise: async () => '`src/price.mjs`를 고쳤습니다.' })
  assert.notEqual(stubborn.text, '`src/price.mjs`를 고쳤습니다.', 'a rewrite that says it again is not posted')
})

function world(t) {
  const base = tmp(t), dataDir = path.join(base, 'egdesk-data'), project = path.join(base, 'demo-app'); fs.mkdirSync(dataDir); fs.mkdirSync(path.join(project, 'src'), { recursive: true }); fs.writeFileSync(path.join(project, 'src', 'price.mjs'), 'export const f = a => Math.floor(a)\n')
  let chat = null
  const wiring = createOwnToolsWiring({ env: { EGDESK_OWN_TOOLS: 'on', PATH: '/usr/bin:/bin', HOME: '/home/synthetic' }, dataDir, spawn: () => { const c = new EventEmitter(); Object.assign(c, { pid: 1, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }); return c }, getChat: () => chat, home: '/home/synthetic', gitStatus: async () => null })
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0030', recipientForKey: () => 'a'.repeat(64), fetchImpl: async (url, init) => Response.json({ answers: JSON.parse(init.body).questions.map(q => ({ name: q.name, type: 'predicate', probability: 0.05 })), usage: { input_tokens: 20 } }) })
  const replies = []
  chat = new CodexChatRuntime({ request: async (method, params) => { if (method === 'thread/start') return { thread: { id: 'conv-1' }, cwd: params.cwd }; if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }; return {} },
    respond: (...args) => replies.push(args), emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, getOwnerKey: () => 'codex:own-edit', toolProviders: wiring.toolProviders, ownTools: wiring.ownTools,
    decisionContext: { mode: () => 'on', configured: () => true, client, calibrationLog: openCalibrationLog({ dataDir: path.join(base, 'calibration'), log: () => {} }), terminalGate: wiring.terminalGate(null) } })
  chat.setConnection(true)
  return { chat, project, replies }
}

test('end to end: the runtime keeps the run\'s edits in order and the answer\'s evidence has them as readable items in place of the references to the edit calls; a read stays a reference', async t => {
  const w = world(t)
  const sent = await w.chat.send({ message: '고쳐 줘', clientThreadId: 'ui', requestId: 'r1', cwd: w.project }), run = w.chat.runFor(sent)
  const step = async (n, tool, args) => {
    await w.chat.handleNotification({ method: 'item/started', params: { threadId: sent.conversationId, turnId: sent.runId, item: { type: 'dynamicToolCall', id: `call-${n}`, tool, status: 'inProgress', arguments: args } } })
    await w.chat.handleServerRequest({ id: `call-${n}`, method: 'item/tool/call', params: { threadId: sent.conversationId, turnId: sent.runId, callId: `call-${n}`, tool, arguments: args } })
    const end = Date.now() + 3000; while (!w.replies.some(r => r[0] === `call-${n}`) && Date.now() < end) await new Promise(r => setTimeout(r, 5))
  }
  const edit = { path: 'src/price.mjs', mode: 'replace', oldString: 'Math.floor', newString: 'Math.round' }
  await step(1, 'egdesk_read_file', { path: 'src/price.mjs' }); await step(2, 'egdesk_edit_file', { ...edit, dryRun: true }); await step(3, 'egdesk_edit_file', edit)
  assert.deepEqual(run.ownEdits.map(e => [e.state, e.path]), [['previewed', 'src/price.mjs'], ['applied', 'src/price.mjs']])
  const items = w.chat.answerFactsEvidence(run)
  assert.deepEqual(items.filter(i => /^edit\d/.test(i.id)).map(i => [i.id, i.kind, i.facts.state]), [['edit1', 'run_state', 'previewed'], ['edit2', 'run_state', 'applied']])
  assert.deepEqual(items.filter(i => i.opaque).map(i => i.source), ['tool:dynamicToolCall'], 'only the read stays a content-free reference'); assert.equal(items.length, 3)
  assert.equal(fs.readFileSync(path.join(w.project, 'src', 'price.mjs'), 'utf8'), 'export const f = a => Math.round(a)\n')
})
