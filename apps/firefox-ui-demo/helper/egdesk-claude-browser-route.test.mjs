// L8 u5 (U19): the real-window failure of u4. A Claude conversation granted a Card was refused BROWSER_TOOLS_UNAVAILABLE both in an old conversation (409, "predates Browser tools") and in a new one
// (503, "contract is not verified": the Browser provider judged Claude's turn by the CODEX slot's probe). REPLAY over the real runtime, chat store, own-tools wiring, Claude adapter, MCP bridge, Browser and
// page-tool providers and the bridge's own readiness function; only the Claude process (a scripted transport) and the page are fake. Nothing real runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { OWNER, pageWorld } from './egdesk-browser-live-runner.mjs'
import { createPageToolsProvider } from './egdesk-page-tools.mjs'
import { createOwnToolsWiring } from './egdesk-own-tools-wiring.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { browserSchemaReady, claudeBrowserLive } from './egdesk-claude-browser-route.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
const until = async (predicate, ms = 4000) => { const end = Date.now() + ms; while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); assert.ok(predicate(), 'condition not reached in time') }
const H = 'shop.example.test'
const PAGES = () => ({ '/home': { text: ['쇼핑몰'], elements: [{ ref: 'q', role: 'textbox', label: '상품 검색', tag: 'input', href: '', value: '' }] } })
const here = path.dirname(new URL(import.meta.url).pathname)
const bridge = fs.readFileSync(path.join(here, 'codex-bridge-server.mjs'), 'utf8')
const surface = fs.readFileSync(path.join(here, '..', 'overlay', 'JS', 'eg-desk-surface.uc.js'), 'utf8')

/**
 * world(t, { harness, pageTools, codexReady, oldReadiness }): the bridge's wiring in miniature. harness / pageTools: the two flags (EGDESK_CLAUDE_HARNESS, EGDESK_PAGE_TOOLS).
 * codexReady: the Codex slot's own answer (qaReady), false = no Codex app-server (the real-window case). oldReadiness: the Browser provider's readiness as u4 left it (the Codex slot's, for every engine).
 */
function world(t, { harness = true, pageTools = true, codexReady = false, oldReadiness = false } = {}) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-claude-route-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'project'); fs.mkdirSync(root); const dataDir = path.join(base, 'data'); fs.mkdirSync(dataDir)
  const transports = [], events = []
  let chat = null
  const claude = createClaudeEngineAdapter({
    snapshot: () => ({ installed: true, version: '2.1.328', versionStatus: 'untested', auth: { status: 'signedIn', method: 'apiKey', account: 'synthetic', label: 'Claude API' } }),
    env: {}, defaultCwd: base, resolveExecutable: () => '/fake/claude',
    createTransport: options => {
      const transport = {
        options, sent: [], replies: [], inited: false, closed: false,
        async start() {}, info: () => ({ init: { billsApiKey: true } }), async interrupt() {},
        respondControl(id, answer) { this.replies.push({ id, ...JSON.parse(JSON.stringify(answer)) }); return true },
        async close() { if (!this.closed) { this.closed = true; options.onExit?.() } },
        sendUserMessage(content) {
          this.sent.push(JSON.parse(JSON.stringify(content))); const sid = options.sessionId || options.resume
          setImmediate(async () => {
            if (!this.inited) {
              this.inited = true
              const bounded = options.bounded === true
              const tools = bounded ? (await options.controlHandlers.mcp_message({ subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, { requestId: `list-${this.sent.length}` })).write.response.response.mcp_response.result.tools.map(tool => `mcp__egdesk__${tool.name}`) : undefined
              options.onMessage({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-test', cwd: options.cwd, claude_code_version: '2.1.328', apiKeySource: 'ANTHROPIC_API_KEY',
                ...(bounded ? { permissionMode: 'dontAsk', tools, mcp_servers: [{ name: 'egdesk', status: 'connected' }], capabilities: [] } : {}) })
            }
            options.onMessage({ session_id: sid, type: 'assistant', parent_tool_use_id: null, message: { id: `m-${this.sent.length}`, role: 'assistant', content: [{ type: 'text', text: '네' }], usage: { input_tokens: 3, output_tokens: 2 } } })
            options.onMessage({ session_id: sid, type: 'result', subtype: 'success', is_error: false })
          })
        },
      }
      transports.push(transport)
      return transport
    },
  })
  const codex = createCodexEngineAdapter({ request: async method => { throw new Error(`the Codex engine is not used here: ${method}`) }, respond: () => false })
  const wiring = createOwnToolsWiring({ env: { EGDESK_OWN_TOOLS: 'on', ...(harness ? { EGDESK_CLAUDE_HARNESS: 'on' } : {}), PATH: '/usr/bin:/bin', HOME: '/home/synthetic' }, dataDir, spawn: () => { throw new Error('no command runs here') }, getChat: () => chat, home: '/home/synthetic', gitStatus: async () => '' })
  const pw = pageWorld('x', H, 'card', { pages: PAGES() }); pw.go('/home')
  const readiness = oldReadiness ? route => codexReady : browserSchemaReady({ claudeLive: () => chat.claudeBrowserLive() === true, claudeReady: () => claude.isReady() && claude.capabilities().has('boundedQa'), codexReady: () => codexReady })
  const browser = createCodexBrowserToolProvider({ transport: pw.transport, getOwnerKey: () => OWNER, schemaReady: readiness })
  const page = createPageToolsProvider({ mode: () => 'on', browser: { dispatch: (run, event) => browser.dispatch(run, event) }, ledger: wiring.ledger })
  const store = openChatStore({ dataDir: path.join(base, 'chat'), ownerScope: 'claude-route' }); t.after(() => store.close())
  chat = new CodexChatRuntime({ engines: [codex, claude], store, requireStore: true, getOwnerKey: () => OWNER, toolProviders: [browser, ...(pageTools ? [page] : []), ...wiring.toolProviders], ownTools: wiring.ownTools, verifyFile: async () => null, emit: event => events.push(event), emitLegacy: () => {} })
  const unsubscribe = claude.subscribe({ notification: (_, m) => chat.handleNotification(m), serverRequest: (_, m) => chat.handleServerRequest(m), connection: (id, s) => chat.setConnection(id, s.ready, s) })
  claude.syncStatus(); chat.setConnection('claude', true, {})
  const drain = async () => { await chat.queue; await tick(); await chat.queue }
  t.after(async () => { unsubscribe(); await claude.dispose(); await drain() })
  const selected = (threadId = 'ui-claude') => [{ id: 'source', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact', browserToolSelection: { token: `tok-${Math.random()}`, threadId },
    browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: OWNER, authorityEpoch: 1 }, sourceRef: { viewId: 'card', profileId: 'synthetic', accountId: '', uri: `https://${H}/home` } }]
  const send = (message, extra = {}) => chat.send({ message, engineId: 'claude', clientThreadId: 'ui-claude', requestId: `r-${Math.random()}`, browserTransportId: 'ui', ...extra })
  const browserSend = (message, extra = {}) => send(message, { executionPolicy: { mode: 'browserBounded' }, selectedSources: selected(), ...extra })
  const runOf = sent => chat.runs.get(`${sent.conversationId}/${sent.runId}`)
  const settled = async sent => { await until(() => ['completed', 'failed', 'interrupted'].includes(runOf(sent)?.status)); await drain(); return runOf(sent) }
  return { chat, claude, transports, events, root, send, browserSend, runOf, settled, drain, pw }
}
const refusal = async promise => { try { await promise; return null } catch (error) { return { code: error.code, status: error.httpStatus } } }

test('the 04:42 failure, reproduced: a NEW Claude conversation granted a Card is refused 503 when the Browser provider asks the Codex slot (no Codex app-server): the u4 readiness', async t => {
  const w = world(t, { oldReadiness: true })
  assert.deepEqual(await refusal(w.browserSend('이 페이지 제목 알려줘')), { code: 'BROWSER_TOOLS_UNAVAILABLE', status: 503 })
  assert.equal(w.transports.length, 0, 'no Claude process, no turn')
})

test('fixed: with the Claude browser capability live, a NEW Claude conversation granted a Card is judged by Claude\'s own readiness and runs bounded with EG-Desk\'s card tools, while the Codex slot is not ready', async t => {
  const w = world(t)
  assert.equal(w.chat.claudeBrowserLive(), true)
  const sent = await w.browserSend('이 페이지 제목 알려줘'); assert.equal(sent.accepted, true)
  const run = await w.settled(sent); assert.equal(run.status, 'completed')
  const [transport] = w.transports
  assert.deepEqual([transport.options.tools, transport.options.permissionMode, transport.options.bounded, transport.options.allowedTools], [[], 'dontAsk', true, ['mcp__egdesk']])
  const names = transport.options.controlHandlers.mcp_message({ subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }, { requestId: 'list' })
  const listed = (await names).write.response.response.mcp_response.result.tools.map(tool => tool.name)
  for (const name of ['egdesk_card_read', 'egdesk_card_press', 'egdesk_card_type', 'egdesk_card_open', 'egdesk_browser_observe']) assert.ok(listed.includes(name), name)
})

test('a conversation that STARTED with a Card keeps working: its second turn with a Card is accepted and runs bounded again (registration was recorded at its start)', async t => {
  const w = world(t)
  const first = await w.browserSend('이 페이지 제목 알려줘'); await w.settled(first)
  assert.equal(w.chat.browserRegisteredThreads.has(first.conversationId), true)
  const second = await w.browserSend('검색창에 우산 입력', { conversationId: first.conversationId }); assert.equal(second.accepted, true)
  assert.equal((await w.settled(second)).status, 'completed')
  assert.deepEqual([w.transports.at(-1).options.bounded, w.transports.at(-1).options.tools], [true, []])
})

test('an ORDINARY Claude conversation (its first turn had no Card) is still refused 409 even with the capability live: granting a Card would bind the whole conversation to bounded execution for good (no own tools, no files afterwards), which the person did not ask for; the code is the existing one', async t => {
  const w = world(t)
  assert.equal(w.chat.claudeBrowserLive(), true)
  const first = await w.send('안녕', { cwd: w.root }); await w.settled(first)
  assert.equal(w.chat.browserRegisteredThreads.has(first.conversationId), false)
  assert.deepEqual(await refusal(w.browserSend('이 페이지 제목 알려줘', { conversationId: first.conversationId })), { code: 'BROWSER_TOOLS_UNAVAILABLE', status: 409 })
  assert.equal(w.transports.length, 1, 'no turn was started; the conversation is untouched (history and draft kept)')
})

test('flags off the old behaviour stays exactly: the same existing conversation is refused 409 "predates Browser tools" (no page tools provider: the capability is not live), and the Codex answer decides readiness', async t => {
  const w = world(t, { pageTools: false, codexReady: true })
  assert.equal(w.chat.claudeBrowserLive(), false)
  const first = await w.send('안녕', { cwd: w.root }); await w.settled(first)
  assert.deepEqual(await refusal(w.browserSend('이 페이지 제목 알려줘', { conversationId: first.conversationId })), { code: 'BROWSER_TOOLS_UNAVAILABLE', status: 409 })
  const harnessOff = world(t, { harness: false, codexReady: false })
  assert.equal(harnessOff.chat.claudeBrowserLive(), false)
  assert.deepEqual(await refusal(harnessOff.browserSend('x')), { code: 'BROWSER_TOOLS_UNAVAILABLE', status: 503 }, 'harness off: the Codex slot still decides')
})

test('the pure rules: only a Claude route with the capability live leaves the Codex slot; a Codex route and a Codex thread are untouched', () => {
  const calls = []
  const ready = browserSchemaReady({ claudeLive: () => true, claudeReady: () => true, codexReady: route => { calls.push(route); return false } })
  assert.equal(ready({ engineId: 'claude', engineProfileId: null }), true)
  assert.equal(ready({ engineId: 'codex', engineProfileId: 'codex' }), false); assert.equal(ready(undefined), false); assert.equal(calls.length, 2)
  assert.equal(browserSchemaReady({ claudeLive: () => true, claudeReady: () => false, codexReady: () => true })({ engineId: 'claude' }), false, 'Claude not ready: not ready, whatever Codex says')
  assert.equal(browserSchemaReady({ claudeLive: () => false, claudeReady: () => true, codexReady: () => false })({ engineId: 'claude' }), false, 'capability off: the old answer')
  assert.equal(claudeBrowserLive({ harness: null, toolProviders: [{ providerId: 'egdesk-page' }] }), false)
  assert.equal(claudeBrowserLive({ harness: {}, toolProviders: [{ providerId: 'egdesk-browser' }] }), false)
  assert.equal(claudeBrowserLive({ harness: {}, toolProviders: [{ providerId: 'egdesk-page' }] }), true)
})

test('the bridge judges the Browser provider by the route\'s engine, and the screen no longer says "made before the tools were registered" for a 503', () => {
  assert.ok(bridge.includes('schemaReady: browserSchemaReady({ claudeLive:'))
  assert.ok(bridge.includes("claudeReady: () => claudeEngine.isReady() && claudeEngine.capabilities().has('boundedQa')"))
  assert.ok(bridge.includes('codexReady: route => slotReadiness.qaReady(route?.engineProfileId)'))
  assert.ok(surface.includes("if (error.code === 'BROWSER_TOOLS_UNAVAILABLE' && error.status === 409) {"), 'only the 409 (a thread without the tools) gets that sentence')
  assert.ok(!surface.includes("if (error.code === 'BROWSER_TOOLS_UNAVAILABLE') {"))
})
