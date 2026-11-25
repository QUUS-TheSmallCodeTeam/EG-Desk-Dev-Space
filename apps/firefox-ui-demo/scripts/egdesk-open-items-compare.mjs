#!/usr/bin/env node
// L1 c32: read the records of a real-engine check run of real-engine-open-items-v1 and put the turns side by side: what the resolver settled, its one Decision request's ms, the turn's seconds,
// what ran. Reads files only.   node scripts/egdesk-open-items-compare.mjs <check output dir> [--json]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function* recordFiles(dir) { for (const name of readdirSync(dir)) { const file = path.join(dir, name); if (statSync(file).isDirectory()) yield* recordFiles(file); else if (name.endsWith('.json')) yield file } }
export function load(dir) { return [...recordFiles(dir)].map(file => JSON.parse(readFileSync(file, 'utf8'))).filter(r => r && Array.isArray(r.turns)) }
/** rows: one per turn of every conversation whose id starts with open-. */
export function rowsOf(records) {
  const rows = []
  for (const rec of records) if (String(rec.id).startsWith('open-')) for (const turn of rec.turns ?? []) {
    const o = turn.openItems ?? null, sub = turn.subTurns ?? []
    rows.push({ conversation: rec.id, turn: turn.index, say: turn.say, flag: o?.flag === true, settled: o ? (o.status === 'settled' ? o.kind : 'none') : null, reason: o?.reason ?? null, resolverMs: o?.resolverMs ?? null,
      seconds: sub[0]?.latencyMs != null ? Math.round(sub[0].latencyMs / 100) / 10 : null, commandsRan: sub.flatMap(s => s.commandsRan ?? []), approvalWaiting: o?.approvalWaiting ?? null, ok: turn.ok === true,
      failed: (turn.expectations ?? []).filter(e => !e.ok).map(e => e.check) })
  }
  return rows
}
/** pairs: the same turn of the dialogue without (open-off-*) and with (open-on-*) the flag. */
export function pairsOf(rows) {
  const out = []
  for (const on of rows.filter(r => r.conversation.startsWith('open-on-'))) {
    const off = rows.find(r => r.conversation === on.conversation.replace('open-on-', 'open-off-') && r.turn === on.turn && r.say === on.say)
    if (off) out.push({ dialogue: on.conversation.replace('open-on-', ''), turn: on.turn, say: on.say, offSeconds: off.seconds, onSeconds: on.seconds, addedSeconds: off.seconds != null && on.seconds != null ? Math.round((on.seconds - off.seconds) * 10) / 10 : null, offRan: off.commandsRan, onRan: on.commandsRan, sameCommands: JSON.stringify(off.commandsRan) === JSON.stringify(on.commandsRan) })
  }
  return out
}
export function render(rows, pairs) {
  const c = v => String(v ?? '-').replace(/\|/g, '/').replace(/\s+/g, ' ')
  const lines = ['| 대화 | 턴 | 플래그 | 정리된 것 | 이유 | 해소기 ms | 초 | 실행된 명령 | 승인 대기 | 기대 | 말 |', '|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${c(r.conversation)} | ${r.turn} | ${r.flag ? 'on' : 'off'} | ${c(r.settled)} | ${c(r.reason)} | ${c(r.resolverMs)} | ${c(r.seconds)} | ${c(r.commandsRan.join(' ; ') || '-')} | ${c(r.approvalWaiting)} | ${r.ok ? 'ok' : `FAIL ${r.failed.join(',')}`} | ${c(r.say).slice(0, 40)} |`)]
  if (pairs.length) lines.push('', '| 같은 대화 | 턴 | 끔 초 | 켬 초 | 더해진 초 | 끔에서 실행 | 켬에서 실행 | 같은 명령 |', '|---|---|---|---|---|---|---|---|', ...pairs.map(p => `| ${p.dialogue} | ${p.turn} | ${c(p.offSeconds)} | ${c(p.onSeconds)} | ${c(p.addedSeconds)} | ${c(p.offRan.join(' ; ') || '-')} | ${c(p.onRan.join(' ; ') || '-')} | ${p.sameCommands ? 'yes' : 'NO'} |`))
  return lines.join('\n')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2]
  if (!dir) { console.error('usage: node scripts/egdesk-open-items-compare.mjs <check output dir> [--json]'); process.exit(2) }
  const rows = rowsOf(load(dir)), pairs = pairsOf(rows)
  console.log(process.argv.includes('--json') ? JSON.stringify({ rows, pairs }, null, 2) : render(rows, pairs))
  process.exit(rows.length ? 0 : 1)
}
