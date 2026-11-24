// The subjective model's side of the Answer Briefing flow (egdesk-briefing-flow.mjs), on L3's internal turns (codex-internal-turn.mjs): the SAME model that wrote the
// answer designs the briefing on a private fork of that conversation. Nothing of these turns reaches the chat (no run, no message, no draft); the fork cannot act.
// This module only builds the prompt, reads back ONE reply and reduces it to the closed shape the flow's own validators check (resolveDesign / completeBriefingArgs).
// It never decides anything: a reply that does not parse is null, the flow retries within its bound and then leaves the chat answer as it is.
// Bounds: per-turn time, total time, number of turns, reply size. Model-facing text is English; step texts are asked for in the language of the answer.

export const BRIEFING_ENGINE_LIMITS = Object.freeze({ turnMs: 30_000, totalMs: 100_000, maxTurns: 6, replyMax: 16_000, componentMax: 8_000, reportMax: 20_000 })
const MAX_STEPS = 20, MAX_TARGETS = 12, MAX_NEW = 6
const text = (value, max) => typeof value === 'string' ? value.slice(0, max) : undefined

/** The one JSON object of a reply (code fences and surrounding prose tolerated), or null. */
export function parseEngineJson(reply, max = BRIEFING_ENGINE_LIMITS.replyMax) {
  if (typeof reply !== 'string' || !reply.trim() || reply.length > max) return null
  const start = reply.indexOf('{'), end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try { const value = JSON.parse(reply.slice(start, end + 1)); return value && typeof value === 'object' && !Array.isArray(value) ? value : null } catch { return null }
}
/** Only the fields a design may have, as plain strings and arrays; anything else is dropped. The flow validates the meaning. */
export function shapeDesign(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.steps)) return null
  const steps = value.steps.slice(0, MAX_STEPS).map(step => {
    const s = step && typeof step === 'object' ? step : {}
    return { text: text(s.text, 2000) ?? '', targets: (Array.isArray(s.targets) ? s.targets : []).slice(0, MAX_TARGETS).filter(a => typeof a === 'string' && a.length <= 64),
      ...(typeof s.emphasis === 'string' ? { emphasis: s.emphasis.slice(0, 32) } : {}), ...(typeof s.fallback === 'string' ? { fallback: s.fallback.slice(0, 1000) } : {}) }
  })
  const news = Array.isArray(value.newComponents) ? value.newComponents.slice(0, MAX_NEW).filter(n => n && typeof n === 'object')
    .map(n => ({ part: text(n.part, 16) ?? '', title: text(n.title, 200) ?? '', summary: text(n.summary, 600) ?? '' })) : null
  return { title: text(value.title, 400) ?? '', steps, ...(news?.length ? { newComponents: news } : {}) }
}

const FRAME = 'You are preparing an Answer Briefing: ordered steps that walk the person through your final answer on their board, each step pointing at components that are ALREADY on the board. ' +
  'This is private preparation. Do not use tools. Do not address the person. Reply with exactly one JSON object and nothing else.'
const SHAPE = '{"title": string, "steps": [{"text": string, "targets": [alias, ...], "emphasis": "spotlight" | "outline" (optional), "fallback": string}], "newComponents": [{"part": string, "title": string, "summary": string}] (only if allowed)}'
const RULES = [
  'Use only the listed target aliases. Every alias in "reuse" must be used by at least one step. Never invent an alias.',
  'Each step has 1 to 6 targets, a short explanation (at most 240 characters) that says only what its targets show, and a fallback sentence for when a target cannot be shown.',
  'Create nothing new unless "newAllowed" lists a part: then that part may get ONE new component, referenced in a step as "new:<part>" and described in newComponents. Otherwise omit newComponents.',
  'Write title, step text and fallback in the language of your answer.',
].join('\n')
const answerBlock = report => (report ? `Your final answer was:\n<answer>\n${report}\n</answer>\n\n` : '')
const dataBlock = (label, data) => `${label}:\n${JSON.stringify(data)}`

export function designPrompt(request, report = '') {
  const { reply: _reply, kind: _kind, ...data } = request
  return `${FRAME}\n\n${answerBlock(report)}${dataBlock('Board components you may point at, and the limits', data)}\n\nRules:\n${RULES}\n\nJSON shape: ${SHAPE}`
}
export function redesignPrompt(request, report = '') {
  const { kind, note, invalid, previous, findings, where, ...rest } = request
  const why = invalid ? `Your previous design could not be used (reason code: ${invalid}).`
    : kind === 'briefing_redesign_inconclusive' ? (note || 'A reviewer could not decide whether the flow is sound. Make each explanation and its targets more specific.')
    : `A reviewer found problems in your previous design. Each finding names a closed issue kind, the step (scope) and the aliases it concerns:\n${JSON.stringify({ findings: findings ?? [], where: where ?? null })}`
  return `${FRAME}\n\n${answerBlock(report)}${why}\n\n${dataBlock('Your previous design', previous ?? null)}\n\n${dataBlock('Constraints that still apply', rest)}\n\nFix only what the reviewer named and keep the rest. Rules:\n${RULES}\n\nJSON shape: ${SHAPE}`
}
export function componentPrompt(request, report = '') {
  return 'You are writing ONE new board component for your final answer. This is private preparation. Do not use tools. Do not address the person. ' +
    `Reply with only the component content as markdown (no code fence around it, at most ${BRIEFING_ENGINE_LIMITS.componentMax} characters), in the language of your answer.\n\n` +
    `${answerBlock(report)}Component title: ${String(request.title ?? '')}\nIt must cover: ${String(request.summary ?? '')}\nUse only what your answer already says; add no new claims.`
}
const unfence = value => { const m = /^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/.exec(value); return (m ? m[1] : value).trim() }

/**
 * createBriefingEngine({ runText, report?, now?, limits? }) → async engine(request) → design | { markdown } | null
 *   runText(prompt, { timeoutMs }) → the model's final text of one private turn, or null (CodexChatRuntime.internalText bound to the answer's run).
 * engine.stats() → { turns, elapsedMs, refused } (content-free).
 */
export function createBriefingEngine({ runText, report = '', now = Date.now, limits = {} } = {}) {
  if (typeof runText !== 'function') throw new TypeError('runText is required')
  const L = { ...BRIEFING_ENGINE_LIMITS, ...Object.fromEntries(Object.entries(limits).filter(([k, v]) => Object.hasOwn(BRIEFING_ENGINE_LIMITS, k) && Number.isFinite(v) && v > 0)) }
  const answer = typeof report === 'string' ? report.slice(0, L.reportMax) : ''
  const started = now()
  let turns = 0, refused = 0
  const ask = async prompt => {
    const left = L.totalMs - (now() - started)
    if (turns >= L.maxTurns || left <= 0) { refused++; return null }
    turns++
    try { const reply = await runText(prompt, { timeoutMs: Math.max(1, Math.min(L.turnMs, left)) }); return typeof reply === 'string' && reply.length <= L.replyMax ? reply : null } catch { return null }
  }
  const engine = async request => {
    const kind = request?.kind
    if (kind === 'briefing_design') return shapeDesign(parseEngineJson(await ask(designPrompt(request, answer)), L.replyMax))
    if (kind === 'briefing_redesign' || kind === 'briefing_redesign_inconclusive') return shapeDesign(parseEngineJson(await ask(redesignPrompt(request, answer)), L.replyMax))
    if (kind === 'briefing_component') {
      const reply = await ask(componentPrompt(request, answer))
      const markdown = typeof reply === 'string' ? unfence(reply).slice(0, L.componentMax) : ''
      return markdown ? { markdown } : null
    }
    return null
  }
  engine.stats = () => ({ turns, refused, elapsedMs: Math.max(0, now() - started) })
  return engine
}

/**
 * The bridge's dependencies for the `on` path, in one place so a test mounts exactly what the bridge mounts.
 * enabled === false (the default) leaves the engine out: the route then answers 'no-engine' and does nothing.
 */
export function briefingDeps({ chat, contexts, enabled = false, limits } = {}) {
  return {
    engineFor: (run, { report = '' } = {}) => (enabled === true && chat.canInternalTurn(run)
      ? createBriefingEngine({ runText: (prompt, options) => chat.internalText(run, prompt, options), report, limits }) : null),
    runFor: ids => chat.runFor(ids),
    propose: (run, args) => contexts.proposeBriefing(run, args),
    publishOutput: (run, args) => contexts.publishOutput(run, args),
  }
}
