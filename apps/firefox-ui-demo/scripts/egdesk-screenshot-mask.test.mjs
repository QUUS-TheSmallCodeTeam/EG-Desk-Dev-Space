import assert from 'node:assert/strict'
import { test } from 'node:test'

// BRW-09: masked Browser Card screenshots (D-B6, REA 웹6 decision 3). The
// pure policy module, the child actor's cover-box pass and the parent
// actor's capture flow are exercised with fake DOM/Gecko objects; the real
// drawSnapshot call needs a Firefox window and is not run here.
globalThis.JSWindowActorChild ||= class {}
globalThis.JSWindowActorParent ||= class { sendQuery(name, data) { return this.querySink(name, data) } }
const mask = await import('../overlay/resources/EGDeskScreenshotMask.sys.mjs')
const { EGDeskBrowserAgentRuntimeChild } = await import('../overlay/resources/EGDeskBrowserAgentRuntimeChild.sys.mjs')
const { EGDeskBrowserAgentRuntimeParent } = await import('../overlay/resources/EGDeskBrowserAgentRuntimeParent.sys.mjs')

const viewport = { width: 720, height: 480, devicePixelRatio: 1 }
const passwordRect = { left: 20, top: 80, width: 160, height: 30 }
function report(overrides = {}) {
  return { documentId: 'doc-a', revision: 4, viewport, innerWindowId: 77, browsingContextId: 5, complete: true, incompleteReason: null,
    regions: [{ kind: 'sensitive-field', reason: 'password', rect: passwordRect }], ...overrides }
}

test('autocomplete tokens for payment cards and one-time codes are sensitive', () => {
  for (const value of ['cc-number', 'cc-name', 'section-pay cc-exp-year', 'CC-CSC', 'one-time-code', 'new-password', 'shipping current-password']) {
    assert.equal(mask.isSensitiveAutocomplete(value), true, value)
  }
  for (const value of ['name', 'email', 'street-address', 'ccname', '', null, undefined, 'off', 'tel-national']) {
    assert.equal(mask.isSensitiveAutocomplete(value), false, String(value))
  }
})

test('a cover box grows by the margin, clips to the viewport, and is dropped when off screen', () => {
  assert.deepEqual(mask.maskRegionInViewport(passwordRect, viewport), { x: 17, y: 77, width: 166, height: 36 })
  assert.deepEqual(mask.maskRegionInViewport({ left: -10, top: 470, width: 40, height: 40 }, viewport), { x: 0, y: 467, width: 33, height: 13 })
  assert.equal(mask.maskRegionInViewport({ left: 2000, top: 80, width: 160, height: 30 }, viewport), null)
  assert.equal(mask.maskRegionInViewport({ left: 20, top: 80, width: Number.NaN, height: 30 }, viewport), null)
  assert.equal(mask.maskRegionInViewport(passwordRect, { width: 0, height: 480 }), null)
})

test('a mask report must be complete, identified and well formed', () => {
  assert.equal(mask.normalizeMaskReport(report()).ok, true)
  assert.deepEqual(mask.normalizeMaskReport(null), { ok: false, reason: 'mask-unavailable' })
  assert.deepEqual(mask.normalizeMaskReport(report({ complete: false, incompleteReason: 'scan-budget' })), { ok: false, reason: 'scan-budget' })
  assert.deepEqual(mask.normalizeMaskReport(report({ complete: false, incompleteReason: 'because' })), { ok: false, reason: 'mask-incomplete' })
  assert.deepEqual(mask.normalizeMaskReport(report({ regions: [{ kind: 'frame', reason: 'password', rect: passwordRect }] })), { ok: false, reason: 'mask-unavailable' })
  assert.deepEqual(mask.normalizeMaskReport(report({ viewport: { width: 0, height: 480 } })), { ok: false, reason: 'viewport-unavailable' })
  assert.deepEqual(mask.normalizeMaskReport(report({ innerWindowId: 'x' })), { ok: false, reason: 'mask-unavailable' })
})

test('the decision withholds the image unless both reports agree and the capture matches the viewport', () => {
  const image = { width: 720, height: 480 }
  const sent = mask.screenshotDecision({ before: report(), after: report({ revision: 5 }), image })
  assert.equal(sent.send, true)
  assert.deepEqual(sent.masks, [{ x: 17, y: 77, width: 166, height: 36 }])
  assert.deepEqual(sent.maskedRegions, [{ kind: 'sensitive-field', reason: 'password', bounds: { x: 17, y: 77, width: 166, height: 36 } }])
  assert.equal(sent.imageScale, 1)
  assert.equal(sent.revision, 5)
  assert.equal(sent.innerWindowId, 77)
  const refused = (before, after, img = image) => mask.screenshotDecision({ before, after, image: img })
  assert.deepEqual(refused(report({ complete: false, incompleteReason: 'rect-unavailable' }), report()), { send: false, reason: 'rect-unavailable' })
  assert.deepEqual(refused(report(), report({ complete: false, incompleteReason: 'frame-transform' })), { send: false, reason: 'frame-transform' })
  assert.deepEqual(refused(report(), report({ documentId: 'doc-b' })), { send: false, reason: 'document-changed' })
  assert.deepEqual(refused(report(), report({ innerWindowId: 78 })), { send: false, reason: 'document-changed' })
  assert.deepEqual(refused(report(), report({ viewport: { ...viewport, height: 400 } })), { send: false, reason: 'viewport-changed' })
  assert.deepEqual(refused(report(), report({ regions: [{ kind: 'sensitive-field', reason: 'password', rect: { ...passwordRect, top: 90 } }] })), { send: false, reason: 'mask-moved' })
  assert.deepEqual(refused(report(), report({ regions: [] })), { send: false, reason: 'mask-moved' })
  assert.deepEqual(refused(report(), report(), { width: 1440, height: 480 }), { send: false, reason: 'image-size-mismatch' })
  assert.deepEqual(refused(report(), report(), { width: 0, height: 480 }), { send: false, reason: 'image-size-mismatch' })
  // Off-screen regions cover nothing and do not count as movement.
  const offscreen = { kind: 'sensitive-field', reason: 'password', rect: { left: 2000, top: 80, width: 160, height: 30 } }
  assert.deepEqual(mask.screenshotDecision({ before: report({ regions: [offscreen] }), after: report({ regions: [] }), image }).masks, [])
})

test('a capture a scrollbar narrower than the viewport keeps the CSS grid with a wider cover; a uniform rescale maps by scale', () => {
  const near = mask.screenshotDecision({ before: report(), after: report(), image: { width: 705, height: 480 } })
  assert.equal(near.send, true)
  assert.deepEqual(near.masks, [{ x: 2, y: 62, width: 196, height: 66 }])
  assert.equal(near.imageScale, 1)
  const scaled = mask.screenshotDecision({ before: report(), after: report(), image: { width: 1440, height: 960 } })
  assert.equal(scaled.send, true)
  assert.deepEqual(scaled.masks, [{ x: 30, y: 150, width: 340, height: 80 }])
  assert.equal(scaled.imageScale, 2)
})

test('encode attempts shrink from the capped size to the floor and end with a lower quality', () => {
  const attempts = mask.encodeAttempts({ width: 2000, height: 1000 })
  assert.equal(attempts.length, 6)
  assert.deepEqual(attempts[0], { width: 1280, height: 640, factor: 0.64, quality: 0.7 })
  assert.deepEqual(attempts[attempts.length - 1], { ...attempts[attempts.length - 2], quality: 0.5 })
  assert.ok(attempts.every(attempt => Math.max(attempt.width, attempt.height) <= 1280))
  assert.ok(attempts.every((attempt, index) => index === 0 || attempt.width <= attempts[index - 1].width))
  assert.ok(Math.max(attempts[attempts.length - 1].width, attempts[attempts.length - 1].height) >= 480)
  const small = mask.encodeAttempts({ width: 720, height: 480 })
  assert.deepEqual(small.map(attempt => [attempt.width, attempt.height, attempt.quality]), [[720, 480, 0.7], [576, 384, 0.7], [576, 384, 0.5]])
  assert.deepEqual(mask.encodeAttempts({ width: 0, height: 480 }), [])
})

test('masks scaled onto a smaller output grow outward and never uncover a capture pixel', () => {
  assert.deepEqual(mask.scaleMasks([{ x: 17, y: 77, width: 166, height: 36 }], { width: 720, height: 480 }, { width: 576, height: 384 }),
    [{ x: 12, y: 60, width: 136, height: 32 }])
  assert.deepEqual(mask.scaleMasks([], { width: 720, height: 480 }, { width: 720, height: 480 }), [])
  assert.equal(mask.scaleMasks([{ x: 1, y: 1, width: Number.NaN, height: 1 }], { width: 720, height: 480 }, { width: 720, height: 480 }), null)
  assert.equal(mask.fitsBudget('data:image/jpeg;base64,AAAA', 100), true)
  assert.equal(mask.fitsBudget('data:image/jpeg;base64,AAAA', 10), false)
  assert.equal(mask.fitsBudget('data:text/html;base64,AAAA', 100), false)
  assert.equal(mask.fitsBudget('https://example.test/a.jpg', 100), false)
})

// Child actor fixture: a checkout page with a password field, a card number
// field, a plain field, a hidden password, an off-screen password, a
// cross-origin payment frame and an unreadable frame.
function childFixture() {
  const actor = new EGDeskBrowserAgentRuntimeChild()
  const doc = { title: 'Checkout', readyState: 'complete', nodeType: 9, location: { href: 'https://shop.example/checkout' } }
  const element = (tagName, rect, attrs = {}, extra = {}) => ({
    ownerDocument: doc, isConnected: true, tagName, parentElement: null, nodeType: 1,
    getAttribute: name => Object.hasOwn(attrs, name) ? attrs[name] : null,
    getBoundingClientRect: () => rect, ...extra,
  })
  const nodes = {
    password: element('INPUT', passwordRect, { type: 'password' }, { type: 'password' }),
    card: element('INPUT', { left: 20, top: 130, width: 200, height: 30 }, { type: 'text', autocomplete: 'cc-number' }, { type: 'text' }),
    note: element('INPUT', { left: 20, top: 180, width: 200, height: 30 }, { type: 'text', placeholder: 'Delivery note' }, { type: 'text' }),
    hiddenPassword: element('INPUT', { left: 0, top: 0, width: 0, height: 0 }, { type: 'password' }, { type: 'password' }),
    offscreenPassword: element('INPUT', { left: 2000, top: 80, width: 160, height: 30 }, { type: 'password' }, { type: 'password' }),
    payFrame: element('IFRAME', { left: 300, top: 60, width: 320, height: 200 }, { title: 'Payment' },
      { contentDocument: { nodeType: 9, location: { href: 'https://pay.other/frame' } } }),
    blankFrame: element('IFRAME', { left: 300, top: 300, width: 100, height: 100 }, {}, { contentDocument: null }),
    button: element('BUTTON', { left: 20, top: 230, width: 100, height: 32 }, {}, { innerText: 'Pay' }),
  }
  const all = Object.values(nodes)
  doc.body = element('BODY', { left: 0, top: 0, width: 720, height: 480 })
  doc.documentElement = element('HTML', { left: 0, top: 0, width: 720, height: 480 })
  doc.activeElement = doc.body
  doc.querySelectorAll = () => all
  doc.createTreeWalker = () => ({ nextNode: () => null })
  const win = {
    location: doc.location, innerWidth: 720, innerHeight: 480, devicePixelRatio: 1,
    getComputedStyle: node => ({ display: 'block', visibility: 'visible', opacity: node?.opacity ?? '1', transform: 'none' }),
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return [] } },
    setTimeout,
  }
  actor.document = doc
  actor.contentWindow = win
  actor.manager = { innerWindowId: 77 }
  actor.browsingContext = { id: 5 }
  return { actor, nodes, doc }
}

test('child cover pass lists painted sensitive fields and unread frames with top-viewport boxes', () => {
  const f = childFixture()
  const first = f.actor.screenshotMask()
  assert.equal(first.complete, true)
  assert.equal(first.incompleteReason, null)
  assert.equal(first.innerWindowId, 77)
  assert.equal(first.browsingContextId, 5)
  assert.deepEqual(first.viewport, viewport)
  assert.deepEqual(first.regions, [
    { kind: 'sensitive-field', reason: 'password', rect: passwordRect },
    { kind: 'sensitive-field', reason: 'sensitive-autocomplete', rect: { left: 20, top: 130, width: 200, height: 30 } },
    { kind: 'sensitive-field', reason: 'password', rect: { left: 2000, top: 80, width: 160, height: 30 } },
    { kind: 'frame', reason: 'cross-origin', rect: { left: 300, top: 60, width: 320, height: 200 } },
    { kind: 'frame', reason: 'unreadable', rect: { left: 300, top: 300, width: 100, height: 100 } },
  ])
  assert.equal(first.regionCount, 5)
  // The plain field and the button are not covered; the same page reports
  // the same boxes again, so a capture between the two passes may be sent.
  const decision = mask.screenshotDecision({ before: first, after: f.actor.screenshotMask(), image: { width: 720, height: 480 } })
  assert.equal(decision.send, true)
  assert.equal(decision.masks.length, 4, 'the off-screen password covers nothing')
  // A field that stops painting (opacity 0) leaves the report; a box the
  // actor cannot measure makes the report incomplete.
  f.nodes.card.opacity = '0'
  assert.equal(f.actor.screenshotMask().regions.filter(region => region.reason === 'sensitive-autocomplete').length, 0)
  f.nodes.password.getBoundingClientRect = () => ({ left: 20, top: 80, width: Number.NaN, height: 30 })
  const broken = f.actor.screenshotMask()
  assert.equal(broken.complete, false)
  assert.equal(broken.incompleteReason, 'rect-unavailable')
  assert.deepEqual(mask.screenshotDecision({ before: broken, after: broken, image: { width: 720, height: 480 } }), { send: false, reason: 'rect-unavailable' })
})

test('child forwards the parent ticket on an observe request with options.screenshot and returns only a sent capture or a reason', async () => {
  const f = childFixture()
  const queries = []
  f.actor.sendQuery = async (name, data) => {
    queries.push([name, data])
    return { send: true, imageUrl: 'data:image/jpeg;base64,QUJD', format: 'jpeg', width: 720, height: 480, imageScale: 1, maskedRegions: [], maskCount: 0 }
  }
  const result = await f.actor.receiveMessage({ name: 'snapshot', data: { options: { textLimit: 1, elementLimit: 1,
    screenshot: { ticket: 'ticket-1', maxEdge: 1280, budgetChars: 150000, format: 'jpeg', quality: 0.7 } } } })
  assert.deepEqual(queries, [['captureScreenshot', { ticket: 'ticket-1', maxEdge: 1280, budgetChars: 150000, format: 'jpeg', quality: 0.7 }]])
  assert.equal(result.screenshot.send, true)
  assert.equal(result.screenshot.imageUrl, 'data:image/jpeg;base64,QUJD')
  assert.equal(result.url, 'https://shop.example/checkout')
  assert.equal(typeof result.documentId, 'string')
  assert.equal(result.text.length, 0)
  f.actor.sendQuery = async () => ({ send: false, reason: 'mask-moved' })
  const withheld = await f.actor.receiveMessage({ name: 'snapshot', data: { options: { screenshot: { ticket: 'ticket-2' } } } })
  assert.deepEqual(withheld.screenshot, { send: false, reason: 'mask-moved' })
  f.actor.sendQuery = async () => { throw new Error('actor destroyed') }
  const failed = await f.actor.receiveMessage({ name: 'snapshot', data: { options: { screenshot: { ticket: 'ticket-3' } } } })
  assert.deepEqual(failed.screenshot, { send: false, reason: 'capture-failed' })
  f.actor.sendQuery = async () => ({ imageUrl: 'data:image/jpeg;base64,QUJD' })
  const unmarked = await f.actor.receiveMessage({ name: 'snapshot', data: { options: { screenshot: { ticket: 'ticket-4' } } } })
  assert.deepEqual(unmarked.screenshot, { send: false, reason: 'capture-failed' }, 'a reply without send:true never carries an image')
  // A plain observe is unchanged and the cover pass answers its own message.
  const plain = await f.actor.receiveMessage({ name: 'snapshot', data: { options: { textLimit: 60, elementLimit: 80 } } })
  assert.equal(Object.hasOwn(plain, 'screenshot'), false)
  assert.equal((await f.actor.receiveMessage({ name: 'screenshotMask', data: {} })).complete, true)
})

// Parent actor fixture: a fake WindowGlobalParent with drawSnapshot, a chrome
// owner document that hands out a recording canvas, and a child whose
// screenshotMask answers come from a queue.
function parentFixture({ reports, bitmap = { width: 720, height: 480 }, dataUrlLength = 4000 } = {}) {
  const parent = new EGDeskBrowserAgentRuntimeParent()
  const calls = []
  let closed = 0
  const canvas = {
    width: 0, height: 0,
    getContext: () => ({ fillStyle: '', drawImage: (...args) => calls.push(['drawImage', ...args.slice(1)]),
      fillRect: (...args) => calls.push(['fillRect', ...args]) }),
    toDataURL: (mime, quality) => { calls.push(['toDataURL', mime, quality, canvas.width, canvas.height]); return `data:image/jpeg;base64,${'A'.repeat(dataUrlLength)}` },
  }
  const ownerDocument = { nodePrincipal: { isSystemPrincipal: true }, createElementNS: (ns, tag) => { calls.push(['createElementNS', ns, tag]); return canvas } }
  const ownerWindow = { document: ownerDocument }
  ownerDocument.defaultView = ownerWindow
  const browser = { localName: 'browser', isConnected: true, ownerDocument, browsingContext: { id: 101 },
    closest: selector => selector === '.egd-browser-card' ? { isConnected: true } : null }
  const context = { id: 101, embedderElement: browser }
  context.top = context
  parent.browsingContext = context
  parent.manager = { innerWindowId: 77, isCurrentGlobal: true, isClosed: false,
    drawSnapshot: async (rect, scale, background) => { calls.push(['drawSnapshot', rect, scale, background]); return { ...bitmap, close() { closed++ } } } }
  const childQueries = []
  parent.querySink = async (name, data) => {
    childQueries.push([name, data])
    if (name === 'screenshotMask') return reports.shift()
    return { snapshotFor: name, data }
  }
  return { parent, calls, childQueries, canvas, get closed() { return closed } }
}

test('parent mints a one-time ticket only on a screenshot observe query and refuses captures without it', async () => {
  const f = parentFixture({ reports: [report(), report()] })
  const plain = await f.parent.sendQuery('snapshot', { options: { textLimit: 60 } })
  assert.deepEqual(plain.data, { options: { textLimit: 60 } }, 'a plain observe query is passed through unchanged')
  const query = await f.parent.sendQuery('snapshot', { options: { textLimit: 1, screenshot: { maxEdge: 1280 } } })
  const ticket = query.data.options.screenshot.ticket
  assert.equal(typeof ticket, 'string')
  assert.equal(query.data.options.screenshot.maxEdge, 1280)
  assert.deepEqual(await f.parent.receiveMessage({ name: 'captureScreenshot', data: { ticket: 'forged' } }), { send: false, reason: 'unauthorized' })
  assert.deepEqual(await f.parent.receiveMessage({ name: 'captureScreenshot', data: {} }), { send: false, reason: 'unauthorized' })
  assert.equal(f.calls.length, 0, 'nothing is captured for an unauthorized request')
  const sent = await f.parent.receiveMessage({ name: 'captureScreenshot', data: { ticket, maxEdge: 1280, budgetChars: 150000, format: 'jpeg', quality: 0.7 } })
  assert.equal(sent.send, true)
  assert.match(sent.imageUrl, /^data:image\/jpeg;base64,A+$/)
  assert.deepEqual([sent.format, sent.width, sent.height, sent.imageScale, sent.maskCount, sent.documentId, sent.revision, sent.innerWindowId],
    ['jpeg', 720, 480, 1, 1, 'doc-a', 4, 77])
  assert.deepEqual(sent.maskedRegions, [{ kind: 'sensitive-field', reason: 'password', bounds: { x: 17, y: 77, width: 166, height: 36 } }])
  assert.deepEqual(f.childQueries.filter(([name]) => name === 'screenshotMask').length, 2, 'boxes are read before and after the capture')
  assert.deepEqual(f.calls.filter(([name]) => name === 'drawSnapshot'), [['drawSnapshot', null, 1, 'white']])
  assert.deepEqual(f.calls.filter(([name]) => name === 'fillRect'), [['fillRect', 16, 76, 168, 38]], 'the cover is painted before encoding')
  assert.ok(f.calls.findIndex(([name]) => name === 'fillRect') < f.calls.findIndex(([name]) => name === 'toDataURL'))
  assert.equal(f.closed, 1, 'the bitmap is released')
  assert.deepEqual(await f.parent.receiveMessage({ name: 'captureScreenshot', data: { ticket } }), { send: false, reason: 'unauthorized' }, 'a ticket is spent once')
})

test('parent sends nothing when the boxes moved during capture, the capture is unsupported, or no size fits the budget', async () => {
  const moved = parentFixture({ reports: [report(), report({ regions: [] })] })
  const ticket = (await moved.parent.sendQuery('snapshot', { options: { screenshot: {} } })).data.options.screenshot.ticket
  assert.deepEqual(await moved.parent.receiveMessage({ name: 'captureScreenshot', data: { ticket } }), { send: false, reason: 'mask-moved' })
  assert.equal(moved.calls.some(([name]) => name === 'toDataURL'), false, 'no image is encoded')
  assert.equal(moved.closed, 1)
  const incomplete = parentFixture({ reports: [report({ complete: false, incompleteReason: 'scan-budget' }), report()] })
  const ticket2 = (await incomplete.parent.sendQuery('snapshot', { options: { screenshot: {} } })).data.options.screenshot.ticket
  assert.deepEqual(await incomplete.parent.receiveMessage({ name: 'captureScreenshot', data: { ticket: ticket2 } }), { send: false, reason: 'scan-budget' })
  const tooLarge = parentFixture({ reports: [report(), report()], dataUrlLength: 200000 })
  const ticket3 = (await tooLarge.parent.sendQuery('snapshot', { options: { screenshot: {} } })).data.options.screenshot.ticket
  assert.deepEqual(await tooLarge.parent.receiveMessage({ name: 'captureScreenshot', data: { ticket: ticket3, budgetChars: 150000 } }), { send: false, reason: 'image-too-large' })
  assert.deepEqual(tooLarge.calls.filter(([name]) => name === 'toDataURL').map(call => call.slice(3)), [[720, 480], [576, 384], [576, 384]], 'every size and the fallback quality were tried')
  assert.equal(tooLarge.closed, 1)
  const replaced = parentFixture({ reports: [report(), report()] })
  const ticket4 = (await replaced.parent.sendQuery('snapshot', { options: { screenshot: {} } })).data.options.screenshot.ticket
  replaced.parent.manager.innerWindowId = 78
  assert.deepEqual(await replaced.parent.receiveMessage({ name: 'captureScreenshot', data: { ticket: ticket4 } }), { send: false, reason: 'document-changed' })
  assert.equal(replaced.calls.some(([name]) => name === 'drawSnapshot'), false)
  const unsupported = parentFixture({ reports: [report(), report()] })
  const ticket5 = (await unsupported.parent.sendQuery('snapshot', { options: { screenshot: {} } })).data.options.screenshot.ticket
  delete unsupported.parent.manager.drawSnapshot
  assert.deepEqual(await unsupported.parent.receiveMessage({ name: 'captureScreenshot', data: { ticket: ticket5 } }), { send: false, reason: 'capture-unsupported' })
  assert.deepEqual(unsupported.parent.receiveMessage({ name: 'authorizeAct', data: {} }), { authorized: false, reason: 'missing-authorizer' }, 'the act path is unchanged')
})

// Helper side: the tool rides on an observe request and the provider hands
// the image to the model as its own inputImage item.
const { createBrowserToolService } = await import('../helper/egdesk-browser-tool-runtime.mjs')
const { createCodexBrowserToolProvider } = await import('../helper/codex-browser-tool-provider.mjs')
const helperRun = { answerId: 'answer-1', runId: 'run-1', clientThreadId: 'thread-a', status: 'inProgress' }
function helperSource(permission) {
  return { id: 'selected-browser-1', kind: 'browser', selectedByUser: true,
    browserToolPermission: permission, browserToolSelection: { token: 'grant-browser-1', threadId: 'thread-a' },
    browserToolIdentity: { cardEpoch: 'card-epoch-1', userContextId: 0,
      engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 0 },
    sourceRef: { viewId: 'browser-1', profileId: 'firefox-default', accountId: 'fixture-account', uri: 'https://example.test/local' } }
}
const sentCapture = { send: true, imageUrl: 'data:image/jpeg;base64,QUJD', format: 'jpeg', width: 720, height: 480, imageScale: 1,
  maskedRegions: [{ kind: 'sensitive-field', reason: 'password', bounds: { x: 17, y: 77, width: 166, height: 36 } }], maskCount: 1,
  documentId: 'document-1', revision: 3, innerWindowId: 77 }
function helperFixture(permission, screenshot) {
  const requests = []
  const current = { cardId: 'browser-1', documentId: 'document-1', revision: 3, coordinateSpace: 'browser-viewport-local',
    viewport: { width: 720, height: 480, devicePixelRatio: 1 }, url: 'https://example.test/local', title: 'Fixture', text: [],
    interactiveElements: [], ...(screenshot === undefined ? {} : { screenshot }) }
  const sendToUi = async request => {
    requests.push(request)
    if (request.kind === 'bind') return { requestId: request.requestId, status: 'bound',
      binding: { cardId: 'browser-1', cardEpoch: 'card-epoch-1', profileId: 'firefox-default', accountId: 'fixture-account',
        userContextId: 0, url: 'https://example.test/local', engineAccountKey: 'codex:chatgpt:fixture@example.test', authorityEpoch: 0 } }
    if (request.kind === 'observe') return { requestId: request.requestId, status: 'observed', snapshot: current }
    throw new Error(`unexpected UI request ${request.kind}`)
  }
  const service = createBrowserToolService({ sendToUi, getOwnerKey: () => 'engine-account-1' })
  return { service, requests, permission }
}
async function boundDispatch(f, tool, args, callId) {
  const prepared = f.service.prepare({ selectedSources: [helperSource(f.permission)] })
  await f.service.bind(helperRun, prepared)
  return f.service.dispatch(helperRun, { tool, callId, arguments: args })
}

test('helper sends the screenshot tool as an observe request with screenshot options under an observe grant', async () => {
  const f = helperFixture('observe', sentCapture)
  const result = await boundDispatch(f, 'egdesk_browser_screenshot', { cardId: 'browser-1' }, 'call-shot-1')
  const observe = f.requests.find(request => request.kind === 'observe')
  assert.deepEqual(observe.options, { textLimit: 1, elementLimit: 1,
    screenshot: { maxEdge: 1280, budgetChars: 150000, format: 'jpeg', quality: 0.7 } })
  assert.equal(result.status, 'screenshot-observed')
  assert.equal(result.cardId, 'browser-1')
  assert.equal(result.documentId, 'document-1')
  assert.equal(result.revision, 3)
  assert.equal(result.externalEffectVerified, false)
  assert.equal(Object.hasOwn(result, 'observationId'), false, 'a screenshot is not an observation')
  const { send: _send, ...expected } = sentCapture
  assert.deepEqual(result.screenshot, expected)
})

test('helper reports a withheld screenshot with its reason and refuses an image it cannot verify', async () => {
  const withheld = await boundDispatch(helperFixture('observe', { send: false, reason: 'mask-moved' }), 'egdesk_browser_screenshot', { cardId: 'browser-1' }, 'call-shot-2')
  assert.equal(withheld.status, 'screenshot-withheld')
  assert.deepEqual(withheld.screenshot, { reason: 'mask-moved' })
  for (const bad of [undefined, { send: true, imageUrl: 'https://example.test/shot.jpg', format: 'jpeg', width: 720, height: 480, imageScale: 1, maskedRegions: [] },
    { send: true, imageUrl: 'data:image/jpeg;base64,QUJD', format: 'jpeg', width: 720, height: 480, imageScale: 1, maskedRegions: [{ kind: 'x' }] },
    { send: false }]) {
    await assert.rejects(boundDispatch(helperFixture('observe', bad), 'egdesk_browser_screenshot', { cardId: 'browser-1' }, 'call-shot-3'),
      error => error.code === 'BROWSER_OBSERVATION_UNAVAILABLE')
  }
  // Even with an interaction grant the screenshot never becomes the fresh
  // observation an action may spend.
  const f = helperFixture('interact', sentCapture)
  await boundDispatch(f, 'egdesk_browser_screenshot', { cardId: 'browser-1' }, 'call-shot-4')
  await assert.rejects(f.service.dispatch(helperRun, { tool: 'egdesk_browser_click', callId: 'call-click-1', arguments: {
    cardId: 'browser-1', observationId: 'screenshot', expectedRevision: 3, ref: 'el_1',
    expectedTarget: { ref: 'el_1', role: 'button', label: 'Pay', href: '', value: '', tag: 'button' },
    postcondition: { kind: 'visible-text', value: 'Paid' } } }), error => error.code === 'BROWSER_OBSERVATION_STALE')
  assert.equal(f.requests.some(request => request.kind === 'act'), false)
})

test('provider attaches a sent screenshot as an inputImage item and allows the tool with an observe-only Card', async () => {
  const events = []
  const results = new Map()
  const service = { prepare: () => null, bind: async () => ({ cards: [] }), cancelRun: async () => [], reset: async () => [],
    dispatch: async (run, event) => results.get(event.callId) }
  const transport = { runs: new Map(), hasClient: () => true, bindRun() {}, unbindRun() {}, reset() {} }
  const provider = createCodexBrowserToolProvider({ transport, getOwnerKey: () => 'codex:account-1', service })
  provider.runtime = { browserRegisteredThreads: new Set(), currentEpoch: () => 1, emit: (run, event, detail) => events.push({ event, detail }) }
  const run = { answerId: 'a/1', runId: 'turn-1', clientThreadId: 'ui-thread-1', status: 'inProgress',
    executionPolicy: { mode: 'browserBounded' }, browserBinding: { cards: [{ cardId: 'card-1', permission: 'observe', sourceId: 'source-1' }] } }
  const { send: _send, ...screenshot } = sentCapture
  results.set('call-1', { status: 'screenshot-observed', cardId: 'card-1', documentId: 'document-1', revision: 3, screenshot, externalEffectVerified: false })
  results.set('call-2', { status: 'screenshot-withheld', cardId: 'card-1', documentId: 'document-1', revision: 3, screenshot: { reason: 'image-too-large' }, externalEffectVerified: false })
  const sent = await provider.dispatch(run, { tool: 'egdesk_browser_screenshot', callId: 'call-1', arguments: { cardId: 'card-1' } })
  assert.equal(sent.success, true)
  assert.equal(sent.contentItems.length, 2)
  assert.equal(sent.contentItems[0].type, 'inputText')
  assert.equal(JSON.parse(sent.contentItems[0].text).screenshot.imageUrl, '[attached image]')
  assert.equal(JSON.parse(sent.contentItems[0].text).screenshot.maskCount, 1)
  assert.deepEqual(sent.contentItems[1], { type: 'inputImage', imageUrl: 'data:image/jpeg;base64,QUJD' })
  assert.equal(events.at(-1).event, 'browser.tool.completed')
  assert.equal(events.at(-1).detail.externalEffectVerified, false)
  const withheld = await provider.dispatch(run, { tool: 'egdesk_browser_screenshot', callId: 'call-2', arguments: { cardId: 'card-1' } })
  assert.equal(withheld.success, false)
  assert.equal(withheld.contentItems.length, 1)
  assert.equal(JSON.parse(withheld.contentItems[0].text).screenshot.reason, 'image-too-large')
  assert.equal(events.at(-1).event, 'browser.tool.unverified')
  const denied = await provider.dispatch(run, { tool: 'egdesk_browser_click', callId: 'call-3', arguments: { cardId: 'card-1' } })
  assert.equal(JSON.parse(denied.contentItems[0].text).error.code, 'BROWSER_INTERACTION_NOT_GRANTED', 'an observe grant still never acts')
})
