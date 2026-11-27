// L1 c18, owner rule U11: profile, subscription account, folder and screen combine freely and independently. Each test switches ONE axis
// mid-session and asserts the others stay. The window used to treat its default Codex sign-in as the account of every room: a room that
// runs on another Codex engine profile recorded the default's account, was detached and held as "another account" when the default
// sign-in changed, and was "not ready" when only the default was signed out. Contract §14.1: a Run keeps its engineProfileId; changing the
// default does not move it. The helper stays authoritative for ownership; these are the window's fences.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import * as Chat from '../overlay/resources/EGDeskChatState.sys.mjs'

const signedIn = (email, accountId = null) => ({ isLoggedIn: true, authMode: 'chatgpt', accountEmail: email, ...(accountId ? { accountId } : {}) })
const engines = ({ slotAccount = 'b@example.test', slotSignedIn = true } = {}) => [{ id: 'codex', status: 'ready', profiles: [
  { id: 'codex-default', active: true, owned: false, auth: { status: 'signedIn', method: 'chatgpt', account: 'a@example.test' } },
  { id: 'codex-p1b2c3d4e5', active: false, owned: true, auth: slotSignedIn ? { status: 'signedIn', method: 'chatgpt', account: slotAccount } : { status: 'signedOut', method: null, account: null } }] }]
const SLOT = 'codex-p1b2c3d4e5'
const room = (id, engineProfileId, conversationId) => ({ id, type: 'dm', engineId: 'codex', engineProfileId, conversationId: null, clientBindingId: null, bindingAccountKey: null, bindingState: 'fresh', retainedNativeBinding: null, messages: [{ id: 'm', role: 'user', content: 'x' }], _cid: conversationId })
// a run finishes in each room: the room's binding as the window records it (nativeBindingForRun after run.started)
function bound(thread, context) {
  const run = { conversationId: thread._cid, accountKey: Chat.codexAccountKey(context.authStatus), engineProfileId: thread.engineProfileId }
  return { ...thread, conversationId: thread._cid, ...Chat.nativeBindingForRun({ ...thread, conversationId: thread._cid }, run, context) }
}
// the window's update(patch) with a new default sign-in: resetThreadConversations detaches every Codex room, then every room is reconciled
function defaultSignInChanged(threads, context, authStatus) {
  const next = { ...context, authStatus }
  return { context: next, threads: threads.map(t => Chat.reconcileNativeThread(Chat.detachNativeThread(t, Chat.codexAccountKey(context.authStatus), 'nonce'), authStatus, next)) }
}

test('account (the default sign-in) switches; a room on another engine profile keeps its own account, binding and readiness', () => {
  let context = { authStatus: signedIn('a@example.test'), engines: engines(), connected: true }
  const onDefault = bound(room('r-default', 'codex-default', 'conv-d'), context), onSlot = bound(room('r-slot', SLOT, 'conv-s'), context)
  assert.equal(onDefault.bindingAccountKey, Chat.codexAccountKey(context.authStatus))
  assert.equal(onSlot.bindingAccountKey, `codex:slot:${SLOT}:b@example.test`, 'the account that ran it, not the default sign-in')
  for (const t of [onDefault, onSlot]) assert.equal(Chat.canResumeNativeThread(t, context.authStatus, context), true, t.id)
  const after = defaultSignInChanged([onDefault, onSlot], context, signedIn('c@example.test'))
  const [d, s] = after.threads
  assert.equal(Chat.nativeBindingHeld(d), true, 'the default room\'s own account changed: held (unchanged rule)')
  assert.equal(d.retainedNativeBinding.reason, 'identity-mismatch')
  assert.equal(Chat.nativeBindingHeld(s), false, 'the other profile\'s room is not held')
  assert.deepEqual([s.conversationId, s.bindingState, s.bindingAccountKey], ['conv-s', 'verified', `codex:slot:${SLOT}:b@example.test`])
  assert.equal(Chat.canResumeNativeThread(s, after.context.authStatus, after.context), true)
  assert.equal(Chat.chatThreadReadiness(s, after.context).ready, true)
  assert.equal(s.engineProfileId, SLOT, 'its engine profile stays')
})

test('account of the other engine profile switches; that room is held, the default room is untouched', () => {
  const context = { authStatus: signedIn('a@example.test'), engines: engines(), connected: true }
  const onDefault = bound(room('r-default', 'codex-default', 'conv-d'), context), onSlot = bound(room('r-slot', SLOT, 'conv-s'), context)
  const next = { ...context, engines: engines({ slotAccount: 'd@example.test' }) }
  const [d, s] = [onDefault, onSlot].map(t => Chat.reconcileNativeThread(t, next.authStatus, next))
  assert.equal(Chat.canResumeNativeThread(d, next.authStatus, next), true)
  assert.equal(Chat.canResumeNativeThread(s, next.authStatus, next), false, 'a different account now signs in to that profile')
  // the window's reset on the profile's account change detaches it; the reconcile then holds it as another account
  const held = Chat.reconcileNativeThread(Chat.detachNativeThread(s, null, 'nonce'), next.authStatus, next)
  assert.deepEqual([Chat.nativeBindingHeld(held), held.retainedNativeBinding.reason], [true, 'identity-mismatch'])
})

test('the default sign-in is signed out; the room on the other profile stays ready and resumable, the default room is not', () => {
  const context = { authStatus: signedIn('a@example.test'), engines: engines(), connected: true }
  const onDefault = bound(room('r-default', 'codex-default', 'conv-d'), context), onSlot = bound(room('r-slot', SLOT, 'conv-s'), context)
  const out = { ...context, authStatus: { isLoggedIn: false } }
  assert.equal(Chat.chatThreadReadiness(onSlot, out).ready, true)
  assert.equal(Chat.canResumeNativeThread(onSlot, out.authStatus, out), true)
  assert.equal(Chat.chatThreadReadiness(onDefault, out).ready, false)
  assert.equal(Chat.canResumeNativeThread(onDefault, out.authStatus, out), false)
  // and the other way round: that profile signed out -> its room not ready (the same copy as today), the default room ready
  const slotOut = { ...context, engines: engines({ slotSignedIn: false }) }
  assert.deepEqual(Chat.chatThreadReadiness(onSlot, slotOut), { engineId: 'codex', ready: false, reason: 'Codex 연결 후 전송할 수 있습니다' })
  assert.equal(Chat.chatThreadReadiness(onDefault, slotOut).ready, true)
})

test('a profile the window does not know keeps today\'s default-account rule; the room key never borrows the default for a known profile', () => {
  const context = { authStatus: signedIn('a@example.test'), engines: [{ id: 'codex', profiles: [] }], connected: true }
  const unknown = bound(room('r-u', 'codex-pzzzzzzzz', 'conv-u'), context)
  assert.equal(unknown.bindingAccountKey, Chat.codexAccountKey(context.authStatus))
  assert.equal(Chat.codexRoomAccountKey(unknown, context.authStatus, context), Chat.codexAccountKey(context.authStatus))
  const known = { authStatus: signedIn('a@example.test'), engines: engines({ slotSignedIn: false }), connected: true }
  const r = bound(room('r-s', SLOT, 'conv-s'), known)
  assert.deepEqual([r.bindingAccountKey, r.bindingState], [null, 'live-unverified'], 'unverified, never the default account')
  assert.equal(Chat.codexSlotAccountKey('codex-default', known), null)
  // a row that still names an account but is not signed in gives no key (only a signed-in profile vouches for its account)
  const stale = { engines: [{ id: 'codex', profiles: [{ id: SLOT, auth: { status: 'signedOut', account: 'b@example.test' } }] }] }
  assert.equal(Chat.codexSlotAccountKey(SLOT, stale), null)
})

test('folder and screen are not part of a room\'s account: the same room in another folder or another window keeps its binding and readiness', () => {
  const context = { authStatus: signedIn('a@example.test'), engines: engines(), connected: true }
  const onSlot = bound(room('r-slot', SLOT, 'conv-s'), context)
  const elsewhere = { ...onSlot, projectDraft: { folder: '/synthetic/other' }, cwd: '/synthetic/other' }
  assert.equal(Chat.canResumeNativeThread(elsewhere, context.authStatus, context), true)
  const otherWindow = { ...structuredClone(context), activeThreadId: 'r-slot', hudOpen: true } // a second window's own state, same bridge rows
  assert.equal(Chat.canResumeNativeThread(onSlot, otherWindow.authStatus, otherWindow), true)
  assert.equal(Chat.chatThreadReadiness(onSlot, otherWindow).ready, true)
})

test('the window passes its engine rows to every binding update (run binding, auth/engine updates, snapshot and history restore)', () => {
  const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
  assert.match(surface, /ChatState\.nativeBindingForRun\(current, run, state\.codex\)/)
  assert.match(surface, /state\.codex\.threads = state\.codex\.threads\.map\(thread => ChatState\.reconcileNativeThread\(thread, state\.codex\.authStatus, state\.codex\)\);/)
  assert.match(surface, /chatBindingNonce\(\)\), state\.codex\.authStatus, state\.codex\)\);\n        state\.codex\.activeThreadId = snapshot\.chat\.activeThreadId;/)
  assert.match(surface, /retainedNativeBinding: detail\.retainedNativeBinding \|\| null,\n      \}, null, chatBindingNonce\(\)\), state\.codex\.authStatus, state\.codex\);/)
})
