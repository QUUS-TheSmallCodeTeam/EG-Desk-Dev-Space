// c34: the heartbeat note question's concrete wording as an opt-in of the conversation flow (conversationFlow.noteWording() === 'waiting', EGDESK_FLOW_NOTE_WORDING=waiting).
// Default unchanged, no text the person sees changes (it is a question to the Decision model, not copy). Measured in c53: standard .83/.75 on two phrasings, 'waiting' 1.0 on three.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { FLOW_PREDICATES, NOTE_WORDING, flowPredicates } from './egdesk-conversation-flow.mjs'
import { world } from './egdesk-heartbeat-flow.fixture.mjs'

test('pure: by default and with an unknown value the note question is the standard wording; "waiting" swaps ONLY the instructions (name, type, topic stay)', () => {
  const standard = flowPredicates(['explain_wait']), same = flowPredicates(['explain_wait'], { noteWording: 'standard' }), unknown = flowPredicates(['explain_wait'], { noteWording: 'nonsense' })
  assert.deepEqual(standard, same); assert.deepEqual(standard, unknown); assert.equal(standard[0].instructions, NOTE_WORDING.standard); assert.equal(NOTE_WORDING.standard, FLOW_PREDICATES.note.instructions, 'the standard text is the one shipped before')
  const waiting = flowPredicates(['explain_wait', 'stalled'], { noteWording: 'waiting' })
  assert.deepEqual(waiting.map(q => [q.name, q.type, q.topic]), [['note', 'predicate', 'explain_wait_stalled']]); assert.equal(waiting[0].instructions, NOTE_WORDING.waiting)
  assert.match(NOTE_WORDING.waiting, /left waiting with nothing said/); assert.doesNotMatch(NOTE_WORDING.waiting, /second|\d/, 'no timing in the question: when it is asked is code (firstAfterMs)')
})

test('pure: the other questions are untouched by the wording, and no note question exists when code offers no note kind', () => {
  const a = flowPredicates(['ask_missing'], { note: { text: '파일 경로가 필요합니다.' } }), b = flowPredicates(['ask_missing'], { note: { text: '파일 경로가 필요합니다.' }, noteWording: 'waiting' })
  assert.deepEqual(a, b); assert.deepEqual(flowPredicates([], { noteWording: 'waiting' }), []); assert.deepEqual(flowPredicates(['pointer'], { noteWording: 'waiting' }), flowPredicates(['pointer']))
})

async function questionText(flags) {
  const instructions = []
  const t = { after: () => {} }, w = world(t, { flags: { held: true, flow: true, ...flags }, tap: async request => { const q = request.questions.find(x => x.name === 'message__note'); if (q) instructions.push(q.instructions) } }), d = await w.dm('dm-wording')
  await w.advance(1000); await d.tool('s1', 'started'); await w.advance(12000)
  assert.ok(instructions.length > 0, 'the heartbeat asked the note question at least once'); return instructions
}

test('runtime: the Decision request carries the standard question by default and the concrete one only when the flow opts in', async () => {
  const standard = await questionText({}), waiting = await questionText({ noteWording: 'waiting' })
  assert.ok(standard.every(x => x === NOTE_WORDING.standard), 'default: unchanged')
  assert.ok(waiting.every(x => x === NOTE_WORDING.waiting), 'opt-in: the concrete wording')
  assert.ok((await questionText({ noteWording: 'anything-else' })).every(x => x === NOTE_WORDING.standard), 'an unknown value is not an opt-in')
})

test('the bridge, the real-engine check and the check composition read the opt-in from EGDESK_FLOW_NOTE_WORDING=waiting and nothing else changes the default', () => {
  for (const file of ['codex-bridge-server.mjs', 'egdesk-real-engine-check.mjs']) {
    const src = fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
    assert.match(src, /EGDESK_FLOW_NOTE_WORDING === 'waiting' \? \{ noteWording: \(\) => 'waiting' \} : \{\}/, file)
  }
  assert.match(fs.readFileSync(new URL('./egdesk-real-engine-check.mjs', import.meta.url), 'utf8'), /'EGDESK_FLOW_NOTE_WORDING'/)
})
