import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTION_EFFECTS, COMPUTER_ADAPTER_CODES, COMPUTER_METHODS, DELIVERY_CEILINGS,
  createComputerAdapter, createFakeComputerProvider, normalizeActionResult, validateComputerArgs,
} from './egdesk-computer-adapter.mjs'
import { HOST_LEASE_CODES, createHostLease } from './egdesk-host-lease.mjs'

const A = COMPUTER_ADAPTER_CODES
const L = HOST_LEASE_CODES
const TEXTEDIT = { app: 'com.apple.TextEdit' }
const WINDOW = { app: 'com.apple.TextEdit', windowId: 11 }
const RECORD_KEYS = ['at', 'commandId', 'method', 'app', 'inputBytes', 'effect', 'route', 'deliveryMode', 'dispatched', 'code', 'durationMs']
const flush = () => new Promise(resolve => setImmediate(resolve))

function fakeTimers() {
  const pending = new Map()
  let id = 0
  return {
    setTimeout(fn) { pending.set(++id, fn); return id },
    clearTimeout(handle) { pending.delete(handle) },
    fire() { for (const [handle, fn] of [...pending]) { pending.delete(handle); fn() } },
    get size() { return pending.size },
  }
}

function setup({ provider = createFakeComputerProvider(), lease: withLease = true, deliveryCeiling, timers, providerOptions } = {}) {
  const clock = { t: 1000 }
  const lease = withLease ? createHostLease({ now: () => clock.t }) : null
  lease?.setInputMonitor(true)
  const fake = providerOptions ? createFakeComputerProvider(providerOptions) : provider
  const records = []
  const adapter = createComputerAdapter({ provider: fake, lease, now: () => clock.t, onRecord: entry => records.push(entry), ...(deliveryCeiling ? { deliveryCeiling } : {}), ...(timers ? { timers } : {}) })
  return { adapter, lease, provider: fake, records, clock }
}

test('a provider result becomes the closed result: confirmed needs evidence, partial a count, refused neither and is never dispatched', () => {
  assert.deepEqual(ACTION_EFFECTS, ['confirmed', 'partial', 'unverifiable', 'suspected_noop', 'refused'])
  const confirmed = normalizeActionResult({ effect: 'confirmed', route: 'accessibility', delivery: { mode: 'background' }, evidence: [{ kind: 'value_readback', detail: 'value read back as 42' }], summary: 'Set value', selector: '#x', x: 5 })
  assert.deepEqual(confirmed, { effect: 'confirmed', route: 'accessibility', delivery: { mode: 'background' }, evidence: [{ kind: 'value_readback', detail: 'value read back as 42' }], summary: 'Set value', dispatched: true })
  assert.equal(normalizeActionResult({ effect: 'confirmed', route: 'accessibility', evidence: [] }).effect, 'unverifiable')
  assert.equal(normalizeActionResult({ effect: 'confirmed', evidence: [{ kind: 'screenshot_changed' }] }).effect, 'unverifiable', 'only published evidence kinds count')
  assert.equal(normalizeActionResult({ effect: 'partial', delivery: { mode: 'background' } }).effect, 'unverifiable')
  assert.deepEqual(normalizeActionResult({ effect: 'partial', delivery: { mode: 'background', delivered_count: 2 } }).delivery, { mode: 'background', deliveredCount: 2 })
  const refused = normalizeActionResult({ effect: 'refused', route: 'synthetic_events', delivery: { mode: 'background' }, evidence: [{ kind: 'window_change' }], error: { code: 'background_unavailable', hint: 'Try another way.' } })
  assert.deepEqual(refused, { effect: 'refused', route: 'synthetic_events', summary: '', dispatched: false, error: { code: 'background_unavailable', hint: 'Try another way.' } })
  assert.equal(normalizeActionResult({ effect: 'refused', error: { code: 'bad code!' } }).error.code, A.PROVIDER_REFUSED)
  assert.equal('error' in normalizeActionResult({ effect: 'unverifiable', error: { code: 'x' } }), false, 'error only on refused')
  assert.deepEqual(normalizeActionResult({ effect: 'surprise' }), { effect: 'unverifiable', route: null, delivery: { mode: 'unknown' }, evidence: [], summary: '', dispatched: true })
  // next_call must be a read with valid arguments; a foreground retry is never one.
  assert.deepEqual(normalizeActionResult({ effect: 'unverifiable', next_call: { tool: 'capture', arguments: { target: TEXTEDIT } } }).nextCall, { tool: 'capture', arguments: { target: TEXTEDIT } })
  for (const nextCall of [{ tool: 'click', arguments: { target: TEXTEDIT, element: '1' } }, { tool: 'capture', arguments: { target: TEXTEDIT, pid: 5 } }, { tool: 'capture' }, 'capture']) {
    assert.equal('nextCall' in normalizeActionResult({ effect: 'unverifiable', nextCall }), false, JSON.stringify(nextCall))
  }
  // Text is capped and common secrets are redacted.
  const long = normalizeActionResult({ effect: 'unverifiable', summary: `token=sk-abcdefghijklmnop ${'x'.repeat(900)}`, hint: 'y'.repeat(400) })
  assert.ok(long.summary.length <= 500)
  assert.doesNotMatch(long.summary, /sk-abcdefghijklmnop/)
  assert.ok(long.hint.length <= 240)
  assert.equal(normalizeActionResult({ effect: 'unverifiable' }, { dispatched: 'unknown' }).dispatched, 'unknown')
})

test('arguments: only known fields, an element or a point with its frame, capped text and plain key names', () => {
  assert.deepEqual(validateComputerArgs('click', { target: TEXTEDIT, element: '12' }), { target: TEXTEDIT, element: '12', button: 'left', count: 1 })
  assert.deepEqual(validateComputerArgs('click', { target: WINDOW, x: 10, y: 20.5, frame: 3, button: 'right', count: 2 }), { target: WINDOW, x: 10, y: 20.5, frame: 3, button: 'right', count: 2 })
  assert.deepEqual(validateComputerArgs('key', { target: TEXTEDIT, key: 'cmd+shift+t' }), { target: TEXTEDIT, key: 'cmd+shift+t' })
  assert.deepEqual(validateComputerArgs('scroll', { target: TEXTEDIT, direction: 'down' }), { target: TEXTEDIT, direction: 'down', amount: 3 })
  assert.deepEqual(validateComputerArgs('listApps', undefined), {})
  assert.deepEqual(validateComputerArgs('listWindows', {}), {})
  const bad = [
    ['click', { target: TEXTEDIT }, 'element'],
    ['click', { target: TEXTEDIT, element: '1', x: 1, y: 1, frame: 1 }, 'element'],
    ['click', { target: TEXTEDIT, x: 1, y: 1 }, 'frame'],
    ['click', { target: TEXTEDIT, x: -1, y: 1, frame: 1 }, 'x'],
    ['click', { target: TEXTEDIT, element: '1', pid: 501 }, null],
    ['click', { target: { app: 'TextEdit', pid: 501 }, element: '1' }, null],
    ['click', { target: { app: '' }, element: '1' }, 'target.app'],
    ['click', { element: '1' }, 'target'],
    ['click', { target: TEXTEDIT, element: '1', count: 4 }, 'count'],
    ['typeText', { target: TEXTEDIT, text: '' }, 'text'],
    ['typeText', { target: TEXTEDIT, text: 'x'.repeat(4001) }, 'text'],
    ['key', { target: TEXTEDIT, key: 'cmd+q; rm -rf /' }, 'key'],
    ['key', { target: TEXTEDIT, key: 'a+b+c+d+e+f' }, 'key'],
    ['scroll', { target: TEXTEDIT, direction: 'sideways' }, 'direction'],
    ['drag', { target: TEXTEDIT, from: { x: 1, y: 1 }, to: { x: 2, y: 2 } }, 'frame'],
    ['capture', { target: TEXTEDIT, maxEdge: 10000 }, 'maxEdge'],
    ['listApps', { all: true }, null],
    ['teleport', {}, 'method'],
  ]
  for (const [method, args, field] of bad) {
    assert.throws(() => validateComputerArgs(method, args), error => error.field === field, `${method} ${JSON.stringify(args)}`)
  }
})

test('the adapter lists what the provider implements and refuses unknown methods, missing methods and bad arguments without echoing values', async () => {
  const partial = { capture: async () => ({}), click: async () => ({}) }
  const { adapter, records } = setup({ provider: partial })
  assert.deepEqual(adapter.methods(), ['capture', 'click'])
  assert.deepEqual(COMPUTER_METHODS, ['capture', 'listApps', 'listWindows', 'click', 'typeText', 'key', 'scroll', 'drag', 'readElements'])
  assert.equal((await adapter.call('teleport', {})).error.code, A.UNKNOWN_METHOD)
  assert.equal((await adapter.call('typeText', { target: TEXTEDIT, text: 'hi' })).error.code, A.UNSUPPORTED_METHOD)
  const invalid = await adapter.call('click', { target: TEXTEDIT, element: '1', secretField: 'Hunter2' })
  assert.deepEqual([invalid.error.code, invalid.dispatched], [A.INVALID_ARGUMENTS, false])
  assert.doesNotMatch(JSON.stringify(invalid), /Hunter2|secretField/)
  assert.match((await adapter.call('click', { target: TEXTEDIT })).error.hint, /element/)
  assert.deepEqual(records.map(record => [record.method, record.code]), [['invalid', A.UNKNOWN_METHOD], ['typeText', A.UNSUPPORTED_METHOD], ['click', A.INVALID_ARGUMENTS], ['click', A.INVALID_ARGUMENTS]])
  assert.throws(() => createComputerAdapter({}), TypeError)
  assert.throws(() => createComputerAdapter({ provider: partial, deliveryCeiling: 'anything' }), TypeError)
  assert.deepEqual(DELIVERY_CEILINGS, ['view-only', 'background', 'allow-activation'])
})

test('an action without a host lease is refused and the provider is never called (fail closed); reads still work', async () => {
  const { adapter, provider } = setup({ lease: false })
  const result = await adapter.call('click', { target: TEXTEDIT, element: '1' })
  assert.deepEqual([result.effect, result.error.code, result.dispatched], ['refused', A.NO_HOST_LEASE, false])
  assert.deepEqual(provider.calls, [])
  assert.equal((await adapter.call('listApps')).ok, true)
})

test('the delivery ceiling is checked before the provider: view-only, background-only by default, or allow-activation', async () => {
  const background = setup()
  const drag = { target: WINDOW, from: { x: 1, y: 1 }, to: { x: 50, y: 50 }, frame: 1 }
  await background.adapter.call('capture', { target: WINDOW })
  const refused = await background.adapter.call('drag', drag)
  assert.deepEqual([refused.error.code, refused.dispatched], [A.WOULD_REQUIRE_ACTIVATION, false])
  assert.deepEqual(background.provider.events, [])
  const allowed = setup({ deliveryCeiling: 'allow-activation' })
  await allowed.adapter.call('capture', { target: WINDOW })
  const dragged = await allowed.adapter.call('drag', drag)
  assert.deepEqual([dragged.effect, dragged.delivery.mode, dragged.dispatched], ['confirmed', 'foreground', true])
  assert.deepEqual(allowed.provider.events.map(event => event.phase), ['down', 'move', 'up'])
  const viewOnly = setup({ deliveryCeiling: 'view-only' })
  assert.equal((await viewOnly.adapter.call('click', { target: TEXTEDIT, element: '1' })).error.code, A.VIEW_ONLY)
  assert.equal((await viewOnly.adapter.call('listApps')).ok, true, 'view-only can still look')
  const unsupported = setup({ providerOptions: { guarantees: { scroll: 'unsupported' } } })
  assert.equal((await unsupported.adapter.call('scroll', { target: TEXTEDIT, direction: 'down' })).error.code, A.UNSUPPORTED_ACTION)
  // A provider that cannot say how it delivers is treated as bringing the app forward.
  const silent = setup({ provider: { ...createFakeComputerProvider(), guarantee() { throw new Error('unknown') } } })
  assert.equal((await silent.adapter.call('click', { target: TEXTEDIT, element: '1' })).error.code, A.WOULD_REQUIRE_ACTIVATION)
})

test('a point is only used in the frame it was read from: the last capture, read again right before sending', async () => {
  const { adapter, provider } = setup()
  const noCapture = await adapter.call('click', { target: WINDOW, x: 10, y: 10, frame: 1 })
  assert.deepEqual([noCapture.error.code, noCapture.nextCall], [A.STALE_FRAME, { tool: 'capture', arguments: { target: WINDOW } }])
  const shot = await adapter.call('capture', { target: WINDOW })
  assert.deepEqual(shot, { ok: true, frame: { target: WINDOW, windowId: 11, width: 800, height: 600, scale: 2, geometryRevision: 1 }, image: { mime: 'image/png', data: 'iVBORw0KGgo=' } })
  const clicked = await adapter.call('click', { target: WINDOW, x: 10, y: 10, frame: 1 })
  assert.deepEqual([clicked.effect, clicked.route, clicked.dispatched], ['confirmed', 'synthetic_events', true])
  // The window moved after the capture: the re-read inside the lease refuses before any event.
  provider.setRevision(WINDOW, 2)
  const before = provider.events.length
  const moved = await adapter.call('click', { target: WINDOW, x: 10, y: 10, frame: 1 })
  assert.deepEqual([moved.error.code, moved.dispatched], [A.STALE_FRAME, false])
  assert.equal(provider.events.length, before)
  assert.equal((await adapter.call('click', { target: WINDOW, x: 10, y: 10, frame: 2 })).error.code, A.STALE_FRAME, 'a frame number the Agent was never given')
  await adapter.call('capture', { target: WINDOW })
  assert.equal((await adapter.call('click', { target: WINDOW, x: 10, y: 10, frame: 2 })).effect, 'confirmed')
  // An element needs no frame; a provider that cannot re-read refuses points.
  assert.equal((await adapter.call('click', { target: TEXTEDIT, element: '4' })).route, 'accessibility')
  const { currentRevision, ...blind } = createFakeComputerProvider()
  assert.equal(typeof currentRevision, 'function')
  const noRevision = setup({ provider: blind })
  await noRevision.adapter.call('capture', { target: WINDOW })
  assert.equal((await noRevision.adapter.call('click', { target: WINDOW, x: 1, y: 1, frame: 1 })).error.code, A.COORDINATES_UNSUPPORTED)
})

test('a call is recorded as metadata only: no text, keys, coordinates, titles, images or summary', async () => {
  const { adapter, records } = setup()
  const secret = 'Hunter2 is my password'
  const typedArgs = { target: TEXTEDIT, text: secret }
  const typed = await adapter.call('typeText', typedArgs, { commandId: 'type-1' })
  assert.deepEqual([typed.effect, typed.evidence], ['confirmed', [{ kind: 'value_readback', detail: '22 characters read back' }]])
  await adapter.call('capture', { target: WINDOW })
  await adapter.call('click', { target: WINDOW, x: 321, y: 654, frame: 1 })
  await adapter.call('key', { target: TEXTEDIT, key: 'cmd+shift+z' })
  await adapter.call('listWindows', { target: TEXTEDIT })
  for (const record of records) assert.deepEqual(Object.keys(record), RECORD_KEYS)
  assert.deepEqual(records[0], { at: 1000, commandId: 'type-1', method: 'typeText', app: 'com.apple.textedit', inputBytes: Buffer.byteLength(JSON.stringify(typedArgs)), effect: 'confirmed', route: 'accessibility', deliveryMode: 'background', dispatched: true, code: null, durationMs: 0 })
  assert.doesNotMatch(JSON.stringify(records), /Hunter2|password|321|654|cmd\+shift|Untitled|iVBOR|Typed the text/)
  assert.deepEqual(records.map(record => record.effect), ['confirmed', 'read', 'confirmed', 'unverifiable', 'read'])
})

test('a person typing during the Agent\'s typing stops it at the next event; what was sent stays sent and the Agent waits', async () => {
  const holder = {}
  const provider = createFakeComputerProvider({ between: async ({ index }) => { if (index === 1) holder.lease.observeInput({ kind: 'key' }) } })
  const { adapter, lease } = setup({ provider })
  holder.lease = lease
  const result = await adapter.call('typeText', { target: TEXTEDIT, text: 'a'.repeat(30) })
  assert.deepEqual([result.effect, result.dispatched, result.outcomeCode], ['unverifiable', true, L.USER_INTERVENTION])
  assert.equal('nextCall' in result, false, 'after a takeover the Agent waits for the person, it does not look and retry')
  assert.deepEqual(provider.events, [{ method: 'typeText', kind: 'key', chars: 8 }])
  const next = await adapter.call('click', { target: TEXTEDIT, element: '1' })
  assert.deepEqual([next.error.code, next.dispatched], [L.USER_INTERVENTION, false])
  assert.equal(provider.events.length, 1)
  lease.handBack()
  assert.equal((await adapter.call('click', { target: TEXTEDIT, element: '1' })).effect, 'confirmed')
})

test('the input monitor seeing the Agent\'s own stamped events does not stop it', async () => {
  const holder = {}
  const provider = createFakeComputerProvider({ echo: event => holder.lease.observeInput(event) })
  const { adapter, lease } = setup({ provider })
  holder.lease = lease
  const result = await adapter.call('typeText', { target: TEXTEDIT, text: 'b'.repeat(20) })
  assert.equal(result.effect, 'confirmed')
  assert.equal(provider.events.length, 3)
  assert.equal(lease.status().state, 'ai')
})

test('while a person is using the Mac an action is refused before the provider; look again later', async () => {
  const { adapter, lease, provider } = setup()
  lease.observeInput({ kind: 'pointer' })
  const result = await adapter.call('click', { target: TEXTEDIT, element: '1' })
  assert.deepEqual([result.error.code, result.dispatched, result.nextCall.tool], [L.USER_CONTROL, false, 'capture'])
  assert.deepEqual(provider.calls, [])
})

test('a provider failure after the gate is an unknown outcome, never retried; before the gate it is a plain failure', async () => {
  const after = setup({ providerOptions: { fail: { click: 'throw-after' } } })
  const lost = await after.adapter.call('click', { target: TEXTEDIT, element: '1' })
  assert.deepEqual([lost.effect, lost.dispatched, lost.outcomeCode, lost.nextCall.tool], ['unverifiable', 'unknown', A.HOST_ACTION_OUTCOME_UNKNOWN, 'capture'])
  assert.equal(after.provider.calls.length, 1)
  assert.equal(after.records[0].code, A.HOST_ACTION_OUTCOME_UNKNOWN)
  const before = setup({ providerOptions: { fail: { click: 'throw-before' } } })
  const failed = await before.adapter.call('click', { target: TEXTEDIT, element: '1' })
  assert.deepEqual([failed.effect, failed.dispatched, failed.error.code], ['refused', false, A.HOST_ACTION_FAILED])
  // A provider that claims an effect without passing the gate is not vouched for.
  const sneaky = setup({ provider: { ...createFakeComputerProvider(), click: async () => ({ effect: 'confirmed', route: 'accessibility', evidence: [{ kind: 'window_change' }] }) } })
  const claimed = await sneaky.adapter.call('click', { target: TEXTEDIT, element: '1' })
  assert.deepEqual([claimed.effect, claimed.dispatched], ['unverifiable', 'unknown'])
  // A provider refusal without sending stays a refusal.
  const honest = setup({ provider: { ...createFakeComputerProvider(), click: async () => ({ effect: 'refused', route: 'accessibility', error: { code: 'background_unavailable' } }) } })
  const declined = await honest.adapter.call('click', { target: TEXTEDIT, element: '1' })
  assert.deepEqual([declined.effect, declined.dispatched, declined.error.code], ['refused', false, 'background_unavailable'])
})

test('on the deadline the call answers at once and the provider can send nothing more', async () => {
  const timers = fakeTimers()
  const hung = setup({ timers, providerOptions: { fail: { click: 'hang-after' } } })
  const pending = hung.adapter.call('click', { target: TEXTEDIT, element: '1' }, { deadlineMs: 2000 })
  await flush()
  timers.fire()
  const unknown = await pending
  assert.deepEqual([unknown.dispatched, unknown.outcomeCode], ['unknown', A.HOST_ACTION_OUTCOME_UNKNOWN])
  // Not sent yet when time runs out: refused, and a late attempt to send is stopped.
  let release
  const gate = new Promise(resolve => { release = resolve })
  const events = []
  const slow = {
    ...createFakeComputerProvider(),
    async click(args, ctx) { await gate; ctx.checkpoint(); events.push('click'); return { effect: 'confirmed', route: 'accessibility', evidence: [{ kind: 'window_change' }] } },
  }
  const late = setup({ timers, provider: slow })
  const waiting = late.adapter.call('click', { target: TEXTEDIT, element: '1' }, { deadlineMs: 2000 })
  await flush()
  timers.fire()
  const expired = await waiting
  assert.deepEqual([expired.effect, expired.dispatched, expired.error.code], ['refused', false, L.EXPIRED])
  release()
  await flush()
  assert.deepEqual(events, [])
  assert.equal(timers.size, 0, 'no timer is left behind')
})

test('stopping the app while the Agent holds a key releases it before the stop is acknowledged', async () => {
  const holder = {}
  const order = []
  const provider = createFakeComputerProvider({
    between: async ({ kind, index }) => {
      if (kind === 'key' && index === 1) holder.stop = holder.lease.stopApp(TEXTEDIT).then(ack => { order.push(`ack after ${provider.events.map(event => event.phase ?? event.kind).join(',')}`); return ack })
    },
  })
  const { adapter, lease } = setup({ provider })
  holder.lease = lease
  const result = await adapter.call('key', { target: TEXTEDIT, key: 'shift' })
  order.push('result')
  const ack = await holder.stop
  assert.deepEqual([result.effect, result.dispatched, result.outcomeCode], ['unverifiable', true, L.STOPPED])
  assert.deepEqual(provider.events.map(event => event.phase ?? event.kind), ['down', 'release'])
  assert.deepEqual([ack.scope, ack.app, ack.inFlight], ['app', 'com.apple.textedit', 1])
  assert.deepEqual(order, ['ack after down,release', 'result'], 'even a stop raised inside the first event waits for the release')
  assert.equal((await adapter.call('key', { target: TEXTEDIT, key: 'shift' })).error.code, L.STOPPED)
})

test('reads return only known fields, capped, and a failing read is reported, not thrown', async () => {
  const apps = [
    { name: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 501, active: true, path: '/Applications/TextEdit.app', token: 'secret' },
    { pid: 3 },
    ...Array.from({ length: 300 }, (_, index) => ({ name: `App ${index}`, bundleId: `com.example.app${index}`, pid: 1000 + index })),
  ]
  const windows = [
    { windowId: 11, app: 'com.apple.TextEdit', pid: 501, title: 'Notes', bounds: { x: 0, y: 0, width: 10, height: 10 }, onScreen: true, layer: 0 },
    { windowId: 12, app: 'com.apple.finder', pid: 502, title: 'Desktop', bounds: { x: 0, y: 0, width: 1, height: Number.NaN } },
    { app: 'com.apple.finder', title: 'no id' },
  ]
  const { adapter } = setup({ providerOptions: { apps, windows } })
  const listed = await adapter.call('listApps')
  assert.equal(listed.apps.length, 200)
  assert.deepEqual(listed.apps[0], { name: 'TextEdit', bundleId: 'com.apple.TextEdit', pid: 501, active: true })
  const all = await adapter.call('listWindows')
  assert.deepEqual(all.windows.map(window => [window.windowId, window.bounds]), [[11, { x: 0, y: 0, width: 10, height: 10 }], [12, null]])
  assert.deepEqual((await adapter.call('listWindows', { target: TEXTEDIT })).windows.map(window => window.windowId), [11])
  const broken = setup({ provider: { listApps: async () => { throw new Error('/Users/private/secret') } } })
  const failed = await broken.adapter.call('listApps')
  assert.deepEqual([failed.ok, failed.error.code], [false, A.HOST_ACTION_FAILED])
  assert.doesNotMatch(JSON.stringify(failed), /private/)
})
