// L8 u4 (owner direction U19: a Claude conversation runs under EG-Desk's harness, browser control included): REPLAY of a Claude conversation with a Browser Card granted to operate. Real runtime, Claude adapter, MCP bridge,
// permission broker, Browser provider and page-tool provider over a fixture page world; only the Claude process and the page are fake. Nothing real runs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { OWNER, pageWorld } from './egdesk-browser-live-runner.mjs'
import { PAGE_TOOL_NAMES, createPageToolsProvider } from './egdesk-page-tools.mjs'

const CWD = '/work/claude-browser'
const H = 'shop.example.test', O = `https://${H}`
const tick = () => new Promise(resolve => setImmediate(resolve))
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : role === 'button' ? 'button' : 'input', href: '', value: '', ...extra })
const PAGES = () => ({
  '/home': { text: ['쇼핑몰', '찾는 상품을 검색하세요.'], elements: [el('q', 'textbox', '상품 검색'), el('list', 'link', '상품 목록', { href: `${O}/list` }), el('pay', 'button', '결제하기'), el('fav', 'button', '관심 상품에 담기'), el('pw', 'textbox', '비밀번호', { type: 'password' })] },
  '/list': { text: ['상품 목록', '상품 3개'], elements: [el('back', 'link', '홈', { href: `${O}/home` })] },
})
const T = PAGE_TOOL_NAMES

function harness(t, { version = '2.1.300', host = H, ledger = null } = {}) {
  const transports = [], events = [], dispatched = [], prepared = []
  const claude = createClaudeEngineAdapter({
    snapshot: () => ({ installed: true, version, versionStatus: 'untested', auth: { status: 'signedIn', method: 'claudeai', account: 'owner@example.com', label: 'Max' } }),
    env: {}, defaultCwd: CWD, resolveExecutable: () => '/fake/claude', collectContextUsage: false,
    setTimer: () => ({}), clearTimer: () => {},
    createTransport: options => {
      const transport = {
        options, sent: [], replies: [], closed: false,
        async start() {},
        sendUserMessage(content) { this.sent.push(content) },
        respondControl(id, answer) { this.replies.push({ id, ...answer }); return true },
        info: () => ({ init: { billsApiKey: false } }),
        async interrupt() {},
        async close() { if (!this.closed) { this.closed = true; options.onExit() } },
        message(message) { options.onMessage(message) },
        control(requestId, request) { return options.controlHandlers[request.subtype](request, { requestId }) },
      }
      transports.push(transport)
      return transport
    },
  })
  const codex = createCodexEngineAdapter({ request: async method => { throw new Error(`Unexpected Codex call: ${method}`) }, respond: () => true })
  const world = pageWorld('x', host, 'card', { pages: PAGES() }); world.go('/home')
  const send0 = world.transport.sendToUi.bind(world.transport)
  world.transport.sendToUi = async request => { if (request.kind === 'act' && request.action.type === 'fill') { const page = world.state.pages[world.state.cur.path]; const target = page.elements.find(e => e.ref === request.action.ref); if (target) { target.value = request.action.text; world.state.cur = { ...world.state.cur, revision: world.state.cur.revision + 1 } } } return send0(request) }
  const browser = createCodexBrowserToolProvider({ transport: world.transport, getOwnerKey: () => OWNER })
  const page = createPageToolsProvider({ mode: () => 'on', browser: { dispatch: (run, event) => { dispatched.push(event.tool); return browser.dispatch(run, event) } }, ledger })
  const chat = new CodexChatRuntime({ getOwnerKey: () => OWNER, engines: [codex, claude], toolProviders: [browser, page], emit: event => events.push(event), verifyFile: async () => null })
  const unsubscribe = claude.subscribe({
    notification: (_, message) => chat.handleNotification(message),
    serverRequest: (_, message) => chat.handleServerRequest(message),
    connection: (id, state) => chat.setConnection(id, state.ready, state),
  })
  claude.syncStatus()
  t.after(async () => { unsubscribe(); await claude.dispose(); await chat.queue })
  const drain = async () => { await chat.queue; await tick(); await chat.queue }
  const selected = (permission, uri = `https://${host}/home`) => [{ id: 'source', kind: 'browser', selectedByUser: true, browserToolPermission: permission, browserToolSelection: { token: `tok-${Math.random()}`, threadId: 'ui-claude' },
    browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: OWNER, authorityEpoch: 1 }, sourceRef: { viewId: 'card', profileId: 'synthetic', accountId: '', uri } }]
  const send = (extra = {}) => chat.send({ message: 'Look at the card', engineId: 'claude', clientThreadId: 'ui-claude', requestId: `req-${Math.random()}`, browserTransportId: 'ui', ...extra })
  return { chat, claude, transports, events, dispatched, prepared, drain, selected, send, world }
}


const call = (h, transport, id, name, args) => { transport.control(`call-${id}`, { subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } } }) }
const answerOf = (transport, id) => { const reply = transport.replies.find(r => r.id === `call-${id}`); const response = reply?.write?.response?.response?.mcp_response ?? reply?.response?.mcp_response; return response }
const listNames = transport => transport.control('list', { subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }).write.response.response.mcp_response.result.tools.map(tool => tool.name)

test('a Claude conversation with a Card granted to operate: the run is browserBounded, Claude has NO built-in tools, and the card tools (read, press, type, open) are in its EG-Desk MCP catalog and work inside the grant', async t => {
  const h = harness(t)
  const run = await h.send({ executionPolicy: { mode: 'browserBounded' }, selectedSources: h.selected('interact') })
  await h.drain()
  const [transport] = h.transports
  assert.deepEqual([transport.options.tools, transport.options.permissionMode, transport.options.bounded, transport.options.allowedTools], [[], 'dontAsk', true, ['mcp__egdesk']])
  assert.equal(h.chat.runs.get(`${run.conversationId}/${run.runId}`).executionPolicy.mode, 'browserBounded')
  const names = listNames(transport)
  for (const name of Object.values(T)) assert.ok(names.includes(name), `${name} is in Claude's catalog (mcp__egdesk__${name})`)
  assert.ok(names.includes('egdesk_browser_observe'))
  transport.message({ type: 'system', subtype: 'init', session_id: run.conversationId, model: 'claude-x', cwd: CWD, claude_code_version: '2.1.300', permissionMode: 'dontAsk', apiKeySource: 'none', tools: names.map(n => `mcp__egdesk__${n}`), mcp_servers: [{ name: 'egdesk', status: 'connected' }], capabilities: [] })
  call(h, transport, 2, T.read, { mode: 'structure' })
  await h.drain(); await new Promise(resolve => setTimeout(resolve, 30)); await h.drain()
  const read = JSON.parse(answerOf(transport, 2).result.content[0].text)
  assert.deepEqual([read.status, read.title, read.elements.map(e => `${e.ref}:${e.act}`)], ['read', '쇼핑몰', ['q:auto', 'list:auto', 'pay:person', 'fav:approval', 'pw:person']])
  call(h, transport, 3, T.type, { ref: 'q', text: '우산' }); call(h, transport, 4, T.press, { ref: 'pay' })
  await h.drain(); await new Promise(resolve => setTimeout(resolve, 30)); await h.drain()
  assert.deepEqual([JSON.parse(answerOf(transport, 3).result.content[0].text).status, h.world.state.pages['/home'].elements.find(e => e.ref === 'q').value], ['typed', '우산'])
  assert.deepEqual(JSON.parse(answerOf(transport, 4).result.content[0].text).status, 'person_step', 'payment is the person\'s')
  call(h, transport, 5, T.read, { mode: 'structure' }); await h.drain(); await new Promise(resolve => setTimeout(resolve, 30)); await h.drain()
  call(h, transport, 6, T.press, { ref: 'list' }); await h.drain(); await new Promise(resolve => setTimeout(resolve, 30)); await h.drain()
  assert.deepEqual([JSON.parse(answerOf(transport, 6).result.content[0].text).via, h.world.state.cur.path], ['auto', '/list'])
  assert.ok(h.dispatched.includes('egdesk_browser_fill') && h.dispatched.includes('egdesk_browser_navigate') && h.dispatched.includes('egdesk_browser_observe'), 'every action went through the Browser provider')
  // a built-in tool is still denied without an approval card
  assert.equal(transport.control('perm', { subtype: 'can_use_tool', tool_name: 'WebFetch', tool_use_id: 'toolu-9', input: { url: 'https://x.test' } }).response.behavior, 'deny')
})

test('a Card granted only to observe: Claude is offered the read tool and no press, type or open; no Card at all: no page tools', async t => {
  const h = harness(t)
  await h.send({ executionPolicy: { mode: 'browserBounded' }, selectedSources: h.selected('observe') })
  await h.drain()
  const names = listNames(h.transports[0]).filter(name => name.startsWith('egdesk_card_'))
  assert.deepEqual(names, [T.read])
})

test('the Claude ceiling and the Card opacity are the runtime\'s own: a Card on an AI service sign-in page gives the engine nothing (flag EGDESK_TERMINAL_OPEN_URL)', async t => {
  const prev = process.env.EGDESK_TERMINAL_OPEN_URL
  process.env.EGDESK_TERMINAL_OPEN_URL = 'on'
  try {
    const h = harness(t, { host: 'claude.ai' })
    const run = await h.send({ executionPolicy: { mode: 'browserBounded' }, selectedSources: h.selected('interact', 'https://claude.ai/home') })
    await h.drain()
    const [transport] = h.transports
    transport.message({ type: 'system', subtype: 'init', session_id: run.conversationId, model: 'claude-x', cwd: CWD, claude_code_version: '2.1.300', permissionMode: 'dontAsk', apiKeySource: 'none', tools: listNames(transport).map(n => `mcp__egdesk__${n}`), mcp_servers: [{ name: 'egdesk', status: 'connected' }], capabilities: [] })
    // the runtime drops a Card on an AI service's sign-in page from the selection (withoutAuthOpaqueSources): Claude's run has no Card, so only the read tool is offered (no interaction was granted) and it finds no Card
    const names = listNames(transport)
    assert.deepEqual(names.filter(name => name.startsWith('egdesk_card_')), [T.read], 'no interaction tool without a Card')
    call(h, transport, 2, T.read, { mode: 'structure' })
    const opened = transport.control('open', { subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: T.open, arguments: { url: 'https://auth.openai.com/x' } } } })
    await h.drain(); await new Promise(resolve => setTimeout(resolve, 30)); await h.drain()
    const read = JSON.parse(answerOf(transport, 2).result.content[0].text)
    assert.ok(read.error?.code === 'EGDESK_TOOL_REFUSED' || (read.status === 'refused' && read.code === 'PAGE_NO_CARD'), `refused: ${JSON.stringify(read)}`)
    assert.deepEqual([read.lines, read.elements, read.title], [undefined, undefined, undefined], 'nothing of the page')
    assert.equal(opened.write.response.response.mcp_response.error.message, 'Unknown tool', 'open is not even offered without an interaction grant')
    assert.equal(h.world.state.acts.length, 0)
  } finally { if (prev === undefined) delete process.env.EGDESK_TERMINAL_OPEN_URL; else process.env.EGDESK_TERMINAL_OPEN_URL = prev }
})
