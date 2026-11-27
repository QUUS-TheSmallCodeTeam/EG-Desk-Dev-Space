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
import { PLANS_L1 } from './committed-plans/L1.mjs'
import { PLANS_L2 } from './committed-plans/L2.mjs'
import { PLANS_L3 } from './committed-plans/L3.mjs'
import { PLANS_L4 } from './committed-plans/L4.mjs'
import { PLANS_L5 } from './committed-plans/L5.mjs'
import { PLANS_L6 } from './committed-plans/L6.mjs'
import { PLANS_L7 } from './committed-plans/L7.mjs'
import { PLANS_L8 } from './committed-plans/L8.mjs'

// c33: the register is the concatenation of one append-only list per lane (helper/committed-plans/L<n>.mjs); this file changes only when the format or a lane list is added.
export const COMMITTED_PLANS = Object.freeze([...PLANS_L1, ...PLANS_L2, ...PLANS_L3, ...PLANS_L4, ...PLANS_L5, ...PLANS_L6, ...PLANS_L7, ...PLANS_L8])

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
