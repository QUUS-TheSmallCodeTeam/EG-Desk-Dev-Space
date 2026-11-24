// The HUD routing real-measure plan (L1 c20): the written files are exactly what the product builds; within the ceiling; product bars
// declared; the grouping lint passes; the code-routed inputs make no request; the analysis reads answers the way the product does.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { HUD_CEILING, HUD_ROOT, analyzeHudRouting, buildHudPlan } from './egdesk-hud-routing-real-plan.mjs'
import { lintGroupedRequest } from './egdesk-decision-grouping.mjs'

test('the written plan is byte-identical to the product build; ceiling, bars, lint and code-routed inputs hold', () => {
  const built = buildHudPlan()
  assert.equal(readFileSync(path.join(HUD_ROOT, 'plan.json')).equals(built.planBytes), true, 'plan.json is current (node helper/egdesk-hud-routing-real-plan.mjs --write)')
  for (const f of built.files) assert.equal(readFileSync(path.join(HUD_ROOT, f.file)).equals(f.bytes), true, f.file)
  assert.ok(built.est <= HUD_CEILING && HUD_CEILING <= 10000)
  assert.deepEqual(built.plan.productBars['*predicate'].yes, 0.8); assert.deepEqual(built.plan.productBars['*predicate'].no, 0.2)
  for (const r of built.rows) assert.equal(lintGroupedRequest(JSON.parse(r.bytes)).ok, true, r.id)
  assert.deepEqual(built.codeRouted.map(c => [c.id, c.rule, c.requests]), [['address', 'address', 0], ['command', 'command', 0], ['exact-name', 'name', 0]])
  assert.deepEqual(built.rows.map(r => r.id), ['question', 'open-card', 'open-card-2', 'web-search', 'ambiguous', 'ambiguous-2', 'command-diagnostic'])
  for (const r of built.rows) assert.deepEqual(r.kinds, ['hud_text', 'canvas_text'])
  assert.equal(built.plan.requests.find(r => r.id === 'command-diagnostic').recordOnly, true)
})

test('analysis: the product reading (rankRoute) decides wrong highlights; an undecided answer is never wrong', () => {
  const { plan } = buildHudPlan()
  const yes = 0.95, no = 0.03, mid = 0.5
  const ans = o => ({ status: 200, answers: Object.entries(o).map(([name, probability]) => ({ name, type: 'predicate', probability })) })
  const results = {
    question: ans({ goes_to_I1: no, goes_to_I2: no, web_search: no, assistant_request: yes }),
    'open-card': ans({ goes_to_I1: yes, goes_to_I2: no, web_search: no, assistant_request: mid }),
    'open-card-2': ans({ goes_to_I1: yes, goes_to_I2: no, web_search: no, assistant_request: no }), // the wrong card
    'web-search': ans({ goes_to_I1: no, goes_to_I2: no, web_search: mid, assistant_request: no }),
    ambiguous: ans({ goes_to_I1: mid, goes_to_I2: no, web_search: no, assistant_request: no }),
    'ambiguous-2': ans({ goes_to_I1: no, goes_to_I2: no, web_search: no, assistant_request: yes }), // highlighted the request row: wrong
  }
  const a = analyzeHudRouting(results, plan)
  assert.deepEqual(a.rows.map(r => [r.id, r.picked, r.wrong]), [['question', 'ask', false], ['open-card', 'card:res-v1', false], ['open-card-2', 'card:res-v1', true],
    ['web-search', null, false], ['ambiguous', null, false], ['ambiguous-2', 'ask', true]])
  assert.deepEqual([a.wrong, a.covered, a.total], [2, 3, 6], 'covered: question, open-card, ambiguous (kept today\'s highlight, as wanted)')
})
