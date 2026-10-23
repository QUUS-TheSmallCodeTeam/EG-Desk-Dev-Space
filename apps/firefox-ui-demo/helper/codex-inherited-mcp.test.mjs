import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  INHERITED_MCP_KINDS, INHERITED_MCP_NOTIFICATION, INHERITED_MCP_STATUSES,
  classifyMcpServer, createInheritedMcpSync, publicInheritedMcpServer, startupStatus,
} from './codex-inherited-mcp.mjs'

const ROW_KEYS = ['name', 'enabled', 'status', 'controlsExternal', 'kind']
const server = (name, extra = {}) => ({ name, authStatus: 'unsupported', tools: {}, resources: [], resourceTemplates: [], toolsError: null, ...extra })

test('server kind comes from whole name tokens first, then tool names; controlsExternal is every kind but other', () => {
  const byName = {
    playwright: 'browser', 'playwright-electron': 'browser', 'playwright-gtdev': 'browser', 'chrome-devtools': 'browser',
    'firefox-devtools': 'browser', Control_Chrome: 'browser', 'claude-in-chrome': 'browser', chromeDevtools: 'browser', puppeteer: 'browser',
    'computer-use': 'desktop', computer_use: 'desktop', 'desktop-commander': 'desktop', peekaboo: 'desktop',
    node_repl: 'repl', 'node-repl': 'repl', jupyter: 'repl', 'shell-server': 'repl',
    context7: 'other', supabase: 'other', figma: 'other', pencil: 'other', 'codex-cli': 'other', github: 'other',
    // Substrings are not tokens.
    'shellfish-recipes': 'other', 'executive-summary': 'other', 'chromebook-docs': 'other', browserless: 'other',
  }
  for (const [name, kind] of Object.entries(byName)) {
    assert.deepEqual(classifyMcpServer({ name }), { controlsExternal: kind !== 'other', kind }, name)
  }
  const byTools = [
    [['browser_navigate', 'browser_click'], 'browser'], [['navigate_page'], 'browser'], [['take_snapshot'], 'browser'],
    [['computer'], 'desktop'], [['computer_batch'], 'desktop'], [['left_click'], 'desktop'], [['app_click'], 'desktop'],
    [['js', 'js_reset'], 'repl'], [['execute_code'], 'repl'], [['run_shell_command'], 'repl'],
    [['search_docs', 'get_file'], 'other'], [[], 'other'], [['javascript_tool_docs'], 'other'],
  ]
  for (const [toolNames, kind] of byTools) assert.equal(classifyMcpServer({ name: 'acme', toolNames }).kind, kind, toolNames.join())
  assert.equal(classifyMcpServer({ name: 'playwright', toolNames: ['js'] }).kind, 'browser', 'a name rule wins over tools')
  assert.equal(classifyMcpServer({ name: 'acme', toolNames: ['js', 'browser_click'] }).kind, 'browser', 'browser rules are checked before desktop and repl')
  assert.deepEqual(classifyMcpServer(), { controlsExternal: false, kind: 'other' })
  assert.deepEqual(INHERITED_MCP_KINDS, ['browser', 'desktop', 'repl', 'other'])
})

test('a public row carries only name, enabled, status and the classification, never configuration or secrets', () => {
  const row = publicInheritedMcpServer(server('playwright', {
    command: 'npx', args: ['@playwright/mcp', '--token', 'SECRET-ARG'], env: { API_KEY: 'SECRET-ENV' },
    url: 'https://user:pass@mcp.example/path?token=SECRET-QUERY', httpOrigin: 'https://mcp.example', pluginId: 'private-plugin',
    authStatus: 'bearerToken', serverInfo: { name: 'Playwright', version: '1.0.0', websiteUrl: 'https://private.example' },
    tools: { browser_navigate: { name: 'browser_navigate', inputSchema: { description: 'SECRET-SCHEMA' } } },
    resources: [{ uri: 'file:///Users/private/SECRET-RESOURCE' }], serverCapabilities: { experimental: { token: 'SECRET-CAP' } },
  }))
  assert.deepEqual(row, { name: 'playwright', enabled: true, status: 'available', controlsExternal: true, kind: 'browser' })
  assert.deepEqual(Object.keys(row), ROW_KEYS)
  assert.doesNotMatch(JSON.stringify(row), /SECRET|private|mcp\.example|npx|bearer/i)
  // Tool names classify a server whose name says nothing; the names are not published.
  assert.deepEqual(publicInheritedMcpServer(server('acme', { tools: { js: { name: 'js' } } })), { name: 'acme', enabled: true, status: 'available', controlsExternal: true, kind: 'repl' })
  for (const bad of [null, {}, { name: '' }, { name: '   ' }, { name: 7 }, { name: 'a\0b' }]) assert.equal(publicInheritedMcpServer(bad), null)
  assert.ok(publicInheritedMcpServer(server('x'.repeat(500))).name.length <= 128)
})

test('status follows the thread runtime state, then catalog errors and login, else the server is available', () => {
  const statusOf = extra => publicInheritedMcpServer(server('acme', extra))
  assert.deepEqual([statusOf({ runtimeStatus: 'connected' }).status, statusOf({ runtimeStatus: 'connected' }).enabled], ['connected', true])
  assert.deepEqual([statusOf({ runtimeStatus: 'disabled' }).status, statusOf({ runtimeStatus: 'disabled' }).enabled], ['disabled', false])
  assert.equal(statusOf({ toolsError: 'spawn failed: /Users/private/bin' }).status, 'failed')
  assert.equal(statusOf({ authStatus: 'notLoggedIn' }).status, 'authenticationRequired')
  assert.equal(statusOf({ runtimeStatus: 'starting', toolsError: 'x' }).status, 'starting')
  assert.equal(statusOf({ runtimeStatus: 'surprise' }).status, 'available')
  assert.equal(statusOf({ toolsError: 'x' }).enabled, true)
  assert.deepEqual(['starting', 'ready', 'failed', 'cancelled', 'other'].map(state => startupStatus(state)), ['starting', 'connected', 'failed', 'cancelled', null])
  assert.equal(startupStatus('failed', 'reauthenticationRequired'), 'authenticationRequired')
  for (const status of ['connected', 'starting', 'notStarted', 'available', 'authenticationRequired', 'failed', 'cancelled', 'disabled']) assert.ok(INHERITED_MCP_STATUSES.includes(status))
})

function nativeList(pages) {
  const calls = []
  const request = async (method, params) => {
    calls.push([method, params])
    if (method !== 'mcpServerStatus/list') throw new Error(`unexpected ${method}`)
    const page = pages[params.cursor ?? 'first']
    if (page instanceof Error) throw page
    return page
  }
  return { calls, request }
}

test('refresh reads the inherited list once per connection without a thread, pages it and drops duplicate names', async () => {
  const native = nativeList({
    first: { data: [server('playwright'), server('context7'), server('node_repl', { runtimeStatus: 'disabled' })], nextCursor: 'page-2' },
    'page-2': { data: [server('computer-use'), server('playwright')], nextCursor: null },
  })
  const changes = []
  const sync = createInheritedMcpSync({ request: native.request, onChange: rows => changes.push(rows) })
  assert.equal(sync.snapshot(), null, 'unknown until read')
  const rows = await sync.refresh()
  assert.deepEqual(native.calls.map(([, params]) => params), [{ limit: 100, detail: 'toolsAndAuthOnly' }, { limit: 100, cursor: 'page-2', detail: 'toolsAndAuthOnly' }])
  assert.deepEqual(rows, [
    { name: 'playwright', enabled: true, status: 'available', controlsExternal: true, kind: 'browser' },
    { name: 'context7', enabled: true, status: 'available', controlsExternal: false, kind: 'other' },
    { name: 'node_repl', enabled: false, status: 'disabled', controlsExternal: true, kind: 'repl' },
    { name: 'computer-use', enabled: true, status: 'available', controlsExternal: true, kind: 'desktop' },
  ])
  assert.deepEqual(sync.snapshot(), rows)
  assert.equal(changes.length, 1)
  sync.snapshot()[0].status = 'tampered'
  assert.equal(sync.snapshot()[0].status, 'available', 'callers get copies')
  await sync.refresh()
  assert.equal(changes.length, 1, 'an unchanged list is not announced again')
})

test('a failed read, an unknown shape or an offline app-server leaves the list unknown (null)', async () => {
  const failing = nativeList({ first: new Error('offline: /Users/private/.codex/config.toml') })
  const changes = []
  const sync = createInheritedMcpSync({ request: failing.request, onChange: rows => changes.push(rows) })
  assert.equal(await sync.refresh(), null)
  assert.deepEqual(changes, [])
  const shape = createInheritedMcpSync({ request: nativeList({ first: { data: [{ name: 'x', tools: [] }] } }).request })
  assert.equal(await shape.refresh(), null)
  let reads = 0
  const offline = createInheritedMcpSync({ request: async () => { reads += 1 }, ready: () => false })
  assert.equal(await offline.refresh(), null)
  assert.equal(reads, 0)
  // A known list becomes unknown when a later read fails.
  let fail = false
  const flaky = createInheritedMcpSync({ request: async () => { if (fail) throw new Error('lost'); return { data: [server('playwright')], nextCursor: null } }, onChange: rows => changes.push(rows) })
  await flaky.refresh()
  fail = true
  assert.equal(await flaky.refresh(), null)
  assert.deepEqual(changes.slice(-2).map(rows => rows && rows.length), [1, null])
})

test('startup notices update a known server, add a new one by name, skip non-inheriting threads and never invent a list', async () => {
  const changes = []
  const sync = createInheritedMcpSync({
    request: nativeList({ first: { data: [server('playwright'), server('context7')], nextCursor: null } }).request,
    ignoreThread: threadId => threadId === 'qa-thread',
    onChange: rows => changes.push(rows),
  })
  const notice = params => ({ method: INHERITED_MCP_NOTIFICATION, params })
  assert.equal(sync.notify(notice({ name: 'playwright', status: 'ready' })), true)
  assert.equal(sync.snapshot(), null, 'a notice before the list is read does not invent one')
  assert.equal(sync.notify({ method: 'account/updated', params: {} }), false)
  await sync.refresh()
  sync.notify(notice({ name: 'playwright', status: 'ready', threadId: 'ordinary-thread' }))
  assert.equal(sync.snapshot()[0].status, 'connected')
  sync.notify(notice({ name: 'context7', status: 'failed', failureReason: 'reauthenticationRequired', error: 'token SECRET expired' }))
  assert.equal(sync.snapshot()[1].status, 'authenticationRequired')
  assert.doesNotMatch(JSON.stringify(changes), /SECRET/)
  const before = changes.length
  sync.notify(notice({ name: 'playwright', status: 'failed', threadId: 'qa-thread' }))
  sync.notify(notice({ name: 'playwright', status: 'unknown-state' }))
  sync.notify(notice({ status: 'ready' }))
  assert.equal(changes.length, before, 'skipped notices change nothing')
  sync.notify(notice({ name: 'chrome-devtools', status: 'starting' }))
  assert.deepEqual(sync.snapshot().at(-1), { name: 'chrome-devtools', enabled: true, status: 'starting', controlsExternal: true, kind: 'browser' })
  assert.deepEqual(Object.keys(sync.snapshot().at(-1)), ROW_KEYS)
})

test('reset on disconnect makes the list unknown and a read still in flight cannot bring the old list back', async () => {
  let release
  const changes = []
  const sync = createInheritedMcpSync({
    request: () => new Promise(resolve => { release = () => resolve({ data: [server('playwright')], nextCursor: null }) }),
    onChange: rows => changes.push(rows),
  })
  const pending = sync.refresh()
  assert.equal(sync.refresh(), pending, 'reads are coalesced')
  sync.reset()
  release()
  assert.equal(await pending, null)
  assert.equal(sync.snapshot(), null)
  assert.deepEqual(changes, [])
  const known = createInheritedMcpSync({ request: async () => ({ data: [server('playwright')], nextCursor: null }), onChange: rows => changes.push(rows) })
  await known.refresh()
  known.reset()
  assert.deepEqual(changes.map(rows => rows && rows.length), [1, null])
})

test('the bridge reads the inherited list after each ready connection, follows startup notices and forgets it when the app-server goes', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const at = text => { const index = source.indexOf(text); assert.notEqual(index, -1, `missing server marker: ${text}`); return index }
  assert.ok(at('const inheritedMcp = createInheritedMcpSync({') > at('const chat = new CodexChatRuntime({'))
  at("ignoreThread: threadId => Boolean(threadId && chat.threads.get(threadId)?.executionPolicy),")
  at("onChange: servers => broadcast({ type: 'mcp.inherited', v: BRIDGE_PROTOCOL_VERSION, provider: PROVIDER_ID, inheritedMcp: servers, ts: Date.now() }),")
  const open = source.slice(at('socket.onopen = async () => {'), at('socket.onmessage = event => {'))
  assert.ok(open.indexOf('chat.setConnection(true)') < open.indexOf('void inheritedMcp.refresh()'))
  assert.equal(source.split('inheritedMcp.refresh()').length, 2, 'read once per connection, not per /v1/state')
  const close = source.slice(at('socket.onclose = () => {'), at('async function startChatgptLogin() {'))
  assert.match(close, /chat\.setConnection\(false\)\n {4}inheritedMcp\.reset\(\)/)
  const lost = source.slice(at('const lost = () => {'), at("child.on('error', lost)"))
  assert.match(lost, /inheritedMcp\.reset\(\)/)
  const notices = source.slice(at('function handleAppServerNotification(message) {'), at('function startLoginPolling() {'))
  assert.match(notices, /case 'mcpServer\/startupStatus\/updated':\n {6}inheritedMcp\.notify\(message\)\n {6}return/)
  assert.equal(INHERITED_MCP_NOTIFICATION, 'mcpServer/startupStatus/updated')
})
