// c32 (U13, audit R-A, as corrected by the owner: the approval STATE is the action layer, the words the conversation layer): approvals decision-first behind
// EGDESK_DECISION_FIRST_APPROVALS=on (with EGDESK_DECISION_FIRST=on; default off). Fake engine, scripted Decision model, a fake spawn: nothing is sent and nothing really runs.
// The scenario of real-engine-approval-words-v1: the engine's own turn asks about a force push; "그냥 해" is settled by the Decision and run once by code; "아니 잠깐" cancels at once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { APPROVALS_FAST_LIMITS, approvalOutcomeBlock } from './egdesk-decision-first-approvals.mjs'
import { DECISION_FIRST_PICK } from './egdesk-decision-first-commands.mjs'
import { createOwnToolsWiring } from './egdesk-own-tools-wiring.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const FORCE = 'git push --force origin main'
const tmp = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-df-approvals-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }
const until = async (predicate, ms = 4000) => { const end = Date.now() + ms; while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); assert.ok(predicate(), 'condition not reached in time') }

const answerFor = body => body.questions.map(q => {
  if (q.name === DECISION_FIRST_PICK) return { name: q.name, type: 'choice', choice: 'none', confidence: 0.97, probabilities: [{ value: 'none', probability: 0.97 }, { value: q.choices.find(c => c.value !== 'none')?.value ?? 'x', probability: 0.01 }] }
  const text = JSON.stringify(body.input)
  if (q.name === 'reply_runs_command') return { name: q.name, type: 'predicate', probability: /그냥 해/.test(text) ? 0.96 : 0.03 }
  if (q.name === 'reply_declines_command') return { name: q.name, type: 'predicate', probability: /아니 잠깐/.test(text) ? 0.96 : 0.03 }
  return { name: q.name, type: 'predicate', probability: 0.04 }
})
function world(t, { approvals = true, flag = true } = {}) {
  const base = tmp(t), dataDir = path.join(base, 'egdesk-data'); fs.mkdirSync(dataDir)
  const root = fs.realpathSync(createPrivateQaTempDirectory('egdesk-df-approvals-root-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' } }))
  const ran = [], engineCalls = [], decisionBodies = []
  const spawn = (file, args) => { const command = String(args.at(-1)); ran.push(command); const child = new EventEmitter(); Object.assign(child, { pid: 7000 + ran.length, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }); setImmediate(() => { child.stdout.write('To origin\n'); setTimeout(() => child.emit('close', 0, null), 5) }); return child }
  let chat = null
  const wiring = createOwnToolsWiring({ env: { EGDESK_OWN_TOOLS: 'on', ...(flag ? { EGDESK_DECISION_FIRST: 'on' } : {}), ...(approvals ? { EGDESK_DECISION_FIRST_APPROVALS: 'on' } : {}), PATH: '/usr/bin:/bin', HOME: '/home/synthetic' }, dataDir, spawn, getChat: () => chat, home: '/home/synthetic', gitStatus: async () => '' })
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0032', recipientForKey: () => 'a'.repeat(64), fetchImpl: async (url, init) => { const body = JSON.parse(init.body); decisionBodies.push(body); return Response.json({ model: 'gpt-6-luna', answers: answerFor(body), usage: { input_tokens: 40 } }) } })
  chat = new CodexChatRuntime({
    request: async (method, params) => { engineCalls.push([method, params]); if (method === 'thread/start') return { thread: { id: 'conv-1' }, cwd: params.cwd }; if (method === 'turn/start') return { turn: { id: `turn-eng-${engineCalls.length}`, status: 'inProgress', items: [] } }; return {} },
    respond: (...args) => replies.push(args), emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, getOwnerKey: () => 'codex:df-approvals', toolProviders: wiring.toolProviders, ownTools: wiring.ownTools,
    decisionContext: { mode: () => 'on', configured: () => true, client, calibrationLog: openCalibrationLog({ dataDir: path.join(base, 'calibration'), log: () => {} }), terminalGate: wiring.terminalGate(null) } })
  const replies = []
  chat.setConnection(true)
  return { chat, root, ran, engineCalls, decisionBodies, replies, turnStarts: () => engineCalls.filter(([m]) => m === 'turn/start').map(([, p]) => p) }
}
const send = (w, message) => w.chat.send({ message, clientThreadId: 'ui', requestId: `r-${Math.random()}`, cwd: w.root, ...(w.conversationId ? { conversationId: w.conversationId } : {}) }).then(r => { w.conversationId ??= r.conversationId; return r })
// the engine's own turn: it calls the tool for the force push; the gate says the person is needed; the engine then words the question and the turn ends (what the real engine did in check-24un)
async function askedByEngine(w) {
  const first = await send(w, `Run this command: ${FORCE}`), run = w.chat.runFor(first)
  await until(() => w.turnStarts().length === 1)
  const call = w.chat.handleServerRequest({ id: 'tool-1', method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: 'tool-1', tool: 'egdesk_run_command', arguments: { command: FORCE } } })
  await until(() => w.replies.some(r => r[0] === 'tool-1')); await call
  const result = JSON.parse(w.replies.find(r => r[0] === 'tool-1')[1].contentItems[0].text); assert.equal(result.status, 'needs_person'); assert.deepEqual(w.ran, [], 'nothing ran: the command waits for the person')
  await w.chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn: { id: run.runId, status: 'completed', items: [] } } }); await w.chat.queue
  assert.equal(w.chat.gateHookBroker().awaitingReply(run.conversationId), true, 'the ledger waits for the reply')
  return run
}
const contextOf = turnStart => JSON.stringify(turnStart)

test('pure: the outcome block says what became of the command, facts only, and tells the engine not to call the tool', () => {
  assert.match(approvalOutcomeBlock({ outcome: 'ran', command: FORCE, exitCode: 128, durationMs: 900, tail: 'fatal: not a git repository' }), /approved `git push --force origin main`; EG-Desk ran it once \(0\.9 s\) with exit code 128\. Do not call the tool for it again\.\nLast lines of its output:\nfatal: not a git repository/)
  assert.match(approvalOutcomeBlock({ outcome: 'declined', command: FORCE }), /declined .*did not run it.*Do not call the tool for it\./s); assert.match(approvalOutcomeBlock({ outcome: 'unclear', command: FORCE }), /did not approve/)
  assert.ok(approvalOutcomeBlock({ outcome: 'ran', command: FORCE, tail: 'x'.repeat(5000) }).length < 900, 'bounded'); assert.equal(typeof APPROVALS_FAST_LIMITS.timeoutMs, 'number')
})

test('the broker names the one pending command and says declined only for a clear no; a conversation with nothing pending has none', async t => {
  const w = world(t), run = await askedByEngine(w), broker = w.chat.gateHookBroker()
  assert.deepEqual([broker.pendingAsk(run.conversationId).command, broker.pendingAsk('other')], [FORCE, null]); assert.ok(broker.pendingAsk(run.conversationId).reasons.length >= 1)
})

test('"그냥 해": the Decision settles the reply and CODE runs exactly that command once, at once; the engine continues ONCE with the result as context and no tool call; nothing is posted by code', async t => {
  const w = world(t), asked = await askedByEngine(w), before = w.turnStarts().length
  const sent = await send(w, '그냥 해'), run = w.chat.runFor(sent)
  assert.equal(sent.accepted, true); assert.deepEqual(w.ran, [FORCE], 'run once, before the engine speaks'); assert.equal(w.turnStarts().length, before + 1, 'the engine continues once')
  assert.deepEqual([run.decisionFirst.path, run.decisionFirst.reason], ['engine', 'approval_ran']); assert.ok(w.decisionBodies.some(b => b.questions.some(q => q.name === 'reply_runs_command')), 'the existing approval judgement read the reply')
  const turn = contextOf(w.turnStarts().at(-1)); assert.match(turn, /EG-Desk fact about the command the person was asked to approve/); assert.match(turn, /ran it once/); assert.match(turn, /Do not call the tool for it again/)
  assert.equal(run.messages.filter(m => m.role === 'assistant').length, 0, 'no sentence of code in the conversation'); assert.equal(w.chat.gateHookBroker().awaitingReply(asked.conversationId), false)
})

test('"아니 잠깐": cancelled by code: nothing runs, the question is closed, and the engine continues ONCE with the decline as context (so it cannot sit waiting on a tool call)', async t => {
  const w = world(t), asked = await askedByEngine(w), before = w.turnStarts().length
  const sent = await send(w, '아니 잠깐'), run = w.chat.runFor(sent)
  assert.deepEqual(w.ran, []); assert.equal(w.turnStarts().length, before + 1); assert.deepEqual([run.decisionFirst.path, run.decisionFirst.reason], ['engine', 'approval_declined'])
  const turn = contextOf(w.turnStarts().at(-1)); assert.match(turn, /The person declined/); assert.match(turn, /Do not call the tool for it\./); assert.equal(w.chat.gateHookBroker().awaitingReply(asked.conversationId), false)
  assert.equal(run.messages.filter(m => m.role === 'assistant').length, 0)
})

test('a reply that neither approves nor declines ("그건 뭔데?") is the engine\'s message as today: nothing ran, no outcome block; the question is closed (one hop)', async t => {
  const w = world(t), asked = await askedByEngine(w), before = w.turnStarts().length
  const sent = await send(w, '그건 뭔데?'), run = w.chat.runFor(sent)
  assert.deepEqual(w.ran, []); assert.equal(w.turnStarts().length, before + 1); assert.deepEqual([run.decisionFirst.path, run.decisionFirst.reason], ['engine', 'approval_unclear'])
  assert.doesNotMatch(contextOf(w.turnStarts().at(-1)), /asked to approve/); assert.equal(w.chat.gateHookBroker().awaitingReply(asked.conversationId), false)
})

test('defaults unchanged: with the approvals flag off (or the whole decision-first flag off) the reply goes to the engine exactly as today: nothing is run by code, the engine runs the command through its own tool call', async t => {
  for (const opts of [{ approvals: false }, { flag: false, approvals: false }]) {
    const w = world(t, opts), asked = await askedByEngine(w), before = w.turnStarts().length
    const sent = await send(w, '그냥 해'); await until(() => w.turnStarts().length === before + 1)
    assert.deepEqual(w.ran, [], 'EG-Desk runs nothing before the engine\'s own tool call'); assert.doesNotMatch(contextOf(w.turnStarts().at(-1)), /asked to approve/); assert.equal(w.chat.runFor(sent).decisionFirst ?? null, opts.flag === false ? null : w.chat.runFor(sent).decisionFirst ?? null)
    assert.equal(w.chat.gateHookBroker().awaitingReply(asked.conversationId), false, 'the ordinary path read the reply (approved once for the engine\'s retry)')
  }
})
