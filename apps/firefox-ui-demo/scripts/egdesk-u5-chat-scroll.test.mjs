import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as ChatHistoryView from '../overlay/resources/EGDeskChatHistoryView.sys.mjs'
import * as ChatStatusView from '../overlay/resources/EGDeskChatStatusView.sys.mjs'

const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')

// ---- the number of requests a room waits on, and when its change moves the log ----
test('u5: waitingAskCount counts the approvals and questions a room waits on (not stale, answered or recorded-only ones); askChanged needs a known earlier number', () => {
  const pending = { status: 'pending' }
  assert.equal(ChatStatusView.waitingAskCount([]), 0); assert.equal(ChatStatusView.waitingAskCount(null), 0)
  assert.equal(ChatStatusView.waitingAskCount([{ pendingApprovals: [pending, { status: 'approved' }, { status: 'pending', stale: true }] }]), 1)
  assert.equal(ChatStatusView.waitingAskCount([{ pendingUserInputs: [pending, { status: 'answered' }, { status: 'pending', stale: true }] }, { pendingApprovals: [pending, {}] }]), 3, 'an approval with no status is pending, as waitingAsk reads it')
  assert.equal(ChatStatusView.waitingAskCount([{ localHistory: true, pendingApprovals: [pending], pendingUserInputs: [pending] }]), 0, 'a run only read back from history waits on nothing')
  assert.equal(ChatStatusView.waitingAskCount([null, {}, { pendingUserInputs: 'x' }]), 0)
  assert.equal(ChatHistoryView.askChanged(undefined, 1), false, 'first drawing of a room'); assert.equal(ChatHistoryView.askChanged(0, 0), false); assert.equal(ChatHistoryView.askChanged(1, 1), false)
  assert.equal(ChatHistoryView.askChanged(0, 1), true, 'a request arrived'); assert.equal(ChatHistoryView.askChanged(1, 0), true, 'it was answered or decided'); assert.equal(ChatHistoryView.askChanged(2, 1), true)
  assert.equal(ChatHistoryView.askChanged(NaN, 1), false)
})

// ---- the restore step of the real Chat render, run against a fake log ----
class Log {
  constructor({ thread = 'A', last = 'u1', answer = 'a1', height = 3000, viewport = 300, top = 0 } = {}) {
    this.dataset = { threadId: thread, lastUserMessageId: last, lastAnswerId: answer }; this.scrollHeight = height; this.clientHeight = viewport; this._top = top; this.isConnected = true; this.docks = []
  }
  get scrollTop() { return this._top } set scrollTop(v) { this._top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)) }
  getBoundingClientRect() { return { top: 0, bottom: this.clientHeight } }
  querySelectorAll() { return [] } appendChild(node) { this.docks.push(node) } addEventListener() {}
}
function restoreStep({ messageState, log, askRevealThreadId, thread = 'A' }) {
  const mount = surface.match(/  function mountCodexHUD\(body, codexBridge, options = \{\}\) \{([\s\S]*?)\n  \}/)[1]
  const restore = mount.match(/      const msgEl = body\.querySelector\("\.egd-codex-messages"\);[\s\S]*?(?=\n      const newInput = body\.querySelector)/)[0]
  const frames = []
  const run = new Function('body', 'ChatHistoryView', 'buildCodexNewMessageButton', 'requestAnimationFrame', 'state', 'revealRequestedMessage', 'messageState', 'activeThread', 'askRevealThreadId', 'taskScroll',
    `let pendingMessageScroll = null, newMessageNotice = null;\n${restore}\nreturn { notice: () => newMessageNotice };`)
  const out = run({ querySelector: () => log }, ChatHistoryView, () => ({ remove() {}, pill: true }), fn => frames.push(fn), { codex: {} }, () => {}, messageState, { id: thread }, askRevealThreadId, null)
  for (const frame of frames) frame()
  return { top: log.scrollTop, pill: log.docks.some(node => node.pill), notice: out.notice() }
}
const reading = { threadId: 'A', atBottom: false, top: 400, anchor: null, lastUserMessageId: 'u1', lastAnswerId: 'a1' }

test('u5: reading further up, the engine\'s words keep "새 메시지" and the place (as before)', () => {
  const r = restoreStep({ messageState: reading, log: new Log({ answer: 'a2' }), askRevealThreadId: null })
  assert.equal(r.top, 400); assert.equal(r.pill, true)
  assert.equal(restoreStep({ messageState: reading, log: new Log({ answer: 'a2' }) }).pill, true, 'no ask information: as before')
})

test('u5: a request for the person arrives or is answered in this room: the log goes to the newest message from wherever it was, with no pill', () => {
  const r = restoreStep({ messageState: reading, log: new Log({ answer: 'a2', height: 3000 }), askRevealThreadId: 'A' })
  assert.equal(r.top, 3000 - 300, 'the foot of the log, where the question\'s card is'); assert.equal(r.pill, false); assert.equal(r.notice, null)
  // the same without any engine words (the question card alone arriving)
  const q = restoreStep({ messageState: reading, log: new Log({ answer: 'a1', height: 3300 }), askRevealThreadId: 'A' })
  assert.equal(q.top, 3000); assert.equal(q.pill, false)
})

test('u5: a request in another room does not move this room\'s log; a person who sent keeps following as before', () => {
  assert.equal(restoreStep({ messageState: reading, log: new Log({ answer: 'a2' }), askRevealThreadId: 'B' }).top, 400)
  const sent = restoreStep({ messageState: reading, log: new Log({ last: 'u2', answer: 'a1' }), askRevealThreadId: null })
  assert.equal(sent.top, 2700); assert.equal(sent.pill, false)
})

test('u5: wiring: the count is taken at each drawing with the room\'s last number; first drawing and other rooms do not trigger; the reveal is part of preserveAnchor', () => {
  assert.match(surface, /if \(typeof waitingAskSeen !== 'undefined' && typeof activeThread !== 'undefined'\) \{\n\s+askRevealThreadId = null;\n\s+if \(activeThread\) try \{\n\s+const waitingNow = ChatStatusView\.waitingAskCount\(codexRuns\(activeThread\)\), waitingBefore = waitingAskSeen\.get\(activeThread\.id\);\n\s+waitingAskSeen\.set\(activeThread\.id, waitingNow\);\n\s+if \(ChatHistoryView\.askChanged\(waitingBefore, waitingNow\)\) askRevealThreadId = activeThread\.id;/)
  assert.match(surface, /const askReveal = typeof askRevealThreadId !== 'undefined' && askRevealThreadId !== null && askRevealThreadId === activeThread\?\.id;/)
  assert.match(surface, /!messageState\.atBottom && !sentNewMessage && !askReveal;/)
})
