// L6 cycle 17: the register of every committed real-measurement plan and how it is kept reproducible. Analysis tooling only; nothing here
// sends, and no product code reads it. helper/egdesk-plan-clock.test.mjs checks that every committed plan location is registered and that
// every "rebuilt" entry rebuilds byte-identically with the system clock moved.
//
// A committed plan location is
//   proofs/decision-real-measure/<folder>      (any plan.json below it)
//   scripts/real-plans/<folder>
//   scripts/*plan*.json, helper/*plan*.json    (single-file plans: live-journey plans, heartbeat registrations)
// Each entry is exactly one of
//   rebuilt: { script, argv?, matches? }  the script's own compare mode (prints "matches" per set it covers, never "differs"/"DIFFERS"/"stale")
//   rebuilt: { builder: [module, export], dir? }  the builder's files ({ name: text } or [{ file, bytes }], plus planBytes) equal the committed ones
//   rebuilt: { heartbeat: true }   the heartbeat snapshot: planFile(buildHeartbeatPlan()) deep-equals the committed snapshot
//   frozen: reason                 kept exactly as sent; its own test checks integrity, the code no longer builds it
//   handWritten: reason            written by hand (no builder; static bytes, no clock)
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

export const COMMITTED_PLANS = Object.freeze([
  // proofs/decision-real-measure
  { path: 'proofs/decision-real-measure/action-relevance', lane: 'L7', rebuilt: { script: 'egdesk-action-relevance-plan.mjs' } },
  { path: 'proofs/decision-real-measure/all-on-s3-faithful-fill', lane: 'L2', handWritten: 'two hand-built s3 requests (161609b); no builder' },
  { path: 'proofs/decision-real-measure/axis-hybrid', lane: 'L7', rebuilt: { script: 'egdesk-axis-hybrid-plan.mjs' } },
  { path: 'proofs/decision-real-measure/axis-split', lane: 'L7', rebuilt: { script: 'egdesk-axis-split-plan.mjs' } },
  { path: 'proofs/decision-real-measure/board-reply-screening', lane: 'L1', rebuilt: { script: 'egdesk-board-reply-real-plan.mjs', matches: 3 } },
  { path: 'proofs/decision-real-measure/briefing-coverage', lane: 'L4', rebuilt: { script: 'egdesk-briefing-coverage-plan.mjs', matches: 2 } },
  { path: 'proofs/decision-real-measure/briefing-coverage-facts', lane: 'L4', rebuilt: { script: 'egdesk-briefing-coverage-plan.mjs', matches: 2 } },
  { path: 'proofs/decision-real-measure/contamination', lane: 'L6', rebuilt: { script: 'egdesk-contamination-plan.mjs' } },
  { path: 'proofs/decision-real-measure/draft-overcorrection', lane: 'L6', rebuilt: { script: 'egdesk-draft-overcorrection-plan.mjs' } },
  { path: 'proofs/decision-real-measure/hud-routing', lane: 'L1', rebuilt: { builder: ['./egdesk-hud-routing-real-plan.mjs', 'buildHudPlan'] } },
  { path: 'proofs/decision-real-measure/l1-remeasure-c13', lane: 'L1', rebuilt: { script: 'egdesk-board-reply-real-plan.mjs', matches: 3 } },
  { path: 'proofs/decision-real-measure/memory-action', lane: 'L7', frozen: 'memory-action-v1 as sent in c24, superseded by memory-action-v2 (helper/egdesk-speech-hybrid.test.mjs checks the bodies as sent)' },
  { path: 'proofs/decision-real-measure/memory-action-v2', lane: 'L7', rebuilt: { script: 'egdesk-memory-action-v2-plan.mjs' } },
  { path: 'proofs/decision-real-measure/split-wording', lane: 'L7', rebuilt: { script: 'egdesk-split-wording-plan.mjs' } },
  { path: 'proofs/decision-real-measure/turn-context-idle', lane: 'L6', rebuilt: { script: 'egdesk-turn-context-latency-plan.mjs', argv: ['--idle'] } },
  { path: 'proofs/decision-real-measure/turn-context-latency', lane: 'L6', rebuilt: { script: 'egdesk-turn-context-latency-plan.mjs' } },
  { path: 'proofs/decision-real-measure/turn-context-warmup-size', lane: 'L6', rebuilt: { script: 'egdesk-turn-context-latency-plan.mjs', argv: ['--size'] } },
  { path: 'proofs/decision-real-measure/turn-context-warmup-sep', lane: 'L6', rebuilt: { script: 'egdesk-turn-context-latency-plan.mjs', argv: ['--sep'] } },
  { path: 'proofs/decision-real-measure/turn-context-warmup', lane: 'L6', rebuilt: { script: 'egdesk-turn-context-latency-plan.mjs', argv: ['--warmup'] } },
  { path: 'proofs/decision-real-measure/utterance-threshold', lane: 'L6', rebuilt: { script: 'egdesk-utterance-threshold-study.mjs' } },
  { path: 'proofs/decision-real-measure/work-placement', lane: 'L1', rebuilt: { script: 'egdesk-board-reply-real-plan.mjs', matches: 3 } },
  { path: 'proofs/decision-real-measure/working-memory-judge', lane: 'L6', rebuilt: { script: 'egdesk-working-memory-real-plan.mjs' } },
  // scripts/real-plans
  { path: 'scripts/real-plans/command-judgments-v1', lane: 'L5', frozen: 'sent 2026-11-24; a frozen record integrity-checked by helper/egdesk-command-real-plan.test.mjs' },
  { path: 'scripts/real-plans/command-risk-v2', lane: 'L5', rebuilt: { builder: ['./egdesk-command-risk-plan.mjs', 'buildCommandRiskPlanV2'] } },
  { path: 'scripts/real-plans/run-conditions-v1', lane: 'L5', rebuilt: { builder: ['./egdesk-run-conditions-plan.mjs', 'buildRunConditionsPlan'] } },
  // single-file plans
  { path: 'helper/egdesk-heartbeat-real-plan.snapshot.json', lane: 'L3', rebuilt: { heartbeat: true } },
  ...['c15', 'c16', 'c17'].map(c => ({ path: `helper/egdesk-heartbeat-real-plan.${c}.json`, lane: 'L3', frozen: `the ${c} heartbeat registration as measured (2026-11-24); helper/egdesk-heartbeat-real-plan.test.mjs` })),
  ...['', '-v2', '-v3', '-v4', '-v5', '-v6', '-v7'].map(v => ({ path: `scripts/egdesk-all-on-live-measure.plan${v}.json`, lane: 'L2', handWritten: 'all-on journey scenario plan (steps and checks written by hand; the live runner builds bodies at run time)' })),
  ...['', '-v2', '-v3', '-v4'].map(v => ({ path: `scripts/egdesk-multiuser-live-measure.plan${v}.json`, lane: 'L1', handWritten: 'collaboration scenario plan (written by hand; the live runner builds bodies at run time)' })),
  ...['allon-plan', 'plan', 'plan-delivery', 'plan-holdout', 'plan-holdout-rerun', 'plan-holdout2', 'plan-settings', 'plan-stuck', 'plan-entry', 'plan-settings-error', 'plan-stability', 'plan-statement', 'recorded-plan', 'renamed-plan'].map(v => ({ path: `scripts/egdesk-browser-live-${v}.json`, lane: 'L8', handWritten: 'browser journey plan (written by hand; the live runner builds bodies at run time)' })),
])

/** Every committed plan location under the app root (see the header), sorted. */
export function findCommittedPlans(appRoot) {
  const out = []
  const hasPlan = dir => readdirSync(dir, { recursive: true }).some(f => path.basename(String(f)) === 'plan.json')
  for (const base of ['proofs/decision-real-measure', 'scripts/real-plans']) {
    const root = path.join(appRoot, base)
    if (!existsSync(root)) continue
    for (const d of readdirSync(root)) if (statSync(path.join(root, d)).isDirectory() && hasPlan(path.join(root, d))) out.push(`${base}/${d}`)
  }
  for (const base of ['scripts', 'helper']) for (const f of readdirSync(path.join(appRoot, base))) if (/plan.*\.json$/.test(f) && statSync(path.join(appRoot, base, f)).isFile()) out.push(`${base}/${f}`)
  return out.sort()
}

// Name rules used ONLY to name the likely owner of a location that is not registered yet (the failure message); a registered entry's lane wins.
const LANE_RULES = Object.freeze([
  [/turn-context|contamination|overcorrection|utterance|working-memory/, 'L6'],
  [/board|hud|placement|l1-|multiuser|presence|requester/, 'L1'],
  [/briefing|real-material|l4-/, 'L4'],
  [/heartbeat|scenario|l3-/, 'L3'],
  [/browser|settings|delivery|statement|l8-/, 'L8'],
  [/all-on|journey|l2-/, 'L2'],
  [/axis|memory-action|split-wording|action-relevance|terse|record|sentence|l7-/, 'L7'],
  [/command|run-condition|terminal|l5-/, 'L5'],
])
/** The likely owning lane of an unregistered location: from its plan's set name, then its path; null when nothing matches. */
export function guessLane(location, appRoot) {
  let set = ''
  try {
    const file = location.endsWith('.json') ? path.join(appRoot, location)
      : path.join(appRoot, location, readdirSync(path.join(appRoot, location), { recursive: true }).map(String).find(f => path.basename(f) === 'plan.json'))
    set = String(JSON.parse(readFileSync(file, 'utf8')).set ?? '')
  } catch { set = '' }
  const lane = text => /\b[lL]([1-9])[-_ ]/.exec(text)?.[1]
  if (lane(set)) return `L${lane(set)}`
  for (const text of [set.toLowerCase(), location.toLowerCase()]) for (const [re, l] of LANE_RULES) if (re.test(text)) return l
  return null
}

/** Locations without an entry, and entries without a location: each named with its (likely) lane. */
export function coverageProblems(appRoot) {
  const found = findCommittedPlans(appRoot), registered = new Map(COMMITTED_PLANS.map(e => [e.path, e]))
  const missing = found.filter(p => !registered.has(p)).map(p => {
    const lane = guessLane(p, appRoot)
    return `${p}: committed plan not covered (owning lane ${lane ?? 'unknown, see git log --diff-filter=A -- ' + p}${lane ? ', guessed from its set name / path' : ''}); register it in helper/egdesk-committed-plans.mjs as rebuilt (a compare mode or builder) or handWritten/frozen with a reason`
  })
  const stale = COMMITTED_PLANS.filter(e => !found.includes(e.path)).map(e => `${e.path} (lane ${e.lane}): registered but no committed plan is there`)
  const malformed = COMMITTED_PLANS.filter(e => ['rebuilt', 'frozen', 'handWritten'].filter(k => e[k] !== undefined).length !== 1 || !/^L[1-9]$/.test(e.lane)).map(e => `${e.path}: an entry needs exactly one of rebuilt / frozen / handWritten and a lane`)
  return [...missing, ...stale, ...malformed]
}
