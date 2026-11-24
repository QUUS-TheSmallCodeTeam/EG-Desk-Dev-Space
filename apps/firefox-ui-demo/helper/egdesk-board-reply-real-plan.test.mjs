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
import { BOARD_AGENT_IN_EFFECT_BAR, BOARD_AGENT_RELEVANCE_BAR, localDay, readScreeningInput } from './egdesk-board-agent-context.mjs'
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

test('Board reply v2: committed bytes are the product\'s; with the pre-registered answers the product offers exactly the relevant, current excerpts', async t => {
  const calls = noNetwork(t)
  const built = await buildBoardReplyPlan(), again = await buildBoardReplyPlan()
  assert.equal(calls(), 0); assert.ok(built.planBytes.equals(again.planBytes), 'deterministic')
  const dir = committed(BOARD_REPLY_PLAN_DIR, built)
  for (const [n, r] of built.requests.entries()) {
    const sent = readScreeningInput(r.body.input)
    assert.deepEqual(sent, { question: ASKS[n].question, today: localDay(ASKED_AT), candidates: ASKS[n].excerpts.map(([, text], i) => ({ alias: `c${i + 1}`, text })) })
    assert.deepEqual(r.body.questions.map(q => q.name), [...sent.candidates.map(c => c.alias), ...sent.candidates.map(c => `${c.alias}_now`)])
    // if the model answers as pre-registered, the drafting model gets the relevant current excerpts and NOT the wrong-time one (it is dated)
    assert.deepEqual([...r.forcedSelection].sort(), r.cases.flatMap((kind, i) => (kind === 'relevant' ? [i + 1] : [])), r.id)
  }
  // today's word match (no Decisions) for comparison: it lets every wrong-time excerpt through
  const picked = kind => built.requests.flatMap(r => r.cases.map((k, i) => [k, r.localSelection.includes(i + 1)])).filter(([k, hit]) => k === kind && hit).length
  t.diagnostic(`word match selects: relevant ${picked('relevant')}/4, irrelevant ${picked('irrelevant')}/3, near_miss ${picked('near_miss')}/3, wrong_time ${picked('wrong_time')}/3`)
  assert.equal(picked('wrong_time'), 3)
  const { plan, total } = format(dir, { set: BOARD_REPLY_SET, ceiling: BOARD_REPLY_TOKEN_CEILING })
  assert.ok(BOARD_REPLY_TOKEN_CEILING <= 6000 && total < 0.9 * BOARD_REPLY_TOKEN_CEILING, `${total}: at least 10% under the ceiling (v1's actual was 3% above its estimate)`)
  assert.deepEqual([BOARD_AGENT_RELEVANCE_BAR, BELOW_BAR, BOARD_AGENT_IN_EFFECT_BAR, BELOW_IN_EFFECT], [0.6, 0.599, 0.5, 0.499], 'the plan\'s bars are the product\'s')
  const kinds = {}
  for (const [n, item] of plan.requests.entries()) for (const [i, [kind]] of ASKS[n].excerpts.entries()) {
    kinds[kind] = (kinds[kind] ?? 0) + 1; assert.ok(CASES.includes(kind))
    const mine = item.expect.filter(e => e.name === `c${i + 1}` || e.name === `c${i + 1}_now`).map(e => [e.name.endsWith('_now') ? 'now' : 'rel', e.min ?? null, e.max ?? null, e.severity])
    assert.deepEqual(mine, { relevant: [['rel', 0.6, null, 'hard'], ['now', 0.5, null, 'hard']], irrelevant: [['rel', null, 0.599, 'hard']], near_miss: [['rel', null, 0.599, 'soft']], wrong_time: [['now', null, 0.499, 'hard']] }[kind], `${item.id} c${i + 1} ${kind}`)
  }
  assert.deepEqual(kinds, { irrelevant: 3, relevant: 4, near_miss: 3, wrong_time: 3 }, 'every ask covers the four kinds; wrong-time is HARD now')
  for (const n of ASKS.map((_, i) => i)) assert.ok(ASKS[n].excerpts.length >= 4 && ASKS[n].excerpts.length <= 6)
  assert.equal(estimateBoardReplyTokens(1, 1000), estimateTokens(0, 1, 1000))
})

test('work placement v2: committed bytes are the product\'s; only content predicates, each item quoted alone; the pre-registered answers mean what the product does', async t => {
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
    // each card quoted on its own: its block names no other card
    for (const [i, [, card]] of scene.cards.entries()) { const block = r.body.input[2 + i].content; assert.ok(block.includes(card.label) && scene.cards.every(([, other]) => other === card || !block.includes(other.label))) }
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
