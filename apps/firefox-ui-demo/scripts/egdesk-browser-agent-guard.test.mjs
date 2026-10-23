import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis.JSWindowActorChild ||= class {}
globalThis.JSWindowActorParent ||= class {}
const { EGDeskBrowserAgentRuntimeChild } = await import('../overlay/resources/EGDeskBrowserAgentRuntimeChild.sys.mjs')
const { EGDeskBrowserAgentRuntimeParent, registerBrowserActionAuthorizer } =
  await import('../overlay/resources/EGDeskBrowserAgentRuntimeParent.sys.mjs')

function localDocumentFixture() {
  const actor = new EGDeskBrowserAgentRuntimeChild()
  const pendingMutations = []
  const countNode = { nodeValue: 'Count: 0' }
  let clicks = 0, inputEvents = 0, focusCalls = 0
  const buttonClickListeners = new Set(), inputClickListeners = new Set()
  const doc = { title: 'Isolated local document', readyState: 'complete' }
  const rect = { left: 20, top: 30, width: 100, height: 32 }
  const button = {
    ownerDocument: doc, isConnected: true, tagName: 'BUTTON', innerText: 'Increment', disabled: false,
    getAttribute() { return null }, getBoundingClientRect() { return rect },
    dispatchEvent() { return true }, focus() { focusCalls++ },
    addEventListener(name, fn) { if (name === 'click') buttonClickListeners.add(fn) },
    removeEventListener(name, fn) { if (name === 'click') buttonClickListeners.delete(fn) },
    scrollIntoView() {}, click() {
      for (const listener of buttonClickListeners) listener({ target: this })
      clicks++; countNode.nodeValue = `Count: ${clicks}`; pendingMutations.push({})
    },
    contains(node) { return node === this },
  }
  const input = {
    ownerDocument: doc, isConnected: true, tagName: 'INPUT', type: 'text', value: '', disabled: false,
    getAttribute(name) { return name === 'type' ? 'text' : name === 'placeholder' ? 'Note' : null },
    getBoundingClientRect() { return { left: 20, top: 80, width: 160, height: 30 } },
    dispatchEvent(event) { if (event.name === 'input' || event.name === 'change') inputEvents++; return true },
    focus() { focusCalls++ }, scrollIntoView() {}, contains(node) { return node === this },
    addEventListener(name, fn) { if (name === 'click') inputClickListeners.add(fn) },
    removeEventListener(name, fn) { if (name === 'click') inputClickListeners.delete(fn) },
    click() { for (const listener of inputClickListeners) listener({ target: this }) },
  }
  countNode.parentElement = button
  doc.body = { getBoundingClientRect() { return { width: 720, height: 480 } } }
  doc.documentElement = { getBoundingClientRect() { return { width: 720, height: 480 } } }
  doc.activeElement = doc.body
  doc.querySelectorAll = () => [button, input]
  doc.elementFromPoint = (x, y) => x >= 20 && y >= 30 && y <= 62 ? button : input
  doc.createTreeWalker = (_root, _what, filter) => {
    let seen = false
    return { nextNode() { if (seen) return null; seen = true; return filter.acceptNode(countNode) === 1 ? countNode : null } }
  }
  const win = {
    location: { href: 'data:text/html,isolated-fixture' }, innerWidth: 720, innerHeight: 480, devicePixelRatio: 1,
    getComputedStyle(node) { return { display: 'block', visibility: 'visible', opacity: node?.opacity ?? '1' } },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return pendingMutations.splice(0) } },
    Event: class { constructor(name) { this.name = name } },
    MouseEvent: class { constructor(name) { this.name = name } },
    PointerEvent: class { constructor(name) { this.name = name } },
    setTimeout,
  }
  actor.document = doc
  actor.contentWindow = win
  actor.sendQuery = async () => ({ authorized: true })
  return { actor, button, input, win, pendingMutations, get clicks() { return clicks },
    get inputEvents() { return inputEvents }, get focusCalls() { return focusCalls } }
}

function qaCounterOptions(f) {
  const fixtureUrl = 'http://127.0.0.1:39220/egdesk-qa/QA_URL_0123456789abcdef';
  const fixtureMarker = 'QA_DOM_0123456789abcdef';
  f.win.location.href = fixtureUrl;
  f.actor.document.getElementById = id => id === 'fixture-marker' ? { textContent: fixtureMarker } : null;
  return { qaDiagnostics: { fixtureUrl, fixtureMarker } };
}

test('perform-entry diagnostic is opt-in, exact-fixture scoped, and advances for actual actions', async () => {
  const f = localDocumentFixture(), qa = qaCounterOptions(f);
  assert.equal(f.actor.snapshot().qaDiagnostics, undefined);
  for (const changed of [{ fixtureMarker: 'QA_DOM_wrong0123456789abcdef' },
    { fixtureUrl: qa.qaDiagnostics.fixtureUrl + '?changed=1' }]) {
    assert.equal(f.actor.snapshot({ qaDiagnostics: { ...qa.qaDiagnostics, ...changed } }).qaDiagnostics, undefined);
  }
  const before = f.actor.snapshot(qa);
  assert.deepEqual(before.qaDiagnostics, { kind: 'actor-perform-entry', actorDocumentId: before.documentId, performCalls: 0 });
  const button = before.interactiveElements.find(item => item.role === 'button');
  await f.actor.act({ type: 'click', ref: button.ref }, guarded(guardFrom(before, button)));
  assert.equal(f.clicks, 1);
  assert.equal(f.actor.snapshot(qa).qaDiagnostics.performCalls, 1);
  f.win.location.href = 'https://example.invalid/egdesk-qa/QA_URL_0123456789abcdef';
  assert.equal(f.actor.snapshot(qa).qaDiagnostics, undefined);
});

test('DOM, viewport, expiry and revoked authority denials never enter perform', async () => {
  for (const reason of ['dom', 'viewport', 'expiry', 'authority']) {
    const f = localDocumentFixture(), qa = qaCounterOptions(f), before = f.actor.snapshot(qa);
    const button = before.interactiveElements.find(item => item.role === 'button');
    const options = guarded(guardFrom(before, button));
    if (reason === 'dom') f.pendingMutations.push({});
    if (reason === 'viewport') f.win.innerWidth++;
    if (reason === 'expiry') options.lease.deadlineMs = 0;
    if (reason === 'authority') f.actor.sendQuery = async () => ({ authorized: false, reason: 'ui-denied' });
    await assert.rejects(f.actor.act({ type: 'click', ref: button.ref }, options), /stale|expired|revoked/i);
    assert.equal(f.actor.snapshot(qa).qaDiagnostics.performCalls, before.qaDiagnostics.performCalls, reason);
    assert.equal(f.clicks, 0, reason);
    assert.equal(f.inputEvents, 0, reason);
  }
});

function guardFrom(snapshot, target = null) {
  return { documentId: snapshot.documentId, revision: snapshot.revision,
    viewport: snapshot.viewport, url: snapshot.url,
    focusedRef: snapshot.focusedElement?.ref || null, target }
}

const guarded = guard => ({ guard, lease: { leaseId: 'lease-local', requestId: 'request-local',
  deadlineMs: Date.now() + 10000 }, settleMs: 0 })

test('guarded native Browser actor changes isolated local DOM exactly once and returns post-observation', async () => {
  const f = localDocumentFixture()
  const before = f.actor.snapshot()
  assert.equal(before.coordinateSpace, 'browser-viewport-local')
  const button = before.interactiveElements.find(item => item.role === 'button')
  const clicked = await f.actor.act({ type: 'click', ref: button.ref },
    guarded(guardFrom(before, button)))
  assert.equal(f.clicks, 1, 'one model click must never dispatch duplicate click effects')
  assert.equal(clicked.result.clickDiagnostics.targetClickObserved, true)
  assert.equal(clicked.after.text[0], 'Count: 1')
  assert.equal(clicked.observation.newVisibleText[0], 'Count: 1')
  assert.equal(f.focusCalls, 0, 'guarded action does not call global or content focus')

  const observedAgain = f.actor.snapshot()
  const input = observedAgain.interactiveElements.find(item => item.tag === 'input')
  const filled = await f.actor.act({ type: 'fill', ref: input.ref, text: 'local note' },
    guarded(guardFrom(observedAgain, input)))
  assert.equal(f.input.value, 'local note')
  assert.equal(filled.after.interactiveElements.find(item => item.ref === input.ref).value, 'local note')
  assert.equal(filled.after.revision, observedAgain.revision,
    'a property-only input value change need not produce a MutationObserver revision')
  assert.equal(f.inputEvents, 2)
  assert.equal(f.focusCalls, 0)
})

test('guarded click uses one DOM activation without Gecko mousedown or focus', async () => {
  const f = localDocumentFixture()
  const targeted = [], topLevel = []
  f.win.windowUtils = {
    sendMouseEventToWindow(...args) { targeted.push(args) },
    sendMouseEvent(...args) { topLevel.push(args) },
  }
  const before = f.actor.snapshot()
  const button = before.interactiveElements.find(item => item.role === 'button')
  const result = await f.actor.act({ type: 'click', ref: button.ref },
    guarded(guardFrom(before, button)))
  assert.equal(targeted.length, 0, 'guarded model input never sends Gecko mousedown')
  assert.equal(topLevel.length, 0, 'overlapping Cards must not receive top-level widget input')
  assert.equal(f.clicks, 1)
  assert.equal(result.result.clickDiagnostics.dispatchScope, 'dom-click-no-pointerdown')
  assert.equal(result.after.text[0], 'Count: 1')
  assert.equal(f.focusCalls, 0)
})

test('unguarded internal click retains its existing single DOM fallback', () => {
  const f = localDocumentFixture()
  let topLevelCalls = 0
  f.win.windowUtils = { sendMouseEvent() { topLevelCalls++ } }
  const before = f.actor.snapshot()
  const button = before.interactiveElements.find(item => item.role === 'button')
  const result = f.actor.perform({ type: 'click', ref: button.ref })
  assert.equal(topLevelCalls, 0)
  assert.equal(f.clicks, 1)
  assert.equal(result.clickDiagnostics.dispatchScope, 'dom-fallback')
  assert.equal(f.focusCalls, 1, 'the legacy unguarded route remains distinct from model input')
})

test('unguarded per-window mouse completion alone is not DOM change evidence', () => {
  const f = localDocumentFixture()
  const mouseEvents = []
  f.win.windowUtils = { sendMouseEventToWindow: (...args) => { mouseEvents.push(args) } }
  const before = f.actor.snapshot()
  const button = before.interactiveElements.find(item => item.role === 'button')
  const result = f.actor.perform({ type: 'click', ref: button.ref })
  assert.deepEqual(mouseEvents.map(event => event[0]), ['mousemove', 'mousedown', 'mouseup'])
  assert.equal(result.clickDiagnostics.usedWindowUtils, true)
  assert.equal(result.clickDiagnostics.dispatchScope, 'document-window')
  assert.equal(f.clicks, 0, 'the mocked widget delivered no page click')
  assert.equal(f.actor.snapshot().text[0], 'Count: 0')
})

test('guarded click on a standard input leaves a simulated Chat composer as keyboard recipient', async () => {
  const f = localDocumentFixture()
  const composer = { focused: true, value: 'draft', blurCount: 0 }
  f.input.focus = () => { composer.focused = false; composer.blurCount++ }
  f.win.windowUtils = { sendMouseEventToWindow() { composer.focused = false; composer.blurCount++ } }
  const before = f.actor.snapshot()
  const input = before.interactiveElements.find(item => item.tag === 'input')
  const result = await f.actor.act({ type: 'click', ref: input.ref },
    guarded(guardFrom(before, input)))
  assert.equal(result.result.clickDiagnostics.targetClickObserved, true)
  assert.equal(result.after.interactiveElements.find(item => item.ref === input.ref)?.value, '')
  assert.equal(composer.focused, true)
  assert.equal(composer.blurCount, 0)
  if (composer.focused) composer.value += 'x'
  assert.equal(composer.value, 'draftx', 'this is a pure routing repro, not real Firefox focus proof')
})

test('guarded click without a DOM activation method fails closed and never uses mouse fallback', async () => {
  const f = localDocumentFixture()
  let mouseEvents = 0
  f.win.windowUtils = { sendMouseEventToWindow() { mouseEvents++ } }
  const before = f.actor.snapshot()
  const button = before.interactiveElements.find(item => item.role === 'button')
  f.button.click = undefined
  await assert.rejects(f.actor.act({ type: 'click', ref: button.ref },
    guarded(guardFrom(before, button))), /no focus-safe DOM click/)
  assert.equal(mouseEvents, 0)
  assert.equal(f.focusCalls, 0)
})

test('site-script focus during DOM activation remains visible as an exception', async () => {
  const f = localDocumentFixture()
  const before = f.actor.snapshot()
  const button = before.interactiveElements.find(item => item.role === 'button')
  const originalClick = f.button.click
  f.button.click = () => { originalClick(); f.actor.document.activeElement = f.input }
  const result = await f.actor.act({ type: 'click', ref: button.ref },
    guarded(guardFrom(before, button)))
  assert.equal(result.after.text[0], 'Count: 1')
  assert.equal(result.observation.focusedElementChanged, true)
  assert.equal(result.after.focusedElement?.role, 'textbox')
})

test('expired-lease diagnostic checks the live target guard without physical input', async () => {
  const f = localDocumentFixture()
  const before = f.actor.snapshot()
  const button = before.interactiveElements.find(item => item.role === 'button')
  const expired = { guard: guardFrom(before, button), lease: {
    leaseId: 'qa-expired-probe', requestId: 'qa-expired-probe', deadlineMs: 0,
  }, settleMs: 0 }
  await assert.rejects(f.actor.act({ type: 'click', ref: button.ref }, expired), /lease is missing or expired/)
  assert.equal(f.clicks, 0)
  assert.equal(f.focusCalls, 0)
  f.pendingMutations.push({})
  await assert.rejects(f.actor.act({ type: 'click', ref: button.ref }, expired), /observation is stale/)
  assert.equal(f.clicks, 0, 'the stale-guard branch also precedes all physical input')
})

test('document mutation, real viewport resize, target change and occlusion reject old actions', async () => {
  const f = localDocumentFixture()
  const before = f.actor.snapshot()
  const button = before.interactiveElements[0]
  f.pendingMutations.push({})
  await assert.rejects(f.actor.act({ type: 'click', ref: button.ref },
    guarded(guardFrom(before, button))), /stale/)
  assert.equal(f.clicks, 0)
  const afterMutation = f.actor.snapshot()
  f.win.canvasCameraScale = 0.5
  assert.equal(f.actor.snapshot().revision, afterMutation.revision,
    'Canvas camera movement must not change Browser document or viewport revision')
  f.win.innerWidth = 1280
  await assert.rejects(f.actor.act({ type: 'click', ref: button.ref },
    guarded(guardFrom(afterMutation, button))), /stale/)
  const afterResize = f.actor.snapshot()
  f.button.innerText = 'Different action'
  await assert.rejects(f.actor.act({ type: 'click', ref: button.ref },
    guarded(guardFrom(afterResize, button))), /target changed/)
  f.button.innerText = 'Increment'
  const current = f.actor.snapshot()
  f.actor.document.elementFromPoint = () => f.input
  await assert.rejects(f.actor.act({ type: 'click', ref: button.ref },
    guarded(guardFrom(current, button))), /obscured/)
  assert.equal(f.clicks, 0)
})

test('page zoom and document replacement invalidate observations independently of Canvas camera', () => {
  const f = localDocumentFixture()
  const before = f.actor.snapshot()
  f.win.devicePixelRatio = 1.5
  assert.notEqual(f.actor.snapshot().revision, before.revision)
  const afterZoom = f.actor.snapshot()
  f.actor.document = { ...f.actor.document }
  const afterDocument = f.actor.snapshot()
  assert.notEqual(afterDocument.documentId, afterZoom.documentId)
})

test('human focus change invalidates a model action without taking focus back', async () => {
  const f = localDocumentFixture()
  const before = f.actor.snapshot()
  const button = before.interactiveElements[0]
  f.actor.document.activeElement = f.input
  await assert.rejects(f.actor.act({ type: 'click', ref: button.ref },
    guarded(guardFrom(before, button))), /stale/)
  assert.equal(f.clicks, 0)
  assert.equal(f.focusCalls, 0)
})

test('fieldset-disabled and aria-disabled ancestor controls are observed and guarded as unavailable', async () => {
  for (const reason of ['fieldset', 'aria-ancestor']) {
    const f = localDocumentFixture()
    const before = f.actor.snapshot()
    const button = before.interactiveElements.find(item => item.role === 'button')
    if (reason === 'fieldset') f.button.matches = selector => selector === ':disabled'
    else f.button.parentElement = { parentElement: f.actor.document.body,
      getAttribute: name => name === 'aria-disabled' ? 'true' : null }
    assert.equal(f.actor.snapshot().interactiveElements.find(item => item.ref === button.ref).disabled, true, reason)
    await assert.rejects(f.actor.act({ type: 'click', ref: button.ref },
      guarded(guardFrom(before, button))), /unavailable|disabled/i, reason)
    assert.equal(f.clicks, 0, reason)
    assert.equal(f.actor.actorPerformCalls, 0, reason)
  }
})

test('guarded fill rejects a button and a read-only field before entering perform', async () => {
  for (const reason of ['button', 'read-only']) {
    const f = localDocumentFixture()
    if (reason === 'button') f.button.value = 'original'
    else f.input.readOnly = true
    const before = f.actor.snapshot()
    const target = before.interactiveElements.find(item => item.tag === (reason === 'button' ? 'button' : 'input'))
    await assert.rejects(f.actor.act({ type: 'fill', ref: target.ref, text: 'changed' },
      guarded(guardFrom(before, target))), /editable|read.only/i, reason)
    assert.equal(reason === 'button' ? f.button.value : f.input.value,
      reason === 'button' ? 'original' : '', reason)
    assert.equal(f.actor.actorPerformCalls, 0, reason)
    assert.equal(f.inputEvents, 0, reason)
  }
})

test('password, token and editable controls redact every snapshot label, value, focus and text path', () => {
  const f = localDocumentFixture()
  const password = 'PASSWORD_CANARY_DO_NOT_EXPOSE'
  f.input.type = 'password'
  f.input.value = password
  f.input.getAttribute = name => name === 'type' ? 'password' : name === 'aria-label' ? password : null
  f.actor.document.activeElement = f.input
  let seen = f.actor.snapshot()
  const field = seen.interactiveElements.find(item => item.tag === 'input')
  assert.equal(field.label, 'Sensitive field')
  assert.equal(field.value, '')
  assert.equal(seen.focusedElement.label, 'Sensitive field')
  assert.equal(seen.focusedElement.value, '')
  assert(!JSON.stringify(seen).includes(password))
  assert.throws(() => f.actor.assertGuard({ type: 'fill', ref: field.ref }, guardFrom(seen, field)),
    /Sensitive fields/)
  assert.equal(f.input.value, password)

  const token = 'TOKEN_CANARY_DO_NOT_EXPOSE'
  f.input.type = 'text'
  f.input.value = token
  f.input.getAttribute = name => name === 'type' ? 'text' : name === 'name' ? 'sessionToken' :
    name === 'aria-label' ? token : null
  seen = f.actor.snapshot()
  assert(!JSON.stringify(seen).includes(token))

  for (const name of ['creditCardNumber', 'ssn', 'PAN', 'socialSecurityNumber']) {
    const canary = `SENSITIVE_${name}_CANARY`
    f.input.value = canary
    f.input.getAttribute = key => key === 'type' ? 'text' : key === 'name' ? name : null
    seen = f.actor.snapshot()
    assert.equal(seen.interactiveElements.find(item => item.tag === 'input').label, 'Sensitive field')
    assert(!JSON.stringify(seen).includes(canary), `${name} value must be masked`)
  }

  const editable = { isContentEditable: true, tagName: 'DIV', parentElement: f.actor.document.body,
    ownerDocument: f.actor.document, isConnected: true,
    innerText: 'EDITABLE_CANARY_DO_NOT_EXPOSE', textContent: 'EDITABLE_CANARY_DO_NOT_EXPOSE',
    getAttribute() { return null },
    getBoundingClientRect() { return { width: 100, height: 20 } } }
  f.actor.document.querySelectorAll = () => [f.button, f.input, editable]
  const secretText = { nodeValue: 'EDITABLE_CANARY_DO_NOT_EXPOSE', parentElement: editable }
  const visibleText = { nodeValue: 'Public count', parentElement: f.button }
  f.actor.document.createTreeWalker = (_root, _what, filter) => {
    const nodes = [secretText, visibleText]
    return { nextNode() {
      while (nodes.length) {
        const node = nodes.shift()
        if (filter.acceptNode(node) === 1) return node
      }
      return null
    } }
  }
  seen = f.actor.snapshot()
  assert(!JSON.stringify(seen).includes('EDITABLE_CANARY_DO_NOT_EXPOSE'))
  const editableControl = seen.interactiveElements.find(item => item.tag === 'div')
  assert.equal(editableControl.label, 'Sensitive field')
  assert.equal(editableControl.value, '')
  assert(seen.text.includes('Public count'))
})

test('opacity-zero ordinary and composed-shadow ancestors hide text without hiding normal text', () => {
  const f = localDocumentFixture()
  const hiddenParent = { opacity: '0', parentElement: f.actor.document.body,
    getBoundingClientRect() { return { width: 100, height: 20 } } }
  const shadowHost = { opacity: '0', parentElement: f.actor.document.body,
    getBoundingClientRect() { return { width: 100, height: 20 } } }
  const shadowChild = { parentElement: null, getRootNode: () => ({ host: shadowHost }),
    getBoundingClientRect() { return { width: 100, height: 20 } } }
  const nodes = [
    { nodeValue: 'HIDDEN_PARENT_CANARY', parentElement: hiddenParent },
    { nodeValue: 'HIDDEN_SHADOW_CANARY', parentElement: shadowChild },
    { nodeValue: 'Normal visible text', parentElement: f.button },
  ]
  f.actor.document.createTreeWalker = (_root, _what, filter) => {
    const remaining = [...nodes]
    return { nextNode() {
      while (remaining.length) {
        const node = remaining.shift()
        if (filter.acceptNode(node) === 1) return node
      }
      return null
    } }
  }
  const seen = f.actor.snapshot()
  assert.deepEqual(seen.text, ['Normal visible text'])
  assert.equal(f.actor.isVisible(shadowChild), false)
})

test('actor rejects javascript/data/file navigation and accepts only absolute http(s)', () => {
  const f = localDocumentFixture()
  for (const url of ['javascript:alert(1)', 'data:text/html,fixture', 'file:///tmp/fixture.html']) {
    assert.throws(() => f.actor.perform({ type: 'navigate', url }), /http\(s\)/)
  }
  assert.deepEqual(f.actor.perform({ type: 'navigate', url: 'http://127.0.0.1:18181/fixture' }), { ok: true })
  assert.equal(f.win.location.href, 'http://127.0.0.1:18181/fixture')
})

test('actor rechecks live parent authority and deadline after delayed query, before physical input', async () => {
  for (const invalidation of ['cancelled', 'account-changed', 'deadline']) {
    const f = localDocumentFixture()
    const before = f.actor.snapshot()
    const button = before.interactiveElements[0]
    let release
    f.actor.sendQuery = () => new Promise(resolve => { release = resolve })
    let clockMs = Date.now()
    f.actor.nowMs = () => clockMs
    const options = { guard: guardFrom(before, button), lease: { leaseId: 'lease-pending',
      requestId: 'request-pending', deadlineMs: clockMs + 1000 }, settleMs: 0 }
    const action = f.actor.act({ type: 'click', ref: button.ref }, options)
    await Promise.resolve()
    assert.equal(typeof release, 'function')
    if (invalidation === 'deadline') clockMs += 1001
    release({ authorized: invalidation === 'deadline' })
    await assert.rejects(action, /authority was revoked/)
    assert.equal(f.clicks, 0)
  }
})

test('focus, disabled state and document changes during parent approval prevent late input', async () => {
  for (const change of ['focus', 'disabled', 'document']) {
    const f = localDocumentFixture()
    const before = f.actor.snapshot()
    const button = before.interactiveElements.find(item => item.role === 'button')
    let approve
    f.actor.sendQuery = () => new Promise(resolve => { approve = resolve })
    const pending = f.actor.act({ type: 'click', ref: button.ref }, guarded(guardFrom(before, button)))
    if (change === 'focus') f.actor.document.activeElement = f.input
    if (change === 'disabled') f.button.disabled = true
    if (change === 'document') f.actor.document = { ...f.actor.document }
    approve({ authorized: true })
    await assert.rejects(pending, /stale|unavailable/i, change)
    assert.equal(f.clicks, 0, change)
    assert.equal(f.actor.actorPerformCalls, 0, change)
  }
})

test('parent actor delegates only its exact embedded Browser to privileged UI authority', () => {
  const parent = new EGDeskBrowserAgentRuntimeParent()
  const ownerDocument = { nodePrincipal: { isSystemPrincipal: true } }
  let unload
  const ownerWindow = { document: ownerDocument,
    addEventListener(name, fn) { if (name === 'unload') unload = fn },
    removeEventListener(name, fn) { if (name === 'unload' && unload === fn) unload = null },
  }
  ownerDocument.defaultView = ownerWindow
  const card = { isConnected: true }
  const browser = { localName: 'browser', isConnected: true, ownerDocument,
    browsingContext: { id: 101 }, closest: selector => selector === '.egd-browser-card' ? card : null }
  const unregister = registerBrowserActionAuthorizer(browser, ownerWindow,
    request => request.browser === browser && request.leaseId === 'lease-a')
  parent.browsingContext = { top: { embedderElement: browser } }
  parent.browsingContext.id = 101
  parent.manager = { id: 'window-global-a' }
  assert.deepEqual(parent.receiveMessage({ name: 'authorizeAct', data: { leaseId: 'lease-a' } }),
    { authorized: true, reason: 'approved' })
  assert.deepEqual(parent.receiveMessage({ name: 'authorizeAct', data: { leaseId: 'other' } }),
    { authorized: false, reason: 'ui-denied' })
  unload()
  unregister()
  browser.ownerGlobal = { __egdesk: { browserAgentTools: {
    authorizePhysicalAction: () => true,
  } } }
  assert.deepEqual(parent.receiveMessage({ name: 'authorizeAct', data: { leaseId: 'lease-a' } }),
    { authorized: false, reason: 'missing-authorizer' },
    'an expando is never an authority fallback after exact chrome registration ends')
  const webDocument = { nodePrincipal: { isSystemPrincipal: false } }
  const webWindow = { document: webDocument, addEventListener() {}, removeEventListener() {} }
  webDocument.defaultView = webWindow
  assert.throws(() => registerBrowserActionAuthorizer({ ...browser,
    ownerDocument: webDocument }, webWindow, () => true), /chrome-owned Browser Card/)
})
