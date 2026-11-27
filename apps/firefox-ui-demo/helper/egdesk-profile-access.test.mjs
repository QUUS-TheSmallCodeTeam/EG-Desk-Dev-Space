// L1 c25 (owner decision U11; flag EGDESK_ROOM_ACCOUNT=on): the last auth/quota/permission rejection of a turn on an Agent profile's own app-server is kept
// per profile as status data ({kind, cause, at}; no copy). The shared tracker (default account) is the real one and stays independent: a profile's failure
// never reaches the default account's, nor another profile's; another account signed in on the profile does not inherit it; a completed turn clears it;
// flag off, nothing is recorded and nothing is added to the status. The trackers are the real SUB-14 trackers; the app-server side is a fake. Mocks only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createAccountAccessTracker } from './codex-bridge-http.mjs'
import { createProfileAccessFailures } from './egdesk-profile-access.mjs'
import { describeCodexEngine } from './codex-engine-adapter.mjs'

const WORK = 'codex-abcdef01', OTHER = 'codex-0badc0de'
const signedIn = email => ({ isLoggedIn: true, accountEmail: email, accountId: null })
const QUOTA = { method: 'turn/completed', params: { turn: { id: 't1', status: 'failed', error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } } } }
const OK = { method: 'turn/completed', params: { turn: { id: 't2', status: 'completed' } } }

function world({ flag = true } = {}) {
  const w = { flag, clock: 5_000_000, auth: { [WORK]: signedIn('work@example.test'), [OTHER]: signedIn('other@example.test') } }
  w.access = createProfileAccessFailures({ enabled: () => w.flag, authOf: id => w.auth[id] ?? null, now: () => w.clock })
  // the shared tracker, as the bridge builds it for the default account
  w.shared = { isLoggedIn: true, accountEmail: 'a@example.test', accountId: null, accessFailure: null }
  w.sharedTracker = createAccountAccessTracker({ auth: () => w.shared, update: patch => Object.assign(w.shared, patch), now: () => w.clock })
  return w
}

test('a profile server\'s rejection is recorded for that profile only: not the default account, not another profile; a completed turn clears it', () => {
  const w = world()
  assert.equal(w.access.notify(WORK, QUOTA), true)
  assert.deepEqual(w.access.failureOf(WORK), { kind: 'quota', cause: 'usageLimitExceeded', at: 5_000_000 })
  assert.equal(w.access.failureOf(OTHER), null); assert.equal(w.shared.accessFailure, null, 'the default account\'s failure is not touched')
  w.sharedTracker.notify({ method: 'error', params: { error: { message: 'Unauthorized', codexErrorInfo: 'unauthorized' } } })
  assert.equal(w.shared.accessFailure.kind, 'auth'); assert.equal(w.access.failureOf(WORK).kind, 'quota', 'and the default\'s failure does not reach the profile')
  w.clock += 10
  assert.equal(w.access.notify(WORK, { method: 'error', params: { error: { message: 'Permission denied by policy' } } }), true)
  assert.equal(w.access.failureOf(WORK).kind, 'permission')
  w.access.notify(WORK, OK); assert.equal(w.access.failureOf(WORK), null, 'a completed turn clears the profile\'s failure')
  assert.equal(w.shared.accessFailure.kind, 'auth', 'and not the default\'s')
  assert.equal(Object.keys(w.access.failureOf(WORK) ?? { kind: 1 }).includes('identity'), false, 'the status carries no account identity')
})

test('an account change on the profile: another account does not inherit the failure; signed out shows none; a turn/start rejection is recorded under the requesting account', async () => {
  const w = world()
  w.access.notify(WORK, QUOTA); assert.ok(w.access.failureOf(WORK))
  w.auth[WORK] = signedIn('z@example.test'); assert.equal(w.access.failureOf(WORK), null, 'another account signed in on the profile')
  w.auth[WORK] = { isLoggedIn: false }; assert.equal(w.access.failureOf(WORK), null, 'signed out')
  w.auth[WORK] = signedIn('work@example.test')
  w.access.notify(WORK, OK)
  const rejection = Object.assign(new Error('Unauthorized'), { code: -32000 })
  await assert.rejects(w.access.request(WORK, 'turn/start', () => Promise.reject(rejection)), error => error === rejection, 'the error passes through unchanged')
  assert.equal(w.access.failureOf(WORK)?.kind, 'auth')
  // another account signs in while the request is in flight: the rejection is not recorded for it
  w.access.notify(WORK, OK)
  await assert.rejects(w.access.request(WORK, 'turn/start', () => { w.auth[WORK] = signedIn('z@example.test'); return Promise.reject(rejection) }), error => error === rejection)
  assert.equal(w.access.failureOf(WORK), null)
  assert.equal(await w.access.request(WORK, 'thread/list', async () => 'passed'), 'passed', 'other methods pass straight through')
})

test('flag off: nothing is recorded, nothing is added; requests pass through', async () => {
  const w = world({ flag: false })
  assert.equal(w.access.notify(WORK, QUOTA), false); assert.equal(w.access.failureOf(WORK), null)
  const rejection = Object.assign(new Error('Unauthorized'), { code: -32000 })
  await assert.rejects(w.access.request(WORK, 'turn/start', () => Promise.reject(rejection)), error => error === rejection)
  w.flag = true; assert.equal(w.access.failureOf(WORK), null, 'nothing was recorded while off')
  assert.throws(() => createProfileAccessFailures({}), TypeError)
})

test('the engine status row carries the failure only when given (flag on), as an allowlisted {kind, cause, at}', () => {
  const row = extra => describeCodexEngine({ ready: true, auth: { isLoggedIn: true }, extraProfiles: [{ id: WORK, label: 'Work', runnable: true, auth: signedIn('work@example.test'), ...extra }] }).profiles.find(p => p.id === WORK)
  assert.equal(Object.hasOwn(row({}), 'accessFailure'), false, 'default output unchanged')
  assert.deepEqual(row({ accessFailure: { kind: 'quota', cause: 'usageLimitExceeded', at: 7, identity: 'email:secret@x', extra: 'x' } }).accessFailure, { kind: 'quota', cause: 'usageLimitExceeded', at: 7 })
  assert.equal(Object.hasOwn(row({ accessFailure: { kind: 'bogus', at: 1 } }), 'accessFailure'), false)
})

test('the bridge records profile notifications and turn/start rejections per profile and puts the failure on the profile row, behind the flag', () => {
  const server = readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(server, /const profileAccess = createProfileAccessFailures\(\{ enabled: \(\) => process\.env\.EGDESK_ROOM_ACCOUNT === 'on', authOf: id => codexProfileServers\.snapshot\(id\)\?\.auth \?\? null \}\)/)
  assert.match(server, /onNotification: \(id, message\) => \{ profileAccess\.notify\(id, message\); if \(!profileReaders\.handleNotification\(id, message\)\) codexEngine\.notify\(message, id\) \},/)
  assert.match(server, /profiles: \{ \.\.\.codexProfileServers, request: \(id, method, params\) => profileAccess\.request\(id, method, \(\) => codexProfileServers\.request\(id, method, params\)\) \},/)
  assert.match(server, /\.\.\.\(failure \? \{ accessFailure: failure \} : \{\}\)/)
})
