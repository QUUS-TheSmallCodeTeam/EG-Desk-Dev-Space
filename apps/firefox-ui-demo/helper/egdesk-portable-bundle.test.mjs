import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { PassThrough, Readable } from 'node:stream'
import { createEGDeskZipCodec, createEGDeskEncryptedEnvelope, createEGDeskPortableBundle } from './egdesk-portable-bundle.mjs'
import { createEGDeskPortableState } from '../overlay/resources/EGDeskPortableState.sys.mjs'

// Integration checkout owns dependencies. Workers can inject that package root
// only for tests; production code resolves its own pinned packages normally.
const require = createRequire(process.env.EGDESK_TEST_HELPER_PACKAGE || import.meta.url)
let dependencies
try {
  const yazl = require('yazl')
  const yauzl = require('yauzl')
  const sodium = require('libsodium-wrappers-sumo')
  await sodium.ready
  dependencies = { codec: createEGDeskZipCodec({ yazl, yauzl }), envelope: createEGDeskEncryptedEnvelope({ sodium }) }
} catch { dependencies = null }

const digest = data => createHash('sha256').update(data).digest('hex')
async function collect(source) { const parts = []; for await (const part of source) parts.push(Buffer.from(part)); return Buffer.concat(parts) }
const entry = (name, bytes) => ({ name, size: bytes.length, open: () => Readable.from([bytes]) })

function memorySink() {
  const writable = new PassThrough()
  const parts = []
  writable.on('data', part => parts.push(Buffer.from(part)))
  let published = false
  let aborted = false
  return {
    atomicPublish: true, stagingProtection: 'encrypted', writable,
    publish: async () => { published = true; return { location: 'memory' } },
    abort: async () => { aborted = true; writable.destroy() },
    bytes: () => Buffer.concat(parts),
    isPublished: () => published,
    isAborted: () => aborted,
  }
}

function fixture(overrides = {}) {
  const content = Buffer.from('Selected source bytes\n')
  const objectHash = digest(content)
  const nodes = new Map([
    ['board-1', { id: 'board-1', type: 'board', scopeRootId: 'board-1', title: 'Selected Board', refs: ['chat-1', 'private-1'], objects: [] }],
    ['chat-1', { id: 'chat-1', type: 'chat', scopeRootId: 'board-1', title: 'Selected chat', refs: ['source-1'], objects: [] }],
    ['source-1', { id: 'source-1', type: 'source', scopeRootId: 'board-1', title: 'Source', refs: [], objects: [{ sha256: objectHash, role: 'source' }] }],
    ['private-1', { id: 'private-1', type: 'source', scopeRootId: 'other-root', title: 'Private source', refs: [], objects: [] }],
  ])
  const committed = []
  const aborted = []
  const objectProvider = {
    async openExportSnapshot() {
      return {
        getNode: async id => nodes.get(id),
        listEvents: async () => [{ id: 'event-1', ownerId: 'chat-1', kind: 'message', at: 1, objectHash }],
        getObjectMeta: async hash => hash === objectHash ? { size: content.length, portableApproved: true, scopeRootId: 'board-1' } : null,
        openObject: async hash => Readable.from([overrides.objectBytes || content]),
        close: async () => {},
      }
    },
  }
  const importStore = {
    async beginStage() {
      const staged = new Map()
      return {
        encryptedStaging: true,
        async putObject({ sha256, stream }) { staged.set(sha256, await collect(stream)) },
        async commitCopy(payload) { committed.push({ ...payload, staged }); return { transaction: 'committed' } },
        async abort() { aborted.push(true) },
      }
    },
    async reopenRepresentative(rootIds) { return rootIds.length === 1 && committed.length === 1 },
  }
  const service = createEGDeskPortableBundle({ objectProvider, importStore, ...dependencies, ...(overrides.envelope ? { envelope: overrides.envelope } : {}) })
  return { service, content, objectHash, committed, aborted, nodes }
}

test('ZIP64 codec round-trips allowlisted entries sequentially without path extraction', { skip: !dependencies }, async () => {
  const { codec } = dependencies
  const object = Buffer.from('object')
  const zip = await collect(codec.encode([entry('manifest.json', Buffer.from('{}')), entry('events.jsonl', Buffer.alloc(0)), entry('transcript.md', Buffer.from('# summary')), entry(`objects/${digest(object)}`, object)]))
  const seen = []
  await codec.read(zip, async part => { seen.push([part.name, await collect(part.bytes())]) })
  assert.equal(seen.length, 4)
  assert.deepEqual(seen[3][1], object)
  assert.throws(() => codec.encode([entry('manifest.json', Buffer.from('{}')), entry('events.jsonl', Buffer.alloc(0)), entry('transcript.md', Buffer.from('x')), entry('manifest.json', Buffer.from('{}'))]), { code: 'DUPLICATE_ENTRY' })
  assert.throws(() => codec.encode([entry('../escape', Buffer.from('x')), entry('events.jsonl', Buffer.alloc(0)), entry('transcript.md', Buffer.from('x'))]), { code: 'UNSAFE_ENTRY' })
})

test('ZIP producer, lazy-provider and declared-length errors reject the output stream', { skip: !dependencies }, async () => {
  const base = [entry('manifest.json', Buffer.from('{}')), entry('events.jsonl', Buffer.alloc(0)), entry('transcript.md', Buffer.from('summary'))]
  const name = `objects/${'a'.repeat(64)}`
  await assert.rejects(collect(dependencies.codec.encode([...base, { name, size: 5, open: () => Readable.from((async function* () { yield Buffer.from('ab'); throw new Error('source failed') })()) }])), /source failed/)
  await assert.rejects(collect(dependencies.codec.encode([...base, { name, size: 5, open: async () => { throw new Error('provider failed') } }])), /provider failed/)
  await assert.rejects(collect(dependencies.codec.encode([...base, { name, size: 5, open: () => Readable.from([Buffer.from('ab')]) }])), /unexpected number of bytes/)
})

test('ZIP reader rejects duplicate names, links, excessive compression and entry budgets', { skip: !dependencies }, async () => {
  const { ZipFile } = require('yazl')
  const rawZip = async extras => {
    const zip = new ZipFile()
    for (const [name, bytes, options] of [['manifest.json', Buffer.from('{}'), {}], ['events.jsonl', Buffer.alloc(0), {}], ['transcript.md', Buffer.from('summary'), {}], ...extras]) zip.addBuffer(bytes, name, options)
    zip.end({ forceZip64Format: true })
    return collect(zip.outputStream)
  }
  const objectName = `objects/${'a'.repeat(64)}`
  const read = source => dependencies.codec.read(source, async part => { await collect(part.bytes()) })
  await assert.rejects(read(await rawZip([['transcript.md', Buffer.from('duplicate'), {}]])), { code: 'DUPLICATE_ENTRY' })
  await assert.rejects(read(await rawZip([[objectName, Buffer.from('link target'), { mode: 0o120777 }]])), { code: 'UNSAFE_ENTRY_TYPE' })
  await assert.rejects(read(await rawZip([[objectName, Buffer.alloc(8192, 65), { compress: true }]])), { code: 'ARCHIVE_RATIO' })
  const four = await rawZip([[objectName, Buffer.from('data'), { compress: false }]])
  await assert.rejects(dependencies.codec.read(four, async part => { await collect(part.bytes()) }, { budget: { maxEntries: 3, maxUncompressedBytes: 1024, maxRatio: 100 } }), { code: 'ARCHIVE_BUDGET' })
})

test('encrypted envelope authenticates header, every frame and FINAL; wrong password and truncation fail', { skip: !dependencies }, async () => {
  const { envelope } = dependencies
  const plain = Buffer.alloc(1024 * 1024 + 7, 65)
  const encrypted = await collect(envelope.encrypt(Readable.from([plain]), 'correct passphrase'))
  assert.equal(envelope.isEncryptedPrefix(encrypted), true)
  assert.deepEqual(await collect(envelope.decrypt(Readable.from([encrypted]), 'correct passphrase')), plain)
  await assert.rejects(collect(envelope.decrypt(Readable.from([encrypted]), 'incorrect')), /error|auth|decrypt|state|invalid/i)
  await assert.rejects(collect(envelope.decrypt(Readable.from([encrypted.subarray(0, -1)]), 'correct passphrase')), { code: 'TRUNCATED_ENVELOPE' })
  const tampered = Buffer.from(encrypted)
  tampered[20] ^= 1
  await assert.rejects(collect(envelope.decrypt(Readable.from([tampered]), 'correct passphrase')))
  await assert.rejects(collect(envelope.decrypt(Readable.from([Buffer.concat([encrypted, Buffer.from('extra')])]), 'correct passphrase')), { code: 'ENVELOPE_TRAILING' })
})

test('selected Board graph exports one bundle and imports as new IDs after validation', { skip: !dependencies }, async () => {
  const { service, content, objectHash, committed } = fixture()
  const plan = await service.planExport({ rootIds: ['board-1'] })
  assert.equal(plan.nodeCount, 3)
  assert.equal(plan.excludedCount, 1)
  assert.equal(plan.objectCount, 1)
  const sink = memorySink()
  const result = await service.exportPlan({ planId: plan.planId, sink, password: 'portable passphrase' })
  assert.equal(result.status, 'published')
  assert.equal(result.encrypted, true)
  assert.equal(sink.isPublished(), true)
  const preview = await service.inspectImport({ source: sink.bytes(), password: 'portable passphrase' })
  assert.equal(preview.mode, 'new-copy')
  assert.equal(preview.nodeCount, 3)
  assert.equal(committed.length, 0)
  const applied = await service.applyNewCopy({ importId: preview.importId })
  assert.equal(applied.status, 'imported-and-reopened')
  assert.notEqual(applied.rootIds[0], 'board-1')
  assert.equal(committed.length, 1)
  assert.deepEqual(committed[0].staged.get(objectHash), content)
  assert.equal(committed[0].nodes.some(node => node.id === 'private-1'), false)
  assert.equal(committed[0].nodes.some(node => node.refs.includes('private-1')), false)
  assert.equal(committed[0].events[0].ownerId, committed[0].nodes.find(node => node.type === 'chat').id)
})

test('plain bundle is explicit, protected sink mandatory, and original object hash checked twice', { skip: !dependencies }, async () => {
  const { service, nodes } = fixture()
  const plan = await service.planExport({ rootIds: ['board-1'] })
  await assert.rejects(service.exportPlan({ planId: plan.planId, sink: { writable: new PassThrough() } }), { code: 'UNSAFE_SINK' })
  const sink = memorySink()
  const receipt = await service.exportPlan({ planId: plan.planId, sink })
  assert.equal(receipt.encrypted, false)
  const preview = await service.inspectImport({ source: sink.bytes() })
  await service.cancelImport({ importId: preview.importId })
  nodes.get('board-1').title = '/Users/private/data'
  await assert.rejects(service.planExport({ rootIds: ['board-1'] }), { code: 'UNSAFE_METADATA' })
  const bad = fixture({ objectBytes: Buffer.from('wrong object bytes') })
  await assert.rejects(bad.service.planExport({ rootIds: ['board-1'] }), { code: 'OBJECT_HASH' })
})

test('object changes during ZIP production reject export without publication', { skip: !dependencies }, async () => {
  const overrides = {}
  const { service, content } = fixture(overrides)
  const plan = await service.planExport({ rootIds: ['board-1'] })
  overrides.objectBytes = Buffer.alloc(content.length, 66)
  const sink = memorySink()
  await assert.rejects(service.exportPlan({ planId: plan.planId, sink }), { code: 'OBJECT_HASH' })
  assert.equal(sink.isPublished(), false)
  assert.equal(sink.isAborted(), true)
})

test('65 MiB encrypted export cannot publish a bundle beyond its own import ceiling', { skip: !dependencies }, async () => {
  const chunk = Buffer.alloc(1024 * 1024, 65)
  const hasher = createHash('sha256')
  for (let index = 0; index < 65; index++) hasher.update(chunk)
  const objectHash = hasher.digest('hex')
  const service = createEGDeskPortableBundle({ ...dependencies,
    objectProvider: { openExportSnapshot: async () => ({
      getNode: async () => ({ id: 'source', type: 'source', scopeRootId: 'source', title: 'Large selected source', refs: [], objects: [{ sha256: objectHash, role: 'source' }] }),
      listEvents: async () => [], getObjectMeta: async () => ({ size: 65 * chunk.length, portableApproved: true, scopeRootId: 'source' }),
      openObject: async () => Readable.from((async function* () { for (let index = 0; index < 65; index++) yield chunk })()), close: async () => {},
    }) },
    importStore: { beginStage: async () => {}, reopenRepresentative: async () => true },
  })
  const plan = await service.planExport({ rootIds: ['source'] })
  const sink = memorySink()
  await assert.rejects(service.exportPlan({ planId: plan.planId, sink, password: 'test password' }), { code: 'MEMORY_BUDGET' })
  assert.equal(sink.bytes().length, 0)
  assert.equal(sink.isPublished(), false)
  assert.equal(sink.isAborted(), true)
})

test('encrypted export size guard includes ZIP64 overhead before publish', { skip: !dependencies }, async () => {
  const baseline = fixture()
  const plainPlan = await baseline.service.planExport({ rootIds: ['board-1'] })
  const plainSink = memorySink()
  await baseline.service.exportPlan({ planId: plainPlan.planId, sink: plainSink })
  let entryBytes = 0
  await dependencies.codec.read(plainSink.bytes(), async part => { entryBytes += (await collect(part.bytes())).length })
  assert.ok(plainSink.bytes().length > entryBytes + 10)
  const limited = fixture({ envelope: { ...dependencies.envelope, maxMemoryZipBytes: entryBytes + 10 } })
  const plan = await limited.service.planExport({ rootIds: ['board-1'] })
  const sink = memorySink()
  await assert.rejects(limited.service.exportPlan({ planId: plan.planId, sink, password: 'test password' }), { code: 'MEMORY_BUDGET' })
  assert.equal(sink.isPublished(), false)
  assert.equal(sink.isAborted(), true)
})

test('tampered object hash rejects import before commit and aborts stage', { skip: !dependencies }, async () => {
  const { service, committed, aborted } = fixture()
  const plan = await service.planExport({ rootIds: ['board-1'] })
  const sink = memorySink()
  await service.exportPlan({ planId: plan.planId, sink })
  const { codec } = dependencies
  const entries = []
  await codec.read(sink.bytes(), async part => entries.push(entry(part.name, await collect(part.bytes()))))
  entries[entries.length - 1] = entry(entries.at(-1).name, Buffer.from('wrong payload'))
  const tampered = await collect(codec.encode(entries))
  await assert.rejects(service.inspectImport({ source: tampered }), /size|hash/i)
  assert.equal(committed.length, 0)
  assert.equal(aborted.length, 1)
})

test('import rejects disconnected nodes, credential metadata and unknown major before staging', { skip: !dependencies }, async () => {
  const { service, committed, aborted } = fixture()
  const plan = await service.planExport({ rootIds: ['board-1'] })
  const sink = memorySink()
  await service.exportPlan({ planId: plan.planId, sink })
  const parts = []
  await dependencies.codec.read(sink.bytes(), async part => parts.push({ name: part.name, bytes: await collect(part.bytes()) }))
  for (const [code, mutate] of [
    ['UNSELECTED_NODE', content => content.nodes.push({ id: 'orphan', type: 'source', scopeRootId: 'board-1', title: 'Unselected', summary: '', rootAlias: null, refs: [], objects: [] })],
    ['INVALID_SCHEMA', content => { content.nodes[0].credential = 'must not restore' }],
    ['UNSUPPORTED_VERSION', content => { content.version.major = 2 }],
    ['UNSAFE_METADATA', content => { content.nodes[0].title = '/etc/local-file' }],
  ]) {
    const { contentSha256, ...content } = JSON.parse(parts[0].bytes.toString('utf8'))
    mutate(content)
    const manifest = { ...content, contentSha256: digest(Buffer.from(JSON.stringify(content))) }
    const altered = [entry('manifest.json', Buffer.from(JSON.stringify(manifest))), ...parts.slice(1).map(part => entry(part.name, part.bytes))]
    await assert.rejects(service.inspectImport({ source: await collect(dependencies.codec.encode(altered)) }), { code })
  }
  assert.equal(committed.length, 0)
  assert.equal(aborted.length, 0)
})

test('portable UI state separates preview, explicit publish, validated import and commit without retaining passwords', async () => {
  const calls = []
  const controller = createEGDeskPortableState({
    bundleService: {
      planExport: async ({ rootIds }) => ({ planId: 'plan-1', rootIds, objectCount: 1 }),
      exportPlan: async ({ password }) => { calls.push(['export', password]); return { status: 'published', encrypted: !!password } },
      cancelExport: async () => true,
      inspectImport: async () => ({ importId: 'import-1', mode: 'new-copy' }),
      applyNewCopy: async () => ({ status: 'imported-and-reopened', rootIds: ['new-board'] }),
      cancelImport: async () => true,
    },
    chooseExportSink: async () => ({ atomicPublish: true }),
    chooseImportSource: async () => Buffer.from('opaque selected bundle'),
  })
  assert.equal((await controller.prepareExport(['board-1'])).phase, 'export-ready')
  await assert.rejects(controller.publishExport(), /노출 범위/)
  assert.equal((await controller.publishExport({ password: 'do not persist' })).phase, 'export-published')
  assert.equal(JSON.stringify(controller.snapshot()).includes('do not persist'), false)
  assert.deepEqual(calls, [['export', 'do not persist']])
  assert.equal((await controller.inspectSelectedImport()).phase, 'import-ready')
  assert.equal((await controller.applyNewCopy()).phase, 'import-complete')
  assert.equal(controller.snapshot().receipt.rootIds[0], 'new-board')
})
