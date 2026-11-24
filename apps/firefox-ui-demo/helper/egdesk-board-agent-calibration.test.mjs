import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { rmSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { createBoardAgentAsk } from '../overlay/resources/EGDeskBoardAgentAsk.sys.mjs'
import { createBoardAgentAskService } from './egdesk-board-agent-ask.mjs'
import { selectBoardAgentContext } from './egdesk-board-agent-context.mjs'
import { createBoardAgentDraftTransport } from './egdesk-board-agent-draft.mjs'
import { openCalibrationLog, CALIBRATION_FILE } from './egdesk-decision-calibration-log.mjs'
import { createDecisionClient, DECISION_MODEL } from './egdesk-decision-client.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'

// L1 cycle 4. Synthetic: temp desk + temp private calibration file, real service/selector/client, mock fetch.
const BOARD = 'board-calibration-sim', PROFILE = 'profile-calibration-sim'
const QUESTION = 'Where do visitors park on Friday?'
const E = ['Friday visitors park behind the gym.', 'Meet in the atrium on Friday.', 'Catering invoice totals seventy credits.']
const KEY = 'egd-synthetic-not-a-key-0001'
const profile = { lifecycle: 'active', activeRevision: 1, active: { revision: 1, hash: 'a'.repeat(64), body: { name: 'Calibration Sim Agent', model: null } } }
const sha = text => createHash('sha256').update(text).digest('hex')
const probs = list => body => Response.json({ model: DECISION_MODEL, answers: body.questions.map((q, i) => ({ name: q.name, type: 'predicate', probability: list[i] })) })
const err = (status, code) => () => Response.json({ error: { code, type: code } }, { status })

function machine(t, { mode, respond, draftFetch = null, brokenLog = false }) {
  const root = createPrivateQaTempDirectory('egdesk-board-calibration-')
  const desk = openDeskStore({ dataDir: path.join(root, 'desk'), ownerScope: 'calibration-sim' })
  desk.saveBoard(BOARD, { body: { version: 1, agenda: { id: BOARD, title: 'Sim Board' }, cards: [], shapes: [] }, expectedRevision: null })
  const log = openCalibrationLog({ dataDir: path.join(root, 'settings'), log() {} })
  const client = createDecisionClient({ getApiKey: () => KEY, fetchImpl: async (url, init) => respond(JSON.parse(init.body), init) })
  const draft = createBoardAgentDraftTransport({ readConfig: () => draftFetch ? { apiKey: 'egd-synthetic-draft-not-a-key-0002', model: 'synthetic-responses-model' } : null,
    fetchImpl: draftFetch ?? (async () => Response.json({}, { status: 500 })) })
  const service = createBoardAgentAskService({ desk, profiles: { get: id => id === PROFILE ? profile : null }, selectContext: selectBoardAgentContext, calibrationLog: brokenLog ? { record() { throw new Error('record failed') }, complete() { throw new Error('complete failed') } } : log,
    decisionStatus: () => mode === 'off' ? null : ({ mode, model: DECISION_MODEL, bindingId: 'sim-binding', client }), draft })
  t.after(() => { service.close(); desk.close(); rmSync(root, { recursive: true, force: true }) })
  let version = service.policy({ boardId: BOARD, action: 'save', expectedVersion: null, profileId: PROFILE, excerpts: E, publicInstructions: '' }).policy.version
  const issue = () => { const issued = service.policy({ boardId: BOARD, action: 'issue', expectedVersion: version }); version = issued.policy.version; return issued.askCode }
  const request = askCode => ({ kind: 'request', requestId: '8878a7f3-df6b-4383-af12-6ae38ad4fe2e', requestDigest: sha(String(Math.random())), question: QUESTION, recipient: 'Member', excerpt: '', expectedReply: 'short', askCode })
  async function ask({ decisionEgress, runMode = 'extract', code = issue() } = {}) {
    const prepared = service.prepare({ boardId: BOARD, request: request(code), mode: runMode, decisionEgress })
    const outcome = await service.run({ ticket: prepared.ticket, confirm: true }).then(result => ({ result }), error => ({ error: { code: error.code, status: error.httpStatus } }))
    return { prepared, code, ...outcome }
  }
  return { service, log, ask, issue, root, get version() { return version }, request }
}

const SCEN = {
  confident: { respond: probs([0.1, 0.98, 0.02]), probs: [0.98, 0.1, 0.02], picks: 1 },
  lowConfidence: { respond: probs([0.5, 0.55, 0.2]), probs: [0.55, 0.5, 0.2], picks: 0 },
  abstain: { respond: probs([0, 0, 0]), probs: [0, 0, 0], picks: 0 },
  noCredit: { respond: err(429, 'insufficient_quota'), fallback: 'no_credit' },
  spendLimit: { respond: err(429, 'organization_spend_limit_exceeded'), fallback: 'spend_limit_reached' },
  timeout: { respond: (b, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })), { once: true })), fallback: 'timeout' },
}

for (const mode of ['off', 'advisory', 'on']) for (const [name, s] of Object.entries(SCEN)) {
  test(`L1c4 calibration mode=${mode} decision=${name}`, async t => {
    const m = machine(t, { mode, respond: s.respond })
    const { result, error } = await m.ask({ decisionEgress: mode !== 'off' })
    assert.equal(error, undefined)
    const entries = m.log.entries()
    if (mode === 'off') { assert.deepEqual(entries, [], 'off records nothing'); return }
    assert.equal(entries.length, 1)
    const [entry] = entries
    t.diagnostic('ENTRY ' + JSON.stringify(entry))
    assert.deepEqual([entry.feature, entry.mode, entry.candidates], ['turn_context', mode, 3])
    assert.equal(entry.outcome.run, 'completed', 'the run outcome is stored once the ask finishes')
    if (s.fallback) {
      assert.equal(entry.fallback, s.fallback)
      assert.deepEqual(entry.judgments, [])
      assert.equal(entry.attached, false)
    } else {
      assert.deepEqual(entry.judgments.map(j => j.p), s.probs)
      assert.ok(entry.judgments.every(j => j.q === 'relevance' && j.kind === 'board' && j.threshold === 0.6))
      assert.deepEqual(entry.judgments.map(j => j.would), s.probs.map(p => p >= 0.6 ? 'attach' : 'skip'))
      assert.equal(entry.attached, mode === 'on' && s.picks > 0, 'attached = the selection was applied to the reply')
      assert.equal(entry.fallback, undefined)
    }
    // Advisory never changes the reply: the answer is the same as the no-Decisions local selection.
    if (mode === 'advisory') assert.equal(result.answer, [E[0], E[1]].join('\n\n'))
    // Content-free: nothing from the question, excerpts, ids, names or keys.
    const raw = readFileSync(path.join(m.root, 'settings', CALIBRATION_FILE), 'utf8')
    for (const secret of [QUESTION, ...E, BOARD, PROFILE, 'Calibration Sim Agent', KEY, 'Member', 'egask1']) assert.ok(!raw.includes(secret), 'file must not contain: ' + secret.slice(0, 12))
  })
}

test('L1c4 recording never changes the answer or throws, even when the log throws', async t => {
  const fine = await machine(t, { mode: 'on', respond: SCEN.confident.respond }).ask({ decisionEgress: true })
  const broken = await machine(t, { mode: 'on', respond: SCEN.confident.respond, brokenLog: true }).ask({ decisionEgress: true })
  assert.equal(broken.error, undefined)
  assert.deepEqual(broken.result, fine.result)
  assert.equal(broken.result.answer, E[1])
})

// --- Item 2: the question code when a run does not complete -----------------------------------
test('L1c4 code lifecycle: screening failure is not a failed run; a failed draft or revoked run consumes the code; manual reply stays available', async t => {
  const rows = []
  // (a) screening 429/timeout: run completes with the local selection, code is used, replay is refused
  for (const name of ['noCredit', 'spendLimit', 'timeout']) {
    const m = machine(t, { mode: 'on', respond: SCEN[name].respond })
    const first = await m.ask({ decisionEgress: true })
    assert.ok(first.result, 'screening failure still returns a reviewed answer')
    assert.equal(first.result.screening, 'fallback')
    assert.throws(() => m.service.prepare({ boardId: BOARD, request: m.request(first.code), mode: 'extract', decisionEgress: false }), e => e.code === 'BOARD_AGENT_ASK_CODE_INVALID')
    assert.rejects(m.service.run({ ticket: first.prepared.ticket, confirm: true }), { code: 'BOARD_AGENT_ASK_STALE' })
    rows.push([name, 'answer returned', 'code consumed', 'replay refused'])
  }
  // (b) draft provider failure after approval: no answer; code consumed; same code cannot be reused
  const d = machine(t, { mode: 'off', respond: SCEN.confident.respond, draftFetch: async () => Response.json({}, { status: 500 }) })
  const failed = await d.ask({ decisionEgress: false, runMode: 'draft' })
  assert.equal(failed.error?.code, 'BOARD_AGENT_ASK_RUN_FAILED')
  assert.throws(() => d.service.prepare({ boardId: BOARD, request: d.request(failed.code), mode: 'extract', decisionEgress: false }), e => e.code === 'BOARD_AGENT_ASK_CODE_INVALID')
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
      if (end === 'prepare') return { status: 200, body: { ticket: 't', expiresAt: 5000, mode: 'extract', decisionEgress: false, profileName: 'Agent', profileRevision: 1, model: null,
        provider: null, draftModel: null, decisionModel: null, question: 'q?', excerpts: ['x'], replyStyle: 'plain', publicInstructions: '' } }
      if (end === 'run') return { status: 502, body: { code: 'BOARD_AGENT_ASK_RUN_FAILED' } }
      return { status: 200, body: {} }
    } })
  await flow.open({ board: { id: 'b', title: 'B' }, review })
  await flow.prepare(); await flow.run()
  assert.equal(view.step, 'stopped')
  assert.match(view.error, /질문 코드는 이미 사용되었을 수 있습니다.*직접 회신/)
})
