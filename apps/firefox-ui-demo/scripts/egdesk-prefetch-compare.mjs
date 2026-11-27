#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Compares the -off / -on pairs of real-engine-prefetch-v1 in a check's records: engine tool calls, latency and tokens per turn, and the saving. Reads only.
//   node scripts/egdesk-prefetch-compare.mjs <records dir | record.json>…
const facts = rec => { const turn = rec.turns?.[0], all = turn?.subTurns ?? [], sub = all.at(-1)
  return { ok: rec.ok === true, toolCalls: all.flatMap(s => s.toolCalls ?? []).length, tools: all.flatMap(s => s.toolCalls ?? []).map(c => c.tool).join(','), ms: sub?.latencyMs ?? null, input: sub?.usage?.input ?? null,
    keys: (turn?.contextKeys ?? []).join('+'), answer: String(turn?.posted?.at(-1) ?? '').slice(0, 80) } }

/** compare(records) → { lines, ok } for parsed records of the set (others are ignored). */
export function compare(all) {
  const records = all.filter(r => r?.set === 'real-engine-prefetch-v1'), by = new Map(records.map(r => [r.id, facts(r)]))
  const lines = ['| scenario | mode | ok | engine tool calls | engine s | input tokens | context keys | answer |', '|---|---|---|---|---|---|---|---|']
  let saved = 0, pairs = 0
  for (const name of ['notes', 'code', 'ledger']) {
    for (const mode of ['off', 'on']) { const f = by.get(`${name}-${mode}`); if (f) lines.push(`| ${name} | ${mode} | ${f.ok ? 'ok' : 'FAIL'} | ${f.toolCalls}${f.tools ? ` (${f.tools})` : ''} | ${f.ms === null ? '?' : (f.ms / 1000).toFixed(1)} | ${f.input ?? '?'} | ${f.keys} | ${f.answer} |`) }
    const off = by.get(`${name}-off`), on = by.get(`${name}-on`)
    if (off?.ms != null && on?.ms != null) { pairs++; saved += off.ms - on.ms; lines.push(`| ${name} | saving | | ${off.toolCalls - on.toolCalls} calls | ${((off.ms - on.ms) / 1000).toFixed(1)} | | | |`) }
  }
  if (pairs) lines.push('', `mean saving over ${pairs} pairs: ${(saved / pairs / 1000).toFixed(1)} s per turn`)
  return { lines, ok: records.length > 0 && records.every(r => r.ok) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inputs = process.argv.slice(2)
  if (!inputs.length) { console.error('usage: egdesk-prefetch-compare.mjs <records dir | record.json>…'); process.exit(2) }
  const files = inputs.flatMap(p => (statSync(p).isDirectory() ? readdirSync(p, { recursive: true }).filter(f => f.endsWith('.json')).map(f => path.join(p, f)) : [p]))
  const out = compare(files.map(f => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }))
  console.log(out.lines.join('\n')); process.exitCode = out.ok ? 0 : 1
}
