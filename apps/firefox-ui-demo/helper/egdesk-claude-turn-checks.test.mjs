// u4 (PHILOSOPHY U19): the Decision model's turn judgments run for a Claude conversation under EG-Desk's harness, in a PLAIN thread too (not only an Agent room), and the pre-publication check
// catches a sentence the run gives no basis for. The replay world is lane L5's (egdesk-claude-harness.fixture.mjs): the real runtime, the real Claude adapter and EG-Desk's own tools; only the CLI
// is a recorded-shape script; the Decision model is a scripted fetch whose judge reads the quoted sentence. No CLI, no login, no model call, nothing sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { harnessWorld, result, text, toolUse, until, userResult } from './egdesk-claude-harness.fixture.mjs'

const PLAN = { id: 'doc:calc', kind: 'document', title: '계산기 앱 노트', summary: '계산기 앱 창 정보', timeSlice: 'present', loadText: () => 'body' }
const FALSE_DEPLOY = 'main 브랜치에 v2.3.1을 배포했습니다.'
const supAsks = w => w.decisionBodies.filter(b => b.questions.some(q => /^sup_/.test(q.name)))
const settle = async (w, a) => { await w.settled(a); await new Promise(r => setTimeout(r, 300)); await w.drain() }
const NPM = { command: 'npm test' }
const ranNpm = (n, ...after) => [toolUse('toolu_1', 'egdesk_run_command', NPM), { tool: { name: 'egdesk_run_command', arguments: NPM } }, userResult('toolu_1'), ...after]

test('plain Claude thread under the harness: the held answer is checked, and a claim the run gives no basis for is not posted (a deployment that never ran)', async t => {
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on' }, judge: { unsupported: /배포/ }, script: n => [...text(n, FALSE_DEPLOY), ...result()] })
  const a = await w.send('배포 상태 알려줘'); await settle(w, a)
  assert.deepEqual(w.posted(), [], 'withheld: no Claude process can revise (no private turns), and a fixed sentence never stands in for it')
  assert.deepEqual(w.chat.turnStagesFor(w.runOf(a).requestId).map(s => s.stage), ['memory', 'action', 'engine', 'check'], 'the check came after the engine, before posting')
  assert.equal(w.transports.length, 1, 'no private Claude process')
})

test('plain Claude thread: a sentence the run DOES support is posted as written (the command EG-Desk ran for the turn is the evidence)', async t => {
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on' }, judge: { unsupported: /배포/ }, script: n => n === 1 ? ranNpm(n, ...text(n, '테스트 5개가 모두 통과했습니다.'), ...result()) : [...text(n, 'x'), ...result()] })
  const a = await w.send('테스트 돌려줘'); await settle(w, a)
  assert.deepEqual(w.ran, ['npm test'], 'the command went through EG-Desk'); assert.deepEqual(w.posted().map(p => p[1]), ['테스트 5개가 모두 통과했습니다.'])
  assert.equal(supAsks(w).length, 1, 'the sentence was judged, and passed')
})

test('plain Claude thread: narration before a tool call is posted as written and never checked; only the answer after the tools is held and judged', async t => {
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on' }, judge: { unsupported: /배포/ }, script: n => n === 1
    ? [...text(n, '먼저 배포 상태부터 확인해 보겠습니다.'), ...ranNpm(n, ...text(n + 10, '테스트 5개가 모두 통과했습니다.'), ...result())] : [...text(n, 'x'), ...result()] })
  const a = await w.send('테스트 돌려줘'); await settle(w, a)
  assert.deepEqual(w.posted().map(p => p[1]), ['먼저 배포 상태부터 확인해 보겠습니다.', '테스트 5개가 모두 통과했습니다.'], 'narration, then the answer, in order, each once')
  const judged = JSON.stringify(supAsks(w).map(b => b.input)); assert.match(judged, /통과했습니다/); assert.doesNotMatch(judged, /확인해 보겠습니다/, 'the narration was not sent to the check')
})

test('the "이번 실행" claim of the 04:03 window run: a sentence about what THIS run was or was not allowed to do, with nothing from this turn behind it, is not posted when the run has material to compare it with', async t => {
  const said = '계산기 화면은 읽을 수 없습니다. 이번 실행에서 계산기를 보는 권한이 허용되지 않았습니다.'
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on' }, judge: { unsupported: /이번 실행/ }, candidates: [PLAN], script: n => [...text(n, said), ...result()] })
  const a = await w.send('계산기 앱 창의 화면 요소를 읽어서 알려줘'); await settle(w, a)
  assert.deepEqual(w.posted().map(p => p[1]), ['계산기 화면은 읽을 수 없습니다.'], 'the unsupported sentence is cut, the rest stands')
  assert.equal(supAsks(w).length, 1)
})

test('the same claim with NO material for the turn at all: it is found locally (nothing supports it by construction), no Decision request is needed, the rest of the answer stands', async t => {
  const said = '계산기 화면은 읽을 수 없습니다. 이번 실행에서 계산기를 보는 권한이 허용되지 않았습니다.'
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on' }, judge: { unsupported: /이번 실행/ }, script: n => [...text(n, said), ...result()] })
  const a = await w.send('계산기 앱 창의 화면 요소를 읽어서 알려줘'); await settle(w, a)
  assert.deepEqual(w.posted().map(p => p[1]), ['계산기 화면은 읽을 수 없습니다.']); assert.equal(supAsks(w).length, 0, 'found by code: no evidence at all')
})

test('after a tool call the same sentence is NOT cut: this turn has a basis for it (a content-free reference to the call) that the check cannot read, so it does not act against it', async t => {
  const said = '파일을 읽으려 했지만 이번 실행에서 그 위치에 접근할 권한이 허용되지 않았습니다.'
  const call = { path: 'notes.md' }
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on' }, judge: { unsupported: /이번 실행/ }, project: { 'notes.md': '메모' },
    script: n => n === 1 ? [toolUse('toolu_1', 'egdesk_read_file', call), { tool: { name: 'egdesk_read_file', arguments: call } }, userResult('toolu_1'), ...text(n, said), ...result()] : [...text(n, 'x'), ...result()] })
  const a = await w.send('notes.md 읽어줘'); await settle(w, a)
  assert.deepEqual(w.posted().map(p => p[1]), [said])
})

test('what counts as a sentence about THIS run\'s own state (code, no judgment): this run or turn plus a permission, approval, refusal or block word; not a question, a plan, an earlier run, or another subject', async () => {
  const { claimsRunState } = await import('./egdesk-draft-run-facts.mjs')
  for (const yes of ['이번 실행에서 계산기를 보는 권한이 허용되지 않았습니다.', '이번 턴에는 승인이 거절되어 실행하지 못했습니다.', 'This run was blocked from reading the screen.', '이번 요청은 권한 문제로 막혔습니다.']) assert.equal(claimsRunState(yes), true, yes)
  for (const no of ['이번 실행에서 권한이 허용되었는지 확인해 볼까요?', '이번 실행에서 승인을 받으면 진행하겠습니다.', '지난 실행에서는 권한이 거절되었습니다.', '이번 실행에서 파일 세 개를 읽었습니다.', '권한이 허용되지 않았습니다.', '']) assert.equal(claimsRunState(no), false, no)
})

test('U9 and scope: with the Decision mode 끔 nothing is held or sent; outside the harness a plain Claude thread is not held either; an Agent room is held as before', async t => {
  const off = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on' }, decisions: false, script: n => [...text(n, FALSE_DEPLOY), ...result()] })
  const a = await off.send('배포 상태 알려줘'); await settle(off, a)
  assert.deepEqual(off.posted().map(p => p[1]), [FALSE_DEPLOY], 'mode 끔: posted as written'); assert.deepEqual(off.decisionBodies, [], 'no request to the Decision model')
  const outside = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on', EGDESK_CLAUDE_HARNESS: 'off' }, judge: { unsupported: /배포/ }, script: n => [...text(n, FALSE_DEPLOY), ...result()] })
  const b = await outside.send('배포 상태 알려줘'); await settle(outside, b)
  assert.deepEqual(outside.posted().map(p => p[1]), [FALSE_DEPLOY], 'outside the harness: not this feature\'s business'); assert.equal(supAsks(outside).length, 0)
  const room = harnessWorld(t, { agent: true, env: { EGDESK_DRAFT_CHECK: 'on' }, judge: { unsupported: /배포/ }, script: n => [...text(n, FALSE_DEPLOY), ...result()] })
  const c = await room.send('배포 상태 알려줘'); await settle(room, c)
  assert.deepEqual(room.posted(), [], 'an Agent room: held and checked as before')
})

test('other turn judgments on a plain Claude thread (the table of the report): open items, memory prefetch and the proposal registry run; the memory loop (write-first) is for Agent rooms only, as for Codex', async t => {
  // proposal registry: the answer's own question is registered as an item
  const reg = harnessWorld(t, { predicates: { pq_0: 0.95, ph_0: 0.95 }, script: n => [...text(n, '이 순서대로 실행해도 될까요?'), ...result()] })
  reg.chat.decisionContext.proposalRegistry = { mode: () => 'on' }
  const a = await reg.send('절차 알려줘'); await reg.settled(a); await reg.chat.proposalRegistryIdle()
  assert.deepEqual(reg.chat.openItemsFor(a.conversationId).map(i => [i.provider, i.kind]), [['proposals', 'proposal']])
  // the memory loop: eligible only for a direct (Agent room) send, whatever the engine
  const calls = []
  const turnMemory = { mode: () => 'on', wiki: async () => { calls.push('wiki'); return null } }
  const plain = harnessWorld(t, { turnMemory, script: n => [...text(n, '네'), ...result()] }), p = await plain.send('안녕'); await plain.settled(p)
  assert.equal(calls.length, 0, 'plain thread: the memory loop does not start')
  const room = harnessWorld(t, { agent: true, turnMemory, script: n => [...text(n, '네'), ...result()] }), r = await room.send('안녕'); await room.settled(r)
  assert.ok(calls.length >= 1, 'Agent room: it does')
})

test('narration is posted when the tool call starts, not at the end of the turn: while the tool is still going the person already reads it', async t => {
  let seen = null, w = null
  w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on' }, judge: { unsupported: /배포/ }, script: n => n === 1
    ? [...text(n, '먼저 테스트부터 돌려 보겠습니다.'), ...ranNpm(n, { check: () => { seen = w.posted().map(p => p[1]) } }, ...text(n + 10, '테스트 5개가 모두 통과했습니다.'), ...result())] : [...text(n, 'x'), ...result()] })
  const a = await w.send('테스트 돌려줘'); await settle(w, a)
  assert.deepEqual(seen, ['먼저 테스트부터 돌려 보겠습니다.'], 'after the tool, before the answer: the narration is already posted and the answer is still held')
})

test('two texts in a row without a tool between: the LAST one is the answer and is judged, the earlier one is posted as written; a withheld answer does not take the earlier text with it', async t => {
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on' }, judge: { unsupported: /배포/ }, script: n => [...text(n, '확인해 봤습니다.'), ...text(n + 10, FALSE_DEPLOY), ...result()] })
  const a = await w.send('배포 상태 알려줘'); await settle(w, a)
  assert.deepEqual(w.posted().map(p => p[1]), ['확인해 봤습니다.']); assert.ok(!JSON.stringify(w.posted()).includes('배포'))
  const ok = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on' }, judge: { unsupported: /배포/ }, script: n => n === 1 ? [...text(n, FALSE_DEPLOY), ...text(n + 10, '아직 배포하지 않았습니다.'), ...result()] : [...text(n, 'x'), ...result()] })
  const b = await ok.send('배포 상태 알려줘'); await settle(ok, b)
  assert.deepEqual(ok.posted().map(p => p[1]), [FALSE_DEPLOY, '아직 배포하지 않았습니다.'], 'only the last text is the answer: an earlier text is not judged')
})

test('which sends the draft check applies to (draftCheckEligibleFor): an Agent room\'s direct send; a Claude thread under the harness; never a Board send, a stateless one, an unverified binding, a Claude thread outside the harness; a configured `eligible` decides alone', t => {
  const w = harnessWorld(t, { script: n => [...text(n, 'x'), ...result()] }), chat = w.chat, claude = { engine: { id: 'claude' } }, codex = { engine: { id: 'codex' } }
  const ok = (context, body = {}) => chat.draftCheckEligibleFor(body, context)
  assert.deepEqual([ok({ channelKind: 'direct', ...codex }), ok({ channelKind: null, ...claude }), ok({ channelKind: null, ...codex })], [true, true, false])
  assert.deepEqual([ok({ channelKind: 'direct', stateless: true, ...claude }), ok({ channelKind: 'direct', board: true, ...claude }), ok({ channelKind: null, ...claude }, { boardId: 'b1' }), ok({ channelKind: 'unverified', ...claude }), ok({ channelKind: 'board', ...claude })], [false, false, false, false, false])
  const own = chat.ownTools; chat.ownTools = { ...own, claudeHarness: () => null }
  assert.equal(ok({ channelKind: null, ...claude }), false, 'a Claude thread outside the harness'); chat.ownTools = own
  chat.decisionContext.draftCheck = { mode: () => 'on', eligible: ({ context }) => context.channelKind === 'x' }
  assert.deepEqual([ok({ channelKind: 'x', ...codex }), ok({ channelKind: 'direct', ...claude })], [true, false], 'a configured eligible decides alone')
})
