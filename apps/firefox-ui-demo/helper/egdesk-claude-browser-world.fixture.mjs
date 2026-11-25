// L8 u5/u6 (U19): the miniature of the bridge for the Claude browser replay tests: the real runtime, chat store, own-tools wiring, Claude adapter, MCP bridge, Browser and page-tool providers and the
// bridge's own readiness function; only the Claude process (a scripted transport) and the page are fake. Nothing real runs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createDecisionClient } from './egdesk-decision-client.mjs'
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
export function world(t, { harness = true, pageTools = true, codexReady = false, oldReadiness = false, init = 'minimal', extraTools = [], host = H, pages = PAGES, start = '/home', hold = false, decisions = null } = {}) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-claude-route-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'project'); fs.mkdirSync(root); const dataDir = path.join(base, 'data'); fs.mkdirSync(dataDir)
  const transports = [], events = [], ran = [], decisionBodies = []
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
            const finish = () => {
              options.onMessage({ session_id: sid, type: 'assistant', parent_tool_use_id: null, message: { id: `m-${this.sent.length}`, role: 'assistant', content: [{ type: 'text', text: '네' }], usage: { input_tokens: 3, output_tokens: 2 } } })
              options.onMessage({ session_id: sid, type: 'result', subtype: 'success', is_error: false })
            }
            if (hold) this.finish = finish; else finish()
          })
        },
      }
      transports.push(transport)
      return transport
    },
  })
  const codex = createCodexEngineAdapter({ request: async method => { throw new Error(`the Codex engine is not used here: ${method}`) }, respond: () => false })
  // a command that would run is recorded, never run (the child is a stub that prints 'ok')
  const spawn = (file, args) => { const command = String(args.at(-1)); ran.push(command); const child = new EventEmitter(); Object.assign(child, { pid: 7000 + ran.length, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }); setImmediate(() => { child.stdout.write('ok\n'); setTimeout(() => child.emit('close', 0, null), 5) }); return child }
  const decisionFlags = decisions ? { EGDESK_DECISION_FIRST: 'on', EGDESK_DECISION_FIRST_APPROVALS: 'on', ...(decisions.openItems ? { EGDESK_OPEN_ITEMS: 'on' } : {}) } : {}
  const wiring = createOwnToolsWiring({ env: { EGDESK_OWN_TOOLS: 'on', ...(harness ? { EGDESK_CLAUDE_HARNESS: 'on' } : {}), ...decisionFlags, PATH: '/usr/bin:/bin', HOME: '/home/synthetic' }, dataDir, spawn, getChat: () => chat, home: '/home/synthetic', gitStatus: async () => '' })
  const pw = pageWorld('x', host, 'card', { pages: pages() }); pw.go(start)
  const send0 = pw.transport.sendToUi.bind(pw.transport)
  pw.transport.sendToUi = async request => { if (request.kind === 'act' && request.action.type === 'fill') { const page = pw.state.pages[pw.state.cur.path]; const target = page.elements.find(e => e.ref === request.action.ref); if (target) { target.value = request.action.text; pw.state.cur = { ...pw.state.cur, revision: pw.state.cur.revision + 1 } } } return send0(request) }
  const readiness = oldReadiness ? route => codexReady : browserSchemaReady({ claudeLive: () => chat.claudeBrowserLive() === true, claudeReady: () => claude.isReady() && claude.capabilities().has('boundedQa'), codexReady: () => codexReady })
  const browser = createCodexBrowserToolProvider({ transport: pw.transport, getOwnerKey: () => OWNER, schemaReady: readiness })
  const page = createPageToolsProvider({ mode: () => 'on', browser: { dispatch: (run, event) => browser.dispatch(run, event) }, ledger: wiring.ledger })
  // the decision model: a scripted answer per question name (predicates by name; a pick is 'none'); every request body is kept
  const predicates = decisions?.predicates ?? {}
  const decisionClient = decisions ? createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0001', recipientForKey: () => 'a'.repeat(64), fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); decisionBodies.push(body)
    const answers = body.questions.map(q => q.name === 'df_pick' || q.name === 'ov_app' ? { type: 'choice', name: q.name, choice: 'none', confidence: 0.97, probabilities: [{ value: 'none', probability: 0.97 }] } : { name: q.name, type: 'predicate', probability: predicates[q.name] ?? (/^oi_ref_/.test(q.name) ? (decisions.settles ?? 0.05) : 0.05) })
    return Response.json({ model: 'gpt-6-luna', answers, usage: { input_tokens: 40 } })
  } }) : null
  const store = openChatStore({ dataDir: path.join(base, 'chat'), ownerScope: 'claude-route' }); t.after(() => store.close())
  chat = new CodexChatRuntime({ engines: [codex, claude], store, requireStore: true, getOwnerKey: () => OWNER, toolProviders: [browser, ...(pageTools ? [page] : []), ...wiring.toolProviders], ownTools: wiring.ownTools, verifyFile: async () => null, emit: event => events.push(event), emitLegacy: () => {},
    ...(decisions ? { decisionContext: { mode: () => 'on', configured: () => true, client: decisionClient, settingsGeneration: () => 0, budgetMs: 800, collect: async () => [], terminalGate: wiring.terminalGate(null), ...(decisions.openItems ? { openItems: true } : {}) } } : {}) })
  const unsubscribe = claude.subscribe({ notification: (_, m) => chat.handleNotification(m), serverRequest: (_, m) => chat.handleServerRequest(m), connection: (id, s) => chat.setConnection(id, s.ready, s) })
  claude.syncStatus(); chat.setConnection('claude', true, {})
  const drain = async () => { await chat.queue; await tick(); await chat.queue }
  t.after(async () => { unsubscribe(); await claude.dispose(); await drain() })
  const selected = (threadId = 'ui-claude') => [{ id: 'source', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact', browserToolSelection: { token: `tok-${Math.random()}`, threadId },
    browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: OWNER, authorityEpoch: 1 }, sourceRef: { viewId: 'card', profileId: 'synthetic', accountId: '', uri: `https://${host}${start}` } }]
  const send = (message, extra = {}) => chat.send({ message, engineId: 'claude', clientThreadId: 'ui-claude', requestId: `r-${Math.random()}`, browserTransportId: 'ui', ...extra })
  const browserSend = (message, extra = {}) => send(message, { executionPolicy: { mode: 'browserBounded' }, selectedSources: selected(), ...extra })
  const runOf = sent => chat.runs.get(`${sent.conversationId}/${sent.runId}`)
  const settled = async sent => { await until(() => ['completed', 'failed', 'interrupted'].includes(runOf(sent)?.status)); await drain(); return runOf(sent) }
  return { chat, claude, transports, events, root, send, browserSend, runOf, settled, drain, pw, ran, decisionBodies, wiring }
}
export const refusal = async promise => { try { await promise; return null } catch (error) { return { code: error.code, status: error.httpStatus } } }


/** a card tool call as Claude's process makes it (the SDK MCP control request), answered through the permission broker and the real providers: the parsed JSON the tool returned */
let callSeq = 100
export async function callTool(w, name, args) {
  const transport = w.transports.at(-1), id = ++callSeq, requestId = `call-${id}`
  await transport.options.controlHandlers.mcp_message({ subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } } }, { requestId })
  for (let i = 0; i < 600 && !transport.replies.some(r => r.id === requestId); i++) await new Promise(resolve => setTimeout(resolve, 5))
  const reply = transport.replies.find(r => r.id === requestId)
  const response = reply?.write?.response?.response?.mcp_response ?? reply?.response?.mcp_response
  assert.ok(response, 'the tool call was answered')
  return JSON.parse(response.result?.content?.[0]?.text ?? '{}')
}

/**
 * Google's first page as the real window showed it (D19): the search box is a <textarea role="combobox" aria-label="검색" name="q"> in a form that GETs /search; the buttons are inputs of
 * type submit in that form; the sign-in is a link to accounts.google.com. Facts as the Firefox child reports them (elementItem + navigationFacts).
 */
export const GOOGLE_HOST = 'www.google.com'
const gel = (ref, role, label, extra = {}) => ({ ref, role, label, tag: extra.tag ?? (role === 'link' ? 'a' : role === 'button' ? 'input' : 'textarea'), href: '', value: '', disabled: false, ...extra })
// The facts of the two submit buttons of Google's real first page, computed by the REAL Firefox child (navigationFacts) over a fake DOM of the real form (read from google.com/?hl=ko in a real browser, 2026-11):
// an unnamed hidden <input type=file> (image search), the <textarea role=combobox name=q aria-label=검색>, the <button role=link> (voice/image), two copies of the btnK and btnI submit inputs (the page
// and the suggestion list; every one with aria-label, which is also what closest('[aria-label]') returns), and six hidden inputs. Same facts with the suggestion list open.
globalThis.JSWindowActorChild ||= class {}
const { EGDeskBrowserAgentRuntimeChild } = await import('../overlay/resources/EGDeskBrowserAgentRuntimeChild.sys.mjs')
export function googleSearchFacts({ query = '우산', method = 'GET', extraFields = [], hiddenNames = ['sca_esv', 'hl', 'sxsrf', 'source', 'ei', 'iflsig'] } = {}) {
  const doc = { URL: `https://${GOOGLE_HOST}/`, baseURI: `https://${GOOGLE_HOST}/` }
  const node = (tagName, attrs = {}, extra = {}) => ({ tagName, getAttribute: name => (Object.hasOwn(attrs, name) ? attrs[name] : null), closest: () => null, querySelector: () => null, ownerDocument: doc, ...extra })
  const submit = (name, label) => { const n = node('INPUT', { type: 'submit', name, 'aria-label': label, value: label, ...(name === 'btnK' ? { role: 'button' } : {}) }, { value: label }); n.closest = selector => (selector.includes('[aria-label]') ? n : null); return n }
  const fields = [node('INPUT', { type: 'file', hidden: '' }), node('TEXTAREA', { name: 'q', role: 'combobox', 'aria-label': '검색', autocomplete: 'off' }, { value: query }), node('BUTTON', { type: 'button', role: 'link' }),
    submit('btnK', 'Google 검색'), submit('btnI', 'I’m Feeling Lucky'), submit('btnK', 'Google 검색'), submit('btnI', 'I’m Feeling Lucky'),
    ...hiddenNames.map(name => node('INPUT', { type: 'hidden', name }, { value: name === 'hl' ? 'ko' : 'v' })), ...extraFields]
  const form = { getAttribute: name => ({ action: '/search', role: 'search', ...(method ? { method } : {}) })[name] ?? null, elements: fields }
  fields.forEach(field => { field.form = form })
  const actor = new EGDeskBrowserAgentRuntimeChild()
  return { btnK: actor.navigationFacts(fields[3]), btnI: actor.navigationFacts(fields[4]), actor, fields, node }
}
const facts = googleSearchFacts()
const searchForm = facts.btnK.form, submitNav = facts.btnK
export const GOOGLE_PAGES = () => ({
  '/': { text: ['Google', '검색', '한국어'], elements: [
    gel('gmail', 'link', 'Gmail', { href: 'https://mail.google.com/mail/&ogbl' }), gel('img', 'link', '이미지', { href: `https://${GOOGLE_HOST}/imghp?hl=ko&ogbl` }),
    gel('login', 'link', '로그인', { href: 'https://accounts.google.com/ServiceLogin?hl=ko&passive=true&continue=https://www.google.com/&ec=GAZAAQ' }),
    gel('q', 'combobox', '검색', { tag: 'textarea' }),
    gel('btnK', 'button', 'Google 검색', { tag: 'input', nav: facts.btnK }),
    gel('btnI', 'button', 'I’m Feeling Lucky', { tag: 'input', nav: facts.btnI }),
    gel('sel', 'combobox', '언어', { tag: 'select' }),
    gel('fav', 'button', '즐겨찾기에 추가', { tag: 'button', view: '/fav' }),
  ] },
  '/fav': { text: ['Google', '즐겨찾기에 추가됨'], elements: [] },
  '/search': { text: ['우산 - Google 검색', '검색결과 약 1억 개'], elements: [gel('back', 'link', '홈', { href: `https://${GOOGLE_HOST}/` })] },
})
