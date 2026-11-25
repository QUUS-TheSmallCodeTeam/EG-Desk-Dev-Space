#!/usr/bin/env node
// u4: the turn stage table from the decision-call log. Reads only; never sends, never writes. Usage:
//   node scripts/egdesk-decision-call-table.mjs db <copy of a chat-*.sqlite> [--since <ISO>] [--until <ISO>] [--engine claude|codex] [--json]
//       the bridge's chat store: COPY it first (cp the .sqlite and its -wal/-shm into a scratch folder, delete the copy afterwards); it is opened read-only
//   node scripts/egdesk-decision-call-table.mjs route <file.json> [--json]      the JSON of GET /chat/decision-calls (calls only, no stage times)
// Exit: 0 rows found, 1 none, 2 usage.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { formatCallTable, summarizeCalls, turnsFromChatDb, turnsFromRouteJson } from '../helper/egdesk-decision-call-table.mjs'

export function main(argv, { print = line => console.log(line), printError = line => console.error(line), open = file => new DatabaseSync(file, { readOnly: true }), read = file => fs.readFileSync(file, 'utf8') } = {}) {
  const args = [...argv], mode = args.shift(), json = args.includes('--json')
  const value = name => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null }
  const file = args.find((a, i) => !a.startsWith('--') && !['--since', '--until', '--engine'].includes(args[i - 1]))
  let turns = []
  if (mode === 'db' && file) {
    const since = value('--since') ? Date.parse(value('--since')) : 0, until = value('--until') ? Date.parse(value('--until')) : Number.MAX_SAFE_INTEGER
    if (Number.isNaN(since) || Number.isNaN(until)) { printError('--since and --until are ISO times'); return 2 }
    const db = open(path.resolve(file))
    try { turns = turnsFromChatDb(db, { since, until, engine: value('--engine') }) } finally { db.close?.() }
  } else if (mode === 'route' && file) turns = turnsFromRouteJson(JSON.parse(read(path.resolve(file))))
  else { printError('usage: egdesk-decision-call-table.mjs db <chat sqlite COPY> [--since ISO] [--until ISO] [--engine claude|codex] [--json] | route <file.json> [--json]'); return 2 }
  print(json ? JSON.stringify({ turns: turns.map(t => ({ ...t, summary: summarizeCalls(t.calls) })) }, null, 2) : formatCallTable(turns).join('\n'))
  return turns.length ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) process.exitCode = main(process.argv.slice(2))
