import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ImmutableContextStore, hashContent } from './egdesk-context-store.mjs'
import { SmartReadEngine, readAdmission, partitionText } from './egdesk-smart-read.mjs'

async function setup(t, { failAt = -1, maxPartitionsPerCall = 4, partitionChars = 12000, truncated = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-read-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new ImmutableContextStore({ dataDir: dir, allowedRoots: [dir] })
  const text = Array.from({ length: 400 }, (_, i) => `Source line ${i}: selected evidence for reading.`).join('\n')
  const [capture] = await store.captureAttachments('owner', { clientThreadId: 'ui', attachments: [{ id: 'source', kind: 'browser', label: 'Source', sourceRef: {}, captureScope: { type: 'document-text' }, content: { mime: 'text/plain', text, truncated } }] })
  const reads = []
  const reader = { read: async options => {
    reads.push(options)
    if (reads.length === failAt) throw Object.assign(new Error('Reader failure'), { code: 'READER_FAILED' })
    const quote = options.text.slice(0, 20)
    const inputText = JSON.stringify({ sourceId: options.sourceId, sourceHash: options.sourceHash, sourceText: options.text, range: options.range, intent: options.intent })
    return { summary: 'A bounded source reading summary.', structure: ['Source structure'], selectedSpans: quote ? [{ quote, startOffset: options.range.startOffset, endOffset: options.range.startOffset + quote.length }] : [], nativeThreadId: 'test-native-reader', nativeTurnId: `test-native-turn-${reads.length}`, inputPayload: { text: inputText, hash: hashContent(inputText) } }
  } }
  const engine = new SmartReadEngine({ store, reader, maxPartitionsPerCall, partitionChars })
  const events = []
  const options = { ownerKey: 'owner', run: { conversationId: 'parent', runId: 'turn', answerId: 'parent/turn', context: { captures: [capture] } }, sourceId: capture.sourceId, intent: 'Review the selected source', cwd: dir, assertActive: () => {}, emit: (name, details) => events.push({ name, details }) }
  return { store, text, capture, engine, options, reads, events }
}

test('admission considers context reserves, source shape and attachment count rather than byte/token comparison', () => {
  const text = 'x,y,z\n'.repeat(80)
  const usage = { modelContextWindow: 10000, usedTokens: 3000 }
  assert.ok(readAdmission(text, { format: 'table' }, usage, 4).estimatedTokens > readAdmission(text, { format: 'text' }, usage, 1).estimatedTokens)
  assert.ok(readAdmission(text, {}, usage, 4).availableTokens < readAdmission(text, {}, usage, 1).availableTokens)
  assert.equal(readAdmission('Short text', {}, {}, 1).mode, 'direct')
  assert.equal(readAdmission('Long text '.repeat(3000), {}, {}, 1).mode, 'reader')
})

test('partition plan covers all selected source offsets without clipping', () => {
  const text = 'one\ntwo\n' + 'long-line'.repeat(100)
  const parts = partitionText(text, [{ startOffset: 0, endOffset: text.length }], 80)
  assert.equal(parts[0].startOffset, 0)
  assert.equal(parts.at(-1).endOffset, text.length)
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i].startOffset, parts[i - 1].endOffset)
  assert.equal(parts.map(part => text.slice(part.startOffset, part.endOffset)).join(''), text)
})

test('overflow uses Reader and produces coverage-backed packet, with original source preserved', async t => {
  const h = await setup(t)
  const record = await h.engine.read(h.options)
  assert.equal(record.packet.mode, 'reader')
  assert.equal(record.packet.coverage.complete, true)
  assert.ok(h.reads.length > 0)
  assert.equal(record.deliveryHash, hashContent(record.deliveryText))
  assert.equal((await h.store.inspect('owner', h.capture.sourceId)).delivered, null)
  assert.equal((await h.store.readProjection('owner', h.capture.sourceId)).text, h.text)
})

test('bounded partial Reader can continue and truncated source never becomes full original coverage', async t => {
  const h = await setup(t, { maxPartitionsPerCall: 1, partitionChars: 5000, truncated: true })
  let record = await h.engine.read(h.options)
  assert.equal(record.packet.coverage.complete, false)
  assert.equal(record.packet.coverage.reviewedPartitions, 1)
  const readerSessionId = record.packet.reader.sessionId
  const prior = record.packet.packetId
  for (let i = 0; i < 10 && record.packet.coverage.continuation; i++) record = await h.engine.read({ ...h.options, readerSessionId })
  assert.equal(record.packet.coverage.continuation, null)
  assert.equal(record.packet.coverage.reviewedPartitions, record.packet.coverage.totalPartitions)
  assert.equal(record.packet.coverage.complete, false)
  assert.equal(record.packet.coverage.sourceTruncated, true)
  assert.ok(record.packet.lineage.refines)
  assert.notEqual(record.packet.packetId, prior)
})

test('refinement reuses logical Reader and reads fixed source bytes again', async t => {
  const h = await setup(t, { partitionChars: 30000 })
  const first = await h.engine.read(h.options)
  const second = await h.engine.read({ ...h.options, readerSessionId: first.packet.reader.sessionId, intent: 'Re-read original source from a different angle' })
  assert.equal(first.packet.reader.sessionId, second.packet.reader.sessionId)
  assert.equal(second.packet.lineage.refines, first.packet.packetId)
  assert.equal(h.reads[0].text, h.text)
  assert.equal(h.reads[1].text, h.text)
})

test('partition failure preserves completed coverage but never returns a successful full packet', async t => {
  const h = await setup(t, { failAt: 2, partitionChars: 5000 })
  await assert.rejects(h.engine.read(h.options), e => e.code === 'READER_FAILED')
  const failed = h.events.find(event => event.name === 'reader.failed')
  assert.equal(failed.details.reviewedPartitions, 1)
  assert.ok(failed.details.totalPartitions > 1)
  assert.equal((await h.store.listRecords('owner', 'packets')).length, 0)
  assert.equal(h.events.some(event => event.name === 'reader.completed'), false)
})

test('missing exact native Reader input receipt cannot become successful coverage', async t => {
  const h = await setup(t)
  const read = h.engine.reader.read
  h.engine.reader.read = async options => ({ ...await read(options), inputPayload: { text: 'replaced input', hash: hashContent('different bytes') } })
  await assert.rejects(h.engine.read(h.options), e => e.code === 'READER_RECEIPT_INVALID')
  assert.equal((await h.store.listRecords('owner', 'packets')).length, 0)
  assert.equal(h.events.find(event => event.name === 'reader.failed').details.reviewedPartitions, 0)
})

test('packet persistence failure is not Reader completion or a refinement delivery reference', async t => {
  const h = await setup(t)
  const put = h.store.putRecord.bind(h.store)
  h.store.putRecord = async (owner, kind, ...rest) => {
    if (kind === 'packets') throw Object.assign(new Error('Storage unavailable'), { code: 'STORE_FAILED' })
    return put(owner, kind, ...rest)
  }
  await assert.rejects(h.engine.read(h.options), e => e.code === 'STORE_FAILED')
  assert.equal(h.events.some(event => event.name === 'reader.completed'), false)
  const session = [...h.engine.sessions.values()][0]
  assert.equal(session.packetId, null)
  assert.equal(session.busy, false)
  assert.equal((await h.store.inspect('owner', h.capture.sourceId)).delivered, null)
})

test('failed reading integration retains completed leaf evidence for an explicit retry', async t => {
  const h = await setup(t, { failAt: 5, partitionChars: 4000 })
  await assert.rejects(h.engine.read(h.options), e => e.code === 'READER_FAILED')
  const session = [...h.engine.sessions.values()][0]
  assert.equal(session.next, 4)
  assert.equal(session.levels[0].length, 4)
  assert.equal(session.packetId, null)
  const retried = await h.engine.read({ ...h.options, readerSessionId: session.id })
  assert.equal(retried.packet.coverage.reviewedPartitions, retried.packet.coverage.totalPartitions)
  assert.equal(retried.packet.coverage.complete, true)
})
