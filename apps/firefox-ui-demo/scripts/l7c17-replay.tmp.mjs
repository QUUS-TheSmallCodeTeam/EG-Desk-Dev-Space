// Offline replay: the all-on journey (product code, L2's harness) answered with Main's REAL answers of 2026-11-25 (matched by the exact
// list of question names, in order of arrival). Nothing is sent.
import { readFileSync } from 'node:fs'
import { STEPS, loadJourneyPlan, createMeasureTransport, DEFAULT_CAPS } from './egdesk-all-on-live-measure.mjs'
import { allOnWorld } from './egdesk-all-on.support.mjs'
const recorded = JSON.parse(readFileSync(process.argv[2], 'utf8')), env = JSON.parse(process.argv[3] ?? '{}'), upTo = process.argv[4] ?? 's9-status-remark'
const queue = recorded.steps.flatMap(s => (s.requests ?? []).filter(r => Array.isArray(r.answers) && r.answers.length).map(r => ({ step: s.id, key: r.questions.join(','), answers: r.answers, used: false })))
const misses = []
let current = null
const replay = { async answer(wire) {
  const key = wire.questions.map(q => q.name).join(','), hit = queue.find(q => !q.used && q.key === key && q.step === current) ?? queue.find(q => !q.used && q.key === key)
  if (!hit) { misses.push(`${current}: ${key.slice(0, 80)}`); return {} }
  hit.used = true
  return Object.fromEntries(hit.answers.map(a => [a.name, a]))
} }
const plan = loadJourneyPlan()
const { transport } = createMeasureTransport({ send: false, caps: DEFAULT_CAPS, plan, scripted: replay })
const cleanups = [], t = { after: fn => cleanups.push(fn) }
const w = allOnWorld(t, { transport, settleLimitMs: 60_000, env })
await w.settings.turnMemory.save('on')
const j = { note: {}, sends: [], async say(text, extra) { try { const out = await w.send(text, extra); j.sends.push(out) } catch (e) { j.sends.push({ refused: e?.code }) } await w.idle() }, async pause() { await new Promise(r => setTimeout(r, 60)); await w.idle() } }
for (const def of STEPS) {
  w.step(def.id); current = def.id; j.sends = []
  try { await def.run(w, j); await w.idle() } catch (e) { console.log('step failed', def.id, e?.code ?? e?.message) }
  if (def.id === upTo) {
    const run = [...w.chat.runs.values()].filter(r => r.clientThreadId === 'dm-all-on' || true).at(-1)
    const turn = w.chat.turnMemoryTurns.get(run)
    const writes = (() => { try { return JSON.parse(readFileSync(`${w.dir}/settings/egdesk-wiki-writes.json`, 'utf8')) } catch { return null } })()
    console.log(JSON.stringify({ step: def.id, receipt: w.chat.turnMemoryWriteReceipts.get(run) ?? null, position: turn?.position ?? null, memory: turn?.result?.memory?.status ?? null,
      held: turn?.result?.held ?? null, packet: Object.keys(turn?.result?.memory?.delivered ?? {}), writes, decisions: w.decisionsIn(def.id).map(d => d.feature ?? d.family) }, null, 1))
    break
  }
}
console.log('unmatched requests:', JSON.stringify(misses))
for (const fn of cleanups.reverse()) { try { fn() } catch {} }
process.exit(0)
