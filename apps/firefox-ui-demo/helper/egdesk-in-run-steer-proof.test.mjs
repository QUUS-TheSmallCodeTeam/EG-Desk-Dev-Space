// c25 (L2's c21 finding, Main's item 1): the person's message typed into a working run is steered into the native turn when it asks for a change. That steer carries no
// additional context (only the text), so the proof it needs is the schema-derived steer contract of the connected binary (c23), not the board peer contract that the code
// grants to 0.162.1 only. Without any contract the message waits for the next turn, as before. Mock engine, in-process; no Codex.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const STEER = 'd'.repeat(64), PEER = 'e'.repeat(64)
function world(t, contracts) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-in-run-steer-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const project = path.join(base, 'project'); fs.mkdirSync(project)
  const calls = []
  const store = openChatStore({ dataDir: path.join(base, 'chat'), ownerScope: 'in-run-steer' })
  t.after(() => { try { store.close() } catch {} })
  let turns = 0
  const chat = new CodexChatRuntime({
    request: async (method, params) => {
      calls.push([method, structuredClone(params)])
      if (method === 'thread/start') return { thread: { id: 'conv-1' }, cwd: params.cwd }
      if (method === 'turn/start') return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } }
      if (method === 'turn/steer') return { turnId: params.expectedTurnId }
      return {}
    },
    respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, getOwnerKey: () => 'codex:steer', store, requireStore: true,
    ...contracts, decisionContext: { mode: () => 'off', configured: () => false, client: null, inRunMessages: { mode: () => 'on' } },
  })
  chat.setConnection(true)
  const steered = () => calls.filter(([m]) => m === 'turn/steer').map(([, p]) => p)
  return { chat, project, steered }
}
async function working(w) {
  const sent = await w.chat.send({ message: 'Fix the readme', clientThreadId: 'ui', requestId: 'r1', cwd: w.project })
  const run = w.chat.runFor(sent)
  const accepted = await w.chat.send({ clientThreadId: 'ui', conversationId: sent.conversationId, message: 'Actually, do the changelog first', requestId: 'r2', inRunMessageTo: sent.runId })
  assert.equal(accepted.accepted, true); assert.equal(accepted.inRun, true)
  return { sent, run }
}

test('a change message is steered with the schema-derived steer contract alone: no additional context, the running turn named, the message id kept', async t => {
  const w = world(t, { getSteerContract: () => STEER })
  const { sent, run } = await working(w)
  assert.equal(await w.chat.settleInRunMessage(run, 'r2', 'steer'), 'steer')
  assert.deepEqual(w.steered(), [{ threadId: sent.conversationId, expectedTurnId: sent.runId, clientUserMessageId: 'r2', input: [{ type: 'text', text: 'Actually, do the changelog first', text_elements: [] }] }])
  assert.equal('additionalContext' in w.steered()[0], false)
  assert.deepEqual(w.chat.pendingInRunMessages(run), [], 'settled: nothing left pending')
})

test('no contract on this binary: the message stays pending (and is carried into the next turn); an older binary with only the board peer contract still steers', async t => {
  const none = world(t, {})
  const a = await working(none)
  assert.equal(await none.chat.settleInRunMessage(a.run, 'r2', 'steer'), 'failed'); assert.deepEqual(none.steered(), [], 'nothing was sent')
  assert.equal(none.chat.pendingInRunMessages(a.run).length, 1, 'the message waits')
  const old = world(t, { getBoardPeerContract: () => PEER })
  const b = await working(old)
  assert.equal(await old.chat.settleInRunMessage(b.run, 'r2', 'steer'), 'steer'); assert.equal(old.steered().length, 1)
  const both = world(t, { getSteerContract: () => STEER, getBoardPeerContract: () => PEER })
  const c = await working(both)
  assert.equal(await both.chat.settleInRunMessage(c.run, 'r2', 'steer'), 'steer')
})
