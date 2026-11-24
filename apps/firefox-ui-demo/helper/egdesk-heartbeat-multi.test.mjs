import test from 'node:test'
import assert from 'node:assert/strict'
import { audienceFacts } from './egdesk-conversation-flow.mjs'
import { MID, world } from './egdesk-heartbeat-flow.fixture.mjs'

// Cycle 12 on the virtual clock (mock engine, mock decision model): other features' questions on the heartbeat, who is waiting
// and where a message may go, long reasoning versus a stalled engine, and a bounded run opted in to intermediate messages.
const opt = (value, description = 'A fixed description.') => ({ value, description })

test('a provider\'s question rides the same request as the message question; each gets its own verdict; a question whose kind is not allowed is skipped alone', async t => {
  const w = world(t, { policy: { placement__surface: () => 'guest_screen' } }), d = await w.dm('dm-place')
  const placed = [], skipped = []
  d.hb.register('placement', { facts: () => ({ openSurfaces: 1 }),
    propose: beat => (beat.facts.sinceUserMs >= 10_000 && !placed.length ? { name: 'surface', instructions: 'Where should the surface this task needs be opened?',
      options: [opt('none'), opt('own_screen'), opt('guest_screen')], facts: { guest_viewport_free: true, owner_busy_nearby: 'yes' } } : null),
    onVerdict: ({ verdicts }) => { placed.push(verdicts); return 'placed' } })
  d.hb.register('attention', { propose: beat => (beat.facts.sinceUserMs >= 10_000 && !skipped.length ? { name: 'card', instructions: 'Should a card be pointed out?', options: [opt('none'), opt('point')], kinds: ['canvas_text'] } : null),
    onVerdict: ({ verdicts }) => { skipped.push(verdicts) } })
  await w.advance(2000); await d.tool('s1', 'started'); await w.advance(8000)
  assert.equal(w.requests.flow, 1, 'one Decision request for the beat')
  assert.deepEqual(w.beatRequests[0].names, ['message__need', 'placement__surface'], 'the canvas question is not sent: no card of this run may go to a model')
  assert.match(w.beatRequests[0].input.join('\n'), /Question placement__surface:\nguest_viewport_free: yes\nowner_busy_nearby: yes/)
  assert.deepEqual(placed.map(list => list.map(v => [v.name, v.value, v.accepted])), [[['surface', 'guest_screen', true]]])
  assert.deepEqual(skipped.map(list => list.map(v => [v.name, v.value, v.accepted, v.skipped])), [[['card', 'none', false, true]]])
  assert.deepEqual(d.assistant(), [MID], 'the message question was judged in the same request')
  assert.equal(d.beats[1].sources.placement.openSurfaces, 1)
  const entry = w.flowEntries().at(-1)
  assert.deepEqual([entry.questions, entry.flow, entry.posted, entry.judgments.map(j => j.provider)], [3, 'explain_wait', 'model', ['message', 'placement']])
  await d.final('끝났습니다.')
  t.diagnostic(`provider questions: requests=${w.requests.flow} questions sent=${w.beatRequests[0].names.length} of 3 proposed; verdicts message=explain_wait placement=guest_screen attention=skipped`)
})

const GUEST = (active, idle = 3000) => ({ member: 'guest-1', self: false, active, viewport: null, focusCard: null, lastInputAgeMs: idle })
const OWNER = (active, idle = 1000) => ({ member: 'owner-1', self: true, active, viewport: null, focusCard: null, lastInputAgeMs: idle })
const both = { requester: 'guest-1', owner: 'owner-1', participants: ['guest-1', 'owner-1'] }
for (const [label, rows, audience, expected] of [
  ['the requester (an invited person) is present', [GUEST(true), OWNER(false)], both, { posts: 1, waiting: 'requester', own: /waiting_person: requester\nwaiting_person_present: yes\nwaiting_person_idle_seconds: 3/ }],
  ['the requester is away, the owner is present and takes part', [GUEST(false), OWNER(true)], both, { posts: 1, waiting: 'owner', own: /waiting_person: owner\nwaiting_person_present: yes\nwaiting_person_idle_seconds: 1/ }],
  ['nobody is present', [GUEST(false), OWNER(false)], both, { posts: 0, waiting: 'nobody', requests: 0 }],
  ['a third person takes part in the conversation', [GUEST(true), OWNER(true)], { ...both, participants: ['guest-1', 'owner-1', 'other-2'] }, { posts: 0, waiting: 'requester', requests: 0 }],
  ['the owner is present but not in this conversation', [GUEST(false), OWNER(true)], { ...both, participants: ['guest-1'] }, { posts: 0, waiting: 'owner', requests: 0, inConversation: false }],
]) {
  test(`who is waiting: ${label}`, async t => {
    const presence = { rows, snapshot() { return this.rows } }
    const w = world(t, { presence, audience: () => audience }), d = await w.dm('dm-shared')
    await w.advance(2000); await d.tool('s1', 'started'); await w.advance(18_000)
    assert.equal(d.assistant().length, expected.posts)
    if (expected.requests !== undefined) assert.equal(w.requests.flow, expected.requests, 'nothing may be said here, so nothing is asked')
    if (expected.own) assert.match(w.flowAsked[0].own, expected.own)
    const seen = d.beats.at(-1).sources.audience
    assert.equal(seen.waiting, expected.waiting); assert.equal(seen.postable, expected.posts > 0)
    if (expected.inConversation === false) assert.deepEqual([seen.addressee, seen.addresseeInConversation], ['owner', false], 'other providers can see that the owner is elsewhere')
    assert.ok(!JSON.stringify([w.beatRequests, d.beats, w.flowEntries()]).match(/guest-1|owner-1|other-2/), 'member ids never reach the decision model, the beats or the record')
    await d.final('끝났습니다.')
    if (expected.posts) assert.deepEqual(d.history().map(r => r[0]), ['user', 'assistant', 'assistant'])
  })
}

test('the waiting person leaves between the verdict and the post: nothing is posted; without a presence feed the behaviour is as before', async t => {
  const presence = { rows: [GUEST(true), OWNER(false)], snapshot() { return this.rows } }
  const w = world(t, { presence, audience: () => both, policy: { message: values => { presence.rows = [GUEST(false), OWNER(false)]; return values.includes('explain_wait') ? 'explain_wait' : 'none' } } })
  const d = await w.dm('dm-leaves')
  await w.advance(2000); await d.tool('s1', 'started'); await w.advance(13_000)
  assert.equal(w.requests.flow, 1); assert.equal(w.forkPrompts.length, 1, 'the message was written')
  assert.deepEqual(d.assistant(), [], 'and not posted: nobody is waiting any more')
  assert.deepEqual([w.flowEntries()[0].flow, w.flowEntries()[0].posted], ['explain_wait', 'none'])
  await d.final('끝났습니다.')
  const solo = world(t), s = await solo.dm('dm-solo')
  await solo.advance(2000); await s.tool('s1', 'started'); await solo.advance(8000)
  assert.deepEqual(s.assistant(), [MID]); assert.match(solo.flowAsked[0].own, /waiting_person: requester\nwaiting_person_present: unknown/)
  await s.final('끝났습니다.')
  // the pure rule
  assert.deepEqual(audienceFacts({}), { waiting: 'requester', addressee: 'requester', addresseePresent: null, addresseeIdleMs: null, addresseeInConversation: true, outsiders: 0, postable: true })
  assert.equal(audienceFacts({ audience: both, presence: [] }).waiting, 'nobody')
  assert.equal(audienceFacts({ presence: [{ member: 'me', self: true, active: true, lastInputAgeMs: 10 }] }).postable, true, "'self' matches the row marked self")
})

test('long reasoning is not a stall: reasoning deltas, part boundaries and token updates all count as engine activity', async t => {
  const w = world(t), d = await w.dm('dm-thinking')
  await w.advance(1000); await d.raw('item/started', { item: { id: 'r1', type: 'reasoning', summary: [], content: [] } })
  const during = [['item/reasoning/summaryTextDelta', { itemId: 'r1', delta: '생각 ' }], ['item/reasoning/summaryPartAdded', { itemId: 'r1', summaryIndex: 1 }],
    ['item/reasoning/textDelta', { itemId: 'r1', delta: 'x', contentIndex: 0 }], ['thread/tokenUsage/updated', { tokenUsage: { modelContextWindow: 1000, total: { totalTokens: 10 }, last: { totalTokens: 10 } } }]]
  for (let i = 0; w.at() < 59_000; i++) { await w.advance(4000); await d.raw(...during[i % during.length]) }
  await w.advance(60_000 - w.at())
  assert.equal(d.hb.beats, 12)
  assert.ok(d.beats.every(b => b.sinceEngineMs <= 4000), 'never silent for more than one delta interval')
  assert.ok(w.flowAsked.length >= 1 && w.flowAsked.every(a => !a.offered.includes('stalled')), 'the stall option is never offered')
  assert.match(w.flowAsked[0].own, /reasoning_in_progress: yes/)
  assert.match(w.beatRequests[0].input[1], /last_activity_from_the_work: (reasoning|usage)/)
  assert.deepEqual(d.assistant(), [])
  await d.final('오래 생각했습니다. 결론입니다.')
  t.diagnostic(`long reasoning 60 s: beats=${d.hb.beats} requests=${w.requests.flow} stalled offered=0 messages=${d.assistant().length} (final only)`)
})

test('a reasoning item is open and the engine sends nothing: the stall bound is 60 s, not 20 s; without an open item it stays 20 s', async t => {
  const w = world(t), d = await w.dm('dm-quiet-thinking')
  await w.advance(1000); await d.raw('item/started', { item: { id: 'r1', type: 'reasoning', summary: [], content: [] } })
  await w.advance(54_000) // 55 s: 54 s of silence with the item open
  assert.ok(w.flowAsked.every(a => !a.offered.includes('stalled')))
  await w.advance(10_000) // 65 s: the first beat with at least 60 s of silence
  assert.ok(w.flowAsked.at(-1).offered.includes('stalled')); assert.match(w.flowAsked.at(-1).own, /reasoning_in_progress: yes/)
  await d.final('끝났습니다.')
  const closed = world(t), c = await closed.dm('dm-after-thinking')
  await closed.advance(1000); await c.raw('item/started', { item: { id: 'r1', type: 'reasoning', summary: [], content: [] } })
  await closed.advance(2000); await c.raw('item/completed', { item: { id: 'r1', type: 'reasoning', summary: [], content: [] } })
  await closed.advance(22_000) // 25 s: 22 s of silence, nothing open
  assert.ok(closed.flowAsked.at(-1).offered.includes('stalled')); assert.match(closed.flowAsked.at(-1).own, /reasoning_in_progress: no/)
  await c.final('끝났습니다.')
})

test('a bounded run opted in speaks through the same path; its final answer is not held; another bounded run is unaffected', async t => {
  const w = world(t)
  const bounded = { executionPolicy: { mode: 'readOnlyQa' } }
  const task = await w.dm('dm-task', '점검해 주세요', bounded), other = await w.dm('dm-other', '점검해 주세요', bounded)
  assert.deepEqual(w.chat.snapshot().runs.map(run => run.executionPolicy?.mode), ['readOnlyQa', 'readOnlyQa'])
  assert.equal(w.chat.allowIntermediateMessages('dm-task'), true); assert.equal(w.chat.allowIntermediateMessages('dm-none'), false)
  await w.advance(2000); await task.tool('s1', 'started'); await other.tool('s1', 'started')
  await w.advance(10_000)
  assert.deepEqual(task.assistant(), [MID], 'a completed, checked message from the opted-in run')
  assert.deepEqual(other.assistant(), [], 'the other bounded run says nothing')
  assert.equal(w.requests.flow, 1, 'and is never asked about')
  // the opted-in run's final answer streams as it does today (it is not held), and nothing is said once it has begun
  await task.raw('item/started', { item: { id: 'ans', type: 'agentMessage', phase: 'final_answer', text: '' } })
  await task.raw('item/agentMessage/delta', { itemId: 'ans', delta: '점검을 ' })
  assert.ok(w.events.some(e => e.event === 'message.delta' && e.clientThreadId === 'dm-task'), 'streamed, not held')
  await w.advance(40_000)
  assert.deepEqual(task.assistant().filter(text => text === MID).length, 1)
  await task.raw('item/completed', { item: { id: 'ans', type: 'agentMessage', phase: 'final_answer', text: '점검을 마쳤습니다.' } })
  await task.final(null); await other.final(null)
  assert.deepEqual(task.history().map(r => r[1]), ['점검해 주세요', MID, '점검을 마쳤습니다.'])
  // the opt-in needs the draft check: without it nothing is said
  const unchecked = world(t, { flags: { held: false, flow: true } }), u = await unchecked.dm('dm-unchecked', '점검해 주세요', bounded)
  unchecked.chat.allowIntermediateMessages('dm-unchecked')
  await unchecked.advance(2000); await u.tool('s1', 'started'); await unchecked.advance(20_000)
  assert.equal(unchecked.requests.flow, 0); await u.final(null)
  t.diagnostic(`bounded opt-in: messages task=${task.assistant().length} other=${other.assistant().length} requests=${w.requests.flow}`)
})

test('the decision budget is the existing one: a refused request is recorded and nothing is said', async t => {
  const w = world(t, { policy: { message: () => { throw Object.assign(new Error('budget'), { code: 'budget_exceeded' }) } } }), d = await w.dm('dm-budget')
  await w.advance(2000); await d.tool('s1', 'started'); await w.advance(26_000) // 28 s
  assert.deepEqual(d.assistant(), [])
  assert.deepEqual(w.flowEntries().map(e => [e.fallback, e.posted, e.judgments.length]), [['budget_exceeded', 'none', 0]], 'asked at 10 s; after a failed round the same question waits 20 s')
  await w.advance(2000) // 30 s
  assert.equal(w.flowEntries().length, 2); assert.deepEqual(d.assistant(), [])
  await d.final('끝났습니다.')
})

test('a tool that runs quietly for a long time is a wait to explain, not a stalled engine', async t => {
  const w = world(t), d = await w.dm('dm-quiet-tool')
  await w.advance(2000); await d.tool('s1', 'started')
  await w.advance(58_000) // 60 s, 58 s without any engine event while the step runs
  assert.deepEqual(d.assistant(), [MID])
  assert.ok(w.flowAsked.every(a => !a.offered.includes('stalled')))
  assert.equal(d.beats.at(-1).phase, 'tool_running')
  await d.tool('s1', 'completed'); await d.final('끝났습니다.')
})

test('before the run exists (a pre-turn objective loop) a provider\'s question is already judged through the conversation\'s gate', async t => {
  const w = world(t, { policy: { browser_task__progress: () => 'tell' } })
  const hb = w.chat.startHeartbeat({ clientThreadId: 'dm-pre', toolCeiling: null }, 'native-pre')
  const got = []
  hb.register('browser_task', { facts: () => ({ phase: 'objective_step', stepsDone: 6 }),
    propose: beat => (beat.facts.sinceUserMs >= 10_000 && !got.length ? { name: 'progress', instructions: 'Should the person be told that the browser task is still going?', options: [opt('none'), opt('tell')] } : null),
    onVerdict: ({ verdicts }) => { got.push(verdicts[0].value) } })
  await w.advance(10_000)
  assert.deepEqual(w.beatRequests.map(r => r.names), [['browser_task__progress']]); assert.deepEqual(got, ['tell'])
  assert.match(w.beatRequests[0].input[1], /current_phase: objective_step/)
  assert.equal(w.events.filter(e => e.event?.startsWith('message.')).length, 0, 'nothing is posted by the runtime: there is no run to carry a message yet')
  w.chat.stopHeartbeat(hb, 'run_end'); assert.equal(w.timers.length, 0)
})
