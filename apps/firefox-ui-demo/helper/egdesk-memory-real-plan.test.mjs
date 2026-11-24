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
    for (const r of run.requests.filter(r => r.stage === 'scan' || r.stage === 'expand')) for (const id of run.held) assert.ok(!text(r).includes(bodyOf(id)), `${r.name} does not re-send held page ${id}`)
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
  // mid triage: need decided "no" is the T4 failure
  let r = mutate(res => { res[find('pg-mid', 'triage').name].answers.find(a => a.name === 'tn_need').probability = 0.02 })
  assert.match(names(r, 'pg-mid').join('|'), /need is not a decided "no"/); assert.equal(r.pass, false, 'a triage hard failure fails the whole measurement')
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
