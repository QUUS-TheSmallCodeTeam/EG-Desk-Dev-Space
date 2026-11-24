import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { createDecisionTransport } from './egdesk-decision-transport.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const QUESTION = { type: 'predicate', name: 'p', instructions: 'Is it?' }

// Loopback server that records connections, raw bytes per connection and requests.
async function server(t, { onRequest } = {}) {
  const log = { connections: 0, bytes: 0, requests: [] }
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const entry = { headers: req.headers, body: Buffer.concat(chunks).toString(), socket: req.socket._id }
      log.requests.push(entry)
      if (onRequest?.(req, res, entry)) return
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ answers: [{ name: 'p', type: 'predicate', probability: 0.9 }], usage: { input_tokens: 1 } }))
    })
  })
  srv.keepAliveTimeout = 0
  srv.on('connection', socket => { socket._id = ++log.connections; socket.on('data', d => { log.bytes += d.length }) })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  t.after(() => { srv.closeAllConnections(); srv.close() })
  return { log, url: `http://127.0.0.1:${srv.address().port}/v1/decisions` }
}
const mkTransport = (t, options) => { const tr = createDecisionTransport(options); t.after(() => tr.close()); return tr }
const post = (tr, url, body = '{"a":1}', init = {}) => tr.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer egd-synthetic-not-a-key-0005' }, body, ...init })

test('pre-connect opens one connection and writes nothing: no bytes, no request, no credential', async t => {
  const { log, url } = await server(t)
  const tr = mkTransport(t)
  assert.equal(tr.preconnect(url), 'warmed')
  await sleep(150)
  assert.equal(log.connections, 1)
  assert.equal(log.bytes, 0, 'not a single byte reached the server')
  assert.equal(log.requests.length, 0)
  assert.equal(tr.preconnect(url), 'skipped', 'at most one warm-up per idle period')
  await sleep(50)
  assert.equal(log.connections, 1)
})

test('the next real request adopts the warm socket; the key travels only in that request', async t => {
  const { log, url } = await server(t)
  const tr = mkTransport(t)
  tr.preconnect(url)
  await sleep(100)
  const response = await post(tr, url)
  assert.equal(response.status, 200)
  await response.text()
  assert.equal(log.connections, 1, 'no second connection')
  assert.equal(log.requests.length, 1)
  assert.match(log.requests[0].headers.authorization, /^Bearer egd-synthetic/)
  assert.equal(tr.stats().warmAdopted, 1)
  // a real request ended the idle period, so a later warm-up is allowed again
  await sleep(10)
  assert.equal(tr.preconnect(url), 'skipped', 'a parked free socket already exists')
})

test('an unused warm socket is closed after its idle limit and never reused', async t => {
  const { log, url } = await server(t)
  const tr = mkTransport(t, { warmIdleMs: 120 })
  tr.preconnect(url)
  await sleep(350)
  assert.equal(tr.stats().warmExpired, 1)
  const response = await post(tr, url); await response.text()
  assert.equal(log.connections, 2, 'the expired warm socket was not used')
})

test('sequential requests reuse one socket; the decision client works over the transport', async t => {
  const { log, url } = await server(t)
  const tr = mkTransport(t)
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0005', endpoint: url, fetchImpl: tr.fetch })
  const first = await client.decide({ input: 'x', questions: [QUESTION], timeoutMs: 3000 })
  const second = await client.decide({ input: 'y', questions: [QUESTION], timeoutMs: 3000 })
  assert.equal(first.answers.p.type, 'predicate')
  assert.equal(second.answers.p.probability, 0.9)
  assert.equal(log.connections, 1)
  assert.equal(tr.stats().reusedSockets, 1)
})

test('a server Keep-Alive hint shortens the idle limit (hint minus margin)', async t => {
  const { log, url } = await server(t, { onRequest: (req, res) => { res.writeHead(200, { 'keep-alive': 'timeout=2' }); res.end('{"answers":[]}'); return true } })
  const tr = mkTransport(t, { idleMs: 30_000 })
  await (await post(tr, url)).text()
  await sleep(1300) // 2 s hint - 1 s margin = 1 s: the socket was closed before the server could
  await (await post(tr, url)).text()
  assert.equal(log.connections, 2)
  assert.equal(tr.stats().reusedSocketErrors, 0)
})

test('a failed reused socket is reported, never replayed: the server sees each body exactly once', async t => {
  let n = 0
  const { log, url } = await server(t, { onRequest: (req) => { n++; if (n === 2) { req.socket.destroy(); return true } return false } })
  const tr = mkTransport(t)
  await (await post(tr, url, '{"n":1}')).text()
  await assert.rejects(post(tr, url, '{"n":2}'), e => e.reusedSocket === true)
  assert.deepEqual(log.requests.map(r => r.body), ['{"n":1}', '{"n":2}'])
  assert.equal(tr.stats().reusedSocketErrors, 1)
  // the broken socket is gone; the next call is a fresh, single request
  await (await post(tr, url, '{"n":3}')).text()
  assert.deepEqual(log.requests.map(r => r.body), ['{"n":1}', '{"n":2}', '{"n":3}'])
})

test('a decision client error on a dead reused socket says the request was dispatched (may be billed)', async t => {
  let n = 0
  const { url } = await server(t, { onRequest: req => { n++; if (n === 2) { req.socket.destroy(); return true } return false } })
  const tr = mkTransport(t)
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0005', endpoint: url, fetchImpl: tr.fetch })
  await client.decide({ input: 'x', questions: [QUESTION], timeoutMs: 3000 })
  await assert.rejects(client.decide({ input: 'y', questions: [QUESTION], timeoutMs: 3000 }), e => e.code === 'unreachable' && e.dispatched === true)
})

test('abort rejects with AbortError, an aborted-before-start request sends nothing, redirects are errors', async t => {
  const { log, url } = await server(t, { onRequest: (req, res) => { if (req.url === '/redir') { res.writeHead(302, { location: '/x' }); res.end(); return true } return false } })
  const tr = mkTransport(t)
  const pre = new AbortController(); pre.abort()
  await assert.rejects(post(tr, url, '{}', { signal: pre.signal }), e => e.name === 'AbortError')
  assert.equal(log.connections, 0)
  const live = new AbortController()
  const pending = post(tr, url.replace('/v1/decisions', '/hang'), '{}', { signal: live.signal })
  live.abort()
  await assert.rejects(pending, e => e.name === 'AbortError')
  await assert.rejects(post(tr, url.replace('/v1/decisions', '/redir')), e => e instanceof TypeError)
})

test('optional trace reports phase names and times only (no content), and marks reuse', async t => {
  const { url } = await server(t)
  const events = []
  const tr = mkTransport(t, { trace: e => events.push(e) })
  await (await post(tr, url, '{"secret":"body-text"}')).text()
  await (await post(tr, url, '{"secret":"body-text"}')).text()
  assert.deepEqual([...new Set(events.flatMap(e => Object.keys(e)))].sort(), ['phase', 'reused', 't'])
  const phases = events.map(e => e.phase)
  assert.deepEqual(phases.filter(p => p === 'start' || p === 'response'), ['start', 'response', 'start', 'response'])
  assert.ok(phases.includes('connect'))
  assert.equal(events.at(-1).reused, true)
  assert.doesNotMatch(JSON.stringify(events), /body-text|egd-synthetic/)
})
