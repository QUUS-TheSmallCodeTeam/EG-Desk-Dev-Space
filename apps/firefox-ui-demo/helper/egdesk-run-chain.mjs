// L6 c25: the "two passing full runs" readiness rule, counted so that a repeat does not count twice. Analysis only: nothing here sends or reads a key.
// Identical request bytes give identical answers (117 of 117 pairs measured: journeys, browser-live, a duplicate send), so a passing run whose requests are
// mostly byte-identical to an earlier passing run of the same chain is a re-check of the code around the model, not a new draw from it.
// A chain is a list of results files of one plan family in time order. Each entry says whether the run passed (no hard failure) and whether it is FRESH:
// the first pass, or a pass with fewer than half of its Decisions requests byte-identical to a request of an earlier PASS of the chain.
export const FRESH_BELOW = 0.5

/** The keys of a results file's Decisions requests: a journey's (step, family, question names, sha256), a runner or browser-live result's sha256. */
export function requestKeys(results) {
  if (Array.isArray(results?.steps)) return results.steps.flatMap(step => (step.requests ?? []).filter(q => typeof q?.sha256 === 'string').map(q => `${step.id}|${q.family}|${(q.questions ?? []).join(',')}|${q.sha256}`))
  return (Array.isArray(results?.requests) ? results.requests : []).filter(q => typeof q?.sha256 === 'string').map(q => q.sha256)
}
/** { pass, hardFailures } of a results file: browser-live has scorecard.pass and hardFailures[]; a journey or multiuser run has scorecard.hard.failed[]. */
export function runOutcome(results) {
  const card = results?.scorecard
  if (typeof card?.pass === 'boolean') return { pass: card.pass, hardFailures: Array.isArray(card.hardFailures) ? card.hardFailures.length : card.pass ? 0 : null }
  const failed = card?.hard?.failed
  return Array.isArray(failed) ? { pass: failed.length === 0, hardFailures: failed.length } : { pass: false, hardFailures: null, unreadable: true }
}
/** chain([{ name, results }]) -> [{ name, pass, hardFailures, requests, sameAsEarlierPass, fresh }] */
export function chain(entries) {
  const seen = new Set(), out = []
  for (const { name, results } of entries) {
    const keys = requestKeys(results), { pass, hardFailures, unreadable } = runOutcome(results), same = keys.filter(k => seen.has(k)).length
    out.push({ name, pass, hardFailures, requests: keys.length, sameAsEarlierPass: same, fresh: pass && (seen.size === 0 || keys.length === 0 || same / keys.length < FRESH_BELOW), ...(unreadable ? { unreadable } : {}) })
    if (pass) keys.forEach(k => seen.add(k))
  }
  return out
}
/** { passed, failed, freshPasses, last } of a chain. */
export function summarize(list) {
  const last = list.at(-1)
  return { passed: list.filter(x => x.pass).length, failed: list.filter(x => !x.pass).length, freshPasses: list.filter(x => x.fresh).length, last: last ? `${last.name} ${last.pass ? 'pass' : `FAIL ${last.hardFailures}`}` : null }
}
