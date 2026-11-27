import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'
import { loadEGDeskPortableDependencies } from './egdesk-portable-bundle.mjs'
import { PORTABLE_BODY_LIMITS, handlePortableHttp, uploadBodyLimit } from './egdesk-portable-http.mjs'
import { PORTABLE_LIMITS, createPortableService, exportFileName, homeRelativePath, portableExportLocation } from './egdesk-portable-service.mjs'
import { PROFILE_TEMPLATES, openProfileStore } from './egdesk-profile-store.mjs'

let dependencies = null
try { dependencies = await loadEGDeskPortableDependencies() } catch { dependencies = null }
const needsBundle = { skip: !dependencies && 'yazl/yauzl/libsodium are not installed in helper/node_modules' }

const T0 = new Date(2026, 9, 24, 15, 30, 12).getTime()
const THREAD = 'thread-dm-abc1234'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function collect(source) { const parts = []; for await (const part of source) parts.push(Buffer.from(part)); return Buffer.concat(parts) }
const has = (bytes, text) => bytes.includes(Buffer.from(text))

function fakeRequest(method, url, body, headers = {}) {
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(raw)
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:39218', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}
async function call(service, method, url, body, headers, { reviewService, signal } = {}) {
  const sent = []
  const handled = await handlePortableHttp(fakeRequest(method, url, body, headers), new URL(url, 'http://127.0.0.1:39218'), { service, reviewService, signal, send: (status, data) => sent.push({ status, data }) })
  assert.ok(sent.length <= 1)
  return { handled, status: sent[0]?.status, data: sent[0]?.data }
}

/** One "machine": its own Desk, chat and profile stores and export folder, under a private temp dir. */
function device(t, name, { limits, desk: deskOverride } = {}) {
  const dataDir = createPrivateQaTempDirectory(`egdesk-portable-${name}-`)
  const desk = openDeskStore({ dataDir: path.join(dataDir, 'desk'), ownerScope: 'local-desktop-v1', now: () => T0, utcOffsetMinutes: 0 })
  const chat = openChatStore({ dataDir: path.join(dataDir, 'chat'), ownerScope: 'local-desktop-v1' })
  const profiles = openProfileStore({ dataDir: path.join(dataDir, 'chat'), ownerHash: 'local-desktop-v1' })
  profiles.seedTemplates()
  const exportDir = path.join(dataDir, 'exports')
  const service = createPortableService({
    desk: deskOverride ?? desk, chat, profiles, dependencies, limits, now: () => T0, home: dataDir,
    location: () => ({ directory: exportDir, folder: 'custom' }),
  })
  t.after(() => {
    desk.close(); chat.close(); profiles.close()
    assert.equal(realpathSync.native(dataDir), dataDir)
    rmSync(dataDir, { recursive: true, force: true })
  })
  return { dataDir, desk, chat, profiles, exportDir, service, api: (...args) => call(service, ...args) }
}
const boardBody = (id, title, cards) => ({ version: 1, savedAt: T0, agenda: { id, title, memberCardIds: cards.map(card => card.id), contextBindings: [] }, cards, shapes: [] })
const deskState = () => ({
  version: 1, savedAt: T0,
  desk: { pan: { x: 0, y: 0 }, zoom: 1, activeAgendaId: 'agenda-alpha-001', activeCardId: null },
  agenda: { id: 'agenda-alpha-001', title: 'Alpha 계획', memberCardIds: ['card-chat', 'card-web'], contextBindings: [] },
  cards: [
    { id: 'card-chat', type: 'chat', runtimeState: { activeThreadId: THREAD, chatDockMode: 'canvas' } },
    { id: 'card-web', type: 'browser', runtimeState: { uri: 'https://example.com/report', title: 'Report' } },
  ],
  shapes: [],
  surface: { mode: 'canvas', recoveryBackupKey: 'egdesk.deskRecovery.v1.local-slot' },
  chat: {
    threads: [{ id: THREAD, title: 'Plan chat', conversationId: 'native-thread-1', bindingAccountKey: 'acct-SECRET-KEY', cwd: '/Users/someone/project', messages: [{ role: 'user', text: 'Desk copy of the thread text' }] }],
    activeThreadId: THREAD, codexAccountKey: 'acct-SECRET-KEY', threadDrafts: { [THREAD]: 'unsent draft words' }, hudView: 'list', localHistoryBackupKey: 'egdesk.chatBackup.v1',
  },
})
const seededRun = () => ({
  conversationId: 'native-thread-1', runId: 'native-run-1', answerId: 'answer-1', requestId: 'request-1',
  clientThreadId: THREAD, localRunId: 'local-run-1', status: 'completed',
  messages: [
    { id: 'm-user', messageId: 'native-user-1', localMessageId: 'lm-user-1', role: 'user', text: 'Summarize the plan', status: 'complete' },
    { id: 'm-answer', messageId: 'native-answer-1', localMessageId: 'lm-answer-1', role: 'assistant', text: 'Plan summary. Use password: hunter2 never.', status: 'complete', completionConfirmed: true },
  ],
  activities: [], artifacts: [], pendingApprovals: [], error: null, truncated: false, historyComplete: true,
  cwdPublic: '/Users/someone/project', accountIdentity: { ownerHash: 'owner-hash-SECRET', status: 'verified' },
  engine: { id: 'codex', version: '1.0', engineProfileId: 'codex-default' },
})
const chatCard = { id: 'card-chat', type: 'chat', runtimeState: { activeThreadId: THREAD } }
function seed({ desk, chat, profiles }) {
  desk.saveBoard('agenda-alpha-001', { body: boardBody('agenda-alpha-001', 'Alpha 계획', [chatCard, { id: 'card-note', type: 'result', runtimeState: { text: 'Alpha note' } }]), expectedRevision: null })
  desk.saveBoard('agenda-beta-002', { body: boardBody('agenda-beta-002', 'Beta board', [{ id: 'card-web', type: 'browser', runtimeState: { uri: 'https://example.com/beta' } }]), expectedRevision: null })
  desk.saveCurrent({ state: deskState(), parentGeneration: null })
  chat.createConversation({ clientThreadId: THREAD, title: 'Plan chat', createdAt: T0 - 1000 })
  chat.importSnapshot({ clientThreadId: THREAD, importId: 'seed', snapshot: { protocolVersion: 2, conversationId: 'native-thread-1', truncated: false, historyComplete: true, runs: [seededRun()] } })
  const created = profiles.createDraft({ ...PROFILE_TEMPLATES[0].body, name: 'Reviewer Kim' })
  profiles.activate(created.id, 1, null)
}
const upload = file => ({ bundle: readFileSync(file).toString('base64') })
const nothingWritten = machine => {
  assert.deepEqual(machine.desk.listBoards().boards, [])
  assert.equal(machine.desk.current().generation, null)
  assert.deepEqual(machine.chat.listConversations().threads, [])
}

test('a Desk exports without chats, inspects, imports on another machine under the same IDs and, on the same machine, as new copies', needsBundle, async t => {
  const a = device(t, 'desk-a')
  seed(a)
  const out = await a.api('POST', '/v1/portable/export', { scope: 'desk', include: { chats: false, profiles: false } })
  assert.equal(out.status, 201)
  assert.match(out.data.fileName, /^EG-Desk-Desk-20261024-153012\.egdesk$/)
  assert.equal(out.data.encrypted, false)
  assert.deepEqual(out.data.contents, { scope: 'desk', exportedAt: T0, title: null, desk: true, boards: 2, cards: 5, deskCards: 2, chats: 0, profiles: 0, attachments: 0, fileDrafts: 0, omitted: { attachments: 0, fileDrafts: 0 }, chatsOmitted: 0 })
  assert.deepEqual([out.data.folder, out.data.displayPath, out.data.fileRef], ['custom', `~/exports/${out.data.fileName}`, { exportFile: out.data.fileName }])
  assert.deepEqual(readdirSync(a.exportDir), [out.data.fileName], 'no temp file is left beside the export')
  const file = path.join(a.exportDir, out.data.fileName)
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  const bytes = readFileSync(file)
  assert.equal(bytes.length, out.data.bytes)
  assert.ok(has(bytes, 'Beta board') && has(bytes, 'https://example.com/report'), 'a plain bundle carries the Desk and Boards')
  for (const secret of ['acct-SECRET-KEY', 'Desk copy of the thread text', 'unsent draft words', 'egdesk.deskRecovery.v1.local-slot', 'Summarize the plan']) assert.equal(has(bytes, secret), false, secret)
  assert.ok(out.data.redacted.identifiers >= 3)

  const inspected = await a.api('POST', '/v1/portable/inspect', { fileRef: out.data.fileRef })
  assert.equal(inspected.status, 200)
  assert.deepEqual(inspected.data, { encrypted: false, locked: false, bytes: out.data.bytes, formatVersion: '1.0', scope: 'desk', exportedAt: T0, title: null, desk: true, boards: 2, cards: 5, deskCards: 2, chats: 0, profiles: 0, attachments: 0, fileDrafts: 0, omitted: { attachments: 0, fileDrafts: 0 } })

  // Another machine: nothing collides, so the Board IDs stay and the Desk becomes generation 1.
  const b = device(t, 'desk-b')
  const imported = await b.api('POST', '/v1/portable/import', { ...upload(file), mode: 'asNew' })
  assert.equal(imported.status, 201)
  assert.equal(imported.data.mode, 'asNew')
  assert.equal(imported.data.verified, true)
  assert.deepEqual(imported.data.desk, { generation: 1, unchanged: false })
  assert.deepEqual(imported.data.boards.map(item => [item.boardId, item.idChanged]), [['agenda-alpha-001', false], ['agenda-beta-002', false]])
  assert.deepEqual([imported.data.chats, imported.data.profiles], [[], []])
  assert.deepEqual(b.desk.board('agenda-alpha-001').head.body, a.desk.board('agenda-alpha-001').head.body)
  assert.equal(b.desk.board('agenda-alpha-001').head.author, 'import')
  const landed = b.desk.current()
  assert.deepEqual([landed.reason, landed.state.cards.length, landed.state.desk.activeAgendaId], ['import', 2, 'agenda-alpha-001'])
  assert.deepEqual([landed.state.chat.threads, landed.state.chat.codexAccountKey, landed.state.surface.recoveryBackupKey], [[], null, null])

  // Same machine again: every Board ID is taken, so new IDs; nothing existing changes.
  const again = await a.api('POST', '/v1/portable/import', { fileRef: out.data.fileRef, mode: 'asNew' })
  assert.equal(again.status, 201)
  const [alpha, beta] = again.data.boards
  assert.deepEqual([alpha.sourceBoardId, alpha.idChanged, beta.idChanged], ['agenda-alpha-001', true, true])
  assert.match(alpha.boardId, /^agenda-import-/)
  assert.equal(a.desk.listBoards().boards.length, 4)
  assert.equal(a.desk.board('agenda-alpha-001').headRevision, 1)
  assert.equal(a.desk.board(alpha.boardId).head.body.agenda.id, alpha.boardId)
  assert.equal(a.desk.board(alpha.boardId).title, 'Alpha 계획')
  assert.deepEqual(again.data.desk, { generation: 2, unchanged: false })
  const head = a.desk.current().state
  assert.deepEqual([head.desk.activeAgendaId, head.agenda.id], [alpha.boardId, alpha.boardId], 'Desk references follow the renamed Board')
  assert.equal(a.desk.generation(1).state.chat.codexAccountKey, 'acct-SECRET-KEY', 'the earlier Desk stays in the journal untouched')
})

test('a Board exports with its chat and profiles; import adds a new conversation and profile with no native or account identifiers', needsBundle, async t => {
  const a = device(t, 'board-a')
  seed(a)
  const out = await a.api('POST', '/v1/portable/export', { scope: 'board', boardId: 'agenda-alpha-001', include: { chats: true, profiles: true } })
  assert.equal(out.status, 201)
  assert.match(out.data.fileName, /^EG-Desk-Board-Alpha-계획-20261024-153012\.egdesk$/)
  assert.deepEqual(out.data.contents, { scope: 'board', exportedAt: T0, title: 'Alpha 계획', desk: false, boards: 1, cards: 2, deskCards: 0, chats: 1, profiles: 1, attachments: 0, fileDrafts: 0, omitted: { attachments: 0, fileDrafts: 0 }, chatsOmitted: 0 })
  const bytes = readFileSync(path.join(a.exportDir, out.data.fileName))
  assert.ok(has(bytes, 'Summarize the plan') && has(bytes, 'Reviewer Kim'))
  for (const secret of ['hunter2', 'owner-hash-SECRET', 'native-thread-1', 'native-run-1', '/Users/someone/project', 'codex-default']) assert.equal(has(bytes, secret), false, secret)
  assert.ok(out.data.redacted.maskedTexts >= 1 && out.data.redacted.identifiers >= 4)

  const b = device(t, 'board-b')
  const imported = await b.api('POST', '/v1/portable/import', { ...upload(path.join(a.exportDir, out.data.fileName)), mode: 'asNew' })
  assert.equal(imported.status, 201)
  assert.equal(imported.data.desk, null)
  assert.deepEqual(imported.data.boards.map(item => item.boardId), ['agenda-alpha-001'])
  assert.deepEqual(imported.data.chats.map(item => [item.clientThreadId, item.idChanged, item.runs]), [[THREAD, false, 1]])
  // Active where it was exported, but an Agent from a file waits as a draft until the user reviews it here.
  assert.deepEqual(imported.data.profiles.map(item => [item.name, item.status, item.active, item.reviewRequired]), [['Reviewer Kim', 'imported', false, true]])
  const conversation = b.chat.getConversation(THREAD)
  assert.deepEqual([conversation.title, conversation.conversationId, conversation.coverage.status], ['Plan chat', null, 'complete'])
  const run = b.chat.getLatestRun(THREAD)
  assert.deepEqual([run.runId, run.accountIdentity, run.cwdPublic, run.engine.engineProfileId, run.localRunId], [null, null, null, null, 'local-run-1'])
  assert.match(run.messages[1].text, /password: \[REDACTED\]/)
  assert.deepEqual(b.chat.listMessages(THREAD).messages.map(message => message.text), ['Summarize the plan', 'Plan summary. Use password: [REDACTED] never.'])
  const profile = b.profiles.list().profiles.find(item => item.name === 'Reviewer Kim')
  assert.deepEqual([profile?.lifecycle, profile?.id.startsWith('prof-'), profile?.activeRevision, profile?.reviewRequired], ['draft', true, null, true])
  assert.deepEqual([profile.latestSource.kind, profile.latestSource.format, profile.latestSource.name], ['import', 'egdesk', 'Reviewer Kim'])
  assert.throws(() => b.profiles.runProfile(profile.id), error => error.code === 'PROFILE_NOT_RUNNABLE', 'nothing runs before review')
  const reviewed = b.profiles.activate(profile.id, 1, null)
  assert.deepEqual([reviewed.lifecycle, reviewed.reviewRequired, reviewed.source.length], ['active', false, 1], 'activating is the review; the source stays')

  // Same machine: the conversation ID is taken, so a new one; the Board's chat card follows it.
  const again = await a.api('POST', '/v1/portable/import', { fileRef: out.data.fileRef, mode: 'asNew' })
  assert.equal(again.status, 201)
  const [copy] = again.data.chats
  assert.match(copy.clientThreadId, /^thread-import-[0-9a-f]{12}$/)
  assert.equal(copy.idChanged, true)
  const board = a.desk.board(again.data.boards[0].boardId).head.body
  assert.equal(board.cards.find(card => card.type === 'chat').runtimeState.activeThreadId, copy.clientThreadId)
  assert.deepEqual(again.data.profiles.map(item => item.status), ['duplicate'])
  assert.equal(a.chat.getConversation(THREAD).conversationId, 'native-thread-1', 'the original conversation keeps its binding')
  assert.equal(a.chat.getConversation(copy.clientThreadId).conversationId, null)
})

for (const lifecycle of ['active', 'draft']) test(`portable export keeps a local ${lifecycle} photo profile and writes only its safe initial`, needsBundle, async t => {
  const a = device(t, `photo-${lifecycle}-a`)
  a.desk.saveBoard('agenda-photo-001', { body: boardBody('agenda-photo-001', 'Photo export', []), expectedRevision: null })
  // A real 1×1 RGB PNG goes through the store's image validation and asset storage.
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPgFlMEAAByAEMwyWmKAAAAAElFTkSuQmCC'
  const { assetId } = a.profiles.putAvatarImage({ mediaType: 'image/png', imageBase64 })
  const initial = { kind: 'initial', value: '김', color: PROFILE_TEMPLATES[0].body.avatar.color }
  const created = a.profiles.createDraft({ ...PROFILE_TEMPLATES[0].body, name: 'Photo reviewer', avatar: { ...initial, kind: 'image', assetId } })
  if (lifecycle === 'active') {
    a.profiles.activate(created.id, 1, null)
    a.profiles.saveDraft(created.id, { ...a.profiles.get(created.id).head.body, name: 'Unactivated photo edit' }, 1)
  }
  const original = a.profiles.get(created.id)
  const originalImage = a.profiles.getAvatarImage(assetId)
  const selected = original.active ?? original.head
  const portableBody = { ...selected.body, avatar: initial }
  const out = await a.api('POST', '/v1/portable/export', { scope: 'board', boardId: 'agenda-photo-001', include: { chats: false, profiles: true } })
  assert.equal(out.status, 201)
  assert.equal(out.data.contents.profiles, 1, 'unchanged built-in templates still do not travel')
  const file = path.join(a.exportDir, out.data.fileName)
  const entries = new Map()
  await dependencies.codec.read(readFileSync(file), async entry => { entries.set(entry.name, await collect(entry.bytes())) })
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'))
  const profileNode = manifest.nodes.find(node => node.id === 'profile-1')
  assert.ok(profileNode, 'the real exported archive contains the selected profile')
  const exported = JSON.parse(entries.get(`objects/${profileNode.objects[0].sha256}`).toString('utf8'))
  assert.deepEqual(exported.body, portableBody, 'only the avatar changes; active revision takes precedence over a newer draft')
  assert.equal(exported.lifecycle, lifecycle)
  assert.equal(Object.hasOwn(exported.body.avatar, 'assetId'), false)
  for (const [name, bytes] of entries) {
    assert.equal(has(bytes, assetId), false, `${name} must not contain a local image asset ID`)
    assert.equal(bytes.includes(originalImage.bytes), false, `${name} must not contain image bytes`)
    assert.equal(has(bytes, imageBase64), false, `${name} must not contain a base64 image`)
  }
  assert.deepEqual(a.profiles.get(created.id), original, 'export leaves source revisions, hashes and bodies unchanged')
  assert.deepEqual(a.profiles.getAvatarImage(assetId), originalImage, 'export leaves the original image asset unchanged')

  const b = device(t, `photo-${lifecycle}-b`)
  const imported = await b.api('POST', '/v1/portable/import', { ...upload(file), mode: 'asNew' })
  assert.equal(imported.status, 201)
  assert.deepEqual(imported.data.profiles.map(item => [item.name, item.status, item.active, item.reviewRequired]), [['Photo reviewer', 'imported', false, true]])
  const copy = b.profiles.get(imported.data.profiles[0].profileId)
  assert.deepEqual([copy.lifecycle, copy.activeRevision, copy.reviewRequired], ['draft', null, true])
  assert.deepEqual(copy.head.body, portableBody)
  assert.deepEqual([copy.source.at(-1).kind, copy.source.at(-1).format], ['import', 'egdesk'])
  assert.throws(() => b.profiles.runProfile(copy.id), error => error.code === 'PROFILE_NOT_RUNNABLE')
  assert.throws(() => b.profiles.getAvatarImage(assetId), error => error.code === 'PROFILE_ASSET_NOT_FOUND')
  const profileCount = b.profiles.list().profiles.length
  const again = await b.api('POST', '/v1/portable/import', { ...upload(file), mode: 'asNew' })
  assert.equal(again.status, 201)
  assert.deepEqual(again.data.profiles.map(item => item.status), ['duplicate'])
  assert.equal(b.profiles.list().profiles.length, profileCount, 'reimport uses existing draft deduplication')

  const excluded = await a.api('POST', '/v1/portable/export', { scope: 'board', boardId: 'agenda-photo-001', include: { chats: false, profiles: false } })
  assert.equal(excluded.status, 201)
  assert.equal(excluded.data.contents.profiles, 0)
  const excludedImport = await b.api('POST', '/v1/portable/import', { ...upload(path.join(a.exportDir, excluded.data.fileName)), mode: 'asNew' })
  assert.equal(excludedImport.status, 201)
  assert.deepEqual(excludedImport.data.profiles, [], 'profiles:false remains excluded from the actual export/import flow')
  assert.equal(b.profiles.list().profiles.length, profileCount)
  assert.deepEqual(a.profiles.get(created.id), original)
  assert.deepEqual(a.profiles.getAvatarImage(assetId), originalImage)
})

test('a passphrase locks the file: inspect reports locked, a wrong one is refused, import needs it, short ones are refused', needsBundle, async t => {
  const a = device(t, 'pass-a')
  seed(a)
  const short = await a.api('POST', '/v1/portable/export', { scope: 'desk', passphrase: 'short' })
  assert.deepEqual([short.status, short.data.code], [400, 'PORTABLE_PASSPHRASE_TOO_SHORT'])
  assert.equal(existsSync(a.exportDir) ? readdirSync(a.exportDir).length : 0, 0)
  const out = await a.api('POST', '/v1/portable/export', { scope: 'desk', include: { chats: false, profiles: true }, passphrase: 'correct horse battery' })
  assert.equal(out.status, 201)
  assert.equal(out.data.encrypted, true)
  assert.equal(JSON.stringify(out.data).includes('correct horse battery'), false)
  const file = path.join(a.exportDir, out.data.fileName)
  const bytes = readFileSync(file)
  assert.equal(bytes.subarray(0, 10).toString(), 'EGDESK-E1\n')
  for (const text of ['Beta board', 'agenda-alpha-001', 'Reviewer Kim', 'manifest.json']) assert.equal(has(bytes, text), false, text)

  const locked = await a.api('POST', '/v1/portable/inspect', { fileRef: out.data.fileRef })
  assert.deepEqual([locked.status, locked.data], [200, { encrypted: true, locked: true, bytes: bytes.length }])
  const wrong = await a.api('POST', '/v1/portable/inspect', { fileRef: out.data.fileRef, passphrase: 'not the passphrase' })
  assert.deepEqual([wrong.status, wrong.data.code, wrong.data.encrypted], [400, 'PORTABLE_PASSPHRASE_INVALID', true])

  const b = device(t, 'pass-b')
  const missing = await b.api('POST', '/v1/portable/import', { ...upload(file), mode: 'asNew' })
  assert.deepEqual([missing.status, missing.data.code], [400, 'PORTABLE_PASSPHRASE_REQUIRED'])
  nothingWritten(b)
  const imported = await b.api('POST', '/v1/portable/import', { ...upload(file), passphrase: 'correct horse battery', mode: 'asNew' })
  assert.equal(imported.status, 201)
  assert.deepEqual([imported.data.encrypted, imported.data.boards.length, imported.data.contents.profiles], [true, 2, 1])
})

async function rewriteBundle(bytes, { payload, manifest } = {}) {
  const { codec } = dependencies
  const parts = new Map()
  await codec.read(bytes, async entry => { parts.set(entry.name, await collect(entry.bytes())) })
  const { contentSha256, ...content } = JSON.parse(parts.get('manifest.json').toString('utf8'))
  if (payload) {
    const root = content.nodes.find(node => node.id === content.roots[0])
    const oldHash = root.objects[0].sha256
    const value = JSON.parse(parts.get(`objects/${oldHash}`).toString('utf8'))
    payload(value)
    const next = Buffer.from(JSON.stringify(value))
    const nextHash = sha(next)
    root.objects[0].sha256 = nextHash
    Object.assign(content.objects.find(object => object.sha256 === oldHash), { sha256: nextHash, size: next.length })
    parts.set(`objects/${nextHash}`, next)
  }
  manifest?.(content)
  const manifestBytes = Buffer.from(JSON.stringify({ ...content, contentSha256: sha(Buffer.from(JSON.stringify(content))) }))
  const entry = (name, value) => ({ name, size: value.length, open: () => Readable.from([value]) })
  return collect(codec.encode([
    entry('manifest.json', manifestBytes), entry('events.jsonl', parts.get('events.jsonl')), entry('transcript.md', parts.get('transcript.md')),
    ...content.objects.map(object => entry(`objects/${object.sha256}`, parts.get(`objects/${object.sha256}`))),
  ]))
}

test('portable Browser local locations never reopen a recipient filesystem, including pre-fix bundles', needsBundle, async t => {
  const a = device(t, 'local-browser-sender'), b = device(t, 'local-browser-recipient')
  const uri = 'file:///synthetic-private-root/local-note.md'
  const cards = [
    { id: 'card-local', type: 'browser', runtimeState: { uri }, sourceRef: { kind: 'browser-url', uri } },
    { id: 'card-fallback', type: 'browser', sourceRef: { kind: 'browser-url', uri: '  FILE:///synthetic-private-root/local-note.md' } },
    { id: 'card-web', type: 'browser', runtimeState: { uri: 'https://example.com/retained' } },
  ]
  const boardId = 'agenda-local-browser-001'
  a.desk.saveBoard(boardId, { body: boardBody(boardId, 'Local source references', cards), expectedRevision: null })
  const out = await a.api('POST', '/v1/portable/export', { scope: 'board', boardId })
  assert.equal(out.status, 201)
  const bytes = readFileSync(path.join(a.exportDir, out.data.fileName))
  let rawContains = false
  await dependencies.codec.read(bytes, async entry => {
    const body = await collect(entry.bytes())
    if (entry.name.startsWith('objects/')) rawContains ||= has(body, 'synthetic-private-root')
  })
  assert.equal(rawContains, false, 'outbound archive does not contain these local navigation fields')
  const legacy = await rewriteBundle(bytes, { payload: value => { value.board.body.cards = cards } })
  const bundle = legacy.toString('base64')
  const summary = await b.api('POST', '/v1/portable/inspect', { bundle })
  assert.equal(summary.status, 200)
  assert.deepEqual([summary.data.scope, summary.data.boards, summary.data.cards], ['board', 1, 3])
  nothingWritten(b)
  const imported = await b.api('POST', '/v1/portable/import', { bundle, mode: 'asNew' })
  assert.equal(imported.status, 201)
  const [main, fallback, web] = b.desk.board(boardId).head.body.cards
  assert.equal(main.runtimeState.uri, 'about:blank')
  assert.equal(main.sourceRef.uri, 'about:blank')
  assert.equal(fallback.runtimeState.uri, 'about:blank')
  assert.equal(fallback.sourceRef.uri, 'about:blank')
  assert.equal(web.runtimeState.uri, 'https://example.com/retained')
  assert.equal(a.desk.board(boardId).head.body.cards[0].runtimeState.uri, uri)
})

test('damaged, altered, private-field and newer-version files are refused and nothing is written', needsBundle, async t => {
  const a = device(t, 'damage-a')
  seed(a)
  const out = await a.api('POST', '/v1/portable/export', { scope: 'desk', include: { chats: true, profiles: true } })
  const bytes = readFileSync(path.join(a.exportDir, out.data.fileName))
  const b = device(t, 'damage-b')
  const flipped = Buffer.from(bytes)
  flipped[bytes.indexOf(Buffer.from('Beta board'))] ^= 1
  for (const [label, broken] of [
    ['truncated', bytes.subarray(0, bytes.length - 40)],
    ['changed byte inside an object', flipped],
    ['not a bundle', Buffer.from('just some text, not a zip file at all')],
  ]) {
    const seen = await b.api('POST', '/v1/portable/inspect', { bundle: broken.toString('base64') })
    assert.deepEqual([seen.status, seen.data.code], [400, 'PORTABLE_FILE_DAMAGED'], label)
    assert.match(seen.data.reason, /^[A-Z0-9_]+$/, label)
    const tried = await b.api('POST', '/v1/portable/import', { bundle: broken.toString('base64'), mode: 'asNew' })
    assert.deepEqual([tried.status, tried.data.code], [400, 'PORTABLE_FILE_DAMAGED'], label)
  }
  const privateField = await rewriteBundle(bytes, { payload: value => { value.desk.state.cards[1].runtimeState.password = 'leaked' } })
  const refused = await b.api('POST', '/v1/portable/import', { bundle: privateField.toString('base64'), mode: 'asNew' })
  assert.deepEqual([refused.status, refused.data.code], [400, 'PORTABLE_PRIVATE_FIELD'])
  const newer = await rewriteBundle(bytes, { manifest: content => { content.version.major = 2 } })
  const future = await b.api('POST', '/v1/portable/import', { bundle: newer.toString('base64'), mode: 'asNew' })
  assert.deepEqual([future.status, future.data.code], [400, 'PORTABLE_VERSION_UNSUPPORTED'])
  const unknownKind = await rewriteBundle(bytes, { payload: value => { value.kind = 'something.else' } })
  const odd = await b.api('POST', '/v1/portable/import', { bundle: unknownKind.toString('base64'), mode: 'asNew' })
  assert.deepEqual([odd.status, odd.data.code, odd.data.reason], [400, 'PORTABLE_FILE_DAMAGED', 'UNSUPPORTED_CONTENT'])
  nothingWritten(b)
  assert.equal(b.profiles.list().profiles.some(item => item.name === 'Reviewer Kim'), false)
  // The untouched file still imports.
  assert.equal((await b.api('POST', '/v1/portable/import', { bundle: bytes.toString('base64'), mode: 'asNew' })).status, 201)
})

test('size limits: an over-limit export writes nothing, an over-limit file or body is refused', needsBundle, async t => {
  const limits = { maxContentBytes: 4096, maxBundleBytes: 8192 }
  const a = device(t, 'size-a', { limits })
  a.desk.saveBoard('agenda-large-001', { body: boardBody('agenda-large-001', 'Large', [{ id: 'card-big', type: 'result', runtimeState: { text: 'x'.repeat(6000) } }]), expectedRevision: null })
  const big = await a.api('POST', '/v1/portable/export', { scope: 'board', boardId: 'agenda-large-001' })
  assert.deepEqual([big.status, big.data.code], [413, 'PORTABLE_EXPORT_TOO_LARGE'])
  assert.equal(existsSync(a.exportDir), false, 'nothing is created when the limit is hit')
  const tooBig = Buffer.alloc(limits.maxBundleBytes + 1, 65).toString('base64')
  const file = await a.api('POST', '/v1/portable/inspect', { bundle: tooBig })
  assert.deepEqual([file.status, file.data.code], [413, 'PORTABLE_FILE_TOO_LARGE'])
  const body = await a.api('POST', '/v1/portable/import', { bundle: 'A'.repeat(uploadBodyLimit(limits.maxBundleBytes) + 4), mode: 'asNew' })
  assert.deepEqual([body.status, body.data.code], [413, 'BODY_TOO_LARGE'])
  mkdirSync(a.exportDir, { recursive: true })
  writeFileSync(path.join(a.exportDir, 'large.egdesk'), Buffer.alloc(limits.maxBundleBytes + 1))
  const ref = await a.api('POST', '/v1/portable/inspect', { fileRef: { exportFile: 'large.egdesk' } })
  assert.deepEqual([ref.status, ref.data.code], [413, 'PORTABLE_FILE_TOO_LARGE'])
  assert.equal(PORTABLE_BODY_LIMITS.upload, uploadBodyLimit(PORTABLE_LIMITS.maxBundleBytes))
  assert.equal(PORTABLE_BODY_LIMITS.small, 65536)

  // The bundle library's own encrypted ceiling stops the write after the temp file exists; it is removed.
  const b = device(t, 'size-b')
  seed(b)
  const tight = createPortableService({ desk: b.desk, chat: b.chat, profiles: b.profiles, now: () => T0,
    dependencies: { codec: dependencies.codec, envelope: { ...dependencies.envelope, maxMemoryZipBytes: 64 } },
    location: () => ({ directory: b.exportDir, folder: 'custom' }) })
  const ceiling = await call(tight, 'POST', '/v1/portable/export', { scope: 'desk', passphrase: 'long enough phrase' })
  assert.deepEqual([ceiling.status, ceiling.data.code], [413, 'PORTABLE_EXPORT_TOO_LARGE'])
  assert.deepEqual(readdirSync(b.exportDir), [])
})

test('private keys and account identifiers never enter a bundle, even from older saved data', needsBundle, async t => {
  const olderDesk = {
    current: () => ({ generation: 1, state: {
      version: 1, cards: [{ id: 'card-1', type: 'browser', runtimeState: { uri: 'https://example.com', apiKey: 'sk-live-SECRET-1' } }],
      nested: { password: 'p@ss-SECRET-2', kept: 'visible-value' },
      chat: { threads: [{ id: 'thread-dm-zzz9999', systemPrompt: 'hidden-prompt-SECRET-3', bindingAccountKey: 'acct-SECRET-4', messages: [] }], codexAccountKey: 'acct-SECRET-4', activeThreadId: 'thread-dm-zzz9999', threadDrafts: {} },
    } }),
    listBoards: () => ({ boards: [] }), board: () => null, boardIds: () => new Set(),
  }
  const a = device(t, 'private-a', { desk: olderDesk })
  const out = await a.api('POST', '/v1/portable/export', { scope: 'desk', include: { chats: true, profiles: false } })
  assert.equal(out.status, 201)
  const bytes = readFileSync(path.join(a.exportDir, out.data.fileName))
  assert.ok(has(bytes, 'visible-value'))
  for (const secret of ['sk-live-SECRET-1', 'p@ss-SECRET-2', 'hidden-prompt-SECRET-3', 'acct-SECRET-4', '"apiKey"', '"systemPrompt"']) assert.equal(has(bytes, secret), false, secret)
  assert.equal(out.data.redacted.privateFields, 3)
  assert.ok(out.data.redacted.identifiers >= 2)
})

test('HTTP contract: loopback guard, routes, methods, fields, unavailable stores and generic failures', needsBundle, async t => {
  const a = device(t, 'http-a')
  const api = a.api
  assert.equal((await call(a.service, 'GET', '/v1/desk/current')).handled, false)
  const hostile = await api('POST', '/v1/portable/export', { scope: 'desk' }, { origin: 'https://evil.example' })
  assert.deepEqual([hostile.status, hostile.data.code], [403, 'PORTABLE_LOOPBACK_REQUIRED'])
  assert.deepEqual((await api('GET', '/v1/portable/nope')).status, 404)
  assert.deepEqual([(await api('GET', '/v1/portable/export')).status, (await api('POST', '/v1/portable/exports', {})).status], [405, 405])
  for (const body of [{ scope: 'board' }, { scope: 'desk', boardId: 'agenda-x' }, { scope: 'desk', extra: 1 }, { scope: 'everything' }, { scope: 'desk', include: { chats: 'yes' } }, { scope: 'desk', include: { files: true } }, { scope: 'desk', include: { attachments: 'yes' } }, { scope: 'desk', include: { fileDrafts: 1 } }, { scope: 'desk', passphrase: 12345678 }]) {
    const answer = await api('POST', '/v1/portable/export', body)
    assert.deepEqual([answer.status, answer.data.code], [400, 'PORTABLE_HTTP_INPUT'], JSON.stringify(body))
  }
  for (const [url, body] of [
    ['/v1/portable/inspect', { fileRef: { exportFile: 'a.egdesk' }, bundle: 'AAAA' }],
    ['/v1/portable/inspect', {}],
    ['/v1/portable/inspect', { fileRef: 'a.egdesk' }],
    ['/v1/portable/import', { bundle: 'AAAA' }],
    ['/v1/portable/import', { bundle: 'AAAA', mode: 'replace' }],
    ['/v1/portable/inspect', { bundle: 'not base64!' }],
    ['/v1/portable/inspect', { fileRef: { exportFile: '../escape.egdesk' } }],
    ['/v1/portable/inspect', { fileRef: { exportFile: '.hidden.egdesk' } }],
  ]) {
    const answer = await api('POST', url, body)
    assert.deepEqual([answer.status, answer.data.code], [400, 'PORTABLE_HTTP_INPUT'], JSON.stringify(body))
  }
  assert.deepEqual((await api('POST', '/v1/portable/export?x=1', { scope: 'desk' })).status, 400)
  const missingFile = await api('POST', '/v1/portable/inspect', { fileRef: { exportFile: 'missing.egdesk' } })
  assert.deepEqual([missingFile.status, missingFile.data.code], [404, 'PORTABLE_FILE_NOT_FOUND'])
  const empty = await api('POST', '/v1/portable/export', { scope: 'desk' })
  assert.deepEqual([empty.status, empty.data.code], [409, 'PORTABLE_NOTHING_TO_EXPORT'])
  const noBoard = await api('POST', '/v1/portable/export', { scope: 'board', boardId: 'agenda-none-001' })
  assert.deepEqual([noBoard.status, noBoard.data.code], [404, 'BOARD_NOT_FOUND'])

  const offline = createPortableService({ desk: () => null, chat: () => null, profiles: () => null, dependencies, location: () => ({ directory: a.exportDir, folder: 'custom' }) })
  const unavailable = await call(offline, 'POST', '/v1/portable/export', { scope: 'desk' })
  assert.deepEqual([unavailable.status, unavailable.data.code], [503, 'PORTABLE_STORE_UNAVAILABLE'])
  const broken = { limits: PORTABLE_LIMITS, exportBundle: async () => { throw new Error('disk exploded at /Users/someone/secret') } }
  assert.deepEqual((await call(broken, 'POST', '/v1/portable/export', { scope: 'desk' })).data, { code: 'PORTABLE_ERROR', error: 'Portable request could not be completed' })

  // Exports list: newest first, temp files hidden, each with the fileRef inspect/import accept.
  seed(a)
  const first = await api('POST', '/v1/portable/export', { scope: 'board', boardId: 'agenda-beta-002' })
  const second = await api('POST', '/v1/portable/export', { scope: 'board', boardId: 'agenda-beta-002' })
  assert.equal(second.data.fileName, first.data.fileName.replace(/\.egdesk$/, ' (2).egdesk'), 'an existing file is never replaced')
  writeFileSync(path.join(a.exportDir, '.egdesk-leftover.part'), 'partial')
  const listed = await api('GET', '/v1/portable/exports')
  assert.equal(listed.status, 200)
  assert.deepEqual(listed.data.files.map(item => item.fileName).sort(), [first.data.fileName, second.data.fileName].sort())
  assert.deepEqual([listed.data.folder, listed.data.displayPath], ['custom', '~/exports'])
  assert.deepEqual(listed.data.files[0].fileRef, { exportFile: listed.data.files[0].fileName })
})

test('export folder is ~/Downloads/EG-Desk when Downloads exists, app data otherwise, and names are safe', t => {
  const home = createPrivateQaTempDirectory('egdesk-portable-home-')
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const appDataDir = path.join(home, 'AppData-EG-Desk')
  assert.deepEqual(portableExportLocation({ env: {}, home, appDataDir }), { directory: path.join(appDataDir, 'exports'), folder: 'app-data' })
  mkdirSync(path.join(home, 'Downloads'))
  assert.deepEqual(portableExportLocation({ env: {}, home, appDataDir }), { directory: path.join(home, 'Downloads', 'EG-Desk'), folder: 'downloads' })
  assert.equal(existsSync(path.join(home, 'Downloads', 'EG-Desk')), false, 'resolving the folder creates nothing')
  assert.deepEqual(portableExportLocation({ env: { EGDESK_EXPORT_DIR: path.join(home, 'custom') }, home, appDataDir }), { directory: path.join(home, 'custom'), folder: 'custom' })
  assert.throws(() => portableExportLocation({ env: { EGDESK_EXPORT_DIR: 'relative/dir' }, home }), { code: 'PORTABLE_EXPORT_FOLDER_INVALID' })
  assert.equal(homeRelativePath(path.join(home, 'Downloads', 'EG-Desk', 'a.egdesk'), home), '~/Downloads/EG-Desk/a.egdesk')
  assert.equal(homeRelativePath(path.join(path.dirname(home), 'elsewhere', 'a.egdesk'), home), null)
  assert.equal(exportFileName({ scope: 'board', title: 'Q4 / 계획: 초안?', at: T0 }), 'EG-Desk-Board-Q4-계획-초안-20261024-153012.egdesk')
  assert.equal(exportFileName({ scope: 'board', title: '///', at: T0 }), 'EG-Desk-Board-20261024-153012.egdesk')
  assert.equal(exportFileName({ scope: 'desk', title: 'ignored', at: T0 }), 'EG-Desk-Desk-20261024-153012.egdesk')
})

test('store imports are all-or-nothing: a taken Board ID or conversation ID writes nothing', t => {
  const a = device(t, 'stores-a')
  a.desk.saveBoard('agenda-alpha-001', { body: boardBody('agenda-alpha-001', 'Alpha', []), expectedRevision: null })
  assert.throws(() => a.desk.importPortable({ state: deskState(), boards: [
    { boardId: 'agenda-new-002', title: 'New', body: boardBody('agenda-new-002', 'New', []) },
    { boardId: 'agenda-alpha-001', title: 'Alpha copy', body: boardBody('agenda-alpha-001', 'Alpha copy', []) },
  ] }), { code: 'BOARD_EXISTS', httpStatus: 409 })
  assert.deepEqual([...a.desk.boardIds()], ['agenda-alpha-001'])
  assert.equal(a.desk.current().generation, null)
  const done = a.desk.importPortable({ state: deskState(), boards: [{ boardId: 'agenda-new-002', title: 'New', body: boardBody('agenda-new-002', 'New', []) }] })
  assert.deepEqual([done.desk.generation, done.desk.reason, done.boards], [1, 'import', [{ boardId: 'agenda-new-002', title: 'New', revision: 1 }]])
  assert.equal(a.desk.importPortable({ state: { ...deskState(), savedAt: T0 + 5 } }).desk.unchanged, true)

  a.chat.createConversation({ clientThreadId: THREAD, title: 'Existing' })
  const snapshot = { protocolVersion: 2, conversationId: null, truncated: false, historyComplete: true, runs: [] }
  assert.throws(() => a.chat.importConversationCopy({ clientThreadId: THREAD, title: 'Copy', createdAt: T0, importId: 'portable-1', snapshot }), { code: 'CONVERSATION_EXISTS', httpStatus: 409 })
  assert.equal(a.chat.getConversation(THREAD).title, 'Existing')
  const copy = a.chat.importConversationCopy({ clientThreadId: 'thread-import-000000000001', title: 'Copy', createdAt: T0, importId: 'portable-2', snapshot })
  assert.deepEqual([copy.imported, a.chat.getConversation('thread-import-000000000001').title], [true, 'Copy'])
})

test('the bridge mounts portable routes after Desk routes, behind the loopback guard, and lists the capability', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const at = text => { const index = source.indexOf(text); assert.notEqual(index, -1, `missing server marker: ${text}`); return index }
  at("import { createPortableHttpHandler } from './egdesk-portable-http.mjs'")
  at('const handlePortableHttp = createPortableHttpHandler({ desk: () => deskStore, chat: () => chatStore, profiles: () => profileStore, attachments: portableAttachments, fileDrafts: portableFileDrafts, appDataDir: dataDir, port: BRIDGE_PORT })')
  at('const portableAttachments = createContextAttachmentProvider({ store: contextStore, ownerKey: () => publicAuthIdentityKey(authState),')
  at("const portableFileDrafts = createManagedDraftProvider({ directory: path.join(dataDir, 'file-drafts') })")
  const mount = at('if (await handlePortableHttp(req, res, url)) return')
  assert.ok(at('if (!guardBridgeRequest(req, BRIDGE_PORT)) {') < mount)
  assert.ok(at('if (await handleDeskHttp(req, res, url)) return') < mount)
  assert.ok(mount < at('if (await handleContextHttp(req, res, url)) return'))
  assert.ok(mount < at('if (await handleChatHttp(req, res, url)) return'))
  at("...(deskStore ? ['export', 'inspect', 'import-as-new', 'passphrase', 'exports-list', 'attachments', 'file-drafts'] : ['local-store-unavailable'])")
  at("...(await handlePortableHttp.supportsReviewHandoff() ? ['reviewHandoff'] : [])")
})

test('review handoff returns only the approved answer to the issuing Board after explicit confirmation', needsBundle, async t => {
  const { createReviewFlow, createReviewStore } = await import('../overlay/resources/EGDeskReviewHandoff.sys.mjs')
  const { createPortableReviewService } = await import('./egdesk-portable-review.mjs')
  const { REVIEW_BUNDLE_FORMAT } = await import('./egdesk-portable-bundle.mjs')
  const a = device(t, 'review-sender')
  const b = device(t, 'review-recipient')
  const original = { id: 'agenda-alpha-001', title: 'Original review Board' }
  const unrelated = { id: 'agenda-beta-002', title: 'Unrelated review Board' }
  const sameIdOnB = { id: original.id, title: 'Independent Board on recipient profile' }
  const privateBoardText = 'Synthetic sender notes intentionally not selected for sharing'
  const privateRecipientText = 'Synthetic recipient working notes intentionally not approved'
  const privateChatText = 'Synthetic sender chat not selected for sharing'
  const privateBinding = 'synthetic-local-account-binding-review-fixture'
  const requestText = {
    recipient: 'Schedule reviewer', question: 'Does the Friday sequence work?',
    excerpt: 'Friday: rehearsal, then a retrospective.', expectedReply: 'Give the recommended order.',
  }
  const answer = 'Keep rehearsal first. Move the retrospective to Monday. 다음 주 월요일.'
  const passphrase = 'synthetic review file phrase'
  const exportRoute = '/v1/portable/review/export'
  const inspectRoute = '/v1/portable/review/inspect'

  for (const [machine, board, text] of [[a, original, privateBoardText], [a, unrelated, 'Unrelated fixture note'], [b, sameIdOnB, privateRecipientText]]) {
    machine.desk.saveBoard(board.id, { expectedRevision: null, body: boardBody(board.id, board.title, [
      { id: 'card-note', type: 'result', runtimeState: { text } },
    ]) })
  }
  const current = deskState()
  Object.assign(current.chat.threads[0], { bindingAccountKey: privateBinding, messages: [{ role: 'user', text: privateChatText }] })
  current.chat.codexAccountKey = privateBinding
  a.desk.saveCurrent({ state: current, parentGeneration: null })
  const originalHead = a.desk.board(original.id).head
  const unrelatedHead = a.desk.board(unrelated.id).head
  assert.equal(originalHead.body.cards[0].runtimeState.text, privateBoardText)
  assert.equal(a.desk.current().state.chat.threads[0].bindingAccountKey, privateBinding)

  // The same in-process HTTP fixture as other portable tests, plus the real
  // review service used by the mount. Each browser profile owns one private pref.
  function profile(machine, boardList) {
    const prefsFile = path.join(machine.dataDir, 'review-pref.json')
    const read = () => existsSync(prefsFile) ? readFileSync(prefsFile, 'utf8') : ''
    const write = value => writeFileSync(prefsFile, value, { mode: 0o600 })
    const reviewService = createPortableReviewService({
      dependencies, home: machine.dataDir, location: () => ({ directory: machine.exportDir, folder: 'custom' }),
    })
    const boards = new Map(boardList.map(board => [board.id, board]))
    const context = Object.freeze({})
    const calls = []
    const api = async (method, route, body, signal) => {
      const result = await machine.api(method, route, body, undefined, { reviewService, signal })
      calls.push({ method, route, body, ...result })
      return { status: result.status, body: result.data }
    }
    return { read, calls, api, openModel() {
      let pickedFile
      let state
      const flow = createReviewFlow({
        request: (method, route, body, { signal }) => api(method, route, body, signal),
        pickFile: async () => ({ bytes: await readFile(pickedFile) }),
        getContext: () => context, isContextCurrent: candidate => candidate === context,
        getBoard: id => boards.get(id), isBoardCurrent: board => boards.get(board.id) === board,
        store: createReviewStore({ read, write }), onState: next => { state = next },
      })
      return { flow, state: () => state, async pick(file) {
        pickedFile = file
        flow.openFile()
        await flow.chooseFile()
        return state
      } }
    } }
  }
  async function assertArchive(bytes, review) {
    const entries = new Map()
    await dependencies.codec.read(bytes, async entry => { entries.set(entry.name, await collect(entry.bytes())) })
    assert.deepEqual([...entries.keys()], ['manifest.json', 'events.jsonl', 'transcript.md'])
    const manifest = JSON.parse(entries.get('manifest.json'))
    const metadata = {}
    if (review.kind === 'request') {
      assert.match(manifest.requestNonce, /^[a-f0-9]{64}$/)
      metadata.requestNonce = manifest.requestNonce
    }
    assert.deepEqual(manifest, { format: REVIEW_BUNDLE_FORMAT, version: 2, review, ...metadata })
    assert.equal(entries.get('events.jsonl').length, 0)
    assert.equal(entries.get('transcript.md').length, 0)
  }
  const sender = profile(a, [original, unrelated])
  const recipient = profile(b, [sameIdOnB])
  let senderModel = sender.openModel()
  const recipientModel = recipient.openModel()

  senderModel.flow.openRequest(original)
  assert.equal(senderModel.flow.previewRequest(requestText), true)
  const requestDraft = { kind: 'request', ...requestText }
  assert.deepEqual(senderModel.state().review, requestDraft)
  assert.equal(sender.read(), '', 'request preview has not recorded an issue')
  assert.equal(sender.calls.length, 0)
  await senderModel.flow.exportFile({ passphrase, confirm: passphrase })
  assert.equal(senderModel.state().step, 'exported')
  assert.equal(senderModel.state().warning, null)
  const requestFile = path.join(a.exportDir, senderModel.state().fileName)
  const requestBytes = readFileSync(requestFile)
  const issued = sender.calls[0].data.review
  const { requestId, requestDigest } = issued
  assert.match(requestId, /^[a-f0-9-]{36}$/)
  assert.match(requestDigest, /^[a-f0-9]{64}$/)
  assert.deepEqual(issued, { ...requestDraft, requestId, requestDigest })
  const issuedPref = sender.read()
  assert.notEqual(issuedPref, '')

  assert.equal((await recipientModel.pick(requestFile)).step, 'locked')
  assert.deepEqual(recipient.calls[0].data, { encrypted: true, locked: true })
  await recipientModel.flow.unlock(passphrase)
  assert.equal(recipientModel.state().step, 'request-inspected')
  assert.deepEqual(recipientModel.state().review, issued)
  assert.equal(recipientModel.flow.beginReply(), true)
  assert.equal(recipientModel.flow.previewReply(answer), true)
  const reply = { kind: 'reply', requestId, requestDigest, answer }
  assert.deepEqual(recipientModel.state().review, reply)
  assert.equal(recipient.calls.length, 2, 'previewing the reply does not export it')
  assert.equal(existsSync(b.exportDir), false)
  await recipientModel.flow.exportFile()
  assert.equal(recipientModel.state().step, 'exported')
  const replyName = recipientModel.state().fileName
  assert.deepEqual(readdirSync(b.exportDir), [replyName])
  const replyFile = path.join(b.exportDir, replyName)
  const replyBytes = readFileSync(replyFile)
  assert.deepEqual(recipient.calls[2].data.review, reply)
  assert.equal(recipient.read(), '', 'replying never issues or attaches on the recipient profile')
  await assertArchive(replyBytes, reply)
  await assertArchive(await collect(dependencies.envelope.decrypt(Readable.from([requestBytes]), passphrase)), issued)

  // A valid reply sharing the request ID but not its digest is still unknown.
  const unknownReply = { ...reply, requestDigest: (requestDigest[0] === 'a' ? 'b' : 'a') + requestDigest.slice(1), answer: 'Unknown reply fixture.' }
  const unknownExport = await sender.api('POST', exportRoute, { review: unknownReply })
  assert.equal(unknownExport.status, 201)
  const unknownFile = path.join(a.exportDir, unknownExport.body.fileName)
  const unknown = await senderModel.pick(unknownFile)
  assert.deepEqual([unknown.step, unknown.canReturn, unknown.review], ['reply-inspected', false, unknownReply])
  assert.equal(senderModel.flow.confirmReturn(), false)
  assert.equal(sender.read(), issuedPref)

  const preview = await senderModel.pick(replyFile)
  assert.deepEqual([preview.step, preview.boardTitle, preview.canReturn, preview.review], ['reply-inspected', original.title, true, reply])
  assert.equal(sender.read(), issuedPref, 'inspecting the reply has not stored the answer')
  assert.deepEqual(senderModel.flow.openResults(original).results, [])
  assert.deepEqual(senderModel.flow.openResults(unrelated).results, [])
  assert.equal((await senderModel.pick(replyFile)).canReturn, true)
  assert.equal(senderModel.flow.confirmReturn(), true)
  assert.equal(senderModel.state().step, 'returned')
  senderModel.flow.close()
  assert.equal(senderModel.state(), null)

  senderModel = sender.openModel()
  const results = () => senderModel.flow.openResults(original).results.map(result => result.answer)
  assert.deepEqual(results(), [answer], 'new flow and store load the actual answer from local prefs')
  assert.deepEqual(senderModel.flow.openResults(unrelated).results, [])
  assert.deepEqual(recipientModel.flow.openResults(sameIdOnB).results, [])
  const acceptedPref = sender.read()
  const duplicate = await senderModel.pick(replyFile)
  assert.deepEqual([duplicate.step, duplicate.canReturn, duplicate.review], ['reply-inspected', false, reply])
  assert.equal(senderModel.flow.confirmReturn(), false)
  assert.equal(sender.read(), acceptedPref)

  assert.equal(recipient.read(), '')
  assert.deepEqual(results(), [answer])
  assert.deepEqual(senderModel.flow.openResults(unrelated).results, [])
  assert.deepEqual(a.desk.board(original.id).head, originalHead)
  assert.deepEqual(a.desk.board(unrelated.id).head, unrelatedHead)

  const requestUpload = { bundle: requestBytes.toString('base64') }
  const replyUpload = { bundle: replyBytes.toString('base64') }
  assert.deepEqual(sender.calls.map(({ method, route, body, handled, status }) => [method, route, body, handled, status]), [
    ['POST', exportRoute, { review: requestDraft, passphrase }, true, 201],
    ['POST', exportRoute, { review: unknownReply }, true, 201],
    ['POST', inspectRoute, upload(unknownFile), true, 200],
    ...Array.from({ length: 3 }, () => ['POST', inspectRoute, replyUpload, true, 200]),
  ])
  assert.deepEqual(recipient.calls.map(({ method, route, body, handled, status }) => [method, route, body, handled, status]), [
    ['POST', inspectRoute, requestUpload, true, 200],
    ['POST', inspectRoute, { ...requestUpload, passphrase }, true, 200],
    ['POST', exportRoute, { review: reply }, true, 201],
  ])
  const responses = Buffer.from(JSON.stringify([...sender.calls, ...recipient.calls].map(call => call.data)))
  for (const undisclosed of [privateBoardText, privateRecipientText, privateChatText, privateBinding, 'bindingAccountKey', passphrase]) {
    assert.equal(has(responses, undisclosed), false, 'helper responses never echo private source data or the file phrase')
    assert.equal(has(Buffer.from(acceptedPref), undisclosed), false, 'private source data and the file phrase never enter the review preference')
  }
})
