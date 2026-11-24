// The subjective model's side of the Answer Briefing flow (egdesk-briefing-flow.mjs), on L3's internal turns (codex-internal-turn.mjs): the SAME model that wrote the
// answer designs the briefing on a private fork of that conversation. Nothing of these turns reaches the chat (no run, no message, no draft); the fork cannot act.
// This module only builds the prompt, reads back ONE reply and reduces it to the closed shape the flow's own validators check (resolveDesign / completeBriefingArgs).
// It never decides anything: a reply that does not parse is null, the flow retries within its bound and then leaves the chat answer as it is.
// Bounds: per-turn time, total time, number of turns, reply size. Model-facing text is English; step texts are asked for in the language of the answer.
// Cycle 30, behind a default-off flag (outputSchema): the fill / design request also carries a JSON Schema built from the accepted shape of the render components
// (egdesk-briefing-output-schema.mjs), sent as the turn's `outputSchema`, so the engine's final message must be a valid fill / design. Off: nothing below changes a byte.

import { outputSchemaFor, stripNulls, violation } from './egdesk-briefing-output-schema.mjs'

// Cycle 35, from Main's real runs (check-9, Codex 0.171, a fresh internal thread, low-effort app-server): one card of the fill took 20.9 s and 28.7 s (output 785 / 1,299 tokens, reasoning
// 632 / 886), the whole fill of 2 cards did not finish in 30 s. The board is published AFTER the person already has the chat answer and nothing about it is shown while it is being
// made, so it may take longer: a private turn gets 90 s (a whole 2-3 card fill at the measured pace, with room), and the whole flow's private turns 240 s (one whole fill, one round
// of pieces and one rewrite). The chrome waits 290 s for the answer to /decision/briefing-observe (overlay/JS/eg-desk-surface.uc.js), under Firefox's default 300 s response timeout
// (an assumption about the default, not verified in this build); BRIEFING_CHROME_WAIT_MS names it here and a test pins that the surface uses it.
export const BRIEFING_CHROME_WAIT_MS = 290_000
export const BRIEFING_FILL_EFFORT = 'low' // closed word; the private fill / component turns reason little: the materials and the guide say what to write
export const BRIEFING_ENGINE_LIMITS = Object.freeze({ turnMs: 90_000, totalMs: 240_000, maxTurns: 6, replyMax: 16_000, componentMax: 8_000, reportMax: 20_000 })
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
// Skeleton-first order (cycle 13, egdesk-briefing-skeleton.mjs): the design guide is already decided. This prompt carries ONLY that guide and the materials: no answer text,
// no board, no instruction to design. The model returns slot data; code validates it against the slot schemas and builds the components.
const FILL_FRAME = 'You are filling in the data of an Answer Briefing whose design is already decided. This is private preparation. Do not use tools. Do not address the person. ' +
  'Reply with exactly one JSON object and nothing else.'
const FILL_SHAPE_FULL = '{"title": string, "items": {"<item id>": {"text": string, "fallback": string, "slots": {"<slot name>": value}}}, "unfillable": [{"item": "<item id>", "slot": "<slot name>", "reason": string}]}'
// c35: the compact shape (no fallback sentence: the request's guide does not list one)
const FILL_SHAPE_COMPACT = FILL_SHAPE_FULL.replace('"fallback": string, ', '')
const FILL_RULES_BASE = [
  'Fill every listed item and only the listed items: do not add an item, a step, a component, a slot or a field.',
  '@@ITEM_RULE@@',
  'A text slot is a string no longer than its "max". A material slot is one of the item\'s material aliases. A list slot is an array of rows with exactly the listed fields, between "min" and "max" rows.',
  'Use ONLY what the materials say. If the materials do not contain the data for a slot, do not invent it: leave that slot out and report it in "unfillable".',
  'Where a line or value restates something a material says, keep its actors, qualifiers, amounts and dates exactly as the material has them: who does it, under what condition, how much, by when (for example write "팀장 승인 후 견적서 v2 발송", not "승인 후 견적서 v2 발송").',
  // Cycle 26: a card holds a fixed number of rows; a material that lists more items than that still states how many there are (c25: "8개 레인" on a six-row card).
  'If a material lists more items than a list slot has rows, list the first ones and put the total the material states in that item\'s title slot, as the material writes it.',
  'Write every text in the language of the materials.',
].join('\n')

// c35: the item rule depends on what the request's guide lists. Compact (the default for a request built by fillRequest): "text" is ONE SHORT PHRASE (the step explanation, at
// most 80 characters, saying what the item shows without repeating what its slots show), no fallback sentence. A guide that still lists a fallback (an older request) is
// asked for it as before. A line field marked "copy" may be null: the code copies the cited material's own date / sentences, exactly, so the model does not retype them.
const wantsFallback = request => (request?.guide?.items ?? []).some(i => (i.step ?? []).some(s => s.name === 'fallback'))
const hasCopy = request => (request?.guide?.items ?? []).some(i => (i.slots ?? []).some(s => (s.of ?? []).some(f => f.copy === true)))
const itemRule = request => (wantsFallback(request)
  ? 'Each item has "text" (the step explanation, saying only what the item shows) and "fallback" (one sentence for when it cannot be shown), plus the slots its component lists.'
  : 'Each item has "text" (the step explanation: one short phrase of at most 80 characters that says what the item shows, without repeating what its slots show), plus the slots its component lists.')
const COPY_RULE = 'A list field marked "copy": true may be null: the label as null is the cited material\'s date; the text as null is the cited material\'s whole text, copied by the code exactly, and only when that whole text is no longer than the field\'s "max". If the material\'s text is longer than "max", do not use null: write a line of at most "max" characters that keeps every id, number, date and name the material states (leave out explanations first).'
const fillRules = request => FILL_RULES_BASE.replace('@@ITEM_RULE@@', itemRule(request)) + (hasCopy(request) ? `\n${COPY_RULE}` : '')
export function fillPrompt(request) {
  // A rewrite after the check: closed words only for what was not supported by its material ("P2 line 2", "P1 explanation"); never the reviewer's text.
  const rejected = Array.isArray(request?.rejected) ? request.rejected.filter(w => typeof w === 'string' && /^P[1-6] (?:explanation|line \d{1,2}|row \d{1,2} (?:left|right))$/.test(w)).slice(0, 24) : []
  // Cycle 34 (owner rule U5, one bounded re-design round): the materials whose statements the board must ALSO carry, by alias only (never the answer's text).
  const cover = Array.isArray(request?.cover) ? request.cover.filter(a => typeof a === 'string' && /^M\d{1,2}$/.test(a)).slice(0, 12) : []
  const scope = (Array.isArray(request?.only) && request.only.length ? `Fill only these items again: ${request.only.join(', ')}.\n` : '') +
    (cover.length ? `A check found that the board does not yet show everything these materials state: ${cover.join(', ')}. Write the listed items so that they carry every id, number, date, name and condition those materials state, as the material writes it.\n` : '') +
    (rejected.length ? `A check found these parts of your previous data not supported by the material they cite: ${rejected.join('; ')}. Write them again from what the material says, keeping its actors, qualifiers, amounts and dates exactly, or report the slot as unfillable.\n` : '') + (request?.only?.length || rejected.length || cover.length ? '\n' : '')
  return `${FILL_FRAME}\n\n${scope}${dataBlock('Design guide (decided; do not change it)', request?.guide ?? null)}\n\n${dataBlock('Materials', request?.materials ?? [])}\n\nRules:\n${fillRules(request)}\n\nJSON shape: ${wantsFallback(request) || !request?.guide ? FILL_SHAPE_FULL : FILL_SHAPE_COMPACT}`
}
const unfence = value => { const m = /^\s*```[a-zA-Z]*\n([\s\S]*?)\n```\s*$/.exec(value); return (m ? m[1] : value).trim() }

/**
 * createBriefingEngine({ runText, report?, now?, limits?, outputSchema? }) → async engine(request) → design | { markdown } | null
 *   runText(prompt, { timeoutMs, outputSchema? }) → the model's final text of one private turn, or null (CodexChatRuntime.internalText bound to the answer's run).
 *   outputSchema === true: a fill / design request is sent with its schema; the reply is checked against it here (a reply that does not fit is null, as a reply that does not parse).
 * engine.stats() → { turns, elapsedMs, refused } (content-free; plus schemaInvalid when outputSchema is on).
 */
export function createBriefingEngine({ runText, report = '', now = Date.now, limits = {}, outputSchema = false, effort = null } = {}) {
  if (typeof runText !== 'function') throw new TypeError('runText is required')
  const L = { ...BRIEFING_ENGINE_LIMITS, ...Object.fromEntries(Object.entries(limits).filter(([k, v]) => Object.hasOwn(BRIEFING_ENGINE_LIMITS, k) && Number.isFinite(v) && v > 0)) }
  const answer = typeof report === 'string' ? report.slice(0, L.reportMax) : ''
  const started = now()
  let turns = 0, refused = 0, schemaInvalid = 0, last = null
  const ask = async (prompt, schema = null, kindEffort = null) => {
    const left = L.totalMs - (now() - started)
    if (turns >= L.maxTurns || left <= 0) { refused++; last = 'refused'; return null }
    turns++
    // Cycle 34: a null reply that came back only when its allotted time was up is a TIMEOUT (c33's check-7: two fill turns of 30.4 s each, no reply); asking the same
    // thing again will not help, and the flow reads it through engine.lastFailure().
    const allotted = Math.max(1, Math.min(L.turnMs, left)), at = now()
    try { const reply = await runText(prompt, { timeoutMs: allotted, ...(schema ? { outputSchema: schema } : {}), ...(kindEffort ? { effort: kindEffort } : {}) }); if (typeof reply === 'string' && reply.length <= L.replyMax) return reply; last = reply === null || reply === undefined ? (now() - at >= allotted - 250 ? 'timeout' : 'no-reply') : 'unusable'; return null } catch { last = now() - at >= allotted - 250 ? 'timeout' : 'no-reply'; return null }
  }
  // The schema of a request (null when off or for a kind that is not constrained). A request that cannot be described is asked without one, as with the flag off.
  const schemaOf = request => { if (outputSchema !== true) return null; try { return outputSchemaFor(request) } catch { return null } }
  // With a schema the final message must BE the JSON object (no prose around it) and fit the schema; null slots / emphasis are read as left out.
  const constrained = (reply, schema, kind) => {
    let value = null
    try { value = JSON.parse(String(reply ?? '').trim()) } catch { value = null }
    if (value === null || violation(value, schema)) { schemaInvalid++; return null }
    return stripNulls(kind, value)
  }
  const run = async request => {
    const kind = request?.kind
    const schema = schemaOf(request)
    if (schema) {
      const prompt = kind === 'briefing_fill' ? fillPrompt(request) : kind === 'briefing_design' ? designPrompt(request, answer) : redesignPrompt(request, answer)
      const reply = await ask(prompt, schema, kind === 'briefing_fill' ? effort : null)
      if (typeof reply !== 'string') return null
      const value = constrained(reply, schema, kind)
      return value && kind !== 'briefing_fill' ? shapeDesign(value) : value
    }
    if (kind === 'briefing_design') return shapeDesign(parseEngineJson(await ask(designPrompt(request, answer)), L.replyMax))
    if (kind === 'briefing_redesign' || kind === 'briefing_redesign_inconclusive') return shapeDesign(parseEngineJson(await ask(redesignPrompt(request, answer)), L.replyMax))
    if (kind === 'briefing_fill') return parseEngineJson(await ask(fillPrompt(request), null, effort), L.replyMax)
    if (kind === 'briefing_component') {
      const reply = await ask(componentPrompt(request, answer), null, effort)
      const markdown = typeof reply === 'string' ? unfence(reply).slice(0, L.componentMax) : ''
      return markdown ? { markdown } : null
    }
    return null
  }
  // The reason the last request produced nothing usable: 'timeout' | 'no-reply' | 'refused' (turn or time bound) | 'unusable' (a reply, but not the asked shape); null after a usable one.
  const engine = async request => { last = null; const out = await run(request); if (out === null || out === undefined) last ??= 'unusable'; else last = null; return out }
  engine.lastFailure = () => last
  engine.stats = () => ({ turns, refused, elapsedMs: Math.max(0, now() - started), ...(outputSchema === true ? { schemaInvalid } : {}) })
  return engine
}

/**
 * The bridge's dependencies for the `on` path, in one place so a test mounts exactly what the bridge mounts.
 * enabled === false (the default) leaves the engine out: the route then answers 'no-engine' and does nothing.
 */
export function briefingDeps({ chat, contexts, enabled = false, limits, order = 'skeleton', fillCheck = 'all', coverage = 'facts', outputSchema = 'off' } = {}) {
  return {
    // Cycle 30: 'on' sends the fill / design request with its outputSchema (the engine's final message must be a valid fill / design). Default off: the request is as before.
    outputSchema: outputSchema === 'on' ? 'on' : 'off',
    // The coverage check at the end: one question per fact the board must show (default, cycle 21) or the one whole-board question ('board', internal switch, cycle 19).
    coverage: coverage === 'board' ? 'board' : 'facts',
    // The check after the fill: every piece (default) or only the pieces with a number, a date, a Latin word or a name ('facts', internal switch, off by default).
    fillCheck: fillCheck === 'facts' ? 'facts' : 'all',
    // Which side decides the design. 'skeleton' (default since cycle 13): the Decision model fixes the design guide from the catalog, the subjective model fills the data.
    // 'design-first': the earlier order (the subjective model designs, the Decision model checks), kept for comparison.
    order: order === 'design-first' ? 'design-first' : 'skeleton',
    // The turn's memory materials as data (lane L7: chat.memoryMaterialsFor(run), rows the answering model was given this turn). Absent method or anything unusable = none.
    materialsFor: run => { try { const rows = chat.memoryMaterialsFor?.(run); return Array.isArray(rows) ? rows : [] } catch { return [] } },
    // c32: preamble:false. The private turn may run on a FRESH ephemeral thread (an ephemeral answer thread cannot be forked on Codex 0.171); that thread must see exactly this
    // prompt (guide + materials, or the design prompt that carries the answer itself), never a context line added by the runtime.
    engineFor: (run, { report = '' } = {}) => (enabled === true && chat.canInternalTurn(run)
      ? createBriefingEngine({ runText: (prompt, options) => chat.internalText(run, prompt, { ...options, preamble: false }), report, limits, outputSchema: outputSchema === 'on', effort: BRIEFING_FILL_EFFORT }) : null),
    runFor: ids => chat.runFor(ids),
    propose: (run, args) => contexts.proposeBriefing(run, args),
    publishOutput: (run, args) => contexts.publishOutput(run, args),
  }
}
