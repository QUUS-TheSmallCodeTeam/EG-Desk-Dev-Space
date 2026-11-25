#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

// Compares the -off / -on pairs of real-engine-prefetch-v1 in a check's records: engine tool calls, items, latency and tokens per turn, and the saving. Reads only.
//   node scripts/egdesk-prefetch-compare.mjs <records dir | record.json>…
const inputs = process.argv.slice(2)
if (!inputs.length) { console.error('usage: egdesk-prefetch-compare.mjs <records dir | record.json>…'); process.exit(2) }
const files = inputs.flatMap(p => (statSync(p).isDirectory() ? readdirSync(p, { recursive: true }).filter(f => f.endsWith('.json')).map(f => path.join(p, f)) : [p]))
const records = files.map(f => JSON.parse(readFileSync(f, 'utf8'))).filter(r => r?.set === 'real-engine-prefetch-v1')
const facts = rec => { const turn = rec.turns?.[0], sub = turn?.subTurns?.at(-1), all = turn?.subTurns ?? []
  return { ok: rec.ok === true, toolCalls: (turn?.subTurns ?? []).flatMap(s => s.toolCalls ?? []).length, tools: (sub?.toolCalls ?? []).map(c => c.tool).join(','), ms: sub?.latencyMs ?? null, items: JSON.stringify(sub?.items ?? {}), input: all.at(-1)?.usage?.input ?? null,
    keys: (turn?.contextKeys ?? []).join('+'), keyBytes: turn?.memory?.keyBytes ? JSON.stringify(turn.memory.keyBytes) : null, answer: String(turn?.posted?.at(-1) ?? '').slice(0, 80) } }
const by = new Map(records.map(r => [r.id, facts(r)]))
console.log('| scenario | mode | ok | engine tool calls | engine s | input tokens | context keys | answer |\n|---|---|---|---|---|---|---|---|')
let saved = 0, pairs = 0
for (const name of ['notes', 'code', 'ledger']) {
  for (const mode of ['off', 'on']) { const f = by.get(`${name}-${mode}`); if (f) console.log(`| ${name} | ${mode} | ${f.ok ? 'ok' : 'FAIL'} | ${f.toolCalls} ${f.tools ? `(${f.tools})` : ''} | ${f.ms === null ? '?' : (f.ms / 1000).toFixed(1)} | ${f.input ?? '?'} | ${f.keys} | ${f.answer} |`) }
  const off = by.get(`${name}-off`), on = by.get(`${name}-on`)
  if (off?.ms != null && on?.ms != null) { pairs++; saved += off.ms - on.ms; console.log(`| ${name} | saving | | ${off.toolCalls - on.toolCalls} calls | ${((off.ms - on.ms) / 1000).toFixed(1)} | | | |`) }
}
if (pairs) console.log(`\nmean saving over ${pairs} pairs: ${(saved / pairs / 1000).toFixed(1)} s per turn`)
process.exitCode = records.length && records.every(r => r.ok) ? 0 : 1
