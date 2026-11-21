import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import vm from 'node:vm'
import { rm } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { backoffDelayMs, createAccountAccessTracker, createChatHttpHandler, createRateLimitSync, createReconnectBackoff, guardBridgeRequest, readJsonBody, sendJson, setBridgeCors } from './codex-bridge-http.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createChatEngineAuth } from './codex-bridge-engine-auth.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createOntologyHttpHandler } from './egdesk-ontology-http.mjs'
import { openProfileStore } from './egdesk-profile-store.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

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
  assert.equal(guardBridgeRequest(request('{}', { origin: 'null' })), false)
  assert.equal(guardBridgeRequest(request('{}', { origin: 'chrome://browser' })), true)
  for (const headers of [{ origin: 'https://evil.example' }, { host: 'evil.example:39218' }, { origin: 'http://localhost:8080' }, { origin: 'null', 'sec-fetch-site': 'cross-site' }]) assert.equal(guardBridgeRequest(request('{}', headers)), false)
  const remote = request('{}'); remote.socket.remoteAddress = '192.168.1.1'
  assert.equal(guardBridgeRequest(remote), false)
  assert.equal(guardBridgeRequest(request('{}', {}, 'http://evil.example/chat/send')), false)
  const res = response(); setBridgeCors(request('{}', { origin: 'http://127.0.0.1:39218' }), res)
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:39218')
  assert.notEqual(res.headers['Access-Control-Allow-Origin'], '*')
})

test('absent or trusted origins still reject same-site and every unrecognized present Fetch Metadata value', () => {
  for (const fetchSite of ['same-site', 'cross-site', 'unknown', '', 'Same-Origin', 'none, same-origin', null, undefined, ['same-origin']]) {
    assert.equal(guardBridgeRequest(request('{}', { 'sec-fetch-site': fetchSite })), false, String(fetchSite))
    assert.equal(guardBridgeRequest(request('{}', { origin: 'chrome://browser', 'sec-fetch-site': fetchSite })), false, String(fetchSite))
  }
  for (const origin of ['https://evil.example', 'http://localhost:8080', 'http://127.0.0.1:8080']) {
    for (const fetchSite of ['none', 'same-origin']) {
      assert.equal(guardBridgeRequest(request('{}', { origin, 'sec-fetch-site': fetchSite })), false)
    }
  }
})

test('trusted loopback/Chrome origins retain missing-header, none and same-origin compatibility', () => {
  for (const origin of [undefined, 'chrome://browser', 'chrome://userchrome', 'http://127.0.0.1:39218', 'http://localhost:39218', 'http://[::1]:39218']) {
    for (const fetchSite of [undefined, 'none', 'same-origin']) {
      const headers = {}
      if (origin !== undefined) headers.origin = origin
      if (fetchSite !== undefined) headers['sec-fetch-site'] = fetchSite
      assert.equal(guardBridgeRequest(request('{}', headers)), true)
      assert.equal(guardBridgeRequest(request('{}', { ...headers, host: 'other.example:39218' })), false)
    }
  }
})

test('literal Origin null is rejected for absent, trusted and untrusted Fetch Metadata combinations', () => {
  for (const fetchSite of [undefined, 'none', 'same-origin', 'same-site', 'cross-site', 'unknown', '', null]) {
    const headers = { origin: 'null' }
    if (fetchSite !== undefined) headers['sec-fetch-site'] = fetchSite
    const req = request('{}', headers)
    const res = response()
    const allowed = guardBridgeRequest(req)
    assert.equal(allowed, false, String(fetchSite))
    // Production sets CORS only after the guard accepts the request.
    if (allowed) setBridgeCors(req, res)
    assert.equal(res.headers['Access-Control-Allow-Origin'], undefined)
  }
})

test('bridge CORS adds Terminal scope headers without granting Origin, Chat login or ontology token authority', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const start = source.indexOf('const bridgeServer = createServer(async (req, res) => {')
  const end = source.indexOf('  // File routes have their own bounded', start)
  assert.ok(start >= 0 && end > start, 'use the production guard, preflight and ontology dispatch without starting the bridge')
  const port = 39218, trusted = 'chrome://browser'
  const profileId = 'a'.repeat(64), token = 'b'.repeat(64)
  let accountChecks = 0, ontologyReads = 0
  const chat = new CodexChatRuntime({ request: async () => assert.fail('denied request must not reach the provider'), respond: () => {} })
  chat.setConnection(true)
  const auth = createChatEngineAuth({ chat, refreshCodexAccount: async () => { accountChecks++ }, getCodexAuth: () => ({ isLoggedIn: false }) })
  const handleChatHttp = createChatHttpHandler(chat, auth)
  const handleOntologyHttp = createOntologyHttpHandler({ port, binding: { profileId, token }, store: { readGraph: () => { ontologyReads++; return { nodes: [] } } } })
  const handle = vm.runInNewContext(source.slice(start, end) + '\n  await handleChatHttp(req, res, url)\n}); bridgeServer', {
    BRIDGE_PORT: port, URL, createServer: callback => callback, guardBridgeRequest, sendJson, setBridgeCors,
    handleMemoryEvidenceHttp: () => assert.fail('not a memory evidence request'), handleOntologyHttp, handleChatHttp,
  })
  const terminalHeaders = {
    'x-egdesk-terminal-owner': '00000000-0000-4000-8000-000000000001',
    'x-egdesk-terminal-view': '00000000-0000-4000-8000-000000000002',
  }
  const headers = { ...terminalHeaders, 'x-egdesk-overlay-build': 'fixture-build', 'x-egdesk-ontology-profile': profileId, 'x-egdesk-ontology-token': token }
  const call = async (method, path, origin, extra) => {
    const req = request('{"message":"fixture"}', { origin, ...extra }, path)
    req.method = method
    const res = response()
    await handle(req, res)
    return res
  }
  const preflight = await call('OPTIONS', '/terminal/attach', trusted, { 'access-control-request-headers': Object.keys(terminalHeaders).join(', ') })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers['Access-Control-Allow-Origin'], trusted)
  assert.equal(preflight.headers['Access-Control-Allow-Headers'], 'Content-Type, X-EGDesk-Overlay-Build, X-EGDesk-Ontology-Profile, X-EGDesk-Ontology-Token, X-EGDesk-Terminal-Owner, X-EGDesk-Terminal-View')
  assert.equal(preflight.headers['Access-Control-Allow-Methods'], 'GET,POST,PUT,OPTIONS')
  for (const [method, path] of [['OPTIONS', '/terminal/attach'], ['POST', '/chat/send'], ['GET', '/ontology/graph']]) {
    const refused = await call(method, path, 'https://untrusted.example', headers)
    assert.deepEqual([refused.status, refused.headers['Access-Control-Allow-Origin']], [403, undefined])
  }
  assert.deepEqual([accountChecks, ontologyReads], [0, 0])
  const chatRefused = await call('POST', '/chat/send', trusted, headers)
  assert.deepEqual([chatRefused.status, chatRefused.body.code, accountChecks], [401, 'LOGIN_REQUIRED', 1])
  const { 'x-egdesk-ontology-token': unused, ...withoutToken } = headers
  const ontologyRefused = await call('GET', '/ontology/graph', trusted, withoutToken)
  assert.deepEqual([ontologyRefused.status, ontologyRefused.body.code, ontologyReads], [403, 'ONTOLOGY_TOKEN_REQUIRED', 0])
  assert.equal((await call('GET', '/ontology/graph', trusted, headers)).status, 200)
  assert.equal(ontologyReads, 1)
})

test('JSON reader rejects oversized bodies, non-JSON types and non-object data', async () => {
  assert.deepEqual(await readJsonBody(request('{"message":"hi"}')), { message: 'hi' })
  await assert.rejects(readJsonBody(request('[')), e => e.code === 'INVALID_JSON')
  await assert.rejects(readJsonBody(request('[]')), e => e.code === 'INVALID_JSON')
  await assert.rejects(readJsonBody(request('{}', { 'content-type': 'text/plain' })), e => e.httpStatus === 415)
  await assert.rejects(readJsonBody(request('x'.repeat(65537))), e => e.httpStatus === 413)
})

test('run project origin GET awaits server verification, rejects duplicate/authority fields, and never authenticates or dispatches', async () => {
  const queries = []
  const handler = createChatHttpHandler({ async runProjectOrigin(query) {
    queries.push(query)
    await Promise.resolve()
    return { protocolVersion: 1, ...query, status: 'verified', verified: true, rootId: 'current-root', directoryId: 'current-directory', displayPath: '/authorized/current', projectId: 'original-project', source: 'board' }
  } }, async () => assert.fail('read must not make an auth/provider call'))
  const get = async suffix => {
    const res = response(), req = request('', {}, `/chat/run-project-origin${suffix}`); req.method = 'GET'
    assert.equal(await handler(req, res, new URL(`http://localhost${req.url}`)), true)
    return res
  }
  const valid = await get('?conversationId=original&runId=turn')
  assert.equal(valid.status, 200)
  assert.deepEqual(valid.body, { protocolVersion: 1, conversationId: 'original', runId: 'turn', status: 'verified', verified: true,
    rootId: 'current-root', directoryId: 'current-directory', displayPath: '/authorized/current', projectId: 'original-project', source: 'board' })
  assert.deepEqual(queries, [{ conversationId: 'original', runId: 'turn' }])
  for (const suffix of ['?runId=turn', '?conversationId=original&runId=', '?conversationId=a&conversationId=b&runId=t', '?conversationId=c&runId=a&runId=b',
    '?conversationId=c&runId=r&rootId=forged', '?conversationId=c&runId=r&directoryId=forged', '?conversationId=c&runId=r&displayPath=/forged',
    '?conversationId=c&runId=r&cwd=/private', '?conversationId=c&runId=r&ownerScope=forged', '?conversationId=c&runId=%00']) {
    const res = await get(suffix)
    assert.deepEqual([res.status, res.body.code], [400, 'INVALID_RUN_ORIGIN_QUERY'])
  }
  assert.equal(queries.length, 1)
  assert.equal(await handler(request('{}', {}, '/chat/run-project-origin'), response(), new URL('http://localhost/chat/run-project-origin')), false)
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

test('actual bridge auth defaults only a new chat to Codex and refreshes its account before dispatch', async () => {
  const calls = []
  let loggedIn = false
  const chat = new CodexChatRuntime({ request: async method => {
    calls.push(method)
    if (method === 'thread/start') return { thread: { id: 'codex-auth-thread' } }
    if (method === 'turn/start') return { turn: { id: 'codex-auth-turn', status: 'inProgress', items: [] } }
    throw new Error(`Unexpected call: ${method}`)
  }, respond: () => {} })
  chat.setConnection(true)
  const auth = createChatEngineAuth({ chat, refreshCodexAccount: async () => { calls.push('auth') }, getCodexAuth: () => ({ isLoggedIn: loggedIn }) })
  const handler = createChatHttpHandler(chat, auth)
  const send = async body => { const res = response(); await handler(request(JSON.stringify(body)), res, new URL('http://localhost/chat/send')); return res }
  const refused = await send({ message: 'New chat while logged out' })
  assert.deepEqual([refused.status, refused.body.accepted, refused.body.code], [401, false, 'LOGIN_REQUIRED'])
  assert.deepEqual(calls, ['auth'])
  loggedIn = true
  const accepted = await send({ message: 'New chat after login' })
  assert.equal(accepted.body.accepted, true)
  assert.deepEqual(calls, ['auth', 'auth', 'thread/start', 'turn/start'])
})

test('the server mounts the tested stored-engine auth function, without a Codex response-routing shim', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(source, /const ensureChatAuth = createChatEngineAuth\(\{ chat, refreshCodexAccount: refreshAccountState, getCodexAuth: \(\) => authState \}\)/)
  assert.match(source, /createChatHttpHandler\(chat, ensureChatAuth\)/)
  assert.match(source, /createContextHttpHandler\(contexts, ensureChatAuth, \{ port: BRIDGE_PORT \}\)/)
  const contextStart = source.indexOf('contexts = new ContextRuntime({')
  const contextEnd = source.indexOf('const browserTransport =', contextStart)
  assert.ok(contextStart >= 0 && contextEnd > contextStart, 'the actual context constructor boundary is present')
  const contextWiring = source.slice(contextStart, contextEnd)
  assert.match(contextWiring, /getAuthority: hints => chat\.contextAuthority\(hints\)/)
  assert.match(contextWiring, /schemaReady: authority => authority\?\.engineId === 'claude'\s*\? claudeEngine\.isReady\(\) && claudeEngine\.capabilities\(\)\.has\('dynamicTools'\)\s*: nativeCapabilities\.schemaMatch && appServerReady/)
  assert.match(source, /respond: nativeRespond,/)
  assert.doesNotMatch(source, /respond:.*claudeEngine\.owns/)
})

test('HTTP send answers 400 MODEL_UNAVAILABLE or EFFORT_UNSUPPORTED for a choice outside the listed models, after auth and before any native call', async () => {
  const calls = []
  const models = [{ id: 'gpt-6-luna', displayName: 'GPT-6-Luna', isDefault: true, supportedEfforts: ['low', 'medium', 'max'], defaultEffort: 'medium' }]
  const codex = createCodexEngineAdapter({
    request: async (method, params) => {
      calls.push(method)
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, model: 'gpt-6-luna' }
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }
      return {}
    },
    respond: () => {}, getModels: () => models,
  })
  const chat = new CodexChatRuntime({ engines: [codex] })
  chat.setConnection(true)
  let auth = 0
  const handler = createChatHttpHandler(chat, async () => { auth += 1 })
  const send = async body => { const res = response(); await handler(request(JSON.stringify(body)), res, new URL('http://localhost/chat/send')); return res }
  const unavailable = await send({ message: 'hi', model: 'gpt-reserve', requestId: 'r-1' })
  assert.deepEqual([unavailable.status, unavailable.body.accepted, unavailable.body.code, unavailable.body.requestId], [400, false, 'MODEL_UNAVAILABLE', 'r-1'])
  const unsupported = await send({ message: 'hi', model: 'gpt-6-luna', effort: 'ultra' })
  assert.deepEqual([unsupported.status, unsupported.body.code], [400, 'EFFORT_UNSUPPORTED'])
  assert.deepEqual(calls, [])
  assert.equal(auth, 2, 'the account is checked first, as for every send')
  const accepted = await send({ message: 'hi', model: 'gpt-6-luna', effort: 'max' })
  assert.deepEqual([accepted.status, accepted.body.accepted], [202, true])
  assert.deepEqual(calls, ['thread/start', 'turn/start'])
})

test('HTTP send names a missing or inactive Agent profile with its own status before any native call', async t => {
  const dataDir = createPrivateQaTempDirectory('egdesk-http-profile-')
  const profiles = openProfileStore({ dataDir, ownerHash: 'local-desktop-test' })
  t.after(async () => { profiles.close(); await rm(dataDir, { recursive: true, force: true }) })
  const calls = []
  const chat = new CodexChatRuntime({ request: async method => { calls.push(method); throw new Error('no native call expected') }, respond: () => {}, profiles })
  chat.setConnection(true)
  const handler = createChatHttpHandler(chat, async () => {})
  const missing = response()
  await handler(request(JSON.stringify({ message: 'hi', requestId: 'profile-missing', profileEnabled: true, profileId: 'no-such-profile' })), missing, new URL('http://localhost/chat/send'))
  assert.equal(missing.status, 404)
  assert.equal(missing.body.code, 'PROFILE_NOT_FOUND')
  assert.equal(missing.body.accepted, false)
  const draft = profiles.createDraft({ name: '초안' })
  const inactive = response()
  await handler(request(JSON.stringify({ message: 'hi', requestId: 'profile-draft', profileEnabled: true, profileId: draft.id })), inactive, new URL('http://localhost/chat/send'))
  assert.equal(inactive.status, 409)
  assert.equal(inactive.body.code, 'PROFILE_NOT_RUNNABLE')
  assert.deepEqual(calls, [])
})

test('bounded QA output markers and policy traverse the ordinary EG-Desk /chat/send handler', async () => {
  let received
  const policy = { mode: 'readOnlyQa' }
  const markers = ['EGDESK_FILE_NONCE_7f41ad982b', 'EGDESK_COMMAND_TAG_9c62ab71']
  const handler = createChatHttpHandler({ send: async body => { received = body; return { accepted: true, conversationId: 'native-thread', runId: 'native-turn', executionPolicy: { mode: 'readOnlyQa', status: 'native-thread-verified' } } } }, async () => {})
  const res = response()
  await handler(request(JSON.stringify({ message: 'Read the public fixture', clientThreadId: 'ui-thread', requestId: 'qa-request', executionPolicy: policy, qaOutputMarkers: markers })), res, new URL('http://localhost/chat/send'))
  assert.equal(res.status, 202)
  assert.deepEqual(received.executionPolicy, policy)
  assert.deepEqual(received.qaOutputMarkers, markers)
  assert.equal(res.body.runId, 'native-turn')
})

test('native MCP inventory RPC diagnostics never escape QA HTTP, events or durable history, before or after thread/start', async () => {
  const sentinel = 'PRIVATE_MCP_RPC_SENTINEL_7f41ad98'
  for (const stage of ['before-thread', 'after-thread']) {
    const dataDir = createPrivateQaTempDirectory('egdesk-mcp-rpc-error-')
    let store = null
    try {
      store = openChatStore({ dataDir, ownerScope: `mcp-rpc-${stage}` })
      const nativeCalls = [], events = []
      const chat = new CodexChatRuntime({ store, requireStore: true,
        getOwnerKey: () => 'codex:chatgpt:qa-fixture-owner', qaReady: () => true,
        request: async (method, params) => {
          nativeCalls.push({ method, params })
          if (method === 'config/read') return { config: {}, layers: [{ name: { type: 'user' }, config: {} }] }
          if (method === 'mcpServerStatus/list') {
            if ((stage === 'before-thread' && !params.threadId) || (stage === 'after-thread' && params.threadId)) {
              throw Object.assign(new Error(sentinel), { code: sentinel })
            }
            return { data: [], nextCursor: null }
          }
          if (method === 'thread/start') return { thread: { id: `native-${stage}` }, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
          throw new Error(`Unexpected native method ${method}`)
        }, respond: () => {}, emit: event => events.push(event),
      })
      chat.setConnection(true)
      const handler = createChatHttpHandler(chat, async () => {})
      const clientThreadId = `client-${stage}`
      const sent = response()
      await handler(request(JSON.stringify({ message: 'Bounded fixture read', requestId: `request-${stage}`, clientThreadId,
        executionPolicy: { mode: 'readOnlyQa' } })), sent, new URL('http://localhost/chat/send'))
      assert.equal(sent.status, 502)
      assert.equal(sent.body.code, 'QA_TOOL_ISOLATION_UNVERIFIED')
      assert.equal(nativeCalls.some(call => call.method === 'turn/start'), false)
      assert.equal(nativeCalls.filter(call => call.method === 'thread/start').length, stage === 'after-thread' ? 1 : 0)
      const historyReq = request('')
      historyReq.method = 'GET'
      const history = response()
      await handler(historyReq, history, new URL(`http://localhost/chat/history?clientThreadId=${clientThreadId}&afterSeq=0&limit=100`))
      assert.equal(history.status, 200)
      assert.equal(JSON.stringify({ sent: sent.body, events, snapshot: chat.snapshot(), history: history.body }).includes(sentinel), false)
    } finally {
      try { store?.close() } catch {}
      await rm(dataDir, { recursive: true, force: true })
    }
  }
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

test('local history reads and legacy imports bypass native auth and preserve paged response shapes', async () => {
  let authCalls = 0
  const calls = []
  const history = {
    listLocalThreads: async options => { calls.push(['threads', options]); return { protocolVersion: 1, threads: [], nextCursor: null, hasMore: false } },
    getLocalHistory: async options => { calls.push(['history', options]); return { protocolVersion: 1, thread: { clientThreadId: options.clientThreadId }, runs: [], messages: [], events: [], nextCursor: null, hasMore: false, projectionTruncated: false, coverage: { scope: 'egdesk-local', status: 'unknown', reasons: [], nativeHistoryComplete: null } } },
    importLocalHistory: async body => { calls.push(['import', body]); return { imported: true, alreadyImported: false, clientThreadId: body.clientThreadId, localConversationId: 'local-1', coverage: { scope: 'egdesk-local', status: 'partial', reasons: ['legacy-truncated'], nativeHistoryComplete: false } } },
  }
  const handler = createChatHttpHandler({}, async () => { authCalls++; throw new Error('Native unavailable') }, history)
  const threadsReq = request(''); threadsReq.method = 'GET'
  const threadsRes = response()
  await handler(threadsReq, threadsRes, new URL('http://localhost/chat/history/threads?limit=10'))
  assert.equal(threadsRes.status, 200)
  const historyReq = request(''); historyReq.method = 'GET'
  const historyRes = response()
  await handler(historyReq, historyRes, new URL('http://localhost/chat/history?clientThreadId=client-1&afterSeq=4&limit=25'))
  assert.equal(historyRes.status, 200)
  assert.deepEqual(historyRes.body.events, [])
  const snapshot = { protocolVersion: 2, conversationId: 'native-1', streamId: 'stream-1', seq: 8, truncated: true, historyComplete: false, runs: [] }
  const importRes = response()
  await handler(request(JSON.stringify({ clientThreadId: 'client-1', importId: 'import-1', snapshot })), importRes, new URL('http://localhost/chat/history/import'))
  assert.equal(importRes.status, 201)
  assert.deepEqual(calls, [
    ['threads', { cursor: null, limit: 10 }],
    ['history', { clientThreadId: 'client-1', afterSeq: 4, limit: 25 }],
    ['import', { clientThreadId: 'client-1', importId: 'import-1', snapshot }],
  ])
  assert.equal(authCalls, 0)
})

test('history endpoints reject invalid cursors, limits and imports before store calls', async () => {
  let called = false
  const history = { listLocalThreads: () => { called = true }, getLocalHistory: () => { called = true }, importLocalHistory: () => { called = true } }
  const handler = createChatHttpHandler({}, async () => {}, history)
  for (const path of ['/chat/history?clientThreadId=x&afterSeq=-1', '/chat/history?clientThreadId=x&limit=501', '/chat/history?afterSeq=0', '/chat/history/threads?limit=0']) {
    const req = request(''); req.method = 'GET'
    const res = response()
    await handler(req, res, new URL(`http://localhost${path}`))
    assert.equal(res.status, 400, path)
  }
  const invalid = response()
  await handler(request(JSON.stringify({ clientThreadId: 'x', importId: 'one', snapshot: { protocolVersion: 1, runs: [] } })), invalid, new URL('http://localhost/chat/history/import'))
  assert.equal(invalid.status, 400)
  const oversized = response()
  const largeReq = Readable.from([Buffer.alloc(64 * 1024 * 1024 + 1)])
  largeReq.method = 'POST'; largeReq.url = '/chat/history/import'; largeReq.headers = { host: '127.0.0.1:39218', 'content-type': 'application/json' }; largeReq.socket = { remoteAddress: '127.0.0.1' }
  await handler(largeReq, oversized, new URL('http://localhost/chat/history/import'))
  assert.equal(oversized.status, 413)
  assert.equal(called, false)
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

test('real-store HTTP imports and reads local-only legacy text without native auth or IDs', async () => {
  const dataDir = createPrivateQaTempDirectory('egdesk-local-history-http-')
  let store = null
  try {
    store = openChatStore({ dataDir, ownerScope: 'local-http-test' })
    let authCalls = 0, nativeCalls = 0
    const chat = new CodexChatRuntime({
      store, requireStore: true,
      request: async () => { nativeCalls++; throw new Error('Native runtime must stay offline') },
      respond: () => {},
    })
    const handler = createChatHttpHandler(chat, async () => { authCalls++; throw new Error('Native auth must not be checked') })
    const snapshot = {
      protocolVersion: 2, conversationId: null, streamId: 'legacy-local', seq: 1,
      truncated: false, historyComplete: false,
      runs: [{
        localRunId: 'local-legacy-run', conversationId: null, runId: null,
        status: 'unknown', messages: [{
          id: 'ui-old', messageId: null, localMessageId: 'local-old',
          role: 'user', text: 'legacy', status: 'complete',
        }], activities: [], artifacts: [], pendingApprovals: [],
      }],
    }
    const body = { clientThreadId: 'legacy-client', importId: 'legacy-import-1', snapshot }
    const imported = response()
    const importReq = request(JSON.stringify(body), {}, '/chat/history/import')
    assert.equal(guardBridgeRequest(importReq), true)
    await handler(importReq, imported, new URL('http://localhost/chat/history/import'))
    assert.equal(imported.status, 201)
    assert.equal(imported.body.imported, true)
    assert.equal(imported.body.coverage.status, 'partial')
    const historyReq = request(''); historyReq.method = 'GET'; historyReq.url = '/chat/history?clientThreadId=legacy-client&afterSeq=0&limit=100'
    const history = response()
    await handler(historyReq, history, new URL('http://localhost/chat/history?clientThreadId=legacy-client&afterSeq=0&limit=100'))
    assert.equal(history.status, 200)
    assert.equal(history.body.thread.conversationId, null)
    assert.equal(history.body.runs[0].localRunId, 'local-legacy-run')
    assert.equal(history.body.runs[0].runId, null)
    const message = history.body.messages.find(value => value.localMessageId === 'local-old')
    assert.equal(message.text, 'legacy')
    assert.equal(message.id, 'ui-old')
    assert.equal(message.messageId, null)
    assert.ok(history.body.events.some(event => event.event === 'message.checkpoint' && event.details.message.text === 'legacy' && event.messageId === null))
    const repeated = response()
    await handler(request(JSON.stringify(body), {}, '/chat/history/import'), repeated, new URL('http://localhost/chat/history/import'))
    assert.equal(repeated.status, 200)
    assert.equal(repeated.body.alreadyImported, true)
    assert.equal(authCalls, 0)
    assert.equal(nativeCalls, 0)
  } finally {
    try { store?.close() } catch {}
    await rm(dataDir, { recursive: true, force: true })
  }
})

async function askingRuntime() {
  const replies = []
  const chat = new CodexChatRuntime({
    request: async method => {
      if (method === 'thread/start') return { thread: { id: 'thread' } }
      if (method === 'turn/start') return { turn: { id: 'turn', status: 'inProgress', items: [] } }
      throw new Error('Unexpected native call')
    }, respond: (...args) => replies.push(args),
  })
  chat.setConnection(true)
  const run = await chat.send({ message: 'Ask me' })
  const ask = async id => {
    await chat.handleServerRequest({ id, method: 'item/tool/requestUserInput', params: { threadId: run.conversationId, turnId: run.runId, itemId: id, isBlocking: true, questions: [
      { id: 'password', header: 'Password', question: 'Password?', isSecret: true, options: null },
    ] } })
    return chat.snapshot().runs[0].pendingUserInputs.at(-1).userInputId
  }
  return { chat, replies, run, ask }
}

test('HTTP Agent answer requires auth, skip works without it, and stale questions return 409', async () => {
  const { chat, replies, run, ask } = await askingRuntime()
  let authCalls = 0
  const handler = createChatHttpHandler(chat, async () => { authCalls++; throw Object.assign(new Error('Account lookup failed'), { httpStatus: 503 }) })
  const userInputId = await ask('ask-auth')
  const submit = response()
  await handler(request(JSON.stringify({ ...run, userInputId, action: 'submit', answers: [{ questionId: 'password', text: 'HTTP_UNSENT_SECRET' }] })), submit, new URL('http://localhost/chat/user-input'))
  assert.equal(submit.status, 503)
  assert.equal(authCalls, 1)
  assert.deepEqual(replies, [])
  assert.equal(chat.snapshot().runs[0].pendingUserInputs[0].status, 'pending')
  const skip = response()
  await handler(request(JSON.stringify({ ...run, userInputId, action: 'skip' })), skip, new URL('http://localhost/chat/user-input'))
  assert.equal(skip.status, 200)
  assert.deepEqual(skip.body, { accepted: true, userInputId, conversationId: run.conversationId, runId: run.runId, status: 'replySent' })
  assert.equal(authCalls, 1, 'a skip is a safety response and needs no account lookup')
  assert.deepEqual(replies, [['ask-auth', null, { code: -32000, message: 'User skipped the question' }]])
  const stale = response()
  await handler(request(JSON.stringify({ ...run, userInputId, action: 'skip' })), stale, new URL('http://localhost/chat/user-input'))
  assert.equal(stale.status, 409)
  assert.deepEqual(stale.body, { accepted: false, conversationId: run.conversationId, requestId: run.requestId, code: 'STALE_USER_INPUT', error: 'Question is stale, already answered, or belongs to another run' })
  assert.ok(!JSON.stringify([submit.body, skip.body, stale.body]).includes('HTTP_UNSENT_SECRET'))
})

test('HTTP Agent answer acknowledges without echoing answers and rejects invalid or oversized bodies', async () => {
  const { chat, replies, run, ask } = await askingRuntime()
  const handler = createChatHttpHandler(chat, async () => {})
  const userInputId = await ask('ask-ok')
  const invalid = response()
  await handler(request(JSON.stringify({ ...run, userInputId, action: 'submit', answers: [{ questionId: 'password', text: 'HTTP_INVALID_SECRET', optionIndex: 0 }] })), invalid, new URL('http://localhost/chat/user-input'))
  assert.equal(invalid.status, 400)
  assert.equal(invalid.body.code, 'INVALID_USER_INPUT_ANSWER')
  const large = response()
  await handler(request(JSON.stringify({ ...run, userInputId, action: 'submit', answers: [{ questionId: 'password', text: 'x'.repeat(70000) }] })), large, new URL('http://localhost/chat/user-input'))
  assert.equal(large.status, 413)
  assert.deepEqual(replies, [])
  const ok = response()
  await handler(request(JSON.stringify({ ...run, userInputId, action: 'submit', answers: [{ questionId: 'password', text: 'HTTP_PRIVATE_SECRET' }] })), ok, new URL('http://localhost/chat/user-input'))
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { accepted: true, userInputId, conversationId: run.conversationId, runId: run.runId, status: 'replySent' })
  assert.deepEqual(replies, [['ask-ok', { answers: { password: { answers: ['HTTP_PRIVATE_SECRET'] } } }]])
  const exposed = JSON.stringify([invalid.body, ok.body, chat.snapshot()])
  for (const hidden of ['HTTP_INVALID_SECRET', 'HTTP_PRIVATE_SECRET']) assert.ok(!exposed.includes(hidden), hidden)
  const offline = response()
  chat.setConnection(false)
  await handler(request(JSON.stringify({ ...run, userInputId, action: 'skip' })), offline, new URL('http://localhost/chat/user-input'))
  assert.equal(offline.status, 503)
  assert.equal(offline.body.code, 'BRIDGE_OFFLINE')
})

// Shape of codex 0.162.1 GetAccountRateLimitsResponse / AccountRateLimitsUpdatedNotification.
const limitsResult = (usedPercent, extra = {}) => ({ rateLimits: { limitId: 'codex', primary: { usedPercent, windowDurationMins: 300, resetsAt: 1793000000 }, secondary: null, credits: null, planType: 'plus', rateLimitReachedType: null, ...extra }, ordinaryUsageAllowed: true })
function usageFixture({ minIntervalMs = 60_000 } = {}) {
  const state = { isLoggedIn: true, accountEmail: 'owner@example.test', accountId: null, rateLimits: null }
  const reads = [], updates = []
  let clock = 1_000_000, ready = true
  const sync = createRateLimitSync({
    request: (method, params) => new Promise((resolve, reject) => reads.push({ method, params, resolve, reject })),
    auth: () => state, ready: () => ready, now: () => clock, minIntervalMs,
    update: patch => { updates.push(patch); Object.assign(state, patch) },
  })
  return { state, reads, updates, sync, tick: ms => { clock += ms }, setReady: value => { ready = value } }
}

test('ChatGPT usage is read after sign-in, coalesced, throttled unless forced, and normalized without invented values', async () => {
  const u = usageFixture()
  const first = u.sync.refresh(), joined = u.sync.refresh({ force: true })
  assert.equal(u.reads.length, 1)
  assert.deepEqual({ method: u.reads[0].method, params: u.reads[0].params }, { method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } })
  u.reads[0].resolve(limitsResult(42.5))
  await Promise.all([first, joined])
  assert.deepEqual(u.state.rateLimits, { primary: { usedPercent: 42.5, windowMinutes: 300, resetsAt: 1793000000000 }, secondary: null, reachedType: null, usageAllowed: true, observedAt: 1_000_000 })
  assert.equal(JSON.stringify(u.state.rateLimits).includes('codex'), false)
  await u.sync.refresh()
  assert.equal(u.reads.length, 1, 'an unforced read inside the interval is skipped')
  const forced = u.sync.refresh({ force: true })
  assert.equal(u.reads.length, 2, 'a finished turn forces a fresh read')
  u.reads[1].resolve(limitsResult(55))
  await forced
  assert.equal(u.state.rateLimits.primary.usedPercent, 55)
  u.tick(60_000)
  void u.sync.refresh()
  assert.equal(u.reads.length, 3)
})

test('a usage answer after sign-out or an account switch is dropped; failures and offline never invent usage', async () => {
  const u = usageFixture()
  const old = u.sync.refresh()
  u.state.accountEmail = 'other@example.test'
  const switched = u.sync.refresh({ force: true })
  assert.equal(u.reads.length, 2, 'the new identity starts its own read')
  u.reads[0].resolve(limitsResult(99))
  await old
  assert.equal(u.state.rateLimits, null, "the old account's numbers never show for the new one")
  u.reads[1].reject(Object.assign(new Error('usage endpoint failed'), { code: -32603 }))
  await switched
  assert.equal(u.state.rateLimits, null)
  assert.deepEqual(u.updates, [])
  const late = u.sync.refresh({ force: true })
  u.state.isLoggedIn = false
  u.reads[2].resolve(limitsResult(10))
  await late
  assert.equal(u.state.rateLimits, null)
  await u.sync.refresh({ force: true })
  u.state.isLoggedIn = true; u.setReady(false)
  await u.sync.refresh({ force: true })
  u.setReady(true); u.state.accountEmail = null
  await u.sync.refresh({ force: true })
  assert.equal(u.reads.length, 3, 'signed out, offline or unknown identity sends no read')
})

test('sparse usage notifications merge into the signed-in identity only', async () => {
  const u = usageFixture()
  const read = u.sync.refresh()
  u.reads[0].resolve(limitsResult(20, { secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1793500000 } }))
  await read
  assert.equal(u.sync.notify({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 30, windowDurationMins: null, resetsAt: null }, secondary: null } } }), true)
  assert.deepEqual(u.state.rateLimits.primary, { usedPercent: 30, windowMinutes: 300, resetsAt: 1793000000000 })
  assert.equal(u.state.rateLimits.secondary.usedPercent, 5, 'a null window never clears an observed one')
  assert.equal(u.sync.notify({ method: 'account/updated', params: {} }), false)
  u.state.isLoggedIn = false
  const before = u.updates.length
  assert.equal(u.sync.notify({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 90 } } } }), false)
  assert.equal(u.updates.length, before)
})

// SUB-14: the auth/quota/permission failure a Codex turn leaves on the auth state.
function accessFixture() {
  const state = { isLoggedIn: true, accountEmail: 'owner@example.test', accountId: null, accessFailure: null }
  const updates = []
  let clock = 2_000_000
  const tracker = createAccountAccessTracker({ auth: () => state, now: () => clock, update: patch => { updates.push(patch); Object.assign(state, patch) } })
  return { state, updates, tracker, tick: ms => { clock += ms } }
}

test('access tracker records auth, quota and permission turn rejections for the signed-in identity, with allowlisted causes only', () => {
  const a = accessFixture()
  assert.equal(a.tracker.notify({ method: 'error', params: { error: { message: 'Reconnecting', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } }, willRetry: true } }), false, 'the app-server retries itself')
  assert.equal(a.state.accessFailure, null)
  assert.equal(a.tracker.notify({ method: 'turn/completed', params: { turn: { id: 't1', status: 'failed', error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } } } }), true)
  assert.deepEqual(a.state.accessFailure, { kind: 'quota', cause: 'usageLimitExceeded', at: 2_000_000, identity: 'email:owner@example.test' })
  a.tick(10)
  assert.equal(a.tracker.notify({ method: 'error', params: { error: { message: 'Unauthorized', codexErrorInfo: 'unauthorized' } } }), true)
  assert.deepEqual([a.state.accessFailure.kind, a.state.accessFailure.at], ['auth', 2_000_010])
  assert.equal(a.tracker.notify({ method: 'error', params: { error: { message: 'boom', codexErrorInfo: 'internalServerError' } } }), false, 'network/model errors are not account states')
  assert.equal(a.state.accessFailure.kind, 'auth')
  assert.equal(a.tracker.notify({ method: 'turn/completed', params: { turn: { id: 't2', status: 'failed', error: { message: 'denied', codexErrorInfo: { unknownVariant: 1 } } } } }), false)
  assert.equal(JSON.stringify(a.state).includes('unknownVariant'), false)
  assert.equal(a.tracker.notify({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'Permission denied by policy' } } } }), true, 'a message without a structured cause still classifies')
  assert.deepEqual([a.state.accessFailure.kind, a.state.accessFailure.cause], ['permission', null])
  assert.equal(a.tracker.notify({ method: 'account/rateLimits/updated', params: {} }), false)
})

test('access tracker clears on a completed turn or a finished sign-in; a turn-scoped cause clears when the next turn starts', () => {
  const a = accessFixture()
  a.tracker.notify({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'policy', codexErrorInfo: 'sandboxError' } } } })
  assert.deepEqual(a.state.accessFailure, { kind: 'permission', cause: 'sandboxError', at: 2_000_000, identity: 'email:owner@example.test' })
  a.tracker.notify({ method: 'turn/started', params: {} })
  assert.equal(a.state.accessFailure, null)
  a.tracker.notify({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'x', codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 403 } } } } } })
  assert.equal(a.state.accessFailure.cause, 'http403')
  a.tracker.notify({ method: 'turn/started', params: {} })
  assert.equal(a.state.accessFailure.cause, 'http403', 'an account-level cause survives a new turn')
  const before = a.updates.length
  a.tracker.notify({ method: 'turn/completed', params: { turn: { status: 'completed', error: null } } })
  assert.equal(a.state.accessFailure, null)
  a.tracker.notify({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  assert.equal(a.updates.length, before + 1, 'no update without a change')
  a.tracker.notify({ method: 'error', params: { error: { message: 'Unauthorized', codexErrorInfo: 'unauthorized' } } })
  a.tracker.notify({ method: 'account/login/completed', params: { success: false, error: 'cancelled' } })
  assert.equal(a.state.accessFailure.kind, 'auth')
  a.tracker.notify({ method: 'account/login/completed', params: { success: true } })
  assert.equal(a.state.accessFailure, null)
  a.state.accountEmail = null
  a.tracker.notify({ method: 'error', params: { error: { message: 'Unauthorized', codexErrorInfo: 'unauthorized' } } })
  assert.equal(a.state.accessFailure.identity, null, 'an unknown identity records no invented key')
})

test('SUB-14 request tracker records only definite turn/start auth, quota and permission rejections and rethrows the original', async () => {
  for (const [message, info, kind, cause] of [
    ['Turn refused', 'usageLimitExceeded', 'quota', 'usageLimitExceeded'],
    ['Turn refused', 'unauthorized', 'auth', 'unauthorized'],
    ['Turn refused', 'sandboxError', 'permission', 'sandboxError'],
    ['You have hit your usage limit.', undefined, 'quota', null],
    ['Unauthorized', undefined, 'auth', null],
    ['Permission denied by policy', undefined, 'permission', null],
  ]) {
    const a = accessFixture()
    const failure = Object.assign(new Error(message), { code: -32000, codexErrorInfo: info, privateDetail: 'not an account-state field' })
    let calls = 0
    await assert.rejects(a.tracker.request('turn/start', () => { calls++; return Promise.reject(failure) }), error => error === failure)
    assert.deepEqual(a.state.accessFailure, { kind, cause, at: 2_000_000, identity: 'email:owner@example.test' })
    assert.equal(calls, 1, 'tracking never retries')
    assert.equal(a.updates.length, 1)
    assert.equal(JSON.stringify(a.state).includes('privateDetail'), false)
  }
})

test('SUB-14 request tracker leaves timeouts, transport/model/unknown errors, other methods and success unchanged', async () => {
  const a = accessFixture()
  a.tracker.notify({ method: 'error', params: { error: { codexErrorInfo: 'unauthorized' } } })
  const previous = structuredClone(a.state.accessFailure), count = a.updates.length
  for (const failure of [
    Object.assign(new Error('usage limit lookup timed out'), { code: 'RPC_TIMEOUT' }),
    Object.assign(new Error('usage limit lookup timed out'), { code: -32000 }),
    Object.assign(new Error('Unauthorized status lookup failed'), { code: -32000 }),
    Object.assign(new Error('Permission denied while writing to socket'), { code: -32000 }),
    Object.assign(new Error('Permission denied while writing to socket'), { code: 'EACCES' }),
    new Error('Unauthorized'),
    Object.assign(new Error('Turn failed'), { code: -32603 }),
    Object.assign(new Error('Turn failed'), { code: -32000, codexErrorInfo: 'contextWindowExceeded' }),
    Object.assign(new Error('Turn failed'), { code: -32000, codexErrorInfo: { unknownVariant: 1 } }),
    Object.assign(new Error('Rate limit exceeded'), { code: -32000, willRetry: true }),
  ]) {
    await assert.rejects(a.tracker.request('turn/start', () => Promise.reject(failure)), error => error === failure)
    assert.deepEqual(a.state.accessFailure, previous)
  }
  for (const method of ['thread/start', 'thread/resume', 'account/read', 'turn/interrupt']) {
    const failure = Object.assign(new Error('Quota exceeded'), { code: -32000 })
    await assert.rejects(a.tracker.request(method, () => Promise.reject(failure)), error => error === failure)
  }
  const result = { turn: { id: 'accepted' } }
  assert.equal(await a.tracker.request('turn/start', () => Promise.resolve(result)), result)
  assert.deepEqual(a.state.accessFailure, previous, 'an accepted RPC alone does not prove turn completion or account recovery')
  assert.equal(a.updates.length, count)
})

test('SUB-14 request tracker ignores unowned/stale rejections and cannot mask the original error if tracking fails', async () => {
  for (const change of ['account', 'signout', 'unknown', 'connection']) {
    const a = accessFixture()
    if (change === 'unknown') a.state.accountEmail = null
    let reject, current = true
    const failure = Object.assign(new Error('Unauthorized'), { code: -32000 })
    const pending = a.tracker.request('turn/start', () => new Promise((_resolve, fail) => { reject = fail }), () => current)
    if (change === 'account') a.state.accountEmail = 'other@example.test'
    if (change === 'signout') a.state.isLoggedIn = false
    if (change === 'connection') current = false
    reject(failure)
    await assert.rejects(pending, error => error === failure)
    assert.equal(a.state.accessFailure, null, change)
    assert.equal(a.updates.length, 0)
  }
  const failure = Object.assign(new Error('Unauthorized'), { code: -32000 })
  const tracker = createAccountAccessTracker({ auth: () => ({ isLoggedIn: true, accountEmail: 'owner@example.test' }),
    update: () => { throw new Error('status observer failed') } })
  await assert.rejects(tracker.request('turn/start', () => { throw failure }), error => error === failure)
  await assert.rejects(tracker.request('turn/start', () => Promise.reject(failure), () => { throw new Error('scope observer failed') }), error => error === failure)
})

test('bridge mounts Agent profiles, plan usage and PUT preflight in the documented order', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const at = text => { const index = source.indexOf(text); assert.notEqual(index, -1, `missing server marker: ${text}`); return index }
  // Profile storage opens beside chat storage, cannot stop the bridge, and reaches the Chat runtime.
  assert.ok(at("profileStore = openProfileStore({ dataDir: path.join(dataDir, 'chat'), ownerHash: 'local-desktop-v1' })") < at('profileStore.seedTemplates()'))
  assert.ok(at('profileStore.seedTemplates()') < at('const chat = new CodexChatRuntime({'))
  assert.ok(at('  profiles: profileStore,') > at('const chat = new CodexChatRuntime({'))
  at("const handleProfileHttp = createProfileHttpHandler({ store: () => profileStore, port: BRIDGE_PORT })")
  // Mounted after the loopback guard and local files, before Context and Chat.
  const mount = at('if (await handleProfileHttp(req, res, url)) return')
  assert.ok(at('if (await localFiles.handle(req, res, url)) return') < mount)
  assert.ok(mount < at('if (await handleContextHttp(req, res, url)) return'))
  assert.ok(mount < at('if (await handleChatHttp(req, res, url)) return'))
  at("'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS'")
  at('profileStorageReady: Boolean(profileStore), profileStorageError: profileStoreError')
  // Plan and usage travel with every auth snapshot (/v1/state, auth.status, auth-status).
  at('usage: usageDisplay(authState.rateLimits, Date.now()),')
  at("planType: publicPlanType(message.params?.planType) ?? authState.planType,")
  at("rateLimits: identityChanged || !normalized.isLoggedIn ? null : authState.rateLimits,")
  at("case 'account/rateLimits/updated':")
  assert.ok(at("case 'turn/completed':") < at('void rateLimitSync.refresh({ force: true })'))
})

test('app-server reconnect waits 1s, 2s, 4s … capped at 30s, and jitter only shortens the wait', () => {
  const steady = { random: () => 0 }
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 40, 5000].map(failures => backoffDelayMs(failures, steady)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000])
  for (const failures of [0, -3, NaN, undefined, 'x']) assert.equal(backoffDelayMs(failures, steady), 1000)
  for (const failures of [1, 3, 6, 50]) {
    const base = backoffDelayMs(failures, steady)
    const shortest = backoffDelayMs(failures, { random: () => 0.999999 })
    assert.ok(shortest >= Math.floor(base * 0.8) && shortest <= base, `${failures}: ${shortest} of ${base}`)
  }
  assert.equal(backoffDelayMs(3, { initialMs: 500, maxMs: 1500, random: () => 0 }), 1500)
})

test('reconnect state counts consecutive failures, shows only count and next time, and a ready connection resets it', () => {
  let clock = 10_000
  const backoff = createReconnectBackoff({ now: () => clock, random: () => 0 })
  assert.deepEqual(backoff.snapshot(), { consecutiveFailures: 0, nextAttemptAt: null })
  assert.deepEqual([backoff.next(), backoff.next(), backoff.next()], [1000, 2000, 4000])
  assert.deepEqual(backoff.snapshot(), { consecutiveFailures: 3, nextAttemptAt: 14_000 })
  clock = 14_000
  backoff.attempting()
  assert.deepEqual(backoff.snapshot(), { consecutiveFailures: 3, nextAttemptAt: null })
  backoff.reset()
  assert.deepEqual(backoff.snapshot(), { consecutiveFailures: 0, nextAttemptAt: null })
  assert.equal(backoff.next(), 1000)
  assert.deepEqual(Object.keys(backoff.snapshot()), ['consecutiveFailures', 'nextAttemptAt'])
})

test('/v1/state keeps every existing field in order and adds bridge build, reconnect state, engines, inherited MCP, workflow, computer control and Desk storage', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const route = source.indexOf("if (req.method === 'GET' && route === '/v1/state') {")
  assert.notEqual(route, -1)
  const body = source.indexOf('    sendJson(res, 200, {', route)
  const end = source.indexOf('\n    })\n    return\n', body)
  assert.ok(route < body && body < end)
  const block = source.slice(body, end)
  assert.deepEqual([...block.matchAll(/^ {6}([A-Za-z]\w*)(?=[:,])/gm)].map(match => match[1]), [
    'protocolVersion', 'provider', 'appServerReady', 'chatStorageReady', 'profileStorageReady', 'native',
    'engineConfiguration', 'memoryIsolation', 'node', 'auth', 'chat', 'capabilities',
    'bridge', 'appServerReconnect', 'engines', 'inheritedMcp', 'workflow', 'computerControl', 'deskStorageReady',
  ])
  assert.deepEqual([...block.matchAll(/^ {8}([A-Za-z]\w*)(?=:)/gm)].map(match => match[1]), ['auth', 'chat', 'context', 'files', 'profiles', 'engines', 'boardDeliveryIntent', 'boardPresentation', 'channelContext', 'desk', 'portable'])
  assert.ok(block.includes('boardDeliveryIntent: true,'))
  assert.ok(block.includes('boardPresentation: true,'))
  assert.ok(block.includes('channelContext: true,'))
  assert.ok(block.includes('bridge: bridgeBuildState(bridgeBuild, expectedOverlayBuild(req.headers, url.searchParams)),'))
  assert.ok(block.includes('appServerReconnect: appServerBackoff.snapshot(),'))
  assert.ok(block.includes('inheritedMcp: inheritedMcp.snapshot(),'))
  assert.ok(block.includes('workflow: workflow.snapshot(),'))
  assert.ok(block.includes('computerControl: chat.computerControlSnapshot(),'))
})

test('bridge hashes its source once at start, backs off app-server reconnects and resets on a ready connection', async () => {
  const source = await readFile(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  const at = text => { const index = source.indexOf(text); assert.notEqual(index, -1, `missing server marker: ${text}`); return index }
  assert.equal(source.split('startBridgeBuild(').length, 2, 'the build hash is computed exactly once')
  assert.ok(at('const bridgeBuild = startBridgeBuild()') < at('const bridgeServer = createServer('))
  const schedule = source.slice(at('function scheduleAppServerReconnect() {'), at('function spawnAppServer() {'))
  assert.match(schedule, /appServerBackoff\.attempting\(\)\n {4}connectToAppServer\(\)\n {2}\}, appServerBackoff\.next\(\)\)/)
  assert.doesNotMatch(schedule, /\}, \d+\)/)
  const open = source.slice(at('socket.onopen = async () => {'), at('socket.onmessage = event => {'))
  assert.ok(open.indexOf('appServerReady = true') < open.indexOf('appServerBackoff.reset()'))
  assert.equal(source.split('appServerBackoff.reset()').length, 2)
})

test('run changes and command output are read from bridge memory without an account call, with exact query checks', async () => {
  let authCalls = 0
  const chat = new CodexChatRuntime({
    request: async (method) => {
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, cwd: '/work' }
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }
      throw new Error(`Unexpected method: ${method}`)
    }, respond: () => {}, emit: () => {},
  })
  chat.setConnection(true)
  const run = await chat.send({ message: 'Run tests' })
  await chat.handleNotification({ method: 'item/commandExecution/outputDelta', params: { threadId: run.conversationId, turnId: run.runId, itemId: 'cmd-1', delta: 'ok 1\npassword=HTTP_SECRET\n' } })
  await chat.handleNotification({ method: 'item/fileChange/patchUpdated', params: { threadId: run.conversationId, turnId: run.runId, itemId: 'edit-1', changes: [{ path: '/work/a.js', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] } })
  const handler = createChatHttpHandler(chat, async () => { authCalls++ })
  const get = async target => {
    const req = request(''); req.method = 'GET'
    const res = response()
    assert.equal(await handler(req, res, new URL(`http://localhost${target}`)), true)
    return res
  }
  const ids = `conversationId=${encodeURIComponent(run.conversationId)}&runId=${encodeURIComponent(run.runId)}`
  const output = await get(`/chat/command-output?${ids}&itemId=cmd-1`)
  assert.equal(output.status, 200)
  assert.deepEqual([output.body.protocolVersion, output.body.itemId, output.body.head, output.body.tail, output.body.complete], [1, 'cmd-1', 'ok 1\npassword=[REDACTED]\n', '', false])
  const changes = await get(`/chat/run-changes?${ids}`)
  assert.equal(changes.status, 200)
  assert.deepEqual(changes.body.items.map(item => [item.itemId, item.files[0].diff]), [['edit-1', '@@ -1 +1 @@\n-a\n+b\n']])
  assert.deepEqual(changes.body.commands, [{ itemId: 'cmd-1', totalBytes: Buffer.byteLength('ok 1\npassword=HTTP_SECRET\n'), complete: false }])
  assert.deepEqual((await get(`/chat/run-changes?${ids}&itemId=edit-1`)).body.items.length, 1)
  for (const [target, status, code] of [
    [`/chat/command-output?${ids}`, 400, 'INVALID_RUN_OUTPUT_QUERY'],
    [`/chat/command-output?${ids}&itemId=`, 400, 'INVALID_RUN_OUTPUT_QUERY'],
    [`/chat/run-changes?runId=${run.runId}`, 400, 'INVALID_RUN_OUTPUT_QUERY'],
    [`/chat/run-changes?conversationId=${'x'.repeat(301)}&runId=r`, 400, 'INVALID_RUN_OUTPUT_QUERY'],
    [`/chat/run-changes?conversationId=nope&runId=nope`, 404, 'RUN_NOT_FOUND'],
    [`/chat/command-output?${ids}&itemId=cmd-9`, 404, 'COMMAND_OUTPUT_UNAVAILABLE'],
  ]) {
    const res = await get(target)
    assert.deepEqual([res.status, res.body.code], [status, code], target)
    assert.deepEqual(Object.keys(res.body), ['code', 'error'])
  }
  assert.equal(authCalls, 0)
  const post = response()
  assert.equal(await handler(request('{}', {}, '/chat/run-changes'), post, new URL('http://localhost/chat/run-changes')), false, 'only GET reads outputs')
})

test('2-R routes: Board send, message sharing and sub-Agent hand-back reach their runtime actions with auth; a stop requirement is reported', async () => {
  const seen = []
  let auth = 0
  const chat = {
    sendBoard: async (body, { authenticateRecipient }) => { await authenticateRecipient({ ...body, clientThreadId: 'member-thread', profileId: 'member' }); seen.push(['sendBoard', body]); return { accepted: true, requestId: 'b-1', clientThreadId: body.clientThreadId, recipients: [] } },
    shareMessages: body => { seen.push(['shareMessages', body]); return { accepted: true, shareId: 'share-1', messageCount: 1, attach: 'nextTurn' } },
    reassignSubAgent: async () => { throw Object.assign(new Error('Stop or wait for the current turn, then hand the task back'), { httpStatus: 409, code: 'RUN_IN_PROGRESS', stopRequired: true, conversationId: 'parent' }) },
  }
  const handler = createChatHttpHandler(chat, async () => { auth += 1 })
  const post = async (path, body) => { const res = response(); assert.equal(await handler(request(JSON.stringify(body), {}, path), res, new URL(`http://localhost${path}`)), true); return res }
  const board = await post('/chat/board/send', { clientThreadId: 'room-1', message: '@코더 봐 줘' })
  assert.deepEqual([board.status, board.body.accepted], [202, true])
  const share = await post('/chat/share', { fromClientThreadId: 'a', toClientThreadId: 'b', localMessageIds: ['m-1'] })
  assert.deepEqual([share.status, share.body.shareId], [200, 'share-1'])
  const handback = await post('/chat/subagent/reassign', { conversationId: 'parent', runId: 'turn-1', threadId: 'child-1' })
  assert.deepEqual([handback.status, handback.body.code, handback.body.stopRequired, handback.body.accepted], [409, 'RUN_IN_PROGRESS', true, false])
  assert.deepEqual(seen.map(([action, body]) => [action, Object.keys(body)]), [['sendBoard', ['clientThreadId', 'message']], ['shareMessages', ['fromClientThreadId', 'toClientThreadId', 'localMessageIds']]])
  assert.equal(auth, 3)
  const invalidCwd = await post('/chat/board/send', { clientThreadId: 'room-1', message: 'hi', cwd: 'relative/path' })
  assert.equal(invalidCwd.status, 400)
  assert.equal(auth, 3, 'an invalid project folder is refused before the account check, as for /chat/send')
  // A runtime without the action answers that plainly instead of crashing.
  const bare = createChatHttpHandler({}, async () => {})
  const res = response()
  await bare(request(JSON.stringify({ clientThreadId: 'room-1', message: 'hi' }), {}, '/chat/board/send'), res, new URL('http://localhost/chat/board/send'))
  assert.deepEqual([res.status, res.body.code, res.body.accepted], [501, 'CHAT_ACTION_UNAVAILABLE', false])
})

test('CHAT-01: POST /chat/rooms/agent reaches setRoomAgent without an engine account check; a room never sent answers 404; a bridge without it answers 501', async () => {
  const seen = []
  let auth = 0
  const chat = {
    setRoomAgent: body => {
      seen.push(body)
      if (body.clientThreadId === 'never-sent') throw Object.assign(new Error('That conversation has not been saved yet'), { code: 'CONVERSATION_NOT_FOUND', httpStatus: 404 })
      return { accepted: true, clientThreadId: body.clientThreadId, agent: body.profileId === null ? null : { profileId: body.profileId, revision: body.revision ?? null, setAt: 7 } }
    },
  }
  const handler = createChatHttpHandler(chat, async () => { auth += 1; throw Object.assign(new Error('Codex ChatGPT login is required'), { code: 'LOGIN_REQUIRED', httpStatus: 401 }) })
  const post = async body => { const res = response(); assert.equal(await handler(request(JSON.stringify(body), {}, '/chat/rooms/agent'), res, new URL('http://localhost/chat/rooms/agent')), true); return res }
  const picked = await post({ clientThreadId: 'room-1', profileId: 'code-reviewer', revision: 3 })
  assert.deepEqual([picked.status, picked.body], [200, { accepted: true, clientThreadId: 'room-1', agent: { profileId: 'code-reviewer', revision: 3, setAt: 7 } }])
  const cleared = await post({ clientThreadId: 'room-1', profileId: null, revision: null })
  assert.deepEqual([cleared.status, cleared.body.agent], [200, null])
  const unsent = await post({ clientThreadId: 'never-sent', profileId: 'code-reviewer' })
  assert.deepEqual([unsent.status, unsent.body.code, unsent.body.accepted], [404, 'CONVERSATION_NOT_FOUND', false])
  assert.equal(auth, 0, 'a signed-out pick is still written: the room Agent is a local-store record, not a turn')
  assert.deepEqual(seen.map(body => [body.clientThreadId, body.profileId]), [['room-1', 'code-reviewer'], ['room-1', null], ['never-sent', 'code-reviewer']])
  const bare = createChatHttpHandler({}, async () => {})
  const res = response()
  await bare(request(JSON.stringify({ clientThreadId: 'room-1', profileId: 'code-reviewer' }), {}, '/chat/rooms/agent'), res, new URL('http://localhost/chat/rooms/agent'))
  assert.deepEqual([res.status, res.body.code], [501, 'CHAT_ACTION_UNAVAILABLE'])
})
