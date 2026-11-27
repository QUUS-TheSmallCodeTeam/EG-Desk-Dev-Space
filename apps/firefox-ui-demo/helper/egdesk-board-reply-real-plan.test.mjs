// Lane L1's real-measurement plans (cycle 12): Board reply screening v2 (relevance + "still in effect today?") and work placement v2 (content
// predicates). The committed plans are exactly what the product code builds today, they fit the generic runner's declarative format and its loader,
// the pre-registered answers mean what the product's own code does with them, and building them sends nothing. No network, no key.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASKED_AT, ASKS, BELOW_BAR, BELOW_IN_EFFECT, BOARD_REPLY_PLAN_DIR, BOARD_REPLY_SET, BOARD_REPLY_TOKEN_CEILING, CASES, buildBoardReplyPlan, estimateBoardReplyTokens } from './egdesk-board-reply-real-plan.mjs'
import { BELOW_YES, PLACEMENT_PLAN_DIR, PLACEMENT_SET, PLACEMENT_TOKEN_CEILING, RESULTS, SCENES, buildPlacementPlan, estimatePlacementTokens } from './egdesk-work-placement-real-plan.mjs'
import { REMEASURE_ASKS, REMEASURE_PLAN_DIR, REMEASURE_SET, REMEASURE_TOKEN_CEILING, buildRemeasurePlan } from './egdesk-l1-remeasure-plan.mjs'
import { BOARD_AGENT_IN_EFFECT_BAR, BOARD_AGENT_RELEVANCE_BAR, localDay, questionDate, readScreeningInput } from './egdesk-board-agent-context.mjs'
import { PLACEMENT_PREDICATE_YES } from './egdesk-work-placement.mjs'
import { DECISIONS_ENDPOINT, DECISION_MODEL, validateDecisionRequest } from './egdesk-decision-client.mjs'
import { estimateTokens } from './egdesk-memory-real-plan.mjs'
import { loadPlan } from './egdesk-decision-real-runner.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const noNetwork = t => { const realFetch = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('no network in this test') }; t.after(() => { globalThis.fetch = realFetch }); return () => calls }
function committed(dirName, built) {
  const dir = path.join(here, '..', dirName)
  assert.ok(readFileSync(path.join(dir, 'plan.json')).equals(built.planBytes), `${dirName}/plan.json is stale: run node scripts/egdesk-board-reply-real-plan.mjs --write`)
  assert.deepEqual(readdirSync(path.join(dir, 'requests')).sort(), built.requests.map(r => path.basename(r.file)).sort(), 'no other file in the plan directory')
  for (const r of built.requests) { assert.ok(readFileSync(path.join(dir, r.file)).equals(r.bytes), `${r.file} is stale`); assert.equal(r.url, DECISIONS_ENDPOINT) }
  return dir
}
function format(dir, { set, ceiling }) {
  const plan = JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8'))
  assert.deepEqual(Object.keys(plan), ['set', 'tokenCeiling', 'passRule', 'requests']); assert.deepEqual([plan.set, plan.tokenCeiling], [set, ceiling])
  let total = 0
  for (const item of plan.requests) {
    assert.deepEqual(Object.keys(item), ['id', 'file', 'sha256', 'estInputTokens', 'expect']); assert.equal(item.file, `requests/${item.id}.json`)
    const bytes = readFileSync(path.join(dir, item.file)); assert.equal(sha256(bytes), item.sha256, 'sha256 of the exact file bytes')
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); assert.equal(body.model, DECISION_MODEL)
    validateDecisionRequest({ input: body.input, questions: body.questions, promptCacheKey: body.prompt_cache_key ?? null, safetyIdentifier: null })
    assert.ok(body.questions.every(q => q.type === 'predicate'), 'yes/no predicates only (R2)')
    for (const e of item.expect) assert.ok(body.questions.some(q => q.name === e.name) && e.kind === 'predicate' && ['hard', 'soft'].includes(e.severity), e.name)
    assert.equal(item.estInputTokens, estimateTokens(0, body.questions.length, bytes.length), 'the runner\'s typed token model'); total += item.estInputTokens
    for (const secret of [/egd-synthetic/, /Bearer/i, /egask1-/, /acct-/, /"x"\s*:/, /c-quote|c-lunch|agent-result|board-reply-plan/, /00000000-0000-4000/]) assert.doesNotMatch(bytes.toString('utf8'), secret)
  }
  assert.ok(total <= plan.tokenCeiling, `estimated ${total} input tokens`)
  const loaded = loadPlan(path.join(dir, 'plan.json')) // the generic runner's own loader (lane L6): re-hashes, validates, never sends
  assert.deepEqual([loaded.set, loaded.totals.estInputTokens, loaded.totals.independentEst], [set, total, total])
  return { plan, total }
}

test('Board reply v3: committed bytes are the product\'s; two requests per ask; with the pre-registered answers the product offers exactly the relevant, current excerpts', async t => {
  const calls = noNetwork(t)
  const built = await buildBoardReplyPlan(), again = await buildBoardReplyPlan()
  assert.equal(calls(), 0); assert.ok(built.planBytes.equals(again.planBytes), 'deterministic')
  const dir = committed(BOARD_REPLY_PLAN_DIR, built)
  assert.deepEqual(built.requests.map(r => r.id), ASKS.flatMap(a => [a.id, `${a.id}-now`]))
  for (const [n, ask] of ASKS.entries()) {
    const rel = built.requests[2 * n], now = built.requests[2 * n + 1]
    assert.deepEqual(readScreeningInput(rel.body.input), { question: ask.question, today: localDay(ASKED_AT), candidates: ask.excerpts.map(([, text], i) => ({ alias: `c${i + 1}`, text })) })
    assert.deepEqual(rel.body.questions.map(q => q.name), ask.excerpts.map((_, i) => `c${i + 1}`), 'stage 1: relevance only')
    // stage 2: only the excerpts the (pre-registered) relevance answers select, i.e. the relevant and the wrong-time ones; never the irrelevant or near-miss
    const selected = ask.excerpts.flatMap(([kind], i) => (['relevant', 'wrong_time'].includes(kind) ? [i] : []))
    const date = questionDate(ask.question, ASKED_AT)
    assert.deepEqual(readScreeningInput(now.body.input), { question: ask.question, today: localDay(ASKED_AT), ...(date.stated ? { about: date.when } : {}), candidates: selected.map(i => ({ alias: `c${i + 1}`, text: ask.excerpts[i][1] })) })
    assert.deepEqual(now.body.questions.map(q => q.instructions), selected.map(i => `Does the arrangement this excerpt describes (excerpt c${i + 1}) still apply ${date.stated ? (date.when.length === 7 ? `in ${date.when}` : `on ${date.when}`) : `today (${date.when})`}?`))
    // if the model answers as pre-registered, the drafting model gets the relevant current excerpts and NOT the wrong-time one (it is dated)
    assert.deepEqual([...rel.forcedSelection].sort(), rel.cases.flatMap((kind, i) => (kind === 'relevant' ? [i + 1] : [])), ask.id)
  }
  assert.deepEqual(ASKS.map(a => questionDate(a.question, ASKED_AT).when), ['2026-11-27', '2026-11-24', '2026-12'], 'the dates the questions are about, by code')
  const picked = kind => built.requests.filter(r => r.stage === 'relevance').flatMap(r => r.cases.map((k, i) => [k, r.localSelection.includes(i + 1)])).filter(([k, hit]) => k === kind && hit).length
  t.diagnostic(`word match selects: relevant ${picked('relevant')}/4, irrelevant ${picked('irrelevant')}/3, near_miss ${picked('near_miss')}/3, wrong_time ${picked('wrong_time')}/3`)
  assert.equal(picked('wrong_time'), 3)
  const { plan, total } = format(dir, { set: BOARD_REPLY_SET, ceiling: BOARD_REPLY_TOKEN_CEILING })
  assert.ok(BOARD_REPLY_TOKEN_CEILING <= 6000 && total < 0.9 * BOARD_REPLY_TOKEN_CEILING, `${total}`)
  assert.deepEqual([BOARD_AGENT_RELEVANCE_BAR, BELOW_BAR, BOARD_AGENT_IN_EFFECT_BAR, BELOW_IN_EFFECT], [0.6, 0.599, 0.5, 0.499], 'the plan\'s bars are the product\'s')
  const kinds = {}
  for (const [n, ask] of ASKS.entries()) for (const [i, [kind]] of ask.excerpts.entries()) {
    kinds[kind] = (kinds[kind] ?? 0) + 1; assert.ok(CASES.includes(kind))
    const mine = [...plan.requests[2 * n].expect, ...plan.requests[2 * n + 1].expect].filter(e => e.name === `c${i + 1}` || e.name === `c${i + 1}_now`).map(e => [e.name.endsWith('_now') ? 'now' : 'rel', e.min ?? null, e.max ?? null, e.severity])
    assert.deepEqual(mine, { relevant: [['rel', 0.6, null, 'hard'], ['now', 0.5, null, 'hard']], irrelevant: [['rel', null, 0.599, 'hard']], near_miss: [['rel', null, 0.599, 'soft']], wrong_time: [['now', null, 0.499, 'hard']] }[kind], `${ask.id} c${i + 1} ${kind}`)
  }
  assert.deepEqual(kinds, { irrelevant: 3, relevant: 4, near_miss: 3, wrong_time: 3 }, 'every ask covers the four kinds; wrong-time is HARD')
  assert.equal(estimateBoardReplyTokens(1, 1000), estimateTokens(0, 1, 1000))
})

test('work placement v3: committed bytes are the product\'s; only content predicates, each card inside its own question; the pre-registered answers mean what the product does', async t => {
  const calls = noNetwork(t)
  const built = await buildPlacementPlan(), again = await buildPlacementPlan()
  assert.equal(calls(), 0); assert.ok(built.planBytes.equals(again.planBytes), 'deterministic')
  const dir = committed(PLACEMENT_PLAN_DIR, built)
  const { plan, total } = format(dir, { set: PLACEMENT_SET, ceiling: PLACEMENT_TOKEN_CEILING })
  assert.ok(PLACEMENT_TOKEN_CEILING <= 5000 && total < 0.9 * PLACEMENT_TOKEN_CEILING, `${total}`)
  assert.deepEqual([PLACEMENT_PREDICATE_YES, BELOW_YES], [0.8, 0.799])
  assert.deepEqual(plan.requests.map(r => r.id), [...SCENES.map(s => s.id), ...RESULTS.map(r => r.id)])
  for (const [n, scene] of SCENES.entries()) {
    const r = built.requests[n]
    assert.deepEqual(r.body.questions.map(q => q.name), scene.cards.map((_, i) => `same_matter_R${i + 1}`))
    assert.match(r.body.input[1].content, new RegExp(`The person's request:\\n"""\\n${scene.request}\\n"""`))
    // v3 isolation: the shared input holds the request only; each card is inside its own question and no other
    assert.equal(r.body.input.length, 2); for (const [, card] of scene.cards) assert.ok(!r.body.input.some(m => m.content.includes(card.label)), card.label)
    for (const [i, q] of r.body.questions.entries()) { const [, card] = scene.cards.find(([, c]) => q.instructions.includes(c.label)) ?? []; assert.ok(card, q.name); assert.ok(scene.cards.every(([, other]) => other === card || !q.instructions.includes(other.label)), `${q.name} names one card`); assert.equal(i, r.body.questions.indexOf(q)) }
    assert.equal(new Set(r.body.questions.map(q => q.instructions)).size, r.body.questions.length, 'no two questions are the same question')
    // with the pre-registered answers the product places the surface beside the same-matter card
    assert.deepEqual([r.outcome.kind, r.outcome.source], ['beside_related', 'decision'])
    const yes = plan.requests[n].expect.filter(e => e.min === 0.8).map(e => e.name)
    assert.deepEqual([r.outcome.related], yes.map(name => name.replace('same_matter_', '')))
    assert.ok(plan.requests[n].expect.every(e => (e.note.startsWith('near_miss') ? e.severity === 'soft' : e.severity === 'hard')))
  }
  for (const [n, result] of RESULTS.entries()) {
    const r = built.requests[SCENES.length + n]
    assert.deepEqual(r.body.questions.map(q => q.name), ['owner_action']); assert.ok(r.body.input.some(m => m.content.includes(result.answer)) && r.body.input.some(m => m.content.includes(result.request)))
    assert.deepEqual([r.outcome.branch, r.outcome.source], [result.kind === 'yes' ? 'owner' : 'requester', 'decision'], 'yes: the owner is the one to tell; no: the requester')
    assert.deepEqual(plan.requests[SCENES.length + n].expect, [{ name: 'owner_action', kind: 'predicate', ...(result.kind === 'yes' ? { min: 0.8 } : { max: 0.799 }), severity: 'hard', note: `${result.kind}: ${result.note}` }])
  }
  assert.equal(estimatePlacementTokens(2, 500), estimateTokens(0, 2, 500))
})

test('re-measure plan (cycle 13): the two v2 failures, product-built; both isolations of same_matter; the arrangement wording on the failed excerpts with controls; under 5k', async t => {
  const calls = noNetwork(t)
  const built = await buildRemeasurePlan(), again = await buildRemeasurePlan()
  assert.equal(calls(), 0); assert.ok(built.planBytes.equals(again.planBytes), 'deterministic')
  const dir = committed(REMEASURE_PLAN_DIR, built)
  const { plan, total } = format(dir, { set: REMEASURE_SET, ceiling: REMEASURE_TOKEN_CEILING })
  assert.ok(total <= REMEASURE_TOKEN_CEILING && total < 0.95 * REMEASURE_TOKEN_CEILING, `${total}: v2's actual was up to 4% above its estimate`)
  assert.deepEqual(plan.requests.map(r => r.id), ['pl-same-matter-quote', 'pl-same-matter-report', ...['quote', 'report'].flatMap(s => [1, 2, 3].map(i => `pl-same-matter-${s}-R${i}`)), ...REMEASURE_ASKS.map(a => `${a}-now`)])
  // one card per request: the same questions as the grouped request, one each, with the same shared input
  const { byQuestion, byRequest, board } = built.groups
  for (const [n, grouped] of byQuestion.entries()) for (const [i, q] of grouped.body.questions.entries()) {
    const one = byRequest[3 * n + i]; assert.deepEqual(one.body.questions, [q]); assert.deepEqual(one.body.input, grouped.body.input)
    assert.deepEqual(one.expect, grouped.expect.filter(e => e.name === q.name))
  }
  const cost = list => list.reduce((sum, r) => sum + plan.requests.find(p => p.id === r.id).estInputTokens, 0)
  t.diagnostic(`same_matter tokens: one card per question ${cost(byQuestion)}, one card per request ${cost(byRequest)}; arrangement ${cost(board)}; total ${total}`)
  assert.ok(cost(byRequest) > cost(byQuestion))
  // the two excerpts v2 judged still in effect, hard, each with a still-valid control in the same request
  const failed = ['2025년 가을 설명회까지는', '2025년 가을 학기 워크숍은']
  for (const [n, r] of board.entries()) {
    const sent = readScreeningInput(r.body.input), wrong = sent.candidates.find(c => c.text.startsWith(failed[n])), controls = sent.candidates.filter(c => c !== wrong)
    assert.ok(wrong && controls.length >= 1, r.id)
    assert.deepEqual(r.expect.find(e => e.name === `${wrong.alias}_now`), { name: `${wrong.alias}_now`, kind: 'predicate', max: 0.499, severity: 'hard', note: r.expect.find(e => e.name === `${wrong.alias}_now`).note })
    for (const c of controls) assert.equal(r.expect.find(e => e.name === `${c.alias}_now`).min, 0.5)
  }
})
