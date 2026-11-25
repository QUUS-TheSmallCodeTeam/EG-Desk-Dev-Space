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

export const SKELETON_LIMITS = Object.freeze({ answerMax: 1200, factsAnswerMax: 8000, maxFacts: 6, factRequests: 2, factMax: 300, maxMaterials: 12, usualMaterials: 8, maxParts: 6, softSteps: 5, maxRequests: 10, maxQuestions: 60, judgeMs: 40_000, fillTurns: 3, pieceTurns: 4, requestMax: 400, titleMax: 80, excerptMax: 400, contentMax: 600, slotTextMax: 600, readZoom: BRIEFING_LIMITS.readZoom, overlapShare: BRIEFING_LIMITS.overlapShare })
// A predicate counts as yes at or above `yes` and as no at or below `no`; anything between is undecided. Placeholders until calibrated (real predicates of the other features answer near 0 or 1).
export const SKELETON_BARS = Object.freeze({ yes: .7, no: .3 })
export const SKELETON_STAGES = Object.freeze(['place', 'fit', 'order', 'fill_check', 'coverage'])
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
  // Cycle 26 (Main): twelve materials only for a long range (more dated materials than the usual eight could hold); otherwise eight, as before c25
  const pool = fresh.length ? fresh : listed, longRange = pool.slice(0, SKELETON_LIMITS.maxMaterials).filter(m => typeof (m.time?.at ?? m.at) === 'string').length > SKELETON_LIMITS.usualMaterials
  const usable = pool.slice(0, longRange ? SKELETON_LIMITS.maxMaterials : SKELETON_LIMITS.usualMaterials)
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
// Cycle 26 (Main's position after the c25 real run, where a group asked through its first line - a decision ABOUT L7 c19 - dropped the merge line the request asked for):
// the representative is picked by CODE: the member whose title names every identifier the request names (a token with a digit: "L7", "c19", "v2"), the one that names
// them earliest (a line's subject follows its stamp). A group with no such member, or a request that names none, is asked material by material.
const IDENT = /(?<![A-Za-z0-9])[A-Za-z]*\d+[A-Za-z0-9]*(?![A-Za-z0-9])/g
export const requestIdentifiers = request => [...new Set([...String(request ?? '').matchAll(IDENT)].map(m => m[0].toLowerCase()))]
function namedAt(title, idents) {
  const t = String(title).replace(/^\d{2}-\d{2} \d{2}:\d{2}\s*/, '').toLowerCase(), found = idents.map(id => [...t.matchAll(IDENT)].find(m => m[0] === id)?.index ?? -1)
  return found.every(i => i >= 0) ? Math.min(...found) : -1
}
export function relevanceQuestions(mats, request = '') {
  const idents = requestIdentifiers(request)
  return materialGroups(mats).flatMap(group => {
    if (group.length === 1) return [{ kind: 'about', material: group[0].alias, covers: [group[0].alias] }]
    const named = idents.length ? group.map(m => ({ m, at: namedAt(m.title, idents) })).filter(x => x.at >= 0).sort((a, b) => a.at - b.at) : []
    if (named.length) return [{ kind: 'about', material: named[0].m.alias, covers: group.map(m => m.alias) }]
    return group.map(m => ({ kind: 'about', material: m.alias, covers: [m.alias] }))
  })
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
    const dated = group.filter(m => m.at).sort((a, b) => a.at.localeCompare(b.at) || Number(a.alias.slice(1)) - Number(b.alias.slice(1)))
    // Cycle 25 (long ranges): more dated materials than one list card holds -> several sequence parts, one per period (consecutive in date order), never chat
    if (dated.length >= 2) {
      const chunks = splitByPeriod(dated, sequenceRows(catalog)), split = `S${raw.length}`
      chunks.forEach((chunk, index) => raw.push({ trait: 'sequence', materials: chunk.map(m => m.alias), ...(chunks.length > 1 ? { period: { split, index } } : {}) }))
    }
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
    return { alias, trait: part.trait, materials: part.materials, anchor: { min: dates[0] ?? null, max: dates.at(-1) ?? null }, ...(part.period ? { period: part.period } : {}), options }
  }).filter(part => part.options.length) // a part nothing in the catalog can show is not a part
  return { materials: mats, targets, shows, how, built, parts, retrievable: targets.filter(t => t.retrievable).map(t => t.alias).slice(0, 6), catalog }
}
/** How many characters one line of a list card holds: the text field of the catalog's sequence list component (90). */
export function lineTextMax(catalog = BRIEFING_CATALOG) {
  const maxes = (catalog.entries ?? []).filter(e => e.suits?.includes('sequence') && e.renderer?.creates).flatMap(e => e.slots.filter(sl => sl.type === 'list').flatMap(sl => sl.of.filter(f => f.name === 'text').map(f => f.max)))
  return maxes.length ? Math.min(...maxes) : 90
}
/** How many rows a sequence card holds: the list slot of the catalog's sequence components (the smallest), else 6. */
export function sequenceRows(catalog = BRIEFING_CATALOG) {
  const maxes = (catalog.entries ?? []).filter(e => e.suits?.includes('sequence') && e.renderer?.creates).flatMap(e => e.slots.filter(sl => sl.type === 'list').map(sl => sl.max))
  return maxes.length ? Math.min(...maxes) : 6
}
/**
 * splitByPeriod(dated, max) -> consecutive chunks of the date-ordered materials, each 2..max long: as few chunks as the rows require, near-equal in size, cut where
 * the date changes when it can (a chunk is a period), never leaving one material alone (a sequence needs two).
 */
export function splitByPeriod(dated, max = 6) {
  const list = [...dated]
  if (list.length <= max) return [list]
  const k = Math.ceil(list.length / max), size = Math.ceil(list.length / k), out = []
  const dayLength = at => list.filter(m => m.at === at).length
  let cur = []
  for (let i = 0; i < list.length; i++) {
    cur.push(list[i])
    const next = list[i + 1]
    if (!next) break
    // keep a day whole only when the day fits one card; a longer day is cut at the near-equal size
    const sameDay = next.at === list[i].at && dayLength(next.at) <= max
    if (cur.length >= max || (cur.length >= size && !(sameDay && cur.length < max && list.length - i - 1 > 1))) { out.push(cur); cur = [] }
  }
  if (cur.length) out.push(cur)
  // a last chunk of one cannot be a sequence: move the boundary back to the previous date change when both sides keep two or more, else move one material
  if (out.length > 1 && out.at(-1).length < 2) {
    const prev = out.at(-2), last = out.at(-1)
    let j = -1
    for (let x = prev.length - 1; x >= 2; x--) if (prev[x].at !== prev[x - 1].at && prev.length - x + last.length <= max) { j = x; break }
    const moved = prev.splice(j > 0 ? j : prev.length - 1)
    out[out.length - 1] = [...moved, ...last]
  }
  return out
}
// ---------------- 3. the judge: yes/no predicates only; every judged item is quoted in its own question; code combines the answers ----------------
// Real measurement (2026-11-24, 11 requests) of the earlier request shape: N-way choices with safe ways out ("bubble", "none_fits", "bubble_enough") went flat or to
// the safe side, a "which comes next" choice whose options carried no content was refused, and a negated check over a JSON blob said "mismatch" for every step, right
// or wrong. So (design rules R1-R4): the model reads the actual request and material text, each question is ONE yes/no about ONE quoted thing, and whatever code can
// compute (layout, time order, what is already on the board, which fold to propose) is not asked.
const MATERIAL_ALIAS = /^M(?:[1-9]|1[0-2])$/, TARGET_ALIAS = /^T(?:[1-9]|1[0-2])$/, PART_ALIAS = /^P[1-6]$/, REUSE_VALUE = /^reuse_(T(?:[1-9]|1[0-2]))$/
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
const STAGE_KINDS = { place: ['several', 'one_sentence', 'combines', 'about', 'same'], fit: ['aspect', 'happened', 'todo', 'fact'], order: ['before'], fill_check: ['slot', 'step'], coverage: ['covers', 'onboard', 'stated'] }
const SHOW = { compare: 'how these two versions differ', sequence: 'what happened across these materials, in date order', open_items: 'what is still not done in these materials', single: 'this one material' }
export const questionName = q => (q.kind === 'several' || q.kind === 'one_sentence' || q.kind === 'combines' || q.kind === 'covers' ? q.kind : q.kind === 'about' ? `about_${q.material}` : q.kind === 'onboard' ? `onboard_${q.fact}` : q.kind === 'stated' ? `stated_${q.fact}` : q.kind === 'same' ? `same_${q.materials[0]}_${q.materials[1]}` : q.kind === 'aspect' ? `aspect_${q.part}` : ['happened', 'todo', 'fact'].includes(q.kind) ? `${q.kind}_${q.material}` : q.kind === 'before' ? `before_${q.first.part}_${q.second.part}`
  : q.kind === 'slot' ? `slot_${q.part}_r${q.row}${q.side ? `_${q.side}` : ''}` : `step_${q.part}`)

/** The closed object for one judgment, re-validated here (the bridge route is reachable from the chrome): unknown fields, aliases, components or stages refuse the whole request. */
export function normalizeSkeletonDto(raw, catalog = BRIEFING_CATALOG) {
  try {
    if (!exactKeys(raw, ['stage', 'request', 'materials', 'cards', 'questions'], ['answer', 'board']) || !SKELETON_STAGES.includes(raw.stage) || !plain(raw.request, SKELETON_LIMITS.requestMax)) return null
    // cycle 21: the board, quoted once for the per-fact coverage questions (each question quotes only its own fact); the coverage stage only, never with the answer
    const board = raw.board === undefined ? undefined : raw.stage === 'coverage' && raw.answer === undefined ? boardFields(raw.board) : (() => { throw 0 })()
    if (raw.questions?.some?.(q => q?.kind === 'onboard') !== (board !== undefined)) return null
    // the answer being laid out, for the place request only (a request like "정리해줘" refers to it)
    if (raw.answer !== undefined && (!['place', 'coverage'].includes(raw.stage) || !plain(raw.answer, SKELETON_LIMITS.answerMax))) return null
    if (raw.questions?.some?.(q => q?.kind === 'combines') && raw.answer === undefined) return null // the content question needs the answer it quotes
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
      if (q.kind === 'several' || q.kind === 'one_sentence' || q.kind === 'combines') { if (!exactKeys(q, ['kind'])) throw 0; out = { kind: q.kind } }
      else if (q.kind === 'covers') {
        if (!exactKeys(q, ['kind', 'board'])) throw 0
        out = { kind: 'covers', board: boardFields(q.board) }
      }
      else if (q.kind === 'onboard' || q.kind === 'stated') {
        if (!exactKeys(q, ['kind', 'fact', 'text']) || !/^F(?:[1-9]|1[0-2])$/.test(q.fact) || !plain(q.text, SKELETON_LIMITS.factMax)) throw 0
        out = { kind: q.kind, fact: q.fact, text: q.text }
      }
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
    return { stage: raw.stage, request: raw.request, ...(raw.answer !== undefined ? { answer: raw.answer } : {}), ...(board !== undefined ? { board } : {}), materials, cards: list, questions }
  } catch { return null }
}
/** A board as quoted to the judge: its parts in order, each { text, shown: [structured card fields] }; anything else refuses the request. */
function boardFields(board) {
  if (!Array.isArray(board) || !board.length || board.length > SKELETON_LIMITS.maxParts) throw 0
  return board.map(p => { if (!exactKeys(p, ['text', 'shown']) || !plain(p.text, BRIEFING_LIMITS.textMax) || !Array.isArray(p.shown) || !p.shown.length || p.shown.length > 3) throw 0; return { text: p.text, shown: p.shown.map(shownCard) } })
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
  coverage: 'You are a system judge checking a finished board briefing against what the person asked. Judge only from the quoted request, the quoted answer and the quoted parts of the board, in their order.',
  coverage_facts: 'You are a system judge checking whether a finished board briefing shows given facts. Judge only from the quoted parts of the board and the quoted fact.',
  coverage_stated: 'You are a system judge checking whether a finished board briefing shows given facts, and whether a sentence states what the materials say. Judge only from the quoted parts of the board, the quoted materials and the quoted sentence or fact.',
  fill_check: 'You are a system judge checking a text against its source. Each question quotes ONE text and ONE source. Answer each question on its own, whatever the others are. Rewording, summarising and linking words are fine. A number, amount, date, name or event that the quoted source does not contain is NOT supported.',
}
// Only what the record has: no date when it has none, no status when the record does not say ("unknown" is not a status to judge from).
const quoteMaterial = m => `${m.alias} ${JSON.stringify({ title: m.title, ...(m.at ? { date: m.at } : {}), ...(m.status && m.status !== 'unknown' ? { status: m.status } : {}), text: m.text })}`
const TABLE_ROW_NOTE = / · /
const ROW_GUIDANCE = ' This fact is the cells of a table row joined by " · ": it is shown when every value is on the board, in any order or form; a date may be written as month-day in the fact and in full on the board.'
function questionText(q, c, catalog) {
  // The request is the one user message of the request; each question quotes its own materials, text or source.
  const mat = a => c.materials.find(m => m.alias === a)
  if (q.kind === 'several') return 'To answer this request well, does the person need to see several of the listed materials together: side by side (for example two versions against each other) or one after another (for example what happened in order)?'
  if (q.kind === 'one_sentence') return 'Is this request fully answered by one short sentence or a single fact (for example one number, one date, or yes or no)?'
  // Cycle 18: with the answer at hand, ask about its CONTENT, not its length ("방금 그 내용 정리해줘" asks to organise an answer that is itself one sentence: real .72).
  if (q.kind === 'combines') return `The assistant's answer, quoted exactly as a JSON string: ${JSON.stringify(c.answer ?? '')}. Does this answer combine several separate facts from different materials (dates, versions, steps) that would be easier to follow laid out side by side or in order?`
  if (q.kind === 'aspect') return `Two materials, each quoted as JSON: ${q.materials.map(a => quoteMaterial(mat(a))).join('; ')}. Do both of these materials state a value for at least one same aspect (for example a price in each, or a date in each)?`
  if (q.kind === 'happened') return `Material, quoted as JSON: ${quoteMaterial(mat(q.material))}. Does this material state something that happened or was decided (an action, an event or a decision)?`
  if (q.kind === 'todo') return `Material, quoted as JSON: ${quoteMaterial(mat(q.material))}. According to this material, is something not done yet or still to happen?`
  // Cycle 19: what is missing, as ONE condition over the whole board in order.
  if (q.kind === 'covers') return `The person asked, quoted exactly as a JSON string: ${JSON.stringify(c.request)}. The board, its parts quoted in order as JSON: ${JSON.stringify(q.board)}. Does this board answer everything the person's request asks about${c.answer ? ' (the request may refer to the assistant\'s answer quoted above)' : ''}?`
  // Cycle 21 (R4): one fact per question, quoted alone; the board is quoted once, above.
  // Cycle 38 (the c21 plan sent in c40: f-meta-sentences F5 "11-24 · 검색 화면 착수" .66 and F4 .73 although the board's third line has the date 2026-11-24 and "검색 화면 착수" word for word):
  // a fact that came from a table row is its cells joined by " · ", and a date may be written month-day in the fact and in full on the board. The request's RULE text says so (once per request,
  // not in every question: the c21 plan's token ceiling is tight).
  // Cycle 39: c38 put the table-row guidance in the request's RULE text, which applies to every fact of the request. The c43 re-send showed what that does to a plain fact: "11월 6일 v1 발송"
  // (board: "11월 6일 보낸 v1") went from .96 to .21 / .04, the judge reading "every value" literally. The guidance belongs only to a fact that IS a table row (its cells joined by " · "):
  // it is in that fact's own question, and a plain fact's question and the request's rule are exactly what they were before c38.
  if (q.kind === 'onboard') return `The fact, quoted exactly as a JSON string: ${JSON.stringify(q.text)}. Is this fact shown on the board quoted above (in the text or the shown fields of any of its parts)?${TABLE_ROW_NOTE.test(q.text) ? ROW_GUIDANCE : ''}`
  // Cycle 36 (check-11): a sentence of the answer that no code anchor ties to a material may be a statement ABOUT the answer ("정리했습니다", "파일은 변경하지 않았습니다") that no board can show.
  // Only the judge can tell it from a content fact, from the materials quoted once above.
  if (q.kind === 'stated') return `The sentence, quoted exactly as a JSON string: ${JSON.stringify(q.text)}. Does this sentence restate something that the materials quoted above say? (A sentence that only names or introduces the topic of the answer, such as a title or "X 정리입니다" or "the results are below", that only describes what the assistant did or how its answer is organised, or that says what it did not do, is not a statement of the materials, even if the topic is the materials' own.)`
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
    const listing = c.stage === 'coverage' && c.board ? `\n\nThe board, its parts quoted in order as JSON: ${JSON.stringify(c.board)}${c.questions.some(q => q.kind === 'stated') ? `\n\nThe materials, each quoted as JSON:\n${c.materials.map(quoteMaterial).join('\n')}` : ''}` : c.stage === 'coverage' && c.answer ? `\n\nThe assistant's answer to it, quoted exactly as a JSON string: ${JSON.stringify(c.answer)}` : c.stage === 'place' ? `${c.answer ? `\n\nThe assistant's answer to it, quoted exactly as a JSON string: ${JSON.stringify(c.answer)}` : ''}\n\nMaterials the assistant had, each quoted as JSON:\n${c.materials.map(quoteMaterial).join('\n')}` : ''
    const packet = { input: [{ role: 'developer', content: RULES[c.stage === 'coverage' && c.board ? (c.questions.some(q => q.kind === 'stated') ? 'coverage_stated' : 'coverage_facts') : c.stage] }, { role: 'user', content: `Request, quoted exactly as a JSON string: ${JSON.stringify(c.request)}${listing}` }],
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
export function decidePlace(answers, { relevant = null } = {}) {
  // With the answer quoted (cycle 19, Main's decision): board = the answer combines several facts from different materials (yes) AND, by code, at least two
  // materials were decided relevant. "Several" is not asked then: the count of relevant materials is known to code (R3), and one condition per question (R4).
  if (answers && Object.hasOwn(answers, 'combines')) {
    if (isNo(answers.combines)) return { value: 'bubble', reason: 'judged-bubble' }
    if (!isYes(answers.combines)) return { value: 'bubble', reason: 'placement-undecided' }
    if (relevant !== null && relevant < 2) return { value: 'bubble', reason: relevant === 0 ? 'not-asked-about' : 'single-material' }
    return { value: 'board', reason: null }
  }
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
  // two periods of one split sequence: their order is the split's own (code made it from the date order)
  const pa = a.period ?? scene.parts?.find(p => p.alias === a.id)?.period, pb = b.period ?? scene.parts?.find(p => p.alias === b.id)?.period
  if (pa && pb && pa.split === pb.split) return pa.index < pb.index
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
// Cycle 38 (check-17b: the real model filled 2 of 6 rows and reported the rest "unfillable" because all ids and figures do not fit 90 characters): a SEQUENCE card has a line for EVERY
// material it shows, so its list needs at least as many rows as the item has materials (when the card holds that many); validateFill also checks that each material is named.
const slotsOf = (item, catalog) => (catalog.get(item.component)?.slots ?? []).map(s => { const max = s.type === 'list' && item.maxRows ? Math.min(s.max, item.maxRows) : s.max; const base = s.type === 'list' && item.maxRows ? { ...s, max } : s
  return s.type === 'list' && item.trait === 'sequence' && Array.isArray(s.of) && s.of.some(f => f.name === 'from' && f.type === 'material') && item.materials.length <= max ? { ...base, min: Math.max(base.min ?? 1, item.materials.length) } : base })
/** The design guide: ordered components with their slot schemas, the existing cards they reuse, and the fold proposals. This, and the materials, is all the subjective model gets. */
export function buildGuide(items, scene, retire = []) {
  const label = a => scene.targets.find(t => t.alias === a)?.label ?? ''
  return { version: 1, catalog: scene.catalog.version, titleMax: BRIEFING_LIMITS.titleMax,
    items: items.map((item, i) => ({ id: item.id, position: i + 1, shows: item.trait, component: item.component ?? 'existing_card', materials: [...item.materials], emphasis: item.emphasis,
      pointsAt: [...(item.creates ? [{ alias: item.creates, new: true }] : []), ...item.reuse.map(a => ({ alias: a, new: false, label: label(a) }))],
      step: STEP_SLOTS, slots: slotsOf(item, scene.catalog) })),
    retrievals: [...retire] }
}
// Cycle 35 (c33's real replies took 20-30 s per card; output and reasoning size dominate): the model is asked for the MINIMUM the render needs. A step's fallback sentence is not
// asked for (the validator uses the step's text when the reply has none), and in a SEQUENCE line the label (the material's date) and the text (the material's own sentences, as many
// as fit the line) may be null: code copies them from the material the line cites, exactly. The model is left only with choosing and ordering the lines.
export const copyField = (item, field) => item?.shows === 'sequence' && (field?.name === 'label' || field?.name === 'text')
// Cycle 40 (check-20br): the real model wrote six rows per card, as asked, and aimed at the limit: row texts of 73 to 103 characters against a max of 90 (3 to 5 of 6 rows over), so the whole
// list was refused, rewritten, refused again and the card dropped ("nothing-left"). A model overshoots a limit it is given; so the request shows a MARGIN: the model is asked for at most 85 % of
// a row's label and text limits (`max`), while the validator keeps the real limit (the card holds it). Rows that still run over are named to the model by line in the one rewrite.
export const ROW_MARGIN = 0.85
const advised = f => (f.type === 'text' && Number.isFinite(f.max) ? { ...f, max: Math.max(1, Math.floor(f.max * ROW_MARGIN)) } : f)
const compactItem = item => ({ ...item, step: (item.step ?? []).filter(s => s.name !== 'fallback'), slots: (item.slots ?? []).map(s => (s.type === 'list' && Array.isArray(s.of) && s.of.some(f => f.name === 'from' && f.type === 'material') ? { ...s, of: s.of.map(f => advised(copyField(item, f) ? { ...f, copy: true } : f)) } : s)) })
/** The copy a null line text stands for: the material's WHOLE text when it fits `max` characters (a line of a card), else ''. Cycle 37: never a prefix of it. c35 copied the whole
 *  sentences that fit; for a long ledger entry ("... 표준 게이트 교체: 242개 파일 5752건 통과") that is a first sentence WITHOUT the figure, a fact lost to the line without any check
 *  noticing (the text is still "supported by its material"). A line the material does not fit in is the model's to write, keeping the ids, numbers and dates. */
export function copyThatFits(text, max) {
  const whole = clean(text, 4000)
  return whole.length > 0 && whole.length <= max ? whole : ''
}
/** only: fill just these items again. rejected: closed words for what was not supported last time (e.g. "P2 line 2", "P1 explanation"). cover: material aliases the cards must carry. */
export function fillRequest(guide, materials, only = null, rejected = [], cover = [], long = []) {
  return { kind: 'briefing_fill', ...(only ? { only: [...only] } : {}), ...(rejected.length ? { rejected: [...rejected] } : {}), ...(cover.length ? { cover: [...cover] } : {}), ...(long.length ? { long: [...long] } : {}), guide: { ...guide, items: guide.items.filter(i => !only || only.has(i.id)).map(compactItem) },
    materials: materials.map(m => ({ alias: m.alias, title: m.title, text: m.text, at: m.at, status: m.status })) }
}
function readSlot(schema, value, item, reported, materials = null) {
  if (reported) return { issue: 'empty' }
  if (schema.type === 'text') { const v = clean(value, 4000); return !v ? { issue: 'empty' } : v.length > schema.max ? { issue: 'mismatch' } : { value: v } }
  if (schema.type === 'material') return value === undefined || value === null || value === '' ? { issue: 'empty' } : item.materials.includes(value) ? { value } : { issue: 'mismatch' }
  if (!Array.isArray(value) || !value.length) return { issue: 'empty' }
  if (value.length > schema.max) return { issue: 'mismatch' }
  const rows = [], long = []
  for (const [index, row] of value.entries()) {
    if (!isObj(row) || Object.keys(row).some(k => !schema.of.some(f => f.name === k))) return { issue: 'mismatch' }
    const out = {}
    for (const f of schema.of) {
      // a sequence line's label / text left null is the cited material's own date / sentences (copyField), never a value the model had to retype
      let given = row[f.name]
      if (copyField(item, f) && (given === null || given === undefined || given === '') && materials) { const m = materials.get(row.from); given = !m ? null : f.name === 'label' ? (m.at ?? null) : (copyThatFits(m.text, f.max) || null) }
      const r = readSlot(f, given, item, false, materials)
      // c40: a text longer than its limit is noted by line (the model is told which lines to shorten) and the scan goes on; anything else refuses the list at once
      if (r.issue === 'mismatch' && f.type === 'text' && typeof given === 'string' && clean(given, 4000).length > f.max) { if (!long.includes(index + 1)) long.push(index + 1); continue }
      if (r.issue) return { issue: r.issue === 'empty' && value.length === 1 ? 'empty' : 'mismatch' }; out[f.name] = r.value }
    rows.push(out)
  }
  if (long.length) return { issue: 'mismatch', long }
  return rows.length < schema.min ? { issue: 'mismatch' } : { value: rows }
}
/**
 * validateFill(guide, reply, { only }) -> { ok:false, reason } | { ok:true, title, items: { P#: { text, fallback, slots } }, issues: [{ item, slot, kind:'empty'|'mismatch' }] }
 * The reply may only fill what the guide lists: an unknown item, field or slot refuses the whole reply (no new components, no extra steps). A slot the model
 * reports as unfillable, or leaves out, is an issue of that item, never a reason to invent a value.
 */
export function validateFill(guide, reply, { only = null, needTitle = false, materials = null } = {}) {
  const byAlias = Array.isArray(materials) ? new Map(materials.map(m => [m.alias, m])) : null
  if (!isObj(reply) || !isObj(reply.items)) return { ok: false, reason: 'not-an-object' }
  if (Object.keys(reply).some(k => !['title', 'items', 'unfillable'].includes(k))) return { ok: false, reason: 'extra-field' }
  const wanted = guide.items.filter(i => !only || only.has(i.id)), ids = new Set(wanted.map(i => i.id))
  if (Object.keys(reply.items).some(k => !ids.has(k))) return { ok: false, reason: 'extra-item' }
  // Cycle 34: a title longer than its limit is cut at a word, not a reason to refuse the whole reply (a strict output schema cannot state a length, so the schema admits it).
  const whole = !only || needTitle, raw = clean(reply.title, 400)
  const title = raw.length > guide.titleMax ? clean(raw.slice(0, guide.titleMax).replace(/\s+\S*$/, '') || raw.slice(0, guide.titleMax), guide.titleMax) : raw
  if (whole && !title) return { ok: false, reason: 'no-title' }
  const reported = new Set((Array.isArray(reply.unfillable) ? reply.unfillable : []).filter(u => isObj(u) && ids.has(u.item) && typeof u.slot === 'string').map(u => `${u.item}/${u.slot}`))
  const items = {}, issues = []
  for (const item of wanted) {
    const got = isObj(reply.items[item.id]) ? reply.items[item.id] : {}
    if (Object.keys(got).some(k => !['text', 'fallback', 'slots'].includes(k))) return { ok: false, reason: 'extra-field' }
    const given = isObj(got.slots) ? got.slots : {}
    if (Object.keys(given).some(k => !item.slots.some(s => s.name === k))) return { ok: false, reason: 'extra-slot' }
    const out = { slots: {} }
    for (const s of item.step) { const r = readSlot(s, s.name === 'fallback' && got.fallback === undefined ? got.text : got[s.name], item, reported.has(`${item.id}/${s.name}`)); if (r.issue) issues.push({ item: item.id, slot: s.name, kind: r.issue }); else out[s.name] = r.value }
    for (const s of item.slots) { const r = readSlot(s, given[s.name], item, reported.has(`${item.id}/${s.name}`), byAlias); if (r.issue) issues.push({ item: item.id, slot: s.name, kind: r.issue, ...(r.long ? { long: r.long } : {}) }); else out.slots[s.name] = r.value }
    if (out.slots.left !== undefined && out.slots.left === out.slots.right) issues.push({ item: item.id, slot: 'right', kind: 'mismatch' })
    // c38: a sequence card names every material it shows (one row each); a card that leaves one out is a mismatch of its list, which the flow rewrites
    if (item.shows === 'sequence') for (const s of item.slots) if (s.type === 'list' && Array.isArray(out.slots[s.name]) && s.of?.some(f => f.name === 'from') && item.materials.length <= s.max) { const named = new Set(out.slots[s.name].map(r => r.from)); if (item.materials.some(a => !named.has(a))) { issues.push({ item: item.id, slot: s.name, kind: 'mismatch' }); delete out.slots[s.name] } }
    items[item.id] = out
  }
  return { ok: true, title: whole ? title : null, items, issues }
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
  const shown = shownFor(item, data, scene)
  // 'facts' (internal switch, default off): only the pieces that carry a number, a date, a Latin word or a name are judged; every explanation still is.
  const kept = mode === 'facts' ? out.filter(q => FACTY.test(q.text)) : [...out]
  return { questions: [...kept, { kind: 'step', part: item.id, text: cut(data.text, BRIEFING_LIMITS.textMax), shown }], failures, skipped: out.length - kept.length }
}
export const FILL_CHECK_MODES = Object.freeze(['all', 'facts'])
// A number, a Latin word (v2, an id, a name), a role title (팀장, 대표, ...) or a name with its marker (A사, 김민수 님).
const FACTY = /[0-9０-９]|[A-Za-z]|(?:^|[^가-힣])(?:팀장|대표|부장|과장|이사|담당자)|[가-힣](?:사|님|씨)(?![가-힣])/
/** What one step shows, as structured fields: its new card (lines / rows / text) and the existing cards it points at. */
export function shownFor(item, data, scene) {
  const cut = (v, max) => clean(v, max)
  return [...(item.creates ? [shownOf(item, data.slots ?? {}, cut)] : []),
    ...item.reuse.map(a => { const t = scene.targets.find(x => x.alias === a); return { label: cut(t.label, BRIEFING_LIMITS.labelMax), text: cut(t.gist ?? '', SKELETON_LIMITS.contentMax) } })].slice(0, 3)
}
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

// ---------------- 5b. coverage facts (cycle 21): split and cited by code ----------------
export const COVERAGE_MODES = Object.freeze(['facts', 'board'])
/** The answer as facts: its sentences; a sentence is split at ", " / "; " into its clauses only when EVERY clause carries its own date, version mark or amount (then
 *  each stands alone as a fact; a comma inside a number, "12,800", never splits). A list ("법무 검토, 대표 승인, 최종본 발송") stays one sentence, one fact.
 *  Cycle 38 (Main): at most SKELETON_LIMITS.maxFacts per coverage request and SKELETON_LIMITS.factRequests requests (6 x 2 = 12 facts); the rest are counted (cut), never asked. -> { facts: [text], cut } */
export function answerFacts(answer) {
  const units = factUnits(answer), all = units.map(u => u.text)
  const cap = SKELETON_LIMITS.maxFacts * SKELETON_LIMITS.factRequests
  // Cycle 42: over the cap, the answer's STRUCTURED facts (table rows, list items) are asked first and its prose (a lead sentence like "…정리했습니다", whose "12개" is an amount to code) fills what is
  // left; within each group the answer's own order. Within the cap nothing is reordered.
  const facts = all.length > cap ? [...units.filter(u => u.structured), ...units.filter(u => !u.structured)].map(u => u.text) : all
  return { facts: facts.slice(0, cap), cut: Math.max(0, all.length - cap) }
}
// Cycle 29 (real answers are markdown): the answer's own structure first - one unit per bullet, numbered item, heading or table row (the header row and the
// separator row of a table are not facts; a row's cells are joined by " · "), emphasis and code marks removed - then sentences within each unit.
// Plain text (no line structure) is split as before.
export function answerUnits(answer) { return taggedUnits(answer).map(u => u.text) }
// The same units, each with whether it is a table row. Cycle 33: a row is ONE fact (its cells are one record: the date, the commit and the test count of the same line).
// c32's real answer had "결제 모듈 병합 완료. 알림 설정 화면은 시안만 확정" in a cell; splitting the row at that period gave one fact with the date and no commit, and another
// with the commit and no date, and the coverage check asked the board for both halves.
// a table cell that carries no value (an empty marker), not a statement
const NO_VALUE_CELL = /^(?:[-–—]+|없음|해당\s?없음|기록\s?없음|n\/a|none)$/i
function taggedUnits(answer) {
  // Cycle 42 (check-25br): the answer was cut at answerMax (1200) BEFORE its facts were split, and a real answer is a table whose rows each start with a link to an absolute path: 4,488
  // characters, the fourth row cut in the middle ("| 11-24 15:29 | int/c5 = ...", "| 258개 파일 5930") and eight rows never seen. The link targets go first (they are not facts), then the
  // facts-sized limit; the answer quoted to the judge is still the answerMax one.
  const raw = String(answer ?? '').normalize('NFC').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').slice(0, SKELETON_LIMITS.factsAnswerMax)
  if (!/\n/.test(raw)) return [{ text: raw, row: false, structured: false }]
  const out = [], lines = raw.split(/\n/)
  for (let i = 0; i < lines.length; i++) {
    let l = lines[i].trim(), row = false
    const listItem = /^(?:[-*+]|\d+[.)])\s+/.test(l)
    if (!l || /^```/.test(l) || /^#{1,6}\s/.test(l)) continue // a heading names a section, it states no fact
    if (/[:：]\s*(?:\*\*)?$/.test(l)) continue // a lead-in ("…정리:") introduces what follows, it states no fact
    if (/^(?:\*\*|__)[^*_]+(?:\*\*|__)$/.test(l)) continue // a line that is only a bold label names a section, it states no fact
    if (/^\|.*\|\s*$/.test(l)) {
      if (/^\|[\s:|-]+\|$/.test(l)) continue // separator row
      if (/^\|[\s:|-]+\|$/.test((lines[i + 1] ?? '').trim())) continue // header row (the next line is the separator)
      // Cycle 35 (check-9: the coverage check refused the row "11-24 · 검색 화면 착수 · 기록 없음 · 기록 없음" because no board can show that a commit and a test count were never recorded, and it
      // cites the 11-24 note by its date, so it blocked): a cell that only says "no value" states nothing and is left out of the row's fact.
      l = l.replace(/^\||\|$/g, '').split('|').map(c => c.replace(/\*\*|__|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()).filter(c => c && !NO_VALUE_CELL.test(c)).join(' · '); row = true
    }
    l = l.replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()
    if (l) out.push({ text: l, row, structured: row || listItem })
  }
  return out
}
// Cycle 50 (c64, Main's measure of c49's plan on the recorded V2 request: "11월 6일 v1 발송 순서이고" .29, the same fact with its ending cut "11월 6일 v1 발송 순서" .84, the natural noun phrase 1.0, the
// V1 clause "11월 6일에 v1을 보냈으며" 1.0): the cause is the COPULAR connective on a noun ("…순서이고"), not the noun. A clause cut from its sentence at the comma keeps the copula that joined it to the next
// clause, and the judge reads "X이고" as an unfinished claim. Only the copular endings (이고, 이며, 이지만, 이면서) are cut, and only from a clause split at a comma, never from a whole sentence, a
// table row or a list item. A VERB connective ("보냈으며", "받았고") is left as it is (the judge reads it, c59 1.0, and a cut would leave a bare verb stem), and so is a verb whose stem ends in 이 ("줄이고",
// "높이고", "보이고": the common ones are listed): the cut must leave at least two characters.
const IY_VERB = /(?:높|줄|먹|붙|보|쌓|깎|섞|속|녹|끓|맡|넓|좁|죽|굽|묶|엮|갚|밝|낮|맞|웃|울|비|씻|꾸미|바꾸|드러내)$/
export function trimCopular(clause) {
  const m = /^(.*\S)(이고|이며|이지만|이면서)$/.exec(String(clause ?? '').trim())
  return m && m[1].length >= 2 && !IY_VERB.test(m[1]) ? m[1] : String(clause ?? '').trim()
}
function factUnits(answer) {
  const anchored = t => { const a = factAnchors(t); return a.dates.length + a.versions.length + a.amounts.length > 0 }
  const out = taggedUnits(answer).flatMap(u => {
    const text = clean(u.text, SKELETON_LIMITS.answerMax)
    if (u.row) return [{ text, structured: true }]
    return text.split(/\n|(?<=[.!?。])\s+/).flatMap(sentence => {
      const clauses = sentence.split(/[,;]\s+/).map(t => t.trim()).filter(Boolean)
      return (clauses.length > 1 && clauses.every(anchored) ? clauses.map(trimCopular) : [sentence.trim()]).map(t => ({ text: t, structured: u.structured }))
    })
  })
  return out.map(u => ({ ...u, text: clean(u.text, SKELETON_LIMITS.factMax) })).filter(u => u.text)
}
function factSentences(answer) { return factUnits(answer).map(u => u.text) }
const DATE_ANY = /(?<!\d)(\d{1,2})\s?월\s?(\d{1,2})\s?일|(?<![\d/.])(\d{1,2})[/.](\d{1,2})(?![\d/.])/g
const AMOUNT = /\d{1,3}(?:,\d{3})+|\d+(?=\s?(?:원|개|%|명|건|대|일간))/g
/** Cycle 30: an amount is in a text only as a whole number (never inside another number or a date): c29 cited every material containing the digit 9 for "9개 파일". */
export const amountIn = (text, amount) => new RegExp(`(?<![\\d,.])${String(amount).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\d]|,\\d)`).test(String(text))
/** What a fact can be told apart by: its dates, version marks and amounts (code-readable anchors). */
export function factAnchors(text) {
  const t = String(text ?? '')
  const dates = [...t.matchAll(DATE_ANY)].map(m => ({ month: Number(m[1] ?? m[3]), day: Number(m[2] ?? m[4]) })).filter(d => d.month >= 1 && d.month <= 12 && d.day >= 1 && d.day <= 31)
  const versions = [...t.matchAll(new RegExp(VERSION_MARK.source, 'gi'))].map(m => Number(m[1] ?? m[2] ?? m[3]))
  const amounts = [...t.replace(DATE_ANY, ' ').matchAll(AMOUNT)].map(m => m[0])
  return { dates, versions, amounts }
}
/** Which materials a fact cites, by code: a material that has one of the fact's dates, version marks or amounts. null = the fact has no anchor (unknown: every
 *  material may hold it); [] = it has anchors and no material has any of them (no part could show it). */
export function factCites(text, materials) {
  const a = factAnchors(text)
  if (!a.dates.length && !a.versions.length && !a.amounts.length) return null
  return materials.filter(m => {
    const body = `${m.title} ${m.text}`
    const marks = [...body.matchAll(new RegExp(VERSION_MARK.source, 'gi'))].map(x => Number(x[1] ?? x[2] ?? x[3]))
    return a.dates.some(d => dateMatches(d, { at: m.at, text: body })) || a.versions.some(n => marks.includes(n)) || a.amounts.some(x => amountIn(body, x))
  }).map(m => m.alias)
}

// Cycle 27 (Main, R3): the materials the ANSWER cites stay on the board even when request relevance dropped them, so a fact the answer states is not lost to the chat.
// Found by code, per fact of the answer (all its sentences, not only the six the coverage asks): its specific anchors - lane-cycle ids ("L7 c19"), version marks,
// amounts - cite the materials that carry them; a date cites only when the fact has no specific anchor (a date alone is shared by a whole day of records).
const LANE_CYCLE_ID = /(?<![A-Za-z0-9])([A-Za-z]\d{1,2})\s?(c\d{1,3})(?![A-Za-z0-9])/gi
const laneCycleIds = t => [...String(t).matchAll(LANE_CYCLE_ID)].map(m => `${m[1]} ${m[2]}`.toLowerCase())
export function answerCited(answer, materials) {
  const cited = new Set()
  for (const fact of factSentences(answer)) {
    const a = factAnchors(fact), ids = laneCycleIds(fact)
    const specific = ids.length || a.versions.length || a.amounts.length
    for (const m of materials) {
      const body = `${m.title} ${m.text}`
      const marks = [...body.matchAll(new RegExp(VERSION_MARK.source, 'gi'))].map(x => Number(x[1] ?? x[2] ?? x[3])), own = laneCycleIds(body)
      const hit = specific ? ids.some(id => own.includes(id)) || a.versions.some(n => marks.includes(n)) || a.amounts.some(x => amountIn(body, x)) : a.dates.some(d => dateMatches(d, { at: m.at, text: body }))
      if (hit) cited.add(m.alias)
    }
  }
  return [...cited]
}

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
export async function runSkeletonFlow({ request = '', answer = '', materials = [], candidates = [], currentAnswerId = null, viewport = null, judge, fill = null, egress = null, allow = async () => true, observeOnly = false, catalog = BRIEFING_CATALOG, now = Date.now, bindings = null, fillCheck = 'all', coverageCheck = 'facts', layers = false, prefill = false } = {}) {
  const checkMode = FILL_CHECK_MODES.includes(fillCheck) ? fillCheck : 'all', coverageMode = COVERAGE_MODES.includes(coverageCheck) ? coverageCheck : 'facts'
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
  // Cycle 41 (L2's V1 analysis: request 6 was byte-identical to request 4, 3,813 tokens, its answers the same by construction): a judgment asked again with exactly the same stage, questions
  // and quoted board is answered from the earlier answer, not asked again. Only an answer that came back is kept (never an unavailable one).
  const answered = new Map()
  const ask = async (stage, questions, extra = {}) => {
    const key = JSON.stringify([stage, questions.slice(0, SKELETON_LIMITS.maxQuestions), extra])
    if (answered.has(key)) { stats.reused = (stats.reused ?? 0) + 1; return { answers: answered.get(key) } }
    const reply = await askNew(stage, questions, extra)
    if (reply.answers) answered.set(key, reply.answers)
    return reply
  }
  const askNew = async (stage, questions, extra = {}) => {
    if (stats.judgeRequests >= SKELETON_LIMITS.maxRequests || stats.judgeMs >= SKELETON_LIMITS.judgeMs) return { unavailable: 'request-bound' }
    const quoteAnswer = said && (stage === 'place' || (stage === 'coverage' && !extra.board))
    const prepared = await judge.prepare({ stage, ...base, ...(quoteAnswer ? { answer: said } : {}), ...extra, questions: questions.slice(0, SKELETON_LIMITS.maxQuestions) })
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
  const relevance = relevanceQuestions(scene.materials, asked), pairs = versionCandidates(scene.materials)
  // the content question when the answer is at hand; the length question only without it (the earlier path)
  const placed = await ask('place', [...(said ? [{ kind: 'combines' }] : [{ kind: 'several' }, { kind: 'one_sentence' }]), ...relevance.map(q => ({ kind: 'about', material: q.material })), ...pairs.map(materials => ({ kind: 'same', materials }))])
  if (placed.unavailable) return unavailable(placed, false)
  if (placed.advisory !== undefined) {
    const fits0 = fitQuestions(scene)
    if (placed.advisory === 'board' && fits0.length) await ask('fit', fits0)
    return done('advisory-only', { verdict: placed.advisory, requested: true })
  }
  // Code drops what the request does not ask about (decided no or undecided) and adds the version pairs the judge confirmed; the scene is built again from that.
  const relevant = new Set(relevance.filter(q => isYes(placed.answers[`about_${q.material}`])).flatMap(q => q.covers))
  // (cycle 27) and what the answer itself cites stays, whatever relevance said; recorded apart
  const citedOnly = (said ? answerCited(answer, scene.materials) : []).filter(a => !relevant.has(a))
  // Cycle 41 (check-22br, schema-off: about_M11 .56): a material the judge is UNDECIDED about stays when the records link it to a material it is sure about (one matter: the follows_from chain of
  // a log). Leaving it out removed one entry from the middle of a sequence and its figure ("269ms") from the board. A decided no still drops it; the rule is one step, not transitive.
  const linked = new Set(relevance.filter(q => { const p = placed.answers[`about_${q.material}`]; return Number.isFinite(p) && !isYes(p) && !isNo(p) && q.covers.some(a => !relevant.has(a)) })
    .flatMap(q => q.covers).filter(a => !relevant.has(a) && scene.materials.some(m => (m.alias === a && m.links.some(l => relevant.has(l.to))) || (relevant.has(m.alias) && m.links.some(l => l.to === a)))))
  // Cycle 44 (check-29br schema-on: about_M12 .26, the 02:31 entry with "1,812", dropped before the fill, so no later check could see the loss; seen before: M10 .11 / .05 / .10 and M12 .23 in four
  // more of twelve recorded runs, while the other five or six entries of the same log were sure). One judged yes/no per entry is one sample; an entry of a recorded LOG (materials the records chain
  // as one matter, at least four) that the judge answers NO for stays when at least three other entries of that log are sure and they are at least two thirds of the log's other entries: the
  // log is the unit the request asks about ("read the ledger"), the entry's own answer is one vote. DELIBERATE CHANGE of the c41 rule "a decided no still drops it": that holds for a
  // log the other entries do not vote for (and for an entry without a log). Recorded as relevance.voted; the vote never adds an entry a question was not asked about.
  const voted = new Set()
  for (const group of materialGroups(scene.materials)) {
    if (group.length < 4) continue
    for (const m of group) {
      const own = relevance.find(q => q.material === m.alias && q.covers.length === 1), p = own ? placed.answers[`about_${m.alias}`] : undefined
      if (!own || !Number.isFinite(p) || isYes(p) || relevant.has(m.alias) || citedOnly.includes(m.alias) || linked.has(m.alias)) continue
      const others = group.filter(x => x.alias !== m.alias), sure = others.filter(x => relevant.has(x.alias)).length
      if (sure >= 3 && sure * 3 >= others.length * 2) voted.add(m.alias)
    }
  }
  const kept = new Set(scene.materials.map(m => m.alias).filter(a => relevant.has(a) || citedOnly.includes(a) || linked.has(a) || voted.has(a)))
  const dropped0 = scene.materials.filter(m => !kept.has(m.alias)).map(m => m.alias), versions = pairs.filter(([a, b]) => isYes(placed.answers[`same_${a}_${b}`]))
  relevanceOut = { kept: [...kept], dropped: dropped0, versions, ...(citedOnly.length ? { cited: citedOnly } : {}), ...(linked.size ? { linked: [...linked] } : {}), ...(voted.size ? { voted: [...voted] } : {}) }
  const place = decidePlace(placed.answers, { relevant: kept.size })
  if (place.value !== 'board') return done('bubble', { reason: place.reason, requested: true, place: placed.answers })
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
  // Why the last request produced nothing: the engine says 'timeout' | 'no-reply' | 'refused' | 'unusable' (a fill function without lastFailure is read as unusable).
  const failureOf = () => (typeof fill.lastFailure === 'function' ? fill.lastFailure() : null)
  const fillOnce = async (only, rejected = [], cover = [], long = []) => {
    if (stats.fillTurns >= SKELETON_LIMITS.fillTurns) return { bound: true }
    stats.fillTurns++
    const want = fillRequest(guide, scene.materials, only, rejected, cover, long)
    stats.received.push({ turn: stats.fillTurns, keys: Object.keys(want), items: want.guide.items.map(i => `${i.id}:${i.component}`), materials: want.materials.map(m => m.alias), ...(rejected.length ? { rejected } : {}), ...(cover.length ? { cover } : {}), ...(long.length ? { long } : {}) })
    const reply = await fill(want)
    return { ...validateFill(guide, reply, { only, materials: scene.materials }), failure: reply === null || reply === undefined ? failureOf() : null }
  }
  // Cycle 34 (owner rule U5): when the whole fill did not come back, ONE bounded re-design round asks for the items one by one (each reply is short, so each is asked inside
  // its own time); the title is the first piece's. Not for a single item (nothing to split) and at most SKELETON_LIMITS.pieceTurns requests; any piece unusable -> stop.
  const fillInPieces = async () => {
    if (items.length < 2 || items.length > SKELETON_LIMITS.pieceTurns || stats.fillTurns >= SKELETON_LIMITS.fillTurns) return null
    stats.fillTurns++; stats.pieces = []
    const all = { ok: true, title: null, items: {}, issues: [] }
    for (const item of items) {
      stats.pieceTurns = (stats.pieceTurns ?? 0) + 1
      const only = new Set([item.id]), want = fillRequest(guide, scene.materials, only)
      stats.received.push({ turn: stats.fillTurns, piece: item.id, keys: Object.keys(want), items: want.guide.items.map(i => `${i.id}:${i.component}`), materials: want.materials.map(m => m.alias) })
      const reply = await fill(want), read = validateFill(guide, reply, { only, needTitle: true, materials: scene.materials })
      stats.pieces.push({ item: item.id, ok: read.ok, ...(read.ok ? {} : { reason: read.reason }), ...(reply === null || reply === undefined ? { failure: failureOf() } : {}) })
      if (!read.ok) return { ok: false, reason: `piece-${read.reason}`, failure: reply === null || reply === undefined ? failureOf() : null }
      all.title ??= read.title; Object.assign(all.items, read.items); all.issues.push(...read.issues)
    }
    return all
  }
  let got = await fillOnce(null)
  // Cycle 45 (EGDESK_BRIEFING_PREFILL=on): a prefill run, started while the answer is still being written, stops after its first fill request, whatever came back: that request is the point of it (the
  // route keeps the reply by the request's hash, egdesk-briefing-prefill.mjs). No retry, no pieces, no check, no coverage: everything that is published comes only from the run after the answer.
  if (prefill) return done(got.ok ? 'prefilled' : 'prefill-failed', { requested: true })
  if (!got.bound && !got.ok && got.failure !== 'timeout') got = await fillOnce(null) // one retry for a reply that is not the asked shape (not after a timeout: the same request would time out again)
  if (!got.bound && !got.ok) { const pieces = await fillInPieces(); if (pieces) { stats.pieceRound = true; if (pieces.ok) got = pieces } } // a failed round keeps the whole fill's reason as the detail (the pieces' own are in stats.pieces)
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
      // c40: the lines that ran over their limit are named by line ("P1 line 3") for the one rewrite
      if (mine.length) { failing.set(item.id, { problem: mine.some(x => x.kind === 'empty') ? 'slot_empty' : 'slot_mismatch', words: [], long: mine.flatMap(x => (x.long ?? []).map(n => `${item.id} line ${n}`)) }); continue }
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
      // Cycle 44 (EGDESK_BRIEFING_LAYERS=on, default off; check-29br schema-off: step_P2 .65 on a sentence with no figure while all six of its rows were sure cost a whole 29.5 s fill turn, and the
      // rewrite's sentence was no better): the card's own pieces are what the Decision settles; a step sentence that is only UNDECIDED (not a decided no) stays when every piece of its card is sure.
      const pieceSure = part => questions.every(x => x.part !== part || x.kind === 'step' || isYes(judged.answers[questionName(x)]))
      for (const q of questions.slice(0, SKELETON_LIMITS.maxQuestions)) if (!isYes(judged.answers[questionName(q)])) { if (layers && q.kind === 'step' && !isNo(judged.answers[questionName(q)]) && Number.isFinite(judged.answers[questionName(q)]) && pieceSure(q.part)) { stats.stepKept = [...(stats.stepKept ?? []), q.part]; continue } const f = failing.get(q.part) ?? { problem: 'unsupported', words: [] }; f.words.push(rejectedWord(q)); failing.set(q.part, f) }
      for (const q of questions.slice(SKELETON_LIMITS.maxQuestions)) failing.set(q.part, failing.get(q.part) ?? { problem: 'unsupported', words: [rejectedWord(q)] })
    }
    if (!failing.size) break
    // What happens to a failing part is a rule: missing data -> the next way of showing it that was judged to fit, else leave it out; anything else -> written again
    // once, with the closed words for what was not supported, else leave it out.
    const again = new Set(), words = [], longs = []
    for (const [id, f] of failing) {
      const index = items.findIndex(i => i.id === id), item = items[index], part = scene.parts.find(p => p.alias === id)
      const next = f.problem === 'slot_empty' ? (alternatives.get(id) ?? []).find(o => !item.tried.includes(o.value)) : null
      if (next) { const swapped = itemFor({ ...part, materials: item.materials }, next, scene, 0); items[index] = { ...swapped, creates: swapped.creates ? item.creates ?? 'N' + (++n) : null, tried: [...item.tried, next.value] }; delete filled[id]; again.add(id); rejections.push({ part: id, problem: f.problem, action: next.value }); continue }
      if (f.problem !== 'slot_empty' && !item.refilled) { items[index] = { ...item, refilled: true }; again.add(id); words.push(...f.words); longs.push(...(f.long ?? [])); rejections.push({ part: id, problem: f.problem, action: 'rewrite', words: f.words }); continue }
      items.splice(index, 1); delete filled[id]; dropped.push({ part: id, why: f.problem, words: f.words }); rejections.push({ part: id, problem: f.problem, action: 'drop', words: f.words })
    }
    if (!items.length) return done('fallback-chat', { reason: 'nothing-left', rejections })
    issues = []; pending = again
    if (!again.size) break
    layout = layoutSkeleton(items, scene, viewport); guide = buildGuide(items, scene, retire())
    const rewritten = await fillOnce(again, words, [], longs)
    if (rewritten.bound || !rewritten.ok) return done('fallback-chat', { reason: rewritten.bound ? 'fill-bound' : 'fill-invalid', detail: rewritten.reason, rejections })
    Object.assign(filled, rewritten.items); issues = rewritten.issues
  }
  // (e) Coverage. Default (cycle 21, R4): the facts the board must show, split and cited by CODE (the answer's clauses; without an answer, the first sentence of each
  // relevant material), each asked alone: "is this fact shown on the board?" with the board quoted once. Code combines: a fact decided NOT shown that some material
  // holds (or that has no code anchor) is missing; a missing fact no material holds is recorded (no part could show it) and does not block; undecided does not block.
  // Missing facts -> ONE bounded re-design: add the catalog parts whose fit was UNDECIDED and whose materials the missing facts cite (a part judged not to fit stays out),
  // fill and check only them, ask the missing facts again; still missing, or nothing to add -> the chat answer.
  // 'board' (cycle 19, kept for comparison; EGDESK_BRIEFING_COVERAGE=board): one whole-board question; a decided no, or (cycle 21) an undecided answer when a re-design
  // candidate exists, gets the one re-design; a no after it -> the chat answer; an undecided answer with nothing to add -> the board is proposed (recorded).
  // Requests: coverage 1, re-design 2 more (the added parts' check and the coverage again), one more fill turn; SKELETON_LIMITS.maxRequests bounds the rest.
  const boardView = () => items.map(item => ({ text: clean(filled[item.id].text, BRIEFING_LIMITS.textMax), shown: shownFor(item, filled[item.id], scene) }))
  const coverage = { mode: coverageMode, asked: 0, redesign: null }
  const candidatesFor = cites => { const inItems = new Set(items.map(i => i.id))
    return scene.parts.filter(p => !inItems.has(p.alias) && decisions[p.alias] === 'undecided' && !dropped.some(d => d.part === p.alias) && p.options.some(o => o.component) && (cites === null || p.materials.some(a => cites.has(a)))) }
  // Cycle 34 (owner rule U5): no undecided part to add (every part is already a card), but a fact that a material holds is not on the board -> the cards of those materials are
  // written AGAIN, once, with the closed list of the materials whose statements they must carry (aliases only, never the answer's text); checked like any fill (code rules, the
  // support questions) and asked again by the coverage question; still missing -> the chat answer.
  const rewriteCovering = async cites => {
    const targets = items.filter(i => cites === null || i.materials.some(a => cites.has(a)))
    if (!targets.length) return done('fallback-chat', { reason: 'not-covered', coverage })
    const cover = [...new Set(targets.flatMap(i => i.materials).filter(a => cites === null || cites.has(a)))].slice(0, 12)
    coverage.redesign = { parts: [], from: 'rewrite', because: 'fact-missing', items: targets.map(i => i.id), cover }
    const ids = new Set(targets.map(i => i.id)), before = Object.fromEntries(targets.map(i => [i.id, filled[i.id]]))
    const one = await fillOnce(ids, [], cover)
    if (one.bound || !one.ok || one.issues.length) return done('fallback-chat', { reason: one.bound ? 'fill-bound' : 'not-covered', coverage })
    Object.assign(filled, one.items)
    for (const item of targets) { const cap = layout.capacity.get(item.id), md = markdownOf(item); if (md !== null && cap && textLines(md, cap.widthPx) > cap.lines) { Object.assign(filled, before); return done('fallback-chat', { reason: 'not-covered', coverage }) } }
    const checked = targets.map(item => fillChecks(item, filled[item.id], scene, catalog, { mode: checkMode })), questions = checked.flatMap(c => c.questions)
    if (checked.some(c => c.failures.length)) return done('fallback-chat', { reason: 'not-covered', coverage })
    if (questions.length) {
      const verdict = await ask('fill_check', questions); if (verdict.unavailable) return unavailable(verdict, true)
      const failed = questions.filter(q => !isYes(verdict.answers[questionName(q)]))
      // Cycle 42 (check-25br, schema-on: step_P2 .42 after a rewrite whose 12 rows were all supported): when only a step EXPLANATION is refused, the cards stay and the explanation that was already
      // judged supported before the rewrite (step_P2 .86) comes back; a refused row still ends the round (the chat answer stays).
      if (failed.some(q => q.kind !== 'step')) return done('fallback-chat', { reason: 'not-covered', coverage })
      for (const q of failed) { if (before[q.part]) { filled[q.part] = { ...filled[q.part], text: before[q.part].text, ...(before[q.part].fallback !== undefined ? { fallback: before[q.part].fallback } : {}) } } }
      if (failed.length) coverage.explanationKept = failed.map(q => q.part)
    }
    return null
  }
  const redesign = async (parts, because) => {
    const added = parts.slice(0, Math.max(0, SKELETON_LIMITS.maxParts - items.length)).map(part => { const option = part.options.find(o => o.component); return { part, option, item: itemFor(part, option, scene, ++n) } })
    coverage.redesign = { parts: added.map(a => ({ part: a.part.alias, trait: a.part.trait, component: a.option.value })), from: 'undecided-part', because }
    items = [...items, ...added.map(a => a.item)]; layout = layoutSkeleton(items, scene, viewport); guide = buildGuide(items, scene, retire())
    const one = await fillOnce(new Set(added.map(a => a.item.id)))
    if (one.bound || !one.ok || one.issues.length) return done('fallback-chat', { reason: one.bound ? 'fill-bound' : 'not-covered', coverage })
    Object.assign(filled, one.items)
    const checked = added.map(a => fillChecks(a.item, filled[a.item.id], scene, catalog, { mode: checkMode }))
    const verdict = await ask('fill_check', checked.flatMap(c => c.questions))
    if (verdict.unavailable) return unavailable(verdict, true)
    if (checked.some(c => c.failures.length || c.questions.some(q => !isYes(verdict.answers[questionName(q)])))) return done('fallback-chat', { reason: 'not-covered', coverage })
    return null
  }
  if (coverageMode === 'board') {
    const askBoard = async () => { coverage.asked++; const r0 = await ask('coverage', [{ kind: 'covers', board: boardView() }]); if (!r0.unavailable) coverage.p = r0.answers.covers ?? null; return r0 }
    let covered = await askBoard()
    if (covered.unavailable) return unavailable(covered, true)
    const parts = isYes(coverage.p) ? [] : candidatesFor(null).slice(0, 1)
    if (isNo(coverage.p) && !parts.length) return done('fallback-chat', { reason: 'not-covered', coverage })
    if (parts.length) {
      const stop = await redesign(parts, isNo(coverage.p) ? 'board-no' : 'board-undecided')
      if (stop) return stop
      covered = await askBoard()
      if (covered.unavailable) return unavailable(covered, true)
      if (isNo(coverage.p)) return done('fallback-chat', { reason: 'not-covered', coverage })
    }
  } else {
    const keptMats = scene.materials.filter(m => kept.has(m.alias))
    const factCap = SKELETON_LIMITS.maxFacts * SKELETON_LIMITS.factRequests
    const split = said ? answerFacts(answer) : { facts: keptMats.slice(0, factCap).map(m => clean(m.text.split(/(?<=[.!?。])\s+/)[0], SKELETON_LIMITS.factMax)).filter(Boolean), cut: Math.max(0, keptMats.length - factCap) }
    const facts = split.facts.map((text, i) => ({ id: `F${i + 1}`, text, cites: said ? factCites(text, keptMats) : [keptMats[i].alias], p: null }))
    Object.assign(coverage, { from: said ? 'answer' : 'materials', facts, cut: split.cut, missing: [], unshowable: [] })
    // Cycle 36: a fact with no code anchor (cites null) also gets the question "does it restate something the materials say?" in the same request (first ask only). Decided NO
    // (a sentence about the answer itself) = no board can show it: recorded as unshowable, not missing. Yes or undecided = it is enforced as before.
    // Cycle 38 (Main): at most SKELETON_LIMITS.maxFacts facts per request; an answer of more facts (up to 12) gets ONE more request for the rest, bounded. Each request quotes the
    // board once; the stated question is only for the facts of that request.
    const askFacts = async (list, withStated = false) => {
      let last = null
      for (let i = 0; i < list.length && i < SKELETON_LIMITS.maxFacts * SKELETON_LIMITS.factRequests; i += SKELETON_LIMITS.maxFacts) {
        const chunk = list.slice(i, i + SKELETON_LIMITS.maxFacts); coverage.asked++
        const stated = withStated ? chunk.filter(f => f.cites === null).map(f => ({ kind: 'stated', fact: f.id, text: f.text })) : []
        const r0 = await ask('coverage', [...chunk.map(f => ({ kind: 'onboard', fact: f.id, text: f.text })), ...stated], { board: boardView() })
        if (r0.unavailable) return r0
        for (const f of chunk) { f.p = r0.answers[`onboard_${f.id}`] ?? null; if (withStated && f.cites === null) f.stated = r0.answers[`stated_${f.id}`] ?? null }
        last = r0
      }
      return last ?? { answers: {} }
    }
    const moot = f => f.cites?.length === 0 || (f.cites === null && isNo(f.stated))
    const sortOut = () => { const no = facts.filter(f => isNo(f.p)); coverage.unshowable = no.filter(moot).map(f => f.id); coverage.missing = no.filter(f => !moot(f)).map(f => f.id); return facts.filter(f => coverage.missing.includes(f.id)) }
    if (facts.length) {
      const r1 = await askFacts(facts, true)
      if (r1.unavailable) return unavailable(r1, true)
      const missing = sortOut()
      if (missing.length) {
        const cites = missing.some(f => f.cites === null) ? null : new Set(missing.flatMap(f => f.cites))
        const parts = candidatesFor(cites)
        const stop = parts.length ? await redesign(parts, 'fact-missing') : await rewriteCovering(cites)
        if (stop) return stop
        const r2 = await askFacts(missing)
        if (r2.unavailable) return unavailable(r2, true)
        if (sortOut().length) return done('fallback-chat', { reason: 'not-covered', coverage })
      }
    }
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
    reuse: { reuse: [...used()], retire: [...guide.retrievals], created: newComponents.map(c => c.component) }, guide, decisions, coverage, order: { ties: ordering.ties.map(([a, b]) => `${a.id}/${b.id}`), answers: orderAnswers }, repaired, rejections, dropped, revisions: rejections.filter(r => r.action === 'rewrite').length })
}
