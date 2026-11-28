import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WORKFLOW_STORE_FILE, openWorkflowStore } from './egdesk-workflow-store.mjs'

// Every store is closed before its folder is removed (no write can race the removal).
async function folder(t, prefix = 'egdesk-workflow-store-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  const opened = []
  t.after(async () => {
    for (const store of opened) store.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, open: (directory = path.join(root, 'store')) => { const store = openWorkflowStore({ directory }); opened.push(store); return store } }
}
const event = (seq, type = 'example') => ({ seq, at: '2026-10-24T00:00:00.000Z', type })

test('opens one private SQLite file with WAL, FULL durability and a versioned schema', async t => {
  const f = await folder(t)
  const store = f.open()
  assert.equal(path.basename(store.filename), WORKFLOW_STORE_FILE)
  assert.equal((await stat(store.filename)).mode & 0o777, 0o600)
  assert.equal((await stat(store.directory)).mode & 0o777, 0o700)
  const db = new DatabaseSync(store.filename, { readOnly: true })
  try {
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1)
  } finally { db.close() }
  store.close()
  assert.equal(store.closed, true)
  assert.throws(() => store.events.count(), { code: 'WORKFLOW_STORE_CLOSED' })
})

test('task events are append-only: in seq order, never updated or deleted, and a stale writer is refused', async t => {
  const f = await folder(t)
  const store = f.open()
  assert.equal(store.events.append(0, [event(1), event(2)]), 2)
  assert.deepEqual(store.events.rows().map(row => [row.seq, JSON.parse(row.json).type]), [[1, 'example'], [2, 'example']])
  assert.throws(() => store.events.append(1, [event(2)]), { code: 'WORKFLOW_STORE_CONFLICT' }, 'a writer that saw one event')
  assert.throws(() => store.events.append(2, [event(4)]), /seq order/)
  assert.equal(store.events.count(), 2, 'a refused append writes nothing')
  // The triggers hold even for a writer that bypasses this module.
  const db = new DatabaseSync(store.filename)
  try {
    assert.throws(() => db.prepare("UPDATE task_events SET type = 'changed' WHERE seq = 1").run(), /append-only/)
    assert.throws(() => db.prepare('DELETE FROM task_events WHERE seq = 1').run(), /kept/)
  } finally { db.close() }
  // A second connection sees the rows and keeps the order.
  const other = f.open()
  assert.equal(other.events.count(), 2)
  other.events.append(2, [event(3)])
  assert.throws(() => store.events.append(2, [event(3)]), { code: 'WORKFLOW_STORE_CONFLICT' })
})

test('ledger rows change only where they differ, under the expected digest', async t => {
  const f = await folder(t)
  const store = f.open()
  assert.equal(store.ledger.read(), null)
  store.ledger.write({ expectedDigest: null, revision: 1, digest: 'd1', changes: [
    { collection: 'graphs', pos: 0, json: '{"g":1}' }, { collection: 'attempts', pos: 0, json: '{"a":1}' }, { collection: 'attempts', pos: 1, json: '{"a":2}' }] })
  assert.throws(() => store.ledger.write({ expectedDigest: null, revision: 2, digest: 'd2', changes: [] }), { code: 'WORKFLOW_STORE_CONFLICT' })
  store.ledger.write({ expectedDigest: 'd1', revision: 2, digest: 'd2', changes: [{ collection: 'attempts', pos: 1, json: null }, { collection: 'boardFences', pos: 0, json: '{"b":1}' }] })
  assert.deepEqual(store.ledger.read(), { revision: 2, digest: 'd2', rows: { graphs: ['{"g":1}'], attempts: ['{"a":1}'], approvals: [], boardFences: ['{"b":1}'] } })
  // A gap in the rows is reported, never patched.
  const db = new DatabaseSync(store.filename)
  try { db.prepare("INSERT INTO ledger_rows VALUES ('approvals', 3, '{}')").run() } finally { db.close() }
  assert.throws(() => store.ledger.read(), { code: 'WORKFLOW_STORE_CORRUPT' })
})

test('records keep their order: insert goes last, replace keeps its place, remove drops one', async t => {
  const f = await folder(t)
  const store = f.open()
  store.transaction(() => { store.records.insert('plan', 'plan-a', '{"n":1}'); store.records.insert('plan', 'plan-b', '{"n":2}') })
  store.records.insert('source', 'task-source-x', '{"s":1}')
  store.records.replace('plan', 'plan-a', '{"n":3}')
  assert.deepEqual(store.records.list('plan'), [{ key: 'plan-a', json: '{"n":3}' }, { key: 'plan-b', json: '{"n":2}' }])
  assert.equal(store.records.count('source'), 1)
  assert.throws(() => store.records.insert('plan', 'plan-a', '{}'), /UNIQUE/)
  assert.throws(() => store.records.replace('plan', 'plan-missing', '{}'), { code: 'WORKFLOW_STORE_CONFLICT' })
  assert.equal(store.records.remove('plan', 'plan-a'), true)
  assert.equal(store.records.remove('plan', 'plan-a'), false)
  store.records.insert('plan', 'plan-a', '{"n":4}')
  assert.deepEqual(store.records.list('plan').map(row => row.key), ['plan-b', 'plan-a'])
  assert.throws(() => store.records.list('profile'), TypeError)
  // A failing transaction leaves nothing behind.
  assert.throws(() => store.transaction(() => { store.records.insert('plan', 'plan-c', '{}'); throw new Error('stop') }), /stop/)
  assert.deepEqual(store.records.list('plan').map(row => row.key), ['plan-b', 'plan-a'])
})

test('a legacy import runs once with its marker; a failed import writes nothing and is tried again', async t => {
  const f = await folder(t)
  const store = f.open()
  assert.equal(store.legacy.marker('task-plans'), null)
  assert.throws(() => store.legacy.importOnce('task-plans', () => { store.records.insert('plan', 'plan-a', '{}'); throw new Error('bad file') }), /bad file/)
  assert.equal(store.records.count('plan'), 0)
  assert.equal(store.legacy.marker('task-plans'), null)
  const first = store.legacy.importOnce('task-plans', () => { store.records.insert('plan', 'plan-a', '{}'); return { source: 'task-plans.json', plans: 1 } })
  assert.equal(first.imported, true)
  assert.equal(first.marker.source, 'task-plans.json')
  let ran = false
  const second = store.legacy.importOnce('task-plans', () => { ran = true })
  assert.deepEqual([second.imported, ran, second.marker.plans], [false, false, 1])
  assert.throws(() => store.legacy.importOnce('profiles', () => {}), TypeError)
})

test('directories and files that are not private, or are links, are refused', async t => {
  const f = await folder(t)
  const open = path.join(f.root, 'open')
  await mkdir(open, { mode: 0o755 })
  await chmod(open, 0o755)
  assert.throws(() => openWorkflowStore({ directory: open }), TypeError)
  const real = path.join(f.root, 'real')
  await mkdir(real, { mode: 0o700 })
  const link = path.join(f.root, 'link')
  await symlink(real, link)
  assert.throws(() => openWorkflowStore({ directory: link }), TypeError)
  const target = path.join(f.root, 'elsewhere.sqlite')
  await writeFile(target, '')
  await symlink(target, path.join(real, WORKFLOW_STORE_FILE))
  assert.throws(() => openWorkflowStore({ directory: real }), TypeError)
  assert.throws(() => openWorkflowStore({ directory: 'relative/dir' }), TypeError)
  assert.throws(() => openWorkflowStore({ directory: '/' }), TypeError)
})

test('an unreadable or foreign database is reported and left byte for byte', async t => {
  const f = await folder(t)
  const garbage = path.join(f.root, 'garbage')
  await mkdir(garbage, { mode: 0o700 })
  const file = path.join(garbage, WORKFLOW_STORE_FILE)
  await writeFile(file, 'this is not a database, but a file someone may want to inspect', { mode: 0o600 })
  assert.throws(() => openWorkflowStore({ directory: garbage }), error => ['WORKFLOW_STORE_OPEN_FAILED', 'WORKFLOW_STORE_CORRUPT'].includes(error.code))
  assert.equal(await readFile(file, 'utf8'), 'this is not a database, but a file someone may want to inspect')

  const foreign = path.join(f.root, 'foreign')
  await mkdir(foreign, { mode: 0o700 })
  const db = new DatabaseSync(path.join(foreign, WORKFLOW_STORE_FILE))
  db.exec('CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES (\'keep me\'); PRAGMA user_version=7;')
  db.close()
  await chmod(path.join(foreign, WORKFLOW_STORE_FILE), 0o600)
  assert.throws(() => openWorkflowStore({ directory: foreign }), { code: 'WORKFLOW_STORE_UNSUPPORTED_VERSION' })
  const check = new DatabaseSync(path.join(foreign, WORKFLOW_STORE_FILE), { readOnly: true })
  try { assert.equal(check.prepare('SELECT body FROM notes').get().body, 'keep me') } finally { check.close() }
})

test('browser_procedure records: own table made on first use, same list/insert/replace/remove API, other kinds untouched', async t => {
  const f = await folder(t)
  const store = f.open()
  const tables = () => { const db = new DatabaseSync(store.filename); try { return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name) } finally { db.close() } }
  assert.equal(tables().includes('procedure_records'), false)
  assert.equal(store.records.count('browser_procedure'), 0)
  store.records.insert('browser_procedure', 'proc-a', '{"n":1}')
  store.records.insert('browser_procedure', 'proc-b', '{"n":2}')
  store.records.insert('plan', 'proc-a', '{"p":1}')
  store.records.replace('browser_procedure', 'proc-a', '{"n":3}')
  assert.deepEqual(store.records.list('browser_procedure'), [{ key: 'proc-a', json: '{"n":3}' }, { key: 'proc-b', json: '{"n":2}' }])
  assert.deepEqual(store.records.list('plan'), [{ key: 'proc-a', json: '{"p":1}' }])
  assert.throws(() => store.records.insert('browser_procedure', 'proc-a', '{}'), /UNIQUE/)
  assert.throws(() => store.records.replace('browser_procedure', 'proc-x', '{}'), { code: 'WORKFLOW_STORE_CONFLICT' })
  assert.equal(store.records.remove('browser_procedure', 'proc-a'), true)
  assert.equal(store.records.remove('browser_procedure', 'proc-a'), false)
  assert.deepEqual(store.records.list('browser_procedure').map(r => r.key), ['proc-b'])
  store.close()
  const again = f.open()
  assert.equal(again.records.count('browser_procedure'), 1, 'it survives a reopen')
})
