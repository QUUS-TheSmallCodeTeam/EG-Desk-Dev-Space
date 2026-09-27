import { randomUUID } from 'node:crypto'
import { hashContent } from './egdesk-context-store.mjs'
import { chatError } from './codex-chat-values.mjs'

export function estimateTokens(text, shape = {}) {
  let ascii = 0, nonAscii = 0
  for (const char of text) { if (char.codePointAt(0) <= 127) ascii++; else nonAscii++ }
  const lines = text.split('\n').length
  return Math.ceil(ascii / 3.5 + nonAscii * 1.5 + (shape.format === 'table' ? lines * 3 : shape.format === 'code' ? lines : 0))
}

export function readAdmission(text, shape, usage = {}, attachments = 1) {
  const measured = Number.isFinite(usage.modelContextWindow) && Number.isFinite(usage.usedTokens)
  const answerReserve = 4096, toolOverhead = 1024 + Math.max(0, attachments - 1) * 128
  const availableTokens = measured
    ? Math.max(0, Math.min(8192, usage.modelContextWindow - usage.usedTokens - (usage.deliveryDebt || 0) - answerReserve - toolOverhead))
    : Math.max(0, 2048 - (usage.deliveryDebt || 0))
  const estimatedTokens = estimateTokens(text, shape) + 800
  return { mode: estimatedTokens <= availableTokens ? 'direct' : 'reader', estimatedTokens, availableTokens, answerReserve, toolOverhead, measurement: measured ? 'native-token-usage' : 'conservative-unmeasured-bound', reason: estimatedTokens <= availableTokens ? 'Full named read result fits after reply/tool reserves and source-shape costs.' : 'Read result exceeds the remaining admission allowance after shape and reply/tool reserves.' }
}

export function partitionText(text, ranges, maxChars = 12000) {
  const parts = []
  for (const range of ranges) {
    let start = range.startOffset
    while (start < range.endOffset) {
      let end = Math.min(range.endOffset, start + maxChars)
      if (end < range.endOffset) {
        const newline = text.lastIndexOf('\n', end)
        if (newline > start + Math.floor(maxChars / 2)) end = newline + 1
        if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--
      }
      parts.push({ index: parts.length, startOffset: start, endOffset: end })
      start = end
    }
  }
  return parts
}

function selectedRanges(text, query, range) {
  const lines = text.split('\n'), offsets = [0]
  for (let i = 0; i < lines.length; i++) offsets.push(offsets[i] + lines[i].length + (i < lines.length - 1 ? 1 : 0))
  const lineEnd = endLine => offsets[endLine] - (endLine < lines.length ? 1 : 0)
  if (range) {
    if (!Number.isInteger(range.startLine) || !Number.isInteger(range.endLine) || range.startLine < 1 || range.endLine < range.startLine || range.endLine > lines.length) throw chatError('INVALID_RANGE', 'Read range must refer to captured source lines')
    return { scope: 'line-range', ranges: [{ startOffset: offsets[range.startLine - 1], endOffset: lineEnd(range.endLine) }] }
  }
  if (query) {
    const lower = query.toLocaleLowerCase(), ranges = []
    for (let i = 0; i < lines.length; i++) if (lines[i].toLocaleLowerCase().includes(lower)) {
      const startOffset = offsets[Math.max(0, i - 1)], endOffset = lineEnd(Math.min(lines.length, i + 2))
      if (ranges.length && ranges.at(-1).endOffset >= startOffset) ranges.at(-1).endOffset = endOffset
      else ranges.push({ startOffset, endOffset })
    }
    return { scope: 'complete-literal-query-hit-set', ranges }
  }
  return { scope: 'capture', ranges: [{ startOffset: 0, endOffset: text.length }] }
}

function verifyReaderReceipt(result, assigned) {
  const payload = result?.inputPayload
  let input
  try { input = JSON.parse(payload?.text) } catch {}
  if (typeof result?.nativeThreadId !== 'string' || typeof result?.nativeTurnId !== 'string' || typeof payload?.text !== 'string' || hashContent(payload.text) !== payload.hash || input?.sourceText !== assigned.text || input?.sourceId !== assigned.sourceId || input?.sourceHash !== assigned.sourceHash || input?.range?.startOffset !== assigned.range.startOffset || input?.range?.endOffset !== assigned.range.endOffset) {
    throw chatError('READER_RECEIPT_INVALID', 'Reader did not retain the exact assigned native input payload; no successful coverage was recorded', 409)
  }
}

export class SmartReadEngine {
  constructor({ store, reader, maxPartitionsPerCall = 4, partitionChars = 12000, now = Date.now }) {
    Object.assign(this, { store, reader, maxPartitionsPerCall, partitionChars, now })
    this.sessions = new Map()
  }

  async read({ ownerKey, run, sourceId, intent, query, range, readerSessionId, usage, model, effort, cwd, signal, assertActive, emit = () => {} }) {
    if (typeof intent !== 'string' || !intent.trim() || intent.length > 2000 || (query != null && (typeof query !== 'string' || query.length > 1000))) throw chatError('INVALID_READ', 'A bounded read intent and optional literal query are required')
    if (range && query) throw chatError('INVALID_READ', 'Choose an explicit line range or a literal query, not both')
    assertActive()
    const { manifest, text } = await this.store.readProjection(ownerKey, sourceId)
    assertActive()
    const selection = selectedRanges(text, query, range)
    const selected = selection.ranges.map(r => text.slice(r.startOffset, r.endOffset)).join('\n')
    const admission = readAdmission(selected, manifest.shape, usage, run.context?.captures?.length || 1)
    if (admission.availableTokens < 768) throw chatError('CONTEXT_CAPACITY_REQUIRED', 'Insufficient remaining context for even a bounded packet; compact or continue in a fresh turn', 409)
    if (readerSessionId) admission.mode = 'reader'
    const packetId = randomUUID()
    let packet, readSession
    if (admission.mode === 'direct') {
      packet = {
        packetId, sourceId, sourceHash: manifest.hash, projectionHash: manifest.payloads.projection.hash, mode: 'direct', intent, query: query || null,
        content: { text: selected, ranges: selection.ranges },
        coverage: { scope: selection.scope, captureScope: manifest.captureScope, complete: !manifest.truncated, sourceTruncated: manifest.truncated, reviewedRanges: selection.ranges },
        selectedSpans: [], omissionPolicy: { type: 'none-within-named-read', sourceLimit: manifest.capture.coverage },
        lineage: { sourceId, rawHash: manifest.hash, projectionHash: manifest.payloads.projection.hash, transformations: manifest.transformations },
        reader: null, admission,
      }
    } else {
      if (!this.reader) throw chatError('READER_UNAVAILABLE', 'Native Reader is unavailable; no clipped result was substituted', 503)
      const signature = hashContent(JSON.stringify({ sourceId, hash: manifest.hash, intent, query: query || null, range: range || null }))
      let session = readerSessionId ? this.sessions.get(readerSessionId) : null
      if (readerSessionId && (!session || session.ownerKey !== ownerKey || session.conversationId !== run.conversationId || session.sourceId !== sourceId || session.hash !== manifest.hash)) throw chatError('READER_SESSION_MISMATCH', 'Reader session is unavailable or belongs to another source/account/conversation', 409)
      if (session?.busy) throw chatError('READER_BUSY', 'This Reader session is already reading', 409)
      const priorPacketId = session?.packetId || null
      if (!session) {
        if (this.sessions.size >= 32) throw chatError('READER_SESSION_LIMIT', 'Reader session limit reached', 429)
        session = { id: randomUUID(), ownerKey, conversationId: run.conversationId, sourceId, hash: manifest.hash, revision: 0, packetId: null }
        this.sessions.set(session.id, session)
      }
      if (session.signature !== signature || session.next >= session.parts?.length) {
        session.signature = signature
        session.parts = partitionText(text, selection.ranges, this.partitionChars)
        session.next = 0; session.levels = []; session.completed = []; session.native = []
      }
      session.busy = true
      readSession = session
      const maxOutputChars = Math.max(160, Math.min(1000, Math.floor((admission.availableTokens - 600) * 0.7)))
      const base = { ownerKey, parentThreadId: run.conversationId, readerSessionId: session.id, sourceId, sourceHash: manifest.hash, intent, query, cwd, model, effort, signal, maxOutputChars, onLifecycle: details => emit('reader.started', { ...details, sourceId }) }
      const merge = async nodes => {
        const notes = JSON.stringify(nodes.map(node => ({ summary: node.summary, sourceQuotes: node.selectedSpans.map(span => span.quote) })))
        const assigned = { ...base, text: notes, range: { startOffset: 0, endOffset: notes.length }, intent: `Integrate these already-covered source-reading notes for this read intent: ${intent}. Preserve uncertainty. This is a reading transformation, not the user's final business answer.` }
        const merged = await this.reader.read(assigned)
        assertActive()
        verifyReaderReceipt(merged, assigned)
        const recordId = await this.store.putRecord(ownerKey, 'readers', { stage: 'reading-integration', readerSessionId: session.id, sourceId, sourceHash: manifest.hash, inputPayload: merged.inputPayload, result: merged, createdAt: this.now() })
        assertActive()
        session.native.push({ threadId: merged.nativeThreadId, turnId: merged.nativeTurnId, purpose: 'reading-integration', recordId })
        // Only original-source quotations remain citations. Derived summaries
        // are not relabeled as raw source, and all leaf coverage stays in manifest.
        const spans = nodes.flatMap(node => node.selectedSpans)
        return { summary: merged.summary, structure: merged.structure, selectedSpans: spans.filter(span => merged.selectedSpans.some(selected => selected.quote.includes(span.quote) || span.quote.includes(selected.quote))).slice(0, 8) }
      }
      const addNode = async (node, level = 0) => {
        session.levels[level] ||= []
        session.levels[level].push(node)
        if (session.levels[level].length >= 4) {
          const group = session.levels[level].slice(0, 4)
          const merged = await merge(group)
          session.levels[level].splice(0, group.length)
          await addNode(merged, level + 1)
        }
      }
      emit('reader.started', { phase: 'preparing', readerSessionId: session.id, sourceId, sourceHash: manifest.hash, nextPartition: session.next, totalPartitions: session.parts.length })
      try {
        const end = Math.min(session.parts.length, session.next + this.maxPartitionsPerCall)
        while (session.next < end) {
          assertActive()
          const part = session.parts[session.next]
          const assigned = { ...base, text: text.slice(part.startOffset, part.endOffset), range: part }
          const result = await this.reader.read(assigned)
          assertActive()
          verifyReaderReceipt(result, assigned)
          const recordId = await this.store.putRecord(ownerKey, 'readers', { stage: 'source-fragment', readerSessionId: session.id, sourceId, sourceHash: manifest.hash, inputPayload: result.inputPayload, range: part, result, createdAt: this.now() })
          assertActive()
          session.native.push({ threadId: result.nativeThreadId, turnId: result.nativeTurnId, purpose: 'source-fragment', recordId })
          session.completed.push({ ...part, completedAt: this.now(), recordId })
          session.next++
          await addNode(result)
        }
        const nodes = session.levels.flat().filter(Boolean)
        let final = nodes.at(-1) || { summary: 'No matching captured text.', structure: [], selectedSpans: [] }
        // A partial packet describes completed coverage only. Do not make all
        // source content disappear merely because this bounded call must yield.
        if (nodes.length > 1) {
          let pending = nodes
          while (pending.length > 1) {
            const next = []
            for (let i = 0; i < pending.length; i += 4) next.push(pending.slice(i, i + 4).length === 1 ? pending[i] : await merge(pending.slice(i, i + 4)))
            pending = next
          }
          final = pending[0] || final
        }
        session.revision++
        const manifestId = await this.store.putRecord(ownerKey, 'readers', { readerSessionId: session.id, sourceId, sourceHash: manifest.hash, intent, query: query || null, partitions: session.parts, completed: session.completed, nextPartition: session.next, nativeSessions: session.native, revision: session.revision })
        assertActive()
        packet = {
          packetId, sourceId, sourceHash: manifest.hash, projectionHash: manifest.payloads.projection.hash, mode: 'reader', intent, query: query || null,
          summary: { text: final.summary, structure: final.structure }, selectedSpans: final.selectedSpans.map(span => ({ ...span, payloadRole: 'projection', projectionHash: manifest.payloads.projection.hash })),
          coverage: { scope: selection.scope, captureScope: manifest.captureScope, manifestId, complete: session.next === session.parts.length && !manifest.truncated, sourceTruncated: manifest.truncated, reviewedPartitions: session.next, totalPartitions: session.parts.length, continuation: session.next < session.parts.length ? { readerSessionId: session.id, nextPartition: session.next } : null },
          omissionPolicy: { type: 'reader-summary', reason: admission.reason, sourceLimit: manifest.capture.coverage, sourceSpans: 'selected exact quotations; full assigned coverage remains in the partition manifest' },
          lineage: { sourceId, rawHash: manifest.hash, projectionHash: manifest.payloads.projection.hash, transformations: manifest.transformations, refines: priorPacketId },
          reader: { sessionId: session.id, revision: session.revision }, admission,
        }
      } catch (error) {
        session.busy = false
        emit('reader.failed', { readerSessionId: session.id, sourceId, reviewedPartitions: session.next, totalPartitions: session.parts.length, code: error.code || 'READER_FAILED' })
        throw error
      }
    }
    try {
      assertActive()
      const deliveryText = JSON.stringify(packet)
      const deliveredTokens = estimateTokens(deliveryText)
      if (deliveredTokens > admission.availableTokens) throw chatError('PACKET_ADMISSION_REQUIRED', 'Structured packet exceeds remaining context; no clipped packet was delivered', 409)
      const record = { packet, deliveryText, deliveryHash: hashContent(deliveryText), binding: { conversationId: run.conversationId, runId: run.runId, answerId: run.answerId }, preparedAt: this.now(), estimatedTokens: deliveredTokens }
      await this.store.putRecord(ownerKey, 'packets', record, packetId)
      assertActive()
      if (readSession) {
        readSession.packetId = packetId
        emit('reader.completed', { readerSessionId: readSession.id, sourceId, coverage: packet.coverage, packetId, deliveryStatus: 'prepared' })
      }
      return record
    } catch (error) {
      if (readSession) emit('reader.failed', { readerSessionId: readSession.id, sourceId, reviewedPartitions: readSession.next, totalPartitions: readSession.parts.length, code: error.code || 'READER_FAILED' })
      throw error
    } finally { if (readSession) readSession.busy = false }
  }
}
