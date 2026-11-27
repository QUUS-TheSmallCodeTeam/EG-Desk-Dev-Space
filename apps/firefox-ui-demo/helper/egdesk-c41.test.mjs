import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REPLAY_SENT, REPLAY_SET, REPLAY_TOKEN_CEILING, SCENARIOS, buildMemoryFirstReplayPlan, captureScenario, chainsOf, replayTimingReport } from './egdesk-c41-replay.mjs'
import { buildConfirmationStatedPlan, OWN_SAID } from './egdesk-c36-plans.mjs'
import { loadPlan } from './egdesk-decision-real-runner.mjs'
import { buildMemoryFirstScript, buildMemoryFirstV2Script } from './egdesk-memory-first-real-engine-scripts.mjs'
import { buildMemoryWriteV3Script } from './egdesk-memory-real-engine-scripts.mjs'

const body = (built, id) => JSON.parse(built.files.find(f => f.file === `requests/${id}.json`).bytes)
const text = b => b.input.map(m => String(m.content)).join('\n')

test('the replay plan: the declared ceiling holds, every request is checked by code, the plan loads in the generic runner with the product bars, and a second build is byte-identical', async () => {
  const built = await buildMemoryFirstReplayPlan(), again = await buildMemoryFirstReplayPlan()
  assert.equal(built.plan.set, REPLAY_SET); assert.deepEqual(built.plan.requests.map(r => r.id), REPLAY_SENT)
  assert.ok(built.plan.tokenCeiling <= 12_000 && built.plan.tokenCeiling === REPLAY_TOKEN_CEILING); assert.ok(built.estInputTokens * 1.1 <= built.plan.tokenCeiling, 'ten percent over the estimate (what c57 measured) still fits')
  assert.deepEqual(built.plan.requests.map(r => r.sha256), again.plan.requests.map(r => r.sha256), 'deterministic')
  assert.equal(built.plan.transport, 'product')
  for (const r of built.plan.requests) assert.ok(r.expect.some(e => e.severity === 'hard'), `${r.id} has a hard check`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c41-plan-')); fs.mkdirSync(path.join(dir, 'requests'))
  for (const { file, bytes } of built.files) fs.writeFileSync(path.join(dir, file), bytes)
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(built.plan))
  const loaded = loadPlan(path.join(dir, 'plan.json'))
  assert.equal(loaded.requests.length, REPLAY_SENT.length); assert.ok(Object.keys(loaded.productBars).length >= 10)
  for (const r of built.plan.requests) assert.equal(createHash('sha256').update(built.files.find(f => f.file === r.file).bytes).digest('hex'), r.sha256)
})

test('the inputs are the recorded ones: the person\'s messages are those of the committed real-engine scripts, the seeds are theirs, and the held page of the second turn is the first turn\'s', async () => {
  const v3 = buildMemoryWriteV3Script().conversations, v2 = buildMemoryFirstV2Script().conversations
  const said = id => v3.find(c => c.id === id).turns[1].say
  assert.equal(SCENARIOS.find(s => s.id === 'own').say, said('own-confirm')); assert.equal(said('own-confirm'), OWN_SAID)
  assert.equal(SCENARIOS.find(s => s.id === 'hedged').say, said('hedged')); assert.equal(SCENARIOS.find(s => s.id === 'relayed').say, said('relayed'))
  assert.equal(SCENARIOS.find(s => s.id === 'control').say, buildMemoryFirstScript().conversations.find(c => c.id === 'control-first').turns[1].say)
  assert.equal(SCENARIOS.find(s => s.id === 'newrecord').say, v2.find(c => c.id === 'newrecord-first').turns[1].say)
  for (const s of SCENARIOS.filter(x => x.id !== 'control')) assert.equal(s.first, v3.find(c => c.id === (s.id === 'own' || s.id === 'newrecord' ? 'own-confirm' : s.id))?.turns[0].say, `${s.id} first turn`)
  const built = await buildMemoryFirstReplayPlan()
  const own = body(built, 'own-write'), control = body(built, 'control-triage')
  assert.ok(text(own).includes('아 그거 다음 주 화요일로 확정했어') && text(own).includes('신제품 리뷰 회의 일정은 아직 정해지지 않았다. 후보는 다음 주 화요일과 수요일이다.'), 'the message and the seeded record')
  assert.ok(text(control).includes('Held in the answering model\'s context:\n- 신제품 리뷰 회의 일정 | status=unknown') && text(control).includes('신제품 리뷰 회의 일정 아직 안 정해졌지?'), 'the second turn holds what the first turn delivered')
  const confirm = body(built, 'own-confirm-yes'), c36 = await buildConfirmationStatedPlan()
  assert.deepEqual(confirm.questions, body(c36, 'rc2-own-yes').questions, 'the confirmation request is the c36 one (wording v2) for the real reply of check-20mw')
  const ct = body(built, 'contradiction-yes'); assert.ok(text(ct).includes('12월 5일') && text(ct).includes('12월 12일') && ct.questions.length === 1 && ct.questions[0].name === 'ct_0')
})

test('every request is the product\'s own: the write request carries the three speech axes and its second step, the conflict request is judgeRecordConflict\'s, nothing of the scripted walk is in a body', async () => {
  const built = await buildMemoryFirstReplayPlan()
  assert.deepEqual(body(built, 'own-write').questions.map(q => q.name), ['tw_status', 'tw_about_0', 'speech_source_0', 'speech_form_0', 'speech_time_0'])
  assert.deepEqual(body(built, 'own-write-second').questions.map(q => q.name), ['speechs_other_0', 'speechs_own_0', 'speechs_record_0', 'speechs_guess_0'])
  assert.match(body(built, 'own-write-second').questions.find(q => q.name === 'speechs_own_0').instructions, /decided, fixed or arranged/, 'own wording v4 (the flag set of write-v3)')
  assert.deepEqual(body(built, 'own-conflict').questions.map(q => q.name), ['cf_differs']); assert.ok(text(body(built, 'own-conflict')).includes('신제품 리뷰 회의 일정'))
  assert.deepEqual(body(built, 'control-triage').questions.map(q => q.name), ['tn_courtesy', 'tn_need', 'tn_recall', 'tn_record'])
  for (const id of REPLAY_SENT) { const raw = JSON.stringify(body(built, id)); assert.ok(!/"probability"|"confidence"/.test(raw), `${id}: no answer in a request`) }
  // the requests the replay builds but does not send (the declared ceiling) exist
  const all = Object.fromEntries(await Promise.all(SCENARIOS.map(async s => [s.id, (await captureScenario(s)).captured.map(c => c.stage)])))
  assert.deepEqual(all.own, ['triage', 'write', 'write-second', 'conflict']); assert.deepEqual(all.hedged, ['triage', 'write', 'conflict']); assert.deepEqual(all.relayed, ['triage', 'write', 'conflict'])
  assert.deepEqual(all.control, ['triage', 'conflict']); assert.ok(all.newrecord.includes('link') && all.newrecord.includes('write') && all.newrecord.includes('write-second'))
})

test('the expectations are built by code from the recorded outcomes: one yes and the others no for an update, all no for a new record, the axes at the product\'s bars; hedged is never an own or relayed install', async () => {
  const built = await buildMemoryFirstReplayPlan(), by = id => built.plan.requests.find(r => r.id === id).expect
  const own = by('own-write'); assert.deepEqual(own.filter(e => e.min !== undefined).map(e => [e.name, e.min, e.severity]), [['tw_about_0', 0.8, 'hard']])
  assert.deepEqual(own.find(e => e.name === 'speech_source_0').oneOf, ['self_reported_observation', 'unspecified']); assert.deepEqual(own.find(e => e.name === 'speech_source_0').whenAccepted, { minConfidence: 0.85, minMargin: 0.2 })
  assert.deepEqual(by('relayed-write').find(e => e.name === 'speech_source_0').oneOf, ['attributed_report'])
  const hedged = by('hedged-write').find(e => e.name === 'speech_source_0'); assert.ok(!hedged.oneOf.includes('self_reported_observation') && !hedged.oneOf.includes('attributed_report') && hedged.severity === 'hard')
  assert.deepEqual(by('newrecord-write').filter(e => e.name.startsWith('tw_about')).map(e => [e.max, e.severity]), [[0.2, 'hard']], 'a new record is about no stored record')
  assert.deepEqual(by('control-triage').find(e => e.name === 'tn_record'), { ...by('control-triage').find(e => e.name === 'tn_record') }); assert.equal(by('control-triage')[0].max, 0.79)
  assert.deepEqual(by('own-write-second').map(e => [e.name, e.min ?? e.max]), [['speechs_own_0', 0.85], ['speechs_other_0', 0.15]])
  assert.deepEqual(by('own-confirm-yes').map(e => [e.name, e.min ?? e.max]), [['rc_stated_0', 0.8], ['rc_confirms_0', 0.8], ['rc_rejects_0', 0.2]])
  assert.ok(built.plan.requests.every(r => r.expect.every(e => typeof e.note === 'string' && e.note.length >= 5)), 'every check says what it rests on')
  assert.ok(by('relayed-conflict')[0].note.includes('check-31mf') || by('relayed-write').some(e => e.note.includes('check-31mf')), 'the real run it comes from is named')
})

test('the timing report adds the sequential requests of a turn start against the budget of its socket (warm 2.5 s, cold 4 s), takes the slower of the two beside the write judgment, and says what is missing', async () => {
  const built = await buildMemoryFirstReplayPlan()
  const res = id => ({ status: 200, elapsedMs: 0, warmBefore: true })
  const results = { results: Object.fromEntries(built.plan.requests.map(r => [r.id, { ...res(r.id), elapsedMs: { 'own-write': 700, 'own-write-second': 500, 'own-conflict': 300, 'relayed-write': 800, 'relayed-conflict': 1500, 'contradiction-yes': 400, 'contradiction-control': 900 }[r.id] ?? 300 }])) }
  results.results['hedged-write'].warmBefore = false
  const rep = replayTimingReport(results, built.plan), chain = id => rep.chains.find(c => c.id === id)
  assert.deepEqual([chain('own').ms, chain('own').budget, chain('own').within], [1500, 2500, true]); assert.deepEqual([chain('relayed').ms, chain('relayed').within], [2300, true])
  assert.deepEqual([chain('hedged').budget, chain('hedged').within], [4000, true], 'a cold socket gets the cold budget'); assert.equal(chain('contradiction').ms, 900)
  results.results['relayed-conflict'].elapsedMs = 2100; assert.equal(replayTimingReport(results, built.plan).chains.find(c => c.id === 'relayed').within, false)
  assert.match(rep.text, /\| own-write \| 200 \| 700 \| yes \|/); assert.match(rep.text, /own \(added after the loop: write, second step, conflict \(sequential\)\) \| 3 \| 1500 \| 2500 \| yes/)
  assert.equal(replayTimingReport({ results: {} }, built.plan).chains.every(c => c.within === null), true, 'nothing answered: nothing is said to be within')
  assert.deepEqual(chainsOf().flatMap(c => c.ids).sort(), [...REPLAY_SENT].sort(), 'every sent request belongs to a chain')
})

test('the replay never sends: no network call, no key, no environment in the module or its runner script', () => {
  for (const f of ['egdesk-c41-replay.mjs', '../scripts/egdesk-c41-replay.mjs']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8')
    assert.ok(!/\bfetch\s*\(|OPENAI_API_KEY|process\.env|child_process|node:net|node:http/.test(src), f)
  }
})
