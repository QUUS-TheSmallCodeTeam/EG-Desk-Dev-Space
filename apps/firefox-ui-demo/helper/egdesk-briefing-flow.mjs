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

// What the runtime knows about an already rendered component: who made it, for which answer, whether a newer output replaced it, whether it is stale, how it shows now.
// Unknown provenance is treated as the user's own: only a component this Agent made for an EARLIER answer, now superseded or stale and still shown, can be retrieved.
// A component can be a briefing target only if the publish path can bind it: a bound source, a run artifact, or a published result card (bound by the host).
const targetableRef = ref => !!ref && typeof ref === 'object' && (typeof ref.sourceId === 'string' || typeof ref.artifactId === 'string' || typeof ref.outputId === 'string')
const OWNERS = new Set(['agent', 'user', 'shared']), VISIBILITY = new Set(['visible', 'collapsed', 'offscreen'])
function componentFacts(c, currentAnswerId) {
  const owner = OWNERS.has(c.owner) ? c.owner : 'user', visibility = VISIBILITY.has(c.visibility) ? c.visibility : 'visible'
  const earlier = owner === 'agent' && typeof c.createdForAnswer === 'string' && !!c.createdForAnswer && !!currentAnswerId && c.createdForAnswer !== currentAnswerId
  const origin = owner === 'agent' ? (earlier ? 'agent-earlier' : 'agent-current') : owner
  const superseded = c.superseded === true, stale = c.stale === true
  return { owner, origin, superseded, stale, visibility, retrievable: c.onBoard === true && origin === 'agent-earlier' && (superseded || stale) && visibility !== 'collapsed' }
}

// ---------------- 1. facts from the real board: what the report points at, and whether it exists there ----------------
/**
 * enumerateBriefingFacts({ report, candidates }) -> { facts, targets, boardFeasible, idOf, aliasOf }
 * candidates: [{ id, ref:{ sourceId | artifactId }, kind:'source'|'artifact'|'output', label, gist?, onBoard, maySend, rect? }] from the host (bound context
 * plus the open canvas views). Only candidates the user may send count at all. A target is "referenced" when the report text names its label.
 */
export function enumerateBriefingFacts({ report = '', candidates = [], currentAnswerId = null } = {}) {
  const text = String(report ?? ''), lines = text.split('\n')
  const usable = (Array.isArray(candidates) ? candidates : []).filter(c => c && typeof c.id === 'string' && KINDS.has(c.kind) && c.maySend === true && typeof c.label === 'string' && c.label.trim().length >= 3 && c.ref && typeof c.ref === 'object').slice(0, BRIEFING_LIMITS.maxCandidates)
  const lower = text.toLowerCase()
  const targets = usable.map((c, i) => ({ alias: 'T' + (i + 1), id: c.id, ref: c.ref, kind: c.kind, label: clean(c.label, BRIEFING_LIMITS.labelMax), ...(c.gist ? { gist: clean(c.gist, BRIEFING_LIMITS.gistMax) } : {}),
    onBoard: c.onBoard === true, targetable: targetableRef(c.ref), referenced: lower.includes(c.label.trim().toLowerCase()), ...(finiteRect(c.rect) ? { rect: { x: c.rect.x, y: c.rect.y, width: c.rect.width, height: c.rect.height } } : {}),
    ...componentFacts(c, currentAnswerId) }))
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
export function buildDesignRequest({ enumeration, constraint = null, parts = [] }) {
  const offered = constraint ? enumeration.targets.filter(t => constraint.reuse.has(t.alias)) : enumeration.targets.filter(t => t.onBoard)
  return { kind: 'briefing_design', facts: enumeration.facts, ...(constraint ? constraintView(constraint, parts) : {}),
    targets: offered.map(t => ({ alias: t.alias, kind: t.kind, label: t.label, ...(t.gist ? { gist: t.gist } : {}), referenced: t.referenced })),
    limits: { maxSteps: BRIEFING_LIMITS.maxSteps, maxTargetsPerStep: BRIEFING_MAX_TARGETS, textMax: BRIEFING_LIMITS.textMax },
    reply: 'Return { title, steps: [{ text, targets: [alias], emphasis?: "spotlight"|"outline", fallback }] }: ordered steps, each pointing at 1-6 listed board targets, with a short explanation a first-time reader can follow.' +
      (constraint ? ' Reuse first: use every listed target; never target anything else. A new component is allowed only for a listed newAllowed part: put "new:<part>" in the step targets and describe it in newComponents: [{ part, title, summary }].' : '') }
}
export function buildRedesignRequest({ status, result, previous, revision, remaining, invalid = null, extra = {} }) {
  if (invalid) return { kind: 'briefing_redesign', revision, remaining, invalid, previous, ...extra }
  if (status === 'inconclusive') return { kind: 'briefing_redesign_inconclusive', revision, remaining, previous, ...extra, note: 'The system judge could not decide whether this briefing flow is sound. Make the explanations and their targets more specific.' }
  return { kind: 'briefing_redesign', revision, remaining, understandable: result.understandable, findings: result.findings.map(f => ({ item: f.item, ...(f.scope ? { scope: f.scope } : {}), aliases: [...f.aliases], p: f.p })), where: result.where ? { ...result.where } : null, previous, ...extra }
}
/** resolveDesign(design, enumeration) -> { ok:true, steps, publishArgs } | { ok:false, reason }. publishArgs fits egdesk_publish_briefing_multi. */
export function resolveDesign(design, enumeration, { constraint = null } = {}) {
  const fail = reason => ({ ok: false, reason })
  const title = typeof design?.title === 'string' ? clean(design.title, BRIEFING_LIMITS.titleMax) : ''
  const list = design?.steps
  if (!title) return fail('no-title')
  if (!Array.isArray(list) || !list.length) return fail('no-steps')
  if (list.length > BRIEFING_LIMITS.maxSteps) return fail('too-many-steps')
  const byAlias = new Map(enumeration.targets.map(t => [t.alias, t])), steps = [], newTokens = new Map()
  for (const [i, s] of list.entries()) {
    const text = typeof s?.text === 'string' ? s.text.trim() : ''
    if (!text) return fail('empty-text')
    if (text.length > BRIEFING_LIMITS.textMax) return fail('text-too-long')
    if (typeof s.fallback !== 'string' || !s.fallback.trim()) return fail('no-fallback')
    if (s.emphasis !== undefined && !BRIEFING_EMPHASIS.includes(s.emphasis)) return fail('bad-emphasis')
    if (!Array.isArray(s.targets) || !s.targets.length) return fail('no-targets')
    if (s.targets.length > BRIEFING_MAX_TARGETS) return fail('too-many-targets')
    if (new Set(s.targets).size !== s.targets.length) return fail('duplicate-target')
    const resolvedTargets = []
    for (const a of s.targets) {
      if (constraint && typeof a === 'string' && a.startsWith('new:')) {
        const part = a.slice(4)
        if (!constraint.newAllowed.has(part)) return fail('new-not-allowed')
        if (newTokens.has(part)) return fail('new-duplicate')
        newTokens.set(part, { alias: 'N' + (newTokens.size + 1), stepId: 's' + (i + 1) }); resolvedTargets.push(newTokens.get(part).alias); continue
      }
      const t = byAlias.get(a); if (!t) return fail('unknown-target'); if (!t.onBoard) return fail('off-board-target')
      if (constraint && !constraint.reuse.has(a)) return fail('not-reusable-target')
      resolvedTargets.push(a)
    }
    steps.push({ alias: 'S' + (i + 1), id: 's' + (i + 1), text, fallback: clean(s.fallback, 400), ...(s.emphasis ? { emphasis: s.emphasis } : {}), targets: resolvedTargets })
  }
  const newComponents = [], newTargets = []
  if (constraint) {
    const used = new Set(steps.flatMap(s => s.targets))
    for (const a of constraint.reuse) if (!used.has(a)) return fail('reuse-unused')
    const specs = Array.isArray(design?.newComponents) ? design.newComponents : []
    if (specs.some(n => !newTokens.has(n?.part))) return fail(specs.some(n => !constraint.newAllowed.has(n?.part)) ? 'new-not-allowed' : 'new-unreferenced')
    for (const [part, token] of newTokens) {
      const spec = specs.find(n => n.part === part), titleText = clean(spec?.title, BRIEFING_LIMITS.labelMax), summary = clean(spec?.summary, BRIEFING_LIMITS.gistMax)
      if (!titleText || !summary) return fail('new-missing-spec')
      newComponents.push({ alias: token.alias, part, title: titleText, summary, stepId: token.stepId })
      newTargets.push({ alias: token.alias, id: null, ref: null, kind: 'output', label: titleText, gist: summary, onBoard: false, referenced: false, planned: true })
    }
  }
  // Steps that point only at a component that does not exist yet wait for it: the host creates the component first, then completeBriefingArgs() finishes them.
  const refsOf = s => s.targets.filter(a => !a.startsWith('N')).map(a => ({ ...byAlias.get(a).ref }))
  const stepSpecs = steps.map(s => ({ id: s.id, text: s.text, fallback: s.fallback, ...(s.emphasis ? { emphasis: s.emphasis } : {}), refs: refsOf(s), news: s.targets.filter(a => a.startsWith('N')) }))
  const publishArgs = { title, steps: stepSpecs.filter(s => s.refs.length).map(s => ({ id: s.id, text: s.text, fallback: s.fallback, ...(s.emphasis ? { emphasis: s.emphasis } : {}), targets: s.refs })) }
  if (!publishArgs.steps.length) return fail('only-new')
  if (!validBriefing({ id: 'proposal', title, steps: publishArgs.steps })) return fail('invalid-briefing')
  return { ok: true, steps, publishArgs, stepSpecs, title, newComponents, newTargets, pendingSteps: stepSpecs.filter(s => !s.refs.length).map(s => s.id) }
}

// ---------------- 4. the flow check: items enumerated per step from the design and the board ----------------
/** enumerateBriefingChecks(steps, enumeration, { links, viewport }) -> { items, locations }. items: [{ key, name, scope, aliases, measure:{ count } }] */
export function enumerateBriefingChecks(steps, enumeration, { links = [], viewport = null, coverSet = null } = {}) {
  const byAlias = new Map(enumeration.targets.map(t => [t.alias, t])), items = []
  const add = (name, scope, aliases) => { const unique = [...new Set(aliases)]; if (unique.length) items.push({ key: scope ? `${name}_${scope}` : name, name, scope, aliases: unique, measure: { count: unique.length } }) }
  for (const s of steps) {
    add('step_unclear', s.alias, [s.alias])
    if (s.targets.some(a => byAlias.get(a)?.gist)) add('explanation_mismatch', s.alias, [s.alias, ...s.targets])
  }
  const covered = new Set(steps.flatMap(s => s.targets))
  add('uncovered_target', null, enumeration.targets.filter(t => (coverSet ? coverSet.has(t.alias) : t.referenced && t.onBoard) && !covered.has(t.alias)).map(t => t.alias))
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
const STEP_ALIAS = /^S[1-8]$/, TARGET_ALIAS = /^(?:T(?:[1-9]|1[0-2])|N[1-3])$/
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

// ---------------- 5. reuse, retrieval and "is a new component needed": the judge over the components already rendered ----------------
// Today's models keep generating new things. Before any design, the runtime lists what is ALREADY on the board (opaque aliases T#, with owner, the answer it was
// made for, superseded/stale, visibility) and the parts of the report (P#, with the components that already cover them), and the judge answers closed questions:
// per component reuse / retrieve / irrelevant, per part "is a new component required?". RETRIEVE exists as an option only for a component this Agent made for an EARLIER
// answer that is now superseded or stale and still shown; user-made and shared components never get it. A retrieval is a proposal to fold the card on the user's own
// screen (apply/undo/Cmd+Z); nothing is deleted and no shared Board data is written.
export const REUSE_BARS = Object.freeze({ component: .75, margin: .2, newRequired: .7 }) // placeholders until calibrated
export const MAX_REPORT_PARTS = 6
const ORIGINS = new Set(['agent-earlier', 'agent-current', 'user', 'shared'])
const PART_ALIAS = /^P[1-6]$/

/** enumerateReportParts(report, targets) -> [{ alias, label, chars, coveredBy:[T#] }]: heading sections (else paragraphs) of at least 20 characters, with the on-board components each names. */
export function enumerateReportParts(report, targets = []) {
  const lines = String(report ?? '').split('\n'), blocks = [], heading = l => /^\s{0,3}#{1,6}\s+\S/.test(l), headed = lines.some(heading)
  let cur = null
  const start = label => { cur = { label, lines: [] }; blocks.push(cur) }
  for (const l of lines) {
    if (headed) { if (heading(l)) { start(l.replace(/^\s{0,3}#{1,6}\s+/, '')); continue } if (!cur) { if (!l.trim()) continue; start(l) } cur.lines.push(l) }
    else { if (!l.trim()) { cur = null; continue } if (!cur) start(l); cur.lines.push(l) }
  }
  const comps = targets.filter(t => t.onBoard)
  return blocks.map(b => ({ label: clean(b.label.replace(/^[-*+\d.)\s]+/, ''), BRIEFING_LIMITS.labelMax), body: `${b.label}\n${b.lines.join('\n')}`.toLowerCase(), chars: Math.min(99999, `${b.label}\n${b.lines.join('\n')}`.length) }))
    .filter(b => b.chars >= 20 && b.label).slice(0, MAX_REPORT_PARTS)
    .map((b, i) => ({ alias: 'P' + (i + 1), label: b.label, chars: b.chars, coveredBy: comps.filter(t => b.body.includes(t.label.toLowerCase())).map(t => t.alias) }))
}
const retrievableOf = c => c.origin === 'agent-earlier' && (c.stale || c.superseded) && c.visibility !== 'collapsed'

/** reuseDto(enumeration, parts) -> the closed object for the reuse judge. Only components the user may send are in it (they are the only candidates). */
export function reuseDto(enumeration, parts) {
  return { components: enumeration.targets.filter(t => t.onBoard).map(t => ({ alias: t.alias, kind: t.kind, origin: t.origin, stale: t.stale, superseded: t.superseded, visibility: t.visibility, retrievable: t.retrievable, targetable: t.targetable,
      label: t.label, ...(t.gist ? { gist: t.gist } : {}) })),
    parts: parts.map(x => ({ alias: x.alias, label: x.label, chars: x.chars, coveredBy: [...x.coveredBy] })) }
}
export function normalizeReuseDto(raw) {
  try {
    if (!exactKeys(raw, ['components', 'parts']) || !Array.isArray(raw.components) || !raw.components.length || raw.components.length > BRIEFING_LIMITS.maxCandidates || !Array.isArray(raw.parts) || raw.parts.length > MAX_REPORT_PARTS) return null
    const declared = new Set()
    const components = raw.components.map(c => {
      const keys = Object.hasOwn(c ?? {}, 'gist') ? ['alias', 'kind', 'origin', 'stale', 'superseded', 'visibility', 'retrievable', 'targetable', 'label', 'gist'] : ['alias', 'kind', 'origin', 'stale', 'superseded', 'visibility', 'retrievable', 'targetable', 'label']
      if (!exactKeys(c, keys) || !TARGET_ALIAS.test(c.alias) || c.alias.startsWith('N') || declared.has(c.alias) || !KINDS.has(c.kind) || !ORIGINS.has(c.origin) || typeof c.stale !== 'boolean' || typeof c.superseded !== 'boolean' ||
          !VISIBILITY.has(c.visibility) || typeof c.retrievable !== 'boolean' || typeof c.targetable !== 'boolean' || !plain(c.label, BRIEFING_LIMITS.labelMax) || (Object.hasOwn(c, 'gist') && !plain(c.gist, BRIEFING_LIMITS.gistMax))) throw 0
      // The retrieve option is a closed rule of the system, not a claim of the chrome: it must follow from the facts.
      if (c.retrievable !== retrievableOf(c)) throw 0
      declared.add(c.alias); return { alias: c.alias, kind: c.kind, origin: c.origin, stale: c.stale, superseded: c.superseded, visibility: c.visibility, retrievable: c.retrievable, targetable: c.targetable, label: c.label, ...(Object.hasOwn(c, 'gist') ? { gist: c.gist } : {}) }
    })
    const seen = new Set()
    const parts = raw.parts.map(x => {
      if (!exactKeys(x, ['alias', 'label', 'chars', 'coveredBy']) || !PART_ALIAS.test(x.alias) || seen.has(x.alias) || !plain(x.label, BRIEFING_LIMITS.labelMax) || !Number.isInteger(x.chars) || x.chars < 0 || x.chars > 99999 ||
          !Array.isArray(x.coveredBy) || new Set(x.coveredBy).size !== x.coveredBy.length || !x.coveredBy.every(a => declared.has(a))) throw 0
      seen.add(x.alias); return { alias: x.alias, label: x.label, chars: x.chars, coveredBy: [...x.coveredBy] }
    })
    return { components, parts }
  } catch { return null }
}
const roleText = 'Judge only from the listed facts. Never choose retrieve unless it is offered.'
export function prepareBriefingReuse({ mode = 'off', binding = '', dto } = {}) {
  const manual = { status: 'manual', packet: null }
  if (!binding || !['advisory', 'on'].includes(mode)) return manual
  const c = normalizeReuseDto(dto)
  if (!c) return manual
  const questions = [
    ...c.components.filter(x => x.targetable || x.retrievable).map(x => choiceQuestion(`component_${x.alias}`, `What is the role of this existing board component (${x.alias}, a ${x.kind} made by ${x.origin}) for the final report? reuse = point a briefing step at it; irrelevant = the report does not need it${x.retrievable ? '; retrieve = it is an outdated output the agent made for an earlier answer, fold it away' : ''}. ${roleText}`,
      [...(x.targetable ? [{ value: 'reuse', description: 'use it as a briefing target' }] : []), { value: 'irrelevant', description: 'not needed for this report' }, ...(x.retrievable ? [{ value: 'retrieve', description: 'outdated output of an earlier answer: fold it away on the user screen' }] : [])])),
    ...c.parts.map(x => predicateQuestion(`new_${x.alias}`, `Is a NEW board component required to show part ${x.alias} of the report? Answer yes only if none of the existing components ${x.coveredBy.length ? `(covering it: ${x.coveredBy.join(', ')})` : '(none covers it by name)'} can show it. ${roleText}`)),
  ]
  const packet = { input: [{ role: 'user', content: [{ type: 'input_text', text: 'Existing board components and the parts of a final report. Reuse existing components before anything new is made.' }, { type: 'input_json', data: c }] }], questions }
  return { status: 'prepared', kind: 'briefing-reuse', mode, binding, dto: c, options: c.components.map(x => x.alias), packet }
}
/** readBriefingReuse: per component reuse | retrieve (only if offered) | irrelevant | undecided (unsure); per part newRequired. An unusable answer makes the whole reading manual. */
export function readBriefingReuse(prepared, answers, currentBinding) {
  const base = { status: 'manual', verdict: 'manual', components: [], parts: [] }
  if (prepared?.status !== 'prepared' || prepared.kind !== 'briefing-reuse' || currentBinding !== prepared.binding) return base
  const components = [], parts = []
  for (const x of prepared.dto.components) {
    // A component that can be neither a target nor retrieved has nothing to decide: it is simply not part of this briefing.
    if (!x.targetable && !x.retrievable) { components.push({ alias: x.alias, decision: 'irrelevant', p: null }); continue }
    const r = readChoice(answers, `component_${x.alias}`, { minConfidence: REUSE_BARS.component, minMargin: REUSE_BARS.margin })
    if (r.state === 'unknown' || !['reuse', 'irrelevant', 'retrieve'].includes(r.value)) return base
    const allowed = r.value !== 'retrieve' || x.retrievable
    components.push({ alias: x.alias, decision: r.state === 'accepted' && allowed ? r.value : 'undecided', p: r.confidence })
  }
  for (const x of prepared.dto.parts) {
    const r = readPredicate(answers, `new_${x.alias}`, REUSE_BARS.newRequired)
    if (r.probability === null) return base
    parts.push({ alias: x.alias, newRequired: r.state === 'yes', p: r.probability })
  }
  return { status: 'ok', verdict: 'ok', components, parts, reply: { status: 'ok', components, parts } }
}
export function briefingReuseCalibrationEntry(prepared, answers, result) {
  const dec = new Map(result.components.map(c => [c.alias, c.decision])), np = new Map(result.parts.map(x => [x.alias, x.newRequired]))
  const WOULD = { reuse: 'attach', retrieve: 'act', irrelevant: 'skip', undecided: 'hold' }
  return { feature: 'board_arrangement', mode: prepared.mode, candidates: prepared.dto.components.length, attached: prepared.mode === 'on' && result.status === 'ok' && result.components.some(c => c.decision === 'reuse'),
    judgments: [...prepared.dto.components.map(x => { const a = answers?.[`component_${x.alias}`], rows = Array.isArray(a?.probabilities) ? a.probabilities : []
        return { q: 'choice', would: WOULD[dec.get(x.alias)] ?? 'unknown', top: rows[0]?.probability, second: rows[1]?.probability, p: a?.confidence, threshold: REUSE_BARS.component, minMargin: REUSE_BARS.margin, kind: 'board' } }),
      ...prepared.dto.parts.map(x => ({ q: 'relevance', would: np.get(x.alias) ? 'accept' : 'reject', p: answers?.[`new_${x.alias}`]?.probability, threshold: REUSE_BARS.newRequired, kind: 'board' }))] }
}
/** What the design may use, from the judge's reading: reuse set, retire list (code re-checks eligibility), parts where a new component is allowed (never where a reused component already covers it). */
export function constraintFrom(reply, enumeration, parts) {
  const byAlias = new Map(enumeration.targets.map(t => [t.alias, t]))
  const reuse = new Set(reply.components.filter(c => c.decision === 'reuse' && byAlias.get(c.alias)?.onBoard && byAlias.get(c.alias)?.targetable).map(c => c.alias))
  const retire = reply.components.filter(c => c.decision === 'retrieve' && byAlias.get(c.alias)?.retrievable === true && !reuse.has(c.alias)).map(c => c.alias)
  const newAllowed = new Map(), newBlocked = []
  for (const x of reply.parts) {
    if (!x.newRequired) continue
    const part = parts.find(q => q.alias === x.alias)
    if (!part || part.coveredBy.some(a => reuse.has(a))) { newBlocked.push(x.alias); continue }
    newAllowed.set(x.alias, part.label)
  }
  return { reuse, retire, newAllowed, newBlocked }
}
const constraintView = (c, parts) => ({ reuse: [...c.reuse], retire: [...c.retire], newAllowed: [...c.newAllowed].map(([part, label]) => ({ part, label })), maxNew: c.newAllowed.size, parts: parts.map(x => ({ part: x.alias, label: x.label })) })
/** retrievalPlan(retrievals) -> the plan the presentation controller previews (offerRetrieval): fold these cards on the user's own screen. */
export const retrievalPlan = retrievals => ({ option: 'retrieval', collapse: retrievals.map(r => ({ id: r.id, value: true })) })
/** completeBriefingArgs(result, created) -> the publish arguments including the steps that waited for a new component; created: { N1: { artifactId | sourceId } } (the host created it). */
export function completeBriefingArgs(outcome, created = {}) {
  const result = outcome.plan ?? outcome // a flow outcome ('presented') or its plan
  const steps = result.stepSpecs.map(s => ({ id: s.id, text: s.text, fallback: s.fallback, ...(s.emphasis ? { emphasis: s.emphasis } : {}), targets: [...s.refs, ...s.news.map(a => created[a]).filter(Boolean)] }))
  if (steps.some(s => !s.targets.length)) return null
  const args = { title: result.title, steps }
  return validBriefing({ id: 'proposal', title: args.title, steps }) ? args : null
}

// ---------------- 6. the bounded flow ----------------
/**
 * runBriefingFlow({ report, candidates, currentAnswerId, links, viewport, decide, engine, allow, limits }) -> one of
 *   { status:'bubble', reason }                       the report stays in the chat message (no design request was made)
 *   { status:'advisory-only', verdict }               recorded only; behaves as a chat message
 *   { status:'presented', publishArgs, newComponents, retrievals, revisions }   a briefing that passed the flow check, built reuse-first; the host publishes it as a proposal
 *                                                     through the existing tool, creates the (0..n) allowed new components first, and offers the retrievals on the user's screen
 *   { status:'fallback-chat', reason, revisions }     the chat answer plus a note: the briefing did not pass within the bound
 * decide: { placement, reuse?, check } each { prepare(dto), run(ticket), cancel(ticket) } (bridge routes); engine(request) -> design | null (the subjective model);
 * allow(kind, preview) -> true when sending that exact packet is permitted (standing mode-on consent or the user's review). Bound: maxRevisions redesigns.
 * Without decide.reuse the flow behaves as before (every board target is a candidate); with it, the design is reuse-first.
 */
export async function runBriefingFlow({ report, candidates, currentAnswerId = null, links = [], viewport = null, decide, engine, allow = async () => true, limits = {}, observeOnly = false, egress = null }) {
  const maxRevisions = Number.isInteger(limits.maxRevisions) ? Math.max(0, Math.min(limits.maxRevisions, 3)) : BRIEFING_LIMITS.maxRevisions
  const stats = { judgeRequests: 0, designRounds: 0 }
  const enumeration = enumerateBriefingFacts({ report, candidates, currentAnswerId })
  if (!enumeration.boardFeasible) return { status: 'bubble', reason: 'no-board-targets', requested: false, stats }
  const ask = async (route, kind, dto) => {
    // Step texts and card labels leave only when the run's models may receive them (shared gate; no separate consent).
    if (egress && !egress.allows('canvas_text')) return { unavailable: 'declined' }
    const prepared = await route.prepare(dto)
    if (prepared?.status !== 'prepared') return { unavailable: prepared?.reason ?? 'unavailable' }
    if (!(await allow(kind, prepared.preview))) { await route.cancel(prepared.ticket); return { unavailable: 'declined' } }
    stats.judgeRequests++
    return { reply: await route.run(prepared.ticket) }
  }
  const placed = await ask(decide.placement, 'placement', { facts: enumeration.facts })
  if (placed.unavailable) return { status: 'bubble', reason: placed.unavailable === 'declined' ? 'declined' : 'judge-unavailable', detail: placed.unavailable, requested: false, stats }
  const stages = ['placement']
  // Advisory records what the judge would have said, and if it would have gone to the board, also what it would have said about reuse: record only, no design.
  if (placed.reply?.status === 'advisory-only') {
    if (placed.reply.verdict === 'board' && decide.reuse) {
      const parts0 = enumerateReportParts(report, enumeration.targets)
      const seen = await ask(decide.reuse, 'briefing-reuse', reuseDto(enumeration, parts0))
      if (!seen.unavailable) stages.push('reuse')
    }
    return { status: 'advisory-only', verdict: placed.reply.verdict, stages, requested: true, stats }
  }
  if (placed.reply?.status !== 'board') return { status: 'bubble', reason: placed.reply?.status === 'bubble' ? 'judged-bubble' : 'placement-undecided', requested: true, stats }
  if (observeOnly && !decide.reuse) return { status: 'observed', stages, requested: true, stats }
  let constraint = null, parts = []
  if (decide.reuse) {
    parts = enumerateReportParts(report, enumeration.targets)
    const judged = await ask(decide.reuse, 'briefing-reuse', reuseDto(enumeration, parts))
    if (judged.unavailable) return { status: 'fallback-chat', reason: 'judge-unavailable', detail: judged.unavailable, revisions: 0, stats }
    if (judged.reply?.status === 'advisory-only') return { status: 'advisory-only', verdict: judged.reply.verdict, requested: true, stats }
    if (judged.reply?.status !== 'ok') return { status: 'fallback-chat', reason: 'judge-unavailable', detail: judged.reply?.reason ?? judged.reply?.status ?? 'manual', revisions: 0, stats }
    stages.push('reuse')
    constraint = constraintFrom(judged.reply, enumeration, parts)
    if (observeOnly) return { status: 'observed', stages, requested: true, stats }
    if (!constraint.reuse.size && !constraint.newAllowed.size) return { status: 'fallback-chat', reason: 'nothing-to-reuse', revisions: 0, stats }
  }
  const extra = constraint ? constraintView(constraint, parts) : {}
  let request = buildDesignRequest({ enumeration, constraint, parts }), previous = null, revision = 0, last = null
  for (;;) {
    stats.designRounds++
    const resolved = resolveDesign(await engine(request), enumeration, { constraint })
    if (!resolved.ok) {
      if (revision >= maxRevisions) return { status: 'fallback-chat', reason: 'design-invalid', detail: resolved.reason, revisions: revision, stats }
      revision++; request = buildRedesignRequest({ invalid: resolved.reason, previous, revision, remaining: maxRevisions - revision, extra }); continue
    }
    previous = resolved.steps.map(s => ({ alias: s.alias, text: s.text, targets: s.targets }))
    const forCheck = resolved.newTargets.length ? { ...enumeration, targets: [...enumeration.targets, ...resolved.newTargets] } : enumeration
    const checks = enumerateBriefingChecks(resolved.steps, forCheck, { links, viewport, coverSet: constraint?.reuse ?? null })
    const dto = briefingCheckDto(resolved.steps, forCheck, checks, { title: resolved.publishArgs.title })
    const judged = dto ? await ask(decide.check, 'briefing-check', dto) : { unavailable: 'nothing-to-check' }
    if (judged.unavailable) return { status: 'fallback-chat', reason: 'judge-unavailable', detail: judged.unavailable, revisions: revision, stats }
    last = judged.reply
    if (last?.status === 'ok') {
      const retrievals = constraint ? constraint.retire.map(a => { const t = enumeration.targets.find(x => x.alias === a); return { alias: a, id: t.id, ref: t.ref } }) : []
      return { status: 'presented', publishArgs: resolved.publishArgs, plan: { title: resolved.title, stepSpecs: resolved.stepSpecs, pendingSteps: resolved.pendingSteps }, newComponents: resolved.newComponents, retrievals,
        reuse: constraint ? { reuse: [...constraint.reuse], retire: [...constraint.retire], newAllowed: [...constraint.newAllowed.keys()], newBlocked: constraint.newBlocked } : null,
        revisions: revision, checks: checks.items.map(i => i.key), stats }
    }
    if (last?.status !== 'findings' && last?.status !== 'inconclusive') return { status: 'fallback-chat', reason: 'judge-unavailable', detail: last?.reason ?? last?.status ?? 'manual', revisions: revision, stats }
    if (revision >= maxRevisions) return { status: 'fallback-chat', reason: last.status === 'findings' ? 'check-not-passed' : 'check-inconclusive', revisions: revision, stats }
    revision++; request = buildRedesignRequest({ status: last.status, result: last, previous, revision, remaining: maxRevisions - revision, extra })
  }
}
