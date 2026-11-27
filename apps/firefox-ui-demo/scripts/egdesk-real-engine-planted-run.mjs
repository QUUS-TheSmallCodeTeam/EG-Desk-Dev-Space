#!/usr/bin/env node
// L6 c28: runs the planted-draft sets (scripts/egdesk-real-engine-planted-scripts.mjs) through the real-engine check, ONE conversation per check process, under a Decision-token CEILING,
// and tallies them (helper/egdesk-real-engine-planted.mjs scorePlanted). DRY by default: it prints the plan, the per-conversation estimate and the ceiling, and starts nothing.
//   node scripts/egdesk-real-engine-planted-run.mjs --codex-bin <abs path> --out <dir> [--person-home | --codex-home <dir>] [--replicas 4] [--ceiling 60000] [--cases s13,coding,number,tense] [--run]
// --run needs EGDESK_REAL_CHECK_DECISION_KEY (the check reads it; this tool never reads or prints it). The check itself is started as
//   node scripts/egdesk-real-engine-check.mjs --run --decisions --persisted-with-cleanup --codex-bin … [--person-home | --codex-home …] --script <one-conversation script> --out <out>/<case>-<n>
// Order: ROUNDS (replica 1 of every case, then replica 2 of every case, …) so that a stop leaves the cases equally measured. The ceiling is enforced BETWEEN conversations from the tokens the
// Decision responses reported (usage.input_tokens, per call, in the record): before a conversation, the run stops when spent + that case's declared estimate would pass the ceiling (reason "ceiling").
// A conversation's real cost may differ from its estimate; the overshoot is one conversation at most, and it is in the summary. A check that exits 2 (preflight) or aborts stops the run too:
// nothing is retried. The summary (<out>/planted-summary.json) and the tally (<out>/score.txt) are written after every conversation, so a stop leaves both.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CASE_IDS, DEFAULT_REPLICAS, ESTIMATE_TOKENS, MAX_REPLICAS, buildPlantedScripts, scriptText, setOf } from './egdesk-real-engine-planted-scripts.mjs'
import { formatPlantedScore, inputTokensOf, scorePlanted } from '../helper/egdesk-real-engine-planted.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const CHECK_SCRIPT = path.join(here, 'egdesk-real-engine-check.mjs')
export const DEFAULT_CEILING = 60_000, MAX_CEILING = 60_000
const USAGE = 'usage: egdesk-real-engine-planted-run.mjs --codex-bin <abs path> --out <dir> [--person-home | --codex-home <dir>] [--replicas 1-8] [--ceiling N<=60000] [--cases s13,coding,number,tense] [--run]'

/** parseRunArgs(argv) → options. Throws an Error with the usage on a bad one. */
export function parseRunArgs(argv) {
  const o = { run: false, codexBin: null, out: null, home: null, replicas: DEFAULT_REPLICAS, ceiling: DEFAULT_CEILING, cases: [...CASE_IDS] }
  const fail = why => { throw new Error(`${why}\n${USAGE}`) }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--run') { o.run = true; continue }
    if (a === '--person-home') { if (o.home) fail('give --codex-home or --person-home, not both'); o.home = { kind: 'person' }; continue }
    const v = argv[++i]
    if (v === undefined || v.startsWith('--')) fail(`${a} needs a value`)
    if (a === '--codex-bin') o.codexBin = v
    else if (a === '--out') o.out = v
    else if (a === '--codex-home') { if (o.home) fail('give --codex-home or --person-home, not both'); o.home = { kind: 'dir', dir: v } }
    else if (a === '--replicas') { o.replicas = Number(v); if (!Number.isInteger(o.replicas) || o.replicas < 1 || o.replicas > MAX_REPLICAS) fail(`--replicas is 1-${MAX_REPLICAS}`) }
    else if (a === '--ceiling') { o.ceiling = Number(v); if (!Number.isInteger(o.ceiling) || o.ceiling < 1000 || o.ceiling > MAX_CEILING) fail(`--ceiling is 1000-${MAX_CEILING} (the declared ceiling of this measure)`) }
    else if (a === '--cases') { o.cases = v.split(',').filter(Boolean); if (!o.cases.length || o.cases.some(c => !CASE_IDS.includes(c)) || new Set(o.cases).size !== o.cases.length) fail(`--cases: distinct names from ${CASE_IDS.join(',')}`) }
    else fail(`unknown argument ${a}`)
  }
  if (!o.codexBin || !path.isAbsolute(o.codexBin)) fail('--codex-bin <absolute path> is required')
  if (!o.out || !path.isAbsolute(o.out)) fail('--out <absolute dir> is required')
  return o
}

/** planRounds({ cases, replicas }) → [{ case, replica, estimate }] in round order. */
export function planRounds({ cases = CASE_IDS, replicas = DEFAULT_REPLICAS } = {}) {
  const out = []
  for (let r = 1; r <= replicas; r++) for (const c of cases) out.push({ case: c, replica: r, estimate: ESTIMATE_TOKENS[c] })
  return out
}
export const estimateTotal = plan => plan.reduce((t, p) => t + p.estimate, 0)

/** One conversation's script (the committed set's replica n, as a script of its own). */
export function scriptFor(caseId, replica, replicas = DEFAULT_REPLICAS) {
  const set = buildPlantedScripts({ replicas: Math.max(replicas, replica) })[setOf(caseId)]
  return { ...set, conversations: [set.conversations[replica - 1]] }
}

/** The conversation records (<runDir>/records/<set>/<id>.json) of one check run; nothing else under the run folder is read. */
export function readRecords(runDir) {
  const dir = path.join(runDir, 'records')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { recursive: true }).filter(f => String(f).endsWith('.json')).map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) } catch { return null } }).filter(r => r && Array.isArray(r.turns))
}
const allRecords = out => { const runs = path.join(out, 'runs'); return fs.existsSync(runs) ? fs.readdirSync(runs).flatMap(n => readRecords(path.join(runs, n))) : [] }

/**
 * runPlanted(options, { spawn, env }) → { stopped, reason, spent, ceiling, conversations: [...], summary }. spawn(file, args, { env }) → { status } is injectable (the tests' fake check).
 * Dry (options.run false): nothing is started; the plan is returned.
 */
export function runPlanted(options, { spawn = (file, args, opts) => spawnSync(process.execPath, [file, ...args], { ...opts, stdio: 'inherit' }), env = process.env, log = console.log } = {}) {
  const plan = planRounds({ cases: options.cases, replicas: options.replicas })
  const result = { run: options.run, ceiling: options.ceiling, estimateTotal: estimateTotal(plan), plan, conversations: [], spent: 0, stopped: false, reason: null }
  if (!options.run) return result
  if (!String(env.EGDESK_REAL_CHECK_DECISION_KEY ?? '').trim()) { result.stopped = true; result.reason = 'no_key'; return result }
  fs.mkdirSync(path.join(options.out, 'scripts'), { recursive: true })
  const write = () => {
    const score = scorePlanted(allRecords(options.out))
    fs.writeFileSync(path.join(options.out, 'planted-summary.json'), `${JSON.stringify({ ...result, plan: undefined, score: undefined }, null, 2)}\n`)
    fs.writeFileSync(path.join(options.out, 'score.txt'), `${formatPlantedScore(score, { ceiling: options.ceiling })}\n`)
    return score
  }
  for (const item of plan) {
    if (result.spent + item.estimate > options.ceiling) { result.stopped = true; result.reason = 'ceiling'; break }
    const name = `${item.case}-${item.replica}`, scriptFile = path.join(options.out, 'scripts', `${name}.json`), runDir = path.join(options.out, 'runs', name)
    fs.writeFileSync(scriptFile, scriptText(scriptFor(item.case, item.replica, options.replicas)))
    const args = ['--run', '--decisions', '--persisted-with-cleanup', '--codex-bin', options.codexBin, ...(options.home?.kind === 'person' ? ['--person-home'] : options.home?.kind === 'dir' ? ['--codex-home', options.home.dir] : []), '--script', scriptFile, '--out', runDir]
    log(`planted ${name}: spent ${result.spent} of ${options.ceiling}, estimate ${item.estimate}`)
    const done = spawn(CHECK_SCRIPT, args, { env })
    const records = readRecords(runDir), used = records.reduce((t, r) => { const u = inputTokensOf(r); return { tokens: t.tokens + u.tokens, calls: t.calls + u.calls } }, { tokens: 0, calls: 0 })
    result.spent += used.tokens
    result.conversations.push({ name, status: done?.status ?? null, tokens: used.tokens, calls: used.calls, estimate: item.estimate, aborted: records.some(r => r.aborted) })
    write()
    if (done?.status === 2) { result.stopped = true; result.reason = 'preflight'; break }
    if (records.some(r => r.aborted) || records.length === 0) { result.stopped = true; result.reason = 'aborted'; break }
  }
  result.overCeiling = result.spent > options.ceiling
  write()
  return result
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  let options
  try { options = parseRunArgs(process.argv.slice(2)) } catch (error) { console.error(error.message); process.exit(2) }
  const out = runPlanted(options)
  if (!options.run) {
    console.log(`DRY: ${out.plan.length} conversation(s) in ${options.replicas} round(s): ${options.cases.join(', ')}; declared estimate ${out.estimateTotal} Decision input tokens, ceiling ${out.ceiling}${out.estimateTotal > out.ceiling ? ` (the estimate is over the ceiling: the run stops before the conversation that would pass it)` : ''}`)
    for (const p of out.plan) console.log(`  ${p.case}-${p.replica}: estimate ${p.estimate}`)
    console.log('Add --run (with EGDESK_REAL_CHECK_DECISION_KEY set) to start.')
    process.exit(0)
  }
  console.log(`planted run: ${out.conversations.length} conversation(s), spent ${out.spent} of ceiling ${out.ceiling}${out.stopped ? `, STOPPED (${out.reason})` : ''}; score: ${path.join(options.out, 'score.txt')}`)
  process.exit(out.stopped && out.reason !== 'ceiling' ? 1 : 0)
}
