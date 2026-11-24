// L1 c25 (U11, owner decision "a room's checks use the ROOM's account"), window side of the Browser card identity. The bridge side (c24) binds a Browser grant to
// the account of the slot running the room; the window compared the card's identity against the DEFAULT sign-in, so a room on an Agent profile could not
// select, bind or keep a card while the default was signed out or someone else. With the room-account flag the window uses the room's own account for the
// selection check, the grant check, the bind and every later comparison; default rooms and flag off compare as before. The window functions are the real
// ones (extracted from eg-desk-surface.uc.js); the card is a stub whose toolBinding(roomKey) answers like the real one. Mocks only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
import * as BrowserGrant from '../overlay/resources/EGDeskBrowserGrant.sys.mjs'

const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const decl = name => { const a = surface.indexOf(`  function ${name}(`); assert.ok(a >= 0, name); return surface.slice(a, surface.indexOf('\n  }\n', a) + 4) }
const line = prefix => { const a = surface.indexOf(prefix); assert.ok(a >= 0, prefix); return surface.slice(a, surface.indexOf('\n', a)) }
const SLOT = 'codex-p1b2c3d4e5'
let nonce = 0
const signedIn = email => ({ isLoggedIn: true, authMode: 'chatgpt', accountEmail: email })
const engines = (slotAccount = 'b@example.test') => [{ id: 'codex', status: 'ready', profiles: [
  { id: 'codex-default', active: true, auth: { status: 'signedIn', account: 'a@example.test' } },
  { id: SLOT, auth: slotAccount ? { status: 'signedIn', account: slotAccount } : { status: 'signedOut', account: null } }] }]
const SLOT_KEY = account => `codex:slot:${SLOT}:${account}`

function world({ flag = 'on', defaultAuth = signedIn('a@example.test') } = {}) {
  const room = (id, slot) => ({ id, type: 'dm', title: id, engineId: 'codex', engineProfileId: slot ? SLOT : 'codex-default', conversationId: `conv-${id}`, clientBindingId: id,
    bindingState: 'verified', bindingAccountKey: slot ? SLOT_KEY('b@example.test') : ChatState.codexAccountKey(defaultAuth), retainedNativeBinding: null, messages: [], inputSources: [] })
  const codex = { threads: [room('room-w', true), room('room-d', false)], engines: engines(), authStatus: defaultAuth, codexAccountKey: ChatState.codexAccountKey(defaultAuth), connected: true,
    activeThreadId: 'room-w', roomAccountMode: flag }
  const state = { codex }
  const card = { id: 'card-1', isConnected: true, classList: { contains: () => true }, _browserControls: { toolBinding: roomKey => ({ cardId: 'card-1', cardEpoch: 'epoch-1', profileId: 'p1', accountId: 'acct', userContextId: 0,
    engineAccountKey: (roomKey === undefined ? ChatState.codexAccountKey(state.codex.authStatus) : roomKey) || null, authorityEpoch: 0, url: 'https://example.test/page' }) } }
  const document = { getElementById: id => (id === 'card-1' ? card : null) }
  const fns = new Function('state', 'ChatState', 'BrowserGrant', 'document', 'window', `
    const browserToolUserSelections = new Map(), browserToolThreadGrants = new Map(), browserToolThreadSites = new Map(), browserToolBindingRooms = new WeakMap();
    ${decl('getCodexThreadById')}
    ${decl('browserToolSameUrl')}
    ${decl('chatBindingNonce')}
    ${decl('browserToolSiteForHost')}
    ${line('  const browserToolGrantKey =')}
    ${decl('browserToolRoomKeyFor')}
    ${line('  const browserToolRoomKeyOf =')}
    ${decl('revokeBrowserToolGrants')}
    ${decl('browserToolGrantFor')}
    ${decl('registerBrowserToolSelection')}
    ${decl('browserToolRefreshSelection')}
    ${decl('browserToolSelectedSources')}
    return { register: registerBrowserToolSelection, selected: browserToolSelectedSources, roomKeyFor: browserToolRoomKeyFor, roomKeyOf: browserToolRoomKeyOf, rooms: browserToolBindingRooms, grantFor: browserToolGrantFor,
      grants: browserToolThreadGrants }`)(state, ChatState, BrowserGrant, document, { crypto: { randomUUID: () => `nonce-${++nonce}` } })
  // what attaching the card to a chat recorded: the card's identity under the DEFAULT sign-in at that time
  const source = () => ({ id: 'input-1', kind: 'browser', label: 'Page', browserToolPermission: 'observe', sourceRef: { viewId: 'card-1', uri: 'https://example.test/page', profileId: 'p1', accountId: 'acct' },
    browserToolIdentity: { cardEpoch: 'epoch-1', userContextId: 0, engineAccountKey: ChatState.codexAccountKey(state.codex.authStatus) || null, authorityEpoch: 0 } })
  return { state, codex, fns, source, card }
}
const pick = (w, thread, permission = 'observe') => { const selected = w.fns.register(thread, w.source(), permission); return selected ? { selected, list: w.fns.selected(thread, [selected]) } : null }

test('flag on: a profile room selects its Browser card under ITS account while the default is signed out, and while the default is someone else; the grant carries the room\'s key', () => {
  for (const defaultAuth of [{ isLoggedIn: false }, signedIn('someone-else@example.test')]) {
    const w = world({ defaultAuth }), got = pick(w, 'room-w')
    assert.ok(got, `selected (default ${JSON.stringify(defaultAuth)})`)
    assert.equal(got.selected.browserToolIdentity.engineAccountKey, SLOT_KEY('b@example.test'))
    assert.equal(got.list.length, 1, 'still selected at send time')
    const interact = w.fns.register('room-w', w.source(), 'interact')
    assert.ok(interact); assert.equal(w.fns.grantFor('room-w', 'card-1')?.engineAccountKey, SLOT_KEY('b@example.test'), 'the standing grant holds under the room\'s account')
  }
})

test('flag on: the default account changing does not touch the profile room\'s selection or grant; another account on the profile does', () => {
  const w = world(), first = pick(w, 'room-w'); assert.equal(first.list.length, 1)
  w.fns.register('room-w', w.source(), 'interact'); assert.ok(w.fns.grantFor('room-w', 'card-1'))
  w.codex.authStatus = signedIn('c@example.test'); w.codex.codexAccountKey = ChatState.codexAccountKey(w.codex.authStatus)
  assert.equal(w.fns.selected('room-w', [first.selected]).length, 1, 'default changed: still')
  assert.ok(w.fns.grantFor('room-w', 'card-1'), 'default changed: grant holds')
  w.codex.authStatus = { isLoggedIn: false }
  assert.equal(w.fns.selected('room-w', [first.selected]).length, 1, 'default signed out: still')
  w.codex.engines = engines('z@example.test')
  assert.equal(w.fns.selected('room-w', [first.selected]).length, 0, 'another account on the profile ends the selection')
  assert.equal(w.fns.grantFor('room-w', 'card-1'), null, 'and the grant')
  w.codex.engines = engines(null)
  // a signed-out account is selectable as before (selection happens before any send) but carries no account: the bind request refuses an unknown account
  // (`ChatState.knownCodexAccountKey`), and it is never the default's account
  const out = pick(w, 'room-w')
  assert.equal(out.selected.browserToolIdentity.engineAccountKey, null); assert.equal(ChatState.knownCodexAccountKey(out.selected.browserToolIdentity.engineAccountKey), false)
})

test('flag on: a default room compares as before (the attach-time account must still be the default; a profile account does not matter to it)', () => {
  const w = world(), got = pick(w, 'room-d'); assert.ok(got); assert.equal(got.selected.browserToolIdentity.engineAccountKey, ChatState.codexAccountKey(signedIn('a@example.test')))
  w.codex.engines = engines('z@example.test'); assert.equal(w.fns.selected('room-d', [got.selected]).length, 1)
  const stale = w.source(); w.codex.authStatus = signedIn('c@example.test')
  assert.equal(w.fns.register('room-d', stale, 'observe'), null, 'the default changed after the card was attached: refused')
  assert.equal(w.fns.selected('room-d', [got.selected]).length, 0)
})

test('flag off: a profile room is checked against the default sign-in exactly as before', () => {
  const w = world({ flag: 'off' }); const got = pick(w, 'room-w'); assert.ok(got)
  assert.equal(got.selected.browserToolIdentity.engineAccountKey, ChatState.codexAccountKey(signedIn('a@example.test')))
  w.codex.authStatus = { isLoggedIn: false }
  assert.equal(w.fns.selected('room-w', [got.selected]).length, 0, 'default signed out: not selected, as before')
  const signedOut = world({ flag: 'off', defaultAuth: { isLoggedIn: false } })
  const none = signedOut.fns.register('room-w', signedOut.source(), 'observe')
  assert.equal(ChatState.knownCodexAccountKey(none?.browserToolIdentity?.engineAccountKey), false, 'default signed out: the profile room\'s selection has no known account (the bind refuses it), as before')
})

test('binding objects made by the window remember their room; the room key of an unknown object or room is the default (undefined)', () => {
  const w = world(); const binding = w.card._browserControls.toolBinding(SLOT_KEY('b@example.test'))
  assert.equal(w.fns.roomKeyOf(binding), undefined, 'an object the window did not register')
  w.fns.rooms.set(binding, 'room-w'); assert.equal(w.fns.roomKeyOf(binding), SLOT_KEY('b@example.test'))
  w.fns.rooms.set(binding, 'room-d'); assert.equal(w.fns.roomKeyOf(binding), ChatState.codexAccountKey(signedIn('a@example.test')))
  assert.equal(w.fns.roomKeyFor('no-such-room'), undefined); assert.equal(w.fns.roomKeyFor(null), undefined)
})

test('every window comparison of a card identity names its room: no zero-argument toolBinding() is left outside card-generation checks and the QA fixture', () => {
  const calls = [...surface.matchAll(/toolBinding\??\.?\(([^)]*)\)/g)].filter(match => match[1] === '').map(match => surface.slice(Math.max(0, match.index - 90), match.index + 60).replace(/\s+/g, ' '))
  const unscoped = calls.filter(text => !/cardEpoch !== request\.targetCardEpoch/.test(text) && !/toolBinding\?\.\(\);\s*return binding\?\.accountId === ''/.test(text) && !/view\._browserControls\?\.toolBinding\?\.\(\)/.test(text) && !/card\._browserControls\?\.toolBinding\?\.\(\);\s*if \(!card\.isConnected/.test(text) && !/card\._browserControls\?\.toolBinding\?\.\(\);\s*return binding\?\.accountId/.test(text))
  assert.deepEqual(unscoped, [], 'unscoped toolBinding() calls: ' + unscoped.join(' | '))
  assert.match(surface, /engineAccountKey: \(roomKey === undefined \? ChatState\.codexAccountKey\(state\.codex\.authStatus\) : roomKey\) \|\| null,/)
  assert.match(surface, /const current = browserToolBinding\(browserToolRoomKeyOf\(expected\)\);/)
})
