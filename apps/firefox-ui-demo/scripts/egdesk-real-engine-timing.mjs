#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareRuns, formatCompare, formatSummary, formatTable, recordTimings, summarize } from '../helper/egdesk-real-engine-timing.mjs'

// L2 c31: the shared U13 timing measure for the real-engine check's records. Reads only; never sends. Usage:
//   node scripts/egdesk-real-engine-timing.mjs table   <records dir | record.json>… [--json] [--set <prefix>]     one row per scripted turn, top-line numbers overall and per script
//   node scripts/egdesk-real-engine-timing.mjs compare <records dir (flag off)> <records dir (flag on)> [--json] [--normalize '<regexp>']
//       the SAME script run twice (flags set per conversation in the script, e.g. an -off and an -on copy; --normalize '-off|-on' drops the suffix from set and conversation ids before matching):
//       seconds saved per turn, Decision calls, engine rounds, changed answer facts
//   node scripts/egdesk-real-engine-timing.mjs compare <records dir> --pairs [--json]
//       ONE records dir whose conversation ids end in -off / -on (a journey script of off/on pairs, e.g. real-engine-journey-u13-v10): the -off conversations are the flag-off side, the -on ones the flag-on side
// A records dir is the check's <out>/records (or any folder holding its <set>/<id>.json files). Exit: 0 rows found, 1 none, 2 usage.
const files = list => list.flatMap(p => (statSync(p).isDirectory() ? readdirSync(p, { recursive: true }).filter(f => f.endsWith('.json')).map(f => path.join(p, f)) : [p]))

export function main(argv, { print = line => console.log(line), printError = line => console.error(line) } = {}) {
  const args = [...argv], mode = args.shift(), json = args.includes('--json')
  const at = args.indexOf('--set'), prefix = at >= 0 ? args[at + 1] : null, nat = args.indexOf('--normalize'), normalize = nat >= 0 && args[nat + 1] ? new RegExp(args[nat + 1], 'g') : null
  const pairs = args.includes('--pairs')
  const inputs = args.filter((a, i) => a !== '--json' && a !== '--pairs' && a !== '--set' && a !== '--normalize' && !(at >= 0 && i === at + 1) && !(nat >= 0 && i === nat + 1))
  const records = list => files(list).flatMap(f => { try { const r = JSON.parse(readFileSync(f, 'utf8')); return r?.set && r?.id && Array.isArray(r.turns) && (!prefix || r.set.startsWith(prefix)) ? [r] : [] } catch { return [] } })
  if (mode === 'table' && inputs.length) {
    const rows = recordTimings(records(inputs)), summary = summarize(rows)
    const sets = [...new Set(rows.map(r => r.set))].sort(), bySet = Object.fromEntries(sets.map(set => [set, summarize(rows.filter(r => r.set === set))]))
    print(json ? JSON.stringify({ rows, summary, bySet }, null, 2) : `${formatTable(rows)}\n\nALL\n${formatSummary(summary)}\n\n${sets.map(set => `${set}\n${formatSummary(bySet[set])}`).join('\n\n')}`)
    return rows.length ? 0 : 1
  }
  if (mode === 'compare' && pairs && inputs.length === 1) {
    const all = records([inputs[0]]), side = suffix => all.filter(r => r.id.endsWith(suffix))
    const result = compareRuns(side('-off'), side('-on'), { normalize: /-off$|-on$/g })
    print(json ? JSON.stringify(result, null, 2) : formatCompare(result))
    return result.turns.length ? 0 : 1
  }
  if (mode === 'compare' && inputs.length === 2) {
    const result = compareRuns(records([inputs[0]]), records([inputs[1]]), { normalize })
    print(json ? JSON.stringify(result, null, 2) : formatCompare(result))
    return result.turns.length ? 0 : 1
  }
  printError('usage: egdesk-real-engine-timing.mjs table <records…> [--json] [--set <prefix>] | compare <off records> <on records> [--json] [--normalize <regexp>] | compare <records> --pairs [--json]')
  return 2
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2))
