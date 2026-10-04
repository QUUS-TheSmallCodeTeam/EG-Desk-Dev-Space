import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { BoundedSseClient } from './codex-bridge-sse.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'

class Response extends EventEmitter {
  constructor() { super(); this.frames = []; this.allowWrite = false; this.destroyed = false; this.writableLength = 0 }
  write(frame) { this.frames.push(frame); if (!this.allowWrite) this.writableLength += Buffer.byteLength(frame); return this.allowWrite }
  destroy() { this.destroyed = true; this.emit('close') }
  drain(allowWrite = true) { this.allowWrite = allowWrite; this.writableLength = 0; this.emit('drain') }
}

function clock() {
  const pending = new Map()
  let next = 0
  return {
    setTimer: fn => { const id = ++next; pending.set(id, fn); return id },
    clearTimer: id => pending.delete(id),
    fire: () => { for (const [id, fn] of [...pending]) { pending.delete(id); fn() } },
    pending,
  }
}

test('write(false) is accepted once and later frames wait for drain', () => {
  const response = new Response(), timers = clock()
  const client = new BoundedSseClient(response, timers)
  assert.equal(client.send('A'), true)
  assert.equal(client.send('B'), true)
  assert.equal(client.send('C'), true)
  assert.deepEqual(response.frames, ['A'])
  assert.equal(response.destroyed, false)
  response.drain()
  assert.deepEqual(response.frames, ['A', 'B', 'C'])
  assert.equal(client.queuedBytes, 0)
  assert.equal(timers.pending.size, 0)
  client.close()
})

test('backpressure can recur during drain without duplicate frames', () => {
  const response = new Response(), timers = clock()
  const client = new BoundedSseClient(response, timers)
  for (const frame of ['A', 'B', 'C']) client.send(frame)
  response.drain(false)
  assert.deepEqual(response.frames, ['A', 'B'])
  assert.equal(client.blocked, true)
  assert.equal(timers.pending.size, 1)
  response.drain()
  assert.deepEqual(response.frames, ['A', 'B', 'C'])
  client.close()
})

test('bounded queue disconnects an overflowing subscriber without writing queued frames twice', () => {
  const response = new Response(), timers = clock(), reasons = []
  const client = new BoundedSseClient(response, { ...timers, maxBufferedBytes: 8, onClose: reason => reasons.push(reason) })
  client.send('1234')
  client.send('5678')
  assert.equal(client.send('9'), false)
  assert.deepEqual(response.frames, ['1234'])
  assert.equal(response.destroyed, true)
  assert.equal(client.queue.length, 0)
  assert.equal(timers.pending.size, 0)
  assert.deepEqual(reasons, ['buffer_limit'])
})

test('drain timeout removes the subscriber; a new client can receive a fresh snapshot notification', () => {
  const response = new Response(), timers = clock(), reasons = []
  const client = new BoundedSseClient(response, { ...timers, onClose: reason => reasons.push(reason) })
  client.send('accepted-before-timeout')
  client.send('queued')
  timers.fire()
  assert.equal(response.destroyed, true)
  assert.deepEqual(reasons, ['drain_timeout'])
  assert.equal(client.send('later'), false)
  const resumedResponse = new Response()
  resumedResponse.allowWrite = true
  const resumed = new BoundedSseClient(resumedResponse, timers)
  resumed.send('event: ready\ndata: {"resyncRequired":true}\n\n')
  resumed.send('snapshot-after-last-seq')
  assert.equal(resumedResponse.frames.length, 2)
  assert.equal(resumedResponse.frames.includes('queued'), false)
  resumed.close()
})

test('normal response close clears timers, queues and listeners', () => {
  const response = new Response(), timers = clock()
  const client = new BoundedSseClient(response, timers)
  client.send('A'); client.send('B')
  response.emit('close')
  assert.equal(client.closed, true)
  assert.equal(client.queue.length, 0)
  assert.equal(timers.pending.size, 0)
  assert.equal(response.listenerCount('drain'), 0)
})

test('a slow SSE subscriber can recover completed native state without stopping the run', async () => {
  const response = new Response(), timers = clock()
  const client = new BoundedSseClient(response, timers)
  const chat = new CodexChatRuntime({
    request: async method => method === 'thread/start'
      ? { thread: { id: 'thread' } }
      : { turn: { id: 'turn', status: 'inProgress', items: [] } },
    respond: () => {}, emit: event => client.send(`data: ${JSON.stringify(event)}\n\n`),
  })
  chat.setConnection(true)
  const run = await chat.send({ message: 'Harmless test' })
  timers.fire()
  assert.equal(response.destroyed, true)
  assert.equal(chat.snapshot().connection, 'ready')
  assert.equal(chat.snapshot().runs[0].status, 'inProgress')
  await chat.handleNotification({ method: 'item/completed', params: { threadId: run.conversationId, turnId: run.runId, item: { id: 'answer', type: 'agentMessage', text: 'Done' } } })
  await chat.handleNotification({ method: 'turn/completed', params: { threadId: run.conversationId, turn: { id: run.runId, status: 'completed', items: [], itemsView: 'notLoaded' } } })
  const state = chat.snapshot(run.conversationId)
  assert.equal(state.runs[0].status, 'completed')
  assert.equal(state.runs[0].stopRequested, false)
  assert.equal(state.runs[0].messages[0].text, 'Done')
})
