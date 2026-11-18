import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { PRIVATE_KEYS } from './egdesk-chat-store.mjs'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'
import {
  BOARD_SEARCH_LIMITS, DESK_AUTOSAVE_MERGE_MS, DESK_RETENTION, MAX_BOARD_BODY_BYTES, MAX_DESK_STATE_BYTES, MAX_TITLE_CHARS,
  boardSearchText, contentHash, mergeBoardBodies, openDeskStore,
} from './egdesk-desk-store.mjs'

const T0 = Date.UTC(2026, 9, 1, 12) // Noon UTC: far from any day boundary.
const DAY = 86_400_000

function fixture(t, options = {}) {
  const dataDir = createPrivateQaTempDirectory('egdesk-desk-store-test-')
  const handles = []
  const clock = { now: T0 }
  t.after(() => {
    for (const handle of handles) handle.close()
    assert.equal(realpathSync.native(dataDir), dataDir)
    assert.match(path.basename(dataDir), /^egdesk-desk-store-test-/)
    rmSync(dataDir, { recursive: true, force: true })
  })
  const open = (extra = {}) => {
    // The autosave window is off here so each save below is its own generation;
    // the window has its own tests (merge: true).
    const { merge, ...rest } = { ...options, ...extra }
    const store = openDeskStore({ dataDir, ownerScope: 'local-desktop-v1', now: () => clock.now, utcOffsetMinutes: 0, autosaveMergeMs: merge ? undefined : 0, ...rest })
    handles.push(store)
    return store
  }
  const file = store => path.join(dataDir, `desk-${store.ownerScopeHash}.sqlite`)
  return { dataDir, open, clock, file }
}
// Shapes follow what the screen already writes (egdesk.deskSession.v1 / agendaState.v1).
const desk = (n, extra = {}) => ({
  version: 1, savedAt: T0 + n,
  desk: { pan: { x: n, y: 0 }, zoom: 1, activeAgendaId: 'agenda-default' },
  cards: Array.from({ length: n % 5 }, (_, index) => ({ id: `card-${index}`, type: 'browser', runtimeState: { uri: `https://example.com/search?q=${n}-${index}` } })),
  shapes: [],
  ...extra,
})
const board = (title, extra = {}) => ({
  version: 1, savedAt: T0,
  agenda: { id: 'agenda-a', title, memberCardIds: ['card-1'], contextBindings: [] },
  cards: [{ id: 'card-1', type: 'file', geometry: { x: 1, y: 2, width: 3, height: 4 } }], shapes: [],
  ...extra,
})
const rejects = (action, code, status) => assert.throws(action, error => error.code === code && (status === undefined || error.httpStatus === status))
const range = (from, to) => Array.from({ length: Math.abs(to - from) + 1 }, (_, index) => from > to ? from - index : from + index)
function privateKeysIn(value, found = []) {
  if (Array.isArray(value)) for (const item of value) privateKeysIn(item, found)
  else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))) found.push(key)
    privateKeysIn(child, found)
  }
  return found
}

test('each Desk save is a generation; equal content (savedAt aside) makes none; a stale parent is 409 with the latest generation', t => {
  const { open } = fixture(t)
  const store = open()
  const empty = store.current()
  assert.deepEqual([empty.generation, empty.state, empty.lastImport, empty.seq], [null, null, null, null])
  assert.deepEqual(store.generations().generations, [])

  const first = store.saveCurrent({ state: desk(1), parentGeneration: null })
  assert.deepEqual([first.generation, first.parent, first.seq, first.reason, first.unchanged, first.cardCount, first.shapeCount, first.createdAt], [1, null, 1, 'autosave', false, 1, 0, T0])
  assert.equal(first.state, undefined, 'a save answer does not echo the state')
  assert.equal(first.stateHash, contentHash(desk(1)))
  // The screen stamps savedAt on every write; that alone is not a change.
  const same = store.saveCurrent({ state: { ...desk(1), savedAt: T0 + 999 }, parentGeneration: 1 })
  assert.deepEqual([same.generation, same.unchanged], [1, true])
  const second = store.saveCurrent({ state: desk(2), parentGeneration: 1, reason: 'explicit' })
  assert.deepEqual([second.generation, second.parent, second.seq, second.reason, second.unchanged], [2, 1, 2, 'explicit', false])

  assert.throws(() => store.saveCurrent({ state: desk(3), parentGeneration: 1 }),
    error => error.code === 'DESK_GENERATION_CONFLICT' && error.httpStatus === 409 && error.generation === 2 && error.stateHash === second.stateHash)
  rejects(() => store.saveCurrent({ state: desk(3), parentGeneration: null }), 'DESK_GENERATION_CONFLICT', 409)
  // A retried save whose answer was lost: same content, old parent → the generation it made.
  const retried = store.saveCurrent({ state: desk(2), parentGeneration: 1, reason: 'explicit' })
  assert.deepEqual([retried.generation, retried.unchanged], [2, true])

  const current = store.current()
  assert.deepEqual([current.generation, current.reason, current.state, current.lastImport], [2, 'explicit', desk(2), null])
  const listed = store.generations()
  assert.deepEqual(listed.generations.map(item => [item.generation, item.parent, item.reason]), [[2, 1, 'explicit'], [1, null, 'autosave']])
  assert.equal(listed.head, 2)
  assert.ok(listed.generations.every(item => item.state === undefined), 'lists carry no state')
  assert.deepEqual(listed.retention, { ...DESK_RETENTION })
  const paged = store.generations({ limit: 1 })
  assert.deepEqual([paged.generations.map(item => item.generation), paged.hasMore, paged.nextBefore], [[2], true, 2])
  assert.deepEqual(store.generations({ limit: 1, before: 2 }).generations.map(item => item.generation), [1])
  assert.deepEqual(store.generation(1).state, desk(1))

  // Key order never changes the hash; array order does.
  assert.equal(contentHash({ a: 1, b: { c: 2, d: 3 } }), contentHash({ b: { d: 3, c: 2 }, a: 1 }))
  assert.notEqual(contentHash({ a: [1, 2] }), contentHash({ a: [2, 1] }))
  rejects(() => store.saveCurrent({ state: desk(4), parentGeneration: 2, reason: 'import' }), 'INVALID_DESK_REASON')
  rejects(() => store.saveCurrent({ state: desk(4) }), 'INVALID_DESK_GENERATION')
  rejects(() => store.saveCurrent({ state: desk(4), parentGeneration: 0 }), 'INVALID_DESK_GENERATION')
  rejects(() => store.saveCurrent({ state: [desk(4)], parentGeneration: 2 }), 'INVALID_DESK_STATE')
  rejects(() => store.generation(99), 'DESK_GENERATION_NOT_FOUND', 404)
  rejects(() => store.generations({ limit: 501 }), 'INVALID_DESK_QUERY')
  assert.deepEqual(store.listBoards().boards, [], 'Desk saves never create Boards')
})

test('restore publishes an earlier generation as a new one and keeps the current one in the journal', t => {
  const { open, clock } = fixture(t)
  const store = open()
  store.saveCurrent({ state: desk(1), parentGeneration: null })
  store.saveCurrent({ state: desk(2), parentGeneration: 1 })
  const third = store.saveCurrent({ state: desk(3), parentGeneration: 2 })
  clock.now = T0 + 5000
  const restored = store.restore({ generation: 1 })
  assert.deepEqual([restored.generation, restored.parent, restored.seq, restored.reason, restored.restoredFrom, restored.unchanged, restored.createdAt],
    [4, 3, 4, 'restore', 1, false, T0 + 5000])
  assert.equal(restored.stateHash, store.generation(1).stateHash)
  assert.deepEqual(store.current().state, desk(1))
  assert.equal(store.generation(3).stateHash, third.stateHash, 'the replaced Desk stays restorable')
  // Restoring what is already the head changes nothing.
  assert.deepEqual([store.restore({ generation: 1 }).unchanged, store.current().generation], [true, 4])
  assert.throws(() => store.restore({ generation: 2, parentGeneration: 3 }), error => error.code === 'DESK_GENERATION_CONFLICT' && error.generation === 4)
  rejects(() => store.restore({ generation: 99 }), 'DESK_GENERATION_NOT_FOUND', 404)
  rejects(() => store.restore({}), 'INVALID_DESK_GENERATION')
  assert.equal(store.saveCurrent({ state: desk(5), parentGeneration: 4 }).generation, 5)
})

test('retention keeps the newest 200 plus the newest of each of the last 30 days, and never the head (fixed rule)', t => {
  const { open, clock } = fixture(t)
  const store = open()
  assert.deepEqual({ ...DESK_RETENTION }, { recent: 200, dailyDays: 30, maxBytes: 512 * 1024 * 1024 })
  let parent = null, n = 0
  const save = () => { const saved = store.saveCurrent({ state: desk(++n), parentGeneration: parent }); parent = saved.generation; return saved }
  const kept = () => store.generations({ limit: 500 }).generations.map(item => item.generation)
  // One generation a day for days 0..34 (generation = day + 1) ...
  for (let day = 0; day < 35; day++) { clock.now = T0 + day * DAY; save() }
  assert.equal(kept().length, 35)
  // ... then 199 more on day 34, so day 34 holds generations 35..234.
  for (let index = 1; index <= 199; index++) { clock.now = T0 + 34 * DAY + index * 1000; save() }
  // Newest 200 = 234..35 (all day 34); days 5..33 keep their only generation (6..34); 1..5 are gone.
  assert.deepEqual(kept(), [...range(234, 35), ...range(34, 6)])
  // Time alone moves the window: on day 40 days 5..10 leave it, and 35 drops out of the newest 200.
  clock.now = T0 + 40 * DAY
  const later = save()
  assert.deepEqual([later.generation, later.pruned], [235, 7])
  assert.deepEqual(kept(), [...range(235, 36), ...range(34, 12)])
  assert.equal(store.current().generation, 235)
})

test('the byte budget drops the oldest kept generations first and never the head', t => {
  const states = range(1, 6).map(n => desk(n, { note: 'x'.repeat(1000) }))
  const sizes = states.map(state => Buffer.byteLength(JSON.stringify(state)))
  // Exactly the three newest fit.
  const { open } = fixture(t, { retention: { recent: 10, dailyDays: 1, maxBytes: sizes[3] + sizes[4] + sizes[5] } })
  const store = open()
  let parent = null
  for (const state of states) parent = store.saveCurrent({ state, parentGeneration: parent }).generation
  assert.deepEqual(store.generations().generations.map(item => item.generation), [6, 5, 4])
  const tiny = open({ ownerScope: 'tiny-budget', retention: { recent: 10, dailyDays: 1, maxBytes: 1 } })
  parent = null
  for (let n = 1; n <= 3; n++) parent = tiny.saveCurrent({ state: desk(n), parentGeneration: parent }).generation
  assert.deepEqual(tiny.generations().generations.map(item => item.generation), [3], 'the head stays even over budget')
  for (const retention of [{ recent: 0 }, { dailyDays: 1.5 }, { keepForever: true }]) rejects(() => open({ ownerScope: 'bad', retention }), 'INVALID_STORE_OPTIONS')
})

test('the generation list counts the open Boards of each point from the saved text; one record carries none', t => {
  const { open } = fixture(t)
  const store = open()
  const projections = { 'egd-board-1': { id: 'egd-board-1', boardId: 'agenda-a', title: '주간 보고' }, 'egd-board-2': { id: 'egd-board-2', boardId: 'agenda-b', title: '회의' } }
  const first = store.saveCurrent({ state: desk(1), parentGeneration: null })
  store.saveCurrent({ state: desk(2, { boardProjections: { projections, activeProjectionId: null } }), parentGeneration: first.generation })
  store.saveCurrent({ state: desk(3, { boardProjections: { projections: null } }), parentGeneration: 2, reason: 'explicit' })
  assert.deepEqual(store.generations().generations.map(item => [item.generation, item.cardCount, item.boardCount]), [[3, 3, 0], [2, 2, 2], [1, 1, 0]])
  assert.equal('boardCount' in store.generation(2), false, 'the full record keeps the saved shape; the screen counts it from state')
  assert.equal('boardCount' in first, false)
})

test('Board revisions are immutable: create, expectedRevision conflicts, retries, title metadata and revert', t => {
  const { open, file } = fixture(t)
  const store = open()
  const created = store.saveBoard('agenda-a', { body: board('기획'), expectedRevision: null })
  assert.deepEqual([created.revision, created.unchanged, created.boardCreated, created.board.title, created.board.headRevision, created.board.metadataVersion, created.board.lifecycle],
    [1, false, true, '기획', 1, 1, 'active'])
  assert.deepEqual([store.saveBoard('agenda-a', { body: board('기획'), expectedRevision: null }).unchanged], [true])
  assert.throws(() => store.saveBoard('agenda-a', { body: board('기획', { cards: [] }), expectedRevision: null }),
    error => error.code === 'BOARD_REVISION_CONFLICT' && error.httpStatus === 409 && error.headRevision === 1)

  const second = store.saveBoard('agenda-a', { body: board('기획', { cards: [] }), expectedRevision: 1 })
  assert.deepEqual([second.revision, second.unchanged, second.boardCreated, second.board.headRevision], [2, false, false, 2])
  // Another window still on revision 1 cannot overwrite revision 2.
  assert.throws(() => store.saveBoard('agenda-a', { body: board('기획', { shapes: [{ id: 's' }] }), expectedRevision: 1 }),
    error => error.code === 'BOARD_REVISION_CONFLICT' && error.headRevision === 2)
  // A retried save whose answer was lost returns the revision it made; savedAt alone is no change.
  assert.deepEqual([store.saveBoard('agenda-a', { body: board('기획', { cards: [] }), expectedRevision: 1 }).revision, store.saveBoard('agenda-a', { body: board('기획', { cards: [], savedAt: T0 + 5 }), expectedRevision: 2 }).unchanged], [2, true])
  assert.throws(() => store.saveBoard('agenda-new', { body: board('새'), expectedRevision: 3 }), error => error.code === 'BOARD_REVISION_CONFLICT' && error.headRevision === null)

  // Renaming with the same composition changes metadataVersion only.
  const renamed = store.saveBoard('agenda-a', { body: board('기획', { cards: [] }), expectedRevision: 2, title: '기획 v2' })
  assert.deepEqual([renamed.revision, renamed.unchanged, renamed.board.title, renamed.board.metadataVersion], [2, true, '기획 v2', 2])

  const reverted = store.revertBoard('agenda-a', { revision: 1 })
  assert.deepEqual([reverted.revision, reverted.revertedFrom, reverted.unchanged, reverted.hash, reverted.board.title], [3, 1, false, created.hash, '기획 v2'])
  assert.deepEqual(store.boardRevision('agenda-a', 3).body, store.boardRevision('agenda-a', 1).body)
  assert.deepEqual(store.boardRevisions('agenda-a').revisions.map(item => [item.revision, item.parentRevision, item.author, item.revertedFrom]),
    [[3, 2, 'user', 1], [2, 1, 'user', null], [1, null, 'user', null]])
  assert.ok(store.boardRevisions('agenda-a').revisions.every(item => item.body === undefined))
  assert.deepEqual([store.revertBoard('agenda-a', { revision: 1 }).unchanged, store.revertBoard('agenda-a', { revision: 1 }).revertedFrom], [true, null])
  rejects(() => store.revertBoard('agenda-a', { revision: 2, expectedRevision: 2 }), 'BOARD_REVISION_CONFLICT', 409)
  assert.equal(store.revertBoard('agenda-a', { revision: 2, expectedRevision: 3 }).revision, 4)
  rejects(() => store.revertBoard('agenda-a', { revision: 9 }), 'BOARD_REVISION_NOT_FOUND', 404)
  rejects(() => store.revertBoard('agenda-missing', { revision: 1 }), 'BOARD_NOT_FOUND', 404)
  rejects(() => store.saveBoard('../escape', { body: board('x'), expectedRevision: null }), 'INVALID_BOARD_ID')
  rejects(() => store.saveBoard('agenda-b', { body: board('x') }), 'INVALID_BOARD_REVISION')

  // Titles: 80 characters fit, 81 do not; a body without agenda.title is named Board.
  assert.equal(store.saveBoard('agenda-80', { body: board('t'), expectedRevision: null, title: '가'.repeat(MAX_TITLE_CHARS) }).board.title, '가'.repeat(80))
  rejects(() => store.saveBoard('agenda-81', { body: board('t'), expectedRevision: null, title: '가'.repeat(81) }), 'INVALID_BOARD_TITLE')
  assert.equal(store.saveBoard('agenda-plain', { body: { cards: [] }, expectedRevision: null }).board.title, 'Board')

  assert.deepEqual(store.listBoards().boards.map(item => item.boardId).sort(), ['agenda-80', 'agenda-a', 'agenda-plain'])
  assert.deepEqual([store.board('agenda-a').headRevision, store.board('agenda-a').head.revision], [4, 4])
  assert.equal(store.board('agenda-missing'), null)
  assert.equal(store.current().generation, null, 'Board saves never make Desk generations')

  const raw = new DatabaseSync(file(store))
  t.after(() => raw.close())
  assert.throws(() => raw.prepare("UPDATE board_revisions SET body_json='{}' WHERE board_id='agenda-a'").run(), /immutable/)
  assert.throws(() => raw.prepare("DELETE FROM board_revisions WHERE board_id='agenda-a'").run(), /kept/)
  store.saveCurrent({ state: desk(1), parentGeneration: null })
  assert.throws(() => raw.prepare("UPDATE desk_generations SET state_json='{}'").run(), /immutable/)
  assert.equal(store.boardRevisions('agenda-a').revisions.length, 4)
})

test('earlier preference values import once; the same import is a duplicate; nothing is overwritten', t => {
  const { open, clock } = fixture(t)
  const store = open()
  // What the screen holds today: the deskSession string and the agendaState Boards.
  const agendaStore = { version: 2, agendas: { 'agenda-a': board('기획'), 'agenda-b': board('회의') }, meta: { 'agenda-a': { title: '기획' }, 'agenda-b': { title: '회의 준비' } } }
  const boards = Object.entries(agendaStore.agendas).map(([boardId, body]) => ({ boardId, title: agendaStore.meta[boardId].title, body: JSON.stringify(body) }))
  const first = store.importPrefs({ deskSnapshot: JSON.stringify(desk(3)), boards })
  assert.equal(first.duplicate, false)
  assert.deepEqual(first.desk, { status: 'imported', generation: 1, skipReason: null })
  assert.deepEqual(first.boards.map(item => [item.boardId, item.status, item.revision, item.skipReason]), [['agenda-a', 'imported', 1, null], ['agenda-b', 'imported', 1, null]])
  const current = store.current()
  assert.deepEqual([current.reason, current.state, current.lastImport], ['import', desk(3), { importId: first.importId, importedAt: T0 }])
  assert.deepEqual([store.boardRevision('agenda-b', 1).author, store.board('agenda-b').title], ['import', '회의 준비'])

  // The same values again (as objects this time) are recognised by hash.
  clock.now = T0 + 1000
  const again = store.importPrefs({ deskSnapshot: desk(3), boards: boards.map(item => ({ ...item, body: JSON.parse(item.body) })) })
  assert.deepEqual(again, { ...first, duplicate: true })
  assert.equal(store.generations().generations.length, 1)

  // After the screen moved on, a different import adds new Boards only.
  store.saveCurrent({ state: desk(4), parentGeneration: 1 })
  store.saveBoard('agenda-a', { body: board('기획', { cards: [] }), expectedRevision: 1 })
  const later = store.importPrefs({ deskSnapshot: desk(1), boards: [{ boardId: 'agenda-a', body: board('옛 기획') }, { boardId: 'agenda-c', title: 'x'.repeat(120), body: board('새 Board') }] })
  assert.deepEqual(later.desk, { status: 'skipped', generation: 2, skipReason: 'DESK_EXISTS' })
  assert.deepEqual(later.boards.map(item => [item.boardId, item.status, item.revision, item.skipReason]), [['agenda-a', 'skipped', 2, 'BOARD_EXISTS'], ['agenda-c', 'imported', 1, null]])
  assert.equal(store.board('agenda-c').title, '새 Board', 'an over-long earlier title falls back to the body title')
  assert.deepEqual([store.current().generation, store.current().state, store.board('agenda-a').headRevision], [2, desk(4), 2])
  assert.equal(store.current().lastImport.importId, later.importId)

  // Bad input writes nothing.
  rejects(() => store.importPrefs({ deskSnapshot: '{not json' }), 'DESK_IMPORT_UNREADABLE')
  rejects(() => store.importPrefs({ deskSnapshot: 'null' }), 'DESK_IMPORT_UNREADABLE')
  rejects(() => store.importPrefs({ boards: [{ boardId: 'agenda-d', body: '{' }] }), 'DESK_IMPORT_UNREADABLE')
  rejects(() => store.importPrefs({ boards: [{ boardId: 'agenda-d', body: board('d') }, { boardId: 'agenda-d', body: board('d') }] }), 'INVALID_DESK_IMPORT')
  rejects(() => store.importPrefs({ boards: [{ boardId: 'agenda-d', body: board('d') }, { boardId: 'agenda-e', body: { apiKey: 'x' } }] }), 'PRIVATE_BOARD_PAYLOAD')
  rejects(() => store.importPrefs({}), 'INVALID_DESK_IMPORT')
  rejects(() => store.importPrefs({ deskSnapshot: desk(1), extra: true }), 'INVALID_DESK_IMPORT')
  assert.deepEqual([store.board('agenda-d'), store.board('agenda-e'), store.generations().generations.length], [null, null, 2])
})

test('size limits, private fields and non-JSON values are refused before any write', t => {
  const { open } = fixture(t)
  const store = open()
  assert.throws(() => store.saveCurrent({ state: desk(1, { blob: 'x'.repeat(MAX_DESK_STATE_BYTES) }), parentGeneration: null }),
    error => error.code === 'DESK_STATE_TOO_LARGE' && error.httpStatus === 413)
  assert.equal(store.current().generation, null)
  const pad = MAX_DESK_STATE_BYTES - Buffer.byteLength(JSON.stringify(desk(1, { blob: '' })))
  const edge = desk(1, { blob: 'x'.repeat(pad) })
  assert.equal(Buffer.byteLength(JSON.stringify(edge)), MAX_DESK_STATE_BYTES)
  assert.equal(store.saveCurrent({ state: edge, parentGeneration: null }).bytes, MAX_DESK_STATE_BYTES)
  rejects(() => store.saveBoard('agenda-big', { body: board('b', { blob: 'x'.repeat(MAX_BOARD_BODY_BYTES) }), expectedRevision: null }), 'BOARD_BODY_TOO_LARGE', 413)

  for (const key of ['cookie', 'apiKey', 'access_token', 'Authorization', 'client-secret']) {
    rejects(() => store.saveCurrent({ state: desk(2, { cards: [{ id: 'c', runtimeState: { [key]: 'x' } }] }), parentGeneration: 1 }), 'PRIVATE_DESK_PAYLOAD')
  }
  rejects(() => store.saveBoard('agenda-p', { body: board('p', { secret: 'x' }), expectedRevision: null }), 'PRIVATE_BOARD_PAYLOAD')
  const cyclic = { a: {} }
  cyclic.a.b = cyclic
  let deep = {}
  for (let index = 0; index < 150; index++) deep = { deep }
  for (const state of [{ a: Number.NaN }, { a: new Date(0) }, { a: undefined }, cyclic, deep, null]) {
    rejects(() => store.saveCurrent({ state, parentGeneration: 1 }), 'INVALID_DESK_STATE')
  }
  assert.deepEqual([store.current().generation, store.listBoards().boards], [1, []])

  // Browser URLs and queries are kept exactly as the screen sent them: no new fields, none dropped.
  const browsing = desk(3)
  store.saveCurrent({ state: browsing, parentGeneration: 1 })
  assert.deepEqual(store.current().state.cards.map(card => card.runtimeState.uri), ['https://example.com/search?q=3-0', 'https://example.com/search?q=3-1', 'https://example.com/search?q=3-2'])
})

test('every public answer shape passes the chat store private-field gate', t => {
  const { open } = fixture(t)
  const store = open()
  const shapes = {
    imported: store.importPrefs({ deskSnapshot: desk(1), boards: [{ boardId: 'agenda-a', title: '기획', body: board('기획') }] }),
    saved: store.saveCurrent({ state: desk(2), parentGeneration: 1 }),
    restored: store.restore({ generation: 1 }),
    current: store.current(), generations: store.generations(), generation: store.generation(1),
    board: store.saveBoard('agenda-a', { body: board('기획', { cards: [] }), expectedRevision: 1 }),
    reverted: store.revertBoard('agenda-a', { revision: 1 }),
    boards: store.listBoards(), view: store.board('agenda-a'), revisions: store.boardRevisions('agenda-a'), revision: store.boardRevision('agenda-a', 1),
  }
  assert.deepEqual(privateKeysIn(shapes), [])
  for (const [name, shape] of Object.entries(shapes)) assert.doesNotThrow(() => JSON.stringify(shape), name)
})

test('the Desk database is private (0600 file, 0700 directory) and everything survives a restart', t => {
  const { dataDir, open, clock, file } = fixture(t, { retention: { recent: 1, dailyDays: 1, maxBytes: 1024 * 1024 } })
  const store = open()
  store.importPrefs({ boards: [{ boardId: 'agenda-a', title: '기획', body: board('기획') }] })
  for (let n = 1; n <= 3; n++) store.saveCurrent({ state: desk(n), parentGeneration: n === 1 ? null : n - 1 })
  store.saveBoard('agenda-a', { body: board('기획', { cards: [] }), expectedRevision: 1 })
  const filename = file(store)
  if (process.platform !== 'win32') {
    assert.equal(statSync(filename).mode & 0o777, 0o600)
    assert.equal(statSync(dataDir).mode & 0o077, 0)
    if (existsSync(`${filename}-wal`)) assert.equal(statSync(`${filename}-wal`).mode & 0o077, 0, 'the WAL file is as private as the database')
  }
  assert.ok(isOwnedAndPrivate(filename, lstatSync(filename), 0o077))
  const before = { current: store.current(), boards: store.listBoards(), revisions: store.boardRevisions('agenda-a'), generations: store.generations() }
  assert.deepEqual(before.generations.generations.map(item => item.generation), [3], 'recent 1 keeps only the head')
  store.close()

  clock.now = T0 + 60_000
  const reopened = open()
  assert.deepEqual({ current: reopened.current(), boards: reopened.listBoards(), revisions: reopened.boardRevisions('agenda-a'), generations: reopened.generations() }, before)
  // Generation numbers are never reused after pruning, and seq continues.
  const next = reopened.saveCurrent({ state: desk(4), parentGeneration: 3 })
  assert.deepEqual([next.generation, next.parent, next.seq], [4, 3, 4])
  const raw = new DatabaseSync(filename, { readOnly: true })
  t.after(() => raw.close())
  assert.equal(raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3)
})

test('unsafe or unknown store files are refused without changing them', t => {
  const { dataDir, open, file } = fixture(t)
  rejects(() => openDeskStore({ dataDir: 'relative', ownerScope: 'x' }), 'INVALID_STORE_SCOPE')
  rejects(() => openDeskStore({ dataDir, ownerScope: '' }), 'INVALID_STORE_SCOPE')
  rejects(() => openDeskStore({ dataDir, ownerScope: 'x', utcOffsetMinutes: 0.5 }), 'INVALID_STORE_OPTIONS')

  // A database written by something else is left as it is.
  const foreign = open({ ownerScope: 'foreign' })
  const foreignFile = file(foreign)
  foreign.close()
  rmSync(foreignFile)
  writeFileSync(foreignFile, '', { mode: 0o600 })
  const other = new DatabaseSync(foreignFile)
  other.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)')
  other.close()
  rejects(() => open({ ownerScope: 'foreign' }), 'UNSUPPORTED_STORE_VERSION')
  const check = new DatabaseSync(foreignFile, { readOnly: true })
  assert.deepEqual(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name), ['notes'])
  check.close()

  // A missing immutability trigger is a damaged schema, not something to rebuild.
  const damaged = open({ ownerScope: 'damaged' })
  const damagedFile = file(damaged)
  damaged.saveCurrent({ state: desk(1), parentGeneration: null })
  damaged.close()
  const edit = new DatabaseSync(damagedFile)
  edit.exec('DROP TRIGGER desk_generations_immutable')
  edit.close()
  rejects(() => open({ ownerScope: 'damaged' }), 'STORE_CORRUPT')

  // A state whose text no longer matches its hash is reported, never served.
  const tampered = open({ ownerScope: 'tampered' })
  const tamperedFile = file(tampered)
  tampered.saveCurrent({ state: desk(1), parentGeneration: null })
  const writer = new DatabaseSync(tamperedFile)
  writer.exec(`DROP TRIGGER desk_generations_immutable;
    UPDATE desk_generations SET state_json='{"version":1,"forged":true}';
    CREATE TRIGGER desk_generations_immutable BEFORE UPDATE ON desk_generations BEGIN SELECT RAISE(ABORT, 'desk generations are immutable'); END;`)
  writer.close()
  rejects(() => tampered.current(), 'STORE_CORRUPT', 500)
  rejects(() => tampered.generation(1), 'STORE_CORRUPT', 500)

  if (process.platform === 'win32') return
  const loose = open({ ownerScope: 'loose' })
  const looseFile = file(loose)
  loose.close()
  const bytes = readFileSync(looseFile)
  chmodSync(looseFile, 0o666)
  rejects(() => open({ ownerScope: 'loose' }), 'INVALID_STORE_SCOPE')
  assert.equal(statSync(looseFile).mode & 0o777, 0o666, 'permissions are not tightened behind the user')
  assert.deepEqual(readFileSync(looseFile), bytes)
  const shared = path.join(dataDir, 'shared')
  openDeskStore({ dataDir: shared, ownerScope: 'x' }).close()
  chmodSync(shared, 0o755)
  rejects(() => openDeskStore({ dataDir: shared, ownerScope: 'x' }), 'INVALID_STORE_SCOPE')
})

// ── 2-RT: autosave window, chat kept once, Board search, card merge, schema v2 ──

test('autosaves within 60 seconds become one recovery point; explicit saves and the next window always add one', t => {
  const { open, clock } = fixture(t, { merge: true })
  const store = open()
  assert.equal(store.autosaveMergeMs, DESK_AUTOSAVE_MERGE_MS)
  assert.equal(DESK_AUTOSAVE_MERGE_MS, 60_000)
  const first = store.saveCurrent({ state: desk(1), parentGeneration: null })
  assert.deepEqual([first.generation, first.merged, first.replacedGeneration], [1, false, null])
  // Moving cards around: each autosave replaces the head of the same window.
  clock.now = T0 + 10_000
  const moved = store.saveCurrent({ state: desk(2), parentGeneration: 1 })
  assert.deepEqual([moved.generation, moved.parent, moved.seq, moved.merged, moved.replacedGeneration, moved.createdAt], [2, null, 1, true, 1, T0 + 10_000])
  rejects(() => store.generation(1), 'DESK_GENERATION_NOT_FOUND', 404)
  // The window is anchored at its first save, so 59 s after it still merges ...
  clock.now = T0 + 59_000
  assert.deepEqual(Object.values((({ generation, merged }) => ({ generation, merged }))(store.saveCurrent({ state: desk(3), parentGeneration: 2 }))), [3, true])
  // ... and 61 s after it starts a new recovery point on top of the merged one.
  clock.now = T0 + 61_000
  const next = store.saveCurrent({ state: desk(4), parentGeneration: 3 })
  assert.deepEqual([next.generation, next.parent, next.seq, next.merged], [4, 3, 2, false])
  // An explicit save always adds a row and ends the window.
  clock.now = T0 + 62_000
  const explicit = store.saveCurrent({ state: desk(5), parentGeneration: 4, reason: 'explicit' })
  assert.deepEqual([explicit.generation, explicit.merged, explicit.reason], [5, false, 'explicit'])
  clock.now = T0 + 63_000
  assert.equal(store.saveCurrent({ state: desk(6), parentGeneration: 5 }).merged, false, 'never merged into an explicit save')
  clock.now = T0 + 64_000
  assert.deepEqual([store.saveCurrent({ state: desk(7), parentGeneration: 6 }).generation, store.current().state], [7, desk(7)])
  assert.deepEqual(store.generations().generations.map(item => [item.generation, item.reason, item.parent, item.seq]),
    [[7, 'autosave', 5, 4], [5, 'explicit', 4, 3], [4, 'autosave', 3, 2], [3, 'autosave', null, 1]])
  // A restore is its own recovery point, and an autosave after it is too.
  const restored = store.restore({ generation: 4 })
  assert.deepEqual([restored.generation, restored.merged], [8, false])
  assert.equal(store.saveCurrent({ state: desk(9), parentGeneration: 8 }).merged, false)
  for (const autosaveMergeMs of [-1, 1.5, DAY + 1]) rejects(() => open({ ownerScope: 'bad-window', autosaveMergeMs }), 'INVALID_STORE_OPTIONS')
})

test('a head another window collided with is never merged away: the overwritten work stays in the journal', t => {
  const { open, clock } = fixture(t, { merge: true })
  const store = open()
  store.saveCurrent({ state: desk(1), parentGeneration: null })
  clock.now = T0 + 1000
  // Window B saved on top of 1 (merging its own window), then window A, still on 1 ...
  const b = store.saveCurrent({ state: desk(2), parentGeneration: 1 })
  assert.deepEqual([b.generation, b.merged], [2, true])
  clock.now = T0 + 2000
  assert.throws(() => store.saveCurrent({ state: desk(3), parentGeneration: 1 }), error => error.code === 'DESK_GENERATION_CONFLICT' && error.generation === 2)
  // ... retries on the latest generation: a new row, B's Desk is kept.
  const a = store.saveCurrent({ state: desk(3), parentGeneration: 2 })
  assert.deepEqual([a.generation, a.merged, a.parent], [3, false, 2])
  assert.deepEqual(store.generation(2).state, desk(2))
  // A's own next autosave in the same window merges again (A wrote 3).
  clock.now = T0 + 3000
  assert.deepEqual([store.saveCurrent({ state: desk(4), parentGeneration: 3 }).merged], [true])
})

const chatDesk = (messagesA, messagesB = [{ id: 'b-1', role: 'user', text: '다른 방 첫 메시지' }], extra = {}) => ({
  ...desk(1),
  chat: {
    threads: [
      { id: 'thread-a', type: 'dm', title: 'Codex', participants: ['나', 'Codex'], messages: messagesA, unreadCount: 0 },
      { id: 'thread-b', type: 'group', title: '보드 방', messages: messagesB, unreadCount: 1 },
      { id: 'thread-empty', type: 'dm', title: '빈 방', messages: [] },
      { id: 'thread-none', type: 'dm', title: '목록 없음', messages: null },
    ],
    activeThreadId: 'thread-a', threadDrafts: {},
  },
  ...extra,
})
const message = (n, text = `메시지 ${n} ${'내용 '.repeat(50)}`) => ({ id: `a-${n}`, role: n % 2 ? 'user' : 'assistant', text, status: 'complete' })

test('chat transcripts in a Desk are kept once per message: generations share them and reads return the exact state', t => {
  const { open, file } = fixture(t, { retention: { recent: 2, dailyDays: 1, maxBytes: 512 * 1024 * 1024 } })
  const store = open()
  const one = chatDesk([message(1), message(2)])
  const two = chatDesk([message(1), message(2), message(3)])
  const three = chatDesk([message(1), message(2), message(3), message(4)])
  store.saveCurrent({ state: one, parentGeneration: null })
  store.saveCurrent({ state: two, parentGeneration: 1 })
  // Same text, same key order, empty and missing lists untouched.
  assert.equal(JSON.stringify(store.current().state), JSON.stringify(two))
  assert.equal(JSON.stringify(store.generation(1).state), JSON.stringify(one))
  assert.equal(store.current().bytes, Buffer.byteLength(JSON.stringify(two)), 'bytes is the size the screen sent')
  const raw = new DatabaseSync(file(store), { readOnly: true })
  t.after(() => raw.close())
  const blobs = () => raw.prepare('SELECT hash, refs FROM desk_blobs ORDER BY hash').all().map(row => ({ ...row }))
  // a-1, a-2 shared by both generations; a-3 in one; b-1 shared.
  assert.deepEqual(blobs().map(row => row.refs).sort(), [1, 2, 2, 2])
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM desk_generations WHERE instr(state_json, '메시지 1') > 0").get().n, 0, 'no transcript copy inside a generation')
  // Pruning lets go of messages nobody holds any more (recent: 2).
  store.saveCurrent({ state: three, parentGeneration: 2 })
  assert.deepEqual(store.generations().generations.map(item => item.generation), [3, 2])
  assert.deepEqual(blobs().map(row => row.refs).sort(), [1, 2, 2, 2, 2])
  store.saveCurrent({ state: desk(9), parentGeneration: 3 })
  store.saveCurrent({ state: desk(10), parentGeneration: 4 })
  assert.deepEqual(blobs(), [], 'a Desk without chat holds no messages')
  // Restore brings the transcript back from an earlier generation's copy.
  store.saveCurrent({ state: three, parentGeneration: 5 })
  store.saveCurrent({ state: two, parentGeneration: 6 })
  store.restore({ generation: 6 })
  assert.equal(JSON.stringify(store.current().state), JSON.stringify(three))
  assert.deepEqual(blobs().map(row => row.refs).sort(), [1, 2, 2, 2, 2])
  // A missing or changed message is reported, never served.
  const writer = new DatabaseSync(file(store))
  writer.exec("DELETE FROM desk_blobs WHERE hash IN (SELECT hash FROM desk_blobs LIMIT 1)")
  writer.close()
  rejects(() => store.current(), 'STORE_CORRUPT', 500)
  const tampered = open({ ownerScope: 'tampered-chat' })
  tampered.saveCurrent({ state: one, parentGeneration: null })
  const edit = new DatabaseSync(file(tampered))
  edit.exec("DROP TRIGGER desk_blobs_fixed; UPDATE desk_blobs SET json = '{\"id\":\"a-1\",\"role\":\"user\",\"text\":\"forged\"}' WHERE json LIKE '%a-1%'")
  edit.close()
  rejects(() => tampered.current(), 'STORE_CORRUPT', 500)
})

test('the byte budget counts a shared chat message once', t => {
  const long = Array.from({ length: 20 }, (_, n) => message(n + 1, `긴 메시지 ${n} ${'x'.repeat(2000)}`))
  const states = [1, 2, 3].map(n => chatDesk(long, undefined, { note: n }))
  const full = Buffer.byteLength(JSON.stringify(states[0]))
  // Three full copies would not fit; one transcript plus three small Desks does.
  const { open } = fixture(t, { retention: { recent: 10, dailyDays: 1, maxBytes: Math.floor(full * 1.5) } })
  const store = open()
  let parent = null
  for (const state of states) parent = store.saveCurrent({ state, parentGeneration: parent }).generation
  assert.deepEqual(store.generations().generations.map(item => item.generation), [3, 2, 1])
  // A budget below one transcript keeps only the head.
  const tight = open({ ownerScope: 'tight', retention: { recent: 10, dailyDays: 1, maxBytes: Math.floor(full / 2) } })
  parent = null
  for (const state of states) parent = tight.saveCurrent({ state, parentGeneration: parent }).generation
  assert.deepEqual(tight.generations().generations.map(item => item.generation), [3])
  assert.equal(JSON.stringify(tight.current().state), JSON.stringify(states[2]))
})

const searchBoard = (title, { cards = [], labels = [], memos } = {}) => ({
  version: 1, savedAt: T0,
  agenda: { id: 'agenda-x', title, memberCardIds: cards.map(card => card.id), contextBindings: [] },
  cards, shapes: labels.map((text, index) => ({ id: `label-${index}`, type: 'label', geometry: { x: 0, y: 0, width: 10, height: 10 }, runtimeState: { transform: '', text } })),
  ...(memos ? { memos } : {}),
})
const browserCard = (id, uri, pageTitle) => ({ id, type: 'browser', geometry: { x: 0, y: 0, width: 10, height: 10 }, runtimeState: { uri, title: pageTitle } })

test('Board search finds title, card names and memo text, Korean short words included, best match first', t => {
  const { open, clock } = fixture(t)
  const store = open()
  assert.equal(store.searchIndex, 'fts5-trigram')
  store.saveBoard('agenda-weekly', { body: searchBoard('주간 회의', { cards: [browserCard('c1', 'https://docs.example.com/%EA%B8%B0%ED%9A%8D?token=abc', '분기 기획서')], labels: ['회의록 정리 담당: 민수'] }), expectedRevision: null })
  clock.now = T0 + 1000
  store.saveBoard('agenda-design', { body: searchBoard('Design Review', { cards: [{ id: 'f1', type: 'file', runtimeState: { root: { name: '디자인 시안' } } }], memos: [{ id: 'm1', text: '회의 전에 색 대비 확인', replies: [{ id: 'r1', text: 'Figma 링크 첨부' }] }] }), expectedRevision: null })
  clock.now = T0 + 2000
  store.saveBoard('agenda-misc', { body: searchBoard('기타', { labels: ['100% 완료_표시'] }), expectedRevision: null })
  const ids = query => store.searchBoards({ query }).boards.map(board => board.boardId)
  // Two-letter Korean words match as substrings; the title match ranks first.
  assert.deepEqual(ids('회의'), ['agenda-weekly', 'agenda-design'])
  assert.deepEqual(ids('회의록'), ['agenda-weekly'])
  assert.deepEqual(ids('기획서'), ['agenda-weekly'], 'Browser page title is a card name')
  assert.deepEqual(ids('docs.example.com/기획'), ['agenda-weekly'], 'the site and decoded path are searchable')
  assert.deepEqual(ids('token=abc'), [], 'the query string is not indexed')
  assert.deepEqual(ids('figma'), ['agenda-design'], 'memo replies, any letter case')
  assert.deepEqual(ids('디자인 시안'), ['agenda-design'])
  assert.deepEqual(ids('회의 대비'), ['agenda-design'], 'every word must appear')
  assert.deepEqual(ids('100%'), ['agenda-misc'])
  assert.deepEqual(ids('0%'), ['agenda-misc'])
  assert.deepEqual(ids('완료_'), ['agenda-misc'], '% and _ are plain letters')
  assert.deepEqual(ids('_표'), ['agenda-misc'])
  assert.deepEqual(ids('없는말'), [])
  const hit = store.searchBoards({ query: '회의록' })
  assert.deepEqual(hit.boards[0].fields, ['notes'])
  assert.equal(hit.boards[0].snippet, '회의록 정리 담당: 민수')
  assert.deepEqual([hit.index, hit.query, hit.boards[0].title, hit.boards[0].headRevision], ['fts5-trigram', '회의록', '주간 회의', 1])
  assert.deepEqual(store.searchBoards({ query: '주간' }).boards[0].snippet, null, 'a title-only hit needs no snippet')
  assert.equal(store.searchBoards({ query: '회의', limit: 1 }).boards.length, 1)

  // The index follows every head change: edits, a title change alone, revert, imports.
  clock.now = T0 + 3000
  store.saveBoard('agenda-weekly', { body: searchBoard('주간 회의', { labels: ['안건 확정'] }), expectedRevision: 1 })
  assert.deepEqual([ids('회의록'), ids('안건')], [[], ['agenda-weekly']])
  store.saveBoard('agenda-weekly', { body: searchBoard('주간 회의', { labels: ['안건 확정'] }), expectedRevision: 2, title: '월간 점검' })
  assert.deepEqual([ids('월간 점검'), ids('주간')], [['agenda-weekly'], []])
  store.revertBoard('agenda-weekly', { revision: 1 })
  assert.deepEqual([ids('회의록'), ids('안건')], [['agenda-weekly'], []])
  store.importPrefs({ boards: [{ boardId: 'agenda-old', title: '예전 보드', body: searchBoard('예전 보드', { labels: ['가져온 메모'] }) }] })
  store.importPortable({ boards: [{ boardId: 'agenda-copy', title: '복사본', body: searchBoard('복사본', { labels: ['묶음 메모'] }) }] })
  assert.deepEqual([ids('가져온'), ids('묶음 메모')], [['agenda-old'], ['agenda-copy']])

  for (const query of [undefined, '', '   ', 'x'.repeat(BOARD_SEARCH_LIMITS.queryChars + 1), 'a b c d e f g h i', 5]) rejects(() => store.searchBoards({ query }), 'INVALID_BOARD_QUERY')
  for (const limit of [0, 101, 1.5]) rejects(() => store.searchBoards({ query: '회의', limit }), 'INVALID_BOARD_QUERY')
  assert.deepEqual(boardSearchText({ cards: [null, { type: 'browser', runtimeState: { uri: 'javascript:alert(1)', title: 7 } }], shapes: [{ type: 'rect' }], memos: 'x' }), { cards: '', notes: '' })
})

test('three-way Board merge: different cards combine, same card both changed is a listed conflict, deletes never beat changes', () => {
  const card = (id, x, extra = {}) => ({ id, type: 'file', geometry: { x, y: 0, width: 100, height: 100 }, ...extra })
  const body = (cards, agenda = {}, extra = {}) => ({ version: 1, savedAt: T0, agenda: { id: 'agenda-a', title: '기획', memberCardIds: cards.map(item => item.id), contextBindings: [], ...agenda }, cards, shapes: [], ...extra })
  const base = Object.freeze(body([card('c1', 0), card('c2', 100), card('c3', 200)]))
  // Mine moved c1, deleted c3, added c4; theirs edited c2 and added c5 (another window).
  const mine = body([card('c1', 50), card('c2', 100), card('c4', 400)], {}, { savedAt: T0 + 5 })
  const theirs = body([card('c1', 0), card('c2', 100, { title: '수정' }), card('c3', 200), card('c5', 500)], {}, { savedAt: T0 + 9 })
  const clean = mergeBoardBodies({ base, mine, theirs })
  assert.equal(clean.clean, true)
  assert.deepEqual(clean.conflicts, [])
  assert.deepEqual(clean.body.cards.map(item => [item.id, item.geometry.x, item.title ?? null]), [['c1', 50, null], ['c2', 100, '수정'], ['c5', 500, null], ['c4', 400, null]])
  assert.deepEqual(clean.body.agenda.memberCardIds, ['c1', 'c2', 'c5', 'c4'])
  assert.equal(clean.body.savedAt, T0 + 9)
  assert.deepEqual(mergeBoardBodies({ base, mine: base, theirs }).body, theirs, 'an untouched side takes the other side')

  // Both moved c1: mine wins by default, theirs when asked; the conflict carries both.
  const both = mergeBoardBodies({ base, mine: body([card('c1', 50), card('c2', 100), card('c3', 200)]), theirs: body([card('c1', 70), card('c2', 100), card('c3', 200)]) })
  assert.deepEqual([both.clean, both.body.cards[0].geometry.x], [false, 50])
  assert.deepEqual(both.conflicts.map(item => [item.kind, item.id, item.reason, item.kept, item.mine.geometry.x, item.theirs.geometry.x]), [['card', 'c1', 'both-changed', 'mine', 50, 70]])
  assert.equal(mergeBoardBodies({ base, mine: body([card('c1', 50), card('c2', 100), card('c3', 200)]), theirs: body([card('c1', 70), card('c2', 100), card('c3', 200)]), prefer: 'theirs' }).body.cards[0].geometry.x, 70)

  // Mine deleted c2 while theirs changed it: the changed card stays (and stays a member).
  const deleted = mergeBoardBodies({ base, mine: body([card('c1', 0), card('c3', 200)]), theirs: body([card('c1', 0), card('c2', 999), card('c3', 200)]) })
  assert.deepEqual(deleted.body.cards.map(item => item.id), ['c1', 'c2', 'c3'])
  assert.deepEqual(deleted.body.agenda.memberCardIds, ['c1', 'c2', 'c3'])
  assert.deepEqual(deleted.conflicts.map(item => [item.id, item.reason, item.kept, item.mine]), [['c2', 'mine-deleted', 'theirs', null]])
  const theirsDeleted = mergeBoardBodies({ base, mine: body([card('c1', 0), card('c2', 5), card('c3', 200)]), theirs: body([card('c1', 0), card('c3', 200)]) })
  assert.deepEqual(theirsDeleted.conflicts.map(item => [item.id, item.reason, item.kept]), [['c2', 'theirs-deleted', 'mine']])

  // Both added the same id differently; both renamed the Board; marks merge the same way.
  const added = mergeBoardBodies({ base, mine: body([...base.cards, card('c9', 1)], { title: '기획안' }), theirs: body([...base.cards, card('c9', 2)], { title: '기획 v2' }) })
  assert.deepEqual(added.conflicts.map(item => [item.kind, item.id ?? item.path, item.reason, item.kept]), [['field', 'agenda.title', 'both-changed', 'mine'], ['card', 'c9', 'both-added', 'mine']])
  const marks = mergeBoardBodies({ base: { shapes: [{ id: 's1', type: 'rect' }] }, mine: { shapes: [{ id: 's1', type: 'rect' }, { id: 's2', type: 'label' }] }, theirs: { shapes: [] } })
  assert.deepEqual(marks.body.shapes.map(item => item.id), ['s2'])
  // No common base: everything both added.
  assert.deepEqual(mergeBoardBodies({ base: null, mine: body([card('c1', 0)]), theirs: body([card('c2', 0)]) }).body.cards.map(item => item.id), ['c2', 'c1'])
  const refuse = input => assert.throws(() => mergeBoardBodies(input), error => error.code === 'INVALID_BOARD_MERGE')
  refuse({ base, mine: null, theirs })
  refuse({ base, mine, theirs, prefer: 'newest' })
  refuse({ base, mine: body([card('c1', 0), card('c1', 1)]), theirs })
  refuse({ base, mine: { cards: [{ type: 'file' }] }, theirs })
  refuse({ base, mine: { cards: 'c1' }, theirs })
  assert.deepEqual(base.cards.map(item => item.geometry.x), [0, 100, 200], 'inputs are not changed')
})

test('mergeBoard merges an edit that started from an older revision onto the head without writing, then the merged body saves', t => {
  const { open } = fixture(t)
  const store = open()
  const card = (id, x) => ({ id, type: 'file', geometry: { x, y: 0, width: 100, height: 100 } })
  const body = cards => ({ version: 1, savedAt: T0, agenda: { id: 'agenda-a', title: '기획', memberCardIds: cards.map(item => item.id), contextBindings: [] }, cards, shapes: [] })
  store.saveBoard('agenda-a', { body: body([card('c1', 0), card('c2', 100)]), expectedRevision: null })
  store.saveBoard('agenda-a', { body: body([card('c1', 0), card('c2', 100), card('c3', 300)]), expectedRevision: 1 })
  const windowA = body([card('c1', 40), card('c2', 100)])
  rejects(() => store.saveBoard('agenda-a', { body: windowA, expectedRevision: 1 }), 'BOARD_REVISION_CONFLICT', 409)
  const merged = store.mergeBoard('agenda-a', { body: windowA, baseRevision: 1 })
  assert.deepEqual([merged.baseRevision, merged.headRevision, merged.clean, merged.unchanged], [1, 2, true, false])
  assert.deepEqual(merged.body.cards.map(item => [item.id, item.geometry.x]), [['c1', 40], ['c2', 100], ['c3', 300]])
  assert.equal(merged.hash, contentHash(merged.body))
  assert.equal(store.boardRevisions('agenda-a').revisions.length, 2, 'merging writes nothing')
  assert.equal(store.saveBoard('agenda-a', { body: merged.body, expectedRevision: merged.headRevision }).revision, 3)
  assert.equal(store.mergeBoard('agenda-a', { body: merged.body, baseRevision: 3 }).unchanged, true)
  rejects(() => store.mergeBoard('agenda-a', { body: windowA, baseRevision: 9 }), 'BOARD_REVISION_NOT_FOUND', 404)
  rejects(() => store.mergeBoard('agenda-missing', { body: windowA, baseRevision: 1 }), 'BOARD_NOT_FOUND', 404)
  rejects(() => store.mergeBoard('agenda-a', { body: { ...windowA, secret: 'x' }, baseRevision: 1 }), 'PRIVATE_BOARD_PAYLOAD')
  assert.deepEqual(privateKeysIn([merged, store.searchBoards({ query: '기획' })]), [])
})

// Frozen copy of the schema shipped as user_version 1.
const DESK_V1_SCHEMA = `
    CREATE TABLE desk_generations (
      generation INTEGER PRIMARY KEY AUTOINCREMENT,
      parent INTEGER, seq INTEGER NOT NULL CHECK (seq > 0), state_hash TEXT NOT NULL,
      created INTEGER NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('autosave','explicit','import','restore')),
      restored_from INTEGER, card_count INTEGER, shape_count INTEGER,
      bytes INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 4194304),
      state_json TEXT NOT NULL
    );
    CREATE TRIGGER desk_generations_immutable BEFORE UPDATE ON desk_generations
      BEGIN SELECT RAISE(ABORT, 'desk generations are immutable'); END;
    CREATE TABLE boards (
      board_id TEXT PRIMARY KEY, title TEXT NOT NULL, head_revision INTEGER NOT NULL,
      metadata_version INTEGER NOT NULL CHECK (metadata_version > 0),
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active','archived')),
      created INTEGER NOT NULL, updated INTEGER NOT NULL,
      FOREIGN KEY(board_id, head_revision) REFERENCES board_revisions(board_id, revision) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE board_revisions (
      board_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
      parent_revision INTEGER, hash TEXT NOT NULL,
      author TEXT NOT NULL CHECK (author IN ('user','import')),
      reverted_from INTEGER,
      bytes INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 4194304),
      body_json TEXT NOT NULL, created INTEGER NOT NULL,
      PRIMARY KEY(board_id, revision),
      FOREIGN KEY(board_id) REFERENCES boards(board_id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TRIGGER board_revisions_immutable BEFORE UPDATE ON board_revisions
      BEGIN SELECT RAISE(ABORT, 'board revisions are immutable'); END;
    CREATE TRIGGER board_revisions_kept BEFORE DELETE ON board_revisions
      BEGIN SELECT RAISE(ABORT, 'board revisions are kept'); END;
    CREATE TABLE desk_imports (import_hash TEXT PRIMARY KEY, created INTEGER NOT NULL, result_json TEXT NOT NULL);
    CREATE TABLE store_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
`
function writeDeskV1(open, file, ownerScope) {
  // Created through the store so the file is private, then rebuilt as v1.
  const created = open({ ownerScope })
  const filename = file(created)
  created.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(filename + suffix, { force: true })
  writeFileSync(filename, '', { mode: 0o600 })
  const db = new DatabaseSync(filename)
  db.exec('PRAGMA journal_mode=WAL;')
  db.exec(`BEGIN; ${DESK_V1_SCHEMA} PRAGMA user_version=1; COMMIT;`)
  const state = chatDesk([message(1), message(2)])
  const stateJson = JSON.stringify(state)
  db.prepare('INSERT INTO desk_generations (parent, seq, state_hash, created, reason, restored_from, card_count, shape_count, bytes, state_json) VALUES (NULL, 1, ?, ?, ?, NULL, 1, 0, ?, ?)').run(contentHash(state), T0, 'autosave', Buffer.byteLength(stateJson), stateJson)
  const old = searchBoard('예전 회의', { labels: ['v1에서 쓴 메모'] })
  const oldJson = JSON.stringify(old)
  db.exec('BEGIN')
  db.prepare("INSERT INTO boards VALUES ('agenda-v1', '예전 회의', 1, 1, 'active', ?, ?)").run(T0, T0)
  db.prepare("INSERT INTO board_revisions VALUES ('agenda-v1', 1, NULL, ?, 'user', NULL, ?, ?, ?)").run(contentHash(old), Buffer.byteLength(oldJson), oldJson, T0)
  db.exec('COMMIT')
  db.close()
  return { filename, state, old }
}

test('a v1 Desk database is backed up, then opens as v2 with every generation and Board kept and searchable', t => {
  const { open, file, clock } = fixture(t)
  const { filename, state, old } = writeDeskV1(open, file, 'desk-v1')
  const store = open({ ownerScope: 'desk-v1' })
  assert.equal(JSON.stringify(store.current().state), JSON.stringify(state), 'a v1 generation keeps its full text and reads as before')
  assert.deepEqual(store.board('agenda-v1').head.body, old)
  assert.deepEqual(store.searchBoards({ query: 'v1에서' }).boards.map(board => board.boardId), ['agenda-v1'], 'existing Boards are indexed during the upgrade')
  clock.now = T0 + 1000
  const next = store.saveCurrent({ state: chatDesk([message(1), message(2), message(3)]), parentGeneration: 1 })
  assert.deepEqual([next.generation, next.parent, next.seq], [2, 1, 2])
  assert.deepEqual(store.generation(1).state, state)
  store.close()
  const raw = new DatabaseSync(filename, { readOnly: true })
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3)
  assert.equal(raw.prepare('SELECT chat_refs_json FROM desk_generations WHERE generation=1').get().chat_refs_json, null)
  raw.close()
  const backup = `${filename}.v1.bak`
  assert.ok(isOwnedAndPrivate(backup, statSync(backup), 0o077))
  const copy = new DatabaseSync(backup, { readOnly: true })
  assert.deepEqual([copy.prepare('PRAGMA user_version').get().user_version, copy.prepare('SELECT COUNT(*) AS n FROM desk_generations').get().n], [1, 1])
  copy.close()
  // Reopening v2 neither migrates again nor rewrites the backup.
  const before = readFileSync(backup)
  const again = open({ ownerScope: 'desk-v1' })
  assert.equal(again.current().generation, 2)
  assert.deepEqual(readFileSync(backup), before)

  // An incomplete v1 or v2 schema fails closed: no backup, no migration, no reset.
  const broken = writeDeskV1(open, file, 'desk-v1-broken')
  const edit = new DatabaseSync(broken.filename)
  edit.exec('DROP TABLE desk_imports')
  edit.close()
  rejects(() => open({ ownerScope: 'desk-v1-broken' }), 'STORE_CORRUPT')
  assert.equal(existsSync(`${broken.filename}.v1.bak`), false)
  const v2 = open({ ownerScope: 'desk-v2-broken' })
  const v2File = file(v2)
  v2.close()
  const drop = new DatabaseSync(v2File)
  drop.exec('DROP TABLE board_search')
  drop.close()
  rejects(() => open({ ownerScope: 'desk-v2-broken' }), 'STORE_CORRUPT')
  const meta = open({ ownerScope: 'desk-v2-meta' })
  const metaFile = file(meta)
  meta.close()
  const unmark = new DatabaseSync(metaFile)
  unmark.exec("DELETE FROM store_meta WHERE name='board_search'")
  unmark.close()
  rejects(() => open({ ownerScope: 'desk-v2-meta' }), 'STORE_CORRUPT')
})

test('without FTS5 the same search runs on a plain index (substring match for every word)', t => {
  const { open, file } = fixture(t)
  const created = open({ ownerScope: 'plain-search' })
  created.saveBoard('agenda-weekly', { body: searchBoard('주간 회의', { labels: ['회의록 정리'] }), expectedRevision: null })
  const filename = file(created)
  created.close()
  // What a SQLite build without FTS5 would have made.
  const raw = new DatabaseSync(filename)
  raw.exec(`BEGIN;
    CREATE TABLE board_search_plain (board_id TEXT PRIMARY KEY, title TEXT NOT NULL, cards TEXT NOT NULL, notes TEXT NOT NULL);
    INSERT INTO board_search_plain SELECT board_id, title, cards, notes FROM board_search;
    DROP TABLE board_search;
    ALTER TABLE board_search_plain RENAME TO board_search;
    UPDATE store_meta SET value='plain' WHERE name='board_search';
    COMMIT;`)
  raw.close()
  const store = open({ ownerScope: 'plain-search' })
  assert.equal(store.searchIndex, 'plain')
  store.saveBoard('agenda-design', { body: searchBoard('Design Review', { labels: ['회의 전 확인'] }), expectedRevision: null })
  const ids = query => store.searchBoards({ query }).boards.map(board => board.boardId)
  assert.deepEqual(ids('회의록'), ['agenda-weekly'])
  assert.deepEqual(ids('회의'), ['agenda-weekly', 'agenda-design'], 'title match first')
  assert.deepEqual(ids('Design 확인'), ['agenda-design'])
  assert.equal(store.searchBoards({ query: '회의록' }).index, 'plain')
  store.saveBoard('agenda-weekly', { body: searchBoard('주간 회의', { labels: ['안건'] }), expectedRevision: 1 })
  assert.deepEqual([ids('회의록'), ids('안건')], [[], ['agenda-weekly']])
})
