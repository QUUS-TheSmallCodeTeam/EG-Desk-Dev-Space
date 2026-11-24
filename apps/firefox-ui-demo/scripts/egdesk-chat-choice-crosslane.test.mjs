// L2 cycle 5: cross-lane interaction matrix for the DM chooser, one continuous journey on int/c3.
// Mounted/real code: Surface chooser controller + the Surface bridge snippet (status/choice) in a fake DOM,
// real /decision/* and /chat/choice HTTP handlers, real credential store, real CodexChatRuntime.chatChoice, real decision client,
// real keep-alive transport talking to a LOOPBACK mock "Decisions" server (127.0.0.1 only, synthetic keys), real calibration log.
// Not mounted: Surface chatChoiceScope gate (covered by egdesk-chat-choice-restored-dm / settings-return).
// EGDESK_SIM_OUT=<file> dumps the measured journey as JSON.
import assert from 'node:assert/strict'
import fs, { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import vm from 'node:vm'
import { CodexChatRuntime } from '../helper/codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from '../helper/codex-engine-adapter.mjs'
import { createChatHttpHandler } from '../helper/codex-bridge-http.mjs'
import { openChatStore } from '../helper/egdesk-chat-store.mjs'
import { createDecisionClient, decisionTopicRecipient, DECISION_MODEL } from '../helper/egdesk-decision-client.mjs'
import { openDecisionCredentialStore } from '../helper/egdesk-decision-credential.mjs'
import { createDecisionHttpHandler } from '../helper/egdesk-decision-http.mjs'
import { createDecisionTransport } from '../helper/egdesk-decision-transport.mjs'
import { openCalibrationLog } from '../helper/egdesk-decision-calibration-log.mjs'
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs'

const surface = fs.readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8')
function section(from, to) {
  const a = surface.indexOf(from), b = surface.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, from)
  return surface.slice(a, b)
}
const mount = vm.runInNewContext(`${section('  function chatChoiceExplanationDraft(', '  function mountCodexHUD(')}\nmountChatChoiceComposer`)
const transportSource = section('      readChatChoiceMode(signal)', "      // Settings '결정 모델")

const ids = { clientThreadId: 'dm-synthetic', conversationId: 'native-synthetic', profileId: 'agent-synthetic' }
const time = 1780000000000
const engine = { id: 'codex', engineProfileId: 'codex-default' }
const profileBinding = { profileId: ids.profileId, revision: 1, hash: 'synthetic-profile-hash' }
const author = 'synthetic-account'
const ownerHash = createHash('sha256').update(author).digest('hex')
const question = '이번 주 발표 자료는 어느 쪽으로 정리할까요?'
const options = ['슬라이드 10장 요약본', '표 중심 상세본']
const KEY1 = 'sk-proj-TESTKEY-0123456789abcdefWXYZ', KEY2 = 'sk-proj-TESTKEY-REPLACED-0123456789abcdefWXYZ'
const tick = () => new Promise(resolve => setImmediate(resolve))
const settleAll = async () => { for (let i = 0; i < 8; i++) await tick() }
const until = async (fn, label, ms = 9000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 25)) } throw new Error('timed out waiting for ' + label) }

// ---- loopback mock Decisions server ------------------------------------------------------
async function mockProvider(t) {
  const seen = { connections: 0, requests: [], aborted: 0 }
  const plan = [] // per-request behavior, consumed in order; default 'ok'
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const behavior = plan.shift() ?? 'ok'
      seen.requests.push({ auth: req.headers.authorization, behavior })
      res.on('close', () => { if (!res.writableEnded) seen.aborted++ })
      if (behavior === 'hang') return
      const q = body.questions[0]
      if (behavior === 'spend') { res.writeHead(429, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { code: 'organization_spend_limit_exceeded' } })) }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ usage: { input_tokens: 10 }, answers: [{ name: q.name, type: 'choice', choice: q.choices[0].value, confidence: 0.96,
        probabilities: [{ value: q.choices[0].value, probability: 0.96 }, { value: q.choices[1].value, probability: 0.03 }, { value: 'abstain', probability: 0.01 }] }] }))
    })
  })
  server.on('connection', socket => { seen.connections++; socket.unref() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections?.(); server.close() })
  return { seen, plan, endpoint: `http://127.0.0.1:${server.address().port}/v1/decisions` }
}

// ---- bridge: real decision HTTP + chat runtime over one store ------------------------------
function fakeRequest(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  return Object.assign(req, { method, url, socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', ...(body === undefined ? {} : { 'content-type': 'application/json' }) } })
}
const fakeResponse = () => Object.assign(new EventEmitter(), { status: null, body: '', writeHead(s) { this.status = s }, end(b) { this.body = b ?? '' } })

function startBridge(t, provider, shared = null) {
  const state = shared ?? (() => {
    const dataDir = mkdtempSync(join(tmpdir(), 'egdesk-cross-chat-'))
    const store = openChatStore({ dataDir, ownerScope: 'fixture-only' })
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
    const root = createPrivateQaTempDirectory('egdesk-cross-decision-')
    const credentials = openDecisionCredentialStore({ dataDir: join(root, 'data'), log: () => {} })
    const calibrationLog = openCalibrationLog({ dataDir: join(root, 'cal'), log: () => {} })
    t.after(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }) })
    return { store, credentials, calibrationLog, mode: { mode: 'on', saved: true, persisted: true, save(m) { this.mode = m; return true } }, gen: 0, native: 0 }
  })()
  const transport = createDecisionTransport()
  t.after(() => transport.close())
  const revisionOf = () => createHash('sha256').update(JSON.stringify([state.mode.mode, state.credentials.getApiKey() !== null, state.credentials.savedAt(), state.credentials.getApiKey()?.length ?? 0, state.gen])).digest('hex')
  const boardPresentation = { settingsRevision: revisionOf, invalidate() {} }
  const decisionHttp = createDecisionHttpHandler({ store: state.credentials, verifyKey: async () => ({ status: 'verified', retryable: false }), model: DECISION_MODEL,
    mode: state.mode, boardPresentation, onSettingsChanged: () => { state.gen++ } })
  const client = createDecisionClient({ getApiKey: async () => { if (state.keyStall) await state.keyStall; return state.credentials.getApiKey() }, endpoint: provider.endpoint, fetchImpl: transport.fetch,
    recipientForKey: (key, endpoint, model) => decisionTopicRecipient(key, state.credentials.savedAt(), endpoint, model) })
  const recipient = () => decisionTopicRecipient(state.credentials.getApiKey(), state.credentials.savedAt(), provider.endpoint, DECISION_MODEL)
  const noNative = () => { state.native++; throw Error('Unexpected native operation') }
  const adapter = createCodexEngineAdapter({ request: noNative, respond: noNative, getOwnerKey: () => author, profiles: { ensureReady: noNative } })
  Object.assign(adapter, { ensureReady: noNative, startTurn: noNative })
  const chat = new CodexChatRuntime({ request: noNative, respond: noNative, engines: [adapter], store: state.store, requireStore: true, getOwnerKey: () => author, now: () => state.clock ?? time,
    profiles: { runProfile: () => ({ binding: profileBinding, developerInstructions: 'synthetic instructions' }) },
    decisionContext: { client, calibrationLog: state.calibrationLog, mode: () => state.mode.mode, configured: () => state.credentials.getApiKey() !== null,
      settingsGeneration: () => state.gen, reviewRevision: revisionOf, recipientForChatChoice: ({ ownerKey }) => ownerKey === author && state.credentials.getApiKey() ? recipient() : null } })
  chat.startTurn = noNative
  const chatHttp = createChatHttpHandler(chat, noNative)
  const call = async (method, path, body, signal) => {
    if (state.bridgeDown) throw new TypeError('fetch failed (bridge not running)')
    const req = fakeRequest(method, path, body), res = fakeResponse()
    signal?.addEventListener('abort', () => res.emit('close'), { once: true })
    const url = new URL(path, 'http://127.0.0.1:39218')
    const handled = path.startsWith('/decision/') ? await decisionHttp(req, res, url) : await chatHttp(req, res, url)
    assert.equal(handled, true, path)
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
    return { status: res.status, data: res.body ? JSON.parse(res.body) : null }
  }
  return { state, chat, transport, call, client }
}

// ---- fake DOM + mounted chooser -----------------------------------------------------------
let focused = null
function el(tag, props = {}, ...children) {
  return { tag, props, children: children.filter(x => x != null), value: '', textContent: '', hidden: false, disabled: false,
    focus() { focused = this }, replaceChildren(...next) { this.children = next },
    querySelector(selector) { return this.find(selector.match(/data-testid="([^\"]+)"/)?.[1])[0] || null },
    find(id) { return [...(this.props.data?.testid === id ? [this] : []), ...this.children.flatMap(x => x.find?.(id) || [])] },
    all() { return [this, ...this.children.flatMap(x => x.all?.() || [])] },
    contains(node) { return this.all().includes(node) },
    get ownerDocument() { return { get activeElement() { return focused } } },
    get text() { return this.textContent + ' ' + this.children.map(x => typeof x === 'string' ? x : x.text).join(' ') },
    addEventListener() {}, click() { if (!this.disabled && !this.hidden) this.props.onclick?.() },
    type(value) { this.value = value; this.props.oninput?.() } }
}

function mountDm(t, bridgeRef) {
  focused = null
  const scene = { editKey: 'room/owner/draft/1', gen: 0 }
  scene.key = JSON.stringify([scene.editKey, 0])
  const input = Object.assign(el('textarea'), { isConnected: true, value: question, dataset: { threadId: 'room' } })
  const drafts = []
  // The real Surface snippet: status read and choice POST, over the (possibly restarted) bridge.
  const surfaceBridge = vm.runInNewContext(`({${transportSource}})`, { fetchJson: async (path, args) => {
    const body = args.body ? JSON.parse(args.body) : undefined
    const { status, data } = await bridgeRef.current.call(args.method ?? 'GET', path, body, args.signal)
    if (status >= 400) throw Object.assign(new Error(`http ${status}`), { status, data })
    return data
  } })
  const choice = mount({ el, readMode: surfaceBridge.readChatChoiceMode, postChoice: surfaceBridge.postChatChoice, makeController: () => new AbortController(),
    makeRequestId: () => `choice-${time}-${randomUUID()}`,
    openSettings: reason => { scene.opened = (scene.opened || []).concat(reason) } })
  const attach = () => choice.attach({ input, readScope: () => scene.key && ({ key: scene.key, editKey: scene.editKey, ...ids, question: input.value }), setDraft: d => drafts.push(d) })
  attach(); choice.sync()
  const find = id => choice.panel.find(`chat-choice-${id}`)
  const click = id => find(id)[0]?.click()
  const where = () => !focused ? 'body' : focused === input ? 'composer' : (!choice.panel.contains(focused) && focused !== choice.trigger) ? 'body(lost)' : focused.props?.data?.testid?.replace('chat-choice-', '') ?? focused.tag
  const text = () => choice.panel.text.replace(/\s+/g, ' ').trim()
  const buttons = () => choice.panel.all().filter(n => n.tag === 'button').map(n => n.props.data.testid.replace('chat-choice-', ''))
  const fields = () => find('option').map(n => n.value)
  const typeOptions = () => find('option').forEach((n, i) => n.type(options[i]))
  // This window saves Decisions settings: the product bumps the scope key (not the edit key).
  const settingsSaved = () => { scene.key = JSON.stringify([scene.editKey, ++scene.gen]); choice.sync() }
  return { scene, input, choice, find, click, where, text, buttons, fields, typeOptions, settingsSaved, surfaceBridge, drafts }
}

const JOURNEY = {}
const mark = (step, row) => { JOURNEY[step] = row; if (process.env.EGDESK_SIM_OUT) fs.writeFileSync(process.env.EGDESK_SIM_OUT, JSON.stringify(JOURNEY, null, 2)) }
const countsOf = (provider, bridge) => ({ providerRequests: provider.seen.requests.length, connections: provider.seen.connections, calibration: bridge.state.calibrationLog.entries().length, native: bridge.state.native })

test('X0 mode off or no key: typing, opening the panel and reviewing make no provider contact', async t => {
  const provider = await mockProvider(t)
  const bridge = startBridge(t, provider); const ref = { current: bridge }
  const dm = mountDm(t, ref)
  dm.choice.trigger.click(); await settleAll() // no key saved yet: opening the panel contacts nobody
  assert.equal(provider.seen.connections, 0)
  await bridge.call('POST', '/decision/credential', { apiKey: KEY1 })
  await bridge.call('POST', '/decision/mode', { mode: 'off' })
  const fresh = mountDm(t, ref)
  fresh.choice.trigger.click(); await settleAll()
  assert.equal(provider.seen.connections, 0, 'off = zero contact')
  fresh.typeOptions(); fresh.click('review'); await settleAll()
  assert.match(fresh.text(), /결정 모델이 꺼져 있습니다/); assert.deepEqual(fresh.buttons(), ['settings', 'cancel'])
  assert.equal(provider.seen.requests.length, 0); assert.equal(bridge.state.calibrationLog.entries().length, 0)
  assert.notEqual(fresh.where(), 'body(lost)')
})

test('X1 one journey: open panel (no contact) -> timeout (dispatched) -> retry -> spend limit -> mode off mid-flight -> key replaced mid-flight -> bridge restart', async t => {
  const provider = await mockProvider(t)
  const bridge = startBridge(t, provider); const ref = { current: bridge }
  await bridge.call('POST', '/decision/credential', { apiKey: KEY1 })
  await bridge.call('POST', '/decision/mode', { mode: 'on' })
  const dm = mountDm(t, ref)

  // 1) opening the panel contacts nobody: there is no pre-connect
  dm.choice.trigger.click(); await settleAll()
  const opened = countsOf(provider, bridge)
  mark('1 open panel', opened)
  assert.deepEqual([opened.connections, opened.providerRequests], [0, 0], 'no connection and no request before the user confirms')
  assert.equal(dm.where(), 'option', 'opening lands on the first option field')
  dm.typeOptions(); dm.click('review'); await settleAll()
  assert.ok(dm.buttons().includes('confirm')); assert.equal(dm.where(), 'confirm')

  // 2) confirm (double-click) -> provider hangs -> deadline -> "timeout" (dispatched)
  provider.plan.push('hang')
  const confirm = dm.find('confirm')[0]; confirm.click(); confirm.click()
  await until(() => /제한 시간/.test(dm.text()), 'timeout text')
  const timedOut = { ...countsOf(provider, bridge), text: dm.text().slice(0, 100), buttons: dm.buttons(), focus: dm.where() }
  mark('2 confirm x2 -> timeout (dispatched)', timedOut)
  assert.equal(timedOut.providerRequests, 1, 'one paid request for a double-clicked confirm')
  assert.equal(timedOut.connections, 1, 'the confirmed request opened the only connection')
  assert.match(timedOut.text, /요청은 이미 보냈으므로 비용이 청구될 수 있고/); assert.deepEqual(timedOut.buttons, ['retry', 'edit', 'cancel'])
  assert.equal(timedOut.focus, 'retry'); assert.equal(timedOut.calibration, 1)

  // 3) retry -> review -> confirm -> 429 spend limit: no retry, no settings, focus on edit
  dm.click('retry'); await settleAll()
  assert.equal(provider.seen.requests.length, 1, 'retry alone sends nothing'); assert.equal(dm.where(), 'confirm')
  provider.plan.push('spend'); dm.click('confirm'); await until(() => /지출·사용 한도/.test(dm.text()), 'spend text')
  const spend = { ...countsOf(provider, bridge), buttons: dm.buttons(), focus: dm.where() }
  mark('3 retry -> confirm -> spend limit', spend)
  assert.equal(spend.providerRequests, 2); assert.deepEqual(spend.buttons, ['edit', 'cancel']); assert.equal(spend.focus, 'edit'); assert.equal(spend.calibration, 2)

  // 4) edit -> review -> confirm (provider hangs) -> mode switched to advisory mid-flight
  dm.click('edit'); await settleAll(); assert.deepEqual(dm.fields(), options)
  dm.click('review'); await settleAll()
  provider.plan.push('hang'); dm.click('confirm'); await until(() => provider.seen.requests.length === 3, 'third request')
  await bridge.call('POST', '/decision/mode', { mode: 'advisory' }); dm.settingsSaved(); await settleAll()
  const modeSwitch = { ...countsOf(provider, bridge), panelHidden: dm.choice.panel.hidden, focus: dm.where(), options: (dm.choice.trigger.click(), dm.fields()) }
  mark('4 mode advisory mid-flight', modeSwitch)
  assert.equal(modeSwitch.providerRequests, 3); assert.equal(modeSwitch.panelHidden, true)
  assert.deepEqual(modeSwitch.options, options, 'typed options survive')
  assert.notEqual(modeSwitch.focus, 'body(lost)')
  await settleAll()
  assert.equal(modeSwitch.native, 0)
  // advisory: reopening says the mode is not "on"; still no extra request
  dm.click('review'); await settleAll()
  assert.match(dm.text(), /기록만/); assert.equal(provider.seen.requests.length, 3)
  const afterMode = { ...countsOf(provider, bridge), calibration: bridge.state.calibrationLog.entries().length }
  mark('4b calibration after mode switch', afterMode)
  assert.equal(afterMode.calibration, 3, 'the in-flight request that was abandoned by a mode switch is still recorded once')

  // 5) mode back to on through settings; typed options return; key replaced mid-flight
  dm.click('settings'); assert.deepEqual(dm.scene.opened.slice(-1), ['mode'])
  await bridge.call('POST', '/decision/mode', { mode: 'on' }); dm.settingsSaved(); await settleAll()
  dm.choice.trigger.click(); assert.deepEqual(dm.fields(), options, 'typed options come back after the settings return')
  dm.click('review'); await settleAll()
  provider.plan.push('hang'); dm.click('confirm'); await until(() => provider.seen.requests.length === 4, 'fourth request')
  await bridge.call('POST', '/decision/credential', { apiKey: KEY2 }); dm.settingsSaved(); await settleAll()
  const keySwap = { ...countsOf(provider, bridge), focus: dm.where(), options: (dm.choice.trigger.click(), dm.fields()) }
  mark('5 key replaced mid-flight', keySwap)
  assert.equal(keySwap.providerRequests, 4, 'replacing the key never triggers a second request'); assert.deepEqual(keySwap.options, options)
  assert.notEqual(keySwap.focus, 'body(lost)')

  // 6) confirm under the new key -> recommendation; carries the new key only
  dm.click('review'); await settleAll(); provider.plan.push('ok'); dm.click('confirm'); await until(() => dm.find('result').length === 1, 'recommendation')
  const done = { ...countsOf(provider, bridge), focus: dm.where(), auth: provider.seen.requests.map(r => r.auth === `Bearer ${KEY1}` ? 'key1' : r.auth === `Bearer ${KEY2}` ? 'key2' : 'other') }
  mark('6 confirm under replaced key', done)
  assert.deepEqual(done.auth, ['key1', 'key1', 'key1', 'key1', 'key2']); assert.equal(done.focus, 'explain')
  assert.equal(done.providerRequests, 5)
  assert.equal(done.calibration, 5, 'exactly one calibration entry per provider request')
  assert.deepEqual(bridge.state.calibrationLog.entries().map(e => e.fallback ?? 'none'), ['timeout', 'spend_limit_reached', 'mode_changed', 'mode_changed', 'none'])

  // 7) bridge restart while the recommendation is shown, then ask again: bridge unreachable, then back
  ref.current = Object.assign(bridge, {}); bridge.state.bridgeDown = true
  dm.click('explain'); await settleAll()          // 이유 묻기 re-checks status: bridge is down
  const down = { text: dm.text().slice(0, 80), buttons: dm.buttons(), focus: dm.where(), draftCount: dm.drafts.length }
  mark('7 bridge down at explain', down)
  assert.equal(dm.drafts.length, 0, 'no draft from an unverifiable recommendation')
  assert.notEqual(down.focus, 'body(lost)')
  bridge.state.bridgeDown = false
  assert.equal(bridge.state.native, 0)

  // noContent: the calibration file never saw the question/options/keys/ids
  const root = JSON.stringify(bridge.state.calibrationLog.entries())
  for (const secret of [question, ...options, KEY1, KEY2, ...Object.values(ids)]) assert.equal(root.includes(secret), false, secret)
})

test('X2 bridge restart between confirms: new runtime on the same store; unreachable bridge keeps the typed options and offers a way forward', async t => {
  const provider = await mockProvider(t)
  const bridge = startBridge(t, provider); const ref = { current: bridge }
  await bridge.call('POST', '/decision/credential', { apiKey: KEY1 })
  await bridge.call('POST', '/decision/mode', { mode: 'on' })
  const dm = mountDm(t, ref)
  dm.choice.trigger.click(); dm.typeOptions(); dm.click('review'); await settleAll()
  // restart: the bridge is down when the user confirms (status read at confirm fails: the chooser reports the check, not a send)
  bridge.state.bridgeDown = true
  dm.click('confirm'); await settleAll()
  const down = { text: dm.text().slice(0, 100), buttons: dm.buttons(), focus: dm.where(), requests: provider.seen.requests.length }
  mark('8 bridge down at confirm', down)
  assert.equal(down.requests, 0)
  assert.notEqual(down.focus, 'body(lost)')
  assert.ok(down.buttons.includes('edit') || down.buttons.includes('retry'), `a way forward that keeps the typed options (buttons: ${down.buttons})`)
  // bridge returns as a NEW runtime/transport/client over the same store and credential
  const restarted = startBridge(t, provider, bridge.state); ref.current = restarted
  bridge.state.bridgeDown = false
  if (dm.find('edit').length) dm.click('edit'); else dm.click('cancel')
  await settleAll()
  dm.choice.trigger.hidden && dm.find('option').length ? null : dm.choice.trigger.click()
  assert.deepEqual(dm.fields(), options, 'typed options survive the restart')
  dm.click('review'); await settleAll(); dm.click('confirm'); await until(() => dm.find('result').length === 1, 'recommendation after restart')
  const after = { ...countsOf(provider, bridge), focus: dm.where() }
  mark('9 confirm after restart', after)
  assert.equal(after.providerRequests, 1, 'exactly one paid request for the one confirm that reached the bridge'); assert.equal(after.calibration, 1); assert.equal(after.native, 0)
})

test('X3 stalled key lookup: timeout_unsent says nothing was sent, nothing is billed or counted as a provider timeout', async t => {
  const provider = await mockProvider(t)
  const bridge = startBridge(t, provider); const ref = { current: bridge }
  await bridge.call('POST', '/decision/credential', { apiKey: KEY1 })
  await bridge.call('POST', '/decision/mode', { mode: 'on' })
  const dm = mountDm(t, ref)
  dm.choice.trigger.click(); dm.typeOptions(); dm.click('review'); await settleAll()
  bridge.state.keyStall = new Promise(() => {})
  dm.click('confirm'); await until(() => /아무것도 전송하지 않았습니다/.test(dm.text()), 'timeout_unsent text')
  const unsent = { ...countsOf(provider, bridge), buttons: dm.buttons(), focus: dm.where() }
  mark('10 timeout_unsent', unsent)
  assert.equal(unsent.providerRequests, 0); assert.deepEqual(unsent.buttons, ['retry', 'edit', 'cancel']); assert.equal(unsent.focus, 'retry')
  assert.equal(unsent.calibration, 0, 'a request that never left is not recorded as a provider timeout')
  // restart + replay of an already used request ID (informational: the one-time receipt is in memory only)
  bridge.state.keyStall = null
  const body = { ...ids, requestId: `choice-${time}-${randomUUID()}`, question, options, confirm: true, reviewRevision: createHash('sha256').update(JSON.stringify([bridge.state.mode.mode, true, bridge.state.credentials.savedAt(), bridge.state.credentials.getApiKey().length, bridge.state.gen])).digest('hex') }
  const first = await bridge.call('POST', '/chat/choice', body)
  bridge.state.clock = time + 5000                       // the bridge process restarts five seconds later
  const restarted = startBridge(t, provider, bridge.state)
  const replay = await restarted.call('POST', '/chat/choice', body)
  mark('11 replay of the same request ID after a bridge restart', { first: first.data, replay: replay.data, providerRequests: provider.seen.requests.length })
  assert.equal(first.data.status, 'recommended')
  assert.deepEqual(replay.data, { status: 'manual' }, 'a request ID minted before the restart is never paid again')
  assert.equal(provider.seen.requests.length, 1)
  // a fresh confirm after the restart is a new intent and is served
  const fresh = await restarted.call('POST', '/chat/choice', { ...body, requestId: `choice-${time + 5000}-${randomUUID()}` })
  assert.equal(fresh.data.status, 'recommended'); assert.equal(provider.seen.requests.length, 2)
  assert.equal(bridge.state.native, 0)
})
