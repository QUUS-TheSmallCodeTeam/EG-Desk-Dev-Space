// L1 c24 (owner decision: a profile room's big reads use the ROOM's account, U11): behind EGDESK_ROOM_ACCOUNT, a smart read for a room on an Agent profile
// runs on THAT profile's own reader (its app-server, its account), never on the shared reader of the default account; flag off, everything goes to the shared
// reader as before. The SmartReadEngine and the context store are real; the readers and app-server routes are fakes that record every call. Mocks only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ImmutableContextStore, hashContent } from './egdesk-context-store.mjs'
import { SmartReadEngine } from './egdesk-smart-read.mjs'
import { createEngineReaderFactory, ContextRuntime } from './egdesk-context-runtime.mjs'
import { createProfileReaders } from './egdesk-profile-readers.mjs'
import { isProfileSlot } from './egdesk-slot-readiness.mjs'
import { NativeReaderClient } from './egdesk-native-reader.mjs'
import { readFileSync } from 'node:fs'

const SLOT = 'codex-abcdef01', MAIN = 'codex-default'
const fakeReader = name => { const reads = []; return { name, reads, estimateInput: () => 1,
  async read(options) { reads.push(options); const quote = options.text.slice(0, 20)
    const inputText = JSON.stringify({ sourceId: options.sourceId, sourceHash: options.sourceHash, sourceText: options.text, range: options.range, intent: options.intent })
    return { summary: `read by ${name}`, structure: ['s'], selectedSpans: quote ? [{ quote, startOffset: options.range.startOffset, endOffset: options.range.startOffset + quote.length }] : [],
      nativeThreadId: `${name}-thread`, nativeTurnId: `${name}-turn-${reads.length}`, inputPayload: { text: inputText, hash: hashContent(inputText) } } },
  disconnect(options) { this.disconnected = options } } }

async function sourceFixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-profile-read-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new ImmutableContextStore({ dataDir: dir, allowedRoots: [dir] })
  const text = Array.from({ length: 400 }, (_, i) => `Source line ${i}: selected evidence for reading.`).join('\n')
  const [capture] = await store.captureAttachments('owner', { clientThreadId: 'ui', attachments: [{ id: 'source', kind: 'browser', label: 'Source', sourceRef: {}, captureScope: { type: 'document-text' }, content: { mime: 'text/plain', text, truncated: false } }] })
  const options = (authority, extra = {}) => ({ ownerKey: 'owner', run: { conversationId: 'parent', runId: 'turn', answerId: 'parent/turn', clientThreadId: 'ui', context: { captures: [capture] } }, sourceId: capture.sourceId,
    intent: 'Review the selected source', engineId: 'codex', assertActive() {}, authority, usage: {}, model: 'm', effort: 'low', ...extra })
  return { store, capture, options }
}

test('the engine factory: a profile read goes to the profile\'s reader (flag), the shared reader otherwise; a profile without a reader is unavailable, never the shared account\'s', () => {
  const shared = fakeReader('shared'), own = fakeReader('profile')
  const flagOn = createEngineReaderFactory({ codex: shared, forProfile: id => (id === SLOT ? own : undefined) })
  assert.equal(flagOn('codex', { engineProfileId: SLOT }), own)
  assert.equal(flagOn('codex', { engineProfileId: MAIN }), shared, 'the default account: the shared reader')
  assert.equal(flagOn('codex', null), shared); assert.equal(flagOn('codex'), shared)
  assert.equal(flagOn('claude', { engineProfileId: SLOT }), null, 'another engine is not a Codex profile read')
  const none = createEngineReaderFactory({ codex: shared, forProfile: () => null })
  assert.equal(none('codex', { engineProfileId: SLOT }), null, 'a profile slot with no reader: unavailable, not the shared account')
  const flagOff = createEngineReaderFactory({ codex: shared, forProfile: () => undefined })
  assert.equal(flagOff('codex', { engineProfileId: SLOT }), shared, 'flag off: as before')
  assert.equal(createEngineReaderFactory({ codex: shared })('codex', { engineProfileId: SLOT }), shared, 'no profile readers configured: as before')
})

test('a smart read for a profile room runs on the profile\'s reader; the shared reader stays untouched (shared down + default signed out); the default room reads on the shared one', async t => {
  const f = await sourceFixture(t)
  const shared = fakeReader('shared'), own = fakeReader('profile')
  const readers = createProfileReaders({ enabled: () => true, isProfileSlot, request() {}, respond() {}, ownerKey: () => 'email:work@example.test', makeClient: () => own })
  const engine = new SmartReadEngine({ store: f.store, getReader: createEngineReaderFactory({ codex: shared, forProfile: id => readers.forProfile(id) }) })
  // the shared reader would fail (its server is down): a profile read must not touch it
  shared.read = async () => { throw Object.assign(new Error('shared app-server offline'), { code: 'READER_OFFLINE' }) }
  const record = await engine.read(f.options({ engineId: 'codex', engineProfileId: SLOT, ownerKey: 'email:work@example.test' }))
  assert.equal(record.packet.mode, 'reader'); assert.ok(own.reads.length > 0, 'read on the profile\'s reader')
  assert.equal(shared.reads.length, 0)
  // the default room's read goes to the shared reader (here: failing)
  await assert.rejects(engine.read(f.options({ engineId: 'codex', engineProfileId: MAIN, ownerKey: 'owner' })), /offline|READER/)
  // reverse: the profile reader down, the shared up: the default room reads, the profile room does not borrow the shared account
  const f2 = await sourceFixture(t), shared2 = fakeReader('shared'), own2 = fakeReader('profile')
  own2.read = async () => { throw Object.assign(new Error('profile app-server offline'), { code: 'READER_OFFLINE' }) }
  const engine2 = new SmartReadEngine({ store: f2.store, getReader: createEngineReaderFactory({ codex: shared2, forProfile: id => (id === SLOT ? own2 : undefined) }) })
  assert.equal((await engine2.read(f2.options({ engineId: 'codex', engineProfileId: MAIN }))).packet.mode, 'reader'); assert.ok(shared2.reads.length > 0)
  const before = shared2.reads.length
  await assert.rejects(engine2.read(f2.options({ engineId: 'codex', engineProfileId: SLOT }, { })), /offline|READER/)
  assert.equal(shared2.reads.length, before, 'the profile room never fell back to the shared account')
})

test('profile readers: off by default; per profile; requests, replies and owner keys go to THAT profile\'s app-server; events reach only its own reader', async () => {
  const calls = []
  const make = options => ({ options, notified: [], requested: [], handleNotification(m) { this.notified.push(m); return m.params?.threadId === 'child-a' }, handleServerRequest(m) { return m.params?.threadId === 'child-a' },
    disconnect() {} })
  let flag = false
  const readers = createProfileReaders({ enabled: () => flag, isProfileSlot, request: (id, method, params) => { calls.push(['request', id, method]); return {} }, respond: (id, rpcId) => calls.push(['respond', id, rpcId]),
    ownerKey: id => `owner-of-${id}`, makeClient: make })
  assert.equal(readers.forProfile(SLOT), undefined, 'flag off: the shared reader is used')
  flag = true
  assert.equal(readers.forProfile(MAIN), undefined, 'the default account is not a profile'); assert.equal(readers.forProfile(undefined), undefined)
  const a = readers.forProfile(SLOT), b = readers.forProfile('codex-0badc0de')
  assert.notEqual(a, b); assert.equal(readers.forProfile(SLOT), a, 'one reader per profile')
  a.options.request('thread/start', {}); b.options.request('thread/start', {})
  a.options.respond('codex-profile:7', null, { code: 1 })
  assert.deepEqual(calls, [['request', SLOT, 'thread/start'], ['request', 'codex-0badc0de', 'thread/start'], ['respond', SLOT, 'codex-profile:7']])
  assert.deepEqual([a.options.getOwnerKey(), b.options.getOwnerKey()], [`owner-of-${SLOT}`, 'owner-of-codex-0badc0de'])
  assert.equal(readers.handleNotification(SLOT, { params: { threadId: 'child-a' } }), true)
  assert.equal(readers.handleNotification('codex-0badc0de', { params: { threadId: 'child-a' } }), true, 'each profile asks its own reader')
  assert.deepEqual([a.notified.length, b.notified.length], [1, 1])
  assert.equal(readers.handleNotification('codex-nope', { params: {} }), false); assert.equal(readers.handleServerRequest(SLOT, { params: { threadId: 'other' } }), false)
  assert.equal(readers.all().length, 2)
  assert.throws(() => createProfileReaders({}), TypeError)
})

test('a real NativeReaderClient of a profile checks ITS account: another account on that profile ends the read; the default account changing does not', () => {
  let profileOwner = 'email:work@example.test', defaultOwner = 'email:a@example.test'
  const readers = createProfileReaders({ enabled: () => true, isProfileSlot, request() {}, respond() {}, ownerKey: () => profileOwner })
  const reader = readers.forProfile(SLOT), shared = new NativeReaderClient({ request() {}, respond() {}, getOwnerKey: () => defaultOwner })
  assert.doesNotThrow(() => reader.assertOwner('email:work@example.test'))
  defaultOwner = 'email:c@example.test'
  assert.doesNotThrow(() => reader.assertOwner('email:work@example.test'), 'the default account changed: the profile\'s read stands')
  assert.throws(() => shared.assertOwner('email:a@example.test'), { code: 'ACCOUNT_CHANGED' }, 'the shared reader follows the default, as before')
  profileOwner = 'email:z@example.test'
  assert.throws(() => reader.assertOwner('email:work@example.test'), { code: 'ACCOUNT_CHANGED' }, 'another account signed in on the profile')
  profileOwner = null; assert.throws(() => reader.assertOwner('email:work@example.test'), { code: 'ACCOUNT_CHANGED' })
})

test('connection loss: a profile\'s lost connection disconnects THAT profile\'s reader and not the shared one; the readiness is the profile\'s', () => {
  const shared = fakeReader('shared'), own = fakeReader('profile')
  const contexts = new ContextRuntime({ store: {}, reader: shared, profileReaders: { forProfile: id => (id === SLOT ? own : undefined) }, getOwnerKey: () => 'email:a@example.test', getAuthority: () => null, schemaReady: () => true })
  contexts.disconnect({ engineId: 'codex', engineProfileId: SLOT, processLost: true })
  assert.deepEqual([own.disconnected?.processLost, shared.disconnected], [true, undefined], 'the profile\'s reader only')
  contexts.disconnect({ engineId: 'codex', engineProfileId: MAIN, processLost: true })
  assert.equal(shared.disconnected?.processLost, true, 'the default connection: the shared reader, as before')
  assert.deepEqual(contexts.readerReadiness({ engineId: 'codex', engineProfileId: SLOT }), { ready: true, engineId: 'codex', code: null })
  const noReader = new ContextRuntime({ store: {}, reader: shared, profileReaders: { forProfile: () => null }, getOwnerKey: () => 'x', getAuthority: () => null, schemaReady: () => true })
  assert.deepEqual(noReader.readerReadiness({ engineId: 'codex', engineProfileId: SLOT }), { ready: false, engineId: 'codex', code: 'READER_UNAVAILABLE' }, 'a profile with no reader is unavailable, not shared')
})

test('the bridge builds the profile readers behind the flag and routes a profile\'s events to them; smart read passes the authority to the reader choice', () => {
  const server = readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(server, /const profileReaders = createProfileReaders\(\{ enabled: \(\) => process\.env\.EGDESK_ROOM_ACCOUNT === 'on', isProfileSlot,/)
  assert.match(server, /readers: \{ claude: claudeReader \}, profileReaders, getReadCapacity/)
  assert.match(server, /onNotification: \(id, message\) => \{ if \(!profileReaders\.handleNotification\(id, message\)\) codexEngine\.notify\(message, id\) \},/)
  assert.match(server, /onServerRequest: \(id, message\) => \{ if \(!profileReaders\.handleServerRequest\(id, message\)\) codexEngine\.serverRequest\(message, id\) \},/)
  assert.match(readFileSync(new URL('./egdesk-smart-read.mjs', import.meta.url), 'utf8'), /this\.getReader\(engineId, authority\)/)
})

test('published results of a profile room are read under the room\'s own account (default signed out, default someone else, account change mid-read); without a route, the default as before', async () => {
  const OUT = '11111111-2222-3333-4444-555555555555'
  for (const defaultOwner of [null, 'email:someone-else@example.test']) {
    const state = { work: 'email:work@example.test', seen: [] }
    const authority = () => ({ engineId: 'codex', engineProfileId: SLOT, ownerKey: state.work, epoch: 3 })
    const contexts = new ContextRuntime({ store: { async listOutputs(owner) { state.seen.push(['list', owner]); return [] }, async readOutput(owner) { state.seen.push(['read', owner]); state.afterRead?.(); return { markdown: 'x' } } },
      reader: {}, getOwnerKey: () => defaultOwner, getAuthority: () => authority(), schemaReady: () => true })
    contexts.runtime = { epoch: 0 }
    assert.deepEqual(await contexts.listOutputVersions({ conversationId: 'c' }, authority()), { outputs: [] })
    await contexts.readOutput(OUT, authority())
    assert.deepEqual(state.seen, [['list', 'email:work@example.test'], ['read', 'email:work@example.test']], `default ${defaultOwner}`)
    // another account signs in on the profile while the read is in flight: the result is refused, not delivered under the new account
    const stale = authority()
    state.afterRead = () => { state.work = 'email:z@example.test' }
    await assert.rejects(contexts.readOutput(OUT, stale), { code: 'ACCOUNT_CHANGED' })
  }
  // no route: the default account, as before
  const seen = []
  const plain = new ContextRuntime({ store: { async readOutput(owner) { seen.push(owner); return {} } }, reader: {}, getOwnerKey: () => 'email:a@example.test', getAuthority: () => ({ engineId: 'codex', engineProfileId: MAIN, ownerKey: 'email:a@example.test', epoch: 1 }), schemaReady: () => true })
  plain.runtime = { epoch: 0 }
  await plain.readOutput(OUT); assert.deepEqual(seen, ['email:a@example.test'])
  const http = readFileSync(new URL('./egdesk-context-http.mjs', import.meta.url), 'utf8')
  assert.match(http, /context\.readOutput\(output\[1\], authority\)/); assert.match(http, /outputKey \}, authority\)\)/)
})
