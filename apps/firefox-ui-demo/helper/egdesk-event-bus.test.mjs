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
  assert.deepEqual([...WORKFLOW_TOPICS], ['terminal.exit', 'auth.changed', 'file.changed', 'browser.navigated', 'browser.oauthCompleted', 'user.action',
    'browser.loaded', 'browser.popupClosed'])
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

test('a popup card may name the card that opened it (openerCardId); it is optional, opaque, and never the card itself', () => {
  const bus = createWorkflowEventBus()
  const popup = bus.publish({ topic: 'browser.oauthCompleted', owner: OWNER,
    payload: { cardId: 'egd-browser-card-9', origin: 'http://127.0.0.1:43123', path: '/oauth/callback', openerCardId: 'egd-browser-card-2' } })
  assert.deepEqual(popup.payload, { cardId: 'egd-browser-card-9', origin: 'http://127.0.0.1:43123', path: '/oauth/callback', openerCardId: 'egd-browser-card-2' })
  assert.ok(Object.isFrozen(popup.payload))
  const navigated = bus.publish({ topic: 'browser.navigated', owner: OWNER,
    payload: { cardId: 'egd-browser-card-9', origin: 'http://localhost:43124', path: '/login', openerCardId: 'egd-browser-card-2' } })
  assert.equal(navigated.payload.openerCardId, 'egd-browser-card-2')
  const plain = bus.publish({ topic: 'browser.oauthCompleted', owner: OWNER, payload: { cardId: 'c1', origin: 'https://a.example', path: '/cb' } })
  assert.equal(Object.hasOwn(plain.payload, 'openerCardId'), false, 'an ordinary card keeps the old payload shape')
  const nulled = bus.publish({ topic: 'browser.navigated', owner: OWNER, payload: { cardId: 'c1', origin: 'https://a.example', path: '/', openerCardId: null } })
  assert.equal(Object.hasOwn(nulled.payload, 'openerCardId'), false, 'null means no opener and is left out')
  assert.equal(popup.summary, 'Browser sign-in finished at http://127.0.0.1:43123/oauth/callback', 'card IDs stay out of the summary')
  for (const bad of ['', '../card', 'card id', 'a'.repeat(161), 7, true, { id: 'c' }]) {
    assert.throws(() => bus.publish({ topic: 'browser.oauthCompleted', owner: OWNER,
      payload: { cardId: 'c1', origin: 'https://a.example', path: '/cb', openerCardId: bad } }), { code: 'WORKFLOW_EVENT_INPUT' }, String(bad))
  }
  assert.throws(() => bus.publish({ topic: 'browser.oauthCompleted', owner: OWNER,
    payload: { cardId: 'c1', origin: 'https://a.example', path: '/cb', openerCardId: 'c1' } }), { code: 'WORKFLOW_EVENT_INPUT', message: /not the card itself/ })
  assert.throws(() => bus.publish({ topic: 'browser.oauthCompleted', owner: OWNER,
    payload: { cardId: 'c1', origin: 'https://a.example', path: '/cb', openerUrl: 'https://a.example/' } }), { code: 'WORKFLOW_EVENT_INPUT' }, 'only openerCardId is new')
  assert.throws(() => bus.publish({ topic: 'auth.changed', owner: OWNER, payload: { signedIn: true, openerCardId: 'c2' } }), { code: 'WORKFLOW_EVENT_INPUT' },
    'other topics do not take an opener')
})

test('POST /events/browser accepts openerCardId from a popup card and passes it through; bad openers publish nothing', async () => {
  const bus = createWorkflowEventBus()
  const handler = createWorkflowEventHttpHandler({ bus, owner: OWNER })
  const published = []
  bus.subscribe({ owner: OWNER }, event => { published.push(event) })
  const accepted = await request(handler, 'POST', '/events/browser', { cardId: 'egd-browser-card-9', kind: 'oauthCompleted',
    url: 'http://127.0.0.1:43123/oauth/callback?code=SECRET-CODE&state=s', openerCardId: 'egd-browser-card-2' }, { origin: 'chrome://browser' })
  assert.equal(accepted.status, 202)
  assert.deepEqual(accepted.body.event, { seq: 1, id: accepted.body.event.id, topic: 'browser.oauthCompleted',
    origin: 'http://127.0.0.1:43123', path: '/oauth/callback', openerCardId: 'egd-browser-card-2' })
  const ordinary = await request(handler, 'POST', '/events/browser', { cardId: 'egd-browser-card-2', kind: 'navigated', url: 'https://a.example/x' })
  assert.equal(Object.hasOwn(ordinary.body.event, 'openerCardId'), false, 'the old request shape still answers with the old event shape')
  const nulled = await request(handler, 'POST', '/events/browser', { cardId: 'egd-browser-card-2', kind: 'navigated', url: 'https://a.example/y', openerCardId: null })
  assert.equal(nulled.status, 202)
  assert.equal(Object.hasOwn(nulled.body.event, 'openerCardId'), false)
  await bus.flush()
  assert.deepEqual(published[0].payload, { cardId: 'egd-browser-card-9', origin: 'http://127.0.0.1:43123', path: '/oauth/callback', openerCardId: 'egd-browser-card-2' })
  assert.equal(JSON.stringify(published).includes('SECRET-CODE'), false)
  for (const openerCardId of ['../c', '', 'egd-browser-card-9', 42]) {
    const refused = await request(handler, 'POST', '/events/browser', { cardId: 'egd-browser-card-9', kind: 'oauthCompleted', url: 'https://a.example/cb', openerCardId })
    assert.equal(refused.status, 400, String(openerCardId))
    assert.equal(refused.body.code, 'WORKFLOW_EVENT_INPUT')
  }
  assert.equal((await request(handler, 'POST', '/events/browser', { cardId: 'c', kind: 'navigated', url: 'https://a.example/', openerCardId: 'p', title: 'x' })).status, 400)
  await bus.flush()
  assert.equal(published.length, 3, 'refused requests publish nothing')
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

test('BRW-04 (D-B11): popupClosed names its opener and who closed it; loaded is a plain card location', async () => {
  const bus = createWorkflowEventBus()
  assert.ok(WORKFLOW_TOPICS.includes('browser.popupClosed') && WORKFLOW_TOPICS.includes('browser.loaded'))
  const closed = bus.publish({ topic: 'browser.popupClosed', owner: OWNER, payload: { cardId: 'card-pop', origin: 'https://accounts.example',
    path: '/signin', openerCardId: 'card-1', closedBy: 'page' } })
  assert.equal(closed.summary, 'Browser popup closed itself')
  for (const bad of [{ closedBy: 'script' }, { openerCardId: undefined }, { openerCardId: 'card-pop' }, { extra: 1 }]) {
    const payload = { cardId: 'card-pop', origin: 'https://accounts.example', path: '/signin', openerCardId: 'card-1', closedBy: 'page', ...bad }
    if (bad.openerCardId === undefined && 'openerCardId' in bad) delete payload.openerCardId
    assert.throws(() => bus.publish({ topic: 'browser.popupClosed', owner: OWNER, payload }), { code: 'WORKFLOW_EVENT_INPUT' })
  }
  assert.equal(bus.publish({ topic: 'browser.loaded', owner: OWNER, payload: { cardId: 'card-1', origin: 'https://app.example', path: '/' } }).summary,
    'Browser loaded https://app.example/')
  const handler = createWorkflowEventHttpHandler({ bus, owner: OWNER })
  const posted = await request(handler, 'POST', '/events/browser', { cardId: 'card-pop', kind: 'popupClosed', closedBy: 'user',
    openerCardId: 'card-1', url: 'https://accounts.example/signin?token=SECRET' })
  assert.equal(posted.status, 202)
  assert.equal(posted.body.event.topic, 'browser.popupClosed')
  assert.equal(bus.recent({ owner: OWNER }).events.at(-1).payload.closedBy, 'user')
  assert.equal(JSON.stringify(bus.recent({ owner: OWNER })).includes('SECRET'), false)
  assert.equal((await request(handler, 'POST', '/events/browser', { cardId: 'card-1', kind: 'loaded', url: 'https://app.example/home' })).body.event.topic, 'browser.loaded')
  assert.equal((await request(handler, 'POST', '/events/browser', { cardId: 'card-1', kind: 'navigated', closedBy: 'page', url: 'https://app.example/' })).status, 400)
  assert.equal((await request(handler, 'POST', '/events/browser', { cardId: 'card-pop', kind: 'popupClosed', url: 'https://a.example/', openerCardId: 'card-1' })).status, 400)
})
