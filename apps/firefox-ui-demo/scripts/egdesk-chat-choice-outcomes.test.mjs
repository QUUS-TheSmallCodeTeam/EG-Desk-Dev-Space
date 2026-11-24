// L2 sim: every chooser outcome as seen in the same DM.
// Chain under test (all real code, synthetic data only):
//   mock Decisions fetch -> createDecisionClient -> CodexChatRuntime.chatChoice -> createChatHttpHandler(/chat/choice)
//   -> Surface mountChatChoiceComposer (fake DOM executing the real handlers).
// No network, no real key, no native conversation: a native send/start would trip `state.native`.
// Set EGDESK_SIM_OUT=<file> to dump the observed matrix as JSON (used for the before/after report).
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
import { createDecisionClient, decisionTopicRecipient } from '../helper/egdesk-decision-client.mjs'

const surface = fs.readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
function section(from, to) {
  const a = surface.indexOf(from), b = surface.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a)
  return surface.slice(a, b)
}
const controllerSource = section('  function chatChoiceExplanationDraft(', '  function mountCodexHUD(')
const mount = vm.runInNewContext(`${controllerSource}\nmountChatChoiceComposer`)
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

// ---- mock Decisions endpoint -------------------------------------------------
const rows = (q, order) => order.map(([value, probability]) => ({ value: value === 'abstain' ? 'abstain' : q.choices[Number(value.slice(1)) - 1].value, probability }))
const answer = order => (q, extra = {}) => new Response(JSON.stringify({ answers: [{ name: q.name, type: 'choice',
  probabilities: rows(q, order), choice: rows(q, order)[0].value, confidence: order[0][1], ...extra }] }))
const json = (status, body) => new Response(JSON.stringify(body), { status })
export const OUTCOMES = {
  confident: { respond: answer([['c1', 0.96], ['c2', 0.03], ['abstain', 0.01]]) },
  abstain: { respond: answer([['abstain', 0.9], ['c1', 0.06], ['c2', 0.04]]) },
  near_tie: { respond: answer([['c1', 0.46], ['c2', 0.44], ['abstain', 0.1]]) },
  low_confidence: { respond: answer([['c1', 0.62], ['c2', 0.28], ['abstain', 0.1]]) },
  out_of_list: { respond: q => new Response(JSON.stringify({ answers: [{ name: q.name, type: 'choice', choice: 'c9', confidence: 0.9,
    probabilities: [{ value: 'c9', probability: 0.9 }, { value: 'abstain', probability: 0.1 }] }] })) },
  no_credit: { respond: () => json(429, { error: { code: 'insufficient_quota', type: 'insufficient_quota' } }) },
  rate_limited: { respond: () => json(429, { error: { code: 'rate_limit_exceeded', type: 'rate_limit_error' } }) },
  timeout: { hang: true },
  budget_exceeded: { budget: { canSpend: () => false, record() {} } },
  invalid_key: { respond: () => json(401, { error: { code: 'invalid_api_key' } }) },
  unreachable: { throws: new TypeError('fetch failed') },
  server_error: { respond: () => json(500, { error: { code: 'server_error' } }) },
  model_unavailable: { respond: () => json(404, { error: { code: 'model_not_found' } }) },
}

function runtime(t, outcome) {
  const dataDir = mkdtempSync(join(tmpdir(), 'egdesk-outcome-db-'))
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
  const state = { native: 0, posts: [], key: 'egd-synthetic-not-a-key-0002' }
  const noNative = () => { state.native++; throw Error('Unexpected native operation') }
  const client = createDecisionClient({
    getApiKey: async () => state.key, budget: outcome.budget ?? null,
    recipientForKey: (key, endpoint, model) => decisionTopicRecipient(key, 42, endpoint, model),
    fetchImpl: async (url, req) => {
      const body = JSON.parse(req.body)
      state.posts.push({ url, body })
      if (outcome.throws) throw outcome.throws
      if (outcome.hang) return new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
      return outcome.respond(body.questions[0])
    } })
  const decisionContext = { client, mode: () => 'on', configured: () => true, settingsGeneration: () => 1, reviewRevision: () => reviewRevision,
    recipientForChatChoice: ({ ownerKey }) => ownerKey === author ? decisionTopicRecipient(state.key, 42) : null }
  const adapter = createCodexEngineAdapter({ request: noNative, respond: noNative, getOwnerKey: () => author, profiles: { ensureReady: noNative } })
  Object.assign(adapter, { ensureReady: noNative, startTurn: noNative })
  const chat = new CodexChatRuntime({ request: noNative, respond: noNative, engines: [adapter], store, requireStore: true, getOwnerKey: () => author, now: () => time,
    profiles: { runProfile: () => ({ binding: profileBinding, developerInstructions: 'synthetic instructions' }) }, decisionContext })
  chat.startTurn = noNative
  const handle = createChatHttpHandler(chat, noNative)
  const post = async body => {
    const req = Object.assign(new EventEmitter(), { url: '/chat/choice', method: 'POST', socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } })
    const response = {}
    const res = Object.assign(new EventEmitter(), { writeHead(status) { response.status = status }, end(data) { response.body = JSON.parse(data) } })
    assert.equal(await handle(req, res, new URL('/chat/choice', 'http://127.0.0.1:39218')), true)
    return response
  }
  return { state, post, bridge: [] }
}

// ---- Surface harness (same fake-DOM pattern as egdesk-chat-choice-composer.test.mjs) -------
let focused = null
function el(tag, props = {}, ...children) {
  const listeners = new Map()
  const node = { tag, props, children: children.filter(x => x != null), value: '', textContent: '', hidden: false, disabled: false,
    focus() { focused = this }, replaceChildren(...next) { this.children = next; },
    querySelector(selector) { return this.find(selector.match(/data-testid="([^\"]+)"/)?.[1])[0] || null },
    find(id) { return [...(this.props.data?.testid === id ? [this] : []), ...this.children.flatMap(x => x.find?.(id) || [])] },
    all() { return [this, ...this.children.flatMap(x => x.all?.() || [])] },
    get text() { return this.textContent + ' ' + this.children.map(x => typeof x === 'string' ? x : x.text).join(' ') },
    addEventListener(type, callback) { listeners.set(type, callback) },
    click() { if (!this.disabled && !this.hidden) { this.props.onclick?.() } },
    type(value) { this.value = value; this.props.oninput?.() } }
  return node
}

async function journey(t, name, { probe = 'edit' } = {}) {
  focused = null
  const outcome = OUTCOMES[name]
  const rt = runtime(t, outcome)
  const proof = { configured: true, mode: 'on', boardRevision: reviewRevision }
  const calls = { drafts: [], native: [], status: 0, httpPosts: [] }
  const sceneKey = { key: 'room/owner/revision/1', editKey: 'room/owner/draft/1' }
  const input = Object.assign(el('textarea'), { isConnected: true, value: question, dataset: { threadId: 'room' } })
  const bridge = vm.runInNewContext(`({${transport}})`, { fetchJson: async (path, args) => {
    if (path === '/decision/status') { calls.status++; return proof }
    const body = JSON.parse(args.body)
    const result = await rt.post({ ...body, requestId: `choice-${time}-${randomUUID()}`, ...ids })
    calls.httpPosts.push({ status: result.status, body: result.body })
    if (result.status !== 200) throw new Error(`http ${result.status}`)
    return result.body
  } })
  const choice = mount({ el, readMode: bridge.readChatChoiceMode, postChoice: bridge.postChatChoice,
    openSettings: reason => calls.settings = (calls.settings || []).concat(reason),
    makeController: () => new AbortController(), makeRequestId: () => `choice-${time}-${randomUUID()}` })
  choice.attach({ input, readScope: () => ({ ...sceneKey, ...ids, question: input.value }), setDraft: draft => calls.drafts.push(draft) })
  choice.sync()
  const find = id => choice.panel.find(`chat-choice-${id}`)
  const click = id => find(id)[0]?.click()
  const settle = async () => { for (let i = 0; i < 80 && /기다리는 중|확인 중/.test(choice.panel.text); i++) await new Promise(r => setTimeout(r, 50)) }
  // 1) user opens 보기 추천, edits two options, reviews, confirms.
  choice.trigger.click(); find('option').forEach((node, i) => node.type(options[i]))
  click('review'); await tick()
  const beforeConfirmPosts = rt.state.posts.length
  focused = null
  click('confirm'); await tick(); await settle()
  const observe = () => ({
    panelHidden: choice.panel.hidden,
    text: choice.panel.text.replace(/\s+/g, ' ').trim(),
    buttons: choice.panel.all().filter(n => n.tag === 'button').map(n => ({ id: n.props.data.testid.replace('chat-choice-', ''), label: n.text.trim(), disabled: n.disabled })),
    focus: focused?.props?.data?.testid?.replace('chat-choice-', '') ?? (focused ? focused.tag : null),
    composerValue: input.value,
    decisionsPosts: rt.state.posts.length - beforeConfirmPosts,
    bridgeReply: calls.httpPosts.at(-1)?.body ?? null,
    nativeOps: rt.state.native, draftsCreated: calls.drafts.length,
  })
  const seen = observe()
  const recovery = {}
  if (probe) {
    // 2) recovery probes, whichever controls exist. Never presses 보내기 / native send.
    const has = id => find(id).length > 0
    recovery.available = Object.fromEntries(['retry', 'edit', 'explain', 'ask', 'settings', 'cancel'].map(id => [id, has(id)]))
    if (probe === 'retry' && has('retry')) {
      const posts = rt.state.posts.length
      click('retry'); await tick(); await tick()
      recovery.retryGoesTo = find('confirm').length ? 'review-with-confirm-button' : choice.panel.text.replace(/\s+/g, ' ').trim()
      recovery.retrySentWithoutConfirm = rt.state.posts.length !== posts
    }
    if (probe === 'edit' && has('edit')) {
      click('edit'); await tick()
      recovery.editOptions = find('option').map(n => n.value)
      recovery.editFocus = focused?.props?.data?.testid?.replace('chat-choice-', '') ?? null
    }
  }
  return { name, seen, recovery, rt, choice, find, click, calls, input, settle, beforeConfirmPosts, reopen() {
    choice.trigger.click(); return find('option').map(n => n.value) } }
}

const MATRIX = {}
const dump = () => { if (process.env.EGDESK_SIM_OUT) fs.writeFileSync(process.env.EGDESK_SIM_OUT, JSON.stringify(MATRIX, null, 2)) }
const RETRYABLE = new Set(['rate_limited', 'timeout', 'unreachable', 'server_error'])
const AMBIGUOUS = new Set(['abstain', 'near_tie', 'low_confidence'])

for (const name of Object.keys(OUTCOMES)) {
  test(`L2 outcome ${name}: same-DM rendering, preserved input, correct next steps, nothing executes`, async t => {
    // Run A: observe, then close and reopen (does [닫기] destroy the reviewed options?).
    const a = await journey(t, name, { probe: false })
    let reopened = null
    if (name !== 'confident' && a.find('cancel').length) { a.click('cancel'); await tick(); reopened = a.reopen() }
    // Run B: same outcome again, now press the recovery controls that exist (retry / edit).
    const j = await journey(t, name, { probe: 'edit' })
    const r = await journey(t, name, { probe: 'retry' })
    j.recovery = { ...j.recovery, retryGoesTo: r.recovery.retryGoesTo ?? null, retrySentWithoutConfirm: r.recovery.retrySentWithoutConfirm ?? null }
    MATRIX[name] = { observed: j.seen, recovery: j.recovery, optionsAfterClose: reopened }
    dump()
    const { seen } = j
    // Invariants that must hold both before and after the patch.
    assert.equal(seen.nativeOps, 0, 'nothing may start or send a native/subscription turn')
    assert.equal(seen.draftsCreated, 0, 'no draft is created without an explicit user click')
    assert.equal(seen.composerValue, question, 'the composer text is untouched')
    assert.equal(seen.decisionsPosts, name === 'budget_exceeded' ? 0 : 1, 'exactly one Decisions call (zero when the local budget blocks it)')
    if (name === 'confident') {
      assert.match(seen.text, /EG-Desk 추천: 슬라이드 10장 요약본 · 실행하지 않음/)
      assert.ok(seen.buttons.some(b => b.id === 'explain' && !b.disabled))
      return
    }
    // Outcomes below must NOT look like a recommendation and must say something specific.
    assert.doesNotMatch(seen.text, /EG-Desk 추천:/)
    assert.deepEqual(seen.buttons.filter(b => b.id === 'explain'), [], 'no recommendation to explain')
    assert.equal(seen.bridgeReply.status, 'manual')
    assert.equal(seen.bridgeReply.reason, name === 'near_tie' ? 'unclear' : name === 'out_of_list' ? 'bad_response' : name, 'bridge names the outcome with a fixed enum, nothing else')
    assert.deepEqual(Object.keys(seen.bridgeReply).sort(), ['reason', 'status'])
    assert.doesNotMatch(seen.text, /^추천을 표시할 수 없습니다\. 직접 판단해 주세요\. 작성 중인 메시지는 그대로입니다\. 닫기$/, 'not the one generic sentence')
    // The reviewed options survive (GOV.UK: do not clear fields on error).
    // [닫기] stays an explicit dismissal (existing composer test: manual close discards option edits);
    // the preserving path is [질문·보기 수정], asserted through recovery.editOptions below.
    assert.deepEqual(reopened, ['', ''], '[닫기] dismisses; it does not silently keep text')
    // Retry is offered only for retryable outcomes, and never sends by itself.
    const ids = seen.buttons.map(b => b.id)
    assert.equal(ids.includes('retry'), RETRYABLE.has(name), 'retry only when retryable')
    if (RETRYABLE.has(name)) {
      assert.equal(j.recovery.retryGoesTo, 'review-with-confirm-button')
      assert.equal(j.recovery.retrySentWithoutConfirm, false)
    }
    assert.deepEqual(j.recovery.editOptions, options, '[질문·보기 수정] returns to the editor with the reviewed options')
    assert.ok(ids.includes('edit'), 'edit options is always possible')
    assert.equal(ids.includes('ask'), AMBIGUOUS.has(name), 'ask-the-agent draft only when the model could not choose')
    assert.equal(ids.includes('settings'), ['invalid_key', 'model_unavailable'].includes(name))
    assert.ok(seen.focus && ids.includes(seen.focus), `focus lands on a control of the result (${seen.focus})`)
  })
}

test('L2 ambiguous outcome: [에이전트에게 물어보기] only fills an editable draft; sending stays a separate action', async t => {
  const j = await journey(t, 'abstain', { probe: false })
  j.click('ask'); await tick()
  assert.equal(j.calls.drafts.length, 1)
  assert.equal(j.input.value, j.calls.drafts[0])
  assert.match(j.input.value, /질문: /); assert.ok(options.every(o => j.input.value.includes(o)))
  assert.match(j.input.value, /선택하거나 실행하지 마세요/)
  assert.equal(j.rt.state.native, 0)
})

test('L2 invalid_key: [계정 설정 열기] keeps the reviewed options for the return trip', async t => {
  const j = await journey(t, 'invalid_key', { probe: false })
  j.click('settings'); await tick()
  assert.deepEqual(j.calls.settings, ['key'])
  assert.deepEqual(j.reopen(), options)
})
