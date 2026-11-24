// c21: the real-measure plan of the condition arbiter's auxiliary predicates. Built from the product's own request builder; never sent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { RUN_CONDITIONS_PLAN_SET, RUN_CONDITIONS_PLAN_TOKEN_CEILING, buildRunConditionsPlan } from './egdesk-run-conditions-plan.mjs'
import { loadPlan, runPlan } from './egdesk-decision-real-runner.mjs'
import { CONDITION_PREDICATES } from './egdesk-run-conditions.mjs'

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'real-plans', 'run-conditions-v1')
const walk = (dir, base = '') => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`])

test('the committed plan is byte-for-byte what the builder makes, without the network', async t => {
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('no network') }
  t.after(() => { globalThis.fetch = realFetch })
  const built = await buildRunConditionsPlan()
  assert.equal(calls, 0)
  assert.deepEqual(walk(DIR).sort(), Object.keys(built.files).sort())
  for (const [name, text] of Object.entries(built.files)) assert.equal(readFileSync(path.join(DIR, name), 'utf8'), text, name)
})

test('the runner loads it: product bars declared and respected, grouping lint clean, under the ceiling; a dry run sends nothing', async () => {
  const plan = loadPlan(path.join(DIR, 'plan.json'))
  assert.equal(plan.set, RUN_CONDITIONS_PLAN_SET); assert.equal(plan.tokenCeiling, RUN_CONDITIONS_PLAN_TOKEN_CEILING)
  assert.deepEqual(Object.keys(plan.productBars).sort(), Object.keys(CONDITION_PREDICATES).sort())
  assert.ok(plan.requests.every(r => r.groupingOk === true && r.questions.length === 1))
  assert.ok(plan.totals.estInputTokens <= plan.tokenCeiling)
  const hard = plan.requests.flatMap(r => r.expect.filter(e => e.severity === 'hard').map(e => `${r.id}:${e.min !== undefined ? `>=${e.min}` : `<=${e.max}`}`))
  assert.deepEqual(hard, ['problem-lint-errors-exit0:>=0.8', 'problem-tsc-errors-exit0:>=0.8', 'problem-build-clean:<=0.2', 'listening-vite-ready:>=0.8', 'listening-eaddrinuse:<=0.2',
    'conflict-merge:>=0.8', 'conflict-rebase:>=0.8', 'conflict-fast-forward:<=0.2'])
  let sent = 0
  await runPlan({ plan, send: false, fetchImpl: async () => { sent++; throw new Error('dry run') } })
  assert.equal(sent, 0)
  const bodies = walk(path.join(DIR, 'requests')).map(name => readFileSync(path.join(DIR, 'requests', name), 'utf8')).join('\n')
  assert.doesNotMatch(bodies, /egd-synthetic|sk-[A-Za-z0-9]|\/Users\//)
})
