// L7 c23: the triage's courtesy and record questions with the previous assistant message, and the per-predicate split wording.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { COURTESY_WITH_PREVIOUS, RECORD_WITH_PREVIOUS, triageTurn } from './egdesk-turn-memory.mjs'
import { SPLIT_WORDING_CHOICE, SPLIT_WORDING_V2_AS_SENT, speechSegments, speechSplitQuestions } from './egdesk-speech-grounding.mjs'
import { buildWordingPlan } from './egdesk-split-wording-plan.mjs'

const client = seen => ({ async decide(r) { seen.push(r); return { answers: {} } } })

test('without the previous message the triage questions are byte for byte as before; with it, courtesy and record get one sentence each', async () => {
  const seen = []
  await triageTurn({ message: 'ㅇㅇ', heldTitles: [], stored: [], client: client(seen) })
  await triageTurn({ message: 'ㅇㅇ', heldTitles: [], stored: [], client: client(seen), previousReply: '다음은 7번입니다. 계속 갈까요?' })
  const [a, b] = seen.map(r => Object.fromEntries(r.questions.map(q => [q.name, q.instructions])))
  assert.ok(!a.tn_courtesy.includes(COURTESY_WITH_PREVIOUS) && !a.tn_record.includes(RECORD_WITH_PREVIOUS))
  assert.equal(b.tn_courtesy, `${a.tn_courtesy} ${COURTESY_WITH_PREVIOUS}`)
  assert.equal(b.tn_record, `${a.tn_record} ${RECORD_WITH_PREVIOUS}`)
  assert.equal(b.tn_need, a.tn_need)
  assert.equal(b.tn_recall, a.tn_recall)
  // an empty or blank previous message is no previous message
  await triageTurn({ message: 'ㅇㅇ', heldTitles: [], stored: [], client: client(seen), previousReply: '   ' })
  assert.equal(JSON.stringify(seen[2].questions), JSON.stringify(seen[0].questions))
})

test('per-predicate wording: the measured choice (v2, own v3 since c24); v1 default; an object picks per key', () => {
  assert.deepEqual(SPLIT_WORDING_CHOICE, { other: 'v2', own: 'v3', guess: 'v2', before: 'v2', now: 'v2' })
  const text = '주문 내역을 보니 지난달 15일에 결제가 두 번 됐어.', spans = speechSegments(text)
  const by = w => Object.fromEntries(speechSplitQuestions(spans, text, { wording: w }).map(q => [q.name, q.instructions]))
  const v1 = by('v1'), v2 = by('v2'), mixed = by({ own: 'v1', other: 'v2' }), v3 = by({ other: 'v2', own: 'v3', guess: 'v2' })
  assert.deepEqual(by(undefined), v1)
  assert.equal(mixed.speechs_own_0, v1.speechs_own_0)
  assert.equal(mixed.speechs_other_0, v2.speechs_other_0)
  assert.equal(mixed.speechs_guess_0, v1.speechs_guess_0, 'a key the object does not name is v1')
  assert.notEqual(v3.speechs_own_0, by(SPLIT_WORDING_V2_AS_SENT).speechs_own_0, 'v3 own differs from the v2 own split-wording-v2 was sent with')
  assert.equal(v2.speechs_own_0, v3.speechs_own_0, "since c24 'v2' (the choice) asks own in v3")
  assert.match(v3.speechs_own_0, /주문 내역을 보니/)
  assert.equal(v3.speechs_guess_0, v2.speechs_guess_0)
  assert.equal(v3.speechs_before_0, v1.speechs_before_0, 'v3 changes only own; time keys not named stay v1')
})

test('the committed split-wording-v2 plan (sent in c26) is still what v2 builds', () => {
  const built = buildWordingPlan()
  const dir = new URL('../proofs/decision-real-measure/split-wording/', import.meta.url)
  for (const f of built.files) assert.ok(readFileSync(new URL(f.file, dir)).equals(f.bytes), f.file)
})
