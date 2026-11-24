// c26: the command the person stopped is told to the next turn (Main's check-7w: after the interrupt the engine never got the tool result, so on the next turn it could not say
// what happened). The fact: the command line, "stopped at the person's request after 4.6 s", the signal, not completed, the output printed before. Fake spawn and a fake engine only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { COMMAND_TOOL_NAME } from './egdesk-command-executor.mjs'
import { createOwnToolsWiring } from './egdesk-own-tools-wiring.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { STOPPED_COMMAND_KEY, STOPPED_COMMAND_LIMITS, stoppedCommandBlock, stoppedCommandEvidence, stoppedCommandFact } from './egdesk-stopped-command.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const until = async (predicate, ms = 8000) => { const end = Date.now() + ms; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate(), 'condition not reached in time') }

test('the fact: only a stopped command with a command line; the block and the evidence say it plainly, in seconds with one decimal', () => {
  assert.equal(stoppedCommandFact(null), null); assert.equal(stoppedCommandFact({ stopped: false, command: 'ls' }), null); assert.equal(stoppedCommandFact({ stopped: true, command: '  ' }), null)
  const fact = stoppedCommandFact({ stopped: true, command: 'sleep 15 && echo build-finished', durationMs: 4630, signal: 'SIGTERM', exitCode: null, outputTail: 'compiling…\nstep 2\n' })
  assert.deepEqual(fact, { command: 'sleep 15 && echo build-finished', durationMs: 4630, signal: 'SIGTERM', exitCode: null, outputTail: 'compiling…\nstep 2' }); assert.ok(Object.isFrozen(fact))
  const block = stoppedCommandBlock(fact)
  assert.match(block, /^EG-Desk fact about the last command you started in this conversation:/)
  assert.match(block, /The command `sleep 15 && echo build-finished` was stopped at the person's request after 4\.6 s \(signal SIGTERM\)\./)
  assert.match(block, /It did not complete: it has no exit code; whether it would have succeeded is not known, and it is no longer running\./)
  assert.match(block, /Output printed before it was stopped \(last part\):\ncompiling…\nstep 2$/)
  assert.match(stoppedCommandBlock(stoppedCommandFact({ stopped: true, command: 'make', durationMs: 900, signal: 'SIGKILL' })), /after 0\.9 s \(signal SIGKILL\)[\s\S]*It had printed no output before it was stopped\./)
  // no duration or signal known: the sentence does not invent them; an odd signal word is dropped; a long command and a long output are cut
  const bare = stoppedCommandFact({ stopped: true, command: 'x'.repeat(500), signal: 'rm -rf', outputTail: 'o'.repeat(5000) })
  assert.equal(bare.command.length, STOPPED_COMMAND_LIMITS.commandChars); assert.equal(bare.signal, null); assert.equal(bare.durationMs, null); assert.ok(bare.outputTail.length <= STOPPED_COMMAND_LIMITS.outputChars + 1); assert.ok(bare.outputTail.startsWith('…'))
  assert.doesNotMatch(stoppedCommandBlock(bare), /after .* s|signal/)
  // the draft check's evidence: the output only where terminal data may go to the run's models
  const evidence = stoppedCommandEvidence(fact), withOutput = stoppedCommandEvidence(fact, { outputAllowed: true })
  assert.deepEqual([evidence.kind, evidence.time, evidence.source], ['terminal', 'past', 'run']); assert.doesNotMatch(evidence.text, /compiling/); assert.match(withOutput.text, /compiling/); assert.match(evidence.text, /stopped at the person's request after 4\.6 s/)
  assert.match(STOPPED_COMMAND_KEY, /^[A-Za-z][A-Za-z0-9_]{0,63}$/)
})

function world(t, { draftCheck = null } = {}) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-stopped-fact-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const dataDir = path.join(base, 'egdesk-data'), project = path.join(base, 'demo-app')
  fs.mkdirSync(dataDir); fs.mkdirSync(project)
  const signals = [], spawned = []
  const spawn = (file, args, options) => {
    const child = new EventEmitter()
    Object.assign(child, { pid: 8000 + spawned.length, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
    spawned.push({ command: args[1], child })
    setImmediate(() => child.stdout.write(args[1].startsWith('echo ') ? 'quick\n' : 'compiling…\n'))
    if (args[1].startsWith('echo ')) setTimeout(() => child.emit('close', 0, null), 20)
    return child
  }
  const killGroup = (child, signal) => { signals.push([child.pid, signal]); setImmediate(() => child.emit('close', null, signal)) }
  let chat = null
  const wiring = createOwnToolsWiring({ env: { EGDESK_OWN_TOOLS: 'on', PATH: '/usr/bin:/bin', HOME: '/home/synthetic' }, dataDir, spawn, getChat: () => chat, killGroup, home: '/home/synthetic', gitStatus: async () => null })
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0026', recipientForKey: () => 'a'.repeat(64),
    fetchImpl: async (url, init) => Response.json({ answers: JSON.parse(init.body).questions.map(q => ({ name: q.name, type: 'predicate', probability: 0.05 })), usage: { input_tokens: 20 } }) })
  const calls = [], replies = []
  let turns = 0, threads = 0
  chat = new CodexChatRuntime({
    request: async (method, params) => { calls.push([method, params]); if (method === 'thread/start') return { thread: { id: `conv-${++threads}` }, cwd: params.cwd }
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }; return {} },
    respond: (...args) => replies.push(args), emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, getOwnerKey: () => 'codex:stopped',
    toolProviders: wiring.toolProviders, ownTools: wiring.ownTools,
    decisionContext: { mode: () => 'on', configured: () => true, client, calibrationLog: openCalibrationLog({ dataDir: path.join(base, 'calibration'), log: () => {} }), terminalGate: wiring.terminalGate(null), ...(draftCheck ? { draftCheck } : {}) },
  })
  chat.setConnection(true)
  const turnStarts = () => calls.filter(([m]) => m === 'turn/start').map(([, p]) => p)
  const runCommand = (sent, id, command) => chat.handleServerRequest({ id, method: 'item/tool/call', params: { threadId: sent.conversationId, turnId: sent.runId, callId: id, tool: COMMAND_TOOL_NAME, arguments: { command } } })
  const finishTurn = async sent => chat.handleNotification({ method: 'turn/completed', params: { threadId: sent.conversationId, turn: { id: sent.runId, status: 'interrupted', items: [] } } })
  return { chat, project, signals, spawned, replies, calls, turnStarts, runCommand, finishTurn }
}
const noteOf = start => start.additionalContext?.[STOPPED_COMMAND_KEY]?.value ?? null

test('end to end: the person stops a running command; the NEXT turn is told what happened to it, once', async t => {
  const w = world(t)
  const sent = await w.chat.send({ message: '빌드를 돌려줘', clientThreadId: 'ui', requestId: 'r1', cwd: w.project })
  await w.runCommand(sent, 'call-1', 'sleep 15 && echo build-finished')
  await until(() => w.spawned.length === 1)
  assert.equal(noteOf(w.turnStarts()[0]), null, 'nothing to tell on the first turn')
  const stopped = await w.chat.interrupt({ conversationId: sent.conversationId, runId: sent.runId }); assert.equal(stopped.accepted, true)
  await until(() => w.replies.some(r => r[0] === 'call-1'))
  assert.equal(JSON.parse(w.replies.find(r => r[0] === 'call-1')[1].contentItems[0].text).status, 'stopped')
  await w.finishTurn(sent)
  // the next turn of the same conversation
  const second = await w.chat.send({ message: '아니 지금 왜 멈췄니?', clientThreadId: 'ui', requestId: 'r2', cwd: w.project, conversationId: sent.conversationId })
  const note = noteOf(w.turnStarts().at(-1))
  assert.ok(note, 'the second turn carries the fact: ' + JSON.stringify(w.turnStarts().at(-1).additionalContext))
  assert.equal(w.turnStarts().at(-1).additionalContext[STOPPED_COMMAND_KEY].kind, 'application')
  assert.match(note, /The command `sleep 15 && echo build-finished` was stopped at the person's request after \d+\.\d s \(signal SIGTERM\)\./)
  assert.match(note, /It did not complete: it has no exit code/); assert.match(note, /Output printed before it was stopped \(last part\):\ncompiling…/)
  assert.doesNotMatch(JSON.stringify(w.turnStarts().at(-1).input), /stopped at the person/, 'the person\'s message itself is untouched: the fact rides as context')
  // consumed: the turn after that does not repeat it
  await w.chat.handleNotification({ method: 'turn/completed', params: { threadId: sent.conversationId, turn: { id: second.runId, status: 'completed', items: [] } } })
  await w.chat.send({ message: '고마워', clientThreadId: 'ui', requestId: 'r3', cwd: w.project, conversationId: sent.conversationId })
  assert.equal(noteOf(w.turnStarts().at(-1)), null, 'told once')
})

test('a command that finished is not announced as stopped; a later command that ran to its end replaces a stopped one; another conversation never gets it', async t => {
  const w = world(t)
  const sent = await w.chat.send({ message: 'run it', clientThreadId: 'ui', requestId: 'r1', cwd: w.project })
  await w.runCommand(sent, 'call-1', 'echo done')
  await until(() => w.replies.some(r => r[0] === 'call-1'))
  assert.equal(JSON.parse(w.replies[0][1].contentItems[0].text).status, 'ran')
  await w.finishTurn(sent)
  const second = await w.chat.send({ message: 'and now?', clientThreadId: 'ui', requestId: 'r2', cwd: w.project, conversationId: sent.conversationId })
  assert.equal(noteOf(w.turnStarts().at(-1)), null, 'a finished command is no stopped command')
  // stop a command in turn 2, then (as the engine can in the next turn) run a different command to its end before the stop was told: the stale stop is gone
  await w.runCommand(second, 'call-2', 'sleep 30'); await until(() => w.spawned.length === 2)
  await w.chat.interrupt({ conversationId: sent.conversationId, runId: second.runId }); await until(() => w.replies.some(r => r[0] === 'call-2')); await w.finishTurn(second)
  assert.ok(w.chat.stoppedCommands.get('ui'), 'remembered for the next turn')
  const run = w.chat.runFor(second)
  w.chat.noteOwnCommand(run, { exitCode: 0, durationMs: 20, health: { health: 'healthy', reasons: [] }, worktree: null })
  assert.equal(w.chat.stoppedCommands.has('ui'), false, 'a later command that was not stopped replaces it')
  // another conversation (its own thread) is never told about this one's command
  const mine = await w.chat.send({ message: 'again', clientThreadId: 'ui', requestId: 'r3', cwd: w.project, conversationId: sent.conversationId })
  assert.equal(noteOf(w.turnStarts().at(-1)), null); void mine
  await w.runCommand(mine, 'call-3', 'sleep 40'); await until(() => w.spawned.length === 3)
  await w.chat.interrupt({ conversationId: sent.conversationId, runId: mine.runId }); await until(() => w.replies.some(r => r[0] === 'call-3'))
  const elsewhere = await w.chat.send({ message: 'other room', clientThreadId: 'ui-2', requestId: 'o1', cwd: w.project })
  assert.equal(noteOf(w.turnStarts().at(-1)), null, 'another conversation is not told'); assert.ok(elsewhere.conversationId !== sent.conversationId)
  assert.ok(w.chat.stoppedCommands.has('ui'), 'still waiting for its own conversation\'s next turn')
})

test('the draft check knows it: a stopped command told to this turn is known text for the check (its output only where terminal data may go), not an opaque reference', async t => {
  const w = world(t, { draftCheck: { mode: () => 'advisory', eligible: () => true } })
  const sent = await w.chat.send({ message: '빌드를 돌려줘', clientThreadId: 'ui', requestId: 'r1', cwd: w.project })
  await w.runCommand(sent, 'call-1', 'sleep 15 && echo build-finished'); await until(() => w.spawned.length === 1)
  await w.chat.interrupt({ conversationId: sent.conversationId, runId: sent.runId }); await until(() => w.replies.some(r => r[0] === 'call-1')); await w.finishTurn(sent)
  const second = await w.chat.send({ message: '왜 멈췄니?', clientThreadId: 'ui', requestId: 'r2', cwd: w.project, conversationId: sent.conversationId })
  assert.ok(noteOf(w.turnStarts().at(-1)))
  const entry = w.chat.draftCheckTurns.get(w.chat.runFor(second))
  assert.ok(entry, 'the check registered this turn')
  const item = entry.evidence.find(e => e.id === 'stopped'); assert.ok(item, JSON.stringify(entry.evidence)); assert.match(item.text, /stopped at the person's request after \d+\.\d s/); assert.equal(item.opaque, undefined)
  assert.equal(entry.evidence.filter(e => e.source === 'application' && e.opaque).length, 0, 'the stopped-command block is not counted as an opaque context block')
})
