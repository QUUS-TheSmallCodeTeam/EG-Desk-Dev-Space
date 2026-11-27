#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { formatScore, scoreMemoryRecord } from '../helper/egdesk-real-engine-memory-score.mjs'

// Scores the memory conversations of a real-engine check run. Reads only; never sends. Usage:
//   node scripts/egdesk-real-engine-memory-score.mjs <records dir | record.json>… [--json]
const args = process.argv.slice(2), json = args.includes('--json'), inputs = args.filter(a => a !== '--json')
if (!inputs.length) { console.error('usage: egdesk-real-engine-memory-score.mjs <records dir | record.json>… [--json]'); process.exit(2) }
const files = inputs.flatMap(p => (statSync(p).isDirectory() ? readdirSync(p, { recursive: true }).filter(f => f.endsWith('.json')).map(f => path.join(p, f)) : [p]))
const scores = files.map(f => JSON.parse(readFileSync(f, 'utf8'))).filter(r => r?.set && /^real-engine-memory-/.test(r.set)).map(scoreMemoryRecord)
console.log(json ? JSON.stringify(scores, null, 2) : scores.map(formatScore).join('\n\n'))
process.exitCode = scores.length && scores.every(s => s.ok) ? 0 : 1
