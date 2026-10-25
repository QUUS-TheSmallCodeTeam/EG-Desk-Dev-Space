import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runResultFromCodexItem, RUN_RESULT_LIMITS } from '../overlay/resources/EGDeskRunResult.sys.mjs'
import { createChatRunOutputsFixture, chatRunOutputsFixtureEnabled, chatRunOutputFixtureIds,
  CHAT_RUN_OUTPUT_MARKER, CHAT_RUN_DIFF_MARKER, CHAT_RUN_OUTPUT_DELTA } from './egdesk-chat-run-outputs-fixture.mjs'

const env = { EGDESK_QA_RUN_OUTPUTS_FIXTURE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_REAL_TURN: '0' }
const makeRun = (scenario = 'RUN_OUTPUTS', n = 1) => ({ scenario, conversationId: `conversation-${n}`, runId: `run-${n}`,
  answerId: `conversation-${n}/run-${n}`, status: 'running', activities: new Map(), messages: new Map(), pendingApprovals: [] })
function fixture() {
  const runs = new Map(), events = []
  const sidecar = createChatRunOutputsFixture({ runs, env, envelope: (run, event, details, itemId) => {
    events.push({ runId: run.runId, conversationId: run.conversationId, event, details, itemId })
  } })
  return { ...sidecar, runs, events, add(scenario, n) { const run = makeRun(scenario, n); runs.set(run.runId, run); sidecar.seed(run); return run } }
}
const url = (route, run, itemId) => new URL(`${route}?${new URLSearchParams({ conversationId: run.conversationId, runId: run.runId,
  ...(itemId === undefined ? {} : { itemId }) })}`, 'http://fixture.invalid')

test('factory is opt-in, model-free and mutually exclusive with project fixtures', () => {
  assert.equal(chatRunOutputsFixtureEnabled({}), false)
  assert.equal(chatRunOutputsFixtureEnabled({ EGDESK_QA_RUN_OUTPUTS_FIXTURE: '0' }), false)
  assert.equal(chatRunOutputsFixtureEnabled(env), true)
  for (const patch of [{ EGDESK_QA_RUN_OUTPUTS_FIXTURE: 'yes' }, { EGDESK_QA_FIXTURE_TRANSPORT: '0' },
    { EGDESK_QA_REAL_TURN: '1' }, { EGDESK_QA_REAL_TURN: undefined }, { EGDESK_QA_PROJECT_FILE_FIXTURE: '1' }]) {
    assert.throws(() => chatRunOutputsFixtureEnabled({ ...env, ...patch }))
  }
  assert.throws(() => createChatRunOutputsFixture({ runs: new Map(), envelope() {}, env: {} }))
});

test('only fixed owned scenarios can populate the existing run map through the injected envelope', () => {
  const f = fixture(), run = makeRun()
  assert.equal(f.accepts('RUN_OUTPUTS'), true)
  assert.equal(f.accepts('RUN_OUTPUTS_LOST'), true)
  assert.equal(f.accepts('arbitrary-event'), false)
  assert.throws(() => f.seed(run), /owned/)
  f.runs.set(run.runId, run)
  assert.equal(f.seed(run), true)
  const before = structuredClone(f.events)
  assert.equal(f.seed(run), false)
  assert.deepEqual(f.events, before, 'no duplicate seed or SSE')
  assert.equal(run.pendingApprovals.length, 1)
  assert.equal(run.pendingApprovals[0].status, 'pending')
  assert.deepEqual(run.pendingApprovals[0].choices, ['decline', 'cancel'])
  assert.equal(f.events.some(event => event.event === 'approval.resolved'), false)
  assert.equal(f.stats().requests.length, 0)
  assert.doesNotMatch(JSON.stringify(f.events), new RegExp(`${CHAT_RUN_OUTPUT_MARKER}|${CHAT_RUN_DIFF_MARKER}|aggregatedOutput`))
  const guidance = [...run.messages.values()].filter(message => message.role === 'assistant' && message.status === 'streaming')
  assert.equal(guidance.length, 1, 'existing delta seam has exactly one eligible same-run guidance message')
  assert.equal(guidance[0].id, `${run.runId}-output-message`)
  assert.equal(guidance[0].text.includes(CHAT_RUN_OUTPUT_DELTA.trim()), false, 'the persistence marker is never seeded automatically')
  assert.deepEqual(f.events.filter(event => event.event.startsWith('message.')).map(event => event.event), ['message.started', 'message.delta'])
  assert.equal(f.events.at(-1).details.delta, guidance[0].text)
});

test('actual RunOutputStore supplies success/failure counts and bounded retained output on exact GET identities', () => {
  const f = fixture(), run = f.add(), ids = chatRunOutputFixtureIds(run.runId)
  const messages = structuredClone([...run.messages.values()]), events = structuredClone(f.events)
  for (const [key, outcome, headline] of [['pass', 'passed', '3 통과'], ['fail', 'failed', '2 통과 · 1 실패']]) {
    const response = f.route('GET', url('/chat/command-output', run, ids[key]))
    assert.equal(response.status, 200)
    assert.deepEqual([response.body.conversationId, response.body.runId, response.body.itemId], [run.conversationId, run.runId, ids[key]])
    assert.equal(response.body.complete, true)
    assert.ok(response.body.totalBytes > 0)
    assert.match(response.body.head + response.body.tail, new RegExp(CHAT_RUN_OUTPUT_MARKER))
    assert.deepEqual(response.body.limits, { headBytes: 8192, tailBytes: 65536 })
    const activity = run.activities.get(ids[key])
    const parsed = runResultFromCodexItem({ ...activity.detail, status: activity.status }, { output: response.body })
    assert.equal(parsed.outcome, outcome)
    assert.equal(parsed.headline, headline)
    if (key === 'pass') assert.equal(parsed.tail.split('\n').length, RUN_RESULT_LIMITS.tailLines,
      'fill the actual renderer tail limit; native QA separately requires measurable local overflow')
  }
  assert.equal(f.stats().requests.length, 2)
  assert.deepEqual([...run.messages.values()], messages, 'GET cannot advance the streaming guidance')
  assert.deepEqual(f.events, events, 'GET cannot emit the persistence event')
});

test('activity and pending-approval diffs are GET-only, retained and never alter approvals', () => {
  const f = fixture(), run = f.add(), ids = chatRunOutputFixtureIds(run.runId)
  const before = structuredClone(run.pendingApprovals), events = structuredClone(f.events), messages = structuredClone([...run.messages.values()])
  for (const itemId of [ids.change, ids.proposed]) {
    const response = f.route('GET', url('/chat/run-changes', run, itemId))
    assert.equal(response.status, 200)
    assert.equal(response.body.retained, true)
    assert.equal(response.body.items.length, 1)
    assert.equal(response.body.items[0].itemId, itemId)
    assert.match(response.body.items[0].files[0].diff, new RegExp(CHAT_RUN_DIFF_MARKER))
    assert.equal(response.body.turn, null, 'an item-specific request cannot borrow the turn diff')
  }
  assert.deepEqual(run.pendingApprovals, before)
  assert.deepEqual(f.events, events, 'viewing emits no approval or execution event')
  assert.deepEqual([...run.messages.values()], messages, 'diff GET cannot advance the streaming guidance')
  assert.equal(f.route('POST', url('/chat/run-changes', run, ids.proposed)).status, 405)
  assert.equal(f.route('POST', new URL('http://fixture.invalid/chat/approval')), null, 'the sidecar never handles approval submission')
  assert.deepEqual(f.stats().effects, { providerTurns: 0, shellExecutions: 0, fileWrites: 0, approvalPosts: 0 })
});

test('same run ID with a foreign conversation, unseeded runs and invalid query shapes fail closed', () => {
  const f = fixture(), run = f.add(), id = chatRunOutputFixtureIds(run.runId).fail
  const wrong = url('/chat/command-output', run, id)
  wrong.searchParams.set('conversationId', 'other-room')
  assert.equal(f.route('GET', wrong).body.code, 'RUN_NOT_FOUND')
  const unrelated = makeRun('COMPLETE', 2)
  f.runs.set(unrelated.runId, unrelated)
  assert.equal(f.route('GET', url('/chat/command-output', unrelated, id)).body.code, 'RUN_NOT_FOUND')
  for (const query of ['runId=run-1', `conversationId=conversation-1&runId=run-1&itemId=${id}&itemId=${id}`,
    `conversationId=conversation-1&runId=run-1&itemId=${id}&cwd=/unsafe`]) {
    assert.equal(f.route('GET', new URL(`http://fixture.invalid/chat/command-output?${query}`)).status, 400)
  }
  assert.equal(f.route('GET', url('/chat/command-output', run, 'foreign-item')).body.code, 'COMMAND_OUTPUT_UNAVAILABLE')
});

test('the lost scenario actually forgets retained output while preserving its command metadata', () => {
  const f = fixture(), run = f.add('RUN_OUTPUTS_LOST'), ids = chatRunOutputFixtureIds(run.runId)
  assert.equal(run.activities.get(ids.fail).status, 'completed')
  assert.equal(run.fixtureStage, 'run-outputs-lost')
  assert.equal(run.status, 'completed')
  assert.equal([...run.messages.values()].some(message => message.status === 'streaming'), false)
  assert.deepEqual(f.events.filter(event => event.event.startsWith('message.')).map(event => event.event), ['message.started', 'message.completed'])
  assert.equal(f.route('GET', url('/chat/command-output', run, ids.fail)).body.code, 'COMMAND_OUTPUT_UNAVAILABLE')
  const changes = f.route('GET', url('/chat/run-changes', run))
  assert.equal(changes.body.retained, false)
  assert.deepEqual(changes.body.items, [])
  assert.equal(f.stats().retainedBytes, 0)
  assert.deepEqual(f.stats().retainedRunKeys, [])
});

test('OPTIONS and stats are detached, read-only observations; dispose leaves unrelated runs and approvals intact', () => {
  const f = fixture(), run = f.add(), before = structuredClone(run.pendingApprovals)
  for (const route of ['/chat/command-output', '/chat/run-changes']) {
    assert.deepEqual(f.route('OPTIONS', new URL(`http://fixture.invalid${route}`)), { status: 204, body: {} })
  }
  const stats = f.stats()
  assert.equal(stats.requests.length, 0)
  assert.equal(stats.options.length, 2)
  stats.options.length = 0
  stats.scenarios[0].ids.fail = 'corrupted-copy'
  assert.equal(f.stats().options.length, 2)
  assert.notEqual(f.stats().scenarios[0].ids.fail, 'corrupted-copy')
  f.dispose()
  f.dispose()
  assert.equal(f.stats().disposed, true)
  assert.equal(f.stats().retainedBytes, 0)
  assert.equal(f.runs.get(run.runId), run)
  assert.deepEqual(run.pendingApprovals, before)
  assert.throws(() => f.seed(run), /disposed/)
  assert.equal(f.route('GET', url('/chat/command-output', run, 'id')).status, 410)
});

test('sidecar imports the actual store and contains no server, provider, shell, file-write or generic event injection surface', () => {
  const source = readFileSync(new URL('./egdesk-chat-run-outputs-fixture.mjs', import.meta.url), 'utf8')
  assert.match(source, /import \{ RunOutputStore \} from '\.\.\/helper\/codex-run-outputs\.mjs'/)
  assert.doesNotMatch(source, /from ['"]node:|createServer\(|\.listen\(|spawn\(|exec\(|writeFile|appendFile|createWriteStream|approval\.resolved|body\.event|setTimeout\(|setInterval\(/)
  const f = fixture()
  assert.deepEqual(Object.keys(f).filter(key => !['runs', 'events', 'add'].includes(key)), ['accepts', 'seed', 'route', 'stats', 'dispose'])
  assert.equal(f.route('POST', new URL('http://fixture.invalid/__qa/delta')), null, 'only the pre-existing transport owns the explicit delta control')
});
