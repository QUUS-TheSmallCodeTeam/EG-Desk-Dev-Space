import { predicateQuestion, choiceQuestion, readPredicate, readChoice } from './egdesk-decision-questions.mjs'
import { BRIEFING_EMPHASIS, BRIEFING_MAX_TARGETS, validBriefing } from '../overlay/resources/EGDeskBriefingState.sys.mjs'

// Answer Briefing flow (canon: INTERACTION_AND_ORCHESTRATION_CONTRACT section 8; JEV doc 9.4 JEV-BRIEF-01 "Briefing explanation matches its targets").
// The Decision model is a system-level judge at two points: (1) does a final report belong in a chat bubble or on the board, (2) is the designed
// briefing's flow sound, step by step. It only answers closed questions about options THIS runtime enumerated from real facts (counts, steps,
// targets, closed issue kinds, geometry). The subjective model (Codex/Claude) designs and redesigns; the user gets the briefing only after it passes,
// or the chat answer with a note. Raw probability is not permission: nothing here publishes, moves the camera or writes the Board.
// Nothing in this file talks to a network or a credential: the host injects decide{} (the bridge routes) and engine() (the subjective model).

export const BRIEFING_LIMITS = Object.freeze({ maxSteps: 8, textMax: 240, labelMax: 40, gistMax: 120, titleMax: 120, maxRevisions: 2, maxCandidates: 12, readZoom: .5, overlapShare: .14 })
export const BRIEFING_BARS = Object.freeze({ placement: .75, margin: .2, understandable: .8, flawed: .3, issue: .7 }) // placeholders until calibrated
export const BRIEFING_ITEMS = Object.freeze({
  step_unclear: 'Is the explanation of the listed step hard to understand on its own for a first-time reader?',
  explanation_mismatch: 'Does the explanation of the listed step say something its listed targets do not show?',
  uncovered_target: 'Is a board item that the report refers to missing from every step of the briefing?',
  step_order: 'Do the listed steps come in an order that contradicts the stated before/after relation between their targets?',
  targets_far: 'Are the targets of the listed step so far apart that they cannot be read together at one view?',
  targets_overlap: 'Do the targets of the listed step cover each other so that a reader cannot take each in separately?',
})
export const BRIEFING_ITEM_NAMES = Object.freeze(Object.keys(BRIEFING_ITEMS))
const KINDS = new Set(['source', 'artifact', 'output'])
const clean = (text, max) => typeof text === 'string' ? text.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : ''
const plain = (t, max) => typeof t === 'string' && t.length > 0 && t.length <= max && !/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(t) && t === t.normalize('NFC') && t.trim() === t
const exactKeys = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const right = r => r.x + r.width, bottom = r => r.y + r.height
const area = r => r.width * r.height
const overlapArea = (a, b) => Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y))
const finiteRect = r => !!r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0

// ---------------- 1. facts from the real board: what the report points at, and whether it exists there ----------------
/**
 * enumerateBriefingFacts({ report, candidates }) -> { facts, targets, boardFeasible, idOf, aliasOf }
 * candidates: [{ id, ref:{ sourceId | artifactId }, kind:'source'|'artifact'|'output', label, gist?, onBoard, maySend, rect? }] from the host (bound context
 * plus the open canvas views). Only candidates the user may send count at all. A target is "referenced" when the report text names its label.
 */
export function enumerateBriefingFacts({ report = '', candidates = [] } = {}) {
  const text = String(report ?? ''), lines = text.split('\n')
  const usable = (Array.isArray(candidates) ? candidates : []).filter(c => c && typeof c.id === 'string' && KINDS.has(c.kind) && c.maySend === true && typeof c.label === 'string' && c.label.trim().length >= 3 && c.ref && typeof c.ref === 'object').slice(0, BRIEFING_LIMITS.maxCandidates)
  const lower = text.toLowerCase()
  const targets = usable.map((c, i) => ({ alias: 'T' + (i + 1), id: c.id, ref: c.ref, kind: c.kind, label: clean(c.label, BRIEFING_LIMITS.labelMax), ...(c.gist ? { gist: clean(c.gist, BRIEFING_LIMITS.gistMax) } : {}),
    onBoard: c.onBoard === true, referenced: lower.includes(c.label.trim().toLowerCase()), ...(finiteRect(c.rect) ? { rect: { x: c.rect.x, y: c.rect.y, width: c.rect.width, height: c.rect.height } } : {}) }))
  const n = v => Math.min(99999, v)
  const facts = { chars: n(text.length), lines: n(lines.filter(l => l.trim()).length), listItems: n(lines.filter(l => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l)).length),
    headings: n(lines.filter(l => /^\s{0,3}#{1,6}\s+\S/.test(l)).length), tableRows: n(lines.filter(l => /^\s*\|.+\|\s*$/.test(l)).length),
    referenced: targets.filter(t => t.referenced).length, onBoard: targets.filter(t => t.referenced && t.onBoard).length }
  return { facts, targets, boardFeasible: facts.onBoard >= 2, idOf: new Map(targets.map(t => [t.alias, t.id])), aliasOf: new Map(targets.map(t => [t.id, t.alias])) }
}

// ---------------- 2. bubble or board: a choice over the two options the runtime offers ----------------
export function normalizePlacementDto(raw) {
  const keys = ['chars', 'lines', 'listItems', 'headings', 'tableRows', 'referenced', 'onBoard']
  if (!exactKeys(raw, ['facts']) || !exactKeys(raw.facts, keys) || !keys.every(k => Number.isInteger(raw.facts[k]) && raw.facts[k] >= 0 && raw.facts[k] <= 99999) || raw.facts.onBoard > raw.facts.referenced) return null
  return { facts: Object.fromEntries(keys.map(k => [k, raw.facts[k]])) }
}
export function prepareBriefingPlacement({ mode = 'off', binding = '', dto } = {}) {
  const manual = { status: 'manual', packet: null }
  if (!binding || !['advisory', 'on'].includes(mode)) return manual
  const clean_ = normalizePlacementDto(dto)
  if (!clean_ || clean_.facts.onBoard < 2) return manual // the board option must exist at runtime: at least two referenced items on the canvas
  const f = clean_.facts
  const packet = { input: [{ role: 'user', content: [{ type: 'input_text', text: 'Where should this final report of an agent be shown to the user?' }, { type: 'input_json', data: { facts: f } }] }],
    questions: [choiceQuestion('placement', 'A final report belongs inside a chat message unless it is long or structured, or it points at several existing board items that a reader should see in order. Judge only from the counts. Choose bubble when unsure.',
      [{ value: 'bubble', description: 'show the report inside the chat message' }, { value: 'board', description: `show it as ordered steps on the board that point at ${f.onBoard} board items it refers to` }])] }
  return { status: 'prepared', kind: 'briefing-placement', mode, binding, dto: clean_, options: ['bubble', 'board'], packet }
}
export function readBriefingPlacement(prepared, answers, currentBinding) {
  const base = { status: 'manual', verdict: 'manual', p: null }
  if (prepared?.status !== 'prepared' || prepared.kind !== 'briefing-placement' || currentBinding !== prepared.binding) return base
  const r = readChoice(answers, 'placement', { minConfidence: BRIEFING_BARS.placement, minMargin: BRIEFING_BARS.margin })
  if (r.state === 'unknown' || (r.value !== 'bubble' && r.value !== 'board')) return base
  const status = r.state === 'accepted' ? r.value : 'inconclusive'
  return { status, verdict: status, p: r.confidence, reply: { status, p: r.confidence } }
}
export function placementCalibrationEntry(prepared, answers, result) {
  const a = answers?.placement, rows = Array.isArray(a?.probabilities) ? a.probabilities : []
  return { feature: 'board_arrangement', mode: prepared.mode, candidates: 2, attached: prepared.mode === 'on' && result.status === 'board',
    judgments: [{ q: 'choice', would: result.status === 'board' ? 'act' : result.status === 'bubble' ? 'none' : 'hold', top: rows[0]?.probability, second: rows[1]?.probability, p: a?.confidence,
      threshold: BRIEFING_BARS.placement, minMargin: BRIEFING_BARS.margin, kind: 'board' }] }
}

// ---------------- 3. hand-off to the subjective model, and its design resolved against the runtime ----------------
export function buildDesignRequest({ enumeration }) {
  return { kind: 'briefing_design', facts: enumeration.facts,
    targets: enumeration.targets.filter(t => t.onBoard).map(t => ({ alias: t.alias, kind: t.kind, label: t.label, ...(t.gist ? { gist: t.gist } : {}), referenced: t.referenced })),
    limits: { maxSteps: BRIEFING_LIMITS.maxSteps, maxTargetsPerStep: BRIEFING_MAX_TARGETS, textMax: BRIEFING_LIMITS.textMax },
    reply: 'Return { title, steps: [{ text, targets: [alias], emphasis?: "spotlight"|"outline", fallback }] }: ordered steps, each pointing at 1-6 listed board targets, with a short explanation a first-time reader can follow.' }
}
export function buildRedesignRequest({ status, result, previous, revision, remaining, invalid = null }) {
  if (invalid) return { kind: 'briefing_redesign', revision, remaining, invalid, previous }
  if (status === 'inconclusive') return { kind: 'briefing_redesign_inconclusive', revision, remaining, previous, note: 'The system judge could not decide whether this briefing flow is sound. Make the explanations and their targets more specific.' }
  return { kind: 'briefing_redesign', revision, remaining, understandable: result.understandable, findings: result.findings.map(f => ({ item: f.item, ...(f.scope ? { scope: f.scope } : {}), aliases: [...f.aliases], p: f.p })), where: result.where ? { ...result.where } : null, previous }
}
/** resolveDesign(design, enumeration) -> { ok:true, steps, publishArgs } | { ok:false, reason }. publishArgs fits egdesk_publish_briefing_multi. */
export function resolveDesign(design, enumeration) {
  const fail = reason => ({ ok: false, reason })
  const title = typeof design?.title === 'string' ? clean(design.title, BRIEFING_LIMITS.titleMax) : ''
  const list = design?.steps
  if (!title) return fail('no-title')
  if (!Array.isArray(list) || !list.length) return fail('no-steps')
  if (list.length > BRIEFING_LIMITS.maxSteps) return fail('too-many-steps')
  const byAlias = new Map(enumeration.targets.map(t => [t.alias, t])), steps = []
  for (const [i, s] of list.entries()) {
    const text = typeof s?.text === 'string' ? s.text.trim() : ''
    if (!text) return fail('empty-text')
    if (text.length > BRIEFING_LIMITS.textMax) return fail('text-too-long')
    if (typeof s.fallback !== 'string' || !s.fallback.trim()) return fail('no-fallback')
    if (s.emphasis !== undefined && !BRIEFING_EMPHASIS.includes(s.emphasis)) return fail('bad-emphasis')
    if (!Array.isArray(s.targets) || !s.targets.length) return fail('no-targets')
    if (s.targets.length > BRIEFING_MAX_TARGETS) return fail('too-many-targets')
    if (new Set(s.targets).size !== s.targets.length) return fail('duplicate-target')
    for (const a of s.targets) { const t = byAlias.get(a); if (!t) return fail('unknown-target'); if (!t.onBoard) return fail('off-board-target') }
    steps.push({ alias: 'S' + (i + 1), id: 's' + (i + 1), text, fallback: clean(s.fallback, 400), ...(s.emphasis ? { emphasis: s.emphasis } : {}), targets: [...s.targets] })
  }
  const publishArgs = { title, steps: steps.map(s => ({ id: s.id, text: s.text, fallback: s.fallback, ...(s.emphasis ? { emphasis: s.emphasis } : {}), targets: s.targets.map(a => ({ ...byAlias.get(a).ref })) })) }
  if (!validBriefing({ id: 'proposal', title, steps: publishArgs.steps })) return fail('invalid-briefing')
  return { ok: true, steps, publishArgs }
}

// ---------------- 4. the flow check: items enumerated per step from the design and the board ----------------
/** enumerateBriefingChecks(steps, enumeration, { links, viewport }) -> { items, locations }. items: [{ key, name, scope, aliases, measure:{ count } }] */
export function enumerateBriefingChecks(steps, enumeration, { links = [], viewport = null } = {}) {
  const byAlias = new Map(enumeration.targets.map(t => [t.alias, t])), items = []
  const add = (name, scope, aliases) => { const unique = [...new Set(aliases)]; if (unique.length) items.push({ key: scope ? `${name}_${scope}` : name, name, scope, aliases: unique, measure: { count: unique.length } }) }
  for (const s of steps) {
    add('step_unclear', s.alias, [s.alias])
    if (s.targets.some(a => byAlias.get(a)?.gist)) add('explanation_mismatch', s.alias, [s.alias, ...s.targets])
  }
  const covered = new Set(steps.flatMap(s => s.targets))
  add('uncovered_target', null, enumeration.targets.filter(t => t.referenced && t.onBoard && !covered.has(t.alias)).map(t => t.alias))
  const firstStep = new Map(); steps.forEach((s, i) => s.targets.forEach(a => { if (!firstStep.has(a)) firstStep.set(a, i) }))
  const order = []
  for (const e of links) {
    const p = enumeration.aliasOf.get(e?.parent), c = enumeration.aliasOf.get(e?.child)
    if (e?.kind === 'waits' && p && c && firstStep.has(p) && firstStep.has(c) && firstStep.get(c) < firstStep.get(p)) order.push(steps[firstStep.get(c)].alias, steps[firstStep.get(p)].alias)
  }
  add('step_order', null, order)
  for (const s of steps) {
    const rects = s.targets.map(a => byAlias.get(a)?.rect).filter(Boolean)
    if (rects.length < 2) continue
    if (viewport?.width > 0 && viewport?.height > 0) {
      const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y)), w = Math.max(...rects.map(right)) - x, h = Math.max(...rects.map(bottom)) - y
      if (Math.min(viewport.width / w, viewport.height / h) < BRIEFING_LIMITS.readZoom) add('targets_far', s.alias, [s.alias, ...s.targets])
    }
    const over = []
    for (let i = 0; i < s.targets.length; i++) for (let j = i + 1; j < s.targets.length; j++) {
      const a = byAlias.get(s.targets[i])?.rect, b = byAlias.get(s.targets[j])?.rect
      if (a && b && overlapArea(a, b) > Math.min(area(a), area(b)) * BRIEFING_LIMITS.overlapShare) over.push(s.targets[i], s.targets[j])
    }
    if (over.length) add('targets_overlap', s.alias, [s.alias, ...over])
  }
  return { items, locations: [...new Set(items.flatMap(i => i.aliases))] }
}
/** The closed object that may leave the machine for the flow check: the step explanations, target kind/label/gist (all of cards the user may send), items. No id, path, coordinate. */
export function briefingCheckDto(steps, enumeration, checks, { title } = {}) {
  const used = new Set([...steps.flatMap(s => s.targets), ...checks.items.flatMap(i => i.aliases).filter(a => a.startsWith('T'))])
  const purpose = clean(title, BRIEFING_LIMITS.titleMax)
  if (!purpose || !checks.items.length) return null
  return { purpose,
    steps: steps.map(s => ({ alias: s.alias, text: clean(s.text, BRIEFING_LIMITS.textMax), targets: [...s.targets], ...(s.emphasis ? { emphasis: s.emphasis } : {}) })),
    targets: enumeration.targets.filter(t => used.has(t.alias)).map(t => ({ alias: t.alias, kind: t.kind, label: t.label, ...(t.gist ? { gist: t.gist } : {}) })),
    items: checks.items.map(i => ({ name: i.name, ...(i.scope ? { scope: i.scope } : {}), aliases: [...i.aliases], measure: { count: i.measure.count } })) }
}
const STEP_ALIAS = /^S[1-8]$/, TARGET_ALIAS = /^T(?:[1-9]|1[0-2])$/
export function normalizeBriefingCheckDto(raw) {
  try {
    if (!exactKeys(raw, ['purpose', 'steps', 'targets', 'items']) || !plain(raw.purpose, BRIEFING_LIMITS.titleMax)) return null
    if (!Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > BRIEFING_LIMITS.maxSteps || !Array.isArray(raw.targets) || !raw.targets.length || raw.targets.length > BRIEFING_LIMITS.maxCandidates ||
        !Array.isArray(raw.items) || !raw.items.length || raw.items.length > 64) return null
    const declared = new Set()
    const targets = raw.targets.map(t => {
      if (!exactKeys(t, Object.hasOwn(t ?? {}, 'gist') ? ['alias', 'kind', 'label', 'gist'] : ['alias', 'kind', 'label']) || !TARGET_ALIAS.test(t.alias) || !KINDS.has(t.kind) || declared.has(t.alias) ||
          !plain(t.label, BRIEFING_LIMITS.labelMax) || (Object.hasOwn(t, 'gist') && !plain(t.gist, BRIEFING_LIMITS.gistMax))) throw 0
      declared.add(t.alias); return { alias: t.alias, kind: t.kind, label: t.label, ...(Object.hasOwn(t, 'gist') ? { gist: t.gist } : {}) }
    })
    const stepAliases = new Set()
    const steps = raw.steps.map(s => {
      if (!exactKeys(s, Object.hasOwn(s ?? {}, 'emphasis') ? ['alias', 'text', 'targets', 'emphasis'] : ['alias', 'text', 'targets']) || !STEP_ALIAS.test(s.alias) || stepAliases.has(s.alias) || !plain(s.text, BRIEFING_LIMITS.textMax) ||
          !Array.isArray(s.targets) || !s.targets.length || s.targets.length > BRIEFING_MAX_TARGETS || new Set(s.targets).size !== s.targets.length || !s.targets.every(a => declared.has(a)) ||
          (Object.hasOwn(s, 'emphasis') && !BRIEFING_EMPHASIS.includes(s.emphasis))) throw 0
      stepAliases.add(s.alias); return { alias: s.alias, text: s.text, targets: [...s.targets], ...(Object.hasOwn(s, 'emphasis') ? { emphasis: s.emphasis } : {}) }
    })
    const all = new Set([...declared, ...stepAliases]), keys = new Set()
    const items = raw.items.map(i => {
      if (!exactKeys(i, Object.hasOwn(i ?? {}, 'scope') ? ['name', 'scope', 'aliases', 'measure'] : ['name', 'aliases', 'measure']) || !BRIEFING_ITEM_NAMES.includes(i.name) || (Object.hasOwn(i, 'scope') && !stepAliases.has(i.scope)) ||
          !Array.isArray(i.aliases) || !i.aliases.length || new Set(i.aliases).size !== i.aliases.length || !i.aliases.every(a => all.has(a)) || !exactKeys(i.measure, ['count']) || !Number.isInteger(i.measure.count) || i.measure.count < 1 || i.measure.count > 99) throw 0
      const key = i.scope ? `${i.name}_${i.scope}` : i.name
      if (keys.has(key)) throw 0
      keys.add(key); return { name: i.name, ...(i.scope ? { scope: i.scope } : {}), aliases: [...i.aliases], measure: { count: i.measure.count } }
    })
    return { purpose: raw.purpose, steps, targets, items }
  } catch { return null }
}
const keyOf = i => i.scope ? `${i.name}_${i.scope}` : i.name
const WHERE_NONE = 'none'
export function prepareBriefingCheck({ mode = 'off', binding = '', dto } = {}) {
  const manual = { status: 'manual', packet: null }
  if (!binding || !['advisory', 'on'].includes(mode)) return manual
  const c = normalizeBriefingCheckDto(dto)
  if (!c) return manual
  const locations = [...new Set(c.items.flatMap(i => i.aliases))]
  const describe = a => a.startsWith('S') ? `briefing step ${a.slice(1)}` : `board item (${c.targets.find(t => t.alias === a)?.kind ?? 'item'})`
  const frame = 'Judge only from the provided steps, targets and counts. Do not invent locations.'
  const questions = [
    predicateQuestion('understandable', `Given the briefing title, its ordered steps and the board items they point at, would a first-time reader understand the flow of this briefing? ${frame}`),
    ...c.items.map(i => predicateQuestion(`issue_${keyOf(i)}`, `${BRIEFING_ITEMS[i.name]} Locations: ${i.aliases.join(', ')}. ${frame}`)),
    choiceQuestion('where', `If the briefing needs improvement, which one location needs it most? Choose ${WHERE_NONE} if none stands out. ${frame}`,
      [...locations.map(a => ({ value: a, description: describe(a) })), { value: WHERE_NONE, description: 'no single location stands out' }]),
  ]
  const packet = { input: [{ role: 'user', content: [{ type: 'input_text', text: c.purpose }, { type: 'input_json', data: { steps: c.steps, targets: c.targets, items: c.items } }] }], questions }
  return { status: 'prepared', kind: 'briefing-check', mode, binding, dto: c, locations, options: c.items.map(keyOf), packet }
}
/** readBriefingCheck: findings need a flawed flow AND an item over the bar; ok = understood and no item over the bar; anything else inconclusive; unusable = manual. */
export function readBriefingCheck(prepared, answers, currentBinding) {
  const base = { status: 'manual', verdict: 'manual', understandable: null, findings: [], where: null }
  if (prepared?.status !== 'prepared' || prepared.kind !== 'briefing-check' || currentBinding !== prepared.binding) return base
  const flow = readPredicate(answers, 'understandable', BRIEFING_BARS.understandable)
  const rows = prepared.dto.items.map(i => ({ item: i, ...readPredicate(answers, `issue_${keyOf(i)}`, BRIEFING_BARS.issue) }))
  if (flow.probability === null || rows.some(r => r.probability === null)) return base
  const applies = rows.filter(r => r.state === 'yes').sort((a, b) => b.probability - a.probability)
  const understood = flow.probability >= BRIEFING_BARS.understandable, flawed = flow.probability <= BRIEFING_BARS.flawed
  const verdict = understood && !applies.length ? 'ok' : flawed && applies.length ? 'findings' : 'inconclusive'
  const out = { status: verdict, verdict, understandable: flow.probability, findings: [], where: null }
  if (verdict !== 'findings') return out
  out.findings = applies.map(r => ({ item: r.item.name, ...(r.item.scope ? { scope: r.item.scope } : {}), aliases: [...r.item.aliases], p: r.probability }))
  const where = readChoice(answers, 'where', { minConfidence: BRIEFING_BARS.placement, minMargin: BRIEFING_BARS.margin })
  if (where.state === 'accepted' && where.value !== WHERE_NONE && out.findings.some(f => f.aliases.includes(where.value))) out.where = { alias: where.value, p: where.confidence }
  return out
}
export function briefingCheckCalibrationEntry(prepared, answers, result) {
  const flow = answers?.understandable, where = answers?.where, rows = Array.isArray(where?.probabilities) ? where.probabilities : []
  return { feature: 'board_arrangement', mode: prepared.mode, candidates: prepared.dto.items.length, attached: prepared.mode === 'on' && result.status === 'findings',
    judgments: [{ q: 'goal_met', would: result.verdict === 'findings' ? 'act' : result.verdict === 'ok' ? 'none' : 'hold', p: flow?.probability, threshold: BRIEFING_BARS.understandable, kind: 'board' },
      ...prepared.dto.items.map(i => { const p = answers?.[`issue_${keyOf(i)}`]?.probability; return { q: 'relevance', would: p >= BRIEFING_BARS.issue ? 'accept' : 'reject', p, threshold: BRIEFING_BARS.issue, kind: 'board' } }),
      { q: 'choice', would: result.where ? 'accept' : 'reject', top: rows[0]?.probability, second: rows[1]?.probability, p: where?.confidence, threshold: BRIEFING_BARS.placement, minMargin: BRIEFING_BARS.margin, kind: 'board' }] }
}

// ---------------- 5. the bounded flow ----------------
/**
 * runBriefingFlow({ report, candidates, links, viewport, decide, engine, allow, limits }) -> one of
 *   { status:'bubble', reason }                       the report stays in the chat message (no design request was made)
 *   { status:'advisory-only', verdict }               recorded only; behaves as a chat message
 *   { status:'presented', publishArgs, revisions }    a briefing that passed the flow check; the host publishes it as a proposal through the existing tool
 *   { status:'fallback-chat', reason, revisions }     the chat answer plus a note: the briefing did not pass within the bound
 * decide: { placement, check } each { prepare(dto), run(ticket), cancel(ticket) } (bridge routes); engine(request) -> design | null (the subjective model);
 * allow(kind, preview) -> true when sending that exact packet is permitted (standing mode-on consent or the user's review). Bound: maxRevisions redesigns.
 */
export async function runBriefingFlow({ report, candidates, links = [], viewport = null, decide, engine, allow = async () => true, limits = {} }) {
  const maxRevisions = Number.isInteger(limits.maxRevisions) ? Math.max(0, Math.min(limits.maxRevisions, 3)) : BRIEFING_LIMITS.maxRevisions
  const stats = { judgeRequests: 0, designRounds: 0 }
  const enumeration = enumerateBriefingFacts({ report, candidates })
  if (!enumeration.boardFeasible) return { status: 'bubble', reason: 'no-board-targets', requested: false, stats }
  const ask = async (route, kind, dto) => {
    const prepared = await route.prepare(dto)
    if (prepared?.status !== 'prepared') return { unavailable: prepared?.reason ?? 'unavailable' }
    if (!(await allow(kind, prepared.preview))) { await route.cancel(prepared.ticket); return { unavailable: 'declined' } }
    stats.judgeRequests++
    return { reply: await route.run(prepared.ticket) }
  }
  const placed = await ask(decide.placement, 'placement', { facts: enumeration.facts })
  if (placed.unavailable) return { status: 'bubble', reason: placed.unavailable === 'declined' ? 'declined' : 'judge-unavailable', detail: placed.unavailable, requested: false, stats }
  if (placed.reply?.status === 'advisory-only') return { status: 'advisory-only', verdict: placed.reply.verdict, requested: true, stats }
  if (placed.reply?.status !== 'board') return { status: 'bubble', reason: placed.reply?.status === 'bubble' ? 'judged-bubble' : 'placement-undecided', requested: true, stats }
  let request = buildDesignRequest({ enumeration }), previous = null, revision = 0, last = null
  for (;;) {
    stats.designRounds++
    const resolved = resolveDesign(await engine(request), enumeration)
    if (!resolved.ok) {
      if (revision >= maxRevisions) return { status: 'fallback-chat', reason: 'design-invalid', detail: resolved.reason, revisions: revision, stats }
      revision++; request = buildRedesignRequest({ invalid: resolved.reason, previous, revision, remaining: maxRevisions - revision }); continue
    }
    previous = resolved.steps.map(s => ({ alias: s.alias, text: s.text, targets: s.targets }))
    const checks = enumerateBriefingChecks(resolved.steps, enumeration, { links, viewport })
    const dto = briefingCheckDto(resolved.steps, enumeration, checks, { title: resolved.publishArgs.title })
    const judged = dto ? await ask(decide.check, 'briefing-check', dto) : { unavailable: 'nothing-to-check' }
    if (judged.unavailable) return { status: 'fallback-chat', reason: 'judge-unavailable', detail: judged.unavailable, revisions: revision, stats }
    last = judged.reply
    if (last?.status === 'ok') return { status: 'presented', publishArgs: resolved.publishArgs, revisions: revision, checks: checks.items.map(i => i.key), stats }
    if (last?.status !== 'findings' && last?.status !== 'inconclusive') return { status: 'fallback-chat', reason: 'judge-unavailable', detail: last?.reason ?? last?.status ?? 'manual', revisions: revision, stats }
    if (revision >= maxRevisions) return { status: 'fallback-chat', reason: last.status === 'findings' ? 'check-not-passed' : 'check-inconclusive', revisions: revision, stats }
    revision++; request = buildRedesignRequest({ status: last.status, result: last, previous, revision, remaining: maxRevisions - revision })
  }
}
