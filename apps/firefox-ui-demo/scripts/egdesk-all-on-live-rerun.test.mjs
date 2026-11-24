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
import { LATEST_PLAN_FILE, PLAN_FILE, PLAN_FILE_V2, PLAN_FILE_V3, PLAN_FILE_V4, STEPS, diffJourneys, formatDiff, loadJourneyPlan, main, packetPages, runJourney } from './egdesk-all-on-live-measure.mjs'

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
const REGISTERED_PLAN_V4_SHA256 = 'ce0b3c751231a315ac88faf80143c52405581970f5a4a9da382619e06d5ed981'
test('plan v4: pinned, based on v3 by hash, keeps every v3 expectation; the only changes are body counting and the held-page rule for s9.packet, each marked', () => {
  const bytes = readFileSync(PLAN_FILE_V4), raw = JSON.parse(bytes.toString('utf8')), v3 = JSON.parse(readFileSync(PLAN_FILE_V3, 'utf8'))
  assert.equal(sha256(bytes), REGISTERED_PLAN_V4_SHA256); assert.equal(LATEST_PLAN_FILE, PLAN_FILE_V4)
  assert.equal(raw.version, 4); assert.equal(raw.basedOn.sha256, sha256(readFileSync(PLAN_FILE_V3)))
  assert.deepEqual(raw.world.env, { EGDESK_TURN_MEMORY_PRUNE_HELD: 'on', EGDESK_TURN_MEMORY_KEEP_LATE: 'on' })
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
  assert.deepEqual(loadJourneyPlan(PLAN_FILE_V3).world.env, {}, 'older plans keep the world as it was')
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
