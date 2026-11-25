// u1 (PHILOSOPHY U19): a Claude conversation under EG-Desk's harness. EG-Desk's real runtime, tool providers, gate ledger and Claude adapter (permission broker, MCP bridge, translator);
// only the CLI process is a REPLAY: a recorded-shape stream-json script (system init, stream events, assistant tool_use, the SDK MCP control request, the tool result going back, the final text, the
// result). No CLI runs, no login is read, no model is called; the Decision model is a scripted fetch; commands run through a fake spawn.
import test from 'node:test'
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
import { CLAUDE_BUILTIN_COMMAND_FILE_TOOLS, CLAUDE_BUILTIN_COMPUTER_USE_RULES, CLAUDE_BUILTIN_OUTWARD_TOOLS, CLAUDE_BUILTIN_READ_TOOLS, CLAUDE_BUILTIN_WEB_TOOLS, claudeHarnessFromEnv, claudeHarnessInstructions, claudeHarnessThreadOverrides } from './egdesk-claude-harness.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openProfileStore } from './egdesk-profile-store.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const tmp = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-claude-harness-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }
const PASS = 'ℹ tests 5\nℹ suites 0\nℹ pass 5\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 52.1\n'
const tick = () => new Promise(resolve => setImmediate(resolve))
const until = async (predicate, ms = 4000) => { const end = Date.now() + ms; while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); assert.ok(predicate(), 'condition not reached in time') }

// ---- the pure module ----
test('the harness flag: only "on" is on; the built-in command and file tools are the ones EG-Desk\'s own tools replace; the web tools stay unless their own switch says off', () => {
  assert.equal(claudeHarnessFromEnv({}), null); assert.equal(claudeHarnessFromEnv({ EGDESK_CLAUDE_HARNESS: 'yes' }), null)
  const DEFAULT_OFF = [...CLAUDE_BUILTIN_COMMAND_FILE_TOOLS, ...CLAUDE_BUILTIN_READ_TOOLS, ...CLAUDE_BUILTIN_OUTWARD_TOOLS, ...CLAUDE_BUILTIN_COMPUTER_USE_RULES]; assert.deepEqual([...CLAUDE_BUILTIN_READ_TOOLS], ['Read', 'Grep', 'Glob']); assert.deepEqual([...CLAUDE_BUILTIN_COMPUTER_USE_RULES], ['mcp__computer-use', 'mcp__computer_use']); assert.deepEqual(claudeHarnessFromEnv({ EGDESK_CLAUDE_HARNESS: 'on' }).disallowed, DEFAULT_OFF); assert.deepEqual([...CLAUDE_BUILTIN_OUTWARD_TOOLS].sort(), ['CronCreate', 'CronDelete', 'CronList', 'EnterWorktree', 'ExitWorktree', 'Monitor', 'PushNotification', 'RemoteTrigger', 'ScheduleWakeup', 'SendMessage', 'SendToProject', 'Workflow']); assert.deepEqual(claudeHarnessFromEnv({ EGDESK_CLAUDE_HARNESS: 'on', EGDESK_PAGE_TOOLS: 'on' }).disallowed, [...DEFAULT_OFF, 'WebFetch', 'WebSearch'], 'with EG-Desk\'s card tools on, the built-in web tools are off'); assert.deepEqual(claudeHarnessFromEnv({ EGDESK_CLAUDE_HARNESS: 'on', EGDESK_PAGE_TOOLS: 'off' }).disallowed, DEFAULT_OFF); assert.equal(claudeHarnessFromEnv({ EGDESK_PAGE_TOOLS: 'on' }), null, 'the browser flag alone does not switch the harness on')
  for (const kept of ['WebFetch', 'WebSearch', 'ToolSearch', 'ListAgents', 'TaskStop']) assert.ok(!DEFAULT_OFF.includes(kept), kept + ' stays'); assert.deepEqual([...CLAUDE_BUILTIN_COMMAND_FILE_TOOLS], ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
  assert.deepEqual(claudeHarnessFromEnv({ EGDESK_CLAUDE_HARNESS: 'on', EGDESK_CLAUDE_HARNESS_WEB: 'off' }).disallowed, [...DEFAULT_OFF, 'WebFetch', 'WebSearch']); assert.deepEqual([...CLAUDE_BUILTIN_WEB_TOOLS], ['WebFetch', 'WebSearch'])
  const text = claudeHarnessInstructions('Be brief.'); assert.ok(text.startsWith('Be brief.\n\n')); assert.match(text, /Bash, Edit, Write, MultiEdit, NotebookEdit, Read, Grep, Glob\) are off/); assert.match(text, /ls or find with egdesk_run_command/); assert.match(text, /mcp__egdesk__/); assert.match(text, /egdesk_run_command/); assert.match(text, /needs_person/); assert.doesNotMatch(text, /read-only filesystem setting/)
  assert.deepEqual(claudeHarnessThreadOverrides({}), {}); assert.deepEqual(Object.keys(claudeHarnessThreadOverrides({ harness: claudeHarnessFromEnv({ EGDESK_CLAUDE_HARNESS: 'on' }) })).sort(), ['developerInstructions', 'egdesk_disallowed'.replace('egdesk_disallowed', 'egdeskDisallowedTools')].sort())
})

// ---- the world: the real runtime and adapter, a replayed CLI ----
/**
 * script(n) → the CLI's output for the n-th user message: [{ msg }] (a stream-json line) | [{ tool: { name, arguments } }] (an SDK MCP tools/call control request, then the replay waits for the
 * result EG-Desk sends back, like the real CLI) | [{ check: fn }]. The init line comes first, once per process.
 */
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

test('the harness on a Claude thread: the engine runs in the empty folder, the built-in command and edit tools are switched off with --disallowedTools, EG-Desk\'s instructions are the Claude version; flag off: nothing of this', async t => {
  const w = harnessWorld(t, { script: n => [...text(n, '알겠습니다'), ...result()] }), sent = await w.send('안녕'); assert.equal(sent.accepted, true); await w.settled(sent)
  const opts = w.transports[0].options; assert.deepEqual(opts.disallowedTools, [...CLAUDE_BUILTIN_COMMAND_FILE_TOOLS, ...CLAUDE_BUILTIN_READ_TOOLS, ...CLAUDE_BUILTIN_OUTWARD_TOOLS, ...CLAUDE_BUILTIN_COMPUTER_USE_RULES]); assert.notEqual(opts.cwd, w.root, 'not the person\'s folder'); assert.match(opts.cwd, /engine-folders/)
  assert.match(opts.appendPrompt, /Bash, Edit, Write, MultiEdit, NotebookEdit, Read, Grep, Glob\) are off/); assert.deepEqual(opts.allowedTools, ['mcp__egdesk'])
  const argv = buildClaudeArgs({ ...opts, mcpConfig: opts.mcpConfig, platform: 'darwin' }); const at = argv.indexOf('--disallowedTools'); assert.ok(at >= 0, argv.join(' ')); assert.equal(argv[at + 1], [...CLAUDE_BUILTIN_COMMAND_FILE_TOOLS, ...CLAUDE_BUILTIN_READ_TOOLS, ...CLAUDE_BUILTIN_OUTWARD_TOOLS, ...CLAUDE_BUILTIN_COMPUTER_USE_RULES].join(','))
  // the CLI's own computer-use server: blocked by rule AND not loaded at all (strict MCP config: only EG-Desk's server; settings carry nothing but the hooks switch; no claude.ai connectors)
  assert.ok(argv[at + 1].split(',').includes('mcp__computer-use')); assert.ok(argv.includes('--strict-mcp-config')); assert.deepEqual(JSON.parse(argv[argv.indexOf('--settings') + 1]), { disableAllHooks: true }); assert.equal(JSON.parse(argv[argv.indexOf('--mcp-config') + 1]).mcpServers.egdesk.type, 'sdk'); assert.deepEqual(Object.keys(JSON.parse(argv[argv.indexOf('--mcp-config') + 1]).mcpServers), ['egdesk']); assert.ok(!argv.includes('--tools'), 'no --tools whitelist: the web and read tools are left as they are')
  const tools = w.transports[0].options.controlHandlers && w.claude.stats?.(); void tools
  const off = harnessWorld(t, { env: { EGDESK_CLAUDE_HARNESS: 'off' }, script: n => [...text(n, '알겠습니다'), ...result()] }), s2 = await off.send('안녕'); await off.settled(s2)
  assert.equal(off.transports[0].options.disallowedTools, undefined); assert.equal(off.transports[0].options.cwd, off.root, 'the Claude CLI runs in the conversation\'s folder as before'); assert.doesNotMatch(String(off.transports[0].options.appendPrompt ?? ''), /are off in this session/)
})

const userResult = id => ({ msg: { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } } })
const toolReply = (transport, requestId) => JSON.parse(transport.replies.find(r => r.id === requestId).write.response.response.mcp_response.result.content[0].text)
const pickTests = ({ message, choices }) => (/테스트/.test(message) ? { value: choices.find(c => /tests/.test(c.description))?.value ?? 'none', confidence: 0.96 } : { value: 'none', confidence: 0.97 })

test('replay: tool call → EG-Desk\'s runner → the result back to Claude and into the run: the command ran through EG-Desk, the row says so, the facts are the arbiter\'s', async t => {
  const call = { command: 'npm test' }
  const w = harnessWorld(t, { script: n => [toolUse('toolu_1', 'egdesk_run_command', call), { tool: { name: 'egdesk_run_command', arguments: call } }, userResult('toolu_1'), ...text(n, '테스트 5개가 모두 통과했습니다.'), ...result()] })
  const sent = await w.send('테스트 돌려줘'), run = await w.settled(sent)
  assert.deepEqual(w.ran, ['npm test'], 'the command ran once, through EG-Desk\'s runner (the built-in Bash is switched off)'); assert.equal(run.status, 'completed')
  const back = toolReply(w.transports[0], 'tool-1-1'); assert.deepEqual([back.status, back.exitCode, back.health, back.tests.passed, back.tests.failed, back.worktree.state], ['ran', 0, 'healthy', 5, 0, 'clean'], 'Claude is handed EG-Desk\'s reading, not just the text')
  assert.deepEqual(run.activities.map(a => [a.kind, a.status, a.detail.tool, a.detail.executedBy]), [['dynamicToolCall', 'completed', 'egdesk_run_command', 'egdesk']], 'the activity row says an EG-Desk tool ran it')
  assert.deepEqual(run.ownCommands.map(c => [c.command, c.exitCode, c.health, c.summary.passed]), [['npm test', 0, 'healthy', 5]], 'the run keeps the command as evidence for the answer check'); assert.equal(run.ownTools, true)
  assert.equal(JSON.stringify(w.transports[0].options.disallowedTools).includes('Bash'), true)
})

test('replay: a command the rule floor stops needs the person: the tool result says so and nothing runs; the person\'s yes in the conversation approves THIS command once; asking again does not run it a second time', async t => {
  const cmd = 'git reset --hard HEAD~1'
  const w = harnessWorld(t, { predicates: { reply_runs_command: 0.97, reply_declines_command: 0.02 }, script: (n, { transport }) => n === 1
    ? [toolUse('toolu_1', 'egdesk_run_command', { command: cmd }), { tool: { name: 'egdesk_run_command', arguments: { command: cmd } } }, userResult('toolu_1'), ...text(n, '이 명령은 기록을 되돌립니다. 실행할까요?'), ...result()]
    : n === 2 ? [toolUse('toolu_2', 'egdesk_run_command', { command: cmd }), { tool: { name: 'egdesk_run_command', arguments: { command: cmd } } }, userResult('toolu_2'), { tool: { name: 'egdesk_run_command', arguments: { command: cmd } } }, ...text(n, '실행했습니다'), ...result()]
      : [...text(n, 'x'), ...result()] })
  const a = await w.send('마지막 커밋 되돌려줘'); await w.settled(a)
  const first = toolReply(w.transports[0], 'tool-1-1'); assert.equal(first.status, 'needs_person'); assert.deepEqual(w.ran, [], 'nothing ran: the floor stopped it (no model was needed)')
  const b = await w.send('응 실행해', { conversationId: a.conversationId, requestId: 'r-yes' }); await w.settled(b)
  assert.deepEqual(w.ran, [cmd], 'approved once: it ran once'); const second = toolReply(w.transports[0], 'tool-2-1'); assert.deepEqual([second.status, second.approvedOnce], ['ran', true])
  const again = toolReply(w.transports[0], 'tool-2-2'); assert.notEqual(again.status, 'ran', 'the approval is consumed: the same command asked again is not run'); assert.equal(w.ran.length, 1)
  assert.ok(w.decisionBodies.some(b => b.questions.some(q => q.name === 'reply_runs_command')), 'the person\'s reply was read by the decision model, not by a word list')
})

test('action first on Claude: the decision model picks, EG-Desk runs the command BEFORE the turn, Claude is asked once with the result block and no tool call; the row records who ran it and what the decision model judged', async t => {
  const w = harnessWorld(t, { env: { EGDESK_DECISION_FIRST: 'on' }, pick: pickTests, script: n => [...text(n, '테스트 5개가 모두 통과했습니다.'), ...result()] })
  const sent = await w.send('테스트 돌려줘'), run = await w.settled(sent)
  assert.deepEqual(w.ran, ['npm test']); assert.equal(w.transports[0].sent.length, 1, 'ONE Claude round'); assert.match(JSON.stringify(w.transports[0].sent[0]), /egdesk_command_result/); assert.match(JSON.stringify(w.transports[0].sent[0]), /Command: .npm test./)
  assert.deepEqual([run.decisionFirst.path, run.decisionFirst.reason, run.decisionFirst.option], ['action', 'healthy', 'script'])
  const row = run.activities.find(a => a.kind === 'commandExecution'); assert.equal(row.detail.executedBy, 'egdesk'); assert.deepEqual([row.detail.decidedBy.path, row.detail.decidedBy.reason, row.detail.decidedBy.option], ['action', 'healthy', 'script']); assert.ok(row.detail.decidedBy.confidence >= 0.9)
  assert.deepEqual(run.ownCommands.map(c => [c.command, c.health]), [['npm test', 'healthy']])
  const off = harnessWorld(t, { pick: pickTests, script: n => [...text(n, '네'), ...result()] }), s2 = await off.send('테스트 돌려줘'); await off.settled(s2); assert.deepEqual(off.ran, [], 'without the decision-first flag nothing runs before the turn, as on Codex')
})

test('a Claude conversation continues in the same folder: the second message names the same project folder and is accepted (the engine runs in the empty folder, the real folder is EG-Desk\'s); another folder is refused', async t => {
  const w = harnessWorld(t, { script: n => [...text(n, '네'), ...result()] }), a = await w.send('안녕'); await w.settled(a)
  const b = await w.send('또 안녕', { conversationId: a.conversationId, requestId: 'r-2' }); assert.equal(b.accepted, true); await w.settled(b); assert.equal(w.transports[0].sent.length, 2, 'the same process answered both')
  const other = path.join(w.base, 'other'); fs.mkdirSync(other)
  await assert.rejects(w.send('다른 폴더', { conversationId: a.conversationId, requestId: 'r-3', cwd: other }), { code: 'CWD_CHANGE_UNSUPPORTED' })
})

test('no project folder: the harness thread still runs in the empty folder and EG-Desk\'s tools have no folder to touch (nothing runs, the bridge\'s own folder is never used)', async t => {
  const cmd = { command: 'npm test' }
  const w = harnessWorld(t, { script: n => [toolUse('toolu_1', 'egdesk_run_command', cmd), { tool: { name: 'egdesk_run_command', arguments: cmd } }, userResult('toolu_1'), ...text(n, '폴더가 없습니다'), ...result()] })
  const sent = await w.chat.send({ message: '테스트 돌려줘', engineId: 'claude', clientThreadId: 'ui-claude', requestId: 'r-nofolder' }); await w.settled(sent)
  assert.match(w.transports[0].options.cwd, /engine-folders/); assert.deepEqual(w.ran, []); assert.equal(toolReply(w.transports[0], 'tool-1-1').status, 'no_folder')
})

test('approvals fast path on Claude: the person\'s yes is read by the decision model against that one command, EG-Desk runs it once BEFORE the turn, Claude is told it ran (no second call), and the row records both', async t => {
  const cmd = 'git reset --hard HEAD~1'
  const w = harnessWorld(t, { env: { EGDESK_DECISION_FIRST: 'on', EGDESK_DECISION_FIRST_APPROVALS: 'on' }, pick: pickTests, predicates: { reply_runs_command: 0.97, reply_declines_command: 0.02 }, script: n => n === 1
    ? [toolUse('toolu_1', 'egdesk_run_command', { command: cmd }), { tool: { name: 'egdesk_run_command', arguments: { command: cmd } } }, userResult('toolu_1'), ...text(n, '실행할까요?'), ...result()] : [...text(n, '실행했습니다'), ...result()] })
  const a = await w.send('마지막 커밋 되돌려줘'); await w.settled(a); assert.deepEqual(w.ran, [])
  const b = await w.send('응 실행해', { conversationId: a.conversationId, requestId: 'r-yes' }), run = await w.settled(b)
  assert.deepEqual(w.ran, [cmd], 'ran once, before the turn'); assert.equal(w.transports[0].sent.length, 2); assert.match(JSON.stringify(w.transports[0].sent[1]), /Do not call the tool for it again/); assert.deepEqual([run.decisionFirst.path, run.decisionFirst.reason], ['engine', 'approval_ran'])
  const row = run.activities.find(x => x.kind === 'commandExecution'); assert.ok(row, 'the card'); assert.equal(row.detail.executedBy, 'egdesk'); assert.deepEqual([row.detail.decidedBy.reason, row.detail.decidedBy.option], ['approval_ran', 'approved'])
  assert.deepEqual(run.ownCommands.map(c => c.command), [cmd], 'the answer check sees the command'); assert.ok(w.decisionBodies.some(x => x.questions.some(q => q.name === 'reply_runs_command')))
})

const PLAN = { id: 'doc:tests', kind: 'document', title: '테스트 결과 노트', summary: '테스트 5개 통과', timeSlice: 'present', loadText: () => 'body' }
const DRAFT = '테스트 5개가 모두 통과했습니다. 배포는 3번 반복되었습니다.', REVISED = '테스트 5개가 모두 통과했습니다.'
const judged = { unsupported: /배포/ }

test('draft check on a Claude answer: advisory records the check after the answer is posted; on holds the answer, checks it, and posts a supported one as written (the held Claude text is captured: it has no phase)', async t => {
  const adv = harnessWorld(t, { agent: true, env: { EGDESK_DRAFT_CHECK: 'advisory' }, judge: judged, candidates: [PLAN], script: n => [...text(n, DRAFT), ...result()] })
  const a = await adv.send('어떻게 됐어?'); await adv.settled(a); await until(() => adv.decisionBodies.some(b => b.questions.some(q => /^sup_/.test(q.name))))
  assert.deepEqual(adv.posted().map(p => p[1]), [DRAFT], 'advisory never changes or holds the answer')
  const on = harnessWorld(t, { agent: true, env: { EGDESK_DRAFT_CHECK: 'on' }, judge: judged, candidates: [PLAN], script: n => [...text(n, REVISED), ...result()] })
  const b = await on.send('어떻게 됐어?'); await on.settled(b); await until(() => on.posted().length === 1); assert.deepEqual(on.posted().map(p => p[1]), [REVISED]); assert.ok(on.decisionBodies.some(x => x.questions.some(q => /^sup_/.test(q.name))), 'the check ran on the Claude answer')
})

test('draft check on, a claim EG-Desk cannot support, no private turns: Claude has no fork, so the check cannot ask for a revision and the answer is not posted (as for any engine that cannot run a private turn); the posted-instead record says it', async t => {
  const w = harnessWorld(t, { agent: true, env: { EGDESK_DRAFT_CHECK: 'on' }, judge: judged, candidates: [PLAN], script: n => [...text(n, DRAFT), ...result()] })
  const a = await w.send('어떻게 됐어?'); await w.settled(a); await new Promise(r => setTimeout(r, 400)); await w.drain()
  assert.equal(w.transports.length, 1, 'no private Claude process'); assert.ok(w.posted().every(p => !p[1].includes('배포')), 'the unsupported claim is never posted')
})

test('private turns on Claude (EGDESK_CLAUDE_HARNESS_PRIVATE=on): the revision runs on a fresh Claude thread with NO tools and no EG-Desk tools; the revised, supported answer is posted; the private thread is released', async t => {
  const w = harnessWorld(t, { agent: true, env: { EGDESK_DRAFT_CHECK: 'on', EGDESK_CLAUDE_HARNESS_PRIVATE: 'on' }, judge: judged, candidates: [PLAN],
    script: (n, { index }) => index === 0 ? [...text(n, DRAFT), ...result()] : [...text(n, REVISED), ...result()] })
  const a = await w.send('어떻게 됐어?'); await w.settled(a); await until(() => w.posted().length === 1, 8000)
  assert.deepEqual(w.posted().map(p => p[1]), [REVISED], 'the revision was posted, not the unsupported draft'); assert.equal(w.transports.length, 2, 'one private Claude process')
  const priv = w.transports[1].options; assert.deepEqual(priv.tools, [], 'no built-in tool at all (--tools "")'); assert.equal(priv.mcpConfig ?? null, null, 'no EG-Desk tools'); assert.match(priv.cwd, /engine-folders/); assert.notEqual(w.transports[1].options.sessionId ?? w.transports[1].options.resume, w.transports[0].options.sessionId ?? w.transports[0].options.resume)
  assert.deepEqual(buildClaudeArgs({ ...priv, platform: 'darwin' }).slice(buildClaudeArgs({ ...priv, platform: 'darwin' }).indexOf('--tools'), buildClaudeArgs({ ...priv, platform: 'darwin' }).indexOf('--tools') + 2), ['--tools', ''])
  assert.match(JSON.stringify(w.transports[1].sent[0]), /Here is your draft answer|material you were given/, 'the fresh thread got the draft and the material in its text')
  const main = w.transports[0].options; assert.deepEqual(main.disallowedTools.slice(0, 5), ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'], 'the conversation itself keeps the harness')
})


test('memory prefetch (turnMemory.prefetch files) on Claude: the folder the person chose is read by EG-Desk and its files are offered to the decision model as candidates (the engine\'s own folder is the empty one)', async t => {
  const w = harnessWorld(t, { judge: {}, project: { 'ARCHITECTURE.md': '# 구조\n세션은 EG-Desk 하네스로 돈다.\n' }, turnMemory: { prefetch: 'files' }, script: n => [...text(n, '네'), ...result()] })
  const a = await w.send('구조 문서 읽어줘'); await w.settled(a)
  const asked = JSON.stringify(w.decisionBodies); assert.match(asked, /ARCHITECTURE\.md/, 'the project file reached the candidate list'); assert.doesNotMatch(asked, /engine-folders/, 'not the engine\'s empty folder')
})

test('open items on Claude: while a command waits for the person, the next message is read against it and Claude is told what stays open (the egdesk_open_items block rides in the turn); the pre-run command is listed for the memory layer', async t => {
  const cmd = 'git reset --hard HEAD~1'
  const w = harnessWorld(t, { env: { EGDESK_OPEN_ITEMS: 'on' }, script: n => n === 1
    ? [toolUse('toolu_1', 'egdesk_run_command', { command: cmd }), { tool: { name: 'egdesk_run_command', arguments: { command: cmd } } }, userResult('toolu_1'), ...text(n, '실행할까요?'), ...result()] : [...text(n, '알겠습니다'), ...result()] })
  const a = await w.send('마지막 커밋 되돌려줘'); await w.settled(a)
  const b = await w.send('잠깐, 다른 얘기인데 오늘 날씨는?', { conversationId: a.conversationId, requestId: 'r-2' }); await w.settled(b)
  const second = JSON.stringify(w.transports[0].sent[1]); assert.match(second, /egdesk_open_items/); assert.match(second, /approval: still open/)
  assert.ok(w.decisionBodies.some(x => x.questions.some(q => /^oi_ref_/.test(q.name))), 'the decision model read the message against the open approval')
})

test('replay, file tools: Claude reads through EG-Desk, previews an edit (dryRun changes nothing), applies one with an undo record, and a whole-file delete needs the person: the project file changes only through EG-Desk\'s tools', async t => {
  const calls = [
    ['egdesk_read_file', { path: 'notes.txt' }],
    ['egdesk_edit_file', { path: 'notes.txt', mode: 'replace', oldString: 'rate: 10', newString: 'rate: 12', dryRun: true }],
    ['egdesk_edit_file', { path: 'notes.txt', mode: 'replace', oldString: 'rate: 10', newString: 'rate: 12' }],
    ['egdesk_edit_file', { path: 'notes.txt', mode: 'delete' }],
  ]
  const w = harnessWorld(t, { project: { 'notes.txt': 'title: price\nrate: 10\n' }, script: n => [...calls.flatMap(([name, args], i) => [toolUse(`toolu_${i}`, name, args), { tool: { name, arguments: args } }, userResult(`toolu_${i}`)]), ...text(n, '끝'), ...result()] })
  const sent = await w.send('notes.txt 의 rate를 12로 고쳐줘'), run = await w.settled(sent), file = path.join(w.root, 'notes.txt')
  const [read, preview, applied, del] = [1, 2, 3, 4].map(i => toolReply(w.transports[0], `tool-1-${i}`))
  assert.match(JSON.stringify(read), /rate: 10/); assert.match(JSON.stringify(preview), /rate: 12/); assert.equal(fs.readFileSync(file, 'utf8').includes('rate: 12'), true, 'the applied edit changed the file')
  assert.ok(applied.editId || applied.undo || JSON.stringify(applied).includes('editId'), 'an undo record: ' + JSON.stringify(applied).slice(0, 200)); assert.equal(del.status, 'needs_person', 'deleting a whole file needs the person'); assert.equal(fs.existsSync(file), true, 'it is still there')
  assert.deepEqual(run.activities.filter(a => a.kind === 'dynamicToolCall').map(a => [a.detail.tool, a.detail.executedBy]), calls.map(([name]) => [name, 'egdesk']))
  assert.deepEqual(w.ran, [], 'no command ran for file work'); assert.equal(w.transports[0].options.disallowedTools.includes('Edit'), true)
})

test('no project chosen, the request names the bridge\'s own folder (the development copy): under the harness it is not a project, EG-Desk\'s tools answer no_folder and the Claude process stays in the empty folder', async t => {
  const cmd = { command: 'npm test' }
  const w = harnessWorld(t, { script: n => [toolUse('toolu_1', 'egdesk_run_command', cmd), { tool: { name: 'egdesk_run_command', arguments: cmd } }, userResult('toolu_1'), toolUse('toolu_2', 'egdesk_read_file', { path: 'package.json' }), { tool: { name: 'egdesk_read_file', arguments: { path: 'package.json' } } }, userResult('toolu_2'), ...text(n, '폴더가 없습니다'), ...result()] })
  const sent = await w.chat.send({ message: '테스트 돌려줘', engineId: 'claude', clientThreadId: 'ui-claude', requestId: 'r-bridge', cwd: process.cwd() }); await w.settled(sent)
  assert.match(w.transports[0].options.cwd, /engine-folders/); assert.notEqual(w.transports[0].options.cwd, process.cwd()); assert.deepEqual(w.ran, [])
  assert.equal(toolReply(w.transports[0], 'tool-1-1').status, 'no_folder'); assert.match(JSON.stringify(w.transports[0].replies.find(r => r.id === 'tool-1-2')), /no_folder|NO_FOLDER/, 'the read tool has no folder either')
})

test('the built-in read tools are off too: Read, Grep and Glob are in the argv of a harness thread, and EG-Desk\'s read and search tools cover reading a project file and finding text in it', async t => {
  const calls = [['egdesk_read_file', { path: 'notes.txt' }], ['egdesk_search_files', { pattern: 'rate' }]]
  const w = harnessWorld(t, { project: { 'notes.txt': 'title: price\nrate: 10\n' }, script: n => [...calls.flatMap(([name, args], i) => [toolUse(`toolu_${i}`, name, args), { tool: { name, arguments: args } }, userResult(`toolu_${i}`)]), ...text(n, '찾았습니다'), ...result()] })
  const sent = await w.send('rate 가 어디 있어?'); await w.settled(sent)
  const argv = buildClaudeArgs({ ...w.transports[0].options, platform: 'darwin' }), off = argv[argv.indexOf('--disallowedTools') + 1].split(','); for (const name of ['Read', 'Grep', 'Glob']) assert.ok(off.includes(name), name)
  assert.match(JSON.stringify(toolReply(w.transports[0], 'tool-1-1')), /rate: 10/); assert.match(JSON.stringify(toolReply(w.transports[0], 'tool-1-2')), /notes\.txt/)
  assert.match(w.transports[0].options.appendPrompt, /ls or find with egdesk_run_command/, 'listing by name is said to go through the runner: EG-Desk has no glob tool')
})
