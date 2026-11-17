import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { ImmutableContextStore, hashContent } from './egdesk-context-store.mjs'
import { SmartReadEngine, readAdmission, strictReadAdmission, partitionText } from './egdesk-smart-read.mjs'
import { estimateClaudeReaderInput } from './egdesk-claude-reader.mjs'

async function setup(t, { failAt = -1, maxPartitionsPerCall = 4, partitionChars = 12000, truncated = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-read-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = new ImmutableContextStore({ dataDir: dir, allowedRoots: [dir] })
  const text = Array.from({ length: 400 }, (_, i) => `Source line ${i}: selected evidence for reading.`).join('\n')
  const [capture] = await store.captureAttachments('owner', { clientThreadId: 'ui', attachments: [{ id: 'source', kind: 'browser', label: 'Source', sourceRef: {}, captureScope: { type: 'document-text' }, content: { mime: 'text/plain', text, truncated } }] })
  const reads = []
  const reader = { estimateInput: estimateClaudeReaderInput, read: async options => {
    reads.push(options)
    if (reads.length === failAt) throw Object.assign(new Error('Reader failure'), { code: 'READER_FAILED' })
    const quote = options.text.slice(0, 20)
    const inputText = JSON.stringify({ sourceId: options.sourceId, sourceHash: options.sourceHash, sourceText: options.text, range: options.range, intent: options.intent })
    return { summary: 'A bounded source reading summary.', structure: ['Source structure'], selectedSpans: quote ? [{ quote, startOffset: options.range.startOffset, endOffset: options.range.startOffset + quote.length }] : [], nativeThreadId: 'test-native-reader', nativeTurnId: `test-native-turn-${reads.length}`, inputPayload: { text: inputText, hash: hashContent(inputText) },
      ...(options.engineId === 'claude' ? { receipt: { ...options.authority, sourceId: options.sourceId, sourceHash: options.sourceHash, range: options.range,
        fragmentHash: hashContent(options.text), inputPayloadHash: hashContent(inputText), nativeSessionId: 'test-native-reader', nativeResultId: `test-native-turn-${reads.length}` } } : {}) }
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

test('Claude refuses NativeReader and its continuation even when a Codex Reader is available', async t => {
  const h = await setup(t)
  await assert.rejects(h.engine.read({ ...h.options, engineId: 'claude' }), e => e.code === 'CLAUDE_CONTEXT_READER_UNSUPPORTED')
  const direct = { ...h.options, engineId: 'claude', range: { startLine: 1, endLine: 1 } }
  await assert.rejects(h.engine.read({ ...direct, readerSessionId: 'codex-reader-session' }), e => e.code === 'CLAUDE_CONTEXT_READER_UNSUPPORTED')
  assert.equal(h.reads.length, 0)
  assert.equal(h.engine.sessions.size, 0)
  assert.equal((await h.store.listRecords('owner', 'readers')).length, 0)
  assert.equal((await h.store.listRecords('owner', 'packets')).length, 0)
})

test('Claude direct line-range continuation is exact and names coverage honestly; preflight is not delivery', async t => {
  const h = await setup(t)
  const options = { ...h.options, engineId: 'claude', range: { startLine: 1, endLine: 1 } }
  const prepared = await h.engine.read({ ...options, prepareOnly: true })
  assert.equal(prepared.packet.mode, 'direct')
  assert.equal((await h.store.listRecords('owner', 'packets')).length, 0)
  const first = await h.engine.read(options)
  const second = await h.engine.read({ ...options, range: { startLine: 2, endLine: 3 } })
  assert.equal(first.packet.content.text, h.text.split('\n')[0])
  assert.equal(second.packet.content.text, h.text.split('\n').slice(1, 3).join('\n'))
  assert.equal(second.packet.sourceHash, first.packet.sourceHash)
  assert.equal(second.packet.coverage.scope, 'line-range')
  assert.equal(second.packet.coverage.complete, true)
  assert.equal(second.packet.coverage.reviewedRanges[0].startOffset, first.packet.coverage.reviewedRanges[0].endOffset + 1)
  assert.equal((await h.store.inspect('owner', h.capture.sourceId)).delivered, null)
  assert.equal(h.reads.length, 0)
})

test('Claude rejects truncated captured coverage even for a fitting direct range', async t => {
  const h = await setup(t, { truncated: true })
  await assert.rejects(h.engine.read({ ...h.options, engineId: 'claude', range: { startLine: 1, endLine: 1 } }), e => e.code === 'CONTEXT_CAPTURE_INCOMPLETE')
  assert.equal(h.reads.length, 0)
  assert.equal((await h.store.listRecords('owner', 'packets')).length, 0)
})

const verifiedCapacity = () => ({ status: 'verified', engineId: 'claude', source: 'native-observation', fallback: false,
  scope: { engineId: 'claude', engineProfileId: 'test', ownerKey: 'owner', epoch: 1 },
  model: 'fixture-model', engineBuild: 'fixture-build', metadataHash: hashContent('fixture metadata, not production evidence'),
  usableContextWindow: 64000, toolOutputLimitTokens: 8192, inputOverheadTokens: 128,
  estimator: { kind: 'utf8-upper-bound', verified: true, version: 'fixture-utf8-v1' } })
const strictOptions = () => ({ engineId: 'claude', authority: { engineId: 'claude', engineProfileId: 'test', ownerKey: 'owner', epoch: 1 },
  capacity: verifiedCapacity(), readerBudget: { maxInputTokens: 4800, inputOverheadTokens: 400 }, usage: { usedTokens: 2000 } })

test('B3 strict capacity never treats an unknown, fallback, documented or caller window as native evidence', () => {
  for (const capacity of [null, {}, { ...verifiedCapacity(), fallback: true }, { ...verifiedCapacity(), source: 'documented-model-policy' },
    { ...verifiedCapacity(), estimator: { kind: 'utf8-upper-bound', verified: false } }]) {
    assert.throws(() => strictReadAdmission('text', {}, capacity, { modelContextWindow: 1e9, usedTokens: 0 }), { code: 'ENGINE_CAPACITY_UNKNOWN' })
  }
  assert.throws(() => strictReadAdmission('text', {}, verifiedCapacity()), { code: 'ENGINE_CAPACITY_UNKNOWN' })
  const first = strictReadAdmission('text', {}, verifiedCapacity(), { usedTokens: 50000 })
  const busy = strictReadAdmission('text', {}, verifiedCapacity(), { usedTokens: 50000, reservedTokens: 1000 })
  assert.ok(busy.availableTokens < first.availableTokens)
  assert.equal(first.measurement, 'verified-utf8-upper-bound')
})

test('B3 and Codex prepareOnly cannot execute Reader, mutate sessions, emit lifecycle or write any record', async t => {
  const h = await setup(t)
  const engine = new SmartReadEngine({ store: h.store, getReader: () => h.engine.reader })
  for (const extra of [{}, strictOptions()]) {
    const result = await engine.read({ ...h.options, ...extra, prepareOnly: true })
    assert.equal(result.plan.mode, 'reader')
    assert.equal(result.plan.coverage, 'pending')
    assert.ok(result.plan.totalPartitions > 1)
  }
  assert.equal(h.reads.length, 0)
  assert.equal(h.events.length, 0)
  assert.equal(engine.sessions.size, 0)
  for (const kind of ['packets', 'deliveries', 'readers']) assert.deepEqual(await h.store.listRecords('owner', kind), [])
})

test('B3 huge source is partitioned by verified Reader input budget and continues all immutable ranges', async t => {
  const h = await setup(t)
  const engine = new SmartReadEngine({ store: h.store, getReader: id => id === 'claude' ? h.engine.reader : null, maxPartitionsPerCall: 2 })
  const options = { ...h.options, ...strictOptions() }
  let record = await engine.read(options)
  assert.equal(record.packet.coverage.complete, false)
  assert.equal(record.packet.coverage.reviewedPartitions, 2)
  const readerSessionId = record.packet.reader.sessionId
  while (record.packet.coverage.continuation) record = await engine.read({ ...options, readerSessionId })
  assert.equal(record.packet.coverage.complete, true)
  const coverage = await h.store.getRecord('owner', 'readers', record.packet.coverage.manifestId)
  const fragments = []
  for (const part of coverage.completed) {
    const receipt = await h.store.getRecord('owner', 'readers', part.recordId)
    const input = JSON.parse(receipt.inputPayload.text)
    assert.equal(input.sourceText, h.text.slice(part.startOffset, part.endOffset))
    assert.ok(Buffer.byteLength(input.sourceText) <= 4400)
    fragments.push(input.sourceText)
  }
  assert.equal(fragments.join(''), h.text)
  assert.equal(record.packet.reader.engineId, 'claude')
  assert.equal(record.packet.reader.purpose, 'source-reading')
})

test('B3 continuation refuses engine/profile/epoch/conversation drift and refinement rereads the original source', async t => {
  const h = await setup(t)
  const engine = new SmartReadEngine({ store: h.store, getReader: () => h.engine.reader })
  const options = { ...h.options, ...strictOptions() }
  const first = await engine.read(options)
  const readerSessionId = first.packet.reader.sessionId
  for (const change of [{ authority: { ...options.authority, epoch: 2 } }, { authority: { ...options.authority, engineProfileId: 'other' } },
    { run: { ...options.run, conversationId: 'other' } }, { engineId: 'codex' }]) {
    await assert.rejects(engine.read({ ...options, ...change, readerSessionId }), { code: 'READER_SESSION_MISMATCH' })
  }
  const count = h.reads.length
  const refined = await engine.read({ ...options, readerSessionId, intent: 'Inspect exact original evidence for another question' })
  assert.equal(refined.packet.lineage.refines, first.packet.packetId)
  assert.equal(h.reads[count].text, h.text.slice(0, h.reads[count].range.endOffset))
  assert.match(h.reads[count].intent, /another question/)
})

test('Reader integration preserves original quote identities/ranges despite JSON quotes and newlines', async t => {
  const h = await setup(t)
  const original = 'First "quoted" line\nSecond line\\path\n'.repeat(1000)
  const [capture] = await h.store.captureAttachments('owner', { clientThreadId: 'ui', attachments: [{ kind: 'browser', label: 'Quotes', sourceRef: {}, captureScope: { type: 'document-text' }, content: { text: original, truncated: false } }] })
  const record = await h.engine.read({ ...h.options, sourceId: capture.sourceId })
  assert.ok(record.packet.selectedSpans.length)
  for (const span of record.packet.selectedSpans) {
    assert.match(span.spanId, /^[a-f0-9]{64}$/)
    assert.equal(original.slice(span.startOffset, span.endOffset), span.quote)
  }
  assert.ok(record.packet.selectedSpans.some(span => span.quote.includes('"')))
})

// SUB-09: continuation cursor after a helper restart (a new SmartReadEngine on the same store).
const restartOptions = (h, epoch) => {
  const options = { ...h.options, ...strictOptions() }
  options.authority = { ...options.authority, epoch }
  options.capacity = { ...options.capacity, scope: { ...options.capacity.scope, epoch } }
  return options
}

test('SUB-09 a restarted helper continues the same Reader session from its saved cursor without rereading completed fragments', async t => {
  const h = await setup(t)
  const before = new SmartReadEngine({ store: h.store, getReader: () => h.engine.reader, maxPartitionsPerCall: 2 })
  const first = await before.read(restartOptions(h, 1))
  assert.equal(first.packet.coverage.reviewedPartitions, 2)
  const readerSessionId = first.packet.reader.sessionId
  const readsBefore = h.reads.length
  const lastEnd = h.reads.filter(read => !read.intent.startsWith('Integrate')).at(-1).range.endOffset
  // Restart: memory is gone; the connection epoch is new.
  const after = new SmartReadEngine({ store: h.store, getReader: () => h.engine.reader, maxPartitionsPerCall: 2 })
  let record = await after.read({ ...restartOptions(h, 5), readerSessionId })
  assert.equal(record.packet.reader.sessionId, readerSessionId)
  assert.equal(record.packet.reader.restoredFrom, 'checkpoint')
  assert.equal(h.reads[readsBefore].range.startOffset, lastEnd, 'continues at the next partition, not from the start')
  assert.equal(record.packet.lineage.refines, first.packet.packetId)
  while (record.packet.coverage.continuation) record = await after.read({ ...restartOptions(h, 5), readerSessionId })
  assert.equal(record.packet.coverage.complete, true)
  const coverage = await h.store.getRecord('owner', 'readers', record.packet.coverage.manifestId)
  const fragments = []
  for (const part of coverage.completed) fragments.push(JSON.parse((await h.store.getRecord('owner', 'readers', part.recordId)).inputPayload.text).sourceText)
  assert.equal(fragments.join(''), h.text, 'every original range covered exactly once across the restart')
})

test('SUB-09 cursor restore refuses another conversation/profile, the same process and a tampered cursor', async t => {
  const h = await setup(t)
  const engine = new SmartReadEngine({ store: h.store, getReader: () => h.engine.reader, maxPartitionsPerCall: 2 })
  const first = await engine.read(restartOptions(h, 1))
  const readerSessionId = first.packet.reader.sessionId
  engine.sessions.clear()
  await assert.rejects(engine.read({ ...restartOptions(h, 1), readerSessionId }), { code: 'READER_SESSION_MISMATCH' }, 'same process: no revival')
  const restarted = () => new SmartReadEngine({ store: h.store, getReader: () => h.engine.reader, maxPartitionsPerCall: 2 })
  await assert.rejects(restarted().read({ ...restartOptions(h, 2), readerSessionId, run: { ...h.options.run, conversationId: 'other' } }), { code: 'READER_SESSION_MISMATCH' })
  const otherProfile = restartOptions(h, 2)
  otherProfile.authority = { ...otherProfile.authority, engineProfileId: 'other' }
  otherProfile.capacity = { ...otherProfile.capacity, scope: { ...otherProfile.capacity.scope, engineProfileId: 'other' } }
  await assert.rejects(restarted().read({ ...otherProfile, readerSessionId }), { code: 'READER_SESSION_MISMATCH' })
  await assert.rejects(restarted().read({ ...restartOptions(h, 2), readerSessionId, engineId: 'codex' }), { code: 'READER_SESSION_MISMATCH' })
  // A newer cursor whose completed fragment points at the wrong receipt is refused, not trusted.
  const cursors = await h.store.listRecords('owner', 'readers', record => record.stage === 'reader-cursor' && record.readerSessionId === readerSessionId)
  const latest = cursors.sort((a, b) => b.seq - a.seq)[0]
  const { id: _id, ownerScope: _scope, ...copy } = latest
  const swapped = [copy.completed[1], copy.completed[0]]
  await h.store.putRecord('owner', 'readers', { ...copy, seq: latest.seq + 1, completed: swapped })
  await assert.rejects(restarted().read({ ...restartOptions(h, 2), readerSessionId }), { code: 'READER_CURSOR_INVALID' })
})
