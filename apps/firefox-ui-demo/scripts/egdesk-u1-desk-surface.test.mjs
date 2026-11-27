import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import * as SurfaceState from '../overlay/resources/EGDeskSurfaceState.sys.mjs'
import * as View from '../overlay/resources/EGDeskAccountSettingsView.sys.mjs'

const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const SAFE = { left: 24, top: 60, right: 1256, bottom: 640 }
const rect = (x, y, width, height) => ({ x, y, width, height })
const overlaps = (a, b, gap = 0) => !(a.x + a.width + gap <= b.x || a.x >= b.x + b.width + gap || a.y + a.height + gap <= b.y || a.y >= b.y + b.height + gap)

// ---- item 1: placement beside the terminal ----
test('u1/1: the sign-in card of a 480x360 terminal opens right of it, in view, at the terminal\'s top, 24 px away', () => {
  const term = rect(100, 100, 480, 360)
  const p = SurfaceState.placeBesideOpener({ size: { width: 640, height: 480 }, opener: term, safe: SAFE })
  assert.deepEqual([p.x, p.y, p.width, p.height, p.inView], [604, 100, 640, 480, true])
  assert.ok(p.x + p.width <= SAFE.right && p.y + p.height <= SAFE.bottom, 'fully inside the visible area')
})

test('u1/1: placeBesideOpener: order, sliding along the edge, occupied rects, and the not-in-view fallback', () => {
  const size = { width: 400, height: 300 }
  // room on the right: aligned with the terminal's top
  let p = SurfaceState.placeBesideOpener({ size, opener: rect(100, 120, 480, 360), safe: SAFE })
  assert.deepEqual([p.x, p.y, p.inView], [604, 120, true])
  // a terminal at the far right: the left side is used
  p = SurfaceState.placeBesideOpener({ size, opener: rect(760, 120, 480, 360), safe: SAFE })
  assert.deepEqual([p.x, p.y, p.inView], [336, 120, true]); assert.equal(overlaps(p, rect(760, 120, 480, 360), 24), false)
  // a tall card slides up so it stays inside the safe area
  p = SurfaceState.placeBesideOpener({ size: { width: 400, height: 500 }, opener: rect(100, 400, 480, 200), safe: SAFE })
  assert.deepEqual([p.x, p.y, p.inView], [604, 140, true])
  // the right is taken by another View: left, and when that is taken too, below/above
  const wall = rect(604, 0, 600, 700)
  p = SurfaceState.placeBesideOpener({ size, opener: rect(300, 120, 280, 360), safe: SAFE, occupied: [wall] })
  assert.deepEqual([p.x, p.y, p.inView], [-124, 120, false], 'left is outside the safe area (x<24): the first free spot is used and the caller frames both')
  // a terminal that fills the view: nothing fits in view; the first free spot (right) with inView false
  p = SurfaceState.placeBesideOpener({ size: { width: 640, height: 480 }, opener: rect(24, 60, 1232, 580), safe: SAFE })
  assert.deepEqual([p.x, p.y, p.inView], [1280, 60, false])
  // the placed rect never overlaps an occupied View by less than the gap, in any case
  for (const opener of [rect(100, 100, 480, 360), rect(24, 60, 1232, 580), rect(800, 400, 440, 240)]) {
    const occupied = [rect(0, 0, 50, 50), rect(1300, 80, 300, 300), rect(500, 500, 100, 100)]
    const spot = SurfaceState.placeBesideOpener({ size, opener, safe: SAFE, occupied })
    for (const o of [...occupied, opener]) assert.equal(overlaps(spot, o, 24), false, JSON.stringify([spot, o]))
  }
  // unusable input
  assert.equal(SurfaceState.placeBesideOpener({ size: null, opener: rect(0, 0, 1, 1), safe: SAFE }), null)
  assert.equal(SurfaceState.placeBesideOpener({ size, opener: null, safe: SAFE }), null)
  assert.equal(SurfaceState.placeBesideOpener({ size, opener: rect(0, 0, 10, 10), safe: { left: 0 } }), null)
})

test('u1/1: wiring: spawnBrowserCard uses the beside-opener placement and reveals a background card that has an opener (alone when they cannot share the screen)', () => {
  assert.match(surface, /: options\.besideOpener \? resolveBesideOpenerPlacement\('browser', options\.besideOpener\) : resolveCanvasCardPlacement\('browser'\);/)
  assert.match(surface, /else if \(options\.revealBackground === true && options\.besideOpener\) revealPlacedCanvasCard\(card, placement, \{ kind: 'browser', keepVisible: options\.besideOpener, revealAlone: true \}\);/)
  assert.match(surface, /else if \(options\.revealAlone === true\) state\.setCanvasPanTarget\?\.\(SurfaceState\.revealRectPan\(rect, safe, view\)\)/)
  assert.match(surface, /activate: !options\.background,/, 'the card still takes no input focus')
})

// ---- item 2: close on success ----
test('u1/2: claudeSigninPageUrl is Claude\'s sign-in page only', () => {
  for (const url of ['https://claude.com/cai/oauth/authorize?code=true', 'https://claude.ai/login', 'https://platform.claude.com/oauth/authorize?x=1', 'https://console.anthropic.com/login']) assert.equal(SurfaceState.claudeSigninPageUrl(url), true, url)
  for (const url of ['https://auth.openai.com/log-in', 'https://claude.com/', 'https://claude.ai/chat/1', 'https://example.test/oauth/authorize', 'about:blank', '', null, 'x']) assert.equal(SurfaceState.claudeSigninPageUrl(url), false, String(url))
})

test('u1/2: the login watch returns signedIn even when the login row stops being "current" the moment the login worked', async () => {
  let t = 0, checks = 0, current = true
  const result = await View.watchClaudeLogin({ refresh: async () => { checks++; if (checks === 2) current = false }, isSignedIn: () => checks >= 2, sessionEnded: () => false, isCurrent: () => current, wait: async ms => { t += ms }, now: () => t })
  assert.equal(result, 'signedIn')
  checks = 0; current = true; t = 0
  assert.equal(await View.watchClaudeLogin({ refresh: async () => { checks++; if (checks === 2) current = false }, isSignedIn: () => false, sessionEnded: () => false, isCurrent: () => current, wait: async ms => { t += ms }, now: () => t }), 'changed')
})

function watchSandbox({ signedAfter = Infinity, alreadySigned = false, bridge = true, guard = true } = {}) {
  const src = surface.slice(surface.indexOf('  function watchClaudeSignedIn(card, href) {'), surface.indexOf('  state.watchClaudeSignedIn = watchClaudeSignedIn;'))
  assert.ok(src.length > 200)
  let polls = 0, clock = 0
  const state = { codexBridge: bridge ? { refreshClaudeEngine: async () => { polls++; } } : null, codex: { connected: true, engines: [] } }
  const signed = () => alreadySigned || polls > signedAfter
  const AccountSettingsView = { ...View, claudeAccountView: () => ({ status: signed() ? 'signedIn' : 'signedOut' }) }
  const context = { state, SurfaceState, AccountSettingsView, signinGuardOn: () => guard, window: { setTimeout: (fn) => { clock += 3000; Promise.resolve().then(fn); return 1; } }, Promise }
  const api = runInNewContext(`${src}\n({ watchClaudeSignedIn })`, context)
  return { api, polls: () => polls, clock: () => clock }
}

test('u1/2: the surface watch: Claude\'s sign-in address only, one watch per terminal card, signedIn when the engine says so, already for a signed-in engine, null without the guard or a bridge', async () => {
  const CLAUDE = 'https://claude.com/cai/oauth/authorize?state=s'
  const card = { isConnected: true, ownerDocument: null }
  let w = watchSandbox({ signedAfter: 3 })
  assert.equal(w.api.watchClaudeSignedIn(card, 'https://auth.openai.com/log-in'), null, 'not Claude\'s page')
  const first = w.api.watchClaudeSignedIn(card, CLAUDE)
  assert.equal(w.api.watchClaudeSignedIn(card, CLAUDE), first, 'shared while it runs')
  assert.equal(await first, 'signedIn'); assert.ok(w.polls() >= 4 && w.polls() <= 6, `polls ${w.polls()}`)
  await Promise.resolve(); assert.notEqual(w.api.watchClaudeSignedIn(card, CLAUDE), first, 'a finished watch is forgotten: a later login is read afresh')
  assert.equal(await watchSandbox({ alreadySigned: true }).api.watchClaudeSignedIn({ isConnected: true }, CLAUDE), 'already')
  assert.equal(watchSandbox({ guard: false }).api.watchClaudeSignedIn({ isConnected: true }, CLAUDE), null)
  assert.equal(watchSandbox({ bridge: false }).api.watchClaudeSignedIn({ isConnected: true }, CLAUDE), null)
  const ended = { isConnected: true, _sessionEnded: false }, w2 = watchSandbox({})
  const p = w2.api.watchClaudeSignedIn(ended, CLAUDE); ended._sessionEnded = true
  assert.equal(await p, 'ended', 'the session ended without success')
  const gone = { isConnected: true }, w3 = watchSandbox({}); const q = w3.api.watchClaudeSignedIn(gone, CLAUDE); gone.isConnected = false
  assert.equal(await q, 'changed', 'a closed terminal card ends the watch')
})

test('u1/2: wiring: the Settings row shares the terminal card\'s watch; the terminal zone starts and acts on it', () => {
  assert.match(surface, /state\.watchClaudeSignedIn = watchClaudeSignedIn;/)
  assert.match(surface, /void Promise\.resolve\(loginCard\._claudeSigninWatch \|\| AccountSettingsView\.watchClaudeLogin\(/)
  const terminal = readFileSync(new URL('../overlay/resources/surface/EGDeskSurfaceTerminal.mjs', import.meta.url), 'utf8')
  assert.match(terminal, /state\.watchClaudeSignedIn\?\.\(card, url\.href\)\?\.then\(result => \{ if \(result === 'signedIn'\) closeLinkedCards\(\); \}\)/)
})

// ---- item 5: edge dots never sit on a View ----
import * as Viewport from '../overlay/resources/EGDeskViewportExtras.sys.mjs'
const VP = { width: 1280, height: 720 }
const dotAt = (side, x, y, extra = {}) => ({ key: `view:${side}${x}${y}`, type: 'view', side, x, y, id: `c-${side}${x}${y}`, count: 1, ...extra })
const hits = (dot, c) => { const w = dot.type === 'more' ? 22 : 12, h = 12; return Math.min(dot.x + w, c.right) - Math.max(dot.x - w, c.left) > 0 && Math.min(dot.y + h, c.bottom) - Math.max(dot.y - h, c.top) > 0 }

test('u1/5: a dot on a View slides along its edge to the nearest spot clear of every View; a dot already clear is the same object', () => {
  const card = { left: 800, top: 100, right: 1262, bottom: 500 }
  const onCard = dotAt('right', 1250, 300), clear = dotAt('left', 12, 400), top = dotAt('top', 900, 20)
  const out = Viewport.edgeDotsAvoidCards([onCard, clear, top], { cards: [card], viewport: VP })
  assert.equal(out[1], clear, 'a clear dot is untouched'); assert.equal(out[2], top)
  assert.equal(hits(out[0], card), false, 'no longer on the card'); assert.equal(out[0].side, 'right'); assert.equal(out[0].x, 1250, 'it stays on its edge column')
  assert.ok(Math.abs(out[0].y - 300) <= 220, 'the nearest clear spot, not the far end'); assert.equal(onCard.y, 300, 'the input is not mutated')
})

test('u1/5: the cards of a whole side cover its edge: the gutter, else the least covered spot; dots keep their distance and their order; a "+N" dot is wider', () => {
  const wall = { left: 900, top: 0, right: 1280, bottom: 720 }
  const out = Viewport.edgeDotsAvoidCards([dotAt('right', 1250, 200), dotAt('right', 1250, 215)], { cards: [wall], viewport: VP })
  for (const d of out) { assert.ok(d.x >= 8 && d.x <= 1272 && d.y >= 8 && d.y <= 712, JSON.stringify(d)) }
  assert.ok(Math.abs(out[0].y - out[1].y) >= 26, 'the two dots do not touch'); assert.ok(out[0].y < out[1].y, 'order kept')
  const more = dotAt('bottom', 640, 700, { type: 'more', count: 3 }), card = { left: 600, top: 560, right: 700, bottom: 712 }
  const moved = Viewport.edgeDotsAvoidCards([more], { cards: [card], viewport: VP })[0]
  assert.equal(Math.min(moved.x + 22, card.right) - Math.max(moved.x - 22, card.left) > 0 && Math.min(moved.y + 12, card.bottom) - Math.max(moved.y - 12, card.top) > 0, false, 'the wider hit box is respected')
  assert.equal(moved.y, 700)
})

test('u1/5: edgeDotsAvoidCards: no cards, no viewport, nothing: the same list; wiring runs it after the dock rule', () => {
  const dots = [dotAt('right', 1250, 300)]
  assert.equal(Viewport.edgeDotsAvoidCards(dots, { cards: [], viewport: VP }), dots); assert.equal(Viewport.edgeDotsAvoidCards(dots, { cards: [{ left: 0, top: 0, right: 5, bottom: 5 }] }), dots); assert.deepEqual(Viewport.edgeDotsAvoidCards([], { viewport: VP, cards: [{ left: 0, top: 0, right: 5, bottom: 5 }] }), [])
  assert.equal(Viewport.edgeDotsAvoidCards(dots, { cards: [{ left: NaN, top: 0, right: 1, bottom: 1 }], viewport: VP }), dots, 'a broken rect is ignored')
  assert.match(surface, /edgeDotsBesideDock\(dots, \{ dock: dockRect[^\n]*catch \{\}\n\s+avoidCards\(\);/)
  assert.match(surface, /ViewportExtras\.edgeDotsAvoidCards\(dots, \{ viewport: \{ width: window\.innerWidth, height: window\.innerHeight \},\n\s+cards: cards\.map\(card => \{ const r = card\.getBoundingClientRect\(\)/)
})

// ---- item 7: the search field's routing can be turned on from a bundle ----
import * as HudRouting from '../overlay/resources/EGDeskHudRouting.sys.mjs'
test('u1/7: hudRoutingModeFor: a pref the person set wins (even "off"), else the bridge\'s announced mode, else off', () => {
  const f = HudRouting.hudRoutingModeFor, on = ['hud-routing-on'], adv = ['hud-routing-advisory']
  assert.deepEqual([f(undefined), f(null), f('yes')], ['off', 'off', 'off']); assert.equal(f('', on), 'on')
  assert.equal(f(null, on), 'on'); assert.equal(f(undefined, adv), 'advisory'); assert.equal(f('yes', adv), 'advisory', 'a garbage pref is no pref'); assert.equal(f(null, [...adv, ...on]), 'on')
  assert.equal(f('off', on), 'off', 'an explicit off wins'); assert.equal(f('advisory', on), 'advisory'); assert.equal(f('on', []), 'on')
  assert.equal(f(null, 'hud-routing-on'), 'off', 'not a list'); assert.equal(f(null, ['terminal-open-url']), 'off')
  assert.deepEqual({ ...HudRouting.HUD_ROUTING_CAPABILITIES }, { advisory: 'hud-routing-advisory', on: 'hud-routing-on' })
  assert.match(surface, /function hudRoutingModeNow\(\) \{ return HudRouting\.hudRoutingModeFor\(readSurfacePref\(HudRouting\.HUD_ROUTING_PREF\), state\.codex\?\.chatCapabilities\); \}/)
})

// ---- Main's item: "사용량 44%" must not read as "한도에 가까워졌습니다" ----
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
test('u1/usage: an early allowed_warning below 70% reads as the plain usage line; at or above 70%, or with no percent, it is the warning; a rejection is a limit', () => {
  const NOW = Date.UTC(2026, 10, 26, 3, 0, 0), run = (extra = {}) => ({ engineId: 'claude', rateLimit: { engineId: 'claude', status: 'allowed_warning', window: 'weekly', usedPercent: 44, resetsAt: NOW + 3600000, ...extra } })
  const at44 = ChatState.runRateLimitNotice(run(), NOW)
  assert.equal(at44.level, 'ok'); assert.match(at44.text, /^Claude 사용량을 확인했습니다\. 주간 한도 · 사용량 44%/); assert.doesNotMatch(at44.text, /가까워졌습니다/); assert.equal(at44.usedPercent, 44)
  assert.equal(ChatState.runRateLimitNotice(run({ usedPercent: 42.5, window: 'fiveHour' }), NOW).level, 'ok')
  assert.equal(ChatState.RATE_LIMIT_WARN_FROM_PERCENT, 70)
  assert.equal(ChatState.runRateLimitNotice(run({ usedPercent: 69.9 }), NOW).level, 'ok')
  for (const percent of [70, 87, 100]) { const n = ChatState.runRateLimitNotice(run({ usedPercent: percent }), NOW); assert.equal(n.level, 'warn', String(percent)); assert.match(n.text, /^Claude 사용 한도에 가까워졌습니다\./) }
  assert.equal(ChatState.runRateLimitNotice(run({ usedPercent: null }), NOW).level, 'warn', 'no percent: the provider\'s warning stands')
  assert.equal(ChatState.runRateLimitNotice(run({ status: 'rejected', usedPercent: 100 }), NOW).level, 'limit')
  assert.equal(ChatState.runRateLimitNotice(run({ status: 'allowed', usedPercent: 10 }), NOW).level, 'ok')
})

// ---- Main's item: '기록 없이 시작' for a Claude room ----
test('u1/stateless: with Claude selected there is no one-time switch and no Codex wording; with Codex (or an unknown engine) nothing changes', () => {
  const claude = { id: 'claude', label: 'Claude', status: 'ready', capabilities: ['stream', 'resume', 'usage.rateLimits'] }
  const codexRow = { id: 'codex', label: 'Codex', status: 'ready', capabilities: ['stream', 'ephemeralThreads', 'threadFork'] }
  const caps = ['send', 'stateless'], room = { id: 't1', type: 'dm', startStateless: true, engineId: 'claude' }
  const codexState = (engineId, rows = [codexRow, claude]) => ({ engines: rows, authStatus: { isLoggedIn: true }, recentEngineId: null, profileEngines: null, _engineId: engineId })
  const v = ChatState.chatStatelessStartView(room, caps, codexState('claude'))
  assert.deepEqual([v.available, v.on, v.note], [false, false, ChatState.STATELESS_ENGINE_UNSUPPORTED_NOTE]); assert.doesNotMatch(v.note, /코덱스/)
  const c = ChatState.chatStatelessStartView({ ...room, engineId: 'codex' }, caps, codexState('codex'))
  assert.deepEqual([c.available, c.on], [true, true]); assert.match(c.note, /코덱스에 대화 기록을 남기지 않습니다/)
  assert.deepEqual(ChatState.chatStatelessStartView({ ...room, engineId: 'codex' }, caps, codexState('codex')), ChatState.chatStatelessStartView({ ...room, engineId: 'codex' }, caps), 'a Codex room reads the same with or without the engine list')
  assert.equal(ChatState.chatStatelessStartView(room, caps).on, true, 'no engine state given: as before')
  assert.equal(ChatState.chatStatelessStartView(room, caps, codexState('claude', [{ id: 'claude', label: 'Claude', status: 'ready' }])).available, true, 'an engine row without a capability list is not judged')
  assert.equal(ChatState.chatStatelessStartView(null, caps, codexState('claude')).available, false)
})

// ---- Main's item: the room's name follows the engine ----
test('u1/name: choosing Claude renames a room that still has its default name; a name the person changed, a started room and other titles are never touched', () => {
  const room = (extra = {}) => ({ id: 't', type: 'dm', title: 'Codex 1', participants: ['나', 'Codex'], participantRoles: { 나: 'owner', Codex: 'member' }, ...extra })
  assert.deepEqual(ChatState.relabelDefaultRoom(room(), 'Claude'), { title: 'Claude 1', from: 'Codex', to: 'Claude' })
  assert.deepEqual(ChatState.relabelDefaultRoom(room({ title: 'Codex', participants: ['나', 'Codex'] }), 'Claude'), { title: 'Claude', from: 'Codex', to: 'Claude' })
  assert.deepEqual(ChatState.relabelDefaultRoom(room({ title: 'Claude 7', participants: ['나', 'Claude'] }), 'Codex'), { title: 'Codex 7', from: 'Claude', to: 'Codex' }, 'and back')
  assert.equal(ChatState.relabelDefaultRoom(room({ title: '견적 검토' }), 'Claude'), null, 'a name the person chose')
  assert.equal(ChatState.relabelDefaultRoom(room({ title: 'Codex 1 메모' }), 'Claude'), null)
  assert.equal(ChatState.relabelDefaultRoom(room({ type: 'group' }), 'Claude'), null)
  assert.equal(ChatState.relabelDefaultRoom(room({ conversationId: 'c1' }), 'Claude'), null, 'a started room keeps its name (and its engine)')
  assert.equal(ChatState.relabelDefaultRoom(room(), ''), null); assert.equal(ChatState.relabelDefaultRoom(room(), 'Codex'), null, 'same name: nothing to do')
  assert.deepEqual(ChatState.relabelDefaultRoom(room({ participants: ['나', 'Someone'] }), 'Claude'), { title: 'Claude 1', from: null, to: null }, 'a peer the person renamed is kept')
  const surface2 = surface
  assert.match(surface2, /\.\.\.\(typeof relabelRoomPatch === 'function' \? relabelRoomPatch\(current, engineLabel\) : \{\}\) \}\)\);/)
  assert.match(surface2, /const label = normalizedType === 'group' \? `대화 \$\{nextNonce\}` : `\$\{peerName\} \$\{nextNonce\}`;/)
})

// ---- item 6: does scrolling in the Settings card zoom the canvas? The wheel router, run as the surface has it ----
function wheelRig({ activeId = 'settings-1', guard = false } = {}) {
  const A = surface.slice(surface.indexOf('    const shouldAllowActiveEntityScroll = (target) => {'), surface.indexOf('    state.nativeGestureHook = (payload) => {'))
  const B = surface.slice(surface.indexOf('    const routeCanvasWheel = (ev) => {'), surface.indexOf('    const terminalFrameWheelResults = new WeakMap();'))
  assert.ok(A.length > 300 && B.length > 300)
  class El { constructor(id, cls = [], parent = null) { this.id = id; this.cls = cls; this.parent = parent; this.kids = [] ; parent?.kids.push(this) }
    contains(node) { for (let n = node; n; n = n.parent) if (n === this) return true; return false }
    closest(sel) { const want = sel.split(',').map(s => s.trim().replace(/^[#.]/, '')); for (let n = this; n; n = n.parent) if (want.includes(n.id) || n.cls.some(c => want.includes(c))) return n; return null }
    querySelector(sel) { const c = sel.replace(/^\./, ''); const walk = n => { for (const k of n.kids) { if (k.cls.includes(c)) return k; const f = walk(k); if (f) return f } return null }; return walk(this) }
    get offsetParent() { return {} } }
  const settings = new El('settings-1', ['egd-canvas-card', 'egd-settings-card']), body = new El('b1', ['egd-card-body'], settings), shell = new El('sh', ['egd-settings-shell'], body), row = new El('row', [], shell)
  const other = new El('other-1', ['egd-canvas-card']), otherBody = new El('b2', ['egd-card-body'], other)
  const byId = { 'settings-1': settings, 'other-1': other }
  const calls = []
  const state = { activeEntityId: activeId, cardFullscreen: null }
  const ctx = { state, Element: El, document: { getElementById: id => byId[id] ?? null }, performance: { now: () => 1000 }, WHEEL_SESSION_IDLE_MS: 220,
    panCanvasByWheel: () => calls.push('pan'), zoomCanvasByWheel: () => calls.push('zoom'), shouldAllowHudScroll: () => false, wheelScrollGuardOn: () => guard }
  const api = runInNewContext(`${A}\n${B}\n({ routeCanvasWheel, resetWheelSession, wheelSession })`, ctx)
  return { ...api, calls, settings, row, otherBody, state, clock: ms => { ctx.performance.now = () => ms } }
}
test('u1/6: a plain scroll over the Settings card never zooms: active card scrolls natively (nothing consumed), an inactive one pans the canvas; only a ctrl/pinch wheel zooms', () => {
  const active = wheelRig(); const plain = { target: active.row, deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false, metaKey: false }
  for (let i = 0; i < 5; i++) assert.equal(active.routeCanvasWheel({ ...plain }), false, 'the active Settings card scrolls by itself')
  assert.deepEqual(active.calls, [])
  const inactive = wheelRig({ activeId: 'other-1' })
  for (let i = 0; i < 5; i++) assert.equal(inactive.routeCanvasWheel({ ...plain, target: inactive.row }), true)
  assert.deepEqual(inactive.calls, ['pan', 'pan', 'pan', 'pan', 'pan'], 'an inactive card: the canvas pans, it does not zoom')
  const pinch = wheelRig(); assert.equal(pinch.routeCanvasWheel({ ...plain, target: pinch.row, ctrlKey: true }), true); assert.deepEqual(pinch.calls, ['zoom'])
  // the one way a scroll over the active card turns into a zoom: a wheel event of the same gesture that carries ctrlKey (a trackpad pinch component, or ⌃ held) takes the zoom branch FIRST
  const mixed = wheelRig(); mixed.routeCanvasWheel({ ...plain, target: mixed.row }); mixed.routeCanvasWheel({ ...plain, target: mixed.row, ctrlKey: true }); mixed.routeCanvasWheel({ ...plain, target: mixed.row })
  assert.deepEqual(mixed.calls, ['zoom', 'pan'], 'today: ctrlKey is checked before the entity-owned scroll session, and the rest of that gesture then pans the canvas: the card stops scrolling and the camera moves')
})

test('u1/6: with the guard on, a ctrl-flagged wheel inside a live scroll gesture of the active card is a scroll (nothing consumed); a ctrl/pinch that starts its own gesture, another card, or ⌘ still behave as before', () => {
  const plain = row => ({ target: row, deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false, metaKey: false })
  const g = wheelRig({ guard: true })
  g.clock(1000); assert.equal(g.routeCanvasWheel(plain(g.row)), false)
  g.clock(1040); assert.equal(g.routeCanvasWheel({ ...plain(g.row), ctrlKey: true }), false, 'a pinch component inside the scroll gesture')
  g.clock(1080); assert.equal(g.routeCanvasWheel(plain(g.row)), false, 'the card keeps scrolling')
  assert.deepEqual(g.calls, [], 'no zoom, no canvas pan')
  // the gesture ended (idle > 140 ms): a ctrl wheel is a new gesture and zooms
  g.clock(1400); assert.equal(g.routeCanvasWheel({ ...plain(g.row), ctrlKey: true }), true); assert.deepEqual(g.calls, ['zoom'])
  // ⌘ is the pan gesture and is not touched by the guard
  const m = wheelRig({ guard: true }); m.clock(1000); m.routeCanvasWheel(plain(m.row)); m.clock(1030); m.routeCanvasWheel({ ...plain(m.row), metaKey: true }); m.clock(1060); m.routeCanvasWheel({ ...plain(m.row), ctrlKey: true, metaKey: true }); assert.deepEqual(m.calls, ['pan', 'zoom'], '⌘ pans; ⌘+ctrl is the zoom branch as before')
  // a scroll that started elsewhere (the canvas owns it) is still zoomed by ctrl
  const o = wheelRig({ guard: true, activeId: 'other-1' }); o.clock(1000); o.routeCanvasWheel(plain(o.row)); o.clock(1030); o.routeCanvasWheel({ ...plain(o.row), ctrlKey: true }); assert.deepEqual(o.calls, ['pan', 'zoom'])
  // guard off (the default): as today
  const off = wheelRig({ guard: false }); off.clock(1000); off.routeCanvasWheel(plain(off.row)); off.clock(1040); off.routeCanvasWheel({ ...plain(off.row), ctrlKey: true }); assert.deepEqual(off.calls, ['zoom'])
  assert.match(surface, /readSurfacePref\('egdesk\.wheelScrollGuard'\) === 'on'/)
})
