import test from 'node:test'
import assert from 'node:assert/strict'
import { HEARTBEAT_LIMITS, createHeartbeat } from './egdesk-heartbeat.mjs'
import { createBeatJudge, beatRequest } from './egdesk-heartbeat-judge.mjs'

// The contract other features build on (header of egdesk-heartbeat.mjs), exercised with fake providers only:
// facts and questions in, ONE Decision request per asked beat, each provider's own verdicts out, shared bounds.
function clockwork() {
  let clock = 0
  const timers = []
  return { monotonicNow: () => clock, setTimer: (fn, ms) => { const t = { fn, at: clock + ms }; timers.push(t); return t },
    clearTimer: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) },
    async advance(ms) {
      const end = clock + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift(); clock = next.at; next.fn()
        for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r))
      }
      clock = end
      for (let i = 0; i < 6; i++) await new Promise(r => setImmediate(r))
    } }
}
const opt = (value, description = 'A fixed description.') => ({ value, description })
// A fake decision client: answers each question with the value its policy names (default: the first option).
function fakeClient(policy = {}) {
  const requests = []
  return { requests, async decide(request) {
    requests.push(request)
    const answers = {}
    for (const q of request.questions) {
      const values = q.choices.map(c => c.value), pick = policy[q.name] ?? values[0]
      answers[q.name] = { type: 'choice', choice: pick, confidence: 0.95, probabilities: [{ value: pick, probability: 0.96 }, { value: values.find(v => v !== pick), probability: 0.02 }] }
    }
    return { answers, usage: null }
  } }
}
const messageProvider = (seen, { from = 10_000 } = {}) => ({
  propose: beat => (beat.facts.sinceUserMs >= from ? { name: 'need', instructions: 'Should a short message be sent now?', options: [opt('none'), opt('explain_wait')], facts: { messages_sent: 0 } } : null),
  onVerdict: ({ verdicts }) => { seen.push(verdicts); return verdicts[0].value === 'none' ? 'none' : 'model' },
})

test('one request per asked beat carries the message question and a provider\'s questions; each receives only its own verdicts', async () => {
  const c = clockwork(), hb = createHeartbeat({ ...c }), forMessage = [], forPlacement = [], rounds = []
  const client = fakeClient({ message__need: 'explain_wait', placement__surface: 'guest_screen', placement__attention: 'none' })
  hb.setJudge(createBeatJudge({ client }), { onRound: summary => rounds.push(summary) })
  hb.register('message', messageProvider(forMessage))
  hb.register('placement', {
    facts: () => ({ openSurfaces: 2, phase: 'objective_step' }),
    propose: beat => (beat.facts.sinceUserMs >= 10_000 ? [
      { name: 'surface', instructions: 'Where should the needed surface open?', options: [opt('none'), opt('own_screen'), opt('guest_screen')], facts: { guest_viewport_free: true, owner_working_nearby: 'yes', note: 'free text is dropped 가나다' } },
      { name: 'attention', instructions: 'Should someone be pointed to it?', options: [opt('none'), opt('notify_owner')] }] : null),
    onVerdict: ({ verdicts }) => { forPlacement.push(verdicts); return 'placed' },
  })
  hb.start()
  await c.advance(5000)
  assert.equal(client.requests.length, 0, 'a beat on which nobody proposes costs no request')
  await c.advance(5000)
  assert.equal(client.requests.length, 1, 'ONE request for the whole beat')
  const [request] = client.requests
  assert.deepEqual(request.questions.map(q => q.name), ['message__need', 'placement__surface', 'placement__attention'])
  assert.deepEqual(request.questions[1].choices.map(c => c.value), ['none', 'own_screen', 'guest_screen'])
  assert.equal(request.promptCacheKey, 'heartbeat-beat')
  const text = request.input.map(row => row.content).join('\n')
  assert.match(text, /Session:\nseconds_since_the_person_wrote: 10\n/); assert.match(text, /current_phase: objective_step/)
  assert.match(text, /Question placement__surface:\nguest_viewport_free: yes\nowner_working_nearby: yes$/m)
  assert.ok(!text.includes('free text') && !text.includes('가나다'), 'question facts are numbers and closed labels only')
  // own verdicts only
  assert.deepEqual(forMessage.map(list => list.map(v => [v.name, v.value, v.accepted])), [[['need', 'explain_wait', true]]])
  assert.deepEqual(forPlacement.map(list => list.map(v => [v.name, v.value, v.accepted])), [[['surface', 'guest_screen', true], ['attention', 'none', true]]])
  assert.ok(Object.isFrozen(forPlacement[0]) && Object.isFrozen(forPlacement[0][0]))
  // the owner's content-free summary of the round
  assert.equal(rounds.length, 1)
  assert.deepEqual(rounds[0].questions.map(q => [q.provider, q.name, q.options, q.verdict.value]), [['message', 'need', 2, 'explain_wait'], ['placement', 'surface', 3, 'guest_screen'], ['placement', 'attention', 2, 'none']])
  assert.deepEqual(rounds[0].outcomes, { message: 'model', placement: 'placed' }); assert.equal(rounds[0].failure, null)
  assert.equal(hb.asks, 1)
  // facts-only subscribers never see verdicts
  const beats = []; hb.subscribe(beat => beats.push(Object.keys(beat)))
  await c.advance(5000)
  assert.deepEqual(beats, [['beat', 'internalMs', 'facts']])
})

test('closed vocabulary: a question with content in it is refused alone; the rest of the beat is asked', async () => {
  const c = clockwork(), hb = createHeartbeat({ ...c }), client = fakeClient(), got = []
  hb.setJudge(createBeatJudge({ client }))
  const good = { name: 'ok', instructions: 'A fixed question?', options: [opt('none'), opt('act')] }
  hb.register('bad', { propose: () => [
    { name: 'title', instructions: '카드 "분기 보고서"를 어디에 둘까요?', options: [opt('none'), opt('act')] }, // content in the prompt
    { name: 'value', instructions: 'Where?', options: [opt('none'), opt('Quarterly Report')] }, // an option that is not a closed label
    { name: 'described', instructions: 'Where?', options: [opt('none'), opt('act', '분기 보고서 옆')] },
    { name: 'long', instructions: 'x'.repeat(301), options: [opt('none'), opt('act')] },
    { name: 'single', instructions: 'Where?', options: [opt('none')] },
    { name: 'nonone', instructions: 'Where?', options: [opt('a'), opt('b')] },
    { name: 'dup', instructions: 'Where?', options: [opt('none'), opt('none')] },
    { name: 'Bad Name', instructions: 'Where?', options: [opt('none'), opt('act')] },
    { name: 'many', instructions: 'Where?', options: Array.from({ length: HEARTBEAT_LIMITS.maxOptions + 1 }, (_, i) => opt(i ? `o${i}` : 'none')) },
    { ...good, name: 'own_none', none: 'keep', options: [opt('keep'), opt('move')] },
    good], onVerdict: ({ verdicts }) => { got.push(verdicts.map(v => v.name)) } })
  hb.start(); await c.advance(5000)
  assert.deepEqual(client.requests[0].questions.map(q => q.name), ['bad__own_none', 'bad__ok'])
  assert.deepEqual(got, [['own_none', 'ok']])
  assert.ok(!JSON.stringify(client.requests).includes('분기'))
})

test('shared bounds: 10 s between requests, doubling after each all-"none" round, a never-offered option may ask at once, six requests per heartbeat, six questions per request', async () => {
  const c = clockwork(), hb = createHeartbeat({ ...c }), asked = []
  let options = [opt('none'), opt('a')], value = 'none'
  hb.setJudge(async ({ beat, questions }) => { asked.push([beat.internalMs / 1000, questions.length]); return Object.fromEntries(questions.map(q => [q.wire, { value, accepted: true }])) })
  hb.register('p', { propose: () => ({ name: 'q', instructions: 'Act now?', options }), onVerdict() {} })
  hb.start()
  await c.advance(30_000)
  assert.deepEqual(asked.map(a => a[0]), [5, 25], 'after one "none" the same question waits 20 s (after two, 40 s)')
  options = [opt('none'), opt('a'), opt('b')] // a new option becomes possible
  await c.advance(5000)
  assert.deepEqual(asked.map(a => a[0]), [5, 25, 35], 'asked at once although the 40 s gap had not passed')
  value = 'a'
  await c.advance(40_000) // 75 s: three "none" in a row, the gap is 80 s
  assert.deepEqual(asked.map(a => a[0]), [5, 25, 35])
  await c.advance(40_000) // 115 s = 35 + 80
  assert.deepEqual(asked.map(a => a[0]), [5, 25, 35, 115])
  await c.advance(300_000)
  assert.deepEqual(asked.map(a => a[0]), [5, 25, 35, 115, 125, 135], 'a round that acted resets the gap to 10 s; then the heartbeat\'s six requests are used up')
  assert.equal(hb.asks, HEARTBEAT_LIMITS.maxAsks)
  const wide = createHeartbeat({ ...c }), sizes = []
  wide.setJudge(async ({ questions }) => { sizes.push(questions.length); return {} })
  for (const name of ['a', 'b']) wide.register(name, { propose: () => Array.from({ length: 5 }, (_, i) => ({ name: `q${i}`, instructions: 'Act now?', options: [opt('none'), opt('act')] })) })
  wide.start(); await c.advance(5000)
  assert.deepEqual(sizes, [HEARTBEAT_LIMITS.maxQuestions])
})

test('one round at a time: while a provider is still acting on its verdict nothing new is asked', async () => {
  const c = clockwork(), hb = createHeartbeat({ ...c }), asked = []
  let release
  hb.setJudge(async ({ beat, questions }) => { asked.push(beat.beat); return Object.fromEntries(questions.map(q => [q.wire, { value: 'act', accepted: true }])) })
  hb.register('slow', { propose: () => ({ name: 'q', instructions: 'Act now?', options: [opt('none'), opt('act')] }), onVerdict: () => new Promise(resolve => { release = resolve }) })
  hb.start(); await c.advance(30_000)
  assert.deepEqual(asked, [1], 'beats 2 to 6 fall inside the open round')
  release('done'); await new Promise(resolve => setImmediate(resolve)); await c.advance(5000)
  assert.deepEqual(asked, [1, 7])
  // A provider that never returns cannot hold the heartbeat for ever: the round is given up after roundMs.
  await c.advance(HEARTBEAT_LIMITS.roundMs + 5000)
  assert.equal(asked.length, 3)
})

test('failures stay local: a judge error, a throwing provider, a disallowed kind and a stop in mid-round', async () => {
  const c = clockwork()
  const hb = createHeartbeat({ ...c }), got = [], rounds = []
  hb.setJudge(async () => { throw Object.assign(new Error('x'), { code: 'timeout' }) }, { onRound: s => rounds.push(s) })
  hb.register('p', { propose: () => ({ name: 'q', instructions: 'Act now?', options: [opt('none'), opt('act')] }), onVerdict: ({ verdicts }) => { got.push(verdicts[0]) } })
  hb.register('thrower', { propose: () => { throw new Error('propose failed') } })
  hb.start(); await c.advance(5000)
  assert.deepEqual([got[0].value, got[0].accepted, got[0].failed, rounds[0].failure], ['none', false, true, 'timeout'])
  // a kind the run's models may not receive: that question is skipped alone
  const h2 = createHeartbeat({ ...c }), client = fakeClient({ a__q: 'act', b__q: 'act' }), seen = {}
  h2.setJudge(createBeatJudge({ client, allows: kind => kind !== 'canvas_text' }))
  h2.register('a', { propose: () => ({ name: 'q', instructions: 'Act now?', options: [opt('none'), opt('act')], kinds: ['canvas_text'] }), onVerdict: ({ verdicts }) => { seen.a = verdicts[0] } })
  h2.register('b', { propose: () => ({ name: 'q', instructions: 'Act now?', options: [opt('none'), opt('act')] }), onVerdict: ({ verdicts }) => { seen.b = verdicts[0]; throw new Error('handler failed') } })
  h2.start(); await c.advance(5000)
  assert.deepEqual(client.requests[0].questions.map(q => q.name), ['b__q'])
  assert.deepEqual([seen.a.value, seen.a.accepted, seen.a.skipped, seen.b.value, seen.b.accepted], ['none', false, true, 'act', true])
  // every question disallowed: no request at all
  const h3 = createHeartbeat({ ...c }), none = fakeClient()
  h3.setJudge(createBeatJudge({ client: none, allows: () => false }))
  h3.register('a', { propose: () => ({ name: 'q', instructions: 'Act now?', options: [opt('none'), opt('act')], kinds: ['canvas_text'] }), onVerdict() {} })
  h3.start(); await c.advance(5000); assert.equal(none.requests.length, 0)
  // stopped while the judge was thinking: no verdict is delivered
  const h4 = createHeartbeat({ ...c }), late = []
  let answer
  h4.setJudge(() => new Promise(resolve => { answer = resolve }))
  h4.register('p', { propose: () => ({ name: 'q', instructions: 'Act now?', options: [opt('none'), opt('act')] }), onVerdict: v => { late.push(v) } })
  h4.start(); await c.advance(5000); h4.stop('run_end'); answer({ p__q: { value: 'act', accepted: true } }); await c.advance(1000)
  assert.deepEqual(late, [])
  // an uncertain answer is not an act
  assert.equal(beatRequest({ beat: { facts: h2.facts() }, questions: [] }).questions.length, 0)
})
