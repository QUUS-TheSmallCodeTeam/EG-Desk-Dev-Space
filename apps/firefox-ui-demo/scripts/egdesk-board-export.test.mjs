import test from 'node:test'
import assert from 'node:assert/strict'
import { realpathSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { boardCanvasFilename, createEGDeskBoardExport } from '../overlay/resources/EGDeskBoardExport.sys.mjs'
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs'
import { openDeskStore } from '../helper/egdesk-desk-store.mjs'
import { handleDeskHttp } from '../helper/egdesk-desk-http.mjs'

const projection = (boardId = 'board-a', title = '회의 Board') => ({ boardId, title, hasStoredBoard: true, hasUnsavedChanges: false })
const packet = () => ({ canvas: { nodes: [
  { id: 'a', type: 'link', x: 0, y: 0, width: 100, height: 100, url: 'https://example.com/' },
  { id: 'f', type: 'text', x: 200, y: 0, width: 100, height: 100, text: '파일 카드', egdesk: { kind: 'card', type: 'file', omitted: 'attachment' } },
], edges: [], egdesk: { version: 1, shapes: [{ id: 'freehand', type: 'path' }] } }, report: { nodes: 2, edges: 0, omitted: [{ id: 'freehand', kind: 'shape', reason: 'freehand' }] } })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
function fixture({ request, saveText, onState } = {}) {
  const requests = [], saves = [], writes = [], states = []
  const flow = createEGDeskBoardExport({
    request: (path, options) => { requests.push({ path, options }); return request ? request(path, options) : Promise.resolve(packet()) },
    saveText: async options => { saves.push(options); if (saveText) return saveText(options, writes)
      if (!options.beginWrite()) return { cancelled: true }
      writes.push({ fileName: options.fileName, text: options.text }); return { saved: true }
    },
    onState: value => { states.push(value); onState?.(value) },
  })
  return { flow, requests, saves, writes, states }
}

test('filenames are bounded portable basenames with exactly one .canvas extension', () => {
  assert.equal(boardCanvasFilename('회의 자료'), '회의 자료.canvas')
  assert.equal(boardCanvasFilename('이미.canvas.CANVAS'), '이미.canvas')
  assert.equal(boardCanvasFilename('CON'), 'Board-CON.canvas')
  assert.equal(boardCanvasFilename('NUL.txt'), 'Board-NUL.txt.canvas')
  assert.equal(boardCanvasFilename(' ... '), 'Board.canvas')
  for (const title of ['../../unsafe\\name:*?<>|"\n', '\u202efile', '😀'.repeat(1000), '가'.repeat(1000)]) {
    const name = boardCanvasFilename(title)
    assert.match(name, /\.canvas$/); assert.doesNotMatch(name, /[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/)
    assert.ok(!name.startsWith('.')); assert.ok(Buffer.byteLength(name) <= 200)
  }
})

test('the clicked Board projection is frozen and only canvas JSON is written with conversion notes separately', async () => {
  const response = deferred(), h = fixture({ request: () => response.promise }), clicked = projection()
  const pending = h.flow.exportBoard(clicked)
  clicked.boardId = 'later-board'; clicked.title = 'later title'; clicked.hasUnsavedChanges = true
  assert.equal(h.requests[0].path, '/v1/boards/board-a/export?format=json-canvas')
  assert.deepEqual(Object.keys(h.requests[0].options).sort(), ['method', 'signal'])
  assert.equal(h.requests[0].options.method, 'GET')
  response.resolve(packet())
  const result = await pending
  assert.equal(result.status, 'saved'); assert.equal(result.boardId, 'board-a'); assert.equal(result.fileName, '회의 Board.canvas')
  assert.equal(h.writes.length, 1); assert.deepEqual(JSON.parse(h.writes[0].text), packet().canvas)
  assert.equal(Object.hasOwn(JSON.parse(h.writes[0].text), 'report'), false)
  assert.deepEqual(result.report, packet().report)
  assert.ok(result.notes.some(note => note.includes('첨부·캡처 1개')))
  assert.ok(result.notes.some(note => note.includes('직접 표시되지 않는 항목 1개')))
  assert.deepEqual(h.states.map(state => state.status), ['fetching', 'saving', 'saved'])
  assert.ok(Object.isFrozen(result.report.omitted)); assert.ok(Object.isFrozen(result.notes))
})

test('absent and unknown stored-Board evidence asks for Save without requests or writes', async () => {
  for (const fields of [{ hasStoredBoard: false }, { hasStoredBoard: undefined }, { hasStoredBoard: null }]) {
    const h = fixture(), result = await h.flow.exportBoard({ ...projection(), ...fields })
    assert.equal(result.status, 'needs-save'); assert.match(result.message, /먼저.*저장.*자동으로 저장하지/)
    assert.equal(h.requests.length, 0); assert.equal(h.saves.length, 0); assert.equal(h.writes.length, 0)
  }
})

test('existing saved Boards export despite unsaved or unknown draft state, with a clear exclusion note', async () => {
  for (const hasUnsavedChanges of [true, undefined]) {
    const h = fixture()
    const result = await h.flow.exportBoard({ ...projection(), hasUnsavedChanges })
    assert.equal(result.status, 'saved'); assert.equal(h.requests.length, 1); assert.equal(h.writes.length, 1)
    assert.deepEqual(JSON.parse(h.writes[0].text), packet().canvas)
    for (const state of h.states) assert.ok(state.notes.some(note => note.includes('미저장 변경은 포함하지 않습니다')))
    assert.equal(h.states.some(state => state.status === 'needs-save'), false)
    assert.equal(h.requests[0].options.method, 'GET'); assert.equal(Object.hasOwn(h.requests[0].options, 'body'), false)
  }
})

test('invalid Board IDs cannot become paths or cause any save', async () => {
  for (const boardId of [null, '', '../board', 'board/a', 'board?a=1', 'a'.repeat(129)]) {
    const h = fixture()
    assert.equal((await h.flow.exportBoard(projection(boardId))).code, 'BOARD_EXPORT_INPUT')
    assert.equal(h.requests.length, 0); assert.equal(h.saves.length, 0)
  }
})

test('a missing stored Board asks for Save but does not create it or retry', async () => {
  for (const request of [async () => { throw Object.assign(new Error('not found'), { code: 'BOARD_NOT_FOUND' }) }, async () => ({ code: 'BOARD_NOT_FOUND', error: 'not found' })]) {
    const h = fixture({ request })
    assert.equal((await h.flow.exportBoard(projection())).status, 'needs-save')
    assert.equal(h.requests.length, 1); assert.equal(h.saves.length, 0)
  }
})

test('duplicate clicks share one request, picker and write without retargeting', async () => {
  const response = deferred(), saved = deferred()
  const h = fixture({ request: () => response.promise, saveText: async (options, writes) => {
    assert.equal(options.beginWrite(), true); assert.equal(options.beginWrite(), false)
    writes.push(options.text); return saved.promise
  } })
  const first = h.flow.exportBoard(projection())
  assert.equal(h.flow.exportBoard(projection('board-b')), first)
  response.resolve(packet()); await settle()
  assert.equal(h.flow.exportBoard(projection()), first)
  assert.equal(h.requests.length, 1); assert.equal(h.saves.length, 1); assert.equal(h.writes.length, 1)
  saved.resolve({ saved: true }); assert.equal((await first).boardId, 'board-a')
})

test('cancellation resolves independently of a pending request and its late response never writes', async () => {
  const response = deferred(), h = fixture({ request: () => response.promise })
  const pending = h.flow.exportBoard(projection())
  assert.equal(h.flow.cancel().status, 'cancelled')
  assert.equal((await pending).status, 'cancelled'); assert.equal(h.requests[0].options.signal.aborted, true)
  response.resolve(packet()); await settle()
  assert.equal(h.saves.length, 0); assert.equal(h.writes.length, 0)
  assert.deepEqual(h.states.map(state => state.status), ['fetching', 'cancelled'])
})

test('picker cancellation and pre-write save failures never report success or write', async () => {
  for (const [saveText, status] of [[async () => ({ cancelled: true }), 'cancelled'], [async () => { throw new Error('picker failed') }, 'failed'],
    [async () => ({ saved: false }), 'failed'], [async () => undefined, 'failed']]) {
    const h = fixture({ saveText }), result = await h.flow.exportBoard(projection())
    assert.equal(result.status, status); assert.equal(h.writes.length, 0)
    assert.equal(h.states.some(state => state.status === 'saved'), false); assert.equal(h.requests.length, 1)
  }
})

test('view rebinding fences old responses, including an ABA Board return, without updating the new view', async () => {
  const old = deferred(); let count = 0
  const h = fixture({ request: () => ++count === 1 ? old.promise : Promise.resolve(packet()) })
  const first = h.flow.exportBoard(projection())
  h.flow.invalidate()
  assert.equal((await first).status, 'stale')
  const second = await h.flow.exportBoard(projection('board-a', '새 화면'))
  assert.equal(second.status, 'saved')
  const states = h.states.length
  old.resolve(packet()); await settle()
  assert.equal(h.states.length, states); assert.equal(h.saves.length, 1)
  assert.equal(h.saves[0].fileName, '새 화면.canvas'); assert.equal(h.flow.snapshot(), second)
})

test('cancel, invalidate and dispose during a pending picker revoke the actual write gate', async () => {
  for (const action of ['cancel', 'invalidate', 'dispose']) {
    const picker = deferred()
    const h = fixture({ saveText: async (options, writes) => {
      await picker.promise
      if (!options.beginWrite()) return { cancelled: true }
      writes.push(options.text); return { saved: true }
    } })
    const pending = h.flow.exportBoard(projection()); await settle()
    assert.equal(h.saves.length, 1)
    h.flow[action]()
    assert.equal((await pending).status, action === 'cancel' ? 'cancelled' : 'stale')
    const states = h.states.length
    picker.resolve(); await settle()
    assert.equal(h.writes.length, 0); assert.equal(h.states.length, states)
    if (action === 'dispose') {
      assert.equal((await h.flow.exportBoard(projection())).status, 'disposed'); assert.equal(h.requests.length, 1)
    }
  }
})

test('interruption or failure after actual write permission stays unknown and never claims rollback', async () => {
  for (const action of ['cancel', 'invalidate', 'dispose', 'reject']) {
    const receipt = deferred()
    const h = fixture({ saveText: async (options, writes) => { assert.equal(options.beginWrite(), true); writes.push(options.text); return receipt.promise } })
    const pending = h.flow.exportBoard(projection()); await settle()
    if (action === 'reject') receipt.reject(new Error('reply lost after write'))
    else h.flow[action]()
    const result = await pending
    assert.equal(result.status, 'unknown'); assert.equal(h.writes.length, 1)
    const states = h.states.length
    if (action !== 'reject') receipt.resolve({ saved: true })
    await settle(); assert.equal(h.states.length, states)
    assert.equal(h.states.some(state => state.status === 'saved'), false)
    assert.equal(h.requests.length, 1); assert.equal(h.saves.length, 1)
  }
})

test('a save receipt without the required dispatch gate or a contradictory receipt is never success', async () => {
  for (const saveText of [async () => ({ saved: true }), async options => { options.beginWrite(); return { saved: true, cancelled: true } },
    async options => { options.beginWrite(); return { cancelled: true } }]) {
    const h = fixture({ saveText })
    assert.equal((await h.flow.exportBoard(projection())).status, 'unknown')
    assert.equal(h.states.some(state => state.status === 'saved'), false)
  }
})

test('malformed responses and request failures never reach save and never expose raw error paths', async () => {
  for (const request of [async () => ({}), async () => ({ ...packet(), report: { nodes: 99, edges: 0, omitted: [] } }),
    async () => { throw new Error('secret provider detail at /private/error-path') }]) {
    const h = fixture({ request }), result = await h.flow.exportBoard(projection())
    assert.equal(result.status, 'failed'); assert.equal(h.saves.length, 0)
    assert.doesNotMatch(JSON.stringify(result), /private\/error-path|secret provider/)
  }
})

test('response text is snapshotted before save and onState errors cannot replay or misreport a write', async () => {
  const original = packet()
  const h = fixture({ request: async () => original, onState: () => { throw new Error('UI failed') }, saveText: async (options, writes) => {
    original.canvas.nodes[0].url = 'https://later.example/'
    original.report.omitted[0].reason = 'later'
    assert.equal(options.beginWrite(), true); writes.push(options.text); return { saved: true }
  } })
  const result = await h.flow.exportBoard(projection())
  assert.equal(result.status, 'saved'); assert.equal(result.report.omitted[0].reason, 'freehand')
  assert.equal(JSON.parse(h.writes[0]).nodes[0].url, 'https://example.com/')
  assert.equal(h.writes.length, 1)
})

test('reentrant cancellation from a presentation update cannot start a request or a write', async () => {
  for (const status of ['fetching', 'saving']) {
    let flow
    const h = fixture({ onState: state => { if (state.status === status) flow.cancel() } }); flow = h.flow
    assert.equal((await flow.exportBoard(projection())).status, 'cancelled')
    assert.equal(h.requests.length, status === 'fetching' ? 0 : 1); assert.equal(h.saves.length, 0)
  }
})

test('dirty Board export uses the actual stored head once, keeping the live draft, saved revision and Desk unchanged', async t => {
  const dataDir = createPrivateQaTempDirectory('egdesk-board-export-test-')
  const store = openDeskStore({ dataDir, ownerScope: 'local-desktop-v1' })
  t.after(() => { store.close(); assert.equal(realpathSync.native(dataDir), dataDir); rmSync(dataDir, { recursive: true, force: true }) })
  const body = { version: 1, agenda: { id: 'board-a', title: '저장 Board' }, cards: [
    { id: 'b', type: 'browser', geometry: { x: 0, y: 0, width: 100, height: 100 }, runtimeState: { uri: 'https://example.com/saved' } },
    { id: 'f', type: 'file', geometry: { x: 200, y: 0, width: 100, height: 100 }, runtimeState: { root: { name: '파일', displayPath: '/private/never-export-path' } } },
  ], shapes: [] }
  store.saveBoard('board-a', { body, expectedRevision: null })
  const liveDraft = structuredClone(body)
  liveDraft.cards[0].runtimeState.uri = 'https://unsaved.example/not-exported'
  const beforeDraft = structuredClone(liveDraft)
  const before = { board: store.board('board-a'), desk: store.current(), revisions: store.boardRevisions('board-a') }
  const h = fixture({ request: async (path, options) => {
    const req = Readable.from([]); req.url = path; req.method = options.method; req.headers = { host: '127.0.0.1:39218' }; req.socket = { remoteAddress: '127.0.0.1' }
    let response
    await handleDeskHttp(req, new URL(path, 'http://127.0.0.1:39218'), { store, send: (status, data) => { response = { status, data } } })
    assert.equal(response.status, 200); return response.data
  } })
  const result = await h.flow.exportBoard({ ...projection(), hasUnsavedChanges: true, draft: liveDraft })
  assert.equal(result.status, 'saved'); assert.equal(h.requests.length, 1); assert.equal(h.writes.length, 1)
  const canvas = JSON.parse(h.writes[0].text)
  assert.equal(canvas.nodes.find(node => node.id === 'b').url, 'https://example.com/saved')
  assert.equal(canvas.nodes.find(node => node.id === 'f').egdesk.omitted, 'attachment')
  assert.doesNotMatch(h.writes[0].text, /never-export-path/)
  assert.doesNotMatch(h.writes[0].text, /unsaved\.example/)
  assert.deepEqual(liveDraft, beforeDraft)
  assert.deepEqual({ board: store.board('board-a'), desk: store.current(), revisions: store.boardRevisions('board-a') }, before)
})
