#!/usr/bin/env node
// Replays an all-on journey results file against the code of ONE checkout (the old or the new int SHA of scripts/egdesk-journey-diff.mjs) and
// writes the request bodies that code builds. Analysis only: nothing is sent (the replay answers from the recorded answers), and the checkout is a
// throwaway extraction of an immutable commit.
//
//   node scripts/egdesk-journey-replay-driver.mjs --checkout <dir that holds apps/firefox-ui-demo> --results <journey results.json> --out <file>
//
// A results file keeps only each request's sha256, byte count and question names, not its body. The journey harness (scripts/egdesk-all-on-live-measure.mjs)
// builds the bodies with the product's own Decision client; this driver runs that harness from the checkout with the recorded answers
// (replayAnswers) and one instrumentation line that records each body next to its sha256. The line is added to a COPY of the harness inside
// the checkout (BODY_ANCHOR is the line it follows); a checkout that does not have the anchor is refused. A body counts as reproduced when its
// sha256 is the one the results file recorded; the rest is reported, never hidden.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const BODY_ANCHOR = "row.sha256 = sha256(Buffer.from(body, 'utf8')); row.estInputTokens = est"
export const BODY_HOOK = " globalThis.__egdeskJourneyBodies?.push({ step: row.step, family: row.feature, names: wire.questions.map(q => q.name), body, sha256: row.sha256 })"
export const instrument = text => (text.split(BODY_ANCHOR).length === 2 ? text.replace(BODY_ANCHOR, BODY_ANCHOR + ';' + BODY_HOOK) : null)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** The plan file of the checkout whose sha256 is the one the results file names (the results file's own plan name is the unversioned file). */
export function findPlanFile(scriptsDir, wantedSha) {
  for (const name of readdirSync(scriptsDir).filter(n => /^egdesk-all-on-live-measure\.plan.*\.json$/.test(n)).sort()) {
    if (sha256(readFileSync(path.join(scriptsDir, name))) === wantedSha) return path.join(scriptsDir, name)
  }
  return null
}

export async function replay({ checkout, results }) {
  const app = path.join(checkout, 'apps', 'firefox-ui-demo'), scripts = path.join(app, 'scripts')
  const source = path.join(scripts, 'egdesk-all-on-live-measure.mjs'), patched = instrument(readFileSync(source, 'utf8'))
  if (!patched) return { error: 'anchor_missing', message: `the journey harness of this checkout has no "${BODY_ANCHOR}" line: the body capture needs updating (scripts/egdesk-journey-replay-driver.mjs BODY_ANCHOR)` }
  const planFile = findPlanFile(scripts, results?.plan?.sha256)
  if (!planFile) return { error: 'plan_missing', message: `no plan file of this checkout has the sha256 ${String(results?.plan?.sha256).slice(0, 16)} the results file names` }
  // a copy next to the harness (its relative imports must resolve), dot-named and unique, removed at the end
  const copy = path.join(scripts, `.egdesk-journey-replay-${process.pid}-${Date.now()}.mjs`)
  writeFileSync(copy, patched)
  let mod, plan, outcome, bodies
  try {
    globalThis.__egdeskJourneyBodies = []
    mod = await import(pathToFileURL(copy).href)
    plan = mod.loadJourneyPlan(planFile)
    outcome = await mod.runJourney({ plan, replay: mod.replayAnswers(results), switches: Array.isArray(results?.world?.switchesOn) ? results.world.switchesOn : [] })
    bodies = globalThis.__egdeskJourneyBodies
  } finally { rmSync(copy, { force: true }); delete globalThis.__egdeskJourneyBodies }
  const recorded = new Map()
  for (const step of results.steps ?? []) for (const row of step.requests ?? []) recorded.set(row.sha256, (recorded.get(row.sha256) ?? 0) + 1)
  const rows = (outcome.steps ?? []).map(step => ({ id: step.id, requests: (step.requests ?? []).map(r => ({ family: r.family, sha256: r.sha256, replay: r.replay ?? null, questions: r.questions })) }))
  const reproduced = bodies.filter(b => recorded.has(b.sha256)).length
  return { plan: path.basename(planFile), bodies, rows, reproduced, built: bodies.length, recorded: [...recorded.values()].reduce((a, b) => a + b, 0), stopped: outcome.ledger?.stopped ?? null }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), valueOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? null : null }
  const checkout = valueOf('--checkout'), resultsFile = valueOf('--results'), out = valueOf('--out')
  if (!checkout || !resultsFile || !out) { console.error('usage: egdesk-journey-replay-driver.mjs --checkout <dir> --results <results.json> --out <file>'); process.exit(2) }
  const results = JSON.parse(readFileSync(resultsFile, 'utf8'))
  const outcome = await replay({ checkout, results })
  writeFileSync(out, JSON.stringify(outcome))
  if (outcome.error) { console.error(outcome.message); process.exit(outcome.error === 'anchor_missing' ? 3 : 4) }
  console.log(JSON.stringify({ built: outcome.built, reproduced: outcome.reproduced, recorded: outcome.recorded, stopped: outcome.stopped }))
}
