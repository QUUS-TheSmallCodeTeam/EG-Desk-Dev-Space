// command-risk-v2: the gate's re-measurement plan (rule floor + content predicates). Built by the product's code, never sent from here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { DECISION_MODEL, validateDecisionRequest } from './egdesk-decision-client.mjs'
import { COMMAND_RISK_PLAN_SET, COMMAND_RISK_PLAN_TOKEN_CEILING, RISK_V2_CASES, buildCommandRiskPlanV2, independentEstimate } from './egdesk-command-risk-plan.mjs'
import { RISK_PREDICATES, RISK_PREDICATE_NO } from './egdesk-terminal-command-gate.mjs'

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'real-plans', 'command-risk-v2')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const walk = (dir, base = '') => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name), `${base}${entry.name}/`) : [`${base}${entry.name}`])

test('building sends nothing, is deterministic, and the committed plan is byte-for-byte what the builder produces', async t => {
  const realFetch = globalThis.fetch
  let networkCalls = 0
  globalThis.fetch = async () => { networkCalls++; throw new Error('the plan builder must not use the network') }
  t.after(() => { globalThis.fetch = realFetch })
  const first = await buildCommandRiskPlanV2(), second = await buildCommandRiskPlanV2()
  assert.equal(networkCalls, 0)
  assert.deepEqual(second.files, first.files)
  assert.deepEqual(walk(DIR).sort(), Object.keys(first.files).sort())
  for (const [name, text] of Object.entries(first.files)) assert.equal(readFileSync(path.join(DIR, name), 'utf8'), text, `${name} differs from the builder: run scripts/egdesk-command-real-plan.mjs --out <dir>`)
})

test('the 12 commands asked for: the floor settles 10 with zero requests in the product; the predicates judge the rest', () => {
  const cases = JSON.parse(readFileSync(path.join(DIR, 'cases.json'), 'utf8'))
  const byId = Object.fromEntries(cases.cases.map(c => [c.id, c]))
  const floor = { 'v2-git-clean': ['deletes_untracked'], 'v2-git-reset': ['discards_history'], 'v2-npm-publish': ['publishes'], 'v2-docker-prune': ['container_data'], 'v2-push-force': ['remote_irreversible'],
    'v2-branch-delete': ['discards_history'], 'v2-docker-volume-rm': ['container_data'], 'v2-drop-table': ['database_destructive'], 'v2-rm-outside': ['outside_cwd'], 'v2-curl-sh': ['remote_script'] }
  for (const [id, reasons] of Object.entries(floor)) assert.deepEqual([byId[id].productRequests, byId[id].floor], [0, reasons], id)
  for (const id of ['v2-rm-node-modules', 'v2-rm-build', 'v2-git-push', 'v2-rm-env-local', 'v2-scp-dump', 'v2-docker-rm']) assert.deepEqual([byId[id].productRequests, byId[id].floor], [1, []], id)
  assert.deepEqual(cases.notAsked.map(c => [c.command, c.productRequests, c.approval]), [['npm publish --dry-run', 0, false], ['git clean -n', 0, false], ['git reset --soft HEAD~5', 0, false], ['docker ps', 0, false]])
})

test('plan format: predicate checks only (no score question), every body a valid request with the three predicates, under the token ceiling', () => {
  const plan = JSON.parse(readFileSync(path.join(DIR, 'plan.json'), 'utf8'))
  assert.deepEqual(Object.keys(plan), ['set', 'tokenCeiling', 'passRule', 'requests'])
  assert.deepEqual([plan.set, plan.tokenCeiling], [COMMAND_RISK_PLAN_SET, COMMAND_RISK_PLAN_TOKEN_CEILING])
  let total = 0
  for (const request of plan.requests) {
    const bytes = readFileSync(path.join(DIR, request.file))
    assert.equal(sha256(bytes), request.sha256)
    const body = JSON.parse(bytes.toString('utf8'))
    assert.deepEqual(Object.keys(body), ['model', 'input', 'questions']); assert.equal(body.model, DECISION_MODEL)
    validateDecisionRequest({ input: body.input, questions: body.questions, promptCacheKey: null, safetyIdentifier: null })
    assert.deepEqual(body.questions.map(q => [q.type, q.name]), RISK_PREDICATES.map(p => ['predicate', p.name]))
    assert.equal(request.estInputTokens, independentEstimate(3, bytes.length))
    total += request.estInputTokens
    assert.ok(request.expect.length > 0)
    for (const e of request.expect) {
      assert.equal(e.kind, 'predicate'); assert.ok(body.questions.some(q => q.name === e.name)); assert.ok(e.note.length > 30)
      assert.ok(e.severity === 'soft' || (e.min === RISK_PREDICATE_NO || e.min === 0.5), `${request.id}: a hard check sits at the product bar (0.2) or the wording bar (0.5)`)
    }
  }
  assert.ok(total <= plan.tokenCeiling, `estimated ${total} input tokens`)
  const hard = plan.requests.flatMap(r => r.expect.filter(e => e.severity === 'hard').map(e => `${r.id}:${e.name}:${e.min}`))
  assert.deepEqual(hard, ['v2-git-clean:risk_unrestorable:0.5', 'v2-npm-publish:risk_outside:0.5', 'v2-docker-volume-rm:risk_unrestorable:0.5', 'v2-drop-table:risk_unrestorable:0.5',
    'v2-rm-outside:risk_personal_files:0.5', 'v2-git-push:risk_outside:0.2', 'v2-rm-env-local:risk_unrestorable:0.2', 'v2-scp-dump:risk_outside:0.2'])
})

test('request bodies: no key, no absolute path, only the reserved example.test host; the product bodies are exactly what the gate sends', () => {
  const all = walk(path.join(DIR, 'requests')).map(name => readFileSync(path.join(DIR, 'requests', name), 'utf8')).join('\n')
  assert.doesNotMatch(all, /egd-synthetic|sk-[A-Za-z0-9]|Bearer |\/Users\/|\/home\/|\/work\//)
  for (const host of [...all.matchAll(/(?:https?:\/\/|@|\b)([a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:test|com|net|org|io|dev))\b/gi)].map(m => m[1])) assert.match(host, /example\.test$/, host)
  const envLocal = JSON.parse(readFileSync(path.join(DIR, 'requests', 'v2-rm-env-local.json'), 'utf8')).input[1].content[0].data
  assert.deepEqual(envLocal, { command: 'rm -f .env.local', working_directory: 'demo-app', stated_intent: 'Start again from the default settings', git_working_tree: 'clean',
    targets: [{ path: '.env.local', exists: true, kind: 'file', tracked_files: 0, ignored: true, inside_working_directory: true }] })
  assert.equal(RISK_V2_CASES.length, 16)
})
