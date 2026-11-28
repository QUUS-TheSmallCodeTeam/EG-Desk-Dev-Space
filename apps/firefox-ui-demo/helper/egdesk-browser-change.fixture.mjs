// L55: a live page whose DOM never stops changing, for the change-decision tests and the real-model check (scripts/egdesk-change-decision-real-check.mjs).
import { pageStateAnswers } from './egdesk-browser-page-state.fixture.mjs'

const USAGE = Object.freeze({ inputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 1 })
export const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : role === 'button' ? 'button' : 'input', href: '', value: '', disabled: false, ...extra })
export const FORM = 'https://example.invalid/form'
export const NEXT = 'https://example.invalid/next'
export const choice = (value, confidence = 0.9) => ({ type: 'choice', choice: value, confidence, probabilities: [{ value, probability: confidence }, { value: '__other', probability: 0.05 }] })

// A live page whose DOM never stops changing: `live.revision` moves while the decision model thinks (and after every act), the way a clock or a banner moves the actor's revision.
// A tool call is refused as not sent (staleBy revision) when its expectedRevision is not the live one. `shape(live)` gives the page as it is now.
export function world({ shape, answer = () => null, tickOnDecide = true, tickOnAct = true, staleBy = 'revision', onFirstAct = null, realClient = null, text = live => ['Form', `clock ${live.revision}`] }) {
  const live = { revision: 1, doc: 'doc-1', url: FORM, filled: [], opened: [], waits: 0, observes: 0, decisions: [], acts: [], refused: 0 }
  const snapshot = () => ({ url: live.url, documentId: live.doc, revision: live.revision, text: text(live), interactiveElements: shape(live), viewport: { width: 1280, height: 800 } })
  const fake = { async decide(request) {
    live.decisions.push(request)
    if (tickOnDecide) live.revision++
    const answers = Object.create(null)
    for (const q of request.questions) {
      if (q.name.startsWith('ps_')) { answers[q.name] = pageStateAnswers(answer({ name: 'page_state' }, live, request) ?? 'content', 0.9)[q.name]; continue }
      const given = answer(q, live, request)
      answers[q.name] = given ?? (q.name === 'goal_met' ? { type: 'predicate', probability: live.opened.length || (live.filled.length && !shape(live).some(e => e.role === 'link')) ? 0.96 : 0.03 } : q.name === 'next_step' ? choice(q.choices.find(c => (live.filled.length ? /^\[L\d/ : /^\[[FL]\d/).test(c.value))?.value ?? 'blocked') : { type: 'predicate', probability: 0.03 })
    }
    return { answers, model: 'test', usage: USAGE, latencyMs: 1 }
  } }
  // a real decision model (the check script) sees the same requests; the page ticks while it thinks, as it does for the product
  const client = realClient ? { async decide(request, ...rest) { live.decisions.push(request); if (tickOnDecide) live.revision++; return realClient.decide(request, ...rest) } } : fake
  const callTool = async (name, args) => {
    if (name === 'egdesk_browser_observe') { live.observes++; return { status: 'observed', cardId: args.cardId, observationId: `obs-${live.observes}`, snapshot: snapshot() } }
    if (name === 'egdesk_browser_wait') { live.waits++; return { status: 'idle' } }
    live.acts.push({ name, args })
    const first = live.acts.length === 1
    const refuse = args.expectedRevision !== live.revision || (first && !!onFirstAct)
    if (first && onFirstAct) onFirstAct(live)
    if (tickOnAct) live.revision++
    if (refuse) { live.refused++; throw Object.assign(new Error('Browser reflex step failed'), { code: 'BROWSER_OBSERVATION_STALE', staleBy: first && onFirstAct ? staleBy : 'revision' }) }
    if (name === 'egdesk_browser_fill') live.filled.push([args.ref, args.text])
    if (name === 'egdesk_browser_navigate') { live.opened.push(args.url); live.url = args.url }
    return { status: 'postcondition-observed' }
  }
  return { live, client, callTool }
}
export const plain = live => [el('f_1', 'textbox', 'Name', { bounds: { x: 10, y: 100, width: 200, height: 24 } }), el('l_1', 'link', 'Next', { href: NEXT, bounds: { x: 10, y: 200, width: 60, height: 20 } })]
