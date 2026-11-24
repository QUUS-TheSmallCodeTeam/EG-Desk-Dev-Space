// The collaboration scenario's live measurement (lane L1 cycle 14), with mock providers behind the network layer only: dry run sends nothing,
// send goes through lane L2's transport and lane L6's guarded sender, caps and the first failure stop the run, the key never appears in any
// output, a body the product did not build is refused, the re-run is one command with a diff. Synthetic; no real network, no Firefox.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DECISIONS_ENDPOINT, DECISION_MODEL } from '../helper/egdesk-decision-client.mjs'
import { EXIT } from '../helper/egdesk-decision-real-runner.mjs'
import { createMeasureTransport } from './egdesk-all-on-live-measure.mjs'
import { allOnWorld, DM } from './egdesk-all-on.support.mjs'
import { DRAFT_CHECK_COPY } from '../helper/egdesk-draft-check.mjs'
import { ANSWER, ANSWER_INFO, ASK, CHECK_NAMES, DEFAULT_CAPS, PLAN_FILE, PLAN_FILE_V1, PLAN_FILE_V2, SCRIPT_FILE, STEPS, STEPS_V1, loadScenarioPlan, main, runScenario, scenarioWorld, scriptedScenario } from './egdesk-multiuser-live-measure.mjs'

const KEY = 'sk-synthetic-not-a-key-l1c14-000000000001'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
// The provider behind the network layer: the scenario's pre-registered answers. failAt: the n-th call answers that HTTP status; overrides: name -> p.
function provider({ failAt = null, status = 429, overrides = {} } = {}) {
  const scripted = scriptedScenario(), calls = []
  const fetchImpl = async (url, init) => {
    const bytes = Buffer.from(init.body), n = calls.length + 1
    calls.push({ url, method: init.method, redirect: init.redirect, authorization: init.headers?.authorization, text: bytes.toString('utf8') })
    await new Promise(resolve => setTimeout(resolve, 2))
    if (failAt === n) return new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }), { status })
    const wire = JSON.parse(bytes.toString('utf8'))
    const answers = (await scripted.answer(wire)).map(a => (Object.hasOwn(overrides, a.name) ? { ...a, probability: overrides[a.name] } : a))
    return new Response(JSON.stringify({ model: wire.model, answers, usage: { input_tokens: Math.round(56.5 * wire.questions.filter(q => q.type === 'choice').length + 134.8 * wire.questions.filter(q => q.type !== 'choice').length + 0.1983 * bytes.length), output_tokens: 3 } }), { status: 200, headers: { 'content-type': 'application/json', 'openai-processing-ms': '2' } })
  }
  return { fetchImpl, calls }
}
const noNetwork = () => { const calls = []; return { calls, fetchImpl: async (...args) => { calls.push(args); throw new Error('the network must not be used') } } }
async function cli(argv, { env = { OPENAI_API_KEY: KEY }, fetchImpl } = {}) {
  const out = [], err = []
  const code = await main(argv, { env, fetchImpl, print: line => out.push(line), printError: line => err.push(line) })
  return { code, out, err }
}
const tmp = t => { const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-multiuser-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
const results = file => JSON.parse(readFileSync(file, 'utf8'))

test('plan: pre-registered before any send, the six steps of v2 (v1\'s five kept), person-level expectations with owners and whose view; caps within 20 requests / 20k tokens; malformed plans refused', t => {
  const plan = loadScenarioPlan()
  assert.deepEqual(plan.steps.map(s => s.id), STEPS.map(s => s.id)); assert.deepEqual(STEPS.map(s => s.id), ['join', 'ask', 'surface', 'result', 'followup', 'leave'])
  const v1 = loadScenarioPlan(PLAN_FILE_V1); assert.deepEqual(v1.steps.map(s => s.id), STEPS_V1.map(s => s.id)); assert.equal(v1.set, 'multiuser-collaboration-v1', 'v1 is kept as it was registered')
  assert.notEqual(v1.sha256, plan.sha256)
  assert.match(plan.registered, /before any send/)
  const all = plan.steps.flatMap(s => s.expect)
  assert.deepEqual([...new Set(all.map(e => e.who))].sort(), ['A', 'B', 'ledger', 'system'], 'what A sees, what B sees, what the shared ledger holds')
  assert.ok(all.every(e => /^L[1-8]$/.test(e.owner) && CHECK_NAMES.includes(e.check)))
  assert.ok(plan.steps.reduce((n, s) => n + s.caps.maxRequests, 0) <= 20 && plan.steps.reduce((n, s) => n + s.caps.maxEstTokens, 0) <= 20_000)
  assert.deepEqual(DEFAULT_CAPS, { tokenCeiling: 20_000, maxRequests: 20 })
  const dir = tmp(t), raw = JSON.parse(readFileSync(PLAN_FILE, 'utf8'))
  const refused = edit => { const copy = structuredClone(raw); edit(copy); const f = path.join(dir, `p${Math.random()}.json`); writeFileSync(f, JSON.stringify(copy)); assert.throws(() => loadScenarioPlan(f), e => e.name === 'PlanError') }
  refused(p => { p.steps[1].caps.maxRequests = 30 }); refused(p => { p.steps[0].expect[0].check = 'nope' }); refused(p => { p.steps[0].expect[0].owner = 'L9' })
  refused(p => { p.steps.splice(4, 1, p.steps[5]) }) // a step order that is neither v1 nor v2
  refused(p => { p.steps[0].expect[0].who = 'C' }); refused(p => { p.steps.pop() }); refused(p => { delete p.registered })
})

test('dry run: sends nothing; the whole scenario runs through product code; every pre-registered expectation holds with the pre-registered answers', async t => {
  const net = noNetwork(), dir = tmp(t), out = path.join(dir, 'dry.json')
  const run = await cli(['--out', out], { env: {}, fetchImpl: net.fetchImpl })
  assert.equal(run.code, EXIT.ok); assert.equal(net.calls.length, 0, 'the network was never used')
  const r = results(out)
  assert.equal(r.mode, 'dry_run'); assert.equal(r.totals.sent, 0); assert.equal(r.endpoint, DECISIONS_ENDPOINT); assert.equal(statSync(out).mode & 0o777, 0o600)
  assert.deepEqual(r.scorecard.hard.failed, []); assert.deepEqual(r.scorecard.soft.missed, []); assert.ok(r.scorecard.hard.passed >= 25)
  assert.deepEqual(r.steps.map(s => [s.id, s.state]), STEPS.map(s => [s.id, 'done']))
  // per step: every request's family, sha256, answer, elapsed time and usage; what each person saw
  for (const s of r.steps) {
    for (const q of s.requests) { assert.equal(q.caller, 'helper/egdesk-decision-client.mjs', 'every body came from the product client'); assert.match(q.sha256, /^[0-9a-f]{64}$/); assert.ok(Array.isArray(q.answers) && Number.isFinite(q.elapsedMs) && q.usage) }
    assert.ok(s.seen.A && s.seen.B && s.seen.ledger && Array.isArray(s.seen.newMessages))
  }
  const fam = id => r.steps.find(s => s.id === id).requests.map(q => q.family)
  assert.deepEqual([fam('join'), fam('surface'), fam('leave')], [[], ['work_placement'], []])
  assert.ok(fam('result').includes('work_placement'))
  const surface = r.steps.find(s => s.id === 'surface').seen.A.surface
  assert.deepEqual([surface.rule, surface.quiet, surface.inAView, surface.inBView, surface.nearB], ['requester_working', true, false, false, true])
  assert.deepEqual(r.steps.find(s => s.id === 'result').seen.newMessages.map(m => [m.by, m.text === ANSWER || m.by !== 'agent']), [['agent', true], ['system_flow', true]], 'A sees the decision answer as written, then one pointer')
  assert.deepEqual(r.steps.find(s => s.id === 'followup').seen.newMessages.map(m => m.by), ['person', 'agent'], 'the follow-up: A sees the answer and no pointer')
  assert.equal(r.steps.find(s => s.id === 'followup').seen.newMessages[1].text, ANSWER_INFO)
  assert.deepEqual([surface.waited, surface.besideRelated, surface.movedAfterOpen], [true, true, false], 'a timely same-matter answer: opened beside the related card, never moved')
  // request bodies stay out of the results (sha256 and size only); what A saw is in it
  const text = readFileSync(out, 'utf8')
  assert.ok(!text.includes('Is the work for the quoted request') && !text.includes('"bodies"'), 'no request body is written')
  assert.ok(r.steps.find(s => s.id === 'ask').seen.newMessages.some(m => m.by === 'person' && m.text === ASK), 'A saw the request A sent')
})

test('send (mock provider): one request at a time through L6\'s guarded sender; the key only in the Authorization header, never in any output; results carry answers and usage', async t => {
  const net = provider(), dir = tmp(t), out = path.join(dir, 'sent.json')
  const run = await cli(['--send', '--out', out], { fetchImpl: net.fetchImpl })
  assert.equal(run.code, EXIT.ok)
  const r = results(out), rows = r.steps.flatMap(s => s.requests)
  assert.equal(r.mode, 'send'); assert.equal(net.calls.length, rows.length); assert.equal(r.totals.sent, rows.length); assert.ok(rows.every(q => q.sent && q.status === 200))
  for (const call of net.calls) { assert.equal(call.url, DECISIONS_ENDPOINT); assert.equal(call.method, 'POST'); assert.equal(call.redirect, 'error'); assert.equal(call.authorization, `Bearer ${KEY}`); assert.ok(!call.text.includes(KEY)) }
  for (const text of [readFileSync(out, 'utf8'), run.out.join('\n'), run.err.join('\n')]) assert.ok(!text.includes(KEY) && !text.includes(KEY.slice(4, 24)), 'the key is in no output')
  assert.ok(r.totals.inputTokensReported > 0); assert.deepEqual(r.scorecard.hard.failed, [])
  // no key: nothing is sent
  const none = await cli(['--send'], { env: {}, fetchImpl: net.fetchImpl }); assert.equal(none.code, EXIT.noKey); assert.equal(net.calls.length, rows.length)
})

test('caps: the request cap and the token ceiling stop the run before the request that would cross them; later steps are not run', async t => {
  const capped = provider()
  const one = await runScenario({ plan: loadScenarioPlan(), send: true, key: KEY, fetchImpl: capped.fetchImpl, caps: { tokenCeiling: 20_000, maxRequests: 2 } })
  assert.equal(one.ledger.stopped.reason, 'request_cap'); assert.equal(capped.calls.length, 2, 'the third request was not sent')
  assert.deepEqual(one.steps.map(s => s.state), ['done', 'done', 'done', 'stopped', 'not_run', 'not_run'])
  const tight = provider()
  const two = await runScenario({ plan: loadScenarioPlan(), send: true, key: KEY, fetchImpl: tight.fetchImpl, caps: { tokenCeiling: 2_600, maxRequests: 20 } })
  assert.equal(two.ledger.stopped.reason, 'token_ceiling'); assert.equal(tight.calls.length, 1)
  assert.ok(two.steps.filter(s => s.state === 'not_run').length >= 2)
  // a step's own cap (from the plan) also stops it
  const dir = tmp(t), raw = JSON.parse(readFileSync(PLAN_FILE, 'utf8')); raw.steps[3].caps.maxRequests = 1; const f = path.join(dir, 'p.json'); writeFileSync(f, JSON.stringify(raw))
  const step = await runScenario({ plan: loadScenarioPlan(f), fetchImpl: noNetwork().fetchImpl })
  assert.equal(step.ledger.stopped.reason, 'step_request_cap'); assert.equal(step.ledger.stopped.step, 'result')
  // the command line refuses caps above the scenario's own
  for (const argv of [['--max-requests', '21'], ['--token-ceiling', '20001'], ['--bogus']]) assert.equal((await cli(argv, { fetchImpl: noNetwork().fetchImpl })).code, EXIT.usage, argv.join(' '))
})

test('stop on failure: the first non-200 answer stops the run; nothing more is sent and later steps are not run', async () => {
  const net = provider({ failAt: 2 })
  const outcome = await runScenario({ plan: loadScenarioPlan(), send: true, key: KEY, fetchImpl: net.fetchImpl })
  assert.equal(outcome.ledger.stopped.reason, 'http_429'); assert.equal(net.calls.length, 2)
  assert.deepEqual(outcome.steps.map(s => s.state), ['done', 'done', 'stopped', 'not_run', 'not_run', 'not_run'])
  assert.ok(outcome.steps.slice(3).every(s => s.checks.every(c => c.pass === null)), 'the expectations of steps not run are not judged')
})

test('body check: a body the product did not build is refused and stops the run (lane L2\'s guard, imported); every request of the scenario passes it', async t => {
  const plan = loadScenarioPlan(), other = provider()
  const direct = createMeasureTransport({ send: true, key: KEY, fetchImpl: other.fetchImpl, caps: DEFAULT_CAPS, plan })
  const wire = { model: DECISION_MODEL, input: [{ role: 'user', content: 'x' }], questions: [{ name: 'same_matter_R1', type: 'predicate', instructions: 'Same?' }] }
  await assert.rejects(direct.transport({ body: JSON.stringify(wire), wire, row: { step: 'surface' } }), error => error.code === 'hand_built_body')
  assert.equal(other.calls.length, 0); assert.match(direct.ledger.stopped.reason, /^hand_built_body:/)
  // a script that hands its own question to the PRODUCT client is caught too
  const third = provider(), viaClient = createMeasureTransport({ send: true, key: KEY, fetchImpl: third.fetchImpl, caps: DEFAULT_CAPS, plan })
  const s = scenarioWorld(t, { transport: viaClient.transport }); s.w.step('surface')
  await assert.rejects(s.w.client.decide({ input: [{ role: 'user', content: 'Is this hand built?' }], questions: [{ name: 'hand_built', type: 'predicate', instructions: 'Is it?' }] }))
  assert.equal(third.calls.length, 0); assert.equal(viaClient.ledger.stopped.reason, 'hand_built_body:built_by_a_script')
  // static: the runner builds no request and calls no client itself
  const source = readFileSync(SCRIPT_FILE, 'utf8')
  for (const pattern of [/\.decide\(/, /questions:\s*\[/, /prompt_cache_key/, /api\.openai\.com/, /fetch\(/]) assert.ok(!pattern.test(source), `the runner contains ${pattern}`)
  assert.match(source, /import \{ createMeasureTransport, diffJourneys, formatDiff, replayAnswers, writeJourneyResults \} from '\.\/egdesk-all-on-live-measure\.mjs'/, 'lane L2\'s transport, imported')
})

test('re-run: one command (--rerun earlier.json) replays the recorded answers and prints the diff; a changed answer shows as a changed outcome for the person', async t => {
  const dir = tmp(t), first = path.join(dir, 'first.json')
  assert.equal((await cli(['--out', first], { env: {}, fetchImpl: noNetwork().fetchImpl })).code, EXIT.ok)
  const same = await cli(['--rerun', first], { env: {}, fetchImpl: noNetwork().fetchImpl })
  assert.ok(same.out.some(line => /no change/.test(line)) && !same.out.some(line => /expectation/.test(line)))
  // the recorded owner answer as if the model had said "no": the replay follows it, and the diff names the answer and A's missing pointer
  const edited = results(first), result = edited.steps.find(s => s.id === 'result')
  result.requests.find(q => q.family === 'work_placement').answers = [{ name: 'owner_action', type: 'predicate', probability: 0.04 }]
  const changed = path.join(dir, 'changed.json'); writeFileSync(changed, JSON.stringify(edited))
  const run = await cli(['--rerun', changed, '--out', path.join(dir, 'rerun.json')], { env: {}, fetchImpl: noNetwork().fetchImpl })
  const text = run.out.join('\n')
  assert.match(text, /replay: the answers recorded in changed\.json/)
  assert.match(text, /== result/); assert.match(text, /expectation\s+R4 \(hard, L3\): fail -> pass|expectation\s+R4 \(hard, L3\): pass -> fail/)
  const again = results(path.join(dir, 'rerun.json'))
  assert.equal(again.mode, 'replay'); assert.ok(again.diff.steps.find(s => s.step === 'result').changes.some(c => c.kind === 'expectation' && c.id === 'R4'))
})

test('product path fixes found by this scenario: a run\'s file viewer finds its session heartbeat by the native conversation id; the run\'s request text is kept with the draft check off', async t => {
  const w = allOnWorld(t, { env: { EGDESK_DRAFT_CHECK: 'off', EGDESK_BROWSER_ENTRY: 'off', EGDESK_BRIEFING_FLOW: 'off' } })
  const out = await w.send(ASK)
  assert.ok(w.chat.heartbeatFor(DM) && w.chat.heartbeatFor(out.conversationId) === w.chat.heartbeatFor(DM), 'the viewer\'s { runId, conversationId } reach the same heartbeat')
  assert.equal(w.chat.placementContextFor(out.conversationId).request, ASK, 'the request is there for the content questions, by either key')
  assert.equal(w.chat.placementContextFor(DM).request, ASK)
  assert.equal(w.chat.heartbeatFor('nobody'), null, 'an unknown key answers as before')
})

test('the bounded wait: a same-matter answer later than 1.5 s on the scenario clock -> the viewer opens at the rule\'s spot; the late answer is recorded only; nothing moves', async () => {
  // the provider answers the same-matter request slowly (real time), so the window's wait (1.5 s on the scenario clock, a few real ms) runs out first
  const fast = provider(), calls = []
  const fetchImpl = async (url, init) => { const names = JSON.parse(Buffer.from(init.body).toString('utf8')).questions.map(q => q.name); calls.push(names.join(','))
    if (names[0] === 'same_matter_R1') await new Promise(resolve => setTimeout(resolve, 1700)); return fast.fetchImpl(url, init) }
  const outcome = await runScenario({ plan: loadScenarioPlan(), send: true, key: KEY, fetchImpl })
  const surface = outcome.steps.find(s => s.id === 'surface')
  const spot = surface.seen.A.surface
  // waited: the bounded path gave the placement (after its deadline: the rule's spot); besideRelated: it did NOT open beside the related card
  assert.deepEqual([spot.waited, spot.besideRelated, spot.movedAfterOpen, spot.quiet, spot.inAView, spot.nearB], [true, false, false, true, false, true], 'opened at the rule\'s spot beside B\'s view, quietly; not moved')
  assert.deepEqual(surface.checks.filter(c => c.pass !== true).map(c => c.id), ['P10'], 'only the soft "opened beside the related card" misses')
  // the late answer: decided beside the related card, recorded by the bridge, and nothing in the window acted on it
  assert.deepEqual(surface.seen.placementRecords.map(r => [r.kind, r.would.kind, r.source]), [['placement', 'beside_related', 'decision']])
  assert.equal(surface.seen.A.cameraCalls, 0); assert.deepEqual(surface.seen.A.cardsMoved, [])
  assert.ok(calls.includes('same_matter_R1,same_matter_R2'))
})
test('v1 stays runnable as registered (five steps): the same product path, judged by v1\'s expectations', async () => {
  const outcome = await runScenario({ plan: loadScenarioPlan(PLAN_FILE_V1), fetchImpl: noNetwork().fetchImpl })
  assert.deepEqual(outcome.steps.map(s => [s.id, s.state]), STEPS_V1.map(s => [s.id, 'done']))
  assert.deepEqual(outcome.scorecard.hard.failed, [], 'with the faithful revision and the decision answer, v1\'s hard expectations hold too')
})

test('the v1 send, reproduced (c20): a first request slower than the turn\'s 800 ms Decision-context budget -> the draft check works without evidence (it trims); the owner question quotes what A saw, and A still gets the pointer', async () => {
  const fast = provider(), slowFirst = async (url, init) => { const names = JSON.parse(Buffer.from(init.body).toString('utf8')).questions.map(q => q.name)
    if (names.includes('answer_type')) await new Promise(resolve => setTimeout(resolve, 950)); return fast.fetchImpl(url, init) }
  const outcome = await runScenario({ plan: loadScenarioPlan(), send: true, key: KEY, fetchImpl: slowFirst })
  const ask = outcome.steps.find(s => s.id === 'ask'), result = outcome.steps.find(s => s.id === 'result')
  assert.equal(ask.checks.find(c => c.id === 'K5').pass, false, 'the soft budget check names what decided v1: the turn context came back after 800 ms')
  assert.ok(ask.checks.find(c => c.id === 'K5').observed.elapsedMs[0] > 800)
  assert.ok(!result.requests.some(q => q.family === 'draft_check'), 'as in v1\'s send: no draft-check request, the check had no evidence')
  assert.deepEqual(result.seen.newMessages.map(m => m.by), ['agent', 'system_flow'])
  // the draft check without evidence trims what it cannot support (the price comparison) and adds its own caveat; the request for the owner's decision stays
  const posted = result.seen.newMessages[0].text
  assert.notEqual(posted, ANSWER); assert.ok(posted.includes('소유자께서 승인해 주셔야') && !posted.includes('12,000원에서 11,000원'), posted)
  assert.equal(result.checks.find(c => c.id === 'R0').pass, false, 'the soft check reports that A did not see the answer as written')
  assert.deepEqual(result.checks.filter(c => c.severity === 'hard' && c.pass !== true).map(c => c.id), [], 'R1 (v3: the answering model\'s own sentences of what A saw are quoted, no check copy), R3 and R4 hold')
})

test('the v2 send, reproduced (c21): both answers carry the draft check\'s appended caveat; the owner question quotes only the answering model\'s own sentences, so "nothing to do" stays the requester\'s branch and A gets no pointer for it', async () => {
  const fast = provider(), slowFirst = async (url, init) => { const names = JSON.parse(Buffer.from(init.body).toString('utf8')).questions.map(q => q.name)
    if (names.includes('answer_type')) await new Promise(resolve => setTimeout(resolve, 950)); return fast.fetchImpl(url, init) }
  const calls = []; const spy = async (url, init) => { calls.push(Buffer.from(init.body).toString('utf8')); return slowFirst(url, init) }
  const outcome = await runScenario({ plan: loadScenarioPlan(), send: true, key: KEY, fetchImpl: spy })
  const follow = outcome.steps.find(s => s.id === 'followup'), result = outcome.steps.find(s => s.id === 'result')
  // what A saw: the answers with the check's caveat (as in the v2 send)
  for (const step of [result, follow]) assert.ok(step.seen.newMessages.find(m => m.by === 'agent').text.includes(DRAFT_CHECK_COPY.partial), step.id)
  // what the owner question read: the model's own sentences, never the caveat
  const owner = calls.filter(text => JSON.parse(text).questions.some(q => q.name === 'owner_action'))
  assert.equal(owner.length, 2); for (const text of owner) assert.ok(!text.includes('자료를 알려 주세요') && !text.includes('확인되지 않은 부분'), 'no draft-check copy in the owner question')
  assert.ok(owner[1].includes('따로 확인하실 일은 없습니다'), 'the follow-up\'s own sentence is quoted')
  assert.deepEqual(follow.checks.filter(c => c.severity === 'hard' && c.pass !== true).map(c => c.id), [], 'F1 and F3 hold: the requester\'s branch, no pointer to A')
  assert.equal(follow.checks.find(c => c.id === 'F2').pass, true, 'the owner question says no')
  assert.deepEqual(result.checks.filter(c => c.severity === 'hard' && c.pass !== true).map(c => c.id), [], 'the decision result still points A to it')
  // v2 as registered would fail its F1 here (it asked for the whole posted answer, caveat included): kept as it was, not rewritten
  const v2 = await runScenario({ plan: loadScenarioPlan(PLAN_FILE_V2), send: true, key: KEY, fetchImpl: slowFirst })
  assert.equal(v2.steps.find(s => s.id === 'followup').checks.find(c => c.id === 'F1').pass, false)
})
