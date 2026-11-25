#!/usr/bin/env node
// c32: per-turn latency of the approval scenario, today's path against the decision-first path, from two real-engine check output folders.
//   node scripts/egdesk-approvals-fast-compare.mjs <out dir of real-engine-approval-words-v1> <out dir of real-engine-approvals-fast-v1>
// Prints, for the question turn and for each reply, latencyMs of every sub-turn, the engine turns and the commands run (from the turn records). Reads records only.
import fs from 'node:fs'
import path from 'node:path'
const [slow, fast] = process.argv.slice(2)
if (!slow || !fast) { console.error('usage: egdesk-approvals-fast-compare.mjs <approval-words out dir> <approvals-fast out dir>'); process.exit(2) }
const read = (dir, set, id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'records', set, `${id}.json`), 'utf8')) } catch { return null } }
const row = (rec, i) => { const t = rec?.turns?.[i]; if (!t) return null; const sub = t.subTurns ?? []; return { latencyMs: sub.reduce((n, s) => n + (Number.isFinite(s.latencyMs) ? s.latencyMs : 0), 0), status: sub.at(-1)?.status ?? null, engineTurns: t.decisionFirst?.engineTurns ?? (t.engineRequests?.['turn/start'] ?? null), reason: t.decisionFirst?.reason ?? null, commandsRan: sub.flatMap(s => s.commandsRan ?? []).length, aborted: rec?.aborted ?? null } }
const pairs = [['just-do-it', 'approval-just-do-it', 'approvals-fast-just-do-it'], ['wait-no', 'approval-wait-no', 'approvals-fast-wait-no']]
const lines = [['conversation', 'turn', 'today ms', 'fast ms', 'fast reason', 'engine turns today -> fast', 'ran today -> fast']]
for (const [name, a, b] of pairs) {
  const ra = read(slow, 'real-engine-approval-words-v1', a), rb = read(fast, 'real-engine-approvals-fast-v1', b)
  for (const [i, label] of [[0, 'question'], [1, 'reply']]) {
    const x = row(ra, i), y = row(rb, i)
    lines.push([name, label, x ? `${x.latencyMs}${x.status === 'timeout' ? ' (timeout)' : ''}` : '-', y ? `${y.latencyMs}${y.status === 'timeout' ? ' (timeout)' : ''}` : '-', y?.reason ?? '-', `${x?.engineTurns ?? '-'} -> ${y?.engineTurns ?? '-'}`, `${x?.commandsRan ?? '-'} -> ${y?.commandsRan ?? '-'}`])
  }
}
for (const l of lines) console.log(l.join('\t'))
