// u1: the same turn order and the same U9 on the CLAUDE engine (the shared send path; Claude's own tool connection is lane L5's and is not touched here). Real Claude adapter with a fake
// transport, real runtime, scripted Decision model behind the gated client. No CLI, no login, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { modeGatedClient, TURN_STAGES } from './egdesk-upper-bundle.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
function claudeWorld(t, { mode = 'on', draftCheck = null, eligible = true } = {}) {
  const transports = [], fetched = []
  const claude = createClaudeEngineAdapter({
    snapshot: () => ({ installed: true, version: '2.1.300', versionStatus: 'untested', auth: { status: 'signedIn', method: 'claudeai', account: 'owner@example.com', label: 'Claude Max' } }),
    env: {}, defaultCwd: '/work/claude-upper', residentLimit: 2, resolveExecutable: () => '/fake/claude', setTimer: () => ({}), clearTimer: () => {},
    createTransport: options => {
      const transport = { options, sent: [], async start() {}, sendUserMessage(content) { this.sent.push(content) }, respondControl() { return true }, info: () => ({ init: { billsApiKey: false } }), async interrupt() {},
        async close() { options.onExit() }, message(message) { options.onMessage(message) }, control(requestId, request) { return options.controlHandlers[request.subtype](request, { requestId }) } }
      transports.push(transport); return transport
    },
  })
  const codex = createCodexEngineAdapter({ request: async () => { throw new Error('no Codex call') }, respond: () => true })
  const decision = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0u1c', recipientForKey: () => 'a'.repeat(64),
    fetchImpl: async (url, init) => { const body = JSON.parse(init.body); fetched.push(body); return Response.json({ answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: 0.03 })) }) } })
  const chat = new CodexChatRuntime({ engines: [codex, claude], emit: () => {}, verifyFile: async () => null,
    decisionContext: { mode: () => mode, configured: () => true, client: modeGatedClient(decision, { mode: () => mode, configured: () => true }), // the bridge's draftCheck has no `eligible`: the held check then applies to Agent-room direct sends only (a plain chat thread is not eligible); the test makes the thread eligible to follow the shared path
      ...(draftCheck ? { draftCheck: { mode: () => draftCheck, ...(eligible ? { eligible: () => true } : {}) } } : {}) } })
  const unsubscribe = claude.subscribe({ notification: (_, message) => chat.handleNotification(message), serverRequest: (_, message) => chat.handleServerRequest(message), connection: (id, state) => chat.setConnection(id, state.ready, state) })
  claude.syncStatus()
  const drain = async () => { await chat.queue; await tick(); await chat.queue }
  t.after(async () => { unsubscribe(); await claude.dispose(); await drain() })
  return { chat, transports, fetched, drain }
}
async function claudeTurn(w, text = '완료했습니다.') {
  const requestId = `req-${Math.random()}`
  await w.chat.send({ message: 'Test message', engineId: 'claude', clientThreadId: 'ui-claude', requestId })
  const transport = w.transports[0], session = transport.options.sessionId || transport.options.resume
  transport.message({ type: 'assistant', session_id: session, message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text }] } })
  transport.message({ type: 'result', subtype: 'success', is_error: false, session_id: session })
  await w.drain()
  return requestId
}

test('Claude engine: the turn order memory -> action -> engine is the same shared path, and with the held answer check on the check follows', async t => {
  const w = claudeWorld(t, { draftCheck: 'on' }), requestId = await claudeTurn(w)
  assert.deepEqual(w.chat.turnStagesFor(requestId).map(s => s.stage), [...TURN_STAGES])
})

test('Claude engine without the check: memory -> action -> engine, and with the Decision mode 끔 the check feature sends nothing to the Decision model', async t => {
  const plain = claudeWorld(t), id1 = await claudeTurn(plain)
  assert.deepEqual(plain.chat.turnStagesFor(id1).map(s => s.stage), ['memory', 'action', 'engine'])
  const off = claudeWorld(t, { mode: 'off', draftCheck: 'on' }), id2 = await claudeTurn(off)
  assert.deepEqual(off.fetched, [], 'mode 끔: no request left for the Decision model')
  assert.ok(off.chat.turnStagesFor(id2).some(s => s.stage === 'engine'))
})

test('a Claude chat thread OUTSIDE the harness (no EGDESK_CLAUDE_HARNESS) with the bridge\'s draft check configuration (no `eligible`) is not held and checked: only Agent-room direct sends are (u4: under the harness a plain thread is too, see egdesk-claude-turn-checks.test.mjs); the order is then memory -> action -> engine', async t => {
  const w = claudeWorld(t, { draftCheck: 'on', eligible: false }), requestId = await claudeTurn(w)
  assert.deepEqual(w.chat.turnStagesFor(requestId).map(s => s.stage), ['memory', 'action', 'engine'])
  assert.deepEqual(w.fetched, [], 'no check ran, so no Decision request left')
})
