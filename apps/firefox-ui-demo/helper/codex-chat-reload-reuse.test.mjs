// L7 c27: the Agent-profile DM's per-turn detach + resume is skipped when nothing its resume depends on changed (flag agentReloadReuse, default off;
// bridge EGDESK_AGENT_RELOAD_REUSE=on). AGENT-04: the ceiling is still verified on every turn, and any change of the resume parameters
// (ceiling, profile instructions, the engine's configuration the overrides are read from, computer control), a restart or a failed verification reloads.
// The harness is a trimmed copy of codex-chat-tool-ceiling.test.mjs's: a native fake whose sandbox, features and MCP catalog follow the thread settings.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { normalizeProfileBody, openProfileStore } from './egdesk-profile-store.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { OWN_TOOLS_INSTRUCTIONS } from './egdesk-own-tools-isolation.mjs'

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

// Feature switches a ceiling turns off; Codex reports them per thread.
const CEILING_FEATURES = ['shell_tool', 'browser_use', 'browser_use_external', 'computer_use']
const featureList = values => ({ data: CEILING_FEATURES.map(name => ({ name, enabled: values[name] ?? true, stage: 'stable' })), nextCursor: null })
// Servers as Codex 0.162.1 listed them: its computer-use plugin (cua_repl) and
// a browser server the user added under mcp_servers.
const COMPUTER_PLUGIN = 'unified-computer-use@openai-bundled'
const computerServers = [
  { name: 'cua_repl', pluginId: COMPUTER_PLUGIN, tools: { js: {}, js_reset: {}, turn_ended: {} } },
  { name: 'firefox-devtools', tools: { navigate_page: {}, take_snapshot: {} } },
]

// A native fake whose reported sandbox, feature switches and MCP catalog follow
// the requested thread settings, like Codex: a turned-off plugin's server is
// gone from that thread's list; other servers stay connected.
function harness({ profiles, sandboxMode = 'workspace-write', toolProviders, request: custom, servers = [], agentReloadReuse = false, ownTools = null } = {}) {
  const calls = [], events = [], replies = []
  let threads = 0, turns = 0
  const threadConfig = new Map()
  const sandboxFor = params => {
    const mode = params.sandbox || sandboxMode
    if (mode === 'read-only') return { type: 'readOnly', networkAccess: false }
    if (mode === 'danger-full-access') return { type: 'dangerFullAccess' }
    return { type: 'workspaceWrite', networkAccess: params.config?.sandbox_workspace_write?.network_access !== false }
  }
  const defaults = async (method, params) => {
    if (method === 'thread/start') {
      const id = `thread-${++threads}`
      threadConfig.set(id, params.config || {})
      return { thread: { id }, cwd: '/work', sandbox: sandboxFor(params), approvalPolicy: params.approvalPolicy || 'on-request' }
    }
    if (method === 'thread/resume') {
      threadConfig.set(params.threadId, params.config || {})
      return { thread: { id: params.threadId, turns: [] }, cwd: '/work', sandbox: sandboxFor(params), approvalPolicy: params.approvalPolicy || 'on-request' }
    }
    if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
    if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }
    if (method === 'turn/interrupt') return {}
    if (method === 'config/read') return { config: { sandbox_mode: sandboxMode },
      layers: [{ name: { type: 'user' }, config: { mcp_servers: { 'user-tools': { command: 'user-mcp' }, ...Object.fromEntries(servers.filter(server => !server.pluginId).map(server => [server.name, { command: server.name }])) } } }] }
    if (method === 'experimentalFeature/list') return featureList(params.threadId ? threadConfig.get(params.threadId)?.features || {} : {})
    if (method === 'mcpServerStatus/list') {
      const config = params.threadId ? threadConfig.get(params.threadId) || {} : null
      const listed = [
        { name: 'user-tools', tools: params.threadId ? {} : { search: {} }, resources: [], resourceTemplates: [], toolsError: null },
        { name: 'plugin-tools', pluginId: 'user-plugin', tools: params.threadId ? {} : { send: {} }, resources: [], resourceTemplates: [], toolsError: null },
      ]
      for (const server of servers) {
        if (config && server.pluginId && (config.plugins?.[server.pluginId]?.enabled === false || config.features?.plugins === false)) continue
        const off = config && !server.pluginId && config.mcp_servers?.[server.name]?.enabled === false
        listed.push({ ...server, tools: off ? {} : server.tools, resources: [], resourceTemplates: [], toolsError: null, ...(config ? { runtimeStatus: off ? 'disabled' : 'connected' } : {}) })
      }
      return { data: listed, nextCursor: null }
    }
    throw new Error(`Unexpected method: ${method}`)
  }
  const chat = new CodexChatRuntime({
    request: async (method, params) => {
      calls.push({ method, params })
      const answer = custom ? await custom(method, params) : undefined
      return answer !== undefined ? answer : defaults(method, params)
    },
    respond: (...args) => replies.push(args), emit: event => events.push(event), verifyFile: async () => null,
    profiles, toolProviders, agentReloadReuse, ...(ownTools ? { ownTools } : {}),
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


const reloads = (h, from) => h.calls.slice(from).filter(call => call.method === 'thread/unsubscribe').length
const resumes = (h, from) => h.calls.slice(from).filter(call => call.method === 'thread/resume').length
const verifies = (h, from, thread) => h.calls.slice(from).filter(call => call.method === 'experimentalFeature/list' && call.params.threadId === thread).length
async function turn(h, id, conversationId, message = 'next', extra = {}) {
  const from = h.calls.length
  const run = await h.chat.send({ message, profileId: id, ...(conversationId ? { conversationId } : {}), ...extra })
  await h.finish(run)
  return { run, from }
}
const TERMINAL_NONE = { terminal: 'none' }

test('flag on: the first send after the thread start reloads once (nothing is known yet); later turns with the same settings neither detach nor resume, and the ceiling is verified on every turn', async t => {
  const p = profileStore(t), id = p.add({ toolCeiling: TERMINAL_NONE })
  const h = harness({ profiles: p.profiles, agentReloadReuse: true })
  const t1 = await turn(h, id, null, 'first'), cid = t1.run.conversationId
  const t2 = await turn(h, id, cid)
  assert.deepEqual([reloads(h, t2.from), resumes(h, t2.from)], [1, 1], 'the start recorded nothing to compare with')
  for (const n of [3, 4, 5]) {
    const t = await turn(h, id, cid)
    assert.deepEqual([reloads(h, t.from), resumes(h, t.from)], [0, 0], `turn ${n}: unchanged settings`)
    assert.ok(verifies(h, t.from, cid) >= 1, `turn ${n}: the thread's features are read and checked again`)
    assert.ok(h.calls.slice(t.from).some(call => call.method === 'turn/start'))
  }
})

test('flag off (default): every turn detaches and resumes, as before', async t => {
  const p = profileStore(t), id = p.add({ toolCeiling: TERMINAL_NONE })
  const h = harness({ profiles: p.profiles })
  const t1 = await turn(h, id, null, 'first'), cid = t1.run.conversationId
  for (let n = 2; n <= 4; n++) { const x = await turn(h, id, cid); assert.deepEqual([reloads(h, x.from), resumes(h, x.from)], [1, 1], `turn ${n}`) }
})

test('a newly activated revision with another ceiling reloads, is verified under the new ceiling, and is reused afterwards', async t => {
  const p = profileStore(t), id = p.add({ toolCeiling: TERMINAL_NONE })
  const h = harness({ profiles: p.profiles, agentReloadReuse: true })
  const t1 = await turn(h, id, null, 'first'), cid = t1.run.conversationId
  await turn(h, id, cid); const steady = await turn(h, id, cid)
  assert.equal(resumes(h, steady.from), 0)
  const second = p.profiles.saveDraft(id, body({ toolCeiling: { files: 'read', network: 'off' } }), 1)
  p.profiles.activate(id, second.revision, 1)
  const changed = await turn(h, id, cid)
  assert.deepEqual([reloads(h, changed.from), resumes(h, changed.from)], [1, 1])
  const params = h.calls.slice(changed.from).find(call => call.method === 'thread/resume').params
  assert.equal(params.sandbox, 'read-only'); assert.equal(params.config.web_search, 'disabled')
  assert.deepEqual(changed.run.toolCeiling, { ...OPEN, files: 'read', network: 'off' })
  const after = await turn(h, id, cid)
  assert.equal(resumes(h, after.from), 0, 'the new settings are reused')
})

test('the same ceiling but other profile instructions (a new revision) reloads: the instructions are part of what the resume sends', async t => {
  const p = profileStore(t), id = p.add({ toolCeiling: TERMINAL_NONE })
  const h = harness({ profiles: p.profiles, agentReloadReuse: true })
  const t1 = await turn(h, id, null, 'first'), cid = t1.run.conversationId
  await turn(h, id, cid); assert.equal(resumes(h, (await turn(h, id, cid)).from), 0)
  const next = p.profiles.saveDraft(id, body({ toolCeiling: TERMINAL_NONE, instructions: '다른 지침: 짧게 답한다.' }), 1)
  p.profiles.activate(id, next.revision, 1)
  const changed = await turn(h, id, cid)
  assert.equal(resumes(h, changed.from), 1)
  assert.match(JSON.stringify(h.calls.slice(changed.from).find(call => call.method === 'thread/resume').params), /다른 지침/)
})

test('an MCP server the engine lists now (the overrides disable servers by what it lists) changes the resume: reload', async t => {
  const servers = []
  const p = profileStore(t), id = p.add({ toolCeiling: { mcp: 'none' } })
  const h = harness({ profiles: p.profiles, agentReloadReuse: true, servers })
  const t1 = await turn(h, id, null, 'first'), cid = t1.run.conversationId
  await turn(h, id, cid); assert.equal(resumes(h, (await turn(h, id, cid)).from), 0)
  servers.push({ name: 'new-server', tools: { go: {} } }) // installed after the thread was loaded
  const changed = await turn(h, id, cid)
  assert.equal(resumes(h, changed.from), 1)
  assert.equal(h.calls.slice(changed.from).find(call => call.method === 'thread/resume').params.config.mcp_servers['new-server'].enabled, false)
})

test('a restart (nothing loaded in the process) loads the thread again and the first turn after it reloads once more before reuse', async t => {
  const p = profileStore(t), id = p.add({ toolCeiling: TERMINAL_NONE })
  const h = harness({ profiles: p.profiles, agentReloadReuse: true })
  const t1 = await turn(h, id, null, 'first'), cid = t1.run.conversationId
  await turn(h, id, cid); assert.equal(resumes(h, (await turn(h, id, cid)).from), 0)
  h.chat.loadedThreads.clear(); h.chat.threads.clear()
  const restarted = await turn(h, id, cid)
  assert.ok(resumes(h, restarted.from) >= 1)
  assert.ok(verifies(h, restarted.from, cid) >= 1, 'verified after the load')
  assert.equal(resumes(h, (await turn(h, id, cid)).from), 0, 'and reused from the next turn')
})

test('a failed verification on a reused thread reloads it, and the reload is verified: it refuses if the engine still shows the drift', async t => {
  const p = profileStore(t), id = p.add({ toolCeiling: TERMINAL_NONE })
  let drift = false
  const h = harness({ profiles: p.profiles, agentReloadReuse: true,
    request: async (method, params) => (drift && method === 'experimentalFeature/list' && params.threadId ? featureList({ shell_tool: true }) : undefined) })
  const t1 = await turn(h, id, null, 'first'), cid = t1.run.conversationId
  await turn(h, id, cid); assert.equal(resumes(h, (await turn(h, id, cid)).from), 0)
  drift = true // the engine now reports the shell switch open on that thread
  const from = h.calls.length
  await assert.rejects(h.chat.send({ message: 'again', profileId: id, conversationId: cid }), error => /verif|ceiling|terminal/i.test(`${error.code} ${error.message}`))
  assert.equal(resumes(h, from), 1, 'it tried a reload before refusing')
})

test('a verification failure at a reload leaves nothing to reuse: the next turn reloads (and verifies) again', async t => {
  const p = profileStore(t), id = p.add({ toolCeiling: TERMINAL_NONE })
  let drift = false
  const h = harness({ profiles: p.profiles, agentReloadReuse: true,
    request: async (method, params) => (drift && method === 'experimentalFeature/list' && params.threadId ? featureList({ shell_tool: true }) : undefined) })
  const t1 = await turn(h, id, null, 'first'), cid = t1.run.conversationId
  drift = true
  await assert.rejects(h.chat.send({ message: 'x', profileId: id, conversationId: cid }))
  assert.equal(h.chat.threads.get(cid)?.appliedResume, undefined)
  drift = false
  const ok = await turn(h, id, cid)
  assert.equal(resumes(h, ok.from), 1)
  assert.ok(h.chat.threads.get(cid).appliedResume?.key)
})

test('bounded (read-only QA) threads are never reused: they reload on every turn as before', async t => {
  const p = profileStore(t), id = p.add({ toolCeiling: { browser: 'observe' } })
  const h = harness({ profiles: p.profiles, agentReloadReuse: true })
  const first = await h.chat.send({ message: 'q1', clientThreadId: 'qa', profileId: id, executionPolicy: { mode: 'readOnlyQa' } }); await h.finish(first)
  for (let n = 2; n <= 3; n++) {
    const from = h.calls.length
    const run = await h.chat.send({ message: `q${n}`, clientThreadId: 'qa', profileId: id, conversationId: first.conversationId, executionPolicy: { mode: 'readOnlyQa' } }); await h.finish(run)
    assert.ok(resumes(h, from) >= 1, `QA turn ${n} reloads`)
  }
})

test('the bridge passes agentReloadReuse only with EGDESK_AGENT_RELOAD_REUSE=on (default off)', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(source, /const agentReloadReuse = process\.env\.EGDESK_AGENT_RELOAD_REUSE === 'on'/)
  assert.match(source, /\.\.\.\(agentReloadReuse \? \{ agentReloadReuse: true \} : \{\}\),/)
  assert.equal(new CodexChatRuntime({ request: async () => ({}), respond() {}, emit() {}, verifyFile: async () => null }).agentReloadReuse, false)
})

// ---- own-tools threads (L5 c23: a resumed own-tools thread gets the same pure-engine switches, isolation and EG-Desk instructions as a new one) ----
const NEUTRAL = '/egdesk-own-tools-empty-folder'
const ownToolsState = () => { const state = { mode: 'on', environments: undefined }; return { state, ownTools: { mode: () => state.mode, neutralFolder: () => NEUTRAL, environments: () => state.environments } } }
const lastResume = (h, from = 0) => h.calls.slice(from).filter(call => call.method === 'thread/resume').at(-1)?.params

test('own tools: a resume (reload or restart) carries the own-tools overrides, and the reuse key covers them', async t => {
  const own = ownToolsState()
  const p = profileStore(t), id = p.add({ toolCeiling: TERMINAL_NONE })
  const h = harness({ profiles: p.profiles, agentReloadReuse: true, ownTools: own.ownTools })
  const t1 = await turn(h, id, null, 'first', { cwd: '/real/folder' }), cid = t1.run.conversationId
  const t2 = await turn(h, id, cid, 'second')
  const r = lastResume(h, t2.from)
  assert.equal(r.sandbox, 'read-only'); assert.equal(r.config.features.shell_tool, false); assert.equal(r.config.features.hooks, false)
  assert.match(r.developerInstructions, new RegExp(OWN_TOOLS_INSTRUCTIONS.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.equal(resumes(h, (await turn(h, id, cid)).from), 0, 'unchanged own-tools overrides: reused')
  // the environments candidate changes what the own-tools overrides contain: reload with it
  own.state.environments = 'none'
  const env = await turn(h, id, cid)
  assert.equal(resumes(h, env.from), 1); assert.deepEqual(lastResume(h, env.from).environments, [])
  assert.equal(resumes(h, (await turn(h, id, cid)).from), 0)
  // own tools switched off: the resume no longer carries them (and the key changed)
  own.state.mode = 'off'
  const off = await turn(h, id, cid)
  assert.equal(resumes(h, off.from), 1); assert.equal(Object.hasOwn(lastResume(h, off.from), 'environments'), false)
})

test('own tools: an MCP server the engine lists now is disabled by the isolation overrides, and that change forces a reload', async t => {
  const servers = [], own = ownToolsState()
  const p = profileStore(t), id = p.add()
  const h = harness({ profiles: p.profiles, agentReloadReuse: true, ownTools: own.ownTools, servers })
  const t1 = await turn(h, id, null, 'first', { cwd: '/real/folder' }), cid = t1.run.conversationId
  await turn(h, id, cid); assert.equal(resumes(h, (await turn(h, id, cid)).from), 0)
  servers.push({ name: 'fresh-server', tools: { go: {} } })
  const changed = await turn(h, id, cid)
  assert.equal(resumes(h, changed.from), 1)
  assert.equal(lastResume(h, changed.from).config.mcp_servers['fresh-server'].enabled, false)
  assert.equal(resumes(h, (await turn(h, id, cid)).from), 0)
})

test('own tools: a restarted process resumes the thread with the own-tools overrides (L5 c23 kept), in ONE resume', async t => {
  const own = ownToolsState()
  const p = profileStore(t), id = p.add({ toolCeiling: TERMINAL_NONE })
  const h = harness({ profiles: p.profiles, agentReloadReuse: true, ownTools: own.ownTools })
  const t1 = await turn(h, id, null, 'first', { cwd: '/real/folder' }), cid = t1.run.conversationId
  h.chat.loadedThreads.clear(); h.chat.threads.clear()
  const restarted = await turn(h, id, cid, 'after restart', { cwd: '/real/folder' })
  assert.equal(resumes(h, restarted.from), 1)
  const r = lastResume(h, restarted.from)
  assert.equal(r.config.features.shell_tool, false); assert.match(r.developerInstructions, /EG-Desk/)
})

test('own tools with the flag off: unchanged behaviour (every turn reloads with the own-tools overrides)', async t => {
  const own = ownToolsState()
  const p = profileStore(t), id = p.add({ toolCeiling: TERMINAL_NONE })
  const h = harness({ profiles: p.profiles, ownTools: own.ownTools })
  const t1 = await turn(h, id, null, 'first', { cwd: '/real/folder' }), cid = t1.run.conversationId
  for (let n = 2; n <= 3; n++) { const x = await turn(h, id, cid); assert.equal(resumes(h, x.from), 1); assert.equal(lastResume(h, x.from).config.features.hooks, false) }
})
