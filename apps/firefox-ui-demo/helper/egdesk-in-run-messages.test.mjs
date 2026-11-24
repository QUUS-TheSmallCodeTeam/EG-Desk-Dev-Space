import test from 'node:test'
import assert from 'node:assert/strict'
import { world } from './egdesk-heartbeat-flow.fixture.mjs'
import { PERSON_PREDICATES, personDecision, personPredicates, workMsOf, writerPrompt } from './egdesk-conversation-flow.mjs'

// c21/c22 (Main): a person's message that arrives while a run works (lane L2's contract: inRunMessageTo, the inRunMessages flag, its queue)
// is judged at the next beat (quoted alone) and settled through settleInRunMessage: a short true progress reply ('reply'), the message
// steered into the working turn ('steer'), or the run stopped ('interrupt'). Developer flag, default off.
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
const send = (w, d, message, n) => w.chat.send({ clientThreadId: 'dm-a', conversationId: d.r.conversationId, profileId: 'first-agent', replyDestination: 'direct', message, requestId: `req-in-${n}`, inRunMessageTo: d.timing.turnId })
const settled = (w, id) => w.chat.flowRuns.get([...w.chat.runs.values()][0]).personJudged?.get(id)

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
  assert.deepEqual([r.accepted, r.inRun], [true, true])
  assert.deepEqual(w.chat.pendingInRunMessages([...w.chat.runs.values()][0]).map(m => m.text), [STATUS], 'queued in lane L2\'s queue until the beat settles it')
  assert.deepEqual(d.history().filter(([role]) => role === 'user').map(([, text]) => text), ['전체 테스트 돌리고 A 모듈부터 고쳐줘', STATUS])
  await w.advance(6000)
  const asked = judged(w)
  assert.equal(asked.length, 1)
  assert.ok(JSON.stringify(asked[0].input).includes(STATUS), 'the message is quoted')
  assert.ok(w.forkPrompts.some(p => p.includes('The person just wrote, while you work') && p.includes(STATUS)))
  assert.deepEqual(d.assistant().slice(before), ['멈춘 게 아니라 테스트를 계속 돌리고 있어요. 끝나면 바로 알려 드릴게요.'])
  assert.equal(w.native.filter(([m]) => m === 'turn/steer').length, 0); assert.equal(w.native.filter(([m]) => m === 'turn/interrupt').length, 0)
  assert.equal(settled(w, 'req-in-1'), 'reply'); assert.deepEqual(w.chat.pendingInRunMessages([...w.chat.runs.values()][0]), [])
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
  assert.equal(settled(w, 'req-in-1'), 'steer')
})

test('a stop request stops the run; a judge failure hands the message to the run; the flag off refuses as before', async t => {
  const { w, d } = await scene(t)
  await send(w, d, STOP, 1); await w.advance(6000)
  assert.equal(w.native.filter(([m]) => m === 'turn/interrupt').length, 1); assert.equal(settled(w, 'req-in-1'), 'interrupt')
  // judge failure: steered (the run gets what the person wrote)
  const s2 = await scene(t)
  s2.w.chat.decisionContext.client.decide = async () => { throw Object.assign(new Error('down'), { code: 'unreachable' }) }
  await send(s2.w, s2.d, STATUS, 2); await s2.w.advance(6000)
  assert.equal(s2.w.native.filter(([m]) => m === 'turn/steer').length, 1); assert.equal(settled(s2.w, 'req-in-2'), 'steer')
  // flag off: refused before anything is stored (lane L2's 409)
  const off = await scene(t, { flags: { held: true, flow: true } })
  await assert.rejects(send(off.w, off.d, STATUS, 3), error => error.code === 'INRUN_MESSAGE_UNAVAILABLE' && error.httpStatus === 409)
  assert.ok(!off.d.history().some(([, text]) => text === STATUS))
})

// c24 (lane L2's v6 real run): the reply prompt said "about 1 seconds so far" for a command that had run about 10 s. The person's message into the
// working run marks "user" again, so sinceUserMs restarts at the nudge; the work's age is measured from the run's start on the heartbeat clock.
test('the reply is told how long the WORK has gone (fake clock), not how long since the person wrote into it', async t => {
  const { w, d } = await scene(t, { writer: prompt => (/The person just wrote, while you work/.test(prompt) ? '멈춘 게 아니라 아직 실행 중이에요.' : null) })
  await send(w, d, STATUS, 1); await w.advance(6000)
  const prompt = w.forkPrompts.find(p => /The person just wrote, while you work/.test(p))
  assert.ok(prompt, 'the reply was written')
  const seconds = Number(/has taken about (\d+) seconds?/.exec(prompt)?.[1] ?? /about (\d+) seconds so far/.exec(prompt)?.[1])
  assert.ok(seconds >= 12 && seconds <= 14, `the work had run 12 s when the person wrote: said ${seconds}`)
  assert.ok(!/about [0-3] seconds? so far/.test(prompt))
  // the beat's own request carries both times, as facts
  const asked = judged(w)[0]
  assert.match(JSON.stringify(asked.input), /The work began 1[2-9] seconds ago \(the person wrote again into the running work [0-2] seconds? ago\)/)
})

test('workMsOf and the prompts (pure): the work\'s age wins over the time since the last message; unknown start falls back to it', () => {
  assert.equal(workMsOf({ internalMs: 15_000 }, { runStartedMs: 4_600 }), 10_400)
  assert.equal(workMsOf({ internalMs: 15_000 }, {}), null); assert.equal(workMsOf({}, { runStartedMs: 1 }), null)
  const facts = { elapsedMs: 800, workMs: 10_400, stepsDone: 1, personMessage: STATUS, waits: [] }
  assert.match(writerPrompt('reply_status', facts), /about 10 seconds so far/)
  assert.match(writerPrompt('explain_wait', facts), /about 10 seconds so far/)
  assert.match(writerPrompt('reply_status', { ...facts, workMs: null }), /about 1 seconds so far/, 'unknown start: the old figure, as before')
  assert.match(writerPrompt('stalled', { ...facts, sinceEngineMs: 21_000 }), /about 21 seconds/, 'silence is its own figure'); assert.match(writerPrompt('stalled', { ...facts, sinceEngineMs: null }), /about 10 seconds/, 'unknown silence: the work\'s age')
})

// c24 (Main): the person's messages are judged at the next beat whatever the heartbeat's ask gap (10 s) and nudge limit (once per 5 s) say; those
// bounds are for the assistant's unprompted notes.
test('a stop one second after another message is acted on at the next beat (0.5 s), not after the ask gap or the nudge limit (fake clock)', async t => {
  const { w, d } = await scene(t, { writer: prompt => (/The person just wrote, while you work/.test(prompt) ? '멈춘 게 아니라 아직 실행 중이에요.' : null) })
  const run = [...w.chat.runs.values()][0]
  const t0 = w.at()
  await send(w, d, STATUS, 1); await w.advance(600)
  assert.equal(settled(w, 'req-in-1'), 'reply', 'the first message was answered within 0.6 s')
  await w.advance(400)                          // one second after the first message: inside the 5 s nudge limit and the 10 s ask gap
  const sentAt = w.at()
  await send(w, d, STOP, 2); await w.advance(600)
  assert.equal(settled(w, 'req-in-2'), 'interrupt', 'the stop was judged at the next beat')
  assert.equal(w.native.filter(([m]) => m === 'turn/interrupt').length, 1)
  assert.ok(w.at() - sentAt <= 700 && sentAt - t0 <= 1100)
  const askedStop = judged(w).at(-1)
  assert.ok(JSON.stringify(askedStop.input).includes(STOP) && !askedStop.names.some(n => !/^message__person_/.test(n)), 'asked alone, about that message')
  assert.deepEqual(w.chat.pendingInRunMessages(run), [])
  // the assistant's own notes were not moved by those two rounds: the beat record says the person rounds did not count as asks
  const rounds = w.flowEntries().filter(e => e.judgments?.some(j => /^beat_person_/.test(j.q)))
  assert.equal(rounds.length, 2)
})
