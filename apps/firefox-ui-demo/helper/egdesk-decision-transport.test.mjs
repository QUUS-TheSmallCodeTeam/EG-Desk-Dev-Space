import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { createDecisionTransport } from './egdesk-decision-transport.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const QUESTION = { type: 'predicate', name: 'p', instructions: 'Is it?' }

// Loopback server that records connections, raw bytes per connection and requests.
async function server(t, { onRequest } = {}) {
  const log = { connections: 0, closed: 0, bytes: 0, requests: [] }
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
  srv.on('connection', socket => { socket._id = ++log.connections; socket.on('close', () => { log.closed++ }); socket.on('data', d => { log.bytes += d.length }) })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  t.after(() => { srv.closeAllConnections(); srv.close() })
  return { log, url: `http://127.0.0.1:${srv.address().port}/v1/decisions` }
}
const mkTransport = (t, options) => { const tr = createDecisionTransport(options); t.after(() => tr.close()); return tr }
const post = (tr, url, body = '{"a":1}', init = {}) => tr.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer egd-synthetic-not-a-key-0005' }, body, ...init })

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

test('hardening: Connection: close responses are never pooled and never error', async t => {
  const { log, url } = await server(t, { onRequest: (req, res) => { res.writeHead(200, { connection: 'close' }); res.end('{"answers":[]}'); return true } })
  const tr = mkTransport(t)
  for (let i = 0; i < 3; i++) await (await post(tr, url, `{"i":${i}}`)).text()
  assert.equal(log.connections, 3)
  assert.equal(tr.stats().reusedSockets, 0)
  assert.equal(tr.stats().reusedSocketErrors, 0)
  assert.deepEqual(log.requests.map(r => r.body), ['{"i":0}', '{"i":1}', '{"i":2}'])
})

test('hardening: a silent (half-open) reused socket times out as dispatched, is destroyed, and the next call uses a fresh socket once', async t => {
  let n = 0
  const { log, url } = await server(t, { onRequest: () => { n++; return n === 2 } }) // 2nd request is received and never answered
  const tr = mkTransport(t)
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0005', endpoint: url, fetchImpl: tr.fetch })
  await client.decide({ input: 'h1', questions: [QUESTION], timeoutMs: 2000 })
  await assert.rejects(client.decide({ input: 'h2', questions: [QUESTION], timeoutMs: 150 }), e => e.code === 'timeout' && e.dispatched === true)
  await client.decide({ input: 'h3', questions: [QUESTION], timeoutMs: 2000 })
  assert.equal(log.connections, 2, 'the silent socket was not reused')
  assert.deepEqual(log.requests.map(r => JSON.parse(r.body).input), ['h1', 'h2', 'h3'])
  assert.equal(tr.stats().reusedSocketErrors, 0, 'our own timeout is not a stale-socket error')
})

test('hardening: twelve concurrent decisions are all sent once each and none is throttled behind a small socket cap', async t => {
  const { log, url } = await server(t, { onRequest: (req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ answers: [{ name: 'p', type: 'predicate', probability: 0.9 }] })) }, 200); return true } })
  const tr = mkTransport(t)
  const client = createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0005', endpoint: url, fetchImpl: tr.fetch })
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => client.decide({ input: `f${i}`, questions: [QUESTION], timeoutMs: 450 })))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 12)
  const ids = log.requests.map(r => JSON.parse(r.body).input)
  assert.equal(new Set(ids).size, 12)
  assert.equal(ids.length, 12, 'never two sends for one intent')
})

test('hardening: close() releases parked sockets', async t => {
  const { log, url } = await server(t)
  const tr = createDecisionTransport()
  await (await post(tr, url)).text() // parks a free socket
  const other = createDecisionTransport(); t.after(() => other.close())
  await (await post(other, url)).text() // a second parked socket on a second transport
  await sleep(100)
  assert.equal(log.connections, 2)
  assert.equal(log.closed, 0)
  tr.close(); other.close()
  for (let i = 0; i < 40 && log.closed < 2; i++) await sleep(10)
  assert.equal(log.closed, 2, 'both parked sockets were closed by shutdown')
})

test('warm() reads the pool: false on a cold transport, true while a kept-alive socket is free, false once it is dropped after the idle cap', async t => {
  const { url } = await server(t)
  const tr = mkTransport(t, { idleMs: 150 })
  assert.equal(tr.warm(), false, 'cold process: no socket yet')
  const res = await post(tr, url)
  await res.text()
  await sleep(20)
  assert.equal(tr.warm(), true, 'the socket went back to the free pool')
  await sleep(400)
  assert.equal(tr.warm(), false, 'idle past the cap: the pool dropped it')
})
