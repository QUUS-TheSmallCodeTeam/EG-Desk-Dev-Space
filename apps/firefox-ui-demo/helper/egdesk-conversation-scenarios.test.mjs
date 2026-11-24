import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SCENARIO_KINDS, UNSTATED_NOTE, pickByLabels, pickScenarios, runScenario, scenarioPlan } from './egdesk-conversation-scenarios.mjs'
import { world as flowWorld } from './egdesk-heartbeat-flow.fixture.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'
import { judgeConfirmation } from './egdesk-record-confirmation.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { allOnWorld } from '../scripts/egdesk-all-on.support.mjs'
import { main as scenariosMain } from '../scripts/egdesk-conversation-scenarios.mjs'
import { main as runnerMain } from './egdesk-decision-real-runner.mjs'

// SYNTHETIC examples in the shape of helper/egdesk-conversation-examples.mjs (no real conversation text in the repository).
const PREV = '배포 전 체크리스트를 정리했습니다. 이대로 다음 단계로 넘어갈까요? 원하시면 롤백 절차도 같이 보겠습니다.'
const ex = (id, user, tags, extra = {}) => ({ id, area: 'egdesk', privacy: 'owner-approved', at: `2026-11-0${id.length % 9 + 1}T00:00:00Z`, source: { kind: 'codex', file: 'synthetic.jsonl', line: 1 },
  before: { text: '배포 준비 상황 정리해줘' }, prev: { text: PREV }, user: { text: user }, next: { text: '네, 진행하겠습니다.' }, tags, ...extra })
const EXAMPLES = [ex('r1', '아까 말한 롤백 절차 다시 설명해줘', ['referential']), ex('c1', '아니 그게 아니라 체크리스트는 어제 거야', ['correction']), ex('a1', 'ㅇㅇ', ['approval', 'ambiguous']),
  ex('p1', '고마워, 잘했어', ['praise']), ex('h1', '왜 멈췄어? 계속 진행해', ['pushback', 'frustration']), ex('q1', '그게 무슨 뜻이야? 모르겠네', ['reask']), ex('a2', '그래', ['approval', 'ambiguous']),
  ex('s1', 'ok', ['approval'], { prev: { text: 'No response requested.' } })]
const makeClient = fetchImpl => createDecisionClient({ getApiKey: async () => 'egd-synthetic-not-a-key-scenario-test', fetchImpl })

test('picks: one example per kind (two where asked), labelled yes first, automation stubs never, deterministic', () => {
  const labels = new Map([['a2', { approval: 'yes', ambiguous: 'yes' }]])
  const picked = pickScenarios(EXAMPLES, labels)
  assert.deepEqual(picked.map(p => [p.kind, p.example.id, p.labelledBy]), [['triage_recall', 'r1', 'heuristic'], ['triage_correction', 'c1', 'heuristic'], ['triage_approval', 'a2', 'decision_model'],
    ['triage_praise', 'p1', 'heuristic'], ['heartbeat_waiting', 'h1', 'heuristic'], ['context_reask', 'q1', 'heuristic'], ['confirm_unstated', 'a1', 'heuristic']])
  assert.ok(!picked.some(p => p.example.id === 's1'), '"No response requested." is not an assistant message the person reacted to')
  assert.deepEqual(pickScenarios(EXAMPLES, labels).map(p => p.example.id), picked.map(p => p.example.id))
  assert.deepEqual(pickScenarios([EXAMPLES.find(e => e.id === 's1')], new Map([['s1', { approval: 'yes' }]])), [], 'even labelled, a turn after an automation stub is not a scenario')
})

test('the scenarios drive the product paths in lane L2\'s all-on world (mock) and keep the product\'s own body for the person\'s turn', async () => {
  const picked = pickScenarios(EXAMPLES, new Map())
  const results = []
  for (const p of picked) results.push({ ...(await runScenario(p, { allOnWorld, judgeConfirmation, makeClient })), example: p.example, labelledBy: p.labelledBy })
  for (const r of results) {
    assert.ok(r.target, `${r.kind}: the product asked its ${SCENARIO_KINDS[r.kind].family} question`)
    const body = JSON.parse(r.target.body)
    assert.ok(r.target.body.includes(JSON.stringify(r.example.user.text).slice(1, -1)), `${r.kind}: the person's real turn is in the body`)
    assert.ok(lintGroupedRequest(body).ok)
  }
  const confirm = results.find(r => r.kind === 'confirm_unstated')
  assert.ok(confirm.target.body.includes(JSON.stringify(PREV).slice(1, -1)), 'the real assistant message is the previous reply')
  assert.ok(confirm.target.body.includes(UNSTATED_NOTE.title)); assert.equal(confirm.seen.action, 'keep')
  // What the product does NOT show today is recorded, not faked: the turn memory triage reads the message without the assistant message before it.
  const triage = results.find(r => r.kind === 'triage_approval')
  assert.ok(!triage.target.body.includes('다음 단계로 넘어갈까요'))
  const heartbeat = results.find(r => r.kind === 'heartbeat_waiting')
  assert.deepEqual(JSON.parse(heartbeat.target.body).questions.map(q => q.name).includes('message__note'), true)
  const built = scenarioPlan(results, { estimate: body => Math.ceil(Buffer.byteLength(body) / 3) })
  assert.equal(built.plan.requests.length, results.length)
  assert.ok(built.plan.tokenCeiling <= 12_000 && built.preregistration.every(p => p.status === 'proposed'))
  assert.ok(built.plan.requests.every(r => r.expect.length && r.expect.every(e => ['hard', 'soft'].includes(e.severity))))
})

test('CLI: writes outside the repository (0600); the plan it writes passes the real runner\'s dry run (product bars, grouping lint)', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-scen-')); t.after(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.EGDESK_SCENARIO_SEEDS })
  mkdirSync(path.join(dir, 'ex', 'examples'), { recursive: true })
  writeFileSync(path.join(dir, 'ex', 'examples', 'egdesk.jsonl'), EXAMPLES.map(e => JSON.stringify(e)).join('\n') + '\n')
  const out = path.join(dir, 'out'), lines = [], errors = []
  const code = await scenariosMain(['--examples', path.join(dir, 'ex'), '--out', out], { print: l => lines.push(l), printError: l => errors.push(l) })
  assert.equal(code, 0, errors.join('\n'))
  const summary = JSON.parse(lines.at(-1))
  assert.equal(summary.scenarios, 7); assert.equal(summary.withTarget, 7)
  assert.equal(statSync(path.join(out, 'plan', 'plan.json')).mode & 0o777, 0o600)
  const printed = [], refused = []
  const dry = await runnerMain([path.join(out, 'plan', 'plan.json')], { env: {}, print: l => printed.push(l), printError: l => refused.push(l), fetchImpl: async () => { throw new Error('no network') } })
  assert.equal(dry, 0, refused.join('\n')); assert.match(printed.join('\n'), /"mode":"dry_run"/)
  assert.ok(JSON.parse(readFileSync(path.join(out, 'mock-results.json'), 'utf8')).every(r => r.target))
})

test('v2 (c21): picked by the Decision labels only, the strongest per kind and area, each example once; the in-run kinds go through the beat\'s person questions', async () => {
  const score = (o = {}) => ({ correction: 0, pushback: 0, approval: 0, ambiguous: 0, referential: 0, topic_switch: 0, topic_return: 0, interruption: 0, praise: 0, frustration: 0, reask: 0, instruction_change: 0, ...o })
  const scores = new Map([['r1', score({ referential: 0.95 })], ['c1', score({ correction: 0.99, instruction_change: 0.9 })], ['h1', score({ frustration: 0.97, pushback: 0.9 })],
    ['a1', score({ approval: 0.92 })], ['a2', score({ approval: 0.99, ambiguous: 0.9 })], ['q1', score({ reask: 0.7 })], ['s1', score({ approval: 1 })]])
  const picked = pickByLabels(EXAMPLES, scores)
  assert.deepEqual(picked.map(p => [p.kind, p.example.id]), [['triage_recall', 'r1'], ['triage_correction', 'c1'], ['triage_approval', 'a2'], ['heartbeat_waiting', 'h1'], ['confirm_unstated', 'a1']],
    'the strongest first (a2 .99 over a1 .92), each example once, nothing below .8 (q1 .7), never after an automation stub (s1), no heuristic fallback (p1 praise unlabelled)')
  assert.ok(picked.every(p => p.labelledBy === 'decision_model'))
  // the in-run path: the person's real turn arrives while a run works and the beat asks about it alone
  const r = await runScenario({ kind: 'inrun_waiting', example: EXAMPLES.find(e => e.id === 'h1') }, { flowWorld, makeClient })
  assert.ok(r.target, 'the beat asked its person questions')
  const body = JSON.parse(r.target.body)
  assert.deepEqual(body.questions.map(q => q.name), ['message__person_status', 'message__person_change', 'message__person_stop'])
  assert.ok(r.target.body.includes(JSON.stringify('왜 멈췄어? 계속 진행해').slice(1, -1)))
  assert.ok(lintGroupedRequest(body).ok)
  assert.deepEqual(r.seen, { accepted: true, action: 'steer' }, 'the mock says no to all three: the safe default hands it to the run (settleInRunMessage steer)')
  // the budget keeps one per kind first
  const fake = (kind, id, bytes) => ({ kind, example: { id, area: 'egdesk', source: {}, tags: [] }, labelledBy: 'decision_model', target: { body: JSON.stringify({ questions: [], x: 'x'.repeat(bytes) }) } })
  const built = scenarioPlan([fake('triage_recall', 'a', 3000), fake('triage_recall', 'b', 3000), fake('triage_correction', 'c', 3000)], { estimate: body => Buffer.byteLength(body), budget: 6100 })
  assert.deepEqual(built.plan.requests.map(q => q.id), ['triage_recall-a', 'triage_correction-c']); assert.deepEqual(built.dropped, ['triage_recall-b'])
})
