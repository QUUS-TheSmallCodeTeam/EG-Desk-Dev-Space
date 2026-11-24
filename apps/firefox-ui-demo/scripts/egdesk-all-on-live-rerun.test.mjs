// The re-run of the all-on live journey (cycle 12): plan v2, replay of recorded answers, the step-by-step diff, --rerun. No network: the
// "earlier real run" of these tests is a --send run against a mock provider (the scripted Decision answers behind the network layer).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EXIT } from '../helper/egdesk-decision-real-runner.mjs'
import { scriptedDecisions } from './egdesk-all-on.support.mjs'
import { CHECK_FUNCTIONS, DEFAULT_CAPS, LATEST_PLAN_FILE, PLAN_FILE, PLAN_FILE_V2, PLAN_FILE_V3, PLAN_FILE_V4, PLAN_FILE_V5, PLAN_FILE_V6, PLAN_FILE_V7, PLAN_FILE_V8, STEPS, diffJourneys, faithfulRevision, formatDiff, loadJourneyPlan, main, packetPages, runJourney } from './egdesk-all-on-live-measure.mjs'

const KEY = 'sk-synthetic-not-a-key-l2c12-000000000002'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const tmp = t => { const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-live-rerun-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir }
// The mock provider; tweak(answer) may change an answer (a different model, or the same model on another day).
function provider(tweak = a => a) {
  const scripted = scriptedDecisions(), calls = []
  const fetchImpl = async (url, init) => {
    const bytes = Buffer.from(init.body)
    calls.push({ url, authorization: init.headers?.authorization, text: bytes.toString('utf8') })
    await new Promise(resolve => setTimeout(resolve, 2))
    const wire = JSON.parse(bytes.toString('utf8'))
    const answers = (await scripted.answer(wire)).map(tweak)
    return new Response(JSON.stringify({ model: wire.model, answers, usage: { input_tokens: 100, output_tokens: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { fetchImpl, calls }
}
const noNetwork = () => { const calls = []; return { calls, fetchImpl: async (...args) => { calls.push(args); throw new Error('the network must not be used') } } }
async function cli(argv, { env = { OPENAI_API_KEY: KEY }, fetchImpl } = {}) {
  const out = [], err = []
  const code = await main(argv, { env, fetchImpl, print: line => out.push(line), printError: line => err.push(line) })
  return { code, out, err }
}
// One earlier "real" run (v1 plan), shared by the tests below.
let earlier = null
async function earlierRun(t) {
  if (earlier) return earlier
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-live-rerun-earlier-')), file = path.join(dir, 'earlier.json')
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  const run = await cli(['--send', '--out', file], { fetchImpl: provider().fetchImpl })
  assert.equal(run.code, EXIT.ok, run.err.join('\n'))
  earlier = { file, results: JSON.parse(readFileSync(file, 'utf8')) }
  return earlier
}

// ---- plan v2 ----
const REGISTERED_PLAN_V2_SHA256 = '131c8dc8aaf0f7fa21d214bb3918b9820f86724a769fb93e14ae3770e01f3dfd'
test('plan v2: pinned, based on v1 by hash, keeps every v1 expectation verbatim, and every new one names its owner and its predicted outcome', () => {
  const bytes = readFileSync(PLAN_FILE_V2), raw = JSON.parse(bytes.toString('utf8')), v1 = JSON.parse(readFileSync(PLAN_FILE, 'utf8'))
  assert.equal(sha256(bytes), REGISTERED_PLAN_V2_SHA256)
  assert.equal(raw.version, 2); assert.equal(raw.basedOn.sha256, sha256(readFileSync(PLAN_FILE)))
  assert.deepEqual(raw.steps.map(s => s.id), v1.steps.map(s => s.id))
  for (const [i, step] of v1.steps.entries()) {
    assert.deepEqual(raw.steps[i].caps, step.caps)
    assert.deepEqual(raw.steps[i].expect.slice(0, step.expect.length), step.expect, `${step.id}: v1 expectations kept as they were`)
    for (const added of raw.steps[i].expect.slice(step.expect.length)) assert.ok(added.owner && added.severity && typeof added.predicted === 'string' && added.predicted.length > 20, added.id)
  }
  const plan = loadJourneyPlan(PLAN_FILE_V2)
  assert.equal(plan.steps.reduce((n, s) => n + s.expect.length, 0) - v1.steps.reduce((n, s) => n + s.expect.length, 0), 7)
})

// ---- --rerun without --send: a replay of the earlier answers on today's code ----
test('--rerun <earlier> (no --send): replays the recorded answers, sends nothing, judges plan v2 and prints the step-by-step diff', async t => {
  const { file, results } = await earlierRun(t), net = noNetwork(), out = path.join(tmp(t), 'rerun.json')
  const run = await cli(['--rerun', file, '--plan', PLAN_FILE_V2, '--out', out], { fetchImpl: net.fetchImpl })
  assert.equal(run.code, EXIT.ok, run.err.join('\n'))
  assert.equal(net.calls.length, 0)
  const now = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(now.mode, 'replay'); assert.equal(now.totals.sent, 0); assert.equal(now.totals.replayUnmatched, 0, 'the same code asks the same requests')
  assert.equal(now.plan.sha256, REGISTERED_PLAN_V2_SHA256); assert.equal(now.replayOf.sha256, sha256(readFileSync(file))); assert.equal(now.diffAgainst.file, path.basename(file))
  assert.ok(now.steps.every(s => s.requests.every(r => r.replay === 'recorded')))
  // Same answers, same code: no request or answer changes; what changes is that v2 judges more.
  for (const step of now.diff.steps) {
    assert.deepEqual(step.changes.filter(c => c.kind === 'requests' || c.kind === 'answer'), [], step.step)
    assert.ok(step.changes.filter(c => c.kind === 'expectation').every(c => c.prev === 'new'), step.step)
  }
  assert.equal(now.diff.steps.flatMap(s => s.changes.filter(c => c.kind === 'expectation')).length, 7)
  const text = run.out.join('\n')
  assert.match(text, /^journey diff: /m); assert.match(text, /^== s1-first-turn /m); assert.match(text, /expectation {2}s9\.claim-backed \(hard, L7\): new -> /)
  assert.equal(results.mode, 'send')
})

// ---- --rerun --send: a real re-run (mock provider) whose answers differ ----
test('--rerun <earlier> --send: sends through the guarded path and the diff shows changed answers, what the person saw, and expectations that flipped', async t => {
  const { file } = await earlierRun(t), out = path.join(tmp(t), 'rerun-send.json')
  // Another day: the draft check now calls every sentence a present-tense restatement.
  // L3 c18: the draft check asks per-sentence predicates by default; its tense question is tense_N (was present_N).
  const net = provider(a => (/^(present|tense)_\d+$/.test(a.name) ? { ...a, probability: 0.97 } : a))
  const run = await cli(['--rerun', file, '--plan', PLAN_FILE_V2, '--send', '--out', out], { fetchImpl: net.fetchImpl })
  const now = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(now.mode, 'send'); assert.equal(net.calls.length, now.totals.sent); assert.ok(net.calls.every(c => c.authorization === `Bearer ${KEY}`))
  assert.ok(!('replayOf' in now))
  const s1 = now.diff.steps.find(s => s.step === 's1-first-turn')
  assert.ok(s1.changes.some(c => c.kind === 'answer' && c.family === 'draft_check' && c.name === 'tense_0' && c.prev === '0.03' && c.cur === '0.97'), JSON.stringify(s1.changes).slice(0, 400))
  assert.ok(s1.changes.some(c => c.kind === 'saw'))
  assert.ok(s1.changes.some(c => c.kind === 'expectation' && c.id === 's1.answer' && c.prev === true && c.cur === false))
  assert.ok(s1.changes.some(c => c.kind === 'expectation' && c.id === 's1.own-words' && c.prev === 'new'))
  for (const text of [readFileSync(out, 'utf8'), run.out.join('\n'), run.err.join('\n')]) assert.ok(!text.includes(KEY))
  assert.match(run.out.join('\n'), /answer {7}draft_check#1 tense_0: 0\.03 -> 0\.97/)
})

test('replay: a request the earlier run did not make is answered by the script and counted; options that cannot go together are refused', async t => {
  const { results } = await earlierRun(t), dir = tmp(t)
  const trimmed = structuredClone(results)
  const s5 = trimmed.steps.find(s => s.id === 's5-silence'); s5.requests = []
  const file = path.join(dir, 'trimmed.json'); writeFileSync(file, JSON.stringify(trimmed))
  const net = noNetwork(), out = path.join(dir, 'replay.json')
  const run = await cli(['--replay', file, '--out', out], { fetchImpl: net.fetchImpl })
  assert.equal(run.code, EXIT.ok, run.err.join('\n')); assert.equal(net.calls.length, 0)
  const now = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(now.totals.replayUnmatched, results.steps.find(s => s.id === 's5-silence').requests.length)
  assert.ok(now.steps.find(s => s.id === 's5-silence').requests.every(r => r.replay === 'unmatched'))
  assert.ok(!now.diff, 'no diff unless asked')
  // A recorded answer whose body differs now (other evidence, other wording) is used but marked; the diff names both kinds of step and
  // does not compare a scripted answer with a real one.
  const changed = structuredClone(results)
  const s1 = changed.steps.find(s => s.id === 's1-first-turn'); s1.requests[0].sha256 = '0'.repeat(64)
  const changedFile = path.join(dir, 'changed.json'); writeFileSync(changedFile, JSON.stringify(changed))
  writeFileSync(file, JSON.stringify(trimmed))
  const both = path.join(dir, 'both.json')
  const marked = await cli(['--replay', changedFile, '--diff', file, '--out', both], { fetchImpl: noNetwork().fetchImpl })
  const after = JSON.parse(readFileSync(both, 'utf8'))
  assert.equal(after.totals.replayChangedBody, 1); assert.equal(after.steps[0].requests[0].replay, 'recorded_changed_body')
  const diffS1 = after.diff.steps.find(s => s.step === 's1-first-turn'), diffS5 = after.diff.steps.find(s => s.step === 's5-silence')
  assert.deepEqual(diffS1.changes.find(c => c.kind === 'replay'), { kind: 'replay', scripted: [], changedBody: [results.steps[0].requests[0].family] })
  assert.ok(!diffS5.changes.some(c => c.kind === 'answer') && !diffS5.changes.some(c => c.kind === 'replay'), 's5 had no recorded answers in either file: nothing to compare')
  assert.match(marked.out.join('\n'), /^replay: steps with scripted answers or answers reused for a changed body .*s1-first-turn/m)
  assert.match(marked.out.join('\n'), /replay {7}recorded answer reused for a changed body: /)
  assert.equal((await cli(['--replay', file, '--send'], { fetchImpl: noNetwork().fetchImpl })).code, EXIT.usage)
  assert.equal((await cli(['--rerun', path.join(dir, 'missing.json')], { fetchImpl: noNetwork().fetchImpl })).code, EXIT.usage)
  writeFileSync(path.join(dir, 'not-results.json'), '{"hello":1}')
  assert.equal((await cli(['--diff', path.join(dir, 'not-results.json')], { fetchImpl: noNetwork().fetchImpl })).code, EXIT.usage)
})

// ---- the diff itself ----
test('diffJourneys: requests per family, answers by threshold, what the person saw (authorship tags aside), board, browser, writes and expectation flips', () => {
  const step = (over = {}) => ({ id: 's1-first-turn', state: 'done', requests: [], checks: [], seen: { newMessages: [], flows: [], board: { observe: null, cards: [], parts: [] }, browser: { note: null, acts: [] }, writes: { pages: [], readings: [] } }, ...over })
  const req = (family, answers) => ({ family, answers })
  const prev = { at: 'a', mode: 'send', plan: { sha256: 'p1' }, scorecard: { hard: { passed: 1, failed: ['x'], notRun: 0 }, soft: { passed: 0, missed: [], notRun: 0 } },
    steps: [step({ requests: [req('draft_check', [{ name: 'present_0', type: 'predicate', probability: 0.30 }, { name: 'claim_0', type: 'choice', choice: 'supported', confidence: 0.9 }, { name: 'q', type: 'predicate', probability: 0.5 }])],
      checks: [{ id: 'x', pass: false }, { id: 'y', pass: true }], seen: { ...step().seen, newMessages: [{ by: 'agent', text: 'A' }], writes: { pages: [], readings: [] } } })] }
  const cur = { at: 'b', mode: 'replay', plan: { sha256: 'p2' }, scorecard: { hard: { passed: 2, failed: [], notRun: 0 }, soft: { passed: 1, missed: [], notRun: 0 } },
    steps: [step({ requests: [req('draft_check', [{ name: 'present_0', type: 'predicate', probability: 0.33 }, { name: 'claim_0', type: 'choice', choice: 'insufficient', confidence: 0.7 }, { name: 'q', type: 'predicate', probability: 0.9 }]), req('memory_fetch', [])],
      checks: [{ id: 'x', pass: true, severity: 'hard', owner: 'L7' }, { id: 'y', pass: true }, { id: 'z', pass: false, severity: 'hard', owner: 'L8' }],
      seen: { ...step().seen, newMessages: [{ by: 'agent', authored: 'own', text: 'A' }], writes: { pages: [], readings: [{}] } } })] }
  const diff = diffJourneys(prev, cur), changes = diff.steps[0].changes
  assert.deepEqual(changes.filter(c => c.kind === 'requests'), [{ kind: 'requests', family: 'memory_fetch', prev: 0, cur: 1 }])
  assert.deepEqual(changes.filter(c => c.kind === 'answer').map(c => [c.name, c.prev, c.cur]), [['claim_0', 'supported@0.9', 'insufficient@0.7'], ['q', '0.5', '0.9']], 'a 0.03 move is not a change')
  assert.ok(!changes.some(c => c.kind === 'saw'), 'the same text with an authorship tag is the same message')
  assert.deepEqual(changes.filter(c => c.kind === 'writes').map(c => [c.prev, c.cur]), [['pages=0 readings=0', 'pages=0 readings=1']])
  assert.deepEqual(changes.filter(c => c.kind === 'expectation').map(c => [c.id, c.prev, c.cur]), [['x', false, true], ['z', 'new', false]])
  assert.deepEqual(diff.scorecard, { prev: { hard: '1/2', soft: '0/0' }, cur: { hard: '2/2', soft: '1/1' } })
  const lines = formatDiff(diff)
  assert.equal(lines[0], 'journey diff: a (send, plan p1) -> b (replay, plan p2)')
  assert.ok(lines.includes('  expectation  z (hard, L8): new -> fail') && lines.includes('  expectation  x (hard, L7): fail -> pass'))
})

// ---- plan v3 (cycle 13) ----
const REGISTERED_PLAN_V3_SHA256 = '2c1c5d8b4f03ba23fd16f17c84ff9e1164b1dde09c3f4c8469e6b1bb4dbc3988'
test('plan v3: pinned, based on v2 by hash, keeps every v2 expectation verbatim, adds the recall step after s3, and every new expectation has an owner and a prediction', () => {
  const bytes = readFileSync(PLAN_FILE_V3), raw = JSON.parse(bytes.toString('utf8')), v2 = JSON.parse(readFileSync(PLAN_FILE_V2, 'utf8'))
  assert.equal(sha256(bytes), REGISTERED_PLAN_V3_SHA256)
  assert.equal(raw.version, 3); assert.equal(raw.basedOn.sha256, sha256(readFileSync(PLAN_FILE_V2)))
  assert.deepEqual(raw.steps.map(s => s.id), [...v2.steps.slice(0, 3).map(s => s.id), 's3b-recall', ...v2.steps.slice(3).map(s => s.id)])
  for (const step of v2.steps) {
    const now = raw.steps.find(s => s.id === step.id)
    assert.deepEqual(now.caps, step.caps); assert.deepEqual(now.expect.slice(0, step.expect.length), step.expect, `${step.id}: v2 expectations kept as they were`)
    for (const added of now.expect.slice(step.expect.length)) assert.ok(added.owner && added.severity && typeof added.predicted === 'string' && added.predicted.length > 10, added.id)
  }
  const recall = raw.steps.find(s => s.id === 's3b-recall')
  assert.ok(recall.expect.some(e => e.severity === 'hard' && e.check === 'packet' && e.args.include.includes('ontology:db/pg-design')), 'the needed page must be fetched (hard)')
  assert.ok(recall.expect.filter(e => e.check === 'calibrationValue').every(e => e.severity === 'soft'), 'the triage values are measured as soft')
  assert.equal(STEPS.find(s => s.id === 's3b-recall').since, 3)
  // The three plans still load; v1 and v2 do not judge (and so do not run) the recall step.
  for (const file of [PLAN_FILE, PLAN_FILE_V2]) assert.ok(!loadJourneyPlan(file).steps.some(s => s.id === 's3b-recall'))
  assert.ok(loadJourneyPlan(PLAN_FILE_V3).steps.some(s => s.id === 's3b-recall'))
})

test('plan loading: a plan must list every core step, in journey order, and no unknown step', t => {
  const dir = tmp(t), v3 = JSON.parse(readFileSync(PLAN_FILE_V3, 'utf8'))
  const write = (name, plan) => { const file = path.join(dir, name); writeFileSync(file, JSON.stringify(plan)); return file }
  assert.throws(() => loadJourneyPlan(write('missing.json', { ...v3, steps: v3.steps.filter(s => s.id !== 's4-long-command') })), /needs the journey step s4-long-command/)
  assert.throws(() => loadJourneyPlan(write('order.json', { ...v3, steps: [v3.steps[1], v3.steps[0], ...v3.steps.slice(2)] })), /journey order/)
  assert.throws(() => loadJourneyPlan(write('unknown.json', { ...v3, steps: [...v3.steps, { ...v3.steps[0], id: 's99-other' }] })), /unknown plan step s99-other/)
})

test('--rerun compares v3 with an earlier run that had no recall step: that step shows as new (its expectations "new"), not as changes or failures of the earlier run', async t => {
  const { file, results } = await earlierRun(t), out = path.join(tmp(t), 'rerun-v3.json'), net = noNetwork()
  assert.ok(!results.steps.some(s => s.id === 's3b-recall'), 'the earlier run (plan v1) has no recall step')
  const run = await cli(['--rerun', file, '--plan', PLAN_FILE_V3, '--out', out], { fetchImpl: net.fetchImpl })
  assert.equal(run.code, EXIT.ok, run.err.join('\n')); assert.equal(net.calls.length, 0)
  const now = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(now.plan.sha256, REGISTERED_PLAN_V3_SHA256)
  const recall = now.diff.steps.find(s => s.step === 's3b-recall')
  assert.equal(recall.added, true)
  assert.deepEqual(recall.changes.filter(c => c.kind !== 'expectation').map(c => c.kind), ['new_step', 'replay'], 'new, and (in a replay) scripted')
  assert.ok(recall.changes.filter(c => c.kind === 'expectation').length >= 5 && recall.changes.filter(c => c.kind === 'expectation').every(c => c.prev === 'new'))
  assert.ok(now.steps.find(s => s.id === 's3b-recall').requests.every(r => r.replay === 'unmatched'), 'no recorded answers exist for it: scripted, and counted')
  assert.ok(now.diff.steps.filter(s => !s.added).every(s => s.changes.filter(c => c.kind === 'expectation').every(c => c.prev !== undefined)))
  const text = run.out.join('\n')
  assert.match(text, /^== s3b-recall \[new in this plan, done\]$/m); assert.match(text, /^ {2}new step {5}not in the earlier run; requests /m)
  assert.match(text, /^ {2}expectation {2}s3b\.fetched \(hard, L7\): new -> \w+ \[not a model result: see replay above\]$/m)
  assert.doesNotMatch(text.split('== s3b-recall')[1].split('\n== ')[0], /requests {5}|answer {7}|person saw/)
})

// ---- plan v4 (cycle 15) ----
const REGISTERED_PLAN_V4_SHA256 = '9a0fe4aae6eb3c51f111c8d7181a30dffd01e0700bb0fc2f1b0a17a5026e1b9f'
test('plan v4: pinned, based on v3 by hash, keeps every v3 expectation; the only changes are body counting and the held-page rule for s9.packet, each marked', () => {
  const bytes = readFileSync(PLAN_FILE_V4), raw = JSON.parse(bytes.toString('utf8')), v3 = JSON.parse(readFileSync(PLAN_FILE_V3, 'utf8'))
  assert.equal(sha256(bytes), REGISTERED_PLAN_V4_SHA256)
  assert.equal(raw.version, 4); assert.equal(raw.basedOn.sha256, sha256(readFileSync(PLAN_FILE_V3)))
  assert.deepEqual(raw.world.env, { EGDESK_TURN_MEMORY_PRUNE_HELD: 'on', EGDESK_TURN_MEMORY_KEEP_LATE: 'on' }); assert.equal(raw.world.budgets, 'bridge')
  assert.deepEqual(raw.steps.map(s => s.id).filter(id => id !== 's8b-finished-result'), v3.steps.map(s => s.id))
  assert.ok(raw.steps.findIndex(s => s.id === 's8b-finished-result') === raw.steps.findIndex(s => s.id === 's8-pointer-on') + 1)
  for (const step of v3.steps) {
    const now = raw.steps.find(s => s.id === step.id)
    assert.deepEqual(now.caps, step.caps)
    for (const e of step.expect) {
      const n = now.expect.find(x => x.id === e.id)
      assert.ok(n, `${e.id} kept`); assert.equal(n.severity, e.severity); assert.equal(n.owner, e.owner)
      if (e.id === 's9.packet') { assert.equal(n.check, 'packetOrHeld'); assert.deepEqual(n.args, { ...e.args, count: 'bodies' }); assert.ok(n.revised) }
      else if (e.check === 'packet' || e.check === 'noRepeatedPages') { assert.equal(n.check, e.check); assert.deepEqual(n.args, { ...(e.args ?? {}), count: 'bodies' }); assert.equal(n.text, e.text); assert.ok(n.revised) }
      else assert.deepEqual(n, e, `${e.id} unchanged`)
    }
    for (const added of now.expect.filter(x => !step.expect.some(e => e.id === x.id))) assert.ok(added.owner && added.severity && added.predicted, added.id)
  }
  // The new person-level checks: no answer ends in a system text, in every step where the Agent answers; the owner question quotes the Agent's own answer.
  assert.deepEqual(raw.steps.filter(s => s.expect.some(e => e.check === 'endsInOwnWords' && e.severity === 'hard')).map(s => s.id),
    ['s1-first-turn', 's2-follow-up', 's3b-recall', 's6-answer', 's9-status-remark', 's10-browser-task', 's11-browser-reply'])
  assert.ok(raw.steps.find(s => s.id === 's8b-finished-result').expect.some(e => e.check === 'quotesOwnAnswer' && e.severity === 'hard'))
  assert.equal(STEPS.find(s => s.id === 's8b-finished-result').since, 4)
  for (const file of [PLAN_FILE, PLAN_FILE_V2, PLAN_FILE_V3]) assert.ok(!loadJourneyPlan(file).steps.some(s => s.id === 's8b-finished-result'))
  assert.deepEqual(loadJourneyPlan(PLAN_FILE_V3).world, { env: {}, budgets: 'single', switches: {} }, 'older plans keep the world as it was')
})

test('packet parsing: a page header with its content is a body; a "not re-sent" header, a header followed by another, or the "not repeated here" line is a reference', () => {
  const value = ['intro', '[page id=ontology:db/pg-health time=present rev=1 via=scan]', '헬스체크 3종: 연결 풀 응답.', '',
    '[page id=ontology:db/pg-design rev=c142 already delivered earlier in this thread, unchanged; content not re-sent]',
    '[page id=ontology:db/pg-plan rev=e290 already delivered earlier in this thread, unchanged; content not re-sent]',
    '[item id=ontology:quote/a-decision kind=timeline time=past status=done]', '11월 18일 회의에서 결정했다.',
    '[page id=ontology:quote/a-v1 time=past rev=2]', '[content not repeated here: this page is among the selected items above]',
    '[page id=ontology:quote/a-meeting time=past rev=3]', '[same record as a selected item above, which shows it in another form: count it once]', '팀장 말로는…',
    '[page id=ontology:db/redis rev=9]'].join('\n')
  assert.deepEqual(packetPages(value), { bodies: ['ontology:db/pg-health', 'ontology:quote/a-decision', 'ontology:quote/a-meeting'],
    refs: ['ontology:db/pg-design', 'ontology:db/pg-plan', 'ontology:quote/a-v1', 'ontology:db/redis'] })
})

test('v4 run: the world gets the plan\'s flags, packets carry bodies and references, the owner-question step runs, and every new check is judged', async t => {
  const outcome = await runJourney({ plan: loadJourneyPlan(PLAN_FILE_V4), fetchImpl: async () => { throw new Error('no network') } })
  assert.deepEqual(outcome.steps.map(s => s.id), loadJourneyPlan(PLAN_FILE_V4).steps.map(s => s.id))
  const s9 = outcome.steps.find(s => s.id === 's9-status-remark')
  assert.ok(s9.seen.packets.every(p => Array.isArray(p.bodyIds) && Array.isArray(p.refIds)))
  assert.ok(s9.seen.packets.some(p => p.refIds.includes('ontology:db/pg-plan')), 'the plan page held since s3b is referenced, not re-sent')
  assert.ok(!s9.seen.packets.some(p => p.bodyIds.includes('ontology:db/pg-plan')))
  assert.equal(s9.checks.find(c => c.id === 's9.packet').pass, true)
  const s8b = outcome.steps.find(s => s.id === 's8b-finished-result')
  assert.ok(s8b.requests.some(r => r.family === 'work_placement'), 'the owner question is asked')
  for (const id of ['s8b.owner-question-own', 's8b.owner-question-asked', 's1.own-ending', 's6.own-ending', 's11.own-ending']) {
    const check = outcome.steps.flatMap(s => s.checks).find(c => c.id === id)
    assert.equal(check.pass, true, `${id} on the scripted answers: ${JSON.stringify(check.observed)}`)
  }
})

test('new checks fail for what they forbid: an answer that ends in an appended caveat, and an owner question that quotes appended text', () => {
  const own = 'A사 견적은 v1 발송 후 v2 수정 계획 단계입니다.', caveat = '확인되지 않은 부분은 답하지 않았습니다. 필요하면 기준으로 삼을 자료를 알려 주세요.'
  const step = text => ({ id: 's1-first-turn', room: 'dm-all-on', seen: { written: [own], newMessages: [{ room: 'dm-all-on', role: 'assistant', by: 'agent', text }] } })
  assert.ok(JSON.parse(readFileSync(PLAN_FILE_V4, 'utf8')).steps.flatMap(x => x.expect).some(x => x.check === 'endsInOwnWords'))
  return import('./egdesk-all-on-live-measure.mjs').then(({ CHECK_FUNCTIONS }) => {
    assert.equal(CHECK_FUNCTIONS.endsInOwnWords({ step: step(own) }).pass, true)
    assert.equal(CHECK_FUNCTIONS.endsInOwnWords({ step: step(`${own}\n\n${caveat}`) }).pass, false, 'an appended fixed caveat')
    assert.equal(CHECK_FUNCTIONS.endsInOwnWords({ step: step(caveat) }).pass, false, 'a fixed reply instead of the answer')
    assert.equal(CHECK_FUNCTIONS.endsInOwnWords({ step: step('A사 견적은 v1 발송 후 v2 수정 계획 단계입니다.') }).pass, true, 'a sentence removed silently still ends in own words')
    const answered = { id: 's6-answer', seen: { written: [own], newMessages: [{ role: 'assistant', by: 'agent', text: `${own}\n\n${caveat}` }] } }
    const world = raw => ({ decisionsIn: () => [{ feature: 'work_placement', raw }] })
    const quotes = (raw) => CHECK_FUNCTIONS.quotesOwnAnswer({ step: { id: 's8b-finished-result' }, results: [answered], args: { answerStep: 's6-answer', families: ['work_placement'] }, world: world(raw) }).pass
    assert.equal(quotes(JSON.stringify({ input: [{ content: `Result: ${own}` }] })), true)
    assert.equal(quotes(JSON.stringify({ input: [{ content: `Result: ${own} ${caveat}` }] })), false, 'the appended caveat is quoted')
    assert.equal(quotes(JSON.stringify({ input: [{ content: 'Result: (none)' }] })), false, 'the answer is not quoted at all')
  })
})

test('world budgets: "bridge" gives the runtime the bridge\'s warm and cold turn_context budgets; the default keeps the single 800 ms budget', async t => {
  const { allOnWorld } = await import('./egdesk-all-on.support.mjs')
  const { TURN_CONTEXT_BUDGET_MS, TURN_CONTEXT_COLD_BUDGET_MS } = await import('../helper/codex-chat-runtime.mjs')
  const bridge = allOnWorld(t, { budgets: 'bridge' }).chat.decisionContext, single = allOnWorld(t).chat.decisionContext
  assert.deepEqual([bridge.budgetMs, bridge.coldBudgetMs, typeof bridge.warm], [TURN_CONTEXT_BUDGET_MS, TURN_CONTEXT_COLD_BUDGET_MS, 'function'])
  assert.equal(bridge.warm(), false, 'cold until a Decisions request of the world has been answered')
  assert.deepEqual([single.budgetMs, single.coldBudgetMs, single.warm], [TURN_CONTEXT_BUDGET_MS, undefined, undefined])
})

// ---- plan v5 (cycle 16) ----
const REGISTERED_PLAN_V5_SHA256 = '841ca72597bf165d4d173b4adc5349211b8f9072d092d561888e40d27cbdc22a'
test('plan v5: pinned, based on v4 by hash, every v4 expectation verbatim, one declared switch (off by default) and one expectation judged only under it', () => {
  const bytes = readFileSync(PLAN_FILE_V5), raw = JSON.parse(bytes.toString('utf8')), v4 = JSON.parse(readFileSync(PLAN_FILE_V4, 'utf8'))
  assert.equal(sha256(bytes), REGISTERED_PLAN_V5_SHA256)
  assert.equal(raw.version, 5); assert.equal(raw.basedOn.sha256, sha256(readFileSync(PLAN_FILE_V4)))
  assert.deepEqual({ env: raw.world.env, budgets: raw.world.budgets }, { env: v4.world.env, budgets: v4.world.budgets })
  assert.deepEqual(Object.keys(raw.world.switches), ['action-relevance'])
  assert.deepEqual(raw.world.switches['action-relevance'].env, { EGDESK_CONTEXT_RELEVANCE: 'action' }); assert.equal(raw.world.switches['action-relevance'].default, 'off')
  assert.deepEqual(raw.steps.map(s => s.id), v4.steps.map(s => s.id))
  for (const step of v4.steps) {
    const now = raw.steps.find(s => s.id === step.id)
    assert.deepEqual(now.caps, step.caps); assert.deepEqual(now.expect.slice(0, step.expect.length), step.expect, `${step.id}: v4 kept as it was`)
  }
  const added = raw.steps.flatMap(s => s.expect).filter(e => !v4.steps.flatMap(x => x.expect).some(x => x.id === e.id))
  assert.deepEqual(added.map(e => [e.id, e.severity, e.owner, e.when]), [['s4.no-page-for-the-action', 'hard', 'L7', { switch: 'action-relevance' }]])
})

test('v5 switches: off, the gated expectation is not judged and the world has no switch flag; on, it is judged and the flag reaches the runtime; an unknown switch is refused', async t => {
  const plan = loadJourneyPlan(PLAN_FILE_V5), noNet = async () => { throw new Error('no network') }
  const off = await runJourney({ plan, fetchImpl: noNet }), on = await runJourney({ plan, fetchImpl: noNet, switches: ['action-relevance'] })
  const gated = run => run.steps.find(s => s.id === 's4-long-command').checks.find(c => c.id === 's4.no-page-for-the-action')
  assert.deepEqual([gated(off).pass, gated(off).state], [null, 'switch_off'])
  assert.equal(typeof gated(on).pass, 'boolean'); assert.deepEqual(on.switches, ['action-relevance']); assert.deepEqual(off.switches, [])
  // Every other expectation is judged the same way with the switch off as in a v4 run.
  const v4 = await runJourney({ plan: loadJourneyPlan(PLAN_FILE_V4), fetchImpl: noNet })
  const verdicts = run => run.steps.flatMap(s => s.checks).filter(c => c.id !== 's4.no-page-for-the-action').map(c => [c.id, c.pass])
  assert.deepEqual(verdicts(off), verdicts(v4))
  await assert.rejects(runJourney({ plan, fetchImpl: noNet, switches: ['no-such'] }), /the plan has no switch no-such/)
  const { allOnWorld } = await import('./egdesk-all-on.support.mjs')
  assert.equal(allOnWorld(t, { env: plan.world.switches['action-relevance'].env }).chat.decisionContext.relevanceRules, 'action')
  assert.equal(allOnWorld(t, { env: plan.world.env }).chat.decisionContext.relevanceRules, undefined)
})

test('v5 switches on the command line: --switch is recorded in the results; an unknown one is a usage error before anything runs', async t => {
  const out = path.join(tmp(t), 'v5.json')
  const run = await cli(['--plan', PLAN_FILE_V5, '--switch', 'action-relevance', '--out', out], { fetchImpl: noNetwork().fetchImpl })
  assert.equal(run.code, EXIT.ok, run.err.join('\n'))
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')).world.switchesOn, ['action-relevance'])
  const bad = await cli(['--plan', PLAN_FILE_V5, '--switch', 'no-such'], { fetchImpl: noNetwork().fetchImpl })
  assert.equal(bad.code, EXIT.usage); assert.match(bad.err.join('\n'), /has no switch no-such \(it has: action-relevance\)/)
})

// ---- plan v6 (cycle 17) ----
const REGISTERED_PLAN_V6_SHA256 = '7d7d238d73b9dc7b14db7c574a69f32e7b2518ec6d12f55566f11d06e34ecc83'
const V6_NEW = [['s4n.kept', 'hard', 'L2'], ['s4n.not-interrupted', 'hard', 'L2'], ['s4n.one-reply', 'hard', 'L3'], ['s4n.reply-says-running', 'soft', 'L3'],
  ['s4n.no-duplicate-wait', 'hard', 'L3'], ['s4n.heard', 'soft', 'L3'], ['s9.nudge-not-repeated', 'hard', 'L3']]
test('plan v6: pinned, based on v5 by hash, every v5 expectation kept (one prediction revised and marked), the nudge step and its flag in the world', () => {
  const bytes = readFileSync(PLAN_FILE_V6), raw = JSON.parse(bytes.toString('utf8')), v5 = JSON.parse(readFileSync(PLAN_FILE_V5, 'utf8'))
  assert.equal(sha256(bytes), REGISTERED_PLAN_V6_SHA256)
  assert.equal(raw.version, 6); assert.equal(raw.basedOn.sha256, sha256(readFileSync(PLAN_FILE_V5)))
  assert.deepEqual(raw.world.env, { ...v5.world.env, EGDESK_INRUN_MESSAGES: 'on' }); assert.equal(raw.world.budgets, v5.world.budgets)
  assert.deepEqual(raw.world.switches['action-relevance'].env, v5.world.switches['action-relevance'].env, 'one flag covers both sides of L7 (c20, c21)')
  assert.deepEqual(raw.steps.map(s => s.id).filter(id => id !== 's4n-nudge'), v5.steps.map(s => s.id))
  assert.equal(raw.steps[raw.steps.findIndex(s => s.id === 's4-long-command') + 1].id, 's4n-nudge')
  for (const step of v5.steps) {
    const now = raw.steps.find(s => s.id === step.id)
    assert.deepEqual(now.caps, step.caps)
    for (const [i, e] of step.expect.entries()) {
      if (e.id !== 's4.no-page-for-the-action') { assert.deepEqual(now.expect[i], e, `${e.id}: verbatim`); continue }
      const { predicted, revised, ...rest } = now.expect[i], { predicted: was, ...before } = e
      assert.deepEqual(rest, before, `${e.id}: only the prediction changes`); assert.notEqual(predicted, was); assert.match(revised, /^v6: prediction only/)
    }
  }
  const added = raw.steps.flatMap(s => s.expect).filter(e => !v5.steps.flatMap(x => x.expect).some(x => x.id === e.id))
  assert.deepEqual(added.map(e => [e.id, e.severity, e.owner]), V6_NEW)
})

// L3 c22: the heartbeat side landed (it judges the nudge and settles it with one checked reply), so the four verdicts that were registered as
// "FAIL until L3's side lands" now pass, and the nudge, settled as 'reply', is no longer carried into the next turn.
test('v6 dry run: the nudge is kept in the run and the command left alone (L2); L3\'s heartbeat answers it once and settles it (L3 c22); every other verdict is v5\'s', async () => {
  const noNet = async () => { throw new Error('no network') }
  const v6 = await runJourney({ plan: loadJourneyPlan(PLAN_FILE_V6), fetchImpl: noNet }), v5 = await runJourney({ plan: loadJourneyPlan(PLAN_FILE_V5), fetchImpl: noNet })
  const verdict = (run, id) => run.steps.flatMap(s => s.checks).find(c => c.id === id)
  assert.deepEqual(V6_NEW.map(([id]) => [id, verdict(v6, id).pass]), [['s4n.kept', true], ['s4n.not-interrupted', true], ['s4n.one-reply', true], ['s4n.reply-says-running', true],
    ['s4n.no-duplicate-wait', true], ['s4n.heard', true], ['s9.nudge-not-repeated', true]])
  assert.deepEqual(verdict(v6, 's4n.one-reply').observed.shown, ['멈춘 게 아니라 명령이 아직 실행 중이에요. 끝나는 대로 알려 드릴게요.'])
  assert.deepEqual(verdict(v6, 's9.nudge-not-repeated').observed.inputs, [['PostgreSQL 마이그레이션 배포 끝났어']], 'settled as reply: not carried into the next turn')
  const others = run => run.steps.flatMap(s => s.checks).filter(c => !V6_NEW.some(([id]) => id === c.id)).map(c => [c.id, c.pass])
  assert.deepEqual(others(v6), others(v5))
})

// ---- plan v7 (cycle 20) ----
const REGISTERED_PLAN_V7_SHA256 = '0a8b4a02231157e8c095015b87257b614cb5c74d30dd1358455f604cc2fd94a5'
const V7_NEW = [['s3b.on-topic', 'hard', 'L3'], ['s3b.not-off-topic', 'hard', 'L3'], ['s3b.answer-kept', 'soft', 'L3'], ['s4.elapsed-true', 'hard', 'L3'], ['s4n.elapsed-true', 'hard', 'L3'],
  ['s4c.kept', 'hard', 'L2'], ['s4c.model-says-change', 'hard', 'L3'], ['s4c.model-not-stop', 'hard', 'L3'], ['s4c.decided-steer', 'hard', 'L3'], ['s4c.steered', 'hard', 'L2'],
  ['s4c.nothing-posted', 'hard', 'L3'], ['s4c.command-continues', 'hard', 'L2'], ['s4c.not-carried', 'hard', 'L2'], ['s9.change-not-repeated', 'hard', 'L3'],
  ['s12.kept', 'hard', 'L2'], ['s12.model-says-stop', 'hard', 'L3'], ['s12.decided-stop', 'hard', 'L3'], ['s12.interrupted', 'hard', 'L2'], ['s12.no-agent-answer', 'hard', 'L3'],
  ['s12.no-command-shown', 'hard', 'L3'], ['s12.not-carried', 'hard', 'L2'], ['s12.system-messages', 'soft', 'L3']]
test('plan v7: pinned, based on v6 by hash, every v6 expectation verbatim, the world as v6 plus faithful wording, the two new steps and the listed additions', () => {
  const bytes = readFileSync(PLAN_FILE_V7), raw = JSON.parse(bytes.toString('utf8')), v6 = JSON.parse(readFileSync(PLAN_FILE_V6, 'utf8'))
  assert.equal(sha256(bytes), REGISTERED_PLAN_V7_SHA256)
  assert.equal(raw.version, 7); assert.equal(raw.basedOn.sha256, sha256(readFileSync(PLAN_FILE_V6)))
  assert.deepEqual({ ...raw.world, wording: undefined, note: undefined }, { ...v6.world, wording: undefined, note: undefined }); assert.equal(raw.world.wording, 'faithful')
  assert.deepEqual(raw.steps.map(s => s.id).filter(id => !['s4c-change-nudge', 's12-stop-nudge'].includes(id)), v6.steps.map(s => s.id))
  assert.equal(raw.steps[raw.steps.findIndex(s => s.id === 's4n-nudge') + 1].id, 's4c-change-nudge'); assert.equal(raw.steps.at(-1).id, 's12-stop-nudge')
  for (const step of v6.steps) {
    const now = raw.steps.find(s => s.id === step.id)
    assert.deepEqual(now.caps, step.caps); assert.deepEqual(now.expect.slice(0, step.expect.length), step.expect, `${step.id}: every v6 expectation verbatim`)
  }
  const added = raw.steps.flatMap(s => s.expect).filter(e => !v6.steps.flatMap(x => x.expect).some(x => x.id === e.id))
  assert.deepEqual(added.map(e => [e.id, e.severity, e.owner]), V7_NEW)
  assert.ok(added.every(e => typeof e.predicted === 'string' && e.predicted.length > 0), 'every new expectation says what is predicted')
})

test('v7 checks on made-up steps: each one fails when what it guards goes wrong', () => {
  const C = CHECK_FUNCTIONS, step = over => ({ id: 'x', room: 'dm-all-on', sends: [], seen: { newMessages: [], flows: [], runs: { 'dm-all-on': { status: 'inProgress' } }, steers: [], interruptCalls: [], carried: 0, writerSeconds: [], workingTurn: 'turn-1', engineTurns: { main: 0, fork: 0, steer: 0 }, interrupts: 0, calibration: [] }, ...over })
  const msg = (role, by, text) => ({ room: 'dm-all-on', role, by, text })
  // the answer the person sees: about PostgreSQL, not the fixed A사 sentence
  const answer = text => step({ seen: { ...step().seen, newMessages: [msg('assistant', 'agent', text)] } })
  assert.equal(C.messageMentions({ step: answer('PostgreSQL 전환은 확정했습니다.'), args: { needles: ['PostgreSQL'] } }).pass, true)
  assert.equal(C.messageMentions({ step: answer('A사 견적은 요청을 받은 뒤 첫 견적서를 보냈습니다.'), args: { needles: ['PostgreSQL'] } }).pass, false)
  assert.equal(C.messageAvoids({ step: answer('A사 견적은 요청을 받은 뒤 첫 견적서를 보냈습니다.'), args: { needles: ['A사'] } }).pass, false)
  assert.equal(C.messageAvoids({ step: answer('PostgreSQL 전환은 확정했습니다.'), args: { needles: ['A사'] } }).pass, true)
  assert.equal(C.messageAvoids({ step: step(), args: { needles: ['A사'] } }).pass, false, 'no answer at all is not an answer about the topic')
  // elapsed time: the number in the writer prompt against the run's real age
  const secs = rows => step({ seen: { ...step().seen, writerSeconds: rows } })
  assert.equal(C.elapsedTrue({ step: secs([{ kind: 'reply_status', claimed: 10, actual: 11 }]), args: { kind: 'reply_status', within: 2 } }).pass, true)
  assert.equal(C.elapsedTrue({ step: secs([{ kind: 'reply_status', claimed: 1, actual: 11 }]), args: { kind: 'reply_status', within: 2 } }).pass, false)
  assert.equal(C.elapsedTrue({ step: secs([]), args: { kind: 'reply_status', within: 2 } }).pass, false, 'no writer prompt: nothing was checked')
  assert.equal(C.elapsedTrue({ step: secs([{ kind: 'explain_wait', claimed: 10, actual: 10 }]), args: { kind: 'reply_status', within: 2 } }).pass, false, 'only the named kind counts')
  // the change: one steer, only the person's words, the working turn, no interrupt
  const steered = (steers, over = {}) => step({ seen: { ...step().seen, steers, ...over } })
  const one = { threadId: 't', turnId: 'turn-1', clientUserMessageId: 'req-6', texts: ['그거 말고 B부터 해줘'] }
  assert.equal(C.steeredWith({ step: steered([one]), args: { said: 'change' } }).pass, true)
  for (const bad of [[], [one, one], [{ ...one, turnId: 'turn-9' }], [{ ...one, texts: ['그거 말고 B부터 해줘', '더'] }], [{ ...one, texts: ['다른 말'] }], [{ ...one, clientUserMessageId: null }]]) assert.equal(C.steeredWith({ step: steered(bad), args: { said: 'change' } }).pass, false, JSON.stringify(bad))
  assert.equal(C.steeredWith({ step: steered([one], { interruptCalls: [{ threadId: 't', turnId: 'turn-1' }] }), args: { said: 'change' } }).pass, false, 'a steer with an interrupt is not a change')
  // the command goes on / the stop reaches the engine once
  assert.equal(C.runWorking({ step: step() }).pass, true)
  assert.equal(C.runWorking({ step: step({ seen: { ...step().seen, interrupts: 1 } }) }).pass, false)
  assert.equal(C.runWorking({ step: step({ seen: { ...step().seen, engineTurns: { main: 1, fork: 0, steer: 0 } } }) }).pass, false)
  const stopped = (calls, over = {}) => step({ seen: { ...step().seen, interruptCalls: calls, runs: { 'dm-all-on': { status: 'interrupted' } }, ...over } })
  const call = { threadId: 't', turnId: 'turn-1' }
  assert.equal(C.interruptedRun({ step: stopped([call]) }).pass, true)
  for (const bad of [stopped([]), stopped([call, call]), stopped([{ ...call, turnId: 'turn-9' }]), stopped([call], { steers: [one] }), step({ seen: { ...step().seen, interruptCalls: [call] } })]) assert.equal(C.interruptedRun({ step: bad }).pass, false)
  assert.equal(C.nothingCarried({ step: step() }).pass, true); assert.equal(C.nothingCarried({ step: step({ seen: { ...step().seen, carried: 1 } }) }).pass, false)
  // the person's words kept once; the derived kind
  const sent = (sends, texts) => step({ sends, seen: { ...step().seen, newMessages: texts.map(t => msg('user', 'person', t)) } })
  assert.equal(C.keptInRunSend({ step: sent([{ inRun: false, accepted: true }, { inRun: true, accepted: true }], ['전체 테스트 한 번 더 돌려줘', '그만해, 그거 하지 마']), args: { said: 'stop' } }).pass, true)
  assert.equal(C.keptInRunSend({ step: sent([{ inRun: false, accepted: true }], ['그만해, 그거 하지 마']), args: { said: 'stop' } }).pass, false, 'sent as a new turn, not into the run')
  assert.equal(C.keptInRunSend({ step: sent([{ inRun: true, accepted: true }], ['그만해, 그거 하지 마', '그만해, 그거 하지 마']), args: { said: 'stop' } }).pass, false, 'shown twice')
  assert.equal(C.derivedFlow({ step: step({ seen: { ...step().seen, flows: [{ flow: 'steer', posted: 'none' }] } }), args: { kind: 'steer' } }).pass, true)
  assert.equal(C.derivedFlow({ step: step({ seen: { ...step().seen, flows: [{ flow: 'reply', posted: 'model' }] } }), args: { kind: 'steer' } }).pass, false)
})

test('faithful revision: keeps the unlisted sentences, restates the listed one as the record, never changes the subject; the old plans keep the fixed sentence', () => {
  const prompt = (draft, listed) => `Here is your draft answer to the person's last message:\n\n${draft}\n\nBefore posting, a check of your draft against the material you were given found these sentences:\n${listed.map(s => `- "${s}": wrong tense. It states as done...`).join('\n')}\n\nRewrite your answer.`
  const s1 = 'PostgreSQL 전환 설계에서 스키마 변환, 데이터 이관, 롤백 순서를 정하기로 확정했습니다.', s2 = '롤백은 먼저 확인했습니다.'
  assert.equal(faithfulRevision(prompt(s1, [s1])), `기록에 따르면 ${s1}`)
  assert.equal(faithfulRevision(prompt(`${s1} ${s2}`, [s1])), `기록에 따르면 ${s1} ${s2}`)
  assert.equal(faithfulRevision(prompt(`${s1} ${s2}`, [s2])), `${s1} 기록에 따르면 ${s2}`)
  assert.equal(faithfulRevision('Write ONE short chat message'), null)
  assert.ok(!faithfulRevision(prompt(s1, [s1])).includes('A사'))
  // v1-v6 never set it (they keep the fixed sentence of the scripted world); a value other than "faithful" is refused
  assert.equal(loadJourneyPlan(PLAN_FILE_V6).world.wording, undefined); assert.equal(loadJourneyPlan(PLAN_FILE_V7).world.wording, 'faithful')
})

test('v7 dry run with the switch: what the scripted world shows about the new steps (the nudge steps pass by code; the elapsed check passes now that L3 c24 is in; the model-side checks use the scripted judge here)', async () => {
  const noNet = async () => { throw new Error('no network') }
  const run = await runJourney({ plan: loadJourneyPlan(PLAN_FILE_V7), fetchImpl: noNet, switches: ['action-relevance'] })
  const checks = run.steps.flatMap(s => s.checks), by = id => checks.find(c => c.id === id)
  // L3 c24 (the reply prompt gives the work's age, not the time since the person wrote) is in: before it, this was the one new expectation that failed (claimed 1 s for a run 11 s in)
  assert.deepEqual(V7_NEW.filter(([id]) => by(id).pass !== true).map(([id]) => id), [])
  assert.deepEqual(by('s4n.elapsed-true').observed.writerSeconds.map(r => [r.kind, Math.abs(r.claimed - r.actual) <= 2]), [['reply_status', true]])
  assert.deepEqual(by('s4.elapsed-true').observed.writerSeconds.map(r => [r.kind, r.claimed === r.actual]), [['explain_wait', true]])
  assert.deepEqual(run.steps.find(s => s.id === 's12-stop-nudge').seen.flows.map(f => f.flow), ['explain_wait', 'stop'])
  assert.deepEqual(run.steps.find(s => s.id === 's4c-change-nudge').seen.flows.map(f => f.flow), ['steer'])
  // every v6 expectation is judged as in v6, except the one the added steps could change: none
  const v6 = await runJourney({ plan: loadJourneyPlan(PLAN_FILE_V6), fetchImpl: noNet, switches: ['action-relevance'] })
  const verdicts = r => r.steps.flatMap(s => s.checks).filter(c => !V7_NEW.some(([id]) => id === c.id)).map(c => [c.id, c.pass])
  assert.deepEqual(verdicts(run), verdicts(v6))
})

// ---- plan v8 (cycle 22) ----
const REGISTERED_PLAN_V8_SHA256 = '33740f2ec5cc230f94be6c5c62b1b4113bbe4ddab469327e64f72502588a34ee'
const V8_NEW = [['s1.no-duplicate-bodies', 'hard', 'L7'], ['s1.no-memory-key', 'hard', 'L7'], ['s3b.no-duplicate-bodies', 'hard', 'L7'], ['s3b.no-memory-key', 'hard', 'L7'],
  ['s13.fetched', 'hard', 'L7'], ['s13.claim-withheld', 'hard', 'L3'], ['s13.nothing-posted', 'hard', 'L3'], ['s13.claim-never-shown', 'hard', 'L3'], ['s13.run-ended', 'hard', 'L2'],
  ['s14.told', 'hard', 'L3'], ['s14.no-repeat', 'hard', 'L7'], ['s14.held-known', 'hard', 'L7'], ['s14.one-answer', 'hard', 'L2'], ['s14.answer', 'hard', 'L3']]
test('plan v8: pinned, based on v7 by hash, every v7 expectation verbatim, the world with the one-packet switch, two new steps at the end and the listed additions', () => {
  const bytes = readFileSync(PLAN_FILE_V8), raw = JSON.parse(bytes.toString('utf8')), v7 = JSON.parse(readFileSync(PLAN_FILE_V7, 'utf8'))
  assert.equal(sha256(bytes), REGISTERED_PLAN_V8_SHA256); assert.equal(LATEST_PLAN_FILE, PLAN_FILE_V8)
  assert.equal(raw.version, 8); assert.equal(raw.basedOn.sha256, sha256(readFileSync(PLAN_FILE_V7)))
  assert.deepEqual(Object.keys(raw.world.switches), [...Object.keys(v7.world.switches), 'one-packet'])
  assert.deepEqual({ ...raw.world, switches: undefined }, { ...v7.world, switches: undefined }); assert.equal(raw.world.switches['one-packet'].env.EGDESK_TURN_MEMORY_ONE_PACKET, 'on')
  assert.deepEqual(raw.steps.map(s => s.id), [...v7.steps.map(s => s.id), 's13-withheld', 's14-after-withheld'])
  for (const step of v7.steps) {
    const now = raw.steps.find(s => s.id === step.id)
    assert.deepEqual(now.caps, step.caps); assert.deepEqual(now.expect.slice(0, step.expect.length), step.expect, `${step.id}: every v7 expectation verbatim`)
  }
  const added = raw.steps.flatMap(s => s.expect).filter(e => !v7.steps.flatMap(x => x.expect).some(x => x.id === e.id))
  assert.deepEqual(added.map(e => [e.id, e.severity, e.owner]), V8_NEW)
  assert.ok(added.every(e => typeof e.predicted === 'string' && e.predicted.length > 0), 'every new expectation says what is predicted')
  assert.deepEqual(added.filter(e => e.when?.switch === 'one-packet').map(e => e.id), V8_NEW.slice(0, 4).map(([id]) => id), 'only the four packet expectations wait for the switch')
})

test('v8 checks on made-up steps: each one fails when what it guards goes wrong', () => {
  const C = CHECK_FUNCTIONS, step = over => ({ id: 'x', room: 'dm-all-on', requests: [], seen: { newMessages: [], packets: [], calibration: [] }, ...over })
  const rec = (check, ifUnrevised, attached) => ({ feature: 'draft_check', mode: 'on', check, ifUnrevised, attached, judgments: [] })
  const asked = n => Array.from({ length: n }, () => ({ family: 'draft_check' }))
  const args = { check: 'would_revise', ifUnrevised: 'would_withhold', requests: 2 }
  assert.equal(C.draftCheckRecord({ step: step({ requests: asked(2), seen: { calibration: [rec('would_revise', 'would_withhold', true)] } }), args }).pass, true)
  assert.equal(C.draftCheckRecord({ step: step({ requests: asked(1), seen: { calibration: [rec('would_revise', 'would_withhold', true)] } }), args }).pass, false, 'no second reading')
  assert.equal(C.draftCheckRecord({ step: step({ requests: asked(2), seen: { calibration: [rec('would_pass', null, false)] } }), args }).pass, false, 'nothing flagged')
  assert.equal(C.draftCheckRecord({ step: step({ requests: asked(2), seen: { calibration: [rec('would_revise', 'would_post', true)] } }), args }).pass, false, 'a part would have stayed')
  assert.equal(C.draftCheckRecord({ step: step({ requests: asked(2), seen: { calibration: [] } }), args }).pass, false, 'no record')
  const packets = copies => step({ seen: { packets: [{ keys: ['egdesk_context', 'egdesk_turn_memory'], copies }], newMessages: [], calibration: [] } })
  assert.equal(C.packetNoDuplicates({ step: packets({ a: 1, b: 1 }) }).pass, true)
  assert.equal(C.packetNoDuplicates({ step: packets({ a: 2 }) }).pass, false); assert.equal(C.packetNoDuplicates({ step: step({ seen: { packets: [], newMessages: [], calibration: [] } }) }).pass, false, 'no packet seen is not a pass')
  assert.equal(C.noContextKey({ step: packets({}), args: { key: 'egdesk_turn_memory' } }).pass, false); assert.equal(C.noContextKey({ step: packets({}), args: { key: 'egdesk_other' } }).pass, true)
})

test('v8 dry run: both ways of running the scripted world (the packet expectations are judged only under the switch; the withheld path passes by code with the scripted judge)', async () => {
  const noNet = async () => { throw new Error('no network') }
  const off = await runJourney({ plan: loadJourneyPlan(PLAN_FILE_V8), fetchImpl: noNet, switches: ['action-relevance'], caps: { ...DEFAULT_CAPS, tokenCeiling: 100000 } })
  const on = await runJourney({ plan: loadJourneyPlan(PLAN_FILE_V8), fetchImpl: noNet, switches: ['action-relevance', 'one-packet'], caps: { ...DEFAULT_CAPS, tokenCeiling: 100000 } })
  const judged = r => r.steps.flatMap(s => s.checks).filter(c => c.severity === 'hard' && c.pass !== null && c.pass !== undefined)
  const by = (r, id) => r.steps.flatMap(s => s.checks).find(c => c.id === id)
  for (const [id] of V8_NEW.slice(4)) { assert.equal(by(off, id).pass, true, id); assert.equal(by(on, id).pass, true, id) }
  for (const [id] of V8_NEW.slice(0, 4)) { assert.equal(by(on, id).pass, true, id); assert.notEqual(by(off, id)?.pass, true, `${id} is not judged without the switch`) }
  // the only v7 expectation that differs from v7's own dry run is the one v7 already predicted (the scripted judge cannot read the action rule)
  assert.deepEqual(judged(off).filter(c => c.pass === false).map(c => c.id), ['s4.no-page-for-the-action'])
  assert.deepEqual(judged(on).filter(c => c.pass === false).map(c => c.id), ['s4.no-page-for-the-action'])
  const s13 = on.steps.find(s => s.id === 's13-withheld'), s14 = on.steps.find(s => s.id === 's14-after-withheld')
  assert.deepEqual(s13.seen.newMessages.filter(m => m.role === 'assistant'), []); assert.deepEqual(s14.seen.newMessages.filter(m => m.by === 'agent').map(m => m.text), ['PostgreSQL 전환은 12월 첫째 주에 배포할 예정입니다.'])
})
