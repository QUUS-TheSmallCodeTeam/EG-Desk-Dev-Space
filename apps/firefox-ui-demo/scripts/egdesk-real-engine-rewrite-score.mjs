#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { formatRewriteScore, scoreRewriteRecords } from '../helper/egdesk-real-engine-rewrite.mjs'

// L2 c26: scores the rewrite conversations (real-engine-rewrite-v1) of a real-engine check run: per case how often the draft drew a finding, the real model rewrote, the rewrite
// passed the re-check, only the certain part was posted, nothing remained, and whether anything wrong reached the person. Reads only; never sends. Usage:
//   node scripts/egdesk-real-engine-rewrite-score.mjs <records dir | record.json>… [--json]
const args = process.argv.slice(2), json = args.includes('--json'), inputs = args.filter(a => a !== '--json')
if (!inputs.length) { console.error('usage: egdesk-real-engine-rewrite-score.mjs <records dir | record.json>… [--json]'); process.exit(2) }
const files = inputs.flatMap(p => (statSync(p).isDirectory() ? readdirSync(p, { recursive: true }).filter(f => f.endsWith('.json')).map(f => path.join(p, f)) : [p]))
const score = scoreRewriteRecords(files.map(f => JSON.parse(readFileSync(f, 'utf8'))))
console.log(json ? JSON.stringify(score, null, 2) : formatRewriteScore(score))
process.exitCode = score.total.n ? 0 : 1
