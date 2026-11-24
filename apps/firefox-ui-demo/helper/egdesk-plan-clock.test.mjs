// Cycle 16 (L6): every committed real-measurement plan is what the code builds on ANY day. On 2026-11-25 the contamination plan's
// product-built bodies stopped matching ("Today is 2026-11-24" vs the build machine's 25th): its builder read the system clock. This file
// moves the system clock (Date.now and new Date()) far from the build day, in both directions, and
//   1. runs every plan script's own compare mode in process (the same bytes check the script prints as matches / DIFFERS), and
//   2. builds every builder whose plan is written outside the repo (Main's evidence directories) at both clocks and requires equal bytes.
// Nothing is sent: the scripts' compare modes and the builders use synthetic clients; process.exit is caught, console output is read.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

// Script compare modes: [label, script, argv]. Each prints "matches" for every committed plan it covers and never "differs"/"DIFFERS"/"stale".
const CHECKS = Object.freeze([
  ['action-relevance', 'egdesk-action-relevance-plan.mjs', []],
  ['axis-hybrid', 'egdesk-axis-hybrid-plan.mjs', []],
  ['axis-split + its utterance chunks', 'egdesk-axis-split-plan.mjs', []],
  ['board-reply-screening + l1-remeasure-c13', 'egdesk-board-reply-real-plan.mjs', []],
  ['briefing-coverage + briefing-coverage-facts', 'egdesk-briefing-coverage-plan.mjs', []],
  ['contamination', 'egdesk-contamination-plan.mjs', []],
  ['draft-overcorrection', 'egdesk-draft-overcorrection-plan.mjs', []],
  ['memory-action-v2', 'egdesk-memory-action-v2-plan.mjs', []],
  ['split-wording', 'egdesk-split-wording-plan.mjs', []],
  ['turn-context-latency', 'egdesk-turn-context-latency-plan.mjs', []],
  ['turn-context-idle', 'egdesk-turn-context-latency-plan.mjs', ['--idle']],
  ['turn-context-warmup', 'egdesk-turn-context-latency-plan.mjs', ['--warmup']],
  ['utterance-threshold', 'egdesk-utterance-threshold-study.mjs', []],
  ['working-memory-judge', 'egdesk-working-memory-real-plan.mjs', []],
])
// Committed plan directories that no script rebuilds: written by hand, or kept as sent after a newer plan superseded them (static bytes, no
// clock involved; memory-action is v1 as sent in c24, rebuilt as memory-action-v2).
const HAND_WRITTEN = Object.freeze(['all-on-s3-faithful-fill', 'work-placement', 'memory-action'])

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
      for (const [label, script, argv] of CHECKS) {
        const { code, out } = await runScript(script, argv, `${clock}-${argv.join('') || 'default'}`)
        const bad = out.filter(line => /\bdiffers\b|DIFFERS|^stale:/.test(line))
        assert.deepEqual(bad, [], `${label}: rebuilt with the clock ${clock}, files differ`)
        assert.equal(code, 0, `${label}: compare mode exited ${code}`)
        assert.ok(out.some(line => /\bmatches\b/.test(line)), `${label}: the compare mode reported no match`)
      }
    } finally { setClock(0) }
  })
}

test('every committed plan directory is covered by a compare mode above or is hand-written', () => {
  const root = path.join(app, 'proofs', 'decision-real-measure')
  const dirs = readdirSync(root).filter(d => statSync(path.join(root, d)).isDirectory())
  const covered = new Set(['action-relevance', 'axis-hybrid', 'axis-split', 'board-reply-screening', 'l1-remeasure-c13', 'briefing-coverage', 'briefing-coverage-facts',
    'contamination', 'draft-overcorrection', 'memory-action-v2', 'split-wording', 'turn-context-latency', 'turn-context-idle', 'turn-context-warmup', 'utterance-threshold', 'working-memory-judge'])
  assert.deepEqual(dirs.filter(d => !covered.has(d) && !HAND_WRITTEN.includes(d)), [], 'a new committed plan directory needs a compare mode in CHECKS (or is declared hand-written)')
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
