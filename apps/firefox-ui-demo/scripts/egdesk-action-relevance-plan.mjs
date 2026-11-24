#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { independentEstimate } from '../helper/egdesk-decision-real-runner.mjs'
import { runJourney, loadJourneyPlan, PLAN_FILE_V3, SAYS } from './egdesk-all-on-live-measure.mjs'
import { scriptedDecisions } from './egdesk-all-on.support.mjs'

// The context selection's 'action' rule set (egdesk-context-setup.mjs CONTEXT_RULE_SETS), PREPARED, NOT SENT: never sends, never reads a key.
// Real all-on v3 (2026-11-25), s4 "전체 테스트 돌리고 결과 알려줘": rel 0.56 (PostgreSQL 마이그레이션 배포 계획) and 0.69 (헬스체크 3종
// 체크리스트) put two unrelated pages in front of a test-run request (soft s4.no-unrelated-pages). The 'action' set adds ONE rule line; the
// questions are unchanged. Two requests, both built by the product inside the all-on journey (scripted Decision model, offline):
//   s4-action   the same 12-item catalog as the real s4 body (held-record pruning off), with the rule. HARD: no item reaches the selection's
//               bar (every rel < .5): a test-run request needs no record of this catalog.
//   s3b-control "PostgreSQL 전환은 설계에서 어떻게 하기로 정했었지?" with the rule and held-record pruning on (7 items, as the v4 journey
//               will run). HARD: the design record still reaches the bar (>= .5; real v3 answer 1.0): the rule must not drop a needed record.
// Pre-registered: both hard checks pass. Soft: the other s3b items stay under the bar.
//   node scripts/egdesk-action-relevance-plan.mjs [--write]
// Sending (owner only): node scripts/egdesk-decision-real-measure.mjs proofs/decision-real-measure/action-relevance/plan.json --send
export const RELEVANCE_DIR = 'proofs/decision-real-measure/action-relevance'
export const RELEVANCE_CEILING = 5000
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const flat = c => (typeof c === 'string' ? c : c.map(p => p.text ?? '').join('\n'))
const catalogOf = text => Object.fromEntries([...text.matchAll(/^#(\d+) \| [^|]+ \| [^|]+ \| ([^|\n]+?)(?: \| |$)/gm)].map(m => [m[2].trim(), `rel_${m[1]}`]))

async function capture(env, message) {
  const scripted = scriptedDecisions(), found = []
  const fetchImpl = async (_u, init) => {
    const body = typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf8'), wire = JSON.parse(body)
    if (wire.questions.some(q => q.name === 'answer_type') && wire.input.map(m => flat(m.content)).join('\n').trimEnd().endsWith(`Message:\n${message}`)) found.push(body)
    return new Response(JSON.stringify({ model: 'gpt-6-luna', answers: await scripted.answer(wire), usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  await runJourney({ plan: loadJourneyPlan(PLAN_FILE_V3), send: true, key: 'egd-synthetic-not-a-key-0020', fetchImpl, env })
  if (found.length !== 1) throw new Error(`expected one turn_context body for ${message}, got ${found.length}`)
  return found[0]
}

export async function buildRelevancePlan() {
  const items = [
    { id: 's4-action', message: SAYS.tests, env: { EGDESK_CONTEXT_RELEVANCE: 'action' },
      expect: catalog => Object.entries(catalog).map(([title, name]) => ({ name, kind: 'predicate', max: 0.49, severity: 'hard', note: `${title}: a test-run request needs no record of this catalog (real v3 without the rule: 배포 계획 .56, 헬스체크 .69)` })) },
    { id: 's3b-control', message: SAYS.recall, env: { EGDESK_CONTEXT_RELEVANCE: 'action', EGDESK_TURN_MEMORY_PRUNE_HELD: 'on' },
      expect: catalog => Object.entries(catalog).map(([title, name]) => (title === 'PostgreSQL 전환 설계'
        ? { name, kind: 'predicate', min: 0.5, severity: 'hard', note: 'the design record is what the question asks for (real v3: 1.0)' }
        : { name, kind: 'predicate', max: 0.49, severity: 'soft', note: `${title}: not asked for` })) },
  ]
  const requests = [], files = []
  for (const item of items) {
    const body = await capture(item.env, item.message), wire = JSON.parse(body)
    if (!/carry out an action/.test(flat(wire.input[0].content))) throw new Error(`${item.id}: the body does not carry the action rule`)
    const text = wire.input.map(m => flat(m.content)).join('\n'), bytes = Buffer.from(body, 'utf8'), file = `requests/${item.id}.json`
    requests.push({ id: item.id, file, sha256: sha(bytes), estInputTokens: independentEstimate(wire.questions.filter(q => q.type === 'choice').length, wire.questions.filter(q => q.type === 'predicate').length, bytes.length),
      expect: item.expect(catalogOf(text)) })
    files.push({ file, bytes })
  }
  const est = requests.reduce((n, r) => n + r.estInputTokens, 0)
  if (est > RELEVANCE_CEILING) throw new Error(`${est} estimated input tokens, over ${RELEVANCE_CEILING}`)
  const plan = { set: 'action-relevance-v1', tokenCeiling: RELEVANCE_CEILING,
    productBars: { 'rel_#': { yes: 0.5, no: 0.49, source: 'egdesk-decision-questions.mjs decisionThresholds relevant 0.5: an item is attached at >= .5 (relevantStrict .8 for a planned item under a present-only question), not below' } },
    passRule: 'Both hard checks pass: nothing of the catalog reaches the bar for the test-run request; the design record still does for the design question. Built by the product (all-on journey, scripted model, offline) with EGDESK_CONTEXT_RELEVANCE=action.',
    requests }
  return { plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), files, est }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', RELEVANCE_DIR)
  const write = process.argv.includes('--write'), built = await buildRelevancePlan()
  let differs = 0
  for (const [name, bytes] of [['plan.json', built.planBytes], ...built.files.map(f => [f.file, f.bytes])]) {
    const target = path.join(dir, name)
    if (write) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes) }
    else { let same = false; try { same = readFileSync(target).equals(bytes) } catch { same = false } if (!same) { differs++; console.log(`differs: ${name}`) } }
  }
  console.log(`${write ? 'written' : differs ? 'DIFFERS' : 'matches'}: ${built.plan.requests.length} requests, est input tokens ${built.est} of ${RELEVANCE_CEILING}`)
  process.exitCode = differs ? 1 : 0
}
