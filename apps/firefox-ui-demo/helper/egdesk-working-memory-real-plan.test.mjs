import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPlan } from './egdesk-decision-real-runner.mjs'
import { WM_CASES, WM_PLAN_DIR, WM_PLAN_TOKEN_CEILING, buildWorkingMemoryPlan } from './egdesk-working-memory-real-plan.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('working-memory judge plan: the committed files are what the product builds today, and the runner accepts them', async () => {
  const built = await buildWorkingMemoryPlan()
  const dir = path.join(root, WM_PLAN_DIR)
  assert.ok(readFileSync(path.join(dir, 'plan.json')).equals(built.planBytes), 'plan.json is stale: run node scripts/egdesk-working-memory-real-plan.mjs --write')
  for (const r of built.requests) assert.ok(readFileSync(path.join(dir, r.file)).equals(r.bytes), `${r.file} is stale`)
  const loaded = loadPlan(path.join(dir, 'plan.json'))
  assert.equal(loaded.requests.length, WM_CASES.length)
  assert.ok(built.totals.estInputTokens <= WM_PLAN_TOKEN_CEILING)
})

test('working-memory judge plan: every body is the predicate design, quotes the goal and every block, and every question has a pre-registered check', async () => {
  const built = await buildWorkingMemoryPlan()
  for (const [n, r] of built.requests.entries()) {
    const c = WM_CASES[n], text = r.body.input.map(m => m.content).join('\n')
    assert.ok(r.body.questions.length > 0 && r.body.questions.every(q => q.type === 'predicate'))
    assert.ok(text.includes(`"""\n${c.goal}\n"""`))
    for (const line of c.text.split('\n').filter(l => /^## /.test(l))) assert.ok(text.includes(line), `${c.id}: ${line} is quoted`)
    const checked = new Set(built.plan.requests[n].expect.map(e => e.name))
    for (const q of r.body.questions) assert.ok(checked.has(q.name), `${c.id}: ${q.name} has a check`)
    assert.ok(built.plan.requests[n].expect.some(e => e.severity === 'hard'))
    assert.equal(/sk-|egd-synthetic/.test(r.bytes.toString('utf8')), false)
  }
  // Paired design: same document, same blocks, different goals.
  assert.equal(WM_CASES[0].text, WM_CASES[1].text)
  assert.deepEqual(built.requests[0].body.questions.map(q => q.name), built.requests[1].body.questions.map(q => q.name))
})
