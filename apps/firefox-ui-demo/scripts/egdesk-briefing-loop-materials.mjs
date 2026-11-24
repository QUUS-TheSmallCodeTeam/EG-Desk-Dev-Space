#!/usr/bin/env node
// L4 cycle 24: build briefing materials from the decision loop's own record. Reads the ledger and the lane reports READ-ONLY and writes the pages OUTSIDE the
// repository (the out dir must not be inside it). Sends nothing.
//   node scripts/egdesk-briefing-loop-materials.mjs --loop <loop root> --out <dir> [--year <YYYY> --year-basis "<where the year is stated>"]
// The ledger lines state month-day only: without --year every date stays unknown; with it, the basis is written next to the pages.
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLoopPages } from '../helper/egdesk-briefing-ledger-materials.mjs'

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined }
const loop = arg('loop'), out = arg('out'), year = arg('year') ? Number(arg('year')) : null, basis = arg('year-basis') ?? null
if (!loop || !out) { console.error('usage: --loop <loop root> --out <dir> [--year YYYY --year-basis TEXT]'); process.exit(2) }
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
if (path.resolve(out).startsWith(repo + path.sep)) { console.error('refused: the materials stay outside the repository'); process.exit(2) }
if (year !== null && !basis) { console.error('refused: a declared year needs its basis (--year-basis)'); process.exit(2) }
const ledger = readFileSync(path.join(loop, 'LEDGER.md'), 'utf8')
const dir = path.join(loop, 'reports'), reports = readdirSync(dir).filter(f => /^l[1-9]-c\d{1,3}\.md$/.test(f)).sort().map(fileName => ({ fileName, text: readFileSync(path.join(dir, fileName), 'utf8') }))
const pages = buildLoopPages({ ledger, reports, year })
mkdirSync(out, { recursive: true, mode: 0o700 })
const count = (rows, f) => rows.reduce((m, r) => ({ ...m, [f(r)]: (m[f(r)] ?? 0) + 1 }), {})
const sha = t => createHash('sha256').update(t).digest('hex')
// the ledger keeps growing while the loop runs: the snapshot these pages came from is named by its hashes
const summary = { builtFrom: { ledgerLines: ledger.split('\n').length, ledgerSha256: sha(ledger), reports: reports.length, reportsSha256: sha(reports.map(r => `${r.fileName}\n${r.text}`).join('\n\u0000')) }, year: year ?? null, yearBasis: basis, pages: pages.length,
  bySource: count(pages, r => r.source), byStatus: count(pages, r => `${r.source}:${r.status}`), dated: pages.filter(r => r.time.at).length, undated: pages.filter(r => !r.time.at).length }
writeFileSync(path.join(out, 'pages.json'), JSON.stringify(pages, null, 1), { mode: 0o600 })
writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary, null, 1), { mode: 0o600 })
console.log(JSON.stringify(summary))
