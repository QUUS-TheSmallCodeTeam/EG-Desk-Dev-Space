// Opt-in QA only. The only synthetic boundary is the bounded provider RPC and
// its tool/answer notifications. Acceptance, SQLite, ownership, capture and
// Briefing comments use the same production modules as the bridge.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { observeQaFixtureFile } from './egdesk-context-qa-contract.mjs';
import { CodexChatRuntime } from '../helper/codex-chat-runtime.mjs';
import { createChatHttpHandler, guardBridgeRequest, readJsonBody, sendJson } from '../helper/codex-bridge-http.mjs';
import { openChatStore } from '../helper/egdesk-chat-store.mjs';
import { ImmutableContextStore } from '../helper/egdesk-context-store.mjs';
import { ContextRuntime } from '../helper/egdesk-context-runtime.mjs';
import { createContextHttpHandler } from '../helper/egdesk-context-http.mjs';

const fail = (code, message, httpStatus = 403) => Object.assign(new Error(message), { code, httpStatus, definite: true });
export function createDayOneContextFixture({ profile, port, token, owner, broadcast }) {
  const { root } = assertQaFixtureManifest(profile);
  const dir = fs.mkdtempSync(path.join(root, 'dayone-runtime-'));
  const chatStore = openChatStore({ dataDir: dir, ownerScope: 'qa-dayone-runtime' });
  const store = new ImmutableContextStore({ dataDir: dir, allowedRoots: [root] });
  const captures = [], sends = [], calls = [], responses = new Map();
  const conversationId = `qa-dayone-conversation-${randomUUID()}`, runId = `qa-dayone-run-${randomUUID()}`;
  let accepted, phase = 'new', busy = false, commentPosts = 0, commentGets = 0, closed = false;
  const contexts = new ContextRuntime({ store, getOwnerKey: owner, getAuthority: hints => chat.contextAuthority(hints) });
  const chat = new CodexChatRuntime({ store: chatStore, requireStore: true, contexts, getOwnerKey: owner,
    resolveProjectWorkspace: async () => null, emit: broadcast, respond: (id, result, error) => responses.set(id, { result, error }),
    request: async (method, params) => {
      if (closed || !owner()) throw fail('QA_FIXTURE_CLOSED', 'No fixture account is ready');
      if (method === 'thread/start' && calls.length === 0) {
        calls.push(method); return { thread: { id: conversationId }, cwd: root, model: 'qa-dayone' };
      }
      if (method === 'turn/start' && calls.length === 1 && params.threadId === conversationId) {
        calls.push(method); return { turn: { id: runId, status: 'inProgress', items: [] } };
      }
      // Normal Firefox reattach can query this exact conversation; never start a turn.
      if (['thread/read', 'thread/resume'].includes(method) && params.threadId === conversationId && accepted) {
        return { thread: { id: conversationId, turns: [{ id: runId, status: phase === 'completed' ? 'completed' : 'inProgress', items: [] }] }, cwd: root };
      }
      throw fail('QA_RPC_REFUSED', 'Only one bounded synthetic provider turn is allowed');
    },
  });
  chat.setConnection(true);
  const chatHttp = createChatHttpHandler(chat, () => { if (!owner()) throw fail('IDENTITY_REQUIRED', 'Fixture signed out'); });
  const contextHttp = createContextHttpHandler(contexts, () => { if (!owner()) throw fail('IDENTITY_REQUIRED', 'Fixture signed out'); }, { port });
  async function tool(name, args, id) {
    await chat.handleServerRequest({ id, method: 'item/tool/call', params: { threadId: conversationId, turnId: runId, callId: id, tool: name, arguments: args } });
    await contexts.calls.get(`${accepted.answerId}/${id}`);
    const response = responses.get(id);
    if (response?.result?.success !== true || response.error) throw fail('QA_TOOL_REFUSED', `${name} did not complete: ${JSON.stringify(response?.result || response?.error || null).slice(0, 400)}`, 409);
  }
  async function complete() {
    const item = { id: 'qa-dayone-answer', type: 'agentMessage', phase: 'final_answer', text: 'QA fixture answer: captured inputs remain separate from the changed live original.' };
    await chat.handleNotification({ method: 'item/completed', params: { threadId: conversationId, turnId: runId, item } });
    await chat.handleNotification({ method: 'turn/completed', params: { threadId: conversationId, turn: { id: runId, status: 'completed', items: [item] } } });
    await chat.queue;
  }
  const snapshot = () => {
    const state = chat.snapshot(conversationId);
    const runs = state.runs.map(run => ({ ...run, status: run.status, contextCaptures: run.context?.captures || [],
      contextPackets: run.context?.packets || [], briefing: run.context?.briefings?.at(-1) || null }));
    return { streamId: state.streamId, phase, sends: structuredClone(sends), runs, captureBatches: captures.length,
      commentPosts, commentGets, providerRpc: [...calls], externalProviderCalls: 0 };
  };
  async function handle(req, res, url) {
    const route = url.pathname;
    const comments = /^\/context\/(?:briefings\/[\da-f-]{36}\/comments|briefing-comments\/[\da-f-]{36}(?:\/(?:edit|delete))?)$/i.test(route);
    const capture = route === '/context/captures' || /^\/context\/(?:captures|packets|briefings)\/[\da-f-]{36}$/i.test(route);
    const contextRoute = capture || comments || ['/context/sources', '/context/capabilities'].includes(route);
    const chatRoute = ['/chat/send','/chat/state','/chat/resume','/chat/history','/chat/history/threads'].includes(route);
    const release = route === '/__qa/context-release';
    if (!contextRoute && !chatRoute && !release) return false;
    if (!guardBridgeRequest(req, port)) throw fail('QA_LOOPBACK_REQUIRED', 'Trusted loopback route required');
    if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return true; }
    if (closed) throw fail('QA_FIXTURE_CLOSED', 'Fixture closed', 503);
    if (comments) {
      if (req.method === 'GET') commentGets++;
      if (req.method === 'POST') commentPosts++;
    }
    if (contextRoute && !(route === '/context/captures' && req.method === 'POST')) return contextHttp(req, res, url);
    if (route === '/context/captures' && req.method === 'POST') {
      const body = await readJsonBody(req, { maxBytes: 2 * 1024 * 1024 });
      if (captures.length >= 8 || !Array.isArray(body.attachments) || body.attachments.length < 1 || body.attachments.length > 3) throw fail('QA_CAPTURE_LIMIT', 'Bounded fixture attachments required', 409);
      for (const item of body.attachments) {
        if (item.kind !== 'file' || item.managedFileView) throw fail('QA_FILE_REQUIRED', 'Only explicitly selected owned fixture files may be captured');
        observeQaFixtureFile(profile, item.sourceRef?.path);
      }
      const result = await contexts.capture(body, contexts.authority(body));
      captures.push({ owner: owner(), clientThreadId: body.clientThreadId, ids: result.captures.map(entry => entry.sourceId) });
      sendJson(res, 201, result); return true;
    }
    if (release) {
      if (req.method !== 'POST' || req.headers['x-egdesk-qa-token'] !== token) throw fail('QA_TOKEN_REQUIRED', 'Fixture control token required');
      const body = await readJsonBody(req);
      if (!accepted || busy || body.runId !== accepted.runId || !['read','briefing'].includes(body.phase)) throw fail('QA_PHASE_REFUSED', 'Exact accepted run and phase required', 409);
      const sources = sends[0].sourceIds;
      busy = true;
      try {
        if (body.phase === 'read' && phase === 'accepted') {
          for (const [i, snapshotId] of sources.entries()) await tool('egdesk_read_source', { snapshotId, intent: 'Read the selected fixture', range: { startLine: 1, endLine: 20 } }, `read-${i}`);
          await tool('egdesk_publish_briefing', { title: 'QA captured-input briefing', steps: sources.map((sourceId, i) => ({ id: `step-${i + 1}`, text: `Captured input ${i + 1}; original version`, target: { sourceId, range: { startLine: 1, endLine: 20 } }, fallback: 'Use only the original capture.' })) }, 'briefing');
          // The visible assistant answer is required by the production history guard.
          await complete(); phase = 'completed';
        } else if (body.phase !== 'briefing' || phase !== 'completed') throw fail('QA_PHASE_REFUSED', 'Fixture phase already consumed', 409);
        sendJson(res, 200, { fixtureOnly: true, phase }); return true;
      } finally { busy = false; }
    }
    if (route !== '/chat/send' || req.method !== 'POST') {
      if (route === '/chat/state' && url.searchParams.has('conversationId')) contexts.authority({ conversationId: url.searchParams.get('conversationId') });
      if (route === '/chat/state' && !url.searchParams.has('conversationId')) {
        const snapshot = chat.snapshot();
        sendJson(res, 200, { ...snapshot, runs: [], conversationId: null }); return true;
      }
      return chatHttp(req, res, url);
    }
    const body = await readJsonBody(req);
    if (!owner() || !/^EGDESK_QA_CONTEXT Day one:/.test(body.message || '') || !Array.isArray(body.contextSnapshotIds) || body.contextSnapshotIds.length !== 2
        || body.profileEnabled === true || body.engineId && body.engineId !== 'codex') throw fail('QA_SEND_REFUSED', 'Explicit one-turn Day One Codex fixture request required');
    if (!captures.some(batch => batch.owner === owner() && batch.clientThreadId === body.clientThreadId
        && batch.ids.length === body.contextSnapshotIds.length && new Set(body.contextSnapshotIds).size === batch.ids.length
        && body.contextSnapshotIds.every(id => batch.ids.includes(id)))) {
      throw fail('QA_CAPTURE_SCOPE_MISMATCH', 'Exact owned batch and local recipient required');
    }
    if (busy || (accepted && body.requestId !== accepted.requestId)) throw fail('QA_ONE_TURN_ONLY', 'No second fixture turn', 409);
    busy = true;
    try {
      const result = await chat.send({ ...body, cwd: root });
      if (!accepted && result.accepted && !result.duplicate) {
        accepted = result; phase = 'accepted';
        sends.push({ ...result, message: body.message, sourceIds: [...body.contextSnapshotIds], respondedAt: Date.now() });
      }
      sendJson(res, 202, result); return true;
    } finally { busy = false; }
  }
  return { handle, snapshot, dispose() { if (!closed) { closed = true; chatStore.close(); } } };
}
