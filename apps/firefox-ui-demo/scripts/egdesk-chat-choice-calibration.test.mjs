// L2 sim: every chooser outcome as seen in the same DM.
// Chain under test (all real code, synthetic data only):
//   mock Decisions fetch -> createDecisionClient -> CodexChatRuntime.chatChoice -> createChatHttpHandler(/chat/choice)
//   -> Surface mountChatChoiceComposer (fake DOM executing the real handlers).
// No network, no real key, no native conversation: a native send/start would trip `state.native`.
// Set EGDESK_SIM_OUT=<file> to dump the observed matrix as JSON (used for the before/after report).
import assert from 'node:assert/strict'
import fs, { mkdtempSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CodexChatRuntime } from '../helper/codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from '../helper/codex-engine-adapter.mjs'
import { createChatHttpHandler } from '../helper/codex-bridge-http.mjs'
import { openChatStore } from '../helper/egdesk-chat-store.mjs'
import { createDecisionClient, decisionTopicRecipient } from '../helper/egdesk-decision-client.mjs'
import { openCalibrationLog } from '../helper/egdesk-decision-calibration-log.mjs'


const ids = { clientThreadId: 'dm-synthetic', conversationId: 'native-synthetic', profileId: 'agent-synthetic' }
const time = 1780000000000
const reviewRevision = 'a'.repeat(64)
const engine = { id: 'codex', engineProfileId: 'codex-default' }
const profileBinding = { profileId: ids.profileId, revision: 1, hash: 'synthetic-profile-hash' }
const author = 'synthetic-account'
const ownerHash = createHash('sha256').update(author).digest('hex')
const question = '이번 주 발표 자료는 어느 쪽으로 정리할까요?'
const options = ['슬라이드 10장 요약본', '표 중심 상세본']
const tick = () => new Promise(resolve => setImmediate(resolve))

// ---- mock Decisions endpoint -------------------------------------------------
const rows = (q, order) => order.map(([value, probability]) => ({ value: value === 'abstain' ? 'abstain' : q.choices[Number(value.slice(1)) - 1].value, probability }))
const answer = order => (q, extra = {}) => new Response(JSON.stringify({ answers: [{ name: q.name, type: 'choice',
  probabilities: rows(q, order), choice: rows(q, order)[0].value, confidence: order[0][1], ...extra }] }))
const json = (status, body) => new Response(JSON.stringify(body), { status })
export const OUTCOMES = {
  confident: { respond: answer([['c1', 0.96], ['c2', 0.03], ['abstain', 0.01]]) },
  abstain: { respond: answer([['abstain', 0.9], ['c1', 0.06], ['c2', 0.04]]) },
  near_tie: { respond: answer([['c1', 0.46], ['c2', 0.44], ['abstain', 0.1]]) },
  low_confidence: { respond: answer([['c1', 0.62], ['c2', 0.28], ['abstain', 0.1]]) },
  out_of_list: { respond: q => new Response(JSON.stringify({ answers: [{ name: q.name, type: 'choice', choice: 'c9', confidence: 0.9,
    probabilities: [{ value: 'c9', probability: 0.9 }, { value: 'abstain', probability: 0.1 }] }] })) },
  no_credit: { respond: () => json(429, { error: { code: 'insufficient_quota', type: 'insufficient_quota' } }) },
  rate_limited: { respond: () => json(429, { error: { code: 'rate_limit_exceeded', type: 'rate_limit_error' } }) },
  timeout: { hang: true },
  // The key lookup never returns, so no POST is ever started: nothing was sent and nothing can be billed.
  timeout_unsent: { stallKey: true },
  budget_exceeded: { budget: { canSpend: () => false, record() {} } },
  // L3's code is not on this branch yet: the real client cannot emit it here, so the client is replaced by a stub that
  // throws the same shape (name 'DecisionError', closed-set code) that runChatChoice forwards. No provider request is made.
  spend_limit_reached: { decideError: Object.assign(new Error('synthetic spend limit'), { name: 'DecisionError', code: 'spend_limit_reached', retryable: false }) },
  invalid_key: { respond: () => json(401, { error: { code: 'invalid_api_key' } }) },
  unreachable: { throws: new TypeError('fetch failed') },
  server_error: { respond: () => json(500, { error: { code: 'server_error' } }) },
  model_unavailable: { respond: () => json(404, { error: { code: 'model_not_found' } }) },
}

function runtime(t, outcome) {
  const dataDir = mkdtempSync(join(tmpdir(), 'egdesk-outcome-db-'))
  const store = openChatStore({ dataDir, ownerScope: 'fixture-only' })
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }) })
  store.createConversation({ clientThreadId: ids.clientThreadId, createdAt: 1 })
  store.setRoomAgent({ clientThreadId: ids.clientThreadId, profileId: ids.profileId, revision: 1, ts: 2 })
  store.acceptRequest({ clientThreadId: ids.clientThreadId, requestId: 'previous-send', fingerprint: 'synthetic-request', ts: 3, localMessageId: 'previous-local-message',
    message: { role: 'user', text: 'Previous native message is not sent to Decisions' } })
  store.appendEvent({ clientThreadId: ids.clientThreadId, eventKey: 'native-binding', event: 'native.thread.bound', ts: 4,
    details: { conversationId: ids.conversationId, ownerHash, replyDestination: 'direct', engine, executionPolicy: null, forkedFrom: null, stateless: false } })
  store.bindNative({ clientThreadId: ids.clientThreadId, conversationId: ids.conversationId, engineId: engine.id, engineProfileId: engine.engineProfileId, localRunId: 'previous-local-run', runId: 'previous-native-run' })
  store.recordRequestOutcome({ clientThreadId: ids.clientThreadId, requestId: 'previous-send', ts: 5,
    outcome: { accepted: true, dispatchStatus: 'confirmed', conversationId: ids.conversationId, runId: 'previous-native-run', localRunId: 'previous-local-run', accountIdentity: { status: 'verified', ownerHash } } })
  store.appendEvent({ clientThreadId: ids.clientThreadId, eventKey: 'run-terminal', event: 'run.completed', ts: 6, requestId: 'previous-send', localRunId: 'previous-local-run', runId: 'previous-native-run',
    details: { status: 'completed' }, runCheckpoint: { conversationId: ids.conversationId, clientThreadId: ids.clientThreadId, requestId: 'previous-send', runId: 'previous-native-run', localRunId: 'previous-local-run',
      engine, profileBinding, status: 'completed', messages: [], pendingApprovals: [], pendingUserInputs: [] } })
  const state = { native: 0, posts: [], key: 'egd-synthetic-not-a-key-0002' }
  const noNative = () => { state.native++; throw Error('Unexpected native operation') }
  const client = createDecisionClient({
    getApiKey: outcome.stallKey ? () => new Promise(() => {}) : async () => state.key, budget: outcome.budget ?? null,
    recipientForKey: (key, endpoint, model) => decisionTopicRecipient(key, 42, endpoint, model),
    fetchImpl: async (url, req) => {
      const body = JSON.parse(req.body)
      state.posts.push({ url, body })
      if (outcome.throws) throw outcome.throws
      if (outcome.hang) return new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
      return outcome.respond(body.questions[0])
    } })
  const calibDir = mkdtempSync(join(tmpdir(), 'egdesk-calib-'))
  t.after(() => rmSync(calibDir, { recursive: true, force: true }))
  const calibrationLog = outcome.noLog ? undefined : openCalibrationLog({ dataDir: calibDir, log: () => {} })
  const decisionContext = { calibrationLog, client: outcome.decideError ? { decide: async () => { throw outcome.decideError } } : client, mode: () => 'on', configured: () => true, settingsGeneration: () => 1, reviewRevision: () => reviewRevision,
    recipientForChatChoice: ({ ownerKey }) => ownerKey === author ? decisionTopicRecipient(state.key, 42) : null }
  const adapter = createCodexEngineAdapter({ request: noNative, respond: noNative, getOwnerKey: () => author, profiles: { ensureReady: noNative } })
  Object.assign(adapter, { ensureReady: noNative, startTurn: noNative })
  const chat = new CodexChatRuntime({ request: noNative, respond: noNative, engines: [adapter], store, requireStore: true, getOwnerKey: () => author, now: () => time,
    profiles: { runProfile: () => ({ binding: profileBinding, developerInstructions: 'synthetic instructions' }) }, decisionContext })
  chat.startTurn = noNative
  const handle = createChatHttpHandler(chat, noNative)
  const post = async body => {
    const req = Object.assign(new EventEmitter(), { url: '/chat/choice', method: 'POST', socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } })
    const response = {}
    const res = Object.assign(new EventEmitter(), { writeHead(status) { response.status = status }, end(data) { response.body = JSON.parse(data) } })
    assert.equal(await handle(req, res, new URL('/chat/choice', 'http://127.0.0.1:39218')), true)
    return response
  }
  return { state, post, calibrationLog, calibDir, chat }
}


const bodyFor = () => ({ ...ids, requestId: `choice-${time}-${randomUUID()}`, question, options, confirm: true, reviewRevision })
const run = async (t, name) => {
  const rt = runtime(t, OUTCOMES[name])
  const reply = await rt.post(bodyFor())
  return { rt, reply }
}
const only = rt => { const e = rt.calibrationLog.entries(); assert.equal(e.length, 1, JSON.stringify(e)); return e[0] }

const EXPECT = {
  confident: { top: 0.96, second: 0.03, p: 0.96, confidence: 0.96, options: 3, margin: 0.93, would: 'act' },
  abstain: { top: 0.9, second: 0.06, p: 0.9, confidence: 0.9, options: 3, margin: 0.84, noPick: 'abstain', would: 'hold' },
  near_tie: { top: 0.46, second: 0.44, p: 0.46, confidence: 0.46, options: 3, margin: 0.02, noPick: 'unclear', would: 'hold' },
  low_confidence: { top: 0.62, second: 0.28, p: 0.62, confidence: 0.62, options: 3, margin: 0.34, noPick: 'low_confidence', would: 'hold' },
}
for (const [name, want] of Object.entries(EXPECT)) {
  test(`C4 ${name}: one content-free entry with the numbers the bar saw (0.80 / 0.20) and what it did`, async t => {
    const { rt, reply } = await run(t, name)
    const entry = only(rt)
    assert.deepEqual(entry.judgments, [{ q: 'choice', ...want, threshold: 0.8, minMargin: 0.2 }])
    assert.equal(entry.feature, 'dm_chooser'); assert.equal(entry.mode, 'on'); assert.equal(entry.candidates, 2)
    assert.equal(entry.fallback, undefined)
    // The reply is unchanged: no probabilities in it.
    assert.deepEqual(Object.keys(reply.body).sort(), name === 'confident' ? ['index', 'status'] : ['reason', 'status'])
  })
}

for (const [name, code] of [['rate_limited', 'rate_limited'], ['no_credit', 'no_credit'], ['server_error', 'server_error'], ['out_of_list', 'bad_response'],
  ['budget_exceeded', 'budget_exceeded'], ['invalid_key', 'invalid_key'], ['unreachable', 'unreachable'], ['model_unavailable', 'model_unavailable']]) {
  test(`C4 ${name}: entry carries the closed outcome code ${code}, no probabilities`, async t => {
    const { rt } = await run(t, name)
    const entry = only(rt)
    assert.equal(entry.fallback, code); assert.deepEqual(entry.judgments, []); assert.equal(entry.candidates, 2)
  })
}

test('C4 timeout (provider never answers) is recorded as timeout', async t => {
  const { rt } = await run(t, 'timeout')
  assert.equal(only(rt).fallback, 'timeout')
})

test('C4 the file holds no question, option, id, key, revision or request ID; it is private and bounded to numbers/closed words', async t => {
  const first = await run(t, 'confident')
  const second = runtime(t, OUTCOMES.abstain); await second.post(bodyFor())
  for (const rt of [first.rt, second]) {
    const file = join(rt.calibDir, 'egdesk-decision-calibration.json')
    const text = fs.readFileSync(file, 'utf8')
    for (const secret of [question, ...options, ...Object.values(ids), 'previous-send', rt.state.key, reviewRevision, 'choice-', 'synthetic instructions']) {
      assert.equal(text.includes(secret), false, secret)
    }
    assert.equal(fs.statSync(file).mode & 0o077, 0, 'owner-only file')
    for (const entry of JSON.parse(text).entries) assert.deepEqual(Object.keys(entry).sort(), ['candidates', 'day', 'feature', 'judgments', 'mode'])
  }
})

test('C4 nothing is recorded when the request never reached a decision (duplicate, no log, failing log)', async t => {
  const rt = runtime(t, OUTCOMES.confident)
  const body = bodyFor()
  await rt.post(body); await rt.post(body)             // second is the one-time-receipt manual
  assert.equal(rt.calibrationLog.entries().length, 1)
  // a log that throws must not change the reply or the single paid request
  const flaky = runtime(t, OUTCOMES.confident)
  flaky.chat.decisionContext.calibrationLog = { record() { throw new Error('disk full') } }
  assert.deepEqual((await flaky.post(bodyFor())).body, { status: 'recommended', index: 0 })
  // no log at all
  const none = runtime(t, { ...OUTCOMES.confident, noLog: true })
  assert.deepEqual((await none.post(bodyFor())).body, { status: 'recommended', index: 0 })
  assert.equal(rt.state.native + flaky.state.native + none.state.native, 0)
})
