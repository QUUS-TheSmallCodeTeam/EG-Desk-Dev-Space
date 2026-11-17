import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ANNOTATION_GROUNDING, ANNOTATION_ITEM_TYPES, ANNOTATION_PROVIDER_ID, ANNOTATION_PURPOSES, ANNOTATION_TARGET_KINDS,
  ANNOTATION_TOOL_LIMITS, ANNOTATION_TOOL_NAME, ANNOTATION_TOOL_SPECS, createAnnotationToolProvider, normalizeAnnotationArguments,
} from './egdesk-annotation-tool-provider.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { specManifestEntries } from './codex-native-tool-manifest.mjs'
import { PRIVATE_KEYS } from './egdesk-chat-store.mjs'
import { BROWSER_TOOL_SPECS } from './egdesk-browser-tool-runtime.mjs'
import { CONTEXT_TOOL_SPECS } from './egdesk-context-runtime.mjs'
import { PLAN_TOOL_SPECS } from './egdesk-plan-tool-provider.mjs'
import * as Screen from '../overlay/resources/EGDeskAnnotationState.sys.mjs'

const run = (over = {}) => ({ runId: 'turn-1', answerId: 'answer-7', status: 'inProgress', profileBinding: { profileId: 'rio' }, ...over })
const fixedId = () => 'ann-fixed'
const parse = response => JSON.parse(response.contentItems[0].text)
const call = (args, over = {}) => ({ tool: ANNOTATION_TOOL_NAME, callId: 'call-1', rpcId: 1, arguments: args, ...over })
const loginArgs = (over = {}) => ({
  cardId: 'egd-card-7', targetKind: 'browser', summary: '로그인 버튼 위치', units: 'viewportPx', grounding: 'dom',
  observation: { documentId: 'doc-1', revision: 4, viewport: { width: 1000, height: 800 }, scroll: { x: 0, y: 200 } },
  items: [
    { id: 'login', type: 'box', rect: { x: 100, y: 160, w: 300, h: 80 }, label: '로그인 버튼', purpose: 'locate', confidence: 0.934, ref: 'e12' },
    { id: 'hint', type: 'label', at: { x: 500, y: 40 }, label: '여기' },
    { id: 'point', type: 'arrow', from: { x: 500, y: 60 }, to: { x: 250, y: 160 }, toItemId: 'login' },
  ],
  ...over,
})

function harness({ emit } = {}) {
  const events = []
  const provider = createAnnotationToolProvider({ now: () => 5000, newId: fixedId })
  provider.runtime = { emit: emit || ((r, event, details) => events.push({ event, details })) }
  return { provider, events }
}

test('tool spec: one function with a closed schema, distinct from every existing EG-Desk tool, manifest-hashable', () => {
  assert.equal(ANNOTATION_TOOL_SPECS.length, 1)
  const [spec] = ANNOTATION_TOOL_SPECS
  assert.equal(spec.name, ANNOTATION_TOOL_NAME)
  assert.equal(spec.name, 'egdesk_publish_annotation')
  assert.equal(spec.inputSchema.additionalProperties, false)
  assert.deepEqual(spec.inputSchema.required, ['summary', 'items'])
  assert.equal(spec.inputSchema.properties.items.maxItems, 32)
  assert.equal(spec.inputSchema.properties.items.items.additionalProperties, false)
  const others = [...BROWSER_TOOL_SPECS, ...CONTEXT_TOOL_SPECS, ...PLAN_TOOL_SPECS].map(item => item.name)
  assert.equal(others.includes(spec.name), false)
  const entries = specManifestEntries(spec, ANNOTATION_PROVIDER_ID)
  assert.equal(entries.length, 1)
  assert.match(entries[0].schemaHash, /^[a-f0-9]{64}$/)
  const off = createAnnotationToolProvider({ schemaReady: () => false })
  assert.deepEqual(off.specs(), [])
  assert.equal(createAnnotationToolProvider().specs(), ANNOTATION_TOOL_SPECS)
})

test('tool vocabulary and limits match the screen annotation module', () => {
  assert.deepEqual([...ANNOTATION_ITEM_TYPES].sort(), [...Screen.ANNOTATION_ITEM_TYPES].sort())
  assert.deepEqual(ANNOTATION_PURPOSES, Screen.ANNOTATION_PURPOSES)
  assert.deepEqual(ANNOTATION_TARGET_KINDS, Screen.ANNOTATION_TARGET_KINDS)
  assert.deepEqual(ANNOTATION_GROUNDING, Screen.ANNOTATION_GROUNDING)
  for (const key of ['items', 'label', 'note', 'coordinate', 'canvasCoordinate']) assert.equal(ANNOTATION_TOOL_LIMITS[key], Screen.ANNOTATION_LIMITS[key], key)
})

test('viewport pixels become card ratios with provenance; the screen module keeps the set as is', () => {
  const set = normalizeAnnotationArguments(loginArgs(), { run: run(), now: 5000, newId: fixedId })
  assert.deepEqual(set, {
    version: 1, id: 'ann-fixed', space: 'card', targetCardId: 'egd-card-7', targetKind: 'browser',
    sourceRunId: 'turn-1', sourceMessageId: 'answer-7', createdByAgentId: 'rio', grounding: 'dom',
    source: { documentId: 'doc-1', revision: 4, viewport: { width: 1000, height: 800 }, scroll: { x: 0, y: 200 } },
    createdAt: 5000,
    items: [
      { id: 'login', type: 'box', rect: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 }, label: '로그인 버튼', purpose: 'locate', confidence: 0.93, ref: 'e12', status: 'proposed' },
      { id: 'hint', type: 'label', at: { x: 0.5, y: 0.05 }, label: '여기', status: 'proposed' },
      { id: 'point', type: 'arrow', from: { x: 0.5, y: 0.075 }, to: { x: 0.25, y: 0.2 }, toItemId: 'login', status: 'proposed' },
    ],
    summary: '로그인 버튼 위치',
  })
  const { summary, ...screenFields } = set
  assert.deepEqual(Screen.normalizeAnnotationSet(set, { now: 1 }), screenFields, 'the screen drops only the chip summary')
  const found = []
  JSON.stringify(set, (key, value) => { if (PRIVATE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))) found.push(key); return value })
  assert.deepEqual(found, [], 'no private chat-store key')
})

test('ratio units and free Canvas sets; a run id that is not a token is left out', () => {
  const ratio = normalizeAnnotationArguments({ cardId: 'egd-file-2', summary: '  표의   합계 ', items: [{ type: 'highlight', rect: { x: 0.1, y: 0.123456, w: 0.5, h: 0.2 } }] },
    { run: run({ answerId: 'thread/answer' }), now: 1, newId: fixedId })
  assert.equal(ratio.summary, '표의 합계')
  assert.deepEqual(ratio.items, [{ id: 'item-1', type: 'highlight', rect: { x: 0.1, y: 0.1235, w: 0.5, h: 0.2 }, status: 'proposed' }])
  assert.equal(Object.hasOwn(ratio, 'sourceMessageId'), false)
  const canvas = normalizeAnnotationArguments({ summary: '정리할 곳', items: [{ type: 'ellipse', rect: { x: 1200.04, y: -40, w: 300, h: 200 } }] }, { now: 1, newId: fixedId })
  assert.equal(canvas.space, 'canvas')
  assert.equal(Object.hasOwn(canvas, 'targetCardId'), false)
  assert.deepEqual(canvas.items[0].rect, { x: 1200, y: -40, w: 300, h: 200 })
  assert.deepEqual(Screen.normalizeAnnotationSet(canvas).items, canvas.items)
})

test('strict validation explains what to fix instead of dropping marks', () => {
  const bad = [
    [{ items: [{ type: 'box', rect: { x: 0, y: 0, w: 1, h: 1 } }] }, /summary/],
    [{ summary: 's', items: [] }, /at least one mark/],
    [{ summary: 's', items: Array.from({ length: 33 }, () => ({ type: 'box', rect: { x: 0, y: 0, w: 1, h: 1 } })) }, /more than 32/],
    [{ summary: 's', extra: 1, items: [{ type: 'box', rect: { x: 0, y: 0, w: 1, h: 1 } }] }, /unknown field extra/],
    [{ summary: 's', items: [{ type: 'circle', rect: { x: 0, y: 0, w: 1, h: 1 } }] }, /type must be one of/],
    [{ summary: 's', items: [{ type: 'box', rect: { x: 0, y: 0, w: 0, h: 1 } }] }, /positive w and h/],
    [{ summary: 's', items: [{ type: 'box', at: { x: 0, y: 0 } }] }, /needs rect/],
    [{ summary: 's', items: [{ type: 'line', from: { x: 1, y: 1 }, to: { x: 1, y: 1 } }] }, /same point/],
    [{ summary: 's', items: [{ type: 'label', at: { x: 0, y: 0 } }] }, /label is empty|label must be text/],
    [{ summary: 's', items: [{ type: 'label', at: { x: 0, y: 0 }, label: 'x'.repeat(121) }] }, /longer than 120/],
    [{ summary: 's', items: [{ type: 'arrow', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, toItemId: 'nobody' }] }, /names no other mark/],
    [{ summary: 's', items: [{ id: 'a', type: 'box', rect: { x: 0, y: 0, w: 1, h: 1 } }, { id: 'a', type: 'box', rect: { x: 0, y: 0, w: 1, h: 1 } }] }, /repeats a/],
    [{ cardId: 'c', summary: 's', units: 'viewportPx', items: [{ type: 'box', rect: { x: 0, y: 0, w: 1, h: 1 } }] }, /needs observation.viewport/],
    [{ summary: 's', units: 'viewportPx', items: [{ type: 'box', rect: { x: 0, y: 0, w: 1, h: 1 } }] }, /needs cardId/],
    [{ cardId: 'c', summary: 's', items: [{ type: 'box', rect: { x: 0, y: 0, w: 101, h: 1 } }] }, /outside the card/],
    [{ cardId: 'bad id/with slash', summary: 's', items: [{ type: 'box', rect: { x: 0, y: 0, w: 1, h: 1 } }] }, /cardId/],
    [{ summary: 's', items: [{ type: 'box', rect: { x: 0, y: 0, w: 1, h: 1 }, ref: 'e1' }] }, /ref needs cardId/],
    [{ summary: 's', items: [{ type: 'box', rect: { x: 0, y: 0, w: 1, h: 1 }, note: 'x'.repeat(40000) }] }, /larger than/],
  ]
  for (const [args, reason] of bad) {
    assert.throws(() => normalizeAnnotationArguments(args, { now: 1, newId: fixedId }), error => error.code === 'ANNOTATION_INVALID' && reason.test(error.message), String(reason))
  }
})

test('dispatch publishes once per native call, emits annotation.published and answers with ids only', async () => {
  const { provider, events } = harness()
  const first = await provider.dispatch(run(), call(loginArgs()))
  const again = await provider.dispatch(run(), call(loginArgs()))
  assert.equal(first, again)
  assert.equal(first.success, true)
  const body = parse(first)
  assert.deepEqual([body.status, body.setId, body.itemCount], ['published', 'ann-fixed', 3])
  assert.equal(JSON.stringify(body).includes('로그인 버튼'), false, 'the Agent is not echoed its own marks')
  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'annotation.published')
  assert.equal(events[0].details.annotation.id, 'ann-fixed')
  assert.equal(events[0].details.callId, 'call-1')
})

test('dispatch: invalid arguments are a fixable answer; wrong tool, bounded runs and emit failure are failures', async () => {
  const { provider, events } = harness()
  const invalid = await provider.dispatch(run(), call({ summary: 's', items: [] }, { callId: 'c2' }))
  assert.equal(invalid.success, true)
  assert.deepEqual([parse(invalid).status, parse(invalid).code], ['invalid', 'ANNOTATION_INVALID'])
  const unknown = await provider.dispatch(run(), call(loginArgs(), { tool: 'egdesk_publish_output', callId: 'c3' }))
  assert.deepEqual([unknown.success, parse(unknown).error.code], [false, 'ANNOTATION_TOOL_UNKNOWN'])
  const namespaced = await provider.dispatch(run(), call(loginArgs(), { namespace: 'x', callId: 'c4' }))
  assert.equal(parse(namespaced).error.code, 'ANNOTATION_TOOL_UNKNOWN')
  const bounded = await provider.dispatch(run({ executionPolicy: 'read-only-qa' }), call(loginArgs(), { callId: 'c5' }))
  assert.deepEqual([bounded.success, parse(bounded).error.code], [false, 'ANNOTATION_FORBIDDEN'])
  assert.equal(events.length, 0)
  const broken = harness({ emit: () => { throw new Error('store down') } })
  const failed = await broken.provider.dispatch(run(), call(loginArgs(), { callId: 'c6' }))
  assert.deepEqual([failed.success, parse(failed).error.code], [false, 'ANNOTATION_NOT_SHOWN'])
})

test('chat runtime offers the tool to Codex threads only, never to Claude', () => {
  const provider = createAnnotationToolProvider()
  const runtime = new CodexChatRuntime({ request: async () => ({}), respond: () => {}, toolProviders: [provider] })
  assert.equal(runtime.providerSupportsEngine(provider, 'codex'), true)
  assert.equal(runtime.providerSupportsEngine(provider, 'claude'), false)
  assert.deepEqual(runtime.collectToolSpecs(null).specs.map(spec => spec.name), [ANNOTATION_TOOL_NAME])
  assert.deepEqual(runtime.collectToolSpecs(null, { engineId: 'claude' }).specs, [])
})

test('bridge registers the annotation provider beside the plan provider', () => {
  const source = readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(source, /import \{ createAnnotationToolProvider \} from '\.\/egdesk-annotation-tool-provider\.mjs'/)
  assert.match(source, /toolProviders: \[browserProvider, planProvider, annotationProvider\]/)
})
