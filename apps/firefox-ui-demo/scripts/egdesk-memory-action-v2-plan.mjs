#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { independentEstimate } from '../helper/egdesk-decision-real-runner.mjs'
import { NO, YES } from '../helper/egdesk-wiki-reconstruction.mjs'
import { runJourney, loadJourneyPlan, PLAN_FILE_V3, SAYS } from './egdesk-all-on-live-measure.mjs'
import { scriptedDecisions } from './egdesk-all-on.support.mjs'

// v2 (L7 c22): turn memory's action request rule (egdesk-turn-memory.mjs TN_ACTION; developer flag EGDESK_CONTEXT_RELEVANCE=action).
// PREPARED, NOT SENT: never sends, never reads a key. v1 (c24, real) showed the triage's need .99 is honest for a test run (it needs repository
// and test facts, not stored pages); v2 adds one yes/no predicate, tn_action, and a code rule: a decided yes fetches no stored page.
//   s4-triage    "전체 테스트 돌리고 결과 알려줘": HARD tn_action >= .8 (the fetch is not run).
//   s3b-triage   "PostgreSQL 전환은 설계에서 어떻게 하기로 정했었지?": HARD tn_action <= .2 and tn_need >= .8 (the design page is still fetched).
//   s9-triage    "PostgreSQL 마이그레이션 배포 끝났어": HARD tn_action <= .2 (a report of a finished deployment names an operation but asks for none;
//                its pages are what the status remark is checked against).
// Pre-registered: all hard checks pass.
// ---- (v1 header, kept for reference) Turn memory's 'action' rules (egdesk-wiki-reconstruction.mjs ACTION_MEMORY_RULE, in the triage and the scan; developer flag
// EGDESK_CONTEXT_RELEVANCE=action, the selection's flag).
// Real all-on c17 and v4 (2026-11-25), s4 "전체 테스트 돌리고 결과 알려줘": with the selection's action rule nothing was selected, but turn
// memory still sent four PostgreSQL pages (triage need .99, scan pg .87 / .87, then links): soft s4.no-unrelated-pages. Three requests, built
// by the product inside the all-on journey with the v4 flags plus the action rules (scripted Decision model, offline; for s4 the scripted
// triage is told need .99 as the real one answered, so the scan that followed is built too):
//   s4-triage    HARD tn_need <= .2: a decided no skips the fetch (held pages exist and the stored list is complete; egdesk-turn-memory
//                triageSkipsFetch).
//   s4-scan      HARD every pg_ <= .2: if the triage still says yes, the scan picks nothing.
//   s3b-triage   control, "PostgreSQL 전환은 설계에서 어떻게 하기로 정했었지?": HARD tn_need >= .8 (real v4: 1.0); a no would skip the fetch
//                and lose the design page.
// Pre-registered: all three hard checks pass.
//   node scripts/egdesk-memory-action-plan.mjs [--write]
// Sending (owner only): node scripts/egdesk-decision-real-measure.mjs proofs/decision-real-measure/memory-action-v2/plan.json --send
export const MEMORY_ACTION_V2_DIR = 'proofs/decision-real-measure/memory-action-v2'
export const MEMORY_ACTION_V2_CEILING = 5000
export const MEMORY_ACTION_V2_ENV = Object.freeze({ EGDESK_TURN_MEMORY_PRUNE_HELD: 'on', EGDESK_TURN_MEMORY_KEEP_LATE: 'on', EGDESK_CONTEXT_RELEVANCE: 'action' })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const flat = c => (typeof c === 'string' ? c : c.map(p => p.text ?? '').join('\n'))

async function capture() {
  const scripted = scriptedDecisions(), found = []
  const fetchImpl = async (_u, init) => {
    const body = typeof init.body === 'string' ? init.body : Buffer.from(init.body).toString('utf8'), wire = JSON.parse(body)
    const text = wire.input.map(m => flat(m.content)).join('\n'), names = wire.questions.map(q => q.name)
    const message = text.slice(text.lastIndexOf('Message:\n') + 9).trim()
    let answers = await scripted.answer(wire)
    if (names.includes('tn_need')) found.push({ kind: 'triage', message, body })
    if (names.includes('pg_0')) found.push({ kind: 'scan', message, body })
    if (names.includes('tn_need') && message === SAYS.tests) answers = answers.map(a => (a.name === 'tn_need' ? { ...a, probability: 0.99 } : a))
    return new Response(JSON.stringify({ model: 'gpt-6-luna', answers, usage: { input_tokens: 1, output_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  await runJourney({ plan: loadJourneyPlan(PLAN_FILE_V3), send: true, key: 'egd-synthetic-not-a-key-0022', fetchImpl, env: MEMORY_ACTION_V2_ENV })
  return found
}

export async function buildMemoryActionV2Plan() {
  const found = await capture()
  const one = (kind, message) => { const list = found.filter(f => f.kind === kind && f.message === message); if (list.length !== 1) throw new Error(`${kind} ${message}: ${list.length} bodies`); return list[0].body }
  const items = [
    { id: 's4-triage', body: one('triage', SAYS.tests), expect: () => [{ name: 'tn_action', kind: 'predicate', min: YES, severity: 'hard', note: 'a request to run the tests: an operation outside the conversation' }] },
    { id: 's3b-triage', body: one('triage', SAYS.recall), expect: () => [{ name: 'tn_action', kind: 'predicate', max: NO, severity: 'hard', note: 'a question about a recorded design, not an operation' },
      { name: 'tn_need', kind: 'predicate', min: YES, severity: 'hard', note: 'the design question needs the design page (real v4 and c24: 1.0)' }] },
    { id: 's9-triage', body: one('triage', SAYS.deployed), expect: () => [{ name: 'tn_action', kind: 'predicate', max: NO, severity: 'hard', note: 'a report that the deployment finished asks for no operation' }] },
  ]
  const requests = [], files = []
  for (const item of items) {
    const wire = JSON.parse(item.body), dev = flat(wire.input[0].content)
    if (!wire.questions.some(q => q.name === 'tn_action')) throw new Error(`${item.id}: no tn_action question in the body`)
    const bytes = Buffer.from(item.body, 'utf8'), file = `requests/${item.id}.json`
    requests.push({ id: item.id, file, sha256: sha(bytes), estInputTokens: independentEstimate(wire.questions.filter(q => q.type === 'choice').length, wire.questions.filter(q => q.type === 'predicate').length, bytes.length), expect: item.expect(wire) })
    files.push({ file, bytes })
  }
  const est = requests.reduce((n, r) => n + r.estInputTokens, 0)
  if (est > MEMORY_ACTION_V2_CEILING) throw new Error(`${est} over ${MEMORY_ACTION_V2_CEILING}`)
  const bars = { yes: YES, no: NO, source: 'egdesk-wiki-reconstruction.mjs YES / NO (.8 / .2): the triage and the scan act on a decided yes or no' }
  const plan = { set: 'memory-action-v2', tokenCeiling: MEMORY_ACTION_V2_CEILING, productBars: { tn_need: bars, tn_action: { ...bars, source: 'egdesk-turn-memory.mjs prepareTurnMemory: a decided tn_action yes (>= .8) fetches no stored page; ternary YES / NO .8 / .2' } },
    passRule: 'All hard checks pass: the test-run request is a decided action request (no stored page is fetched); the design question and the deployment report are decided not, and the design question still needs its page. Built by the product (all-on journey, v4 flags plus EGDESK_CONTEXT_RELEVANCE=action, scripted model, offline).',
    requests }
  return { plan, planBytes: Buffer.from(JSON.stringify(plan, null, 2) + '\n'), files, est }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', MEMORY_ACTION_V2_DIR)
  const write = process.argv.includes('--write'), built = await buildMemoryActionV2Plan()
  let differs = 0
  for (const [name, bytes] of [['plan.json', built.planBytes], ...built.files.map(f => [f.file, f.bytes])]) {
    const target = path.join(dir, name)
    if (write) { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes) }
    else { let same = false; try { same = readFileSync(target).equals(bytes) } catch { same = false } if (!same) { differs++; console.log(`differs: ${name}`) } }
  }
  console.log(`${write ? 'written' : differs ? 'DIFFERS' : 'matches'}: ${built.plan.requests.length} requests, est input tokens ${built.est} of ${MEMORY_ACTION_V2_CEILING}`)
  process.exitCode = differs ? 1 : 0
}
