// u5: the stages of the pre-publication check that no Decision call stands for are told to the decision-call log by closed name (check_local, revise, recheck; lane L5's noteDecisionStage, a no-op while
// the log is off), and the private revision turn on Claude now returns its text (a Claude answer has no phase: before, the turn ran and its reply was dropped, so the posted text was only what was left of the original).
// The replay world is lane L5's (egdesk-claude-harness.fixture.mjs). Nothing real runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { harnessWorld, result, text, until } from './egdesk-claude-harness.fixture.mjs'

const ORIGINAL = '이번 실행에서 계산기를 보는 권한이 허용되지 않았습니다. 보시려면 새 실행에서 계산기를 열고, 묻는 창이 뜨면 허용해 주세요.'
const CLEAN = '계산기를 읽으려면 새 실행에서 계산기를 열고, 묻는 창이 뜨면 허용해 주세요.'
const CERTAIN_PART = '보시려면 새 실행에서 계산기를 열고, 묻는 창이 뜨면 허용해 주세요.'
const DRAFT = '테스트 5개가 모두 통과했습니다. 배포는 3번 반복되었습니다.'
const PLAN = { id: 'doc:tests', kind: 'document', title: '테스트 결과 노트', summary: '테스트 5개 통과', timeSlice: 'present', loadText: () => 'body' }
const spy = w => { const rows = []; w.chat.noteDecisionStage = (who, kind, row) => { rows.push({ kind, outcome: row.outcome, ms: row.endAt - row.startAt, run: typeof who === 'object' }); return row }; return rows }
const scripted = (first, second) => (n, { index }) => (index === 0 ? [...text(n, first), ...result()] : second === '' ? result() : [...text(n, second), ...result()])

test('the 04:30 shape (a sentence about this run, no material, private turns on): the first check is decided by code alone, the private Claude turn runs and its revised text is POSTED, the re-check finds nothing to judge; each stage has its closed name', async t => {
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on', EGDESK_CLAUDE_HARNESS_PRIVATE: 'on' }, judge: {}, script: scripted(ORIGINAL, CLEAN) }), rows = spy(w)
  const a = await w.send('계산기 요청'); await w.settled(a); await until(() => w.posted().length === 1, 8000)
  assert.deepEqual(w.posted().map(p => p[1]), [CLEAN], 'the revised answer, not what was left of the original')
  assert.deepEqual(rows.map(r => [r.kind, r.outcome]), [['check_local', 'ok'], ['revise', 'ok'], ['recheck', 'ok']], 'in the order they happened')
  assert.equal(w.transports.length, 2, 'the private Claude process ran'); assert.ok(rows.every(r => r.run && r.ms >= 0))
  assert.equal(w.decisionBodies.filter(b => b.questions.some(q => /^sup_/.test(q.name))).length, 0, 'no Decision call in the check: this is why the call log showed no "check" row')
})

test('before the fix a Claude private turn returned an empty text; an empty private reply (the model said nothing) is a revise row with outcome bad_response and the posted text is what is left of the original', async t => {
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on', EGDESK_CLAUDE_HARNESS_PRIVATE: 'on' }, judge: {}, script: scripted(ORIGINAL, '') }), rows = spy(w)
  const a = await w.send('계산기 요청'); await w.settled(a); await until(() => w.posted().length === 1, 8000)
  assert.deepEqual(w.posted().map(p => p[1]), [CERTAIN_PART]); assert.deepEqual(rows.map(r => [r.kind, r.outcome]), [['check_local', 'ok'], ['revise', 'bad_response']], 'no re-check: nothing was revised')
})

test('a revision that still carries the claim: the re-check finds it and only the part that stands is posted', async t => {
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on', EGDESK_CLAUDE_HARNESS_PRIVATE: 'on' }, judge: {}, script: scripted(ORIGINAL, ORIGINAL) }), rows = spy(w)
  const a = await w.send('계산기 요청'); await w.settled(a); await until(() => w.posted().length === 1, 8000)
  assert.deepEqual(w.posted().map(p => p[1]), [CERTAIN_PART]); assert.deepEqual(rows.map(r => r.kind), ['check_local', 'revise', 'recheck'])
})

test('when the first check DID ask the Decision model there is no check_local row (the client\'s own "check" call stands for it); revise and recheck follow', async t => {
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on', EGDESK_CLAUDE_HARNESS_PRIVATE: 'on' }, judge: { unsupported: /배포/ }, candidates: [PLAN], script: scripted(DRAFT, '테스트 5개가 모두 통과했습니다.') }), rows = spy(w)
  const a = await w.send('어떻게 됐어?'); await w.settled(a); await until(() => w.posted().length === 1, 8000)
  assert.equal(w.decisionBodies.filter(b => b.questions.some(q => /^sup_/.test(q.name))).length >= 1, true)
  assert.deepEqual(rows.map(r => r.kind), ['revise', 'recheck'])
})

test('no private turns (the flag off): nothing is told for a revision that never started; the stages are the first check only; a withheld answer is withheld as before', async t => {
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on' }, judge: {}, script: scripted('main 브랜치에 v2.3.1을 배포했습니다.', '') }), rows = spy(w)
  const a = await w.send('배포 상태 알려줘'); await w.settled(a); await new Promise(r => setTimeout(r, 300)); await w.drain()
  assert.deepEqual(w.posted(), []); assert.deepEqual(rows.map(r => r.kind), ['check_local'])
})

test('the log being off (no noteDecisionStage on the runtime) changes nothing: the same turn posts the same text', async t => {
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on', EGDESK_CLAUDE_HARNESS_PRIVATE: 'on' }, judge: {}, script: scripted(ORIGINAL, CLEAN) })
  w.chat.noteDecisionStage = undefined // the log is off, or lane L5's method is not there: the calls are optional
  const a = await w.send('계산기 요청'); await w.settled(a); await until(() => w.posted().length === 1, 8000)
  assert.deepEqual(w.posted().map(p => p[1]), [CLEAN])
})

// ---- the internal turn itself: which messages are the answer ----
import { createInternalTurns } from './codex-internal-turn.mjs'
const phaseLess = turns => ({ calls: [], forkThread: async () => ({ thread: { id: 'fork-1' } }), startThread: async () => ({ thread: { id: 'fresh-1', ephemeral: false } }), releaseThread: async () => {},
  startTurn: async params => { setImmediate(() => { turns.feed({ method: 'item/completed', params: { threadId: params.threadId, item: { type: 'agentMessage', phase: null, text: '첫째 답' } } }); turns.feed({ method: 'item/completed', params: { threadId: params.threadId, item: { type: 'agentMessage', phase: null, text: '둘째 답' } } }); turns.feed({ method: 'turn/completed', params: { threadId: params.threadId, turn: { status: 'completed' } } }) }); return { turn: { id: 't' } } } })
test('internal turn: on a fresh-only turn (Claude, no phase on its answers) every completed agent message is the answer; on any other turn a phase-less message is still not one', async () => {
  const FRESH = { preamble: 'p', overrides: async () => ({ cwd: '/engine/empty' }) }
  const a = createInternalTurns(); const fresh = await a.run({ engine: phaseLess(a), slot: 's', parentThreadId: 'parent', text: 'x', freshOnly: true, fresh: FRESH })
  assert.equal(fresh.text, '첫째 답\n둘째 답')
  const b = createInternalTurns(); const fork = await b.run({ engine: phaseLess(b), slot: 's', parentThreadId: 'parent', text: 'x', parentEphemeral: false, fresh: FRESH })
  assert.equal(fork.text, '', 'a fork or an ordinary fresh turn takes only final_answer')
})
