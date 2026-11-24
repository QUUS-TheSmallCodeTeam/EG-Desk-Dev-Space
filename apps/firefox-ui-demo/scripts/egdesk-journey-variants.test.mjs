// L6 c24: the pre-registered variants of the all-on journey. Synthetic world, scripted Decision answers; nothing is sent.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { AGENT_SAYS, SAYS, loadJourneyPlan, main, runJourney } from './egdesk-all-on-live-measure.mjs'
import { EXIT } from '../helper/egdesk-decision-real-runner.mjs'
import { AGENT_KEYS, BASE_PLAN, SAYS_KEYS, VARIANTS, buildAll, buildVariantPlan, decoyIdsOf, idMapOf, planBytesOf, variantPages, variantPlanFile, variantProblems, variantSha256 } from './egdesk-journey-variants.mjs'
import { GRAPH_PAGES, graphOf } from './egdesk-all-on.support.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const baseBytes = readFileSync(path.join(here, BASE_PLAN)), baseRaw = JSON.parse(baseBytes.toString('utf8'))
const stepIds = baseRaw.steps.map(s => s.id)
const context = () => ({ baseSays: SAYS, baseAgent: AGENT_SAYS, basePages: GRAPH_PAGES, baseStepIds: stepIds })
const planPath = id => path.join(here, variantPlanFile(id))
const clone = v => JSON.parse(JSON.stringify(v))

test('the variants are valid and pre-registered: every claim the module makes about them holds', () => {
  assert.deepEqual(Object.keys(VARIANTS), ['V1', 'V2', 'V3'])
  for (const [id, variant] of Object.entries(VARIANTS)) {
    assert.equal(variant.id, id); assert.deepEqual(variantProblems(variant, context()), [], id)
    assert.deepEqual(Object.keys(variant.says).sort(), [...SAYS_KEYS].sort()); assert.deepEqual(Object.keys(variant.agent).sort(), [...AGENT_KEYS].sort())
    assert.ok(Object.isFrozen(variant) && Object.isFrozen(variant.says.quote), 'frozen')
    assert.match(variantSha256(id), /^[0-9a-f]{64}$/)
  }
  assert.deepEqual(Object.keys(SAYS).sort(), [...SAYS_KEYS].sort(), 'the variants cover every turn of the journey (a new turn in the base needs its variant wording)')
  for (const key of Object.keys(AGENT_SAYS)) assert.ok(AGENT_KEYS.includes(key), `agent text ${key} has no variant`)
})

test('each variant is a different input from the base and from the others: no person wording and no agent text is shared', () => {
  const seen = new Map()
  for (const key of SAYS_KEYS) seen.set(`says.${key}`, [SAYS[key]])
  for (const key of AGENT_KEYS) seen.set(`agent.${key}`, [AGENT_SAYS[key]])
  for (const variant of Object.values(VARIANTS)) {
    for (const key of SAYS_KEYS) seen.get(`says.${key}`).push(variant.says[key].text)
    for (const key of AGENT_KEYS) seen.get(`agent.${key}`).push(variant.agent[key])
  }
  for (const [name, texts] of seen) assert.equal(new Set(texts).size, texts.length, `${name}: two runs share a text: ${texts.join(' | ')}`)
  const kinds = Object.values(VARIANTS).map(v => new Set(Object.values(v.says).map(s => s.kind)))
  assert.ok(kinds[1].has('terse') && kinds[0].has('spoken') && kinds[2].has('formal'), 'the three registers are all there')
  for (const v of Object.values(VARIANTS)) assert.ok(Object.values(v.says).filter(s => s.kind === 'terse').length >= 1, `${v.id} has a terse turn`)
  // page ids and decoys are not shared either: each variant's graph differs from the base and from the others
  const graphs = Object.values(VARIANTS).map(v => JSON.stringify(variantPages(GRAPH_PAGES, v).map(p => [p.id, p.title])))
  assert.equal(new Set([...graphs, JSON.stringify(GRAPH_PAGES.map(p => [p.id, p.title]))]).size, 4)
  for (const v of Object.values(VARIANTS)) assert.ok(variantPages(GRAPH_PAGES, v).length > GRAPH_PAGES.length, `${v.id} adds decoys`)
})

test('the committed variant plan files are what the generator builds from plan v7 (compare mode), and the loader accepts them', () => {
  for (const { id, bytes } of buildAll()) {
    assert.equal(readFileSync(planPath(id), 'utf8'), bytes, `${id}: run node scripts/egdesk-journey-variants.mjs --write`)
    const plan = loadJourneyPlan(planPath(id))
    assert.equal(plan.variant.id, id); assert.deepEqual(plan.ceiling, VARIANTS[id].ceiling); assert.equal(plan.world.switches['action-relevance'].owner, 'L7', 'the switch is the base plan\'s')
  }
  assert.deepEqual(buildAll().map(x => x.id), ['V1', 'V2', 'V3'])
})

test('every hard check of the base plan is in each variant plan under the same id, check, severity and owner; only page ids, two needles and decoy exclusions differ', () => {
  const base = new Map(baseRaw.steps.flatMap(s => s.expect.map(e => [e.id, { ...e, step: s.id }])))
  for (const id of Object.keys(VARIANTS)) {
    const raw = JSON.parse(readFileSync(planPath(id), 'utf8')), got = new Map(raw.steps.flatMap(s => s.expect.map(e => [e.id, { ...e, step: s.id }])))
    assert.deepEqual([...got.keys()].sort(), [...base.keys()].sort(), `${id}: the same expectations`)
    assert.equal([...got.values()].filter(e => e.severity === 'hard').length, [...base.values()].filter(e => e.severity === 'hard').length)
    const idMap = idMapOf(VARIANTS[id]), decoys = decoyIdsOf(VARIANTS[id])
    for (const [eid, e] of got) {
      const b = base.get(eid)
      for (const field of ['severity', 'owner', 'check', 'text', 'step', 'when', 'predicted']) assert.deepEqual(e[field], b[field], `${id} ${eid}.${field}`)
      const want = clone(b.args ?? {})
      if (b.check === 'packet' || b.check === 'packetOrHeld') { want.include = want.include.map(x => idMap[x] ?? x); if (want.excludePrefix?.length) want.excludePrefix = [...want.excludePrefix.map(x => idMap[x] ?? x), ...decoys] }
      if (b.check === 'readingPending') want.pageId = idMap[want.pageId] ?? want.pageId
      if (eid === 's4n.heard') want.needles = [VARIANTS[id].says.nudge.text]
      const have = clone(e.args ?? {})
      if (eid === 's9.target-offered') { assert.equal(have.needles.length, 1); assert.notEqual(have.needles[0], b.args.needles[0], `${id}: the page title is the variant's`); continue }
      assert.deepEqual(have, want, `${id} ${eid}.args`)
    }
    // the decoys are excluded wherever pages are excluded by prefix, and the include lists name only pages of the variant's graph
    const ids = new Set(variantPages(GRAPH_PAGES, VARIANTS[id]).map(p => `ontology:${p.id}`))
    for (const e of got.values()) if (e.check === 'packet' || e.check === 'packetOrHeld') for (const page of e.args.include) assert.ok(ids.has(page), `${id} ${e.id}: ${page} is not a page of the variant`)
    assert.ok(raw.ceiling.tokenCeiling > 0 && raw.variantSha256 === variantSha256(id))
    assert.deepEqual(raw.steps.map(s => s.id), VARIANTS[id].order ?? stepIds, `${id}: steps in the variant's order`)
  }
})

test('the validator refuses a variant that shares a wording, escapes in a body, renames across a prefix or loses its topic word, reorders what must keep its order', () => {
  const problems = mutate => { const v = clone(VARIANTS.V1); mutate(v); return variantProblems(v, context()).join(' | ') }
  assert.match(problems(v => { v.says.quote.text = SAYS.quote }), /says\.quote: same as the base wording/)
  assert.match(problems(v => { v.says.stop.text = '그만 "해"' }), /escaped in a request body/)
  assert.match(problems(v => { v.says.nudge.kind = 'polite' }), /kind must be/)
  assert.match(problems(v => { for (const s of Object.values(v.says)) s.kind = 'spoken' }), /at least one terse turn/)
  assert.match(problems(v => { delete v.says.again }), /says\.again: missing/)
  assert.match(problems(v => { v.agent.recall = '설계를 확정했습니다.' }), /agent\.recall must name PostgreSQL/)
  assert.match(problems(v => { v.agent.noted = '네, 알겠습니다.' }), /recording claim/)
  assert.match(problems(v => { v.agent.heard = '기록했습니다.' }), /agent\.heard must not claim/)
  assert.match(problems(v => { v.agent.quote = '견적이 완료됐습니다.' }), /no result words/)
  assert.match(problems(v => { v.pages.rename[0] = { from: 'quote/a-request', id: 'db/pg-x', title: 'A사 견적' } }), /changes the prefix/)
  assert.match(problems(v => { v.pages.rename[0].title = '견적 문의 접수' }), /loses "A사"/)
  assert.match(problems(v => { v.pages.rename[0] = { from: 'quote/nope', id: 'quote/a-x', title: 'A사 x' } }), /no base page/)
  assert.match(problems(v => { v.pages.rename.push({ ...v.pages.rename[0] }) }), /twice/)
  assert.match(problems(v => { v.pages.decoys = ['quote/a-v1'] }), /already a base page/)
  assert.match(problems(v => { v.pages.decoys = ['quote/none'] }), /no fixture page/)
  assert.match(problems(v => { v.pages.decoys = [] }), /at least one decoy/)
  assert.match(problems(v => { v.order = [...stepIds].reverse() }), /order: .* must stay before/)
  assert.match(problems(v => { v.order = stepIds.slice(1) }), /permutation/)
  assert.match(problems(v => { v.order = [...stepIds.filter(s => s !== 's1-first-turn'), 's1-first-turn'] }), /must stay before|ends with/)
})

test('the loader refuses a variant plan whose variant changed, an unknown variant, a ceiling that is not a number, and a step order that is not the variant\'s', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egdesk-variant-plan-'))
  try {
    const write = (name, mutate) => { const raw = JSON.parse(readFileSync(planPath('V3'), 'utf8')); mutate(raw); const file = path.join(dir, name); writeFileSync(file, JSON.stringify(raw)); return file }
    const refuses = (file, pattern) => assert.throws(() => loadJourneyPlan(file), error => error.name === 'PlanError' && pattern.test(error.message), String(pattern))
    refuses(write('sha.json', raw => { raw.variantSha256 = '0'.repeat(64) }), /variant changed since this plan was written/)
    refuses(write('unknown.json', raw => { raw.variant = 'V9' }), /unknown variant/)
    refuses(write('ceiling.json', raw => { raw.ceiling = { tokenCeiling: 'many', maxRequests: 70 } }), /ceiling needs/)
    refuses(write('ceiling-high.json', raw => { raw.ceiling = { tokenCeiling: 900000, maxRequests: 70 } }), /ceiling needs/)
    refuses(write('order.json', raw => { raw.steps = baseRaw.steps.map(s => raw.steps.find(x => x.id === s.id)) }), /follow the journey order/)
    assert.ok(loadJourneyPlan(write('fine.json', () => {})).variant.order.at(-1) === 's11-browser-reply')
    // a plan without a variant is the base journey, as before
    const base = loadJourneyPlan(path.join(here, BASE_PLAN)); assert.equal(base.variant, undefined); assert.equal(base.ceiling, undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a send above the ceiling a plan declares is refused before any key is read; a lower one is taken; a dry run is not stopped by it', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egdesk-variant-send-'))
  try {
    const out = [], err = []; let fetched = 0
    const stamp = path.join(dir, 'last-send.json')
    const run = (argv, env = {}) => main(argv, { env: { EGDESK_DECISION_SEND_STAMP: stamp, ...env }, fetchImpl: async () => { fetched++; throw new Error('no network in a test') }, print: l => out.push(l), printError: l => err.push(l) })
    const key = 'k'.repeat(40)
    assert.equal(await run(['--plan', planPath('V1'), '--send', '--token-ceiling', '70001'], { OPENAI_API_KEY: key }), EXIT.usage)
    assert.match(err.at(-1), /--token-ceiling 70001 is above the ceiling this plan declares \(70000\); nothing was sent/)
    assert.equal(await run(['--plan', planPath('V1'), '--send', '--max-requests', '71'], { OPENAI_API_KEY: key }), EXIT.usage)
    assert.match(err.at(-1), /--max-requests 71 is above the ceiling this plan declares \(70\)/)
    assert.equal(fetched, 0)
    // a lower flag is taken (the first request is bigger than 1,000 tokens: the guard refuses it before the network)
    out.length = 0
    await run(['--plan', planPath('V1'), '--send', '--token-ceiling', '1000'], { OPENAI_API_KEY: key })
    assert.equal(JSON.parse(out[0]).tokenCeiling, 1000); assert.equal(fetched, 0)
    // a send without flags takes the plan's own ceiling; the first request reaches the (failing) network once and the run stops there
    out.length = 0
    await run(['--plan', planPath('V1'), '--send'], { OPENAI_API_KEY: key })
    assert.deepEqual([JSON.parse(out[0]).tokenCeiling, JSON.parse(out[0]).maxRequests], [70000, 70])
    assert.equal(fetched, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// The scripted dry run of each variant: the product code builds every body; the person's words are the variant's, the checks read them, and the base's expectations hold.
const dry = {}
async function dryRun(id) {
  const plan = loadJourneyPlan(id === 'base' ? path.join(here, BASE_PLAN) : planPath(id))
  return runJourney({ plan, caps: { tokenCeiling: 200_000, maxRequests: 200 }, switches: ['action-relevance'] })
}
test('dry run of the base plan with the switch (the reference for the variants): sixteen steps, the one hard check the scripted double cannot satisfy', async () => {
  dry.base = await dryRun('base')
  assert.equal(dry.base.ledger.stopped, null); assert.equal(dry.base.steps.length, 16)
  assert.deepEqual(dry.base.scorecard.hard.failed, ['s4.no-page-for-the-action'], 'the scripted double does not implement the action rule (a real run does)')
})

for (const id of ['V1', 'V2', 'V3']) {
  test(`dry run of ${id}: the person says the variant's words, the steps run in the variant's order, every base hard check holds as in the base dry run, nearly every body is new`, async () => {
    const outcome = dry[id] = await dryRun(id), variant = VARIANTS[id]
    assert.equal(outcome.ledger.stopped, null)
    assert.deepEqual(outcome.steps.map(s => s.id), variant.order ?? stepIds)
    assert.deepEqual(outcome.scorecard.hard.failed, dry.base.scorecard.hard.failed, `${id}: the same hard checks fail in the scripted dry run as in the base's (none of them is a variant effect)`)
    assert.equal(outcome.scorecard.hard.notRun, 0)
    // what the person said, step by step, is the variant's wording (checks such as keptInRun read it from the world)
    const said = outcome.steps.flatMap(s => s.seen.newMessages.filter(m => m.role === 'user').map(m => m.text))
    for (const key of SAYS_KEYS) assert.ok(said.includes(variant.says[key].text), `${id}: nobody said the ${key} words`)
    for (const key of SAYS_KEYS) assert.ok(!said.includes(SAYS[key]), `${id}: the base ${key} words were said`)
    // the answering model's wording is the variant's, and the answer-as-written checks passed on it
    const agent = outcome.steps.flatMap(s => s.seen.newMessages.filter(m => m.role === 'assistant' && m.by === 'agent').map(m => m.text))
    assert.ok(agent.includes(variant.agent.quote) && agent.includes(variant.agent.tidy) && !agent.includes(AGENT_SAYS.quote))
    for (const e of outcome.steps.flatMap(s => s.checks)) if (['s1.answer', 's2.answer', 's4n.kept', 's4c.kept', 's4c.steered', 's12.kept'].includes(e.id)) assert.equal(e.pass, true, `${id} ${e.id}`)
    // independence: the bodies the product built differ from the base's (a body that is byte-identical gets the same answer)
    const sha = o => o.steps.flatMap(s => (s.requests ?? []).map(q => q.sha256))
    const base = new Set(sha(dry.base)), mine = sha(outcome), same = mine.filter(x => base.has(x)).length
    assert.ok(same <= 2, `${id}: ${same} of ${mine.length} request bodies are byte-identical to the base's`)
    // the decoys and renamed pages are in the graph the product read: a request names the new titles, none names the base titles that were renamed
    const text = outcome.steps.flatMap(s => s.requests ?? []).length
    assert.ok(text > 40)
  })
}

test('the variants do not share request bodies with each other either, and the variant plan declares a ceiling its replay estimate fits (the V1 plan is the one that stays within 70,000)', () => {
  const sha = id => new Set(dry[id].steps.flatMap(s => (s.requests ?? []).map(q => q.sha256)))
  for (const [a, b] of [['V1', 'V2'], ['V1', 'V3'], ['V2', 'V3']]) assert.ok([...sha(a)].filter(x => sha(b).has(x)).length <= 2, `${a} and ${b} share request bodies`)
  assert.equal(VARIANTS.V1.ceiling.tokenCeiling, 70_000)
  for (const v of Object.values(VARIANTS)) assert.ok(v.ceiling.tokenCeiling <= 200_000 && v.ceiling.maxRequests <= 200)
  // the registered builder is deterministic: building twice gives the same bytes
  assert.equal(planBytesOf(buildVariantPlan(baseRaw, baseBytes, 'V2')), planBytesOf(buildVariantPlan(baseRaw, baseBytes, 'V2')))
  assert.equal(graphOf(variantPages(GRAPH_PAGES, VARIANTS.V1)).nodes.some(n => n.id === 'quote/b-request'), true)
})
