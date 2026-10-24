import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { WORKFLOW_TOPICS, createWorkflowEventBus, createWorkflowEventHttpHandler, publicBrowserLocation, relativeRootPath } from './egdesk-event-bus.mjs'

const OWNER = 'egdesk-local'
const tick = () => new Promise(resolve => setImmediate(resolve))

async function request(handler, method, url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  Object.assign(req, { method, url, socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:39218', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } })
  const res = { headers: {}, status: null, body: null,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value },
    writeHead(status) { this.status = status },
    end(text) { this.body = JSON.parse(text) } }
  const handled = await handler(req, res)
  return { handled, ...res }
}

test('each topic has one fixed payload shape; extra fields, unknown topics and raw identifiers are refused', () => {
  const bus = createWorkflowEventBus()
  assert.deepEqual([...WORKFLOW_TOPICS], ['terminal.exit', 'auth.changed', 'file.changed', 'browser.navigated', 'browser.oauthCompleted', 'user.action'])
  const exit = bus.publish({ topic: 'terminal.exit', owner: OWNER, payload: { sessionId: 'term-1a2b', exitCode: 0 } })
  assert.deepEqual(exit.payload, { sessionId: 'term-1a2b', exitCode: 0, signal: null })
  assert.equal(exit.source, 'terminal')
  assert.equal(exit.summary, 'Terminal process exited with code 0')
  assert.equal(exit.seq, 1)
  assert.ok(Object.isFrozen(exit) && Object.isFrozen(exit.payload))
  assert.deepEqual(bus.publish({ topic: 'auth.changed', owner: OWNER, payload: { signedIn: true } }).payload, { signedIn: true })
  assert.throws(() => bus.publish({ topic: 'auth.changed', owner: OWNER, payload: { signedIn: true, accountEmail: 'a@example.com' } }), { code: 'WORKFLOW_EVENT_INPUT' })
  assert.throws(() => bus.publish({ topic: 'auth.changed', owner: OWNER, payload: { signedIn: 'yes' } }), { code: 'WORKFLOW_EVENT_INPUT' })
  assert.throws(() => bus.publish({ topic: 'chat.anything', owner: OWNER, payload: {} }), { code: 'WORKFLOW_EVENT_TOPIC' })
  assert.throws(() => bus.publish({ topic: 'file.changed', owner: OWNER, payload: { rootId: 'r1', relativePath: '/etc/passwd', change: 'change' } }), { code: 'WORKFLOW_EVENT_INPUT' })
  assert.throws(() => bus.publish({ topic: 'file.changed', owner: OWNER, payload: { rootId: 'r1', relativePath: 'a/../../b', change: 'change' } }), { code: 'WORKFLOW_EVENT_INPUT' })
  assert.throws(() => bus.publish({ topic: 'browser.oauthCompleted', owner: OWNER, payload: { cardId: 'c', origin: 'https://a.example', path: '/cb?code=1' } }), { code: 'WORKFLOW_EVENT_INPUT' })
  assert.throws(() => bus.publish({ topic: 'terminal.exit', payload: { sessionId: 't', exitCode: 0 } }), /owner scope/)
  assert.equal(relativeRootPath('docs/report.pdf'), 'docs/report.pdf')
  for (const bad of ['', '/abs', 'a//b', './a', 'a/..', 'a\\b', 'a\u0000b']) assert.equal(relativeRootPath(bad), null, bad)
})

test('browser locations keep only origin and path; query, fragment, userinfo and non-web schemes never pass', () => {
  assert.deepEqual(publicBrowserLocation('https://user:pw@login.example:8443/oauth/callback?code=SECRET&state=s#frag'),
    { origin: 'https://login.example:8443', path: '/oauth/callback' })
  assert.deepEqual(publicBrowserLocation('http://127.0.0.1:5173'), { origin: 'http://127.0.0.1:5173', path: '/' })
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'about:blank', 'not a url', 42]) {
    assert.throws(() => publicBrowserLocation(bad), { code: 'WORKFLOW_EVENT_INPUT' })
  }
})

test('delivery is scoped by owner and topic, serial per subscriber, and stops on unsubscribe', async () => {
  const bus = createWorkflowEventBus()
  const local = [], other = [], exits = []
  const offLocal = bus.subscribe({ owner: OWNER }, event => { local.push(event.topic) })
  bus.subscribe({ owner: 'someone-else' }, event => { other.push(event.topic) })
  bus.subscribe({ owner: OWNER, topics: ['terminal.exit'] }, async event => { await tick(); exits.push(event.payload.sessionId) })
  bus.publish({ topic: 'terminal.exit', owner: OWNER, payload: { sessionId: 'term-a', exitCode: 1 } })
  bus.publish({ topic: 'auth.changed', owner: OWNER, payload: { signedIn: false } })
  bus.publish({ topic: 'terminal.exit', owner: OWNER, payload: { sessionId: 'term-b', exitCode: 0 } })
  assert.deepEqual(local, [], 'listeners run after the publishing call returns')
  await bus.flush()
  assert.deepEqual(local, ['terminal.exit', 'auth.changed', 'terminal.exit'])
  assert.deepEqual(other, [])
  assert.deepEqual(exits, ['term-a', 'term-b'])
  offLocal()
  bus.publish({ topic: 'auth.changed', owner: OWNER, payload: { signedIn: true } })
  await bus.flush()
  assert.equal(local.length, 3)
  assert.deepEqual(bus.recent({ owner: 'someone-else' }).events, [])
  assert.deepEqual(bus.recent({ owner: OWNER, since: 2 }).events.map(event => event.seq), [3, 4])
})

test('queues, history and publish rate are bounded: a stuck subscriber loses its oldest events, not memory', async () => {
  let clock = 1_000
  const bus = createWorkflowEventBus({ maxRecent: 4, maxQueue: 3, maxPerTopicPerSecond: 5, now: () => clock })
  let release
  const gate = new Promise(resolve => { release = resolve })
  const seen = []
  bus.subscribe({ owner: OWNER }, async event => { seen.push(event.seq); if (event.seq === 1) await gate })
  bus.publish({ topic: 'auth.changed', owner: OWNER, payload: { signedIn: true } })
  await tick()
  assert.deepEqual(seen, [1], 'the subscriber is now stuck on event 1')
  for (let index = 0; index < 4; index += 1) bus.publish({ topic: 'auth.changed', owner: OWNER, payload: { signedIn: index % 2 === 0 } })
  assert.equal(bus.publish({ topic: 'auth.changed', owner: OWNER, payload: { signedIn: true } }), null, 'sixth event in one second is rate-limited')
  release()
  await bus.flush()
  assert.deepEqual(seen, [1, 3, 4, 5])
  assert.deepEqual(bus.stats(), { seq: 5, subscribers: 1, dropped: 1, rateLimited: 1 })
  assert.deepEqual(bus.recent({ owner: OWNER }).events.map(event => event.seq), [2, 3, 4, 5])
  clock += 1000
  assert.equal(bus.publish({ topic: 'auth.changed', owner: OWNER, payload: { signedIn: true } }).seq, 6)
})

test('POST /events/browser is loopback/Origin guarded, strips the URL to origin + path and publishes one browser topic', async () => {
  const bus = createWorkflowEventBus()
  const handler = createWorkflowEventHttpHandler({ bus, owner: OWNER })
  const published = []
  bus.subscribe({ owner: OWNER }, event => { published.push(event) })
  const accepted = await request(handler, 'POST', '/events/browser', { cardId: 'card-7', kind: 'oauthCompleted',
    url: 'http://127.0.0.1:43123/callback?code=SECRET-CODE&state=xyz#done' }, { origin: 'chrome://browser' })
  assert.equal(accepted.status, 202)
  assert.deepEqual(accepted.body.event, { seq: 1, id: accepted.body.event.id, topic: 'browser.oauthCompleted', origin: 'http://127.0.0.1:43123', path: '/callback' })
  assert.equal(accepted.headers['access-control-allow-origin'], 'chrome://browser')
  await bus.flush()
  assert.deepEqual(published[0].payload, { cardId: 'card-7', origin: 'http://127.0.0.1:43123', path: '/callback' })
  assert.equal(JSON.stringify(published).includes('SECRET-CODE'), false)
  assert.equal((await request(handler, 'POST', '/events/browser', { cardId: 'card-7', kind: 'navigated', url: 'https://a.example/x' })).body.event.topic, 'browser.navigated')

  const foreign = await request(handler, 'POST', '/events/browser', { cardId: 'c', kind: 'navigated', url: 'https://a.example/' }, { origin: 'https://evil.example' })
  assert.equal(foreign.status, 403)
  assert.equal((await request(handler, 'POST', '/events/browser', { cardId: 'c', kind: 'navigated', url: 'https://a.example/' }, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await request(handler, 'POST', '/events/browser', { cardId: 'c', kind: 'navigated', url: 'https://a.example/' }, { host: 'evil.example:39218' })).status, 403)
  assert.equal((await request(handler, 'POST', '/events/browser', { cardId: 'c', kind: 'closed', url: 'https://a.example/' })).status, 400)
  assert.equal((await request(handler, 'POST', '/events/browser', { cardId: 'c', kind: 'navigated', url: 'file:///etc/hosts' })).status, 400)
  assert.equal((await request(handler, 'POST', '/events/browser', { cardId: 'c', kind: 'navigated', url: 'https://a.example/', title: 'x' })).status, 400)
  assert.equal((await request(handler, 'POST', '/events/browser', { cardId: '../c', kind: 'navigated', url: 'https://a.example/' })).status, 400)
  assert.equal((await request(handler, 'GET', '/events/browser')).status, 405)
  assert.equal(await handler({ url: '/events', headers: {} }, {}), false, 'the SSE stream route stays with the bridge')
  assert.equal(await handler({ url: '/tasks/state', headers: {} }, {}), false)
  const recent = await request(handler, 'GET', '/events/recent?since=1')
  assert.deepEqual(recent.body.events.map(event => event.topic), ['browser.navigated'])
  assert.equal((await request(handler, 'GET', '/events/recent?owner=other')).status, 400)
  assert.equal(published.length, 2, 'refused requests publish nothing')
})

test('browser events from the screen are rate-limited per second', async () => {
  let clock = 0
  const bus = createWorkflowEventBus()
  const handler = createWorkflowEventHttpHandler({ bus, owner: OWNER, maxBrowserEventsPerSecond: 2, now: () => clock })
  const send = () => request(handler, 'POST', '/events/browser', { cardId: 'c', kind: 'navigated', url: 'https://a.example/' })
  assert.equal((await send()).status, 202)
  assert.equal((await send()).status, 202)
  assert.equal((await send()).status, 429)
  clock = 1000
  assert.equal((await send()).status, 202)
})
