// RT-03: a saved Board <-> JSON Canvas 1.0 (.canvas, the file Obsidian and
// other canvas apps open). Pure conversion: no files, no store, no network.
//
// Format followed (no code copied): JSON Canvas Spec 1.0 (2024-03-11),
// obsidianmd/jsoncanvas spec/1.0.md:5-100, MIT license. Nodes are text, file,
// link or group with integer x/y/width/height, in ascending z order; edges
// join fromNode -> toNode with optional sides, ends ('none'|'arrow', toEnd
// defaulting to arrow), color and label.
//
// What a Board becomes:
//   Browser card (http/https)   -> link node
//   result card                 -> text node (title + answer text)
//   other cards                 -> text node naming the card ("파일 카드" ...)
//   label mark                  -> text node
//   rect / ellipse / highlight  -> group node
//   line / arrow between nodes  -> edge
//   free line, arrow, freehand  -> not drawable in JSON Canvas; listed in
//                                  report.omitted and kept under the top-level
//                                  "egdesk" key so EG-Desk can read it back
//   memo (body.memos, if any)   -> yellow text node, its links -> edges
//   the Board itself            -> one group node framing everything
// Each node may carry an "egdesk" object with the original record so a
// round trip through EG-Desk keeps card kinds. Other apps ignore it.
// D-R3: attachments and captures (file, input-evidence cards) are left out of
// that record unless includeAttachments is true; the node names them only.
//
// What a .canvas becomes (always a new Board body; the caller picks IDs):
//   link node (http/https) -> Browser card; any other link -> label mark
//   text node              -> label mark (cut at 1000 characters, reported)
//   file node              -> label mark with the path (no file is opened)
//   group node             -> rect mark, plus a label mark for its label
//   edge                   -> arrow or line mark between the two node sides,
//                             plus a label mark for its label
// An "egdesk" record is trusted only for Browser (http/https), result and
// file cards and for marks; terminal, Chat, settings and other cards from a
// file always arrive as label marks.

export const JSON_CANVAS_VERSION = '1.0'
export const JSON_CANVAS_LIMITS = Object.freeze({ nodes: 5000, edges: 10000, idChars: 256, text: 20000, labelText: 1000, titleChars: 80 })
export const JSON_CANVAS_NODE_TYPES = Object.freeze(['text', 'file', 'link', 'group'])
const SIDES = ['top', 'right', 'bottom', 'left']
const ENDS = ['none', 'arrow']
const SHAPE_TYPES = ['rect', 'ellipse', 'line', 'arrow', 'path', 'label', 'highlight']
const BOX_SHAPES = ['rect', 'ellipse', 'highlight']
const IMPORTABLE_CARDS = ['browser', 'result', 'file']
const ATTACHMENT_CARDS = ['file', 'input-evidence']
const CARD_LABELS = Object.freeze({
  browser: 'Browser', file: '파일', chat: 'Chat', terminal: '터미널', settings: '설정',
  ontology: '온톨로지', 'input-evidence': '입력 캡처', result: '결과',
})
const LOCAL_ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
const COLOR = /^(?:[1-6]|#[0-9A-Fa-f]{3}|#[0-9A-Fa-f]{6})$/
const MIN_SIZE = 12
// Same frame as the screen's Board region: 24px padding, 36px title row.
const FRAME = Object.freeze({ padding: 24, title: 36 })
const MEMO = Object.freeze({ width: 220, height: 140 })
const LINE_HEIGHT = 16
const ROTATE = /^rotate\((-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)deg\)$/i

function fail(code, message) {
  throw Object.assign(new Error(message), { code, httpStatus: 400 })
}
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
const list = value => Array.isArray(value) ? value : []
const finite = value => typeof value === 'number' && Number.isFinite(value)
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const round3 = value => { const rounded = Math.round(value * 1000) / 1000; return Object.is(rounded, -0) ? 0 : rounded }

function oneLine(value, max) {
  if (typeof value !== 'string') return ''
  return Array.from(value.normalize('NFC').replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, ' ').trim()).slice(0, max).join('').trim()
}
// Same clean-up as the screen's label text (normalizeCanvasLabelText).
function labelText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
function httpUrl(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null
  } catch { return null }
}
function rectOf(geometry) {
  if (!plain(geometry) || ![geometry.x, geometry.y, geometry.width, geometry.height].every(finite)) return null
  return { x: Math.round(geometry.x), y: Math.round(geometry.y), width: Math.max(MIN_SIZE, Math.round(geometry.width)), height: Math.max(MIN_SIZE, Math.round(geometry.height)) }
}
const center = rect => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 })
function sidePoint(rect, side) {
  if (side === 'top') return { x: rect.x + rect.width / 2, y: rect.y }
  if (side === 'bottom') return { x: rect.x + rect.width / 2, y: rect.y + rect.height }
  if (side === 'left') return { x: rect.x, y: rect.y + rect.height / 2 }
  return { x: rect.x + rect.width, y: rect.y + rect.height / 2 }
}
// The side of `rect` that faces `toward`.
function facingSide(rect, toward) {
  const from = center(rect)
  const dx = toward.x - from.x, dy = toward.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}
// The side of `rect` nearest to a point on or near its edge.
function nearestSide(rect, point) {
  const distances = [
    ['top', Math.abs(point.y - rect.y)], ['bottom', Math.abs(point.y - (rect.y + rect.height))],
    ['left', Math.abs(point.x - rect.x)], ['right', Math.abs(point.x - (rect.x + rect.width))],
  ]
  return distances.sort((a, b) => a[1] - b[1])[0][0]
}

/** A line or arrow mark's two ends, from its box and rotation (how the screen draws it). */
function lineEnds(shape) {
  const rect = rectOf(shape.geometry)
  if (!rect) return null
  const match = typeof shape.runtimeState?.transform === 'string' ? shape.runtimeState.transform.match(ROTATE) : null
  const angle = match ? Number(match[1]) * Math.PI / 180 : 0
  const start = { x: rect.x, y: rect.y + LINE_HEIGHT / 2 }
  return { start, end: { x: start.x + rect.width * Math.cos(angle), y: start.y + rect.width * Math.sin(angle) } }
}
/** The screen's line/arrow record for two world points. */
function lineShape(id, type, start, end) {
  const length = Math.hypot(end.x - start.x, end.y - start.y)
  const angle = round3(Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI)
  return {
    id, type,
    geometry: { x: Math.round(start.x), y: Math.round(start.y - LINE_HEIGHT / 2), width: Math.max(MIN_SIZE, Math.round(length)), height: LINE_HEIGHT, zIndex: 0 },
    sourceRef: null,
    runtimeState: { transform: `rotate(${angle}deg)`, x1: String(round3(start.x)), y1: String(round3(start.y)), x2: String(round3(end.x)), y2: String(round3(end.y)) },
  }
}
function labelShape(id, rect, text, zIndex) {
  return {
    id, type: 'label', geometry: { ...rect, zIndex }, sourceRef: null,
    runtimeState: { transform: '', x1: null, y1: null, x2: null, y2: null, text },
  }
}

// ── Board -> JSON Canvas ──

function memoRect(memo, cardRects) {
  const anchor = memo?.anchor
  const width = finite(memo?.size?.width) ? memo.size.width : MEMO.width
  const height = finite(memo?.size?.baseHeight) ? memo.size.baseHeight : MEMO.height
  let at = null
  if (anchor?.kind === 'canvas' && finite(anchor.x) && finite(anchor.y)) at = { x: anchor.x, y: anchor.y }
  else if (anchor?.kind === 'card') {
    const card = cardRects.get(anchor.cardId)
    if (card && finite(anchor.x) && finite(anchor.y)) at = { x: card.x + card.width * anchor.x, y: card.y + card.height * anchor.y }
    else if (finite(anchor.at?.x) && finite(anchor.at?.y)) at = { x: anchor.at.x, y: anchor.at.y }
  }
  return at ? rectOf({ x: at.x, y: at.y, width, height }) : null
}

/**
 * boardToJsonCanvas(body, {title?, includeAttachments = false, includeEgdesk = true, frame = true})
 * -> {canvas: {nodes, edges[, egdesk]}, report: {nodes, edges, omitted: [{id, kind, reason}]}}
 * body is a saved Board body ({agenda, cards, shapes[, memos]}). The input is not changed.
 */
export function boardToJsonCanvas(body, { title, includeAttachments = false, includeEgdesk = true, frame = true } = {}) {
  if (!plain(body)) fail('INVALID_BOARD_BODY', 'Board body must be a JSON object')
  const boardTitle = oneLine(title, JSON_CANVAS_LIMITS.titleChars) || oneLine(body.agenda?.title, JSON_CANVAS_LIMITS.titleChars) || 'Board'
  const nodes = [], edges = [], omitted = [], kept = []
  const used = new Set()
  const unique = base => {
    const start = typeof base === 'string' && base && base.length <= JSON_CANVAS_LIMITS.idChars ? base : 'node'
    let id = start, n = 2
    while (used.has(id)) id = `${start}-${n++}`
    used.add(id)
    return id
  }
  const nodeOf = new Map() // EG-Desk id -> {id, rect} for edges
  const cardRects = new Map()
  const entries = [
    ...list(body.cards).map((record, order) => ({ kind: 'card', record, order })),
    ...list(body.shapes).map((record, order) => ({ kind: 'shape', record, order: list(body.cards).length + order })),
  ].filter(entry => plain(entry.record))
  // JSON Canvas order is paint order: lowest zIndex first, ties keep Board order.
  entries.sort((a, b) => ((a.record.geometry?.zIndex ?? 0) - (b.record.geometry?.zIndex ?? 0)) || (a.order - b.order))
  const lines = []
  for (const { kind, record } of entries) {
    const recordId = typeof record.id === 'string' ? record.id : null
    if (kind === 'shape' && ['line', 'arrow', 'path'].includes(record.type)) { lines.push(record); continue }
    const rect = rectOf(record.geometry)
    if (!rect) { omitted.push({ id: recordId, kind, reason: 'no-geometry' }); continue }
    const node = { id: unique(recordId), x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    if (kind === 'card') {
      const state = plain(record.runtimeState) ? record.runtimeState : {}
      const label = `${CARD_LABELS[record.type] || '카드'} 카드`
      const url = record.type === 'browser' ? httpUrl(state.uri ?? record.sourceRef?.uri) : null
      if (url) Object.assign(node, { type: 'link', url })
      else if (record.type === 'result') {
        const heading = oneLine(state.title, 80) || label
        const text = typeof state.text === 'string' ? state.text.slice(0, JSON_CANVAS_LIMITS.text) : ''
        Object.assign(node, { type: 'text', text: text ? `## ${heading}\n\n${text}` : `## ${heading}` })
      } else {
        const name = oneLine(state.title, 120) || (plain(state.root) ? oneLine(state.root.name, 120) : '')
        Object.assign(node, { type: 'text', text: name ? `${label} · ${name}` : label })
      }
      if (includeEgdesk) {
        const attachment = ATTACHMENT_CARDS.includes(record.type)
        node.egdesk = (IMPORTABLE_CARDS.includes(record.type) && (!attachment || includeAttachments))
          ? { kind: 'card', type: record.type, sourceRef: copy(record.sourceRef ?? null), runtimeState: copy(state) }
          : { kind: 'card', type: typeof record.type === 'string' ? record.type : 'card', ...(attachment ? { omitted: 'attachment' } : {}) }
      }
      cardRects.set(recordId, rect)
    } else if (record.type === 'label') {
      const text = labelText(record.runtimeState?.text)
      if (!text) { used.delete(node.id); omitted.push({ id: recordId, kind, reason: 'empty-label' }); continue }
      Object.assign(node, { type: 'text', text })
      if (includeEgdesk) node.egdesk = { kind: 'shape', type: 'label' }
    } else if (BOX_SHAPES.includes(record.type)) {
      node.type = 'group'
      if (includeEgdesk) node.egdesk = { kind: 'shape', type: record.type, runtimeState: copy(plain(record.runtimeState) ? record.runtimeState : {}) }
    } else { used.delete(node.id); omitted.push({ id: recordId, kind, reason: 'unknown-shape' }); continue }
    nodes.push(node)
    if (recordId) nodeOf.set(recordId, { id: node.id, rect })
  }
  // Memos (sticky notes), when the Board carries them: on top of everything.
  for (const memo of list(body.memos)) {
    if (!plain(memo) || typeof memo.id !== 'string') continue
    const rect = memoRect(memo, cardRects)
    if (!rect) { omitted.push({ id: memo.id, kind: 'memo', reason: 'no-geometry' }); continue }
    const text = labelText(memo.text) || '메모'
    const node = { id: unique(memo.id), type: 'text', x: rect.x, y: rect.y, width: rect.width, height: rect.height, color: '3', text }
    if (includeEgdesk) node.egdesk = { kind: 'memo' }
    nodes.push(node)
    nodeOf.set(memo.id, { id: node.id, rect })
  }
  // Edges: a line or arrow whose two ends sit on two nodes; memo links.
  const hit = point => {
    for (let index = nodes.length - 1; index >= 0; index--) {
      const node = nodes[index]
      if (node.type === 'group') continue
      const pad = 24
      if (point.x >= node.x - pad && point.x <= node.x + node.width + pad && point.y >= node.y - pad && point.y <= node.y + node.height + pad) return node
    }
    return null
  }
  for (const record of lines) {
    const recordId = typeof record.id === 'string' ? record.id : null
    const ends = record.type === 'path' ? null : lineEnds(record)
    const from = ends && hit(ends.start), to = ends && hit(ends.end)
    if (!from || !to || from === to) {
      omitted.push({ id: recordId, kind: 'shape', reason: record.type === 'path' ? 'freehand' : 'free-line' })
      if (includeEgdesk) kept.push(copy(record))
      continue
    }
    const edge = {
      id: unique(recordId), fromNode: from.id, fromSide: nearestSide(from, ends.start),
      toNode: to.id, toSide: nearestSide(to, ends.end), toEnd: record.type === 'arrow' ? 'arrow' : 'none',
    }
    if (includeEgdesk) edge.egdesk = { kind: 'shape', type: record.type }
    edges.push(edge)
  }
  for (const memo of list(body.memos)) {
    const from = plain(memo) && nodeOf.get(memo.id)
    if (!from) continue
    for (const link of list(memo.links)) {
      const to = nodeOf.get(link?.toId)
      if (!to || to.id === from.id) continue
      const edge = { id: unique(`${from.id}-link`), fromNode: from.id, toNode: to.id, toEnd: 'arrow' }
      const label = oneLine(link.label, 80)
      if (label) edge.label = label
      edges.push(edge)
    }
  }
  let frameId = null
  if (frame && nodes.length) {
    const left = Math.min(...nodes.map(node => node.x)), top = Math.min(...nodes.map(node => node.y))
    const right = Math.max(...nodes.map(node => node.x + node.width)), bottom = Math.max(...nodes.map(node => node.y + node.height))
    frameId = unique(`board-${typeof body.agenda?.id === 'string' ? body.agenda.id : 'frame'}`)
    nodes.unshift({
      id: frameId, type: 'group', label: boardTitle,
      x: left - FRAME.padding, y: top - FRAME.padding - FRAME.title,
      width: right - left + FRAME.padding * 2, height: bottom - top + FRAME.padding * 2 + FRAME.title,
    })
  }
  const canvas = { nodes, edges }
  if (includeEgdesk) {
    canvas.egdesk = { version: 1, board: { agendaId: typeof body.agenda?.id === 'string' ? body.agenda.id : null, title: boardTitle, frameNodeId: frameId } }
    if (kept.length) canvas.egdesk.shapes = kept
  }
  return { canvas, report: { nodes: nodes.length, edges: edges.length, omitted } }
}

// ── JSON Canvas -> Board ──

function validNode(node) {
  if (!plain(node)) return 'not-an-object'
  if (typeof node.id !== 'string' || !node.id || node.id.length > JSON_CANVAS_LIMITS.idChars) return 'bad-id'
  if (!JSON_CANVAS_NODE_TYPES.includes(node.type)) return 'unknown-type'
  if (![node.x, node.y, node.width, node.height].every(finite)) return 'bad-geometry'
  if (node.color !== undefined && (typeof node.color !== 'string' || !COLOR.test(node.color))) return 'bad-color'
  return null
}
function validEdge(edge) {
  if (!plain(edge)) return 'not-an-object'
  if (typeof edge.id !== 'string' || !edge.id || edge.id.length > JSON_CANVAS_LIMITS.idChars) return 'bad-id'
  if (typeof edge.fromNode !== 'string' || typeof edge.toNode !== 'string') return 'bad-endpoint'
  for (const key of ['fromSide', 'toSide']) if (edge[key] !== undefined && !SIDES.includes(edge[key])) return `bad-${key}`
  for (const key of ['fromEnd', 'toEnd']) if (edge[key] !== undefined && !ENDS.includes(edge[key])) return `bad-${key}`
  return null
}
function trustedCard(record, rect, id, zIndex) {
  if (!plain(record) || record.kind !== 'card' || !IMPORTABLE_CARDS.includes(record.type) || record.omitted) return null
  const state = plain(record.runtimeState) ? copy(record.runtimeState) : {}
  const sourceRef = plain(record.sourceRef) ? copy(record.sourceRef) : null
  if (record.type === 'browser') {
    const uri = httpUrl(state.uri)
    if (!uri) return null
    state.uri = uri
    if (sourceRef && sourceRef.uri !== undefined && !httpUrl(sourceRef.uri)) delete sourceRef.uri
  }
  if (record.type === 'result' && state.version !== 1) return null
  return { id, type: record.type, geometry: { ...rect, zIndex }, sourceRef, runtimeState: state }
}
function trustedShape(record, rect, id, zIndex) {
  if (!plain(record) || record.kind !== 'shape' || !BOX_SHAPES.includes(record.type)) return null
  const state = plain(record.runtimeState) ? record.runtimeState : {}
  return {
    id, type: record.type, geometry: { ...rect, zIndex }, sourceRef: null,
    runtimeState: { transform: typeof state.transform === 'string' && ROTATE.test(state.transform) ? state.transform : '', x1: null, y1: null, x2: null, y2: null },
  }
}
// A freehand or free line kept by an EG-Desk export: only the fields the screen reads.
function keptShape(record, id) {
  if (!plain(record) || !['line', 'arrow', 'path'].includes(record.type)) return null
  const rect = rectOf(record.geometry)
  if (!rect) return null
  const state = plain(record.runtimeState) ? record.runtimeState : {}
  const coordinate = value => typeof value === 'string' && value.length <= 32 && Number.isFinite(Number(value)) ? value : null
  const runtimeState = { transform: typeof state.transform === 'string' && ROTATE.test(state.transform) ? state.transform : '' }
  for (const key of ['x1', 'y1', 'x2', 'y2']) runtimeState[key] = coordinate(state[key])
  if (record.type === 'path') {
    runtimeState.points = list(state.points).slice(0, 2000)
      .filter(point => Array.isArray(point) && point.length === 2 && point.every(finite)).map(([x, y]) => [x, y])
  }
  return { id, type: record.type, geometry: { ...rect, zIndex: finite(record.geometry.zIndex) ? Math.round(record.geometry.zIndex) : 0 }, sourceRef: null, runtimeState }
}

/**
 * jsonCanvasToBoard(canvas, {title?, agendaId?, now?, useEgdesk = true})
 * -> {body, title, report: {cards, shapes, dropped: [{id, reason}], truncated: [id], approximated: [{id, reason}]}}
 * Always a new Board body; nothing is saved here. agendaId should be the
 * Board ID the caller will save it under.
 */
export function jsonCanvasToBoard(canvas, { title, agendaId = 'agenda-canvas', now = Date.now(), useEgdesk = true } = {}) {
  if (!plain(canvas)) fail('INVALID_JSON_CANVAS', 'A JSON Canvas file must be a JSON object')
  if (canvas.nodes !== undefined && !Array.isArray(canvas.nodes)) fail('INVALID_JSON_CANVAS', 'nodes must be an array')
  if (canvas.edges !== undefined && !Array.isArray(canvas.edges)) fail('INVALID_JSON_CANVAS', 'edges must be an array')
  const nodes = list(canvas.nodes), edgeList = list(canvas.edges)
  if (nodes.length > JSON_CANVAS_LIMITS.nodes || edgeList.length > JSON_CANVAS_LIMITS.edges) fail('JSON_CANVAS_TOO_LARGE', `A canvas may hold at most ${JSON_CANVAS_LIMITS.nodes} nodes and ${JSON_CANVAS_LIMITS.edges} edges`)
  if (typeof agendaId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agendaId)) fail('INVALID_BOARD_ID', 'agendaId must be a Board ID')
  if (!Number.isSafeInteger(now) || now < 0) fail('INVALID_JSON_CANVAS', 'now must be a millisecond time')
  const meta = useEgdesk && plain(canvas.egdesk) ? canvas.egdesk : null
  const frameNodeId = typeof meta?.board?.frameNodeId === 'string' ? meta.board.frameNodeId : null
  const cards = [], shapes = [], dropped = [], truncated = [], approximated = []
  const used = new Set()
  const localId = (canvasId, prefix) => {
    const clean = String(canvasId).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96)
    const base = LOCAL_ID.test(canvasId) ? canvasId : `jc-${prefix}-${clean || 'node'}`
    let id = base, n = 2
    while (used.has(id)) id = `${base}-${n++}`
    used.add(id)
    return id
  }
  const placed = new Map() // canvas node id -> rect
  let frameTitle = ''
  nodes.forEach((node, index) => {
    const problem = validNode(node)
    if (problem) { dropped.push({ id: typeof node?.id === 'string' ? node.id : null, reason: problem }); return }
    if (placed.has(node.id)) { dropped.push({ id: node.id, reason: 'duplicate-id' }); return }
    const rect = rectOf(node)
    placed.set(node.id, rect)
    const zIndex = index + 1
    if (node.id === frameNodeId && node.type === 'group') { frameTitle = oneLine(node.label, JSON_CANVAS_LIMITS.titleChars); return }
    const record = useEgdesk && plain(node.egdesk) ? node.egdesk : null
    const id = localId(node.id, node.type)
    const card = record && trustedCard(record, rect, id, zIndex)
    if (card) { cards.push(card); return }
    const box = record && trustedShape(record, rect, id, zIndex)
    if (box) { shapes.push(box); return }
    if (record?.kind === 'card' && record.type && !IMPORTABLE_CARDS.includes(record.type)) approximated.push({ id: node.id, reason: 'card-kind-not-imported' })
    if (node.type === 'link') {
      const url = httpUrl(node.url)
      if (url) {
        cards.push({ id, type: 'browser', geometry: { ...rect, zIndex }, sourceRef: null, runtimeState: { uri: url, title: '', firstUseBrowser: false, fixedLogicalHeight: null } })
        return
      }
      approximated.push({ id: node.id, reason: 'link-not-http' })
    }
    if (node.type === 'group') {
      shapes.push({ id, type: 'rect', geometry: { ...rect, zIndex }, sourceRef: null, runtimeState: { transform: '', x1: null, y1: null, x2: null, y2: null } })
      const label = labelText(node.label)
      if (label) shapes.push(labelShape(localId(`${node.id}-label`, 'label'), { x: rect.x + 8, y: rect.y + 4, width: Math.max(MIN_SIZE, rect.width - 16), height: 28 }, label.slice(0, JSON_CANVAS_LIMITS.labelText), zIndex))
      return
    }
    let text = node.type === 'text' ? labelText(node.text)
      : node.type === 'file' ? labelText(`${typeof node.file === 'string' ? node.file : ''}${typeof node.subpath === 'string' ? node.subpath : ''}`)
        : labelText(node.url)
    if (!text) { used.delete(id); dropped.push({ id: node.id, reason: 'empty-text' }); return }
    if (text.length > JSON_CANVAS_LIMITS.labelText) { text = text.slice(0, JSON_CANVAS_LIMITS.labelText); truncated.push(node.id) }
    if (node.type === 'file') approximated.push({ id: node.id, reason: 'file-as-label' })
    shapes.push(labelShape(id, rect, text, zIndex))
  })
  const edgeIds = new Set()
  edgeList.forEach((edge, index) => {
    const problem = validEdge(edge)
    if (problem) { dropped.push({ id: typeof edge?.id === 'string' ? edge.id : null, reason: problem }); return }
    if (edgeIds.has(edge.id)) { dropped.push({ id: edge.id, reason: 'duplicate-id' }); return }
    edgeIds.add(edge.id)
    const from = placed.get(edge.fromNode), to = placed.get(edge.toNode)
    if (!from || !to || edge.fromNode === frameNodeId || edge.toNode === frameNodeId) { dropped.push({ id: edge.id, reason: 'missing-node' }); return }
    const toEnd = edge.toEnd ?? 'arrow', fromEnd = edge.fromEnd ?? 'none'
    let start = sidePoint(from, edge.fromSide ?? facingSide(from, center(to)))
    let end = sidePoint(to, edge.toSide ?? facingSide(to, center(from)))
    let type = 'line'
    if (toEnd === 'arrow') type = 'arrow'
    else if (fromEnd === 'arrow') { type = 'arrow'; [start, end] = [end, start] }
    if (toEnd === 'arrow' && fromEnd === 'arrow') approximated.push({ id: edge.id, reason: 'two-headed-arrow' })
    const shape = lineShape(localId(edge.id, 'edge'), type, start, end)
    shape.geometry.zIndex = nodes.length + index + 1
    shapes.push(shape)
    const label = labelText(edge.label)
    if (label) {
      const middle = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }
      shapes.push(labelShape(localId(`${edge.id}-label`, 'label'), { x: Math.round(middle.x - 80), y: Math.round(middle.y - 14), width: 160, height: 28 }, label.slice(0, JSON_CANVAS_LIMITS.labelText), shape.geometry.zIndex))
    }
  })
  for (const record of meta ? list(meta.shapes) : []) {
    const shape = keptShape(record, localId(typeof record?.id === 'string' ? record.id : 'kept', 'kept'))
    if (shape) shapes.push(shape)
    else dropped.push({ id: typeof record?.id === 'string' ? record.id : null, reason: 'kept-shape-unreadable' })
  }
  const boardTitle = oneLine(title, JSON_CANVAS_LIMITS.titleChars) || oneLine(meta?.board?.title, JSON_CANVAS_LIMITS.titleChars) || frameTitle || 'Canvas'
  const body = {
    version: 1, savedAt: now,
    agenda: { id: agendaId, title: boardTitle, memberCardIds: cards.map(card => card.id), contextBindings: [] },
    cards, shapes,
  }
  return { body, title: boardTitle, report: { cards: cards.length, shapes: shapes.length, dropped, truncated, approximated } }
}
