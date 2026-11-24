// L1 c24 (owner decision U11): a Browser grant is bound to the account of the slot running the room. A room on an Agent profile binds, dispatches and keeps
// its grant under THAT profile's account; the default sign-in being signed out, someone else or changing does not touch it, and another account signing in on
// the profile ends it. The default room (and every room, flag off) still follows the default sign-in. Real service and transport; the UI side is a fake that
// answers bind and observe. Mocks only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createBrowserToolService } from './egdesk-browser-tool-runtime.mjs'
import { BrowserToolTransport } from './codex-browser-tool-transport.mjs'
import { isProfileSlot } from './egdesk-slot-readiness.mjs'

const WORK = 'codex-abcdef01', MAIN = 'codex-default'
const source = { id: 'selected-browser-1', kind: 'browser', selectedByUser: true, browserToolPermission: 'observe', browserToolSelection: { token: 'grant-1', threadId: 'thread-a' },
  browserToolIdentity: { cardEpoch: 'card-epoch-1', userContextId: 0, engineAccountKey: 'codex:chatgpt:work@example.test', authorityEpoch: 0 },
  sourceRef: { viewId: 'browser-1', profileId: 'firefox-default', accountId: 'fixture-account', uri: 'https://example.test/local' } }
const snap = { cardId: 'browser-1', documentId: 'd1', revision: 3, coordinateSpace: 'browser-viewport-local', viewport: { width: 720, height: 480, devicePixelRatio: 1 }, url: 'https://example.test/local', title: 'T', text: ['x'], interactiveElements: [] }
const sendToUi = async request => request.kind === 'bind'
  ? { requestId: request.requestId, status: 'bound', binding: { cardId: 'browser-1', cardEpoch: 'card-epoch-1', profileId: 'firefox-default', accountId: 'fixture-account', userContextId: 0, url: 'https://example.test/local', engineAccountKey: 'codex:chatgpt:work@example.test', authorityEpoch: 0 } }
  : { requestId: request.requestId, status: 'observed', snapshot: snap }

// the bridge's rule, with a settable world: flag, the default sign-in, each profile's sign-in
function world({ flag = true, defaultOwner = null } = {}) {
  const w = { flag, defaultOwner, profiles: { [WORK]: 'email:work@example.test' } }
  w.ownerKeyFor = id => (w.flag && isProfileSlot(id) ? (w.profiles[id] ?? null) : w.defaultOwner)
  w.service = createBrowserToolService({ sendToUi, getOwnerKey: () => w.defaultOwner, ownerKeyFor: w.ownerKeyFor })
  return w
}
const run = (id = 'a1') => ({ answerId: id, runId: id, clientThreadId: 'thread-a', status: 'inProgress' })
const observe = (w, r) => w.service.dispatch(r, { tool: 'egdesk_browser_observe', arguments: { cardId: 'browser-1' }, callId: `c-${r.runId}` })

test('a profile room binds under the profile\'s account while the default is signed out and while the default is someone else; it observes as that account', async () => {
  for (const defaultOwner of [null, 'email:someone-else@example.test']) {
    const w = world({ defaultOwner }), r = run()
    if (defaultOwner === null) assert.throws(() => w.service.prepare({ selectedSources: [source] }), { code: 'BROWSER_OWNER_REQUIRED' }, 'a call with no route still needs the default')
    const prepared = w.service.prepare({ selectedSources: [source], engineProfileId: WORK })
    assert.equal(prepared.ownerKey, 'email:work@example.test'); assert.equal(prepared.engineProfileId, WORK)
    await w.service.bind(r, prepared)
    assert.equal((await observe(w, r)).snapshot.documentId, 'd1', `default ${defaultOwner}`)
  }
})

test('the default account changing while the profile room is bound does not end its grant; another account signing in on the profile does', async () => {
  const w = world({ defaultOwner: 'email:a@example.test' }), r = run()
  await w.service.bind(r, w.service.prepare({ selectedSources: [source], engineProfileId: WORK }))
  w.defaultOwner = 'email:c@example.test'; assert.ok(await observe(w, r), 'default changed: the room keeps working')
  w.defaultOwner = null; assert.ok(await observe(w, { ...r }), 'default signed out: still')
  w.profiles[WORK] = 'email:z@example.test'
  await assert.rejects(observe(w, r), { code: 'BROWSER_RUN_ENDED' }, 'another account signed in on the profile')
  w.profiles[WORK] = null
  await assert.rejects(observe(w, r), { code: 'BROWSER_RUN_ENDED' }, 'the profile signed out')
})

test('an account change in the middle of binding is refused: prepared under one account, the profile switches before bind', async () => {
  const w = world({ defaultOwner: 'email:a@example.test' })
  const prepared = w.service.prepare({ selectedSources: [source], engineProfileId: WORK })
  w.profiles[WORK] = 'email:z@example.test'
  await assert.rejects(w.service.bind(run(), prepared), { code: 'BROWSER_BINDING_FORBIDDEN' })
})

test('the default room follows the default sign-in exactly as before (a profile\'s account does not matter to it), and flag off, a profile room follows the default too', async () => {
  const w = world({ defaultOwner: 'email:a@example.test' }), r = run('d1')
  await w.service.bind(r, w.service.prepare({ selectedSources: [source], engineProfileId: MAIN }))
  w.profiles[WORK] = 'email:z@example.test'; assert.ok(await observe(w, r), 'another profile changed: no effect')
  w.defaultOwner = 'email:c@example.test'; await assert.rejects(observe(w, r), { code: 'BROWSER_RUN_ENDED' })
  const off = world({ flag: false, defaultOwner: 'email:a@example.test' }), r2 = run('o1')
  const prepared = off.service.prepare({ selectedSources: [source], engineProfileId: WORK }); assert.equal(prepared.ownerKey, 'email:a@example.test')
  await off.service.bind(r2, prepared); assert.ok(await observe(off, r2))
  off.profiles[WORK] = 'email:z@example.test'; assert.ok(await observe(off, r2), 'flag off: the profile account is not consulted')
  off.defaultOwner = null; await assert.rejects(observe(off, r2), { code: 'BROWSER_RUN_ENDED' })
})

test('the UI transport binds each run under its slot\'s account: a profile run needs the profile\'s account (default signed out is fine), the default run needs the default', () => {
  const w = world({ defaultOwner: null })
  const transport = new BrowserToolTransport({ getOwnerKey: () => w.defaultOwner, ownerKeyFor: w.ownerKeyFor })
  transport.clients.set('t1', { closed: false })
  transport.bindRun('run-work', 'thread-a', 't1', WORK)
  assert.equal(transport.runs.get('run-work').ownerKey, 'email:work@example.test'); assert.equal(transport.runs.get('run-work').engineProfileId, WORK)
  assert.throws(() => transport.bindRun('run-default', 'thread-a', 't1', MAIN), { code: 'BROWSER_UI_UNAVAILABLE' }, 'the default room with the default signed out')
  w.defaultOwner = 'email:a@example.test'; transport.bindRun('run-default', 'thread-a', 't1'); assert.equal(transport.runs.get('run-default').ownerKey, 'email:a@example.test')
})

test('the bridge gives the service, transport and provider the slot-aware owner rule behind the flag; the provider hands the room\'s route to the service', () => {
  const server = readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(server, /const browserOwnerKeyFor = id => \(process\.env\.EGDESK_ROOM_ACCOUNT === 'on' && isProfileSlot\(id\) \? codexEngine\.ownerKey\(id\) : publicAuthIdentityKey\(authState\)\)/)
  assert.match(server, /new BrowserToolTransport\(\{ getOwnerKey: \(\) => publicAuthIdentityKey\(authState\), ownerKeyFor: browserOwnerKeyFor \}\)/)
  assert.match(server, /createCodexBrowserToolProvider\(\{ transport: browserTransport, getOwnerKey: \(\) => publicAuthIdentityKey\(authState\), ownerKeyFor: browserOwnerKeyFor,/)
  const provider = readFileSync(new URL('./codex-browser-tool-provider.mjs', import.meta.url), 'utf8')
  assert.match(provider, /service\.prepare\(\{ selectedSources, ownerKey: ownerKeyFor\(route\?\.engineProfileId\), engineProfileId: route\?\.engineProfileId \}\)/)
  assert.equal((provider.match(/transport\.bindRun\(run\.runId, run\.clientThreadId, prepared\.transportId, prepared\.selection\?\.engineProfileId\)/g) || []).length, 2)
})
