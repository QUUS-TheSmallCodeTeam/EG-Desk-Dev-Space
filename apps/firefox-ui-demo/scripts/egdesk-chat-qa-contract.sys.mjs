// Test-side protocol model. It never writes to, or replaces, the shipped bridge.
import fs from 'node:fs';
import path from 'node:path';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { isOwnedAndPrivate } from './egdesk-qa-platform.mjs';

const TERMINAL = new Set(['completed', 'interrupted', 'failed']);
const PERSONA_FIELDS = ['agentProfile', 'systemPrompt', 'toolMode'];

export function recoveryMarkerMatches(sourceRef, marker) {
  // Browser source normalization preserves schema scope/URI, not arbitrary IDs.
  return typeof marker === 'string' && marker.startsWith('qa-recovery-new-') &&
    sourceRef?.kind === 'browser-url' && sourceRef.scope === marker && sourceRef.uri === 'about:blank';
}

export function assertPlainRenderedMessage(nativeRaw, uiRaw, visibleInnerText) {
  if (typeof nativeRaw !== 'string' || uiRaw !== nativeRaw) throw new Error('UI raw message differs from the exact transport message');
  // Only line-ending convention and terminal layout breaks are normalized.
  // Internal lines, spaces, punctuation, order and marker characters remain exact.
  const visibleLines = text => String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '');
  if (visibleLines(visibleInnerText) !== visibleLines(nativeRaw)) {
    throw new Error('Rendered plain-text fixture differs from the full native message');
  }
  return true;
}

export function assertFreshAccountRoom(previous, current) {
  if (!current?.localThreadId || current.localThreadId === previous.localThreadId ||
      !current.wireClientThreadId || current.wireClientThreadId === previous.wireClientThreadId ||
      current.conversationId || current.messageCount !== 0 || current.bindingHeld || current.profileEnabled === true) {
    throw new Error('Explicit new account room must have a fresh empty local/wire identity and no retained native binding');
  }
  return true;
}

export function assertOrdinarySend(body) {
  if (!body || typeof body !== 'object' || typeof body.message !== 'string' || !body.message.trim()) {
    throw new Error('chat send needs a nonempty message');
  }
  if (body.profileEnabled !== true) {
    const leaked = PERSONA_FIELDS.filter((field) => Object.hasOwn(body, field));
    if (leaked.length) throw new Error(`ordinary Codex send includes persona fields: ${leaked.join(', ')}`);
  }
  return true;
}

function assertReferencedArtifactAtRoot(artifact, root, expectedPath = null) {
  if (!artifact || artifact.type !== 'file' || artifact.status !== 'available' ||
      artifact.relation !== 'referenced' || typeof artifact.id !== 'string' ||
      typeof artifact.sourceItemId !== 'string' || !artifact.sourceItemId ||
      typeof artifact.conversationId !== 'string' || typeof artifact.runId !== 'string' ||
      artifact.answerId !== `${artifact.conversationId}/${artifact.runId}` ||
      !artifact.verifiedAt || typeof artifact.target?.path !== 'string' ||
      !path.isAbsolute(artifact.target.path)) {
    throw new Error('artifact is not an explicit, verified file reference');
  }
  if (!root || !path.isAbsolute(root)) throw new Error('artifact verification needs an absolute test root');
  if (expectedPath && artifact.target.path !== expectedPath) throw new Error('artifact is not the manifest-bound QA file');
  const canonicalRoot = fs.realpathSync.native(root);
  const file = fs.realpathSync.native(artifact.target.path);
  if (file !== artifact.target.path || !file.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error('artifact escapes the dedicated test root or uses a symlink');
  }
  const info = fs.statSync(file);
  if (!info.isFile() || !isOwnedAndPrivate(file, info)) throw new Error('artifact is not a user-owned regular file');
  return file;
}

export function assertQaFixtureArtifact(profile, artifact) {
  const fixture = assertQaFixtureManifest(profile);
  return assertReferencedArtifactAtRoot(artifact, fixture.root, fixture.artifactPath);
}

export function assertRealTurnArtifact(profile, artifact) {
  const fixture = assertQaFixtureManifest(profile);
  if (!fixture.realTurnCwd) throw new Error('Bootstrap manifest has no dedicated real-turn cwd');
  return assertReferencedArtifactAtRoot(artifact, fixture.realTurnCwd);
}

export function assertNativeTerminalExit(receipt, sessionId) {
  if (receipt?.sessionId !== sessionId || receipt.status !== 'EXITED' || receipt.exited !== true ||
      receipt.exitConfirmed !== true || receipt.error || !['pty.onExit', 'process.exit'].includes(receipt.exitSource) ||
      !Number.isFinite(receipt.exitedAt)) {
    throw new Error('Terminal closure needs a native exit receipt; acknowledgements and unknown sessions are insufficient');
  }
  return true;
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required`);
  return value;
}

export class ChatProtocolProbe {
  #lastSeq = new Map();
  #runs = new Map();
  #requests = new Map();

  get runs() { return [...this.#runs.values()].map((run) => structuredClone(run)); }
  byRun(runId) { const run = this.#runs.get(runId); return run && structuredClone(run); }
  byThread(clientThreadId) { return this.runs.filter((run) => run.clientThreadId === clientThreadId); }

  ingest(envelope) {
    if (envelope?.type !== 'chat.event' || envelope.v !== 2 || envelope.provider !== 'codex') {
      throw new Error('not a v2 Codex chat event');
    }
    const streamId = requiredText(envelope.streamId, 'streamId');
    if (!Number.isSafeInteger(envelope.seq) || envelope.seq < 1) throw new Error('invalid event sequence');
    const last = this.#lastSeq.get(streamId) || 0;
    if (envelope.seq <= last) return { accepted: false, reason: 'duplicate-seq' };
    this.#lastSeq.set(streamId, envelope.seq);
    const runId = requiredText(envelope.runId, 'runId');
    const conversationId = requiredText(envelope.conversationId, 'conversationId');
    const answerId = requiredText(envelope.answerId, 'answerId');
    if (answerId !== `${conversationId}/${runId}`) throw new Error('answerId does not identify this run');
    const requestId = envelope.requestId || null;
    const clientThreadId = envelope.clientThreadId || null;
    let run = this.#runs.get(runId);
    if (!run) {
      run = { runId, conversationId, answerId, requestId, clientThreadId,
        status: 'pending', stopRequested: false, messages: {}, activities: {}, artifacts: [], pendingApprovals: [], error: null };
      this.#runs.set(runId, run);
    } else if (run.conversationId !== conversationId || run.answerId !== answerId ||
        (run.requestId && requestId && run.requestId !== requestId) ||
        (run.clientThreadId && clientThreadId && run.clientThreadId !== clientThreadId)) {
      throw new Error('cross-thread/run event correlation mismatch');
    }
    run.requestId ||= requestId;
    run.clientThreadId ||= clientThreadId;
    if (requestId) this.#requests.set(requestId, runId);
    const event = requiredText(envelope.event, 'event');
    const details = envelope.details || {};
    const messageId = details.messageId || envelope.itemId;
    const activityId = details.id || envelope.itemId;
    switch (event) {
      case 'run.started': run.status = 'running'; break;
      case 'run.stop_requested': run.stopRequested = true; break;
      case 'run.completed': {
        const status = details.status;
        if (!TERMINAL.has(status)) throw new Error('run.completed needs a terminal status');
        run.status = status;
        run.error = details.error || null;
        break;
      }
      case 'run.unavailable':
        run.status = 'failed';
        run.error = details.error || { code: 'RUNTIME_LOST' };
        break;
      case 'message.started':
        requiredText(messageId, 'messageId');
        run.messages[messageId] = { status: 'streaming', text: '' };
        break;
      case 'message.delta':
        requiredText(messageId, 'messageId');
        run.messages[messageId] ||= { status: 'streaming', text: '' };
        run.messages[messageId].text += String(details.delta || '');
        break;
      case 'message.completed':
        requiredText(messageId, 'messageId');
        run.messages[messageId] ||= { status: 'streaming', text: '' };
        if (typeof details.text === 'string') run.messages[messageId].text = details.text;
        run.messages[messageId].status = 'completed';
        break;
      case 'activity.started':
      case 'activity.updated':
      case 'activity.completed':
        requiredText(activityId, 'activity id');
        run.activities[activityId] = { ...run.activities[activityId], ...details };
        break;
      case 'approval.required':
        {
          const approval = details.approval || details;
          requiredText(approval.approvalId, 'approvalId');
          if (!run.pendingApprovals.some((item) => item.approvalId === approval.approvalId)) {
            run.pendingApprovals.push(structuredClone(approval));
          }
        }
        break;
      case 'approval.resolved':
        run.pendingApprovals = run.pendingApprovals.filter((item) => item.approvalId !== details.approvalId);
        break;
      case 'artifact.available':
        // Only an explicit structured event may add an artifact. Never parse
        // paths out of answer prose, command text, or activity detail.
        if (details.artifact) run.artifacts.push(details.artifact);
        break;
      case 'plan.updated':
      case 'summary.delta':
        // Summaries are public presentation data. Raw reasoning is not kept.
        break;
      default: throw new Error(`unexpected v2 chat event: ${event}`);
    }
    return { accepted: true, run: structuredClone(run) };
  }

  markApprovalReply(response) {
    const run = this.#runs.get(response?.runId);
    if (response?.accepted !== true || response.status !== 'replySent' || !run ||
        run.conversationId !== response.conversationId) throw new Error('Approval reply does not match this run');
    const approval = run.pendingApprovals.find((item) => item.approvalId === response.approvalId);
    if (!approval || approval.status !== 'pending') throw new Error('STALE_APPROVAL');
    approval.status = 'replySent';
    return structuredClone(run);
  }

  linkPost({ accepted, conversationId, requestId, runId, answerId }, { clientThreadId } = {}) {
    if (accepted !== true) throw new Error('POST was not accepted');
    const linkedRunId = this.#requests.get(requestId) || runId;
    if (linkedRunId !== runId) throw new Error('POST does not match early SSE request');
    const run = this.#runs.get(runId);
    if (!run || run.conversationId !== conversationId || run.answerId !== answerId ||
        (run.clientThreadId && clientThreadId && run.clientThreadId !== clientThreadId)) {
      throw new Error('POST response does not match early SSE run/thread');
    }
    run.clientThreadId ||= clientThreadId || null;
    return structuredClone(run);
  }
}
