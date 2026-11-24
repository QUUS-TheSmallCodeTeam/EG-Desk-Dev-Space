import { createHash } from 'node:crypto'
import { predicateQuestion, readPredicate } from './egdesk-decision-questions.mjs'
import { BRIEFING_LIMITS, enumerateBriefingFacts } from './egdesk-briefing-flow.mjs'
import { BRIEFING_CATALOG, STEP_SLOTS, resultCardCapacity, textLines } from './egdesk-briefing-catalog.mjs'
import { canvasViewSize, placeCanvasView } from '../overlay/resources/EGDeskSurfaceState.sys.mjs'

// Answer Briefing, skeleton first (cycle 13; the order the owner fixed), judged by yes/no predicates (cycle 15, after the first real measurement).
// The Decision model, a system-level judge, answers closed yes/no questions about text it can read: does this request need several materials shown together; would
// showing THESE quoted materials in THIS way help; which of two parts comes first when the record does not say; is this slot text supported by this quoted material.
// CODE combines the answers into the design guide (board or bubble, the component per part with reuse first, the order) and computes everything it can compute itself
// (layout with the product's real sizes, time order from the records, what is already on the board, fold proposals). Only then the subjective model is asked, and
// only to FILL THE SLOTS of that guide with data from the materials; a part whose data is not supported is written again once or left out, otherwise the chat answer stays.
// Every option exists as data first: parts are enumerated by code from the materials (links, dates, recorded status), ways of showing them from the catalog
// (egdesk-briefing-catalog.mjs) and from the cards already on the board (with provenance). Nothing here talks to a network, publishes, moves a camera or writes the
// Board: the host injects judge{} (bridge route) and fill().

export const SKELETON_LIMITS = Object.freeze({ answerMax: 1200, maxMaterials: 8, maxParts: 6, softSteps: 5, maxRequests: 6, maxQuestions: 60, judgeMs: 40_000, fillTurns: 3, requestMax: 400, titleMax: 80, excerptMax: 400, contentMax: 600, slotTextMax: 600, readZoom: BRIEFING_LIMITS.readZoom, overlapShare: BRIEFING_LIMITS.overlapShare })
// A predicate counts as yes at or above `yes` and as no at or below `no`; anything between is undecided. Placeholders until calibrated (real predicates of the other features answer near 0 or 1).
export const SKELETON_BARS = Object.freeze({ yes: .7, no: .3 })
export const SKELETON_STAGES = Object.freeze(['place', 'fit', 'order', 'fill_check'])
export const SKELETON_CHECKS = Object.freeze(['overflow', 'overlap', 'spread'])
// Lane L7's closed vocabularies (memoryMaterials rows): link types and recorded status.
const VERSION_LINKS = new Set(['supersedes', 'superseded_by']), LINK_TYPES = new Set(['same_task', 'follows_from', 'decided_in', 'supersedes', 'refers_to', 'superseded_by'])
const STATUS = new Set(['plan', 'done', 'superseded', 'reported_by_other', 'unknown'])
const clean = (v, max) => (typeof v === 'string' ? v.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim() : '')
const plain = (t, max) => typeof t === 'string' && t.length > 0 && t.length <= max && t === clean(t, max)
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const exactKeys = (v, keys, optional = []) => isObj(v) && keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k) || optional.includes(k))
const DATE = /^\d{4}-\d{2}-\d{2}$/
const norm = s => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
const right = r => r.x + r.width, bottom = r => r.y + r.height, area = r => r.width * r.height
const overlapArea = (a, b) => Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y))
const finiteRect = r => !!r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0

// ---------------- 1. materials: a simple array (lane L7's rows fit as they are) ----------------
// A material's identity across turns, for "which card was built from it". Lane L7's rows carry `key` (an opaque per-process HMAC of the page, a NON-ENUMERABLE
// property: it must be read from the original row, and it never reaches a model because nothing here copies it into a request). A row without it gets a fingerprint
// of its title, date and kind: exact, stable while those do not change, still inside this process only.
const fingerprint = m => 't:' + createHash('sha256').update(`${norm(m.title)}|${typeof m.time?.at === 'string' ? m.time.at : typeof m.at === 'string' ? m.at : ''}|${typeof m.kind === 'string' ? m.kind : ''}`).digest('hex').slice(0, 32)
/**
 * normalizeMaterials(rows) -> [{ alias:'M1'.., key, title, text, at, status, open, links:[{ type, to }] }] (at most 8).
 * A row: { title, excerpt | text, time?: { at } | at?, status?, links?: [{ type, toAlias | to }], alias? | id?, held?, key? }. Lane L7's
 * chat.memoryMaterialsFor(run) rows are exactly this. Rows attached on THIS turn (held !== true) are the materials; rows the model only holds from earlier turns
 * (nobody judged them relevant to this message) are used only when nothing was attached.
 * "Open" is by record only: status plan (a reported, unconfirmed done is still open). Unknown is not open.
 */
export function normalizeMaterials(rows) {
  const listed = (Array.isArray(rows) ? rows : []).filter(m => isObj(m) && clean(m.title, SKELETON_LIMITS.titleMax)), fresh = listed.filter(m => m.held !== true)
  const usable = (fresh.length ? fresh : listed).slice(0, SKELETON_LIMITS.maxMaterials)
  const idOf = m => (typeof m.alias === 'string' && m.alias ? m.alias : typeof m.id === 'string' ? m.id : null)
  const aliasOf = new Map(usable.map((m, i) => [idOf(m), 'M' + (i + 1)]).filter(([k]) => k !== null))
  return usable.map((m, i) => {
    const at = typeof m.time?.at === 'string' ? m.time.at : typeof m.at === 'string' ? m.at : null, status = STATUS.has(m.status) ? m.status : 'unknown'
    const links = (Array.isArray(m.links) ? m.links : []).map(l => ({ type: l?.type, to: aliasOf.get(l?.toAlias ?? l?.to) })).filter(l => LINK_TYPES.has(l.type) && l.to && l.to !== 'M' + (i + 1))
    return { alias: 'M' + (i + 1), key: typeof m.key === 'string' && /^[a-f0-9]{16,64}$/.test(m.key) ? m.key : fingerprint(m), title: clean(m.title, SKELETON_LIMITS.titleMax), text: clean(m.excerpt ?? m.text, SKELETON_LIMITS.excerptMax),
      at: at && DATE.test(at.slice(0, 10)) ? at.slice(0, 10) : null, status, open: status === 'plan', links }
  })
}
// "These two materials are versions of one thing" is known to code from the record: a supersedes / superseded_by link, or (when the record has no link) two titles
// that are the same except for a version mark (v1 / v2, 1차 / 2차, 버전 1 / 버전 2). The title rule adds the missing link to the newer one (marked derived: 'title').
// Nothing else is guessed: two materials with neither are not offered as a comparison, so the Decision model is never asked whether they are versions.
const VERSION_MARK = /(?:(?<![A-Za-z])v\s?(\d{1,3})(?![\dA-Za-z])|(?<!\d)(\d{1,3})\s?차(?![가-힣])|버전\s?(\d{1,3})(?!\d))/i
export function versionOf(title) {
  const m = VERSION_MARK.exec(String(title ?? ''))
  if (!m) return null
  const base = norm(String(title).replace(VERSION_MARK, ' '))
  return base ? { base, n: Number(m[1] ?? m[2] ?? m[3]) } : null
}
function withTitleVersions(mats) {
  // A title without a mark that equals a marked title's base ("A사 견적서" / "A사 견적서 v2") is the earlier one (version 0).
  const versioned = mats.map(m => ({ m, v: versionOf(m.title) ?? { base: norm(m.title), n: 0, unmarked: true } })).filter(x => x.v.base)
  for (const a of versioned) for (const b of versioned) {
    if (a === b || a.v.base !== b.v.base || a.v.n <= b.v.n || a.v.unmarked) continue
    const linked = a.m.links.some(l => l.to === b.m.alias && VERSION_LINKS.has(l.type)) || b.m.links.some(l => l.to === a.m.alias && VERSION_LINKS.has(l.type))
    if (!linked) a.m.links.push({ type: 'supersedes', to: b.m.alias, derived: 'title' })
  }
  return mats
}
// A pair the judge said is two versions of one thing: the later one (by its date; an undated plan is later; else the later alias) gets the version link.
function withJudgedVersions(mats, pairs) {
  for (const [a, b] of Array.isArray(pairs) ? pairs : []) {
    const x = mats.find(m => m.alias === a), y = mats.find(m => m.alias === b)
    if (!x || !y) continue
    const later = (x.at ?? '9999') > (y.at ?? '9999') || ((x.at ?? '9999') === (y.at ?? '9999') && x.alias > y.alias) ? [x, y] : [y, x]
    if (!later[0].links.some(l => l.to === later[1].alias && VERSION_LINKS.has(l.type))) later[0].links.push({ type: 'supersedes', to: later[1].alias, derived: 'judged' })
  }
  return mats
}

// ---------------- relevance and versions: asked in the place request, combined by code ----------------
// Relevance (cycle 17). The memory loop attached what the answering model needed as CONTEXT; that is broader than what belongs on the board for this request. So
// each material is asked on its own: "does it contain information the request asks about?" To save tokens, ONE question stands for a whole linked group: the record
// links those materials as one matter (same task, follows from, decided in, refers to, supersedes), so a request about one of them is about the matter. The group is
// asked through its first material (the memory loop's own order). Yes keeps the group; no or undecided drops it (the chat answer still has it). A material linked to
// nothing is asked about by itself.
export function relevanceQuestions(mats) {
  return materialGroups(mats).map(group => ({ kind: 'about', material: group[0].alias, covers: group.map(m => m.alias) }))
}
// Versions (cycle 17). Code resolves what the record says: a version link or a version mark in the titles (versions); any other recorded link between the two
// (they are related some other way: not versions); different companies in the titles (not versions). What is left is asked, for pairs whose titles share a word of
// two or more letters (a prefix counts: 견적 / 견적서), most shared words first, at most VERSION_PAIRS per briefing.
export const VERSION_PAIRS = 3
const COMPANY = /^[A-Za-z0-9가-힣]{1,6}사$/
const words = title => norm(String(title ?? '').replace(VERSION_MARK, ' ')).split(/[\s()\[\],.·:/-]+/).filter(w => w.length >= 2)
export function versionCandidates(mats) {
  const out = []
  for (let i = 0; i < mats.length; i++) for (let j = i + 1; j < mats.length; j++) {
    const a = mats[i], b = mats[j]
    if (a.links.some(l => l.to === b.alias) || b.links.some(l => l.to === a.alias)) continue
    if ((versionOf(a.title)?.base ?? norm(a.title)) === (versionOf(b.title)?.base ?? norm(b.title))) continue // the titles say it (code)
    const wa = words(a.title), wb = words(b.title), ca = wa.filter(w => COMPANY.test(w)), cb = wb.filter(w => COMPANY.test(w))
    if (ca.length && cb.length && !ca.some(c => cb.includes(c))) continue
    const shared = wa.filter(w => !COMPANY.test(w) && wb.some(v => !COMPANY.test(v) && (v === w || v.startsWith(w) || w.startsWith(v)))).length
    if (shared >= 1) out.push({ pair: [a.alias, b.alias], shared, at: i * 100 + j })
  }
  return out.sort((x, y) => y.shared - x.shared || x.at - y.at).slice(0, VERSION_PAIRS).map(x => x.pair)
}

/** Materials that the records link to each other (any recorded link, either direction) belong to one matter. Largest group first, then by first member. */
export function materialGroups(mats) {
  const parent = new Map(mats.map(m => [m.alias, m.alias])), find = a => { while (parent.get(a) !== a) a = parent.get(a); return a }
  for (const m of mats) for (const l of m.links) { const a = find(m.alias), b = find(l.to); if (a !== b) parent.set(b, a) }
  const groups = new Map()
  for (const m of mats) { const root = find(m.alias); if (!groups.has(root)) groups.set(root, []); groups.get(root).push(m) }
  return [...groups.values()].sort((a, b) => b.length - a.length || mats.indexOf(a[0]) - mats.indexOf(b[0]))
}

// ---------------- 2. what can be chosen at all: parts and their options, from data ----------------
/**
 * enumerateSkeleton({ materials, candidates, currentAnswerId, catalog, bindings }) -> { materials, targets, shows, built, parts, retrievable }
 * targets: the cards already on the board (opaque aliases T#, provenance facts, rect) from the flow's own enumeration.
 * "This card shows that material", in this order:
 *   1. provenance: bindings (outputId -> { keys, trait, component }) is what the bridge remembered when THIS flow built a card from materials; a card whose
 *      binding is exactly one material's key shows it, and a card built for the same set of materials and the same kind of part is that part's card (built).
 *   2. the same title, exactly. 3. one title inside the other, only when no other material and no other card would match the same way.
 * A card shows at most one material and a material is shown by at most one card. Folded, outdated or unbindable cards never count.
 * parts: per group of linked materials (materialGroups), [{ alias:'P#', trait, materials:[M#], options:[{ value, component? , reuse? }] }]. There is no "none" option: each option is asked about as its own yes/no.
 */
export function enumerateSkeleton({ materials = [], candidates = [], currentAnswerId = null, catalog = BRIEFING_CATALOG, bindings = null, keep = null, versionPairs = [] } = {}) {
  // keep: the aliases the relevance answers kept (others are dropped with their links; aliases stay as they were). versionPairs: pairs the judge said are versions.
  let mats = withJudgedVersions(withTitleVersions(normalizeMaterials(materials)), versionPairs)
  if (keep) { mats = mats.filter(m => keep.has(m.alias)); for (const m of mats) m.links = m.links.filter(l => keep.has(l.to)) }
  const targets = enumerateBriefingFacts({ report: '', candidates, currentAnswerId }).targets.filter(t => t.onBoard)
  const usable = targets.filter(t => t.targetable && t.visibility !== 'collapsed' && !t.retrievable && !t.superseded && !t.stale)
  const bindingOf = t => { const b = typeof t.ref?.outputId === 'string' ? bindings?.get?.(t.ref.outputId) : null; return b && Array.isArray(b.keys) && b.keys.length ? b : null }
  const shows = new Map(), taken = new Set(), how = new Map()
  const bind = (m, t, by) => { shows.set(m.alias, t.alias); taken.add(t.alias); how.set(m.alias, by) }
  for (const t of usable) { const b = bindingOf(t); if (b?.keys.length !== 1) continue; const m = mats.find(x => x.key === b.keys[0] && !shows.has(x.alias)); if (m) bind(m, t, 'provenance') }
  const free = () => usable.filter(t => !taken.has(t.alias) && !bindingOf(t) && norm(t.label).length >= 3)
  for (const m of mats) { if (shows.has(m.alias)) continue; const t = free().find(x => norm(x.label) === norm(m.title)); if (t) bind(m, t, 'title') }
  const inside = (m, t) => norm(m.title).includes(norm(t.label)) || norm(t.label).includes(norm(m.title))
  for (const m of mats) {
    if (shows.has(m.alias)) continue
    const cards = free().filter(t => inside(m, t))
    if (cards.length === 1 && mats.filter(x => !shows.has(x.alias) && inside(x, cards[0])).length === 1) bind(m, cards[0], 'title-part')
  }
  const byAlias = new Map(mats.map(m => [m.alias, m])), raw = []
  for (const group of materialGroups(mats)) {
    const covered = new Set(), seenPairs = new Set(), start = raw.length
    for (const m of group) for (const l of m.links) {
      if (!VERSION_LINKS.has(l.type)) continue
      const [older, newer] = l.type === 'supersedes' ? [l.to, m.alias] : [m.alias, l.to], pair = `${older}>${newer}`
      if (seenPairs.has(pair)) continue
      seenPairs.add(pair); raw.push({ trait: 'compare', materials: [older, newer] })
    }
    const dated = group.filter(m => m.at).sort((a, b) => a.at.localeCompare(b.at) || a.alias.localeCompare(b.alias))
    if (dated.length >= 2) raw.push({ trait: 'sequence', materials: dated.map(m => m.alias) })
    const open = group.filter(m => m.open)
    if (open.length) raw.push({ trait: 'open_items', materials: open.map(m => m.alias) })
    for (const part of raw.slice(start)) for (const a of part.materials) covered.add(a)
    for (const m of group) if (!covered.has(m.alias)) raw.push({ trait: 'single', materials: [m.alias] })
  }
  // A card this flow built earlier for the same materials and the same kind of part: reuse it, never build it again.
  const built = new Map()
  const parts = raw.slice(0, SKELETON_LIMITS.maxParts).map((part, i) => {
    const alias = 'P' + (i + 1), keys = part.materials.map(a => byAlias.get(a).key).sort().join()
    const same = usable.find(t => { const b = bindingOf(t); return b && b.trait === part.trait && [...b.keys].sort().join() === keys && (part.materials.length > 1 || shows.get(part.materials[0]) === t.alias) })
    if (same) built.set(alias, same.alias)
    const existing = part.materials.map(a => shows.get(a)).filter(Boolean), options = []
    for (const c of catalog.suiting(part.trait)) {
      if (part.materials.length < c.needs.materials.min || existing.length < c.needs.existing) continue
      // Reuse first, by construction: no new card for a part that already has its card, nor for a single material that already has one.
      if (c.renderer.creates && (same || (c.needs.materials.max === 1 && existing.length))) continue
      options.push({ value: c.id, component: c.id })
    }
    const reuse = same?.alias ?? (part.materials.length === 1 ? existing[0] : null)
    if (reuse) options.push({ value: `reuse_${reuse}`, reuse })
    const dates = part.materials.map(a => byAlias.get(a).at).filter(Boolean).sort()
    return { alias, trait: part.trait, materials: part.materials, anchor: { min: dates[0] ?? null, max: dates.at(-1) ?? null }, options }
  }).filter(part => part.options.length) // a part nothing in the catalog can show is not a part
  return { materials: mats, targets, shows, how, built, parts, retrievable: targets.filter(t => t.retrievable).map(t => t.alias).slice(0, 6), catalog }
}
// ---------------- 3. the judge: yes/no predicates only; every judged item is quoted in its own question; code combines the answers ----------------
// Real measurement (2026-11-24, 11 requests) of the earlier request shape: N-way choices with safe ways out ("bubble", "none_fits", "bubble_enough") went flat or to
// the safe side, a "which comes next" choice whose options carried no content was refused, and a negated check over a JSON blob said "mismatch" for every step, right
// or wrong. So (design rules R1-R4): the model reads the actual request and material text, each question is ONE yes/no about ONE quoted thing, and whatever code can
// compute (layout, time order, what is already on the board, which fold to propose) is not asked.
const MATERIAL_ALIAS = /^M[1-8]$/, TARGET_ALIAS = /^T(?:[1-9]|1[0-2])$/, PART_ALIAS = /^P[1-6]$/, REUSE_VALUE = /^reuse_(T(?:[1-9]|1[0-2]))$/
const TRAITS = ['compare', 'sequence', 'open_items', 'single']
// Fit (cycle 16, after the second real measurement): content sufficiency only, ONE condition per question. Whether a material belongs to the answer was decided upstream
// (the memory loop's relevance judgments and \`place\`); whether two materials are versions of one thing and whether a material is still open are in the record (code).
// What the judge reads is whether the quoted text holds what the way of showing needs:
//   compare     aspect_P#   do both versions state a value for one same aspect?
//   sequence    happened_M# does this material state something that happened or was decided?
//   open_items  todo_M#     does this material name a concrete step that still has to be taken?   (open = status plan: recorded, not asked)
//   single      fact_M#     does this material state a concrete fact?
// A part whose only way of showing is a card already on the board for it (provenance or title, computed) is reused without a question.
export const FIT_KINDS = Object.freeze({ compare: 'aspect', sequence: 'happened', open_items: 'todo', single: 'fact' })
const STAGE_KINDS = { place: ['several', 'one_sentence', 'about', 'same'], fit: ['aspect', 'happened', 'todo', 'fact'], order: ['before'], fill_check: ['slot', 'step'] }
const SHOW = { compare: 'how these two versions differ', sequence: 'what happened across these materials, in date order', open_items: 'what is still not done in these materials', single: 'this one material' }
export const questionName = q => (q.kind === 'several' || q.kind === 'one_sentence' ? q.kind : q.kind === 'about' ? `about_${q.material}` : q.kind === 'same' ? `same_${q.materials[0]}_${q.materials[1]}` : q.kind === 'aspect' ? `aspect_${q.part}` : ['happened', 'todo', 'fact'].includes(q.kind) ? `${q.kind}_${q.material}` : q.kind === 'before' ? `before_${q.first.part}_${q.second.part}`
  : q.kind === 'slot' ? `slot_${q.part}_r${q.row}${q.side ? `_${q.side}` : ''}` : `step_${q.part}`)

/** The closed object for one judgment, re-validated here (the bridge route is reachable from the chrome): unknown fields, aliases, components or stages refuse the whole request. */
export function normalizeSkeletonDto(raw, catalog = BRIEFING_CATALOG) {
  try {
    if (!exactKeys(raw, ['stage', 'request', 'materials', 'cards', 'questions'], ['answer']) || !SKELETON_STAGES.includes(raw.stage) || !plain(raw.request, SKELETON_LIMITS.requestMax)) return null
    // the answer being laid out, for the place request only (a request like "정리해줘" refers to it)
    if (raw.answer !== undefined && (raw.stage !== 'place' || !plain(raw.answer, SKELETON_LIMITS.answerMax))) return null
    if (!Array.isArray(raw.materials) || !raw.materials.length || raw.materials.length > SKELETON_LIMITS.maxMaterials || !Array.isArray(raw.cards) || raw.cards.length > BRIEFING_LIMITS.maxCandidates ||
        !Array.isArray(raw.questions) || !raw.questions.length || raw.questions.length > SKELETON_LIMITS.maxQuestions) return null
    const mats = new Set(), cards = new Set()
    const materials = raw.materials.map(m => {
      if (!exactKeys(m, ['alias', 'title', 'text', 'at', 'status']) || !MATERIAL_ALIAS.test(m.alias) || mats.has(m.alias) || !plain(m.title, SKELETON_LIMITS.titleMax) || (m.text !== '' && !plain(m.text, SKELETON_LIMITS.excerptMax)) ||
          !(m.at === null || DATE.test(m.at)) || !STATUS.has(m.status)) throw 0
      mats.add(m.alias); return { alias: m.alias, title: m.title, text: m.text, at: m.at, status: m.status }
    })
    const list = raw.cards.map(c => {
      if (!exactKeys(c, ['alias', 'label'], ['gist']) || !TARGET_ALIAS.test(c.alias) || cards.has(c.alias) || !plain(c.label, BRIEFING_LIMITS.labelMax) || (Object.hasOwn(c, 'gist') && !plain(c.gist, BRIEFING_LIMITS.gistMax))) throw 0
      cards.add(c.alias); return { alias: c.alias, label: c.label, ...(Object.hasOwn(c, 'gist') ? { gist: c.gist } : {}) }
    })
    const partRef = p => {
      if (!exactKeys(p, ['part', 'trait', 'materials', 'component']) || !PART_ALIAS.test(p.part) || !TRAITS.includes(p.trait) || !Array.isArray(p.materials) || !p.materials.length || new Set(p.materials).size !== p.materials.length || !p.materials.every(a => mats.has(a))) throw 0
      const reuse = REUSE_VALUE.exec(p.component)?.[1]
      if (reuse ? !cards.has(reuse) : !(catalog.get(p.component)?.purpose?.[p.trait])) throw 0
      return { part: p.part, trait: p.trait, materials: [...p.materials], component: p.component }
    }
    const names = new Set()
    const questions = raw.questions.map(q => {
      if (!isObj(q) || !STAGE_KINDS[raw.stage].includes(q.kind)) throw 0
      let out
      if (q.kind === 'several' || q.kind === 'one_sentence') { if (!exactKeys(q, ['kind'])) throw 0; out = { kind: q.kind } }
      else if (q.kind === 'about') { if (!exactKeys(q, ['kind', 'material']) || !mats.has(q.material)) throw 0; out = { kind: 'about', material: q.material } }
      else if (q.kind === 'same') { if (!exactKeys(q, ['kind', 'materials']) || !Array.isArray(q.materials) || q.materials.length !== 2 || q.materials[0] === q.materials[1] || !q.materials.every(a => mats.has(a))) throw 0; out = { kind: 'same', materials: [...q.materials] } }
      else if (q.kind === 'aspect') { if (!exactKeys(q, ['kind', 'part', 'materials']) || !PART_ALIAS.test(q.part) || !Array.isArray(q.materials) || q.materials.length !== 2 || q.materials[0] === q.materials[1] || !q.materials.every(a => mats.has(a))) throw 0; out = { kind: 'aspect', part: q.part, materials: [...q.materials] } }
      else if (q.kind === 'happened' || q.kind === 'todo' || q.kind === 'fact') { if (!exactKeys(q, ['kind', 'material']) || !mats.has(q.material)) throw 0; out = { kind: q.kind, material: q.material } }
      else if (q.kind === 'before') { if (!exactKeys(q, ['kind', 'first', 'second'])) throw 0; out = { kind: 'before', first: partRef(q.first), second: partRef(q.second) }; if (out.first.part === out.second.part) throw 0 }
      else if (q.kind === 'slot') {
        if (!exactKeys(q, ['kind', 'part', 'row', 'text', 'material'], ['side', 'aspect', 'heading']) || !PART_ALIAS.test(q.part) || !Number.isInteger(q.row) || q.row < 1 || q.row > 12 || !plain(q.text, SKELETON_LIMITS.slotTextMax) || !mats.has(q.material) ||
            (q.side !== undefined && q.side !== 'left' && q.side !== 'right') || (q.aspect !== undefined && !plain(q.aspect, 40)) || ((q.side === undefined) !== (q.aspect === undefined)) ||
            (q.heading !== undefined && (q.side !== undefined || !plain(q.heading, 40)))) throw 0
        out = { kind: 'slot', part: q.part, row: q.row, ...(q.side ? { side: q.side, aspect: q.aspect } : {}), ...(q.heading !== undefined ? { heading: q.heading } : {}), text: q.text, material: q.material }
      } else {
        if (!exactKeys(q, ['kind', 'part', 'text', 'shown']) || !PART_ALIAS.test(q.part) || !plain(q.text, BRIEFING_LIMITS.textMax) || !Array.isArray(q.shown) || !q.shown.length || q.shown.length > 3) throw 0
        out = { kind: 'step', part: q.part, text: q.text, shown: q.shown.map(shownCard) }
      }
      const name = questionName(out)
      if (names.has(name)) throw 0
      names.add(name); return out
    })
    return { stage: raw.stage, request: raw.request, ...(raw.answer !== undefined ? { answer: raw.answer } : {}), materials, cards: list, questions }
  } catch { return null }
}

// What a step shows, as structured fields (never one string of a label run into its text): a list card's lines as { heading, text }, a comparison's rows as
// { aspect, older, newer }, any other card as { text }.
const field = (v, max) => (v === '' || plain(v, max) ? v : (() => { throw 0 })())
function shownCard(x) {
  if (!isObj(x) || !plain(x.label, BRIEFING_LIMITS.labelMax)) throw 0
  if (exactKeys(x, ['label', 'lines'])) { if (!Array.isArray(x.lines) || !x.lines.length || x.lines.length > 12) throw 0; return { label: x.label, lines: x.lines.map(l => { if (!exactKeys(l, ['heading', 'text'])) throw 0; return { heading: field(l.heading, 40), text: field(l.text, SKELETON_LIMITS.slotTextMax) } }) } }
  if (exactKeys(x, ['label', 'rows'])) { if (!Array.isArray(x.rows) || !x.rows.length || x.rows.length > 12) throw 0; return { label: x.label, rows: x.rows.map(r => { if (!exactKeys(r, ['aspect', 'older', 'newer'])) throw 0; return { aspect: field(r.aspect, 40), older: field(r.older, SKELETON_LIMITS.slotTextMax), newer: field(r.newer, SKELETON_LIMITS.slotTextMax) } }) } }
  if (exactKeys(x, ['label', 'text'])) return { label: x.label, text: field(x.text, SKELETON_LIMITS.contentMax) }
  throw 0
}
const RULES = {
  place: 'You are a system judge. An assistant has answered a person in a chat; below are the person\'s request and the stored materials the assistant had. Each question is separate: answer each on its own, whatever the others are. Judge only what the person asked for, from the request and the materials as quoted.',
  fit: 'You are a system judge reading stored materials. Each question quotes ONE material or ONE pair of materials and asks ONE thing about what its text states. Answer each question on its own, whatever the others are. Judge only from the quoted text; never assume content it does not contain.',
  order: 'You are a system judge. Each question describes TWO parts of a briefing by the materials they show. Answer each question on its own. Judge only which part a reader who has seen none of it should be shown first to follow the other.',
  fill_check: 'You are a system judge checking a text against its source. Each question quotes ONE text and ONE source. Answer each question on its own, whatever the others are. Rewording, summarising and linking words are fine. A number, amount, date, name or event that the quoted source does not contain is NOT supported.',
}
// Only what the record has: no date when it has none, no status when the record does not say ("unknown" is not a status to judge from).
const quoteMaterial = m => `${m.alias} ${JSON.stringify({ title: m.title, ...(m.at ? { date: m.at } : {}), ...(m.status && m.status !== 'unknown' ? { status: m.status } : {}), text: m.text })}`
function questionText(q, c, catalog) {
  // The request is the one user message of the request; each question quotes its own materials, text or source.
  const mat = a => c.materials.find(m => m.alias === a)
  if (q.kind === 'several') return 'To answer this request well, does the person need to see several of the listed materials together: side by side (for example two versions against each other) or one after another (for example what happened in order)?'
  if (q.kind === 'one_sentence') return 'Is this request fully answered by one short sentence or a single fact (for example one number, one date, or yes or no)?'
  if (q.kind === 'aspect') return `Two materials, each quoted as JSON: ${q.materials.map(a => quoteMaterial(mat(a))).join('; ')}. Do both of these materials state a value for at least one same aspect (for example a price in each, or a date in each)?`
  if (q.kind === 'happened') return `Material, quoted as JSON: ${quoteMaterial(mat(q.material))}. Does this material state something that happened or was decided (an action, an event or a decision)?`
  if (q.kind === 'todo') return `Material, quoted as JSON: ${quoteMaterial(mat(q.material))}. According to this material, is something not done yet or still to happen?`
  if (q.kind === 'about') return `The person asked, quoted exactly as a JSON string: ${JSON.stringify(c.request)}. Material, quoted as JSON: ${quoteMaterial(mat(q.material))}. Does this material contain information that the person's request asks about${c.answer ? ' (the request may refer to the assistant\'s answer quoted above)' : ''}?`
  if (q.kind === 'same') return `Two materials, each quoted as JSON: ${q.materials.map(a => quoteMaterial(mat(a))).join('; ')}. Are these two materials an earlier and a later version of the same document, offer or plan?`
  if (q.kind === 'fact') return `Material, quoted as JSON: ${quoteMaterial(mat(q.material))}. Does this material state at least one concrete fact (for example a number, an amount, a date, a name or a decision)?`
  if (q.kind === 'before') { const side = (p, x) => `Part ${x} shows ${SHOW[p.trait]}: ${p.materials.map(a => quoteMaterial(mat(a))).join('; ')}.`
    return `${side(q.first, 'X')} ${side(q.second, 'Y')} Should a reader who has seen none of it be shown part X before part Y?` }
  if (q.kind === 'slot' && q.heading !== undefined) return `Line of a list, quoted as JSON with its heading and its text as separate fields: ${JSON.stringify({ heading: q.heading, text: q.text })}. Source material, quoted as JSON: ${quoteMaterial(mat(q.material))}. ` +
    'The heading only names the line. Is everything the line\'s text states supported by this source material?'
  if (q.kind === 'slot') return q.side ? `Value, quoted exactly as a JSON string: ${JSON.stringify(q.text)}, given for the aspect ${JSON.stringify(q.aspect)}. Source material, quoted as JSON: ${quoteMaterial(mat(q.material))}. Is this value, for this aspect, supported by this source material?`
    : `Text, quoted exactly as a JSON string: ${JSON.stringify(q.text)}. Source material, quoted as JSON: ${quoteMaterial(mat(q.material))}. Is everything this text states supported by this source material?`
  return `Explanation, quoted exactly as a JSON string: ${JSON.stringify(q.text)}. What the step shows, quoted as JSON: ${JSON.stringify(q.shown)}. Is every fact in the explanation also in what the step shows?`
}

/** createSkeletonJudge(catalog) -> { prepare, read, entry }: the typed judge the bridge mounts (same contract as the other briefing judges). */
export function createSkeletonJudge(catalog = BRIEFING_CATALOG) {
  function prepare({ mode = 'off', binding = '', dto } = {}) {
    const manual = { status: 'manual', packet: null }
    if (!binding || !['advisory', 'on'].includes(mode)) return manual
    const c = normalizeSkeletonDto(dto, catalog)
    if (!c) return manual
    // Plain text messages (the input shape of the requests that were really sent). The request and, for the placement questions, the materials are listed once;
    // every other question quotes its own material, text or source inside the question.
    const listing = c.stage === 'place' ? `${c.answer ? `\n\nThe assistant's answer to it, quoted exactly as a JSON string: ${JSON.stringify(c.answer)}` : ''}\n\nMaterials the assistant had, each quoted as JSON:\n${c.materials.map(quoteMaterial).join('\n')}` : ''
    const packet = { input: [{ role: 'developer', content: RULES[c.stage] }, { role: 'user', content: `Request, quoted exactly as a JSON string: ${JSON.stringify(c.request)}${listing}` }],
      questions: c.questions.map(q => predicateQuestion(questionName(q), questionText(q, c, catalog))), promptCacheKey: `briefing-skeleton-${c.stage}` }
    return { status: 'prepared', kind: 'briefing-skeleton', mode, binding, dto: { ...c, purpose: `briefing skeleton: ${c.stage}`, items: [] }, options: c.questions.map(questionName), packet }
  }
  /** Every answer is a probability or null (a refusal or a missing answer is unknown, never "no"). Nothing usable at all = manual. */
  function read(prepared, answers, currentBinding) {
    const base = { status: 'manual', verdict: 'manual' }
    if (prepared?.status !== 'prepared' || prepared.kind !== 'briefing-skeleton' || currentBinding !== prepared.binding) return base
    const out = {}
    for (const q of prepared.dto.questions) { const name = questionName(q); out[name] = readPredicate(answers, name, SKELETON_BARS.yes).probability }
    if (Object.values(out).every(p => p === null)) return base
    return { status: 'ok', verdict: prepared.dto.stage === 'place' ? decidePlace(out).value : 'ok', reply: { status: 'ok', stage: prepared.dto.stage, answers: out } }
  }
  /** Content-free calibration record: one judgment per predicate, the bar that applied, what it would do. */
  function entry(prepared, answers, result) {
    return { feature: 'answer_briefing', mode: prepared.mode, candidates: prepared.dto.questions.length, attached: prepared.mode === 'on' && result?.status === 'ok',
      judgments: prepared.dto.questions.map(q => { const p = answers?.[questionName(q)]?.probability
        return { q: 'relevance', would: !Number.isFinite(p) ? 'hold' : p >= SKELETON_BARS.yes ? 'accept' : p <= SKELETON_BARS.no ? 'reject' : 'hold', p, threshold: SKELETON_BARS.yes, kind: 'board' } }) }
  }
  return Object.freeze({ prepare, read, entry })
}
export const SKELETON_JUDGE = createSkeletonJudge()

// ---- code combines the answers ----
const isYes = p => typeof p === 'number' && p >= SKELETON_BARS.yes, isNo = p => typeof p === 'number' && p <= SKELETON_BARS.no
/** Board only when several materials are needed together AND one sentence would not do. Anything undecided stays in the bubble. */
export function decidePlace(answers) {
  if (isYes(answers?.one_sentence)) return { value: 'bubble', reason: 'judged-bubble' }
  if (isYes(answers?.several) && isNo(answers?.one_sentence)) return { value: 'board', reason: null }
  return { value: 'bubble', reason: isNo(answers?.several) ? 'judged-bubble' : 'placement-undecided' }
}
// Reuse first: an existing card, then a component that makes nothing new, then new cards in catalog order.
const preference = (option, catalog) => (option.reuse ? 0 : catalog.get(option.component)?.renderer.creates ? 2 : 1)
/** The fit questions of a scene: one per (part, content requirement), deduplicated (a material asked about once). None for a part that is only reused. */
export function fitQuestions(scene) {
  const out = [], seen = new Set()
  for (const part of scene.parts) {
    if (!part.options.some(o => o.component)) continue // an existing card for it, computed: reused, nothing to ask
    const kind = FIT_KINDS[part.trait]
    const qs = kind === 'aspect' ? [{ kind, part: part.alias, materials: [...part.materials] }] : part.materials.map(material => ({ kind, material }))
    for (const q of qs) { const name = questionName(q); if (!seen.has(name)) { seen.add(name); out.push(q) } }
  }
  return out
}
/**
 * Per part, the ways of showing it that its content supports, best first (reuse > nothing new > a new card), and the materials that carry it.
 * compare: aspect yes. sequence: at least two materials with happened yes (only those are shown). open_items: at least one with todo yes. single: fact yes.
 * Undecided or refused is not yes. A part with no yes is not on the board; no part at all = no component fits.
 */
export function chooseParts(scene, answers) {
  return scene.parts.map(part => {
    const rank = options => options.map((o, i) => ({ o, i })).sort((a, b) => preference(a.o, scene.catalog) - preference(b.o, scene.catalog) || a.i - b.i).map(x => x.o)
    if (!part.options.some(o => o.component)) return { part, materials: part.materials, yes: rank(part.options), decided: true }
    const kind = FIT_KINDS[part.trait], p = m => answers?.[`${kind}_${m}`] ?? null
    if (kind === 'aspect') { const v = answers?.[`aspect_${part.alias}`] ?? null; return { part, materials: part.materials, yes: isYes(v) ? rank(part.options) : [], decided: isYes(v) || isNo(v) } }
    const carried = part.materials.filter(m => isYes(p(m))), enough = carried.length >= (kind === 'happened' ? 2 : 1)
    return { part, materials: enough ? carried : part.materials, yes: enough ? rank(part.options.filter(o => o.component)) : [], decided: part.materials.every(m => isYes(p(m)) || isNo(p(m))) }
  })
}
const FUTURE = '9999-12-31', DERIVES = new Set(['follows_from', 'decided_in', 'supersedes', 'refers_to'])
/** Does the record say a comes before b? true / false / null (the record does not say: a tie). Time first (every material of a is earlier than every material of b; a plan without a date is in the future), then links (b's materials build on a's and not the other way round). */
export function recordedBefore(a, b, scene) {
  const by = new Map(scene.materials.map(m => [m.alias, m])), when = m => m.at ?? (m.open ? FUTURE : null)
  const span = item => { const dates = item.materials.map(x => when(by.get(x))); return dates.includes(null) ? null : { min: [...dates].sort()[0], max: [...dates].sort().at(-1) } }
  const sa = span(a), sb = span(b)
  if (sa && sb) { if (sa.max < sb.min) return true; if (sb.max < sa.min) return false }
  if (a.materials.some(x => b.materials.includes(x))) return null
  const builds = (x, y) => x.materials.some(m => by.get(m).links.some(l => DERIVES.has(l.type) && y.materials.includes(l.to)))
  const ab = builds(b, a), ba = builds(a, b)
  return ab && !ba ? true : ba && !ab ? false : null
}
/** The order of the chosen parts: recorded time and links decide; for the pairs they leave open the judge's "X before Y" answer; an undecided pair keeps the code's own order. */
export function orderItems(items, scene, answers = {}) {
  const wins = new Map(items.map(i => [i.id, 0])), ties = []
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j], rec = recordedBefore(a, b, scene)
    const p = rec === null ? answers[`before_${a.id}_${b.id}`] : null
    if (rec === null) ties.push([a, b])
    const first = rec !== null ? rec : isNo(p) ? false : true // undecided or unasked: the code's own order (versions, sequence, open items, single)
    wins.set(first ? a.id : b.id, wins.get(first ? a.id : b.id) + 1)
  }
  return { ordered: [...items].sort((x, y) => wins.get(y.id) - wins.get(x.id) || items.indexOf(x) - items.indexOf(y)), ties }
}

// ---------------- 4. layout of the chosen skeleton, by code, with the product's sizes ----------------
const targetsOf = item => [...(item.creates ? [item.creates] : []), ...item.reuse]
/** Where the new cards of this skeleton would open (the product's own placement code and size table) and how much each holds. viewport: { x, y, width, height } in canvas px. */
export function layoutSkeleton(items, scene, viewport = null) {
  const existing = scene.targets.filter(t => finiteRect(t.rect))
  const box = existing.length ? { x: Math.min(...existing.map(t => t.rect.x)), y: Math.min(...existing.map(t => t.rect.y)) } : { x: 0, y: 0 }
  const view = finiteRect(viewport) ? { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height } : { x: box.x - 48, y: box.y - 48, width: 1440, height: 900 }
  const safe = { left: view.x + 24, top: view.y + 24, right: right(view) - 24, bottom: bottom(view) - 24 }
  const occupied = existing.map(t => ({ ...t.rect })), rects = new Map(existing.map(t => [t.alias, t.rect])), capacity = new Map()
  for (const item of items) {
    if (!item.creates) continue
    const size = canvasViewSize('result', { width: safe.right - safe.left, height: safe.bottom - safe.top })
    const beside = item.reuse.map(a => rects.get(a)).find(Boolean)
    const placed = placeCanvasView({ size, safe, occupied, anchor: beside ? { x: right(beside) + 24 + size.width / 2, y: beside.y + size.height / 2 } : null, gap: 24 })
    if (!placed) continue
    const rect = { x: placed.x, y: placed.y, width: placed.width, height: placed.height }
    rects.set(item.creates, rect); occupied.push(rect); capacity.set(item.id, resultCardCapacity(rect))
  }
  return { view, rects, capacity }
}
const rowSlot = entry => entry?.slots.find(s => s.type === 'list') ?? null
/** How many rows the part may get: the component's own maximum, the number of materials for a sequence, a trim made by the layout rule. */
export function plannedRows(item, catalog = BRIEFING_CATALOG) {
  const slot = rowSlot(catalog.get(item.component))
  if (!slot) return 0
  return Math.min(item.maxRows ?? slot.max, item.trait === 'sequence' ? Math.max(slot.min, item.materials.length) : slot.max)
}
/** The closed check items of a planned skeleton, each with the fix code applies: [{ item, about, fix, fitRows? }]. Layout is computed, so it is decided by rule, not asked. */
export function skeletonChecks(items, layout, scene, catalog = BRIEFING_CATALOG) {
  const out = []
  for (const item of items) {
    const entry = catalog.get(item.component), cap = layout.capacity.get(item.id)
    if (entry?.size && cap) {
      const want = entry.size.baseLines + (entry.size.rowLines ? (item.trait === 'sequence' && !item.maxRows ? item.materials.length : plannedRows(item, catalog)) * entry.size.rowLines : Math.ceil(600 / Math.max(1, cap.widthPx / 13)))
      const fitRows = entry.size.rowLines ? Math.floor((cap.lines - entry.size.baseLines) / entry.size.rowLines) : 0
      if (want > cap.lines) out.push({ item: 'overflow', about: item.id, fix: entry.size.rowLines && fitRows >= (rowSlot(entry)?.min ?? 1) ? 'trim' : 'drop', fitRows })
    }
    const rects = targetsOf(item).map(a => layout.rects.get(a)).filter(Boolean)
    if (rects.length >= 2) {
      const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y)), w = Math.max(...rects.map(right)) - x, h = Math.max(...rects.map(bottom)) - y
      const fix = item.creates ? 'own_step' : 'drop'
      let covers = false
      for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (overlapArea(rects[i], rects[j]) > Math.min(area(rects[i]), area(rects[j])) * SKELETON_LIMITS.overlapShare) covers = true
      if (Math.min(layout.view.width / w, layout.view.height / h) < SKELETON_LIMITS.readZoom) out.push({ item: 'spread', about: item.id, fix })
      else if (covers) out.push({ item: 'overlap', about: item.id, fix })
    }
  }
  return out
}
const applyFix = (items, check) => (check.fix === 'drop' ? items.filter(i => i.id !== check.about) : items.map(i => (i.id !== check.about ? i : check.fix === 'trim' ? { ...i, maxRows: check.fitRows } : { ...i, reuse: [] })))

// ---------------- 5. the design guide, the fill request and the validation of what comes back ----------------
function itemFor(part, option, scene, n) {
  const catalog = scene.catalog, entry = option.component ? catalog.get(option.component) : null
  const existing = part.materials.map(a => scene.shows.get(a)).filter(Boolean)
  // A compare card also points at the versions that are already on the board; a pair step IS those two cards; a reuse step is that card.
  const reuse = option.reuse ? [option.reuse] : entry.id === 'step_pair' ? existing.slice(0, 2) : part.trait === 'compare' ? existing.slice(0, 2) : []
  return { id: part.alias, trait: part.trait, materials: [...part.materials], component: option.component ?? null, reuse, creates: entry?.renderer.creates ? 'N' + n : null, emphasis: entry?.emphasis ?? 'spotlight', tried: [option.value] }
}
const slotsOf = (item, catalog) => (catalog.get(item.component)?.slots ?? []).map(s => (s.type === 'list' && item.maxRows ? { ...s, max: Math.min(s.max, item.maxRows) } : s))
/** The design guide: ordered components with their slot schemas, the existing cards they reuse, and the fold proposals. This, and the materials, is all the subjective model gets. */
export function buildGuide(items, scene, retire = []) {
  const label = a => scene.targets.find(t => t.alias === a)?.label ?? ''
  return { version: 1, catalog: scene.catalog.version, titleMax: BRIEFING_LIMITS.titleMax,
    items: items.map((item, i) => ({ id: item.id, position: i + 1, shows: item.trait, component: item.component ?? 'existing_card', materials: [...item.materials], emphasis: item.emphasis,
      pointsAt: [...(item.creates ? [{ alias: item.creates, new: true }] : []), ...item.reuse.map(a => ({ alias: a, new: false, label: label(a) }))],
      step: STEP_SLOTS, slots: slotsOf(item, scene.catalog) })),
    retrievals: [...retire] }
}
/** only: fill just these items again. rejected: closed words for what was not supported last time (e.g. "P2 line 2", "P1 explanation"). */
export function fillRequest(guide, materials, only = null, rejected = []) {
  return { kind: 'briefing_fill', ...(only ? { only: [...only] } : {}), ...(rejected.length ? { rejected: [...rejected] } : {}), guide: { ...guide, items: guide.items.filter(i => !only || only.has(i.id)) },
    materials: materials.map(m => ({ alias: m.alias, title: m.title, text: m.text, at: m.at, status: m.status })) }
}
function readSlot(schema, value, item, reported) {
  if (reported) return { issue: 'empty' }
  if (schema.type === 'text') { const v = clean(value, 4000); return !v ? { issue: 'empty' } : v.length > schema.max ? { issue: 'mismatch' } : { value: v } }
  if (schema.type === 'material') return value === undefined || value === null || value === '' ? { issue: 'empty' } : item.materials.includes(value) ? { value } : { issue: 'mismatch' }
  if (!Array.isArray(value) || !value.length) return { issue: 'empty' }
  if (value.length > schema.max) return { issue: 'mismatch' }
  const rows = []
  for (const row of value) {
    if (!isObj(row) || Object.keys(row).some(k => !schema.of.some(f => f.name === k))) return { issue: 'mismatch' }
    const out = {}
    for (const f of schema.of) { const r = readSlot(f, row[f.name], item, false); if (r.issue) return { issue: r.issue === 'empty' && value.length === 1 ? 'empty' : 'mismatch' }; out[f.name] = r.value }
    rows.push(out)
  }
  return rows.length < schema.min ? { issue: 'mismatch' } : { value: rows }
}
/**
 * validateFill(guide, reply, { only }) -> { ok:false, reason } | { ok:true, title, items: { P#: { text, fallback, slots } }, issues: [{ item, slot, kind:'empty'|'mismatch' }] }
 * The reply may only fill what the guide lists: an unknown item, field or slot refuses the whole reply (no new components, no extra steps). A slot the model
 * reports as unfillable, or leaves out, is an issue of that item, never a reason to invent a value.
 */
export function validateFill(guide, reply, { only = null } = {}) {
  if (!isObj(reply) || !isObj(reply.items)) return { ok: false, reason: 'not-an-object' }
  if (Object.keys(reply).some(k => !['title', 'items', 'unfillable'].includes(k))) return { ok: false, reason: 'extra-field' }
  const wanted = guide.items.filter(i => !only || only.has(i.id)), ids = new Set(wanted.map(i => i.id))
  if (Object.keys(reply.items).some(k => !ids.has(k))) return { ok: false, reason: 'extra-item' }
  const title = clean(reply.title, 400)
  if (!only && (!title || title.length > guide.titleMax)) return { ok: false, reason: 'no-title' }
  const reported = new Set((Array.isArray(reply.unfillable) ? reply.unfillable : []).filter(u => isObj(u) && ids.has(u.item) && typeof u.slot === 'string').map(u => `${u.item}/${u.slot}`))
  const items = {}, issues = []
  for (const item of wanted) {
    const got = isObj(reply.items[item.id]) ? reply.items[item.id] : {}
    if (Object.keys(got).some(k => !['text', 'fallback', 'slots'].includes(k))) return { ok: false, reason: 'extra-field' }
    const given = isObj(got.slots) ? got.slots : {}
    if (Object.keys(given).some(k => !item.slots.some(s => s.name === k))) return { ok: false, reason: 'extra-slot' }
    const out = { slots: {} }
    for (const s of item.step) { const r = readSlot(s, got[s.name], item, reported.has(`${item.id}/${s.name}`)); if (r.issue) issues.push({ item: item.id, slot: s.name, kind: r.issue }); else out[s.name] = r.value }
    for (const s of item.slots) { const r = readSlot(s, given[s.name], item, reported.has(`${item.id}/${s.name}`)); if (r.issue) issues.push({ item: item.id, slot: s.name, kind: r.issue }); else out.slots[s.name] = r.value }
    if (out.slots.left !== undefined && out.slots.left === out.slots.right) issues.push({ item: item.id, slot: 'right', kind: 'mismatch' })
    items[item.id] = out
  }
  return { ok: true, title: only ? null : title, items, issues }
}
/**
 * The questions of the check after the fill, for one item: every piece of slot text against the ONE material it cites, and the step explanation against what the step shows.
 * [{ kind:'slot', part, row, side?, aspect?, text, material }, ..., { kind:'step', part, text, shown }]. `what` is the closed word for a rejected piece ("P2 line 2").
 */
export function fillChecks(item, data, scene, catalog = BRIEFING_CATALOG, { mode = 'all' } = {}) {
  const out = [], failures = [], slots = data.slots ?? {}, cut = (v, max) => clean(v, max), by = a => scene.materials.find(m => m.alias === a)
  // Never one string of a heading run into its text: each is its own field. A heading that is a date is checked by code against the material's own date.
  if (item.component === 'result_lines') slots.lines.forEach((row, i) => {
    const heading = cut(row.label, 40), date = dateIn(heading)
    if (date && !dateMatches(date, by(row.from))) failures.push(`${item.id} line ${i + 1}`)
    out.push({ kind: 'slot', part: item.id, row: i + 1, heading, text: cut(row.text, SKELETON_LIMITS.slotTextMax), material: row.from })
  })
  else if (item.component === 'result_compare') slots.rows.forEach((row, i) => { for (const side of ['left', 'right']) out.push({ kind: 'slot', part: item.id, row: i + 1, side, aspect: cut(row.aspect, 40), text: cut(row[side], SKELETON_LIMITS.slotTextMax), material: slots[side] }) })
  else if (item.component === 'result_text') out.push({ kind: 'slot', part: item.id, row: 1, text: cut(slots.body, SKELETON_LIMITS.slotTextMax), material: item.materials[0] })
  const shown = [...(item.creates ? [shownOf(item, slots, cut)] : []),
    ...item.reuse.map(a => { const t = scene.targets.find(x => x.alias === a); return { label: cut(t.label, BRIEFING_LIMITS.labelMax), text: cut(t.gist ?? '', SKELETON_LIMITS.contentMax) } })].slice(0, 3)
  // 'facts' (internal switch, default off): only the pieces that carry a number, a date, a Latin word or a name are judged; every explanation still is.
  const kept = mode === 'facts' ? out.filter(q => FACTY.test(q.text)) : [...out]
  return { questions: [...kept, { kind: 'step', part: item.id, text: cut(data.text, BRIEFING_LIMITS.textMax), shown }], failures, skipped: out.length - kept.length }
}
export const FILL_CHECK_MODES = Object.freeze(['all', 'facts'])
// A number, a Latin word (v2, an id, a name), a role title (팀장, 대표, ...) or a name with its marker (A사, 김민수 님).
const FACTY = /[0-9０-９]|[A-Za-z]|(?:^|[^가-힣])(?:팀장|대표|부장|과장|이사|담당자)|[가-힣](?:사|님|씨)(?![가-힣])/
function shownOf(item, slots, cut) {
  const label = cut(slots.title, BRIEFING_LIMITS.labelMax)
  if (item.component === 'result_lines') return { label, lines: slots.lines.map(l => ({ heading: cut(l.label, 40), text: cut(l.text, SKELETON_LIMITS.slotTextMax) })) }
  if (item.component === 'result_compare') return { label, rows: slots.rows.map(r => ({ aspect: cut(r.aspect, 40), older: cut(r.left, SKELETON_LIMITS.slotTextMax), newer: cut(r.right, SKELETON_LIMITS.slotTextMax) })) }
  return { label, text: cut(slots.body ?? '', SKELETON_LIMITS.contentMax) }
}
/** A date written as a heading: 11/06, 11.6, 2026-11-06, 11월 6일. -> { month, day } or null. */
export function dateIn(text) {
  const t = String(text ?? '').trim()
  let m = /^(?:\d{4}-)?(\d{1,2})[-/.](\d{1,2})$/.exec(t) ?? /^(\d{1,2})\s?월\s?(\d{1,2})\s?일$/.exec(t)
  if (!m) return null
  const month = Number(m[1]), day = Number(m[2])
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? { month, day } : null
}
/** Does the material record that date (its own date, or the same month and day written in its text)? */
export function dateMatches(date, material) {
  if (!material) return false
  if (material.at) { const [, mm, dd] = material.at.split('-').map(Number); if (mm === date.month && dd === date.day) return true }
  return new RegExp(`(?<!\\d)${date.month}\\s?월\\s?${date.day}\\s?일|(?<!\\d)0?${date.month}[/.]0?${date.day}(?!\\d)`).test(material.text)
}
export const rejectedWord = q => (q.kind === 'step' ? `${q.part} explanation` : `${q.part} ${q.side ? `row ${q.row} ${q.side}` : `line ${q.row}`}`)

// ---------------- 6. the bounded loop ----------------
/**
 * runSkeletonFlow({ request, materials, candidates, currentAnswerId, viewport, judge, fill, egress, allow, observeOnly, catalog, bindings }) -> one of
 *   { status:'bubble', reason }            no-materials | no-component-fits | judged-bubble | placement-undecided | declined | judge-unavailable
 *   { status:'advisory-only' | 'observed' } recorded only
 *   { status:'presented', plan, newComponents:[{ alias, part, title, markdown }], retrievals, guide, stats }   the host publishes it as a proposal (same path as before)
 *   { status:'fallback-chat', reason }     the chat answer stays: fill-invalid | fill-bound | nothing-left | judge-unavailable | request-bound
 * judge: { prepare(dto), run(ticket), cancel(ticket) } (the bridge route of SKELETON_JUDGE). fill(request) -> the subjective model's JSON object | null.
 * Judgment requests: place (1), fit (1), order (0 or 1, only for pairs the record leaves open), fill check (1, plus 1 per rewrite round): 3 or 4 on the usual path, at most 6.
 * Bounds: SKELETON_LIMITS. stats counts requests and fill turns and keeps what the subjective model received.
 */
export async function runSkeletonFlow({ request = '', answer = '', materials = [], candidates = [], currentAnswerId = null, viewport = null, judge, fill = null, egress = null, allow = async () => true, observeOnly = false, catalog = BRIEFING_CATALOG, now = Date.now, bindings = null, fillCheck = 'all' } = {}) {
  const checkMode = FILL_CHECK_MODES.includes(fillCheck) ? fillCheck : 'all'
  const stats = { judgeRequests: 0, judgeMs: 0, questions: 0, fillTurns: 0, checkSkipped: 0, stages: [], received: [] }
  let relevanceOut = null, gaps = null
  const done = (status, extra = {}) => ({ status, ...(gaps ? { recordGaps: gaps } : {}), ...(relevanceOut ? { relevance: relevanceOut } : {}), ...extra, stages: [...new Set(stats.stages)], stats })
  // The same permissions as the run's own models: memory pages only if the run's model had them, card labels only if the cards may be sent, the request as the run's own data.
  if (egress && !egress.allows('draft_text')) return done('bubble', { reason: 'declined', requested: false })
  let scene = enumerateSkeleton({ materials: egress && !egress.allows('memory_page') ? [] : materials, candidates: egress && !egress.allows('canvas_text') ? [] : candidates, currentAnswerId, catalog, bindings })
  const asked = clean(request, SKELETON_LIMITS.requestMax)
  if (!scene.materials.length) return done('bubble', { reason: 'no-materials', requested: false })
  if (!asked || !scene.parts.length) return done('bubble', { reason: asked ? 'no-component-fits' : 'no-request', requested: false })
  // Honest about what the record lacks: without a date no material can be in a part in date order, without a recorded status none is open. Counted, never guessed.
  gaps = { materials: scene.materials.length, undated: scene.materials.filter(m => !m.at).length, noStatus: scene.materials.filter(m => m.status === 'unknown').length }
  const said = clean(answer, SKELETON_LIMITS.answerMax)
  const base = { request: asked, materials: scene.materials.map(m => ({ alias: m.alias, title: m.title, text: m.text, at: m.at, status: m.status })),
    cards: scene.targets.filter(t => t.targetable).map(t => ({ alias: t.alias, label: clean(t.label, BRIEFING_LIMITS.labelMax), ...(clean(t.gist, BRIEFING_LIMITS.gistMax) ? { gist: clean(t.gist, BRIEFING_LIMITS.gistMax) } : {}) })) }
  const ask = async (stage, questions) => {
    if (stats.judgeRequests >= SKELETON_LIMITS.maxRequests || stats.judgeMs >= SKELETON_LIMITS.judgeMs) return { unavailable: 'request-bound' }
    const prepared = await judge.prepare({ stage, ...base, ...(stage === 'place' && said ? { answer: said } : {}), questions: questions.slice(0, SKELETON_LIMITS.maxQuestions) })
    if (prepared?.status !== 'prepared') return { unavailable: prepared?.reason ?? 'unavailable' }
    if (!(await allow(`briefing-skeleton-${stage}`, prepared.preview))) { await judge.cancel(prepared.ticket); return { unavailable: 'declined' } }
    stats.judgeRequests++; stats.questions += Math.min(questions.length, SKELETON_LIMITS.maxQuestions); stats.stages.push(stage)
    const started = now()
    const reply = await judge.run(prepared.ticket)
    stats.judgeMs += Math.max(0, now() - started)
    if (reply?.status === 'advisory-only') return { advisory: reply.verdict }
    return reply?.status === 'ok' && isObj(reply.answers) ? { answers: reply.answers } : { unavailable: reply?.reason ?? reply?.status ?? 'manual' }
  }
  const unavailable = (r, fallback) => (fallback ? done('fallback-chat', { reason: r.unavailable === 'request-bound' ? 'request-bound' : 'judge-unavailable', detail: r.unavailable }) : done('bubble', { reason: r.unavailable === 'declined' ? 'declined' : 'judge-unavailable', detail: r.unavailable, requested: false }))
  // (a) bubble or board (two predicates), and in the same request what code cannot resolve about the materials: is each linked group what the request asks about,
  // and are the unresolved title-sharing pairs versions of one thing. One request instead of three; every question quotes its own material.
  const relevance = relevanceQuestions(scene.materials), pairs = versionCandidates(scene.materials)
  const placed = await ask('place', [{ kind: 'several' }, { kind: 'one_sentence' }, ...relevance.map(q => ({ kind: 'about', material: q.material })), ...pairs.map(materials => ({ kind: 'same', materials }))])
  if (placed.unavailable) return unavailable(placed, false)
  if (placed.advisory !== undefined) {
    const fits0 = fitQuestions(scene)
    if (placed.advisory === 'board' && fits0.length) await ask('fit', fits0)
    return done('advisory-only', { verdict: placed.advisory, requested: true })
  }
  const place = decidePlace(placed.answers)
  if (place.value !== 'board') return done('bubble', { reason: place.reason, requested: true, place: placed.answers })
  // Code drops what the request does not ask about (decided no or undecided) and adds the version pairs the judge confirmed; the scene is built again from that.
  const kept = new Set(relevance.filter(q => isYes(placed.answers[`about_${q.material}`])).flatMap(q => q.covers))
  const dropped0 = scene.materials.filter(m => !kept.has(m.alias)).map(m => m.alias), versions = pairs.filter(([a, b]) => isYes(placed.answers[`same_${a}_${b}`]))
  relevanceOut = { kept: [...kept], dropped: dropped0, versions }
  if (!kept.size) return done('bubble', { reason: 'not-asked-about', requested: true })
  scene = enumerateSkeleton({ materials: egress && !egress.allows('memory_page') ? [] : materials, candidates: egress && !egress.allows('canvas_text') ? [] : candidates, currentAnswerId, catalog, bindings, keep: kept, versionPairs: versions })
  base.materials = base.materials.filter(m => kept.has(m.alias))
  if (!scene.parts.length) return done('bubble', { reason: 'no-component-fits', requested: true })
  const fits0 = fitQuestions(scene)

  // (b) content sufficiency, one predicate per (part, requirement); code takes the best supported way, reuse first. All no = nothing fits. A part that is only reused asks nothing.
  const fits = fits0.length ? await ask('fit', fits0) : { answers: {} }
  if (fits.unavailable) return unavailable(fits, true)
  if (fits.advisory !== undefined) return done('advisory-only', { verdict: 'board', requested: true })
  const chosen = chooseParts(scene, fits.answers), decisions = Object.fromEntries(chosen.map(c => [c.part.alias, c.yes[0]?.value ?? (c.decided ? 'no' : 'undecided')]))
  let n = 0, items = []
  const alternatives = new Map()
  for (const c of chosen) { if (!c.yes.length) continue; const item = itemFor({ ...c.part, materials: c.materials }, c.yes[0], scene, n + 1); if (item.creates) n++; items.push(item); alternatives.set(c.part.alias, c.yes.slice(1)) }
  if (!items.length) return done('bubble', { reason: 'no-component-fits', requested: true, decisions })
  if (observeOnly) return done('observed', { requested: true, decisions })
  const dropped = []
  if (items.length > SKELETON_LIMITS.softSteps) { for (const extra of items.slice(SKELETON_LIMITS.softSteps)) dropped.push({ part: extra.id, why: 'too_many_steps' }); items = items.slice(0, SKELETON_LIMITS.softSteps) }

  // (c) order: the record's own time and links; only the pairs they leave open are asked, as "X before Y"
  const optionOf = item => ({ value: item.component ?? `reuse_${item.reuse[0]}` })
  const refOf = item => ({ part: item.id, trait: item.trait, materials: item.materials, component: optionOf(item).value })
  let ordering = orderItems(items, scene), orderAnswers = {}
  if (ordering.ties.length) {
    const tied = await ask('order', ordering.ties.map(([a, b]) => ({ kind: 'before', first: refOf(a), second: refOf(b) })))
    if (tied.unavailable) return unavailable(tied, true)
    orderAnswers = tied.answers; ordering = orderItems(items, scene, orderAnswers)
  }
  items = ordering.ordered

  // (d) layout by code with real sizes; what does not fit is fixed by rule (fewer rows, the step's own card only, or leaving the part out). Nothing is asked.
  const repaired = []
  let layout = layoutSkeleton(items, scene, viewport)
  for (let round = 0; round < 3; round++) {
    const checks = skeletonChecks(items, layout, scene, catalog)
    if (!checks.length) break
    for (const c of checks) { repaired.push({ item: c.item, about: c.about, value: c.fix }); items = applyFix(items, c) }
    if (!items.length) return done('bubble', { reason: 'no-component-fits', requested: true, decisions, repaired })
    layout = layoutSkeleton(items, scene, viewport)
  }

  // Fill: the subjective model gets the guide and the materials, nothing else, and returns slot data.
  if (typeof fill !== 'function') return done('fallback-chat', { reason: 'fill-invalid', detail: 'no-engine' })
  const used = () => new Set(items.flatMap(i => i.reuse)), retire = () => scene.retrievable.filter(a => !used().has(a)) // a fold is only a proposal the person applies: decided by rule
  let guide = buildGuide(items, scene, retire()), title = null
  const filled = {}
  const fillOnce = async (only, rejected = []) => {
    if (stats.fillTurns >= SKELETON_LIMITS.fillTurns) return { bound: true }
    stats.fillTurns++
    const want = fillRequest(guide, scene.materials, only, rejected)
    stats.received.push({ turn: stats.fillTurns, keys: Object.keys(want), items: want.guide.items.map(i => `${i.id}:${i.component}`), materials: want.materials.map(m => m.alias), ...(rejected.length ? { rejected } : {}) })
    return validateFill(guide, await fill(want), { only })
  }
  let got = await fillOnce(null)
  if (!got.bound && !got.ok) got = await fillOnce(null) // one retry for a reply that is not the asked shape
  if (got.bound || !got.ok) return done('fallback-chat', { reason: got.bound ? 'fill-bound' : 'fill-invalid', detail: got.reason })
  title = got.title; Object.assign(filled, got.items)
  let issues = got.issues, pending = new Set(items.map(i => i.id))
  const rejections = []
  const markdownOf = item => (item.creates ? catalog.render(item.component, filled[item.id].slots) : null)
  for (;;) {
    // Check after the fill. Code: empty or mismatched slots, content that does not fit its card. Judge: each piece of slot text against the one material it cites,
    // each explanation against what its step shows; every question quotes both sides.
    const failing = new Map()
    for (const item of items) {
      if (!pending.has(item.id)) continue
      const mine = issues.filter(x => x.item === item.id)
      if (mine.length) { failing.set(item.id, { problem: mine.some(x => x.kind === 'empty') ? 'slot_empty' : 'slot_mismatch', words: [] }); continue }
      const cap = layout.capacity.get(item.id), md = markdownOf(item)
      if (md !== null && cap && textLines(md, cap.widthPx) > cap.lines) failing.set(item.id, { problem: 'overflow', words: [] })
    }
    const checked = items.filter(i => pending.has(i.id) && !failing.has(i.id)).map(item => fillChecks(item, filled[item.id], scene, catalog, { mode: checkMode }))
    const questions = checked.flatMap(c => c.questions)
    stats.checkSkipped += checked.reduce((sum, c) => sum + c.skipped, 0)
    // What code can check itself (a date heading against the material's own date) is a rule, not a question.
    for (const c of checked) for (const word of c.failures) { const part = word.split(' ')[0], f = failing.get(part) ?? { problem: 'unsupported', words: [] }; f.words.push(word); failing.set(part, f) }
    if (questions.length) {
      const judged = await ask('fill_check', questions)
      if (judged.unavailable) return unavailable(judged, true)
      // Supported means a decided yes. A refusal, a missing answer or anything in between is not support.
      for (const q of questions.slice(0, SKELETON_LIMITS.maxQuestions)) if (!isYes(judged.answers[questionName(q)])) { const f = failing.get(q.part) ?? { problem: 'unsupported', words: [] }; f.words.push(rejectedWord(q)); failing.set(q.part, f) }
      for (const q of questions.slice(SKELETON_LIMITS.maxQuestions)) failing.set(q.part, failing.get(q.part) ?? { problem: 'unsupported', words: [rejectedWord(q)] })
    }
    if (!failing.size) break
    // What happens to a failing part is a rule: missing data -> the next way of showing it that was judged to fit, else leave it out; anything else -> written again
    // once, with the closed words for what was not supported, else leave it out.
    const again = new Set(), words = []
    for (const [id, f] of failing) {
      const index = items.findIndex(i => i.id === id), item = items[index], part = scene.parts.find(p => p.alias === id)
      const next = f.problem === 'slot_empty' ? (alternatives.get(id) ?? []).find(o => !item.tried.includes(o.value)) : null
      if (next) { const swapped = itemFor({ ...part, materials: item.materials }, next, scene, 0); items[index] = { ...swapped, creates: swapped.creates ? item.creates ?? 'N' + (++n) : null, tried: [...item.tried, next.value] }; delete filled[id]; again.add(id); rejections.push({ part: id, problem: f.problem, action: next.value }); continue }
      if (f.problem !== 'slot_empty' && !item.refilled) { items[index] = { ...item, refilled: true }; again.add(id); words.push(...f.words); rejections.push({ part: id, problem: f.problem, action: 'rewrite', words: f.words }); continue }
      items.splice(index, 1); delete filled[id]; dropped.push({ part: id, why: f.problem, words: f.words }); rejections.push({ part: id, problem: f.problem, action: 'drop', words: f.words })
    }
    if (!items.length) return done('fallback-chat', { reason: 'nothing-left', rejections })
    issues = []; pending = again
    if (!again.size) break
    layout = layoutSkeleton(items, scene, viewport); guide = buildGuide(items, scene, retire())
    const rewritten = await fillOnce(again, words)
    if (rewritten.bound || !rewritten.ok) return done('fallback-chat', { reason: rewritten.bound ? 'fill-bound' : 'fill-invalid', detail: rewritten.reason, rejections })
    Object.assign(filled, rewritten.items); issues = rewritten.issues
  }
  guide = buildGuide(items, scene, retire())

  // The result, in the shape the host already publishes: new cards first (their text is rendered by CODE from the slot data), then the briefing that points at them.
  const targetRef = a => ({ ...scene.targets.find(t => t.alias === a).ref })
  const stepSpecs = items.map((item, i) => ({ id: 's' + (i + 1), text: filled[item.id].text, fallback: clean(filled[item.id].fallback, 400), emphasis: item.emphasis, refs: item.reuse.map(targetRef), news: item.creates ? [item.creates] : [] }))
  // materialKeys: what the card is built from, for the bridge to remember (provenance of the card; never part of a request).
  const keyOf = a => scene.materials.find(m => m.alias === a).key
  const newComponents = items.filter(i => i.creates).map(item => ({ alias: item.creates, part: item.id, component: item.component, trait: item.trait, materialKeys: item.materials.map(keyOf),
    title: clean(filled[item.id].slots.title, BRIEFING_LIMITS.labelMax), markdown: markdownOf(item) }))
  return done('presented', { plan: { title, stepSpecs, pendingSteps: stepSpecs.filter(s => !s.refs.length).map(s => s.id) }, newComponents,
    retrievals: guide.retrievals.map(a => { const t = scene.targets.find(x => x.alias === a); return { alias: a, id: t.id, ref: t.ref } }),
    reuse: { reuse: [...used()], retire: [...guide.retrievals], created: newComponents.map(c => c.component) }, guide, decisions, order: { ties: ordering.ties.map(([a, b]) => `${a.id}/${b.id}`), answers: orderAnswers }, repaired, rejections, dropped, revisions: rejections.filter(r => r.action === 'rewrite').length })
}
