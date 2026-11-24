// scripts/egdesk-all-on-live-measure.mjs without a network: the dry run sends nothing; --send goes through L6's guarded sender to a MOCK
// fetch (the scripted Decision answers behind the network layer); caps and the first failure stop the run; the key appears nowhere but in the
// Authorization header; and no body reaches the sender unless the product's Decision client built it on behalf of product code.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXIT } from '../helper/egdesk-decision-real-runner.mjs'
import { DECISIONS_ENDPOINT, DECISION_MODEL } from '../helper/egdesk-decision-client.mjs'
import { allOnWorld, scriptedDecisions } from './egdesk-all-on.support.mjs'
import { CHECK_NAMES, DEFAULT_CAPS, OWNERS, PLAN_FILE, PLAN_FILE_V2, PLAN_FILE_V3, PLAN_FILE_V4, PLAN_FILE_V5, PLAN_FILE_V6, PLAN_FILE_V7, PLAN_FILE_V8, SCRIPT_FILE, STEPS, createMeasureTransport, loadJourneyPlan, main, runJourney } from './egdesk-all-on-live-measure.mjs'

const KEY = 'sk-synthetic-not-a-key-l2c11-000000000001'
const CORE = STEPS.filter(s => s.since === undefined)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const tmp = t => { const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-live-measure-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }

// The provider behind the network layer: the scripted Decision answers. failAt: the n-th call answers that HTTP status; dropAt: the n-th call
// fails as a network error; usageFactor: what the provider reports against L6's estimate of the body.
// Like a real network, every answer (and every failure) arrives a few milliseconds after the request; failed records when it was delivered,
// and each call records whether it was dispatched after that.
function provider({ failAt = null, status = 429, dropAt = null, usageFactor = 1 } = {}) {
  const scripted = scriptedDecisions(), calls = [], state = { failed: false, reported: 0 }
  const fetchImpl = async (url, init) => {
    const bytes = Buffer.from(init.body), n = calls.length + 1
    calls.push({ url, method: init.method, redirect: init.redirect, credentials: init.credentials, authorization: init.headers?.authorization, sha256: sha256(bytes), text: bytes.toString('utf8'), afterFailure: state.failed, reportedBefore: state.reported })
    await new Promise(resolve => setTimeout(resolve, 3))
    if (dropAt === n) { state.failed = true; throw new TypeError('fetch failed') }
    if (failAt === n) { state.failed = true; return new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }), { status }) }
    const wire = JSON.parse(bytes.toString('utf8'))
    const est = Math.round(56.5 * wire.questions.filter(q => q.type === 'choice').length + 134.8 * wire.questions.filter(q => q.type !== 'choice').length + 0.1983 * bytes.length)
    const reported = Math.round(est * usageFactor); state.reported += reported
    return new Response(JSON.stringify({ model: wire.model, answers: await scripted.answer(wire), usage: { input_tokens: reported, output_tokens: 7 } }),
      { status: 200, headers: { 'content-type': 'application/json', 'openai-processing-ms': '3' } })
  }
  return { fetchImpl, calls }
}
const noNetwork = () => { const calls = []; return { calls, fetchImpl: async (...args) => { calls.push(args); throw new Error('the network must not be used') } } }
async function cli(argv, { env = { OPENAI_API_KEY: KEY }, fetchImpl } = {}) {
  const out = [], err = []
  const code = await main(argv, { env, fetchImpl, print: line => out.push(line), printError: line => err.push(line) })
  return { code, out, err, rows: out.map(line => JSON.parse(line)) }
}
const results = file => JSON.parse(readFileSync(file, 'utf8'))
const planWith = (t, edit) => {
  const plan = JSON.parse(readFileSync(PLAN_FILE, 'utf8')); edit(plan)
  const file = path.join(tmp(t), 'plan.json'); writeFileSync(file, JSON.stringify(plan)); return file
}

// ---- the plan is pre-registered ----
// The hash of the plan as committed before any request was sent. Changing an expectation after a real run changes this hash, visibly.
const REGISTERED_PLAN_SHA256 = 'eb1ebdb7c34df7f14412fbcc9313b253a69cc89d67cc5450b88925681fc98939'
test('plan: registered before sending (pinned hash), one entry per journey step, every expectation names a check, a severity and an owning lane', () => {
  assert.equal(sha256(readFileSync(PLAN_FILE)), REGISTERED_PLAN_SHA256)
  const plan = loadJourneyPlan()
  assert.deepEqual(plan.steps.map(s => s.id), CORE.map(s => s.id), 'v1 lists every core step (steps added later carry `since` and are not part of v1)')
  for (const step of plan.steps) {
    assert.ok(step.expect.some(e => e.severity === 'hard'), `${step.id} has a hard expectation`)
    for (const e of step.expect) { assert.ok(CHECK_NAMES.includes(e.check)); assert.ok(OWNERS.includes(e.owner)); assert.ok(['hard', 'soft'].includes(e.severity)) }
  }
  assert.throws(() => loadJourneyPlan(path.join(os.tmpdir(), 'no-such-plan.json')), /cannot read the plan file/)
})

// ---- dry run ----
test('dry run (the default): the journey runs on the scripted answers, the step table is printed, nothing leaves the process, even with a key set', async t => {
  const net = noNetwork(), out = path.join(tmp(t), 'dry.json')
  const run = await cli(['--out', out], { fetchImpl: net.fetchImpl })
  assert.equal(run.code, EXIT.ok, run.err.join('\n'))
  assert.equal(net.calls.length, 0)
  assert.equal(run.rows[0].mode, 'dry_run')
  const table = run.rows.slice(1, 1 + CORE.length)
  assert.deepEqual(table.map(row => row.step), CORE.map(s => s.id), 'the default (v1) run runs the core steps only')
  for (const row of table) { assert.equal(row.state, 'done'); assert.equal(typeof row.estInputTokens, 'number'); assert.equal(typeof row.families, 'object') }
  const total = run.rows.at(-1)
  assert.equal(total.sent, 0); assert.ok(total.requests > 0); assert.ok(total.inputTokens > 0 && total.inputTokens <= DEFAULT_CAPS.tokenCeiling, 'the default ceiling covers the dry estimate')
  const file = results(out)
  assert.equal(statSync(out).mode & 0o777, 0o600)
  assert.equal(file.mode, 'dry_run'); assert.equal(file.totals.sent, 0); assert.ok(file.steps.every(s => s.requests.every(r => r.sent === false)))
  assert.ok(!readFileSync(out, 'utf8').includes(KEY) && !run.out.join('\n').includes(KEY))
})

// ---- a run with --send, against the mock provider ----
test('--send: every request goes once to the fixed endpoint with the key in the Authorization header only; the results file records requests and what the person sees', async t => {
  const net = provider(), out = path.join(tmp(t), 'send.json')
  const run = await cli(['--send', '--out', out], { fetchImpl: net.fetchImpl })
  assert.equal(run.code, EXIT.ok, run.err.join('\n'))
  const file = results(out), raw = readFileSync(out, 'utf8')
  assert.equal(statSync(out).mode & 0o777, 0o600)
  assert.equal(file.mode, 'send'); assert.equal(file.endpoint, DECISIONS_ENDPOINT); assert.equal(file.automaticRetries, 0); assert.equal(file.stoppedBecause, null)
  const sent = file.steps.flatMap(s => s.requests.filter(r => r.sent))
  assert.equal(net.calls.length, file.totals.sent); assert.equal(sent.length, net.calls.length)
  assert.deepEqual(net.calls.map(c => c.sha256), sent.map(r => r.sha256), 'the provider received exactly the recorded bodies, in order, each once')
  for (const call of net.calls) {
    assert.equal(call.url, DECISIONS_ENDPOINT); assert.equal(call.method, 'POST'); assert.equal(call.redirect, 'error'); assert.equal(call.credentials, 'omit')
    assert.equal(call.authorization, `Bearer ${KEY}`); assert.ok(!call.text.includes(KEY), 'never in a body')
  }
  // The key is nowhere else.
  for (const text of [raw, run.out.join('\n'), run.err.join('\n')]) assert.ok(!text.includes(KEY) && !text.includes(KEY.slice(4, 24)))
  // Per request: family, caller, hash, answer, time, usage. Per step: what the person sees.
  for (const r of sent) {
    assert.ok(r.family && r.caller && /^[a-f0-9]{64}$/.test(r.sha256) && Array.isArray(r.answers) && Number.isFinite(r.elapsedMs) && Number.isFinite(r.usage.input_tokens), JSON.stringify(r).slice(0, 200))
  }
  const step = id => file.steps.find(s => s.id === id)
  assert.ok(step('s1-first-turn').seen.conversation['dm-all-on'].length >= 2)
  assert.ok(Array.isArray(step('s4-long-command').seen.flows) && Array.isArray(step('s3-briefing').seen.board.cards) && step('s8-pointer-on').seen.placement)
  assert.ok(step('s11-browser-reply').seen.browser && step('s9-status-remark').seen.writes)
  for (const s of file.steps) assert.ok(s.checks.length >= 1 && s.checks.every(c => c.owner && c.severity && typeof c.pass === 'boolean'))
  // Behind the network layer the same scripted answers drive the journey: the same families per step as the dry run.
  const dry = await runJourney({ plan: loadJourneyPlan(), fetchImpl: noNetwork().fetchImpl })
  assert.deepEqual(file.steps.map(s => s.requests.map(r => r.family)), dry.steps.map(s => s.requests.map(r => r.family)))
  assert.ok(file.totals.inputTokensReported > 0)
})

// ---- the guard: only bodies the product's Decision client built on behalf of product code reach the sender ----
test('guard: every body of the run came from the product client; a body handed to the sender directly, or to the client by a script, is refused and nothing is sent', async t => {
  const net = provider()
  const outcome = await runJourney({ plan: loadJourneyPlan(), send: true, key: KEY, fetchImpl: net.fetchImpl })
  assert.equal(outcome.ledger.refusedBodies, 0); assert.equal(outcome.ledger.stopped, null)
  const rows = outcome.steps.flatMap(s => s.requests)
  assert.ok(rows.length > 0 && rows.every(r => r.caller === 'helper/egdesk-decision-client.mjs'))
  assert.equal(net.calls.length, rows.filter(r => r.sent).length, 'no request bypassed the transport')
  // (a) A body built here and given to the sender: refused, the run stops, nothing is sent.
  const plan = loadJourneyPlan(), other = provider()
  const direct = createMeasureTransport({ send: true, key: KEY, fetchImpl: other.fetchImpl, caps: DEFAULT_CAPS, plan })
  const wire = { model: DECISION_MODEL, input: [{ role: 'user', content: 'x' }], questions: [{ name: 'q', type: 'predicate', instructions: 'x?' }] }
  await assert.rejects(direct.transport({ body: JSON.stringify(wire), wire, row: { step: 's1-first-turn' } }), error => error.code === 'hand_built_body')
  assert.equal(other.calls.length, 0); assert.match(direct.ledger.stopped.reason, /^hand_built_body:/)
  // (b) A body built by a script and given to the PRODUCT client: the client sends it to the provider, the guard sees who built it.
  const third = provider(), viaClient = createMeasureTransport({ send: true, key: KEY, fetchImpl: third.fetchImpl, caps: DEFAULT_CAPS, plan })
  const w = allOnWorld(t, { transport: viaClient.transport })
  w.step('s1-first-turn')
  await assert.rejects(w.client.decide({ input: [{ role: 'user', content: 'Is this a hand-built question?' }], questions: [{ name: 'hand_built', type: 'predicate', instructions: 'Is it?' }] }))
  assert.equal(third.calls.length, 0); assert.equal(viaClient.ledger.stopped.reason, 'hand_built_body:built_by_a_script')
})

test('guard (static): the script and its plan build no request and know no question name, so a change of request shape needs no change here', async () => {
  // v1: its whole text. v2: what the script reads (ids, checks, arguments); its 'predicted' prose quotes the c16 evidence by question name.
  const v2 = JSON.parse(readFileSync(PLAN_FILE_V2, 'utf8')), v3 = JSON.parse(readFileSync(PLAN_FILE_V3, 'utf8')), v4 = JSON.parse(readFileSync(PLAN_FILE_V4, 'utf8')), v5 = JSON.parse(readFileSync(PLAN_FILE_V5, 'utf8')), v6 = JSON.parse(readFileSync(PLAN_FILE_V6, 'utf8')), v7 = JSON.parse(readFileSync(PLAN_FILE_V7, 'utf8')), v8 = JSON.parse(readFileSync(PLAN_FILE_V8, 'utf8'))
  const source = readFileSync(SCRIPT_FILE, 'utf8'), plan = readFileSync(PLAN_FILE, 'utf8') + JSON.stringify([...v2.steps, ...v3.steps, ...v4.steps, ...v5.steps, ...v6.steps, ...v7.steps, ...v8.steps, { id: 'world', caps: null, expect: [{ id: 'env', check: null, args: v4.world }, { id: 'env5', check: null, args: v5.world }, { id: 'env6', check: null, args: v6.world }, { id: 'env7', check: null, args: v7.world }, { id: 'env8', check: null, args: v8.world }] }].map(s => ({ id: s.id, caps: s.caps, expect: s.expect.map(e => ({ id: e.id, check: e.check, args: e.args ?? null })) })))
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1]).sort()
  // c17 (L6): the shared last-send stamp wraps the fetch handed in on --send; it builds no request and knows no question.
  assert.deepEqual(imports, ['../helper/egdesk-decision-client.mjs', '../helper/egdesk-decision-real-runner.mjs', '../helper/egdesk-decision-send-stamp.mjs', '../overlay/resources/EGDeskBriefingHost.sys.mjs',
    '../overlay/resources/EGDeskWorkPlacement.sys.mjs', './egdesk-all-on.support.mjs', 'node:crypto', 'node:fs', 'node:path', 'node:url'])
  assert.match(source, /import \{ DECISIONS_ENDPOINT \} from '\.\.\/helper\/egdesk-decision-client\.mjs'/, 'only the endpoint constant, for printing')
  for (const pattern of [/api\.openai\.com/, /prompt_cache_key/, /questions:\s*\[/, /type:\s*'(?:predicate|choice|score)'/, /\.decide\(/])
    assert.ok(!pattern.test(source), `the script contains ${pattern}`)
  // The network is touched in one place: the adapter handed to L6's runPlan (it notes failures); nothing else calls it.
  assert.equal(source.split('fetchImpl(').length - 1, 1); assert.equal(source.split('runPlan({').length - 1, 1)
  assert.match(source, /runPlan\(\{ plan: one, key, send: true, fetchImpl: network,/)
  // Every question name the product asked in the dry run: none of them appears in the script or the plan.
  const dry = await runJourney({ plan: loadJourneyPlan(), fetchImpl: noNetwork().fetchImpl })
  const names = [...new Set(dry.steps.flatMap(s => s.requests.flatMap(r => r.questions)))]
  assert.ok(names.length > 20)
  const known = names.filter(name => new RegExp(`\\b${name}\\b`).test(source) || new RegExp(`\\b${name}\\b`).test(plan))
  assert.deepEqual(known, [])
})

// ---- caps ----
test('caps: the token ceiling stops the run before the request that would cross it; later steps do not run', async t => {
  const net = provider(), out = path.join(tmp(t), 'ceiling.json')
  const run = await cli(['--send', '--token-ceiling', '9000', '--out', out], { fetchImpl: net.fetchImpl })
  assert.equal(run.code, EXIT.stopped)
  const file = results(out)
  assert.equal(file.stoppedBecause, 'token_ceiling'); assert.equal(file.stoppedAt, 's2-follow-up')
  assert.equal(net.calls.length, file.totals.sent); assert.ok(file.totals.inputTokensCounted <= 9000)
  const s2 = file.steps.find(s => s.id === 's2-follow-up')
  assert.equal(s2.state, 'stopped'); assert.ok(s2.requests.some(r => r.refused === 'token_ceiling' && r.sent === false))
  assert.ok(file.steps.slice(2).every(s => s.state === 'not_run' && s.checks.every(c => c.pass === null)))
  assert.equal(file.scorecard.hard.notRun > 0, true)
})

test('caps: the provider\'s own count replaces the estimate, and a reported count over the ceiling stops the run after that answer', async () => {
  const net = provider({ usageFactor: 10 })
  const outcome = await runJourney({ plan: loadJourneyPlan(), send: true, key: KEY, fetchImpl: net.fetchImpl, caps: { tokenCeiling: 12000, maxRequests: 80 } })
  assert.equal(outcome.ledger.stopped.reason, 'token_ceiling_reached')
  assert.ok(outcome.ledger.reportedTokens > 12000)
  // Requests already on the wire are answered; none is dispatched once the provider has reported past the ceiling.
  assert.ok(net.calls.length >= 1 && net.calls.every(c => c.reportedBefore <= 12000), JSON.stringify(net.calls.map(c => c.reportedBefore)))
  assert.ok(outcome.steps.slice(1).every(s => s.state === 'not_run'))
})

test('caps: the request cap and the per-step caps of the plan stop the run', async t => {
  const capped = provider()
  const one = await runJourney({ plan: loadJourneyPlan(), send: true, key: KEY, fetchImpl: capped.fetchImpl, caps: { tokenCeiling: 80000, maxRequests: 4 } })
  assert.equal(one.ledger.stopped.reason, 'request_cap'); assert.equal(capped.calls.length, 4)
  const perStep = provider()
  const file = planWith(t, plan => { plan.steps[0].caps.maxRequests = 2 })
  const two = await runJourney({ plan: loadJourneyPlan(file), send: true, key: KEY, fetchImpl: perStep.fetchImpl })
  assert.deepEqual(two.ledger.stopped, { reason: 'step_request_cap', step: 's1-first-turn' }); assert.equal(perStep.calls.length, 2)
  const tokens = provider()
  const three = await runJourney({ plan: loadJourneyPlan(planWith(t, plan => { plan.steps[1].caps.maxEstTokens = 1000 })), send: true, key: KEY, fetchImpl: tokens.fetchImpl })
  assert.deepEqual(three.ledger.stopped, { reason: 'step_token_cap', step: 's2-follow-up' })
  assert.equal(tokens.calls.length, three.steps[0].requests.length, 'step 1 ran in full, nothing of step 2 was sent')
  // A cap that is not a positive integer is refused before anything runs.
  assert.equal((await cli(['--send', '--token-ceiling', '0'], { fetchImpl: noNetwork().fetchImpl })).code, EXIT.usage)
  assert.equal((await cli(['--max-requests', '999'], { fetchImpl: noNetwork().fetchImpl })).code, EXIT.usage)
})

// ---- stop on the first failure ----
test('stop on failure: the first non-200 answer stops the run (no retry); the product falls back for that request and nothing more is sent', async t => {
  const net = provider({ failAt: 3, status: 429 }), out = path.join(tmp(t), 'fail.json')
  const run = await cli(['--send', '--out', out], { fetchImpl: net.fetchImpl })
  assert.equal(run.code, EXIT.stopped)
  const file = results(out)
  assert.equal(file.stoppedBecause, 'http_429'); assert.equal(file.stoppedAt, 's1-first-turn')
  // The product sends some requests side by side: those already on the wire when the 429 arrives are answered and recorded; nothing is
  // dispatched after it, and nothing is retried.
  assert.ok(net.calls.length >= 3); assert.deepEqual(net.calls.filter(c => c.afterFailure), [], 'nothing dispatched after the failure arrived')
  assert.equal(new Set(net.calls.map(c => c.sha256)).size, net.calls.length, 'no body twice (no retry)')
  const s1 = file.steps[0]
  assert.equal(s1.requests.filter(r => r.sent).length, net.calls.length)
  assert.equal(s1.requests.filter(r => r.status === 429).length, 1)
  assert.ok(s1.requests.filter(r => !r.sent).length >= 1 && s1.requests.filter(r => !r.sent).every(r => /^stopped:http_429$/.test(r.refused)))
  assert.ok(file.steps.slice(1).every(s => s.state === 'not_run'))
  assert.ok(s1.seen.conversation['dm-all-on'].some(m => m.role === 'assistant'), 'the person still gets the answer of the step that was running')
  for (const text of [readFileSync(out, 'utf8'), run.out.join('\n'), run.err.join('\n')]) assert.ok(!text.includes(KEY))
})

test('stop on failure: a network error stops the run the same way', async () => {
  const net = provider({ dropAt: 2 })
  const outcome = await runJourney({ plan: loadJourneyPlan(), send: true, key: KEY, fetchImpl: net.fetchImpl })
  assert.equal(outcome.ledger.stopped.reason, 'network'); assert.ok(net.calls.length >= 2)
  assert.deepEqual(net.calls.filter(c => c.afterFailure), [], 'nothing dispatched after the failure arrived')
  assert.equal(outcome.ledger.sent, net.calls.length - 1, 'every call but the failed one was answered')
  assert.ok(outcome.steps.slice(1).every(s => s.state === 'not_run'))
})

// ---- no key, bad arguments ----
test('no key: --send without a plausible OPENAI_API_KEY sends nothing and runs nothing; unknown arguments are refused', async () => {
  for (const env of [{}, { OPENAI_API_KEY: '' }, { OPENAI_API_KEY: 'short' }, { OPENAI_API_KEY: 'sk with spaces in it 0000000000' }]) {
    const net = noNetwork(), run = await cli(['--send'], { env, fetchImpl: net.fetchImpl })
    assert.equal(run.code, EXIT.noKey); assert.equal(net.calls.length, 0); assert.equal(run.out.length, 0)
  }
  assert.equal((await cli(['--sendd'], { fetchImpl: noNetwork().fetchImpl })).code, EXIT.usage)
  assert.equal((await cli(['--out'], { fetchImpl: noNetwork().fetchImpl })).code, EXIT.usage)
})
