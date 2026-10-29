import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { createEGDeskPortableBundle } from './egdesk-portable-bundle.mjs'
import { createPortableService } from './egdesk-portable-service.mjs'

// Tiny test-only codec: it exercises the real portable service and bundle
// validation without installing/copying ZIP or crypto dependencies. This is
// not the production .egdesk format and is never used outside these tests.
const codec = {
  encode(entries) {
    return Readable.from((async function* () {
      const result = []
      for (const entry of entries) {
        const chunks = []
        for await (const chunk of await entry.open()) chunks.push(Buffer.from(chunk))
        result.push({ name: entry.name, data: Buffer.concat(chunks).toString('base64') })
      }
      yield Buffer.from(JSON.stringify(result))
    })())
  },
  async read(source, onEntry) {
    assert.ok(Buffer.isBuffer(source))
    for (const entry of JSON.parse(source.toString('utf8'))) {
      const data = Buffer.from(entry.data, 'base64')
      await onEntry({ name: entry.name, size: data.length, compressedSize: data.length,
        async *bytes() { yield data } })
    }
  },
}
const dependencies = { codec, envelope: { isEncryptedPrefix: () => false } }
const at = 1793232000000
const scopeToken = '11111111-1111-4111-8111-111111111111'
const bindingToken = '22222222-2222-4222-8222-222222222222'
const identity = () => ({ version: 1, userContextId: 7, profileScopeId: scopeToken,
  browserIdentityKey: bindingToken, containerName: 'Synthetic container' })
const browser = () => ({ id: 'browser-qa', type: 'browser',
  sourceRef: { kind: 'browser-url', uri: 'http://127.0.0.1/fixture', browserIdentityRequired: true, browserIdentityKey: bindingToken },
  runtimeState: { uri: 'http://127.0.0.1/fixture', browserIdentity: identity() } })
const state = () => ({ version: 1, agenda: { id: 'board-qa', title: 'Synthetic', memberCardIds: ['browser-qa'] },
  cards: [browser(), { id: 'default-qa', type: 'browser', sourceRef: { kind: 'browser-url', uri: 'about:blank' },
    runtimeState: { uri: 'about:blank' } }], shapes: [],
  boardProjections: { projections: { one: { members: [{ record: browser() }] } } } })

function tempDir(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'egdesk-portable-cookie-test-'))
  fs.chmodSync(root, 0o700)
  t.after(() => {
    assert.equal(fs.realpathSync.native(root), root)
    assert.match(path.basename(root), /^egdesk-portable-cookie-test-/)
    fs.rmSync(root, { recursive: true })
  })
  return root
}

function deskStore(initialState = null, initialBoards = []) {
  let current = { state: initialState, generation: initialState ? 1 : null }
  const boards = new Map(initialBoards.map(board => [board.boardId, board]))
  return {
    current: () => current,
    listBoards: () => ({ boards: [...boards.values()].map(({ boardId }) => ({ boardId })) }),
    board: id => boards.get(id) || null,
    boardIds: () => new Set(boards.keys()),
    importPortable({ state: imported, boards: incoming }) {
      current = { state: imported, generation: 1 }
      for (const board of incoming) boards.set(board.boardId, { ...board, head: { body: board.body } })
      return { desk: imported ? { generation: 1, unchanged: false } : null,
        boards: incoming.map(({ boardId, title }) => ({ boardId, title })) }
    },
  }
}

function assertUnbound(record) {
  assert.equal(record.sourceRef.browserIdentityRequired, true)
  assert.equal(record.sourceRef.browserIdentityKey, null)
  assert.equal(record.runtimeState.browserIdentity.userContextId, 7)
  assert.equal(record.runtimeState.browserIdentity.profileScopeId, null)
  assert.equal(record.runtimeState.browserIdentity.browserIdentityKey, null)
  assert.equal(record.runtimeState.browserIdentity.containerName, 'Synthetic container')
}

// Create a valid bundle containing unredacted synthetic authority fields to
// exercise the import guard independently of the export guard.
async function rawSyntheticBundle(rawState) {
  const payload = Buffer.from(JSON.stringify({ kind: 'egdesk.portable.root', v: 1, scope: 'desk', exportedAt: at,
    include: { chats: false, profiles: false }, desk: { state: rawState } }))
  const hash = createHash('sha256').update(payload).digest('hex')
  const node = { id: 'desk', type: 'board', scopeRootId: 'desk', title: 'Desk', refs: [],
    objects: [{ sha256: hash, role: 'body' }] }
  const bundle = createEGDeskPortableBundle({ codec, objectProvider: { async openExportSnapshot() {
    return { getNode: async id => id === 'desk' ? node : null, listEvents: async () => [],
      getObjectMeta: async id => id === hash ? { size: payload.length, portableApproved: true, scopeRootId: 'desk' } : null,
      openObject: async () => Readable.from([payload]), close: async () => {} }
  } }, importStore: { beginStage: async () => null, reopenRepresentative: async () => false } })
  const plan = await bundle.planExport({ rootIds: ['desk'] })
  const chunks = []
  const sink = { atomicPublish: true, stagingProtection: 'encrypted',
    writable: new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done() } }),
    publish: async () => ({ fileName: 'synthetic.egdesk' }), abort: async () => {} }
  await bundle.exportPlan({ planId: plan.planId, sink })
  return Buffer.concat(chunks)
}

test('Desk and Board export/import keep the required marker and container number but redact profile-bound authority', async t => {
  const root = tempDir(t), original = state(), originalCopy = structuredClone(original)
  const board = { boardId: 'board-qa', title: 'Synthetic', head: { body: { version: 1,
    agenda: { id: 'board-qa', title: 'Synthetic', memberCardIds: ['browser-qa'] }, cards: [browser()], shapes: [] } } }
  const source = deskStore(original, [board]), target = deskStore()
  const service = store => createPortableService({ desk: store, dependencies, now: () => at, home: root,
    location: () => ({ directory: path.join(root, 'exports'), folder: 'custom' }) })
  const exported = await service(source).exportBundle({ scope: 'desk', include: { chats: false, profiles: false } })
  const bytes = fs.readFileSync(path.join(root, 'exports', exported.fileName))
  for (const entry of JSON.parse(bytes.toString('utf8'))) {
    const body = Buffer.from(entry.data, 'base64').toString('utf8')
    assert.equal(body.includes(scopeToken), false)
    assert.equal(body.includes(bindingToken), false)
  }
  const imported = await service(target).importBundle({ bundle: bytes.toString('base64'), mode: 'asNew' })
  assert.equal(imported.verified, true)
  assertUnbound(target.current().state.cards[0])
  assertUnbound(target.current().state.boardProjections.projections.one.members[0].record)
  assertUnbound(target.board('board-qa').head.body.cards[0])
  assert.equal(Object.hasOwn(target.current().state.cards[1].sourceRef, 'browserIdentityRequired'), false)
  assert.deepEqual(original, originalCopy)
})

test('import also strips foreign authority and marks incomplete Browser identity signals as required', async t => {
  const root = tempDir(t), raw = state()
  raw.other = { profile_scope_id: scopeToken, 'browser-identity-key': bindingToken }
  raw.cards.push({ id: 'legacy-reference', type: 'browser', sourceRef: { kind: 'browser-url',
    browserIdentityKey: bindingToken }, runtimeState: { uri: 'about:blank' } })
  raw.cards.push({ id: 'legacy-runtime', type: 'browser', sourceRef: { kind: 'browser-url' },
    runtimeState: { uri: 'about:blank', browserIdentity: identity() } })
  const target = deskStore(), service = createPortableService({ desk: target, dependencies, now: () => at, home: root,
    location: () => ({ directory: path.join(root, 'exports'), folder: 'custom' }) })
  const bundle = await rawSyntheticBundle(raw)
  const result = await service.importBundle({ bundle: bundle.toString('base64'), mode: 'asNew' })
  assert.equal(result.verified, true)
  const cards = target.current().state.cards
  assertUnbound(cards[0])
  assert.equal(cards[2].sourceRef.browserIdentityRequired, true)
  assert.equal(cards[2].sourceRef.browserIdentityKey, null)
  assert.equal(cards[3].sourceRef.browserIdentityRequired, true)
  assert.equal(cards[3].runtimeState.browserIdentity.userContextId, 7)
  assert.equal(cards[3].runtimeState.browserIdentity.profileScopeId, null)
  assert.equal(cards[3].runtimeState.browserIdentity.browserIdentityKey, null)
  assert.equal(target.current().state.other.profile_scope_id, null)
  assert.equal(target.current().state.other['browser-identity-key'], null)
})

test('standalone Board export and import also retain an unbound required identity', async t => {
  const root = tempDir(t)
  const board = { boardId: 'board-qa', title: 'Synthetic', head: { body: { version: 1,
    agenda: { id: 'board-qa', title: 'Synthetic', memberCardIds: ['browser-qa'] }, cards: [browser()], shapes: [] } } }
  const source = deskStore(null, [board]), target = deskStore()
  const service = store => createPortableService({ desk: store, dependencies, now: () => at, home: root,
    location: () => ({ directory: path.join(root, 'exports'), folder: 'custom' }) })
  const exported = await service(source).exportBundle({ scope: 'board', boardId: 'board-qa',
    include: { chats: false, profiles: false } })
  const bytes = fs.readFileSync(path.join(root, 'exports', exported.fileName))
  const imported = await service(target).importBundle({ bundle: bytes.toString('base64'), mode: 'asNew' })
  assert.equal(imported.verified, true)
  assertUnbound(target.board('board-qa').head.body.cards[0])
})
