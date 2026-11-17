import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'
import { createEGDeskFileService } from './egdesk-file-service.mjs'
import { openEGDeskManagedDraftStore } from './egdesk-managed-drafts.mjs'
import { loadEGDeskPortableDependencies } from './egdesk-portable-bundle.mjs'
import { attachmentFileName, createContextAttachmentProvider, createManagedDraftProvider } from './egdesk-portable-providers.mjs'
import { createPortableService } from './egdesk-portable-service.mjs'

let dependencies = null
try { dependencies = await loadEGDeskPortableDependencies() } catch { dependencies = null }
const needsBundle = { skip: !dependencies && 'yazl/yauzl/libsodium are not installed in helper/node_modules' }
const T0 = new Date(2026, 10, 17, 23, 50, 0).getTime()
const OWNER = 'acct-owner-key-for-tests'

function machine(t, name) {
  const dataDir = createPrivateQaTempDirectory(`egdesk-portable-providers-${name}-`)
  const desk = openDeskStore({ dataDir: path.join(dataDir, 'desk'), ownerScope: 'local-desktop-v1', now: () => T0, utcOffsetMinutes: 0 })
  const context = new ImmutableContextStore({ dataDir, allowedRoots: [dataDir] })
  let owner = OWNER
  const attachments = createContextAttachmentProvider({ store: context, ownerKey: () => owner })
  const fileDrafts = createManagedDraftProvider({ directory: path.join(dataDir, 'file-drafts') })
  const exportDir = path.join(dataDir, 'exports')
  const service = createPortableService({ desk, attachments, fileDrafts, dependencies, now: () => T0, home: dataDir, location: () => ({ directory: exportDir, folder: 'custom' }) })
  t.after(async () => {
    desk.close(); await fileDrafts.close()
    assert.equal(realpathSync.native(dataDir), dataDir)
    rmSync(dataDir, { recursive: true, force: true })
  })
  return { dataDir, desk, context, attachments, fileDrafts, exportDir, service, signOut: () => { owner = null } }
}
/** A stored capture whose delivered projection had a credential masked, like ImmutableContextStore.capture makes. */
async function seedCapture(context, { label, raw, projection, clientThreadId = 'thread-a', mime = 'text/plain' }) {
  const hash = await context.blob(OWNER, Buffer.from(raw))
  const projectionHash = projection === null ? null : await context.blob(OWNER, Buffer.from(projection))
  const sourceId = randomUUID()
  await context.putRecord(OWNER, 'sources', {
    version: 1, sourceId, clientThreadId, hash, storedAt: T0, label,
    shape: projection === null ? { format: 'unsupported-binary', mime, readable: false } : { readable: true, format: 'text', mime },
    payloads: { source: { hash, byteLength: Buffer.byteLength(raw) }, projection: projectionHash ? { hash: projectionHash, byteLength: Buffer.byteLength(projection) } : null },
  }, sourceId)
  return sourceId
}

test('capture names are plain unique file names, never paths', () => {
  const taken = new Set()
  assert.equal(attachmentFileName('Report page', 'text/plain', taken), 'Report page.txt')
  assert.equal(attachmentFileName('Report page', 'text/plain', taken), 'Report page (2).txt')
  assert.equal(attachmentFileName('/Users/someone/secret/plan.md', 'text/markdown', taken), 'Users someone secret plan.md')
  assert.equal(attachmentFileName('../../x', 'text/plain', taken), 'x.txt')
  assert.equal(attachmentFileName('', 'image/png', taken), 'capture.png')
})

test('context captures and File drafts travel through the real stores; imports are new copies and disconnected drafts', needsBundle, async t => {
  const a = machine(t, 'a')
  a.desk.saveBoard('agenda-x-0001', { body: { version: 1, savedAt: T0, agenda: { id: 'agenda-x-0001', title: 'X', memberCardIds: [], contextBindings: [] }, cards: [{ id: 'chat', type: 'chat', runtimeState: { activeThreadId: 'thread-a' } }], shapes: [] }, expectedRevision: null })
  await seedCapture(a.context, { label: 'Page notes', raw: 'see Bearer RAW-TOKEN-123 here', projection: 'see Bearer [REDACTED] here' })
  await seedCapture(a.context, { label: 'Other thread', raw: 'not in this Board', projection: 'not in this Board', clientThreadId: 'thread-b' })
  const drafts = await openEGDeskManagedDraftStore({ directory: path.join(a.dataDir, 'file-drafts'), ownerScope: 'egdesk-local' })
  await drafts.create({ id: 'draft-src-0001', fileId: 'file-1', rootId: 'root-1', name: 'plan.md', head: 'h1', baseText: 'old', text: '# plan\nnew words\n' })
  drafts.close()

  const out = await a.service.exportBundle({ scope: 'desk', include: { attachments: true, fileDrafts: true } })
  assert.deepEqual([out.contents.attachments, out.contents.fileDrafts], [2, 1])
  const bytes = readFileSync(path.join(a.exportDir, out.fileName))
  assert.equal(bytes.includes(Buffer.from('RAW-TOKEN-123')) || bytes.includes(Buffer.from('see Bearer RAW-TOKEN-123 here').toString('base64')), false, 'only the redacted projection travels')
  const board = await a.service.exportBundle({ scope: 'board', boardId: 'agenda-x-0001', include: { attachments: true } })
  assert.equal(board.contents.attachments, 1, 'a Board export carries captures of its own chats only')

  const b = machine(t, 'b')
  const imported = await b.service.importBundle({ bundle: bytes.toString('base64'), mode: 'asNew' })
  assert.deepEqual(imported.attachments.map(item => item.name).sort(), ['Other thread.txt', 'Page notes.txt'])
  const record = await b.context.getRecord(OWNER, 'sources', imported.attachments.find(item => item.name === 'Page notes.txt').id)
  assert.deepEqual([record.clientThreadId, record.kind, (await b.context.readBlob(OWNER, record.hash)).toString()], [null, 'import', 'see Bearer [REDACTED] here'])
  assert.deepEqual((await b.context.readProjection(OWNER, record.sourceId)).text, 'see Bearer [REDACTED] here')

  const [draft] = imported.fileDrafts
  const store = await openEGDeskManagedDraftStore({ directory: path.join(b.dataDir, 'file-drafts'), ownerScope: 'egdesk-local' })
  t.after(() => store.close())
  const saved = await store.get(draft.draftId)
  assert.deepEqual([saved.fileId, saved.rootId, saved.text, saved.origin], [null, null, '# plan\nnew words\n', 'portable-import'])
  const files = createEGDeskFileService({ draftStore: store, createOnlyAdapter: {} })
  const view = await files.readDraft({ draftId: draft.draftId })
  assert.equal(view.sourceConnection, 'reconnect-required', 'an imported draft is not tied to any original')
})

test('signed out: attachments are unavailable and nothing is written', needsBundle, async t => {
  const a = machine(t, 'signed-out')
  a.desk.saveBoard('agenda-x-0001', { body: { version: 1, savedAt: T0, agenda: { id: 'agenda-x-0001', title: 'X', memberCardIds: [], contextBindings: [] }, cards: [], shapes: [] }, expectedRevision: null })
  a.signOut()
  await assert.rejects(a.service.exportBundle({ scope: 'desk', include: { attachments: true } }), error => error.code === 'PORTABLE_ATTACHMENT_STORE_UNAVAILABLE' && error.httpStatus === 503)
  const out = await a.service.exportBundle({ scope: 'desk' })
  assert.equal(out.contents.attachments, 0, 'the default export does not need an account')
})
