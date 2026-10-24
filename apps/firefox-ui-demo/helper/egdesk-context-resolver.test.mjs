import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
  RESOLVER_LIMITS, RESOLVER_POLICY, RESOLVER_REASON_WEIGHTS, RECENT_WINDOW_MS,
  resolveContext, resolverRecord, validateResolverChoice, validateResolverSignals,
} from './egdesk-context-resolver.mjs'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { createContextHttpHandler } from './egdesk-context-http.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'

const NOW = 1_800_000_000_000
const resolve = (signals, now = NOW) => resolveContext(validateResolverSignals(signals), { now })
const summary = result => result.candidates.map(({ ref, score, reasons }) => [ref, score, reasons.join('+')])
const invalidSignal = error => error.code === 'INVALID_RESOLVER_SIGNAL' && error.httpStatus === 400

async function harness(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-resolver-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cwd = path.join(dir, 'workspace'); await mkdir(cwd)
  let owner = 'email:a@example.com', nativeSeq = 0, clock = NOW
  const store = new ImmutableContextStore({ dataDir: path.join(dir, 'state'), allowedRoots: [cwd], now: () => clock })
  const contexts = new ContextRuntime({ store, reader: null, getOwnerKey: () => owner, now: () => clock })
  const calls = [], replies = [], events = []
  const chat = new CodexChatRuntime({
    contexts, respond: (id, result, error) => replies.push({ id, result, error }), emit: e => events.push(e),
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: `parent-${++nativeSeq}` }, cwd, model: 'configured-model' }
      if (method === 'turn/start') return { turn: { id: `turn-${nativeSeq}`, status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected native method ${method}`)
    },
  })
  chat.setConnection(true)
  const browserAttachment = (viewId, text = 'SECRET-BODY-TEXT for the page', extra = {}) => ({
    id: `input-${viewId}`, kind: 'browser', label: 'Private Page Title', capturedAt: 10,
    sourceRef: { viewId, resourceId: `page-${viewId}`, url: 'https://private.example.com/inbox?token=zzz' },
    captureScope: { type: 'document-text', locator: 'body' }, content: { mime: 'text/plain', text, truncated: false }, ...extra,
  })
  let sends = 0
  const send = settings => chat.send({ message: 'Use what I chose', requestId: `req-${++sends}`, clientThreadId: `ui-${sends}`, cwd, contextCapabilities: { read: true, reader: true, publishBriefing: true }, ...settings })
  const tool = async (run, name, args, id) => {
    await chat.handleServerRequest({ id, method: 'item/tool/call', params: { threadId: run.conversationId, turnId: run.runId, callId: id, tool: name, arguments: args } })
    await contexts.calls.get(`${run.answerId}/${id}`)
    return replies.find(reply => reply.id === id)
  }
  const kinds = async kind => { try { return await readdir(path.join(store.root, store.ownerScope('email:a@example.com'), kind)) } catch { return [] } }
  return { dir, cwd, store, contexts, chat, calls, events, send, tool, kinds, browserAttachment, setOwner: value => { owner = value }, tick: ms => { clock += ms } }
}

function request(method, url, body, headers = {}) {
  const raw = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(raw)
  req.method = method; req.url = url
  req.headers = { host: '127.0.0.1:39218', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}
async function call(handler, method, url, body, headers) {
  const res = { writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
  const handled = await handler(request(method, url, body, headers), res, new URL(`http://127.0.0.1:39218${url}`))
  return { handled, status: res.status, body: res.body }
}

test('ranking table: fixed reason weights, deterministic order and tie-breaks', () => {
  assert.deepEqual(RESOLVER_REASON_WEIGHTS, { explicit: 100, focused: 40, activeBoardMember: 30, sameCluster: 20, visibleLarge: 10, recentlyUsed: 8 })
  const signals = {
    boardId: 'board-A',
    explicit: [{ kind: 'file', ref: 'egd-file-card-1' }],
    visible: [
      { kind: 'board-element', ref: 'egd-shape-2', boardId: 'board-A', focused: true, area: 0.05, clusterId: 'c1' },
      { kind: 'board-element', ref: 'egd-shape-3', boardId: 'board-A', area: 0.3, clusterId: 'c1' },
      { kind: 'board-element', ref: 'egd-shape-4', area: 0.01, clusterId: 'c1' },
      { kind: 'board-element', ref: 'egd-shape-5', area: 0.25 },
      { kind: 'board-element', ref: 'egd-shape-6', area: 0.01, lastInteractedAt: NOW - 60_000 },
      { kind: 'board-element', ref: 'egd-shape-7', area: 0.01 },
      { kind: 'file', ref: 'egd-file-card-1', area: 0.01 },
    ],
    cluster: [['egd-shape-2', 'egd-shape-3']],
    recent: [{ kind: 'file', ref: 'egd-file-card-9', at: NOW - 5 * 60_000 }, { kind: 'file', ref: 'egd-file-card-old', at: NOW - RECENT_WINDOW_MS - 1 }],
  }
  const result = resolve(signals)
  assert.equal(result.policy, RESOLVER_POLICY)
  assert.deepEqual(result.board, { boardId: 'board-A', matchedBy: 'active' })
  assert.deepEqual(summary(result), [
    ['egd-file-card-1', 100, 'explicit'],
    ['egd-shape-2', 70, 'focused+activeBoardMember'],
    ['egd-shape-3', 60, 'activeBoardMember+sameCluster+visibleLarge'],
    ['egd-shape-4', 20, 'sameCluster'],
    ['egd-shape-5', 10, 'visibleLarge'],
    ['egd-shape-6', 8, 'recentlyUsed'],
    ['egd-file-card-9', 8, 'recentlyUsed'],
  ])
  // egd-shape-7 (small, unfocused, no Board, not recent) and the stale file are not suggested.
  assert.ok(!result.candidates.some(c => ['egd-shape-7', 'egd-file-card-old'].includes(c.ref)))
  // sameCluster means sharing a cluster with an explicit/focused anchor, not a chain of neighbours.
  const chain = resolve({ visible: [
    { kind: 'file', ref: 'anchor', focused: true }, { kind: 'file', ref: 'near', clusterId: 'k2' }, { kind: 'file', ref: 'far', clusterId: 'k2' },
  ], cluster: [['anchor', 'near']] })
  assert.deepEqual(summary(chain), [['anchor', 40, 'focused'], ['near', 20, 'sameCluster']])
  // Same score: more recent interaction wins (shape-6 1 min ago > file-9 5 min ago).
  // Shuffled input order yields the same ranking and digest.
  const shuffled = { ...signals, visible: [...signals.visible].reverse(), recent: [...signals.recent].reverse(), cluster: [['egd-shape-3', 'egd-shape-2']] }
  assert.deepEqual(resolve(shuffled), result)
  // Full ties fall back to larger area, then ref order.
  const ties = resolve({ visible: [
    { kind: 'file', ref: 'b-file', area: 0.3 }, { kind: 'file', ref: 'a-file', area: 0.3 }, { kind: 'file', ref: 'c-file', area: 0.9 },
  ] })
  assert.deepEqual(ties.candidates.map(c => c.ref), ['c-file', 'a-file', 'b-file'])
})

test('best-matching Board: active, then focused card Board, then most visible area', () => {
  const visible = [
    { kind: 'file', ref: 'f1', boardId: 'board-B', area: 0.5 },
    { kind: 'file', ref: 'f2', boardId: 'board-C', area: 0.1, focused: true },
    { kind: 'file', ref: 'f3', boardId: 'board-C', area: 0.1 },
  ]
  assert.deepEqual(resolve({ boardId: 'board-A', visible }).board, { boardId: 'board-A', matchedBy: 'active' })
  assert.deepEqual(resolve({ visible }).board, { boardId: 'board-C', matchedBy: 'focused' })
  const unfocused = visible.map(({ focused, ...item }) => item)
  const byArea = resolve({ visible: unfocused })
  assert.deepEqual(byArea.board, { boardId: 'board-B', matchedBy: 'visibleArea' })
  assert.deepEqual(byArea.candidates.find(c => c.ref === 'f1').reasons, ['activeBoardMember', 'visibleLarge'])
  assert.equal(resolve({ visible: [{ kind: 'file', ref: 'loose', area: 0.5 }] }).board, null)
})

test('Browser Card content and signed-in pages are suggested but marked as needing consent', () => {
  const result = resolve({
    explicit: [{ kind: 'browser', ref: 'egd-browser-explicit' }],
    visible: [
      { kind: 'browser', ref: 'egd-browser-1', focused: true },
      { kind: 'file', ref: 'egd-file-signed', area: 0.5, signedIn: true },
      { kind: 'file', ref: 'egd-file-local', area: 0.5 },
      { kind: 'board-element', ref: 'egd-shape-1', area: 0.5 },
    ],
  })
  const consent = Object.fromEntries(result.candidates.map(c => [c.ref, c.requiresConsent]))
  assert.deepEqual(consent, {
    'egd-browser-explicit': false, // the person's explicit pick is the consent
    'egd-browser-1': true, 'egd-file-signed': true, 'egd-file-local': false, 'egd-shape-1': false,
  })
})

test('other-account and no-permission resources are excluded and never displace usable suggestions', () => {
  const scoped = { account: { scopes: ['profile-work'] } }
  const result = resolve({ ...scoped, visible: [
    { kind: 'browser', ref: 'work-page', focused: true, accountScope: 'profile-work' },
    { kind: 'browser', ref: 'home-page', area: 0.9, accountScope: 'profile-home' },
    { kind: 'file', ref: 'locked-file', area: 0.9, permission: 'denied' },
    { kind: 'file', ref: 'plain-file', area: 0.2 },
  ] })
  assert.deepEqual(result.candidates.map(c => [c.ref, c.excludedBy ?? null]), [
    ['work-page', null], ['plain-file', null], ['home-page', 'otherAccount'], ['locked-file', 'noPermission'],
  ])
  // Relevance stays recorded separately from the permission decision.
  assert.deepEqual(result.candidates.find(c => c.ref === 'home-page').reasons, ['visibleLarge'])
  // Without an account signal a scoped resource cannot be shown to belong here.
  assert.equal(resolve({ visible: [{ kind: 'browser', ref: 'p', focused: true, accountScope: 'profile-work' }] }).candidates[0].excludedBy, 'otherAccount')
  // Cap: 12 candidates; excluded ones only fill leftover slots.
  const many = resolve({ ...scoped, visible: [
    ...Array.from({ length: 20 }, (_, i) => ({ kind: 'file', ref: `x-${String(i).padStart(2, '0')}`, area: 0.9, accountScope: 'profile-home' })),
    ...Array.from({ length: 14 }, (_, i) => ({ kind: 'file', ref: `ok-${String(i).padStart(2, '0')}`, area: 0.2 })),
  ] })
  assert.equal(many.candidates.length, RESOLVER_LIMITS.candidates)
  assert.ok(many.candidates.every(c => c.ref.startsWith('ok-') && !c.excludedBy))
})

test('invalid or oversized signals are refused; raw content fields cannot ride along', () => {
  const ok = { kind: 'file', ref: 'egd-file-card-1' }
  for (const bad of [
    null, [], { unknown: true }, { text: 'page body' },
    { visible: [{ ...ok, title: 'Private Title' }] }, { visible: [{ ...ok, url: 'https://x.test' }] },
    { explicit: [{ ...ok, content: 'x' }] }, { visible: [{ ...ok, kind: 'terminal' }] },
    { visible: [{ ...ok, ref: 'a@b.com' }] }, { visible: [{ ...ok, ref: '/Users/me/file.txt' }] }, { visible: [{ ...ok, ref: '' }] },
    { visible: [{ ...ok, area: 1.5 }] }, { visible: [{ ...ok, area: Number.NaN }] }, { visible: [{ ...ok, focused: 'yes' }] },
    { visible: [{ ...ok, ref: 'a', focused: true }, { ...ok, ref: 'b', focused: true }] },
    { visible: [ok, ok] }, { visible: [ok], recent: [{ ...ok, kind: 'browser', at: 1 }] },
    { recent: [{ ...ok }] }, { recent: [{ ...ok, at: -1 }] }, { visible: [{ ...ok, lastInteractedAt: 1.5 }] },
    { account: { email: 'a@example.com' } }, { account: { scopes: ['a@example.com'] } },
    { visible: [{ ...ok, permission: 'maybe' }] }, { boardId: 'has space' }, { cluster: [['a', 'a']] },
    { visible: Array.from({ length: RESOLVER_LIMITS.visible + 1 }, (_, i) => ({ ...ok, ref: `v${i}` })) },
    { explicit: Array.from({ length: RESOLVER_LIMITS.explicit + 1 }, (_, i) => ({ ...ok, ref: `e${i}` })) },
    { recent: Array.from({ length: RESOLVER_LIMITS.recent + 1 }, (_, i) => ({ ...ok, ref: `r${i}`, at: 1 })) },
    { cluster: Array.from({ length: RESOLVER_LIMITS.clusters + 1 }, (_, i) => [`a${i}`, `b${i}`]) },
  ]) assert.throws(() => resolve(bad), invalidSignal, JSON.stringify(bad)?.slice(0, 120))
  assert.throws(() => validateResolverChoice({ resolutionId: 'nope', chosen: [] }), e => e.code === 'INVALID_RESOLVER_CHOICE')
  assert.throws(() => validateResolverChoice({ resolutionId: '00000000-0000-4000-8000-000000000000', chosen: ['a', 'a'] }), e => e.code === 'INVALID_RESOLVER_CHOICE')
  assert.throws(() => validateResolverChoice({ resolutionId: '00000000-0000-4000-8000-000000000000', chosen: [], autoAttach: true }), e => e.code === 'INVALID_RESOLVER_CHOICE')
})

test('resolver record keeps ids, codes and scores only', () => {
  const resolution = resolve({ visible: [{ kind: 'browser', ref: 'egd-browser-1', focused: true }, { kind: 'file', ref: 'egd-file-1', area: 0.5 }] })
  const record = resolverRecord('00000000-0000-4000-8000-000000000000', resolution, new Map([['egd-file-1', 'source-1']]))
  assert.deepEqual(Object.keys(record), ['resolutionId', 'resolvedAt', 'signalsDigest', 'policy', 'board', 'candidates'])
  assert.deepEqual(record.candidates.map(c => [c.ref, c.chosen, c.sourceId ?? null]), [['egd-browser-1', false, null], ['egd-file-1', true, 'source-1']])
  for (const candidate of record.candidates) for (const key of Object.keys(candidate)) assert.ok(['ref', 'kind', 'score', 'reasons', 'requiresConsent', 'excludedBy', 'chosen', 'sourceId'].includes(key), key)
})

test('suggest-only: resolving captures and binds nothing; only chosen, captured items are bound', async t => {
  const h = await harness(t)
  const signals = { visible: [
    { kind: 'browser', ref: 'egd-browser-card-1', focused: true },
    { kind: 'board-element', ref: 'egd-shape-2', area: 0.4 },
  ] }
  const resolution = h.contexts.resolve(signals)
  assert.equal(resolution.policy, 'suggest-only')
  assert.equal(resolution.candidates.length, 2)
  assert.deepEqual(await h.kinds('sources'), [])
  assert.deepEqual(await h.kinds('bindings'), [])
  assert.equal(h.calls.length, 0)
  // Naming the suggestions with nothing chosen auto-includes nothing; the run
  // only keeps the declined suggestions as evidence.
  const none = await h.send({ contextResolution: { resolutionId: resolution.resolutionId, chosen: [] } })
  const declined = h.chat.runs.get(none.answerId).context
  assert.deepEqual(declined.captures, [])
  assert.deepEqual(declined.resolver.candidates.map(c => c.chosen), [false, false])
  assert.deepEqual(await h.kinds('sources'), [])
  // Without read capability and attachments there is no context binding at all.
  const bare = await h.send({ contextCapabilities: undefined, contextResolution: { resolutionId: resolution.resolutionId, chosen: [] } })
  assert.equal(h.chat.runs.get(bare.answerId).context, undefined)
  // A chosen suggestion that was not captured through the attach path is refused.
  await assert.rejects(h.send({ contextResolution: { resolutionId: resolution.resolutionId, chosen: ['egd-browser-card-1'] } }), e => e.code === 'RESOLVER_CHOICE_UNCAPTURED')
  await assert.rejects(h.send({ attachments: [h.browserAttachment('egd-other')], contextResolution: { resolutionId: resolution.resolutionId, chosen: ['egd-browser-card-1'] } }), e => e.code === 'RESOLVER_CHOICE_UNCAPTURED')
  await assert.rejects(h.send({ attachments: [h.browserAttachment('egd-browser-card-1')], contextResolution: { resolutionId: resolution.resolutionId, chosen: ['egd-not-suggested'] } }), e => e.code === 'RESOLVER_CHOICE_UNKNOWN')
  // The person picks one: only that capture is bound; the other stays a declined suggestion.
  const run = await h.send({ attachments: [h.browserAttachment('egd-browser-card-1')], contextResolution: { resolutionId: resolution.resolutionId, chosen: ['egd-browser-card-1'] } })
  const context = h.chat.runs.get(run.answerId).context
  assert.equal(context.captures.length, 1)
  assert.deepEqual(context.resolver.candidates.map(c => [c.ref, c.chosen, c.requiresConsent]), [['egd-browser-card-1', true, true], ['egd-shape-2', false, false]])
  assert.equal(context.resolver.candidates[0].sourceId, context.captures[0].sourceId)
  assert.equal(context.resolver.signalsDigest, resolution.signalsDigest)
  assert.ok(h.events.some(e => e.event === 'context.bound' && e.details.resolver?.resolutionId === resolution.resolutionId))
})

test('chosen excluded items, expired suggestions and another account are refused', async t => {
  const h = await harness(t)
  const resolution = h.contexts.resolve({ account: { scopes: ['profile-work'] }, visible: [{ kind: 'browser', ref: 'egd-home', focused: true, accountScope: 'profile-home' }] })
  assert.equal(resolution.candidates[0].excludedBy, 'otherAccount')
  await assert.rejects(h.send({ attachments: [h.browserAttachment('egd-home')], contextResolution: { resolutionId: resolution.resolutionId, chosen: ['egd-home'] } }), e => e.code === 'RESOLVER_CHOICE_FORBIDDEN' && e.httpStatus === 403)
  const fresh = h.contexts.resolve({ visible: [{ kind: 'file', ref: 'egd-file-1', area: 0.5 }] })
  h.setOwner('email:b@example.com')
  await assert.rejects(h.send({ attachments: [h.browserAttachment('egd-file-1')], contextResolution: { resolutionId: fresh.resolutionId, chosen: [] } }), e => e.code === 'ACCOUNT_CHANGED')
  h.setOwner('email:a@example.com')
  h.tick(16 * 60 * 1000)
  await assert.rejects(h.send({ attachments: [h.browserAttachment('egd-file-1')], contextResolution: { resolutionId: fresh.resolutionId, chosen: [] } }), e => e.code === 'RESOLUTION_EXPIRED')
  // Suggestions are bounded in memory.
  for (let i = 0; i < 70; i += 1) h.contexts.resolve({})
  assert.ok(h.contexts.resolutions.size <= 64)
})

test('HTTP: POST /context/resolve is guarded and bounded; packets carry the resolver record without source text', async t => {
  const h = await harness(t)
  let auths = 0
  const handler = createContextHttpHandler(h.contexts, async () => { auths += 1 })
  const signals = { visible: [{ kind: 'browser', ref: 'egd-browser-card-1', focused: true }, { kind: 'board-element', ref: 'egd-shape-2', area: 0.4 }] }
  assert.equal((await call(handler, 'POST', '/context/resolve', signals, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await call(handler, 'POST', '/context/resolve', signals, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await call(handler, 'POST', '/context/resolve', signals, { host: 'evil.example:39218' })).status, 403)
  assert.equal((await call(handler, 'GET', '/context/resolve')).status, 405)
  assert.equal((await call(handler, 'POST', '/context/resolve', { visible: [{ kind: 'file', ref: 'a', text: 'body' }] })).status, 400)
  assert.equal((await call(handler, 'POST', '/context/resolve', JSON.stringify({ visible: [], pad: 'x'.repeat(70 * 1024) }))).status, 413)
  assert.equal(auths, 0, 'refused requests never reach account lookup')
  const resolved = await call(handler, 'POST', '/context/resolve', signals, { origin: 'chrome://browser' })
  assert.equal(resolved.status, 200)
  assert.deepEqual(Object.keys(resolved.body), ['resolutionId', 'policy', 'resolvedAt', 'signalsDigest', 'board', 'candidates'])
  assert.equal(resolved.body.policy, 'suggest-only')
  assert.deepEqual(resolved.body.candidates.map(c => c.reasons), [['focused'], ['visibleLarge']])
  assert.deepEqual(await h.kinds('sources'), [])

  const secret = 'SECRET-BODY-TEXT for the page'
  const run = await h.send({ attachments: [h.browserAttachment('egd-browser-card-1', secret)], contextResolution: { resolutionId: resolved.body.resolutionId, chosen: ['egd-browser-card-1'] } })
  const sourceId = h.chat.runs.get(run.answerId).context.captures[0].sourceId
  const reply = await h.tool(run, 'egdesk_read_source', { snapshotId: sourceId, intent: 'Read the chosen page' }, 'read-1')
  const packetId = JSON.parse(reply.result.contentItems[0].text).packetId
  const packet = await call(handler, 'GET', `/context/packets/${packetId}`)
  assert.equal(packet.status, 200)
  assert.equal(packet.body.deliveryStatus, 'sent-to-app-server')
  assert.equal(packet.body.resolver.resolutionId, resolved.body.resolutionId)
  assert.deepEqual(packet.body.resolver.candidates.map(c => [c.ref, c.chosen]), [['egd-browser-card-1', true], ['egd-shape-2', false]])
  const recordText = JSON.stringify(packet.body.resolver)
  for (const raw of [secret, 'Private Page Title', 'private.example.com', 'token']) assert.ok(!recordText.includes(raw), raw)
  // Stored binding record carries the same text-free resolver record.
  const bindings = await h.store.listRecords('email:a@example.com', 'bindings', b => b.answerId === run.answerId)
  assert.deepEqual(bindings[0].resolver, packet.body.resolver)

  // A run with explicit attachments only reports no resolver record.
  const plain = await h.send({ attachments: [h.browserAttachment('egd-plain', 'Plain text')] })
  const plainSource = h.chat.runs.get(plain.answerId).context.captures[0].sourceId
  const plainReply = await h.tool(plain, 'egdesk_read_source', { snapshotId: plainSource, intent: 'Read' }, 'read-2')
  const plainPacket = await call(handler, 'GET', `/context/packets/${JSON.parse(plainReply.result.contentItems[0].text).packetId}`)
  assert.equal(plainPacket.body.resolver, null)
  assert.equal(h.chat.runs.get(plain.answerId).context.resolver, undefined)
})

test('resume restores the resolver record; a different choice under the same requestId conflicts', async t => {
  const h = await harness(t)
  const resolution = h.contexts.resolve({ visible: [{ kind: 'browser', ref: 'egd-browser-card-1', focused: true }] })
  const accepted = await h.send({ attachments: [h.browserAttachment('egd-browser-card-1')], contextResolution: { resolutionId: resolution.resolutionId, chosen: ['egd-browser-card-1'] } })
  const run = h.chat.runs.get(accepted.answerId)
  const original = structuredClone(run.context.resolver)
  h.contexts.bindings.clear()
  delete run.context
  await h.contexts.restoreRun(run)
  assert.deepEqual(run.context.resolver, original)
  const body = { message: 'Same id', requestId: 'fixed-request', clientThreadId: 'ui-fixed', cwd: h.cwd, contextCapabilities: { read: true }, attachments: [h.browserAttachment('egd-browser-card-1')] }
  const second = h.contexts.resolve({ visible: [{ kind: 'browser', ref: 'egd-browser-card-1', focused: true }] })
  await h.chat.send({ ...body, contextResolution: { resolutionId: second.resolutionId, chosen: ['egd-browser-card-1'] } })
  await assert.rejects(h.chat.send({ ...body, contextResolution: { resolutionId: second.resolutionId, chosen: [] } }), e => e.code === 'REQUEST_CONFLICT')
})
