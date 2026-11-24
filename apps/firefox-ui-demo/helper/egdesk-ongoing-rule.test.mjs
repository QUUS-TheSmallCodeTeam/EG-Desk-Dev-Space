// Owner decision (Main, c24): ongoing decided yes -> now is not consulted (before and after must be decided no). On the recorded answers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { splitLabels } from './egdesk-speech-grounding.mjs'
import { compactionSignal } from './codex-chat-runtime.mjs'

const V = map => Object.fromEntries(Object.entries(map).map(([k, x]) => [k, x >= 0.85 ? 'yes' : x <= 0.15 ? 'no' : 'unknown']))

test('ongoing yes with before and after no: ongoing_no_end whatever now is', () => {
  for (const now of [0.01, 0.39, 0.97]) assert.equal(splitLabels(V({ before: 0.04, now, ongoing: 0.98, after: 0.01, when: 1 })).time, 'ongoing_no_end')
  assert.equal(splitLabels(V({ before: 0.19, now: 0.3, ongoing: 1, after: 0 })).time, 'unknown', 'an undecided before still blocks')
  assert.equal(splitLabels(V({ before: 0.96, now: 0.3, ongoing: 1, after: 0 })).time, 'unknown', 'before yes: two times')
  assert.equal(splitLabels(V({ before: 0.02, now: 0.3, ongoing: 1, after: 0.9 })).time, 'unknown')
  assert.equal(splitLabels(V({ before: 0.02, now: 0.9, ongoing: 0.5, after: 0 })).time, 'unknown', 'ongoing undecided: as before')
  assert.equal(splitLabels(V({ before: 0, now: 0.97, ongoing: 0, after: 0, when: 0.26 })).time, 'at_utterance', 'unchanged elsewhere (c23 c08)')
})

test('on the recorded answers: c37 (c23 and c26) and c30 (c26) now install ongoing_no_end, which their labels allow; nothing else changes', () => {
  // real values: c23 c37 before .1 now .77 ongoing .98 after .01 when 1; c26 c37 before .04 now .39 (+ c23 ongoing/after/when);
  // c26 c30 before .07 now .30 (+ c23 ongoing 1 after 0 when .99); c23 c30 before .19 now .65 (stays unknown)
  assert.equal(splitLabels(V({ before: 0.1, now: 0.77, ongoing: 0.98, after: 0.01, when: 1 })).time, 'ongoing_no_end')
  assert.equal(splitLabels(V({ before: 0.04, now: 0.39, ongoing: 0.98, after: 0.01, when: 1 })).time, 'ongoing_no_end')
  assert.equal(splitLabels(V({ before: 0.07, now: 0.3, ongoing: 1, after: 0, when: 0.99 })).time, 'ongoing_no_end')
  assert.equal(splitLabels(V({ before: 0.19, now: 0.65, ongoing: 1, after: 0, when: 0.99 })).time, 'unknown')
  // a16 (guard, c24): ongoing 0 -> the rule does not apply; the when rule keeps it unknown
  assert.equal(splitLabels(V({ before: 0.12, now: 0.92, ongoing: 0, after: 0.07, when: 1 })).time, 'unknown')
})

test('thread/reverted (Codex 0.171) is a lost-context signal like thread/compacted and a contextCompaction item', () => {
  assert.equal(compactionSignal({ method: 'thread/reverted', params: { threadId: 't3' } }), 't3')
  assert.equal(compactionSignal({ method: 'thread/compacted', params: { threadId: 't2', turnId: 'u9' } }), 't2')
  assert.equal(compactionSignal({ method: 'item/completed', params: { threadId: 't1', turnId: 'u1', item: { id: 'c', type: 'contextCompaction' } } }), 't1')
  assert.equal(compactionSignal({ method: 'thread/reverted', params: {} }), null)
})

test('own v3 is the two-step second step\'s default (terse-record-v1 real: c10 .12, c12 .06); on the recorded answers c12 installs inference, c10 record_based', async () => {
  const { SPLIT_WORDING_CHOICE, SPLIT_WORDING_V2_AS_SENT, speechSegments, speechSplitQuestions } = await import('./egdesk-speech-grounding.mjs')
  assert.equal(SPLIT_WORDING_CHOICE.own, 'v3')
  assert.equal(SPLIT_WORDING_V2_AS_SENT.own, 'v2')
  // c12: other 0 (c26), own .06 (v3, c27), record .03 (c23), guess 1.0 (c26)
  assert.equal(splitLabels(V({ other: 0, own: 0.06, record: 0.03, guess: 1 })).source, 'inference')
  assert.equal(splitLabels(V({ other: 0, own: 0.19, record: 0.03, guess: 1 })).source, 'unknown', 'with v2 own (.19) it was not installed')
  // c10: other 0, own .12 (v3), record .97 (c23), guess .01
  assert.equal(splitLabels(V({ other: 0, own: 0.12, record: 0.97, guess: 0.01 })).source, 'record_based')
  // the second request asks own in its v3 wording unless a wording is given
  const { judgeTurnWrite } = await import('./egdesk-turn-memory.mjs')
  const text = '서버 응답이 느린 걸 보니 트래픽이 몰린 것 같아.', calls = []
  const client = { async decide(r) { calls.push(r); return { answers: {} } } }
  await judgeTurnWrite({ message: text, candidates: [], client, askedAt: Date.parse('2026-11-27T10:00:00+09:00'), targetDesign: 'about', speechDesign: 'hybrid-two-step' })
  const own = calls[1].questions.find(q => q.name === 'speechs_own_0')
  const v3 = speechSplitQuestions(speechSegments(text), text, { wording: { own: 'v3' } }).find(q => q.name === 'speechs_own_0')
  assert.equal(own.instructions, v3.instructions)
  calls.length = 0
  await judgeTurnWrite({ message: text, candidates: [], client, askedAt: Date.parse('2026-11-27T10:00:00+09:00'), targetDesign: 'about', speechDesign: 'hybrid-two-step', splitWording: 'v1' })
  const v1 = speechSplitQuestions(speechSegments(text), text, { wording: 'v1' }).find(q => q.name === 'speechs_own_0')
  assert.equal(calls[1].questions.find(q => q.name === 'speechs_own_0').instructions, v1.instructions, 'an explicit wording still wins')
})
