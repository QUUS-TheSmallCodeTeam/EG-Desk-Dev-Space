#!/usr/bin/env node
// node scripts/egdesk-run-chain.mjs [--json] results-1.json results-2.json ...   (one plan family, oldest first)
// Prints each run (pass/fail, hard failures, requests, how many are byte-identical to an earlier pass, FRESH) and the counts. Reads files only.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chain, summarize } from '../helper/egdesk-run-chain.mjs'

export function run(argv, { print = line => console.log(line), printError = line => console.error(line), read = file => JSON.parse(readFileSync(file, 'utf8')) } = {}) {
  const json = argv.includes('--json'), files = argv.filter(arg => arg !== '--json')
  if (!files.length || files.some(file => file.startsWith('--'))) { printError('usage: egdesk-run-chain.mjs [--json] results.json [...] (one plan family, oldest first)'); return 2 }
  let entries
  try { entries = files.map(file => ({ name: path.basename(file).replace(/-results\.json$|\.json$/, ''), results: read(file) })) } catch { printError('a results file cannot be read'); return 2 }
  const list = chain(entries), sum = summarize(list)
  if (json) { print(JSON.stringify({ runs: list, ...sum })); return 0 }
  for (const x of list) print(`${x.name.padEnd(34)} ${x.pass ? 'pass' : 'FAIL'}  hard ${x.hardFailures ?? '?'}  requests ${String(x.requests).padStart(3)}  identical to an earlier pass ${String(x.sameAsEarlierPass).padStart(3)}${x.fresh ? '  FRESH' : ''}${x.unreadable ? '  (no scorecard)' : ''}`)
  print(`passed ${sum.passed}, failed ${sum.failed}, fresh passes ${sum.freshPasses}, last ${sum.last}`)
  return 0
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = run(process.argv.slice(2))
