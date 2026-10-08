import assert from 'node:assert/strict'
import { test } from 'node:test'

globalThis.JSWindowActorChild ||= class {}
const { EGDeskBrowserAgentRuntimeChild } = await import('../overlay/resources/EGDeskBrowserAgentRuntimeChild.sys.mjs')

function localDocumentFixture() {
  const actor = new EGDeskBrowserAgentRuntimeChild()
  const pendingMutations = []
  const countNode = { nodeValue: 'Count: 0' }
  let clicks = 0, inputEvents = 0, focusCalls = 0
  const doc = { title: 'Isolated local document', readyState: 'complete' }
  const rect = { left: 20, top: 30, width: 100, height: 32 }
  const button = {
    ownerDocument: doc, isConnected: true, tagName: 'BUTTON', innerText: 'Increment', disabled: false,
    getAttribute() { return null }, getBoundingClientRect() { return rect },
    dispatchEvent() { return true }, focus() { focusCalls++ },
    scrollIntoView() {}, click() { clicks++; countNode.nodeValue = `Count: ${clicks}`; pendingMutations.push({}) },
    contains(node) { return node === this },
  }
  const input = {
    ownerDocument: doc, isConnected: true, tagName: 'INPUT', type: 'text', value: '', disabled: false,
    getAttribute(name) { return name === 'type' ? 'text' : name === 'placeholder' ? 'Note' : null },
    getBoundingClientRect() { return { left: 20, top: 80, width: 160, height: 30 } },
    dispatchEvent(event) { if (event.name === 'input' || event.name === 'change') inputEvents++; return true },
    focus() { focusCalls++ }, scrollIntoView() {}, contains(node) { return node === this },
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
    getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1' } },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return pendingMutations.splice(0) } },
    Event: class { constructor(name) { this.name = name } },
    MouseEvent: class { constructor(name) { this.name = name } },
    PointerEvent: class { constructor(name) { this.name = name } },
    setTimeout,
  }
  actor.document = doc
  actor.contentWindow = win
  return { actor, button, input, win, pendingMutations, get clicks() { return clicks },
    get inputEvents() { return inputEvents }, get focusCalls() { return focusCalls } }
}

function guardFrom(snapshot, target = null) {
  return { documentId: snapshot.documentId, revision: snapshot.revision,
    viewport: snapshot.viewport, url: snapshot.url,
    focusedRef: snapshot.focusedElement?.ref || null, target }
}

test('guarded native Browser actor changes isolated local DOM exactly once and returns post-observation', async () => {
  const f = localDocumentFixture()
  const before = f.actor.snapshot()
  assert.equal(before.coordinateSpace, 'browser-viewport-local')
  const button = before.interactiveElements.find(item => item.role === 'button')
  const clicked = await f.actor.act({ type: 'click', ref: button.ref },
    { guard: guardFrom(before, button), settleMs: 0 })
  assert.equal(f.clicks, 1, 'one model click must never dispatch duplicate click effects')
  assert.equal(clicked.after.text[0], 'Count: 1')
  assert.equal(clicked.observation.newVisibleText[0], 'Count: 1')
  assert.equal(f.focusCalls, 0, 'guarded action does not call global or content focus')

  const observedAgain = f.actor.snapshot()
  const input = observedAgain.interactiveElements.find(item => item.tag === 'input')
  const filled = await f.actor.act({ type: 'fill', ref: input.ref, text: 'local note' },
    { guard: guardFrom(observedAgain, input), settleMs: 0 })
  assert.equal(f.input.value, 'local note')
  assert.equal(filled.after.interactiveElements.find(item => item.ref === input.ref).value, 'local note')
  assert.equal(f.inputEvents, 2)
  assert.equal(f.focusCalls, 0)
})

test('document mutation, real viewport resize, target change and occlusion reject old actions', async () => {
  const f = localDocumentFixture()
  const before = f.actor.snapshot()
  const button = before.interactiveElements[0]
  f.pendingMutations.push({})
  await assert.rejects(f.actor.act({ type: 'click', ref: button.ref },
    { guard: guardFrom(before, button), settleMs: 0 }), /stale/)
  assert.equal(f.clicks, 0)
  const afterMutation = f.actor.snapshot()
  f.win.canvasCameraScale = 0.5
  assert.equal(f.actor.snapshot().revision, afterMutation.revision,
    'Canvas camera movement must not change Browser document or viewport revision')
  f.win.innerWidth = 1280
  await assert.rejects(f.actor.act({ type: 'click', ref: button.ref },
    { guard: guardFrom(afterMutation, button), settleMs: 0 }), /stale/)
  const afterResize = f.actor.snapshot()
  f.button.innerText = 'Different action'
  await assert.rejects(f.actor.act({ type: 'click', ref: button.ref },
    { guard: guardFrom(afterResize, button), settleMs: 0 }), /target changed/)
  f.button.innerText = 'Increment'
  const current = f.actor.snapshot()
  f.actor.document.elementFromPoint = () => f.input
  await assert.rejects(f.actor.act({ type: 'click', ref: button.ref },
    { guard: guardFrom(current, button), settleMs: 0 }), /obscured/)
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
    { guard: guardFrom(before, button), settleMs: 0 }), /stale/)
  assert.equal(f.clicks, 0)
  assert.equal(f.focusCalls, 0)
})
