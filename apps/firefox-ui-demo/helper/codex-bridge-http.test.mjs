import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createChatHttpHandler, guardBridgeRequest, readJsonBody, setBridgeCors } from './codex-bridge-http.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'

function request(body, headers = {}, url = '/chat/send') {
  const req = Readable.from([Buffer.from(body)])
  req.method = 'POST'
  req.url = url
  req.headers = { host: '127.0.0.1:39218', 'content-type': 'application/json', ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}
function response() {
  return { headers: {}, setHeader(key, value) { this.headers[key] = value }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) }, end(body) { this.body = body ? JSON.parse(body) : null } }
}

test('loopback boundary rejects hostile Origin, Host, cross-site and nonlocal requests', () => {
  assert.equal(guardBridgeRequest(request('{}')), true)
  assert.equal(guardBridgeRequest(request('{}', { origin: 'null' })), true)
  assert.equal(guardBridgeRequest(request('{}', { origin: 'chrome://browser' })), true)
  for (const headers of [{ origin: 'https://evil.example' }, { host: 'evil.example:39218' }, { origin: 'http://localhost:8080' }, { origin: 'null', 'sec-fetch-site': 'cross-site' }]) assert.equal(guardBridgeRequest(request('{}', headers)), false)
  const remote = request('{}'); remote.socket.remoteAddress = '192.168.1.1'
  assert.equal(guardBridgeRequest(remote), false)
  assert.equal(guardBridgeRequest(request('{}', {}, 'http://evil.example/chat/send')), false)
  const res = response(); setBridgeCors(request('{}', { origin: 'null' }), res)
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'null')
  assert.notEqual(res.headers['Access-Control-Allow-Origin'], '*')
})

test('opaque/null origins reject same-site and every unrecognized present Fetch Metadata value', () => {
  for (const fetchSite of ['same-site', 'cross-site', 'unknown', '', 'Same-Origin', 'none, same-origin', null, undefined, ['same-origin']]) {
    assert.equal(guardBridgeRequest(request('{}', { origin: 'null', 'sec-fetch-site': fetchSite })), false, String(fetchSite))
  }
  for (const origin of ['https://evil.example', 'http://localhost:8080', 'http://127.0.0.1:8080']) {
    for (const fetchSite of ['none', 'same-origin']) {
      assert.equal(guardBridgeRequest(request('{}', { origin, 'sec-fetch-site': fetchSite })), false)
    }
  }
})

test('trusted loopback/Chrome origins retain missing-header, none and same-origin compatibility', () => {
  for (const origin of [undefined, 'null', 'chrome://browser', 'chrome://userchrome', 'http://127.0.0.1:39218', 'http://localhost:39218']) {
    for (const fetchSite of [undefined, 'none', 'same-origin']) {
      const headers = {}
      if (origin !== undefined) headers.origin = origin
      if (fetchSite !== undefined) headers['sec-fetch-site'] = fetchSite
      assert.equal(guardBridgeRequest(request('{}', headers)), true)
      assert.equal(guardBridgeRequest(request('{}', { ...headers, host: 'other.example:39218' })), false)
    }
  }
})

test('JSON reader rejects oversized bodies, non-JSON types and non-object data', async () => {
  assert.deepEqual(await readJsonBody(request('{"message":"hi"}')), { message: 'hi' })
  await assert.rejects(readJsonBody(request('[')), e => e.code === 'INVALID_JSON')
  await assert.rejects(readJsonBody(request('[]')), e => e.code === 'INVALID_JSON')
  await assert.rejects(readJsonBody(request('{}', { 'content-type': 'text/plain' })), e => e.httpStatus === 415)
  await assert.rejects(readJsonBody(request('x'.repeat(65537))), e => e.httpStatus === 413)
})

test('HTTP send preserves accepted/conversationId and adds run IDs without listening on a socket', async () => {
  let received
  const handler = createChatHttpHandler({ send: async body => { received = body; return { accepted: true, conversationId: 'thread', runId: 'turn', answerId: 'thread/turn' } } }, async () => {})
  const res = response()
  assert.equal(await handler(request('{"message":"hi"}'), res, new URL('http://localhost/chat/send')), true)
  assert.equal(res.status, 202)
  assert.equal(res.body.accepted, true)
  assert.equal(res.body.conversationId, 'thread')
  assert.deepEqual(received, { message: 'hi' })
})

test('HTTP approval conflict returns explicit failure, never success', async () => {
  const handler = createChatHttpHandler({ replyApproval: async () => { throw Object.assign(new Error('Stale'), { httpStatus: 409, code: 'STALE_APPROVAL' }) } }, async () => {})
  const res = response()
  await handler(request('{"conversationId":"t","approvalId":"old"}'), res, new URL('http://localhost/chat/approval'))
  assert.equal(res.status, 409)
  assert.deepEqual(res.body, { accepted: false, conversationId: 't', requestId: null, code: 'STALE_APPROVAL', error: 'Stale' })
})

test('state polling is bounded by runtime snapshot and does not call account APIs', async () => {
  let authCalls = 0
  const handler = createChatHttpHandler({ snapshot: id => ({ conversationId: id, runs: [], truncated: true }) }, async () => { authCalls++ })
  const req = request(''); req.method = 'GET'
  const res = response()
  await handler(req, res, new URL('http://localhost/chat/state?conversationId=existing'))
  assert.equal(res.body.conversationId, 'existing')
  assert.equal(res.body.truncated, true)
  assert.equal(authCalls, 0)
})

test('HTTP failure after native thread creation returns the recoverable native ID and request ID', async () => {
  const nativeCalls = []
  const chat = new CodexChatRuntime({
    request: async (method, params) => {
      nativeCalls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'created-native-thread' } }
      throw Object.assign(new Error('Turn rejected'), { code: -32602 })
    }, respond: () => {},
  })
  chat.setConnection(true)
  const handler = createChatHttpHandler(chat, async () => {})
  const res = response()
  await handler(request('{"message":"Hi","requestId":"ui-request","clientThreadId":"ui-thread"}'), res, new URL('http://localhost/chat/send'))
  assert.equal(res.status, 400)
  assert.equal(res.body.accepted, false)
  assert.equal(res.body.conversationId, 'created-native-thread')
  assert.equal(res.body.requestId, 'ui-request')
  assert.equal(res.body.resumeRequired, false)
  const retry = response()
  await handler(request('{"message":"Retry","requestId":"new-request","clientThreadId":"ui-thread"}'), retry, new URL('http://localhost/chat/send'))
  assert.equal(retry.status, 409)
  assert.equal(retry.body.conversationId, 'created-native-thread')
  assert.equal(nativeCalls.filter(call => call.method === 'thread/start').length, 1)
})

test('known Stop, decline and cancel work when auth refresh fails; accept still requires auth', async () => {
  const native = [], replies = []
  const chat = new CodexChatRuntime({
    request: async (method, params) => {
      native.push({ method, params })
      if (method === 'thread/start') return { thread: { id: 'thread' } }
      if (method === 'turn/start') return { turn: { id: 'turn', status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      throw new Error('Unexpected native call')
    }, respond: (...args) => replies.push(args),
  })
  chat.setConnection(true)
  const run = await chat.send({ message: 'Work' })
  let authCalls = 0
  const handler = createChatHttpHandler(chat, async () => { authCalls++; throw Object.assign(new Error('Account lookup failed'), { httpStatus: 503 }) })
  const stop = response()
  await handler(request(JSON.stringify(run)), stop, new URL('http://localhost/chat/interrupt'))
  assert.equal(stop.status, 200)
  assert.equal(stop.body.stopRequested, true)
  assert.equal(authCalls, 0)
  for (const decision of ['decline', 'cancel', 'accept']) {
    await chat.handleServerRequest({ id: decision, method: 'item/commandExecution/requestApproval', params: { threadId: run.conversationId, turnId: run.runId, itemId: decision, command: 'echo harmless' } })
    const approvalId = chat.snapshot().runs[0].pendingApprovals.at(-1).approvalId
    const res = response()
    await handler(request(JSON.stringify({ ...run, approvalId, decision })), res, new URL('http://localhost/chat/approval'))
    assert.equal(res.status, decision === 'accept' ? 503 : 200)
  }
  assert.equal(authCalls, 1)
  assert.deepEqual(replies.map(reply => reply[1].decision), ['decline', 'cancel'])
  const invalid = response()
  await handler(request(JSON.stringify({ ...run, runId: 'wrong', approvalId: 'unknown', decision: 'decline' })), invalid, new URL('http://localhost/chat/approval'))
  assert.equal(invalid.status, 409)
  assert.equal(replies.length, 2)
})

test('HTTP explicit invalid cwd returns INVALID_CWD before auth lookup or a native runtime call', async () => {
  let authCalls = 0, nativeCalls = 0
  const chat = new CodexChatRuntime({ request: async () => { nativeCalls++; throw new Error('Must not run') }, respond: () => {} })
  chat.setConnection(true)
  const handler = createChatHttpHandler(chat, async () => { authCalls++; throw new Error('Must not run auth') })
  for (const cwd of [null, '', ' ', 'relative/path', 'file:///tmp/work', 0, [], {}, '/tmp/bad\0path']) {
    const res = response()
    await handler(request(JSON.stringify({ message: 'Hello', cwd })), res, new URL('http://localhost/chat/send'))
    assert.equal(res.status, 400)
    assert.equal(res.body.code, 'INVALID_CWD')
    assert.equal(res.body.accepted, false)
  }
  assert.equal(authCalls, 0)
  assert.equal(nativeCalls, 0)
})
