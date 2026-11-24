// c28: the deletion proofs (helper/egdesk-real-engine-delete.mjs): validators and the judgement from facts. The end-to-end cases on the fake app-server are in
// egdesk-real-engine-check.test.mjs; the real run is Main's.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OTHER_ROOM, SEED_LIMITS, checkDeleted, validateDeletedExpect, validateSeededWrites } from './egdesk-real-engine-delete.mjs'
import { validateEngineScript } from './egdesk-real-engine-script.mjs'
import { FORGETTER_NAMES, registerConversationForgetters } from './egdesk-conversation-forgetters.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const script = () => JSON.parse(fs.readFileSync(path.join(here, '..', 'scripts', 'real-engine', 'scripts', 'real-engine-delete-v1.json'), 'utf8'))

test('the committed script validates; seeds and expectations are checked against each other', () => {
  assert.deepEqual(validateEngineScript(script()), { ok: true, errors: [] })
  const conv = script().conversations[0], expect = conv.turns[2].expect.deleted
  assert.deepEqual(validateDeletedExpect(expect, conv, { action: 'delete' }), [])
  assert.match(validateDeletedExpect(expect, conv, { say: 'x' }).join(), /only on an action: delete turn/)
  assert.match(validateDeletedExpect({ storeRowsGone: false }, conv, { action: 'delete' }).join(), /storeRowsGone: true/)
  assert.match(validateDeletedExpect({ nope: true }, conv, { action: 'delete' }).join(), /unknown key/); assert.match(validateDeletedExpect({}, conv, { action: 'delete' }).join(), /at least one/)
  const bare = { seededWrites: { pages: [{ id: 'p', title: 't', body: 'b', scope: 'personal' }] } }
  const needs = key => validateDeletedExpect({ [key]: true }, bare, { action: 'delete' }).join()
  assert.match(needs('conversationMemoryGone'), /scope: conversation/); assert.match(needs('pendingReadingsWithdrawn'), /pending reading with from: conversation/); assert.match(needs('pointerMarked'), /pointer page/)
  assert.equal(needs('otherMemoryKept'), ''); assert.match(validateDeletedExpect({ otherMemoryKept: true }, {}, { action: 'delete' }).join(), /page of another scope/)
  const errors = validateSeededWrites
  assert.match(errors({}).join(), /an object/); assert.match(errors({ nope: 1 }).join(), /unknown key/)
  assert.match(errors({ pages: [{ id: 'a b', title: 't', body: 'b', scope: 'conversation' }] }).join(), /id/); assert.match(errors({ pages: [{ id: 'a', title: 't', body: 'b', scope: 'room' }] }).join(), /scope/)
  assert.match(errors({ pages: [{ id: 'a', title: 't', scope: 'conversation' }] }).join(), /body/); assert.match(errors({ pages: [{ id: 'a', title: 't', body: 'b', scope: 'conversation', pointer: true }] }).join(), /no body/)
  assert.match(errors({ pages: [{ id: 'a', title: 't', body: 'b', scope: 'conversation' }, { id: 'a', title: 't', body: 'b', scope: 'other' }] }).join(), /unique/)
  assert.match(errors({ pages: [{ id: 'a', title: 't', body: 'b', scope: 'conversation' }], readings: [{ page: 'zzz', state: 'pending' }] }).join(), /seeded page/)
  assert.match(errors({ pages: [{ id: 'a', title: 't', body: 'b', scope: 'conversation' }], readings: [{ page: 'a', state: 'accepted', from: 'conversation' }] }).join(), /only a pending reading/)
  assert.match(errors({ pages: Array.from({ length: SEED_LIMITS.pages + 1 }, (_, i) => ({ id: `p${i}`, title: 't', body: 'b', scope: 'other' })) }).join(), /at most/)
})

const GOOD = () => ({
  seeded: { pages: [{ id: 'c', scope: 'conversation' }, { id: 'o', scope: 'other' }, { id: 'p', scope: 'personal' }, { id: 'ptr', scope: 'personal', pointer: true }],
    readings: [{ page: 'p', state: 'pending', from: 'conversation' }, { page: 'o', state: 'pending', from: 'other' }, { page: 'p', state: 'accepted' }] },
  route: { status: 200, body: { accepted: true, history: { deleted: true, rows: 9 }, engineHistory: [{ state: 'deleted' }], modules: { pending_readings: 1 } } },
  before: { messages: 4 }, store: { conversation: false, messages: 0, listed: false, localIds: 0 }, resume: { failed: true, error: 'no rollout found' },
  writesBefore: { pendingFromConversation: 1, pendingFromOther: 1, conversationPages: ['c'], pages: {}, readings: [] },
  writesAfter: { pendingFromConversation: 0, pendingFromOther: 1, conversationPages: [], pages: { o: { scope: `dm:${OTHER_ROOM}`, hasBody: true }, p: { scope: 'personal', hasBody: true }, ptr: { scope: 'personal', hasBody: false, sourceDeleted: true } },
    readings: [{ page: 'p', state: 'accepted', from: null }, { page: 'o', state: 'pending', from: OTHER_ROOM }] },
})
const ALL = { routeAccepted: true, storeRowsGone: true, engineGone: true, pendingReadingsWithdrawn: true, conversationMemoryGone: true, otherMemoryKept: true, pointerMarked: true }
const failing = (mutate, expect = ALL) => { const d = GOOD(); mutate(d); return checkDeleted(expect, { deletion: d }).filter(c => !c.ok).map(c => c.check.replace('deleted.', '')) }

test('checkDeleted: a clean deletion passes every proof; each proof fails by itself when its fact is wrong', () => {
  assert.deepEqual(checkDeleted(ALL, { deletion: GOOD() }).map(c => c.ok), Array(7).fill(true))
  assert.deepEqual(failing(d => { d.route.status = 500 }), ['routeAccepted'])
  assert.deepEqual(failing(d => { d.store.messages = 2 }), ['storeRowsGone']); assert.deepEqual(failing(d => { d.store.listed = true }), ['storeRowsGone']); assert.deepEqual(failing(d => { d.route.body.history.rows = 2 }), ['storeRowsGone'])
  assert.deepEqual(failing(d => { d.before.messages = 0 }), ['storeRowsGone'], 'a conversation that had no messages proves nothing')
  assert.deepEqual(failing(d => { d.resume = { failed: false } }), ['engineGone']); assert.deepEqual(failing(d => { d.route.body.engineHistory = [{ state: 'remains', reason: 'failed' }] }), ['engineGone']); assert.deepEqual(failing(d => { d.resume = null }), ['engineGone'])
  assert.deepEqual(failing(d => { d.writesAfter.pendingFromConversation = 1 }), ['pendingReadingsWithdrawn']); assert.deepEqual(failing(d => { d.route.body.modules.pending_readings = 0 }), ['pendingReadingsWithdrawn'])
  assert.deepEqual(failing(d => { d.writesAfter.conversationPages = ['c'] }), ['conversationMemoryGone'])
  assert.deepEqual(failing(d => { delete d.writesAfter.pages.o }), ['otherMemoryKept']); assert.deepEqual(failing(d => { d.writesAfter.pendingFromOther = 0 }), ['otherMemoryKept']); assert.deepEqual(failing(d => { d.writesAfter.readings = d.writesAfter.readings.filter(r => r.state !== 'accepted') }), ['otherMemoryKept'])
  assert.deepEqual(failing(d => { d.writesAfter.pages.ptr.sourceDeleted = false }), ['pointerMarked']); assert.deepEqual(failing(d => { d.writesAfter.pages.ptr.hasBody = true }), ['pointerMarked']); assert.deepEqual(failing(d => { delete d.writesAfter.pages.ptr }), ['pointerMarked'])
  assert.deepEqual(checkDeleted({ storeRowsGone: true }, {}).map(c => [c.check, c.ok]), [['deleted.storeRowsGone', false]], 'no record, no pass')
})

test('the forgetters the bridge registers come from one module: registered by name, each part optional', () => {
  const seen = []
  const chat = { onForgetConversation: (name, fn) => seen.push([name, fn]) }
  registerConversationForgetters(chat, {}); assert.deepEqual(seen, [])
  const calls = []
  registerConversationForgetters(chat, { briefingBindings: { forgetConversation: id => { calls.push(['b', id]); return 1 } }, runRequesters: { set: (keys, v) => { calls.push(['r', keys, v]); return 'cleared' } }, workPlacement: { forget: keys => { calls.push(['w', keys]); return 2 } },
    turnMemoryConfig: { getAdapter: () => ({ withdrawPendingFrom: keys => { calls.push(['pending', keys]); return 3 }, forgetConversation: arg => { calls.push(['memory', arg]); return { pages: 1, readings: 2, pointers: 3 } } }) } })
  assert.deepEqual(seen.map(([n]) => n), [...FORGETTER_NAMES])
  const ctx = { clientThreadId: 'ui', conversationIds: ['n1', 'n2'], messageRefs: ['chat-message:1'] }, out = Object.fromEntries(seen.map(([n, fn]) => [n, fn(ctx)]))
  assert.deepEqual(out, { briefing_bindings: 2, run_requesters: 1, work_placement: 2, pending_readings: 3, conversation_memory: 6 })
  assert.deepEqual(calls.find(c => c[0] === 'r'), ['r', ['ui', 'n1', 'n2'], null]); assert.deepEqual(calls.find(c => c[0] === 'memory'), ['memory', { clientThreadId: 'ui', messageRefs: ['chat-message:1'] }])
  // the bridge registers them through this module, not by hand
  const bridge = fs.readFileSync(path.join(here, 'codex-bridge-server.mjs'), 'utf8')
  assert.equal(bridge.split('registerConversationForgetters(chat, { briefingBindings, runRequesters, workPlacement, turnMemoryConfig })').length, 2); assert.equal(bridge.includes("chat.onForgetConversation('"), false)
})
