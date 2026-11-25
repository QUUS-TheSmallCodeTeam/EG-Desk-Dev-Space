// L8 u5/u6 (U19): the miniature of the bridge for the Claude browser replay tests: the real runtime, chat store, own-tools wiring, Claude adapter, MCP bridge, Browser and page-tool providers and the
// bridge's own readiness function; only the Claude process (a scripted transport) and the page are fake. Nothing real runs.
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
import { browserSchemaReady } from './egdesk-claude-browser-route.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

/**
 * What a real Claude Code CLI (2.1.x) puts in system/init next to EG-Desk's server although it is launched with --tools "" --restricted --strict-mcp-config --disable-slash-commands: the documented
 * SDKSystemMessage (code.claude.com/docs agent-sdk/typescript) lists skills, plugins and agents by name (bundled and built-in ones included), and the tools list carries `EndConversation`
 * (tools-reference: it cannot be removed while any other tool exists). The names are the documented built-in ones plus invented user ones; the shape is what matters.
 */
export const REAL_INIT_LISTS = Object.freeze({
  agents: ['general-purpose', 'Explore', 'Plan', 'my-reviewer'], skills: ['update-config', 'debug', 'simplify', 'my-design-skill'], plugins: [{ name: 'my-plugin', path: '/home/synthetic/.claude/plugins/my-plugin' }],
  slash_commands: ['compact', 'context', 'cost', 'init', 'review'], output_style: 'default',
})
const tick = () => new Promise(resolve => setImmediate(resolve))
const until = async (predicate, ms = 4000) => { const end = Date.now() + ms; while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); assert.ok(predicate(), 'condition not reached in time') }
const H = 'shop.example.test'
const PAGES = () => ({ '/home': { text: ['쇼핑몰'], elements: [{ ref: 'q', role: 'textbox', label: '상품 검색', tag: 'input', href: '', value: '' }] } })
/**
 * world(t, { harness, pageTools, codexReady, oldReadiness }): the bridge's wiring in miniature. harness / pageTools: the two flags (EGDESK_CLAUDE_HARNESS, EGDESK_PAGE_TOOLS).
 * codexReady: the Codex slot's own answer (qaReady), false = no Codex app-server (the real-window case). oldReadiness: the Browser provider's readiness as u4 left it (the Codex slot's, for every engine).
 */
export function world(t, { harness = true, pageTools = true, codexReady = false, oldReadiness = false, init = 'minimal', extraTools = [] } = {}) {
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
                ...(bounded ? { permissionMode: 'dontAsk', tools: init === 'real' ? ['EndConversation', ...extraTools, ...tools] : init === 'lists' ? [...extraTools, ...tools] : tools, mcp_servers: [{ name: 'egdesk', status: 'connected' }], capabilities: [], ...(init === 'real' || init === 'lists' ? REAL_INIT_LISTS : {}) } : {}) })
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
export const refusal = async promise => { try { await promise; return null } catch (error) { return { code: error.code, status: error.httpStatus } } }

