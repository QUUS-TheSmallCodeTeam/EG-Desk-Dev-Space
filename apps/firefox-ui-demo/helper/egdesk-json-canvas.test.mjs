import test from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync, rmSync } from 'node:fs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'
import { JSON_CANVAS_LIMITS, JSON_CANVAS_NODE_TYPES, boardToJsonCanvas, jsonCanvasToBoard } from './egdesk-json-canvas.mjs'

const T0 = Date.UTC(2026, 9, 24, 3)
const ROTATE = /^rotate\(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?deg\)$/i
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child) }
  return value
}
const geometry = (x, y, width, height, zIndex = 1) => ({ x, y, width, height, zIndex })
const blankLine = { transform: '', x1: null, y1: null, x2: null, y2: null }
// Shapes follow what the screen writes (serializeCardState / serializeShapeState).
function sampleBoard() {
  return {
    version: 1, savedAt: T0,
    agenda: { id: 'agenda-weekly', title: '주간 회의', memberCardIds: ['egd-browser-card-1', 'egd-result-card-2', 'egd-terminal-card-3', 'egd-file-card-4'], contextBindings: [] },
    cards: [
      { id: 'egd-browser-card-1', type: 'browser', geometry: geometry(100, 100, 400, 300, 3), sourceRef: { kind: 'browser', uri: 'https://example.com/docs' }, runtimeState: { uri: 'https://example.com/docs?q=1', title: '문서', firstUseBrowser: false, fixedLogicalHeight: null } },
      { id: 'egd-result-card-2', type: 'result', geometry: geometry(600, 100, 360, 280, 2), sourceRef: null, runtimeState: { version: 1, title: '요약', text: '첫 줄\n둘째 줄', totalChars: 9, truncated: false, artifacts: [], source: { threadId: 'thread-1', messageId: 'm-1', author: 'Codex' }, createdAt: T0 } },
      { id: 'egd-terminal-card-3', type: 'terminal', geometry: geometry(100, 500, 300, 200, 1), sourceRef: null, runtimeState: {} },
      { id: 'egd-file-card-4', type: 'file', geometry: geometry(600, 500, 300, 200, 4), sourceRef: null, runtimeState: { version: 1, root: { rootId: 'root-1', directoryId: 'dir-1', name: '보고서 폴더' }, fileId: 'file-1', draftId: null, scrollTop: 0 } },
    ],
    shapes: [
      { id: 'shape-label-1', type: 'label', geometry: geometry(100, 40, 200, 30, 5), sourceRef: null, runtimeState: { ...blankLine, text: '회의록 정리' } },
      { id: 'shape-rect-2', type: 'rect', geometry: geometry(80, 80, 900, 700, 0), sourceRef: null, runtimeState: { ...blankLine } },
      // From the browser card's right side (500, 250) to the result card's left side (600, 240).
      { id: 'shape-arrow-3', type: 'arrow', geometry: geometry(500, 242, 100, 16, 6), sourceRef: null, runtimeState: { transform: `rotate(${Math.atan2(-10, 100) * 180 / Math.PI}deg)`, x1: '500', y1: '250', x2: '600', y2: '240' } },
      { id: 'shape-path-4', type: 'path', geometry: geometry(1200, 1200, 50, 50, 7), sourceRef: null, runtimeState: { ...blankLine, points: [[0, 0], [10, 10], [50, 50]] } },
      { id: 'shape-line-5', type: 'line', geometry: geometry(2000, 2000, 100, 16, 8), sourceRef: null, runtimeState: { ...blankLine } },
    ],
  }
}
/** What JSON Canvas 1.0 requires of a file (spec/1.0.md). */
function assertJsonCanvas(canvas) {
  const ids = new Set()
  for (const node of canvas.nodes) {
    assert.ok(typeof node.id === 'string' && node.id && !ids.has(node.id), `unique node id ${node.id}`)
    ids.add(node.id)
    assert.ok(JSON_CANVAS_NODE_TYPES.includes(node.type), node.type)
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Number.isInteger(node[key]), `${node.id}.${key} is an integer`)
    if (node.type === 'text') assert.equal(typeof node.text, 'string')
    if (node.type === 'link') assert.match(node.url, /^https?:\/\//)
    if (node.color !== undefined) assert.match(node.color, /^(?:[1-6]|#[0-9A-Fa-f]{3}|#[0-9A-Fa-f]{6})$/)
  }
  for (const edge of canvas.edges) {
    assert.ok(typeof edge.id === 'string' && !ids.has(edge.id), `unique edge id ${edge.id}`)
    ids.add(edge.id)
    assert.ok(canvas.nodes.some(node => node.id === edge.fromNode) && canvas.nodes.some(node => node.id === edge.toNode), 'edges join existing nodes')
    for (const key of ['fromSide', 'toSide']) if (edge[key] !== undefined) assert.ok(['top', 'right', 'bottom', 'left'].includes(edge[key]))
    for (const key of ['fromEnd', 'toEnd']) if (edge[key] !== undefined) assert.ok(['none', 'arrow'].includes(edge[key]))
  }
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(canvas)))
}

test('a Board becomes a JSON Canvas 1.0 file: links, text, groups, edges, a titled frame, in paint order', () => {
  const board = deepFreeze(sampleBoard())
  const { canvas, report } = boardToJsonCanvas(board)
  assertJsonCanvas(canvas)
  const byId = id => canvas.nodes.find(node => node.id === id)
  // The Board frame comes first (lowest) and encloses everything with the screen's padding.
  assert.deepEqual([canvas.nodes[0].id, canvas.nodes[0].type, canvas.nodes[0].label], ['board-agenda-weekly', 'group', '주간 회의'])
  assert.deepEqual([canvas.nodes[0].x, canvas.nodes[0].y], [80 - 24, 40 - 24 - 36])
  // Then by zIndex: rect 0, terminal 1, result 2, browser 3, file 4, label 5.
  assert.deepEqual(canvas.nodes.slice(1).map(node => node.id), ['shape-rect-2', 'egd-terminal-card-3', 'egd-result-card-2', 'egd-browser-card-1', 'egd-file-card-4', 'shape-label-1'])
  assert.deepEqual([byId('egd-browser-card-1').type, byId('egd-browser-card-1').url], ['link', 'https://example.com/docs?q=1'])
  assert.equal(byId('egd-result-card-2').text, '## 요약\n\n첫 줄\n둘째 줄')
  assert.equal(byId('egd-terminal-card-3').text, '터미널 카드')
  assert.equal(byId('egd-file-card-4').text, '파일 카드 · 보고서 폴더')
  assert.deepEqual([byId('shape-label-1').type, byId('shape-label-1').text], ['text', '회의록 정리'])
  assert.equal(byId('shape-rect-2').type, 'group')
  // The arrow joins the two cards it touches.
  assert.deepEqual(canvas.edges, [{ id: 'shape-arrow-3', fromNode: 'egd-browser-card-1', fromSide: 'right', toNode: 'egd-result-card-2', toSide: 'left', toEnd: 'arrow', egdesk: { kind: 'shape', type: 'arrow' } }])
  // Freehand and a line that touches nothing cannot be drawn in JSON Canvas: reported and kept for EG-Desk.
  assert.deepEqual(report.omitted, [{ id: 'shape-path-4', kind: 'shape', reason: 'freehand' }, { id: 'shape-line-5', kind: 'shape', reason: 'free-line' }])
  assert.deepEqual(canvas.egdesk.shapes.map(shape => shape.id), ['shape-path-4', 'shape-line-5'])
  assert.deepEqual(canvas.egdesk.board, { agendaId: 'agenda-weekly', title: '주간 회의', frameNodeId: 'board-agenda-weekly' })
  assert.deepEqual([report.nodes, report.edges], [canvas.nodes.length, 1])
  // Kinds survive for EG-Desk; D-R3: attachments (file cards) carry no record unless asked.
  assert.deepEqual(byId('egd-browser-card-1').egdesk.runtimeState, board.cards[0].runtimeState)
  assert.deepEqual(byId('egd-terminal-card-3').egdesk, { kind: 'card', type: 'terminal' })
  assert.deepEqual(byId('egd-file-card-4').egdesk, { kind: 'card', type: 'file', omitted: 'attachment' })
  const withFiles = boardToJsonCanvas(board, { includeAttachments: true }).canvas
  assert.equal(withFiles.nodes.find(node => node.id === 'egd-file-card-4').egdesk.runtimeState.root.name, '보고서 폴더')
  // A plain file for other apps: no EG-Desk records, no frame.
  const bare = boardToJsonCanvas(board, { includeEgdesk: false, frame: false, title: '다른 이름' }).canvas
  assertJsonCanvas(bare)
  assert.ok(!JSON.stringify(bare).includes('egdesk'))
  assert.equal(bare.nodes.length, canvas.nodes.length - 1)
  assert.equal(boardToJsonCanvas(board, { title: '다른 이름' }).canvas.nodes[0].label, '다른 이름')
})

test('a JSON Canvas from another app becomes a new Board body: link cards, label and rect marks, arrows between sides', () => {
  const canvas = deepFreeze({
    nodes: [
      { id: '6f0ad84f44ce9c17', type: 'group', x: -40, y: -40, width: 900, height: 600, label: '조사 묶음', color: '4' },
      { id: 'a1b2c3d4e5f60718', type: 'text', x: 0, y: 0, width: 250, height: 60, text: '# 할 일\n\n- 견적 비교', color: '#FF0000' },
      { id: 'link-1', type: 'link', x: 400.4, y: 0, width: 400, height: 300.6, url: 'https://obsidian.md/canvas' },
      { id: 'link-2', type: 'link', x: 0, y: 300, width: 250, height: 60, url: 'javascript:alert(1)' },
      { id: 'file-1', type: 'file', x: 0, y: 400, width: 250, height: 60, file: 'Notes/plan.md', subpath: '#Goals' },
      { id: 'long-1', type: 'text', x: 0, y: 500, width: 250, height: 60, text: '가'.repeat(1500) },
      { id: 'a1b2c3d4e5f60718', type: 'text', x: 9, y: 9, width: 9, height: 9, text: 'duplicate' },
      { id: 'bad-1', type: 'text', x: 'left', y: 0, width: 10, height: 10, text: 'x' },
      { id: 'bad-2', type: 'sticky', x: 0, y: 0, width: 10, height: 10 },
      { id: 'bad-3', type: 'text', x: 0, y: 0, width: 10, height: 10, text: 'x', color: 'red' },
      { id: 'tiny', type: 'text', x: 0, y: 0, width: 2, height: 2, text: '작음' },
    ],
    edges: [
      { id: 'e1', fromNode: 'a1b2c3d4e5f60718', fromSide: 'right', toNode: 'link-1', toSide: 'left', label: '참고' },
      { id: 'e2', fromNode: 'link-1', toNode: 'file-1', toEnd: 'none' },
      { id: 'e3', fromNode: 'file-1', toNode: 'link-2', fromEnd: 'arrow', toEnd: 'none' },
      { id: 'e4', fromNode: 'file-1', toNode: 'missing', toEnd: 'none' },
      { id: 'e5', fromNode: 'file-1', toNode: 'link-1', toSide: 'middle' },
    ],
  })
  const { body, title, report } = jsonCanvasToBoard(canvas, { agendaId: 'agenda-import-1', now: T0 })
  assert.equal(title, 'Canvas')
  assert.deepEqual(body.agenda, { id: 'agenda-import-1', title: 'Canvas', memberCardIds: ['link-1'], contextBindings: [] })
  assert.deepEqual([body.version, body.savedAt], [1, T0])
  assert.deepEqual(body.cards, [{ id: 'link-1', type: 'browser', geometry: { x: 400, y: 0, width: 400, height: 301, zIndex: 3 }, sourceRef: null,
    runtimeState: { uri: 'https://obsidian.md/canvas', title: '', firstUseBrowser: false, fixedLogicalHeight: null } }])
  const shapes = new Map(body.shapes.map(shape => [shape.id, shape]))
  // Canvas IDs are kept when they can be element IDs; one starting with a digit gets a prefix.
  assert.equal(shapes.get('a1b2c3d4e5f60718').runtimeState.text, '# 할 일\n\n- 견적 비교')
  assert.equal(shapes.get('jc-group-6f0ad84f44ce9c17').type, 'rect')
  assert.equal(shapes.get('jc-label-6f0ad84f44ce9c17-label').runtimeState.text, '조사 묶음')
  assert.equal(shapes.get('link-2').runtimeState.text, 'javascript:alert(1)', 'a link that is not http(s) is only text')
  assert.equal(shapes.get('file-1').runtimeState.text, 'Notes/plan.md#Goals', 'a file node never opens a file')
  assert.equal(shapes.get('long-1').runtimeState.text.length, JSON_CANVAS_LIMITS.labelText)
  assert.deepEqual(shapes.get('tiny').geometry, { x: 0, y: 0, width: 12, height: 12, zIndex: 11 }, 'the screen minimum size')
  for (const shape of body.shapes) {
    assert.ok(['rect', 'label', 'arrow', 'line'].includes(shape.type))
    assert.match(shape.runtimeState.transform, /^$|^rotate\(/)
    if (shape.runtimeState.transform) assert.match(shape.runtimeState.transform, ROTATE)
  }
  // e1: text right side (250, 30) -> link left side (400, 150.5), an arrow with its label in the middle.
  const e1 = shapes.get('e1')
  assert.deepEqual([e1.type, e1.runtimeState.x1, e1.runtimeState.y1, e1.runtimeState.x2, e1.runtimeState.y2], ['arrow', '250', '30', '400', '150.5'])
  assert.deepEqual([e1.geometry.x, e1.geometry.y, e1.geometry.height], [250, 22, 16])
  assert.equal(e1.geometry.width, Math.round(Math.hypot(150, 120.5)))
  assert.equal(shapes.get('e1-label').runtimeState.text, '참고')
  assert.equal(shapes.get('e2').type, 'line')
  // e3 points backwards (fromEnd arrow only): the arrow is drawn from link-2 to file-1.
  const e3 = shapes.get('e3')
  assert.deepEqual([e3.type, Number(e3.runtimeState.y1) < Number(e3.runtimeState.y2)], ['arrow', true])
  assert.deepEqual(report.dropped, [
    { id: 'a1b2c3d4e5f60718', reason: 'duplicate-id' }, { id: 'bad-1', reason: 'bad-geometry' }, { id: 'bad-2', reason: 'unknown-type' },
    { id: 'bad-3', reason: 'bad-color' }, { id: 'e4', reason: 'missing-node' }, { id: 'e5', reason: 'bad-toSide' },
  ])
  assert.deepEqual(report.truncated, ['long-1'])
  assert.deepEqual(report.approximated, [{ id: 'link-2', reason: 'link-not-http' }, { id: 'file-1', reason: 'file-as-label' }])
  assert.deepEqual([report.cards, report.shapes], [1, body.shapes.length])
  // An empty canvas is a valid file and an empty Board.
  assert.deepEqual(jsonCanvasToBoard({}, { now: T0, title: '빈 Canvas' }).body, { version: 1, savedAt: T0, agenda: { id: 'agenda-canvas', title: '빈 Canvas', memberCardIds: [], contextBindings: [] }, cards: [], shapes: [] })
})

test('EG-Desk -> JSON Canvas -> EG-Desk keeps Browser, result and file cards, marks, the arrow and kept freehand; other cards come back as labels', () => {
  const board = deepFreeze(sampleBoard())
  const { canvas } = boardToJsonCanvas(board, { includeAttachments: true })
  const { body, title, report } = jsonCanvasToBoard(JSON.parse(JSON.stringify(canvas)), { agendaId: 'agenda-copy', now: T0 })
  assert.equal(title, '주간 회의')
  const cards = new Map(body.cards.map(card => [card.id, card]))
  assert.deepEqual([...cards.keys()].sort(), ['egd-browser-card-1', 'egd-file-card-4', 'egd-result-card-2'])
  for (const id of cards.keys()) {
    const original = board.cards.find(card => card.id === id)
    assert.deepEqual(cards.get(id).runtimeState, original.runtimeState, id)
    assert.deepEqual({ ...cards.get(id).geometry, zIndex: 0 }, { ...original.geometry, zIndex: 0 }, id)
  }
  assert.deepEqual(cards.get('egd-browser-card-1').sourceRef, board.cards[0].sourceRef)
  assert.deepEqual(body.agenda.memberCardIds, [...cards.keys()])
  const shapes = new Map(body.shapes.map(shape => [shape.id, shape]))
  assert.equal(shapes.get('egd-terminal-card-3').runtimeState.text, '터미널 카드', 'a terminal from a file is never reopened as a terminal')
  assert.deepEqual(report.approximated, [{ id: 'egd-terminal-card-3', reason: 'card-kind-not-imported' }])
  assert.equal(shapes.get('shape-label-1').runtimeState.text, '회의록 정리')
  assert.deepEqual([shapes.get('shape-rect-2').type, shapes.get('shape-rect-2').geometry.width], ['rect', 900])
  assert.equal(shapes.get('shape-arrow-3').type, 'arrow')
  assert.deepEqual(shapes.get('shape-path-4').runtimeState.points, [[0, 0], [10, 10], [50, 50]])
  assert.deepEqual(shapes.get('shape-line-5').geometry, board.shapes[4].geometry)
  assert.ok(!shapes.has('board-agenda-weekly'), 'the Board frame does not come back as a mark')
  // Without the EG-Desk records (another app saved over them) everything is still readable.
  const plainBack = jsonCanvasToBoard(canvas, { now: T0, useEgdesk: false })
  assert.deepEqual(plainBack.body.cards.map(card => card.id), ['egd-browser-card-1'])
  assert.ok(plainBack.body.shapes.some(shape => shape.runtimeState.text === '## 요약\n\n첫 줄\n둘째 줄'))
})

test('records inside a canvas are data: only safe card kinds and http(s) addresses are trusted; bad input is refused', () => {
  const node = (id, egdesk, extra = {}) => ({ id, type: 'text', x: 0, y: 0, width: 100, height: 50, text: id, egdesk, ...extra })
  const { body, report } = jsonCanvasToBoard({ nodes: [
    node('t1', { kind: 'card', type: 'terminal', runtimeState: { command: 'rm -rf /' } }),
    node('t2', { kind: 'card', type: 'browser', runtimeState: { uri: 'file:///etc/passwd' } }),
    node('t3', { kind: 'card', type: 'browser', sourceRef: { uri: 'javascript:alert(1)', kind: 'browser' }, runtimeState: { uri: 'https://example.com/' } }),
    node('t4', { kind: 'card', type: 'result', runtimeState: { title: 'no version' } }),
    node('t5', { kind: 'shape', type: 'ellipse', runtimeState: { transform: 'translate(9px)' } }),
    node('t6', 'not an object'),
  ] }, { now: T0 })
  assert.deepEqual(body.cards.map(card => [card.id, card.type, card.runtimeState.uri, card.sourceRef]), [['t3', 'browser', 'https://example.com/', { kind: 'browser' }]])
  assert.deepEqual(body.shapes.map(shape => [shape.id, shape.type]), [['t1', 'label'], ['t2', 'label'], ['t4', 'label'], ['t5', 'ellipse'], ['t6', 'label']])
  assert.equal(body.shapes.find(shape => shape.id === 't5').runtimeState.transform, '', 'only a rotation is kept')
  assert.deepEqual(report.approximated, [{ id: 't1', reason: 'card-kind-not-imported' }])
  const rejects = (action, code) => assert.throws(action, error => error.code === code)
  for (const bad of [null, [], 'canvas', { nodes: {} }, { edges: 'x' }]) rejects(() => jsonCanvasToBoard(bad), 'INVALID_JSON_CANVAS')
  rejects(() => jsonCanvasToBoard({ nodes: Array.from({ length: JSON_CANVAS_LIMITS.nodes + 1 }, () => ({})) }), 'JSON_CANVAS_TOO_LARGE')
  rejects(() => jsonCanvasToBoard({}, { agendaId: '../x' }), 'INVALID_BOARD_ID')
  rejects(() => boardToJsonCanvas(null), 'INVALID_BOARD_BODY')
  rejects(() => boardToJsonCanvas([]), 'INVALID_BOARD_BODY')
})

test('an imported canvas saves as a Board the Desk store accepts and finds by its text', t => {
  const dataDir = createPrivateQaTempDirectory('egdesk-json-canvas-test-')
  const store = openDeskStore({ dataDir, ownerScope: 'local-desktop-v1', now: () => T0, utcOffsetMinutes: 0 })
  t.after(() => { store.close(); assert.equal(realpathSync.native(dataDir), dataDir); rmSync(dataDir, { recursive: true, force: true }) })
  const { canvas } = boardToJsonCanvas(sampleBoard(), { includeAttachments: true })
  const { body, title } = jsonCanvasToBoard(canvas, { agendaId: 'agenda-from-canvas', now: T0 })
  const saved = store.saveBoard('agenda-from-canvas', { body, expectedRevision: null, title })
  assert.deepEqual([saved.revision, saved.board.title], [1, '주간 회의'])
  assert.deepEqual(store.searchBoards({ query: '회의록' }).boards.map(board => board.boardId), ['agenda-from-canvas'])
  // And back out again: the saved body exports to the same nodes.
  assert.deepEqual(boardToJsonCanvas(store.board('agenda-from-canvas').head.body).canvas.nodes.map(node => node.type).sort(),
    canvas.nodes.map(node => node.type).sort())
})
