#!/usr/bin/env node
// The warm-up probe (set turn-context-warmup-v1), one point at a time, between other sends (L6 c17). The six points are the six committed
// plans proofs/decision-real-measure/turn-context-warmup/<A-rep1|B-rep1|C-rep1|A-rep2|B-rep2|C-rep2>/plan.json:
//   A1 A-rep1  B1 B-rep1  C1 C-rep1  A2 A-rep2  B2 B-rep2  C2 C-rep2      (registered order A1 B1 C1 A2 B2 C2)
//
//   node scripts/egdesk-turn-context-warmup-run.mjs --status [--results F]           points done, the stamp, when the next may run
//   node scripts/egdesk-turn-context-warmup-run.mjs --point A1 [--results F]          dry run: says whether the point may run now; sends nothing
//   OPENAI_API_KEY=... node scripts/egdesk-turn-context-warmup-run.mjs --point A1 --send [--results F]    the point, if allowed
//   node scripts/egdesk-turn-context-warmup-run.mjs --analyze [--results F]          the registered reading (analyzeWarmup) over the points done
//   (add --set sep for the separating probe, points N1 N2 Y1 (Y1 sits idle for 10 minutes inside the run: send nothing else meanwhile); --set size for the body-size probe, points S1 and S2, results <HOME>/turn-context-warmup-size-results.json; run after the six points)
//   node scripts/egdesk-turn-context-warmup-run.mjs --stamp-now [--at ISO]            writes the shared stamp (now, or a known earlier send made by a
//                                                                                    runner that did not stamp; never moves an existing stamp back); sends nothing
//
// A point is refused unless at least 10 minutes have passed since the shared last-send stamp (helper/egdesk-decision-send-stamp.mjs; every
// sending runner writes it), unless it is already in the results file, and when no stamp exists (the idle time is then unknown: --stamp-now,
// then wait). The point itself goes through the generic runner (runPlan: product transport, exact bytes, no retries) and writes the stamp,
// so the next point again needs 10 minutes. Results: one 0600 file (default <HOME>/turn-context-warmup-results.json), one entry per point,
// rewritten atomically; it holds timings, usage and answers, never the key.
import { chmodSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EXIT, loadPlan, runPlan, transportPhases } from '../helper/egdesk-decision-real-runner.mjs'
import { createDecisionTransport } from '../helper/egdesk-decision-transport.mjs'
import { readSendStamp, sendStampPath, stampingFetch, writeSendStamp } from '../helper/egdesk-decision-send-stamp.mjs'
import { SEP_DIR, SEP_SET, SIZE_DIR, SIZE_SET, WARMUP_DIR, WARMUP_SET, analyzeSeparation, analyzeSize, analyzeWarmup } from '../helper/egdesk-turn-context-latency-plan.mjs'

export const WARMUP_POINTS = Object.freeze({ A1: 'A-rep1', B1: 'B-rep1', C1: 'C-rep1', A2: 'A-rep2', B2: 'B-rep2', C2: 'C-rep2' })
export const POINT_ORDER = Object.freeze(Object.keys(WARMUP_POINTS))
// Two registered probes share this runner and the 10-minute rule: the six warm-up points (default) and, from c19, the two body-size points
// (--set size: S1 = the product warm-up body, S2 = the 648-token warm-up; run only after the six points).
export const WARMUP_KIND = Object.freeze({ name: 'warmup', set: WARMUP_SET, dir: WARMUP_DIR, points: WARMUP_POINTS, order: POINT_ORDER, file: 'turn-context-warmup-results.json', analyze: analyzeWarmup })
export const SIZE_POINTS = Object.freeze({ S1: 'S1-small', S2: 'S2-large' })
export const SIZE_KIND = Object.freeze({ name: 'size', set: SIZE_SET, dir: SIZE_DIR, points: SIZE_POINTS, order: Object.freeze(Object.keys(SIZE_POINTS)), file: 'turn-context-warmup-size-results.json', analyze: analyzeSize })
export const SEP_POINTS = Object.freeze({ N1: 'N1', N2: 'N2', Y1: 'Y1' })
export const SEP_KIND = Object.freeze({ name: 'sep', set: SEP_SET, dir: SEP_DIR, points: SEP_POINTS, order: Object.freeze(Object.keys(SEP_POINTS)), file: 'turn-context-warmup-sep-results.json', analyze: analyzeSeparation })
export const KINDS = Object.freeze({ warmup: WARMUP_KIND, size: SIZE_KIND, sep: SEP_KIND })
export const MIN_IDLE_MS = 10 * 60_000
const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
export const pointPlanFile = (point, K = WARMUP_KIND) => path.join(APP, K.dir, K.points[point], 'plan.json')
export const defaultResultsFile = (env, K = WARMUP_KIND) => path.join(env?.HOME || '.', K.file)

export function readResults(file, K = WARMUP_KIND) {
  try { if (lstatSync(file).isSymbolicLink()) throw new Error(`the results file ${file} is a symbolic link`) } catch (error) { if (error?.code === 'ENOENT') return { set: K.set, points: {} }; throw error }
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  if (raw?.set !== K.set || typeof raw.points !== 'object' || raw.points === null) throw new Error(`${file} is not a ${K.set} results file`)
  return raw
}
function writeResultsFile(file, data) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 1) + '\n', { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, file)
}

/** Whether a point may run at `nowMs`: { ok, reason?, idleMs, nextAt } (nextAt: ISO time from which the idle rule allows a send). */
export function pointGate(point, { results, stamp, nowMs }, K = WARMUP_KIND) {
  if (!Object.hasOwn(K.points, point)) return { ok: false, reason: `unknown point ${point} (one of ${K.order.join(' ')})` }
  if (results.points[point]) return { ok: false, reason: `point ${point} is already in the results file (${results.points[point].at})` }
  if (!stamp) return { ok: false, reason: 'no last-send stamp: the idle time is unknown (write one with --stamp-now, then wait 10 minutes)', idleMs: null, nextAt: null }
  const idleMs = nowMs - stamp.lastAt, nextAt = new Date(stamp.lastAt + MIN_IDLE_MS).toISOString()
  if (idleMs < 0) return { ok: false, reason: 'the last-send stamp is in the future', idleMs, nextAt }
  if (idleMs < MIN_IDLE_MS) return { ok: false, reason: `only ${Math.floor(idleMs / 1000)} s since the last Decisions send (${stamp.runner}); 600 s needed`, idleMs, nextAt }
  return { ok: true, idleMs, nextAt }
}

export function status({ results, stamp, nowMs }, K = WARMUP_KIND) {
  const done = K.order.filter(p => results.points[p]), next = K.order.find(p => !results.points[p]) ?? null
  const gate = next ? pointGate(next, { results, stamp, nowMs }, K) : null
  return { set: K.set, done: done.map(p => ({ point: p, at: results.points[p].at, measuredMs: results.points[p].results?.measured?.elapsedMs ?? null, stoppedBecause: results.points[p].stoppedBecause })),
    remaining: K.order.filter(p => !results.points[p]), next, lastSend: stamp ? { at: new Date(stamp.lastAt).toISOString(), runner: stamp.runner } : null,
    ...(gate ? { nextMayRunAt: gate.nextAt, nextAllowedNow: gate.ok, ...(gate.ok ? {} : { why: gate.reason }) } : { complete: true }) }
}

export async function main(argv, { env = {}, fetchImpl = globalThis.fetch, print = line => console.log(line), printError = line => console.error(line), now = () => Date.now(),
  createTransport = createDecisionTransport, sleep } = {}) {
  const args = [...argv], flag = n => args.includes(n), valueOf = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] ?? null : null }
  const known = new Set(['--status', '--point', '--send', '--results', '--analyze', '--stamp-now', '--at', '--set'])
  const bad = args.find((a, i) => a.startsWith('--') ? !known.has(a) : !['--point', '--results', '--at', '--set'].includes(args[i - 1]))
  const modes = ['--status', '--point', '--analyze', '--stamp-now'].filter(flag)
  if (bad || modes.length !== 1 || (flag('--send') && !flag('--point')) || (flag('--point') && !valueOf('--point')) || (flag('--results') && !valueOf('--results')) || (flag('--at') && (!flag('--stamp-now') || !valueOf('--at'))) || (flag('--set') && !Object.hasOwn(KINDS, valueOf('--set') ?? ''))) {
    printError('usage: egdesk-turn-context-warmup-run.mjs --status | --point A1|B1|C1|A2|B2|C2 [--send] | --analyze | --stamp-now   [--set warmup|size] [--results file]  (--set size: points S1, S2; --set sep: points N1, N2, Y1)'); return EXIT.usage
  }
  const K = KINDS[valueOf('--set') ?? 'warmup']
  const stampFile = sendStampPath(env), resultsFile = valueOf('--results') ?? defaultResultsFile(env, K)
  let results, stamp
  try { results = readResults(resultsFile, K); stamp = readSendStamp(stampFile) } catch (error) { printError(`refused: ${error.message}`); return EXIT.usage }
  if (flag('--stamp-now')) {
    const at = flag('--at') ? Date.parse(valueOf('--at')) : now()
    if (!Number.isFinite(at) || at > now()) { printError('refused: --at must be a time that has passed (ISO 8601 with a zone, e.g. 2026-11-25T00:50:00+09:00)'); return EXIT.usage }
    if (stamp && stamp.lastAt > at) { printError(`refused: the stamp already says ${new Date(stamp.lastAt).toISOString()} (${stamp.runner}), later than ${new Date(at).toISOString()}`); return EXIT.usage }
    const iso = new Date(at).toISOString()
    writeSendStamp(stampFile, { startedAt: iso, endedAt: iso, runner: flag('--at') ? 'warmup-run --stamp-now --at (a send recorded by hand)' : 'warmup-run --stamp-now' })
    print(JSON.stringify({ stamped: iso, file: stampFile, sent: 0 })); return EXIT.ok
  }
  if (flag('--status')) { print(JSON.stringify(status({ results, stamp, nowMs: now() }, K), null, 1)); return EXIT.ok }
  if (flag('--analyze')) {
    const byRun = Object.fromEntries(Object.entries(results.points).map(([p, row]) => [K.points[p], row.results]))
    print(JSON.stringify({ ...K.analyze(byRun), points: Object.keys(results.points) }, null, 1)); return EXIT.ok
  }
  const point = valueOf('--point')
  const gate = pointGate(point, { results, stamp, nowMs: now() }, K)
  const outOfOrder = gate.ok && K.order.find(p => !results.points[p]) !== point
  // the size points belong after the six warm-up points: a note, not a refusal (the owner of the run decides)
  let sixFirst = null
  if (K.name !== 'warmup' && !flag('--results')) { try { sixFirst = Object.keys(readResults(defaultResultsFile(env, WARMUP_KIND), WARMUP_KIND).points).length } catch { sixFirst = null } }
  print(JSON.stringify({ point, set: K.name, plan: Object.hasOwn(K.points, point) ? path.relative(APP, pointPlanFile(point, K)) : null, mode: flag('--send') ? 'send' : 'dry_run', allowed: gate.ok,
    ...(gate.ok ? {} : { why: gate.reason }), idleSeconds: gate.idleMs == null ? null : Math.floor(gate.idleMs / 1000), stamp: stampFile, results: resultsFile,
    ...(outOfOrder ? { note: `registered order is ${K.order.join(' ')}; ${point} runs before ${K.order.find(p => !results.points[p])}` } : {}),
    ...(sixFirst !== null && sixFirst < 6 ? { note2: `only ${sixFirst} of the 6 warm-up points are in; the ${K.name} probe is planned for after them` } : {}) }))
  if (!gate.ok) return EXIT.stopped
  if (!flag('--send')) return EXIT.ok
  const plan = loadPlan(pointPlanFile(point, K))
  // the idle rule, read once more right before the first byte leaves (another runner may have sent while the plan was loading)
  const again = pointGate(point, { results, stamp: readSendStamp(stampFile), nowMs: now() }, K)
  if (!again.ok) { printError(`refused: ${again.reason}`); return EXIT.stopped }
  const marks = []
  const makeTransport = () => createTransport({ trace: mark => marks.push(mark), ...(plan.transportIdleMs ? { idleMs: plan.transportIdleMs } : {}) })
  let transport = makeTransport()
  const swap = () => { try { transport?.close?.() } catch { /* nothing to close */ } transport = makeTransport() } // a freshSocket request gets a new transport
  const startedAt = new Date(now()).toISOString()
  // Another runner's stamp newer than this point's start means something else was sent during the point: read before each of this point's
  // requests, at the end of each (onForeign: the stamp on disk is not the one this request wrote) and once after. A foreign send whose stamp
  // was overwritten by this point's own start write before any of these reads is not seen.
  let interleaved = false
  const foreign = () => { try { const s = readSendStamp(stampFile); if (s && !s.runner.startsWith(`warmup-run ${point}`) && s.lastAt >= Date.parse(startedAt)) interleaved = true } catch { interleaved = true } }
  const inner = stampingFetch((url, init) => (transport.fetch ?? fetchImpl)(url, init), { file: stampFile, runner: `warmup-run ${point}`, now: () => new Date(now()), onForeign: () => { interleaved = true } })
  let outcome
  try {
    outcome = await runPlan({ plan, key: env.OPENAI_API_KEY ?? null, send: true, fetchImpl: (url, init) => { foreign(); return inner(url, init) },
      ...(transport?.warm ? { warm: () => transport.warm(), annotate: () => transportPhases(marks.splice(0)), beforeRequest: swap } : {}), ...(sleep ? { sleep } : {}) })
  } finally { try { transport?.close?.() } catch { /* nothing to close */ } }
  if (outcome.stoppedBecause === 'no_key') { printError('OPENAI_API_KEY is not set (or not a plausible key); nothing was sent'); return EXIT.noKey }
  foreign()
  if (outcome.sent > 0) {
    results.points[point] = { at: startedAt, dir: K.points[point], idleSecondsBefore: Math.floor(again.idleMs / 1000), lastSendBefore: { at: new Date(stamp.lastAt).toISOString(), runner: stamp.runner },
      sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, usage: outcome.usage, ...(interleaved ? { interleaved: true } : {}), results: outcome.results }
    writeResultsFile(resultsFile, results)
  }
  print(JSON.stringify({ point, sent: outcome.sent, stoppedBecause: outcome.stoppedBecause, inputTokens: outcome.usage.inputTokens, measuredMs: outcome.results?.measured?.elapsedMs ?? null,
    ...(interleaved ? { warning: 'another runner sent during this point' } : {}), next: status({ results, stamp: readSendStamp(stampFile), nowMs: now() }, K).nextMayRunAt ?? null }))
  return outcome.stoppedBecause ? EXIT.stopped : EXIT.ok
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2), { env: process.env })
