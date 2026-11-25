// u8 (D23b; owner principle U8: no streaming, complete messages only, a working indicator, intermediate talk filtered): in a Claude conversation under EG-Desk's harness, the talk before or between tool calls
// (real window runs: an English line naming an internal state, posted as its own bubble ahead of the answer) is a work note, an activity row of the existing form, never a bubble. Only the last text, the answer, is
// posted, after the pre-publication check when it is on. Replays on lane L5's world (real runtime, adapter and tools; the CLI is a script; the Decision model is a scripted fetch). Nothing real runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { harnessWorld, result, text, toolUse, userResult } from './egdesk-claude-harness.fixture.mjs'

const settle = async (w, a) => { await w.settled(a); await new Promise(r => setTimeout(r, 300)); await w.drain() }
const NARRATION = 'Value is "우산" (replaced). Search button now runs at once.'
const ANSWER = '테스트 5개가 모두 통과했습니다.'
const FALSE_DEPLOY = 'main 브랜치에 v2.3.1을 배포했습니다.'
const NPM = { command: 'npm test' }
const afterTool = (n, ...rest) => [toolUse('toolu_1', 'egdesk_run_command', NPM), { tool: { name: 'egdesk_run_command', arguments: NPM } }, userResult('toolu_1'), ...rest]
const notes = (w, a) => (w.runOf(a)?.activities ?? []).filter(x => x.kind === 'workNote').map(x => String(x.detail?.text ?? ''))
const bubbles = w => w.posted().map(p => p[1])
const turn = n => (n === 1 ? [...text(n, NARRATION), ...afterTool(n, ...text(n + 10, ANSWER), ...result())] : [...text(n, 'x'), ...result()])

for (const check of [true, false]) {
  const env = check ? { EGDESK_DRAFT_CHECK: 'on' } : {}
  test(`narration + tool + final answer (draft check ${check ? 'on' : 'off'}): exactly one bubble, the answer; the narration is a work note and is not posted`, async t => {
    const w = harnessWorld(t, { env, judge: { unsupported: /배포/ }, script: turn })
    const a = await w.send('테스트 돌려줘'); await settle(w, a)
    assert.deepEqual(bubbles(w), [ANSWER]); assert.deepEqual(w.ran, ['npm test'])
    assert.ok(notes(w, a).includes(NARRATION), 'the narration stays as an activity row'); assert.ok(!JSON.stringify(w.posted()).includes('우산'))
  })
}

test('narration + several tools + answer: one bubble; every narration is a note', async t => {
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on' }, judge: {}, script: n => (n === 1
    ? [...text(n, '먼저 돌려 보겠습니다.'), ...afterTool(n, ...text(n + 10, '결과를 보는 중입니다.'), toolUse('toolu_2', 'egdesk_run_command', NPM), { tool: { name: 'egdesk_run_command', arguments: NPM } }, userResult('toolu_2'), ...text(n + 20, ANSWER), ...result())]
    : [...text(n, 'x'), ...result()]) })
  const a = await w.send('테스트 돌려줘'); await settle(w, a)
  assert.deepEqual(bubbles(w), [ANSWER]); const got = notes(w, a); assert.ok(got.includes('먼저 돌려 보겠습니다.') && got.includes('결과를 보는 중입니다.'))
})

test('a turn without a tool is as before: its one text is the answer and is posted, with the check on and off', async t => {
  for (const env of [{ EGDESK_DRAFT_CHECK: 'on' }, {}]) {
    const w = harnessWorld(t, { env, judge: {}, script: n => [...text(n, '안녕하세요. 무엇을 도와드릴까요?'), ...result()] })
    const a = await w.send('안녕'); await settle(w, a)
    assert.deepEqual(bubbles(w), ['안녕하세요. 무엇을 도와드릴까요?']); assert.deepEqual(notes(w, a), [])
  }
})

test('two texts in a row, no tool between: only the last is a bubble, the earlier one is a note', async t => {
  const w = harnessWorld(t, { env: {}, script: n => [...text(n, '확인해 봤습니다.'), ...text(n + 10, ANSWER), ...result()] })
  const a = await w.send('알려줘'); await settle(w, a)
  assert.deepEqual(bubbles(w), [ANSWER]); assert.deepEqual(notes(w, a), ['확인해 봤습니다.'])
})

test('the final answer is still checked: a false claim after the tools is withheld, and the narration is still not a bubble', async t => {
  const w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on' }, judge: { unsupported: /배포/ }, script: n => (n === 1 ? [...text(n, NARRATION), ...afterTool(n, ...text(n + 10, FALSE_DEPLOY), ...result())] : [...text(n, 'x'), ...result()]) })
  const a = await w.send('배포했어?'); await settle(w, a)
  assert.deepEqual(bubbles(w), []); assert.ok(notes(w, a).includes(NARRATION))
})

test('unchanged: the harness off in an Agent room with the check on keeps posting narration as a bubble (u4 behavior); the Decision mode 끔 posts the answer as written', async t => {
  const room = harnessWorld(t, { agent: true, env: { EGDESK_DRAFT_CHECK: 'on', EGDESK_CLAUDE_HARNESS: 'off' }, judge: {}, script: turn })
  const a = await room.send('테스트 돌려줘'); await settle(room, a)
  assert.ok(bubbles(room).includes(NARRATION) || bubbles(room).includes(ANSWER), 'outside the harness this feature does not act'); assert.ok(!notes(room, a).includes(NARRATION), 'no note demotion outside the harness')
  const off = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on' }, decisions: false, script: turn })
  const b = await off.send('테스트 돌려줘'); await settle(off, b)
  assert.deepEqual(bubbles(off), [ANSWER]); assert.ok(notes(off, b).includes(NARRATION)); assert.deepEqual(off.decisionBodies, [])
})

test('scope (claudeHarnessHold): only a Claude direct or plain thread under the harness; never Codex, a stateless or Board send, an unverified binding, a thread outside the harness', t => {
  const w = harnessWorld(t, { script: n => [...text(n, 'x'), ...result()] }), chat = w.chat, hold = (context, body = {}) => chat.claudeHarnessHold(body, context)
  const claude = { engine: { id: 'claude' } }, codex = { engine: { id: 'codex' } }
  assert.deepEqual([hold({ channelKind: null, ...claude }), hold({ channelKind: 'direct', ...claude })], [true, true])
  assert.deepEqual([hold({ channelKind: null, ...codex }), hold({ channelKind: 'direct', ...codex }), hold({ channelKind: null, stateless: true, ...claude }), hold({ channelKind: null, board: true, ...claude }), hold({ channelKind: null, ...claude }, { boardId: 'b' }),
    hold({ channelKind: 'unverified', ...claude }), hold({ channelKind: null, topicAnswerGuard: {}, ...claude })], [false, false, false, false, false, false, false])
  const own = chat.ownTools; chat.ownTools = { ...own, claudeHarness: () => null }
  assert.equal(hold({ channelKind: null, ...claude }), false, 'a thread outside the harness'); chat.ownTools = own
})

test('outside the harness nothing is held: the narration is a bubble while the tool is still going, before the answer (unchanged)', async t => {
  let seen = null, w = null
  w = harnessWorld(t, { env: { EGDESK_DRAFT_CHECK: 'on', EGDESK_CLAUDE_HARNESS: 'off' }, judge: {}, script: n => (n === 1
    ? [...text(n, NARRATION), ...afterTool(n, { check: () => { seen = w.posted().map(p => p[1]) } }, ...text(n + 10, ANSWER), ...result())] : [...text(n, 'x'), ...result()]) })
  const a = await w.send('테스트 돌려줘'); await settle(w, a)
  assert.deepEqual(seen, [NARRATION], 'streamed as before'); assert.deepEqual(bubbles(w), [NARRATION, ANSWER]); assert.deepEqual(notes(w, a), [])
})
