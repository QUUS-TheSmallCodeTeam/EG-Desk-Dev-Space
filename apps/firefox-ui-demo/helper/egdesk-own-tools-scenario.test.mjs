// c19, the person's view: with EG-Desk's own tools on (the bridge's wiring, a mock app-server, a FAKE spawn, a temp folder), one run
// edits two files, runs the tests, reaches a destructive command, asks in the chat, gets "응", runs it once and reports; the undo record
// is usable afterwards. The same run with "아니" runs nothing destructive. No process is ever started.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createOwnToolsWiring } from './egdesk-own-tools-wiring.mjs'
import { COMMAND_TOOL_NAME } from './egdesk-command-executor.mjs'
import { FILE_TOOL_NAMES } from './egdesk-file-tools.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const A = 'export const add = (a, b) => a - b\n'
const B = 'export function greet(name) {\n  return "hi " + name\n}\n'

async function scenario(t, reply) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-own-tools-scenario-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const dataDir = path.join(base, 'egdesk-data'), project = path.join(base, 'demo-app')
  fs.mkdirSync(path.join(project, 'src'), { recursive: true }); fs.mkdirSync(dataDir)
  fs.writeFileSync(path.join(project, 'src', 'add.js'), A); fs.writeFileSync(path.join(project, 'src', 'greet.js'), B)
  // the fake spawn: the test command passes, the push prints; nothing really runs
  const spawned = []
  const spawn = (file, args, options) => {
    const child = new EventEmitter()
    Object.assign(child, { pid: 5000 + spawned.length, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
    spawned.push({ command: args[1], cwd: options.cwd, env: options.env, detached: options.detached, file })
    setImmediate(() => { child.stdout.write(args[1] === 'npm test' ? '2 passing\n' : 'To example.test:demo-app.git\n + abc...def main -> main (forced update)\n'); setImmediate(() => child.emit('close', 0, null)) })
    return child
  }
  const env = { EGDESK_OWN_TOOLS: 'on', PATH: '/usr/bin:/bin', HOME: '/home/synthetic', SSH_AUTH_SOCK: '/tmp/agent.sock', OPENAI_API_KEY: 'sk-synthetic' }
  let chat = null
  const wiring = createOwnToolsWiring({ env, dataDir, spawn, getChat: () => chat, killGroup: () => {}, home: '/home/synthetic' })
  // the Decision model: harmless content predicates; the person's reply read from what they wrote
  const read = []
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0019', recipientForKey: () => 'a'.repeat(64),
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body)
      const data = body.input.find(m => Array.isArray(m.content))?.content[0].data ?? {}
      if (typeof data.reply === 'string') read.push(data.reply)
      const yes = data.reply === '응'
      return Response.json({ answers: body.questions.map(q => ({ name: q.name, type: 'predicate',
        probability: q.name === 'reply_runs_command' ? (yes ? 0.96 : 0.03) : q.name === 'reply_declines_command' ? (yes ? 0.02 : 0.95) : 0.05 })), usage: { input_tokens: 20 } })
    } })
  const calls = [], replies = []
  let turns = 0
  chat = new CodexChatRuntime({
    request: async (method, params) => { calls.push([method, params]); if (method === 'thread/start') return { thread: { id: 'conv-1' }, cwd: params.cwd }
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }; return {} },
    respond: (...args) => replies.push(args), emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null,
    toolProviders: wiring.toolProviders, ownTools: wiring.ownTools,
    decisionContext: { mode: () => 'on', configured: () => true, client, calibrationLog: openCalibrationLog({ dataDir: path.join(base, 'calibration'), log: () => {} }), terminalGate: wiring.terminalGate(null) },
  })
  chat.setConnection(true)
  let n = 0
  const tool = async (run, name, args) => {
    const id = `call-${++n}`
    await chat.handleServerRequest({ id, method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: id, tool: name, arguments: args } })
    const until = Date.now() + 3000
    while (!replies.some(r => r[0] === id) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5))
    const answer = replies.find(r => r[0] === id)
    assert.ok(answer?.[1], `${name} was refused: ${JSON.stringify(answer?.[2])}`)
    return JSON.parse(answer[1].contentItems[0].text)
  }
  const endTurn = async run => { await chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn: { id: run.runId, status: 'completed', items: [] } } }); await chat.queue }

  // turn 1: the request; two edits, the tests, then the destructive push stops at the gate
  const run1 = await chat.send({ message: '덧셈 버그 고치고 인사말 바꾼 다음 테스트 돌리고 강제로 올려줘', clientThreadId: 'ui', requestId: 'r1', cwd: project })
  const e1 = await tool(run1, FILE_TOOL_NAMES.edit, { path: 'src/add.js', mode: 'replace', oldString: 'a - b', newString: 'a + b' })
  const e2 = await tool(run1, FILE_TOOL_NAMES.edit, { path: 'src/greet.js', mode: 'diff', diff: '@@ -1,3 +1,3 @@\n export function greet(name) {\n-  return "hi " + name\n+  return `hello, ${name}`\n }\n' })
  const tests = await tool(run1, COMMAND_TOOL_NAME, { command: 'npm test' })
  const push1 = await tool(run1, COMMAND_TOOL_NAME, { command: 'git push --force origin main' })
  await endTurn(run1) // the model asked the person in its own words (U4) and ended its turn
  // turn 2: the person's answer; the model tries the same command again, then reports
  const run2 = await chat.send({ message: reply, conversationId: run1.conversationId, requestId: 'r2' })
  const push2 = await tool(run2, COMMAND_TOOL_NAME, { command: 'git push --force origin main' })
  await endTurn(run2)
  return { chat, wiring, calls, project, dataDir, spawned, read, e1, e2, tests, push1, push2, run2, tool, endTurn }
}

test('응: edits, tests, the destructive push asked in the chat, run exactly once after "응", reported; undo works afterwards', async t => {
  const s = await scenario(t, '응')
  assert.deepEqual([s.e1.status, s.e1.kind, s.e2.status, s.e2.kind], ['edited', 'update', 'edited', 'update'], 'partial edits run without asking, shown as diffs')
  assert.match(s.e1.diff, /-export const add = \(a, b\) => a - b\n\+export const add = \(a, b\) => a \+ b/)
  assert.deepEqual([s.tests.status, s.tests.exitCode, s.tests.stdout], ['ran', 0, '2 passing\n'])
  assert.deepEqual([s.push1.status, s.push1.reasons, s.push1.executed], ['needs_person', ['remote_irreversible'], false])
  assert.deepEqual(s.read, ['응'], 'the person\'s reply was read once, as yes/no')
  assert.deepEqual([s.push2.status, s.push2.approvedOnce, s.push2.exitCode], ['ran', true, 0])
  assert.deepEqual(s.spawned.map(c => [c.command, c.cwd, c.detached, c.env.SSH_AUTH_SOCK ?? null, c.env.OPENAI_API_KEY ?? null]),
    [['npm test', s.project, true, null, null], ['git push --force origin main', s.project, true, '/tmp/agent.sock', null]], 'the push ran once, with the ssh agent; no key reached any command')
  assert.equal(fs.readFileSync(path.join(s.project, 'src', 'add.js'), 'utf8'), 'export const add = (a, b) => a + b\n')
  // Codex never saw the real folder and could not act on its own
  assert.doesNotMatch(JSON.stringify(s.calls), /demo-app/)
  const [, start] = s.calls.find(([m]) => m === 'thread/start')
  assert.deepEqual([start.cwd, start.sandbox, start.approvalPolicy, start.config.features.shell_tool], [path.join(s.dataDir, 'engine-folders', 'empty'), 'read-only', 'never', false])
  // afterwards: the undo record puts both files back, newest first
  const internal = s.chat.runs.get(`${s.run2.conversationId}/${s.run2.runId}`)
  assert.deepEqual(s.wiring.files.undoRecords(internal).map(r => r.path), ['src/add.js', 'src/greet.js'])
  // the run has ended: a dynamic tool call on it is refused; a later turn of the conversation ("되돌려줘") can use the record
  const run3 = await s.chat.send({ message: '인사말 바꾼 것만 되돌려줘', conversationId: s.run2.conversationId, requestId: 'r3' })
  assert.equal((await s.tool(run3, FILE_TOOL_NAMES.undo, {})).path, 'src/greet.js')
  assert.equal(fs.readFileSync(path.join(s.project, 'src', 'greet.js'), 'utf8'), B)
  assert.equal(JSON.parse((await s.wiring.files.undo(internal)).contentItems[0].text).path, 'src/add.js')
  assert.equal(fs.readFileSync(path.join(s.project, 'src', 'add.js'), 'utf8'), A)
})

test('아니: the same run; the destructive push never runs, everything else is the same', async t => {
  const s = await scenario(t, '아니')
  assert.deepEqual([s.e1.status, s.e2.status, s.tests.status, s.push1.status], ['edited', 'edited', 'ran', 'needs_person'])
  assert.deepEqual(s.read, ['아니'])
  assert.notEqual(s.push2.status, 'ran'); assert.equal(s.push2.executed, false)
  assert.deepEqual(s.spawned.map(c => c.command), ['npm test'], 'only the tests ever reached spawn')
})
