import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import test from 'node:test'
import { rm } from 'node:fs/promises'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { boardStoreMembers, boardSendPlan } from '../overlay/resources/EGDeskBoardThread.sys.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { createCodexEngineAdapter, describeCodexEngine } from './codex-engine-adapter.mjs'
import { createCodexProfileAppServers } from './codex-profile-app-servers.mjs'

function fixture({ reply = () => undefined, getBoardPeerContract = () => null, describeOwned = false } = {}) {
  const homes = new Map([['codex-11111111', { home: '/private/one', identity: 'one' }], ['codex-22222222', { home: '/private/two', identity: 'two' }]])
  const accounts = new Map([['/private/one', 'one@example.org'], ['/private/two', null]])
  const children = [], events = [], shared = []
  let adapter
  const env = { PATH: '/system/bin', HOME: '/user', CODEX_HOME: '/default', OPENAI_API_KEY: 'fake', CODEX_ACCESS_TOKEN: 'fake', CODEX_API_KEY: 'fake', OPENAI_BASE_URL: 'fake', OTHER_TOKEN: 'fake' }
  const pool = createCodexProfileAppServers({ env, cwd: '/workspace', executable: () => '/synthetic/codex', getBoardPeerContract,
    resolveHome: id => { if (!homes.has(id)) throw Object.assign(new Error('No slot'), { code: 'NOT_FOUND' }); return homes.get(id) },
    spawnChild(executable, args, options) {
      const child = new EventEmitter(), home = options.env.CODEX_HOME
      Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), sent: [], kills: [], executable, args, options })
      child.emitRpc = message => child.stdout.write(`${JSON.stringify(message)}\n`)
      child.stdin = new Writable({ write(data, _, done) {
        const message = JSON.parse(data.toString())
        child.sent.push(message)
        if (message.method && message.id) queueMicrotask(() => {
          const override = reply(message, child)
          if (override === null) return // defer to the test
          if (override !== undefined) { child.emitRpc({ id: message.id, ...override }); return }
          const email = accounts.get(home)
          const result = message.method === 'account/read' ? { account: email ? { type: 'chatgpt', email, planType: 'plus' } : null }
            : message.method === 'model/list' ? { data: [{ id: home.split('/').pop(), model: home.split('/').pop(), displayName: email }], nextCursor: null }
            : message.method === 'thread/start' ? { thread: { id: home } } : {}
          child.emitRpc({ id: message.id, result })
        })
        done()
      } })
      child.kill = signal => { child.kills.push(signal); queueMicrotask(() => child.emit('close')); return true }
      children.push(child)
      return child
    },
    onNotification: (id, message) => adapter.notify(message, id),
    onServerRequest: (id, message) => adapter.serverRequest(message, id),
    onConnection: (id, state) => adapter.connection(state, id),
  })
  adapter = createCodexEngineAdapter({ profiles: pool,
    ...(describeOwned ? { describe: () => describeCodexEngine({ ready: true, extraProfiles: [...homes.keys()].map(id => ({ id, runnable: true, ...pool.snapshot(id) })) }) } : {}),
    getBoardPeerContract: () => 'd'.repeat(64), request: (...args) => { shared.push(args); return 'default' }, respond: (...args) => shared.push(args), getOwnerKey: () => 'shared-owner', getModels: () => [{ id: 'shared-model' }] })
  adapter.subscribe({ notification: (...args) => events.push(args), serverRequest: (...args) => events.push(args), connection: (...args) => events.push(args) })
  return { pool, adapter, homes, accounts, children, events, env, shared }
}

const A = 'codex-11111111', B = 'codex-22222222'

test('two owned stdio transports have exact auth/models, isolated environment, and correlated responses', async () => {
  const { pool, adapter, accounts, env, children, events, shared } = fixture()
  try {
    await Promise.all([adapter.ensureReady(A), assert.rejects(adapter.ensureReady(B), { code: 'ENGINE_LOGIN_REQUIRED' })])
    assert.equal(children.length, 2)
    assert.equal(adapter.isReady(A), true)
    assert.equal(adapter.isReady(B), false)
    assert.equal(adapter.ownerKey(A), 'email:one@example.org')
    assert.equal(adapter.ownerKey(B), null)
    assert.equal(adapter.ownerKey('codex-default'), 'shared-owner')
    assert.equal(adapter.models(A)[0].id, 'one')
    assert.equal(adapter.models(B), null)
    assert.equal(adapter.models('codex-default')[0].id, 'shared-model')
    assert.deepEqual(children.map(c => c.options.env), ['/private/one', '/private/two'].map(CODEX_HOME => ({ PATH: '/system/bin', HOME: '/user', CODEX_HOME })))
    assert.equal(env.CODEX_HOME, '/default')
    assert.equal(env.OPENAI_API_KEY, 'fake')
    for (const child of children) {
      assert.deepEqual(child.args, ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store=file'])
      assert.deepEqual(child.options.stdio, ['pipe', 'pipe', 'pipe'])
      assert.equal(child.options.shell, false)
      assert.equal(child.sent[2].method, 'account/read')
      assert.deepEqual(child.sent[2].params, { refreshToken: false })
    }
    accounts.set('/private/two', 'two@example.org')
    await adapter.refresh(B)
    assert.equal(children.length, 3)
    assert.deepEqual(children[1].kills, ['SIGTERM'])
    assert.equal(adapter.ownerKey(B), 'email:two@example.org')
    assert.equal(adapter.models(B)[0].id, 'two')
    assert.deepEqual(await adapter.startThread({ cwd: '/workspace' }, A), { thread: { id: '/private/one' } })
    assert.deepEqual(await adapter.startThread({ cwd: '/workspace' }, B), { thread: { id: '/private/two' } })
    assert.equal(adapter.startThread({}, 'codex-default'), 'default')
    for (const child of [children[0], children[2]]) child.emitRpc({ id: 77, method: 'approval', params: {} })
    const [a, b] = events.filter(([, state]) => state.method === 'approval')
    assert.equal(a[2], A)
    assert.equal(b[2], B)
    assert.notEqual(a[1].id, b[1].id)
    assert.throws(() => adapter.respond(a[1].id, {}, undefined, B), { code: 'ENGINE_PROFILE_MISMATCH' })
    assert.throws(() => adapter.respond(a[1].id, {}), { code: 'ENGINE_PROFILE_NOT_FOUND' })
    adapter.respond(a[1].id, { decision: 'allow' }, undefined, A)
    assert.deepEqual(children[0].sent.at(-1), { id: 77, result: { decision: 'allow' } })
    assert.throws(() => adapter.respond(a[1].id, {}, undefined, A), { code: 'ENGINE_PROFILE_MISMATCH' })
    children[0].emitRpc({ id: 77, method: 'approval', params: {} })
    assert.equal(events.filter(([, event]) => event.method === 'approval').length, 2)
    assert.equal(children[0].sent.filter(message => message.id === 77).length, 1)
    const resolved = { method: 'serverRequest/resolved', params: { requestId: 77, threadId: 'thread' } }
    children[2].emitRpc(resolved) // server cancellation before a reply, same native ID
    children[0].emitRpc(resolved) // delayed resolution after a reply
    children[0].emitRpc(resolved) // duplicate resolution is ignored
    assert.deepEqual(events.filter(([, event]) => event.method === resolved.method), [[b, B], [a, A]].map(([entry, slot]) =>
      ['codex', { ...resolved, params: { ...resolved.params, requestId: entry[1].id } }, slot]))
    assert.throws(() => adapter.respond(b[1].id, {}, undefined, B), { code: 'ENGINE_PROFILE_MISMATCH' })
    assert.equal(children[2].sent.at(-1).method, 'thread/start')
    assert.equal(shared.length, 1)
  } finally { await adapter.dispose() }
  assert.equal(pool.residentCount(), 0)
  assert.deepEqual(children.map(c => c.kills), [['SIGTERM'], ['SIGTERM'], ['SIGTERM']])
})

test('stale, missing, revoked, and replaced homes fail closed instead of selecting shared Codex', async () => {
  const { adapter, accounts, homes, events, children, shared } = fixture()
  try {
    await assert.rejects(adapter.ensureReady('missing'), { code: 'NOT_FOUND' })
    await adapter.ensureReady(A)
    const old = children[0]
    homes.set(A, { home: '/private/one', identity: 'replacement' })
    assert.equal(adapter.isReady(A), false)
    assert.throws(() => adapter.startThread({}, A), { code: 'ENGINE_PROFILE_HOME_UNAVAILABLE' })
    old.emitRpc({ method: 'thread/started', params: {} })
    assert.equal(events.some(([, event]) => event.method === 'thread/started'), false)
    assert.ok(events.some(([, event, id]) => event.processLost && id === A))
    await adapter.ensureReady(A)
    accounts.set('/private/one', 'different@example.org')
    await assert.rejects(adapter.ensureReady(A), { code: 'ENGINE_LOGIN_REQUIRED' })
    assert.equal(adapter.ownerKey(A), null)
    assert.throws(() => adapter.startThread({}, A), { code: 'ENGINE_UNAVAILABLE' })
    await adapter.ensureReady(A)
    homes.delete(A)
    assert.throws(() => adapter.startThread({}, A), { code: 'NOT_FOUND' })
    assert.equal(shared.length, 0)
  } finally { await adapter.dispose() }
})

test('send authentication prepares only the durable scoped slot and refuses a changed route', async () => {
  const { createChatEngineAuth } = await import('./codex-bridge-engine-auth.mjs')
  const { adapter, children, shared } = fixture()
  let selected = A, rewritten = null, legacyChecks = 0
  const chat = {
    requestEngineRoute: (_body, { verifyAccount, useAgent }) => ({ engineId: 'codex', engineProfileId: verifyAccount && rewritten ? rewritten : useAgent ? selected : A }),
    assertEngineContext: () => {},
    assertReady: () => { legacyChecks++ },
    engines: { get: () => adapter },
  }
  const ensure = createChatEngineAuth({ chat, refreshCodexAccount: async () => { legacyChecks++ }, getCodexAuth: () => null })
  try {
    await assert.rejects(ensure({}), { code: 'ENGINE_PROFILE_MISMATCH' })
    assert.equal(children.length, 0)
    assert.equal(await ensure({}, { useAgent: true }), 'codex')
    rewritten = B
    await assert.rejects(ensure({}, { useAgent: true }), { code: 'ENGINE_PROFILE_MISMATCH' })
    rewritten = null
    selected = B
    await assert.rejects(ensure({}, { useAgent: true }), { code: 'ENGINE_LOGIN_REQUIRED' })
    assert.equal(shared.length, 0)
    assert.equal(legacyChecks, 0)
  } finally { await adapter.dispose() }
})

test('native auth rejection drops only the selected readiness and catalog before a new scoped proof', async () => {
  let holdOldCatalog = false, held
  const { pool, adapter, accounts, children, events, shared } = fixture({ reply(request, child) {
    if (request.method === 'model/list' && holdOldCatalog && child === children[0]) { held = request; return null }
    if (request.method === 'turn/start') return { error: { code: -32000, message: 'Request failed', data: { codexErrorInfo: 'unauthorized' } } }
  } })
  const shownAuth = () => describeCodexEngine({ extraProfiles: [{ id: A, ...pool.snapshot(A) }] }).profiles[1].auth.status
  try {
    accounts.set('/private/two', 'two@example.org')
    await adapter.ensureReady(A)
    await adapter.ensureReady(B)
    const old = children[0]
    assert.equal(shownAuth(), 'signedIn')
    assert.equal(adapter.models(A)[0].id, 'one')
    holdOldCatalog = true
    const pendingCheck = assert.rejects(adapter.ensureReady(A), { code: 'ENGINE_LOGIN_REQUIRED' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(held?.method, 'model/list')
    await assert.rejects(adapter.startTurn({}, A), { code: -32000, message: 'Request failed' })
    assert.equal(shownAuth(), 'unknown')
    assert.equal(adapter.isReady(A), false)
    assert.equal(adapter.ownerKey(A), null)
    assert.equal(adapter.models(A), null)
    assert.deepEqual(old.kills, ['SIGTERM'])
    assert.ok(events.some(([, event, slot]) => slot === A && event.ready === false && event.processLost))
    assert.throws(() => adapter.startThread({}, A), { code: 'ENGINE_UNAVAILABLE' })
    old.emitRpc({ id: held.id, result: { data: [{ id: 'old' }] } })
    await pendingCheck
    assert.equal(shownAuth(), 'unknown')
    assert.equal(adapter.ownerKey(B), 'email:two@example.org')
    assert.equal(adapter.models(B)[0].id, 'two')
    assert.equal(adapter.ownerKey('codex-default'), 'shared-owner')
    assert.equal(shared.length, 0)

    accounts.set('/private/one', null)
    await assert.rejects(adapter.ensureReady(A), { code: 'ENGINE_LOGIN_REQUIRED' })
    assert.equal(shownAuth(), 'signedOut')
    assert.equal(adapter.models(A), null)
    accounts.set('/private/one', 'renewed@example.org')
    await adapter.refresh(A)
    assert.equal(shownAuth(), 'signedIn')
    assert.equal(adapter.ownerKey(A), 'email:renewed@example.org')
    assert.equal(adapter.models(A)[0].displayName, 'renewed@example.org')
    assert.equal(children.length, 4)
  } finally { await adapter.dispose() }
})

test('retryable and non-auth failures keep readiness; terminal auth and catalog auth errors invalidate it', async () => {
  let rpcError, rejectCatalog = false
  const { adapter, children } = fixture({ reply(request) {
    if (request.method === 'turn/start' && rpcError) return { error: rpcError }
    if (request.method === 'model/list' && rejectCatalog) return { error: { code: -32000, message: 'Token has expired. Please sign in again.' } }
  } })
  try {
    await adapter.ensureReady(A)
    for (const message of ['Usage limit reached', 'Unauthorized status lookup failed']) {
      rpcError = { code: -32000, message }
      await assert.rejects(adapter.startTurn({}, A), { message })
      assert.equal(adapter.isReady(A), true)
    }
    const error = { message: 'Upstream refused the connection', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 401 } } }
    children[0].emitRpc({ id: 999999, error: { code: 401, message: 'Unauthorized' } })
    children[0].emitRpc({ method: 'error', params: { error, willRetry: true } })
    assert.equal(adapter.isReady(A), true)
    children[0].emitRpc({ method: 'turn/completed', params: { turn: { error } } })
    assert.equal(adapter.isReady(A), false)
    assert.equal(adapter.models(A), null)

    rejectCatalog = true
    await assert.rejects(adapter.ensureReady(A), { code: 'ENGINE_LOGIN_REQUIRED' })
    assert.equal(adapter.isReady(A), false, 'account/read alone cannot override an auth-rejected catalog read')
    assert.equal(adapter.models(A), null)
    assert.deepEqual(children.map(child => child.kills), [['SIGTERM'], ['SIGTERM']])
  } finally { await adapter.dispose() }
})

test('answered ID retention is bounded and a closed client cannot resolve or reply on a replacement', async () => {
  const { adapter, children, events } = fixture()
  try {
    await adapter.ensureReady(A)
    const old = children[0], limit = 4096
    const request = (child, id) => {
      child.emitRpc({ id, method: 'approval', params: {} })
      return events.at(-1)[1].id
    }
    const resolve = (child, requestId) => child.emitRpc({ method: 'serverRequest/resolved', params: { requestId } })
    for (let i = 0; i <= limit; i++) adapter.respond(request(old, i), {}, undefined, A)
    const latest = events.at(-1)[1].id, active = request(old, limit + 1)
    const eventCount = events.length
    resolve(old, 0)
    assert.equal(events.length, eventCount, 'oldest answered mapping was evicted at the retention limit')
    resolve(old, limit)
    assert.equal(events.at(-1)[1].params.requestId, latest)
    adapter.respond(active, {}, undefined, A)
    old.emit('close')
    await adapter.ensureReady(A)
    const replacement = children[1], reused = request(replacement, limit + 1)
    const beforeStale = events.length
    assert.throws(() => adapter.respond(active, {}, undefined, A), { code: 'ENGINE_PROFILE_MISMATCH' })
    resolve(old, limit + 1)
    assert.equal(events.length, beforeStale)
    adapter.respond(reused, {}, undefined, A)
    resolve(replacement, limit + 1)
    assert.equal(events.at(-1)[1].params.requestId, reused)
  } finally { await adapter.dispose() }
})

test('Board peer steering is scoped to the checked process, never the shared fallback or another account with missing proof', async () => {
  let proof = 'a'.repeat(64)
  const { pool, adapter, accounts, children, shared } = fixture({ getBoardPeerContract: bin => bin === '/synthetic/codex' ? proof : null })
  try {
    await adapter.ensureReady(A); proof = null; accounts.set('/private/two','two@example.invalid'); await adapter.ensureReady(B)
    assert.equal(adapter.boardPeerContract(A), 'a'.repeat(64)); assert.equal(adapter.boardPeerContract(B), null)
    const p = { threadId: 'c', expectedTurnId: 'r', clientUserMessageId: 'synthetic', input: [{ type: 'text', text: 'fixture', text_elements: [] }], additionalContext: { egdesk_board_peer: { kind: 'untrusted', value: 'public' } } }
    await adapter.steerTurn(p, A, 'a'.repeat(64)); assert.equal(children[0].sent.filter(c => c.method === 'turn/steer').length, 1)
    for (const [slot, wrong] of [[B,'a'],[B,'d'],[A,'d']]) assert.throws(() => adapter.steerTurn(p, slot, wrong.repeat(64)), { code: 'BOARD_PEER_UNSUPPORTED' })
    assert.ok(!children[1].sent.some(c => c.method==='turn/steer')); assert.deepEqual(shared, [])
  } finally { await pool.dispose() }
})

// Production pool + JSON-RPC + slot-tagged notifications + runtime + SQLite.
// Only the child process is synthetic. In particular neither chat.handleNotification nor
// steerTurn is called by the test to simulate delivery. Each engine can reuse a turn id.
async function scopedBoard(t, { missingB = false, threadId = slot => `board-${slot}` } = {}) {
  const dataDir = createPrivateQaTempDirectory('egdesk-board-slot-'), store = openChatStore({ dataDir, ownerScope: 'qa-slots' })
  const room = { id: 'two-accounts', type: 'group', participants: ['나','솔빛','물결'], participantAgents: { 솔빛: { profileId:'sol' }, 물결: { profileId:'water' } }, messages: [] }
  store.createConversation({clientThreadId:room.id}); store.setRoomMembers({ clientThreadId:room.id, members:boardStoreMembers(room), ts:1 })
  const published = [], received = [], ids = new Map([['sol',A],['water',B]]); let currentProof = 'a'.repeat(64)
  const h = fixture({ describeOwned: true, getBoardPeerContract: () => currentProof, reply(wire, child) {
    const slot = child.options.env.CODEX_HOME === '/private/one' ? A : B
    if (wire.method === 'thread/start') return { result: { thread:{id:threadId(slot)}, cwd:'/workspace' } }
    if (wire.method === 'turn/start') return { result:{turn:{id:'turn-one', status:'inProgress', items:[]}} }
    if (wire.method !== 'turn/steer') return undefined
    const post = published.find(e => e.event === 'message.completed' && e.details.phase === 'final_answer')
    const saved = post && store.listEvents(post.clientThreadId).events.find(e => e.event === 'message.completed' && e.localMessageId === post.localMessageId)
    received.push({ slot, params:wire.params, posted:post?.durable === true, stored:saved?.details.text, publicText:post?.details.text,
      sourceStillRunning:post && !published.some(e => e.event === 'run.completed' && e.conversationId === post.conversationId && e.runId === post.runId) })
    return { result:{turnId:wire.params.expectedTurnId} }
  } })
  const profiles = { runProfile:id => ({ binding:{ profileId:id, revision:1, hash:`synthetic-${id}` }, developerInstructions:`identity:${id}`, model:{engine:'codex',engineProfileId:ids.get(id)} }) }
  const chat = new CodexChatRuntime({ store, requireStore:true, engines:[h.adapter], profiles, emit:e=>published.push(e) })
  const unsubscribe = h.adapter.subscribe({ notification:(engine,m,slot)=>{void chat.handleNotification(m,engine,slot)},
    connection:(engine,s,slot)=>chat.setConnection(engine,s.ready,{processLost:s.processLost,engineProfileId:slot}) })
  t.after(async()=>{ unsubscribe(); try { await h.pool.dispose() } finally { store.close(); await rm(dataDir,{recursive:true,force:true}) } })
  h.accounts.set('/private/two','two@example.invalid'); await h.adapter.ensureReady(A)
  currentProof = missingB ? null : 'b'.repeat(64); await h.adapter.ensureReady(B)
  const send = (message='@솔빛 @물결 표지 색을 골라주세요.',requestId='board-two-accounts')=>chat.sendBoard(boardSendPlan(room,{ message,requestId,clientThreadId:room.id,engineId:'codex' }).body)
  const slotOf = r => ids.get(r.profileId), childOf = r => h.children[slotOf(r)===A?0:1]
  const notify = async (r, method, params) => { childOf(r).emitRpc({method,params:{threadId:r.conversationId,turnId:r.runId,...params}}); await new Promise(resolve=>setImmediate(resolve)); await chat.queue }
  const say = (r,id,phase,text)=>notify(r,'item/completed',{item:{id,type:'agentMessage',phase,text}})
  const end = r=>notify(r,'turn/completed',{turn:{id:r.runId,status:'completed',items:[]}})
  return {...h,chat,store,room,send,say,end,published,received,slotOf,childOf}
}

test('owned Board slots: the actual public final is committed and broadcast before the *other slot* receives it, not gated on speaker turn end', async t => {
  for (const first of ['sol','water']) await t.test(first,async t=>{
    const h=await scopedBoard(t), rows=(await h.send()).recipients
    assert.deepEqual(rows.map(r=>r.status),['started','started']); const source=rows.find(r=>r.profileId===first), target=rows.find(r=>r!==source)
    assert.equal(source.runId,target.runId); assert.notEqual(source.conversationId,target.conversationId)
    await h.say(source,'note','commentary','작업 기록만'); assert.equal(h.received.length,0)
    const words=first==='sol'?'표지는 청록색으로 해요.':'표지는 보라색으로 해요.'
    await h.say(source,'final','final_answer',words); assert.equal(h.received.length,1)
    const [{ slot,params,posted,stored,publicText,sourceStillRunning }] = h.received
    assert.deepEqual([slot,params.threadId,params.expectedTurnId,posted,stored,publicText,sourceStillRunning], [h.slotOf(target),target.conversationId,target.runId,true,words,words,true])
    assert.equal(params.additionalContext.egdesk_board_peer.kind,'untrusted'); assert.equal(JSON.parse(params.additionalContext.egdesk_board_peer.value).text,words)
    assert.deepEqual(h.published.filter(e => e.details?.activity?.kind === 'boardPeerInput').map(e => [e.clientThreadId,e.conversationId,e.runId,e.details.activity.status]),
      [[target.clientThreadId,target.conversationId,target.runId,'completed']])
    await h.end(source); await h.say(target,'final','final_answer','그 색이 좋겠어요.'); await h.end(target)
    assert.equal(h.received.length,1); assert.deepEqual(h.shared,[])
    for(const r of rows){ const log=h.childOf(r).sent; assert.equal(log.filter(m=>m.method==='turn/start').length,1); assert.equal(log.filter(m=>m.method==='turn/steer').length,r===target?1:0); assert.equal(log.some(m=>m.method==='turn/interrupt'),false) }
  })
})

test('owned Board slots: shared proof and sign-in cannot replace a missing/stale recipient slot',async t=>{
  for(const mode of ['no-peer-proof','account-changed']) await t.test(mode,async t=>{
    const h=await scopedBoard(t,{missingB:mode==='no-peer-proof'}); const [source,target]=(await h.send()).recipients
    assert.deepEqual([source.status,target.status],['started','started']); assert.ok(h.adapter.boardPeerContract('codex-default'))
    if(mode==='account-changed'){h.accounts.set('/private/two','changed@example.invalid'); await assert.rejects(h.adapter.ensureReady(B),{code:'ENGINE_LOGIN_REQUIRED'})}
    await h.say(source,'final','final_answer','밝은 표지를 제안합니다.'); assert.equal(h.received.length,0)
    assert.deepEqual(h.shared,[]); assert.ok(!h.children.some(c=>c.sent.some(m=>m.method==='turn/steer')))
  })
})

test('owned Board slots: a newly returned colliding thread id is not rebound and cannot start a second turn', async t => {
  const h = await scopedBoard(t, { threadId: () => 'native-thread-already-bound' })
  const [a, b] = (await h.send()).recipients
  assert.deepEqual([a.status, b.status, b.code], ['started', 'failed', 'THREAD_MISMATCH'])
  assert.equal(h.chat.threadOperationSlot(a.conversationId), A)
  assert.equal(h.store.getConversationByNative(a.conversationId).clientThreadId, a.clientThreadId)
  assert.notEqual(h.store.getConversation(b.clientThreadId)?.conversationId, a.conversationId)
  assert.deepEqual(h.children.map(c => c.sent.filter(m => m.method === 'thread/start').length), [1, 1])
  assert.deepEqual(h.children.map(c => c.sent.filter(m => m.method === 'turn/start').length), [1, 0])
  await h.say(a, 'final', 'final_answer', '기존 대화에서 답하겠습니다.'); await h.end(a)
  assert.deepEqual(h.received, []); assert.deepEqual(h.shared, [])
  assert.equal(h.store.listMessages(a.clientThreadId).messages.filter(m => m.role === 'assistant').length, 1)
  assert.equal(h.store.listMessages(b.clientThreadId).messages.filter(m => m.role === 'assistant').length, 0)
})
