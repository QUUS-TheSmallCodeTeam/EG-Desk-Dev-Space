// Explicit fixture transport data only. Never imports a native provider or
// application store. Inspector reads use these captured bytes, never live files.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { assertContextCaptureBatch, fingerprintQaBytes, observeQaFixtureFile } from './egdesk-context-qa-contract.mjs';
import { readAdmission } from '../helper/egdesk-smart-read.mjs'; // Pure admission math; never constructs a Reader.

const copy = value => JSON.parse(JSON.stringify(value));
const fail = (code, message, httpStatus = 400) => { throw Object.assign(new Error(message), { code, httpStatus }); };

export function createQaContextFixture(profile) {
  assertQaFixtureManifest(profile);
  const sources = new Map();
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
  const directEntries = (sourceIds, owner, clientThreadId) => {
    const entries = scoped(sourceIds, owner, clientThreadId);
    let deliveryDebt = 0;
    for (const entry of entries) {
      if (entry.manifest.truncated) fail('CONTEXT_CAPTURE_INCOMPLETE', 'Selected capture is truncated; no subset is substituted', 409);
      if (!entry.manifest.shape.readable) fail('UNSUPPORTED_SOURCE_FORMAT', 'Selected capture has no readable projection', 422);
      const admission = readAdmission(entry.text, entry.manifest.shape, { deliveryDebt }, entries.length);
      if (admission.mode !== 'direct') fail('CLAUDE_CONTEXT_READER_UNSUPPORTED', 'Claude Smart Read is temporarily unsupported; select a smaller complete source', 409);
      deliveryDebt += admission.estimatedTokens;
    }
    return entries;
  };
  return {
    stats,
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
    validateDirect(sourceIds, clientThreadId, owner) {
      return directEntries(sourceIds, owner, clientThreadId).map(entry => copy(entry.manifest));
    },
    bind(sourceIds, run, owner, { directOnly = false } = {}) {
      const entries = directOnly ? directEntries(sourceIds, owner, run.clientThreadId) : scoped(sourceIds, owner);
      if (directOnly && entries.some(entry => entry.bindings.some(binding => binding.conversationId !== run.conversationId))) {
        fail('CONTEXT_THREAD_MISMATCH', 'Capture is already bound to another native conversation', 403);
      }
      const binding = { bindingId: randomUUID(), conversationId: run.conversationId, runId: run.runId, answerId: run.answerId };
      for (const entry of entries) entry.bindings.push(copy(binding));
      return entries.map(entry => copy(entry.manifest));
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
      if (clientThreadId && entry.manifest.clientThreadId !== clientThreadId) fail('CONTEXT_THREAD_MISMATCH', 'Capture belongs to another fixture thread', 403);
      if (conversationId && entry.bindings.length && !entry.bindings.some(binding => binding.conversationId === conversationId)) {
        fail('CONTEXT_THREAD_MISMATCH', 'Capture belongs to another native conversation', 403);
      }
      const end = endLine ?? Math.min(lines.length, startLine + 199);
      if (!Number.isInteger(startLine) || !Number.isInteger(end) || startLine < 1 || end < startLine
          || end > lines.length || end - startLine >= 500) fail('INVALID_RANGE', 'Inspect at most 500 stored lines');
      const text = lines.slice(startLine - 1, end).join('\n');
      const packet = packetId ? entry.packets.find(item => item.packetId === packetId) : entry.packets.at(-1);
      if (packetId && !packet) fail('PACKET_NOT_FOUND', 'Unknown stored fixture packet', 404);
      stats.inspectorReads.push({ sourceId, startLine, endLine: end, packetId: packetId || null });
      return copy({ capture: entry.manifest, source: { role: 'source', mime: entry.manifest.shape.mime,
        hash: entry.manifest.hash, rangeHash: fingerprintQaBytes(text).sha256, text,
        range: { startLine, endLine: end, totalLines: lines.length }, nextLine: end < lines.length ? end + 1 : null },
      delivered: packet || null, bindings: entry.bindings });
    },
  };
}
