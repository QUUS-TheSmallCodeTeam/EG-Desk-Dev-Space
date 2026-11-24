#!/usr/bin/env node
// Collects conversation examples (helper/egdesk-conversation-examples.mjs) from the person's own LLM-app conversations into a directory
// OUTSIDE the repository, and prepares the Decision labelling plan (dry run only; Main sends).
//
//   node scripts/egdesk-conversation-examples.mjs --out <dir> [--since <ISO>] [--codex <dir>] [--claude <dir>] [--pinned <dir>]
//        [--aside <file>]... [--chunks <n>] [--chunk-tokens <n>] [--labels <results.json>]
//
// Defaults: --codex ~/.codex/sessions (rollout-*.jsonl, any depth), --claude ~/.claude/projects (directories named for EG-Desk or Taehwa),
// --pinned ~/Projects/CodexThreadAnalysis/Codex-pinned-transcripts-20260724_171134/extracted (*/transcript.raw.jsonl). Every file is
// streamed line by line and only read. Writes (0600 files, 0700 directories): examples/<area>.jsonl, scenarios.json, manifest.json
// (per example id / hash / area / time / tags, per source file size and time), fingerprints.json (hashes only; the real-measure runners'
// guard reads it), changes.json (new / changed against the earlier manifest), plans/chunk-NNN/ (plan.json, requests/, preregistration.json).
// --labels: a runner results file of a sent chunk; its answers become the labels of those examples' scenarios.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APPROVAL, AREAS, CONTROL_EXAMPLES, TYPE_NAMES, buildLabelPlan, dedupe, examplesOf, readLabels, scenariosOf, streamTurns } from '../helper/egdesk-conversation-examples.mjs'
import { seedFingerprints } from '../helper/egdesk-scenario-seed-guard.mjs'
import { DECISION_MODEL } from '../helper/egdesk-decision-client.mjs'

const argv = process.argv.slice(2)
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null }
const opts = name => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []))
const home = os.homedir()
const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '..', '..', '..')
const out = opt('--out') ? path.resolve(opt('--out')) : null
if (!out) { console.error('--out <dir> is required (outside the repository)'); process.exit(2) }
const rel = path.relative(repo, out)
if (!rel.startsWith('..') && !path.isAbsolute(rel)) { console.error(`refused: --out ${out} is inside the repository`); process.exit(2) }
const since = opt('--since')
if (since && Number.isNaN(Date.parse(since))) { console.error('--since must be an ISO date'); process.exit(2) }

const walk = (dir, test, depth = 6) => { if (!existsSync(dir) || depth < 0) return []; const list = []
  for (const name of readdirSync(dir).sort()) { const p = path.join(dir, name); const s = statSync(p); if (s.isDirectory()) list.push(...walk(p, test, depth - 1)); else if (test(name, p)) list.push(p) } return list }
const codexDir = opt('--codex') ?? path.join(home, '.codex', 'sessions'), claudeDir = opt('--claude') ?? path.join(home, '.claude', 'projects')
const pinnedDir = opt('--pinned') ?? path.join(home, 'Projects', 'CodexThreadAnalysis', 'Codex-pinned-transcripts-20260724_171134', 'extracted')
const sources = [
  ...walk(codexDir, n => /^rollout-.*\.jsonl$/.test(n)).map(file => ({ kind: 'codex', file, project: '' })),
  ...(existsSync(claudeDir) ? readdirSync(claudeDir).sort().filter(d => /EG-Desk|Taehwa|태화/i.test(d)).flatMap(d => walk(path.join(claudeDir, d), n => n.endsWith('.jsonl'), 0).map(file => ({ kind: 'claude', file, project: d }))) : []),
  ...walk(pinnedDir, n => n === 'transcript.raw.jsonl', 2).map(file => ({ kind: 'codex', file, project: path.basename(path.dirname(file)) })),
  ...opts('--aside').map(file => ({ kind: 'aside', file: path.resolve(file), project: 'EG-Desk (Aside session)' })),
]
const shown = file => (file.startsWith(home) ? `~${file.slice(home.length)}` : file)
const all = [], perSource = []
for (const s of sources) {
  const turns = []
  for await (const t of streamTurns(s.file, s.kind)) turns.push({ role: t.role, text: t.text, at: t.at, line: t.line, cwd: t.cwd })
  const ex = examplesOf(turns, { source: s.kind, file: shown(s.file), project: s.project })
  const st = statSync(s.file)
  perSource.push({ kind: s.kind, file: shown(s.file), bytes: st.size, mtime: Math.floor(st.mtimeMs), turns: turns.length, examples: ex.length, dropped: ex.dropped })
  all.push(...ex)
}
const examples = dedupe(all).filter(e => !since || (e.at && e.at >= since))

mkdirSync(out, { recursive: true, mode: 0o700 }); chmodSync(out, 0o700)
const write = (file, text) => { const target = path.join(out, file); mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 }); const tmp = `${target}.tmp`; writeFileSync(tmp, text, { mode: 0o600 }); renameSync(tmp, target) }
const previous = existsSync(path.join(out, 'manifest.json')) ? JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')) : null
const prior = new Map((previous?.examples ?? []).map(r => [r.id, r]))
const kept = since ? (previous?.examples ?? []).filter(r => !examples.some(e => e.id === r.id)) : []
for (const area of AREAS) {
  const earlier = since && existsSync(path.join(out, 'examples', `${area}.jsonl`)) ? readFileSync(path.join(out, 'examples', `${area}.jsonl`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => !examples.some(x => x.id === e.id)) : []
  write(path.join('examples', `${area}.jsonl`), [...earlier, ...examples.filter(e => e.area === area)].sort((a, b) => (String(a.at) < String(b.at) ? -1 : 1)).map(e => JSON.stringify(e)).join('\n') + '\n')
}
// Labels of a sent chunk (runner results: { results: { <request id>: { answers } } }) turn heuristic scenarios into labelled ones.
const labels = new Map()
if (opt('--labels')) { const res = JSON.parse(readFileSync(path.resolve(opt('--labels')), 'utf8')); for (const [id, r] of Object.entries(res.results ?? {})) if (r?.answers && id.startsWith('ex-')) labels.set(id.slice(3), readLabels(r.answers)) }
const scenarios = examples.flatMap(e => scenariosOf(e, labels.get(e.id) ?? null))
write('scenarios.json', `${JSON.stringify(scenarios, null, 1)}\n`)
const rows = examples.map(e => ({ id: e.id, variant: 'example', hash: e.hash, area: e.area, privacy: e.privacy, at: e.at, tags: e.tags }))
const manifest = { schema: 'egdesk.conversation-examples-manifest/1', ...(since ? { since } : {}), approval: APPROVAL, sources: perSource,
  examples: [...rows, ...kept].sort((a, b) => (a.id < b.id ? -1 : 1)) }
manifest.seeds = manifest.examples.map(({ id, variant, privacy }) => ({ id, variant, privacy })) // the guard's view (helper/egdesk-scenario-seed-guard.mjs)
const prints = since && existsSync(path.join(out, 'fingerprints.json')) ? JSON.parse(readFileSync(path.join(out, 'fingerprints.json'), 'utf8')) : {}
for (const e of examples) prints[`${e.id}|example`] = seedFingerprints({ title: '', pages: [], facts: [], turns: [{ text: e.user.text }, ...(e.prev ? [{ text: e.prev.text }] : [])] })
write('fingerprints.json', `${JSON.stringify(Object.fromEntries(Object.entries(prints).sort()))}\n`)
write('manifest.json', `${JSON.stringify(manifest, null, 1)}\n`)
const changes = { new: rows.filter(r => !prior.has(r.id)).length, changed: rows.filter(r => prior.has(r.id) && prior.get(r.id).hash !== r.hash).length, unchanged: rows.filter(r => prior.get(r.id)?.hash === r.hash).length, kept: kept.length }
write('changes.json', `${JSON.stringify(changes, null, 1)}\n`)

// The labelling plan, chunked; the first --chunks chunks are written (default 1).
const chunks = buildLabelPlan(examples, { model: DECISION_MODEL, chunkTokens: Number(opt('--chunk-tokens') ?? 12000), sha: text => createHash('sha256').update(text).digest('hex') })
const nChunks = Math.min(chunks.length, Number(opt('--chunks') ?? 1))
for (let i = 0; i < nChunks; i++) {
  const dir = path.join('plans', `chunk-${String(i + 1).padStart(3, '0')}`), c = chunks[i]
  for (const r of c.requests) write(path.join(dir, r.file), r.body)
  write(path.join(dir, 'plan.json'), `${JSON.stringify({ ...c.plan, requests: c.plan.requests }, null, 1)}\n`)
  write(path.join(dir, 'preregistration.json'), `${JSON.stringify(c.preregistration, null, 1)}\n`)
}
const count = (list, key) => Object.fromEntries([...new Set(list.map(key))].sort().map(k => [k, list.filter(x => key(x) === k).length]))
console.log(JSON.stringify({ out, sources: perSource.length, turnsRead: perSource.reduce((n, s) => n + s.turns, 0), examples: examples.length,
  perArea: count(examples, e => e.area), candidates: examples.filter(e => e.tags.length).length,
  perType: Object.fromEntries(TYPE_NAMES.map(t => [t, examples.filter(e => e.tags.includes(t)).length])),
  dropped: perSource.reduce((m, s) => ({ no_area: m.no_area + s.dropped.no_area, empty: m.empty + s.dropped.empty }), { no_area: 0, empty: 0 }),
  scenarios: scenarios.length, perFeature: count(scenarios, s => s.feature), chunks: chunks.length, written: nChunks,
  firstChunk: chunks[0] ? { requests: chunks[0].plan.requests.length, estInputTokens: chunks[0].plan.requests.reduce((n, r) => n + r.estInputTokens, 0), tokenCeiling: chunks[0].plan.tokenCeiling } : null,
  controls: CONTROL_EXAMPLES.length, changes }))
