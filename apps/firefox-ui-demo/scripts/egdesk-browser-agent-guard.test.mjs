import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis.JSWindowActorChild ||= class {}
globalThis.JSWindowActorParent ||= class {}
const { EGDeskBrowserAgentRuntimeChild } = await import('../overlay/resources/EGDeskBrowserAgentRuntimeChild.sys.mjs')
const parentModule = await import('../overlay/resources/EGDeskBrowserAgentRuntimeParent.sys.mjs')
const { EGDeskBrowserAgentRuntimeParent, registerBrowserActionAuthorizer } = parentModule
const { boundedFieldValue } = await import('../helper/egdesk-browser-tool-runtime.mjs')

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

function presentationFixture() {
  const f = localDocumentFixture()
  const { actor, win } = f
  actor.presentationMetricNowMs = () => 0
  const doc = actor.document
  doc.body.nodeType = 1
  doc.body.tagName = 'BODY'
  doc.body.openOrClosedShadowRoot = null
  doc.body.parentElement = doc.documentElement
  doc.body.getAttribute = () => null
  doc.documentElement.nodeType = 1
  doc.documentElement.tagName = 'HTML'
  doc.documentElement.openOrClosedShadowRoot = null
  doc.documentElement.getAttribute = () => null
  doc.documentElement.firstChild = doc.body
  const append = (parent, child) => {
    child.parentElement = parent
    if (!parent.firstChild) parent.firstChild = child
    else {
      let sibling = parent.firstChild
      while (sibling.nextSibling) sibling = sibling.nextSibling
      sibling.nextSibling = child
    }
    return child
  }
  const element = (parent, tagName = 'DIV', metricStyle = {}, attributes = {}) => append(parent, {
    nodeType: 1, tagName, metricStyle, hidden: false, inert: false,
    openOrClosedShadowRoot: null,
    getAttribute(name) { return attributes[name] ?? null },
    getBoundingClientRect() { return { left: 0, top: 0, width: 720, height: 480 } },
  })
  const textNode = (parent, value = 'Actual text', rect = { left: 10, top: 10, width: 100, height: 20 }) =>
    append(parent, { nodeType: 3, nodeValue: value, rects: [rect] })
  const textAt = (parent, fontPx, value = 'Actual text', rect) =>
    textNode(element(parent, 'SPAN', { fontSize: `${fontPx}px` }), value, rect)
  win.getComputedStyle = node => ({
    display: 'block', visibility: 'visible', opacity: '1', fontSize: '16px',
    transform: 'none', zoom: '1', scale: 'none', rotate: 'none', translate: 'none',
    contentVisibility: 'visible', overflowX: 'visible', overflowY: 'visible', position: 'static',
    ...node.metricStyle,
  })
  doc.createRange = () => {
    let selected
    return { selectNodeContents(node) { selected = node }, getClientRects() { return selected.rects } }
  }
  return { ...f, append, element, textNode, textAt }
}

test('presentationMetrics is an argument-free read-only system request, not an observation or action', async () => {
  const f = presentationFixture()
  f.textAt(f.actor.document.body, 16)
  f.actor.observationState = () => { throw new Error('observation generated') }
  f.actor.snapshot = () => { throw new Error('snapshot generated') }
  f.actor.act = () => { throw new Error('action entered') }
  f.actor.sendQuery = () => { throw new Error('parent authorization requested') }
  const documentId = f.actor.documentId
  const result = await f.actor.receiveMessage({ name: 'presentationMetrics',
    get data() { throw new Error('request arguments read') } })
  assert.deepEqual(result, { version: 1, fontPx: 16, viewportWidth: 720, viewportHeight: 480,
    sampleCount: 1, complete: true })
  assert.equal(f.actor.documentId, documentId)
  assert.equal(f.actor.revision, 1)
  assert.equal(f.actor.observedDocument, null)
  assert.equal(f.actor.refSeq, 0)
  assert.equal(f.actor.actorPerformCalls, 0)
  assert.equal(f.clicks, 0)
  assert.equal(f.inputEvents, 0)
  assert.equal(f.focusCalls, 0)
  assert.deepEqual(Object.keys(result), ['version', 'fontPx', 'viewportWidth', 'viewportHeight',
    'sampleCount', 'complete'])
})

test('presentationMetrics samples real viewport text rather than the 11px wrapper or only headlines', async () => {
  const f = presentationFixture()
  const wrapper = f.element(f.actor.document.body, 'DIV', { fontSize: '11px' })
  f.textAt(wrapper, 32, 'Headline')
  f.textAt(wrapper, 16, 'Readable body')
  assert.deepEqual(await f.actor.receiveMessage({ name: 'presentationMetrics' }),
    { version: 1, fontPx: 16, viewportWidth: 720, viewportHeight: 480,
      sampleCount: 2, complete: true })
  f.textAt(wrapper, 13, 'Smaller caption')
  assert.equal((await f.actor.receiveMessage({ name: 'presentationMetrics' })).fontPx, 13)
})

test('presentationMetrics excludes hidden, private, input and off-viewport text without returning content', async () => {
  const f = presentationFixture()
  const root = f.actor.document.body
  f.textAt(root, 16, 'PUBLIC_CANARY')
  f.textNode(f.element(root, 'SPAN', { fontSize: '3px', display: 'none' }), 'HIDDEN_CANARY')
  f.textNode(f.element(root, 'SPAN', { fontSize: '3px', opacity: '0' }), 'OPACITY_CANARY')
  f.textNode(f.element(root, 'SPAN', { fontSize: '3px' }, { 'aria-hidden': 'true' }), 'ARIA_CANARY')
  f.textNode(f.element(root, 'SPAN', { fontSize: '3px' }, { 'data-sensitive': 'true' }), 'PRIVATE_CANARY')
  f.textNode(f.element(root, 'INPUT', { fontSize: '3px' }), 'INPUT_CANARY')
  f.textNode(f.element(root, 'DIV', { fontSize: '3px', contentVisibility: 'hidden' }), 'CONTENT_CANARY')
  f.textAt(root, 3, 'OFFSCREEN_CANARY', { left: 900, top: 10, width: 50, height: 20 })
  const result = await f.actor.receiveMessage({ name: 'presentationMetrics' })
  assert.equal(result.fontPx, 16)
  assert.equal(result.sampleCount, 1)
  assert.equal(result.complete, true)
  assert(!JSON.stringify(result).includes('CANARY'))
})

test('presentationMetrics does not miss a visible descendant of a visibility-hidden parent', async () => {
  const f = presentationFixture()
  const parent = f.element(f.actor.document.body, 'DIV', { visibility: 'hidden' })
  f.textNode(parent, 'HIDDEN_DIRECT_CANARY')
  f.textNode(f.element(parent, 'SPAN', { visibility: 'visible', fontSize: '12px' }), 'Visible override')
  f.textAt(f.actor.document.body, 16, 'Main body')
  const result = await f.actor.receiveMessage({ name: 'presentationMetrics' })
  assert.equal(result.complete, true)
  assert.equal(result.fontPx, 12)
  assert.equal(result.sampleCount, 2)
})

test('presentationMetrics fails closed for unsupported transforms, zoom and malformed dimensions or font', async () => {
  for (const style of [{ transform: 'matrix(0.5, 0, 0, 0.5, 0, 0)' }, { zoom: '1.25' },
    { scale: '0.5' }, { fontSize: 'NaNpx' }]) {
    const f = presentationFixture()
    f.textNode(f.element(f.actor.document.body, 'SPAN', style), 'Visible')
    const result = await f.actor.receiveMessage({ name: 'presentationMetrics' })
    assert.equal(result.complete, false)
    assert.equal(result.fontPx, null)
  }
  for (const dimension of [0, -1, 0.5, NaN, Infinity]) {
    const f = presentationFixture()
    f.textAt(f.actor.document.body, 16)
    f.win.innerWidth = dimension
    const result = await f.actor.receiveMessage({ name: 'presentationMetrics' })
    assert.equal(result.complete, false)
    assert.equal(result.fontPx, null)
    assert.equal(result.viewportWidth, 0)
    assert.equal(result.viewportHeight, 0)
  }
  const f = presentationFixture()
  f.textAt(f.actor.document.body, 16, 'Visible', { left: NaN, top: 0, width: 20, height: 20 })
  assert.equal((await f.actor.receiveMessage({ name: 'presentationMetrics' })).complete, false)
})

test('presentationMetrics ignores a decorative transform that contains no sampled text', async () => {
  const f = presentationFixture()
  f.element(f.actor.document.body, 'DIV', { transform: 'matrix(0.5, 0, 0, 0.5, 0, 0)' })
  f.textAt(f.actor.document.body, 16)
  const result = await f.actor.receiveMessage({ name: 'presentationMetrics' })
  assert.equal(result.complete, true)
  assert.equal(result.fontPx, 16)
})

test('presentationMetrics fails closed on node, sample and time limits or no valid text', async () => {
  for (const limit of ['nodes', 'samples', 'time', 'empty']) {
    const f = presentationFixture()
    if (limit === 'nodes') for (let i = 0; i < 257; i++) f.element(f.actor.document.body)
    if (limit === 'samples') for (let i = 0; i < 65; i++) f.textAt(f.actor.document.body, 16)
    if (limit === 'time') {
      f.textAt(f.actor.document.body, 16)
      let clock = 0
      f.actor.presentationMetricNowMs = () => (clock += 5)
    }
    const result = await f.actor.receiveMessage({ name: 'presentationMetrics' })
    assert.equal(result.complete, false, limit)
    assert.equal(result.fontPx, null, limit)
    assert(result.sampleCount <= 64, limit)
  }
})

test('presentationMetrics accepts the exact traversal/sample caps but not one beyond', async () => {
  const nodes = presentationFixture()
  nodes.textAt(nodes.actor.document.body, 16)
  for (let i = 0; i < 252; i++) nodes.element(nodes.actor.document.body)
  assert.equal((await nodes.actor.receiveMessage({ name: 'presentationMetrics' })).complete, true)
  nodes.element(nodes.actor.document.body)
  assert.equal((await nodes.actor.receiveMessage({ name: 'presentationMetrics' })).complete, false)

  const samples = presentationFixture()
  for (let i = 0; i < 64; i++) samples.textAt(samples.actor.document.body, 16)
  const atCap = await samples.actor.receiveMessage({ name: 'presentationMetrics' })
  assert.equal(atCap.complete, true)
  assert.equal(atCap.sampleCount, 64)
  samples.textAt(samples.actor.document.body, 12)
  const pastCap = await samples.actor.receiveMessage({ name: 'presentationMetrics' })
  assert.equal(pastCap.complete, false)
  assert.equal(pastCap.fontPx, null)
  assert.equal(pastCap.sampleCount, 64)
})

test('presentationMetrics preserves CSS font px across DPR and rejects ancestor scale or stale document', async () => {
  const f = presentationFixture()
  const text = f.textAt(f.actor.document.body, 16)
  f.win.devicePixelRatio = 2
  assert.equal((await f.actor.receiveMessage({ name: 'presentationMetrics' })).fontPx, 16)
  f.actor.document.body.metricStyle = { zoom: '1.25' }
  assert.equal((await f.actor.receiveMessage({ name: 'presentationMetrics' })).complete, false)
  f.actor.document.body.metricStyle = {}
  const originalRects = f.actor.document.createRange
  f.actor.document.createRange = () => {
    const range = originalRects()
    return { selectNodeContents: range.selectNodeContents,
      getClientRects() { f.actor.document = { ...f.actor.document }; return text.rects } }
  }
  assert.equal((await f.actor.receiveMessage({ name: 'presentationMetrics' })).complete, false)
})

test('presentationMetrics does not claim complete coverage of a visible embedded document', async () => {
  const f = presentationFixture()
  f.textAt(f.actor.document.body, 16)
  const frame = f.element(f.actor.document.body, 'IFRAME')
  assert.equal((await f.actor.receiveMessage({ name: 'presentationMetrics' })).complete, false)
  frame.getBoundingClientRect = () => ({ left: 900, top: 10, width: 100, height: 100 })
  assert.equal((await f.actor.receiveMessage({ name: 'presentationMetrics' })).complete, true)
})

test('presentationMetrics cannot claim 16px when a closed shadow host may contain 8px text', async () => {
  const f = presentationFixture()
  f.textAt(f.actor.document.body, 16, 'Outside text')
  const host = f.element(f.actor.document.body, 'DIV')
  const shadow = { nodeType: 11, mode: 'closed', host }
  f.textAt(shadow, 8, 'Small shadow text')
  host.shadowRoot = null
  host.openOrClosedShadowRoot = shadow
  const result = await f.actor.receiveMessage({ name: 'presentationMetrics' })
  assert.equal(result.complete, false)
  assert.equal(result.fontPx, null)
})

test('presentationMetrics fails closed if the privileged shadow accessor is unavailable', async () => {
  const f = presentationFixture()
  f.textAt(f.actor.document.body, 16, 'Outside text')
  const host = f.element(f.actor.document.body, 'DIV')
  delete host.openOrClosedShadowRoot
  host.shadowRoot = null
  let result = await f.actor.receiveMessage({ name: 'presentationMetrics' })
  assert.equal(result.complete, false)
  assert.equal(result.fontPx, null)
  Object.defineProperty(host, 'openOrClosedShadowRoot', {
    get() { throw new Error('privileged accessor denied') },
  })
  result = await f.actor.receiveMessage({ name: 'presentationMetrics' })
  assert.equal(result.complete, false)
  assert.equal(result.fontPx, null)
})

test('presentationMetrics cannot prune an off-viewport overflow ancestor over fixed 8px text', async () => {
  const f = presentationFixture()
  f.textAt(f.actor.document.body, 16, 'Outside text')
  const parent = f.element(f.actor.document.body, 'DIV',
    { overflowX: 'hidden', overflowY: 'hidden' })
  parent.getBoundingClientRect = () => ({ left: 900, top: 10, width: 100, height: 100 })
  const fixed = f.element(parent, 'SPAN', { position: 'fixed', fontSize: '8px' })
  f.textNode(fixed, 'Visible fixed caption', { left: 20, top: 20, width: 100, height: 10 })
  const result = await f.actor.receiveMessage({ name: 'presentationMetrics' })
  assert.equal(result.complete, false)
  assert.equal(result.fontPx, null)
})

test('presentationMetrics cannot ignore fixed text outside a partially visible overflow clip', async () => {
  const f = presentationFixture()
  f.textAt(f.actor.document.body, 16, 'Outside text')
  const clipped = f.element(f.actor.document.body, 'DIV',
    { overflowX: 'hidden', overflowY: 'hidden' })
  clipped.getBoundingClientRect = () => ({ left: 0, top: 0, width: 50, height: 50 })
  const fixed = f.element(clipped, 'DIV', { position: 'fixed' })
  f.textAt(fixed, 8, 'Fixed text', { left: 100, top: 100, width: 80, height: 16 })
  const result = await f.actor.receiveMessage({ name: 'presentationMetrics' })
  assert.equal(result.complete, false)
  assert.equal(result.fontPx, null)
})

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
  // BRW-08: an editor is fillable, but its text never enters an observation:
  // no text label fallback, and a value of length and fingerprint only.
  assert.equal(editableControl.label, 'Editable text')
  assert.match(editableControl.value, /^\[editor text hidden: 29 chars, #[0-9a-f]{14}\]$/)
  assert(seen.text.includes('Public count'))
  editable.getAttribute = name => name === 'data-private' ? '' : null
  seen = f.actor.snapshot()
  assert.equal(seen.interactiveElements.find(item => item.tag === 'div').label, 'Sensitive field')
  assert.equal(seen.interactiveElements.find(item => item.tag === 'div').value, '')
  assert(!JSON.stringify(seen).includes('EDITABLE_CANARY_DO_NOT_EXPOSE'))
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

// Guarded scroll / press / wait / same-site navigation (BRW-05, BRW-06).
function interactionFixture() {
  const f = localDocumentFixture()
  const { win, input } = f
  Object.assign(win, { scrollX: 0, scrollY: 0, scrollMaxY: 1500 })
  const scrollCalls = []
  win.scrollBy = ({ top }) => { scrollCalls.push(['by', top]); win.scrollY = Math.min(win.scrollMaxY, Math.max(0, win.scrollY + top)) }
  win.scrollTo = ({ top }) => { scrollCalls.push(['to', top]); win.scrollY = Math.min(win.scrollMaxY, Math.max(0, top)) }
  win.KeyboardEvent = class { constructor(name, init) { Object.assign(this, init); this.name = name } }
  const keyEvents = [], keyListeners = new Set()
  let preventKeydown = false, submits = 0
  const inputDispatch = input.dispatchEvent.bind(input)
  input.dispatchEvent = event => {
    if (!(event instanceof win.KeyboardEvent)) return inputDispatch(event)
    keyEvents.push(`${event.name}:${event.key}`)
    if (event.name === 'keydown') for (const listener of keyListeners) listener(event)
    return !(event.name === 'keydown' && preventKeydown)
  }
  const inputAdd = input.addEventListener, inputRemove = input.removeEventListener
  input.addEventListener = (name, fn, capture) => name === 'keydown' ? keyListeners.add(fn) : inputAdd.call(input, name, fn, capture)
  input.removeEventListener = (name, fn, capture) => name === 'keydown' ? keyListeners.delete(fn) : inputRemove.call(input, name, fn, capture)
  input.form = { elements: [input], requestSubmit() { submits++ } }
  // Keep the base fixture's live counter getters (a spread would freeze them).
  return Object.defineProperties(f, { scrollCalls: { value: scrollCalls }, keyEvents: { value: keyEvents },
    preventKeydown: { value: value => { preventKeydown = value } }, submits: { get: () => submits } })
}
const scrollGuard = (snapshot, target = null) => ({ ...guardFrom(snapshot, target), scroll: snapshot.scroll })
const pressGuard = (snapshot, target, pressPolicy) => ({ ...guardFrom(snapshot, target), pressPolicy })
const inputItem = snapshot => snapshot.interactiveElements.find(item => item.tag === 'input')

test('guarded scroll moves only the document viewport with the DOM scroll API and no focus or pointer input', async () => {
  const f = interactionFixture()
  const mouse = []
  f.win.windowUtils = { sendMouseEventToWindow(...args) { mouse.push(args) }, sendMouseEvent(...args) { mouse.push(args) } }
  const before = f.actor.snapshot()
  assert.deepEqual(before.scroll, { x: 0, y: 0, maxY: 1500 })
  const down = await f.actor.act({ type: 'scroll', direction: 'down', amount: 'page' }, guarded(scrollGuard(before)))
  assert.deepEqual(down.result.dispatchDiagnostics, { inputRoute: 'dom-scroll-api', mode: 'document',
    scrollBefore: { x: 0, y: 0 }, scrollAfter: { x: 0, y: 432 }, maxScrollY: 1500 })
  assert.equal(down.after.scroll.y, 432)
  const middle = f.actor.snapshot()
  await f.actor.act({ type: 'scroll', direction: 'up', amount: 'half' }, guarded(scrollGuard(middle)))
  assert.equal(f.win.scrollY, 192)
  await f.actor.act({ type: 'scroll', direction: 'bottom', amount: 'page' }, guarded(scrollGuard(f.actor.snapshot())))
  assert.equal(f.win.scrollY, 1500)
  await f.actor.act({ type: 'scroll', direction: 'top', amount: 'page' }, guarded(scrollGuard(f.actor.snapshot())))
  assert.equal(f.win.scrollY, 0)
  assert.deepEqual(f.scrollCalls, [['by', 432], ['by', -240], ['to', 1500], ['to', 0]])
  assert.equal(mouse.length, 0)
  assert.equal(f.focusCalls, 0)
  assert.equal(f.clicks, 0)
  assert.equal(f.actor.actorPerformCalls, 4)
})

test('guarded scroll is stale after a human scroll, mutation or revoked authority, before any scroll call', async () => {
  for (const reason of ['human-scroll', 'mutation', 'authority', 'selector', 'no-scroll-guard']) {
    const f = interactionFixture()
    const before = f.actor.snapshot()
    const options = guarded(scrollGuard(before))
    const action = { type: 'scroll', direction: 'down', amount: 'page' }
    if (reason === 'human-scroll') f.win.scrollY = 100
    if (reason === 'mutation') f.pendingMutations.push({})
    if (reason === 'authority') f.actor.sendQuery = async () => ({ authorized: false, reason: 'ui-denied' })
    if (reason === 'selector') action.selector = 'body'
    if (reason === 'no-scroll-guard') delete options.guard.scroll
    await assert.rejects(f.actor.act(action, options), /stale|revoked|reference/i, reason)
    assert.deepEqual(f.scrollCalls, [], reason)
    assert.equal(f.actor.actorPerformCalls, 0, reason)
  }
})

test('guarded into-view scroll needs the exact observed element and reports whether it is in view', async () => {
  const f = interactionFixture()
  let intoView = 0
  f.input.scrollIntoView = () => { intoView++ }
  const before = f.actor.snapshot()
  const input = inputItem(before)
  const result = await f.actor.act({ type: 'scroll', ref: input.ref }, guarded(scrollGuard(before, input)))
  assert.deepEqual(result.result.dispatchDiagnostics, { inputRoute: 'dom-scroll-api', mode: 'into-view',
    scrollBefore: { x: 0, y: 0 }, scrollAfter: { x: 0, y: 0 }, targetInView: true })
  assert.equal(intoView, 1)
  const again = f.actor.snapshot()
  await assert.rejects(f.actor.act({ type: 'scroll', ref: input.ref },
    guarded(scrollGuard(again, { ...inputItem(again), label: 'Other' }))), /changed/)
  await assert.rejects(f.actor.act({ type: 'scroll', ref: input.ref, direction: 'down' },
    guarded(scrollGuard(again, inputItem(again)))), /reference/)
  assert.equal(intoView, 1)
  assert.equal(f.focusCalls, 0)
})

test('guarded press never focuses and needs the focused target or the field the last guarded action filled', async () => {
  const f = interactionFixture()
  const before = f.actor.snapshot()
  const input = inputItem(before)
  for (const policy of ['already-focused', 'after-fill', undefined]) {
    await assert.rejects(f.actor.act({ type: 'press', ref: input.ref, key: 'Escape' },
      guarded(pressGuard(before, input, policy))), /not focused|just filled|focus policy/, String(policy))
  }
  assert.deepEqual(f.keyEvents, [])
  assert.equal(f.actor.actorPerformCalls, 0)

  await f.actor.act({ type: 'fill', ref: input.ref, text: 'seoul' }, guarded(guardFrom(before, input)))
  const filled = f.actor.snapshot()
  const result = await f.actor.act({ type: 'press', ref: input.ref, key: 'Enter' },
    guarded(pressGuard(filled, inputItem(filled), 'after-fill')))
  assert.deepEqual(f.keyEvents, ['keydown:Enter', 'keypress:Enter', 'keyup:Enter'])
  assert.equal(f.submits, 1, 'Enter emulates implicit submission of a single-field form')
  assert.deepEqual(result.result.dispatchDiagnostics, { inputRoute: 'dom-keyboard-event', key: 'Enter',
    trustedInput: false, targetKeyObserved: true, keydownDefaultPrevented: false,
    defaultActionEmulated: 'form-request-submit', focusPolicy: 'after-fill' })
  const consecutive = f.actor.snapshot()
  await f.actor.act({ type: 'press', ref: input.ref, key: 'ArrowDown' },
    guarded(pressGuard(consecutive, inputItem(consecutive), 'after-fill')))
  assert.equal(f.keyEvents.at(-1), 'keyup:ArrowDown')
  assert.equal(f.submits, 1)

  const preClick = f.actor.snapshot()
  const button = preClick.interactiveElements.find(item => item.role === 'button')
  await f.actor.act({ type: 'click', ref: button.ref }, guarded(guardFrom(preClick, button)))
  const afterClick = f.actor.snapshot()
  await assert.rejects(f.actor.act({ type: 'press', ref: input.ref, key: 'Escape' },
    guarded(pressGuard(afterClick, inputItem(afterClick), 'after-fill'))), /just filled/)

  f.actor.document.activeElement = f.input
  const focused = f.actor.snapshot()
  f.preventKeydown(true)
  const prevented = await f.actor.act({ type: 'press', ref: input.ref, key: 'Enter' },
    guarded(pressGuard(focused, inputItem(focused), 'already-focused')))
  assert.equal(prevented.result.dispatchDiagnostics.keydownDefaultPrevented, true)
  assert.equal(prevented.result.dispatchDiagnostics.defaultActionEmulated, null)
  assert.equal(f.submits, 1, 'a site that handles Enter itself gets no emulated submission')
  assert.equal(f.focusCalls, 0)
  for (const key of ['F5', 'constructor', 'toString', undefined]) {
    await assert.rejects(f.actor.act({ type: 'press', ref: input.ref, key },
      guarded(pressGuard(f.actor.snapshot(), inputItem(f.actor.snapshot()), 'already-focused'))), /guarded key set/, String(key))
  }
})

test('guarded Enter clicks an enabled default button and refuses sensitive fields', async () => {
  const f = interactionFixture()
  f.button.type = 'submit'
  f.input.form.elements = [f.input, f.button]
  f.actor.document.activeElement = f.input
  const before = f.actor.snapshot()
  const result = await f.actor.act({ type: 'press', ref: inputItem(before).ref, key: 'Enter' },
    guarded(pressGuard(before, inputItem(before), 'already-focused')))
  assert.equal(result.result.dispatchDiagnostics.defaultActionEmulated, 'default-button-click')
  assert.equal(f.clicks, 1)
  assert.equal(f.submits, 0)
  const sensitive = interactionFixture()
  sensitive.input.type = 'password'
  sensitive.input.getAttribute = name => name === 'type' ? 'password' : null
  sensitive.actor.document.activeElement = sensitive.input
  const secret = sensitive.actor.snapshot()
  await assert.rejects(sensitive.actor.act({ type: 'press', ref: inputItem(secret).ref, key: 'Enter' },
    guarded(pressGuard(secret, inputItem(secret), 'already-focused'))), /Sensitive/)
  assert.deepEqual(sensitive.keyEvents, [])
})

test('guarded navigation stays on the current document site using Gecko Public Suffix data', async () => {
  const previous = globalThis.Services
  try {
    globalThis.Services = { eTLD: { getBaseDomainFromHost(host) {
      const labels = host.split('.')
      if (labels.length < 3 && host.endsWith('co.kr')) throw new Error('NS_ERROR_INSUFFICIENT_DOMAIN_LEVELS')
      return labels.slice(host.endsWith('.co.kr') ? -3 : -2).join('.')
    } } }
    const f = interactionFixture()
    f.win.location.href = 'https://shop.example.co.kr/a'
    for (const url of ['https://other.co.kr/', 'http://shop.example.co.kr/downgrade', 'https://example.co.kr.evil.test/']) {
      const before = f.actor.snapshot()
      await assert.rejects(f.actor.act({ type: 'navigate', url }, guarded(guardFrom(before))), /current document site/, url)
      assert.equal(f.win.location.href, 'https://shop.example.co.kr/a', url)
    }
    assert.equal(f.actor.actorPerformCalls, 0)
    const before = f.actor.snapshot()
    await f.actor.act({ type: 'navigate', url: 'https://www.example.co.kr/b' }, guarded(guardFrom(before)))
    assert.equal(f.win.location.href, 'https://www.example.co.kr/b')
    delete globalThis.Services
    const exact = interactionFixture()
    exact.win.location.href = 'https://shop.example.co.kr/a'
    const unknownSuffix = exact.actor.snapshot()
    await assert.rejects(exact.actor.act({ type: 'navigate', url: 'https://www.example.co.kr/b' },
      guarded(guardFrom(unknownSuffix))), /current document site/, 'without PSL data only the exact origin is in scope')
    await exact.actor.act({ type: 'navigate', url: 'https://shop.example.co.kr/c' }, guarded(guardFrom(exact.actor.snapshot())))
    assert.equal(exact.win.location.href, 'https://shop.example.co.kr/c')
  } finally {
    if (previous === undefined) delete globalThis.Services
    else globalThis.Services = previous
  }
})

test('wait is a read-only snapshot query that reports met or timeout and never enters perform', async () => {
  const f = interactionFixture()
  Object.assign(f.actor, { waitPollMs: 1, idleQuietMs: 5 })
  const wait = spec => f.actor.receiveMessage({ name: 'snapshot', data: { options: { textLimit: 5, wait: spec } } })
  const loaded = await wait({ for: 'load', timeoutMs: 1000 })
  assert.equal(loaded.wait.outcome, 'met')
  assert.equal(loaded.wait.for, 'load')
  assert.equal(typeof loaded.documentId, 'string')
  assert.equal((await wait({ for: 'idle', timeoutMs: 1000 })).wait.outcome, 'met')
  f.actor.document.readyState = 'loading'
  assert.equal((await wait({ for: 'load', timeoutMs: 0 })).wait.outcome, 'timeout')
  f.actor.document.readyState = 'complete'
  assert.equal((await wait({ for: 'load', timeoutMs: 10, notDocumentId: loaded.documentId })).wait.outcome, 'timeout',
    'the document a pending transition left cannot satisfy load')
  const observed = f.actor.snapshot()
  const ref = inputItem(observed).ref
  assert.equal((await wait({ for: 'selector-visible', timeoutMs: 100, ref, documentId: observed.documentId })).wait.outcome, 'met')
  await assert.rejects(wait({ for: 'selector-visible', timeoutMs: 100, ref: 'el_999', documentId: observed.documentId }), /stale/)
  await assert.rejects(wait({ for: 'selector-visible', timeoutMs: 100, ref, documentId: 'other-document' }), /stale/)
  await assert.rejects(wait({ for: 'load', timeoutMs: 10001 }), /bounded condition/)
  f.actor.document.readyState = 'loading'
  const replaced = wait({ for: 'load', timeoutMs: 500 })
  setTimeout(() => { f.actor.document = { ...f.actor.document } }, 5)
  await assert.rejects(replaced, /changed during wait; outcome is unknown/)
  assert.equal(f.actor.actorPerformCalls, 0)
  assert.equal(f.clicks + f.inputEvents + f.focusCalls, 0)
})

test('Parent receipt filter copies only fixed scroll/press route fields', () => {
  const { browserToolDispatchReceiptFields: fields } = parentModule
  assert.deepEqual(fields('scroll', { inputRoute: 'dom-scroll-api', mode: 'document', scrollBefore: { x: 1, y: 2 }, raw: 'x' }),
    { inputRoute: 'dom-scroll-api', scrollMode: 'document' })
  assert.deepEqual(fields('scroll', { inputRoute: 'dom-scroll-api', mode: 'into-view', targetInView: 'yes' }),
    { inputRoute: 'dom-scroll-api', scrollMode: 'into-view', targetInView: false })
  assert.deepEqual(fields('press', { inputRoute: 'dom-keyboard-event', key: 'Enter', trustedInput: false,
    targetKeyObserved: true, keydownDefaultPrevented: false, defaultActionEmulated: 'eval', focusPolicy: 'after-fill', value: 'typed' }),
  { inputRoute: 'dom-keyboard-event', key: 'Enter', trustedInput: false, targetKeyObserved: true,
    keydownDefaultPrevented: false, defaultActionEmulated: null, focusPolicy: 'after-fill' })
  for (const [type, value] of [['press', { inputRoute: 'dom-keyboard-event', key: 'Enter', trustedInput: true, focusPolicy: 'after-fill' }],
    ['press', { inputRoute: 'dom-keyboard-event', key: 'F5', trustedInput: false, focusPolicy: 'after-fill' }],
    ['press', { inputRoute: 'dom-keyboard-event', key: 'Enter', trustedInput: false, focusPolicy: 'stolen' }],
    ['scroll', { inputRoute: 'os-wheel', mode: 'document' }], ['click', { inputRoute: 'dom-scroll-api', mode: 'document' }],
    ['scroll', null], ['scroll', ['dom-scroll-api']]]) assert.deepEqual(fields(type, value), {})
})

// BRW-08: same-origin frames, open shadow roots, editors and long values.
function fakeElement(doc, tagName, rect, { root = doc, attributes = {}, ...props } = {}) {
  const listeners = new Set()
  return { ownerDocument: doc, isConnected: true, tagName, disabled: false, focusCalls: 0, clickCount: 0,
    getAttribute(name) { return attributes[name] ?? null }, getRootNode() { return root },
    getBoundingClientRect() { return rect }, dispatchEvent() { return true }, scrollIntoView() {},
    focus() { this.focusCalls++ }, contains(node) { return node === this },
    addEventListener(name, fn) { if (name === 'click') listeners.add(fn) },
    removeEventListener(name, fn) { if (name === 'click') listeners.delete(fn) },
    click() { for (const fn of listeners) fn({ target: this }); this.clickCount++ }, ...props }
}

const singleTextWalker = (node, filter) => {
  let done = false
  return { nextNode() { if (done) return null; done = true; return filter.acceptNode(node) === 1 ? node : null } }
}

function fakeFrameDocument(href, label = 'Frame send') {
  const doc = { nodeType: 9, title: 'Embedded', readyState: 'complete', location: { href } }
  doc.body = { getBoundingClientRect: () => ({ width: 300, height: 200 }) }
  doc.documentElement = { getBoundingClientRect: () => ({ width: 300, height: 200 }) }
  doc.activeElement = doc.body
  const button = fakeElement(doc, 'BUTTON', { left: 10, top: 10, width: 80, height: 30 }, { innerText: label })
  const input = fakeElement(doc, 'INPUT', { left: 10, top: 60, width: 160, height: 30 },
    { type: 'text', value: '', attributes: { type: 'text', 'aria-label': 'Frame note' } })
  const text = { nodeValue: `${label} body text`, parentElement: button }
  doc.querySelectorAll = () => [button, input]
  doc.elementFromPoint = (_x, y) => y < 50 ? button : input
  doc.createTreeWalker = (_root, _what, filter) => singleTextWalker(text, filter)
  return { doc, button, input }
}

function frameFixture() {
  const f = localDocumentFixture()
  const { actor, win } = f
  const top = actor.document
  win.location.href = 'https://example.test/page'
  const observed = []
  win.MutationObserver = class { observe(target) { observed.push(target) } disconnect() {}
    takeRecords() { return f.pendingMutations.splice(0) } }
  const frameElement = (title, rect, contentDocument) => ({ tagName: 'IFRAME', ownerDocument: top, isConnected: true,
    contentDocument, clientLeft: 0, clientTop: 0, getAttribute: name => name === 'title' ? title : null,
    getBoundingClientRect: () => rect, contains(node) { return node === this } })
  const same = fakeFrameDocument('https://example.test/embedded')
  const iframeRect = { left: 200, top: 100, width: 300, height: 200 }
  const iframe = frameElement('Compose', iframeRect, same.doc)
  const crossOrigin = fakeFrameDocument('https://pay.other.test/checkout', 'CROSS_ORIGIN_CANARY')
  const cross = frameElement('Payment', { left: 20, top: 320, width: 200, height: 100 }, crossOrigin.doc)
  const unreadable = frameElement('Login', { left: 240, top: 320, width: 200, height: 100 }, null)
  const hostRect = { left: 20, top: 200, width: 150, height: 40 }
  const host = { tagName: 'X-WIDGET', ownerDocument: top, isConnected: true, getAttribute: () => null,
    getBoundingClientRect: () => hostRect, contains(node) { return node === this } }
  const shadowRoot = { nodeType: 11, host, ownerDocument: top }
  host.shadowRoot = shadowRoot
  const shadowButton = fakeElement(top, 'BUTTON', { left: 30, top: 205, width: 100, height: 30 },
    { root: shadowRoot, innerText: 'Shadow save', parentElement: null })
  shadowRoot.querySelectorAll = () => [shadowButton]
  shadowRoot.elementFromPoint = () => shadowButton
  const closedSecret = fakeElement(top, 'BUTTON', { left: 0, top: 0, width: 10, height: 10 },
    { innerText: 'CLOSED_SHADOW_CANARY' })
  const closedHost = { tagName: 'X-VAULT', ownerDocument: top, isConnected: true, shadowRoot: null,
    openOrClosedShadowRoot: { querySelectorAll: () => [closedSecret] }, getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) }
  top.querySelectorAll = selector => selector === '*'
    ? [f.button, f.input, host, closedHost, iframe, cross, unreadable] : [f.button, f.input]
  const inside = (rect, x, y) => x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height
  const topHit = top.elementFromPoint
  let frameCovered = false
  top.elementFromPoint = (x, y) => inside(iframeRect, x, y) ? (frameCovered ? f.button : iframe)
    : inside(hostRect, x, y) ? host : topHit(x, y)
  const shadowText = { nodeValue: 'Shadow status ready', parentElement: shadowButton }
  const topWalker = top.createTreeWalker
  top.createTreeWalker = (root, what, filter) => root === shadowRoot
    ? singleTextWalker(shadowText, filter) : topWalker(root, what, filter)
  return { f, actor, win, top, observed, same, iframe, cross, unreadable, host, shadowRoot, shadowButton,
    coverFrame(value) { frameCovered = value } }
}

const byLabel = (snapshot, label) => snapshot.interactiveElements.find(item => item.label === label)

test('observe exposes same-origin frame and open shadow elements as refs and lists other frames only as inaccessible', () => {
  const x = frameFixture()
  const seen = x.actor.snapshot()
  const frameButton = byLabel(seen, 'Frame send')
  assert.match(frameButton.ref, /^f\d+\/el_\d+$/, 'a frame element ref carries its frame path')
  assert.deepEqual(frameButton.bounds, { x: 210, y: 110, width: 80, height: 30 }, 'bounds are top-viewport local')
  assert.match(byLabel(seen, 'Frame note').ref, new RegExp(`^${frameButton.ref.split('/')[0]}/el_\\d+$`))
  assert.match(byLabel(seen, 'Shadow save').ref, /^el_\d+$/)
  assert.deepEqual(seen.interactiveElements.map(item => item.label),
    ['Increment', 'Note', 'Shadow save', 'Frame send', 'Frame note'], 'shadow and frame elements stay in document order')
  assert(seen.text.includes('Frame send body text'))
  assert(seen.text.includes('Shadow status ready'))
  assert.deepEqual(seen.inaccessibleFrames.map(frame => [frame.label, frame.reason]),
    [['Payment', 'cross-origin'], ['Login', 'unreadable']])
  assert.deepEqual(seen.inaccessibleFrames[0].bounds, { x: 20, y: 320, width: 200, height: 100 })
  const json = JSON.stringify(seen)
  for (const canary of ['CROSS_ORIGIN_CANARY', 'CLOSED_SHADOW_CANARY', 'pay.other.test']) assert(!json.includes(canary), canary)
  assert(x.observed.includes(x.same.doc.documentElement), 'the frame document joins the mutation watch')
  assert(x.observed.includes(x.shadowRoot), 'the open shadow root joins the mutation watch')
})

test('a sandboxed or private frame is not read even when its URL looks same-origin', () => {
  const principal = origin => ({ origin, equals(other) { return other?.origin === origin } })
  const x = frameFixture()
  x.top.nodePrincipal = principal('https://example.test')
  x.same.doc.nodePrincipal = principal('moz-nullprincipal:{sandboxed-frame}')
  let seen = x.actor.snapshot()
  assert.equal(byLabel(seen, 'Frame send'), undefined)
  assert.deepEqual(seen.inaccessibleFrames[0], { label: 'Compose', reason: 'cross-origin',
    bounds: { x: 200, y: 100, width: 300, height: 200 } })
  x.same.doc.nodePrincipal = principal('https://example.test')
  seen = x.actor.snapshot()
  assert.match(byLabel(seen, 'Frame send').ref, /^f\d+\/el_\d+$/, 'Gecko principal equality admits the frame')
  x.iframe.getAttribute = name => name === 'title' ? 'Compose' : name === 'data-private' ? '' : null
  seen = x.actor.snapshot()
  assert.equal(byLabel(seen, 'Frame send'), undefined)
  assert.equal(seen.inaccessibleFrames.find(frame => frame.label === 'Compose').reason, 'private')
})

test('guarded click and fill reach frame and shadow targets through their own hit tests, never focus', async () => {
  const x = frameFixture()
  let seen = x.actor.snapshot()
  const frameButton = byLabel(seen, 'Frame send')
  const clicked = await x.actor.act({ type: 'click', ref: frameButton.ref }, guarded(guardFrom(seen, frameButton)))
  assert.equal(x.same.button.clickCount, 1)
  assert.equal(clicked.result.clickDiagnostics.dispatchScope, 'dom-click-no-pointerdown')
  assert.equal(clicked.result.clickDiagnostics.targetClickObserved, true)

  seen = x.actor.snapshot()
  const frameInput = byLabel(seen, 'Frame note')
  const filled = await x.actor.act({ type: 'fill', ref: frameInput.ref, text: 'Frame reply' },
    guarded(guardFrom(seen, frameInput)))
  assert.equal(x.same.input.value, 'Frame reply')
  assert.equal(filled.after.interactiveElements.find(item => item.ref === frameInput.ref).value, 'Frame reply')

  seen = x.actor.snapshot()
  const shadowButton = byLabel(seen, 'Shadow save')
  await x.actor.act({ type: 'click', ref: shadowButton.ref }, guarded(guardFrom(seen, shadowButton)))
  assert.equal(x.shadowButton.clickCount, 1)
  assert.equal(x.same.button.focusCalls + x.same.input.focusCalls + x.shadowButton.focusCalls + x.f.focusCalls, 0)

  seen = x.actor.snapshot()
  const again = byLabel(seen, 'Frame send')
  x.coverFrame(true)
  const performCalls = x.actor.actorPerformCalls
  await assert.rejects(x.actor.act({ type: 'click', ref: again.ref }, guarded(guardFrom(seen, again))), /obscured/)
  assert.equal(x.same.button.clickCount, 1, 'an element covering the frame in the parent document blocks the click')
  assert.equal(x.actor.actorPerformCalls, performCalls)
})

test('a replaced, cross-origin or forged frame makes its refs stale before any input', async () => {
  const x = frameFixture()
  const seen = x.actor.snapshot()
  const frameButton = byLabel(seen, 'Frame send')
  const replacement = fakeFrameDocument('https://example.test/embedded-2')
  x.iframe.contentDocument = replacement.doc
  await assert.rejects(x.actor.act({ type: 'click', ref: frameButton.ref }, guarded(guardFrom(seen, frameButton))), /stale/)
  assert.equal(x.actor.actorPerformCalls, 0)
  await assert.rejects(x.actor.receiveMessage({ name: 'snapshot', data: { options: { wait: {
    for: 'selector-visible', ref: frameButton.ref, documentId: seen.documentId, timeoutMs: 0 } } } }), /stale/)
  const fresh = x.actor.snapshot()
  assert.notEqual(fresh.revision, seen.revision, 'the frame document generation moves the revision')
  assert.throws(() => x.actor.assertGuard({ type: 'click', ref: frameButton.ref }, guardFrom(fresh, frameButton)),
    /frame is stale/, 'a fresh page guard does not revive the old frame ref')
  const newButton = byLabel(fresh, 'Frame send')
  assert.notEqual(newButton.ref.split('/')[0], frameButton.ref.split('/')[0])

  replacement.doc.location.href = 'https://elsewhere.test/'
  await assert.rejects(x.actor.act({ type: 'click', ref: newButton.ref }, guarded(guardFrom(fresh, newButton))), /stale/)
  const after = x.actor.snapshot()
  assert.equal(byLabel(after, 'Frame send'), undefined)
  assert.deepEqual(after.inaccessibleFrames.map(frame => [frame.label, frame.reason]).slice(0, 1), [['Compose', 'cross-origin']])
  const forged = { ...byLabel(after, 'Increment'), ref: 'f99/el_1' }
  assert.throws(() => x.actor.assertGuard({ type: 'click', ref: forged.ref }, guardFrom(after, forged)), /frame is stale/)
  assert.equal(x.same.button.clickCount + replacement.button.clickCount, 0)
  assert.equal(x.actor.actorPerformCalls, 0)
})

test('focus inside a same-origin frame or open shadow root is observed there and keeps the no-focus key policy', async () => {
  const x = frameFixture()
  x.win.KeyboardEvent = class { constructor(name, init) { this.name = name; Object.assign(this, init) } }
  x.top.activeElement = x.iframe
  x.same.doc.activeElement = x.same.input
  const seen = x.actor.snapshot()
  const frameInput = byLabel(seen, 'Frame note')
  assert.equal(seen.focusedElement.ref, frameInput.ref)
  const pressed = await x.actor.act({ type: 'press', ref: frameInput.ref, key: 'Escape' },
    guarded({ ...guardFrom(seen, frameInput), pressPolicy: 'already-focused' }))
  assert.equal(pressed.result.dispatchDiagnostics.focusPolicy, 'already-focused')
  assert.equal(x.same.input.focusCalls, 0)
  x.top.activeElement = x.f.input
  await assert.rejects(x.actor.act({ type: 'press', ref: frameInput.ref, key: 'Escape' },
    guarded({ ...guardFrom(seen, frameInput), pressPolicy: 'already-focused' })), /stale/)
  x.top.activeElement = x.host
  x.shadowRoot.activeElement = x.shadowButton
  assert.equal(x.actor.snapshot().focusedElement.label, 'Shadow save')
})

function editorFixture() {
  const f = localDocumentFixture()
  const top = f.actor.document
  const events = []
  let pageHandler = null, selectionCalls = 0
  const editor = { ownerDocument: top, isConnected: true, tagName: 'DIV', isContentEditable: true,
    parentElement: top.body, childNodes: [], focusCalls: 0,
    getAttribute: name => name === 'aria-label' ? 'Message body' : null,
    getBoundingClientRect: () => ({ left: 20, top: 140, width: 300, height: 120 }),
    dispatchEvent(event) {
      events.push(event.name)
      if (event.name === 'beforeinput' && pageHandler) { pageHandler(event, editor); return false }
      return true
    },
    replaceChildren(...nodes) { this.childNodes = nodes }, focus() { this.focusCalls++ },
    scrollIntoView() {}, contains(node) { return node === this } }
  top.createElement = tagName => ({ nodeType: 1, tagName: tagName.toUpperCase(), childNodes: [] })
  top.createTextNode = nodeValue => ({ nodeType: 3, nodeValue })
  top.getSelection = () => { selectionCalls++; return {} }
  top.querySelectorAll = () => [f.button, f.input, editor]
  f.win.InputEvent = class { constructor(name, init) { this.name = name; Object.assign(this, init) } }
  return { f, editor, events, setPageHandler(fn) { pageHandler = fn }, get selectionCalls() { return selectionCalls } }
}

test('guarded editor fill replaces contenteditable text with an honest beforeinput/input order and no focus or selection', async () => {
  const e = editorFixture()
  let seen = e.f.actor.snapshot()
  let editor = byLabel(seen, 'Message body')
  assert.equal(editor.role, 'textbox')
  assert.equal(editor.value, '[editor text hidden: empty]')
  const text = '안녕하세요 대표님\nSecond line'
  const filled = await e.f.actor.act({ type: 'fill', ref: editor.ref, text }, guarded(guardFrom(seen, editor)))
  assert.deepEqual(e.events, ['beforeinput', 'input'])
  assert.deepEqual(filled.result.dispatchDiagnostics, { inputRoute: 'dom-editor-replace', trustedInput: false,
    focusApi: 'not-called', selectionApi: 'not-called', eventOrder: ['beforeinput', 'input'], beforeInputCanceled: false,
    egdeskWroteContent: true, readbackMatches: true })
  assert.deepEqual(e.editor.childNodes.map(node => node.nodeType === 3 ? node.nodeValue : node.tagName),
    ['안녕하세요 대표님', 'BR', 'Second line'])
  assert.equal(filled.after.interactiveElements.find(item => item.ref === editor.ref).value,
    boundedFieldValue(text, { editor: true }))
  assert(!JSON.stringify(filled.after).includes('Second line'), 'editor text never enters the observation')
  assert.equal(e.editor.focusCalls + e.f.focusCalls + e.selectionCalls, 0)

  // A rich editor that cancels beforeinput and builds paragraphs itself.
  e.events.length = 0
  e.setPageHandler((event, host) => {
    host.childNodes = event.data.split('\n').map(line => ({ nodeType: 1, tagName: 'P',
      childNodes: [{ nodeType: 3, nodeValue: line }] }))
  })
  seen = e.f.actor.snapshot()
  editor = byLabel(seen, 'Message body')
  const handled = await e.f.actor.act({ type: 'fill', ref: editor.ref, text: 'One\nTwo' }, guarded(guardFrom(seen, editor)))
  assert.deepEqual(e.events, ['beforeinput'], 'no input event is invented after the page canceled beforeinput')
  assert.equal(handled.result.dispatchDiagnostics.beforeInputCanceled, true)
  assert.equal(handled.result.dispatchDiagnostics.egdeskWroteContent, false)
  assert.equal(handled.result.dispatchDiagnostics.readbackMatches, false)
  const readback = handled.after.interactiveElements.find(item => item.ref === editor.ref).value
  assert.notEqual(readback, boundedFieldValue('One\nTwo', { editor: true }), 'restructured text reads back as different')
  assert.equal(readback, boundedFieldValue('OneTwo', { editor: true }))
})

test('editor fill fails closed for nested, read-only, private or event-less editors before any change', async () => {
  for (const reason of ['nested', 'read-only', 'private', 'no-input-event']) {
    const e = editorFixture()
    if (reason === 'nested') e.editor.parentElement = { isContentEditable: true, parentElement: e.f.actor.document.body }
    if (reason === 'read-only') e.editor.getAttribute = name => name === 'aria-label' ? 'Message body'
      : name === 'aria-readonly' ? 'true' : null
    if (reason === 'private') e.editor.getAttribute = name => name === 'aria-label' ? 'Message body'
      : name === 'data-sensitive' ? 'true' : null
    if (reason === 'no-input-event') delete e.f.win.InputEvent
    const seen = e.f.actor.snapshot()
    const editor = seen.interactiveElements.find(item => item.tag === 'div')
    await assert.rejects(e.f.actor.act({ type: 'fill', ref: editor.ref, text: 'changed' }, guarded(guardFrom(seen, editor))),
      /editable|Sensitive|input events are unavailable/, reason)
    assert.deepEqual(e.editor.childNodes, [], reason)
    assert.deepEqual(e.events, [], reason)
    assert.equal(e.f.actor.actorPerformCalls, reason === 'no-input-event' ? 1 : 0, reason)
  }
})

test('long field values are observed by prefix, length and fingerprint, fill up to 8000 characters and stay guarded', async () => {
  const f = localDocumentFixture()
  f.win.KeyboardEvent = class { constructor(name, init) { this.name = name; Object.assign(this, init) } }
  let seen = f.actor.snapshot()
  let input = seen.interactiveElements.find(item => item.tag === 'input')
  const long = 'Long draft line. '.repeat(200).slice(0, 3000)
  const filled = await f.actor.act({ type: 'fill', ref: input.ref, text: long }, guarded(guardFrom(seen, input)))
  assert.equal(f.input.value, long)
  const observedValue = filled.after.interactiveElements.find(item => item.ref === input.ref).value
  assert.equal(observedValue, boundedFieldValue(long))
  assert.match(observedValue, /^Long draft line\..*\.\.\. \[3000 chars, #[0-9a-f]{14}\]$/)
  assert(observedValue.length < 130)
  assert.deepEqual(filled.result.dispatchDiagnostics.eventOrder, ['input', 'change'])
  assert.equal(filled.result.dispatchDiagnostics.readbackMatches, true)
  assert.equal(f.focusCalls, 0)

  seen = f.actor.snapshot()
  input = seen.interactiveElements.find(item => item.tag === 'input')
  const pressed = await f.actor.act({ type: 'press', ref: input.ref, key: 'Tab' },
    guarded({ ...guardFrom(seen, input), pressPolicy: 'after-fill' }))
  assert.equal(pressed.result.dispatchDiagnostics.focusPolicy, 'after-fill', 'a long current value no longer blocks key input')

  seen = f.actor.snapshot()
  input = seen.interactiveElements.find(item => item.tag === 'input')
  const performCalls = f.actor.actorPerformCalls
  f.input.value = `${long.slice(0, 2999)}X`
  await assert.rejects(f.actor.act({ type: 'fill', ref: input.ref, text: 'short' }, guarded(guardFrom(seen, input))),
    /target changed/, 'a human edit past the first 120 characters changes the fingerprint')
  seen = f.actor.snapshot()
  input = seen.interactiveElements.find(item => item.tag === 'input')
  await assert.rejects(f.actor.act({ type: 'fill', ref: input.ref, text: 'x'.repeat(8001) }, guarded(guardFrom(seen, input))),
    /exceeds the bounded input/)
  f.input.value = 'y'.repeat(8001)
  seen = f.actor.snapshot()
  input = seen.interactiveElements.find(item => item.tag === 'input')
  assert.match(input.value, /\[over 8000 chars\]$/)
  await assert.rejects(f.actor.act({ type: 'fill', ref: input.ref, text: 'short' }, guarded(guardFrom(seen, input))),
    /exceeds the bounded observation/)
  assert.equal(f.actor.actorPerformCalls, performCalls)
  assert.equal(f.focusCalls, 0)
})

test('actor and helper bounded values agree byte for byte', () => {
  const actor = new EGDeskBrowserAgentRuntimeChild()
  for (const raw of ['', 'short', '  spaced   text  ', 'x'.repeat(120), 'x'.repeat(121), '한글 문장 '.repeat(60),
    'a\nb\tc '.repeat(50), 'y'.repeat(8000), 'y'.repeat(8001)]) {
    assert.equal(actor.boundedValue(raw), boundedFieldValue(raw))
    assert.equal(actor.boundedValue(raw, { editor: true }), boundedFieldValue(raw, { editor: true }))
  }
  assert.notEqual(boundedFieldValue('a'.repeat(200)), boundedFieldValue(`${'a'.repeat(199)}b`))
  assert.equal(boundedFieldValue('local note'), 'local note', 'short values keep their existing observed form')
})

test('Parent receipt filter copies only the fixed fill event order, never the text', () => {
  const { browserToolDispatchReceiptFields: fields } = parentModule
  const diagnostics = { inputRoute: 'dom-editor-replace', trustedInput: false, focusApi: 'not-called',
    selectionApi: 'not-called', eventOrder: ['beforeinput', 'input'], beforeInputCanceled: false,
    egdeskWroteContent: true, readbackMatches: true, text: 'TYPED_SECRET' }
  const copied = fields('fill', diagnostics)
  assert.deepEqual(copied, { inputRoute: 'dom-editor-replace', trustedInput: false, eventOrder: ['beforeinput', 'input'],
    beforeInputCanceled: false, egdeskWroteContent: true, readbackMatches: true })
  assert(!JSON.stringify(copied).includes('TYPED_SECRET'))
  assert.deepEqual(fields('fill', { inputRoute: 'dom-value-setter', trustedInput: false, eventOrder: ['input', 'change'],
    beforeInputCanceled: 'no', egdeskWroteContent: 1 }), { inputRoute: 'dom-value-setter', trustedInput: false,
    eventOrder: ['input', 'change'], beforeInputCanceled: null, egdeskWroteContent: false, readbackMatches: false })
  for (const bad of [{ ...diagnostics, trustedInput: true }, { ...diagnostics, inputRoute: 'clipboard-paste' },
    { ...diagnostics, eventOrder: ['keydown'] }, { ...diagnostics, eventOrder: 'beforeinput' },
    { ...diagnostics, eventOrder: ['input', 'input', 'input', 'input'] }]) assert.deepEqual(fields('fill', bad), {})
})

test('a page past the scan budget still lists its interactive elements but reads no further frames', () => {
  const x = frameFixture()
  const filler = Array.from({ length: 20000 }, () => ({ tagName: 'SPAN' }))
  x.top.querySelectorAll = selector => selector === '*' ? [...filler, x.f.button, x.iframe] : [x.f.button]
  const seen = x.actor.snapshot()
  assert.deepEqual(seen.interactiveElements.map(item => item.label), ['Increment'])
  assert.equal(byLabel(seen, 'Frame send'), undefined)
  assert.deepEqual(seen.inaccessibleFrames, [])
})

// REA 웹4/웹8/웹10: Gecko document identity, dispatch phase and same-clock timing.
function identityFixture() {
  const f = localDocumentFixture()
  f.actor.manager = { innerWindowId: 4101 }
  f.actor.browsingContext = { id: 77 }
  return f
}
const guardedAct = (f, action, options) => f.actor.receiveMessage({ name: 'act', data: { action, options } })

test('snapshot carries the actor Gecko document identity and an act from another document is stale before perform', async () => {
  const f = identityFixture()
  const before = f.actor.snapshot()
  assert.equal(before.innerWindowId, 4101)
  assert.equal(before.browsingContextId, 77)
  const button = before.interactiveElements.find(item => item.role === 'button')
  for (const [key, value] of [['innerWindowId', 4102], ['browsingContextId', 78]]) {
    const refusal = await guardedAct(f, { type: 'click', ref: button.ref },
      guarded({ ...guardFrom(before, button), innerWindowId: 4101, browsingContextId: 77, [key]: value }))
    assert.equal(refusal.ok, false, key)
    assert.equal(refusal.refused, true, key)
    assert.match(refusal.error, /stale/, key)
    assert.equal(refusal.dispatchPhase, 'not-dispatched', key)
    assert.deepEqual(refusal.timing, { performCallsBefore: 0, performCallsAfter: 0 }, key)
  }
  assert.equal(f.clicks, 0)
  // An identity the actor cannot read is not "this document".
  delete f.actor.manager
  const unreadable = await guardedAct(f, { type: 'click', ref: button.ref },
    guarded({ ...guardFrom(f.actor.snapshot(), button), innerWindowId: 4101 }))
  assert.equal(unreadable.dispatchPhase, 'not-dispatched')
  assert.equal(f.actor.snapshot().innerWindowId, undefined, 'no identity is invented')
  const current = identityFixture()
  const seen = current.actor.snapshot()
  const target = seen.interactiveElements.find(item => item.role === 'button')
  const acted = await guardedAct(current, { type: 'click', ref: target.ref },
    guarded({ ...guardFrom(seen, target), innerWindowId: 4101, browsingContextId: 77 }))
  assert.equal(acted.ok, true)
  assert.equal(current.clicks, 1)
})

test('a node whose document is no longer active is stale like remote dom.isStale, before perform', async () => {
  const f = localDocumentFixture()
  let active = true
  f.actor.document.isActive = () => active
  const before = f.actor.snapshot()
  const button = before.interactiveElements.find(item => item.role === 'button')
  active = false
  const refusal = await guardedAct(f, { type: 'click', ref: button.ref }, guarded(guardFrom(before, button)))
  assert.equal(refusal.dispatchPhase, 'not-dispatched')
  assert.match(refusal.error, /unavailable|stale/)
  assert.equal(f.actor.nodeForRef(button.ref), null)
  assert.equal(f.clicks, 0)
  active = true
  assert.equal(f.actor.nodeForRef(button.ref)?.tagName, 'BUTTON')

  const x = frameFixture()
  const seen = x.actor.snapshot()
  const frameButton = byLabel(seen, 'Frame send')
  x.same.doc.isActive = () => false
  assert.throws(() => x.actor.assertGuard({ type: 'click', ref: frameButton.ref }, guardFrom(seen, frameButton)),
    /stale/, 'an inactive frame document ends its generation')
  assert.equal(x.same.button.clickCount, 0)
})

test('guarded refusals answer as data with the phase the actor can prove; perform entry is dispatched', async () => {
  for (const reason of ['stale-before-approval', 'lease-missing', 'authority-denied', 'stale-after-approval',
    'deadline-after-approval', 'perform-threw']) {
    const f = localDocumentFixture()
    const before = f.actor.snapshot()
    const button = before.interactiveElements.find(item => item.role === 'button')
    const options = guarded(guardFrom(before, button))
    let clockMs = Date.now()
    f.actor.nowMs = () => clockMs
    options.lease.deadlineMs = clockMs + 10000
    if (reason === 'stale-before-approval') f.pendingMutations.push({})
    if (reason === 'lease-missing') delete options.lease
    if (reason === 'authority-denied') f.actor.sendQuery = async () => ({ authorized: false, reason: 'ui-denied' })
    if (reason === 'stale-after-approval') f.actor.sendQuery = async () => { f.pendingMutations.push({}); return { authorized: true } }
    if (reason === 'deadline-after-approval') f.actor.sendQuery = async () => { clockMs += 10001; return { authorized: true } }
    if (reason === 'perform-threw') f.button.click = () => { throw new Error('page click handler failed') }
    const refusal = await guardedAct(f, { type: 'click', ref: button.ref }, options)
    assert.equal(refusal.ok, false, reason)
    assert.equal(refusal.refused, true, reason)
    assert.equal(typeof refusal.error, 'string', reason)
    if (reason === 'perform-threw') {
      assert.equal(refusal.dispatchPhase, 'dispatched')
      assert.equal(refusal.timing.performCallsBefore, 0)
      assert.equal(refusal.timing.performCallsAfter, 1)
      assert.ok(Number.isFinite(refusal.timing.performEnterMs) && Number.isFinite(refusal.timing.performExitMs))
      assert.ok(refusal.timing.performExitMs >= refusal.timing.performEnterMs)
    } else {
      assert.equal(refusal.dispatchPhase, 'not-dispatched', reason)
      assert.deepEqual(refusal.timing, { performCallsBefore: 0, performCallsAfter: 0 }, reason)
      assert.equal(f.actor.actorPerformCalls, 0, reason)
    }
    assert.equal(f.clicks, 0, reason)
  }
  // The direct act() contract stays a rejection, now carrying the same facts.
  const f = localDocumentFixture()
  const before = f.actor.snapshot()
  const button = before.interactiveElements.find(item => item.role === 'button')
  f.pendingMutations.push({})
  await assert.rejects(f.actor.act({ type: 'click', ref: button.ref }, guarded(guardFrom(before, button))),
    error => error.dispatchPhase === 'not-dispatched' && error.timing.performCallsAfter === 0 && /stale/.test(error.message))
  // A perform count moved by another call is not proof that this one was never sent.
  const g = localDocumentFixture()
  const seen = g.actor.snapshot()
  const target = seen.interactiveElements.find(item => item.role === 'button')
  g.actor.sendQuery = async () => { g.actor.actorPerformCalls++; return { authorized: false, reason: 'ui-denied' } }
  const contested = await guardedAct(g, { type: 'click', ref: target.ref }, guarded(guardFrom(seen, target)))
  assert.equal(contested.dispatchPhase, 'unknown')
  // Unguarded internal acts keep their thrown errors and record no timing.
  const h = localDocumentFixture()
  await assert.rejects(h.actor.receiveMessage({ name: 'act', data: { action: { type: 'click', ref: 'el_missing' }, options: {} } }),
    error => !('dispatchPhase' in error))
})

test('a guarded action reports same-clock perform timing and bounds settle by what the lease leaves', async () => {
  const f = localDocumentFixture()
  let clockMs = 1000
  f.actor.nowMs = () => clockMs
  let pageClock = 5000
  f.win.performance = { timeOrigin: 1700000000000, now: () => pageClock++ }
  const delays = []
  f.win.setTimeout = (fn, ms) => { delays.push(ms); fn() }
  const before = f.actor.snapshot()
  const button = before.interactiveElements.find(item => item.role === 'button')
  const options = { guard: guardFrom(before, button), settleMs: 150,
    lease: { leaseId: 'lease-a', requestId: 'request-a', deadlineMs: clockMs + 10000 } }
  const acted = await guardedAct(f, { type: 'click', ref: button.ref }, options)
  assert.equal(acted.ok, true)
  const { timing } = acted
  assert.deepEqual(Object.keys(timing).sort(), ['firstEventAtMs', 'performCallsAfter', 'performCallsBefore',
    'performEnterMs', 'performExitMs'])
  assert.equal(timing.performCallsBefore, 0)
  assert.equal(timing.performCallsAfter, 1)
  assert.ok(timing.performEnterMs >= 1700000005000, 'stamped on the page performance clock')
  assert.ok(timing.performEnterMs < timing.firstEventAtMs && timing.firstEventAtMs < timing.performExitMs)
  assert.deepEqual(delays, [150])

  // 600ms left: settle = min(150, 600 - 500) = 100. 400ms left: settle 0.
  for (const [left, expected] of [[600, 100], [400, 0]]) {
    const seen = f.actor.snapshot()
    const target = seen.interactiveElements.find(item => item.role === 'button')
    delays.length = 0
    await guardedAct(f, { type: 'click', ref: target.ref }, { guard: guardFrom(seen, target), settleMs: 150,
      lease: { leaseId: `lease-${left}`, requestId: `request-${left}`, deadlineMs: clockMs + left } })
    assert.deepEqual(delays, [expected], `${left}ms left`)
  }
  // Each guarded route stamps its first DOM event.
  const fill = localDocumentFixture()
  const observed = fill.actor.snapshot()
  const input = observed.interactiveElements.find(item => item.tag === 'input')
  const filled = await guardedAct(fill, { type: 'fill', ref: input.ref, text: 'note' }, guarded(guardFrom(observed, input)))
  assert.ok(filled.timing.firstEventAtMs >= filled.timing.performEnterMs &&
    filled.timing.firstEventAtMs <= filled.timing.performExitMs)
})

test('Parent hands the UI the native document identity after child data so a child cannot replace it', () => {
  const parent = new EGDeskBrowserAgentRuntimeParent()
  const ownerDocument = { nodePrincipal: { isSystemPrincipal: true } }
  const ownerWindow = { document: ownerDocument, addEventListener() {}, removeEventListener() {} }
  ownerDocument.defaultView = ownerWindow
  const card = { isConnected: true }
  const context = { id: 301 }
  const browser = { localName: 'browser', isConnected: true, ownerDocument, browsingContext: context,
    closest: selector => selector === '.egd-browser-card' ? card : null }
  context.top = context
  context.embedderElement = browser
  let seen = null
  const unregister = registerBrowserActionAuthorizer(browser, ownerWindow, request => { seen = request; return true })
  parent.browsingContext = context
  parent.manager = { innerWindowId: 9001 }
  assert.deepEqual(parent.receiveMessage({ name: 'authorizeAct', data: { leaseId: 'lease-a',
    innerWindowId: 1, browsingContextId: 2, windowGlobal: 'forged' } }), { authorized: true, reason: 'approved' })
  assert.equal(seen.innerWindowId, 9001)
  assert.equal(seen.browsingContextId, 301)
  assert.equal(seen.windowGlobal, parent.manager)
  unregister()
})
