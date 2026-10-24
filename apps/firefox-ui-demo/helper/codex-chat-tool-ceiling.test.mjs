import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import {
  TOOL_CEILING_AXES, composeDeveloperInstructions, diffProfileBodies, normalizeProfileBody, normalizeToolCeiling, openProfileStore, profileHash,
} from './egdesk-profile-store.mjs'
import { CEILING_MESSAGES, ceilingApprovalRefusal, effectiveToolCeiling, mergeCeilingOverrides } from './codex-chat-tool-ceiling.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

// AGENT-04: an Agent profile's tool ceiling, from the saved body to the native thread.
const body = (extra = {}) => ({
  name: '리서치', avatar: { kind: 'initial', value: 'R' }, role: '자료 조사 담당',
  personality: { tone: 'concise' }, expertise: ['웹 자료 조사'], instructions: '출처를 붙인다.', ...extra,
})
const OPEN = { browser: 'interact', files: 'write', terminal: 'ask', network: 'on', mcp: 'inherited' }
const RESEARCH = { browser: 'observe', files: 'read', terminal: 'none', network: 'on', mcp: 'inherited' }

function profileStore(t) {
  const dataDir = createPrivateQaTempDirectory('egdesk-ceiling-profile-')
  const profiles = openProfileStore({ dataDir, ownerHash: 'local-desktop-test' })
  t.after(async () => { profiles.close(); await rm(dataDir, { recursive: true, force: true }) })
  const add = (extra = {}) => {
    const created = profiles.createDraft(body(extra))
    profiles.activate(created.id, 1, null)
    return created.id
  }
  return { dataDir, profiles, add }
}

// A native fake whose reported sandbox follows the requested settings, like Codex.
function harness({ profiles, sandboxMode = 'workspace-write', toolProviders, request: custom } = {}) {
  const calls = [], events = [], replies = []
  let threads = 0, turns = 0
  const sandboxFor = params => {
    const mode = params.sandbox || sandboxMode
    if (mode === 'read-only') return { type: 'readOnly', networkAccess: false }
    if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
    return { type: 'workspaceWrite', networkAccess: params.config?.sandbox_workspace_write?.network_access !== false }
  }
  const defaults = async (method, params) => {
    if (method === 'thread/start') return { thread: { id: `thread-${++threads}` }, cwd: '/work', sandbox: sandboxFor(params), approvalPolicy: params.approvalPolicy || 'on-request' }
    if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd: '/work', sandbox: sandboxFor(params), approvalPolicy: params.approvalPolicy || 'on-request' }
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
    if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }
    if (method === 'turn/interrupt') return {}
    if (method === 'config/read') return { config: { sandbox_mode: sandboxMode },
      layers: [{ name: { type: 'user' }, config: { mcp_servers: { 'user-tools': { command: 'user-mcp' } } } }] }
    if (method === 'mcpServerStatus/list') return { data: [
      { name: 'user-tools', tools: params.threadId ? {} : { search: {} }, resources: [], resourceTemplates: [], toolsError: null },
      { name: 'plugin-tools', pluginId: 'user-plugin', tools: params.threadId ? {} : { send: {} }, resources: [], resourceTemplates: [], toolsError: null },
    ], nextCursor: null }
    throw new Error(`Unexpected method: ${method}`)
  }
  const chat = new CodexChatRuntime({
    request: async (method, params) => {
      calls.push({ method, params })
      const answer = custom ? await custom(method, params) : undefined
      return answer !== undefined ? answer : defaults(method, params)
    },
    respond: (...args) => replies.push(args), emit: event => events.push(event), verifyFile: async () => null,
    profiles, toolProviders,
  })
  chat.setConnection(true)
  const approval = (run, id, params) => chat.handleServerRequest({ id, method: 'item/commandExecution/requestApproval',
    params: { threadId: run.conversationId, turnId: run.runId, itemId: `${id}-item`, availableDecisions: ['accept', 'decline', 'cancel'], ...params } })
  const fileApproval = (run, id) => chat.handleServerRequest({ id, method: 'item/fileChange/requestApproval',
    params: { threadId: run.conversationId, turnId: run.runId, itemId: `${id}-item`, availableDecisions: ['accept', 'decline', 'cancel'] } })
  const toolCall = (run, id, tool) => chat.handleServerRequest({ id, method: 'item/tool/call',
    params: { threadId: run.conversationId, turnId: run.runId, callId: `${id}-call`, tool, arguments: { cardId: 'card-1' } } })
  const finish = run => chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn: { id: run.runId, status: 'completed', items: [] } } })
  const ceilingRows = run => chat.snapshot(run.conversationId).runs.find(row => row.runId === run.runId).activities.filter(item => item.kind === 'toolCeiling')
  return { chat, calls, events, replies, approval, fileApproval, toolCall, finish, ceilingRows, started: () => calls.filter(call => call.method === 'thread/start').map(call => call.params) }
}

test('a ceiling is optional, fixed-shape and part of the hash; bodies without one keep their old canonical bytes', () => {
  assert.deepEqual(TOOL_CEILING_AXES.map(item => [item.axis, item.values, item.open]), [
    ['browser', ['none', 'observe', 'interact'], 'interact'], ['files', ['read', 'write'], 'write'],
    ['terminal', ['none', 'ask', 'allow'], 'ask'], ['network', ['off', 'on'], 'on'], ['mcp', ['none', 'inherited'], 'inherited'],
  ])
  // No ceiling: the eight pre-AGENT-04 keys and the same hash as an explicit null.
  assert.deepEqual(Object.keys(normalizeProfileBody(body())), ['name', 'avatar', 'role', 'personality', 'expertise', 'instructions', 'toolPreferences', 'model'])
  assert.equal(profileHash(body({ toolCeiling: null })), profileHash(body()))
  // A partial ceiling fills today's behavior in fixed key order.
  const partial = normalizeProfileBody(body({ toolCeiling: { terminal: 'none', browser: 'observe' } }))
  assert.deepEqual(Object.keys(partial).at(-1), 'toolCeiling')
  assert.deepEqual(Object.keys(partial.toolCeiling), ['browser', 'files', 'terminal', 'network', 'mcp'])
  assert.deepEqual(partial.toolCeiling, { ...OPEN, browser: 'observe', terminal: 'none' })
  assert.equal(profileHash(body({ toolCeiling: { mcp: 'inherited', browser: 'observe', terminal: 'none' } })), profileHash(body({ toolCeiling: { terminal: 'none', browser: 'observe' } })))
  assert.notEqual(profileHash(body({ toolCeiling: OPEN })), profileHash(body()))
  assert.notEqual(profileHash(body({ toolCeiling: RESEARCH })), profileHash(body({ toolCeiling: { ...RESEARCH, network: 'off' } })))
  for (const bad of [{ browser: 'click' }, { files: 'delete' }, { terminal: true }, { shell: 'none' }, ['none'], 'read-only', { network: 'OFF' }]) {
    assert.throws(() => normalizeProfileBody(body({ toolCeiling: bad })), error => error.code === 'INVALID_PROFILE', JSON.stringify(bad))
  }
  assert.equal(normalizeToolCeiling(undefined), null)
  assert.deepEqual(diffProfileBodies(body(), body({ toolCeiling: { files: 'read' } })), [{ field: 'toolCeiling', before: null, after: { ...OPEN, files: 'read' } }])
})

test('composed instructions name only narrowed tools; no ceiling or an open one composes as before', () => {
  const plain = composeDeveloperInstructions(body())
  assert.equal(composeDeveloperInstructions(body({ toolCeiling: OPEN })), plain)
  assert.equal(plain.includes('# 쓸 수 있는 도구'), false)
  const research = composeDeveloperInstructions(body({ toolCeiling: { ...RESEARCH, network: 'off', mcp: 'none' } }))
  assert.match(research, /# 쓸 수 있는 도구\n- 브라우저는 보기만 하고 클릭·입력·이동은 하지 않는다\.\n- 파일은 읽기만 하고 만들거나 고치지 않는다\.\n- 터미널 명령은 실행하지 않는다\.\n- 인터넷에 연결하지 않는다\.\n- 연결된 외부 도구\(MCP\)는 쓰지 않는다\.\n\n# 사용자 지침/)
})

test('a revision saved before AGENT-04 reads as no ceiling and re-saving it unchanged makes no revision', t => {
  const { dataDir, profiles } = profileStore(t)
  const created = profiles.createDraft(body())
  profiles.activate(created.id, 1, null)
  // The stored bytes have no toolCeiling key at all, exactly like an older row.
  const raw = new DatabaseSync(path.join(dataDir, `profiles-${profiles.ownerHash}.sqlite`))
  t.after(() => raw.close())
  assert.equal(raw.prepare('SELECT body_json FROM profile_revisions WHERE profile_id=?').get(created.id).body_json.includes('toolCeiling'), false)
  assert.equal(profiles.runProfile(created.id).toolCeiling, null)
  assert.equal(Object.hasOwn(profiles.getRevision(created.id, 1).body, 'toolCeiling'), false)
  assert.deepEqual([profiles.saveDraft(created.id, body({ toolCeiling: null }), 1).unchanged, profiles.get(created.id).headRevision], [true, 1])
  const narrowed = profiles.saveDraft(created.id, body({ toolCeiling: { terminal: 'allow', files: 'read' } }), 1)
  profiles.activate(created.id, narrowed.revision, 1)
  // The store keeps the declared value; the runtime decides how 'allow' runs.
  assert.deepEqual(profiles.runProfile(created.id).toolCeiling, { ...OPEN, files: 'read', terminal: 'allow' })
  assert.equal(profiles.runProfile(created.id, 1).toolCeiling, null)
})

test('runtime: terminal allow runs as ask (no automatic approval); approval matrix per axis', () => {
  assert.deepEqual(effectiveToolCeiling({ terminal: 'allow' }), OPEN)
  assert.equal(effectiveToolCeiling(null), null)
  assert.throws(() => effectiveToolCeiling({ terminal: 'sudo' }), error => error.code === 'INVALID_PROFILE' && error.httpStatus === 500)
  const refuse = (ceiling, request) => ceilingApprovalRefusal({ ...OPEN, ...ceiling }, request)?.axis ?? null
  assert.equal(refuse({}, { kind: 'commandExecution' }), null)
  assert.equal(refuse({ terminal: 'none' }, { kind: 'commandExecution' }), 'terminal')
  assert.equal(refuse({ files: 'read' }, { kind: 'commandExecution' }), 'files')
  assert.equal(refuse({ network: 'off' }, { kind: 'commandExecution' }), 'network')
  assert.equal(refuse({ files: 'read' }, { kind: 'fileChange' }), 'files')
  assert.equal(refuse({ terminal: 'none' }, { kind: 'fileChange' }), null)
  assert.equal(refuse({ network: 'off' }, { kind: 'commandExecution', network: true }), 'network')
  assert.equal(refuse({ terminal: 'none', files: 'read' }, { kind: 'commandExecution', network: true }), null)
  assert.equal(ceilingApprovalRefusal(null, { kind: 'commandExecution' }), null)
  const merged = mergeCeilingOverrides({ sandbox: undefined, config: { features: { default_mode_request_user_input: true }, web_search: 'live' } },
    { sandbox: 'read-only', config: { features: { shell_tool: false }, web_search: 'disabled' } })
  assert.deepEqual(merged, { sandbox: 'read-only', config: { features: { default_mode_request_user_input: true, shell_tool: false }, web_search: 'disabled' } })
})

test('a profile without a ceiling runs exactly as before: no sandbox, config or MCP calls and no run ceiling', async t => {
  const p = profileStore(t)
  const id = p.add()
  const h = harness({ profiles: p.profiles })
  const run = await h.chat.send({ message: 'Hi', profileId: id })
  assert.deepEqual(Object.keys(h.started()[0]).sort(), ['config', 'developerInstructions'])
  assert.deepEqual(h.started()[0].config, { features: { default_mode_request_user_input: true } })
  assert.equal(h.calls.some(call => ['config/read', 'mcpServerStatus/list'].includes(call.method)), false)
  assert.equal(Object.hasOwn(run, 'toolCeiling'), false)
  assert.equal(Object.hasOwn(h.chat.snapshot().runs[0], 'toolCeiling'), false)
  assert.deepEqual(Object.keys(h.events.find(event => event.event === 'run.started').details), ['status', 'profileBinding'])
  await h.approval(run, 'cmd-plain', { command: 'npm test' })
  assert.ok(h.events.some(event => event.event === 'approval.required'))
  assert.deepEqual(h.replies, [])
})

test('files read narrows the thread to the read-only sandbox and declines file-change and escalated-command approvals', async t => {
  const p = profileStore(t)
  const id = p.add({ toolCeiling: { files: 'read' } })
  const h = harness({ profiles: p.profiles })
  const run = await h.chat.send({ message: 'Summarize the repo', profileId: id })
  assert.equal(h.started()[0].sandbox, 'read-only')
  assert.deepEqual(run.toolCeiling, { ...OPEN, files: 'read' })
  assert.deepEqual(h.events.find(event => event.event === 'run.started').details.toolCeiling, { ...OPEN, files: 'read' })
  await h.fileApproval(run, 'patch-1')
  await h.approval(run, 'cmd-1', { command: 'touch notes.md' })
  assert.deepEqual(h.replies, [['patch-1', { decision: 'decline' }], ['cmd-1', { decision: 'decline' }]])
  assert.equal(h.events.some(event => event.event === 'approval.required'), false)
  assert.deepEqual(h.ceilingRows(run).map(row => [row.title, row.status, row.detail.axis, row.detail.limit]), [
    [CEILING_MESSAGES.files, 'declined', 'files', 'read'], [CEILING_MESSAGES.files, 'declined', 'files', 'read'],
  ])
  // A normal decline: the turn continues, nothing is interrupted or marked failed.
  assert.equal(h.calls.some(call => call.method === 'turn/interrupt'), false)
  assert.equal(h.chat.snapshot().runs[0].error, null)
  assert.equal(h.chat.snapshot().runs[0].status, 'inProgress')
})

test('a native thread that does not confirm the narrowed sandbox never starts a turn', async t => {
  const p = profileStore(t)
  const id = p.add({ toolCeiling: { files: 'read' } })
  const h = harness({ profiles: p.profiles, request: async method => method === 'thread/start' ? { thread: { id: 'wide-thread' }, cwd: '/work', sandbox: { type: 'workspaceWrite', networkAccess: true }, approvalPolicy: 'on-request' } : undefined })
  await assert.rejects(h.chat.send({ message: 'Hi', profileId: id }), error => error.code === 'PROFILE_CEILING_UNVERIFIED' && error.httpStatus === 502)
  assert.equal(h.calls.some(call => call.method === 'turn/start'), false)
})

test('terminal none removes the shell tool and declines command approvals with an activity, not a card', async t => {
  const p = profileStore(t)
  const id = p.add({ toolCeiling: { terminal: 'none' } })
  const h = harness({ profiles: p.profiles })
  const run = await h.chat.send({ message: 'Check the build', profileId: id })
  assert.equal(h.started()[0].config.features.shell_tool, false)
  assert.equal(h.started()[0].config.features.default_mode_request_user_input, true)
  assert.equal(Object.hasOwn(h.started()[0], 'sandbox'), false)
  await h.approval(run, 'cmd-1', { command: 'npm run build', cwd: '/work' })
  assert.deepEqual(h.replies, [['cmd-1', { decision: 'decline' }]])
  const [row] = h.ceilingRows(run)
  assert.equal(row.title, '이 Agent는 터미널 명령이 허용되지 않습니다')
  assert.deepEqual(row.detail, { axis: 'terminal', limit: 'none', command: 'npm run build' })
  assert.ok(h.events.some(event => event.event === 'activity.completed' && event.details.id === row.id))
  assert.equal(h.events.some(event => event.event === 'approval.required' || event.event === 'run.unavailable'), false)
})

test('terminal allow is not automatic approval: it runs as ask and still shows the approval card', async t => {
  const p = profileStore(t)
  const id = p.add({ toolCeiling: { terminal: 'allow' } })
  const h = harness({ profiles: p.profiles })
  const run = await h.chat.send({ message: 'Run tests', profileId: id })
  assert.deepEqual(run.toolCeiling, OPEN)
  assert.equal(Object.hasOwn(h.started()[0], 'sandbox'), false)
  await h.approval(run, 'cmd-1', { command: 'npm test' })
  assert.deepEqual(h.replies, [])
  assert.ok(h.events.some(event => event.event === 'approval.required'))
})

test('an approval card is refused when the run ceiling forbids it, even if the card exists', async t => {
  const p = profileStore(t)
  const id = p.add({ toolCeiling: { browser: 'observe' } })
  const h = harness({ profiles: p.profiles })
  const run = await h.chat.send({ message: 'Run tests', profileId: id })
  await h.approval(run, 'cmd-1', { command: 'npm test' })
  const card = h.events.find(event => event.event === 'approval.required').details
  h.chat.runs.get(`${run.conversationId}/${run.runId}`).toolCeiling.terminal = 'none'
  await assert.rejects(h.chat.replyApproval({ approvalId: card.approvalId, conversationId: run.conversationId, runId: run.runId, decision: 'accept' }), error => error.code === 'PROFILE_CEILING_FORBIDDEN' && error.httpStatus === 403)
  assert.deepEqual(h.replies, [])
})

test('network off disables web search and sandbox network, narrows full access, never widens read-only, and declines network approvals', async t => {
  const p = profileStore(t)
  const id = p.add({ toolCeiling: { network: 'off' } })
  const full = harness({ profiles: p.profiles, sandboxMode: 'danger-full-access' })
  const run = await full.chat.send({ message: 'Read docs', profileId: id })
  const start = full.started()[0]
  assert.equal(start.sandbox, 'workspace-write')
  assert.equal(start.config.web_search, 'disabled')
  assert.deepEqual(start.config.sandbox_workspace_write, { network_access: false })
  assert.deepEqual(full.calls.find(call => call.method === 'config/read').params, { includeLayers: false, cwd: null })
  await full.approval(run, 'net-1', { command: 'curl https://example.com', networkApprovalContext: { host: 'example.com', protocol: 'https' } })
  await full.approval(run, 'esc-1', { command: 'pip install requests' })
  assert.deepEqual(full.replies, [['net-1', { decision: 'decline' }], ['esc-1', { decision: 'decline' }]])
  assert.deepEqual(full.ceilingRows(run).map(row => row.title), [CEILING_MESSAGES.network, CEILING_MESSAGES.network])

  const readOnly = harness({ profiles: p.profiles, sandboxMode: 'read-only' })
  await readOnly.chat.send({ message: 'Read docs', profileId: id })
  assert.equal(readOnly.started()[0].sandbox, 'read-only')

  const unset = harness({ profiles: p.profiles, sandboxMode: null })
  await unset.chat.send({ message: 'Read docs', profileId: id })
  assert.equal(Object.hasOwn(unset.started()[0], 'sandbox'), false)

  // A native default that still reports full access fails closed.
  const reportsFull = harness({ profiles: p.profiles, sandboxMode: null, request: async method => method === 'thread/start' ? { thread: { id: 'full' }, cwd: '/work', sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'on-request' } : undefined })
  await assert.rejects(reportsFull.chat.send({ message: 'Read docs', profileId: id }), error => error.code === 'PROFILE_CEILING_UNVERIFIED')
  assert.equal(reportsFull.calls.some(call => call.method === 'turn/start'), false)
})

test('mcp none turns off the inherited MCP servers on that thread and checks the thread catalog is empty', async t => {
  const p = profileStore(t)
  const id = p.add({ toolCeiling: { mcp: 'none' } })
  const h = harness({ profiles: p.profiles })
  const run = await h.chat.send({ message: 'Plan the week', profileId: id })
  const start = h.started()[0]
  assert.deepEqual({ ...start.config.mcp_servers }, { 'user-tools': { enabled: false } })
  assert.deepEqual({ ...start.config.plugins }, { 'user-plugin': { enabled: false } })
  assert.equal(start.config.features.apps, false)
  const checked = h.calls.filter(call => call.method === 'mcpServerStatus/list')
  assert.deepEqual(checked.map(call => call.params.threadId ?? null), [null, run.conversationId])
  assert.ok(h.calls.indexOf(checked[1]) < h.calls.findIndex(call => call.method === 'turn/start'))

  const leaky = harness({ profiles: p.profiles, request: async (method, params) => method === 'mcpServerStatus/list' && params.threadId
    ? { data: [{ name: 'user-tools', tools: { search: {} }, resources: [], resourceTemplates: [], toolsError: null }], nextCursor: null } : undefined })
  await assert.rejects(leaky.chat.send({ message: 'Plan the week', profileId: id }), error => error.code === 'PROFILE_CEILING_UNVERIFIED')
  assert.equal(leaky.calls.some(call => call.method === 'turn/start'), false)
  const noConfig = harness({ profiles: p.profiles, request: async method => method === 'config/read' ? { config: {}, layers: null } : undefined })
  await assert.rejects(noConfig.chat.send({ message: 'Plan the week', profileId: id }), error => error.code === 'PROFILE_CEILING_UNAVAILABLE')
  assert.equal(noConfig.calls.some(call => call.method === 'thread/start'), false)
})

// Browser tools appear only in bounded runs; a stand-in provider records what it was granted.
function browserProvider(log) {
  const spec = name => ({ type: 'function', name, description: name, inputSchema: { type: 'object' } })
  return {
    providerId: 'egdesk-browser',
    prepare(input) {
      log.push(['prepare', (input.selectedSources || []).map(source => source.browserToolPermission)])
      if (!input.selectedSources?.length) return null
      const permission = input.selectedSources.some(source => source.browserToolPermission === 'interact') ? 'interact' : 'observe'
      return { permission, interactionRequested: input.effectiveExecutionPolicy === 'browserBounded' && permission === 'interact' }
    },
    specs: () => ['egdesk_browser_observe', 'egdesk_browser_click', 'egdesk_browser_fill'].map(spec),
    requireThread() {}, registerThread(threadId) { log.push(['register', threadId]) },
    async bindRun(run, prepared) { if (prepared) run.browserBinding = { cards: [{ cardId: 'card-1', permission: prepared.permission }] } },
    async dispatch(run, event) { log.push(['dispatch', event.tool]); return { success: true, contentItems: [{ type: 'inputText', text: 'ok' }] } },
  }
}
const selection = permission => [{ id: 'source-1', kind: 'browser', selectedByUser: true, browserToolPermission: permission,
  browserToolSelection: { token: 'one-time', threadId: 'ui-browser' }, sourceRef: { viewId: 'card-1', profileId: 'firefox-default', accountId: '', uri: 'https://example.test/' } }]

test('browser observe wins over a Card interaction grant: observe-only grant, catalog and calls', async t => {
  const p = profileStore(t)
  const id = p.add({ toolCeiling: { browser: 'observe' } })
  const log = []
  const h = harness({ profiles: p.profiles, toolProviders: [browserProvider(log)] })
  const run = await h.chat.send({ message: 'Look at this page', clientThreadId: 'ui-browser', profileId: id, executionPolicy: { mode: 'browserBounded' }, selectedSources: selection('interact') })
  assert.deepEqual(log[0], ['prepare', ['observe']])
  assert.deepEqual(h.started()[0].dynamicTools.map(spec => spec.name), ['egdesk_browser_observe'])
  // QA isolation stays; the ceiling only adds native browser and desktop switches.
  assert.equal(h.started()[0].sandbox, 'read-only')
  assert.equal(h.started()[0].config.features.plugins, false)
  assert.deepEqual([h.started()[0].config.features.browser_use, h.started()[0].config.features.browser_use_external, h.started()[0].config.features.computer_use], [false, false, false])
  assert.equal(run.executionPolicy.browserEffects, 'observe-only-selected-card')
  assert.equal(h.chat.snapshot().runs[0].browserBinding.cards[0].permission, 'observe')
  assert.deepEqual(h.ceilingRows(run).map(row => row.title), [CEILING_MESSAGES.browserDowngraded])
  await h.toolCall(run, 'click-1', 'egdesk_browser_click')
  assert.equal(h.replies.at(-1)[0], 'click-1')
  assert.equal(h.replies.at(-1)[2].code, -32601)
  assert.equal(log.some(entry => entry[0] === 'dispatch'), false)
})

test('browser none drops the Browser grant, offers no Browser tools and refuses a Browser call the mode would allow', async t => {
  const p = profileStore(t)
  const id = p.add({ toolCeiling: { browser: 'none' } })
  const log = []
  const h = harness({ profiles: p.profiles, toolProviders: [browserProvider(log)] })
  const run = await h.chat.send({ message: 'Look at this page', clientThreadId: 'ui-browser', profileId: id, executionPolicy: { mode: 'readOnlyQa' }, selectedSources: selection('observe') })
  assert.equal(log.some(entry => entry[0] === 'prepare'), false)
  assert.equal((h.started()[0].dynamicTools || []).some(spec => spec.name.startsWith('egdesk_browser_')), false)
  assert.equal(Object.hasOwn(h.chat.snapshot().runs[0], 'browserBinding'), false)
  await h.toolCall(run, 'observe-1', 'egdesk_browser_observe')
  assert.deepEqual(h.replies.at(-1), ['observe-1', null, { code: -32601, message: 'This Agent profile does not allow the requested Browser tool' }])
  assert.deepEqual(h.ceilingRows(run).map(row => [row.title, row.detail.limit]), [
    [CEILING_MESSAGES.browserDropped, 'none'], [CEILING_MESSAGES.browserNone, 'none'],
  ])
  assert.equal(h.ceilingRows(run)[1].detail.tool, 'egdesk_browser_observe')
})

test('a newly activated revision with another ceiling is re-applied to the same thread on the next send', async t => {
  const p = profileStore(t)
  const id = p.add({ toolCeiling: { terminal: 'none' } })
  const h = harness({ profiles: p.profiles })
  const first = await h.chat.send({ message: 'First', profileId: id })
  assert.equal(h.started()[0].config.features.shell_tool, false)
  await h.finish(first)
  const second = p.profiles.saveDraft(id, body({ toolCeiling: { files: 'read', network: 'off' } }), 1)
  p.profiles.activate(id, second.revision, 1)
  const next = await h.chat.send({ message: 'Next', conversationId: first.conversationId, profileId: id })
  assert.equal(next.conversationId, first.conversationId)
  const resumed = h.calls.filter(call => call.method === 'thread/resume').at(-1).params
  assert.ok(h.calls.findIndex(call => call.method === 'thread/unsubscribe') < h.calls.lastIndexOf(h.calls.filter(call => call.method === 'thread/resume').at(-1)))
  assert.equal(resumed.sandbox, 'read-only')
  assert.equal(resumed.config.web_search, 'disabled')
  assert.equal(Object.hasOwn(resumed.config.features, 'shell_tool'), false)
  assert.deepEqual(next.toolCeiling, { ...OPEN, files: 'read', network: 'off' })
  assert.deepEqual(next.profileBinding.revision, 2)
  // The run-time checks follow the new run's ceiling: a command card is now refused for files, not terminal.
  await h.approval(next, 'cmd-2', { command: 'make' })
  assert.deepEqual(h.ceilingRows(next).map(row => row.detail.axis), ['files'])
  assert.deepEqual(h.chat.snapshot(first.conversationId).runs.map(run => run.toolCeiling.terminal), ['none', 'ask'])
})

test('an engine that cannot apply Codex thread settings refuses a narrowing ceiling before anything is sent', async t => {
  const p = profileStore(t)
  const narrowed = p.add({ toolCeiling: { terminal: 'none' } })
  const open = p.add({ name: '열림', toolCeiling: { terminal: 'allow' } })
  const calls = []
  const codex = createCodexEngineAdapter({ request: async (method, params) => { calls.push(['codex', method]); return method === 'thread/start' ? { thread: { id: 'c-1' }, cwd: '/work' } : { turn: { id: 'c-t', status: 'inProgress', items: [] } } }, respond: () => {} })
  const other = {
    id: 'claude', describe: () => ({ id: 'claude', status: 'ready', version: '1', profiles: [] }), refresh: async () => ({}),
    capabilities: () => new Set(['stream', 'resume', 'interrupt']), ownerKey: () => 'claude-account', isReady: () => true,
    startThread: async () => { calls.push(['claude', 'thread/start']); return { thread: { id: 'x-1' }, cwd: '/work' } },
    resumeThread: async () => ({}), releaseThread: async () => ({ status: 'unsubscribed' }),
    startTurn: async () => { calls.push(['claude', 'turn/start']); return { turn: { id: 'x-t', status: 'inProgress', items: [] } } },
    interruptTurn: async () => ({}), respond: () => true, subscribe: () => () => {}, dispose: async () => {},
  }
  const chat = new CodexChatRuntime({ engines: [codex, other], profiles: p.profiles })
  chat.setConnection(true)
  chat.setConnection('claude', true)
  await assert.rejects(chat.send({ message: 'Hi', engineId: 'claude', profileId: narrowed }), error => error.code === 'PROFILE_CEILING_UNSUPPORTED' && error.httpStatus === 409)
  assert.deepEqual(calls, [])
  // A ceiling that narrows nothing still runs on that engine.
  const run = await chat.send({ message: 'Hi', engineId: 'claude', profileId: open })
  assert.deepEqual(run.toolCeiling, OPEN)
})

test('the run ceiling and its refusals are kept in local history and restored with the run', async t => {
  const p = profileStore(t)
  const id = p.add({ toolCeiling: RESEARCH })
  const dataDir = createPrivateQaTempDirectory('egdesk-ceiling-history-')
  const store = openChatStore({ dataDir, ownerScope: 'local-desktop-test' })
  t.after(async () => { store.close(); await rm(dataDir, { recursive: true, force: true }) })
  const replies = []
  const make = () => {
    const chat = new CodexChatRuntime({
      store, requireStore: true, getOwnerKey: () => 'codex:chatgpt:account-1', respond: (...args) => replies.push(args), profiles: p.profiles,
      request: async (method, params) => {
        if (method === 'thread/start') return { thread: { id: 'native-ceiling' }, cwd: '/work', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request' }
        if (method === 'turn/start') return { turn: { id: 'turn-ceiling', status: 'inProgress', items: [] } }
        throw new Error(`Unexpected native call: ${method}`)
      },
    })
    chat.setConnection(true)
    return chat
  }
  const chat = make()
  const run = await chat.send({ message: 'Research', requestId: 'ceiling-1', clientThreadId: 'ui-ceiling', profileId: id })
  await chat.handleServerRequest({ id: 'cmd-1', method: 'item/commandExecution/requestApproval', params: { threadId: run.conversationId, turnId: run.runId, itemId: 'cmd-item', command: 'ls', availableDecisions: ['accept', 'decline'] } })
  const history = chat.getLocalHistory({ clientThreadId: 'ui-ceiling' })
  const saved = history.runs.find(row => row.runId === run.runId)
  assert.deepEqual(saved.toolCeiling, RESEARCH)
  assert.deepEqual(saved.activities.filter(row => row.kind === 'toolCeiling').map(row => row.title), [CEILING_MESSAGES.terminal])
  // A runtime that only sees the native turn restores the recorded ceiling and keeps refusing.
  const restored = make()
  restored.threads.set(run.conversationId, { id: run.conversationId, clientThreadId: 'ui-ceiling' })
  assert.deepEqual(restored.ensureRun(run.conversationId, run.runId, null, false).toolCeiling, RESEARCH)
  assert.deepEqual(replies, [['cmd-1', { decision: 'decline' }]])
})
