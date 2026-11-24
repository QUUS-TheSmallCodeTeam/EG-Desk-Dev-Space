import { randomUUID } from 'node:crypto'

/**
 * CNV-05: dynamic tool egdesk_publish_annotation for ordinary Codex Agent
 * threads. The Agent publishes one AnnotationSet (box, ellipse, highlight,
 * line, arrow, label) over a Canvas card or at a free Canvas position. The
 * screen shows it at once as a dotted '제안' over the target card without
 * moving the camera (D-K1) and puts a summary chip under the answer (D-K4).
 * Nothing is saved until 대표님 accepts it; an annotation never acts on the
 * card under it and its geometry is never an input coordinate.
 *
 * Registered like egdesk_propose_plan (egdesk-plan-tool-provider.mjs): its
 * own provider in the bridge's toolProviders list. Bounded/QA threads never
 * receive it (the chat runtime prepares only Context/Browser providers for
 * them) and dispatch refuses a run with an execution policy anyway. Claude
 * threads are excluded in codex-chat-runtime providerSupportsEngine.
 *
 * Validation mirrors overlay/resources/EGDeskAnnotationState.sys.mjs
 * normalizeAnnotationSet (same limits and shapes) but is strict: a bad item
 * is refused with a reason the Agent can fix instead of silently dropped.
 * The screen normalizes again with that module before drawing.
 *
 * Tool result (inputText JSON):
 *   published { status: 'published', setId, itemCount, shown }
 *   invalid   { status: 'invalid', code: 'ANNOTATION_INVALID', reason }   (success: true)
 *   failure   success: false, { error: { code } }
 * A publish also emits the chat event 'annotation.published' { annotation }
 * on the run.
 */

export const ANNOTATION_TOOL_NAME = 'egdesk_publish_annotation'
export const ANNOTATION_PROVIDER_ID = 'egdesk-annotation'

// Same values as EGDeskAnnotationState ANNOTATION_ITEM_TYPES / PURPOSES /
// TARGET_KINDS / GROUNDING / LIMITS (a test keeps them equal).
export const ANNOTATION_ITEM_TYPES = Object.freeze(['box', 'ellipse', 'highlight', 'line', 'arrow', 'label'])
export const ANNOTATION_PURPOSES = Object.freeze(['locate', 'critique', 'evidence', 'instruction', 'diff', 'warning'])
export const ANNOTATION_TARGET_KINDS = Object.freeze(['browser', 'image', 'pdf', 'deck', 'file', 'canvas-region'])
export const ANNOTATION_GROUNDING = Object.freeze(['dom', 'visual', 'both'])
export const ANNOTATION_TOOL_LIMITS = Object.freeze({
  items: 32, label: 120, note: 280, summary: 160, coordinate: 100, canvasCoordinate: 1e7, argumentBytes: 32 * 1024, viewport: 100000,
})

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/
const RECT_TYPES = new Set(['box', 'ellipse', 'highlight'])
const LINE_TYPES = new Set(['line', 'arrow'])
const ITEM_KEYS = new Set(['id', 'type', 'rect', 'from', 'to', 'at', 'label', 'note', 'purpose', 'confidence', 'ref', 'fromItemId', 'toItemId'])
const TOP_KEYS = new Set(['cardId', 'targetKind', 'summary', 'units', 'observation', 'grounding', 'items'])
const OBSERVATION_KEYS = new Set(['documentId', 'revision', 'viewport', 'scroll'])

const point = { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } }

export const ANNOTATION_TOOL_SPECS = Object.freeze([{
  type: 'function',
  name: ANNOTATION_TOOL_NAME,
  description: [
    'Mark places on a Canvas card for the person: boxes, ellipses, highlights, lines, arrows and text labels, for example "find the login button and show me".',
    'The marks appear at once over the card as a dotted suggestion; the camera does not move and nothing is saved until the person accepts them.',
    'A short chip under your answer points to them. Marks never click, type or act on the page, and are never input coordinates.',
    'For a Browser card use its cardId from egdesk_browser_list_cards and the latest egdesk_browser_observe: with units "viewportPx" give element bounds as rect {x, y, w, h} in the observed viewport CSS pixels and copy observation {documentId, revision, viewport, scroll} from that observation;',
    'with units "ratio" (default) every value is a 0..1 fraction of the card content. Without cardId the values are Canvas world pixels.',
    'Put a ref from the observation on a mark that points at an element. Keep labels short. After publishing, reply in one or two sentences; do not list coordinates.',
  ].join(' '),
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['summary', 'items'],
    properties: {
      cardId: { type: 'string', description: 'Canvas card the marks sit on (Browser cardId or a bound source viewId). Omit for a free Canvas position.' },
      targetKind: { type: 'string', enum: [...ANNOTATION_TARGET_KINDS] },
      summary: { type: 'string', description: `What the marks show, as the chip text (<=${ANNOTATION_TOOL_LIMITS.summary} chars).` },
      units: { type: 'string', enum: ['ratio', 'viewportPx'], description: 'ratio (default): 0..1 of the card content; viewportPx: observed viewport CSS pixels (needs observation.viewport).' },
      grounding: { type: 'string', enum: [...ANNOTATION_GROUNDING] },
      observation: {
        type: 'object', additionalProperties: false,
        description: 'The Browser observation the marks were computed from, so the screen can tell when the page changed.',
        properties: {
          documentId: { type: 'string' }, revision: { type: 'integer' },
          viewport: { type: 'object', additionalProperties: false, required: ['width', 'height'], properties: { width: { type: 'number' }, height: { type: 'number' } } },
          scroll: point,
        },
      },
      items: {
        type: 'array', minItems: 1, maxItems: ANNOTATION_TOOL_LIMITS.items,
        items: {
          type: 'object', additionalProperties: false, required: ['type'],
          properties: {
            id: { type: 'string', description: 'Short mark ID, unique in this set (letters, digits, ".", "_", ":", "-").' },
            type: { type: 'string', enum: [...ANNOTATION_ITEM_TYPES] },
            rect: { type: 'object', additionalProperties: false, required: ['x', 'y', 'w', 'h'], description: 'box, ellipse, highlight.',
              properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } },
            from: { ...point, description: 'line, arrow: start.' },
            to: { ...point, description: 'line, arrow: end (the arrow head).' },
            at: { ...point, description: 'label: where the text starts.' },
            label: { type: 'string', description: `Short text on the mark (<=${ANNOTATION_TOOL_LIMITS.label} chars). Required for label.` },
            note: { type: 'string', description: `Why this mark (<=${ANNOTATION_TOOL_LIMITS.note} chars), shown on hover.` },
            purpose: { type: 'string', enum: [...ANNOTATION_PURPOSES] },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            ref: { type: 'string', description: 'Element ref from the observation this mark points at.' },
            fromItemId: { type: 'string', description: 'line, arrow: id of the mark it starts at.' },
            toItemId: { type: 'string', description: 'line, arrow: id of the mark it points at.' },
          },
        },
      },
    },
  },
}])

class Invalid extends Error { constructor(reason) { super(reason); this.code = 'ANNOTATION_INVALID' } }
const invalid = reason => { throw new Invalid(reason) }
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const finite = value => typeof value === 'number' && Number.isFinite(value)
const token = value => typeof value === 'string' && TOKEN.test(value) ? value : null
const round = (value, digits) => Math.round(value * digits) / digits
const respond = (success, value) => ({ success, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] })

function onlyKeys(value, allowed, where) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) invalid(`${where}: unknown field ${key}`)
}

function cleanText(value, max, where, { required = false } = {}) {
  if (value === undefined && !required) return null
  if (typeof value !== 'string') invalid(`${where} must be text`)
  const clean = value.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim()
  if (!clean) { if (required) invalid(`${where} is empty`); return null }
  if (clean.length > max) invalid(`${where} is longer than ${max} characters`)
  return clean
}

function observationOf(raw) {
  if (raw === undefined) return null
  if (!plain(raw)) invalid('observation must be an object')
  onlyKeys(raw, OBSERVATION_KEYS, 'observation')
  const source = {}
  if (raw.documentId !== undefined) {
    if (typeof raw.documentId !== 'string' || !raw.documentId || raw.documentId.length > 128) invalid('observation.documentId must be 1-128 characters')
    source.documentId = raw.documentId
  }
  if (raw.revision !== undefined) {
    if (!Number.isSafeInteger(raw.revision) || raw.revision < 0) invalid('observation.revision must be a whole number')
    source.revision = raw.revision
  }
  if (raw.viewport !== undefined) {
    const { width, height } = plain(raw.viewport) ? raw.viewport : {}
    if (!finite(width) || !finite(height) || width <= 0 || height <= 0 || width > ANNOTATION_TOOL_LIMITS.viewport || height > ANNOTATION_TOOL_LIMITS.viewport) invalid('observation.viewport needs a positive width and height')
    source.viewport = { width: Math.round(width), height: Math.round(height) }
    if (!source.viewport.width || !source.viewport.height) invalid('observation.viewport needs a positive width and height')
  }
  if (raw.scroll !== undefined) {
    if (!plain(raw.scroll) || !finite(raw.scroll.x) || !finite(raw.scroll.y)) invalid('observation.scroll needs x and y')
    source.scroll = { x: Math.max(0, Math.round(raw.scroll.x)), y: Math.max(0, Math.round(raw.scroll.y)) }
  }
  return source
}

// Geometry in the stored units: card ratios (4 decimals) or Canvas pixels
// (1 decimal), checked against the same bounds as the screen module.
function geometryOf(raw, type, where, convert) {
  const limit = convert.space === 'canvas' ? ANNOTATION_TOOL_LIMITS.canvasCoordinate : ANNOTATION_TOOL_LIMITS.coordinate
  const digits = convert.space === 'canvas' ? 10 : 10000
  const value = (number, axis, field) => {
    if (!finite(number)) invalid(`${where}.${field} must be a number`)
    const scaled = round(convert[axis](number), digits)
    if (Math.abs(scaled) > limit) invalid(`${where}.${field} is outside the card`)
    return scaled
  }
  const pointOf = (p, field) => {
    if (!plain(p)) invalid(`${where}.${field} needs x and y`)
    return { x: value(p.x, 'x', `${field}.x`), y: value(p.y, 'y', `${field}.y`) }
  }
  if (RECT_TYPES.has(type)) {
    if (!plain(raw.rect)) invalid(`${where}: ${type} needs rect {x, y, w, h}`)
    const rect = { x: value(raw.rect.x, 'x', 'rect.x'), y: value(raw.rect.y, 'y', 'rect.y'), w: value(raw.rect.w, 'x', 'rect.w'), h: value(raw.rect.h, 'y', 'rect.h') }
    if (rect.w <= 0 || rect.h <= 0) invalid(`${where}.rect needs a positive w and h`)
    for (const field of ['from', 'to', 'at']) if (raw[field] !== undefined) invalid(`${where}: ${type} takes rect, not ${field}`)
    return { rect }
  }
  if (LINE_TYPES.has(type)) {
    const from = pointOf(raw.from, 'from'), to = pointOf(raw.to, 'to')
    if (from.x === to.x && from.y === to.y) invalid(`${where}: from and to are the same point`)
    for (const field of ['rect', 'at']) if (raw[field] !== undefined) invalid(`${where}: ${type} takes from and to, not ${field}`)
    return { from, to }
  }
  for (const field of ['rect', 'from', 'to']) if (raw[field] !== undefined) invalid(`${where}: label takes at, not ${field}`)
  return { at: pointOf(raw.at, 'at') }
}

/**
 * normalizeAnnotationArguments(args, { run, now, newId }) -> AnnotationSet
 * Throws Invalid (code ANNOTATION_INVALID) with a reason the Agent can act on.
 */
export function normalizeAnnotationArguments(args, { run = null, now = Date.now(), newId = () => `ann-${randomUUID()}` } = {}) {
  if (!plain(args)) invalid('arguments must be an object')
  if (JSON.stringify(args).length > ANNOTATION_TOOL_LIMITS.argumentBytes) invalid(`arguments are larger than ${ANNOTATION_TOOL_LIMITS.argumentBytes} bytes`)
  onlyKeys(args, TOP_KEYS, 'arguments')
  let cardId = null
  if (args.cardId !== undefined) {
    cardId = token(args.cardId)
    if (!cardId) invalid('cardId is not a Canvas card id')
  }
  const space = cardId ? 'card' : 'canvas'
  const summary = cleanText(args.summary, ANNOTATION_TOOL_LIMITS.summary, 'summary', { required: true })
  const units = args.units === undefined ? 'ratio' : args.units
  if (!['ratio', 'viewportPx'].includes(units)) invalid('units must be ratio or viewportPx')
  if (units === 'viewportPx' && space !== 'card') invalid('viewportPx needs cardId')
  if (args.targetKind !== undefined && !ANNOTATION_TARGET_KINDS.includes(args.targetKind)) invalid('targetKind is not supported')
  if (args.grounding !== undefined && !ANNOTATION_GROUNDING.includes(args.grounding)) invalid('grounding must be dom, visual or both')
  const source = observationOf(args.observation)
  if (source && space !== 'card') invalid('observation needs cardId')
  if (units === 'viewportPx' && !source?.viewport) invalid('viewportPx needs observation.viewport')
  const convert = { space,
    x: units === 'viewportPx' ? value => value / source.viewport.width : value => value,
    y: units === 'viewportPx' ? value => value / source.viewport.height : value => value }
  if (!Array.isArray(args.items) || !args.items.length) invalid('items needs at least one mark')
  if (args.items.length > ANNOTATION_TOOL_LIMITS.items) invalid(`items has more than ${ANNOTATION_TOOL_LIMITS.items} marks`)
  const items = [], ids = new Set()
  for (const [index, raw] of args.items.entries()) {
    const where = `items[${index}]`
    if (!plain(raw)) invalid(`${where} must be an object`)
    onlyKeys(raw, ITEM_KEYS, where)
    if (!ANNOTATION_ITEM_TYPES.includes(raw.type)) invalid(`${where}.type must be one of ${ANNOTATION_ITEM_TYPES.join(', ')}`)
    const id = raw.id === undefined ? `item-${index + 1}` : token(raw.id)
    if (!id) invalid(`${where}.id is not a short id`)
    if (ids.has(id)) invalid(`${where}.id repeats ${id}`)
    ids.add(id)
    const item = { id, type: raw.type, ...geometryOf(raw, raw.type, where, convert) }
    const label = cleanText(raw.label, ANNOTATION_TOOL_LIMITS.label, `${where}.label`, { required: raw.type === 'label' })
    if (label) item.label = label
    const note = cleanText(raw.note, ANNOTATION_TOOL_LIMITS.note, `${where}.note`)
    if (note) item.note = note
    if (raw.purpose !== undefined) {
      if (!ANNOTATION_PURPOSES.includes(raw.purpose)) invalid(`${where}.purpose is not supported`)
      item.purpose = raw.purpose
    }
    if (raw.confidence !== undefined) {
      if (!finite(raw.confidence) || raw.confidence < 0 || raw.confidence > 1) invalid(`${where}.confidence must be 0..1`)
      item.confidence = Math.round(raw.confidence * 100) / 100
    }
    if (raw.ref !== undefined) {
      const ref = token(raw.ref)
      if (!ref) invalid(`${where}.ref is not an observation ref`)
      if (space !== 'card') invalid(`${where}.ref needs cardId`)
      item.ref = ref
    }
    for (const key of ['fromItemId', 'toItemId']) {
      if (raw[key] === undefined) continue
      if (!LINE_TYPES.has(raw.type)) invalid(`${where}.${key} is only for line and arrow`)
      const end = token(raw[key])
      if (!end) invalid(`${where}.${key} is not a mark id`)
      item[key] = end
    }
    item.status = 'proposed'
    items.push(item)
  }
  for (const [index, item] of items.entries()) {
    for (const key of ['fromItemId', 'toItemId']) {
      if (item[key] && (item[key] === item.id || !ids.has(item[key]))) invalid(`items[${index}].${key} names no other mark in this set`)
    }
  }
  const set = { version: 1, id: newId(), space }
  if (cardId) set.targetCardId = cardId
  if (cardId && args.targetKind) set.targetKind = args.targetKind
  const runId = token(run?.runId), answerId = token(run?.answerId), agentId = token(run?.profileBinding?.profileId)
  if (runId) set.sourceRunId = runId
  if (answerId) set.sourceMessageId = answerId
  if (agentId) set.createdByAgentId = agentId
  if (args.grounding) set.grounding = args.grounding
  if (source && Object.keys(source).length) set.source = source
  set.createdAt = now
  set.items = items
  set.summary = summary
  return set
}

/** createAnnotationToolProvider({ schemaReady?, now?, newId? }) */
export function createAnnotationToolProvider({ schemaReady = () => true, now = Date.now, newId } = {}) {
  const calls = new Map()
  return {
    providerId: ANNOTATION_PROVIDER_ID,
    runtime: null,
    specs(route) { return schemaReady(route) ? ANNOTATION_TOOL_SPECS : [] },
    dispatch(run, event) {
      // The same native call delivered twice publishes once.
      const key = `${run?.answerId ?? ''}/${event?.callId ?? ''}`
      if (event?.callId && calls.has(key)) return calls.get(key)
      const work = Promise.resolve().then(() => this.publish(run, event))
      if (event?.callId) {
        calls.set(key, work)
        while (calls.size > 256) calls.delete(calls.keys().next().value)
      }
      return work
    },
    publish(run, event) {
      if (event?.namespace || event?.tool !== ANNOTATION_TOOL_NAME) return respond(false, { error: { code: 'ANNOTATION_TOOL_UNKNOWN' } })
      if (run?.executionPolicy) return respond(false, { error: { code: 'ANNOTATION_FORBIDDEN' } })
      let annotation
      try {
        annotation = normalizeAnnotationArguments(event.arguments, { run, now: now(), ...(newId ? { newId } : {}) })
      } catch (error) {
        if (error?.code === 'ANNOTATION_INVALID') return respond(true, { status: 'invalid', code: 'ANNOTATION_INVALID', reason: String(error.message).slice(0, 500) })
        return respond(false, { error: { code: 'ANNOTATION_FAILED' } })
      }
      try {
        this.runtime?.emit?.(run, 'annotation.published', { annotation, callId: typeof event.callId === 'string' ? event.callId : null })
      } catch {
        return respond(false, { error: { code: 'ANNOTATION_NOT_SHOWN' } })
      }
      return respond(true, {
        status: 'published', setId: annotation.id, itemCount: annotation.items.length,
        shown: 'Shown to the person as a dotted suggestion over the card and a chip under this answer. Nothing is saved until the person accepts it. Reply in one or two sentences; do not list coordinates.',
      })
    },
  }
}
