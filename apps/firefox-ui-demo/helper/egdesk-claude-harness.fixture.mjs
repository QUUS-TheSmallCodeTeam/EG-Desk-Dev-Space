// u4: the replay world of lane L5's Claude harness test (helper/egdesk-claude-harness.test.mjs, u1), copied unchanged as a fixture so that other tests can drive a Claude turn through the real runtime,
// the real Claude adapter and EG-Desk's own tools with only the CLI process replayed (no CLI, no login, no model call; the Decision model is a scripted fetch; commands run through a fake spawn).
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs'
import { buildClaudeArgs } from './claude-engine-transport.mjs'
import { createOwnToolsWiring } from './egdesk-own-tools-wiring.mjs'
import { routePermissionRequest } from './claude-engine-permissions.mjs'
import { CLAUDE_BUILTIN_COMMAND_FILE_TOOLS, CLAUDE_BUILTIN_COMPUTER_USE_RULES, CLAUDE_BUILTIN_FLOW_TOOLS, CLAUDE_BUILTIN_OUTWARD_TOOLS, CLAUDE_BUILTIN_READ_TOOLS, CLAUDE_BUILTIN_WEB_TOOLS, claudeHarnessFromEnv, claudeHarnessInstructions, claudeHarnessThreadOverrides } from './egdesk-claude-harness.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openProfileStore } from './egdesk-profile-store.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const tmp = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-claude-harness-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }
const PASS = 'ℹ tests 5\nℹ suites 0\nℹ pass 5\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 52.1\n'
const tick = () => new Promise(resolve => setImmediate(resolve))
const until = async (predicate, ms = 4000) => { const end = Date.now() + ms; while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); assert.ok(predicate(), 'condition not reached in time') }

function harnessWorld(t, { env = {}, script, outputs = { 'npm test': { text: PASS, code: 0 } }, decisions = true, pick = () => ({ value: 'none', confidence: 0.97 }), predicates = {}, porcelain = '', project = {}, judge = null, candidates = [], agent = false, turnMemory = null } = {}) {
  const base = tmp(t), dataDir = path.join(base, 'egdesk-data'); fs.mkdirSync(dataDir)
  const root = path.join(base, 'project'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } })); for (const [name, text] of Object.entries(project)) fs.writeFileSync(path.join(root, name), text)
  const ran = [], transports = [], decisionBodies = [], events = [], serverRequests = []
  const spawn = (file, args) => { const command = String(args.at(-1)); ran.push(command); const child = new EventEmitter(), out = outputs[command] ?? { text: 'ok\n', code: 0 }
    Object.assign(child, { pid: 7000 + ran.length, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }); setImmediate(() => { child.stdout.write(out.text); setTimeout(() => child.emit('close', out.code, null), 5) }); return child }
  let chat = null
  const wiring = createOwnToolsWiring({ env: { EGDESK_OWN_TOOLS: 'on', EGDESK_CLAUDE_HARNESS: 'on', ...env, PATH: '/usr/bin:/bin', HOME: '/home/synthetic' }, dataDir, spawn, getChat: () => chat, home: '/home/synthetic', gitStatus: async () => porcelain })
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0001', recipientForKey: () => 'a'.repeat(64), fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); decisionBodies.push(body)
    const q = body.questions.find(x => x.name === 'df_pick'), message = /"""\n([\s\S]*?)\n"""/.exec(body.input.find(m => m.role === 'user')?.content ?? '')?.[1] ?? ''
    const answers = body.questions.map(x => {
      if (x.name === 'df_pick') { const p = pick({ message, choices: q.choices }); return { type: 'choice', name: 'df_pick', choice: p.value, confidence: p.confidence, probabilities: [{ value: 'none', probability: 0.02 }, { value: p.value, probability: p.confidence }].sort((a, b) => a.probability - b.probability) } }
      if (judge) { // the draft check's and the context's own questions, answered the way the draft-check test's judge does
        if (x.name === 'answer_type' || x.name === 'time_intent') return { type: 'choice', name: x.name, choice: x.choices[0].value, confidence: 0.9, probabilities: [{ value: x.choices[0].value, probability: 0.9 }] }
        if (/^claim_/.test(x.name)) { const verdict = judge.claim ?? 'supported'; return { type: 'choice', name: x.name, choice: verdict, confidence: 0.95, probabilities: [{ value: verdict, probability: 0.96 }, { value: verdict === 'supported' ? 'insufficient' : 'supported', probability: 0.02 }] } }
        if (/^present_/.test(x.name)) return { name: x.name, type: 'predicate', probability: 0.93 }
        if (/^sup_/.test(x.name)) return { name: x.name, type: 'predicate', probability: judge.unsupported?.test(body.input.map(m => m.content).find(c => String(c).startsWith('Sentence S' + (Number(x.name.slice(4)) + 1) + ':')) ?? '') ? 0.04 : 0.95 }
        if (/^tense_/.test(x.name)) return { name: x.name, type: 'predicate', probability: 0.04 }
        if (x.name === 'rel_0') return { name: x.name, type: 'predicate', probability: 0.95 }
      }
      return { name: x.name, type: 'predicate', probability: predicates[x.name] ?? 0.05 }
    })
    return Response.json({ model: 'gpt-6-luna', answers, usage: { input_tokens: 40 } })
  } })
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
          this.sent.push(JSON.parse(JSON.stringify(content))); const n = this.sent.length, sid = options.sessionId || options.resume
          setImmediate(async () => {
            if (!this.inited) { this.inited = true; options.onMessage({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-test', cwd: options.cwd, claude_code_version: '2.1.328', apiKeySource: 'ANTHROPIC_API_KEY' }) }
            let toolN = 0
            for (const step of script(n, { transport: this, options, index: transports.indexOf(this) })) {
              if (step.msg) options.onMessage({ session_id: sid, ...step.msg })
              else if (step.tool) {
                const requestId = `tool-${n}-${++toolN}`
                await options.controlHandlers.mcp_message({ subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id: toolN, method: 'tools/call', params: { name: step.tool.name, arguments: step.tool.arguments } } }, { requestId })
                for (let i = 0; i < 600 && !this.replies.some(r => r.id === requestId); i++) await new Promise(r => setTimeout(r, 5))
              } else if (step.check) step.check()
            }
          })
        },
      }
      transports.push(transport); return transport
    },
  })
  const codex = createCodexEngineAdapter({ request: async method => { throw new Error(`the Codex engine is not used here: ${method}`) }, respond: () => false })
  const store = openChatStore({ dataDir: path.join(base, 'chat'), ownerScope: 'claude-harness' }); t.after(() => store.close())
  let profileStore = null, room = null
  if (agent) { profileStore = openProfileStore({ dataDir: path.join(base, 'profiles'), ownerHash: 'claude-harness' }); t.after(() => profileStore.close?.()); const created = profileStore.createDraft({ name: '개발 도우미', avatar: { kind: 'initial', value: '개' }, role: '코드', personality: { tone: 'plain' }, expertise: [], instructions: '짧게 답한다.' }); profileStore.activate(created.id, 1, null); room = { profileId: created.id, replyDestination: 'direct' } }
  chat = new CodexChatRuntime({ engines: [codex, claude], store, requireStore: true, ...(profileStore ? { profiles: profileStore } : {}), getOwnerKey: () => 'claude:harness', toolProviders: wiring.toolProviders, ownTools: wiring.ownTools, verifyFile: async () => null,
    emit: event => events.push(event), emitLegacy: () => {},
    decisionContext: { mode: () => (decisions ? 'on' : 'off'), configured: () => decisions, client, settingsGeneration: () => 0, budgetMs: 800, collect: async () => [...candidates], ...(turnMemory ? { turnMemory } : {}), calibrationLog: openCalibrationLog({ dataDir: path.join(base, 'calibration'), log: () => {} }), terminalGate: wiring.terminalGate(null), ...(env.EGDESK_OPEN_ITEMS === 'on' ? { openItems: true } : {}), ...(env.EGDESK_DRAFT_CHECK ? { draftCheck: { mode: () => env.EGDESK_DRAFT_CHECK } } : {}) } })
  const unsubscribe = claude.subscribe({ notification: (_, m) => chat.handleNotification(m), serverRequest: (_, m) => { serverRequests.push(m); chat.handleServerRequest(m) }, connection: (id, s) => chat.setConnection(id, s.ready, s) })
  claude.syncStatus(); chat.setConnection('claude', true, {})
  const drain = async () => { await chat.queue; await tick(); await chat.queue }
  t.after(async () => { unsubscribe(); await claude.dispose(); await drain() })
  const send = (message, extra = {}) => chat.send({ message, engineId: 'claude', ...(room ?? {}), clientThreadId: 'ui-claude', requestId: `r-${Math.random()}`, cwd: root, ...extra })
  const runOf = sent => chat.runs.get(`${sent.conversationId}/${sent.runId}`)
  const settled = async sent => { await until(() => ['completed', 'failed', 'interrupted'].includes(runOf(sent)?.status)); await drain(); return runOf(sent) }
  const posted = (clientThreadId = 'ui-claude') => store.listMessages(clientThreadId, { limit: 50 }).messages.filter(m => m.role === 'assistant').map(m => [m.status, String(m.text ?? '')])
  return { chat, claude, wiring, store, posted, root, base, ran, transports, decisionBodies, events, serverRequests, send, runOf, settled, drain }
}

const text = (n, words) => [{ msg: { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: `m-${n}` } } } }, { msg: { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } } },
  { msg: { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: words } } } },
  { msg: { type: 'assistant', parent_tool_use_id: null, message: { id: `m-${n}`, role: 'assistant', content: [{ type: 'text', text: words }], usage: { input_tokens: 3, output_tokens: 2 } } } },
  { msg: { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } } }]
const result = () => [{ msg: { type: 'result', subtype: 'success', is_error: false } }]
const toolUse = (id, name, input) => ({ msg: { type: 'assistant', parent_tool_use_id: null, message: { id: `a-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: `mcp__egdesk__${name}`, input }], usage: { input_tokens: 3, output_tokens: 2 } } } })
const userResult = id => ({ msg: { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } } })

export { harnessWorld, text, result, toolUse, tick, until, tmp, PASS, userResult }
