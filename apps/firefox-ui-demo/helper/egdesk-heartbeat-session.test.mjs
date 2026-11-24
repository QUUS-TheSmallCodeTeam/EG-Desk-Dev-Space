import test from 'node:test'
import assert from 'node:assert/strict'
import { HEARTBEAT_LIMITS, createHeartbeat, createHeartbeats } from './egdesk-heartbeat.mjs'
import { FLOW_LIMITS, WAIT_LABELS, attentionOf, enumerateOptions, pointerPrompt, pointerRoute, waitSummary, writerPrompt } from './egdesk-conversation-flow.mjs'
import { world } from './egdesk-heartbeat-flow.fixture.mjs'

// The session heartbeat (cycle 13): it lives as long as the conversation's session, across runs, at two tempos; the message
// judgment reads the providers' facts as closed labels; a pointer message tells a person where something waits for them.
// Virtual clock and timers throughout; mock engine and mock decision model; no network, no Codex binary.

function clockwork() {
  let clock = 70_000
  const timers = []
  return { monotonicNow: () => clock, pending: () => timers.length,
    setTimer: (fn, ms) => { const timer = { fn, at: clock + ms }; timers.push(timer); return timer },
    clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1) },
    advance(ms) { const end = clock + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const next = timers[0]; if (!next || next.at > end) break; timers.shift(); clock = next.at; next.fn() } clock = end } }
}
const S = HEARTBEAT_LIMITS

// ---- the heartbeat's own lifetime and tempo ----

test('tempo: a beat every 5 s while a run works, every 20 s after it; the idle session ends by itself after 5 minutes with nothing pending', () => {
  const c = clockwork(), hb = createHeartbeat({ key: 'dm', ...c }), at = []
  hb.subscribe(beat => at.push([beat.facts.internalMs / 1000, beat.facts.tempo, beat.facts.phase]))
  hb.activate()
  c.advance(12_000); hb.settle() // the run ended at 12 s
  assert.deepEqual(at, [[5, 'active', 'thinking'], [10, 'active', 'thinking']])
  c.advance(60_000)
  assert.deepEqual(at.slice(2), [[32, 'idle', 'idle'], [52, 'idle', 'idle'], [72, 'idle', 'idle']], 'idle beats are 20 s apart, counted from the end of the run')
  assert.deepEqual([hb.state, hb.tempo, c.pending()], ['running', 'idle', 1])
  c.advance(S.lingerMs)
  assert.deepEqual([hb.state, hb.stopReason, c.pending()], ['stopped', 'idle', 0])
  assert.equal(at.length, 2 + S.lingerMs / S.idleBeatMs, 'the last beat is the one that finds the session over: 15 idle beats in all')
})

test('hard stop: something still pending keeps an idle session alive, but never past 15 minutes without the person', () => {
  const c = clockwork(), hb = createHeartbeat({ key: 'dm', ...c })
  hb.setKeepAlive(facts => facts.sources.work?.attention === 'result')
  hb.register('work', () => ({ attention: 'result', attentionFor: 'owner' }))
  hb.activate(); c.advance(8000); hb.settle()
  c.advance(S.lingerMs + 60_000)
  assert.equal(hb.state, 'running', 'a result still waits for someone: the session is kept past the linger time')
  c.advance(S.idleStopMs - S.lingerMs - 60_000)
  assert.deepEqual([hb.state, hb.stopReason, c.pending(), hb.beats], ['stopped', 'idle', 0, 1 + S.idleStopMs / S.idleBeatMs])
  // The person coming back (a message) starts the count again; a closed conversation ends at once.
  const d = clockwork(), again = createHeartbeat({ key: 'dm2', ...d })
  again.activate(); d.advance(6000); again.settle(); d.advance(200_000)
  again.activate(); assert.equal(again.tempo, 'active'); d.advance(6000); again.settle()
  d.advance(S.lingerMs - S.idleBeatMs); assert.equal(again.state, 'running', 'linger counts from the last run')
  again.stop('closed'); assert.deepEqual([again.state, again.stopReason, d.pending()], ['stopped', 'closed', 0])
})

test('a new message re-activates the same heartbeat: the grid restarts at that message and the bounds get a new window', async () => {
  const c = clockwork(), hb = createHeartbeat({ key: 'dm', ...c }), at = []
  let asked = 0
  hb.setJudge(async () => { asked++; return { answers: { p__q: { value: 'no', confidence: 0.99, margin: 0.9 } } } })
  hb.register('p', { facts: () => ({ stepsRunning: 1 }), propose: () => ({ name: 'q', none: 'no', instructions: 'Is a message needed now?', options: [{ value: 'no', description: 'Nothing.' }, { value: 'yes', description: 'Send one.' }], facts: {}, kinds: [] }), onVerdict: () => 'none' })
  hb.subscribe(beat => at.push(beat.facts.internalMs / 1000))
  hb.activate()
  for (let i = 0; i < 80; i++) { c.advance(5000); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
  const first = asked
  assert.ok(first >= 1 && first <= S.maxAsks, `at most ${S.maxAsks} requests in one window (asked ${first})`)
  hb.settle(); c.advance(33_000) // idle: one beat at +20 s
  const before = at.length
  hb.activate({ sinceMs: 0 }) // 433 s on the session's counter
  assert.equal(hb.facts().sinceUserMs, 0)
  for (let i = 0; i < 4; i++) { c.advance(5000); await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
  assert.deepEqual(at.slice(before), [438, 443, 448, 453], 'beats 5 s after THIS message')
  assert.ok(asked > first, 'the new run has its own window of requests')
  hb.stop('closed')
})

test('nudge: a provider with something for the judge gets a beat within half a second, at most once per 5 s; acknowledge reaches the provider', () => {
  const c = clockwork(), hb = createHeartbeat({ key: 'dm', ...c }), at = [], acks = []
  hb.subscribe(beat => at.push(beat.facts.internalMs))
  hb.register('work', { facts: () => ({ attention: 'result', attentionFor: 'owner' }), acknowledge: what => acks.push(what) })
  hb.activate(); c.advance(1000); hb.settle() // idle from 1 s: next beat due at 21 s
  c.advance(3000); assert.equal(hb.nudge(), true); assert.equal(hb.nudge(), false, 'a second nudge within 5 s is refused')
  c.advance(500); assert.deepEqual(at, [4500])
  c.advance(16_500); assert.deepEqual(at, [4500, 21_000], 'the grid is unchanged by a nudge')
  assert.equal(hb.acknowledge('work', 'attention'), true); assert.deepEqual(acks, ['attention'])
  assert.equal(hb.acknowledge('work', 'Some free text'), false); assert.equal(hb.acknowledge('nobody', 'attention'), false)
  hb.stop('closed'); assert.equal(hb.nudge(), false)
})

test('registry: ensure keeps a session\'s heartbeat; when full, the longest-idle session gives way to a new one and a working one never does', () => {
  const c = clockwork(), all = createHeartbeats({ ...c, limits: { ...HEARTBEAT_LIMITS, maxLive: 3 } })
  const a = all.open('a'), b = all.open('b'), w = all.open('w')
  for (const hb of [a, b, w]) hb.activate()
  assert.equal(all.ensure('a'), a, 'the same heartbeat for the same live session')
  assert.equal(all.open('x'), null, 'three working sessions: no room')
  c.advance(1000); a.settle(); c.advance(1000); b.settle(); c.advance(1000)
  const x = all.open('x')
  assert.ok(x); assert.deepEqual([a.state, a.stopReason, b.state, w.state, all.size], ['stopped', 'limit', 'running', 'running', 3])
  a.stop('closed'); assert.notEqual(all.ensure('a'), a, 'a stopped session gets a new heartbeat')
  all.stopAll('restart'); assert.deepEqual([all.size, c.pending()], [0, 0])
})

// ---- closed labels: what is being waited on, what needs attention, where a pointer may go ----

test('waitSummary: provider facts become closed labels with seconds; nothing else can ride along', () => {
  const facts = sources => ({ phase: 'tool_running', stepsRunning: 1, sources })
  assert.deepEqual(waitSummary(facts({ engine_commands: { active: true, phase: 'tool_running', terminal: 'running', terminalState: 'running_output', runningMs: 42_400, quietMs: 9000, commandsRunning: 1 } })), [{ what: 'command_running', seconds: 42 }])
  assert.deepEqual(waitSummary(facts({ engine_commands: { terminal: 'waiting', quietMs: 12_000 } })), [{ what: 'command_waiting_input', seconds: 12 }])
  assert.deepEqual(waitSummary(facts({ browser_task: { active: true, phase: 'waiting_user', waitingOnUser: true, task: 'need_context' } })), [{ what: 'browser_task_waiting_person', seconds: null }])
  assert.deepEqual(waitSummary(facts({ browser_task: { task: 'running' }, work_placement: { placementsPending: 1 }, engine_commands: { terminal: 'running', runningMs: 7000 } })).map(w => w.what),
    ['command_running', 'browser_task_running', 'placement_pending'], 'at most three, in a fixed order')
  assert.deepEqual(waitSummary(facts({ other: { waitingOn: 'command_running', waitingOnMs: 3000 } })), [{ what: 'command_running', seconds: 3 }], 'a provider may say it directly')
  assert.deepEqual(waitSummary(facts({ other: { waitingOn: 'rm_rf_slash' } })), [{ what: 'tool_running', seconds: null }], 'an unknown label is not passed on')
  assert.deepEqual(waitSummary({ phase: 'thinking', stepsRunning: 0, sources: {} }), [])
  const prompt = writerPrompt('explain_wait', { elapsedMs: 45_000, waits: [{ what: 'command_running', seconds: 42 }] })
  assert.match(prompt, /a command is still running \(about 42 seconds so far\)/)
  assert.equal(Object.keys(WAIT_LABELS).length, 7)
})

test('attentionOf: the provider\'s attention fact as closed fields (who, where, kind); the placement runtime\'s field names are read as the same fact', () => {
  const placement = { placementsPending: 0, placementsDecided: 2, pointerPending: true, pointerWhere: 'right', pointerDistance: 'very_far', pointerFor: 'owner', pointerNeeds: 'owner_action' }
  assert.deepEqual(attentionOf({ sources: { work_placement: placement } }), { provider: 'work_placement', kind: 'approval', who: 'owner', where: 'right', distance: 'very_far', signature: 'work_placement:approval:owner' })
  assert.equal(attentionOf({ sources: { work_placement: { ...placement, pointerPending: false } } }), null)
  assert.deepEqual(attentionOf({ sources: { tasks: { attention: 'question', attentionFor: 'requester', attentionWhere: 'somewhere_odd' } } }), { provider: 'tasks', kind: 'question', who: 'requester', where: 'none', distance: null, signature: 'tasks:question:requester' })
  assert.equal(attentionOf({ sources: { tasks: { attention: 'result', attentionFor: 'everyone' } } }), null, 'who must be the owner or the requester')
  const prompt = pointerPrompt({ kind: 'approval', who: 'owner', where: 'right', distance: 'very_far' })
  assert.match(prompt, /needs their decision/); assert.match(prompt, /to the right of what they are looking at on the desk, far away/); assert.match(prompt, /Nothing was moved/)
})

test('pointerRoute: the task\'s own conversation only when that person is in it and nobody else is; else that person\'s own live conversation; else nowhere', () => {
  const present = [{ member: 'self', self: true, active: true }, { member: 'm-jin', active: true }]
  const own = { key: 'dm-owner', audience: { requester: 'self', owner: 'self', participants: ['self'] } }
  assert.equal(pointerRoute({ person: 'owner', audience: { requester: 'self', owner: 'self', participants: ['self'] }, presence: present }).target, 'here')
  assert.equal(pointerRoute({ person: 'owner', audience: { requester: 'm-jin', owner: 'self', participants: ['m-jin', 'self'] }, presence: present }).target, 'here')
  assert.equal(pointerRoute({ person: 'owner', audience: { requester: 'm-jin', owner: 'self', participants: ['m-jin'] }, presence: present, others: [own] }).target, 'dm-owner', 'the owner is not in the member\'s conversation')
  assert.equal(pointerRoute({ person: 'owner', audience: { requester: 'm-jin', owner: 'self', participants: ['m-jin', 'self', 'm-ha'] }, presence: present, others: [own] }).target, 'dm-owner', 'a third person is in the room: not there')
  assert.deepEqual(pointerRoute({ person: 'owner', audience: { requester: 'm-jin', owner: 'self', participants: ['m-jin'] }, presence: present,
    others: [{ key: 'room', audience: { requester: 'self', owner: 'self', participants: ['self', 'm-ha'] } }] }), { target: null, reason: 'no_conversation' }, 'never into a conversation someone else takes part in')
  assert.deepEqual(pointerRoute({ person: 'owner', audience: { requester: 'm-jin', owner: 'self', participants: ['m-jin'] }, presence: [{ member: 'self', self: true, active: false }], others: [own] }), { target: null, reason: 'away' })
  assert.equal(pointerRoute({ person: 'requester', audience: { requester: 'm-jin', owner: 'self', participants: ['m-jin'] }, presence: present }).target, 'here')
  assert.equal(pointerRoute({ person: 'everyone', audience: null }).target, null)
  // The option exists only with a route, once per fact, within the window's bound.
  const base = { sent: 0, blocked: true, sinceLastMs: null, audience: { postable: true }, attention: { kind: 'result' }, pointerTarget: 'here', pointed: false, pointers: 0 }
  assert.deepEqual(enumerateOptions(base), ['none', 'pointer'])
  for (const off of [{ pointerTarget: null }, { pointed: true }, { pointers: FLOW_LIMITS.maxPointers }, { attention: null }, { sinceLastMs: 1000 }]) assert.deepEqual(enumerateOptions({ ...base, ...off }), ['none'])
})

// ---- simulations in the real runtime ----

const NATIVE_AFTER = ['thread/fork', 'thread/unsubscribe', 'turn/start'] // the private fork, its turn and its release
const POINTER = '왼쪽에 결과가 준비되어 있어요. 편하실 때 확인해 주세요.'
const pointerWorld = (t, { rows, audience, acks = [], writer } = {}) => world(t, { audience: ({ run }) => audience?.[run.clientThreadId] ?? null, presence: { snapshot: () => rows },
  policy: { message: values => (values.includes('pointer') ? 'pointer' : 'none') }, writer: writer ?? (prompt => (/on the desk/.test(prompt) ? POINTER : null)), attentionPosted: e => acks.push(e) })
// The placement runtime's provider, as it registers on the conversation's heartbeat (its present field names).
function placementProvider(hb) {
  const state = { pointer: null }
  hb.register('work_placement', () => ({ placementsPending: 0, placementsDecided: state.pointer ? 1 : 0, pointerPending: Boolean(state.pointer), ...(state.pointer ?? {}) }))
  return state
}

test('simulation 1: a member\'s task finishes while the owner works elsewhere — one pointer message in the owner\'s own conversation, nothing moved', async t => {
  const rows = [{ member: 'self', self: true, active: true, lastInputAgeMs: 2000 }, { member: 'm-jin', active: false }]
  const acks = []
  const w = pointerWorld(t, { rows, acks, audience: { 'dm-task': { requester: 'm-jin', owner: 'self', participants: ['m-jin'] }, 'dm-owner': { requester: 'self', owner: 'self', participants: ['self'] } } })
  const o = await w.dm('dm-owner', '예산표 정리해 주세요'); await w.advance(3000); await o.final('예산표를 정리했습니다.')
  const m = await w.dm('dm-task', '분기 보고서 초안을 만들어 주세요'); await w.advance(4000); await m.final('보고서 초안을 만들었습니다.')
  assert.deepEqual([o.hb.tempo, m.hb.tempo, w.requests.flow], ['idle', 'idle', 0])
  // After the member's run ended, its result surface is placed and needs the owner (gap a: the heartbeat is still there to carry it).
  assert.equal(w.chat.heartbeatFor('dm-task')?.state, 'running', 'what the placement runtime requires of the heartbeat after the run')
  const placement = placementProvider(m.hb)
  const eventsBefore = w.events.length, nativeBefore = w.native.length
  placement.pointer = { pointerWhere: 'left', pointerDistance: 'far', pointerFor: 'owner', pointerNeeds: 'look' }
  assert.equal(m.hb.nudge(), true); await w.advance(S.nudgeMs)
  assert.deepEqual(o.assistant(), ['예산표를 정리했습니다.', POINTER], 'one completed message in the owner\'s conversation')
  assert.deepEqual(m.assistant(), ['보고서 초안을 만들었습니다.'], 'nothing in the member\'s conversation')
  assert.deepEqual(acks, [{ key: 'dm-task', provider: 'work_placement' }]); placement.pointer = null // the placement runtime withdraws its fact
  // The judgment saw closed labels only; the writer was told where, in fixed words; neither saw the other conversation or a member id.
  const asked = w.beatRequests.at(-1).input.join('\n')
  assert.match(asked, /attention_kind: result/); assert.match(asked, /attention_for: owner/); assert.match(asked, /attention_where: left/); assert.match(asked, /attention_person_in_this_conversation: (false|no)/)
  const prompt = w.forkPrompts.at(-1)
  assert.match(prompt, /to the left of what they are looking at on the desk, some way off/)
  for (const text of [asked, prompt]) assert.doesNotMatch(text, /m-jin|보고서|예산표|분기/)
  // Nothing moved: the only events are the message's own, in the owner's conversation; the only native calls are the private fork's.
  const after = w.events.slice(eventsBefore)
  assert.deepEqual([...new Set(after.map(e => `${e.clientThreadId}:${e.event}`))], ['dm-owner:message.started', 'dm-owner:message.delta', 'dm-owner:message.completed'])
  const nativeAfter = w.native.slice(nativeBefore)
  assert.deepEqual([...new Set(nativeAfter.map(([method]) => method))].sort(), NATIVE_AFTER, 'the private fork and its clean-up, nothing else')
  assert.ok(nativeAfter.every(([method, params]) => params.threadId !== m.r.conversationId && (method === 'thread/fork' ? params.threadId === o.r.conversationId : String(params.threadId).startsWith('fork-'))),
    'forked from the owner\'s conversation; the member\'s conversation is not touched')
  assert.ok(w.native.slice(nativeBefore).filter(([method]) => method === 'turn/start').every(([, params]) => String(params.threadId).startsWith('fork-')), 'no turn on a real conversation')
  // Once: later beats ask nothing more and post nothing more.
  await w.advance(60_000)
  assert.deepEqual([w.requests.flow, o.assistant().length, m.assistant().length], [1, 2, 1])
  const entry = w.flowEntries().at(-1)
  assert.deepEqual([entry.flow, entry.posted, entry.beat.phase], ['pointer', 'model', 'idle'])
  t.diagnostic(`native after the task ended: ${JSON.stringify(nativeAfter.map(([method, params]) => `${method}@${String(params.threadId).replace(/-\d+$/, '')}`))}`)
  t.diagnostic(`pointer: requests=${w.requests.flow} draftChecks=${w.requests.draft} ownerMessages=${o.assistant().length} memberMessages=${m.assistant().length}`)
})

test('simulation 1b: no pointer when the owner is away, has no conversation of their own, or the only place has someone else in it', async t => {
  const audience = { 'dm-task': { requester: 'm-jin', owner: 'self', participants: ['m-jin'] }, 'dm-owner': { requester: 'self', owner: 'self', participants: ['self'] } }
  const point = async (w, withOwner) => {
    const o = withOwner ? await w.dm('dm-owner', '작업') : null
    if (o) { await w.advance(3000); await o.final('끝.') }
    const m = await w.dm('dm-task', '보고서'); await w.advance(4000); await m.final('만들었습니다.')
    placementProvider(m.hb).pointer = { pointerWhere: 'left', pointerDistance: 'far', pointerFor: 'owner', pointerNeeds: 'look' }
    m.hb.nudge(); await w.advance(60_000)
    return { o, m }
  }
  const away = pointerWorld(t, { rows: [{ member: 'self', self: true, active: false }, { member: 'm-jin', active: true }], audience })
  const a = await point(away, true)
  assert.deepEqual([away.requests.flow, a.o.assistant().length, a.m.assistant().length], [0, 1, 1], 'the owner is away: not even a request')
  const alone = pointerWorld(t, { rows: [{ member: 'self', self: true, active: true }], audience })
  const b = await point(alone, false)
  assert.deepEqual([alone.requests.flow, b.m.assistant().length], [0, 1], 'the owner has no live conversation of their own: nothing, and never into the member\'s')
  const shared = pointerWorld(t, { rows: [{ member: 'self', self: true, active: true }], audience: { ...audience, 'dm-owner': { requester: 'self', owner: 'self', participants: ['self', 'm-ha'] } } })
  const c = await point(shared, true)
  assert.deepEqual([shared.requests.flow, c.o.assistant().length], [0, 1], 'someone else takes part there: nothing')
})

test('simulation 2: tests are still running — the wait message is written from the closed "command running" label, never from the command or its output', async t => {
  const w = world(t, { flags: { held: true, flow: true, commands: true } }), d = await w.dm('dm-tests', '테스트 돌려 주세요')
  await w.advance(1000)
  await d.raw('item/started', { item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test -- --suite=payroll-secret', cwd: '/work', status: 'inProgress', commandActions: [] } })
  await d.raw('item/commandExecution/outputDelta', { itemId: 'cmd-1', delta: 'running 40 tests\nFAIL payroll-secret-case\n' })
  await w.advance(9000) // 10 s: the second beat asks
  const row = d.hb.facts().sources.engine_commands
  assert.deepEqual([row.terminal, row.runningMs], ['running', 9000])
  const asked = w.beatRequests.at(-1).input.join('\n')
  assert.match(asked, /waiting_on: command_running/); assert.match(asked, /waiting_on_seconds: 9/)
  const prompt = w.forkPrompts.at(-1)
  assert.match(prompt, /What is being waited on, as far as the system knows: a command is still running \(about 9 seconds so far\)/)
  for (const text of [asked, prompt]) assert.doesNotMatch(text, /npm|payroll|FAIL|40 tests/)
  assert.equal(d.assistant().length, 1, 'the wait message is posted')
  await d.raw('item/completed', { item: { id: 'cmd-1', type: 'commandExecution', command: 'npm test -- --suite=payroll-secret', cwd: '/work', status: 'completed', exitCode: 0, commandActions: [], aggregatedOutput: 'all passed\n' } })
  await d.final('테스트가 모두 통과했습니다.')
  assert.deepEqual(d.history().map(r => r[0]), ['user', 'assistant', 'assistant'])
  t.diagnostic(`command label: beatRequests=${w.requests.flow} messages=${d.assistant().length}`)
})

test('simulation 3: the session goes idle — beats slow to 20 s, no request, and it stops; something pending keeps it until the hard stop; closing ends it at once', async t => {
  const w = world(t), d = await w.dm('dm-idle')
  await w.advance(11_000); await d.final('끝났습니다.')
  const active = d.beats.map(b => b.at)
  assert.deepEqual(active, [5000, 10_000])
  await w.advance(S.lingerMs)
  const idle = d.beats.map(b => b.at).slice(2)
  assert.deepEqual(idle.slice(0, 3), [31_000, 51_000, 71_000]); assert.equal(idle.length, 15)
  assert.deepEqual([d.hb.state, d.hb.stopReason, w.chat.heartbeatFor('dm-idle'), w.requests.flow, w.timers.length, w.flowEntries().length], ['stopped', 'idle', null, 0, 0, 0])
  // A later message opens a new session heartbeat.
  const again = await w.dm('dm-idle', '하나 더', { requestId: 'req-2', conversationId: d.r.conversationId })
  assert.notEqual(again.hb, d.hb); assert.equal(again.hb.tempo, 'active'); await again.final('네.')
  // Something still needs the owner, who is away: the session is kept, asks nothing, and stops at the hard bound.
  const rows = [{ member: 'self', self: true, active: false }]
  const kept = pointerWorld(t, { rows, audience: {} }), k = await kept.dm('dm-kept')
  await kept.advance(6000); await k.final('끝.')
  placementProvider(k.hb).pointer = { pointerWhere: 'right', pointerDistance: 'near', pointerFor: 'owner', pointerNeeds: 'owner_action' }
  await kept.advance(S.lingerMs + 40_000); assert.equal(k.hb.state, 'running')
  await kept.advance(S.idleStopMs - S.lingerMs - 40_000)
  assert.deepEqual([k.hb.state, k.hb.stopReason, kept.requests.flow, kept.timers.length, k.assistant().length], ['stopped', 'idle', 0, 0, 1])
  // The conversation is closed.
  const closed = world(t), c = await closed.dm('dm-closed'); await closed.advance(6000); await c.final('끝.')
  assert.equal(closed.chat.closeSession('dm-closed'), true)
  assert.deepEqual([c.hb.state, c.hb.stopReason, closed.chat.heartbeats.size, closed.timers.length], ['stopped', 'closed', 0, 0])
  assert.equal(closed.chat.closeSession('dm-closed'), false)
  t.diagnostic(`idle: active beats=${active.length} idle beats=${idle.length} requests=${w.requests.flow}; kept until ${S.idleStopMs / 1000} s with 0 requests`)
})

test('simulation 4: a new run starts while a pointer is pending — the same heartbeat goes on, and the pointer is one message inside the new run\'s flow', async t => {
  const rows = [{ member: 'self', self: true, active: true }]
  const w = pointerWorld(t, { rows, audience: {} }), first = await w.dm('dm-x', '자료 조사해 주세요')
  await w.advance(4000); await first.final('조사를 마쳤습니다.')
  const placement = placementProvider(first.hb)
  placement.pointer = { pointerWhere: 'below', pointerDistance: 'near', pointerFor: 'owner', pointerNeeds: 'look' }
  // Before any idle beat the owner writes again.
  await w.advance(2000)
  const second = await w.dm('dm-x', '이어서 요약해 주세요', { requestId: 'req-2', conversationId: first.r.conversationId })
  assert.equal(second.hb, first.hb, 'the session keeps its heartbeat'); assert.deepEqual([second.hb.tempo, second.hb.snapshot().providers.includes('work_placement')], ['active', true])
  await w.advance(10_000) // the new run's second beat asks
  assert.deepEqual(second.history().map(r => r[0]), ['user', 'assistant', 'user', 'assistant'])
  assert.equal(second.assistant().at(-1), POINTER)
  const posted = w.events.filter(e => e.event === 'message.completed' && e.details?.text === POINTER)
  assert.deepEqual(posted.map(e => e.runId), [second.r.runId], 'posted once, as a message of the new run')
  await w.advance(30_000); await second.final('요약했습니다.')
  assert.deepEqual(second.assistant(), ['조사를 마쳤습니다.', POINTER, '요약했습니다.'])
  assert.equal(w.flowEntries().filter(e => e.flow === 'pointer').length, 1)
  t.diagnostic(`new run with pending pointer: requests=${w.requests.flow} pointerMessages=${posted.length}`)
})

test('simulation 4b: the pointer is being written when the new run starts — it is posted into the new run, once, before that run\'s answer', async t => {
  let release = null
  const gate = new Promise(resolve => { release = resolve })
  const rows = [{ member: 'self', self: true, active: true }]
  const w = pointerWorld(t, { rows, audience: {}, writer: async prompt => { if (!/on the desk/.test(prompt)) return null; await gate; return POINTER } })
  const first = await w.dm('dm-y', '자료 조사해 주세요'); await w.advance(4000); await first.final('조사를 마쳤습니다.')
  placementProvider(first.hb).pointer = { pointerWhere: 'right', pointerDistance: 'far', pointerFor: 'owner', pointerNeeds: 'look' }
  first.hb.nudge(); await w.advance(S.nudgeMs)
  assert.deepEqual([w.requests.flow, first.assistant().length], [1, 1], 'judged at the idle beat; the writer has not answered yet')
  const second = await w.dm('dm-y', '이어서 요약해 주세요', { requestId: 'req-2', conversationId: first.r.conversationId })
  release(); await w.settle(); await w.chat.draftCheckIdle(); await w.settle()
  const posted = w.events.filter(e => e.event === 'message.completed' && e.details?.text === POINTER)
  assert.deepEqual(posted.map(e => e.runId), [second.r.runId], 'folded into the run that is working now')
  await w.advance(40_000); await second.final('요약했습니다.')
  assert.deepEqual(second.assistant(), ['조사를 마쳤습니다.', POINTER, '요약했습니다.'])
  assert.equal(w.events.filter(e => e.event === 'message.completed' && e.details?.text === POINTER).length, 1)
})
