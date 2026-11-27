#!/usr/bin/env node
// node scripts/egdesk-run-chain.mjs [--json] [--checks <id regex>] results-1.json results-2.json ...   (one plan family, oldest first)
// --checks: also the hard checks of each journey run whose id matches (the checks of one flag) and which failed.
// Prints each run (pass/fail, hard failures, requests, how many are byte-identical to an earlier pass, FRESH) and the counts. Reads files only.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { attributed, chain, summarize } from '../helper/egdesk-run-chain.mjs'

export function run(argv, { print = line => console.log(line), printError = line => console.error(line), read = file => JSON.parse(readFileSync(file, 'utf8')) } = {}) {
  const at = argv.indexOf('--checks'), pattern = at >= 0 ? argv[at + 1] : null
  const rest = argv.filter((arg, i) => !(at >= 0 && (i === at || i === at + 1)))
  const json = rest.includes('--json'), files = rest.filter(arg => arg !== '--json')
  let belongs = null
  try { if (at >= 0) { const re = new RegExp(pattern); belongs = id => re.test(id) } } catch { belongs = null }
  if (!files.length || files.some(file => file.startsWith('--')) || (at >= 0 && (!pattern || !belongs))) { printError('usage: egdesk-run-chain.mjs [--json] [--checks <id regex>] results.json [...] (one plan family, oldest first)'); return 2 }
  let entries
  try { entries = files.map(file => ({ name: path.basename(file).replace(/-results\.json$|\.json$/, ''), results: read(file) })) } catch { printError('a results file cannot be read'); return 2 }
  const list = chain(entries), sum = summarize(list)
  if (belongs) list.forEach((x, i) => { x.checks = attributed(entries[i].results, belongs) })
  if (json) { print(JSON.stringify({ runs: list, ...sum })); return 0 }
  for (const x of list) print(`${x.name.padEnd(34)} ${x.pass ? 'pass' : 'FAIL'}  hard ${x.hardFailures ?? '?'}  requests ${String(x.requests).padStart(3)}  identical to an earlier pass ${String(x.sameAsEarlierPass).padStart(3)}${x.fresh ? '  FRESH' : ''}${x.unreadable ? '  (no scorecard)' : ''}${x.checks ? `  | checks ${x.checks.hardChecks}, failed ${x.checks.failed.length ? x.checks.failed.join(',') : 'none'}` : ''}`)
  print(`passed ${sum.passed}, failed ${sum.failed}, fresh passes ${sum.freshPasses}, last ${sum.last}`)
  return 0
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = run(process.argv.slice(2))
