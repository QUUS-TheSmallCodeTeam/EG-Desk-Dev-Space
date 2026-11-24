// Harness for the working-memory gate at the real tool-result boundary: the real chat runtime, context runtime and immutable store,
// a mock engine (the test plays the model: it calls tools and reads the replies), and stand-in EG-Desk tool providers.
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { normalizeEntry } from './egdesk-decision-calibration-log.mjs'
import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { ImmutableContextStore } from './egdesk-context-store.mjs'

export const OWNER = 'email:wm@example.com'

/**
 * A stand-in for an EG-Desk tool that returns text it read itself (no such product tool exists yet for terminal reads).
 * `outputs[name]` is what the next call of that tool returns: a string (plain text) or a ready native response.
 */
export function standInProvider(outputs, { declare = true } = {}) {
  const spec = name => ({ type: 'function', name, description: 'stand-in EG-Desk read tool', inputSchema: { type: 'object', properties: {}, additionalProperties: true } })
  return {
    providerId: 'egdesk-standin-read',
    specs: () => ['egdesk_terminal_read', 'egdesk_search_read', 'egdesk_page_read', 'egdesk_plain_tool'].map(spec),
    prepare: async () => ({ selected: true }), bindRun: async () => {}, cancelRun: () => {},
    ...(declare ? { workingMemory: { egdesk_terminal_read: { kind: 'build' }, egdesk_search_read: { kind: 'search' }, egdesk_page_read: { kind: 'page', jsonTextArray: ['snapshot', 'text'] } } } : {}),
    dispatch: (_run, event) => {
      const value = outputs[event.tool]
      return typeof value === 'string' ? { success: true, contentItems: [{ type: 'inputText', text: value }] } : value
    },
  }
}

export async function wiringHarness({ flag = null, decision = null, outputs = {}, declare = true, now = Date.now } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-wm-wiring-'))
  const cwd = path.join(dir, 'workspace'); await mkdir(cwd)
  let nativeSeq = 0
  const store = new ImmutableContextStore({ dataDir: path.join(dir, 'state'), allowedRoots: [cwd], now })
  const contexts = new ContextRuntime({ store, reader: null, getOwnerKey: () => OWNER, now })
  const replies = [], events = [], calls = [], records = []
  const calibrationLog = { record(raw) { const entry = normalizeEntry(raw); if (entry) records.push(entry); return entry ? 'id' : null } }
  const state = { flag, outputs }
  const provider = standInProvider(outputs, { declare })
  const chat = new CodexChatRuntime({
    contexts, toolProviders: [provider], respond: (id, result, error) => { replies.push({ id, result, error }) }, emit: event => events.push(event),
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: `thread-${++nativeSeq}` }, cwd, model: 'mock-model' }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd }
      if (method === 'turn/start') return { turn: { id: `turn-${nativeSeq}`, status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected native method ${method}`)
    },
    decisionContext: {
      mode: () => decision?.mode ?? 'off', configured: () => Boolean(decision?.client), client: decision?.client ?? null, calibrationLog,
      // Absent flag = the product default: the runtime never enters the gate.
      ...(flag === null ? {} : { workingMemory: { mode: () => state.flag } }),
    },
  })
  chat.setConnection(true)
  const capture = async (text = 'attached note', id = 'attachment') => (await contexts.capture({ clientThreadId: 'ui', attachments: [{ id, kind: 'browser', label: 'Selected page', sourceRef: { viewId: `view-${id}`, resourceId: `page-${id}`, url: 'https://example.com/page' },
    capturedAt: 10, captureScope: { type: 'dom-range', locator: '#main' }, content: { text, truncated: false } }] })).captures[0]
  /** Start a turn. withContext: the person attached a source and allowed reads, so this run has context tools and a binding. */
  const start = async ({ withContext = true, clientThreadId = 'ui', message = '결제 모듈 빌드 오류를 고쳐 줘 (src/checkout/payment.ts)' } = {}) => {
    const attached = withContext ? await capture() : null
    const run = await chat.send({ message, requestId: `req-${nativeSeq}-${replies.length}`, clientThreadId, cwd,
      ...(withContext ? { contextSnapshotIds: [attached.sourceId], contextCapabilities: { read: true, reader: false, publishBriefing: false } } : {}) })
    return { run, attached, live: chat.runs.get(`${run.conversationId}/${run.runId}`) }
  }
  /** The mock engine calls a tool and waits for the reply the engine would receive. */
  const tool = async (run, name, args = {}, id = `call-${replies.length}-${Math.random().toString(16).slice(2, 8)}`) => {
    await chat.handleServerRequest({ id, method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: id, tool: name, arguments: args } })
    await contexts.calls.get(`${run.answerId}/${id}`)
    // A provider result is delivered asynchronously (and a spill writes files first): wait for the reply itself, not for a number of ticks.
    for (const deadline = Date.now() + 15000; Date.now() < deadline && !replies.some(reply => reply.id === id);) await new Promise(resolve => setTimeout(resolve, 2))
    return replies.find(reply => reply.id === id)
  }
  /** The engine reports its context use after a model step, as a real engine does; reads are then admitted against measured use. */
  const reportUsage = (run, usedTokens = 30000, modelContextWindow = 200000) => chat.handleNotification({ method: 'thread/tokenUsage/updated',
    params: { threadId: run.conversationId, turnId: run.runId, tokenUsage: { modelContextWindow, last: { totalTokens: usedTokens } } } })
  return { dir, cwd, store, contexts, chat, provider, replies, events, calls, records, state, capture, start, tool, reportUsage, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

export const textOf = reply => reply?.result?.contentItems?.find(item => item.type === 'inputText')?.text ?? null
export const pointersIn = text => [...String(text).matchAll(/Re-read: egdesk_read_source (\{.*?\}\})/g)].map(match => JSON.parse(match[1]))
