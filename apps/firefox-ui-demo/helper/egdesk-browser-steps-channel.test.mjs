// a1 (L1): the bridge's slot for Browser task step lines (developer flag EGDESK_BROWSER_STEPS_UI, default off).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { BROWSER_STEP_FRAME_TYPE, BROWSER_STEPS_UI_FLAG, browserStepFrame, browserStepsUiMode, createBrowserStepsChannel } from './egdesk-browser-steps-channel.mjs'

const step = (extra = {}) => ({ threadId: 'thread-a', taskId: 'task-1', cardId: 'browser-a', seq: 0, op: 'egdesk_browser_fill', target: '검색칸',
  valueName: '검색어', value: '우산 TYPED', ok: true, ms: 280, by: 'decision', ...extra })

test('the flag is off unless it says on', () => {
  assert.equal(BROWSER_STEPS_UI_FLAG, 'EGDESK_BROWSER_STEPS_UI')
  assert.equal(browserStepsUiMode({}), 'off')
  assert.equal(browserStepsUiMode({ EGDESK_BROWSER_STEPS_UI: 'true' }), 'off')
  assert.equal(browserStepsUiMode({ EGDESK_BROWSER_STEPS_UI: 'on' }), 'on')
})

test('a frame carries the room, task, order, labels and the NAME of a value, never what was typed', () => {
  const frame = browserStepFrame(step(), { now: () => 5000 })
  assert.deepEqual(frame, { type: BROWSER_STEP_FRAME_TYPE, v: 1, clientThreadId: 'thread-a', taskId: 'task-1', seq: 0, op: 'fill',
    cardId: 'browser-a', target: '검색칸', valueName: '검색어', ok: true, ms: 280, by: 'decision', ts: 5000 })
  assert.equal(JSON.stringify(frame).includes('TYPED'), false)
  assert.equal(browserStepFrame(step({ ts: 42 })).ts, 42, 'the runtime\'s own time is kept')
  assert.equal(browserStepFrame({ ...step(), taskId: '' }), null)
  assert.equal(browserStepFrame(null), null)
})

test('while off nothing is sent; while on one checked frame per step; other events pass unchanged', () => {
  let mode = 'off'
  const sent = []
  const channel = createBrowserStepsChannel({ mode: () => mode, broadcast: frame => sent.push(frame), now: () => 7 })
  assert.equal(channel.enabled(), false)
  assert.equal(channel.publish(step()), false)
  assert.equal(channel.gate({ type: BROWSER_STEP_FRAME_TYPE, ...step() }), null, 'a frame emitted another way is dropped too')
  assert.deepEqual(sent, [])
  const chatEvent = { type: 'chat.event', v: 2, event: 'browserTask.step', seq: 9, details: step() }
  assert.equal(channel.gate(chatEvent), chatEvent, 'a numbered chat event is never dropped (no gap in the stream)')
  mode = 'on'
  assert.equal(channel.enabled(), true)
  assert.equal(channel.publish(step()), true)
  assert.equal(channel.publish({ nothing: true }), false)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, BROWSER_STEP_FRAME_TYPE)
  assert.equal(sent[0].ts, 7)
  const gated = channel.gate({ ...sent[0] })
  assert.deepEqual(gated, sent[0], 'checking a frame again changes nothing')
  const throwing = createBrowserStepsChannel({ mode: () => { throw new Error('x') }, broadcast: () => {} })
  assert.equal(throwing.enabled(), false)
  const failing = createBrowserStepsChannel({ mode: () => 'on', broadcast: () => { throw new Error('closed') } })
  assert.equal(failing.publish(step()), false)
  assert.throws(() => createBrowserStepsChannel({ mode: () => 'on' }), /broadcast/)
})

test('the bridge sends frames only through the gate, offers the slot to the runtime and lists the capability only when on', () => {
  const source = readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8')
  assert.match(source, /function broadcast\(event, chatProtocol = 0\) \{\n  \/\/ a1 \(L1\)[^\n]*\n  if \(event\?\.type === BROWSER_STEP_FRAME_TYPE && !\(event = browserSteps\.gate\(event\)\)\) return\n/)
  assert.match(source, /const browserSteps = createBrowserStepsChannel\(\{ mode: \(\) => browserStepsUiMode\(\), broadcast: frame => broadcast\(frame, 2\) \}\)/)
  assert.match(source.slice(source.indexOf('decisionContext: {')), /browserEntry: browserEntryConfig,\n[^\n]*\n    browserSteps,\n/)
  assert.match(source, /        channelContext: true,\n        \.\.\.\(browserSteps\.enabled\(\) \? \{ browserSteps: true \} : \{\}\),\n/)
})
