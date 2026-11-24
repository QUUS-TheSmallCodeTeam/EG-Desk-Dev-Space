import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { secretsIn } from './egdesk-secret-mask.mjs'
import { EXPECT_KEYS, validateEngineScript } from './egdesk-real-engine-script.mjs'

// The conversation scripts for lane L5's real-engine check (scripts/real-engine/scripts/real-engine-*-v1.json; L3 c23). Their format is L5's
// (the schema lives on L5's branch until it merges), so this test restates its structural rules instead of importing the validator, and
// adds the one new field, whileRunning. Nothing here runs an engine.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'real-engine', 'scripts')
const SCRIPT_SET = /^real-engine-[a-z0-9][a-z0-9-]{0,40}-v\d{1,3}$/, ID = /^[a-z0-9][a-z0-9-]{0,39}$/, FLAG = /^EGDESK_[A-Z0-9_]{1,48}$/, VALUE = /^[a-z0-9_-]{1,24}$/
const RESERVED = ['EGDESK_CODEX_BIN', 'EGDESK_DATA_DIR', 'EGDESK_CODEX_MODEL', 'EGDESK_CODEX_EFFORT', 'EGDESK_CODEX_DISABLE_MEMORIES', 'EGDESK_CLAUDE_BIN']
const OURS = ['correction', 'why-stopped', 'terse-yes', 'topic-return', 'conditional-yes', 'pause']
const load = name => JSON.parse(readFileSync(path.join(dir, `real-engine-${name}-v1.json`), 'utf8'))

test('the four scripts exist, follow the real-engine script format, and use only known keys and flags', () => {
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  for (const name of OURS) assert.ok(files.includes(`real-engine-${name}-v1.json`), name)
  for (const name of OURS) {
    const script = load(name)
    { const checked = validateEngineScript(script); assert.ok(checked.ok, JSON.stringify(checked.errors)) } // L5's own validator (whileRunning, postedMin, ...)
    assert.deepEqual(Object.keys(script).sort(), ['conversations', 'description', 'set']); assert.equal(script.set, `real-engine-${name}-v1`); assert.match(script.set, SCRIPT_SET)
    for (const conv of script.conversations) {
      assert.match(conv.id, ID); assert.ok(conv.turns.length >= 1 && conv.turns.length <= 12)
      assert.ok(Object.keys(conv).every(k => ['id', 'folder', 'flags', 'turns'].includes(k)))
      for (const [p, content] of Object.entries(conv.folder ?? {})) { assert.ok(!p.startsWith('/') && !p.includes('..') && !/(^|\/)\.(git|codex|agents|egdesk)(\/|$)/.test(p), p); assert.equal(typeof content, 'string') }
      for (const [k, v] of Object.entries(conv.flags ?? {})) { assert.match(k, FLAG); assert.ok(!RESERVED.includes(k)); assert.match(v, VALUE) }
      for (const turn of conv.turns) {
        assert.ok(Object.keys(turn).every(k => ['say', 'approve', 'expect', 'whileRunning'].includes(k)), 'turn keys')
        assert.ok(turn.say.trim().length > 0 && turn.say.length <= 4000)
        assert.ok(Object.keys(turn.expect ?? {}).every(k => EXPECT_KEYS.includes(k)), JSON.stringify(Object.keys(turn.expect ?? {})))
      }
    }
  }
})

test('whileRunning: only on a later turn, with a bounded afterMs, and only in a conversation whose flags turn EGDESK_INRUN_MESSAGES on', () => {
  let seen = 0
  for (const name of OURS) for (const conv of load(name).conversations) conv.turns.forEach((turn, i) => {
    if (!turn.whileRunning) return
    seen++
    assert.deepEqual(Object.keys(turn.whileRunning), ['afterMs']); assert.ok(Number.isInteger(turn.whileRunning.afterMs) && turn.whileRunning.afterMs >= 0 && turn.whileRunning.afterMs <= 120_000)
    assert.ok(i >= 1, 'sent while the PREVIOUS turn runs: never the first turn')
    assert.equal(conv.flags?.EGDESK_INRUN_MESSAGES, 'on')
    assert.ok(/sleep \d+/.test(conv.turns[i - 1].say), 'the previous turn is a command that is still running when this one is sent')
  })
  assert.equal(seen, 2, 'the why-stopped and the pause conversations')
  const why = load('why-stopped').conversations[0]
  assert.equal(why.turns[1].say, '아니 지금 왜 멈췄니?'); assert.equal(why.turns[1].whileRunning.afterMs, 4000)
  assert.ok(why.turns[1].expect.postedMin >= 2, 'the reply is a message of its own: posted:true passed on the final answer alone (check-2, check-6)')
  assert.ok(why.turns[0].say.includes('sleep 15'), 'the command outlasts the 4 s')
  assert.equal(why.turns[0].expect.turnStatus, 'completed', 'the question does not stop the command')
  assert.deepEqual(why.flags, { EGDESK_INRUN_MESSAGES: 'on', EGDESK_CONVERSATION_FLOW: 'on', EGDESK_DRAFT_CHECK: 'on' })
})

test('the patterns: the correction, the terse yes after a proposal, the topic return; expectations are code checks that distinguish the right outcome', () => {
  const c = load('correction').conversations[0]
  assert.match(c.turns[1].say, /^아니, /); assert.deepEqual(c.turns[1].expect.answerIncludes, ['12,000', '8,500', '4,200'])
  const t = load('terse-yes').conversations[0]
  assert.equal(t.turns[1].say, 'ㅇㅇ')
  assert.deepEqual(t.turns[0].expect.files, t.folder, 'nothing is changed before the person says yes')
  assert.equal(t.turns[0].expect.undoRecords, 0)
  assert.deepEqual(t.turns[1].expect.files, { 'notes/todo.md': '- [ ] 일정 확인\n' }); assert.equal(t.turns[1].expect.undoRecords, 1)
  const r = load('topic-return').conversations[0]
  assert.match(r.turns[2].say, /^아까 그거 다시/)
  assert.deepEqual([r.turns[2].expect.answerIncludes, r.turns[2].expect.answerExcludes], [['12월 20일'], ['1월 15일']], 'the first file\'s date, never the second\'s')
  assert.ok(r.folder['notes/quote-a.md'].includes('12월 20일') && r.folder['notes/ship-b.md'].includes('1월 15일'))
})

test('c24 patterns: the conditional approval is checked by marker files (the skipped step stays absent), the pause ends the first turn interrupted without claiming it finished', () => {
  const c = load('conditional-yes').conversations[0]
  assert.equal(c.turns[1].say, '응 근데 테스트는 빼고')
  assert.match(c.turns[0].say, /물어봐 줘\.$/, 'the person\'s "응" answers a question the assistant was asked to put (check-4: with no question it was read as a plan revision and nothing ran)')
  assert.deepEqual(c.turns[0].expect.files, { 'build.done': null, 'test.done': null, 'deploy.done': null }, 'nothing runs before the approval')
  assert.deepEqual(c.turns[1].expect.files, { 'build.done': 'ok', 'test.done': null, 'deploy.done': 'ok' })
  assert.ok(Object.values(c.folder).join('\n').split('\n').filter(Boolean).length === 3 && c.folder['notes/steps.md'].includes('test.done'))
  const p = load('pause').conversations[0]
  assert.deepEqual(p.flags, load('why-stopped').conversations[0].flags, 'the same flags as the why-stopped conversation')
  // Real engine (check-4, 2026-11-25): with afterMs 4000 the stop landed before the engine had called its tool (turn 1 had no tool call), so the stop is sent
  // at 10 s, and the command (sleep 30) outlasts it even if the tool started late.
  assert.equal(p.turns[1].say, '아니 잠깐, 그거 하지 마'); assert.ok(p.turns[1].whileRunning.afterMs >= 8000)
  assert.ok(Number(/sleep (\d+)/.exec(p.turns[0].say)[1]) * 1000 >= p.turns[1].whileRunning.afterMs + 15_000, 'the command outlasts the stop by a wide margin')
  assert.deepEqual(p.turns[0].expect.toolCalls, ['egdesk_run_command'], 'the stop hit a command that had started')
  assert.equal(p.turns[0].expect.turnStatus, 'interrupted'); assert.deepEqual(p.turns[0].expect.answerExcludes, ['cleanup-finished']); assert.equal(p.turns[0].expect.posted, undefined, 'a preamble may have been posted')
  assert.deepEqual(p.turns[2].expect.answerExcludes, ['cleanup-finished']); assert.equal(p.turns[2].expect.turnStatus, 'completed')
})

test('no secret, address, phone number or real-looking identifier in any script', () => {
  for (const name of OURS) { const text = readFileSync(path.join(dir, `real-engine-${name}-v1.json`), 'utf8'); assert.deepEqual(secretsIn(text), [], name) }
})
