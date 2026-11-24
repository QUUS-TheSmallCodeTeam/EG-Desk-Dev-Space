#!/usr/bin/env node
// Real-behaviour scenarios from the conversation examples (helper/egdesk-conversation-scenarios.mjs), in MOCK mode, and the real plan.
//
//   node scripts/egdesk-conversation-scenarios.mjs --examples <conversation-examples dir> --out <dir> [--labels <results.json>]...
//
// Reads <examples>/examples/*.jsonl (masked, outside the repository) and the labelling results given; plays one example per scenario kind
// through lane L2's all-on world with scripted Decision answers; writes <out>/mock-results.json (per scenario: the requests the product
// built for the turn, families and question names) and <out>/plan/ (plan.json, requests/, preregistration.json). Nothing is sent.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AREAS, readLabelScores, readLabels } from '../helper/egdesk-conversation-examples.mjs'
import { pickByLabels, pickScenarios, runScenario, scenarioPlan } from '../helper/egdesk-conversation-scenarios.mjs'
import { judgeConfirmation } from '../helper/egdesk-record-confirmation.mjs'
import { createDecisionClient } from '../helper/egdesk-decision-client.mjs'
import { independentEstimate } from '../helper/egdesk-decision-real-runner.mjs'

export async function main(argv = process.argv.slice(2), { print = line => console.log(line), printError = line => console.error(line), allOnWorld = null } = {}) {
  const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
  const opts = name => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []))
  const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '..', '..', '..')
  const src = opt('--examples'), out = opt('--out') ? path.resolve(opt('--out')) : null
  if (!src || !out) { printError('--examples <dir> and --out <dir> are required'); return 2 }
  const rel = path.relative(repo, out)
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) { printError(`refused: --out ${out} is inside the repository`); return 2 }
  const examples = AREAS.flatMap(a => { const f = path.join(src, 'examples', `${a}.jsonl`); return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [] })
  const labels = new Map(), scores = new Map()
  for (const file of opts('--labels')) { const res = JSON.parse(readFileSync(path.resolve(file), 'utf8')); for (const [id, r] of Object.entries(res.results ?? {})) if (r?.answers && id.startsWith('ex-')) { labels.set(id.slice(3), readLabels(r.answers)); scores.set(id.slice(3), readLabelScores(r.answers)) } }
  // --v2 (c21): picked by the Decision labels only (the strongest per kind and area), the in-run kinds included, a 12k budget.
  const v2 = argv.includes('--v2')
  const world = allOnWorld ?? (await import('./egdesk-all-on.support.mjs')).allOnWorld
  const makeClient = fetchImpl => createDecisionClient({ getApiKey: async () => 'egd-synthetic-not-a-key-scenarios', fetchImpl })
  const flowWorld = v2 ? (await import('../helper/egdesk-heartbeat-flow.fixture.mjs')).world : null
  const picked = v2 ? pickByLabels(examples, scores, { perArea: 1 }) : pickScenarios(examples, labels)
  const results = []
  for (const p of picked) { const r = await runScenario(p, { allOnWorld: world, judgeConfirmation, makeClient, flowWorld }); results.push({ ...r, example: p.example, labelledBy: p.labelledBy, ...(p.score !== undefined ? { score: p.score } : {}) }) }
  mkdirSync(out, { recursive: true, mode: 0o700 }); chmodSync(out, 0o700)
  const write = (file, text) => { const target = path.join(out, file); mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(`${target}.tmp`, text, { mode: 0o600 }); renameSync(`${target}.tmp`, target) }
  const estimate = body => { const q = JSON.parse(body).questions; return independentEstimate(q.filter(x => x.type === 'choice').length, q.filter(x => x.type !== 'choice').length, Buffer.byteLength(body)) }
  write('mock-results.json', `${JSON.stringify(results.map(r => ({ kind: r.kind, labelledBy: r.labelledBy, ...(r.score !== undefined ? { score: r.score, labels: scores.get(r.example.id) } : {}), example: { id: r.example.id, area: r.example.area, at: r.example.at, source: r.example.source, tags: r.example.tags,
    before: r.example.before?.text ?? null, prev: r.example.prev?.text ?? null, user: r.example.user.text },
    requests: r.requests.map(q => ({ family: q.family, names: q.names, bytes: Buffer.byteLength(q.body) })), target: r.target ? { family: r.target.family, bytes: Buffer.byteLength(r.target.body), estInputTokens: estimate(r.target.body) } : null, seen: r.seen })), null, 1)}\n`)
  const built = scenarioPlan(results, v2 ? { estimate, budget: 11_500, set: 'conversation-scenarios-002' } : { estimate })
  for (const r of built.requests) write(path.join('plan', r.file), r.body)
  write(path.join('plan', 'plan.json'), `${JSON.stringify(built.plan, null, 1)}\n`)
  write(path.join('plan', 'preregistration.json'), `${JSON.stringify(built.preregistration, null, 1)}\n`)
  print(JSON.stringify({ out, examples: examples.length, labelled: labels.size, scenarios: results.length, withTarget: results.filter(r => r.target).length,
    perKind: Object.fromEntries(results.map(r => [r.kind, { labelledBy: r.labelledBy, families: [...new Set(r.requests.map(q => q.family))], target: Boolean(r.target) }])), plan: { requests: built.plan.requests.length, estInputTokens: built.total, tokenCeiling: built.plan.tokenCeiling, dropped: built.dropped ?? [] } }))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main()
