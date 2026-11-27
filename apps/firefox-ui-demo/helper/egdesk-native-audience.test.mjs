import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { DECISION_CONTEXT_KEY } from './egdesk-context-setup.mjs'

// Isolate the last-mile dispatch contract. The evidence-wiring suite exercises the
// real resolver/scorer. Here its guarded packet is synthetic, as is every native reply.
const DM = 'local-dm', A = 'first-agent', B = 'second-agent', TEXT = 'synthetic-private-passage'
const locked = { code: 'NATIVE_AUDIENCE_LOCKED' }
function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'native-dm-audience-'))
  const options = { dataDir: dir, ownerScope: 'synthetic-audience' }
  const w = { options, calls: [], mode: 'on', active: true, n: 0, c: 0, r: 0 }
  function boot() {
    w.store = openChatStore(options)
    w.chat = new CodexChatRuntime({ store: w.store, requireStore: true, getOwnerKey: () => 'test-account',
      profiles: { runProfile: profileId => ({ binding: { profileId, revision: 1, hash: `test-${profileId}` }, developerInstructions: `Agent ${profileId}` }) },
      resolveProjectWorkspace: async () => null, respond() {}, request: async (method, params) => {
        w.calls.push({ method, params })
        await w.hook?.(method, params)
        if (method === 'thread/start') return { thread: { id: `native-${++w.c}` } }
        if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] } }
        if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
        if (method === 'thread/fork') return { thread: { id: `native-${++w.c}`, forkedFromId: params.threadId } }
        if (method === 'turn/start') return { turn: { id: `turn-${++w.r}`, status: 'completed', items: [] } }
        assert.fail(`Unexpected native call: ${method}`)
      } })
    w.chat.prepareDecisionContext = async body => w.mode === 'off' || !body.selectedSources?.length ? null : {
      mode: w.mode, result: { status: 'ready', selected: [], extraContext: { [DECISION_CONTEXT_KEY]: TEXT }, mayDispatch: () => w.active } }
    w.chat.setConnection(true)
  }
  boot()
  t.after(() => { w.store.close(); rmSync(dir, { recursive: true, force: true }) })
  w.restart = () => { w.store.close(); boot() }
  w.send = (cid, fields = {}) => w.chat.send({ clientThreadId: DM, profileId: A, replyDestination: 'direct',
    message: 'ordinary question', requestId: `request-${++w.n}`, ...(cid ? { conversationId: cid } : {}), ...fields })
  w.ground = (cid, fields) => w.send(cid, { selectedSources: [{ id: 'synthetic-source' }], ...fields })
  w.lastTurn = () => w.calls.filter(c => c.method === 'turn/start').at(-1)?.params
  return w
}

test('reservation commits before native private input; reopened store rejects changed audience before native resume, even with Decision off', async t => {
  const w = fixture(t)
  w.hook = (method, params) => {
    if (method !== 'turn/start') return
    const witness = openChatStore(w.options)
    try { assert.equal(witness.getNativeAudience(params.threadId), A) } finally { witness.close() }
  }
  const { conversationId: cid } = await w.ground()
  assert.equal(w.lastTurn().additionalContext[DECISION_CONTEXT_KEY].value, TEXT)
  const marker = w.store.listEvents(DM).events.find(e => e.event === 'native.audience.reserved')
  assert.deepEqual(marker.details, { profileId: A }); assert.deepEqual(marker.contextRefs, [])
  w.hook = null; w.restart(); w.mode = 'off'; w.calls.length = 0
  for (const fields of [{ profileId: B }, { replyDestination: undefined }, { boardId: 'board' }, { stateless: true }, { clientThreadId: 'elsewhere' }]) {
    await assert.rejects(w.send(cid, fields), locked)
  }
  await assert.rejects(w.chat.fork({ clientThreadId: 'branch', conversationId: cid }), locked)
  await assert.rejects(w.chat.resume({ clientThreadId: DM, conversationId: cid, profileId: B }), locked)
  assert.deepEqual(w.calls, []); assert.equal(w.store.getConversation(DM).agent.profileId, A)
  assert.equal(w.store.getConversation('branch'), null)
  await w.chat.resume({ clientThreadId: DM, conversationId: cid }) // normal read-only room-open request
  assert.equal((await w.send(cid)).accepted, true)
  assert.equal(w.lastTurn().threadId, cid); assert.equal(w.lastTurn().additionalContext?.[DECISION_CONTEXT_KEY], undefined)
  assert.equal(w.store.listEvents(DM).events.filter(e => e.event === 'native.audience.reserved').length, 1)
  w.store.setRoomMembers({ clientThreadId: DM, members: [{ kind: 'user', role: 'owner' }] })
  w.calls.length = 0
  await assert.rejects(w.send(cid), { code: 'BOARD_SPEAKER_CHANGED' })
  await assert.rejects(w.chat.resume({ clientThreadId: DM, conversationId: cid }), locked)
  assert.deepEqual(w.calls, [])
})

test('unconfirmed reservation fails closed and a lost native reply leaves the committed lock in place', async t => {
  for (const fault of ['throw', 'silent', 'lost-reply']) {
    const w = fixture(t), append = w.store.appendEvent
    w.store.appendEvent = e => {
      if (e.event !== 'native.audience.reserved' || fault === 'lost-reply') return append(e)
      if (fault === 'throw') throw Error('synthetic disk failure')
      return {} // did not commit, despite a plausible response
    }
    w.hook = method => { if (method === 'turn/start' && fault === 'lost-reply') throw Error('synthetic transport reply lost') }
    await assert.rejects(w.ground(), fault === 'lost-reply' ? /reply lost/ : { code: 'CHAT_STORE_UNAVAILABLE' })
    assert.equal(w.calls.some(c => c.method === 'turn/start'), fault === 'lost-reply')
    const cid = w.store.getConversation(DM).conversationId
    w.hook = null; w.restart(); w.mode = 'off'
    assert.equal(w.store.getNativeAudience(cid), fault === 'lost-reply' ? A : null)
    if (fault === 'lost-reply') { w.calls.length = 0; await assert.rejects(w.send(cid, { profileId: B }), locked); assert.deepEqual(w.calls, []) }
  }
})

test('no private packet queued: normal profile transitions and forks survive restart, including advisory and late revoke', async t => {
  for (const mode of ['off', 'advisory', 'revoked']) {
    const w = fixture(t); w.mode = mode === 'revoked' ? 'on' : mode
    if (mode === 'revoked') w.hook = method => { if (method === 'thread/start') w.active = false }
    const { conversationId: cid } = await w.ground()
    assert.equal(w.lastTurn().additionalContext?.[DECISION_CONTEXT_KEY], undefined)
    w.hook = null; w.restart(); w.mode = 'off'
    assert.equal(w.store.getNativeAudience(cid), null)
    assert.equal((await w.send(cid, { profileId: B })).accepted, true)
    assert.equal(w.store.getConversation(DM).agent.profileId, B)
    assert.equal((await w.chat.fork({ conversationId: cid, clientThreadId: 'branch' })).accepted, true)
    assert.equal(w.calls.filter(c => c.method === 'thread/fork').length, 1)
  }
})

test('an in-flight native copy excludes first grounding on its source', async t => {
  const w = fixture(t), { conversationId: cid } = await w.send()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  w.hook = async method => { if (method === 'thread/fork') { entered.resolve(); await release.promise } }
  const fork = w.chat.fork({ conversationId: cid, clientThreadId: 'branch' })
  await entered.promise
  try { await assert.rejects(w.ground(cid), { code: 'RUN_IN_PROGRESS' }) } finally { release.resolve() }
  const branch = await fork
  assert.equal(branch.accepted, true); await w.ground(cid)
  assert.equal(w.store.getNativeAudience(branch.conversationId), null)
  assert.equal(w.store.getNativeAudience(cid), A)
})

test('changed stored Agent during preparation prevents native history restore and dispatch', async t => {
  const w = fixture(t), { conversationId: cid } = await w.ground()
  w.restart(); w.calls.length = 0
  w.chat.prepareDecisionContext = async () => {
    w.store.setRoomAgent({ clientThreadId: DM, profileId: B }); return null
  }
  await assert.rejects(w.send(cid), locked)
  assert.deepEqual(w.calls, [])
})

test('a grant expiring during durable reservation is checked again before native queue', async t => {
  const w = fixture(t), append = w.store.appendEvent
  w.store.appendEvent = record => {
    const saved = append(record)
    if (record.event === 'native.audience.reserved') w.active = false
    return saved
  }
  await w.ground()
  assert.equal(w.lastTurn().additionalContext?.[DECISION_CONTEXT_KEY], undefined)
})
