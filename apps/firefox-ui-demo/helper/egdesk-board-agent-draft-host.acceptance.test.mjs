import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { createBoardAgentAskHttpHandler } from './egdesk-board-agent-ask-http.mjs'
import { createBoardAgentAskService } from './egdesk-board-agent-ask.mjs'
import { localDay, readScreeningInput, selectBoardAgentContext } from './egdesk-board-agent-context.mjs'
import { BOARD_AGENT_DRAFT_CONFIG_FILE, createBoardAgentDraftConfigReader } from './egdesk-board-agent-draft-config.mjs'
import { BOARD_AGENT_DRAFT_INSTRUCTIONS, BOARD_AGENT_DRAFT_REPLY_STYLES, createBoardAgentDraftTransport } from './egdesk-board-agent-draft.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'

const QUESTION = 'Where is the rehearsal?'
const EXCERPT = 'The rehearsal will take place in the atrium on Friday.'
const GUIDANCE = 'Use one brief sentence.'
const ANSWER = 'The rehearsal is in the atrium.'
const MODEL = 'gpt-4.1-mini-2025-04-14'
const ENDPOINT = 'https://api.openai.com/v1/responses'
const BOARD = 'draft-host-fixture-board'
const PROFILE = 'draft-host-fixture-agent'
const INSTRUCTIONS = `${BOARD_AGENT_DRAFT_INSTRUCTIONS}\n${BOARD_AGENT_DRAFT_REPLY_STYLES.warm}`
const dummyCredential = () => ['fixture', randomBytes(18).toString('hex')].join('.')
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const trace = (scenario, fixture, fields) => console.log('BOARD_RESPONSES_TRACE ' + JSON.stringify({ scenario, responsesPosts: fixture.posts.length, decisionsCalls: fixture.decisions(), ...fields }))
// The raw Responses HTTP envelope: output -> message -> content -> output_text.
// No SDK convenience field, reasoning output, streaming frame, or Chat Completions choices.
const response = () => Response.json({
  id: 'resp_fixture', object: 'response', created_at: 1794958200, completed_at: 1794958201,
  status: 'completed', model: MODEL, error: null, incomplete_details: null, background: false,
  instructions: INSTRUCTIONS, previous_response_id: null, store: false, temperature: 1, top_p: 1,
  tool_choice: 'none', tools: [], parallel_tool_calls: false, truncation: 'disabled', metadata: {},
  text: { format: { type: 'text' } }, usage: { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 19 },
  output: [{ id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: ANSWER, annotations: [], logprobs: [] }] }],
})

// decisions: the saved Decisions setting of the host. 'off' is the bridge's answer for mode off or no key (no status at all);
// 'on' is a usable setting whose client fails unless decisionAnswer is given. Nothing in a request can select either.
async function fixture(t, { config = 'dedicated', provider = response, decisions = 'off', decisionAnswer = null } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'board-host-'))
  const dataDir = path.join(root, 'private-app')
  const settings = path.join(dataDir, 'settings')
  mkdirSync(settings, { recursive: true, mode: 0o700 })
  const configFile = path.join(settings, BOARD_AGENT_DRAFT_CONFIG_FILE)
  const decisionCredential = dummyCredential()
  let dedicatedCredential = dummyCredential()
  const writeConfig = apiKey => {
    writeFileSync(configFile + '.pending', JSON.stringify({ version: 1, provider: 'openai', model: MODEL, apiKey }), { mode: 0o600, flag: 'wx' })
    renameSync(configFile + '.pending', configFile)
  }
  if (config !== 'none') writeConfig(config === 'shared' ? decisionCredential : dedicatedCredential)
  const desk = openDeskStore({ dataDir, ownerScope: 'fixture-only' })
  desk.saveBoard(BOARD, { expectedRevision: null, body: { version: 1, agenda: { id: BOARD, title: 'Fixture Board' }, cards: [], shapes: [] } })
  const boardBefore = JSON.stringify(desk.board(BOARD).head)
  const active = { revision: 1, hash: 'a'.repeat(64), body: { name: 'Fixture Agent', model: null, personality: { tone: 'warm', speechNotes: 'Fixture profile guidance not approved' } } }
  const profile = { lifecycle: 'active', activeRevision: 1, active }
  const posts = []
  let decisionsCount = 0
  const decisionInputs = []
  const draft = createBoardAgentDraftTransport({
    readConfig: createBoardAgentDraftConfigReader({ dataDir, getDecisionApiKey: () => decisionCredential }),
    fetchImpl(url, options) {
      // Keep credentials out of stored evidence and out of any assertion diagnostics.
      posts.push({ url, method: options.method, dedicatedBearer: options.headers.authorization === `Bearer ${dedicatedCredential}`,
        storeAndToolControls: options.credentials === 'omit' && options.redirect === 'error' && options.cache === 'no-store',
        body: JSON.parse(options.body), signal: options.signal })
      return provider()
    },
  })
  const service = createBoardAgentAskService({ desk, profiles: { get: id => id === PROFILE ? profile : null },
    selectContext: selectBoardAgentContext,
    decisionStatus: () => decisions === 'off' ? null : ({ mode: 'on', model: 'fixture-decisions-model', bindingId: 'fixture-decisions-binding',
      client: { async decide(request) {
        decisionsCount++; decisionInputs.push(readScreeningInput(request.input))
        if (!decisionAnswer) throw new Error('Decisions must never be invoked in this test')
        // a provider answers exactly the questions it is asked (L1 c13: relevance first, then the time question for the relevant excerpts)
        return { ...decisionAnswer, answers: Object.fromEntries(request.questions.map(q => [q.name, decisionAnswer.answers[q.name]]).filter(([, a]) => a)) }
      } } }),
    draft, draftPreview: tone => `${BOARD_AGENT_DRAFT_INSTRUCTIONS}\n${BOARD_AGENT_DRAFT_REPLY_STYLES[tone]}`,
  })
  t.after(() => { service.close(); desk.close(); rmSync(root, { recursive: true, force: true }) })
  const handler = createBoardAgentAskHttpHandler({ service })
  const route = async (action, input) => {
    const pathname = '/v1/board-agent-ask/' + action
    const req = Readable.from([Buffer.from(JSON.stringify(input))])
    Object.assign(req, { method: 'POST', url: pathname, headers: { host: '127.0.0.1:39218', 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } })
    const res = new EventEmitter()
    res.writeHead = status => { res.status = status }
    res.end = body => { res.body = JSON.parse(body) }
    assert.equal(await handler(req, res, new URL(`http://127.0.0.1:39218${pathname}`)), true)
    return { status: res.status, body: res.body }
  }
  const policy = (action, data = {}) => route('policy', { action, boardId: BOARD, ...data })
  const saved = await policy('save', { profileId: PROFILE, excerpts: [EXCERPT], publicInstructions: GUIDANCE })
  assert.equal(saved.status, 200)
  const issued = await policy('issue', { expectedVersion: saved.body.policy.version })
  assert.equal(issued.status, 200)
  const request = { kind: 'request', requestId: '8878a7f3-df6b-4383-af12-6ae38ad4fe2e',
    requestDigest: createHash('sha256').update('synthetic fixture request identity').digest('hex'),
    recipient: 'Fixture recipient', question: QUESTION, excerpt: '', expectedReply: 'Fixture human-review preference', askCode: issued.body.askCode }
  return {
    availability: () => policy('get'), revoke: () => policy('revoke', { expectedVersion: issued.body.policy.version }),
    preview: (mode = 'draft', extra = {}) => route('prepare', { boardId: BOARD, request, mode, ...extra }),
    run: (preview, confirm = true) => route('run', { ticket: preview.body.ticket, confirm }),
    cancel: preview => route('cancel', { ticket: preview.body.ticket }),
    rotate: () => { dedicatedCredential = dummyCredential(); writeConfig(dedicatedCredential) },
    remove: () => unlinkSync(configFile),
    boardUnchanged: () => boardBefore === JSON.stringify(desk.board(BOARD).head),
    posts, decisions: () => decisionsCount, decisionInputs,
  }
}
const code = (result, status, suffix) => {
  assert.equal(result.status, status)
  assert.equal(result.body.code, `BOARD_AGENT_ASK_${suffix}`)
  assert.equal(Object.hasOwn(result.body, 'answer'), false)
}
const previewDraft = async f => {
  const preview = await f.preview()
  assert.equal(preview.status, 200)
  const { mode, question, excerpts, publicInstructions, decisionModel, decisionMode, draftModel, draftInstructions } = preview.body
  assert.equal(Object.hasOwn(preview.body, 'decisionEgress'), false, 'there is no per-request screening choice')
  assert.deepEqual({ mode, question, excerpts, publicInstructions, decisionModel, decisionMode, draftModel, draftInstructions },
    { mode: 'draft', question: QUESTION, excerpts: [EXCERPT], publicInstructions: GUIDANCE,
      decisionModel: null, decisionMode: null, draftModel: MODEL, draftInstructions: INSTRUCTIONS })
  assert.equal(f.posts.length, 0)
  return preview
}
const noTraffic = f => { assert.equal(f.posts.length, 0); assert.equal(f.decisions(), 0) }

test('preview is inert, and a run without confirmation makes zero outbound attempts', async t => {
  const f = await fixture(t)
  const preview = await previewDraft(f)
  code(await f.run(preview, false), 400, 'INPUT')
  noTraffic(f)
  trace('preview_and_unconfirmed', f, { previewStatus: 200, runStatus: 400, answerReturned: false })
})

test('confirmed extract returns the approved local sentence, not a Responses draft, and never reaches Decisions even when it is on', async t => {
  const f = await fixture(t, { decisions: 'on' })
  code(await f.preview('extract', { decisionEgress: true }), 400, 'INPUT')
  const preview = await f.preview('extract')
  assert.equal(preview.status, 200)
  assert.deepEqual([preview.body.decisionModel, preview.body.decisionMode, preview.body.provider], [null, null, null])
  assert.deepEqual(await f.run(preview), { status: 200, body: { mode: 'extract', answer: EXCERPT, source: 'local', omittedCount: 0 } })
  noTraffic(f)
  trace('extract', f, { runStatus: 200, source: 'local' })
})

for (const config of ['none', 'shared']) test(`draft is off with ${config} dedicated credential configuration`, async t => {
  const f = await fixture(t, { config, decisions: 'on' })
  const state = await f.availability()
  assert.equal(state.status, 200)
  assert.deepEqual(state.body.availability, { decision: true, draft: false, model: null })
  code(await f.preview(), 409, 'DRAFT_OFF')
  noTraffic(f)
  trace(config === 'none' ? 'missing_config' : 'same_as_decisions', f, { draftAvailable: false, previewStatus: 409 })
})

test('one confirmed draft reaches the real Responses adapter and returns only its output_text answer', async t => {
  const f = await fixture(t)
  const preview = await previewDraft(f)
  assert.deepEqual(await f.run(preview), { status: 200, body: { mode: 'draft', answer: ANSWER, source: 'draft' } })
  code(await f.run(preview), 409, 'STALE')
  assert.equal(f.posts.length, 1)
  assert.equal(f.decisions(), 0)
  const { url, method, dedicatedBearer, storeAndToolControls, body } = f.posts[0]
  assert.deepEqual({ url, method, dedicatedBearer, storeAndToolControls }, { url: ENDPOINT, method: 'POST', dedicatedBearer: true, storeAndToolControls: true })
  assert.deepEqual(body, { model: MODEL, instructions: INSTRUCTIONS,
    input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ question: QUESTION, excerpts: [EXCERPT], publicInstructions: GUIDANCE }) }] }],
    text: { format: { type: 'text' } }, store: false, stream: false, tools: [], tool_choice: 'none', parallel_tool_calls: false, max_output_tokens: 2048,
  })
  assert.ok(f.boardUnchanged())
  trace('confirmed_draft', f, { endpoint: '/v1/responses', runStatus: 200, responseShape: 'output[].content[].output_text', answerMatched: true, replayStatus: 409, boardUnchanged: true })
})

test('with the saved Decisions mode on, one confirmed draft screens the same approved excerpts once, then drafts once', async t => {
  const f = await fixture(t, { decisions: 'on', decisionAnswer: { answers: { c1: { type: 'predicate', probability: 0.97 }, c1_now: { type: 'predicate', probability: 0.97 } } } })
  const preview = await f.preview()
  assert.equal(preview.status, 200)
  assert.deepEqual([preview.body.decisionModel, preview.body.decisionMode, preview.body.draftModel], ['fixture-decisions-model', 'on', MODEL])
  noTraffic(f)
  assert.deepEqual(await f.run(preview), { status: 200, body: { mode: 'draft', answer: ANSWER, source: 'draft', screening: 'decision' } })
  assert.equal(f.decisions(), 2, 'L1 c13: relevance, then the time question for the one relevant excerpt')
  assert.deepEqual(f.decisionInputs, [0, 1].map(() => ({ question: QUESTION, today: localDay(Date.now()), candidates: [{ alias: 'c1', text: EXCERPT }] })), 'only the question, the ask\'s day and the approved excerpts the drafting model may also receive')
  assert.equal(f.posts.length, 1)
  assert.deepEqual(JSON.parse(f.posts[0].body.input[0].content[0].text).excerpts, [EXCERPT])
  code(await f.run(preview), 409, 'STALE')
  assert.deepEqual([f.decisions(), f.posts.length], [2, 1], 'the replay sends nothing more')
  trace('draft_with_decisions_on', f, { runStatus: 200, screening: 'decision', replayStatus: 409 })
})

test('a Decisions failure during a draft run falls back to the local selection and the draft still runs once', async t => {
  const f = await fixture(t, { decisions: 'on' })
  const preview = await f.preview()
  assert.deepEqual(await f.run(preview), { status: 200, body: { mode: 'draft', answer: ANSWER, source: 'draft', screening: 'fallback' } })
  assert.deepEqual([f.decisions(), f.posts.length], [1, 1])
  trace('draft_with_decisions_failing', f, { runStatus: 200, screening: 'fallback' })
})

test('a Chat Completions response is not mistaken for Responses output_text', async t => {
  const f = await fixture(t, { provider: () => Response.json({ object: 'chat.completion', choices: [{ message: { role: 'assistant', content: ANSWER } }] }) })
  const preview = await previewDraft(f)
  code(await f.run(preview), 502, 'RUN_FAILED')
  assert.equal(f.posts.length, 1)
  assert.equal(f.decisions(), 0)
  trace('wrong_provider_envelope', f, { runStatus: 502, answerReturned: false })
})

for (const action of ['rotate', 'remove']) test(`configuration ${action} after preview and before confirmation makes zero requests`, async t => {
  const f = await fixture(t)
  const preview = await previewDraft(f)
  f[action]()
  code(await f.run(preview), 409, 'STALE')
  assert.equal((await f.availability()).body.policy.codeActive, true)
  noTraffic(f)
  trace(`${action}_before_confirmation`, f, { runStatus: 409, answerReturned: false, codeStillActive: true })
})

for (const action of ['cancel', 'revoke', 'rotate']) test(`${action} after dispatch cannot return even a valid late Responses answer`, { timeout: 5000 }, async t => {
  const started = deferred(), late = deferred(), delivered = deferred()
  const f = await fixture(t, { provider: async () => { started.resolve(); await late.promise; delivered.resolve(); return response() } })
  const preview = await previewDraft(f)
  const pendingRun = f.run(preview)
  await Promise.race([started.promise, pendingRun.then(result => assert.fail(`run returned before dispatch: ${result.status}`))])
  assert.equal(f.posts.length, 1)
  if (action === 'cancel') assert.deepEqual(await f.cancel(preview), { status: 200, body: { cancelled: true } })
  if (action === 'revoke') assert.equal((await f.revoke()).status, 200)
  if (action === 'rotate') f.rotate()
  code(await pendingRun, 409, 'STALE')
  assert.equal(f.posts[0].signal.aborted, true)
  late.resolve()
  await delivered.promise
  await setImmediate()
  assert.equal(f.posts.length, 1)
  assert.equal(f.decisions(), 0)
  assert.ok(f.boardUnchanged())
  trace(`${action}_in_flight`, f, { runStatus: 409, aborted: true, lateValidResponseDelivered: true, answerReturned: false, boardUnchanged: true })
})
