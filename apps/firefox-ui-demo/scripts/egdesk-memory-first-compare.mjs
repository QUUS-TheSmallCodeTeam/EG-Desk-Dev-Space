#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Compares real-engine-memory-first-v1 and -v2 records: for every conversation and turn the engine seconds, whether it passed, what was settled before the engine (flag on) and the answer. Reads only.
//   node scripts/egdesk-memory-first-compare.mjs <records dir | record.json>…
const turnFacts = (t, i) => { const sub = t?.subTurns?.at(-1), rec = t?.recording ?? t?.hooks?.recording ?? null
  return { n: i + 1, ms: sub?.latencyMs ?? null, ok: (t?.expectations ?? []).every(e => e.ok), failed: (t?.expectations ?? []).filter(e => !e.ok).map(e => e.check),
    settled: rec?.settled ?? null, answer: String(t?.posted?.at(-1) ?? '').replace(/\s+/g, ' ').slice(0, 90) } }

/** compare(records) -> { lines, ok } for parsed records of the set (others are ignored). */
export function compare(all) {
  const records = all.filter(r => r?.set === 'real-engine-memory-first-v1' || r?.set === 'real-engine-memory-first-v2')
  const lines = ['| conversation | turn | ok | engine s | settled before engine | answer |', '|---|---|---|---|---|---|']
  for (const r of records) for (const f of (r.turns ?? []).map(turnFacts)) {
    const s = f.settled, settled = !s ? '-' : `${s.inTime && s.sent ? 'yes' : 'no'} (${s.kind ?? 'none'}, ${s.ms ?? '?'} ms${s.conflict ? `, conflict ${s.conflict}` : ''}${s.contradictions?.found ? `, contradictions ${s.contradictions.found}` : ''}${s.stored ? ', page stored' : ''})`
    lines.push(`| ${r.id} | ${f.n} | ${f.ok ? 'ok' : `FAIL ${f.failed.join(',')}`} | ${f.ms === null ? '?' : (f.ms / 1000).toFixed(1)} | ${settled} | ${f.answer} |`)
  }
  const get = (id, n) => (records.find(r => r.id === id)?.turns ?? []).map(turnFacts)[n - 1] ?? null
  const off = get('own-confirm-off', 2), on = get('own-confirm-first', 2)
  if (off?.ms != null && on?.ms != null) lines.push('', `turn 2 (the statement): engine ${(off.ms / 1000).toFixed(1)} s without the flag, ${(on.ms / 1000).toFixed(1)} s with it; the person's "응 맞아" confirms at turn ${on && get('own-confirm-first', 3)?.ok ? 3 : '?'} with the flag (turn 4 without it)`)
  return { lines, ok: records.length > 0 && records.every(r => r.ok) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const inputs = process.argv.slice(2)
  if (!inputs.length) { console.error('usage: egdesk-memory-first-compare.mjs <records dir | record.json>…'); process.exit(2) }
  const files = inputs.flatMap(p => (statSync(p).isDirectory() ? readdirSync(p, { recursive: true }).filter(f => f.endsWith('.json')).map(f => path.join(p, f)) : [p]))
  const out = compare(files.map(f => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }))
  console.log(out.lines.join('\n')); process.exitCode = out.ok ? 0 : 1
}
