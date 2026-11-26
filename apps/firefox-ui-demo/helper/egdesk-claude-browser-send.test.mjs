// L8 u4 (U19): what a send of a Claude conversation does with Browser Cards: the plan (pure), its use in the screen (static), and the bridge capability.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAUDE_BROWSER_CAPABILITY, claudeBrowserCapable, claudeBrowserSendPlan } from '../overlay/resources/EGDeskClaudeBrowserSend.sys.mjs'
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs'
const { claudeContextSendErrorText } = ChatState

const here = path.dirname(fileURLToPath(import.meta.url))
const surface = fs.readFileSync(path.join(here, '..', 'overlay', 'JS', 'eg-desk-surface.uc.js'), 'utf8')
const bridge = fs.readFileSync(path.join(here, 'codex-bridge-server.mjs'), 'utf8')
const card = (permission, id = 'b1') => ({ id, kind: 'browser', selectedByUser: true, browserToolPermission: permission })
const file = { id: 'f1', kind: 'file' }
const plan = (over = {}) => claudeBrowserSendPlan({ engineId: 'claude', capable: false, selectedInputs: [], threadInputs: over.selectedInputs ?? [], contextPicked: 0, briefingInputs: 0, ...over })

test('the capability is exactly "claude-browser" and only an array that lists it counts', () => {
  assert.equal(CLAUDE_BROWSER_CAPABILITY, 'claude-browser')
  assert.equal(claudeBrowserCapable(['send', 'claude-browser']), true)
  for (const value of [undefined, null, [], ['choice'], 'claude-browser', { includes: () => true }]) assert.equal(claudeBrowserCapable(value), false)
})

test('flag off (no capability): exactly today\'s behaviour: observe-only Cards stay immutable captures, an operate grant or a picked context source is refused, nothing goes live', () => {
  assert.deepEqual(plan({ selectedInputs: [card('observe')] }), { refuse: false, live: false, captureInputs: [card('observe')] })
  assert.deepEqual(plan({ selectedInputs: [file, card('observe')] }), { refuse: false, live: false, captureInputs: [file, card('observe')] })
  assert.deepEqual([plan({ selectedInputs: [card('interact')] }).refuse, plan({ selectedInputs: [card('interact')] }).live], [true, false])
  assert.equal(plan({ selectedInputs: [], threadInputs: [card('interact')] }).refuse, true, 'the screen read thread.inputSources')
  assert.equal(plan({ contextPicked: 2 }).refuse, true)
  assert.equal(plan({ selectedInputs: [file, card('interact')] }).refuse, true)
})

test('capability on, a Claude send with only Browser Cards of which one is granted to operate: live, nothing captured (a bounded Claude has no Reader); the observe-only Cards of the same send go live read-only', () => {
  const live = plan({ capable: true, selectedInputs: [card('interact'), card('observe', 'b2')] })
  assert.deepEqual([live.refuse, live.live, live.captureInputs], [false, true, []])
  assert.deepEqual(plan({ capable: true, selectedInputs: [card('interact')] }).captureInputs, [])
})

test('capability on but the send needs the Reader or has no Card to operate: refused with the screen\'s existing sentence (a file, a canvas element, a briefing input, a picked context source, a stale grant)', () => {
  for (const over of [{ selectedInputs: [card('interact'), file] }, { selectedInputs: [card('interact')], briefingInputs: 1 }, { selectedInputs: [card('interact')], contextPicked: 1 }, { selectedInputs: [file], threadInputs: [card('interact')] }]) {
    const out = plan({ capable: true, ...over }); assert.deepEqual([out.refuse, out.live], [true, false], JSON.stringify(over))
  }
  // observe-only with the capability: still today's immutable capture (nothing becomes live without an operate grant)
  assert.deepEqual(plan({ capable: true, selectedInputs: [card('observe')] }), { refuse: false, live: false, captureInputs: [card('observe')] })
})

test('Codex: only the explicit operate Card skips immutable capture; files and read attachments still go through it', () => {
  const read = card('observe', 'read'), unselected = { ...card('interact', 'not-granted'), selectedByUser: false }
  assert.deepEqual(plan({ engineId: 'codex', selectedInputs: [card('interact'), read, file, unselected] }).captureInputs, [read, file, unselected])
})

test('another engine is untouched: the plan hands the inputs back and refuses nothing', () => {
  for (const engineId of [undefined, 'other']) for (const capable of [true, false]) {
    const inputs = [card('interact'), file]
    assert.deepEqual(claudeBrowserSendPlan({ engineId, capable, selectedInputs: inputs, threadInputs: inputs, contextPicked: 3, briefingInputs: 2 }), { refuse: false, live: false, captureInputs: inputs })
  }
})

test('the screen uses the plan at the three places the old Claude special cases were, with the same sentence; the capability comes from the bridge only with the Claude harness AND the page tools', () => {
  assert.ok(surface.includes('const claudeBrowserCapable = ChatState.claudeBrowserCapable(state.codex.chatCapabilities);'), 'reached through ChatState: every send harness already has it in scope')
  assert.ok(!surface.includes('ClaudeBrowserSend'), 'no new global in the send function')
  assert.equal(ChatState.claudeBrowserSendPlan, claudeBrowserSendPlan); assert.equal(ChatState.claudeBrowserCapable, claudeBrowserCapable)
  assert.ok(surface.includes("if (activeThread && engineId === 'claude' && claudeBrowserGate.refuse) {\n          updateThreadById(activeThread.id, thread => ({ ...thread, sendError: ChatState.claudeContextSendErrorText('CLAUDE_CONTEXT_UNSUPPORTED') }));"))
  assert.ok(surface.includes('captureThreadInputs(activeThread, claudeBrowserPlan.captureInputs, token, prepareOwnerCurrent)'))
  assert.ok(surface.includes("engineId === 'claude' && !claudeBrowserPlan.live ? [] : browserToolSelectedSources(activeThread.id, selectedInputs)"))
  assert.ok(claudeContextSendErrorText('CLAUDE_CONTEXT_UNSUPPORTED').startsWith('현재 Claude 연결에서는 선택한 자료를 사용할 수 없어'), 'no new sentence')
  assert.ok(bridge.includes("...(pageToolsWiring && ownToolsWiring?.ownTools?.claudeHarness?.() ? ['claude-browser'] : [])"))
  assert.ok(!bridge.includes('EGDESK_CLAUDE_HARNESS') && !bridge.includes('EGDESK_PAGE_TOOLS'), 'the flags are read in their wiring modules, not in the bridge')
})
