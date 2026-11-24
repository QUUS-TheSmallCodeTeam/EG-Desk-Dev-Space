import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DECISION_BUDGET_FILE, openDecisionBudgetStore } from './egdesk-decision-budget-store.mjs'
import { openDecisionCredentialStore } from './egdesk-decision-credential.mjs'
import { DecisionError, createDecisionBudget, createDecisionClient } from './egdesk-decision-client.mjs'

const KEY = 'egd-synthetic-not-a-key-0003'
const quiet = () => {}
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'egd-budget-')); fs.chmodSync(d, 0o700); return d }
const wire = (dir, now, log = quiet) => {
  const store = openDecisionBudgetStore({ dataDir: dir, log })
  const budget = createDecisionBudget({ monthlyInputTokenCap: store.state?.cap ?? null, initial: store.state, now, onChange: s => store.save(s) })
  return { store, budget }
}
const JAN = () => Date.parse('2026-11-15T00:00:00Z')

test('usage and an owner cap survive a restart; file is 0600 and never holds the key', () => {
  const dir = tmp()
  const a = wire(dir, JAN)
  assert.equal(a.store.status, 'missing')
  assert.deepEqual({ ...a.budget.snapshot() }, { month: '2026-11', inputTokens: 0, cap: null })
  a.budget.record({ inputTokens: 1200 }); a.budget.setCap(2000); a.budget.record({ inputTokens: 900 })
  const file = path.join(dir, DECISION_BUDGET_FILE)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const b = wire(dir, JAN)
  assert.equal(b.store.status, 'saved')
  assert.deepEqual({ ...b.budget.snapshot() }, { month: '2026-11', inputTokens: 2100, cap: 2000 })
  assert.equal(b.budget.canSpend(), false)
  const text = fs.readFileSync(file, 'utf8')
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['cap', 'inputTokens', 'month', 'version'])
  b.budget.setCap(null)
  assert.equal(wire(dir, JAN).budget.snapshot().cap, null)
})

test('no cap until the owner picks one: a fresh store imposes none and counts only', () => {
  const { budget } = wire(tmp(), JAN)
  budget.record({ inputTokens: 5_000_000 })
  assert.equal(budget.canSpend(), true)
})

test('a new month resets the persisted tally and keeps the cap', () => {
  const dir = tmp()
  const a = wire(dir, JAN); a.budget.setCap(1000); a.budget.record({ inputTokens: 1000 })
  const dec = () => Date.parse('2026-12-01T00:00:01Z')
  const b = wire(dir, dec)
  assert.deepEqual({ ...b.budget.snapshot() }, { month: '2026-12', inputTokens: 0, cap: 1000 })
  assert.equal(b.budget.canSpend(), true)
  b.budget.record({ inputTokens: 10 })
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, DECISION_BUDGET_FILE), 'utf8')), { version: 1, month: '2026-12', inputTokens: 10, cap: 1000 })
})

test('a damaged file is set aside, logged without content, and counting restarts', () => {
  const dir = tmp(); const logs = []
  fs.writeFileSync(path.join(dir, DECISION_BUDGET_FILE), '{"version":1,"month":"2026-11","inputTokens":-5,"cap":null}', { mode: 0o600 })
  const { store, budget } = wire(dir, JAN, m => logs.push(m))
  assert.equal(store.status, 'recovered')
  assert.equal(budget.snapshot().inputTokens, 0)
  assert.ok(fs.readdirSync(dir).some(n => n.startsWith(`${DECISION_BUDGET_FILE}.corrupt-`)))
  assert.ok(logs.length === 1 && !logs[0].includes('-5'))
})

test('a newer-version file is left untouched and never overwritten', () => {
  const dir = tmp(); const file = path.join(dir, DECISION_BUDGET_FILE)
  fs.writeFileSync(file, '{"version":9,"x":1}', { mode: 0o600 })
  const { store, budget } = wire(dir, JAN)
  assert.equal(store.status, 'unsupported')
  budget.record({ inputTokens: 5 })
  assert.equal(fs.readFileSync(file, 'utf8'), '{"version":9,"x":1}')
})

test('a group-readable file is refused as not private', () => {
  const dir = tmp(); const file = path.join(dir, DECISION_BUDGET_FILE)
  fs.writeFileSync(file, '{"version":1,"month":"2026-11","inputTokens":1,"cap":null}', { mode: 0o644 }); fs.chmodSync(file, 0o644)
  assert.equal(openDecisionBudgetStore({ dataDir: dir, log: quiet }).status, 'recovered')
})

test('an unwritable store never breaks counting or throws into the decision path', () => {
  const dir = path.join(tmp(), 'missing-parent-is-created-but-file-dir-removed')
  const { store, budget } = wire(dir, JAN)
  fs.rmSync(dir, { recursive: true })
  assert.doesNotThrow(() => budget.record({ inputTokens: 7 }))
  assert.equal(budget.snapshot().inputTokens, 7)
  assert.equal(store.save({ month: '2026-11', inputTokens: 1, cap: null }), false)
  assert.throws(() => budget.setCap(0), TypeError)
  assert.throws(() => budget.setCap(1.5), TypeError)
})

test('deleting the key keeps the tally; the file never carries the key; cap blocks before any provider call after restart', async () => {
  const dir = tmp()
  const creds = openDecisionCredentialStore({ dataDir: dir, log: quiet })
  assert.equal(creds.save(KEY), true)
  const first = wire(dir, JAN); first.budget.setCap(1500)
  let sent = 0
  const body = JSON.stringify({ model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'q', probability: 0.9 }], usage: { input_tokens: 1000 } })
  const fetchImpl = async () => { sent++; return { ok: true, status: 200, text: async () => body } }
  const ask = client => client.decide({ input: 'x', questions: [{ type: 'predicate', name: 'q', instructions: 'Is it?' }] })
  const c1 = createDecisionClient({ getApiKey: () => creds.getApiKey(), fetchImpl, budget: first.budget })
  await ask(c1); await ask(c1)           // 1000 then 2000: the second started under the cap
  const second = wire(dir, JAN)           // restart
  const c2 = createDecisionClient({ getApiKey: () => creds.getApiKey(), fetchImpl, budget: second.budget })
  await assert.rejects(ask(c2), e => e instanceof DecisionError && e.code === 'budget_exceeded')
  assert.equal(sent, 2)
  assert.equal(creds.clear(), true)
  assert.equal(wire(dir, JAN).budget.snapshot().inputTokens, 2000)
  for (const name of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, name), 'utf8').includes(KEY) || name.startsWith('egdesk-decision-credential'))
  assert.ok(!fs.readdirSync(dir).includes('egdesk-decision-credential.json'))
})

test('a clock set back keeps the persisted later-month tally across restarts', () => {
  const dir = tmp()
  const dec = () => Date.parse('2026-12-05T00:00:00Z')
  const a = wire(dir, dec); a.budget.setCap(500); a.budget.record({ inputTokens: 500 })
  const b = wire(dir, JAN) // restart with the clock reading November
  assert.deepEqual({ ...b.budget.snapshot() }, { month: '2026-12', inputTokens: 500, cap: 500 })
  assert.equal(b.budget.canSpend(), false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, DECISION_BUDGET_FILE), 'utf8')).inputTokens, 500)
})
