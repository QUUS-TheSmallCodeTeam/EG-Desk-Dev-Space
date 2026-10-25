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
    ? Math.max(0, Math.min(8192, usage.modelContextWindow - usage.usedTokens - (usage.deliveryDebt || 0) - (usage.reservedTokens || 0) - answerReserve - toolOverhead))
    : Math.max(0, 2048 - (usage.deliveryDebt || 0) - (usage.reservedTokens || 0))
  const estimatedTokens = estimateTokens(text, shape) + 800
  return { mode: estimatedTokens <= availableTokens ? 'direct' : 'reader', estimatedTokens, availableTokens, answerReserve, toolOverhead, measurement: measured ? 'native-token-usage' : 'conservative-unmeasured-bound', reason: estimatedTokens <= availableTokens ? 'Full named read result fits after reply/tool reserves and source-shape costs.' : 'Read result exceeds the remaining admission allowance after shape and reply/tool reserves.' }
}

// B3 capacity is server-owned evidence, never a client context-window hint.
// Legacy small/direct B2 reads retain their conservative admission separately.
export function strictReadAdmission(text, shape, capacity, usage = {}, attachments = 1, { authority, model } = {}) {
  if (capacity?.status !== 'verified' || capacity.engineId !== 'claude' || capacity.fallback !== false ||
      capacity.source !== 'native-observation' || !capacity.model || !capacity.engineBuild || !capacity.metadataHash ||
      !/^[a-f0-9]{64}$/.test(capacity.metadataHash) ||
      !Number.isSafeInteger(capacity.usableContextWindow) || capacity.usableContextWindow <= 0 ||
      !Number.isSafeInteger(capacity.toolOutputLimitTokens) || capacity.toolOutputLimitTokens <= 0 ||
      !Number.isSafeInteger(capacity.inputOverheadTokens) || capacity.inputOverheadTokens < 0 ||
      capacity.estimator?.kind !== 'utf8-upper-bound' || capacity.estimator.verified !== true || !capacity.estimator.version ||
      !Number.isSafeInteger(usage.usedTokens) || usage.usedTokens < 0 ||
      (usage.deliveryDebt != null && (!Number.isSafeInteger(usage.deliveryDebt) || usage.deliveryDebt < 0)) ||
      (usage.reservedTokens != null && (!Number.isSafeInteger(usage.reservedTokens) || usage.reservedTokens < 0)) ||
      (authority && (capacity.scope?.engineId !== authority.engineId || capacity.scope?.engineProfileId !== authority.engineProfileId ||
        capacity.scope?.ownerKey !== authority.ownerKey || capacity.scope?.epoch !== authority.epoch)) ||
      (model && capacity.model !== model)) {
    throw chatError('ENGINE_CAPACITY_UNKNOWN', 'Claude Reader requires authoritative model capacity, input usage and verified text/tool-output bounds; no Reader was started', 409)
  }
  const window = capacity.usableContextWindow
  const answerReserve = Math.min(4096, Math.floor(window / 4))
  const safetyReserve = Math.max(1024, Math.ceil(window * 0.15))
  const toolOverhead = capacity.inputOverheadTokens + Math.max(0, attachments - 1) * 128
  const availableTokens = Math.max(0, Math.min(4096, Math.floor(0.8 * capacity.toolOutputLimitTokens),
    window - usage.usedTokens - (usage.deliveryDebt || 0) - (usage.reservedTokens || 0) - toolOverhead - answerReserve - safetyReserve))
  const estimatedTokens = Buffer.byteLength(text, 'utf8') + toolOverhead
  return { mode: estimatedTokens <= availableTokens ? 'direct' : 'reader', estimatedTokens, availableTokens,
    answerReserve, safetyReserve, toolOverhead, measurement: 'verified-utf8-upper-bound', estimatorVersion: capacity.estimator.version,
    capacityEvidence: { model: capacity.model, engineBuild: capacity.engineBuild, metadataHash: capacity.metadataHash, source: capacity.source },
    reason: 'Authoritative selected-model capacity minus existing input, attachment references, concurrent reservations, tool overhead and reply/safety reserves.' }
}

export function partitionText(text, ranges, maxChars = 12000, { maxInputTokens = Infinity, estimate = estimateTokens, shape = {} } = {}) {
  if (!Number.isFinite(maxChars) || maxChars < 2 || !(maxInputTokens > 0)) throw chatError('ENGINE_CONTEXT_CONFIGURATION_ERROR', 'Reader cannot fit a valid source unit', 409)
  const parts = []
  for (const range of ranges) {
    let start = range.startOffset
    while (start < range.endOffset) {
      let end = Math.min(range.endOffset, start + maxChars)
      const cost = end => estimate(text.slice(start, end), shape, { startOffset: start, endOffset: end })
      if (cost(end) > maxInputTokens) {
        let lo = start, hi = end
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2)
          if (cost(mid) <= maxInputTokens) lo = mid
          else hi = mid - 1
        }
        end = lo
      }
      if (end < range.endOffset) {
        const newline = text.lastIndexOf('\n', end)
        if (newline > start + Math.floor((end - start) / 2) && newline < end) end = newline + 1
        if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--
      }
      if (end <= start) throw chatError('ENGINE_CONTEXT_CONFIGURATION_ERROR', 'Reader cannot fit the smallest complete source character', 409)
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
  if (!result?.nativeThreadId || !result?.nativeTurnId || typeof payload?.text !== 'string' || hashContent(payload.text) !== payload.hash || input?.sourceText !== assigned.text || input?.sourceId !== assigned.sourceId || input?.sourceHash !== assigned.sourceHash || input?.intent !== assigned.intent || input?.range?.startOffset !== assigned.range.startOffset || input?.range?.endOffset !== assigned.range.endOffset) {
    throw chatError('READER_RECEIPT_INVALID', 'Reader did not retain the exact assigned native input payload; no successful coverage was recorded', 409)
  }
  if (!Array.isArray(result.selectedSpans) || result.selectedSpans.length > 8 || result.selectedSpans.some(span =>
    typeof span.quote !== 'string' || !span.quote || !Number.isInteger(span.startOffset) || !Number.isInteger(span.endOffset) ||
    span.startOffset < assigned.range.startOffset || span.endOffset > assigned.range.endOffset ||
    assigned.text.slice(span.startOffset - assigned.range.startOffset, span.endOffset - assigned.range.startOffset) !== span.quote)) {
    throw chatError('READER_INVALID_CITATION', 'Reader evidence is not an exact quotation of the assigned immutable range', 409)
  }
  if (assigned.engineId === 'claude') {
    const receipt = result.receipt
    if (receipt?.engineId !== 'claude' || receipt.engineProfileId !== assigned.authority?.engineProfileId || receipt.ownerKey !== assigned.ownerKey ||
        receipt.epoch !== assigned.authority?.epoch || receipt.sourceId !== assigned.sourceId || receipt.sourceHash !== assigned.sourceHash ||
        receipt.range?.startOffset !== assigned.range.startOffset || receipt.range?.endOffset !== assigned.range.endOffset ||
        receipt.fragmentHash !== hashContent(assigned.text) || receipt.inputPayloadHash !== payload.hash ||
        receipt.nativeSessionId !== result.nativeThreadId || receipt.nativeResultId !== result.nativeTurnId) {
      throw chatError('READER_RECEIPT_INVALID', 'Claude Reader scope or native receipt does not match the assigned fragment', 409)
    }
  }
}

export class SmartReadEngine {
  constructor({ store, reader, getReader, maxPartitionsPerCall = 4, partitionChars = 12000, now = Date.now }) {
    Object.assign(this, { store, reader, getReader, maxPartitionsPerCall, partitionChars, now })
    this.sessions = new Map()
  }

  async read({ ownerKey, run, sourceId, intent, query, range, readerSessionId, usage, model, effort, cwd, signal, assertActive, engineId = 'codex', authority, capacity, readerBudget, allowReader = true, readerUnavailableCode, forceReader = false, prepareOnly = false, emit = () => {} }) {
    if (typeof intent !== 'string' || !intent.trim() || intent.length > 2000 || (query != null && (typeof query !== 'string' || query.length > 1000))) throw chatError('INVALID_READ', 'A bounded read intent and optional literal query are required')
    if (range && query) throw chatError('INVALID_READ', 'Choose an explicit line range or a literal query, not both')
    assertActive()
    const { manifest, text } = await this.store.readProjection(ownerKey, sourceId)
    assertActive()
    if (engineId === 'claude' && (manifest.truncated || manifest.capture?.coverage?.complete !== true)) throw chatError('CONTEXT_CAPTURE_INCOMPLETE', 'This selected capture is incomplete. Attach a complete selection before sending; the draft has not been sent', 409)
    const selection = selectedRanges(text, query, range)
    const selected = selection.ranges.map(r => text.slice(r.startOffset, r.endOffset)).join('\n')
    const attachments = run.context?.captures?.length || 1
    let admission = readAdmission(selected, manifest.shape, usage, attachments)
    const reader = allowReader ? (this.getReader ? this.getReader(engineId) : engineId === 'codex' ? this.reader : null) : null
    const scopeKey = JSON.stringify([engineId, authority?.engineProfileId || null, authority?.epoch ?? null, run.clientThreadId || null])
    if (readerSessionId && reader) {
      const session = this.sessions.get(readerSessionId)
      if (!session || session.scopeKey !== scopeKey || session.ownerKey !== ownerKey || session.conversationId !== run.conversationId || session.sourceId !== sourceId || session.hash !== manifest.hash) {
        throw chatError('READER_SESSION_MISMATCH', 'Reader session belongs to another engine/source/account/conversation/connection or expired after restart', 409)
      }
      if (session.busy) throw chatError('READER_BUSY', 'This Reader session is already reading', 409)
    }
    const readerUnsupported = () => { throw chatError(readerUnavailableCode || 'CLAUDE_CONTEXT_READER_UNSUPPORTED', 'The selected Claude Reader is not verified available for this read. No fallback, clipped source or draft was sent', 409) }
    if (engineId === 'claude' && (readerSessionId || forceReader || admission.mode !== 'direct' || admission.availableTokens < 768)) {
      if (!reader) readerUnsupported()
      admission = strictReadAdmission(selected, manifest.shape, capacity, usage, attachments, { authority, model })
      // Once the bounded Reader route was selected, a large native window
      // does not reclassify that source as an unbounded raw result.
      admission.mode = 'reader'
    }
    if (admission.availableTokens < 768) throw chatError('CONTEXT_CAPACITY_REQUIRED', 'Insufficient remaining context for even a bounded packet; compact or continue in a fresh turn', 409)
    if (readerSessionId || forceReader) admission.mode = 'reader'
    let plannedParts = null
    const inputBudget = engineId === 'claude' ? readerBudget?.maxInputTokens : readerBudget?.maxInputTokens || Infinity
    const inputOverhead = readerBudget?.inputOverheadTokens || 0
    const maxOutputChars = Math.max(160, Math.min(1000, Math.floor((admission.availableTokens - 600) * 0.7)))
    const inputTemplate = { sourceId, sourceHash: manifest.hash, intent, query, maxOutputChars }
    const estimateInput = (text, shape, range) => engineId === 'claude'
      ? reader.estimateInput({ ...inputTemplate, text, range }) : estimateTokens(text, shape)
    if (admission.mode === 'reader') {
      if (!reader) throw chatError('READER_UNAVAILABLE', 'Selected engine Reader is unavailable; no other engine or clipped source was substituted', 503)
      if (engineId === 'claude' && typeof reader.estimateInput !== 'function') throw chatError('ENGINE_CAPACITY_UNKNOWN', 'Selected Reader cannot measure its exact input envelope without execution', 409)
      if (!(inputBudget > inputOverhead)) throw chatError('ENGINE_CAPACITY_UNKNOWN', 'Verified Reader input capacity is unavailable', 409)
      plannedParts = partitionText(text, selection.ranges, this.partitionChars, { maxInputTokens: inputBudget - inputOverhead, estimate: estimateInput, shape: manifest.shape })
      // Preflight ends before session allocation, lifecycle events, Reader
      // calls or record writes. It is a plan, not source coverage/delivery.
      if (prepareOnly) return { plan: { mode: 'reader', engineId, sourceId, sourceHash: manifest.hash, scope: selection.scope,
        ranges: selection.ranges, totalPartitions: plannedParts.length, maxPartitionsPerCall: this.maxPartitionsPerCall,
        inputBudget, inputOverhead, admission, coverage: 'pending' }, estimatedTokens: Math.min(admission.availableTokens, 2048) }
    }
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
      const signature = hashContent(JSON.stringify({ sourceId, hash: manifest.hash, intent, query: query || null, range: range || null }))
      let session = readerSessionId ? this.sessions.get(readerSessionId) : null
      if (readerSessionId && (!session || session.scopeKey !== scopeKey || session.ownerKey !== ownerKey || session.conversationId !== run.conversationId || session.sourceId !== sourceId || session.hash !== manifest.hash)) throw chatError('READER_SESSION_MISMATCH', 'Reader session is unavailable or belongs to another engine/source/account/conversation/connection', 409)
      if (session?.busy) throw chatError('READER_BUSY', 'This Reader session is already reading', 409)
      const priorPacketId = session?.packetId || null
      if (!session) {
        if (this.sessions.size >= 32) throw chatError('READER_SESSION_LIMIT', 'Reader session limit reached', 429)
        session = { id: randomUUID(), ownerKey, authority, engineId, scopeKey, conversationId: run.conversationId, sourceId, hash: manifest.hash, revision: 0, packetId: null }
        this.sessions.set(session.id, session)
      }
      if (session.signature !== signature || session.next >= session.parts?.length) {
        session.signature = signature
        session.parts = plannedParts
        session.next = 0; session.levels = []; session.completed = []; session.native = []
      }
      session.busy = true
      readSession = session
      const base = { ownerKey: authority?.ownerKey || ownerKey, authority, engineId, engineProfileId: authority?.engineProfileId, epoch: authority?.epoch,
        parentThreadId: run.conversationId, readerSessionId: session.id, sourceId, sourceHash: manifest.hash, intent, query, cwd, model, effort, signal, assertActive, maxOutputChars,
        onLifecycle: details => { assertActive(); emit('reader.started', { ...details, sourceId }) } }
      const inputCost = assigned => (engineId === 'claude' ? reader.estimateInput({ ...assigned, range: { startOffset: assigned.range.startOffset, endOffset: assigned.range.endOffset } }) : estimateTokens(assigned.text, manifest.shape)) + inputOverhead
      let callsThisWave = 0
      const invoke = async assigned => {
        assertActive()
        if (inputCost(assigned) > inputBudget) throw chatError('ENGINE_CONTEXT_CONFIGURATION_ERROR', 'Reading integration exceeds verified Reader input capacity; no notes were clipped', 409)
        if (++callsThisWave > 32) throw chatError('READER_EVENT_LIMIT', 'Bounded Reader wave limit reached; original coverage remains pending, not complete', 409)
        const result = await reader.read(assigned)
        assertActive()
        verifyReaderReceipt(result, assigned)
        return result
      }
      const merge = async nodes => {
        const notes = JSON.stringify(nodes.map(node => ({ summary: node.summary, sourceSpans: node.selectedSpans })))
        const assigned = { ...base, text: notes, range: { startOffset: 0, endOffset: notes.length }, intent: `Integrate these already-covered source-reading notes for this read intent: ${intent}. Preserve uncertainty. This is a reading transformation, not the user's final business answer.` }
        if (inputCost(assigned) > inputBudget && nodes.length > 2) {
          const middle = Math.ceil(nodes.length / 2)
          const left = await merge(nodes.slice(0, middle))
          const right = nodes.length - middle === 1 ? nodes[middle] : await merge(nodes.slice(middle))
          return merge([left, right])
        }
        const merged = await invoke(assigned)
        const recordId = await this.store.putRecord(ownerKey, 'readers', { stage: 'reading-integration', readerSessionId: session.id, sourceId, sourceHash: manifest.hash, inputPayload: merged.inputPayload, result: merged, createdAt: this.now() })
        assertActive()
        session.native.push({ threadId: merged.nativeThreadId, turnId: merged.nativeTurnId, purpose: 'reading-integration', recordId })
        // Only original-source quotations remain citations. Derived summaries
        // are not relabeled as raw source, and all leaf coverage stays in manifest.
        const spans = [...new Map(nodes.flatMap(node => node.selectedSpans).map(span => [span.spanId, span])).values()]
        // Model quotations here refer to the serialized NOTES, not original
        // source offsets. Keep bounded original evidence by identity instead
        // of comparing JSON-escaped text with raw quotations.
        return { summary: merged.summary, structure: merged.structure, selectedSpans: spans.slice(0, 8),
          omittedSpanCount: nodes.reduce((sum, node) => sum + (node.omittedSpanCount || 0), 0) + Math.max(0, spans.length - 8) }
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
          const result = await invoke(assigned)
          for (const span of result.selectedSpans) span.spanId = hashContent(JSON.stringify([sourceId, manifest.hash, span.startOffset, span.endOffset, span.quote]))
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
          omissionPolicy: { type: 'reader-summary', reason: admission.reason, sourceLimit: manifest.capture.coverage,
            selectedSpanLimit: 8, omittedSpanCount: final.omittedSpanCount || 0, sourceSpans: 'selected exact original quotations; full assigned coverage remains in the partition manifest' },
          lineage: { sourceId, rawHash: manifest.hash, projectionHash: manifest.payloads.projection.hash, transformations: manifest.transformations, refines: priorPacketId },
          reader: { sessionId: session.id, revision: session.revision, engineId, purpose: 'source-reading',
            limits: { maxPartitionsPerCall: this.maxPartitionsPerCall, maxReaderCallsPerWave: 32, inputBudget: Number.isFinite(inputBudget) ? inputBudget : null, partitionChars: this.partitionChars } }, admission,
        }
      } catch (error) {
        session.busy = false
        emit('reader.failed', { readerSessionId: session.id, sourceId, reviewedPartitions: session.next, totalPartitions: session.parts.length, code: error.code || 'READER_FAILED' })
        throw error
      }
    }
    try {
      assertActive()
      const packetCost = value => admission.measurement === 'verified-utf8-upper-bound' ? Buffer.byteLength(value, 'utf8') + capacity.inputOverheadTokens : estimateTokens(value)
      // Evidence quotations are an explicitly selected subset, not source
      // coverage. Select whole original spans before naming the final payload;
      // never cut source/summary strings or silently drop reviewed partitions.
      if (packet.mode === 'reader') {
        packet.omissionPolicy.spanSelection = 'Whole exact source spans fitting the admitted packet; unselected spans are counted below and remain in Reader records.'
        while (packet.selectedSpans.length && packetCost(JSON.stringify(packet)) > admission.availableTokens) {
          packet.selectedSpans.pop()
          packet.omissionPolicy.omittedSpanCount++
        }
      }
      const deliveryText = JSON.stringify(packet)
      const deliveredTokens = packetCost(deliveryText)
      if (deliveredTokens > admission.availableTokens) {
        if (engineId === 'claude' && !reader) readerUnsupported()
        throw chatError('PACKET_ADMISSION_REQUIRED', 'Structured packet exceeds remaining context; no clipped packet was delivered', 409)
      }
      const record = { packet, deliveryText, deliveryHash: hashContent(deliveryText), binding: { conversationId: run.conversationId, runId: run.runId, answerId: run.answerId }, preparedAt: this.now(), estimatedTokens: deliveredTokens }
      // Admission is not a read receipt or delivery: persist nothing on preflight.
      if (prepareOnly) return record
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
