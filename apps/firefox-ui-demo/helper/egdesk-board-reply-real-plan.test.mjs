// The Board reply screening measurement plan (L1 cycle 10): the committed plan is exactly what the product code builds today, it fits the
// generic runner's declarative format, and building it sends nothing. No network, no key: the Decisions client and the drafting API are recorders.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ASKS, BELOW_BAR, BOARD_REPLY_PLAN_DIR, BOARD_REPLY_SET, BOARD_REPLY_TOKEN_CEILING, CASES, buildBoardReplyPlan, estimateBoardReplyTokens } from './egdesk-board-reply-real-plan.mjs'
import { BOARD_AGENT_RELEVANCE_BAR } from './egdesk-board-agent-context.mjs'
import { DECISIONS_ENDPOINT, DECISION_MODEL, validateDecisionRequest } from './egdesk-decision-client.mjs'
import { estimateTokens } from './egdesk-memory-real-plan.mjs'

const here = path.dirname(fileURLToPath(import.meta.url)), dir = path.join(here, '..', BOARD_REPLY_PLAN_DIR)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

test('the committed plan is what the product builds, byte for byte, and building it sends nothing', async t => {
  const realFetch = globalThis.fetch; let network = 0
  globalThis.fetch = async () => { network++; throw new Error('no network in this test') }
  t.after(() => { globalThis.fetch = realFetch })
  const built = await buildBoardReplyPlan(), again = await buildBoardReplyPlan()
  assert.equal(network, 0, 'nothing went to the network')
  assert.ok(built.planBytes.equals(again.planBytes), 'the build is deterministic')
  assert.ok(readFileSync(path.join(dir, 'plan.json')).equals(built.planBytes), 'plan.json is stale: run node scripts/egdesk-board-reply-real-plan.mjs --write')
  assert.deepEqual(readdirSync(path.join(dir, 'requests')).sort(), built.requests.map(r => path.basename(r.file)).sort(), 'no other file in the plan directory')
  for (const r of built.requests) {
    assert.ok(readFileSync(path.join(dir, r.file)).equals(r.bytes), `${r.file} is stale`)
    assert.equal(r.url, DECISIONS_ENDPOINT, 'the body is the one the product would post to the Decisions endpoint')
    // If the model answered exactly as pre-registered, the product would hand the drafting model the relevant excerpts and nothing else.
    assert.deepEqual([...r.forcedSelection].sort(), r.cases.flatMap((kind, i) => (kind === 'relevant' ? [i + 1] : [])), `${r.id}: the expectations mean what the product's bar means`)
  }
  // Today's word match (no Decisions), for comparison: it never misses a clearly relevant excerpt here and never picks a clearly irrelevant one,
  // but it lets near-miss and wrong-time excerpts through. That is the gap the measurement is about.
  const local = built.requests.map(r => r.cases.map((kind, i) => [kind, r.localSelection.includes(i + 1)]))
  const picked = kind => local.flat().filter(([k, hit]) => k === kind && hit).length
  assert.deepEqual([picked('relevant'), picked('irrelevant'), picked('near_miss'), picked('wrong_time')], [6, 0, 2, 3])
  t.diagnostic(`word match selects: relevant ${picked('relevant')}/6, irrelevant ${picked('irrelevant')}/6, near_miss ${picked('near_miss')}/3, wrong_time ${picked('wrong_time')}/3`)
})

test('format: the plan is a valid declarative plan for the generic runner, within the token ceiling, with one pre-registered check per excerpt', async () => {
  const plan = JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8'))
  assert.deepEqual(Object.keys(plan), ['set', 'tokenCeiling', 'passRule', 'requests'])
  assert.equal(plan.set, BOARD_REPLY_SET); assert.equal(plan.tokenCeiling, BOARD_REPLY_TOKEN_CEILING); assert.ok(plan.tokenCeiling <= 8000)
  assert.match(plan.passRule, /probability >= 0\.6/); assert.equal(BOARD_AGENT_RELEVANCE_BAR, 0.6, 'the plan\'s bar is the product\'s bar'); assert.equal(BELOW_BAR, 0.599)
  assert.equal(plan.requests.length, 3); assert.deepEqual(plan.requests.map(r => r.id), ASKS.map(a => a.id))
  let total = 0; const kinds = {}
  for (const [n, item] of plan.requests.entries()) {
    assert.deepEqual(Object.keys(item), ['id', 'file', 'sha256', 'estInputTokens', 'expect']); assert.match(item.id, /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/); assert.equal(item.file, `requests/${item.id}.json`)
    const bytes = readFileSync(path.join(dir, item.file))
    assert.equal(sha256(bytes), item.sha256, 'sha256 of the exact file bytes')
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    assert.deepEqual(Object.keys(body), ['model', 'input', 'questions']); assert.equal(body.model, DECISION_MODEL)
    validateDecisionRequest({ input: body.input, questions: body.questions, promptCacheKey: null, safetyIdentifier: null })
    // what leaves: the question and the approved excerpts under aliases, and one predicate per excerpt. Nothing else.
    const input = JSON.parse(body.input)
    assert.deepEqual(input, { question: ASKS[n].question, candidates: ASKS[n].excerpts.map(([, text], i) => ({ alias: `c${i + 1}`, text })) })
    assert.ok(input.candidates.length >= 5 && input.candidates.length <= 6)
    assert.deepEqual(body.questions.map(q => [q.type, q.name]), input.candidates.map(c => ['predicate', c.alias]))
    const text = bytes.toString('utf8')
    for (const secret of [/egask1-/, /egd-synthetic/, /Bearer/i, /board-reply-plan/, /00000000-0000-4000/, /x[1-6]"/, /requestDigest|grantId|invocationId/]) assert.doesNotMatch(text, secret)
    // one expectation per excerpt, in the runner's predicate form
    assert.deepEqual(item.expect.map(e => e.name), body.questions.map(q => q.name))
    for (const [i, e] of item.expect.entries()) {
      const kind = ASKS[n].excerpts[i][0]; kinds[kind] = (kinds[kind] ?? 0) + 1
      assert.ok(CASES.includes(kind)); assert.ok(e.note.startsWith(`${kind}: `)); assert.equal(e.kind, 'predicate')
      assert.deepEqual(Object.keys(e), ['name', 'kind', kind === 'relevant' ? 'min' : 'max', 'severity', 'note'])
      if (kind === 'relevant') assert.equal(e.min, 0.6); else assert.equal(e.max, 0.599)
      assert.equal(e.severity, kind === 'relevant' || kind === 'irrelevant' ? 'hard' : 'soft')
    }
    assert.equal(item.estInputTokens, estimateBoardReplyTokens(body.questions.length, bytes.length)); assert.equal(item.estInputTokens, estimateTokens(0, body.questions.length, bytes.length), 'the same token model as the memory plan')
    total += item.estInputTokens
  }
  assert.deepEqual(kinds, { irrelevant: 6, relevant: 6, near_miss: 3, wrong_time: 3 }, 'every ask covers the four kinds')
  assert.ok(total <= plan.tokenCeiling && total < 8000, `estimated ${total} input tokens`)
  // The generic runner itself (lane L6), when it is in this tree: its loader accepts the plan as it is. Loading never sends.
  const runner = path.join(here, 'egdesk-decision-real-runner.mjs')
  if (existsSync(runner)) {
    const { loadPlan } = await import(runner)
    const loaded = loadPlan(path.join(dir, 'plan.json'))
    assert.deepEqual([loaded.set, loaded.totals.requests, loaded.totals.estInputTokens], [BOARD_REPLY_SET, 3, total])
  }
})
