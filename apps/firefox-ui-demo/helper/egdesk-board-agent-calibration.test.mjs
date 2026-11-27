import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rmSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { createBoardAgentAsk } from '../overlay/resources/EGDeskBoardAgentAsk.sys.mjs'
import { createBoardAgentAskService } from './egdesk-board-agent-ask.mjs'
import { localDay, readScreeningInput, selectBoardAgentContext } from './egdesk-board-agent-context.mjs'
import { createBoardAgentDraftTransport } from './egdesk-board-agent-draft.mjs'
import { openCalibrationLog, CALIBRATION_FILE } from './egdesk-decision-calibration-log.mjs'
import { createDecisionClient, DECISION_MODEL } from './egdesk-decision-client.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'

// L1 cycle 4, updated in cycle 7. Synthetic: temp desk + temp private calibration file, real service/selector/client, mock fetch.
// Cycle 7: there is no per-request screening choice. Decisions screens the approved excerpts only in a draft run (the run that
// already sends them to the drafting model) and only under the saved mode, so the screening cases below are draft runs.
const DRAFT_MODEL = 'synthetic-responses-model', DRAFT_ANSWER = 'Synthetic drafted reply.'
const draftOk = () => Response.json({ object: 'response', status: 'completed', model: DRAFT_MODEL, output: [{ type: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: DRAFT_ANSWER }] }] })
const BOARD = 'board-calibration-sim', PROFILE = 'profile-calibration-sim'
const QUESTION = 'Where do visitors park on Friday?'
const E = ['Friday visitors park behind the gym.', 'Meet in the atrium on Friday.', 'Catering invoice totals seventy credits.']
const KEY = 'egd-synthetic-not-a-key-0001'
const profile = { lifecycle: 'active', activeRevision: 1, active: { revision: 1, hash: 'a'.repeat(64), body: { name: 'Calibration Sim Agent', model: null } } }
const sha = text => createHash('sha256').update(text).digest('hex')
// The provider answers every question it is sent: relevance from the list (those questions come first), and (L1 cycle 12) "still in effect
// today?" for each excerpt, in effect unless the test says otherwise.
const probs = (list, inEffect = () => 0.97) => (body) => Response.json({ model: DECISION_MODEL, answers: body.questions.map((q, i) => ({ name: q.name, type: 'predicate', probability: q.name.endsWith('_now') ? inEffect(q.name) : list[i] })) })
const err = (status, code) => () => Response.json({ error: { code, type: code } }, { status })

function machine(t, { mode, respond, draftFetch = draftOk, brokenLog = false }) {
  const root = createPrivateQaTempDirectory('egdesk-board-calibration-')
  const desk = openDeskStore({ dataDir: path.join(root, 'desk'), ownerScope: 'calibration-sim' })
  desk.saveBoard(BOARD, { body: { version: 1, agenda: { id: BOARD, title: 'Sim Board' }, cards: [], shapes: [] }, expectedRevision: null })
  const log = openCalibrationLog({ dataDir: path.join(root, 'settings'), log() {} })
  const decisionPosts = [], draftExcerpts = []
  const client = createDecisionClient({ getApiKey: () => KEY, fetchImpl: async (url, init) => { decisionPosts.push(JSON.parse(init.body)); return respond(JSON.parse(init.body), init) } })
  const draft = createBoardAgentDraftTransport({ readConfig: () => ({ apiKey: 'egd-synthetic-draft-not-a-key-0002', model: DRAFT_MODEL }),
    fetchImpl: async (url, init) => { draftExcerpts.push(JSON.parse(JSON.parse(init.body).input[0].content[0].text).excerpts); return draftFetch() } })
  const service = createBoardAgentAskService({ desk, profiles: { get: id => id === PROFILE ? profile : null }, selectContext: selectBoardAgentContext, calibrationLog: brokenLog ? { record() { throw new Error('record failed') }, complete() { throw new Error('complete failed') } } : log,
    decisionStatus: () => mode === 'off' ? null : ({ mode, model: DECISION_MODEL, bindingId: 'sim-binding', client }), draft })
  t.after(() => { service.close(); desk.close(); rmSync(root, { recursive: true, force: true }) })
  let version = service.policy({ boardId: BOARD, action: 'save', expectedVersion: null, profileId: PROFILE, excerpts: E, publicInstructions: '' }).policy.version
  const issue = () => { const issued = service.policy({ boardId: BOARD, action: 'issue', expectedVersion: version }); version = issued.policy.version; return issued.askCode }
  const request = askCode => ({ kind: 'request', requestId: '8878a7f3-df6b-4383-af12-6ae38ad4fe2e', requestDigest: sha(String(Math.random())), question: QUESTION, recipient: 'Member', excerpt: '', expectedReply: 'short', askCode })
  async function ask({ runMode = 'draft', code = issue() } = {}) {
    const prepared = service.prepare({ boardId: BOARD, request: request(code), mode: runMode })
    const outcome = await service.run({ ticket: prepared.ticket, confirm: true }).then(result => ({ result }), error => ({ error: { code: error.code, status: error.httpStatus } }))
    return { prepared, code, ...outcome }
  }
  return { service, log, ask, issue, root, get version() { return version }, request, decisionPosts, draftExcerpts }
}

const SCEN = {
  confident: { respond: probs([0.1, 0.98, 0.02]), probs: [0.98, 0.1, 0.02], picks: 1 },
  lowConfidence: { respond: probs([0.5, 0.55, 0.2]), probs: [0.55, 0.5, 0.2], picks: 0 },
  abstain: { respond: probs([0, 0, 0]), probs: [0, 0, 0], picks: 0 },
  noCredit: { respond: err(429, 'insufficient_quota'), fallback: 'no_credit' },
  spendLimit: { respond: err(429, 'organization_spend_limit_exceeded'), fallback: 'spend_limit_reached' },
  timeout: { respond: (b, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })), { once: true })), fallback: 'timeout' },
}

const LOCAL = [E[0], E[1]] // what the on-device word match picks for this question
for (const mode of ['off', 'advisory', 'on']) for (const [name, s] of Object.entries(SCEN)) {
  test(`L1c4 calibration (draft run) mode=${mode} decision=${name}`, async t => {
    const m = machine(t, { mode, respond: s.respond })
    const { result, error, prepared } = await m.ask()
    assert.equal(error, undefined)
    assert.equal(Object.hasOwn(prepared, 'decisionEgress'), false)
    const entries = m.log.entries()
    if (mode === 'off') {
      assert.deepEqual(entries, [], 'off records nothing')
      assert.equal(m.decisionPosts.length, 0, 'off sends nothing to Decisions')
      assert.deepEqual(m.draftExcerpts, [LOCAL]); assert.equal(Object.hasOwn(result, 'screening'), false)
      return
    }
    assert.equal(m.decisionPosts.length, s.fallback ? 1 : 1 + (s.picks > 0 ? 1 : 0), 'allowed: one relevance request, plus (L1 c13) the time question only when something is relevant')
    assert.deepEqual(readScreeningInput(m.decisionPosts[0].input), { question: QUESTION, today: localDay(Date.now()), candidates: E.map((text, i) => ({ alias: `c${i + 1}`, text })) })
    assert.equal(entries.length, 1)
    const [entry] = entries
    t.diagnostic('ENTRY ' + JSON.stringify(entry))
    assert.deepEqual([entry.feature, entry.mode, entry.candidates], ['board_reply', mode, 3])
    assert.equal(entry.outcome.run, 'completed', 'the run outcome is stored once the ask finishes')
    if (s.fallback) {
      assert.equal(entry.fallback, s.fallback)
      assert.deepEqual(entry.judgments, [])
      assert.equal(entry.attached, false)
      assert.equal(result.screening, 'fallback')
      assert.deepEqual(m.draftExcerpts, [LOCAL], 'a failed screening leaves the local selection for the draft')
    } else {
      const relevance = entry.judgments.filter(j => j.q === 'relevance'), inEffect = entry.judgments.filter(j => j.q === 'in_effect')
      assert.deepEqual(relevance.map(j => j.p), s.probs)
      assert.ok(relevance.every(j => j.kind === 'board' && j.threshold === 0.6))
      assert.deepEqual(relevance.map(j => j.would), s.probs.map(p => p >= 0.6 ? 'attach' : 'skip'))
      // L1 cycle 13: the time judgment only for the excerpts decided relevant (R3), against its own bar, and nothing else
      assert.deepEqual(inEffect.map(j => [j.p, j.threshold, j.would, j.kind]), Array.from({ length: s.picks }, () => [0.97, 0.5, 'accept', 'board']))
      assert.equal(entry.judgments.length, relevance.length + inEffect.length)
      assert.equal(entry.attached, mode === 'on' && s.picks > 0, 'attached = the selection was applied to the reply')
      assert.equal(entry.fallback, undefined)
      assert.equal(result.screening, mode === 'advisory' ? 'advisory' : 'decision')
      // Advisory never changes the reply inputs: the drafting model gets the same local selection as with no Decisions.
      if (mode === 'advisory') assert.deepEqual(m.draftExcerpts, [LOCAL])
      else assert.deepEqual(m.draftExcerpts, s.picks ? [[E[1]]] : [], 'on: only the screened excerpts go to the draft; none selected means no draft request')
    }
    // Content-free: nothing from the question, excerpts, ids, names or keys.
    const raw = readFileSync(path.join(m.root, 'settings', CALIBRATION_FILE), 'utf8')
    for (const secret of [QUESTION, ...E, BOARD, PROFILE, 'Calibration Sim Agent', KEY, 'Member', 'egask1', DRAFT_ANSWER]) assert.ok(!raw.includes(secret), 'file must not contain: ' + secret.slice(0, 12))
  })
}

for (const mode of ['off', 'advisory', 'on']) test(`L1c7 extract run mode=${mode}: no model receives the excerpts, so 0 Decisions requests, no record, the local selection as before`, async t => {
  const m = machine(t, { mode, respond: SCEN.confident.respond })
  const { result, error, prepared } = await m.ask({ runMode: 'extract' })
  assert.equal(error, undefined)
  assert.deepEqual([prepared.decisionModel, prepared.decisionMode, prepared.provider], [null, null, null])
  assert.deepEqual(result, { mode: 'extract', answer: LOCAL.join('\n\n'), source: 'local', omittedCount: 0 })
  assert.equal(m.decisionPosts.length, 0)
  assert.deepEqual(m.draftExcerpts, [])
  assert.deepEqual(m.log.entries(), [])
})

test('L1c4 recording never changes the answer or throws, even when the log throws', async t => {
  const fineMachine = machine(t, { mode: 'on', respond: SCEN.confident.respond }), brokenMachine = machine(t, { mode: 'on', respond: SCEN.confident.respond, brokenLog: true })
  const fine = await fineMachine.ask(), broken = await brokenMachine.ask()
  assert.equal(broken.error, undefined)
  assert.deepEqual(broken.result, fine.result)
  assert.deepEqual(broken.result, { mode: 'draft', answer: DRAFT_ANSWER, source: 'draft', screening: 'decision' })
  assert.deepEqual([fineMachine.draftExcerpts, brokenMachine.draftExcerpts], [[[E[1]]], [[E[1]]]])
})

// --- Item 2: the question code when a run does not complete -----------------------------------
test('L1c4 code lifecycle: screening failure is not a failed run; a failed draft or revoked run consumes the code; manual reply stays available', async t => {
  const rows = []
  // (a) screening 429/timeout: run completes with the local selection, code is used, replay is refused
  for (const name of ['noCredit', 'spendLimit', 'timeout']) {
    const m = machine(t, { mode: 'on', respond: SCEN[name].respond })
    const first = await m.ask()
    assert.ok(first.result, 'screening failure still returns a reviewed answer')
    assert.equal(first.result.screening, 'fallback')
    assert.throws(() => m.service.prepare({ boardId: BOARD, request: m.request(first.code), mode: 'extract' }), e => e.code === 'BOARD_AGENT_ASK_CODE_INVALID')
    await assert.rejects(m.service.run({ ticket: first.prepared.ticket, confirm: true }), { code: 'BOARD_AGENT_ASK_STALE' })
    rows.push([name, 'answer returned', 'code consumed', 'replay refused'])
  }
  // (b) draft provider failure after approval: no answer; code consumed; same code cannot be reused
  const d = machine(t, { mode: 'off', respond: SCEN.confident.respond, draftFetch: async () => Response.json({}, { status: 500 }) })
  const failed = await d.ask({ runMode: 'draft' })
  assert.equal(failed.error?.code, 'BOARD_AGENT_ASK_RUN_FAILED')
  assert.throws(() => d.service.prepare({ boardId: BOARD, request: d.request(failed.code), mode: 'extract' }), e => e.code === 'BOARD_AGENT_ASK_CODE_INVALID')
  rows.push(['draft provider 500', 'RUN_FAILED 502', 'code consumed', 'same code refused'])
  t.diagnostic('CODE ' + JSON.stringify(rows))
})

test('L1c4 owner sees that a failed run may have used the code and that a manual reply remains possible', async () => {
  const review = { kind: 'request', recipient: 'r', question: 'q?', excerpt: '', expectedReply: 'e', requestId: '76165063-e1c0-48c9-b42d-465545d0a626', requestDigest: 'a'.repeat(64), askCode: 'egask1-' + 'b'.repeat(32) }
  const policy = { version: 'v1', profileId: 'p', profileName: 'Agent', profileRevision: 1, stale: false, excerpts: ['x'], publicInstructions: '' }
  let view = null
  const flow = createBoardAgentAsk({ isCurrent: () => true, onState: v => { view = v }, onAnswer() { assert.fail('no answer') }, loadProfiles: () => [], now: () => 1000,
    post: async path => {
      const end = path.split('/').at(-1)
      if (end === 'policy') return { status: 200, body: { policy, availability: { decision: false, draft: false, model: null } } }
      if (end === 'prepare') return { status: 200, body: { ticket: 't', expiresAt: 5000, mode: 'extract', profileName: 'Agent', profileRevision: 1, model: null,
        provider: null, draftModel: null, decisionModel: null, question: 'q?', excerpts: ['x'], replyStyle: 'plain', publicInstructions: '' } }
      if (end === 'run') return { status: 502, body: { code: 'BOARD_AGENT_ASK_RUN_FAILED' } }
      return { status: 200, body: {} }
    } })
  await flow.open({ board: { id: 'b', title: 'B' }, review })
  await flow.prepare(); await flow.run()
  assert.equal(view.step, 'stopped')
  assert.match(view.error, /질문 코드는 이미 사용되었을 수 있습니다.*직접 회신/)
})
