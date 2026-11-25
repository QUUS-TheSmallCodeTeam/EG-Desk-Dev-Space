// L8 u1: the page tools in the REAL chat runtime (mock app-server, fixture page world): the catalog offers them to Codex (dynamicTools) and to Claude (the EG-Desk MCP) only in a run bound to a
// granted Browser Card; the dispatch gate checks them as the Browser tool they need (grant, policy, Agent ceiling); a call reaches the Card through the Browser provider and is recorded in the activity.
import test from 'node:test'
import assert from 'node:assert/strict'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { mcpToolsFromSpecs } from './egdesk-claude-mcp.mjs'
import { OWNER, pageWorld } from './egdesk-browser-live-runner.mjs'
import { PAGE_TOOL_NAMES, createPageToolsProvider } from './egdesk-page-tools.mjs'

const H = 'shop.example.test', O = `https://${H}`
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : 'input', href: '', value: '', ...extra })
const PAGES = () => ({ '/home': { text: ['쇼핑몰', '찾는 상품을 검색하세요.'], elements: [el('q', 'textbox', '상품 검색'), el('list', 'link', '상품 목록', { href: `${O}/list` })] }, '/list': { text: ['상품 목록'], elements: [] } })
const T = PAGE_TOOL_NAMES

function harness(t, { toolCeiling = null } = {}) {
  const world = pageWorld('x', H, 'card', { pages: PAGES() }); world.go('/home')
  const browser = createCodexBrowserToolProvider({ transport: world.transport, getOwnerKey: () => OWNER })
  const page = createPageToolsProvider({ mode: () => 'on', browser: { dispatch: (run, event) => browser.dispatch(run, event) } })
  const calls = [], replies = [], events = []
  let threads = 0, turns = 0
  const chat = new CodexChatRuntime({
    getOwnerKey: () => OWNER, toolProviders: [browser, page], verifyFile: async () => null,
    respond: (...args) => replies.push(args), emit: e => events.push(e), emitLegacy() {},
    request: async (method, params) => {
      calls.push([method, structuredClone(params)])
      if (method === 'experimentalFeature/list') return { data: ['browser_use', 'browser_use_external', 'computer_use'].map(name => ({ name, enabled: false, stage: 'stable' })), nextCursor: null }
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null }
      if (method === 'config/read') return { config: { developer_instructions: 'Ordinary instructions' }, layers: [] }
      if (method === 'thread/start') return { thread: { id: `thread-${++threads}` }, cwd: '/work', model: 'm', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }
      return {}
    },
  })
  chat.setConnection(true)
  const source = (permission = 'interact') => ({ id: 'source', kind: 'browser', selectedByUser: true, browserToolPermission: permission, browserToolSelection: { token: `tok-${Math.random()}`, threadId: 'ui' },
    browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: OWNER, authorityEpoch: 1 }, sourceRef: { viewId: 'card', profileId: 'synthetic', accountId: '', uri: `${O}/home` } })
  const send = (n, { permission = 'interact', policy = { mode: 'browserBounded' } } = {}) => chat.send({ message: 'x', requestId: `r${n}`, clientThreadId: 'ui', ...(policy ? { executionPolicy: policy } : {}), ...(policy ? { selectedSources: [source(permission)], browserTransportId: 'ui' } : {}), ...(toolCeiling ? { toolCeiling } : {}) })
  const tool = async (run, id, name, args) => {
    await chat.handleServerRequest({ id, method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: id, tool: name, arguments: args } })
    const until = Date.now() + 3000
    while (!replies.some(r => r[0] === id) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
    const reply = replies.find(r => r[0] === id); assert.ok(reply, `no reply to ${id}`)
    return reply[1] ? { ok: true, body: JSON.parse(reply[1].contentItems[0].text) } : { ok: false, error: reply[2] }
  }
  return { chat, calls, events, world, send, tool, dynamic: () => calls.filter(([m]) => m === 'thread/start').at(-1)?.[1]?.dynamicTools?.map(s => s.name) ?? [] }
}

test('a run bound to a Card the person granted offers the page tools to Codex (dynamicTools) and to Claude (the EG-Desk MCP catalog); read is offered with an observe grant, the rest only with interact', async t => {
  const h = harness(t)
  const run = await h.send(1)
  const names = h.dynamic()
  for (const name of Object.values(T)) assert.ok(names.includes(name), `${name} is in Codex's catalog`)
  assert.ok(names.includes('egdesk_browser_observe'), 'the Browser tools are still there')
  const claude = h.chat.collectToolSpecs('browserBounded', { browserInteraction: true, engineId: 'claude' })
  const mcp = mcpToolsFromSpecs(claude.specs)
  for (const name of Object.values(T)) assert.ok(mcp.tools.some(tool => tool.name === name), `${name} is in Claude's MCP catalog as mcp__egdesk__${name}`)
  assert.ok(Object.values(T).every(name => `mcp__egdesk__${name}`.length <= 64))
  const readOnly = h.chat.collectToolSpecs('readOnlyQa', { browserInteraction: false, engineId: 'codex' }).specs.map(s => s.name)
  assert.deepEqual(readOnly.filter(name => name.startsWith('egdesk_page_')), [T.read])
  const observeOnly = h.chat.collectToolSpecs('browserBounded', { browserInteraction: false, engineId: 'codex' }).specs.map(s => s.name)
  assert.deepEqual(observeOnly.filter(name => name.startsWith('egdesk_page_')), [T.read])
  const ordinary = h.chat.collectToolSpecs(null, { engineId: 'claude' }).specs.map(s => s.name)
  assert.deepEqual(ordinary.filter(name => name.startsWith('egdesk_page_')), [], 'an ordinary thread holds no Card grant: no page tools')
  void run
})

test('the Agent ceiling wins: a profile limited to observing is offered only the read tool, and a press is refused at the runtime gate', async t => {
  const ceiling = { browser: 'observe' }
  const h = harness(t)
  const specs = h.chat.collectToolSpecs('browserBounded', { browserInteraction: true, engineId: 'codex', toolCeiling: ceiling }).specs.map(s => s.name)
  assert.deepEqual(specs.filter(name => name.startsWith('egdesk_page_')), [T.read])
  const run = await h.send(1); const internal = [...h.chat.runs.values()].at(-1); internal.toolCeiling = ceiling
  const refused = await h.tool(run, 'c-press', T.press, { ref: 'list' })
  assert.deepEqual([refused.ok, refused.error?.code], [false, -32601]); assert.match(refused.error.message, /Agent profile/)
  assert.equal(h.world.state.acts.length, 0)
})

test('a call through the runtime reaches the Card through the Browser provider and is recorded in the activity (browser.tool.completed events with the same run); a Card granted only to observe refuses the press at the gate', async t => {
  const h = harness(t)
  const run = await h.send(1)
  const read = await h.tool(run, 'c1', T.read, { mode: 'structure' })
  assert.deepEqual([read.ok, read.body.status, read.body.title, read.body.elements.map(e => `${e.ref}:${e.act}`)], [true, 'read', '쇼핑몰', ['q:auto', 'list:auto']])
  const press = await h.tool(run, 'c2', T.press, { ref: 'list' })
  assert.deepEqual([press.ok, press.body.status, press.body.via], [true, 'pressed', 'auto']); assert.equal(h.world.state.cur.path, '/list')
  const typed = await h.tool(run, 'c3', T.type, { ref: 'q', text: '우산' })
  assert.equal(typed.ok, true)
  assert.ok(h.events.some(e => JSON.stringify(e).includes('browser.tool.completed')), 'the Browser provider\'s activity events were emitted for this run')
  // observe-only Card
  const h2 = harness(t); const run2 = await h2.send(1, { permission: 'observe' })
  assert.equal((await h2.tool(run2, 'o1', T.read, {})).body.status, 'read')
  const denied = await h2.tool(run2, 'o2', T.press, { ref: 'list' })
  assert.deepEqual([denied.ok, denied.error?.code], [false, -32601]); assert.equal(h2.world.state.acts.length, 0)
})

test('an ordinary conversation (no execution policy, no Card) does not accept a page tool call', async t => {
  const h = harness(t)
  const run = await h.send(1, { policy: null })
  const out = await h.tool(run, 'n1', T.read, {})
  assert.deepEqual([out.ok, out.error?.code], [false, -32601])
})

test('registerToolProvider: a provider added after construction joins the catalog; a duplicate or an unnamed one is ignored', async t => {
  const h = harness(t)
  const extra = createPageToolsProvider({ mode: () => 'on', browser: null })
  extra.providerId = 'egdesk-page-2'
  assert.equal(h.chat.registerToolProvider({ specs: () => [] }), false); assert.equal(h.chat.registerToolProvider(null), false)
  const before = h.chat.toolProviders.length
  assert.equal(h.chat.registerToolProvider(extra), true); assert.equal(h.chat.registerToolProvider(extra), false)
  assert.equal(h.chat.toolProviders.length, before + 1); assert.ok(extra.runtime && typeof extra.runtime.emit === 'function')
})
