import { CANVAS_VIEW_SIZES } from '../overlay/resources/EGDeskSurfaceState.sys.mjs'

// Answer Briefing component catalog, AS DATA (cycle 13). The pattern is AG-UI style generative UI ("predefined blocks into which a model's data is mapped"), without any
// dependency: every entry names a component EG-Desk can really render TODAY, its slot schema, the kind of material it suits and size hints taken from the product's own
// size table and stylesheet. The Decision model chooses among these ids; the subjective model only fills the slots; CODE turns filled slots into the component.
//
// What was verified in the surface (see BRIEFING_RENDERERS for the record, a test pins each line against the source):
//   - a result card renders its text through EGDeskMarkdown.appendMarkdown: line breaks, bold/italic, inline code, code fences, links. NOTHING else: no table,
//     no checkbox list, no heading or list structure (they stay literal text). So there is NO table and NO checklist component here. The three card components below
//     are templates over that one real renderer (bold label + text per line), not new renderers.
//   - a briefing step points at 1..6 targets with emphasis spotlight | outline and the stage frames all of them (EGDeskBriefingState).
//   - through this flow only a published result card can be bound as a target (its outputId); a memo, a file viewer or a browser card on the board cannot be bound
//     here, and no Agent path creates them, so they are not components of this catalog.
// Extending: registerComponent(catalog, entry, render) returns a NEW catalog; a component is offered as soon as its entry says what it suits.

/** The result card's own numbers. Size: EGDeskSurfaceState CANVAS_VIEW_SIZES.result. The rest: eg-desk-surface.uc.css (.egd-card-header, .egd-result-card .egd-card-body, .egd-result-card-source). */
export const RESULT_CARD_METRICS = Object.freeze({
  width: CANVAS_VIEW_SIZES.result.width, height: CANVAS_VIEW_SIZES.result.height, minWidth: CANVAS_VIEW_SIZES.result.minWidth, minHeight: CANVAS_VIEW_SIZES.result.minHeight,
  headerPx: 52,   // .egd-card-header min-height
  padX: 14, padY: 12, gapPx: 10, // .egd-result-card .egd-card-body padding 12px 14px, gap 10px
  sourcePx: 37,   // .egd-result-card-source: a 28px button row + 8px padding-bottom + 1px line
  fontPx: 13, linePx: 20.8, // font: 13px/1.6
})
/** How many text lines and how many px of text width a result card shows without scrolling. */
export function resultCardCapacity(size = RESULT_CARD_METRICS) {
  const m = RESULT_CARD_METRICS, width = Number.isFinite(size?.width) ? size.width : m.width, height = Number.isFinite(size?.height) ? size.height : m.height
  return { lines: Math.max(1, Math.floor((height - m.headerPx - 2 * m.padY - m.sourcePx - m.gapPx) / m.linePx)), widthPx: Math.max(1, width - 2 * m.padX) }
}
// An estimate, not a measurement of glyphs: a full-width (CJK) character takes one font size, anything else .56 of it. Wrapped lines of pre-wrap text at that width.
const wide = ch => /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uff60\u3000-\u30ff]/.test(ch)
export function textLines(text, widthPx = resultCardCapacity().widthPx, fontPx = RESULT_CARD_METRICS.fontPx) {
  return String(text ?? '').split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil([...line].reduce((w, ch) => w + (wide(ch) ? 1 : .56) * fontPx, 0) / widthPx)), 0)
}

export const MATERIAL_TRAITS = Object.freeze(['compare', 'sequence', 'open_items', 'single'])
export const SLOT_TYPES = Object.freeze(['text', 'material', 'list'])
const text = (name, max) => Object.freeze({ name, type: 'text', max, required: true })
const material = name => Object.freeze({ name, type: 'material', required: true })
const list = (name, min, max, of) => Object.freeze({ name, type: 'list', min, max, required: true, of: Object.freeze(of) })
/** Every briefing step, whatever it points at, has these two slots (EGDeskBriefingState: step text and its fallback). */
export const STEP_SLOTS = Object.freeze([text('text', 240), text('fallback', 400)])
const CARD = Object.freeze({ surface: 'result card', via: 'egdesk_publish_output -> spawnResultCard -> EGDeskMarkdown.appendMarkdown', creates: 'result' })
const card = (lines, rowLines = 0) => Object.freeze({ width: RESULT_CARD_METRICS.width, height: RESULT_CARD_METRICS.height, minWidth: RESULT_CARD_METRICS.minWidth, minHeight: RESULT_CARD_METRICS.minHeight, baseLines: lines, rowLines })

const ENTRIES = [
  { id: 'result_compare', label: 'two versions set against each other, one line per aspect', renderer: CARD, suits: ['compare'],
    purpose: { compare: 'a new card that sets the two versions against each other, one line per aspect: the old value, then the new value. It needs a value for the same aspect in BOTH versions.' }, needs: { materials: { min: 2, max: 2 }, existing: 0 }, emphasis: 'outline',
    slots: [text('title', 40), material('left'), material('right'), list('rows', 1, 6, [text('aspect', 20), text('left', 60), text('right', 60)])], size: card(1, 3) },
  { id: 'step_pair', label: 'the two existing cards shown together in one step', renderer: Object.freeze({ surface: 'briefing step', via: 'egdesk_publish_briefing_multi: two targets, outline emphasis', creates: null }), suits: ['compare'],
    purpose: { compare: 'one briefing step that shows the two cards of these two versions, which are already on the board, together. Nothing new is made.' },
    needs: { materials: { min: 2, max: 2 }, existing: 2 }, emphasis: 'outline', slots: [], size: null },
  { id: 'result_lines', label: 'an ordered list of short lines, one per item', renderer: CARD, suits: ['sequence', 'open_items'],
    purpose: { sequence: 'a new card with a short list in date order: one line of plain text per material, saying what happened then. It is a plain list, not a table and not a chart.',
      open_items: 'a new card with a short list of what is not done yet: one line of plain text per open item. It is a plain list, not a table and not a chart.' }, needs: { materials: { min: 1, max: 8 }, existing: 0 }, emphasis: 'spotlight',
    // At least one line (cycle 16): an open plan may name a single remaining step. A sequence has two or more lines by construction (code enumerates it from two or more dated materials).
    slots: [text('title', 40), list('lines', 1, 6, [text('label', 24), text('text', 90), material('from')])], size: card(0, 3) },
  { id: 'result_text', label: 'one short text card', renderer: CARD, suits: ['single'],
    purpose: { single: 'a new card with one short paragraph of plain text about this one material. It is plain text, not a table and not a chart.' }, needs: { materials: { min: 1, max: 1 }, existing: 0 }, emphasis: 'spotlight',
    slots: [text('title', 40), text('body', 600)], size: card(0, 0) },
]
const freezeEntry = e => Object.freeze({ ...e, purpose: Object.freeze({ ...(e.purpose ?? {}) }), suits: Object.freeze([...e.suits]), needs: Object.freeze({ materials: Object.freeze({ ...e.needs.materials }), existing: e.needs.existing }), slots: Object.freeze([...e.slots]) })

// Templates over the result card's real renderer: bold label, plain text, one line each. Values are slot data only; nothing here adds a word of its own.
const esc = value => String(value).replace(/[\\`*_[\]<>]/g, '\\$&').replace(/\s+/g, ' ').trim()
const RENDERERS = {
  result_compare: slots => slots.rows.map(row => `**${esc(row.aspect)}** ${esc(row.left)} → ${esc(row.right)}`).join('\n'),
  result_lines: slots => slots.lines.map(line => `**${esc(line.label)}** ${esc(line.text)}`).join('\n'),
  result_text: slots => esc(slots.body),
}

function build(entries, renderers) {
  const byId = new Map(entries.map(e => [e.id, e]))
  return Object.freeze({
    version: 1,
    ids: Object.freeze(entries.map(e => e.id)),
    entries: Object.freeze(entries),
    get: id => byId.get(id) ?? null,
    /** Components that suit a trait, in catalog order. */
    suiting: trait => entries.filter(e => e.suits.includes(trait)),
    /** The markdown of a component from validated slot data, or null for a component that creates nothing. */
    render: (id, slots) => (typeof renderers[id] === 'function' ? renderers[id](slots) : null),
    renderers: Object.freeze({ ...renderers }),
  })
}
const validSlot = s => s && typeof s.name === 'string' && /^[a-z][a-z_]{0,23}$/.test(s.name) && SLOT_TYPES.includes(s.type) &&
  (s.type !== 'text' || (Number.isInteger(s.max) && s.max > 0 && s.max <= 2000)) &&
  (s.type !== 'list' || (Number.isInteger(s.min) && Number.isInteger(s.max) && s.min >= 0 && s.max >= s.min && s.max <= 12 && Array.isArray(s.of) && s.of.length > 0 && s.of.every(f => f.type !== 'list' && validSlot(f))))
/** A new catalog with one more component. The entry must be complete data; a component that creates a card needs its render function. Never mutates the given catalog. */
export function registerComponent(catalog, entry, render = null) {
  if (!entry || typeof entry.id !== 'string' || !/^[a-z][a-z0-9_]{1,31}$/.test(entry.id) || catalog.get(entry.id)) throw new TypeError('component id must be new and closed')
  if (!Array.isArray(entry.suits) || !entry.suits.length || !entry.suits.every(t => MATERIAL_TRAITS.includes(t))) throw new TypeError('suits must name known material traits')
  if (!Array.isArray(entry.slots) || !entry.slots.every(validSlot)) throw new TypeError('slots must be a valid slot schema')
  // The Decision model is asked about a component in plain language (cycle 15): every trait it suits needs one sentence saying what it shows and what it is not.
  if (!entry.suits.every(t => typeof entry.purpose?.[t] === 'string' && entry.purpose[t].length >= 20 && entry.purpose[t].length <= 300 && !/[\u0000-\u001f]/.test(entry.purpose[t]))) throw new TypeError('purpose must describe the component for every trait it suits')
  if (!entry.needs?.materials || !Number.isInteger(entry.needs.materials.min) || !Number.isInteger(entry.needs.materials.max) || !Number.isInteger(entry.needs.existing)) throw new TypeError('needs must be numbers')
  if (entry.renderer?.creates && typeof render !== 'function') throw new TypeError('a component that creates a card needs a render function')
  return build([...catalog.entries, freezeEntry(entry)], render ? { ...catalog.renderers, [entry.id]: render } : catalog.renderers)
}
export const BRIEFING_CATALOG = build(ENTRIES.map(freezeEntry), RENDERERS)

/** What the surface can and cannot render for this flow today. `pin` is a piece of product source a test looks for, so this record cannot drift silently. */
export const BRIEFING_RENDERERS = Object.freeze([
  { what: 'result card with text (line breaks, bold, italic, inline code, code fence, link)', available: true, file: 'overlay/resources/EGDeskMarkdown.sys.mjs', pin: 'export function appendMarkdown(container, text, context = {})' },
  { what: 'briefing step with 1..6 targets and emphasis spotlight | outline', available: true, file: 'overlay/resources/EGDeskBriefingState.sys.mjs', pin: "export const BRIEFING_EMPHASIS = Object.freeze(['spotlight', 'outline']);" },
  { what: 'two cards arranged side by side on the user\'s own screen (user-applied arrangement "pair"); not proposable from this flow yet', available: false, file: 'overlay/resources/EGDeskJointPresentation.sys.mjs', pin: "pair: '선택한 두 장 나란히 비교'" },
  { what: 'table', available: false, file: 'overlay/resources/EGDeskMarkdown.sys.mjs', absent: ['<table', "'table'", "element('tr'"] },
  { what: 'checklist (checkbox list)', available: false, file: 'overlay/resources/EGDeskMarkdown.sys.mjs', absent: ['checkbox', "element('li'", "element('ul'"] },
  { what: 'memo card as a target or as a new component (user-made only; this flow cannot bind it)', available: false, file: 'overlay/resources/EGDeskBriefingHost.sys.mjs', pin: "out.push({ id: c.id, ref: {}, kind: 'source', label: `메모 " },
  { what: 'file viewer opened by an Agent (opens on the user\'s click only)', available: false, file: 'overlay/resources/surface/EGDeskSurfaceFileCard.mjs', pin: "if (runFile && !verifiedRunOpens.delete(runFile)) throw new Error('확인된 실행 파일 요청이 필요합니다.');" },
])
