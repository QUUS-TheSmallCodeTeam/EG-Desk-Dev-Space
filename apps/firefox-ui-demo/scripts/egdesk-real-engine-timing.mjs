#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { compareRuns, formatCompare, formatSummary, formatTable, recordTimings, summarize } from '../helper/egdesk-real-engine-timing.mjs'

// L2 c31: the shared U13 timing measure for the real-engine check's records. Reads only; never sends. Usage:
//   node scripts/egdesk-real-engine-timing.mjs table   <records dir | record.json>… [--json] [--set <prefix>]     one row per scripted turn and the top-line numbers
//   node scripts/egdesk-real-engine-timing.mjs compare <records dir (flag off)> <records dir (flag on)> [--json] [--normalize '<regexp>']
//       the SAME script run twice (flags set per conversation in the script, e.g. an -off and an -on copy; --normalize '-off|-on' drops the suffix from set and conversation ids before matching):
//       seconds saved per turn, Decision calls, engine rounds, changed answer facts
// A records dir is the check's <out>/records (or any folder holding its <set>/<id>.json files).
const args = process.argv.slice(2), mode = args.shift(), json = args.includes('--json')
const at = args.indexOf('--set'), prefix = at >= 0 ? args[at + 1] : null, nat = args.indexOf('--normalize'), normalize = nat >= 0 && args[nat + 1] ? new RegExp(args[nat + 1], 'g') : null
const inputs = args.filter((a, i) => a !== '--json' && a !== '--set' && a !== '--normalize' && !(at >= 0 && i === at + 1) && !(nat >= 0 && i === nat + 1))
const files = list => list.flatMap(p => (statSync(p).isDirectory() ? readdirSync(p, { recursive: true }).filter(f => f.endsWith('.json')).map(f => path.join(p, f)) : [p]))
const records = list => files(list).flatMap(f => { try { const r = JSON.parse(readFileSync(f, 'utf8')); return r?.set && r?.id && Array.isArray(r.turns) && (!prefix || r.set.startsWith(prefix)) ? [r] : [] } catch { return [] } })
if (mode === 'table' && inputs.length) {
  const rows = recordTimings(records(inputs)), summary = summarize(rows)
  const sets = [...new Set(rows.map(r => r.set))].sort(), bySet = Object.fromEntries(sets.map(set => [set, summarize(rows.filter(r => r.set === set))]))
  console.log(json ? JSON.stringify({ rows, summary, bySet }, null, 2) : `${formatTable(rows)}\n\nALL\n${formatSummary(summary)}\n\n${sets.map(set => `${set}\n${formatSummary(bySet[set])}`).join('\n\n')}`)
  process.exitCode = rows.length ? 0 : 1
} else if (mode === 'compare' && inputs.length === 2) {
  const result = compareRuns(records([inputs[0]]), records([inputs[1]]), { normalize })
  console.log(json ? JSON.stringify(result, null, 2) : formatCompare(result))
  process.exitCode = result.turns.length ? 0 : 1
} else { console.error('usage: egdesk-real-engine-timing.mjs table <records…> [--json] [--set <prefix>] | compare <off records> <on records> [--json]'); process.exitCode = 2 }
