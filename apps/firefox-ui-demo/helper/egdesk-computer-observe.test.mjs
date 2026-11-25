import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { CodexChatRuntime, COMPUTER_PROVIDER_ID } from './codex-chat-runtime.mjs'
import { createHostLease } from './egdesk-host-lease.mjs'
import { createHostAgent, HOST_AGENT_CONTENT_REQUESTS } from './egdesk-host-agent.mjs'
import { mcpToolsFromSpecs } from './egdesk-claude-mcp.mjs'
import { createEgressGate, EGRESS_KINDS, modelDataPermissions } from './egdesk-decision-egress.mjs'
import {
  COMPUTER_OBSERVE_FLAG, COMPUTER_OBSERVE_PROVIDER_ID, COMPUTER_OBSERVE_SPECS, COMPUTER_OBSERVE_TOOLS, appDenied, bundleDenied, computerObserveEnabled,
  createComputerObserveProvider,
} from './egdesk-computer-observe.mjs'
import { createComputerObserveWiring } from './egdesk-computer-observe-wiring.mjs'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'

const APPS = [
  { bundleId: 'com.apple.calculator', pid: 701, name: 'Calculator', active: true, policy: 'regular' },
  { bundleId: 'com.apple.Notes', pid: 702, name: 'Notes', active: false, policy: 'regular' },
  { bundleId: 'com.apple.Terminal', pid: 703, name: 'Terminal', active: false, policy: 'regular' },
  { bundleId: 'com.1password.1password', pid: 704, name: '1Password', active: false, policy: 'regular' },
  { bundleId: 'org.mozilla.firefox', pid: 705, name: 'EG-Desk', active: false, policy: 'regular' },
  { bundleId: 'com.openai.codex', pid: 706, name: 'Codex', active: false, policy: 'regular' },
  { bundleId: 'com.example.menubar', pid: 707, name: 'MenuThing', active: false, policy: 'accessory' },
  { bundleId: 'com.example.own', pid: 4242, name: 'OwnProcessApp', active: false, policy: 'regular' },
]
const WINDOWS = [
  { windowId: 11, pid: 701, ownerName: 'Calculator', layer: 0, onScreen: true, bounds: { x: 100, y: 100, width: 300, height: 400 }, title: 'Calculator' },
  { windowId: 12, pid: 702, ownerName: 'Notes', layer: 0, onScreen: true, bounds: { x: 0, y: 0, width: 900, height: 700 }, title: 'Secret plans' },
  { windowId: 13, pid: 703, ownerName: 'Terminal', layer: 0, onScreen: true, bounds: { x: 0, y: 0, width: 900, height: 700 }, title: 'zsh' },
]
const IMAGE = Buffer.from('fake-jpeg-bytes').toString('base64')

function fakeHost(overrides = {}) {
  const calls = []
  const host = {
    calls,
    async ready() { calls.push('ready') },
    async listApps() { calls.push('listApps'); return { apps: APPS.map(app => ({ ...app })), frontmost: null } },
    async listWindows(query) { calls.push(`listWindows:${query?.titles === true}`); return { windows: WINDOWS.map(w => ({ ...w })), titles: 'included', truncated: false } },
    async capture(query) {
      calls.push(`capture:${query.windowId}:${query.pid}`)
      return { frame: { windowId: query.windowId, width: 400, height: 500, scale: 1.3, geometryRevision: 77 }, image: { mime: 'image/jpeg', data: IMAGE },
        masked: { count: 1, reasons: ['secure_field'] }, window: { windowId: query.windowId, pid: query.pid, bounds: { x: 0, y: 0, width: 300, height: 400 } } }
    },
    async readElements(query) {
      calls.push(`readElements:${query.windowId}:${query.pid}`)
      return { window: { windowId: query.windowId, pid: query.pid, bounds: { x: 100, y: 100, width: 300, height: 400 } }, elements: [
        { index: 'e3', depth: 2, role: 'AXButton', label: '7', enabled: true, rect: { x: 10, y: 10, width: 40, height: 40 } },
        { index: 'e9', depth: 2, role: 'AXTextField', label: 'Password', sensitive: true, value: 'must-not-appear', rect: { x: 10, y: 80, width: 200, height: 24 } },
      ], truncated: false, complete: true, sensitiveOmitted: 1, geometryRevision: 77 }
    },
    ...overrides,
  }
  return host
}
const parse = response => JSON.parse(response.contentItems[0].text)
const call = (provider, run, tool, args = {}, callId = `c-${Math.random()}`) => provider.dispatch(run, { tool, arguments: args, callId })

test('the flag is off by default: nothing is created and the helper is not asked for content', () => {
  assert.equal(COMPUTER_OBSERVE_FLAG, 'EGDESK_COMPUTER_OBSERVE')
  assert.equal(computerObserveEnabled({}), false)
  assert.equal(computerObserveEnabled({ EGDESK_COMPUTER_OBSERVE: 'shadow' }), false)
  assert.equal(computerObserveEnabled({ EGDESK_COMPUTER_OBSERVE: 'on' }), true)
  assert.equal(createComputerObserveWiring({ env: {}, getChat: () => null, getHostControl: () => null }), null)
  const on = createComputerObserveWiring({ env: { EGDESK_COMPUTER_OBSERVE: 'on' }, getChat: () => null, getHostControl: () => null })
  assert.equal(on.provider.providerId, COMPUTER_PROVIDER_ID)
  assert.equal(COMPUTER_OBSERVE_PROVIDER_ID, COMPUTER_PROVIDER_ID)
  assert.deepEqual(on.agentOptions, { observeContent: true, heartbeatTimeoutMs: 8000 })
})

test('the catalog is four read-only tools; there is no input tool, and Codex and Claude get the same names', () => {
  const names = COMPUTER_OBSERVE_SPECS.map(spec => spec.name)
  assert.deepEqual(names, ['egdesk_computer_list_apps', 'egdesk_computer_list_windows', 'egdesk_computer_capture', 'egdesk_computer_read_elements'])
  for (const spec of COMPUTER_OBSERVE_SPECS) {
    assert.equal(spec.inputSchema.additionalProperties, false)
    assert.doesNotMatch(spec.name, /click|type|key|scroll|drag|press/)
  }
  const claude = mcpToolsFromSpecs(COMPUTER_OBSERVE_SPECS)
  assert.equal(claude.tools.length, 4)
  assert.equal(claude.skipped ?? 0, 0)
  for (const tool of claude.tools) assert.ok(`mcp__egdesk__${tool.mcpName ?? tool.name}`.length <= 64)
})

test('denied apps (EG-Desk, terminals, Codex, password managers, own pids) are never listed; menu-bar helpers are left out; no pid reaches the model', async () => {
  const host = fakeHost()
  const provider = createComputerObserveProvider({ host, ask: async () => 'accept', ownPids: [4242] })
  const listed = parse(await call(provider, {}, COMPUTER_OBSERVE_TOOLS.listApps))
  assert.deepEqual(listed.apps.map(app => app.bundleId), ['com.apple.calculator', 'com.apple.Notes'])
  assert.doesNotMatch(JSON.stringify(listed), /pid/)
  assert.equal(bundleDenied('com.apple.Terminal'), true)
  assert.equal(bundleDenied('com.apple.TerminalFoo'), false)
  assert.equal(bundleDenied('org.mozilla.firefox'), true)
  assert.equal(bundleDenied('com.example.app', ['com.example.']), true)
  assert.equal(appDenied({ name: 'Visual Studio Code', bundleId: 'com.microsoft.VSCode', pid: 1 }), false)
  assert.equal(appDenied({ name: 'EG-Desk', bundleId: null, pid: 2 }), true)
})

test('window titles stay hidden until the person allowed that app in this run', async () => {
  const asked = []
  const provider = createComputerObserveProvider({ host: fakeHost(), ask: async (run, card) => { asked.push(card.appName); return 'accept' } })
  const run = {}
  let windows = parse(await call(provider, run, COMPUTER_OBSERVE_TOOLS.listWindows)).windows
  assert.deepEqual(windows.map(w => [w.windowId, w.title ?? null]), [[11, null], [12, null]])
  assert.doesNotMatch(JSON.stringify(windows), /Secret plans|pid/)
  await call(provider, run, COMPUTER_OBSERVE_TOOLS.readElements, { app: 'com.apple.Notes' })
  windows = parse(await call(provider, run, COMPUTER_OBSERVE_TOOLS.listWindows, { app: 'Notes' })).windows
  assert.deepEqual(windows.map(w => [w.windowId, w.title]), [[12, 'Secret plans']])
  // another run has not allowed it
  windows = parse(await call(provider, {}, COMPUTER_OBSERVE_TOOLS.listWindows, { app: 'Notes' })).windows
  assert.equal(windows[0].title, undefined)
  assert.deepEqual(asked, ['Notes'])
})

test('a first look asks once per app per run; the picture reaches the model as an image and the text carries no pixels', async () => {
  const host = fakeHost()
  const asked = []
  const provider = createComputerObserveProvider({ host, ask: async (run, card) => { asked.push(card); return 'accept' } })
  const run = {}
  const first = await call(provider, run, COMPUTER_OBSERVE_TOOLS.capture, { app: 'Calculator', maxEdge: 800 })
  assert.equal(first.success, true)
  assert.deepEqual(first.contentItems.map(item => item.type), ['inputText', 'inputImage'])
  assert.equal(first.contentItems[1].imageUrl, `data:image/jpeg;base64,${IMAGE}`)
  const text = parse(first)
  assert.deepEqual([text.status, text.app, text.windowId, text.image, text.masked], ['captured', 'com.apple.calculator', 11, { width: 400, height: 500, scale: 1.3, geometryRevision: 77 }, { count: 1, reasons: ['secure_field'] }])
  assert.equal(first.contentItems[0].text.includes(IMAGE), false)
  assert.deepEqual(host.calls.filter(entry => entry.startsWith('capture')), ['capture:11:701'])
  await call(provider, run, COMPUTER_OBSERVE_TOOLS.capture, { app: 'com.apple.calculator' })
  await call(provider, run, COMPUTER_OBSERVE_TOOLS.readElements, { app: 'com.apple.calculator', windowId: 11 })
  assert.equal(asked.length, 1, 'one card for the app in this run')
  assert.match(asked[0].message, /Calculator/)
  assert.equal(asked[0].appName, 'Calculator')
})

test('a declined app is not asked again in the run, nothing is captured and the model is told not to retry', async () => {
  const host = fakeHost()
  let asks = 0
  const provider = createComputerObserveProvider({ host, ask: async () => { asks++; return 'decline' } })
  const run = {}
  for (const tool of [COMPUTER_OBSERVE_TOOLS.capture, COMPUTER_OBSERVE_TOOLS.readElements, COMPUTER_OBSERVE_TOOLS.capture]) {
    const response = await call(provider, run, tool, { app: 'Notes' })
    assert.equal(parse(response).effect, 'refused')
    assert.equal(parse(response).error.code, 'app_not_approved')
  }
  assert.equal(asks, 1)
  assert.deepEqual(host.calls.filter(entry => /^(capture|readElements)/.test(entry)), [])
  // an expired or cancelled card is not remembered as a decline
  let answers = ['expired', 'accept']
  const again = createComputerObserveProvider({ host, ask: async () => answers.shift() })
  const run2 = {}
  assert.equal(parse(await call(again, run2, COMPUTER_OBSERVE_TOOLS.capture, { app: 'Notes' })).error.code, 'app_not_approved')
  assert.equal((await call(again, run2, COMPUTER_OBSERVE_TOOLS.capture, { app: 'Notes' })).contentItems.length, 2, 'asked again in the same run and then allowed')
})

test('a denied app is refused before any card or helper request', async () => {
  const host = fakeHost()
  let asks = 0
  const provider = createComputerObserveProvider({ host, ask: async () => { asks++; return 'accept' } })
  for (const app of ['Terminal', 'com.apple.Terminal', '1Password', 'org.mozilla.firefox', 'Codex']) {
    const response = await call(provider, {}, COMPUTER_OBSERVE_TOOLS.capture, { app })
    assert.equal(parse(response).error.code, 'app_unavailable', app)
  }
  assert.equal(asks, 0)
  assert.deepEqual(host.calls.filter(entry => /^(capture|readElements)/.test(entry)), [])
  assert.equal(parse(await call(provider, {}, COMPUTER_OBSERVE_TOOLS.capture, { app: 'NoSuchApp' })).error.code, 'app_not_found')
})

test('read_elements returns the element list; a sensitive field carries no value', async () => {
  const provider = createComputerObserveProvider({ host: fakeHost(), ask: async () => 'accept' })
  const response = await call(provider, {}, COMPUTER_OBSERVE_TOOLS.readElements, { app: 'Calculator' })
  assert.equal(response.success, true)
  const body = parse(response)
  assert.deepEqual([body.status, body.app, body.count, body.complete, body.sensitiveOmitted], ['elements', 'com.apple.calculator', 2, true, 1])
  assert.deepEqual(body.elements[1], { index: 'e9', role: 'AXTextField', label: 'Password', sensitive: true, rect: { x: 10, y: 80, width: 200, height: 24 }, depth: 2 })
  assert.doesNotMatch(JSON.stringify(body), /must-not-appear/)
})

test('helper failures become closed codes with one fixed hint; no helper text is passed on', async () => {
  const refuse = helperCode => Object.assign(new Error('The host helper refused the request'), { code: 'HOST_AGENT_REFUSED', helperCode, helperMessage: 'ignored /Users/x/secret' })
  for (const [helperCode, expected] of [['permission_missing', 'permission_missing'], ['mask_unavailable', 'mask_unavailable'], ['window_changed', 'window_changed'], ['ambiguous_window', 'ambiguous_window'], ['observe_only', 'content_off']]) {
    const provider = createComputerObserveProvider({ host: fakeHost({ capture: async () => { throw refuse(helperCode) } }), ask: async () => 'accept' })
    const response = await call(provider, {}, COMPUTER_OBSERVE_TOOLS.capture, { app: 'Calculator' })
    const body = parse(response)
    assert.equal(body.effect, 'refused')
    assert.equal(body.error.code, expected)
    assert.doesNotMatch(JSON.stringify(body), /\/Users\/x/)
    if (helperCode === 'permission_missing') assert.match(body.error.hint, /Screen Recording and Accessibility/)
  }
  const down = createComputerObserveProvider({ host: fakeHost({ ready: async () => { throw Object.assign(new Error('x'), { code: 'HOST_AGENT_UNAVAILABLE' }) } }), ask: async () => 'accept' })
  assert.equal(parse(await call(down, {}, COMPUTER_OBSERVE_TOOLS.listApps)).error.code, 'helper_unavailable')
})

test('unknown tools, input tools, extra arguments and other apps\' windows are refused', async () => {
  const host = fakeHost()
  const provider = createComputerObserveProvider({ host, ask: async () => 'accept' })
  for (const tool of ['egdesk_computer_click', 'egdesk_computer_type_text', 'egdesk_computer_key', 'egdesk_computer_scroll', 'egdesk_computer_drag', 'egdesk_computer_nope']) {
    const response = await call(provider, {}, tool, { app: 'Calculator' })
    assert.equal(parse(response).error.code, 'unknown_tool', tool)
  }
  assert.equal(parse(await call(provider, {}, COMPUTER_OBSERVE_TOOLS.capture, { app: 'Calculator', pid: 701 })).error.code, 'invalid_arguments')
  assert.equal(parse(await call(provider, {}, COMPUTER_OBSERVE_TOOLS.capture, {})).error.code, 'invalid_arguments')
  assert.equal(parse(await call(provider, {}, COMPUTER_OBSERVE_TOOLS.listApps, { app: 'x' })).error.code, 'invalid_arguments')
  // window 12 belongs to Notes, not Calculator
  assert.equal(parse(await call(provider, {}, COMPUTER_OBSERVE_TOOLS.capture, { app: 'Calculator', windowId: 12 })).error.code, 'window_not_found')
  assert.deepEqual(host.calls.filter(entry => /^capture/.test(entry)), [])
})

test('nothing in the provider writes pixels anywhere; the adapter record carries metadata only', async () => {
  const source = await readFile(new URL('./egdesk-computer-observe.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /node:fs|writeFile|createWriteStream|appendFile/)
  const records = []
  const provider = createComputerObserveProvider({ host: fakeHost(), ask: async () => 'accept', onRecord: record => records.push(record) })
  await call(provider, {}, COMPUTER_OBSERVE_TOOLS.capture, { app: 'Calculator' })
  assert.ok(records.length >= 1)
  assert.doesNotMatch(JSON.stringify(records), new RegExp(IMAGE))
})

test('screen_capture is closed for the decision model whatever the run permits', () => {
  assert.ok(EGRESS_KINDS.screen_capture)
  const everything = createEgressGate({ ...modelDataPermissions({ browserGranted: true, canvasMaySend: true, runActive: true, workspaceRead: true, threadReply: true, speechConsent: true, topicConsent: true, boardExcerptsToModel: true,
    memoryScope: { allows: () => true } }) })
  assert.equal(everything.allows('screen_capture'), false)
  assert.equal(everything.allows('page_text'), true)
})

test('the host agent asks the helper for content only when made to, with validated integer arguments', async () => {
  assert.deepEqual([...HOST_AGENT_CONTENT_REQUESTS], ['capture', 'readElements'])
  const spawned = []
  const mkAgent = options => createHostAgent({ executable: '/usr/bin/true', spawnDriver: (exe, args) => { spawned.push(args); throw new Error('no spawn in this test') }, ...options })
  const plain = mkAgent({})
  await assert.rejects(plain.capture({ windowId: 1, pid: 2 }), { code: 'HOST_AGENT_INVALID_REQUEST' })
  assert.equal(plain.observesContent, false)
  const content = mkAgent({ observeContent: true })
  assert.equal(content.observesContent, true)
  for (const bad of [{}, { windowId: 1 }, { windowId: -1, pid: 2 }, { windowId: 1, pid: 0 }, { windowId: 1, pid: 2, maxEdge: 10 }, { windowId: 1, pid: 2, extra: 1 }, { windowId: '1', pid: 2 }]) {
    await assert.rejects(content.capture(bad), { code: 'HOST_AGENT_INVALID_REQUEST' })
  }
  await assert.rejects(content.readElements({ windowId: 1, pid: 2, maxEdge: 500 }), { code: 'HOST_AGENT_INVALID_REQUEST' })
  // valid arguments reach the next check: the helper is not running
  await assert.rejects(content.capture({ windowId: 1, pid: 2, maxEdge: 800 }), { code: 'HOST_AGENT_NOT_READY' })
  await assert.rejects(content.readElements({ windowId: 1, pid: 2 }), { code: 'HOST_AGENT_NOT_READY' })
  content.start().catch(() => {})
  plain.start().catch(() => {})
  assert.equal(spawned.length, 2)
  assert.equal(spawned[0].includes('--observe-content'), true, 'content agent starts the helper with --observe-content')
  assert.equal(spawned[1].includes('--observe-content'), false, 'the default agent does not')
})

// ── through the chat runtime: the same catalog for both engines, the card, the Claude gate ─────────────────────────────────────────────────
function harness(provider, { lease = createHostLease({ requireMonitor: false }) } = {}) {
  const calls = [], events = [], replies = []
  let turn = 0, thread = 0
  const defaults = async (method, params) => {
    if (method === 'thread/start') return { thread: { id: `thread-${++thread}` }, cwd: '/work', model: 'configured-model' }
    if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd: '/work' }
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
    if (method === 'config/read') return { config: { developer_instructions: null } }
    if (method === 'turn/start') return { turn: { id: `turn-${++turn}`, status: 'inProgress', items: [] } }
    if (method === 'turn/interrupt') return {}
    throw new Error(`Unexpected method: ${method}`)
  }
  const chat = new CodexChatRuntime({
    request: async (method, params) => { calls.push({ method, params }); return defaults(method, params) },
    respond: (...args) => replies.push(args), emit: event => events.push(event), toolProviders: [provider], hostLease: lease,
    getOwnerKey: () => 'codex:chatgpt:u1-account', setTimer: () => ({}), clearTimer: () => {}, verifyFile: async () => null,
  })
  chat.setConnection(true)
  const ask = (method, params, id) => chat.handleServerRequest({ id, method, params })
  const tick = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve)) }
  return { chat, calls, events, replies, ask, tick }
}

test('through the runtime: Codex gets the four tools, the first look is a card only the person answers, and the same app is not asked twice', async () => {
  const host = fakeHost()
  const provider = createComputerObserveProvider({ host, ask: (run, card) => h.chat.askComputerApp(run, card) })
  const h = harness(provider)
  const run = await h.chat.send({ message: '계산기 창에 뭐가 보이는지 알려줘', requestId: 'u1-1' })
  assert.deepEqual(h.calls.find(entry => entry.method === 'thread/start').params.dynamicTools.map(tool => tool.name).filter(name => name.startsWith('egdesk_computer_')), COMPUTER_OBSERVE_SPECS.map(spec => spec.name))
  const toolCall = (id, tool, args) => h.ask('item/tool/call', { threadId: run.conversationId, turnId: run.runId, callId: id, tool, arguments: args }, id)

  // a read of the app list needs no card
  await toolCall('list', 'egdesk_computer_list_apps', {})
  await h.tick()
  assert.equal(h.replies.at(-1)[0], 'list')
  assert.equal(h.events.some(event => event.event === 'approval.required'), false)

  await toolCall('cap-1', 'egdesk_computer_capture', { app: 'Calculator' })
  await h.tick()
  const cards = h.events.filter(event => event.event === 'approval.required')
  assert.equal(cards.length, 1)
  const card = cards[0].details
  assert.deepEqual([card.kind, card.choices, card.serverName, card.appName, card.fields], ['computerElicitation', ['accept', 'decline'], 'egdesk-computer', 'Calculator', []])
  assert.equal(h.replies.some(reply => reply[0] === 'cap-1'), false, 'nothing is answered until the person answers')
  assert.equal(host.calls.some(entry => entry.startsWith('capture')), false)

  // U2: the screen's own state builder (not the runtime) must allow this card; it did not before (D2 2026-11-26)
  const screen = ChatState.createChatProtocolState()
  for (const event of h.events) ChatState.reduceChatEvent(screen, event, ['codex', 'claude'])
  const screenRun = screen.runs[ChatState.runKey(run.conversationId, run.runId)]
  const request = ChatState.approvalRequestFor(screenRun, card.approvalId, 'accept')
  assert.deepEqual(request, { approvalId: card.approvalId, conversationId: run.conversationId, runId: run.runId, decision: 'accept' })
  const reply = await h.chat.replyApproval(request)
  assert.equal(reply.status, 'replySent')
  await h.tick()
  assert.equal(h.events.some(event => event.event === 'approval.resolved' && event.details.approvalId === card.approvalId), true, 'the answer closes the card')
  assert.equal(h.chat.snapshot().runs[0].pendingApprovals.length, 0)
  const [id, response] = h.replies.find(entry => entry[0] === 'cap-1')
  assert.equal(id, 'cap-1')
  assert.equal(response.success, true)
  assert.deepEqual(response.contentItems.map(item => item.type), ['inputText', 'inputImage'])

  await toolCall('cap-2', 'egdesk_computer_read_elements', { app: 'com.apple.calculator' })
  await h.tick()
  assert.equal(h.events.filter(event => event.event === 'approval.required').length, 1, 'no second card for the same app in this run')
  assert.equal(h.replies.find(entry => entry[0] === 'cap-2')[1].success, true)
  // the stored tool item carries no result content
  assert.doesNotMatch(JSON.stringify(h.chat.snapshot()), new RegExp(IMAGE))
})

test('through the runtime: declining answers the model with a refusal; control off and an Agent limited to nothing never ask', async () => {
  const provider = createComputerObserveProvider({ host: fakeHost(), ask: (run, card) => h.chat.askComputerApp(run, card) })
  const h = harness(provider)
  const run = await h.chat.send({ message: 'Notes 봐 줘', requestId: 'u1-2' })
  const toolCall = (id, tool, args) => h.ask('item/tool/call', { threadId: run.conversationId, turnId: run.runId, callId: id, tool, arguments: args }, id)
  await toolCall('n-1', 'egdesk_computer_capture', { app: 'Notes' })
  await h.tick()
  const card = h.events.find(event => event.event === 'approval.required').details
  await h.chat.replyApproval({ approvalId: card.approvalId, conversationId: run.conversationId, runId: run.runId, decision: 'decline' })
  await h.tick()
  const declined = h.replies.find(entry => entry[0] === 'n-1')[1]
  assert.equal(JSON.parse(declined.contentItems[0].text).error.code, 'app_not_approved')
  assert.equal(JSON.parse(declined.contentItems[0].text).effect, 'refused')

  h.chat.setComputerControlPolicy('off')
  const before = h.events.filter(event => event.event === 'approval.required').length
  await toolCall('n-off', 'egdesk_computer_capture', { app: 'Calculator' })
  assert.deepEqual(h.replies.at(-1), ['n-off', null, { code: -32601, message: 'Computer control is turned off in EG-Desk settings' }])
  assert.equal(h.events.filter(event => event.event === 'approval.required').length, before)
})

test('Claude sees the computer tools only from a provider that declares exposeToClaude (the flag on); everything else about the Claude gate is unchanged', () => {
  const on = harness(createComputerObserveProvider({ host: fakeHost(), ask: async () => 'accept' }))
  const codex = on.chat.collectToolSpecs(null, { engineId: 'codex' }).specs.map(spec => spec.name)
  const claude = on.chat.collectToolSpecs(null, { engineId: 'claude' }).specs.map(spec => spec.name)
  assert.deepEqual(claude, codex, 'the same catalog for both engines')
  assert.deepEqual(claude, COMPUTER_OBSERVE_SPECS.map(spec => spec.name))
  // the same tools served by a provider that does not declare it stay hidden from Claude (the old rule)
  const hidden = harness({ providerId: COMPUTER_PROVIDER_ID, specs: () => COMPUTER_OBSERVE_SPECS, dispatch: async () => null })
  assert.deepEqual(hidden.chat.collectToolSpecs(null, { engineId: 'claude' }).specs, [])
  assert.equal(hidden.chat.collectToolSpecs(null, { engineId: 'codex' }).specs.length, 4)
  // an Agent limited to watching still gets all four (they all read); one limited to nothing gets none
  assert.equal(on.chat.collectToolSpecs(null, { engineId: 'claude', toolCeiling: { browser: 'observe' } }).specs.length, 4)
  assert.deepEqual(on.chat.collectToolSpecs(null, { engineId: 'claude', toolCeiling: { browser: 'none' } }).specs, [])
  // no host lease, no computer tools
  const noLease = new CodexChatRuntime({ request: async () => ({}), respond: () => {}, emit: () => {}, toolProviders: [createComputerObserveProvider({ host: fakeHost(), ask: async () => 'accept' })],
    getOwnerKey: () => 'x', setTimer: () => ({}), clearTimer: () => {}, verifyFile: async () => null })
  assert.deepEqual(noLease.collectToolSpecs(null, { engineId: 'claude' }).specs, [])
})
