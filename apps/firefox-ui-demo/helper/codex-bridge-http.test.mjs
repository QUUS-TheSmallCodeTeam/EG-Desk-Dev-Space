import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createChatHttpHandler, guardBridgeRequest, readJsonBody, setBridgeCors } from './codex-bridge-http.mjs'

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
