// L2 cycle 3 sim: recovery and stale-result safety in the same DM (statusUnavailable, setup, revoked settings, draft after mode-off).
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
  const proof = { configured: true, mode: 'on', boardRevision: reviewRevision, store: 'ready' }
  const statusFail = { on: false }
  const scene = { key: 'room/owner/revision/1', editKey: 'room/owner/draft/1', room: 'room', gen: 0 }
  const input = Object.assign(el('textarea'), { isConnected: true, value: question, dataset: { threadId: 'room' } })
  const bridge = vm.runInNewContext(`({${transport}})`, { fetchJson: async (path, args) => {
    if (path === '/decision/status') { if (statusFail.on) throw new Error('status unavailable'); return { ...proof } }
    const body = JSON.parse(args.body)
    const result = await rt.post(body, args.signal)
    if (args.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    if (result.status !== 200) throw new Error(`http ${result.status}`)
    return result.body
  } })
  const drafts = []
  const sent = []
  const settingsOpened = []
  const choice = mount({ el, readMode: bridge.readChatChoiceMode, postChoice: bridge.postChatChoice, openSettings: reason => settingsOpened.push(reason),
    makeController: () => new AbortController(), makeRequestId: () => `choice-${time}-${randomUUID()}` })
  const attach = () => choice.attach({ input, readScope: () => scene.key && ({ key: scene.key, editKey: scene.editKey, ...ids, question: input.value }), setDraft: d => drafts.push(d) })
  attach(); choice.sync()
  const find = id => choice.panel.find(`chat-choice-${id}`)
  const click = id => find(id)[0]?.click()
  const where = () => {
    if (!focused) return 'body'
    if (focused === input) return 'composer'
    if (!choice.panel.contains(focused) && focused !== choice.trigger) return 'body(lost)'
    return focused.props?.data?.testid?.replace('chat-choice-', '') ?? focused.tag
  }
  const text = () => choice.panel.text.replace(/\s+/g, ' ').trim()
  const open = () => { choice.trigger.click(); find('option').forEach((n, i) => n.type(options[i])) }
  const toReview = async () => { open(); click('review'); await tick() }
  const ids2 = () => find('option').map(n => n.value)
  const counts = () => ({ ui: rt.state.httpPosts, provider: rt.state.fetches, tokens: rt.budget.snapshot().inputTokens, native: rt.state.native })
  // Same settings change the product makes: this window's Decisions save bumps the scope key (not the edit key).
  const settingsSaved = change => { Object.assign(proof, change); scene.key = JSON.stringify([scene.editKey, ++scene.gen]); choice.sync() }
  const settingsElsewhere = change => { Object.assign(proof, change, { boardRevision: 'b'.repeat(64) }) } // other window: status changes, scope key does not
  const ordinary = vm.runInNewContext(`${section('            const submitComposer = () => {', '            const sendButton =')}\nsubmitComposer`,
    { choice, input, compositionInProgress: false, boardInputState: null, boardPreview: null, manualOwner: 'owner', codexBridge: { sendMessage: o => sent.push({ opts: o, text: input.value }) } })
  const buttons = () => choice.panel.all().filter(n => n.tag === 'button').map(n => n.props.data.testid.replace('chat-choice-', ''))
  return { rt, choice, input, find, click, where, text, open, toReview, counts, scene, drafts, attach, ids2, proof, statusFail, settingsSaved, settingsElsewhere, settingsOpened, ordinary, sent, buttons }
}


const TABLE = {}
const note = (name, row) => { TABLE[name] = row; if (process.env.EGDESK_SIM_OUT) fs.writeFileSync(process.env.EGDESK_SIM_OUT, JSON.stringify(TABLE, null, 2)) }
const snap = d => ({ text: d.text().slice(0, 90), buttons: d.buttons(), focus: d.where(), panelHidden: d.choice.panel.hidden, triggerHidden: d.choice.trigger.hidden })
const reopenOptions = d => { if (d.choice.trigger.hidden && d.find('option').length) return d.find('option').map(n => n.value); if (d.choice.trigger.hidden) return 'trigger-hidden'; d.choice.trigger.click(); return d.find('option').map(n => n.value) }

test('C3-1 retry -> settings status fetch fails (statusUnavailable): says nothing was sent, keeps focus, options survive', async t => {
  const d = dm(t, [rate])
  await d.toReview(); d.click('confirm'); await settleAll()
  d.statusFail.on = true
  d.click('retry'); await settleAll()
  const unavailable = { ...snap(d), ...d.counts() }
  const closed = (d.click('cancel'), { focus: d.where(), options: reopenOptions(d) })
  note('retry -> statusUnavailable', { unavailable, closed })
  assert.match(unavailable.text, /보내지 않았습니다/)
  assert.equal(unavailable.provider, 1, 'no second provider request')
  assert.notEqual(unavailable.focus, 'body(lost)')
  assert.deepEqual(closed.options, options)
  assert.notEqual(closed.focus, 'body(lost)')
})

test('C3-2 retry -> key deleted in account settings (setup): guided to settings, reviewed options survive both paths', async t => {
  for (const path of ['close', 'settings']) {
    const d = dm(t, [rate])
    await d.toReview(); d.click('confirm'); await settleAll()
    d.proof.configured = false; d.proof.store = 'missing'
    d.click('retry'); await settleAll()
    const setup = { ...snap(d), ...d.counts() }
    if (path === 'close') d.click('cancel'); else { d.click('settings'); d.settingsSaved({ configured: true, store: 'ready' }) }
    const back = { focus: d.where(), options: reopenOptions(d), opened: d.settingsOpened.slice() }
    note(`retry -> setup (${path})`, { setup, back })
    assert.deepEqual(setup.buttons, ['settings', 'cancel']); assert.equal(setup.provider, 1)
    assert.notEqual(setup.focus, 'body(lost)')
    assert.deepEqual(back.options, options)
  }
})

const REVOCATIONS = {
  'key deleted (this window)': d => d.settingsSaved({ configured: false, store: 'missing' }),
  'mode off (this window)': d => d.settingsSaved({ mode: 'off' }),
  'mode advisory (this window)': d => d.settingsSaved({ mode: 'advisory' }),
  'account changed': d => { d.scene.key = null; d.scene.editKey = null; d.choice.sync() },
}
for (const [label, revoke] of Object.entries(REVOCATIONS)) {
  test(`C3-3 recommendation on screen, then ${label}: nothing stays actionable and focus stays in the user's task`, async t => {
    const d = dm(t, [ok(0)])
    await d.toReview(); d.click('confirm'); await settleAll()
    const before = snap(d)
    assert.ok(before.buttons.includes('explain'))
    const posts = d.counts().provider
    revoke(d)
    await settleAll()
    const after = { ...snap(d), explainStillThere: d.find('explain').length, resultStillThere: d.find('result').length }
    if (label === 'account changed') { d.scene.key = 'room/owner/revision/1'; d.scene.editKey = 'room/owner/draft/1'; d.choice.sync() }
    after.reopened = reopenOptions(d)
    note(`recommended -> ${label}`, { before, after, ...d.counts() })
    assert.equal(after.explainStillThere, 0, '[이유 묻기] must be gone')
    assert.equal(d.counts().provider, posts); assert.equal(d.drafts.length, 0); assert.equal(d.rt.state.native, 0)
    assert.notEqual(after.focus, 'body(lost)', 'focus must not be dropped to the page body')
    // Existing policy (L1c2 sim D): a delivered recommendation leaves no reusable options. Kept as is; only focus is fixed here.
    assert.deepEqual(after.reopened, ['', ''], 'a delivered recommendation leaves no reusable options (L1 policy, unchanged)')
  })
}

test('C3-4 recommendation on screen, mode switched in ANOTHER window: [이유 묻기] re-checks and refuses; no draft, no Decisions call', async t => {
  const d = dm(t, [ok(0)])
  await d.toReview(); d.click('confirm'); await settleAll()
  const posts = d.counts().provider
  d.settingsElsewhere({ mode: 'off' })
  const stillShown = snap(d)
  d.click('explain'); await settleAll()
  const after = snap(d)
  note('recommended -> mode off in another window -> 이유 묻기', { stillShown, after, drafts: d.drafts.length, ...d.counts() })
  assert.equal(d.drafts.length, 0); assert.equal(d.counts().provider, posts); assert.equal(d.find('result').length, 0)
  assert.equal(d.find('explain').length, 0)
  assert.notEqual(after.focus, 'body(lost)')
})

test('C3-5 manual (retry offered) or pending, then settings change in this window: panel closes, raw options kept, no late result', async t => {
  for (const [label, script, wait] of [['manual', [rate], false], ['pending', [hang], true]]) {
    const d = dm(t, script)
    await d.toReview(); d.click('confirm'); await settleAll()
    const before = snap(d)
    d.settingsSaved({ mode: 'advisory' }); await settleAll()
    const after = { ...snap(d), reopened: reopenOptions(d) }
    note(`${label} -> settings changed`, { before, after, ...d.counts() })
    assert.equal(d.find('retry').length, 0)
    assert.notEqual(after.focus, 'body(lost)')
    assert.deepEqual(after.reopened, options)
  }
})

test('C3-6 [이유 묻기] draft, then mode off: the draft is an ordinary message; nothing Decision-related is sent with it', async t => {
  const d = dm(t, [ok(0)])
  await d.toReview(); d.click('confirm'); await settleAll()
  d.click('explain'); await settleAll()
  const draft = d.input.value
  assert.equal(d.drafts.length, 1); assert.equal(draft, d.drafts[0])
  d.settingsSaved({ mode: 'off' })
  d.input.value += '\n내가 덧붙인 말'
  const posts = d.counts()
  d.ordinary()
  const ordinaryArgs = Object.keys(d.sent[0].opts).sort()
  // Server side: an ordinary turn with mode off or key missing must not call the Decisions provider.
  const off = { mode: 'off', configured: true }, missing = { mode: 'on', configured: false }
  const server = {}
  for (const [name, status] of Object.entries({ off, missing, advisory: { mode: 'advisory', configured: true } })) {
    const calls = { collect: 0 }
    const ctx = { client: { decide: async () => { throw Error('no provider call expected in this probe') } }, mode: () => status.mode, configured: () => status.configured,
      collect: async () => { calls.collect++; return [] }, settingsGeneration: () => 1 }
    const chat = Object.create(CodexChatRuntime.prototype); chat.decisionContext = ctx; chat.now = () => time
    chat.directSpeech = () => null; chat.directEvidenceReader = () => null; chat.topicIntakes = new Map()
    const out = await CodexChatRuntime.prototype.prepareDecisionContext.call(chat, { message: draft }, { conversationId: 'c', askedAt: time })
    server[name] = { returned: out === null ? 'null (no setup ran)' : out.result.status, collectCalls: calls.collect }
  }
  note('draft after mode off -> ordinary send', { draftHasNoDecisionFields: !/choice-|reviewRevision|probab|requestId|confidence/i.test(draft), ordinaryArgs, sentText: d.sent[0].text === draft + '\n내가 덧붙인 말', server, ...posts, provider: d.counts().provider })
  // u2 (D1): the composer also hands the send a UI callback (onBlocked) that shows the existing blocked line when the owner is refused; still no Decision field
  assert.deepEqual(ordinaryArgs, ['manualOwner', 'onBlocked'])
  assert.doesNotMatch(draft, /choice-|reviewRevision|probab|requestId|confidence/i)
  assert.equal(d.counts().provider, posts.provider, 'sending the draft makes no Decisions request')
  assert.equal(d.counts().ui, posts.ui)
  assert.equal(server.off.collectCalls, 0); assert.equal(server.missing.collectCalls, 0)
  assert.equal(server.off.returned, 'null (no setup ran)')
})
