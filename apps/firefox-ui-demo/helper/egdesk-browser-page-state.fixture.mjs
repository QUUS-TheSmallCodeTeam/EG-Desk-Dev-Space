import { PAGE_STATE_CHECKS } from './egdesk-browser-reflex.mjs'

// Test doubles for the page-state predicates (c16). A double that means one page state answers that state's predicate decided yes and
// every other decided no; 'content' is all decided no. An unsure double (p below the 0.7 bar) leaves its predicate undecided.
// 'loading' is not a model answer any more (code reads snapshot.readyState), so it is refused here: such a test must set readyState.
export const PS_NAMES = Object.freeze(PAGE_STATE_CHECKS.map(check => check.name))
const STATE_OF = Object.freeze({ access_denied: 'error_page' })
export function pageStateProbabilities(state = 'content', p = 0.95) {
  if (state === 'loading') throw new Error('loading is read from snapshot.readyState, not answered')
  const target = STATE_OF[state] ?? state
  if (target !== 'content' && !PAGE_STATE_CHECKS.some(check => check.state === target)) throw new Error(`unknown page state ${state}`)
  return Object.fromEntries(PAGE_STATE_CHECKS.map(check => [check.name, check.state === target ? p : target === 'content' && p < 0.7 ? 0.5 : 0.02]))
}
/** Wire answers (the Decisions response array form). */
export const pageStateWire = (state, p) => Object.entries(pageStateProbabilities(state, p)).map(([name, probability]) => ({ name, type: 'predicate', probability }))
/** Normalized answers (the client's answers object form). */
export const pageStateAnswers = (state, p) => Object.fromEntries(Object.entries(pageStateProbabilities(state, p)).map(([name, probability]) => [name, { type: 'predicate', probability }]))
