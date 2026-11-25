// u5 (D18, a real window run): a normal request, "summarize the README", ended in an empty screen. The turn's context step was cut by the turn budget (context call 'aborted', activity "결정 모델 응답 없음":
// no file was put in front of the model), Claude answered from the conversation's memory of an earlier README edit, the check had nothing to compare the sentences with and called both unsupported, and with private turns on
// the rewrite was dropped (the phase-less reply fix of this round). Replays on lane L5's world: the real runtime, adapter and tools; the CLI is a script; the Decision model is a scripted fetch; nothing real runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { harnessWorld, result, text, toolUse, userResult } from './egdesk-claude-harness.fixture.mjs'

const SUMMARY = 'README는 이 프로젝트의 설치와 사용 방법을 설명합니다. README에 설치 줄이 한 줄 추가되어 있습니다.'
const FAIL = 'ℹ tests 5\nℹ suites 0\nℹ pass 3\nℹ fail 2\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 52.1\n'
const settle = async (w, a) => { await w.settled(a); await new Promise(r => setTimeout(r, 500)); await w.drain() }
const supAsks = w => w.decisionBodies.filter(b => b.questions.some(q => /^sup_/.test(q.name)))
/** The turn's context step never answers (its call is cut by the turn budget): the decision client hangs until its signal aborts. */
function cutContext(w) {
  const base = w.chat.decisionContext.client
  w.chat.decisionContext.client = Object.create(base, { decide: { enumerable: true, value: req => (req.questions.some(q => q.name === 'answer_type')
    ? new Promise((_, reject) => { const stop = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError', code: 'aborted' })); req.signal?.aborted ? stop() : req.signal?.addEventListener('abort', stop, { once: true }) })
    : base.decide(req)) } })
  w.chat.decisionContext.budgetMs = 40; w.chat.decisionContext.coldBudgetMs = 40
}
const title = (w, a) => w.runOf(a).activities.find(x => x.kind === 'decisionContext')?.title ?? ''
const NOTE = { id: 'doc:readme', kind: 'document', title: '프로젝트 노트', summary: '프로젝트 소개', timeSlice: 'present', loadText: () => 'body' } // a candidate, so the turn has a context step to cut
const world = (t, extra = {}) => harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on', EGDESK_CLAUDE_HARNESS_PRIVATE: 'on' }, judge: { unsupported: /README/ }, candidates: [NOTE], ...extra })

test('D18: with the context step cut, a sentence the check has nothing to compare with is NOT called unsupported: the answer is posted as written (before: both sentences judged unsupported, nothing posted)', async t => {
  const w = world(t, { script: n => [...text(n, SUMMARY), ...result()] }); cutContext(w)
  const a = await w.send('README 내용 요약해줘'); await settle(w, a)
  assert.match(title(w, a), /응답 없음/, 'the turn was the real one: the context step answered nothing')
  assert.deepEqual(w.posted().map(p => p[1]), [SUMMARY]); assert.equal(supAsks(w).length, 0, 'no judgement for want of material')
})

test('control: a context step that RAN and chose nothing is not "incomplete": the same unsupported sentences are still caught (the check is not weaker for it)', async t => {
  const w = world(t, { script: (n, { index }) => (index === 0 ? [...text(n, SUMMARY), ...result()] : result()) })
  const a = await w.send('README 내용 요약해줘'); await settle(w, a)
  assert.doesNotMatch(title(w, a), /응답 없음/); assert.ok(!JSON.stringify(w.posted()).includes('README'), 'the unsupported sentences are not posted')
})

test('a contradiction is not about missing material: with the context cut, "all tests passed" against the run\'s own failing command is still caught', async t => {
  const call = { command: 'npm test' }
  const w = world(t, { outputs: { 'npm test': { text: FAIL, code: 1 } }, script: (n, { index }) => (index === 0
    ? [toolUse('toolu_1', 'egdesk_run_command', call), { tool: { name: 'egdesk_run_command', arguments: call } }, userResult('toolu_1'), ...text(n, '테스트가 모두 통과했습니다.'), ...result()] : result()) }); cutContext(w)
  const a = await w.send('테스트 돌려줘'); await settle(w, a)
  assert.deepEqual(w.ran, ['npm test']); assert.match(title(w, a), /응답 없음/); assert.ok(!JSON.stringify(w.posted()).includes('통과'), 'the false pass claim is not posted')
})

test('earlier turns of the conversation are evidence: the edit EG-Desk made in turn one is in turn two\'s check as a past fact (text only, no facts of the code rules); a restart of the runtime does not lose it', async t => {
  const call = { path: 'README.md', mode: 'replace', oldString: '# 제목', newString: '# 제목\n설치: npm install' }
  const w = world(t, { project: { 'README.md': '# 제목\n' }, judge: {}, script: (n, { index }) => (n === 1
    ? [toolUse('toolu_1', 'egdesk_edit_file', call), { tool: { name: 'egdesk_edit_file', arguments: call } }, userResult('toolu_1'), ...text(n, '완료했습니다.'), ...result()] : [...text(n, 'README.md에 설치 줄을 추가했습니다.'), ...result()]) })
  const a = await w.send('README에 설치 줄 추가해줘'); await settle(w, a)
  const b = await w.send('방금 뭐 했어?', { conversationId: a.conversationId, requestId: 'r-2' }); await settle(w, b)
  const sup = supAsks(w); assert.ok(sup.length >= 1, 'the second answer was judged')
  const evidence = JSON.stringify(sup.at(-1).input); assert.match(evidence, /In an earlier turn of this conversation the assistant changed/); assert.match(evidence, /README\.md/)
  const items = w.chat.earlierToolFactsEvidence(w.runOf(b)); assert.ok(items.length >= 1); for (const item of items) assert.deepEqual([item.time, item.facts, item.pinned, item.source], ['past', undefined, undefined, 'earlier_turn'])
  w.chat.earlierEvidence?.clear?.(); assert.ok(w.chat.earlierToolFactsEvidence(w.runOf(b)).length >= 1, 'read from the store, not from the in-memory carry')
  assert.deepEqual(w.chat.earlierToolFactsEvidence({ clientThreadId: 'nobody', requestId: 'x' }), [])
})

test('incomplete evidence is not empty evidence: with the context cut but an earlier edit in the conversation, the model IS asked, and a sentence it finds unsupported is still not cut for want of the missing material', async t => {
  const call = { path: 'README.md', mode: 'replace', oldString: '# 제목', newString: '# 제목\n설치: npm install' }
  const w = world(t, { project: { 'README.md': '# 제목\n' }, script: n => (n === 1
    ? [toolUse('toolu_1', 'egdesk_edit_file', call), { tool: { name: 'egdesk_edit_file', arguments: call } }, userResult('toolu_1'), ...text(n, '완료했습니다.'), ...result()] : [...text(n, SUMMARY), ...result()]) })
  const a = await w.send('README에 설치 줄 추가해줘'); await settle(w, a)
  cutContext(w)
  const b = await w.send('README 내용 요약해줘', { conversationId: a.conversationId, requestId: 'r-2' }); await settle(w, b)
  assert.match(title(w, b), /응답 없음/); assert.ok(supAsks(w).length >= 1, 'the model was asked: there was evidence (the earlier edit)')
  assert.deepEqual(w.posted().map(p => p[1]).slice(-1), [SUMMARY], 'posted as written')
})
