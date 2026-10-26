// Explicit fixture transport data only; no native provider. The optional
// prelaunch scene uses real local stores. Inspector reads never reread originals.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { assertContextCaptureBatch, fingerprintQaBytes, observeQaFixtureFile } from './egdesk-context-qa-contract.mjs';
import { readAdmission, partitionText } from '../helper/egdesk-smart-read.mjs'; // Pure math; never constructs a Reader.

const copy = value => JSON.parse(JSON.stringify(value));
const fail = (code, message, httpStatus = 400) => { throw Object.assign(new Error(message), { code, httpStatus }); };

export function createQaContextFixture(profile) {
  assertQaFixtureManifest(profile);
  const sources = new Map();
  const readers = new Map();
  // Like CTX-04, tracking is memory-only, and belongs to a conversation, not
  // the immutable capture. Eviction or missing tracking never means active.
  const tracked = new Map();
  const trackingKey = r => JSON.stringify([r.owner, r.engineId, r.engineProfileId, r.conversationId]);
  const touch = (map, key, value, limit) => {
    map.delete(key); map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
  };
  const stats = { captureBatches: 0, fileCaptureOperations: 0, inspectorReads: [], deliveries: [] };
  const find = (sourceId, owner) => {
    const entry = sources.get(sourceId);
    if (!entry || entry.owner !== owner) fail('CONTEXT_NOT_FOUND', 'Unknown fixture capture for this account', 404);
    return entry;
  };
  const scoped = (sourceIds, owner, clientThreadId) => {
    if (!Array.isArray(sourceIds) || !sourceIds.length || new Set(sourceIds).size !== sourceIds.length) fail('INVALID_CONTEXT', 'Explicit unique source IDs required');
    return sourceIds.map(sourceId => {
      const entry = find(sourceId, owner);
      if (clientThreadId && entry.manifest.clientThreadId !== clientThreadId) fail('CONTEXT_THREAD_MISMATCH', 'Capture belongs to another fixture thread', 403);
      return entry;
    });
  };
  const directEntries = (sourceIds, owner, clientThreadId, readerAvailable = false) => {
    const entries = scoped(sourceIds, owner, clientThreadId);
    let deliveryDebt = 0;
    for (const entry of entries) {
      if (entry.manifest.truncated) fail('CONTEXT_CAPTURE_INCOMPLETE', 'Selected capture is truncated; no subset is substituted', 409);
      if (!entry.manifest.shape.readable) fail('UNSUPPORTED_SOURCE_FORMAT', 'Selected capture has no readable projection', 422);
      const admission = readAdmission(entry.text, entry.manifest.shape, { deliveryDebt }, entries.length);
      if (admission.mode !== 'direct' && !readerAvailable) fail('CLAUDE_CONTEXT_READER_UNSUPPORTED', 'Claude Smart Read is temporarily unsupported; select a smaller complete source', 409);
      deliveryDebt += admission.estimatedTokens;
    }
    return entries;
  };
  const track = (entry, binding) => {
    const ref = entry.manifest.sourceRef, kind = ref.kind;
    if (!(kind === 'file' && ref.path || kind === 'browser' && ref.viewId)) return;
    const key = trackingKey({ ...binding, owner: entry.owner });
    const rows = tracked.get(key) || new Map();
    const sourceId = entry.manifest.sourceId;
    if (!rows.has(sourceId)) touch(rows, sourceId, { sourceId, kind,
      ...(ref.viewId ? { viewId: ref.viewId } : {}), state: 'active', reason: null, changedAt: null, announcedAt: null }, 32);
    touch(tracked, key, rows, 64);
  };
  const assertSourceScope = r => {
    const entry = find(r.sourceId, r.owner);
    if (!entry.bindings.some(b => ['conversationId', 'clientThreadId', 'engineId', 'engineProfileId'].every(k => b[k] === r[k]))) {
      fail('CONTEXT_THREAD_MISMATCH', 'Stored source is not bound to this exact fixture route', 403);
    }
    return entry;
  };
  return {
    stats,
    assertSourceScope,
    sourceStatus(r) {
      return { conversationId: r.conversationId, sources: copy([...(tracked.get(trackingKey(r))?.values() || [])].filter(row => row.state !== 'missing')) };
    },
    setSourceStatus(r) {
      assertSourceScope(r);
      const rows = tracked.get(trackingKey(r));
      // Deliberately do not invent a row for previews, unsupported sources,
      // evicted conversations, or missing memory after a restart.
      const row = rows?.get(r.sourceId);
      if (!row) fail('CONTEXT_STATUS_MISSING', 'Source is not memory-tracked in this conversation', 409);
      Object.assign(row, { state: r.state, reason: r.reason, changedAt: r.changedAt, announcedAt: null });
    },
    registerStored({ owner, manifest, text, binding, packet, store }) {
      if (sources.has(manifest.sourceId)) fail('QA_DUPLICATE_SEED', 'Source already registered', 409);
      const entry = { owner, manifest: copy(manifest), text, bindings: [copy(binding)], packets: [copy(packet)], store };
      sources.set(manifest.sourceId, entry); track(entry, binding);
    },
    captureBatch(body, owner, { directOnly = false } = {}) {
      if (!owner || !body?.clientThreadId || !Array.isArray(body.attachments)
          || body.attachments.length < 1 || body.attachments.length > 16) fail('INVALID_CAPTURE', 'Fixture needs 1–16 explicit attachments');
      const staged = body.attachments.map(attachment => {
        let bytes;
        if (attachment.kind === 'file') {
          const before = observeQaFixtureFile(profile, attachment.sourceRef?.path);
          bytes = fs.readFileSync(before.path);
          if (fingerprintQaBytes(bytes).sha256 !== before.sha256) fail('SOURCE_CHANGED', 'Fixture file changed during capture', 409);
          stats.fileCaptureOperations++;
        } else if (['browser', 'board'].includes(attachment.kind)
            && typeof attachment.content?.text === 'string' && typeof attachment.content.truncated === 'boolean') {
          bytes = Buffer.from(attachment.content.text);
        } else fail('INVALID_CAPTURE', 'Explicit Browser/Board capture text is required');
        if (bytes.length > 32 * 1024 * 1024) fail('CAPTURE_LIMIT', 'Fixture capture exceeds its byte limit', 413);
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { fail(directOnly ? 'UNSUPPORTED_SOURCE_FORMAT' : 'UNSUPPORTED_FIXTURE', 'This fixture covers UTF-8 text, not binary capture', 422); }
        if (text.includes('\0')) fail(directOnly ? 'UNSUPPORTED_SOURCE_FORMAT' : 'UNSUPPORTED_FIXTURE', 'Binary fixture is not configured', 422);
        if (directOnly && attachment.content?.truncated === true) fail('CONTEXT_CAPTURE_INCOMPLETE', 'Selected capture is truncated; no subset is substituted', 409);
        const sourceId = randomUUID(), hash = fingerprintQaBytes(bytes).sha256;
        const mime = attachment.content?.mime || 'text/plain';
        const manifest = { version: 1, id: attachment.id, sourceId, snapshotId: sourceId,
          clientThreadId: body.clientThreadId, hash, capturedAt: Date.now(),
          captureScope: copy(attachment.captureScope), truncated: attachment.kind === 'file' ? false : attachment.content.truncated,
          sourceRef: { ...copy(attachment.sourceRef), kind: attachment.kind },
          shape: { readable: true, format: 'text', mime, lineCount: text.split('\n').length,
            charCount: text.length, byteLength: bytes.length },
          payloads: { source: { hash, byteLength: bytes.length } }, transformations: [] };
        return { owner, manifest, text, bindings: [], packets: [] };
      });
      const response = { captures: staged.map(entry => copy(entry.manifest)) };
      assertContextCaptureBatch(body, response);
      for (const entry of staged) sources.set(entry.manifest.sourceId, entry);
      stats.captureBatches++;
      return response;
    },
    validateDirect(sourceIds, clientThreadId, owner, { readerAvailable = false } = {}) {
      return directEntries(sourceIds, owner, clientThreadId, readerAvailable).map(entry => copy(entry.manifest));
    },
    requiresReader(sourceIds, clientThreadId, owner) {
      let deliveryDebt = 0;
      return scoped(sourceIds, owner, clientThreadId).map(entry => {
        const admission = readAdmission(entry.text, entry.manifest.shape, { deliveryDebt }, sourceIds.length);
        deliveryDebt += admission.estimatedTokens;
        return admission.mode === 'reader';
      }).some(Boolean);
    },
    bind(sourceIds, run, owner, { directOnly = false, readerAvailable = false } = {}) {
      const entries = directOnly ? directEntries(sourceIds, owner, run.clientThreadId, readerAvailable) : scoped(sourceIds, owner);
      if (directOnly && entries.some(entry => entry.bindings.some(binding => binding.conversationId !== run.conversationId))) {
        fail('CONTEXT_THREAD_MISMATCH', 'Capture is already bound to another native conversation', 403);
      }
      const engineId = run.engineId || 'codex';
      const binding = { bindingId: randomUUID(), conversationId: run.conversationId, runId: run.runId, answerId: run.answerId,
        clientThreadId: run.clientThreadId, engineId, engineProfileId: run.engineProfileId || `${engineId}-default` };
      for (const entry of entries) { entry.bindings.push(copy(binding)); track(entry, binding); }
      return entries.map(entry => copy(entry.manifest));
    },
    // Three separate synthetic boundaries: stored source, processed partition,
    // and parent delivery. No native IDs, SDK, persona, child Chat or provider.
    startReader(sourceId, run, owner) {
      const entry = find(sourceId, owner);
      if (!entry.bindings.some(binding => ['conversationId', 'runId', 'answerId'].every(key => binding[key] === run[key]))) fail('CONTEXT_UNBOUND', 'Reader source is not bound to this run', 403);
      const key = `${run.runId}:${sourceId}`;
      let session = readers.get(key);
      if (!session) {
        session = { id: randomUUID(), parts: partitionText(entry.text, [{ startOffset: 0, endOffset: entry.text.length }]),
          next: 0, pending: null, busy: false, sourceId, owner };
        readers.set(key, session);
      }
      if (session.owner !== owner || session.busy || session.pending || session.next >= session.parts.length) fail('READER_SESSION_MISMATCH', 'No available bounded Reader continuation', 409);
      session.busy = true;
      return { fixtureOnly: true, synthetic: true, adapterExecutionVerified: false, phase: 'preparing',
        sourceId, sourceHash: entry.manifest.hash, readerSessionId: session.id,
        nextPartition: session.next, totalPartitions: session.parts.length };
    },
    processReader(sourceId, run, owner) {
      const entry = find(sourceId, owner), session = readers.get(`${run.runId}:${sourceId}`);
      if (!session || session.owner !== owner || !session.busy || session.pending) fail('READER_SESSION_MISMATCH', 'No running synthetic Reader partition', 409);
      const range = session.parts[session.next];
      const inputText = JSON.stringify({ fixtureOnly: true, synthetic: true, sourceId, sourceHash: entry.manifest.hash,
        range, sourceText: entry.text.slice(range.startOffset, range.endOffset) });
      const inputPayload = { text: inputText, hash: fingerprintQaBytes(inputText).sha256 };
      (stats.readerProcessed ||= []).push({ sourceId, readerSessionId: session.id, runId: run.runId,
        fixtureOnly: true, adapterExecutionVerified: false, inputPayload });
      session.next++;
      session.busy = false;
      const coverage = { scope: 'capture', sourceId, complete: session.next === session.parts.length,
        sourceTruncated: false, reviewedPartitions: session.next, totalPartitions: session.parts.length,
        continuation: session.next < session.parts.length ? { readerSessionId: session.id, nextPartition: session.next } : null };
      const value = { fixtureOnly: true, synthetic: true, adapterExecutionVerified: false, tool: 'egdesk_read_source',
        sourceId, snapshotId: sourceId, sourceHash: entry.manifest.hash, version: entry.manifest.version, mode: 'reader',
        summary: { text: `Synthetic QA Reader: ${session.next}/${session.parts.length} partitions processed; no model invoked.`,
          structure: [{ label: 'QA coverage only', text: 'Not a real model summary or whole-source quotation.' }] },
        selectedSpans: [{ startOffset: 0, endOffset: Math.min(80, entry.text.length), quote: entry.text.slice(0, 80) }],
        coverage, omissionPolicy: { type: 'reader-summary', fixtureOnly: true },
        reader: { sessionId: session.id, revision: session.next } };
      const text = JSON.stringify(value);
      session.pending = { role: 'agent_input', packetId: randomUUID(), mime: 'application/json',
        hash: fingerprintQaBytes(text).sha256, text, mode: 'qa-fixture-claude-reader', coverage,
        deliveryStatus: 'prepared', binding: { conversationId: run.conversationId, runId: run.runId, answerId: run.answerId } };
      return copy({ readerSessionId: session.id, sourceId, packetId: session.pending.packetId, coverage,
        fixtureOnly: true, synthetic: true, adapterExecutionVerified: false, deliveryStatus: 'prepared' });
    },
    deliverReader(sourceId, run, owner) {
      const entry = find(sourceId, owner), session = readers.get(`${run.runId}:${sourceId}`);
      if (!session || session.owner !== owner || !session.pending || session.busy) fail('READER_SESSION_MISMATCH', 'No prepared synthetic packet', 409);
      const packet = { ...session.pending, deliveryStatus: 'sent-to-app-server' };
      session.pending = null;
      entry.packets.push(packet);
      stats.deliveries.push({ sourceId, toolName: 'egdesk_read_source', fixtureOnly: true, packet: copy(packet) });
      return copy(packet);
    },
    abandonReader(sourceId, run, owner) {
      const session = readers.get(`${run.runId}:${sourceId}`);
      if (!session || session.owner !== owner) return;
      session.pending = null;
      session.busy = false;
      readers.delete(`${run.runId}:${sourceId}`);
    },
    deliver(sourceId, run, owner, { directOnly = false } = {}) {
      const entry = find(sourceId, owner);
      if (!entry.bindings.some(binding => ['conversationId', 'runId', 'answerId'].every(key => binding[key] === run[key]))) fail('CONTEXT_UNBOUND', 'Fixture source is not bound to this run', 403);
      if (directOnly) directEntries([sourceId], owner, run.clientThreadId);
      const lines = entry.text.split('\n');
      const count = directOnly ? lines.length : Math.min(40, lines.length);
      const coverage = { sourceId, range: { startLine: 1, endLine: count }, totalLines: lines.length, complete: count === lines.length,
        ...(directOnly ? { sourceTruncated: false } : {}) };
      // This is a named synthetic tool result, never native invocation evidence.
      const toolText = JSON.stringify({ fixtureOnly: true, tool: 'egdesk_read_source', sourceId,
        ...(directOnly ? { snapshotId: sourceId, sourceHash: entry.manifest.hash, version: entry.manifest.version } : {}),
        text: lines.slice(0, count).join('\n'), coverage });
      const packet = { role: 'agent_input', packetId: randomUUID(), mime: 'application/json',
        hash: fingerprintQaBytes(toolText).sha256, text: toolText, mode: directOnly ? 'qa-fixture-claude-direct-read' : 'qa-fixture-source-read', coverage,
        deliveryStatus: 'sent-to-app-server', binding: { conversationId: run.conversationId, runId: run.runId, answerId: run.answerId } };
      entry.packets.push(packet);
      stats.deliveries.push({ sourceId, toolName: 'egdesk_read_source', fixtureOnly: true, packet: copy(packet) });
      return copy(packet);
    },
    inspect(sourceId, { startLine = 1, endLine, packetId } = {}, owner, clientThreadId = null, conversationId = null) {
      const entry = find(sourceId, owner), lines = entry.text.split('\n');
      // Read authority and memory tracking are independent. An unsent legacy
      // capture is readable by its original client even in an existing room;
      // it still has no status row or delivery. Bound/seeded sources stay exact.
      if (clientThreadId && (conversationId && entry.bindings.length
        ? !entry.bindings.some(b => b.conversationId === conversationId && b.clientThreadId === clientThreadId)
        : entry.manifest.clientThreadId !== clientThreadId)) fail('CONTEXT_THREAD_MISMATCH', 'Capture belongs to another fixture thread', 403);
      if (conversationId && entry.bindings.length && !entry.bindings.some(binding => binding.conversationId === conversationId)) {
        fail('CONTEXT_THREAD_MISMATCH', 'Capture belongs to another native conversation', 403);
      }
      const end = endLine ?? Math.min(lines.length, startLine + 199);
      if (!Number.isInteger(startLine) || !Number.isInteger(end) || startLine < 1 || end < startLine
          || end > lines.length || end - startLine >= 500) fail('INVALID_RANGE', 'Inspect at most 500 stored lines');
      const text = lines.slice(startLine - 1, end).join('\n');
      const packets = entry.packets.filter(item => !conversationId || item.binding.conversationId === conversationId);
      const packet = packetId ? packets.find(item => item.packetId === packetId) : packets.at(-1);
      if (packetId && !packet) fail('PACKET_NOT_FOUND', 'Unknown stored fixture packet', 404);
      stats.inspectorReads.push({ sourceId, startLine, endLine: end, packetId: packetId || null });
      if (entry.store) return entry.store.inspect(owner, sourceId, { startLine, endLine: end, ...(packet ? { packetId: packet.packetId } : {}) });
      return copy({ capture: entry.manifest, source: { role: 'source', mime: entry.manifest.shape.mime,
        hash: entry.manifest.hash, rangeHash: fingerprintQaBytes(text).sha256, text,
        range: { startLine, endLine: end, totalLines: lines.length }, nextLine: end < lines.length ? end + 1 : null },
      delivered: packet || null, bindings: entry.bindings.map(({ bindingId, conversationId, runId, answerId }) => ({ bindingId, conversationId, runId, answerId })) });
    },
  };
}

// Opt-in, pre-Firefox setup only. All capture/blob/binding/packet/receipt and
// Chat SQLite writes go through the existing stores. This is synthetic history,
// never evidence that a provider received a turn. Runtime counters stay zero.
export async function seedQaSourceChangeScene(profile, context) {
  const fixture = assertQaFixtureManifest(profile);
  if (fs.lstatSync(path.join(profile, 'prefs.js'), { throwIfNoEntry: false })) fail('QA_SEED_NOT_FRESH', 'Seed requires a prefs-less, unopened owned profile', 409);
  const prefPath = path.join(profile, 'user.js');
  const prefStat = fs.lstatSync(prefPath);
  if (!prefStat.isFile() || prefStat.isSymbolicLink()) fail('QA_SEED_NOT_FRESH', 'Owned regular user.js required', 409);
  const prefs = fs.readFileSync(prefPath, 'utf8');
  if (/egdesk\.(deskSession|surfaceLifecycle)\.v1/.test(prefs)) fail('QA_SEED_NOT_FRESH', 'Existing scene preferences cannot be overwritten', 409);
  const dataDir = path.join(fixture.root, 'source-change-seed');
  // Atomic directory creation is also the restart guard. Even partial setup
  // is never replayed or silently repaired over an existing owned scene.
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const [{ ImmutableContextStore }, { openChatStore }, { CodexChatRuntime }, { capturedInputReference }] = await Promise.all([
    import('../helper/egdesk-context-store.mjs'), import('../helper/egdesk-chat-store.mjs'),
    import('../helper/codex-chat-runtime.mjs'), import('../overlay/resources/EGDeskInputContext.sys.mjs'),
  ]);
  const owner = 'a', engine = { engineId: 'codex', engineProfileId: 'codex-default' };
  const account = { variant: owner, email: 'qa-account-a@egdesk.invalid', key: 'codex:chatgpt:qa-account-a@egdesk.invalid' };
  const store = new ImmutableContextStore({ dataDir, allowedRoots: [fixture.root] });
  const chatStore = openChatStore({ dataDir, ownerScope: 'qa-source-change-owned-profile' });
  try {
    const forbidden = () => fail('QA_PROVIDER_FORBIDDEN', 'Seed history cannot invoke an engine', 403);
    const chat = new CodexChatRuntime({ store: chatStore, requireStore: true, getOwnerKey: () => owner, request: forbidden, respond: forbidden });
    const identities = [], threads = [];
    const now = Date.now();
    for (const kind of ['file', 'browser']) {
      const clientThreadId = `qa-ctx04-room-${randomUUID()}`, conversationId = `qa-ctx04-conversation-${randomUUID()}`;
      const runId = `qa-ctx04-run-${randomUUID()}`, answerId = `${conversationId}/${runId}`;
      const route = { ...engine, clientThreadId, conversationId }, run = { ...route, runId, answerId };
      const title = kind === 'file' ? 'CTX04 · 보관 파일' : 'CTX04 · 보관 페이지';
      const selectionId = `qa-ctx04-selection-${randomUUID()}`, viewId = `qa-ctx04-view-${randomUUID()}`;
      const text = Array.from({ length: 12 }, (_, i) => `CTX04 synthetic ${kind} original line ${i + 1}`).join('\n');
      let sourceRef;
      if (kind === 'file') {
        const original = path.join(dataDir, 'original.txt');
        fs.writeFileSync(original, text, { flag: 'wx', mode: 0o600 });
        sourceRef = { path: original };
      } else sourceRef = { viewId, url: 'https://example.invalid/ctx04' };
      const attachment = { id: selectionId, kind, label: title, sourceRef, capturedAt: now,
        captureScope: { type: kind === 'file' ? 'file' : 'document-text' },
        ...(kind === 'browser' ? { content: { mime: 'text/plain', text, truncated: false } } : {}) };
      const [capture] = await store.captureAttachments(owner, { clientThreadId, attachments: [attachment] }, { engine });
      const storedBinding = await store.bind(owner, run, [capture.sourceId], { read: true }, null, undefined, engine);
      const binding = { bindingId: storedBinding.bindingId, ...run };
      const coverage = { sourceId: capture.sourceId, range: { startLine: 1, endLine: 12 }, totalLines: 12, complete: true };
      const packetValue = { fixtureOnly: true, setupOnly: true, synthetic: true, tool: 'egdesk_read_source',
        sourceId: capture.sourceId, snapshotId: capture.snapshotId, sourceHash: capture.hash, text, coverage };
      const deliveryText = JSON.stringify(packetValue), deliveryHash = fingerprintQaBytes(deliveryText).sha256;
      const packetId = await store.putRecord(owner, 'packets', { setupOnly: true, synthetic: true,
        packet: { ...packetValue, mode: 'qa-source-change-seed' }, deliveryText, deliveryHash,
        binding: { conversationId, runId, answerId } });
      await store.putRecord(owner, 'deliveries', { setupOnly: true, synthetic: true, sourceId: capture.sourceId,
        packetId, deliveryStatus: 'sent-to-app-server', sentAt: now, providerInvoked: false });
      const inspected = await store.inspect(owner, capture.sourceId, { packetId });
      const packet = inspected.delivered;
      context.registerStored({ owner, manifest: capture, text, binding, packet, store });
      const reference = capturedInputReference(attachment, capture, route);
      const requestId = `qa-ctx04-request-${randomUUID()}`;
      const messages = [
        { id: randomUUID(), role: 'user', status: 'completed', text: 'CTX04 초기 보관 입력 · 합성 시험 기록',
          ...run, requestId, createdAt: now, inputReferences: [reference] },
        { id: randomUUID(), role: 'assistant', status: 'completed', text: '원본과 전달 내용을 보관한 합성 기록입니다. 실제 모델 호출은 없었습니다.',
          ...run, requestId, createdAt: now, contextCaptures: [capture], contextPackets: [packet] },
      ];
      // Synthetic native history follows CodexChatRuntime's id/messageId
      // pair. Keep the existing IDs; id alone is not a native message binding.
      for (const message of messages) message.messageId = message.id;
      const checkpoint = { ...run, requestId, status: 'completed', createdAt: now, messages,
        engine: { id: 'codex', engineProfileId: 'codex-default' },
        activities: [], artifacts: [], pendingApprovals: [], pendingUserInputs: [], subAgents: [],
        context: { captures: [capture], packets: [packet], briefings: [] }, truncated: false, historyComplete: true };
      chatStore.importConversationCopy({ clientThreadId, importId: `qa-source-change:${clientThreadId}`, title, createdAt: now,
        snapshot: { protocolVersion: 2, conversationId, runs: [checkpoint], truncated: false, historyComplete: true } });
      const saved = chatStore.getConversation(clientThreadId);
      threads.push({ id: clientThreadId, clientBindingId: clientThreadId, conversationId, ...engine, type: 'dm', title,
        subtitle: '합성 보관 입력 · 실제 전송 없음', profileEnabled: false, agentProfileId: null,
        bindingAccountKey: account.key, bindingState: 'verified', localConversationId: saved.localConversationId,
        createdAt: now, updatedAt: now, inputSources: [], briefingInputs: [], messages: [] });
      identities.push({ ...run, title, sources: [{ selectionId, sourceId: capture.sourceId, snapshotId: capture.snapshotId,
        kind, ...(kind === 'file' ? { path: sourceRef.path } : { viewId }), packetId, captureHash: capture.hash, payloadHash: packet.hash }] });
    }
    const chatCardId = `qa-ctx04-chat-${randomUUID()}`, agendaId = `qa-ctx04-desk-${randomUUID()}`;
    const initialState = { surfaceMode: 'desk', activeThreadId: threads[0].id, chatCardId, entryBypassed: true };
    const desk = { version: 1, savedAt: now, desk: { pan: { x: 0, y: 0 }, zoom: 1, activeAgendaId: agendaId, activeCardId: chatCardId },
      agenda: { id: agendaId, title: 'CTX04', memberCardIds: [chatCardId], contextBindings: [] },
      // SOURCE_CHANGE_SEED-only QA placement, not a product collision fix or
      // window resize: reserve chrome at both 1280x800 and observed 1366x768.
      cards: [{ id: chatCardId, type: 'chat', geometry: { x: 160, y: 80, width: 1000, height: 620, zIndex: 1 } }], shapes: [],
      surface: { mode: 'desk', browserCardId: null, initialBrowserFocus: false, recoveryBackupKey: null, recoveryAcknowledged: false },
      boardProjections: { projections: {}, activeProjectionId: null },
      chat: { threads, activeThreadId: threads[0].id, codexAccountKey: account.key, unobservedPreviousRun: false,
        threadDrafts: {}, hudView: 'conversation', recentEngineId: 'codex', localHistoryBackupKey: null } };
    const prefLine = (key, value) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(JSON.stringify(value))});\n`;
    fs.appendFileSync(prefPath, '\n' + prefLine('egdesk.deskSession.v1', desk)
      + prefLine('egdesk.surfaceLifecycle.v1', { version: 1, mode: 'desk', browserCardId: null }));
    const histories = identities.map(row => chat.getLocalHistory({ clientThreadId: row.clientThreadId }));
    const metadata = { version: 1, setupOnly: true, synthetic: true, ready: true, account, initialState, identities,
      counts: { seed: { conversations: chatStore.listConversations().threads.length,
        captures: (await store.listRecords(owner, 'sources')).length, bindings: (await store.listRecords(owner, 'bindings')).length,
        packets: (await store.listRecords(owner, 'packets')).length, deliveryRecords: (await store.listRecords(owner, 'deliveries')).length,
        historyRuns: histories.reduce((sum, h) => sum + h.runs.length, 0), historyMessages: histories.reduce((sum, h) => sum + h.messages.length, 0) },
        runtimeAtSetup: { captureBatches: 0, fileCaptureOperations: 0, sends: 0, deliveries: 0 } } };
    return { metadata, identities: identities.map(row => ({ ...row, fixtureOwner: owner })),
      history: chat, snapshot(conversationId) {
        const row = identities.find(r => r.conversationId === conversationId);
        if (!row) return null;
        return { protocolVersion: 2, conversationId, engineId: 'codex', connection: 'ready',
          runs: chat.getLocalHistory({ clientThreadId: row.clientThreadId }).runs, truncated: false, historyComplete: true };
      }, dispose() { chatStore.close(); } };
  } catch (error) { chatStore.close(); throw error; }
}
