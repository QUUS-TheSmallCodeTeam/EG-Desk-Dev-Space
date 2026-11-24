// L1 c23 (U11): "your attached sources changed" (CTX-04, the changes-only preparation) is looked up under the account of the ROOM's own route, not the
// window's default sign-in. A room on an Agent profile's account tracks its sources under that account; it must hear about changes while the default
// account is signed out or is someone else, and must never see a default room's tracking. The ContextRuntime is real; its authority is what the chat
// runtime would resolve for the room's route. Mocks only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ContextRuntime } from './egdesk-context-runtime.mjs'

const WORK = 'codex-abcdef01'
const CAPTURE = { sourceId: 's1', kind: 'browser', sourceRef: { viewId: 'card-1', url: 'https://captured.example/page' }, captureScope: { type: 'page' } }
// the Browser card left the captured page: the source is now stale and not yet announced (what the changes-only message tells the person)
const changed = contexts => contexts.noteSourceEvent({ topic: 'browser.navigated', payload: { cardId: 'card-1', origin: 'https://elsewhere.example', path: '/' } })
function fixture({ defaultOwner = null, ready = () => true, duringCheck = null } = {}) {
  const state = { defaultOwner, workOwner: 'email:work@example.test', epoch: 3 }
  const authorities = {
    default: () => ({ engineId: 'codex', engineProfileId: 'codex-default', ownerKey: state.defaultOwner, epoch: 1 }),
    work: () => ({ engineId: 'codex', engineProfileId: WORK, ownerKey: state.workOwner, epoch: state.epoch }),
  }
  const contexts = new ContextRuntime({ store: { hasNativeTools: async () => { duringCheck?.(state); return true } }, reader: {}, getReadCapacity: () => 1, getOwnerKey: () => state.defaultOwner,
    getAuthority: hints => (hints?.engineProfileId === WORK ? authorities.work() : authorities.default()), schemaReady: authority => ready(authority) })
  contexts.runtime = { epoch: 0, threadToolManifestStatus: new Map([['conv-default', 'verified'], ['conv-work', 'verified']]), emit() {} }
  return { state, contexts, authorities }
}
const room = (conversationId, profile) => ({ conversationId, clientThreadId: `room-${conversationId}`, ...(profile ? { engineProfileId: profile } : {}) })

test('a profile room hears about changed sources while the default account is signed out; and while the default is another account', async () => {
  for (const defaultOwner of [null, 'email:someone-else@example.test']) {
    const { contexts, authorities } = fixture({ defaultOwner })
    contexts.trackBound('email:work@example.test', 'conv-work', [CAPTURE]); assert.equal(changed(contexts), 1)
    const prepared = await contexts.prepare(room('conv-work', WORK), authorities.work())
    assert.equal(prepared?.changesOnly, true, `default owner ${defaultOwner}`)
    assert.equal(prepared.ownerKey, 'email:work@example.test'); assert.equal(prepared.authority.engineProfileId, WORK); assert.equal(prepared.changes.length, 1)
  }
})

test('the default room is unchanged: tracked under the default account, found with it, silent when the default is signed out; profile and default tracking never mix', async () => {
  const { state, contexts, authorities } = fixture({ defaultOwner: 'email:a@example.test' })
  contexts.trackBound('email:a@example.test', 'conv-default', [CAPTURE]); assert.equal(changed(contexts), 1)
  const prepared = await contexts.prepare(room('conv-default'), authorities.default())
  assert.deepEqual([prepared?.changesOnly, prepared?.ownerKey], [true, 'email:a@example.test'])
  // the same conversation id asked as a profile room: another account's key, nothing tracked there
  assert.equal(await contexts.prepare(room('conv-default', WORK), authorities.work()), null)
  state.defaultOwner = null
  assert.equal(await contexts.prepare(room('conv-default'), authorities.default()), null, 'default signed out: as before')
})

test('the room\'s own account and slot decide: another account on the profile, or a profile slot that is not ready, gives nothing', async () => {
  let workReady = true
  const { state, contexts, authorities } = fixture({ ready: authority => authority?.engineProfileId !== WORK || workReady })
  contexts.trackBound('email:work@example.test', 'conv-work', [CAPTURE]); assert.equal(changed(contexts), 1)
  assert.equal((await contexts.prepare(room('conv-work', WORK), authorities.work()))?.changesOnly, true)
  workReady = false
  assert.equal(await contexts.prepare(room('conv-work', WORK), authorities.work()), null, 'that slot\'s tools are not ready')
  workReady = true
  state.workOwner = 'email:another-work@example.test'
  assert.equal(await contexts.prepare(room('conv-work', WORK), authorities.work()), null, 'another account signed in on the profile: not that room\'s tracking')
  state.workOwner = 'email:work@example.test'
  assert.equal((await contexts.prepare(room('conv-work', WORK), authorities.work()))?.changesOnly, true)
})

test('the room\'s account changing while the check is in flight is refused (ACCOUNT_CHANGED), never delivered under the new account', async () => {
  const { contexts, authorities } = fixture({ duringCheck: state => { state.epoch += 1 } }) // the profile's connection is replaced during the check
  contexts.trackBound('email:work@example.test', 'conv-work', [CAPTURE]); assert.equal(changed(contexts), 1)
  await assert.rejects(contexts.prepare(room('conv-work', WORK), authorities.work()), { code: 'ACCOUNT_CHANGED' })
})
