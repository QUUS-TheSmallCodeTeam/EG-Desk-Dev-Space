// c18: with the own-tools flag on, the real runtime starts Codex as a pure model engine (mock app-server): its own command, image,
// web and project-file tools off, read-only and never asking, in an EG-Desk-owned empty folder; every command and file change goes
// through EG-Desk's tools on the real folder. Temp folders only; a fake runner; nothing is executed.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { COMMAND_TOOL_NAME, createCommandExecutorProvider, executorAssess } from './egdesk-command-executor.mjs'
import { FILE_TOOL_NAMES, createFileToolsProvider } from './egdesk-file-tools.mjs'
import { createGateHookBroker } from './egdesk-gate-hook-broker.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

function harness(t, { flag = 'on', neutral = true } = {}) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-own-tools-test-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const real = path.join(base, 'project'), empty = path.join(base, 'engine-folder')
  fs.mkdirSync(real); fs.mkdirSync(empty)
  fs.writeFileSync(path.join(real, 'README.md'), 'hello\n')
  const calls = [], replies = [], ran = []
  let chat = null
  const ledger = createGateHookBroker({ mode: () => 'on', home: '/home/synthetic', assess: executorAssess(async () => ({ approval: false, reasons: [], source: 'decision' }), { home: '/home/synthetic' }) })
  const workspaceOf = run => chat.runFolder(run)
  const executor = createCommandExecutorProvider({ mode: () => flag, ledger, workspaceOf, runner: async ({ command, cwd }) => { ran.push([command, cwd]); return { exitCode: 0, stdout: '', stderr: '', durationMs: 5 } } })
  const files = createFileToolsProvider({ mode: () => flag, ledger, workspaceOf })
  let turns = 0
  chat = new CodexChatRuntime({
    request: async (method, params) => {
      calls.push([method, structuredClone(params)])
      if (method === 'thread/start') return { thread: { id: 'conv-1' }, cwd: params.cwd }
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }
      return {}
    },
    respond: (...args) => replies.push(args), emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, toolProviders: [executor, files],
    ownTools: { mode: () => flag, neutralFolder: () => (neutral ? empty : null) },
  })
  chat.setConnection(true)
  const tool = async (run, id, name, args) => {
    await chat.handleServerRequest({ id, method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: id, tool: name, arguments: args } })
    const until = Date.now() + 3000
    while (!replies.some(r => r[0] === id) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
    const reply = replies.find(r => r[0] === id)
    assert.ok(reply, `no reply to ${id}`)
    if (!reply[1]) throw new Error(`tool call ${id} was refused: ${JSON.stringify(reply[2])}`)
    return JSON.parse(reply[1].contentItems[0].text)
  }
  return { chat, calls, replies, ran, real, empty, tool }
}

test('flag on: the thread runs in the empty folder as a pure model engine; commands and file changes go through EG-Desk on the real folder only', async t => {
  const h = harness(t)
  const run = await h.chat.send({ message: 'Update the readme and run the tests', clientThreadId: 'ui', requestId: 'r1', cwd: h.real })
  const [, start] = h.calls.find(([m]) => m === 'thread/start')
  assert.equal(start.cwd, h.empty, 'Codex never gets the real folder')
  assert.equal(start.sandbox, 'read-only'); assert.equal(start.approvalPolicy, 'never')
  assert.deepEqual(start.config.features, { ...start.config.features, shell_tool: false, unified_exec: false, view_image: false })
  assert.equal(start.config.web_search, 'disabled'); assert.equal(start.config.project_doc_max_bytes, 0)
  const names = start.dynamicTools.map(spec => spec.name)
  for (const name of [COMMAND_TOOL_NAME, FILE_TOOL_NAMES.read, FILE_TOOL_NAMES.search, FILE_TOOL_NAMES.edit]) assert.ok(names.includes(name), name)
  const [, turn] = h.calls.find(([m]) => m === 'turn/start')
  assert.deepEqual([turn.cwd, turn.approvalPolicy, turn.sandboxPolicy], [h.empty, 'never', { type: 'readOnly', networkAccess: false }])
  assert.doesNotMatch(JSON.stringify(h.calls), new RegExp(h.real.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')), 'the real folder never reaches the app-server')
  // EG-Desk's tools work on the real folder
  assert.equal((await h.tool(run, 'f1', FILE_TOOL_NAMES.edit, { path: 'README.md', mode: 'replace', oldString: 'hello', newString: 'hello world' })).status, 'edited')
  assert.equal(fs.readFileSync(path.join(h.real, 'README.md'), 'utf8'), 'hello world\n')
  assert.deepEqual(fs.readdirSync(h.empty), [], 'nothing is written in the engine folder')
  assert.equal((await h.tool(run, 'c1', COMMAND_TOOL_NAME, { command: 'npm test' })).status, 'ran')
  assert.deepEqual(h.ran, [['npm test', h.real]])
  // a native command or file change request is declined, never shown as a card and never accepted
  await h.chat.handleServerRequest({ id: 91, method: 'item/commandExecution/requestApproval', params: { threadId: run.conversationId, turnId: run.runId, itemId: 'x', command: 'rm -rf src', cwd: h.empty, availableDecisions: ['accept', 'decline', 'cancel'] } })
  await h.chat.handleServerRequest({ id: 92, method: 'item/fileChange/requestApproval', params: { threadId: run.conversationId, turnId: run.runId, itemId: 'y', availableDecisions: ['accept', 'decline', 'cancel'] } })
  await h.chat.queue
  assert.deepEqual(h.replies.filter(r => r[0] === 91 || r[0] === 92).map(r => r[1]), [{ decision: 'decline' }, { decision: 'decline' }])
  assert.deepEqual(h.chat.snapshot().runs[0].pendingApprovals, [])
  // the next turn of the same conversation keeps both folders apart
  await h.chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn: { id: run.runId, status: 'completed', items: [] } } }); await h.chat.queue
  const run2 = await h.chat.send({ message: 'again', conversationId: run.conversationId, requestId: 'r2' })
  assert.equal(h.calls.filter(([m]) => m === 'turn/start').at(-1)[1].cwd, h.empty)
  const internal = h.chat.runs.get(`${run2.conversationId}/${run2.runId}`)
  assert.deepEqual([internal.ownTools, h.chat.runFolder(internal)], [true, h.real], 'the real folder stays EG-Desk\'s for the whole conversation')
  assert.equal((await h.tool(run2, 'c2', COMMAND_TOOL_NAME, { command: 'git status' })).status, 'ran')
  assert.deepEqual(h.ran.at(-1), ['git status', h.real])
})

test('flag off: the thread starts exactly as today (real folder, no pure-engine overrides, no EG-Desk tools); on without an engine folder sends nothing', async t => {
  const off = harness(t, { flag: 'off' })
  await off.chat.send({ message: 'x', clientThreadId: 'ui', requestId: 'r1', cwd: off.real })
  const [, start] = off.calls.find(([m]) => m === 'thread/start')
  assert.equal(start.cwd, off.real); assert.equal(start.sandbox, undefined); assert.equal(start.approvalPolicy, undefined)
  assert.equal(start.config?.features?.shell_tool, undefined); assert.equal(start.dynamicTools?.some(s => s.name === COMMAND_TOOL_NAME) ?? false, false)
  const [, turn] = off.calls.find(([m]) => m === 'turn/start')
  assert.deepEqual([turn.cwd, turn.approvalPolicy, turn.sandboxPolicy], [off.real, undefined, undefined])
  const none = harness(t, { neutral: false })
  await assert.rejects(none.chat.send({ message: 'x', clientThreadId: 'ui', requestId: 'r1', cwd: none.real }), e => e.code === 'OWN_TOOLS_UNAVAILABLE')
  assert.equal(none.calls.filter(([m]) => m === 'thread/start' || m === 'turn/start').length, 0)
})
