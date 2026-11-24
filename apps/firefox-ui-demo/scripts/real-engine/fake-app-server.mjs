// c22: a FAKE Codex app-server that speaks the 0.171 stdio protocol (newline-delimited JSON-RPC), for testing the real-engine check without
// any Codex binary. Every message it sends, and every request it receives, is checked against scripts/real-engine/protocol-0171.json (the
// subset of the schema Main generated from the official binary); a message off the schema ends the process with exit code 3 and a line on
// stderr, so a test cannot pass on a made-up shape.
// It models the person's own Codex setup (script.person: MCP servers, hooks, features, instruction files) and honours the thread/start
// config the way the config types DOCUMENT (enabled = false, features.<name> = false, project_doc_max_bytes = 0). That proves EG-Desk's
// wiring sends the keys; it does not prove the real binary honours them (the check's read-back on the real binary does).
//
// Script (JSON, path in EGDESK_FAKE_APP_SERVER_SCRIPT; the log is appended to EGDESK_FAKE_APP_SERVER_LOG when set):
//   { version, person: { mcpServers: [{ name, tools: [..] }], hooks: n, features: { name: bool }, instructionSources: [path] },
//     turns: [ { match?: "text the person's message contains", steps: [ step ], status?: "completed"|"failed", final?: "text", error?: "text" } ],
//     forkTurns?: [ … same … ] }
//   step: { agentMessage: "text", phase? } | { toolCall: { tool, arguments } } | { nativeCommand: { command, cwd } } | { compaction: true }
//         | { usage: { input, cached, output, reasoning } } | { errorNotification: "text" } | { delayMs: n }
import fs from 'node:fs'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { validateMessage } from '../../helper/egdesk-app-server-protocol.mjs'

export const FAKE_VERSION = '0.171.0-alpha.13'
const MESSAGE_PHASES = { commentary: 'commentary', final: 'final_answer' }

// exit(code): what ends the fake. The process entry below passes process.exit; a test that runs the fake in-process passes its own.
// stderr: where the schema-error line goes.
export function runFakeAppServer({ script, input = process.stdin, output = process.stdout, log = null, home = '/fake/codex-home', env = {}, exit = code => process.exit(code), stderr = process.stderr } = {}) {
  const logLine = entry => { if (log) fs.appendFileSync(log, `${JSON.stringify(entry)}\n`) }
  const person = { mcpServers: [], hooks: 0, features: {}, instructionSources: [], ...(script.person ?? {}) }
  const threads = new Map(), used = new Set(), usedFork = new Set(), pending = new Map()
  let nextThread = 0, nextTurn = 0, nextItem = 0, nextServerRequest = 100
  const send = message => { output.write(`${JSON.stringify(message)}\n`); logLine({ dir: 'out', ...message }) }
  let exitCode = 0
  const fail = (what, errors) => { stderr.write(`fake app-server: ${what} is off the 0.171 schema: ${errors.slice(0, 3).join('; ')}\n`); logLine({ dir: 'schema_error', what, errors }); exitCode = 3; setImmediate(() => exit(3)) }
  const notify = (method, params) => { const errors = validateMessage('notification', method, params); if (errors.length) return fail(`notification ${method}`, errors); send({ method, params }) }
  const result = (id, method, value) => { const errors = validateMessage('result', method, value); if (errors.length) return fail(`result of ${method}`, errors); send({ id, result: value }) }
  const itemId = () => `item-${++nextItem}`
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const textOf = params => (params.input ?? []).filter(i => i?.type === 'text').map(i => i.text).join('\n')

  const effective = thread => {
    const cfg = script.ignoreConfig === true ? {} : (thread.config ?? {}) // ignoreConfig: a binary that does not honour the keys (the check must be able to see that)
    const off = (name, pluginId) => cfg.mcp_servers?.[name]?.enabled === false || (pluginId && cfg.plugins?.[pluginId]?.enabled === false)
    const featureOn = name => (cfg.features?.[name] !== undefined ? cfg.features[name] !== false : person.features[name] !== false)
    const servers = person.mcpServers.filter(s => !off(s.name, s.pluginId))
    const sources = cfg.project_doc_max_bytes === 0 ? [] : person.instructionSources
    return { servers, hooks: featureOn('hooks') ? person.hooks : 0, features: { ...person.features, ...Object.fromEntries(Object.entries(cfg.features ?? {}).filter(([, v]) => typeof v === 'boolean')) }, sources }
  }

  const chooseTurn = (list, usedSet, text) => {
    const index = list.findIndex((t, i) => !usedSet.has(i) && typeof t.match === 'string' && text.includes(t.match))
    const at = index >= 0 ? index : list.findIndex((t, i) => !usedSet.has(i) && t.match === undefined)
    if (at < 0) return null
    usedSet.add(at); return list[at]
  }

  const serverRequest = (method, params) => new Promise(resolve => {
    const errors = validateMessage('serverRequest', method, params)
    if (errors.length) return fail(`server request ${method}`, errors)
    const id = ++nextServerRequest
    pending.set(id, { method, resolve })
    send({ id, method, params })
  })

  async function runTurn(threadId, turnId, plan) {
    const thread = threads.get(threadId), items = []
    const turn = status => ({ id: turnId, items: [], status })
    notify('turn/started', { threadId, turn: turn('inProgress') })
    const user = { type: 'userMessage', id: itemId(), content: [{ type: 'text', text: thread.lastText, text_elements: [] }] }
    notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item: user }); notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: user }); items.push(user)
    for (const step of plan.steps ?? []) {
      if (step.delayMs) await sleep(step.delayMs)
      if (step.agentMessage !== undefined) {
        const item = { type: 'agentMessage', id: itemId(), text: step.agentMessage, phase: MESSAGE_PHASES[step.phase ?? 'commentary'] ?? step.phase }
        notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item: { ...item, text: '' } }); notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item }); items.push(item)
      }
      if (step.toolCall) {
        const callId = `call-${itemId()}`, started = Date.now()
        const base = { type: 'dynamicToolCall', id: callId, tool: step.toolCall.tool, arguments: step.toolCall.arguments ?? {} }
        notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item: { ...base, status: 'inProgress' } })
        const answer = await serverRequest('item/tool/call', { threadId, turnId, callId, tool: step.toolCall.tool, arguments: step.toolCall.arguments ?? {} })
        const errors = answer?.result === undefined ? [] : validateMessage('response', 'item/tool/call', answer.result)
        if (errors.length) return fail('the response to item/tool/call', errors)
        const done = { ...base, status: answer?.error ? 'failed' : 'completed', durationMs: Date.now() - started, ...(answer?.result ? { contentItems: answer.result.contentItems, success: answer.result.success } : {}) }
        notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: done }); items.push(done)
      }
      if (step.nativeCommand) {
        const id = itemId(), cwd = step.nativeCommand.cwd ?? thread.cwd
        const base = { type: 'commandExecution', id, command: step.nativeCommand.command, commandActions: [], cwd }
        notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item: { ...base, status: 'inProgress' } })
        const answer = await serverRequest('item/commandExecution/requestApproval', { threadId, turnId, itemId: id, startedAtMs: Date.now(), command: step.nativeCommand.command, cwd })
        const accepted = typeof answer?.result?.decision === 'string' && answer.result.decision.startsWith('accept')
        const done = { ...base, status: accepted ? 'completed' : 'declined' }
        notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item: done }); items.push(done)
      }
      if (step.compaction) {
        const item = { type: 'contextCompaction', id: itemId() }
        notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item }); notify('thread/compacted', { threadId, turnId }); notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item }); items.push(item)
      }
      if (step.usage) {
        const u = step.usage, input = u.input ?? 0, output = u.output ?? 0
        const breakdown = { inputTokens: input, cachedInputTokens: u.cached ?? 0, outputTokens: output, reasoningOutputTokens: u.reasoning ?? 0, totalTokens: input + output }
        notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: breakdown, total: breakdown, modelContextWindow: 258400 } })
      }
      if (step.errorNotification) notify('error', { threadId, turnId, error: { message: step.errorNotification, codexErrorInfo: null, additionalDetails: null }, willRetry: false })
    }
    if (plan.status !== 'failed' && plan.final !== undefined) {
      const item = { type: 'agentMessage', id: itemId(), text: plan.final, phase: 'final_answer' }
      notify('item/started', { threadId, turnId, startedAtMs: Date.now(), item: { ...item, text: '' } }); notify('item/completed', { threadId, turnId, completedAtMs: Date.now(), item }); items.push(item)
    }
    const status = plan.status ?? 'completed'
    notify('turn/completed', { threadId, turn: { ...turn(status), ...(status === 'failed' ? { error: { message: plan.error ?? 'the model request failed', codexErrorInfo: null, additionalDetails: null } } : {}) } })
  }

  const handlers = {
    initialize: (id) => result(id, 'initialize', { userAgent: `codex_cli_rs/${script.version ?? FAKE_VERSION} (Mac OS 26.0.0; arm64) fake`, codexHome: script.home || env.CODEX_HOME || home, platformFamily: 'unix', platformOs: 'macos' }),
    'thread/start': (id, params) => {
      const threadId = `thr-${++nextThread}`
      threads.set(threadId, { id: threadId, cwd: params.cwd ?? '/fake/cwd', config: params.config ?? {}, ephemeral: params.ephemeral === true, dynamicTools: (params.dynamicTools ?? []).map(t => t.name) })
      result(id, 'thread/start', { thread: threadObject(threadId, { ...params, ephemeral: script.reportEphemeral === false ? false : params.ephemeral }), cwd: params.cwd ?? '/fake/cwd', model: script.model ?? 'fake-model', modelProvider: 'openai', reasoningEffort: script.effort ?? 'low',
        approvalPolicy: params.approvalPolicy ?? 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false }, instructionSources: effective(threads.get(threadId)).sources })
      // like the real binary (Main's 0.171 finding): every MCP server that will be active starts when the thread starts
      for (const server of effective(threads.get(threadId)).servers) for (const status of ['starting', 'ready']) notify('mcpServer/startupStatus/updated', { threadId, name: server.name, status, error: null })
    },
    'thread/fork': (id, params) => {
      const threadId = `fork-${++nextThread}`, parent = threads.get(params.threadId)
      threads.set(threadId, { id: threadId, cwd: params.cwd ?? parent?.cwd ?? '/fake/cwd', config: params.config ?? parent?.config ?? {}, ephemeral: params.ephemeral === true, fork: true })
      result(id, 'thread/fork', { thread: threadObject(threadId, params), cwd: params.cwd ?? parent?.cwd ?? '/fake/cwd', model: script.model ?? 'fake-model', modelProvider: 'openai', approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } })
    },
    'turn/start': (id, params) => {
      const thread = threads.get(params.threadId)
      if (!thread) return send({ id, error: { code: -32600, message: `thread not found: ${params.threadId}` } })
      thread.lastText = textOf(params)
      const plan = (thread.fork ? chooseTurn(script.forkTurns ?? [], usedFork, thread.lastText) : chooseTurn(script.turns ?? [], used, thread.lastText)) ?? { steps: [], final: '(the fake has no script for this turn)' }
      const turnId = `turn-${++nextTurn}`
      result(id, 'turn/start', { turn: { id: turnId, items: [], status: 'inProgress' } })
      setImmediate(() => { runTurn(params.threadId, turnId, plan).catch(error => fail('turn run', [String(error?.message ?? error)])) })
    },
    'thread/unsubscribe': (id) => result(id, 'thread/unsubscribe', { status: 'unsubscribed' }),
    'turn/interrupt': (id) => result(id, 'turn/interrupt', {}),
    'config/read': (id) => result(id, 'config/read', { config: {}, origins: {}, layers: (person.mcpServers.some(s => !s.pluginId) ? [{ name: { type: 'user', file: `${env.CODEX_HOME || home}/config.toml` }, version: 'v1', config: { mcp_servers: Object.fromEntries(person.mcpServers.filter(s => !s.pluginId).map(s => [s.name, { command: 'fake-server' }])) } }] : []) }),
    'mcpServerStatus/list': (id, params) => {
      const view = params.threadId && threads.get(params.threadId) ? effective(threads.get(params.threadId)).servers : person.mcpServers
      result(id, 'mcpServerStatus/list', { data: view.map(s => ({ name: s.name, ...(s.pluginId ? { pluginId: s.pluginId } : {}), tools: Object.fromEntries((s.tools ?? []).map(t => [t, { name: t, inputSchema: {} }])), resources: [], resourceTemplates: [], authStatus: 'unsupported' })), nextCursor: null })
    },
    'experimentalFeature/list': (id, params) => {
      const features = params.threadId && threads.get(params.threadId) ? effective(threads.get(params.threadId)).features : person.features
      result(id, 'experimentalFeature/list', { data: Object.entries(features).map(([name, enabled]) => ({ name, stage: 'stable', enabled, defaultEnabled: true })), nextCursor: null })
    },
    'hooks/list': (id, params) => {
      const n = params.threadId && threads.get(params.threadId) ? effective(threads.get(params.threadId)).hooks : person.hooks
      result(id, 'hooks/list', { data: [{ cwd: '/fake/cwd', errors: [], warnings: [], hooks: Array.from({ length: n }, (_, i) => ({ key: `hook-${i}`, eventName: 'preToolUse', handlerType: 'command', command: 'fake-hook', isManaged: false, source: 'user', sourcePath: '/fake/hooks.json', displayOrder: i, enabled: true, timeoutSec: 5, trustStatus: 'trusted', currentHash: 'x' })) }] })
    },
  }
  const threadObject = (threadId, params) => ({ id: threadId, ephemeral: params.ephemeral === true, sessionId: threadId, projectId: null, forkedFromId: null, preview: '', modelProvider: 'openai', createdAt: 0, updatedAt: 0, status: { type: 'idle' }, path: null, cwd: params.cwd ?? '/fake/cwd',
    cliVersion: script.version ?? FAKE_VERSION, source: 'appServer', agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [] })

  const rl = readline.createInterface({ input })
  rl.on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    logLine({ dir: 'in', ...message })
    if (message.method === undefined && message.id !== undefined) { const wait = pending.get(message.id); if (wait) { pending.delete(message.id); wait.resolve(message) } return }
    if (message.id === undefined) return // 'initialized'
    const handler = handlers[message.method]
    if (!handler) return send({ id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
    const errors = validateMessage('clientRequest', message.method, message.params ?? {})
    if (errors.length) { logLine({ dir: 'client_off_schema', method: message.method, errors }); return send({ id: message.id, error: { code: -32602, message: `invalid params for ${message.method}: ${errors.slice(0, 3).join('; ')}` } }) }
    handler(message.id, message.params ?? {})
  })
  rl.on('close', () => setTimeout(() => exit(exitCode), 20))
  return { close: () => rl.close() }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const scriptPath = process.env.EGDESK_FAKE_APP_SERVER_SCRIPT
  const script = scriptPath ? JSON.parse(fs.readFileSync(scriptPath, 'utf8')) : {}
  if (process.argv.includes('--version')) { console.log(`codex-cli ${script.version ?? FAKE_VERSION}`); process.exit(0) }
  runFakeAppServer({ script, log: process.env.EGDESK_FAKE_APP_SERVER_LOG || null, env: process.env })
}
