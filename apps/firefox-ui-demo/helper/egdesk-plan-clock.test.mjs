// Cycle 16 (L6): every committed real-measurement plan is what the code builds on ANY day. On 2026-11-25 the contamination plan's
// product-built bodies stopped matching ("Today is 2026-11-24" vs the build machine's 25th): its builder read the system clock. This file
// moves the system clock (Date.now and new Date()) far from the build day, in both directions, and
//   1. rebuilds every "rebuilt" entry of the register (helper/egdesk-committed-plans.mjs): a script's own compare mode run in process (the
//      same bytes check it prints as matches / DIFFERS), a builder's files compared with the committed ones, or the heartbeat snapshot;
//   2. requires every committed plan location to be registered (rebuilt, frozen or hand-written); a missing one is named with its likely lane;
//   3. builds every builder whose plan is written outside the repo (Main's evidence directories) at both clocks and requires equal bytes.
// (c17: the register replaced c16's fixed list, which failed on int/c14 as soon as another lane committed a plan folder.)
// Nothing is sent: the scripts' compare modes and the builders use synthetic clients; process.exit is caught, console output is read.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { COMMITTED_PLANS, coverageProblems, findCommittedPlans } from './egdesk-committed-plans.mjs'

const here = path.dirname(fileURLToPath(import.meta.url)), app = path.join(here, '..')
const RealDate = globalThis.Date
const DAY = 86_400_000
// +400 days: another year, month and weekday; -200 days: before any plan existed.
const CLOCKS = Object.freeze([['later', 400 * DAY], ['earlier', -200 * DAY]])
function setClock(shift) {
  class ShiftedDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + shift); else super(...a) }
    static now() { return RealDate.now() + shift }
  }
  globalThis.Date = shift ? ShiftedDate : RealDate
}

// What to rebuild comes from the register (helper/egdesk-committed-plans.mjs): one run per distinct compare mode or builder.
const REBUILT = COMMITTED_PLANS.filter(e => e.rebuilt)
const SCRIPT_RUNS = [...new Map(REBUILT.filter(e => e.rebuilt.script).map(e => {
  const key = [e.rebuilt.script, ...(e.rebuilt.argv || [])].join(' ')
  return [key, { key, script: e.rebuilt.script, argv: e.rebuilt.argv || [], matches: e.rebuilt.matches ?? 1, covers: REBUILT.filter(x => x.rebuilt.script === e.rebuilt.script && (x.rebuilt.argv || []).join(' ') === (e.rebuilt.argv || []).join(' ')).map(x => `${x.path} (${x.lane})`) }]
})).values()]
async function builderDiffs(entry) {
  const [mod, name] = entry.rebuilt.builder
  const built = await (await import(mod))[name]()
  const files = built.files && !Array.isArray(built.files) ? Object.entries(built.files) : (built.files || []).map(f => [f.file, f.bytes])
  if (built.planBytes) files.push(['plan.json', built.planBytes])
  const dir = path.join(app, entry.path)
  if (!files.length) return ['(the builder returned no files)']
  return files.filter(([file, bytes]) => { try { return !readFileSync(path.join(dir, file)).equals(Buffer.from(bytes)) } catch { return true } }).map(([file]) => file)
}
async function heartbeatDiffs(entry) {
  const { buildHeartbeatPlan, planFile } = await import('./egdesk-heartbeat-real-plan.mjs')
  return JSON.stringify(planFile(await buildHeartbeatPlan())) === JSON.stringify(JSON.parse(readFileSync(path.join(app, entry.path), 'utf8'))) ? [] : [entry.path]
}

class Exit extends Error { constructor(code) { super(`process.exit(${code})`); this.code = code } }
async function runScript(script, argv, tag) {
  const saved = { argv: process.argv, exit: process.exit, log: console.log, error: console.error, exitCode: process.exitCode }
  const out = []
  process.argv = [process.argv[0], path.join(app, 'scripts', script), ...argv]
  process.exit = code => { throw new Exit(code ?? 0) }
  console.log = (...a) => out.push(a.join(' ')); console.error = (...a) => out.push(a.join(' '))
  process.exitCode = undefined
  let code = 0
  try { await import(`${pathToFileURL(path.join(app, 'scripts', script)).href}?clock=${tag}`) } catch (err) { if (err instanceof Exit) code = err.code; else throw err } finally {
    if (code === 0 && process.exitCode) code = process.exitCode
    Object.assign(process, { argv: saved.argv, exit: saved.exit }); process.exitCode = saved.exitCode
    console.log = saved.log; console.error = saved.error
  }
  return { code, out }
}

for (const [clock, shift] of CLOCKS) {
  test(`committed plans rebuild byte-identically with the system clock ${clock} (${shift / DAY} days)`, async () => {
    setClock(shift)
    try {
      assert.notEqual(new Date().toISOString().slice(0, 10), new RealDate().toISOString().slice(0, 10), 'the clock moved')
      for (const run of SCRIPT_RUNS) {
        const { code, out } = await runScript(run.script, run.argv, `${clock}-${run.argv.join('') || 'default'}`)
        const bad = out.filter(line => /\bdiffers\b|DIFFERS|^stale:/.test(line))
        assert.deepEqual(bad, [], `${run.covers.join(', ')}: rebuilt with the clock ${clock} by scripts/${run.key}, files differ`)
        assert.equal(code, 0, `scripts/${run.key}: compare mode exited ${code}`)
        assert.ok(out.filter(line => /\bmatches\b/.test(line)).length >= run.matches, `scripts/${run.key}: expected ${run.matches} "matches" line(s) for ${run.covers.join(', ')}`)
      }
      for (const entry of REBUILT.filter(e => e.rebuilt.builder || e.rebuilt.heartbeat)) {
        const diffs = entry.rebuilt.heartbeat ? await heartbeatDiffs(entry) : await builderDiffs(entry)
        assert.deepEqual(diffs, [], `${entry.path} (lane ${entry.lane}): rebuilt with the clock ${clock}, files differ`)
      }
    } finally { setClock(0) }
  })
}

test('every committed plan location is registered (rebuilt, frozen or hand-written), each failure names the location and the owning lane', () => {
  const problems = coverageProblems(app)
  assert.deepEqual(problems, [], `\n${problems.join('\n')}`)
  assert.ok(findCommittedPlans(app).length >= COMMITTED_PLANS.length)
})

test('an unregistered plan location is reported with its folder and a lane', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'egdesk-committed-plans-'))
  try {
    for (const [dir, set] of [['proofs/decision-real-measure/l3-c21-scenarios', 'l3-c21-scenarios-v2'], ['proofs/decision-real-measure/terse-record', 'terse-record-v1'], ['scripts/real-plans/mystery', 'mystery-v1']]) {
      mkdirSync(path.join(root, dir), { recursive: true }); writeFileSync(path.join(root, dir, 'plan.json'), JSON.stringify({ set }))
    }
    mkdirSync(path.join(root, 'scripts'), { recursive: true }); mkdirSync(path.join(root, 'helper'), { recursive: true })
    writeFileSync(path.join(root, 'scripts', 'egdesk-browser-live-plan-settings-v3.json'), JSON.stringify({ set: 'browser-live-settings-v3' }))
    const problems = coverageProblems(root).filter(p => p.includes('not covered'))
    assert.deepEqual(problems.map(p => [p.split(':')[0], /owning lane (L\d|unknown)/.exec(p)[1]]), [
      ['proofs/decision-real-measure/l3-c21-scenarios', 'L3'], ['proofs/decision-real-measure/terse-record', 'L7'],
      ['scripts/egdesk-browser-live-plan-settings-v3.json', 'L8'], ['scripts/real-plans/mystery', 'unknown']])
    assert.ok(problems.every(p => p.includes('helper/egdesk-committed-plans.mjs')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the contamination plan records the clock its bodies were built with, and every product-built body carries that day', async () => {
  const { CONTAMINATION_ASKED_AT } = await import('./egdesk-contamination-plan.mjs')
  const dir = path.join(app, 'proofs', 'decision-real-measure', 'contamination'), plan = JSON.parse(readFileSync(path.join(dir, 'plan.json'), 'utf8'))
  assert.equal(plan.askedAt, new RealDate(CONTAMINATION_ASKED_AT).toISOString())
  const dated = plan.requests.map(r => readFileSync(path.join(dir, r.file), 'utf8')).filter(b => /Today is \d{4}-\d{2}-\d{2}/.test(b))
  assert.ok(dated.length > 0)
  for (const body of dated) for (const m of body.matchAll(/Today is (\d{4}-\d{2}-\d{2})/g)) assert.equal(m[1], '2026-11-24')
})

// Builders whose plans are written outside the repo (the owner's evidence directories): the same bytes at both clocks.
test('out-of-repo plan builders give the same bytes whatever the system clock', async () => {
  const builders = [
    ['command-risk-v2', async () => (await import('./egdesk-command-risk-plan.mjs')).buildCommandRiskPlanV2()],
    ['confirmation', async () => (await import('./egdesk-confirmation-plan.mjs')).buildConfirmationPlan()],
    ['write-target', async () => (await import('./egdesk-write-target-plan.mjs')).buildWriteTargetPlan()],
    ['heartbeat', async () => (await import('./egdesk-heartbeat-real-plan.mjs')).buildHeartbeatPlan()],
  ]
  const bytes = value => JSON.stringify(value, (k, v) => (Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v))
  for (const [label, build] of builders) {
    const seen = []
    for (const [, shift] of CLOCKS) { setClock(shift); try { seen.push(bytes(await build())) } finally { setClock(0) } }
    assert.equal(seen[0], seen[1], `${label}: the built plan depends on the system clock`)
  }
  // The referent plan has no builder export: its script writes a directory; written at both clocks, the files are equal.
  const outs = []
  try {
    for (const [clock, shift] of CLOCKS) {
      const out = mkdtempSync(path.join(tmpdir(), `egdesk-plan-clock-${clock}-`)); outs.push(out)
      setClock(shift)
      try { const r = await runScript('egdesk-referent-plan.mjs', [out], `referent-${clock}`); assert.equal(r.code, 0) } finally { setClock(0) }
    }
    const list = d => readdirSync(d, { recursive: true }).filter(f => statSync(path.join(d, f)).isFile()).sort()
    assert.deepEqual(list(outs[0]), list(outs[1]))
    assert.ok(list(outs[0]).length > 0)
    for (const f of list(outs[0])) assert.ok(readFileSync(path.join(outs[0], f)).equals(readFileSync(path.join(outs[1], f))), `referent ${f} depends on the system clock`)
  } finally { for (const d of outs) rmSync(d, { recursive: true, force: true }) }
})
