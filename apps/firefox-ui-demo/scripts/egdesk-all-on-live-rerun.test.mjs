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
import { PLAN_FILE, PLAN_FILE_V2, diffJourneys, formatDiff, loadJourneyPlan, main } from './egdesk-all-on-live-measure.mjs'

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
  const run = await cli(['--rerun', file, '--out', out], { fetchImpl: net.fetchImpl })
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
  const run = await cli(['--rerun', file, '--send', '--out', out], { fetchImpl: net.fetchImpl })
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
