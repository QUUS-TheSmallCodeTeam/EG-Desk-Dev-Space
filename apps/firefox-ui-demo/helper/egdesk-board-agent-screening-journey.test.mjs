import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { createReviewFlow } from '../overlay/resources/EGDeskReviewHandoff.sys.mjs'
import { createBoardAgentAskService } from './egdesk-board-agent-ask.mjs'
import { selectBoardAgentContext } from './egdesk-board-agent-context.mjs'
import { createBoardAgentDraftTransport } from './egdesk-board-agent-draft.mjs'
import { createBoardAgentDraftConfigReader, BOARD_AGENT_DRAFT_CONFIG_FILE } from './egdesk-board-agent-draft-config.mjs'
import { createDecisionClient, DECISION_MODEL } from './egdesk-decision-client.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'

// L1 cycle 3 (updated in cycle 7): Board ask journey per Decisions mode. Synthetic: temp SQLite desk, real service,
// real selector + real Decisions client with mock fetch, real review flow for what the owner sees.
// Cycle 7: the owner no longer chooses screening per request. Decisions screens the approved excerpts only in a draft run
// (the run that already sends them to the drafting model) under the saved mode; an extract run sends nothing anywhere.
const DRAFT_MODEL = 'synthetic-responses-model', DRAFT_ANSWER = 'Synthetic drafted reply.'
const DRAFT_ON = () => ({ apiKey: 'egd-synthetic-draft-not-a-key-0002', model: DRAFT_MODEL })
const BOARD = 'board-screening-sim'
const PROFILE = 'profile-screening-sim'
const QUESTION = 'Where do visitors park on Friday?'
const E = ['Friday visitors park behind the gym.', 'Meet in the atrium on Friday.', 'Catering invoice totals seventy credits.']
const DECISION_KEY = 'egd-synthetic-not-a-key-0001'
const profile = { lifecycle: 'active', activeRevision: 1, active: { revision: 1, hash: 'a'.repeat(64), body: { name: 'Sim Agent', model: null } } }
const sha = text => createHash('sha256').update(text).digest('hex')

function machine(t, { mode, respond, draftConfig = DRAFT_ON, excerpts = E }) {
  const root = createPrivateQaTempDirectory('egdesk-board-screening-')
  const desk = openDeskStore({ dataDir: path.join(root, 'desk'), ownerScope: 'screening-sim' })
  desk.saveBoard(BOARD, { body: { version: 1, agenda: { id: BOARD, title: 'Sim Board' }, cards: [], shapes: [] }, expectedRevision: null })
  const posts = []
  const client = createDecisionClient({ getApiKey: () => DECISION_KEY, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body)
    posts.push({ names: body.questions.map(q => q.name), input: JSON.parse(body.input), auth: init.headers.authorization === `Bearer ${DECISION_KEY}` })
    return respond(body, init)
  } })
  const draftPosts = []
  const draft = createBoardAgentDraftTransport({ readConfig: draftConfig, fetchImpl: async (url, init) => {
    draftPosts.push(JSON.parse(JSON.parse(init.body).input[0].content[0].text).excerpts)
    return Response.json({ object: 'response', status: 'completed', model: DRAFT_MODEL, output: [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: DRAFT_ANSWER }] }] })
  } })
  const service = createBoardAgentAskService({ desk, profiles: { get: id => id === PROFILE ? profile : null }, selectContext: selectBoardAgentContext,
    decisionStatus: () => mode === 'off' ? null : ({ mode, model: DECISION_MODEL, bindingId: 'sim-binding', client }), draft })
  t.after(() => { service.close(); desk.close(); rmSync(root, { recursive: true, force: true }) })
  let version = null
  const save = () => { version = service.policy({ boardId: BOARD, action: 'save', expectedVersion: null, profileId: PROFILE, excerpts, publicInstructions: '' }).policy.version }
  save()
  const issue = () => { const issued = service.policy({ boardId: BOARD, action: 'issue', expectedVersion: version }); version = issued.policy.version; return issued.askCode }
  async function ask({ runMode = 'draft', between } = {}) {
    const askCode = issue()
    const request = { kind: 'request', requestId: '8878a7f3-df6b-4383-af12-6ae38ad4fe2e', requestDigest: sha(String(Math.random())), question: QUESTION,
      recipient: 'Member', excerpt: '', expectedReply: 'short', askCode }
    const prepared = service.prepare({ boardId: BOARD, request, mode: runMode })
    await between?.(prepared)
    const outcome = await service.run({ ticket: prepared.ticket, confirm: true }).then(result => ({ result }), error => ({ error: { code: error.code, status: error.httpStatus } }))
    return { prepared, ...outcome, request }
  }
  return { desk, service, posts, draftPosts, ask, get version() { return version }, save, issue, set version(v) { version = v } }
}

// What the Board owner sees in the reply composer after the run (real review flow + real beginAgentReply).
async function ownerView(request, result) {
  const binding = Object.freeze({}), board = { id: BOARD, title: 'Sim Board' }
  const flow = createReviewFlow({ getContext: () => binding, isContextCurrent: v => v === binding, getBoard: () => board, isBoardCurrent: () => true,
    store: { check() {}, issue() {} }, pickFile: async () => ({ bytes: new Uint8Array([1]) }),
    request: async () => ({ status: 200, body: { locked: false, encrypted: true, review: request } }) })
  flow.openFile(); await flow.chooseFile()
  assert.equal(flow.beginAgentReply(flow.view().review, board, result), true)
  return { note: flow.view().answerSource, answer: flow.view().review.answer ?? '' }
}

const probs = list => (body) => Response.json({ model: DECISION_MODEL, answers: body.questions.map((q, i) => ({ name: q.name, type: 'predicate', probability: list[i] })) })
const err429 = code => () => Response.json({ error: { code, type: code } }, { status: 429 })
const SCENARIOS = {
  confident: { respond: probs([0.1, 0.98, 0.02]) },
  lowConfidence: { respond: probs([0.5, 0.55, 0.2]) },
  abstainNone: { respond: probs([0, 0, 0]) },
  outOfSet: { respond: body => Response.json({ model: DECISION_MODEL, answers: [...body.questions.map(q => ({ name: q.name, type: 'predicate', probability: 0.9 })), { name: 'c99', type: 'predicate', probability: 0.99 }] }) },
  quotaInsufficient: { respond: err429('insufficient_quota') },
  quotaSpendLimit: { respond: err429('spend_limit_reached') },
  timeout: { respond: (body, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })) },
}

const table = []
const FAILED = ['quotaInsufficient', 'quotaSpendLimit', 'timeout']
for (const mode of ['off', 'advisory', 'on']) for (const [name, scenario] of Object.entries(SCENARIOS)) {
  test(`L1c3 journey (draft run) mode=${mode} decision=${name}`, async t => {
    const m = machine(t, { mode, respond: scenario.respond })
    const { prepared, result, error, request } = await m.ask()
    assert.equal(error, undefined, JSON.stringify(error))
    // Hard invariants in every mode: only owner-approved excerpts can reach the drafting model, and so the reply.
    const sent = m.draftPosts.flat()
    for (const part of sent) assert.ok(E.includes(part), 'the draft receives only approved excerpts: ' + part)
    assert.ok(m.draftPosts.length <= 1)
    assert.ok(!JSON.stringify(m.draftPosts).includes('c99'))
    const view = await ownerView(request, result)
    const row = { mode, scenario: name, posts: m.posts.length, draftRequests: m.draftPosts.length, usedExcerpts: sent.map(p => E.indexOf(p) + 1), source: result.source,
      screening: result.screening ?? null, previewDecisionMode: prepared.decisionMode ?? null, ownerNote: view.note }
    table.push(row)
    t.diagnostic('ROW ' + JSON.stringify(row))
    assert.equal(Object.hasOwn(prepared, 'decisionEgress'), false, 'no per-request screening choice in the contract')
    if (mode === 'off') assert.equal(m.posts.length, 0, 'off: no egress to Decisions at all')
    else {
      assert.equal(m.posts.length, 1, 'allowed: exactly one screening request')
      assert.deepEqual(m.posts[0].input, { question: QUESTION, candidates: E.map((text, i) => ({ alias: `c${i + 1}`, text })) }, 'only question + approved candidates leave the host')
      assert.equal(m.posts[0].auth, true)
    }
    const failed = FAILED.includes(name)
    const expected = mode === 'off' ? null : failed ? 'fallback' : mode === 'advisory' ? 'advisory' : 'decision'
    // What the drafting model received: the local word match unless the saved mode is on and Decisions answered.
    const expectedUsed = expected !== 'decision' ? [1, 2] : name === 'confident' ? [2] : name === 'outOfSet' ? [1, 2, 3] : []
    assert.deepEqual(row.usedExcerpts, expectedUsed, 'advisory / off / failure never change the selection; on narrows inside the approved set')
    assert.equal(row.draftRequests, expectedUsed.length ? 1 : 0, 'nothing selected means no draft request')
    // Owner-facing note says what the screening actually did.
    assert.equal(row.screening, expected, 'screening label')
    assert.equal(row.previewDecisionMode, mode === 'off' ? null : mode, 'preview names the Decisions mode that applies')
    assert.equal(prepared.decisionModel, mode === 'off' ? null : DECISION_MODEL)
    if (expected === 'fallback') assert.match(view.note, /Decisions API 판단을 완료하지 못해/)
    if (expected === 'advisory') assert.match(view.note, /기록만.*반영하지 않고/)
    if (expected === 'decision') assert.match(view.note, /Decisions API를 사용했습니다/)
    if (mode === 'off') assert.doesNotMatch(view.note, /Decisions/)
  })
}

for (const mode of ['off', 'advisory', 'on']) for (const name of ['confident', 'quotaInsufficient']) {
  test(`L1c7 journey (extract run) mode=${mode} decision=${name}: nothing leaves, local selection as before`, async t => {
    const m = machine(t, { mode, respond: SCENARIOS[name].respond })
    const { prepared, result, error, request } = await m.ask({ runMode: 'extract' })
    assert.equal(error, undefined, JSON.stringify(error))
    assert.deepEqual([prepared.decisionModel, prepared.decisionMode, prepared.provider, prepared.payer], [null, null, null, null])
    assert.deepEqual(result, { mode: 'extract', answer: [E[0], E[1]].join('\n\n'), source: 'local', omittedCount: 0 })
    assert.deepEqual([m.posts.length, m.draftPosts.length], [0, 0], 'an extract run sends the excerpts to no model, so not to Decisions either')
    const view = await ownerView(request, result)
    assert.doesNotMatch(view.note, /Decisions/)
    assert.equal(view.answer, result.answer)
  })
}

test('L1c7 no request field can ask for screening: the removed flag is rejected in every mode and nothing is posted', async t => {
  for (const mode of ['off', 'advisory', 'on']) {
    const m = machine(t, { mode, respond: SCENARIOS.confident.respond })
    for (const runMode of ['extract', 'draft']) {
      const askCode = m.issue()
      assert.throws(() => m.service.prepare({ boardId: BOARD, request: { kind: 'request', requestId: '8878a7f3-df6b-4383-af12-6ae38ad4fe2e', requestDigest: sha('x'), question: QUESTION, recipient: 'M', excerpt: '', expectedReply: 'r', askCode }, mode: runMode, decisionEgress: true }),
        error => error.code === 'BOARD_AGENT_ASK_INPUT')
    }
    assert.deepEqual([m.posts.length, m.draftPosts.length], [0, 0])
  }
})

test('L1c3 revoked / expired / edited policy between preview and run: nothing reaches the reply, no egress', async t => {
  for (const [label, between] of [
    ['revoked', m => m.service.policy({ boardId: BOARD, action: 'revoke', expectedVersion: m.version })],
    ['re-saved with different excerpts', m => m.service.policy({ boardId: BOARD, action: 'save', expectedVersion: m.version, profileId: PROFILE, excerpts: ['changed'], publicInstructions: '' })],
    ['code re-issued', m => m.service.policy({ boardId: BOARD, action: 'issue', expectedVersion: m.version })],
  ]) {
    const m = machine(t, { mode: 'on', respond: SCENARIOS.confident.respond })
    const out = await m.ask({ between: () => between(m) })
    assert.equal(out.result, undefined, label)
    assert.equal(out.error.code, 'BOARD_AGENT_ASK_STALE', label)
    assert.equal(m.posts.length, 0, label + ': no Decisions request after the grant changed')
    assert.equal(m.draftPosts.length, 0, label + ': no draft request either')
  }
})

test('L1c3 mid-run revocation while Decisions is in flight discards the late answer', async t => {
  let release
  const gate = new Promise(r => { release = r })
  const m = machine(t, { mode: 'on', respond: async body => { await gate; return SCENARIOS.confident.respond(body) } })
  const pendingAsk = m.ask()
  for (let i = 0; m.posts.length === 0; i++) { assert.ok(i < 400, 'the screening request was never sent'); await new Promise(r => setTimeout(r, 5)) }
  m.service.policy({ boardId: BOARD, action: 'revoke', expectedVersion: m.version })
  release()
  const out = await pendingAsk
  assert.equal(out.result, undefined)
  assert.equal(out.error.code, 'BOARD_AGENT_ASK_STALE')
  assert.equal(m.draftPosts.length, 0, 'the late screening answer never reaches the drafting model')
})

test('L1c3 Responses draft path stays off unless its own config + key exist', async t => {
  // 1. no config -> unavailable; and without a drafting model no ask can reach Decisions (only extract runs remain)
  const off = machine(t, { mode: 'on', respond: SCENARIOS.confident.respond, draftConfig: () => null })
  const askCode = off.issue()
  const req = { kind: 'request', requestId: '8878a7f3-df6b-4383-af12-6ae38ad4fe2e', requestDigest: sha('d'), question: QUESTION, recipient: 'M', excerpt: '', expectedReply: 'r', askCode }
  assert.equal(off.service.policy({ boardId: BOARD, action: 'get' }).availability.draft, false)
  assert.throws(() => off.service.prepare({ boardId: BOARD, request: req, mode: 'draft' }), e => e.code === 'BOARD_AGENT_ASK_DRAFT_OFF')
  const onlyExtract = await off.ask({ runMode: 'extract' })
  assert.equal(onlyExtract.result.source, 'local'); assert.equal(Object.hasOwn(onlyExtract.result, 'screening'), false)
  // 2. the real config reader: missing file -> null; same key as Decisions key -> null (never a fallback)
  const root = createPrivateQaTempDirectory('egdesk-draft-config-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const reader = createBoardAgentDraftConfigReader({ dataDir: path.join(root, 'data'), getDecisionApiKey: () => DECISION_KEY })
  assert.equal(reader(), null, 'no file -> off')
  mkdirSync(path.join(root, 'data', 'settings'), { recursive: true, mode: 0o700 })
  writeFileSync(path.join(root, 'data', 'settings', BOARD_AGENT_DRAFT_CONFIG_FILE), JSON.stringify({ version: 1, provider: 'openai', model: 'gpt-4.1-mini-2025-04-14', apiKey: DECISION_KEY }), { mode: 0o600 })
  assert.equal(reader(), null, 'draft key equal to the Decisions key is rejected')
  assert.equal(off.posts.length + off.draftPosts.length, 0)
})
test.after?.(() => {})
