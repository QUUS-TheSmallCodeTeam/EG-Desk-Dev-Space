import test from 'node:test'
import assert from 'node:assert/strict'
import { AppServerRpc } from './codex-app-server-rpc.mjs'

test('initialize response is followed by initialized before any normal request', async () => {
  const sent = []
  const rpc = new AppServerRpc({ send: text => sent.push(JSON.parse(text)) })
  await assert.rejects(rpc.request('thread/start', {}), /not connected/)
  const init = rpc.initialize()
  assert.equal(sent[0].method, 'initialize')
  rpc.receive(JSON.stringify({ id: sent[0].id, result: { userAgent: 'test' } }))
  await init
  assert.equal(sent[1].method, 'initialized')
  const request = rpc.request('thread/start', {})
  assert.equal(sent[2].method, 'thread/start')
  rpc.receive(JSON.stringify({ id: sent[2].id, result: { thread: { id: 'thread' } } }))
  assert.equal((await request).thread.id, 'thread')
  rpc.close()
})

test('server request ID collision does not resolve a pending client request', async () => {
  const sent = [], approvals = []
  const rpc = new AppServerRpc({ send: text => sent.push(JSON.parse(text)), onRequest: request => approvals.push(request) })
  rpc.ready = true
  const promise = rpc.request('turn/start', {})
  const id = sent[0].id
  rpc.receive(JSON.stringify({ id, method: 'item/commandExecution/requestApproval', params: {} }))
  assert.equal(approvals.length, 1)
  assert.equal(rpc.pending.size, 1)
  rpc.respond(id, { decision: 'decline' })
  assert.deepEqual(sent.at(-1), { id, result: { decision: 'decline' } })
  rpc.receive(JSON.stringify({ id, result: { turn: { id: 'turn' } } }))
  assert.equal((await promise).turn.id, 'turn')
  rpc.close()
})

test('disconnect rejects in-flight RPC and suppresses late traffic', async () => {
  let delivered = 0
  const rpc = new AppServerRpc({ send: () => {}, onNotification: () => delivered++ })
  rpc.ready = true
  const promise = rpc.request('thread/resume', {})
  rpc.close()
  await assert.rejects(promise, /disconnected/)
  assert.equal(rpc.pending.size, 0)
  rpc.receive(JSON.stringify({ method: 'turn/completed', params: {} }))
  assert.equal(delivered, 0)
  assert.throws(() => rpc.respond(1, {}), /not connected/)
})

test('RPC timeout rejects instead of inventing a completed turn', async () => {
  const rpc = new AppServerRpc({ send: () => {}, timeoutMs: 5 })
  rpc.ready = true
  // Keep only this unit test alive while the production timeout is unref'ed.
  const keeper = setTimeout(() => {}, 100)
  try { await assert.rejects(rpc.request('turn/start', {}), error => error.code === 'RPC_TIMEOUT') }
  finally { clearTimeout(keeper); rpc.close() }
})
