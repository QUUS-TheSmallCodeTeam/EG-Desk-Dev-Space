import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as L from '../overlay/resources/EGDeskCardLease.sys.mjs'

const js = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8')

test('flag: default off, only the exact value on enables it', () => {
  assert.equal(L.CARD_LEASE_PREF, 'egdesk.cardLease')
  for (const v of [null, undefined, '', 'true', true, 'ON', { unreadable: true }]) assert.equal(L.cardLeaseEnabled(v), false)
  assert.equal(L.cardLeaseEnabled('on'), true)
})

test('state machine: start takes the lease, generation counts, joins add tasks, last stop releases', () => {
  let l = L.createLease()
  assert.deepEqual([l.state, l.owner, l.generation], ['person', 'person', 0])
  assert.equal(L.leaseBlocksPerson(l), false)
  l = L.leaseStart(l, 'a', 100)
  assert.deepEqual([l.state, l.owner, l.generation, l.startedAt], ['agent', 'agent', 1, 100])
  assert.equal(L.leaseBlocksPerson(l), true)
  l = L.leaseStart(l, 'b', 150)
  assert.equal(l.generation, 1); assert.deepEqual([...l.tasks], ['a', 'b']); assert.equal(l.startedAt, 100)
  l = L.leaseStop(l, 'a'); assert.equal(l.state, 'agent')
  l = L.leaseStop(l, 'b'); assert.deepEqual([l.state, l.reason], ['person', 'task-end'])
  l = L.leaseStart(l, 'c', 300); assert.equal(l.generation, 2)
})

test('state machine: pause, handoff, reset always release; handoff keeps person rights and no hold start', () => {
  const started = L.leaseStart(L.createLease(), 'a', 1)
  assert.equal(L.leasePause(started).state, 'person')
  const h = L.leaseHandoff(started); assert.deepEqual([h.state, h.owner, h.tasks.length], ['handoff', 'person', 0])
  assert.equal(L.leaseBlocksPerson(h), false)
  assert.equal(L.leaseStop(L.leaseStart(started, 'b', 2), 'a', { handoff: true }).state, 'handoff')
  assert.equal(L.leaseReset(started, 'transport').reason, 'transport')
  assert.equal(L.leaseStart(L.createLease(), 'a', 1, { hold: true }).state, 'person', 'a person hold refuses a new lease')
  assert.equal(L.leaseStart(L.createLease(), '', 1).state, 'person')
  // handoff then a new run
  assert.equal(L.leaseStart(h, 'z', 9).state, 'agent')
  // stop of an unknown task with others running keeps the lease
  assert.equal(L.leaseStop(started, 'zz').state, 'agent')
})

test('state machine: inactivity expiry, heartbeat pushes it out, never expires a person lease', () => {
  assert.equal(L.CARD_LEASE_EXPIRY_MS, 120000)
  let l = L.leaseStart(L.createLease(), 'a', 1000)
  assert.equal(L.leaseExpire(l, 1000 + 119999).state, 'agent')
  assert.equal(L.leaseExpiryIn(l, 1000 + 20000), 100000)
  l = L.leaseBeat(l, 61000)
  assert.equal(L.leaseExpire(l, 1000 + 120000).state, 'agent')
  const e = L.leaseExpire(l, 61000 + 120000)
  assert.deepEqual([e.state, e.reason], ['person', 'expired'])
  const p = L.createLease()
  assert.equal(L.leaseExpire(p, 1e12), p); assert.equal(L.leaseBeat(p, 5), p); assert.equal(L.leaseExpiryIn(p, 5), 0)
})

test('input blocking decision: trusted person input in the page area only, while the agent holds the lease', () => {
  const agent = L.leaseStart(L.createLease(), 'a', 1)
  const person = L.createLease()
  const ev = (type, isTrusted = true) => ({ type, isTrusted })
  for (const type of ['mousedown', 'click', 'wheel', 'contextmenu', 'dragstart', 'drop', 'keydown', 'keypress', 'beforeinput', 'compositionstart', 'compositionupdate', 'paste']) {
    assert.equal(L.leaseShouldBlock(agent, ev(type), { inPageArea: true }), true, type)
    assert.equal(L.leaseShouldBlock(person, ev(type), { inPageArea: true }), false, `${type} when person holds it`)
    assert.equal(L.leaseShouldBlock(agent, ev(type), { inPageArea: false }), false, `${type} on the pause control / frame / other cards`)
    assert.equal(L.leaseShouldBlock(agent, ev(type, false), { inPageArea: true }), false, `${type} synthetic (agent) passes`)
  }
  assert.equal(L.leaseShouldBlock(agent, ev('focus'), { inPageArea: true }), false)
})

// ---- wiring: run the real per-card block against a small fake DOM ----
function harness() {
  const start = js.indexOf('    if (cardLeaseFlagOn()) {')
  const end = js.indexOf('    // ---- BRW-13: Agent activity on this Card', start)
  assert.ok(start > 0 && end > start, 'lease block boundary')
  const source = js.slice(start, end)
  const listeners = new Map()
  const win = { addEventListener(n, f) { (listeners.get(n) || listeners.set(n, new Set()).get(n)).add(f) }, removeEventListener(n, f) { listeners.get(n)?.delete(f) },
    timers: [], setTimeout(f, ms) { this.timers.push({ f, ms }); return this.timers.length }, clearTimeout(id) { if (this.timers[id - 1]) this.timers[id - 1] = null } }
  const mk = (name, parent = null) => ({ name, parent, hidden: false, dataset: {}, isConnected: true, children: [], listeners: {},
    contains(t) { for (let n = t; n; n = n.parent) if (n === this) return true; return false },
    addEventListener(n, f) { this.listeners[n] = f }, blurred: 0, blur() { this.blurred++; document.activeElement = null } })
  const xulBrowser = mk('browser'), wrap = mk('wrap'), pauseBtn = mk('pause'), body = { append(n) { n.parent = body; this.shield = n } }
  xulBrowser.parent = wrap
  const document = { activeElement: null }
  const card = { isConnected: true, dataset: {} }
  const el = (_tag, attrs) => Object.assign(mk('shield'), { class: attrs.class })
  const readSurfacePref = () => 'on'
  const fn = new Function('cardLeaseFlagOn', 'CardLease', 'el', 'body', 'xulBrowser', 'wrap', 'window', 'document', 'card', `${source}`)
  fn(() => true, L, el, body, xulBrowser, wrap, win, document, card)
  const fire = (type, target, isTrusted = true) => {
    const e = { type, target, isTrusted, defaultPrevented: false, stopped: false, cancelable: true, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true } }
    for (const f of listeners.get(type) || []) f(e)
    return e
  }
  return { card, win, listeners, xulBrowser, wrap, pauseBtn, body, document, fire }
}

test('wiring: card block exists only behind the flag, shield shows while the agent holds the card', () => {
  assert.match(js, /readSurfacePref\('egdesk\.cardLease'\) === 'on'/)
  assert.match(js, /if \(cardLeaseFlagOn\(\)\) \{/)
  const off = new Function('cardLeaseFlagOn', 'card', 'return typeof card._cardLease')
  assert.equal(off(() => false, { }), 'undefined')
  const h = harness()
  const shield = h.body.shield
  assert.equal(shield.hidden, true)
  assert.equal(h.card._cardLease.state().state, 'person')
  h.document.activeElement = h.xulBrowser
  h.card._cardLease.start('k1')
  assert.equal(shield.hidden, false)
  assert.equal(h.card.dataset.egdCardLease, 'agent')
  assert.equal(h.xulBrowser.blurred, 1, 'focus leaves the page')
  assert.ok(h.listeners.get('keydown').size === 1)
  h.card._cardLease.pause()
  assert.equal(shield.hidden, true)
  assert.equal(h.card.dataset.egdCardLease, 'person')
  assert.equal(h.listeners.get('keydown').size, 0, 'listeners are removed on release')
})

test('DOM: the person click/key/wheel/drop on the page is blocked, pause control and agent (untrusted) input pass', () => {
  const h = harness()
  h.card._cardLease.start('k1')
  for (const type of ['mousedown', 'click', 'wheel', 'contextmenu', 'drop', 'dragover']) {
    assert.equal(h.fire(type, h.xulBrowser).defaultPrevented, true, `${type} on the page`)
    assert.equal(h.fire(type, h.body.shield).defaultPrevented, true, `${type} on the shield`)
  }
  h.document.activeElement = h.xulBrowser
  for (const type of ['keydown', 'keypress', 'beforeinput', 'compositionstart', 'paste']) {
    const e = h.fire(type, h.xulBrowser)
    assert.equal(e.defaultPrevented, true, type); assert.equal(e.stopped, true, `${type} does not reach the page`)
  }
  assert.equal(h.fire('wheel', h.xulBrowser).stopped, false, 'wheel keeps bubbling so the canvas can pan')
  // the pause control, the card frame and other cards are untouched
  h.document.activeElement = h.pauseBtn
  for (const type of ['click', 'keydown', 'mousedown']) assert.equal(h.fire(type, h.pauseBtn).defaultPrevented, false, `${type} on pause`)
  h.document.activeElement = h.pauseBtn
  assert.equal(h.fire('keydown', h.pauseBtn).defaultPrevented, false)
  // the agent: dispatched/internal input is untrusted and passes
  for (const type of ['click', 'keydown', 'beforeinput']) assert.equal(h.fire(type, h.xulBrowser, false).defaultPrevented, false, `agent ${type}`)
  // after release the person types again
  h.card._cardLease.stop('k1')
  h.document.activeElement = h.xulBrowser
  assert.equal(h.fire('keydown', h.xulBrowser).defaultPrevented, false)
  assert.equal(h.fire('click', h.xulBrowser).defaultPrevented, false)
})

test('wiring: release paths (handoff, reset, expiry, dispose) leave no lock and no timer behind', () => {
  const h = harness()
  const c = h.card._cardLease
  c.start('k1'); c.handoff(); assert.equal(c.state().state, 'handoff'); assert.equal(h.body.shield.hidden, true)
  c.start('k2'); assert.equal(h.win.timers.filter(Boolean).length, 1, 'expiry timer armed'); c.reset('transport')
  assert.equal(h.win.timers.filter(Boolean).length, 0); assert.equal(c.state().state, 'person')
  c.start('k3')
  const timer = h.win.timers.filter(Boolean).at(-1)
  assert.ok(timer.ms > 0 && timer.ms <= L.CARD_LEASE_EXPIRY_MS)
  const realNow = Date.now; Date.now = () => realNow() + L.CARD_LEASE_EXPIRY_MS + 1
  try { timer.f() } finally { Date.now = realNow }
  assert.deepEqual([c.state().state, c.state().reason], ['person', 'expired']); assert.equal(h.body.shield.hidden, true)
  c.start('k4'); c.dispose(); assert.equal(h.body.shield.hidden, true); assert.equal(h.listeners.get('keydown').size, 0)
})

test('wiring: activity frames, pause, heartbeat, transport loss, human step and cleanup call the lease', () => {
  assert.match(js, /card\._cardLease\?\.start\(leaseKey, \{ hold: !!agentControl\.hold \}\)/)
  assert.match(js, /card\._cardLease\?\.segmentEnd\(leaseKey, \{ handoff: frame\.reason === 'human_step' \}\)/)
  assert.match(js, /event\.event === 'run\.completed' \|\| event\.event === 'run\.unavailable'/)
  assert.match(js, /card\._cardLease\?\.endRun\(leaseThread\)/)
  assert.match(js, /if \(!frame\) \{ activeBrowserTasks\.clear\(\); card\._cardLease\?\.reset\('cleared'\); \}/)
  assert.match(js, /activeBrowserTasks\.clear\(\);\n      card\._cardLease\?\.pause\(\);/)
  assert.match(js, /agentControl\.inFlight\+\+;\n      card\._cardLease\?\.beat\(\);/)
  assert.match(js, /card\._cardLease\?\.reset\('transport'\)/)
  assert.match(js, /stepIsHumanStep\(event\)[^\n]*_cardLease\?\.handoff\(\)/)
  assert.match(js, /try \{ card\._cardLease\?\.dispose\(\); \} catch \{\}/)
  assert.match(css, /\.egd-card-lease-shield \{[^}]*cursor: not-allowed/)
  assert.match(css, /\.egd-card-lease-shield\[hidden\] \{ display: none; \}/)
})

// ---- run-spanning lease (keyed by the run's thread) ----
test('pure: segment end keeps the lease and pushes the expiry; run end releases only that thread', () => {
  let l = L.leaseStart(L.createLease(), 'T1', 1000)
  l = L.leaseSegmentEnd(l, 'T1', 5000)
  assert.equal(l.state, 'agent'); assert.equal(l.lastBeatAt, 5000); assert.equal(l.generation, 1)
  l = L.leaseStart(l, 'T1', 11000)
  assert.deepEqual([l.state, l.generation, [...l.tasks].length], ['agent', 1, 1], 'second segment is the same lease')
  assert.equal(L.leaseEnd(l, 'T2'), l, 'another thread ending changes nothing')
  const e = L.leaseEnd(l, 'T1'); assert.deepEqual([e.state, e.reason], ['person', 'task-end'])
  assert.equal(L.leaseEnd(L.createLease(), 'T1').state, 'person')
  assert.equal(L.leaseSegmentEnd(L.createLease(), 'T1', 5).state, 'person')
})

test('wiring: two segments in one thread stay agent between them; run end, handoff, other thread, expiry', () => {
  const h = harness(), c = h.card._cardLease
  const frames = (phase, key = 'T1') => phase === 'start' ? c.start(key, {}) : c.segmentEnd(key, {})
  frames('start'); frames('stop')
  assert.equal(c.state().state, 'agent', 'held while the chat model thinks between segments'); assert.equal(h.body.shield.hidden, false)
  assert.equal(h.fire('click', h.xulBrowser).defaultPrevented, true, 'person click still blocked between segments')
  frames('start'); assert.equal(c.state().generation, 1); frames('stop')
  c.endRun('T2'); assert.equal(c.state().state, 'agent', 'another thread run end does not release')
  c.endRun('T1'); assert.equal(c.state().state, 'person'); assert.equal(h.body.shield.hidden, true)
  assert.equal(h.fire('click', h.xulBrowser).defaultPrevented, false)
  // handoff mid-run releases at once, even right after a segment ended
  frames('start'); frames('stop'); c.segmentEnd('T1', { handoff: true }); assert.equal(c.state().state, 'handoff')
  // expiry still works after a segment end
  frames('start'); frames('stop')
  const timer = h.win.timers.filter(Boolean).at(-1)
  const realNow = Date.now; Date.now = () => realNow() + L.CARD_LEASE_EXPIRY_MS + 1
  try { timer.f() } finally { Date.now = realNow }
  assert.deepEqual([c.state().state, c.state().reason], ['person', 'expired'])
})

// ---- round f fixes: only human_step is a release; focus never enters the page while blocked ----
test('handoff filter: needs_value / low_confidence / needs_user keep the lease, human_step releases', () => {
  const step = (status, extra = {}) => ({ op: 'handoff', status, reason: status, ...extra })
  for (const s of ['needs_value', 'low_confidence', 'needs_user']) assert.equal(L.stepIsHumanStep(step(s)), false, s)
  assert.equal(L.stepIsHumanStep(step('human_step')), true)
  assert.equal(L.stepIsHumanStep({ op: 'handoff', status: 'needs_value', code: 'human_step' }), true)
  assert.equal(L.stepIsHumanStep({ op: 'end', status: 'needs_value', code: 'detail_needed' }), false)
  assert.equal(L.stepIsHumanStep(null), false)
  assert.match(js, /if \(event\.cardId && CardLease\.stepIsHumanStep\(event\)\)/)
  assert.doesNotMatch(js, /event\.op === 'handoff' \|\| event\.status === 'human_step'/)
  // end to end on the card: a needs_value handoff mid-run changes nothing, human_step releases at once
  const h = harness(), c = h.card._cardLease
  c.start('T1', {}); c.segmentEnd('T1', {})
  if (L.stepIsHumanStep(step('needs_value'))) c.handoff()
  assert.equal(c.state().state, 'agent')
  if (L.stepIsHumanStep(step('low_confidence'))) c.handoff()
  assert.equal(c.state().state, 'agent')
  if (L.stepIsHumanStep(step('human_step'))) c.handoff()
  assert.equal(c.state().state, 'handoff')
})

test('IME bypass: focus entering the page while blocked is blurred at once; not blurred otherwise', () => {
  const h = harness(), c = h.card._cardLease
  // not blocked: focus stays
  h.document.activeElement = h.xulBrowser
  h.fire('focus', h.xulBrowser); h.fire('focusin', h.xulBrowser)
  assert.equal(h.xulBrowser.blurred, 0, 'person lease never blurs')
  c.start('T1', {})
  const afterStart = h.xulBrowser.blurred
  h.document.activeElement = h.xulBrowser // e.g. toolBrowser().focus() or Tab navigation
  h.fire('focus', h.xulBrowser)
  assert.equal(h.xulBrowser.blurred, afterStart + 1); assert.equal(h.document.activeElement, null)
  h.document.activeElement = h.xulBrowser
  h.fire('focusin', h.wrap.children[0] || h.xulBrowser)
  assert.equal(h.xulBrowser.blurred, afterStart + 2)
  // focus on the pause control or anything outside the page area is left alone
  h.document.activeElement = h.pauseBtn
  h.fire('focus', h.pauseBtn); h.fire('focusin', h.pauseBtn)
  assert.equal(h.xulBrowser.blurred, afterStart + 2); assert.equal(h.document.activeElement, h.pauseBtn)
  // released: listeners gone, focus may enter again
  c.pause()
  assert.equal(h.listeners.get('focus').size, 0); assert.equal(h.listeners.get('focusin').size, 0)
  h.document.activeElement = h.xulBrowser; h.fire('focus', h.xulBrowser)
  assert.equal(h.xulBrowser.blurred, afterStart + 2)
  assert.equal(L.leaseShouldBlurFocus(L.createLease(), { inPageArea: true }), false)
  assert.equal(L.leaseShouldBlurFocus(L.leaseStart(L.createLease(), 'a', 1), { inPageArea: true }), true)
  assert.equal(L.leaseShouldBlurFocus(L.leaseStart(L.createLease(), 'a', 1), { inPageArea: false }), false)
})
