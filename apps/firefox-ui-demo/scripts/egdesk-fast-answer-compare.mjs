#!/usr/bin/env node
// L1 c31: read the records of a real-engine check run of real-engine-memory-fast-answer-v1 and compare the engine's turn with the fast path's on the same question:
// seconds (from the person's message to the finished answer), the answer, and its facts (the check's own answerIncludes / answerExcludes verdicts). Reads files only.
//   node scripts/egdesk-fast-answer-compare.mjs <check output dir> [--json]
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FACT_CHECKS = ['answerIncludes', 'answerExcludes']
function* recordFiles(dir) {
  for (const name of readdirSync(dir)) { const file = path.join(dir, name); if (statSync(file).isDirectory()) yield* recordFiles(file); else if (name.endsWith('.json')) yield file }
}
/** rows: one per scripted turn that carries a fastAnswer record. */
export function rowsOf(records) {
  const rows = []
  for (const rec of records) for (const turn of rec.turns ?? []) {
    const f = turn.fastAnswer
    if (!f) continue
    const facts = (turn.expectations ?? []).filter(e => FACT_CHECKS.includes(e.check))
    rows.push({ conversation: rec.id, turn: turn.index, say: turn.say, flag: f.flag, path: f.used ? 'fast' : 'engine', reason: f.reason ?? null, seconds: f.seconds, decisionMs: f.decisionMs, engineTurns: f.engineTurns,
      answer: turn.finalAnswer ?? f.answer ?? null, factsOk: facts.length ? facts.every(e => e.ok) : null, ok: turn.ok === true })
  }
  return rows
}
/** pairs: the same question answered by the engine (flag off) and by the fast path (flag on, used): seconds saved and whether both answers keep the same facts. */
export function pairsOf(rows) {
  const out = []
  for (const fast of rows.filter(r => r.path === 'fast')) {
    const engine = rows.find(r => r.say === fast.say && !r.flag)
    if (engine) out.push({ say: fast.say, engineSeconds: engine.seconds, fastSeconds: fast.seconds, savedSeconds: Math.round((engine.seconds - fast.seconds) * 10) / 10, engineAnswer: engine.answer, fastAnswer: fast.answer, bothFactsOk: engine.factsOk === true && fast.factsOk === true })
  }
  return out
}
export function render(rows, pairs) {
  const cell = v => String(v ?? '-').replace(/\|/g, '/').replace(/\s+/g, ' ')
  const lines = ['| 대화 | 턴 | 경로 | 이유 | 초 | 결정 ms | 엔진 턴 | 사실 검사 | 답 |', '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${cell(r.conversation)} | ${r.turn} | ${r.path}${r.flag ? '' : ' (flag off)'} | ${cell(r.reason)} | ${cell(r.seconds)} | ${cell(r.decisionMs)} | ${r.engineTurns} | ${r.factsOk === null ? '-' : r.factsOk ? 'ok' : 'FAIL'} | ${cell(r.answer).slice(0, 120)} |`)]
  if (pairs.length) lines.push('', '| 같은 질문 | 엔진 초 | 빠른 길 초 | 절약 초 | 두 답 모두 사실 검사 통과 |', '|---|---|---|---|---|', ...pairs.map(p => `| ${cell(p.say).slice(0, 60)} | ${p.engineSeconds} | ${p.fastSeconds} | ${p.savedSeconds} | ${p.bothFactsOk ? 'yes' : 'NO'} |`))
  return lines.join('\n')
}
export function load(dir) { return [...recordFiles(dir)].map(file => JSON.parse(readFileSync(file, 'utf8'))).filter(r => r && Array.isArray(r.turns)) }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2]
  if (!dir) { console.error('usage: node scripts/egdesk-fast-answer-compare.mjs <check output dir> [--json]'); process.exit(2) }
  const rows = rowsOf(load(dir)), pairs = pairsOf(rows)
  console.log(process.argv.includes('--json') ? JSON.stringify({ rows, pairs }, null, 2) : render(rows, pairs))
  process.exit(rows.length ? 0 : 1)
}
