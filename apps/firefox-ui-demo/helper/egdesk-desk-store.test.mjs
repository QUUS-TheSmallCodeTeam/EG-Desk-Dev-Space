import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { PRIVATE_KEYS } from './egdesk-chat-store.mjs'
import { isOwnedAndPrivate } from './egdesk-private-files.mjs'
import {
  DESK_RETENTION, MAX_BOARD_BODY_BYTES, MAX_DESK_STATE_BYTES, MAX_TITLE_CHARS, contentHash, openDeskStore,
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
    const store = openDeskStore({ dataDir, ownerScope: 'local-desktop-v1', now: () => clock.now, utcOffsetMinutes: 0, ...options, ...extra })
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
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 1)
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
