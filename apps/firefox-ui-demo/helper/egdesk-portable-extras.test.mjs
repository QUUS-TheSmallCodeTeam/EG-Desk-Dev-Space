import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { DECISION_CREDENTIAL_FILE } from './egdesk-decision-credential.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'
import { loadEGDeskPortableDependencies } from './egdesk-portable-bundle.mjs'
import { EXTRA_KIND, PORTABLE_EXTRA_LIMITS, collectPortableExtras, isSafeEntryName, matchExtrasManifest, parseExtraEntry, secretReason, validateExtrasManifest } from './egdesk-portable-extras.mjs'
import { createPortableService } from './egdesk-portable-service.mjs'
import { openProfileStore } from './egdesk-profile-store.mjs'

let dependencies = null
try { dependencies = await loadEGDeskPortableDependencies() } catch { dependencies = null }
const needsBundle = { skip: !dependencies && 'yazl/yauzl/libsodium are not installed in helper/node_modules' }
const T0 = new Date(2026, 10, 17, 23, 40, 0).getTime()
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const has = (bytes, text) => bytes.includes(Buffer.from(text))
const damaged = reason => { throw Object.assign(new Error('damaged'), { code: 'PORTABLE_FILE_DAMAGED', reason }) }

// Fake attachment (context capture) and File draft providers that record every
// write, so a test can prove an import only creates new copies.
function extrasProviders({ attachmentItems = [], draftItems = [] } = {}) {
  const imported = { attachments: [], drafts: [] }
  const listCalls = []
  return {
    imported, listCalls,
    attachments: {
      exportList: async request => { listCalls.push(['attachments', request]); return attachmentItems },
      importCopy: async input => { imported.attachments.push(input); return { id: `capture-${imported.attachments.length}` } },
    },
    fileDrafts: {
      exportList: async request => { listCalls.push(['fileDrafts', request]); return draftItems },
      importDraft: async input => { imported.drafts.push(input); return { draftId: `draft-${imported.drafts.length}` } },
    },
  }
}
function machine(t, name, providers = extrasProviders()) {
  const dataDir = createPrivateQaTempDirectory(`egdesk-portable-extras-${name}-`)
  const desk = openDeskStore({ dataDir: path.join(dataDir, 'desk'), ownerScope: 'local-desktop-v1', now: () => T0, utcOffsetMinutes: 0 })
  const chat = openChatStore({ dataDir: path.join(dataDir, 'chat'), ownerScope: 'local-desktop-v1' })
  const profiles = openProfileStore({ dataDir: path.join(dataDir, 'chat'), ownerHash: 'local-desktop-v1' })
  const exportDir = path.join(dataDir, 'exports')
  const service = createPortableService({ desk, chat, profiles, attachments: providers.attachments, fileDrafts: providers.fileDrafts, dependencies, now: () => T0, home: dataDir, location: () => ({ directory: exportDir, folder: 'custom' }) })
  t.after(() => {
    desk.close(); chat.close(); profiles.close()
    assert.equal(realpathSync.native(dataDir), dataDir)
    rmSync(dataDir, { recursive: true, force: true })
  })
  return { dataDir, desk, exportDir, service, providers }
}
const board = id => ({ version: 1, savedAt: T0, agenda: { id, title: 'Extras', memberCardIds: ['n'], contextBindings: [] }, cards: [{ id: 'n', type: 'result', runtimeState: { text: 'note' } }], shapes: [] })
const NOTE = 'meeting note: ship on Friday'
const DRAFT = 'export const plan = "draft words"\n'

test('D-R3: attachments and File drafts stay out unless the export asks for them', needsBundle, async t => {
  const providers = extrasProviders({ attachmentItems: [{ name: 'note.txt', mime: 'text/plain', read: async () => Buffer.from(NOTE) }], draftItems: [{ name: 'plan.mjs', text: DRAFT }] })
  const a = machine(t, 'default-off', providers)
  a.desk.saveBoard('agenda-x-0001', { body: board('agenda-x-0001'), expectedRevision: null })
  const out = await a.service.exportBundle({ scope: 'board', boardId: 'agenda-x-0001' })
  assert.deepEqual(providers.listCalls, [], 'providers are not even asked')
  assert.deepEqual([out.contents.attachments, out.contents.fileDrafts], [0, 0])
  assert.deepEqual(out.omitted, { attachments: [], fileDrafts: [] })
  const bytes = readFileSync(path.join(a.exportDir, out.fileName))
  assert.equal(has(bytes, Buffer.from(NOTE).toString('base64')) || has(bytes, 'draft words'), false)
  const inspected = await a.service.inspectBundle({ fileRef: out.fileRef })
  assert.deepEqual([inspected.attachments, inspected.fileDrafts], [0, 0])
})

test('opt-in export carries sha256 per entry and a manifest; import writes new capture copies and disconnected drafts only', needsBundle, async t => {
  const big = Buffer.alloc(PORTABLE_EXTRA_LIMITS.maxAttachmentBytes + 1, 1)
  const providers = extrasProviders({
    attachmentItems: [
      { name: 'note.txt', mime: 'text/plain', read: async () => Buffer.from(NOTE) },
      { name: 'shot.png', mime: 'image/png', read: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      { name: 'huge.bin', mime: 'application/octet-stream', size: big.length, read: async () => big },
      { name: '../escape.txt', mime: 'text/plain', read: async () => Buffer.from('x') },
      { name: 'broken.txt', mime: 'text/plain', read: async () => { throw new Error('gone') } },
    ],
    draftItems: [{ name: 'plan.mjs', text: DRAFT }, { name: '/etc/hosts', text: 'x' }],
  })
  const a = machine(t, 'opt-in', providers)
  a.desk.saveBoard('agenda-x-0001', { body: board('agenda-x-0001'), expectedRevision: null })
  const out = await a.service.exportBundle({ scope: 'board', boardId: 'agenda-x-0001', include: { attachments: true, fileDrafts: true } })
  const request = { scope: 'board', boardIds: ['agenda-x-0001'], threadIds: [], draftIds: [] }
  assert.deepEqual(providers.listCalls, [['attachments', request], ['fileDrafts', request]])
  assert.deepEqual([out.contents.attachments, out.contents.fileDrafts], [2, 1])
  assert.deepEqual(out.omitted.attachments, [{ name: 'huge.bin', reason: 'too-large' }, { name: null, reason: 'unsafe-name' }, { name: 'broken.txt', reason: 'unreadable' }])
  assert.deepEqual(out.omitted.fileDrafts, [{ name: null, reason: 'unsafe-name' }])
  assert.deepEqual(readdirSync(a.exportDir), [out.fileName])

  const inspected = await a.service.inspectBundle({ fileRef: out.fileRef })
  assert.deepEqual([inspected.attachments, inspected.fileDrafts, inspected.omitted], [2, 1, { attachments: 3, fileDrafts: 1 }])

  const b = machine(t, 'opt-in-b')
  const file = readFileSync(path.join(a.exportDir, out.fileName))
  const imported = await b.service.importBundle({ bundle: file.toString('base64'), mode: 'asNew' })
  assert.equal(imported.verified, true)
  assert.deepEqual(imported.attachments, [{ id: 'capture-1', name: 'note.txt', bytes: NOTE.length }, { id: 'capture-2', name: 'shot.png', bytes: 4 }])
  assert.deepEqual(imported.fileDrafts, [{ draftId: 'draft-1', name: 'plan.mjs', status: 'draft', original: 'not-connected' }])
  const [note] = b.providers.imported.attachments
  assert.deepEqual([note.name, note.mime, note.bytes.toString('utf8'), note.sha256], ['note.txt', 'text/plain', NOTE, sha(Buffer.from(NOTE))])
  // A draft carries only its name and text: no path, file ID or root, so it can never write an original.
  assert.deepEqual(Object.keys(b.providers.imported.drafts[0]).sort(), ['name', 'sha256', 'text'])
  assert.equal(b.providers.imported.drafts[0].text, DRAFT)
})

test('secrets never travel: bridge settings, the decision credential key file, env files and token text are omitted', needsBundle, async t => {
  const dir = createPrivateQaTempDirectory('egdesk-portable-extras-secrets-')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const KEY = 'sk-proj-SECRETDECISIONKEY1234567890'
  const BRIDGE = '{"engines":{"claude":{"apiKey":"BRIDGE-SECRET-VALUE"}}}'
  writeFileSync(path.join(dir, DECISION_CREDENTIAL_FILE), JSON.stringify({ version: 1, apiKey: KEY }))
  writeFileSync(path.join(dir, 'bridge-settings.json'), BRIDGE)
  const fromDisk = name => ({ name, mime: 'application/json', read: async () => readFileSync(path.join(dir, name)) })
  const providers = extrasProviders({
    attachmentItems: [fromDisk(DECISION_CREDENTIAL_FILE), fromDisk('bridge-settings.json'),
      { name: '.env', mime: 'text/plain', read: async () => Buffer.from('OPENAI_API_KEY=abc') },
      { name: 'id_ed25519', mime: 'application/octet-stream', read: async () => Buffer.from('PRIVATE-KEY-BYTES') },
      { name: 'auth.json', mime: 'application/json', read: async () => Buffer.from('{"tokens":"AUTH-SECRET"}') },
      { name: 'call.txt', mime: 'text/plain', read: async () => Buffer.from('curl -H "Authorization: Bearer LEAKED-BEARER-TOKEN"') },
      { name: 'ok.txt', mime: 'text/plain', read: async () => Buffer.from('plain words') }],
    draftItems: [{ name: 'config.mjs', text: `const key = '${KEY}'\n` }, { name: 'readme.md', text: '# hello\n' }],
  })
  const a = machine(t, 'secrets', providers)
  a.desk.saveBoard('agenda-x-0001', { body: board('agenda-x-0001'), expectedRevision: null })
  const out = await a.service.exportBundle({ scope: 'desk', include: { attachments: true, fileDrafts: true, chats: true, profiles: true } })
  assert.deepEqual(out.omitted.attachments.map(item => [item.name, item.reason]), [
    [DECISION_CREDENTIAL_FILE, 'secret'], ['bridge-settings.json', 'secret'], ['.env', 'secret'], ['id_ed25519', 'secret'], ['auth.json', 'secret'], ['call.txt', 'secret']])
  assert.deepEqual(out.omitted.fileDrafts, [{ name: 'config.mjs', reason: 'secret' }])
  assert.deepEqual([out.contents.attachments, out.contents.fileDrafts], [1, 1])
  const bytes = readFileSync(path.join(a.exportDir, out.fileName))
  const forms = value => [value, Buffer.from(value).toString('base64')]
  for (const secret of [KEY, BRIDGE, 'BRIDGE-SECRET-VALUE', 'OPENAI_API_KEY=abc', 'PRIVATE-KEY-BYTES', '{"tokens":"AUTH-SECRET"}', 'LEAKED-BEARER-TOKEN', readFileSync(path.join(dir, DECISION_CREDENTIAL_FILE), 'utf8')]) {
    for (const form of forms(secret)) assert.equal(has(bytes, form), false, `secret leaked: ${secret}`)
  }
  assert.ok(has(bytes, Buffer.from('plain words').toString('base64')) && has(bytes, '# hello'), 'safe entries do travel')
})

test('entry names: plain file names only; traversal, absolute and drive paths are refused', () => {
  for (const name of ['note.txt', '회의록.md', 'a b (2).png']) assert.equal(isSafeEntryName(name), true, name)
  for (const name of ['../x', '..', '.', 'a/b', 'a\\b', '/etc/passwd', 'C:\\x', 'C:x', '~/x', '\\\\server\\x', 'x\u0000', '', ' x', 'a'.repeat(256)]) assert.equal(isSafeEntryName(name), false, JSON.stringify(name))
  assert.equal(secretReason('tokens.css'), null, 'design tokens are not secrets')
  assert.equal(secretReason('token.json'), 'secret')
})

test('import validation rejects traversal, absolute paths, hash and size mismatches and manifest drift', () => {
  const data = Buffer.from('hello')
  const entry = over => ({ kind: EXTRA_KIND.attachment, v: 1, name: 'a.txt', mime: 'text/plain', bytes: data.length, sha256: sha(data), data: data.toString('base64'), ...over })
  assert.equal(parseExtraEntry(entry(), damaged).name, 'a.txt')
  const refuses = (value, reason) => assert.throws(() => parseExtraEntry(value, damaged), error => error.code === 'PORTABLE_ENTRY_UNSAFE' && error.reason === reason)
  refuses(entry({ name: '../../.ssh/authorized_keys' }), 'UNSAFE_NAME')
  refuses(entry({ name: '/Users/someone/.zshrc' }), 'UNSAFE_NAME')
  refuses(entry({ name: 'C:\\Windows\\x.dll' }), 'UNSAFE_NAME')
  refuses(entry({ name: DECISION_CREDENTIAL_FILE }), 'SECRET_ENTRY')
  refuses(entry({ sha256: sha(Buffer.from('other')) }), 'HASH_MISMATCH')
  refuses(entry({ bytes: 4 }), 'HASH_MISMATCH')
  refuses(entry({ bytes: PORTABLE_EXTRA_LIMITS.maxAttachmentBytes + 1 }), 'ENTRY_TOO_LARGE')
  const draft = over => ({ kind: EXTRA_KIND.fileDraft, v: 1, name: 'd.md', sourceId: null, bytes: 2, sha256: sha(Buffer.from('hi')), text: 'hi', ...over })
  assert.equal(parseExtraEntry(draft(), damaged).text, 'hi')
  refuses(draft({ name: '../d.md' }), 'UNSAFE_NAME')
  refuses(draft({ text: 'ho' }), 'HASH_MISMATCH')
  assert.throws(() => parseExtraEntry(draft({ extra: 1 }), damaged), error => error.code === 'PORTABLE_FILE_DAMAGED')

  const include = { attachments: true, fileDrafts: false }
  const manifest = { attachments: { included: [{ name: 'a.txt', bytes: 5, sha256: sha(data) }], omitted: [{ name: null, reason: 'unsafe-name' }] }, fileDrafts: null }
  validateExtrasManifest(manifest, include, damaged)
  assert.throws(() => validateExtrasManifest(manifest, { attachments: false, fileDrafts: false }, damaged), error => error.reason === 'MANIFEST_MISMATCH')
  assert.throws(() => validateExtrasManifest({ ...manifest, attachments: { included: [{ name: '../a', bytes: 1, sha256: sha(data) }], omitted: [] } }, include, damaged), error => error.reason === 'INVALID_CONTENT')
  const parsed = [parseExtraEntry(entry(), damaged)]
  matchExtrasManifest(manifest, parsed, [], damaged)
  assert.throws(() => matchExtrasManifest(manifest, [], [], damaged), error => error.reason === 'MANIFEST_MISMATCH', 'a listed entry that is missing')
  assert.throws(() => matchExtrasManifest({ ...manifest, attachments: { included: [], omitted: [] } }, parsed, [], damaged), error => error.reason === 'MANIFEST_MISMATCH', 'an entry the manifest does not list')
})

test('a requested kind without a provider fails the export before anything is written', async () => {
  await assert.rejects(collectPortableExtras({ include: { attachments: true, fileDrafts: false }, scope: 'desk', boardIds: new Set() }), error => error.code === 'PORTABLE_ATTACHMENT_STORE_UNAVAILABLE')
  await assert.rejects(collectPortableExtras({ include: { attachments: false, fileDrafts: true }, scope: 'desk', boardIds: new Set() }), error => error.code === 'PORTABLE_DRAFT_STORE_UNAVAILABLE')
})

test('import without an attachment store refuses the whole file and writes nothing', needsBundle, async t => {
  const providers = extrasProviders({ attachmentItems: [{ name: 'note.txt', mime: 'text/plain', read: async () => Buffer.from(NOTE) }] })
  const a = machine(t, 'no-store-a', providers)
  a.desk.saveBoard('agenda-x-0001', { body: board('agenda-x-0001'), expectedRevision: null })
  const out = await a.service.exportBundle({ scope: 'board', boardId: 'agenda-x-0001', include: { attachments: true } })
  const b = machine(t, 'no-store-b', { attachments: null, fileDrafts: null })
  await assert.rejects(b.service.importBundle({ bundle: readFileSync(path.join(a.exportDir, out.fileName)).toString('base64'), mode: 'asNew' }), error => error.code === 'PORTABLE_ATTACHMENT_STORE_UNAVAILABLE')
  assert.deepEqual(b.desk.listBoards().boards, [])
})

test('Board File cards follow an imported draft to its new ID; Desk exports ask for everything', needsBundle, async t => {
  const OLD = '0f0e0d0c-1111-4222-8333-444455556666'
  const providers = extrasProviders({ draftItems: [{ id: OLD, name: 'plan.mjs', text: DRAFT }] })
  const a = machine(t, 'remap-a', providers)
  const body = board('agenda-x-0001')
  body.cards.push({ id: 'file-1', type: 'file', runtimeState: { fileView: { fileId: 'f-1', draftId: OLD } } })
  body.agenda.memberCardIds.push('file-1')
  a.desk.saveBoard('agenda-x-0001', { body, expectedRevision: null })
  const out = await a.service.exportBundle({ scope: 'board', boardId: 'agenda-x-0001', include: { fileDrafts: true } })
  assert.deepEqual(providers.listCalls[0][1].draftIds, [OLD])
  const b = machine(t, 'remap-b', extrasProviders())
  const imported = await b.service.importBundle({ bundle: readFileSync(path.join(a.exportDir, out.fileName)).toString('base64'), mode: 'asNew' })
  assert.deepEqual(imported.fileDrafts.map(item => item.draftId), ['draft-1'])
  const card = b.desk.board('agenda-x-0001').head.body.cards.find(item => item.id === 'file-1')
  assert.equal(card.runtimeState.fileView.draftId, 'draft-1')
  await a.service.exportBundle({ scope: 'desk', include: { fileDrafts: true } })
  assert.deepEqual(providers.listCalls.at(-1)[1], { scope: 'desk', boardIds: ['agenda-x-0001'], threadIds: null, draftIds: null })
})
