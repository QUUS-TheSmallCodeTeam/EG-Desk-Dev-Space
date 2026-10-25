import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import {
  CONTEXT_SUGGEST_DEFAULT, RESOLVER_EXCLUSIONS, RESOLVER_LIMITS, RESOLVER_POLICY, RESOLVER_REASON_WEIGHTS, RECENT_WINDOW_MS,
  boardQueryWords, normalizeContextSuggest, resolveContext, resolverRecord, validateResolverChoice, validateResolverRequest, validateResolverSignals,
} from './egdesk-context-resolver.mjs'
import { ImmutableContextStore } from './egdesk-context-store.mjs'
import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { createContextHttpHandler } from './egdesk-context-http.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openBridgeSettings } from './egdesk-bridge-settings.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'

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
  assert.deepEqual(RESOLVER_REASON_WEIGHTS, { explicit: 100, focused: 40, activeBoardMember: 30, sameCluster: 20, matchingBoard: 15, visibleLarge: 10, recentlyUsed: 8 })
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
  assert.deepEqual(Object.keys(resolved.body), ['resolutionId', 'policy', 'resolvedAt', 'signalsDigest', 'board', 'candidates', 'suggest'])
  assert.deepEqual(resolved.body.suggest, { mode: 'always', omittedByMode: 0, omittedByUser: 0 }, 'default: today\'s behaviour')
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

// ── D-R2: suggestion mode and the 'never suggest' list (defaults = today) ──

const withSuggest = (signals, suggest, extra = {}) => resolveContext(validateResolverSignals(signals), { now: NOW, suggest, ...extra })

test('never-suggest sites and screen-marked folders drop out of suggestions; an explicit pick still shows', () => {
  assert.deepEqual(CONTEXT_SUGGEST_DEFAULT, { mode: 'always', neverSuggest: [] })
  assert.ok(RESOLVER_EXCLUSIONS.includes('userExcluded'))
  const signals = {
    explicit: [{ kind: 'browser', ref: 'egd-mail-picked', site: 'mail.example.com' }],
    visible: [
      { kind: 'browser', ref: 'egd-bank', focused: true, site: 'www.bank.example' },
      { kind: 'browser', ref: 'egd-mail', area: 0.5, site: 'mail.example.com' },
      { kind: 'browser', ref: 'egd-news', area: 0.5, site: 'news.example.org' },
      { kind: 'file', ref: 'egd-private-file', area: 0.5, userExcluded: true },
      { kind: 'file', ref: 'egd-plain-file', area: 0.5 },
    ],
  }
  // Default: everything is suggested as before; the userExcluded mark alone already drops a folder match.
  const before = withSuggest(signals, CONTEXT_SUGGEST_DEFAULT)
  assert.deepEqual(before.candidates.map(c => c.ref), ['egd-mail-picked', 'egd-bank', 'egd-mail', 'egd-news', 'egd-plain-file'])
  assert.deepEqual(before.suggest, { mode: 'always', omittedByMode: 0, omittedByUser: 1 })
  const suggest = normalizeContextSuggest({ mode: 'always', neverSuggest: [{ kind: 'site', host: 'bank.example' }, { kind: 'site', host: 'example.com' }] })
  const after = withSuggest(signals, suggest)
  assert.deepEqual(after.candidates.map(c => c.ref), ['egd-mail-picked', 'egd-news', 'egd-plain-file'], 'subdomains of a listed site drop out; the explicit pick stays')
  assert.deepEqual(after.suggest, { mode: 'always', omittedByMode: 0, omittedByUser: 3 })
  // Left out entirely, not listed as excluded, and absent from the run record.
  assert.ok(!after.candidates.some(c => c.excludedBy === 'userExcluded'))
  assert.ok(!JSON.stringify(resolverRecord('00000000-0000-4000-8000-000000000000', after)).includes('egd-bank'))
  // A host that only ends with the listed text is not its subdomain.
  assert.equal(withSuggest({ visible: [{ kind: 'browser', ref: 'egd-x', focused: true, site: 'notbank.example' }] }, suggest).candidates.length, 1)
  for (const site of ['https://bank.example', 'Bank.example', 'bank.example/path', 'bank.example:443', 'a@bank.example', '']) {
    assert.throws(() => validateResolverSignals({ visible: [{ kind: 'browser', ref: 'egd-x', site }] }), invalidSignal, site)
  }
  assert.throws(() => validateResolverSignals({ visible: [{ kind: 'file', ref: 'egd-x', userExcluded: 'yes' }] }), invalidSignal)
  // One resource cannot be reported with two sites.
  assert.throws(() => resolve({ explicit: [{ kind: 'browser', ref: 'egd-x', site: 'a.example' }], visible: [{ kind: 'browser', ref: 'egd-x', site: 'b.example' }] }), invalidSignal)
})

test('mode: off keeps explicit picks only; firstMessage suggests only while the room has no message', () => {
  const signals = { explicit: [{ kind: 'file', ref: 'egd-picked' }], visible: [{ kind: 'file', ref: 'egd-seen', focused: true }, { kind: 'file', ref: 'egd-big', area: 0.6 }] }
  const off = withSuggest(signals, { mode: 'off', neverSuggest: [] })
  assert.deepEqual(off.candidates.map(c => c.ref), ['egd-picked'])
  assert.deepEqual(off.suggest, { mode: 'off', omittedByMode: 2, omittedByUser: 0 })
  const first = { mode: 'firstMessage', neverSuggest: [] }
  assert.equal(withSuggest({ ...signals, firstMessage: true }, first).candidates.length, 3)
  assert.deepEqual(withSuggest({ ...signals, firstMessage: false }, first).candidates.map(c => c.ref), ['egd-picked'])
  assert.deepEqual(withSuggest(signals, first).candidates.map(c => c.ref), ['egd-picked'], 'not knowing counts as a later message')
  assert.throws(() => validateResolverSignals({ firstMessage: 'yes' }), invalidSignal)
  // firstMessage is part of the screen state digest.
  assert.notEqual(resolve({ firstMessage: true }).signalsDigest, resolve({}).signalsDigest)
})

test('suggestion settings normalize hosts and folders and refuse anything else', () => {
  const value = normalizeContextSuggest({ mode: 'firstMessage', neverSuggest: [
    { kind: 'site', host: ' *.Bank.Example. ' }, { kind: 'site', host: 'bank.example' },
    { kind: 'folder', path: '/Users/me/Private/../Private/' }, { kind: 'folder', path: '/Users/me/Private' },
  ] })
  assert.deepEqual(value, { mode: 'firstMessage', neverSuggest: [{ kind: 'site', host: 'bank.example' }, { kind: 'folder', path: path.resolve('/Users/me/Private') }] })
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.neverSuggest) && Object.isFrozen(value.neverSuggest[0]))
  const refused = input => assert.throws(() => normalizeContextSuggest(input), e => e.code === 'INVALID_CONTEXT_SUGGEST' && e.httpStatus === 400, JSON.stringify(input)?.slice(0, 100))
  refused(null)
  refused({ mode: 'sometimes', neverSuggest: [] })
  refused({ mode: 'always' })
  refused({ mode: 'always', neverSuggest: [], extra: true })
  refused({ mode: 'always', neverSuggest: [{ kind: 'site', host: 'https://bank.example/login' }] })
  refused({ mode: 'always', neverSuggest: [{ kind: 'site', host: 'bank.example', note: 'x' }] })
  refused({ mode: 'always', neverSuggest: [{ kind: 'folder', path: 'relative/folder' }] })
  refused({ mode: 'always', neverSuggest: [{ kind: 'folder', path: `/x${'a'.repeat(1100)}` }] })
  refused({ mode: 'always', neverSuggest: [{ kind: 'folder', path: '/bad\nname' }] })
  refused({ mode: 'always', neverSuggest: [{ kind: 'app', name: 'Mail' }] })
  refused({ mode: 'always', neverSuggest: Array.from({ length: 65 }, (_, i) => ({ kind: 'site', host: `s${i}.example` })) })
})

test('matching saved Boards become candidates by id and reason only, after the screen signals', () => {
  const signals = { boardId: 'board-active', visible: [{ kind: 'file', ref: 'egd-file', area: 0.5 }, { kind: 'board-element', ref: 'board-collide', area: 0.01 }] }
  const matchingBoards = [{ boardId: 'board-active' }, { boardId: 'board-b' }, { boardId: 'board-collide' }, { boardId: 'board-a' }, { boardId: 'board-c' }, { boardId: 'board-d' }, { boardId: 'bad id' }]
  const result = withSuggest(signals, CONTEXT_SUGGEST_DEFAULT, { matchingBoards })
  assert.deepEqual(summary(result), [
    ['board-b', 15, 'matchingBoard'], ['board-a', 15, 'matchingBoard'], ['board-c', 15, 'matchingBoard'], ['egd-file', 10, 'visibleLarge'],
  ], 'search order kept; the active Board and a ref already on screen are skipped; at most 3')
  assert.deepEqual(Object.keys(result.candidates[0]).sort(), ['kind', 'reasons', 'ref', 'requiresConsent', 'score'])
  assert.equal(result.candidates[0].kind, 'board')
  const off = withSuggest(signals, { mode: 'off', neverSuggest: [] }, { matchingBoards })
  assert.deepEqual(off.candidates, [])
  assert.equal(off.suggest.omittedByMode, 4)
})

test('typed words for the Board search: Korean partial words, no single letters, at most 6 words and 200 characters', () => {
  assert.deepEqual(boardQueryWords('지난주  매출 보고서 a 를 정리해줘 매출'), ['지난주', '매출', '보고서', '정리해줘'])
  // The 6 longest words stay (ties keep typing order), shown in typing order.
  assert.deepEqual(boardQueryWords('aa bbbbbbb cc ddddd eeeeee ff gggg hh'), ['aa', 'bbbbbbb', 'cc', 'ddddd', 'eeeeee', 'gggg'])
  assert.ok(boardQueryWords(`${'가'.repeat(150)} ${'나'.repeat(150)}`).join(' ').length <= RESOLVER_LIMITS.query)
  const { signals, query } = validateResolverRequest({ visible: [{ kind: 'file', ref: 'egd-a', focused: true }], query: '분기 매출' })
  assert.equal(query, '분기 매출')
  assert.deepEqual(signals, validateResolverSignals({ visible: [{ kind: 'file', ref: 'egd-a', focused: true }] }), 'the query is kept apart from the signals')
  assert.equal(validateResolverRequest({ query: 'a' }).query, null)
  assert.throws(() => validateResolverRequest({ query: 5 }), invalidSignal)
  assert.throws(() => validateResolverSignals({ query: '분기' }), invalidSignal, 'signals alone never carry text')
})

test('runtime: Board search runs per typed word, the words are not kept, and settings change what is suggested', async t => {
  const h = await harness(t)
  const searched = []
  const boards = { searchBoards({ query, limit }) {
    searched.push({ query, limit })
    if (query === '실패') throw new Error(`no such word ${query}`)
    const rows = { 분기: ['board-sales', 'board-old', 'board-hr'], 매출: ['board-sales', 'board-old'], 정리: ['board-hr'] }[query] || []
    return { query, index: 'fts5-trigram', boards: rows.map(boardId => ({ boardId, title: `Title ${boardId}`, lifecycle: boardId === 'board-old' ? 'archived' : 'active', snippet: 'secret snippet' })) }
  } }
  let saved = null
  const settings = { get value() { return saved ?? CONTEXT_SUGGEST_DEFAULT }, get persisted() { return true }, save(value) { saved = value; return true } }
  h.contexts.attachServices({ boards, settings })
  const resolved = h.contexts.resolve({ visible: [{ kind: 'browser', ref: 'egd-mail', focused: true, site: 'mail.example.com' }], query: '분기 매출' })
  assert.deepEqual(searched.map(s => s.query), ['분기', '매출'])
  assert.deepEqual(resolved.candidates.map(c => [c.ref, c.kind]), [['egd-mail', 'browser'], ['board-sales', 'board']], 'two words must match; archived Boards are skipped')
  const beforeFailure = h.contexts.resolutions.size
  assert.throws(() => h.contexts.resolve({ query: '분기 매출 실패' }), { code: 'CONTEXT_BOARD_SEARCH_UNAVAILABLE' })
  assert.equal(h.contexts.resolutions.size, beforeFailure, 'a partial failed search is not saved as a successful resolution')
  const kept = JSON.stringify([...h.contexts.resolutions.values()])
  for (const text of ['분기', '매출', 'Title', 'secret snippet']) assert.ok(!kept.includes(text), text)
  assert.equal(resolved.signalsDigest, h.contexts.resolve({ visible: [{ kind: 'browser', ref: 'egd-mail', focused: true, site: 'mail.example.com' }] }).signalsDigest)
  // One word is enough when only one was typed.
  assert.deepEqual(h.contexts.resolve({ query: '정리' }).candidates.map(c => c.ref), ['board-hr'])

  assert.deepEqual(h.contexts.suggestSnapshot(), { mode: 'always', neverSuggest: [], persisted: true })
  assert.deepEqual(h.contexts.setSuggestSettings({ neverSuggest: [{ kind: 'site', host: 'example.com' }] }), { mode: 'always', neverSuggest: [{ kind: 'site', host: 'example.com' }], persisted: true })
  assert.deepEqual(saved, { mode: 'always', neverSuggest: [{ kind: 'site', host: 'example.com' }] })
  const listed = h.contexts.resolve({ visible: [{ kind: 'browser', ref: 'egd-mail', focused: true, site: 'mail.example.com' }] })
  assert.deepEqual(listed.candidates, [])
  assert.equal(listed.suggest.omittedByUser, 1)
  // A screen choice of an item that was left out is not among the suggestions.
  await assert.rejects(h.send({ attachments: [h.browserAttachment('egd-mail')], contextResolution: { resolutionId: listed.resolutionId, chosen: ['egd-mail'] } }), e => e.code === 'RESOLVER_CHOICE_UNKNOWN')
  searched.length = 0
  h.contexts.setSuggestSettings({ mode: 'off' })
  assert.deepEqual(h.contexts.resolve({ query: '분기 매출' }).candidates, [])
  assert.equal(searched.length, 0, 'mode off does not search Boards at all')
  assert.throws(() => h.contexts.setSuggestSettings({}), e => e.code === 'INVALID_CONTEXT_SUGGEST')
  assert.throws(() => h.contexts.setSuggestSettings({ mode: 'off', other: 1 }), e => e.code === 'INVALID_CONTEXT_SUGGEST')
  // A failed save still applies until restart and says persisted: false.
  settings.save = () => false
  assert.deepEqual(h.contexts.setSuggestSettings({ mode: 'firstMessage' }).persisted, false)
  assert.equal(h.contexts.suggestSnapshot().mode, 'firstMessage')
})

test('HTTP: suggestion settings are loopback-guarded, validated and read back; resolve takes the typed words', async t => {
  const h = await harness(t)
  let auths = 0
  const handler = createContextHttpHandler(h.contexts, async () => { auths += 1 })
  // Without a settings store the default applies and nothing is kept.
  assert.deepEqual((await call(handler, 'GET', '/context/suggest-settings')).body, { mode: 'always', neverSuggest: [], persisted: false })
  let saved = null
  h.contexts.attachServices({ settings: { get value() { return saved ?? CONTEXT_SUGGEST_DEFAULT }, get persisted() { return true }, save(value) { saved = value; return true } } })
  assert.equal((await call(handler, 'POST', '/context/suggest-settings', { mode: 'off' }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await call(handler, 'DELETE', '/context/suggest-settings')).status, 405)
  const bad = await call(handler, 'POST', '/context/suggest-settings', { neverSuggest: [{ kind: 'site', host: 'https://bank.example' }] })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.code, 'INVALID_CONTEXT_SUGGEST')
  const ok = await call(handler, 'POST', '/context/suggest-settings', { mode: 'firstMessage', neverSuggest: [{ kind: 'site', host: 'Bank.Example' }] })
  assert.deepEqual(ok.body, { mode: 'firstMessage', neverSuggest: [{ kind: 'site', host: 'bank.example' }], persisted: true })
  assert.deepEqual((await call(handler, 'GET', '/context/suggest-settings')).body, ok.body)
  assert.equal(auths, 0, 'a local setting needs no account')
  const resolved = await call(handler, 'POST', '/context/resolve', { visible: [{ kind: 'file', ref: 'egd-a', focused: true }], firstMessage: true, query: '분기 보고서' })
  assert.equal(resolved.status, 200)
  assert.deepEqual(resolved.body.suggest, { mode: 'firstMessage', omittedByMode: 0, omittedByUser: 0 })
  assert.equal((await call(handler, 'POST', '/context/resolve', { query: { text: 'x' } })).status, 400)
})

test('actual Board and settings services keep choices room/account scoped and settings survive reopen without dispatch', async t => {
  const h = await harness(t)
  const board = (id, title) => ({ version: 1, savedAt: NOW, agenda: { id, title, memberCardIds: [], contextBindings: [] }, cards: [], shapes: [] })
  const deskA = openDeskStore({ dataDir: path.join(h.dir, 'desks'), ownerScope: 'desk-owner-a' })
  const deskB = openDeskStore({ dataDir: path.join(h.dir, 'desks'), ownerScope: 'desk-owner-b' })
  t.after(() => { deskA.close(); deskB.close() })
  deskA.saveBoard('board-a', { body: board('board-a', '분기 매출 A'), expectedRevision: null })
  deskB.saveBoard('board-b', { body: board('board-b', '분기 매출 B'), expectedRevision: null })
  const settingsDir = path.join(h.dir, 'settings')
  const settings = openBridgeSettings({ dataDir: settingsDir, log: () => {} })
  h.contexts.attachServices({ boards: deskA, settings: settings.contextSuggest })
  const handler = createContextHttpHandler(h.contexts, async () => {})
  const room = { clientThreadId: 'ui-room-a', conversationId: 'native-room-a' }
  const response = await call(handler, 'POST', '/context/resolve', { ...room, query: '분기 매출' })
  assert.equal(response.status, 200)
  assert.deepEqual(response.body.candidates.map(item => [item.ref, item.kind, item.reasons]), [['board-a', 'board', ['matchingBoard']]])
  assert.ok(!JSON.stringify(response.body).includes('분기'))
  const choice = { resolutionId: response.body.resolutionId, chosen: ['board-a'] }
  const attachment = { id: 'picked-board', kind: 'board', sourceRef: { viewId: 'board-a' }, captureScope: { type: 'board-selection' }, content: { text: 'Explicitly selected Board bytes', mime: 'text/plain', truncated: false } }
  const prepare = extra => h.contexts.prepare({ ...room, contextCapabilities: { read: true }, contextResolution: choice, ...extra })
  await assert.rejects(prepare({ clientThreadId: 'ui-room-b', attachments: [attachment] }), { code: 'CONTEXT_THREAD_MISMATCH' })
  await assert.rejects(prepare({ conversationId: 'native-room-b', attachments: [attachment] }), { code: 'CONTEXT_THREAD_MISMATCH' })
  h.setOwner('email:b@example.com')
  await assert.rejects(prepare({ attachments: [attachment] }), { code: 'ACCOUNT_CHANGED' })
  h.setOwner('email:a@example.com')
  await assert.rejects(prepare({}), { code: 'RESOLVER_CHOICE_UNCAPTURED' })
  assert.deepEqual(await h.kinds('sources'), [], 'suggestion and rejected room choices cannot capture a Board')
  assert.deepEqual(await h.kinds('bindings'), [])
  assert.equal(h.calls.length, 0)
  assert.equal(h.chat.runs.size, 0)
  const capture = (await h.contexts.capture({ clientThreadId: room.clientThreadId, attachments: [attachment] })).captures[0]
  await assert.rejects(prepare({ contextSnapshotIds: [capture.sourceId], contextCapabilities: {} }), { code: 'CONTEXT_PERMISSION_REQUIRED' })
  const prepared = await prepare({ contextSnapshotIds: [capture.sourceId] })
  assert.deepEqual(prepared.sourceIds, [capture.sourceId])
  assert.equal(prepared.resolver.candidates[0].sourceId, capture.sourceId)
  assert.deepEqual(await h.kinds('bindings'), [], 'preparing an explicit choice is not binding or dispatch')
  // Replacing the scoped local store invalidates old suggestion handles.
  h.contexts.attachServices({ boards: deskB })
  await assert.rejects(prepare({ contextSnapshotIds: [capture.sourceId] }), { code: 'RESOLUTION_EXPIRED' })
  assert.deepEqual(h.contexts.resolve({ query: '분기 매출' }).candidates.map(item => item.ref), ['board-b'])
  const saved = await call(handler, 'POST', '/context/suggest-settings', { mode: 'firstMessage', neverSuggest: [{ kind: 'site', host: 'Bank.Example' }, { kind: 'folder', path: h.cwd }] })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.persisted, true)
  const reopened = openBridgeSettings({ dataDir: settingsDir, log: () => {} })
  const restored = new ContextRuntime({ store: h.store, getOwnerKey: () => 'email:a@example.com', now: () => NOW })
  restored.attachServices({ boards: deskA, settings: reopened.contextSuggest })
  assert.deepEqual(restored.suggestSnapshot(), saved.body)
  assert.deepEqual(restored.resolve({ query: '분기 매출' }).candidates, [], 'firstMessage remains off for later messages after reopen')
  assert.deepEqual(restored.resolve({ query: '분기 매출', firstMessage: true }).candidates.map(item => item.ref), ['board-a'])
  assert.equal(restored.resolve({ firstMessage: true, visible: [{ kind: 'browser', ref: 'bank', focused: true, site: 'bank.example' }] }).suggest.omittedByUser, 1)
  assert.equal(h.calls.length, 0)
  assert.equal(h.chat.runs.size, 0)
  assert.deepEqual(await h.kinds('packets'), [])
  assert.deepEqual(await h.kinds('deliveries'), [])
  deskA.close()
  const failed = await call(createContextHttpHandler(restored, async () => {}), 'POST', '/context/resolve', { firstMessage: true, query: '분기 매출' })
  assert.equal(failed.status, 503)
  assert.equal(failed.body.code, 'CONTEXT_BOARD_SEARCH_UNAVAILABLE')
  assert.equal(failed.body.candidates, undefined, 'closed services are not reported as valid empty context')
})

test('Board search and settings failures are explicit HTTP errors, never successful empty/default context', async t => {
  const h = await harness(t)
  const handler = createContextHttpHandler(h.contexts, async () => {})
  for (const searchBoards of [() => { throw new Error('private path and query') }, () => undefined, () => ({ boards: null }), () => ({ boards: [null] })]) {
    h.contexts.attachServices({ boards: { searchBoards } })
    const result = await call(handler, 'POST', '/context/resolve', { query: '보고서' })
    assert.equal(result.status, 503)
    assert.equal(result.body.code, 'CONTEXT_BOARD_SEARCH_UNAVAILABLE')
    assert.equal(result.body.resolutionId, undefined)
    assert.ok(!JSON.stringify(result.body).includes('private'))
    assert.equal(h.contexts.resolutions.size, 0)
  }
  h.contexts.attachServices({ boards: null, settings: { get value() { throw new Error('private settings filename') }, save: () => true } })
  for (const [method, url, body] of [['GET', '/context/suggest-settings'], ['POST', '/context/resolve', {}], ['POST', '/context/suggest-settings', { mode: 'off' }]]) {
    const result = await call(handler, method, url, body)
    assert.equal(result.status, 503)
    assert.equal(result.body.code, 'CONTEXT_SETTINGS_UNAVAILABLE')
    assert.ok(!JSON.stringify(result.body).includes('private'))
  }
  h.contexts.attachServices({ settings: { value: { mode: 'bad', neverSuggest: [] }, save: () => true } })
  assert.equal((await call(handler, 'GET', '/context/suggest-settings')).status, 503)
  h.contexts.attachServices({ settings: null })
  assert.deepEqual(h.contexts.suggestSnapshot(), { mode: 'always', neverSuggest: [], persisted: false }, 'an absent optional adapter keeps the original default')
  assert.equal(h.calls.length, 0)
  assert.equal(h.chat.runs.size, 0)
  assert.deepEqual(await h.kinds('sources'), [])
  assert.deepEqual(await h.kinds('bindings'), [])
})

test('Board search counts each word once and cannot keep a resolution across an account change during search', async t => {
  const h = await harness(t)
  h.contexts.attachServices({ boards: { searchBoards({ query }) { return { boards: query === '분기' ? [{ boardId: 'only-one-word' }, { boardId: 'only-one-word' }] : [] } } } })
  assert.deepEqual(h.contexts.resolve({ query: '분기 매출' }).candidates, [])
  h.contexts.attachServices({ boards: { searchBoards() { h.setOwner('email:changed@example.com'); return { boards: [{ boardId: 'old-account' }] } } } })
  assert.throws(() => h.contexts.resolve({ query: '분기' }), { code: 'ACCOUNT_CHANGED' })
  assert.equal(h.contexts.resolutions.size, 0)
  assert.equal(h.calls.length, 0)
})
