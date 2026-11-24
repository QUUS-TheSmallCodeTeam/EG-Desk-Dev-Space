// L2 cycle 2 sim: repeated / concurrent intents in the same DM.
// Same real chain as egdesk-chat-choice-outcomes.test.mjs (mock Decisions fetch -> real client with a real
// local budget -> real CodexChatRuntime.chatChoice -> real /chat/choice handler -> real Surface chooser in a fake DOM).
// The fake HTTP layer emits 'close' on the response when the UI aborts its fetch, like a real loopback socket.
// EGDESK_SIM_OUT=<file> dumps the measured scenario table as JSON.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { CodexChatRuntime } from '../helper/codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from '../helper/codex-engine-adapter.mjs'
import { createChatHttpHandler } from '../helper/codex-bridge-http.mjs'
import { openChatStore } from '../helper/egdesk-chat-store.mjs'
import { createDecisionBudget, createDecisionClient, decisionTopicRecipient } from '../helper/egdesk-decision-client.mjs'

const surface = fs.readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
function section(from, to) {
  const a = surface.indexOf(from), b = surface.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a)
  return surface.slice(a, b)
}
const mount = vm.runInNewContext(`${section('  function chatChoiceExplanationDraft(', '  function mountCodexHUD(')}\nmountChatChoiceComposer`)
const transport = section('      readChatChoiceMode(signal)', "      // Settings '결정 모델")

const ids = { clientThreadId: 'dm-synthetic', conversationId: 'native-synthetic', profileId: 'agent-synthetic' }
const time = 1780000000000
const reviewRevision = 'a'.repeat(64)
const engine = { id: 'codex', engineProfileId: 'codex-default' }
const profileBinding = { profileId: ids.profileId, revision: 1, hash: 'synthetic-profile-hash' }
const author = 'synthetic-account'
const ownerHash = createHash('sha256').update(author).digest('hex')
const question = '이번 주 발표 자료는 어느 쪽으로 정리할까요?'
const options = ['슬라이드 10장 요약본', '표 중심 상세본']
const tick = () => new Promise(resolve => setImmediate(resolve))
const settleAll = async () => { for (let i = 0; i < 6; i++) await tick() }

const answerFor = (q, top) => new Response(JSON.stringify({ usage: { input_tokens: 10 }, answers: [{ name: q.name, type: 'choice',
  probabilities: [{ value: q.choices[top].value, probability: 0.96 }, { value: q.choices[1 - top].value, probability: 0.03 }, { value: 'abstain', probability: 0.01 }],
  choice: q.choices[top].value, confidence: 0.96 }] }))
const ok = (top = 0) => ({ respond: q => answerFor(q, top) })
const rate = { respond: () => new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429 }) }
const hang = { hang: true }

function runtime(t, script) {
  const dataDir = mkdtempSync(join(tmpdir(), 'egdesk-inflight-db-'))
  const store = openChatStore({ dataDir, ownerScope: 'fixture-only' })
  t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }) })
  store.createConversation({ clientThreadId: ids.clientThreadId, createdAt: 1 })
  store.setRoomAgent({ clientThreadId: ids.clientThreadId, profileId: ids.profileId, revision: 1, ts: 2 })
  store.acceptRequest({ clientThreadId: ids.clientThreadId, requestId: 'previous-send', fingerprint: 'synthetic-request', ts: 3, localMessageId: 'previous-local-message',
    message: { role: 'user', text: 'Previous native message is not sent to Decisions' } })
  store.appendEvent({ clientThreadId: ids.clientThreadId, eventKey: 'native-binding', event: 'native.thread.bound', ts: 4,
    details: { conversationId: ids.conversationId, ownerHash, replyDestination: 'direct', engine, executionPolicy: null, forkedFrom: null, stateless: false } })
  store.bindNative({ clientThreadId: ids.clientThreadId, conversationId: ids.conversationId, engineId: engine.id, engineProfileId: engine.engineProfileId, localRunId: 'previous-local-run', runId: 'previous-native-run' })
  store.recordRequestOutcome({ clientThreadId: ids.clientThreadId, requestId: 'previous-send', ts: 5,
    outcome: { accepted: true, dispatchStatus: 'confirmed', conversationId: ids.conversationId, runId: 'previous-native-run', localRunId: 'previous-local-run', accountIdentity: { status: 'verified', ownerHash } } })
  store.appendEvent({ clientThreadId: ids.clientThreadId, eventKey: 'run-terminal', event: 'run.completed', ts: 6, requestId: 'previous-send', localRunId: 'previous-local-run', runId: 'previous-native-run',
    details: { status: 'completed' }, runCheckpoint: { conversationId: ids.conversationId, clientThreadId: ids.clientThreadId, requestId: 'previous-send', runId: 'previous-native-run', localRunId: 'previous-local-run',
      engine, profileBinding, status: 'completed', messages: [], pendingApprovals: [], pendingUserInputs: [] } })
  const state = { native: 0, fetches: 0, httpPosts: 0, requestIds: [], key: 'egd-synthetic-not-a-key-0002', releases: [] }
  const noNative = () => { state.native++; throw Error('Unexpected native operation') }
  const budget = createDecisionBudget({ monthlyInputTokenCap: 1_000_000, now: () => time })
  const client = createDecisionClient({
    getApiKey: async () => state.key, budget,
    recipientForKey: (key, endpoint, model) => decisionTopicRecipient(key, 42, endpoint, model),
    fetchImpl: async (url, req) => {
      const step = script[Math.min(state.fetches, script.length - 1)]
      const index = state.fetches++
      const body = JSON.parse(req.body)
      if (step.hang) return new Promise((resolve, reject) => {
        state.releases[index] = () => resolve(answerFor(body.questions[0], 1))
        if (!step.late) req.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
      return step.respond(body.questions[0])
    } })
  const decisionContext = { client, mode: () => 'on', configured: () => true, settingsGeneration: () => 1, reviewRevision: () => reviewRevision,
    recipientForChatChoice: ({ ownerKey }) => ownerKey === author ? decisionTopicRecipient(state.key, 42) : null }
  const adapter = createCodexEngineAdapter({ request: noNative, respond: noNative, getOwnerKey: () => author, profiles: { ensureReady: noNative } })
  Object.assign(adapter, { ensureReady: noNative, startTurn: noNative })
  const chat = new CodexChatRuntime({ request: noNative, respond: noNative, engines: [adapter], store, requireStore: true, getOwnerKey: () => author, now: () => time,
    profiles: { runProfile: () => ({ binding: profileBinding, developerInstructions: 'synthetic instructions' }) }, decisionContext })
  chat.startTurn = noNative
  const handle = createChatHttpHandler(chat, noNative)
  const post = async (body, signal) => {
    state.httpPosts++; state.requestIds.push(body.requestId)
    const req = Object.assign(new EventEmitter(), { url: '/chat/choice', method: 'POST', socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } })
    const response = {}
    const res = Object.assign(new EventEmitter(), { writeHead(status) { response.status = status }, end(data) { response.body = JSON.parse(data) } })
    // A real client abort closes the loopback connection; the handler treats that as cancellation.
    signal?.addEventListener('abort', () => res.emit('close'), { once: true })
    await handle(req, res, new URL('/chat/choice', 'http://127.0.0.1:39218'))
    return response
  }
  return { state, post, budget, chat }
}

let focused = null
function el(tag, props = {}, ...children) {
  const listeners = new Map()
  return { tag, props, children: children.filter(x => x != null), value: '', textContent: '', hidden: false, disabled: false,
    focus() { focused = this }, replaceChildren(...next) { this.children = next },
    querySelector(selector) { return this.find(selector.match(/data-testid="([^\"]+)"/)?.[1])[0] || null },
    find(id) { return [...(this.props.data?.testid === id ? [this] : []), ...this.children.flatMap(x => x.find?.(id) || [])] },
    all() { return [this, ...this.children.flatMap(x => x.all?.() || [])] },
    contains(node) { return this.all().includes(node) },
    get ownerDocument() { return { get activeElement() { return focused } } },
    get text() { return this.textContent + ' ' + this.children.map(x => typeof x === 'string' ? x : x.text).join(' ') },
    addEventListener(type, callback) { listeners.set(type, callback) },
    click() { if (!this.disabled && !this.hidden) this.props.onclick?.() },
    type(value) { this.value = value; this.props.oninput?.() } }
}

function dm(t, script) {
  focused = null
  const rt = runtime(t, script)
  const proof = { configured: true, mode: 'on', boardRevision: reviewRevision }
  const scene = { key: 'room/owner/revision/1', editKey: 'room/owner/draft/1', room: 'room' }
  const input = Object.assign(el('textarea'), { isConnected: true, value: question, dataset: { threadId: 'room' } })
  const bridge = vm.runInNewContext(`({${transport}})`, { fetchJson: async (path, args) => {
    if (path === '/decision/status') return proof
    const body = JSON.parse(args.body)
    const result = await rt.post(body, args.signal)
    if (args.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    if (result.status !== 200) throw new Error(`http ${result.status}`)
    return result.body
  } })
  const drafts = []
  const choice = mount({ el, readMode: bridge.readChatChoiceMode, postChoice: bridge.postChatChoice, openSettings() {},
    makeController: () => new AbortController(), makeRequestId: () => `choice-${time}-${randomUUID()}` })
  const attach = () => choice.attach({ input, readScope: () => scene.key && ({ key: scene.key, editKey: scene.editKey, ...ids, question: input.value }), setDraft: d => drafts.push(d) })
  attach(); choice.sync()
  const find = id => choice.panel.find(`chat-choice-${id}`)
  const click = id => find(id)[0]?.click()
  const where = () => {
    if (!focused) return 'body'
    if (!choice.panel.contains(focused) && focused !== choice.trigger) return 'body(lost)'
    return focused.props?.data?.testid?.replace('chat-choice-', '') ?? focused.tag
  }
  const text = () => choice.panel.text.replace(/\s+/g, ' ').trim()
  const open = () => { choice.trigger.click(); find('option').forEach((n, i) => n.type(options[i])) }
  const toReview = async () => { open(); click('review'); await tick() }
  const ids2 = () => find('option').map(n => n.value)
  const counts = () => ({ ui: rt.state.httpPosts, provider: rt.state.fetches, tokens: rt.budget.snapshot().inputTokens, native: rt.state.native })
  return { rt, choice, input, find, click, where, text, open, toReview, counts, scene, drafts, attach, ids2 }
}

const TABLE = {}
const note = (name, row) => { TABLE[name] = row; if (process.env.EGDESK_SIM_OUT) fs.writeFileSync(process.env.EGDESK_SIM_OUT, JSON.stringify(TABLE, null, 2)) }

test('C2-1 double-click on confirm: one intent, one POST, one provider request, focus on the result', async t => {
  const d = dm(t, [ok(0)])
  await d.toReview()
  const confirm = d.find('confirm')[0]
  confirm.click(); confirm.click()
  await settleAll()
  const row = { ...d.counts(), result: d.text(), focus: d.where() }
  note('double-click confirm', row)
  assert.deepEqual([row.ui, row.provider, row.tokens, row.native], [1, 1, 10, 0])
  assert.equal(row.focus, 'explain')
})

for (const kind of ['rate_limited', 'server_error']) {
  test(`C2-2 ${kind}: double-click retry then double-click confirm = one more intent, never duplicate paid requests`, async t => {
    const bad = kind === 'rate_limited' ? rate : { respond: () => new Response('{}', { status: 500 }) }
    const d = dm(t, [bad, ok(0)])
    await d.toReview(); d.click('confirm'); await settleAll()
    const first = { ...d.counts(), focus: d.where(), text: d.text() }
    const retryNode = d.find('retry')[0]
    retryNode.click(); retryNode.click()          // double-click on the same node
    const afterRetry = { ...d.counts(), focus: d.where(), text: d.text() }
    await settleAll()
    const review = { ...d.counts(), focus: d.where(), text: d.text(), confirmPresent: d.find('confirm').length }
    const confirm = d.find('confirm')[0]
    confirm.click(); confirm.click()
    await settleAll()
    const done = { ...d.counts(), focus: d.where(), text: d.text(), ids: new Set(d.rt.state.requestIds).size }
    note(`${kind}: retry x2 + confirm x2`, { first, afterRetry, review, done })
    assert.equal(first.ui, 1); assert.equal(first.provider, 1)
    assert.equal(afterRetry.ui, 1, 'retry alone never sends'); assert.equal(afterRetry.provider, 1)
    assert.equal(review.confirmPresent, 1)
    assert.deepEqual([done.ui, done.provider, done.ids, done.native], [2, 2, 2, 0], 'one confirm = one POST with its own request ID')
    assert.equal(done.tokens, 10, 'only the answered request is counted')
    assert.equal(done.focus, 'explain')
    for (const where of [first.focus, afterRetry.focus, review.focus]) assert.notEqual(where, 'body(lost)', `focus must not be lost (${where})`)
  })
}

test('C2-3 [보기 추천] pressed again while a request is in flight does nothing', async t => {
  const d = dm(t, [hang])
  await d.toReview(); d.click('confirm'); await settleAll()
  const pending = { text: d.text(), triggerHidden: d.choice.trigger.hidden, focus: d.where() }
  d.choice.trigger.click(); d.choice.trigger.click()
  await settleAll()
  const row = { pending, ...d.counts(), options: d.find('option').length, focusAfter: d.where() }
  note('open again while pending', row)
  assert.equal(row.pending.triggerHidden, true)
  assert.deepEqual([row.ui, row.provider, row.options], [1, 1, 0])
  assert.notEqual(row.pending.focus, 'body(lost)', 'focus must not be lost while waiting')
})

test('C2-4 room switch mid-flight then back: stale response cannot overwrite; new request is not blocked by the old one', async t => {
  const d = dm(t, [{ hang: true, late: true }, ok(0)])
  await d.toReview(); d.click('confirm'); await settleAll()
  const mid = d.counts()
  // switch away: the scope key changes, the chooser resets and aborts its fetch (socket closes)
  d.scene.key = 'other/owner/revision/1'; d.scene.editKey = 'other/owner/draft/1'; d.choice.sync(); await settleAll()
  const away = { hidden: d.choice.panel.hidden, text: d.text(), ...d.counts() }
  // back: same room, fresh scope
  d.scene.key = 'room/owner/revision/1'; d.scene.editKey = 'room/owner/draft/1'; d.choice.sync()
  const back = { triggerHidden: d.choice.trigger.hidden, panelHidden: d.choice.panel.hidden, options: (d.open(), d.ids2()) }
  d.click('review'); await tick(); d.click('confirm'); await settleAll()
  const second = { ...d.counts(), text: d.text(), focus: d.where() }
  d.rt.state.releases[0]?.()           // the first (late) provider answer finally arrives, picking the OTHER option
  await settleAll()
  const final = { ...d.counts(), text: d.text(), focus: d.where() }
  note('room switch mid-flight and back', { mid, away, back, second, final })
  assert.equal(away.hidden, true)
  assert.match(second.text, /EG-Desk 추천/, 'the new request is answered, not rejected as concurrent')
  assert.equal(second.text, final.text, 'late first response never changes the visible result')
  assert.equal(d.rt.state.native, 0)
})
