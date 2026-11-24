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
