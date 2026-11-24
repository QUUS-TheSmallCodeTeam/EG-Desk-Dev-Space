import test from 'node:test'
import assert from 'node:assert/strict'
import { world } from './egdesk-heartbeat-flow.fixture.mjs'
import { PERSON_PREDICATES, personDecision, personPredicates } from './egdesk-conversation-flow.mjs'

// c21 (Main): a person's message that arrives while a run works becomes a heartbeat fact; the beat asks about it (quoted alone) and code
// decides: a short true progress reply, the message steered into the working turn, or the run stopped. Developer flag, default off.
const STATUS = '아니 지금 왜 멈췄니?', CHANGE = '그거 말고 B부터 해줘', STOP = '그만해, 취소할게'
// The judge's answers for the person questions, by message (a sound judge); every other question as the fixture answers it.
const sound = { person_status: (q, r) => yesIf(r, STATUS), person_change: (q, r) => yesIf(r, CHANGE), person_stop: (q, r) => yesIf(r, STOP) }
const quoted = request => JSON.stringify(request.input)
const yesIf = (request, text) => quoted(request).includes(text)
const policy = Object.fromEntries(Object.entries(sound).map(([name, f]) => [name, f]))
// On the wire the heartbeat prefixes its provider: message__person_status.
function judged(w) { return w.beatRequests.filter(r => r.names.includes('message__person_status')) }
async function scene(t, { flags = { held: true, flow: true, inRun: true }, writer = null, steer = 'ok' } = {}) {
  const w = world(t, { flags, writer, steer, policy: {} })
  // the fixture judge answers predicates 0.03 unless a policy says otherwise: answer the person questions here
  const decide = w.chat.decisionContext.client.decide
  w.chat.decisionContext.client.decide = async request => {
    const out = await decide(request)
    for (const q of request.questions) { const f = sound[q.name.replace(/^message__/, '')]; if (f) out.answers[q.name] = { type: 'predicate', probability: f(q, request) ? 0.95 : 0.03 } }
    return out
  }
  const d = await w.dm('dm-a', '전체 테스트 돌리고 A 모듈부터 고쳐줘')
  await d.tool('cmd-1', 'started'); await w.advance(12_000)
  return { w, d }
}
const send = (w, d, message, n) => w.chat.send({ clientThreadId: 'dm-a', conversationId: d.r.conversationId, profileId: 'first-agent', replyDestination: 'direct', message, requestId: `req-in-${n}`, inRunMessage: true })

test('predicates: three yes/no questions, each quoting the message alone; code decides stop > change > status > steer (safe default)', () => {
  const qs = personPredicates(CHANGE)
  assert.deepEqual(qs.map(q => q.name), ['person_status', 'person_change', 'person_stop'])
  assert.ok(qs.every(q => q.quote.text === CHANGE && q.type === 'predicate'))
  assert.equal(PERSON_PREDICATES.status.instructions, 'Does this message ask what is happening, how far along the work is, or why it stopped?')
  assert.deepEqual([personDecision(new Set(['person_stop', 'person_change'])), personDecision(new Set(['person_change', 'person_status'])), personDecision(new Set(['person_status'])), personDecision(new Set())],
    ['stop', 'steer', 'reply', 'steer'])
})

test('"아니 지금 왜 멈췄니?" while the run works: recorded at once, judged at the next beat, answered with a short checked progress reply; the run keeps working, nothing is steered', async t => {
  const { w, d } = await scene(t, { writer: prompt => (/The person just wrote, while you work/.test(prompt) ? '멈춘 게 아니라 테스트를 계속 돌리고 있어요. 끝나면 바로 알려 드릴게요.' : null) })
  const before = d.assistant().length // the regular progress note of the first 10 s
  const r = await send(w, d, STATUS, 1)
  assert.deepEqual([r.accepted, r.inRun, r.held], [true, true, true])
  assert.deepEqual(d.history().filter(([role]) => role === 'user').map(([, text]) => text), ['전체 테스트 돌리고 A 모듈부터 고쳐줘', STATUS])
  await w.advance(6000)
  const asked = judged(w)
  assert.equal(asked.length, 1)
  assert.ok(JSON.stringify(asked[0].input).includes(STATUS), 'the message is quoted')
  assert.ok(w.forkPrompts.some(p => p.includes('The person just wrote, while you work') && p.includes(STATUS)))
  assert.deepEqual(d.assistant().slice(before), ['멈춘 게 아니라 테스트를 계속 돌리고 있어요. 끝나면 바로 알려 드릴게요.'])
  assert.equal(w.native.filter(([m]) => m === 'turn/steer').length, 0); assert.equal(w.native.filter(([m]) => m === 'turn/interrupt').length, 0)
  assert.equal(w.chat.flowRuns.get([...w.chat.runs.values()][0]).personMessages[0].action, 'replied')
  const rec = w.flowEntries().find(e => e.judgments?.some(j => j.q === 'beat_person_status'))
  assert.ok(rec, 'the beat is recorded in closed words'); assert.equal(rec.flow, 'reply')
})

test('"그거 말고 B부터 해줘": the task changes, so the message goes into the working turn as the person\'s words (turn/steer); nothing is posted for it', async t => {
  const { w, d } = await scene(t)
  const before = d.assistant().length
  await send(w, d, CHANGE, 1); await w.advance(6000)
  const steers = w.native.filter(([m]) => m === 'turn/steer')
  assert.equal(steers.length, 1)
  assert.deepEqual(steers[0][1].input, [{ type: 'text', text: CHANGE, text_elements: [] }])
  assert.equal(steers[0][1].expectedTurnId, d.timing.turnId)
  assert.ok(!d.assistant().slice(before).some(text => /B/.test(text)), 'no reply is posted for a change of task')
  assert.equal(w.chat.flowRuns.get([...w.chat.runs.values()][0]).personMessages[0].action, 'steered')
})

test('a stop request stops the run; a judge failure hands the message to the run; the flag off refuses as before', async t => {
  const { w, d } = await scene(t)
  await send(w, d, STOP, 1); await w.advance(6000)
  assert.equal(w.native.filter(([m]) => m === 'turn/interrupt').length, 1)
  // judge failure: steered (the run gets what the person wrote)
  const s2 = await scene(t)
  s2.w.chat.decisionContext.client.decide = async () => { throw Object.assign(new Error('down'), { code: 'unreachable' }) }
  await send(s2.w, s2.d, STATUS, 2); await s2.w.advance(6000)
  assert.equal(s2.w.native.filter(([m]) => m === 'turn/steer').length, 1)
  // flag off: refused while the run works
  const off = await scene(t, { flags: { held: true, flow: true } })
  await assert.rejects(send(off.w, off.d, STATUS, 3), error => error.code === 'RUN_IN_PROGRESS')
})
