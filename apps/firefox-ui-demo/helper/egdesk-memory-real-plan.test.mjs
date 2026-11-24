import test from 'node:test'
import assert from 'node:assert/strict'
import { RUNS, SCOPE, buildPlan, estimateTokens, scorePlan } from './egdesk-memory-real-plan.mjs'
import { SYNTHETIC_PAGES } from './egdesk-wiki-reconstruction.fixture.mjs'

const plan = await buildPlan()
const toApi = scripted => Object.entries(scripted).map(([name, a]) => ({ name, ...a }))
const perfect = () => Object.fromEntries(plan.runs.flatMap(run => run.requests.map(r => [r.name, { status: 200, answers: toApi(r.scripted) }])))
const clone = value => JSON.parse(JSON.stringify(value))

test('six runs, every request built offline by the product code with its sha256, size and expected tokens', () => {
  assert.deepEqual(plan.runs.map(r => r.id), ['pg-first', 'pg-mid', 'a-first', 'a-mid', 'j-first', 'j-mid'])
  const all = plan.runs.flatMap(r => r.requests)
  assert.equal(plan.totals.requests, all.length)
  assert.ok(all.every(r => /^[0-9a-f]{64}$/.test(r.sha256) && r.bytes > 500 && r.estInputTokens > 100 && r.body.model === 'gpt-6-luna' && !('prompt_cache_key' in r.body)))
  assert.equal(new Set(all.map(r => r.name)).size, all.length)
  assert.equal(new Set(all.map(r => r.sha256)).size, all.length, 'every request is different')
  assert.equal(plan.totals.estInputTokens, all.reduce((n, r) => n + r.estInputTokens, 0))
  assert.equal(estimateTokens(0, 2, 1155), 499 + 0 * 1, 'the typed model reproduces the 499-token triage request of the earlier real run within rounding') // 2*134.8 + 1155*.1983 = 498.7
})

test('request order and stages follow the product loop: triage, then scan/expand, then (only when worth recording) the write judgment', () => {
  const stages = id => plan.runs.find(r => r.id === id).requests.map(r => r.stage)
  for (const id of ['pg-first', 'pg-mid']) { assert.equal(stages(id)[0], 'triage'); assert.equal(stages(id).at(-1), 'write') }
  for (const id of ['a-first', 'a-mid', 'j-first', 'j-mid']) { assert.equal(stages(id)[0], 'triage'); assert.ok(!stages(id).includes('write'), `${id}: no write request for a turn that is not worth recording`) }
  assert.ok(stages('pg-first').includes('scan') && stages('pg-first').includes('expand'))
})

test('privacy and scope hold in every built request: the private-scope page never appears; mid runs never re-send held content beyond the triage digest', () => {
  const text = r => JSON.stringify(r.body.input)
  for (const run of plan.runs) for (const r of run.requests) assert.ok(!text(r).includes('원가는 단가의 71%') && !text(r).includes('A사 내부 원가'), `${r.name} carries no private page`)
  const bodyOf = id => SYNTHETIC_PAGES.find(p => p.id === id).body
  for (const run of plan.runs.filter(r => r.position === 'mid')) {
    // The judge sees the START of each held page (<= 200 chars) in triage, scan and expand so it can tell what is already covered; a held page is never offered as an option and its full body is never re-sent.
    for (const r of run.requests.filter(r => r.stage === 'scan' || r.stage === 'expand')) for (const id of run.held) if (bodyOf(id).length > 200) assert.ok(!text(r).includes(bodyOf(id)), `${r.name} does not re-send the whole held page ${id}`)
    for (const r of run.requests.filter(r => r.stage === 'scan')) assert.match(text(r), /the start of each is shown; the rest is not repeated/)
    // The write judgment is the one place a held page's content is used again: it judges a status change against that page. Only held and picked pages are offered.
    const def = RUNS.find(x => x.id === run.id)
    for (const r of run.requests.filter(r => r.stage === 'write')) assert.ok(Object.values(r.aliases).every(id => id && [...def.held, ...def.scan, ...def.open].includes(id)), 'write candidates are held or picked pages only')
    const triage = run.requests[0]
    assert.match(text(triage), /Held in the answering model's context/); assert.match(text(triage), /status=/, 'triage shows held content digests (heldExcerpts default)')
  }
  assert.equal(SCOPE.writeScope, 'dm:this-room')
})

test('the scripted expectations score as a pass; this is the sanity check that expectations and checks agree', () => {
  const scored = scorePlan(plan, perfect())
  assert.deepEqual(scored.scored.filter(s => !s.pass).map(s => [s.id, s.hardFailures]), [])
  assert.equal(scored.runsPassed, 6); assert.equal(scored.pass, true)
  assert.ok(scored.scored.every(s => s.hardTotal >= 5), 'every run has its own hard checks')
})

test('the scorer catches what the pre-registration forbids: wrong skip, off-topic pick, missing must-pick, wrong write target, wrong status, unanswered or failed request', () => {
  const mutate = (fn) => { const r = clone(perfect()); fn(r); return scorePlan(plan, r) }
  const names = (scored, id) => scored.scored.find(s => s.id === id).hardFailures
  const find = (runId, stage, nth = 0) => plan.runs.find(r => r.id === runId).requests.filter(r => r.stage === stage)[nth]
  // mid triage: need decided "no" with recall no and a complete list is a skip: the T4 failure
  let r = mutate(res => { res[find('pg-mid', 'triage').name].answers.find(a => a.name === 'tn_need').probability = 0.02 })
  assert.match(names(r, 'pg-mid').join('|'), /triage does not skip the fetch/); assert.equal(r.pass, false, 'a triage hard failure fails the whole measurement')
  // off-topic pick
  r = mutate(res => { const req = find('a-first', 'scan'); const alias = Object.entries(req.aliases).find(([, id]) => id === 'quote/b-v1')[0]; res[req.name].answers.find(a => a.name === `pg_${Number(alias.slice(1)) - 1}`).probability = 0.95 })
  assert.match(names(r, 'a-first').join('|'), /scan does not pick quote\/b-v1/)
  // missing must-pick
  r = mutate(res => { const req = find('j-first', 'scan'); const alias = Object.entries(req.aliases).find(([, id]) => id === 'jev/flow-note')[0]; res[req.name].answers.find(a => a.name === `pg_${Number(alias.slice(1)) - 1}`).probability = 0.5 })
  assert.match(names(r, 'j-first').join('|'), /scan picks jev\/flow-note/)
  // wrong write target and status
  r = mutate(res => { const req = find('pg-first', 'write'); const a = res[req.name].answers.find(x => x.name === 'tw_target'); a.choice = 'new'; a.probabilities = [{ value: 'new', probability: 0.95 }, { value: 'none', probability: 0.01 }] })
  assert.match(names(r, 'pg-first').join('|'), /write target is db\/pg-plan/)
  r = mutate(res => { const req = find('pg-mid', 'write'); const a = res[req.name].answers.find(x => x.name === 'tw_status'); a.choice = 'plan'; a.probabilities = [{ value: 'plan', probability: 0.95 }, { value: 'done', probability: 0.02 }, { value: 'unknown', probability: 0.03 }] })
  assert.match(names(r, 'pg-mid').join('|'), /write status is done/)
  // wrong status reading of the plan page
  r = mutate(res => { const req = find('pg-first', 'expand'); const alias = Object.entries(req.aliases).find(([, id]) => id === 'db/pg-plan')[0]; const a = res[req.name].answers.find(x => x.name === `st_${alias}`); a.choice = 'done'; a.probabilities = [{ value: 'done', probability: 0.95 }, { value: 'plan', probability: 0.02 }] })
  assert.match(names(r, 'pg-first').join('|'), /status of db\/pg-plan reads as plan/)
  // failed / untyped request
  r = mutate(res => { res[find('a-mid', 'triage').name] = { status: 429, answers: [] } })
  assert.match(names(r, 'a-mid').join('|'), /HTTP 200/)
  r = mutate(res => { res[find('a-mid', 'scan').name].answers.pop() })
  assert.match(names(r, 'a-mid').join('|'), /every question answered/)
  // the pass rule: one failed run out of six still passes, two do not (when triage is intact)
  r = mutate(res => { const req = find('a-first', 'scan'); const alias = Object.entries(req.aliases).find(([, id]) => id === 'quote/b-v1')[0]; res[req.name].answers.find(a => a.name === `pg_${Number(alias.slice(1)) - 1}`).probability = 0.95 })
  assert.deepEqual([r.runsPassed, r.pass], [5, true])
  r = mutate(res => { for (const id of ['a-first', 'j-first']) { const req = find(id, 'scan'); const other = id === 'a-first' ? 'quote/b-v1' : 'db/redis'; const alias = Object.entries(req.aliases).find(([, x]) => x === other)?.[0]; if (alias) res[req.name].answers.find(a => a.name === `pg_${Number(alias.slice(1)) - 1}`).probability = 0.95 } })
  assert.ok(r.runsPassed <= 5)
})

test('pre-registration is explicit for all six runs: triage, picks, statuses, write target', () => {
  assert.equal(RUNS.length, 6)
  for (const run of RUNS) {
    assert.ok(run.hard.triage && run.hard.mustPick?.length >= 1, run.id)
    assert.equal(run.hard.triage.record, run.write ? 'yes' : 'no')
    if (run.position === 'mid') assert.ok(run.hard.heldNeverScanned && run.hard.triage.needNotNo && run.held.length >= 2)
  }
  assert.deepEqual(RUNS.filter(r => r.write).map(r => r.id), ['pg-first', 'pg-mid'])
})

test('the scorer replays the real 2026-11-24 answers: the pg-mid scan miss is reproduced; the j-mid wrong skip is now prevented by the rule', async () => {
  const { readFile } = await import('node:fs/promises')
  const real = JSON.parse(await readFile(new URL('./fixtures/memory-e2e-real-20261124.json', import.meta.url), 'utf8')).requests
  assert.equal(Object.keys(real).length, 23)
  const scored = scorePlan(plan, real)
  // The triage question set grew (tn_recall) after that run, so completeness of the mid triage requests is not comparable; everything else is.
  const failures = Object.fromEntries(scored.scored.map(s => [s.id, s.hardFailures.filter(f => !/every question answered/.test(f))]))
  // j-mid: the real answers (need 0.02, no recall answer) were a wrong skip under the old rule. Under the current rule an undecided recall never skips,
  // so the same real answers no longer fail the outcome check; the weak need judgement is still reported as a soft miss below.
  assert.deepEqual(failures, { 'pg-first': [], 'pg-mid': ['scan picks db/pg-health'], 'a-first': [], 'a-mid': [], 'j-first': [], 'j-mid': [] })
  assert.ok(scored.scored.find(x => x.id === 'j-mid').softMisses.includes('triage need is not a decided "no"'))
  const soft = Object.fromEntries(scored.scored.map(s => [s.id, s.softMisses.filter(m => !/recall/.test(m))]))
  assert.deepEqual(soft['j-first'], ['scan picks jev/utt-user', 'scan picks jev/draft', 'link to jev/utt-agent is opened'])
  assert.deepEqual(soft['pg-first'], ['link to db/sqlite-schema is opened', 'link to db/pg-followup is opened'])
})

// ---- the small re-measurement: failing stages plus controls ----
import { CONTROLS, REMEASURE, scoreRemeasure } from './egdesk-memory-real-plan.mjs'
const small = await buildPlan({ subset: 'remeasure' })
const smallPerfect = () => Object.fromEntries(small.runs.flatMap(run => run.requests.map(r => [r.name, { status: 200, answers: toApi(r.scripted) }])))
const smallFind = name => small.runs.flatMap(r => r.requests).find(r => r.name === name)

test('re-measurement: exactly the failing stages and the controls, rebuilt by the current product code', () => {
  const names = small.runs.flatMap(r => r.requests.map(q => q.name))
  assert.deepEqual(names, REMEASURE)
  assert.deepEqual(small.runs.map(r => r.id), ['pg-mid', 'a-first', 'j-mid', 't6-covered'])
  assert.equal(small.totals.requests, 6); assert.ok(small.totals.estInputTokens < 14000)
  const text = name => JSON.stringify(smallFind(name).body.input)
  assert.match(text('j-mid-1-triage'), /Stored pages that are not held \(titles only\)/); assert.match(text('j-mid-1-triage'), /jev hook 흐름 메모\(오늘 오전\)/)
  assert.deepEqual(smallFind('j-mid-1-triage').body.questions.map(q => q.name), ['tn_courtesy', 'tn_need', 'tn_recall', 'tn_record'])
  assert.match(text('pg-mid-2-scan'), /the start of each is shown; the rest is not repeated/); assert.match(text('pg-mid-2-scan'), /how success is judged, what is left to do, and what to do if it failed/)
  for (const r of small.runs.flatMap(x => x.requests)) assert.ok(!JSON.stringify(r.body).includes('원가는 단가의 71%'))
})

test('re-measurement scoring: the scripted expectations pass; a missing health page, a wrong skip, a regression on the control scan and an uncovered control are caught', () => {
  assert.deepEqual([scoreRemeasure(small, smallPerfect()).pass, scoreRemeasure(small, smallPerfect()).runsPassed], [true, 4])
  const run = fn => { const r = clone(smallPerfect()); fn(r); return scoreRemeasure(small, r) }
  const set = (res, name, id, p) => { const req = smallFind(name); const alias = Object.entries(req.aliases).find(([, x]) => x === id)[0]; res[name].answers.find(a => a.name === `pg_${Number(alias.slice(1)) - 1}`).probability = p }
  let r = run(res => set(res, 'pg-mid-2-scan', 'db/pg-health', 0.37))
  assert.deepEqual(r.scored.find(s => s.id === 'pg-mid').hardFailures, ['scan picks db/pg-health']); assert.equal(r.pass, false)
  r = run(res => { const a = res['j-mid-1-triage'].answers; a.find(x => x.name === 'tn_need').probability = 0.02; a.find(x => x.name === 'tn_recall').probability = 0.02 })
  assert.match(r.scored.find(s => s.id === 'j-mid').hardFailures.join('|'), /triage does not skip the fetch/)
  r = run(res => { const a = res['j-mid-1-triage'].answers; a.find(x => x.name === 'tn_need').probability = 0.02; a.find(x => x.name === 'tn_recall').probability = 0.97 })
  assert.deepEqual(r.scored.find(s => s.id === 'j-mid').hardFailures, [], 'need no with recall yes is not a skip: only a soft note')
  r = run(res => set(res, 'a-first-2-scan', 'quote/b-v1', 0.9))
  assert.match(r.scored.find(s => s.id === 'a-first').hardFailures.join('|'), /scan does not pick quote\/b-v1/)
  r = run(res => { res['t6-covered-1-triage'].answers.find(x => x.name === 'tn_need').probability = 0.9 })
  const t6 = r.scored.find(s => s.id === 't6-covered')
  assert.deepEqual([t6.pass, t6.softMisses.length > 0], [true, true], 'a control that fetches instead of skipping costs tokens, not material: soft')
  r = run(res => { res['t6-covered-1-triage'].answers.find(x => x.name === 'tn_courtesy').probability = 0.97 })
  assert.equal(r.scored.find(s => s.id === 't6-covered').pass, false, 'a courtesy yes on a real question is a wrong skip')
})

// ---- the two-request check of the first-turn scan wording ----
import { createHash } from 'node:crypto'
import { FIRST_SCAN, FIRST_SCAN_EXPECT, scoreFirstScan } from './egdesk-memory-real-plan.mjs'
import { JUDGE_RULES, NEXT_RULES } from './egdesk-wiki-reconstruction.mjs'
const firstScan = await buildPlan({ subset: 'first-scan' })
const scanAnswers = (request, yes, p = {}) => ({ status: 200, answers: request.body.questions.map(q => { const id = request.aliases[`P${Number(q.name.slice(3)) + 1}`]
  return { type: 'predicate', name: q.name, probability: id in p ? p[id] : yes.includes(id) ? 0.97 : 0.02 } }) })
const firstScanResults = (overrides = {}) => Object.fromEntries(firstScan.runs.flatMap(run => run.requests.map(request =>
  [request.name, scanAnswers(request, [...FIRST_SCAN_EXPECT[request.name].yes, ...FIRST_SCAN_EXPECT[request.name].wanted], overrides[request.name] ?? {})])))

test('first-scan set: exactly the two first-turn scans, built by the product code, and nothing else', async () => {
  const requests = firstScan.runs.flatMap(r => r.requests)
  assert.deepEqual(requests.map(r => r.name), FIRST_SCAN)
  assert.deepEqual(requests.map(r => [r.stage, r.questions, r.choice]), [['scan', 31, 0], ['scan', 31, 0]])
  assert.equal(firstScan.totals.requests, 2)
  assert.ok(firstScan.totals.estInputTokens > 10000 && firstScan.totals.estInputTokens < 15000, String(firstScan.totals.estInputTokens))
  for (const r of requests) { assert.equal(r.body.input[0].content, JUDGE_RULES); assert.ok(!JSON.stringify(r.body).includes('A사 내부 원가'), 'the page outside this DM is not in the request') }
  await assert.rejects(buildPlan({ subset: 'nope' }), /unknown request set/)
})

test('first-scan scoring: the off-topic page must be a decided no; undecided is inconclusive (not a pass, not called a wrong pick); the target of the other run must stay picked', () => {
  const perfect = scoreFirstScan(firstScan, firstScanResults())
  assert.deepEqual([perfect.pass, perfect.runsPassed, perfect.scored.flatMap(s => s.softMisses)], [true, 2, []])
  const picked = scoreFirstScan(firstScan, firstScanResults({ 'pg-first-2-scan': { 'jev/flow-note': 0.87 } }))
  assert.deepEqual(picked.scored[0].hardFailures, ['jev/flow-note is decided not needed', 'no page of another matter is picked']); assert.equal(picked.pass, false)
  const undecided = scoreFirstScan(firstScan, firstScanResults({ 'pg-first-2-scan': { 'jev/flow-note': 0.5 } }))
  assert.deepEqual(undecided.scored[0].hardFailures, ['jev/flow-note is decided not needed'])
  assert.match(undecided.scored[0].checks.find(c => c.name === 'jev/flow-note is decided not needed').detail, /undecided.*inconclusive/)
  // the gain of the broader wording is watched, softly: losing the health page on the first turn is reported but does not fail the check
  const lost = scoreFirstScan(firstScan, firstScanResults({ 'pg-first-2-scan': { 'db/pg-health': 0.1 } }))
  assert.deepEqual([lost.pass, lost.scored[0].softMisses], [true, ['db/pg-health is picked']])
  const noPlan = scoreFirstScan(firstScan, firstScanResults({ 'pg-first-2-scan': { 'db/pg-plan': 0.4 } }))
  assert.deepEqual(noPlan.scored[0].hardFailures, ['db/pg-plan is picked'])
  // the tighter wording must not cost the run whose target IS that page
  const jLost = scoreFirstScan(firstScan, firstScanResults({ 'j-first-2-scan': { 'jev/flow-note': 0.3 } }))
  assert.deepEqual([jLost.pass, jLost.scored[1].hardFailures], [false, ['jev/flow-note is picked']])
  const jStray = scoreFirstScan(firstScan, firstScanResults({ 'j-first-2-scan': { 'db/pg-plan': 0.9 } }))
  assert.deepEqual(jStray.scored[1].hardFailures, ['no page of another matter is picked'])
  assert.equal(scoreFirstScan(firstScan, {}).pass, false, 'not sent is not a pass')
})

test('rule texts: the first-turn rule is tied to the matter of the message; the mid-session rule is byte-identical to the one measured on 2026-11-24', () => {
  assert.match(JUDGE_RULES, /a record about the same matter as the message/); assert.match(JUDGE_RULES, /decide, verify or do what this message calls for/)
  assert.match(JUDGE_RULES, /A page about a different matter is not needed merely because it mentions or describes the same kind of event/)
  assert.equal(createHash('sha256').update(NEXT_RULES).digest('hex'), 'ad6fc8aba1ae21c44005f62a7897085af7c2fb52fc070711141d846144c62fb7')
})

// ---- labelling an utterance once, at page creation ----
import { UTTERANCE_LABELS, buildUtterancePlan, scoreUtteranceLabels } from './egdesk-memory-real-plan.mjs'
const utterances = await buildUtterancePlan()
const choice = (q, value, p) => ({ type: 'choice', name: q.name, choice: value, confidence: p, probabilities: [{ value, probability: p }, ...q.choices.filter(c => c.value !== value).map(c => ({ value: c.value, probability: (1 - p) / (q.choices.length - 1) }))] })
// Answers as registered; overrides: { [runId]: { [questionName]: [value, probability] } }
const labelResults = (overrides = {}) => Object.fromEntries(utterances.runs.map(run => { const def = UTTERANCE_LABELS.find(d => d.id === run.id), request = run.requests[0]
  return [request.name, { status: 200, answers: request.body.questions.map(q => { const o = overrides[run.id]?.[q.name]
    if (o) return choice(q, o[0], o[1])
    if (q.name === 'tw_target') return choice(q, 'new', 0.95)
    if (q.name === 'tw_status') return choice(q, def.page.status, 0.95)
    return choice(q, def.labels[q.name.split('_')[1]], 0.95) }) }] }))

test('utterance-label set: three page-creation requests built by the write judgment itself, one isolated sentence each, no candidate page', () => {
  assert.deepEqual(utterances.runs.map(r => r.requests.map(q => [q.name, q.stage, q.questions, q.choice])), UTTERANCE_LABELS.map(d => [[`${d.id}-write`, 'write', 5, 5]]))
  assert.equal(utterances.totals.requests, 3); assert.ok(utterances.totals.estInputTokens > 3000 && utterances.totals.estInputTokens < 5000, String(utterances.totals.estInputTokens))
  for (const [i, run] of utterances.runs.entries()) {
    const body = run.requests[0].body, def = UTTERANCE_LABELS[i]
    assert.deepEqual(body.questions.map(q => q.name), ['tw_target', 'tw_status', 'speech_source_0', 'speech_form_0', 'speech_time_0'])
    assert.deepEqual(body.questions[0].choices.map(c => c.value), ['new', 'none', 'unsure'])
    for (const q of body.questions.slice(2)) assert.ok(q.instructions.includes(`Judge only this one sentence, quoted exactly as a JSON string: ${JSON.stringify(def.message)}.`))
    assert.ok(body.input.some(m => m.content.includes('Candidate pages:\n(none)')) && body.input.at(-1).content.endsWith(`Message:\n${def.message}`))
  }
})

test('utterance-label scoring: a wrong INSTALLED label fails; a label that is not installed does not, but fewer than 6 of 9 installed is not a pass', () => {
  const perfect = scoreUtteranceLabels(utterances, labelResults())
  assert.deepEqual([perfect.pass, perfect.runsPassed, perfect.installed, perfect.axes, perfect.bars, perfect.scored.flatMap(s => [...s.hardFailures, ...s.softMisses])], [true, 3, 9, 9, { confidence: 0.85, margin: 0.2 }, []])
  const wrong = scoreUtteranceLabels(utterances, labelResults({ 'u1-relayed-past': { speech_source_0: ['self_reported_observation', 0.95] } }))
  assert.deepEqual([wrong.pass, wrong.scored[0].hardFailures], [false, ['source: an installed label is the registered one']])
  // the same wrong value below the bar is not installed: nothing misleading is stored, so it is a soft miss only
  const low = scoreUtteranceLabels(utterances, labelResults({ 'u1-relayed-past': { speech_source_0: ['self_reported_observation', 0.6] } }))
  assert.deepEqual([low.pass, low.installed, low.scored[0].hardFailures, low.scored[0].softMisses], [true, 8, [], ['source: installed', 'page attributes as registered']])
  // flat answers everywhere (what the offset design gave): no wrong label, but the labelling did nothing
  const flat = scoreUtteranceLabels(utterances, labelResults(Object.fromEntries(UTTERANCE_LABELS.map(d => [d.id, { speech_source_0: [d.labels.source, 0.3], speech_form_0: [d.labels.form, 0.3], speech_time_0: [d.labels.time, 0.3] }]))))
  assert.deepEqual([flat.pass, flat.installed, flat.scored.every(s => s.hardFailures.length === 0)], [false, 0, true])
  const five = scoreUtteranceLabels(utterances, labelResults({ 'u1-relayed-past': { speech_source_0: ['attributed_report', 0.3], speech_time_0: ['past_anchored', 0.3] }, 'u2-own-plan': { speech_source_0: ['unspecified', 0.3], speech_time_0: ['future_anchored', 0.3] } }))
  assert.deepEqual([five.installed, five.pass], [5, false])
  // not recorded as a new page: reported, soft
  const none = scoreUtteranceLabels(utterances, labelResults({ 'u3-own-observation': { tw_target: ['none', 0.95] } }))
  assert.deepEqual([none.pass, none.scored[2].softMisses], [true, ['recorded as a new page']])
  assert.equal(scoreUtteranceLabels(utterances, {}).pass, false, 'not sent is not a pass')
})
