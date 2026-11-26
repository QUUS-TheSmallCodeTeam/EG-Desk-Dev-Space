// a1 (교대, L5): the Decision model and the conversation model take turns on one browser request in ONE conversation, for Claude as for Codex.
// The real runtime, chat store, own-tools wiring, Claude adapter, MCP bridge, Browser and page-tool providers; only the Claude process (a scripted transport), the
// Card (an in-process UI double) and Decisions (a scripted fetch) are fake. Nothing real runs, no login is read, no model is called.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { createPageToolsProvider } from './egdesk-page-tools.mjs'
import { createOwnToolsWiring } from './egdesk-own-tools-wiring.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { createDecisionClient, decisionTopicRecipient } from './egdesk-decision-client.mjs'
import { createBrowserEntryConfig } from './egdesk-browser-entry-wiring.mjs'
import { createBrowserTaskStore } from './egdesk-browser-task.mjs'
import { pageStateWire } from './egdesk-browser-page-state.fixture.mjs'
import { entryWire } from './egdesk-browser-entry.fixture.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { BROWSER_TASK_TOOL_NAME, browserStepFor, browserTaskRule, noteWords, withBrowserTaskRule } from './egdesk-browser-task-turn.mjs'
import { createBrowserTaskTool } from './egdesk-browser-task-tool.mjs'
import { callTool } from './egdesk-claude-browser-world.fixture.mjs'

const KEY = 'egd-synthetic-not-a-key-0011'
const OWNER = 'claude:fixture-owner'
const O = 'https://portal.example.test'
const MSG = '거래처 포털에서 이번 달 세금계산서 내려받아줘'
const el = (ref, role, label, extra = {}) => ({ ref, role, label, tag: role === 'link' ? 'a' : 'button', href: '', value: '', ...extra })
const PAGES = {
  [`${O}/invoices`]: [el('b1', 'link', '사업자 123-45-67890', { href: `${O}/biz/1` }), el('b2', 'link', '사업자 987-65-43210', { href: `${O}/biz/2` }), el('s1', 'button', '발행 제출')],
  [`${O}/biz/2`]: [el('d2', 'link', '이번 달 세금계산서 다운로드', { href: `${O}/download/2.pdf` })], [`${O}/biz/1`]: [], [`${O}/download/2.pdf`]: [],
}
const choice = (name, value, confidence) => ({ name, type: 'choice', choice: value, confidence, probabilities: [{ value, probability: confidence }] })
const starts = (choices, text) => choices.find(c => c.value.includes(text))?.value
const tick = () => new Promise(resolve => setImmediate(resolve))
const until = async (predicate, ms = 4000) => { const end = Date.now() + ms; while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); assert.ok(predicate(), 'condition not reached in time') }

// The Card and Decisions as the C9 entry test scripts them: the portal lists two businesses (the person must choose), the second one's page has the download link.
function portal() {
  const timeline = [], acts = []
  let docSeq = 1, cur = { url: `${O}/invoices`, documentId: 'doc1', revision: 1 }
  const snap = () => ({ cardId: 'card', documentId: cur.documentId, revision: cur.revision, url: cur.url, readyState: 'complete', text: ['합성 포털'],
    viewport: { width: 300, height: 200, devicePixelRatio: 1 }, interactiveElements: PAGES[cur.url] })
  const client = createDecisionClient({ recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model), getApiKey: async () => KEY,
    fetchImpl: async (_e, { body }) => {
      const wire = JSON.parse(body), q0 = wire.questions[0], evidence = wire.input[1].content
      const stepQ = wire.questions.find(q => q.name === 'next_step') ?? (q0.choices ? q0 : { choices: [] })
      timeline.push(`decide:${q0.name}`)
      if (q0.name === 'browser_entry') {
        const msg = /User message: (.*)/.exec(evidence)?.[1] ?? ''
        return { ok: true, text: async () => JSON.stringify({ answers: entryWire(wire.questions, { web: /세금계산서|두 번째/.test(msg) ? 0.95 : 0.05 }) }) }
      }
      if (q0.name === 'task_resume') return { ok: true, text: async () => JSON.stringify({ answers: [choice('task_resume', 'resume_task', 0.95)] }) }
      const url = /URL: (\S+)/.exec(evidence)?.[1], ctx = /Context the user gave in the chat \(not page text\):\n([\s\S]*?)\n\n/.exec(evidence)?.[1] ?? ''
      let next, goalMet = 0
      if (/\/download\//.test(url)) { next = 'goal_met'; goalMet = 0.95 }
      else if (url.endsWith('/invoices')) { const listed = /it is listed now as (\[L\d+\] [^\n]*?)\.(?:\n|$)/.exec(evidence); next = listed ? listed[1].trim() : /두 번째/.test(ctx) ? starts(stepQ.choices, '987-65') : 'needs_user_context' }
      else next = starts(stepQ.choices, '다운로드')
      const answer = choice('next_step', next, 0.95)
      if (next === 'needs_user_context') answer.probabilities.push({ value: starts(stepQ.choices, '123-45'), probability: 0.02 }, { value: starts(stepQ.choices, '987-65'), probability: 0.02 })
      return { ok: true, text: async () => JSON.stringify({ answers: [answer, ...pageStateWire('content'), { name: 'goal_met', type: 'predicate', probability: goalMet }] }) }
    } })
  const transport = { runs: new Map(), hasClient: id => id === 'ui',
    bindRun: (id, thread, transportId) => { if (transport.runs.has(id)) throw new Error('already bound'); transport.runs.set(id, { clientThreadId: thread, transportId, ownerKey: OWNER }) },
    unbindRun: id => transport.runs.delete(id),
    async sendToUi(request) {
      timeline.push(`ui:${request.kind}`)
      const reply = { requestId: request.requestId }
      if (request.kind === 'bind') return { ...reply, status: 'bound', binding: { cardId: 'card', cardEpoch: 'epoch', profileId: 'fixture', accountId: '', userContextId: 0, url: cur.url, engineAccountKey: OWNER, authorityEpoch: 1 } }
      if (request.kind === 'observe') { const wait = request.options?.wait; return { ...reply, status: 'observed', snapshot: wait ? { ...snap(), wait: { for: wait.for, outcome: 'met', elapsedMs: 1 } } : snap() } }
      if (request.kind === 'act') {
        const a = request.action; acts.push({ type: a.type, url: a.url ?? null, ref: a.ref ?? null })
        if (a.type === 'navigate') cur = { url: a.url, documentId: `doc${++docSeq}`, revision: 1 }
        return { ...reply, status: 'acted', receipt: { after: snap(), observation: {}, dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true, inputRoute: 'chrome-load-uri' } } }
      }
      if (request.kind === 'cancel') return { ...reply, status: 'cancelled' }
      return { ...reply, status: 'rejected' }
    } }
  const browser = createCodexBrowserToolProvider({ transport, getOwnerKey: () => OWNER, decision: { mode: () => 'on', configured: () => true, client,
    recipient: () => decisionTopicRecipient(KEY, 1, undefined, client.model), generation: () => 0 } })
  return { timeline, acts, client, browser }
}

// The real-window case of 16:14 (Main): "덕덕고 카드에서 장화 신은 고양이 검색해줘" on a DuckDuckGo Card. The home page has a search box and a read-only GET search
// button; Decisions answers as the real one did (a web task on this card; on the home page the step needs text nobody gave), and, when asked, chooses the span.
const D = 'https://duckduckgo.com'
const DUCK_MSG = '덕덕고 카드에서 장화 신은 고양이 검색해줘'
function duckSite() {
  const timeline = [], acts = []
  let docSeq = 1, cur = { url: `${D}/`, documentId: 'd1', revision: 1, value: '' }
  const submitUrl = () => `${D}/?q=${encodeURIComponent(cur.value)}`
  const elements = () => (new URL(cur.url).searchParams.get('q') === null ? [
    { ref: 'q', role: 'searchbox', tag: 'input', label: '검색', href: '', value: cur.value },
    { ref: 's', role: 'button', tag: 'button', label: '검색', href: '', value: '', nav: { type: 'submit', sensitiveRegion: false, regionLabel: '', form: { method: 'get', fields: ['search', 'submit'], sensitive: false, submitUrl: submitUrl() }, controls: null } },
    { ref: 'p', role: 'link', tag: 'a', label: '개인정보 보호', href: `${D}/privacy`, value: '' },
  ] : [{ ref: 'r1', role: 'link', tag: 'a', label: '장화 신은 고양이 - 나무위키', href: 'https://namu.wiki/w/x', value: '' }])
  const snap = () => ({ cardId: 'card', documentId: cur.documentId, revision: cur.revision, url: cur.url, readyState: 'complete', title: new URL(cur.url).searchParams.get('q') === null ? 'DuckDuckGo' : '장화 신은 고양이 at DuckDuckGo',
    text: new URL(cur.url).searchParams.get('q') === null ? ['DuckDuckGo', '개인정보 보호'] : ['장화 신은 고양이', '장화 신은 고양이 - 나무위키'], viewport: { width: 300, height: 200, devicePixelRatio: 1 }, interactiveElements: elements() })
  const client = createDecisionClient({ recipientForKey: (value, endpoint, model) => decisionTopicRecipient(value, 1, endpoint, model), getApiKey: async () => KEY,
    fetchImpl: async (_e, { body }) => {
      const request = JSON.parse(body), names = request.questions.map(q => q.name), evidence = request.input.map(item => item.content).join('\n')
      timeline.push(`decide:${names[0]}`)
      const answers = []
      if (names.includes('browser_entry')) for (const q of request.questions) answers.push({ name: q.name, type: 'predicate', probability: q.name === 'browser_entry_answer' ? 0.02 : 0.95 })
      else if (names.includes('field_text')) { const q = request.questions[0]; answers.push(choice('field_text', q.choices.some(c => c.value === '장화 신은 고양이') ? '장화 신은 고양이' : q.choices.at(-1).value, 0.95)) }
      else if (names.includes('next_step')) {
        const q = request.questions.find(item => item.name === 'next_step'), onHome = /URL: https:\/\/duckduckgo\.com\/\n/.test(`${evidence}\n`), typed = /filled \[F1\]/.test(evidence)
        answers.push(choice('next_step', !onHome ? 'goal_met' : typed ? q.choices.find(c => c.value.startsWith('[B')).value : 'needs_free_text', 0.95), ...pageStateWire('content'), { name: 'goal_met', type: 'predicate', probability: onHome ? 0.02 : 0.95 })
      } else for (const q of request.questions) answers.push(q.type === 'choice' ? choice(q.name, q.choices[0].value, 0.95) : { name: q.name, type: 'predicate', probability: 0.02 })
      return { ok: true, text: async () => JSON.stringify({ answers }) }
    } })
  const transport = { runs: new Map(), hasClient: id => id === 'ui',
    bindRun: (id, thread, transportId) => { if (transport.runs.has(id)) throw new Error('already bound'); transport.runs.set(id, { clientThreadId: thread, transportId, ownerKey: OWNER }) },
    unbindRun: id => transport.runs.delete(id),
    async sendToUi(request) {
      timeline.push(`ui:${request.kind}`)
      const reply = { requestId: request.requestId }
      if (request.kind === 'bind') return { ...reply, status: 'bound', binding: { cardId: 'card', cardEpoch: 'epoch', profileId: 'fixture', accountId: '', userContextId: 0, url: cur.url, engineAccountKey: OWNER, authorityEpoch: 1 } }
      if (request.kind === 'observe') { const wait = request.options?.wait; return { ...reply, status: 'observed', snapshot: wait ? { ...snap(), wait: { for: wait.for, outcome: 'met', elapsedMs: 1 } } : snap() } }
      if (request.kind === 'act') {
        const a = request.action; acts.push({ type: a.type, ref: a.ref ?? null })
        if (a.type === 'fill') cur = { ...cur, value: a.text, revision: cur.revision + 1 }
        if (a.type === 'navigate') cur = { url: a.url, documentId: `d${++docSeq}`, revision: 1, value: '' }
        return { ...reply, status: 'acted', receipt: { after: snap(), observation: {}, dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true, inputRoute: a.type === 'fill' ? 'dom-value-setter' : 'chrome-load-uri' } } }
      }
      if (request.kind === 'cancel') return { ...reply, status: 'cancelled' }
      return { ...reply, status: 'rejected' }
    } }
  const browser = createCodexBrowserToolProvider({ transport, getOwnerKey: () => OWNER, decision: { mode: () => 'on', configured: () => true, client,
    recipient: () => decisionTopicRecipient(KEY, 1, undefined, client.model), generation: () => 0 } })
  return { timeline, acts, client, browser, get cur() { return cur }, uri: `${D}/` }
}

const source = (n, threadId, uri = `${O}/invoices`) => [{ id: 'selected-source', kind: 'browser', selectedByUser: true, browserToolPermission: 'interact',
  sourceRef: { viewId: 'card', profileId: 'fixture', accountId: '', uri }, browserToolIdentity: { cardEpoch: 'epoch', userContextId: 0, engineAccountKey: OWNER, authorityEpoch: 1 },
  browserToolSelection: { token: `token-${n}`, threadId } }]

/** The bridge's Claude browser wiring in miniature (harness on, page tools on), with the direct entry configured by the bridge's own wiring from the flag value. */
function claudeWorld(t, { flag = 'alternate', startDelayMs = 0, site = 'portal', hold = false, taskTool = false } = {}) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-l5a1-claude-')); t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const dataDir = path.join(base, 'data'); fs.mkdirSync(dataDir)
  const p = site === 'duck' ? duckSite() : portal(), events = [], transports = [], earlyWrites = [], published = []
  let chat = null
  const wiring = createOwnToolsWiring({ env: { EGDESK_OWN_TOOLS: 'on', EGDESK_CLAUDE_HARNESS: 'on', PATH: '/usr/bin:/bin', HOME: '/home/synthetic' }, dataDir,
    spawn: () => { throw new Error('no command runs here') }, getChat: () => chat, home: '/home/synthetic', gitStatus: async () => '' })
  // taskTool: L8's browser task tool beside the page tools, wired as the bridge wires it (egdesk-page-tools-wiring.mjs): the runtime's message, step and store hooks
  let page = null
  const tool = taskTool ? createBrowserTaskTool({ browser: p.browser, messageOf: run => chat?.browserTaskMessage?.(run) ?? null,
    onStep: (run, event) => page?.runtime?.browserTaskStep?.(run, event, { taskId: event.taskId, cardId: event.cardId }), storeOf: () => page?.runtime?.browserTasks?.() ?? null }) : null
  page = createPageToolsProvider({ mode: () => 'on', browser: { dispatch: (run, event) => p.browser.dispatch(run, event) }, ledger: wiring.ledger, ...(tool ? { taskTool: tool } : {}) })
  const claude = createClaudeEngineAdapter({
    snapshot: () => ({ installed: true, version: '2.1.328', versionStatus: 'untested', auth: { status: 'signedIn', method: 'apiKey', account: 'synthetic', label: 'Claude API' } }),
    env: {}, defaultCwd: base, resolveExecutable: () => '/fake/claude',
    createTransport: options => {
      p.timeline.push('claude:process')
      // startDelayMs: the CLI's own start time; a message written before start() is done is recorded (it must never happen)
      const transport = { options, sent: [], replies: [], inited: false, closed: false, started: false,
        async start() { if (startDelayMs) await new Promise(resolve => setTimeout(resolve, startDelayMs)); this.started = true; p.timeline.push('claude:started') },
        info: () => ({ init: { billsApiKey: true } }), async interrupt() {},
        respondControl(id, answer) { this.replies.push({ id, ...JSON.parse(JSON.stringify(answer)) }); return true },
        async close() { if (!this.closed) { this.closed = true; options.onExit?.() } },
        sendUserMessage(content) {
          if (!this.started) earlyWrites.push(this.sent.length)
          this.sent.push(JSON.parse(JSON.stringify(content))); const sid = options.sessionId || options.resume; p.timeline.push('claude:turn')
          setImmediate(() => {
            if (!this.inited) { this.inited = true; options.onMessage({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-test', cwd: options.cwd, claude_code_version: '2.1.328', apiKeySource: 'ANTHROPIC_API_KEY',
              ...(options.bounded ? { permissionMode: 'dontAsk', tools: [], mcp_servers: [{ name: 'egdesk', status: 'connected' }], capabilities: [] } : {}) }) }
            const finish = () => {
              options.onMessage({ session_id: sid, type: 'assistant', parent_tool_use_id: null, message: { id: `m-${this.sent.length}`, role: 'assistant', content: [{ type: 'text', text: '네' }], usage: { input_tokens: 3, output_tokens: 2 } } })
              options.onMessage({ session_id: sid, type: 'result', subtype: 'success', is_error: false })
            }
            if (hold) this.finish = finish; else finish()
          })
        } }
      transports.push(transport); return transport
    } })
  const codex = createCodexEngineAdapter({ request: async method => { throw new Error(`the Codex engine is not used here: ${method}`) }, respond: () => false })
  const store = openChatStore({ dataDir: path.join(base, 'chat'), ownerScope: 'l5a1-claude' }); t.after(() => store.close())
  const browserEntry = createBrowserEntryConfig({ flag: () => flag, getAdapter: () => null, wiki: () => null })
  chat = new CodexChatRuntime({ engines: [codex, claude], store, requireStore: true, getOwnerKey: () => OWNER, toolProviders: [p.browser, page, ...wiring.toolProviders], ownTools: wiring.ownTools,
    verifyFile: async () => null, emit: event => events.push(event), emitLegacy: () => {},
    decisionContext: { mode: () => 'on', configured: () => true, client: p.client, settingsGeneration: () => 0, budgetMs: 800, collect: async () => [], browserEntry,
      browserSteps: { publish: step => { published.push(step); return true } } } }) // lane L1's channel, as the bridge gives it
  const unsubscribe = claude.subscribe({ notification: (_, m) => chat.handleNotification(m), serverRequest: (_, m) => chat.handleServerRequest(m), connection: (id, s) => chat.setConnection(id, s.ready, s) })
  claude.syncStatus(); chat.setConnection('claude', true, {})
  const drain = async () => { await chat.queue; await tick(); await chat.queue }
  t.after(async () => { unsubscribe(); await claude.dispose(); await drain() })
  let n = 0
  const send = (message, extra = {}) => { n++; return chat.send({ message, engineId: 'claude', clientThreadId: 'ui-claude', requestId: `req-${n}`, browserTransportId: 'ui',
    executionPolicy: { mode: 'browserBounded' }, selectedSources: source(n, 'ui-claude', p.uri), ...extra }) }
  const runOf = sent => chat.runs.get(`${sent.conversationId}/${sent.runId}`)
  const settled = async sent => { await until(() => ['completed', 'failed', 'interrupted'].includes(runOf(sent)?.status)); await drain(); return runOf(sent) }
  return { ...p, chat, claude, transports, events, send, settled, runOf, drain, page, earlyWrites, published, get cur() { return p.cur } }
}

const noteOf = content => {
  const block = content.find(part => part.type === 'text' && part.text.startsWith('[EG-Desk context: egdesk_browser_task]'))
  return block ? JSON.parse(block.text.slice(block.text.indexOf('\n') + 1)) : null
}

// ---- the pure module ----
test('the rule: the same words for both engines; it names the browser task tool only when the turn offers it; it rides beside the note, which stays as it is', () => {
  const plain = browserTaskRule(), tool = browserTaskRule({ toolOffered: true })
  assert.ok(!plain.includes(BROWSER_TASK_TOOL_NAME)); assert.ok(tool.includes(BROWSER_TASK_TOOL_NAME))
  for (const text of [plain, tool]) for (const word of ['done', 'needs_value', 'needs_guidance', 'need_context', 'human_step', 'cannot_proceed', 'one message', 'one short question']) assert.ok(text.includes(word), word)
  assert.doesNotMatch(plain + tool, /https?:|제출/, 'no address and no submit word (the C9 note checks)')
  const note = JSON.stringify({ egdesk_browser_task: { id: 'bt_1', status: 'done', stepsDone: 2, actions: { fill: 0 }, next: 'report_to_user' } })
  const value = JSON.parse(withBrowserTaskRule(note, { toolOffered: true }))
  assert.deepEqual(value.egdesk_browser_task, JSON.parse(note).egdesk_browser_task, 'the note is untouched'); assert.equal(value.rule, tool)
  for (const other of ['not json', '[1]', '{"x":1}', null, 3]) assert.equal(withBrowserTaskRule(other), other, 'anything else is returned as it is')
  assert.deepEqual(noteWords(note), { id: 'bt_1', status: 'done', code: null }); assert.equal(noteWords('x'), null)
})

test('a step for the screen (lane L1\'s shape from L8\'s step contract): the screen\'s words, the hand-over with its reason, only the listed fields; no typed value, address or page text', () => {
  const ids = { clientThreadId: 'ui-claude' }
  const hostile = { taskId: 'bt_9', cardId: 'card', seq: 3, op: 'fill', target: '  상품   검색  ', valueName: '검색어', ok: true, ms: 412, by: 'decision', value: '우산', text: 'secret page line', url: 'https://shop.example.test/q?x=1' }
  assert.deepEqual(browserStepFor(hostile, ids), { clientThreadId: 'ui-claude', taskId: 'bt_9', seq: 3, op: 'fill', cardId: 'card', target: '상품 검색', valueName: '검색어', ok: true, ms: 412, by: 'decision' })
  assert.doesNotMatch(JSON.stringify(browserStepFor(hostile, ids)), /우산|secret|https?:/)
  const ops = ['open', 'submit', 'press', 'fill', 'scroll'].map(op => browserStepFor({ taskId: 'bt_1', seq: 1, op }, ids).op)
  assert.deepEqual(ops, ['navigate', 'submit', 'click', 'fill', 'scroll'], 'L8 press is a button: the screen\'s click')
  const end = (status, code) => { const step = browserStepFor({ taskId: 'bt_1', seq: 9, op: 'end', status, ...(code ? { code } : {}) }, ids); return [step.op, step.status ?? null, step.reason ?? null] }
  assert.deepEqual(end('done'), ['done', 'done', null])
  assert.deepEqual(end('need_context', 'detail_needed'), ['handoff', 'needs_value', 'needs_value'])
  assert.deepEqual(end('needs_value'), ['handoff', 'needs_value', 'needs_value'])
  assert.deepEqual(end('needs_guidance', 'uncertain'), ['handoff', 'low_confidence', 'low_confidence'])
  assert.deepEqual(end('need_context', 'choice_needed'), ['handoff', 'needs_user', 'needs_user'])
  assert.deepEqual(end('human_step'), ['handoff', 'human_step', 'human_step'])
  assert.deepEqual(end('cannot', 'blocked'), ['blocked', 'cannot', null])
  assert.equal(browserStepFor({ taskId: 'bt_1', seq: 1, op: 'wait' }, ids), null, 'a wait is no line'); assert.equal(browserStepFor({ seq: 1, op: 'fill' }, ids), null, 'no task')
  assert.equal(browserStepFor({ taskId: 'bt_1', op: 'fill' }, ids), null, 'no order'); assert.equal(browserStepFor({ taskId: 'bt_1', seq: 1, op: 'fill' }, {}), null, 'no conversation')
  assert.equal(browserStepFor({ taskId: 'bt_1', seq: 1, op: 'fill', by: 'model' }, ids).by, 'model')
})

// ---- Claude: the entry first, the same context, one answer ----
test('a Claude room, "on": the Decision model goes first (one bind, the entry decision, one step), the closed note reaches Claude\'s turn, Claude\'s run holds the same binding, and the pause is one hand-over step on L1\'s channel', { timeout: 20000 }, async t => {
  const w = claudeWorld(t, { flag: 'on' })
  const sent = await w.send(MSG); assert.equal(sent.accepted, true)
  await w.settled(sent)
  assert.deepEqual(w.timeline.filter(x => /^(ui:bind|decide:|claude:)/.test(x)), ['ui:bind', 'decide:browser_entry', 'decide:next_step', 'claude:process', 'claude:started', 'claude:turn'])
  const note = noteOf(w.transports[0].sent[0])
  assert.deepEqual([note.egdesk_browser_task.status, note.egdesk_browser_task.code, note.egdesk_browser_task.next], ['need_context', 'choice_needed', 'ask_user_in_chat'])
  assert.equal(note.rule, undefined, '"on": the note as it always was')
  assert.equal(w.transports[0].sent[0].at(-1).text, MSG, 'the person\'s own words are the turn\'s message')
  assert.equal(w.runOf(sent).adoptedFrom, 'pre-req-1', 'Claude\'s run holds the same Card binding')
  assert.deepEqual(w.published.map(step => [step.clientThreadId, step.taskId, step.op, step.status, step.by]), [['ui-claude', note.egdesk_browser_task.id, 'handoff', 'needs_user', 'decision']])
})

test('a Claude room, alternating: the rule rides beside the note; the person\'s answer resumes the same task, its steps go to L1\'s channel before Claude\'s turn (no value, no address), and Claude answers once per message', { timeout: 30000 }, async t => {
  const w = claudeWorld(t)
  const first = await w.send(MSG); await w.settled(first)
  const note1 = noteOf(w.transports[0].sent[0])
  assert.equal(note1.rule, browserTaskRule({ toolOffered: false }), 'no browser task tool in this world: the rule does not name it')
  assert.ok(w.chat.browserTasks().get(note1.egdesk_browser_task.id), 'the task lives in the one store a tool can reach')
  const second = await w.send('두 번째 사업자로', { conversationId: first.conversationId }); await w.settled(second)
  assert.deepEqual(w.acts.map(a => [a.type, a.url]), [['navigate', `${O}/biz/2`], ['navigate', `${O}/download/2.pdf`]])
  const note2 = noteOf(w.transports.at(-1).sent.at(-1))
  assert.deepEqual([note2.egdesk_browser_task.status, note2.egdesk_browser_task.id, note2.egdesk_browser_task.next], ['done', note1.egdesk_browser_task.id, 'report_to_user'])
  assert.equal(w.transports.reduce((sum, tr) => sum + tr.sent.length, 0), 2, 'one Claude turn per message: the loop did the steps, Claude only spoke')
  const steps = w.published.filter(step => step.taskId === note1.egdesk_browser_task.id)
  assert.deepEqual(steps.map(step => [step.op, step.status ?? null]), [['handoff', 'needs_user'], ['navigate', null], ['navigate', null], ['done', 'done']])
  assert.deepEqual(steps.map(step => step.seq), [...steps.map(step => step.seq)].sort((a, b) => a - b), 'in order')
  assert.ok(steps.every(step => step.clientThreadId === 'ui-claude')); assert.doesNotMatch(JSON.stringify(steps), /https?:|example\.test|\/biz|\.pdf/, 'no address (the control\'s own label is the line\'s target)')
  assert.deepEqual(w.events.filter(e => /browserTask|browser\.task\.step/.test(e.event ?? e.type ?? '')), [], 'nothing of it is a stored chat event')
})

test('browserTaskMessage(run): the person\'s message of a browser turn, by its request id and by its pre-turn run, for the browser task tool\'s value candidates; nothing else', { timeout: 20000 }, async t => {
  const w = claudeWorld(t, { flag: 'on' })
  const sent = await w.send(MSG); await w.settled(sent)
  assert.equal(w.chat.browserTaskMessage(w.runOf(sent)), MSG)
  assert.equal(w.chat.browserTaskMessage({ runId: 'pre-req-1' }), MSG)
  assert.equal(w.chat.browserTaskMessage({ requestId: 'unknown' }), null); assert.equal(w.chat.browserTaskMessage(null), null)
})

// ---- the real-window case of 16:14 (Main): a DuckDuckGo search ----
test('DuckDuckGo (16:14 real window), "on": the entry runs, its first step needs the search text nobody gave, so it stops there (detail_needed): the Card does not move and Claude gets the hand-over', { timeout: 20000 }, async t => {
  const w = claudeWorld(t, { flag: 'on', site: 'duck' })
  const sent = await w.send(DUCK_MSG); await w.settled(sent)
  assert.deepEqual(w.timeline.filter(x => /^decide:/.test(x)), ['decide:browser_entry', 'decide:next_step'], 'the entry\'s calls and one step: what the real window\'s call log showed')
  assert.deepEqual(w.acts, [], 'nothing typed, nothing searched'); assert.equal(w.cur.url, `${D}/`)
  const note = noteOf(w.transports[0].sent[0])
  assert.deepEqual([note.egdesk_browser_task.status, note.egdesk_browser_task.code], ['need_context', 'detail_needed'])
  assert.deepEqual(w.published.map(step => [step.op, step.status]), [['handoff', 'needs_value']])
})

test('DuckDuckGo, alternating: the Decision model fills the search box with the span of the person\'s message it chose and runs the GET search before Claude\'s turn; Claude gets "done" and speaks once', { timeout: 20000 }, async t => {
  const w = claudeWorld(t, { site: 'duck' })
  const sent = await w.send(DUCK_MSG); await w.settled(sent)
  assert.ok(w.timeline.includes('decide:field_text'), 'the span was chosen'); assert.equal(new URL(w.cur.url).searchParams.get('q'), '장화 신은 고양이')
  assert.deepEqual(w.acts.map(a => a.type), ['fill', 'navigate'])
  assert.ok(w.timeline.indexOf('claude:turn') > w.timeline.lastIndexOf('ui:act'), 'the Card moved before Claude\'s turn')
  const note = noteOf(w.transports[0].sent[0])
  assert.equal(note.egdesk_browser_task.status, 'done'); assert.ok(note.rule)
  assert.deepEqual(w.published.map(step => [step.op, step.target ?? null, step.status ?? null]), [['fill', '검색', null], ['submit', '검색', null], ['done', null, 'done']])
  assert.doesNotMatch(JSON.stringify(w.published), /장화|https?:/, 'the typed text and the address never reach the channel')
  assert.equal(w.transports[0].sent.length, 1, 'one Claude turn')
})

test('the browser task tool (L8) in a Claude run continues the task the entry stopped (its key is the person\'s chat, the shared store), with the person\'s message as the value candidates; the rule names it; its steps go to the same channel', { timeout: 20000 }, async t => {
  const w = claudeWorld(t, { flag: 'on', site: 'duck', hold: true, taskTool: true })
  const sent = await w.send(DUCK_MSG); await w.drain?.()
  await until(() => w.transports[0]?.sent.length === 1)
  const note = noteOf(w.transports[0].sent[0])
  assert.equal(note.egdesk_browser_task.code, 'detail_needed')
  const out = await callTool(w, BROWSER_TASK_TOOL_NAME, {})
  assert.equal(out.status, 'done', JSON.stringify(out)); assert.equal(out.taskId, note.egdesk_browser_task.id, 'the same task')
  assert.equal(new URL(w.cur.url).searchParams.get('q'), '장화 신은 고양이', 'its span came from the person\'s message (browserTaskMessage)')
  assert.ok(w.published.some(step => step.op === 'fill' && step.clientThreadId === 'ui-claude'))
  w.transports[0].finish(); await w.settled(sent)
  // alternating with the tool on: the entry finishes by itself (fieldText) and the rule names the tool for anything that would still need it
  const alt = claudeWorld(t, { site: 'duck', taskTool: true })
  const s2 = await alt.send(DUCK_MSG); await alt.settled(s2)
  assert.ok(alt.chat.collectToolSpecs('browserBounded', { browserInteraction: true, engineId: 'claude' }).specs.some(s => s.name === BROWSER_TASK_TOOL_NAME), 'offered with an interact Card')
  assert.equal(noteOf(alt.transports[0].sent[0]).rule, browserTaskRule({ toolOffered: true }))
})

// ---- Codex: the same words ----
function codexWorld({ flag = 'alternate' } = {}) {
  const p = portal(), calls = [], events = []
  let turnCount = 0, threadCount = 0
  const chat = new CodexChatRuntime({
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'experimentalFeature/list') return { data: ['browser_use', 'browser_use_external', 'computer_use'].map(name => ({ name, enabled: false, stage: 'stable' })), nextCursor: null }
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      if (method === 'config/read') return { config: { developer_instructions: 'Ordinary instructions' }, layers: [] }
      if (method === 'thread/start') return { thread: { id: `thread-${++threadCount}` }, cwd: '/work', model: 'configured-model', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd: '/work', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      if (method === 'turn/start') return { turn: { id: `turn-${++turnCount}`, status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected method: ${method}`)
    },
    respond: () => {}, emit: event => events.push(event), emitLegacy: () => {}, toolProviders: [p.browser], getOwnerKey: () => OWNER, verifyFile: async () => null,
    decisionContext: { mode: () => 'on', configured: () => true, client: p.client, calibrationLog: { record: () => ({}) }, browserEntry: createBrowserEntryConfig({ flag: () => flag, getAdapter: () => null, wiki: () => null }) },
  })
  chat.setConnection(true)
  const send = message => chat.send({ message, requestId: 'req-1', clientThreadId: 'selected-chat', executionPolicy: { mode: 'browserBounded' }, selectedSources: source(1, 'selected-chat'), browserTransportId: 'ui' })
  return { chat, calls, events, send }
}

test('a Codex room, alternating: the same rule beside the same note in its additionalContext, and the thread\'s own start is exactly what plain "on" sends', { timeout: 20000 }, async () => {
  const alt = codexWorld(), on = codexWorld({ flag: 'on' })
  await alt.send(MSG); await on.send(MSG)
  const ctx = w => w.calls.find(c => c.method === 'turn/start').params.additionalContext.egdesk_browser_task
  const value = JSON.parse(ctx(alt).value)
  assert.equal(value.rule, browserTaskRule({ toolOffered: false }), 'the same words as Claude gets')
  const withoutId = ({ id, ...rest }) => { assert.match(id, /^bt_[0-9a-f]+$/); return rest }
  assert.deepEqual(withoutId(value.egdesk_browser_task), withoutId(JSON.parse(ctx(on).value).egdesk_browser_task), 'the note is the one "on" sends (its task id is random)')
  assert.equal(JSON.stringify(alt.calls.find(c => c.method === 'thread/start').params), JSON.stringify(on.calls.find(c => c.method === 'thread/start').params), 'no thread instruction changes')
  const { additionalContext: a, ...restAlt } = alt.calls.find(c => c.method === 'turn/start').params, { additionalContext: b, ...restOn } = on.calls.find(c => c.method === 'turn/start').params
  assert.deepEqual(restAlt, restOn); assert.deepEqual(Object.keys(a), Object.keys(b))
})

test('the wiring: "alternate" is the entry "on" plus alternate(); "on" and anything else keep their meaning', () => {
  const cfg = value => createBrowserEntryConfig({ flag: () => value, getAdapter: () => null, wiki: () => null })
  assert.deepEqual([cfg('alternate').mode(), cfg('alternate').alternate()], ['on', true])
  assert.deepEqual([cfg('on').mode(), cfg('on').alternate()], ['on', false])
  assert.deepEqual([cfg('advisory').mode(), cfg('advisory').alternate()], ['advisory', false])
  for (const value of [undefined, '', 'yes', 'ALTERNATE']) assert.deepEqual([cfg(value).mode(), cfg(value).alternate()], ['off', false])
  assert.deepEqual([createBrowserEntryConfig({ flag: () => { throw new Error('x') } }).mode(), createBrowserEntryConfig({ flag: () => { throw new Error('x') } }).alternate()], ['off', false])
})

// ---- speed: the conversation model's process starts while the Decision model works ----
test('alternating, a new Claude conversation\'s process starts while the entry runs (not after it), one process, and its first message is written only after the CLI started', { timeout: 20000 }, async t => {
  const w = claudeWorld(t, { startDelayMs: 40 })
  const sent = await w.send(MSG); await w.settled(sent)
  const at = name => w.timeline.indexOf(name)
  assert.ok(at('claude:process') >= 0 && at('claude:process') < at('decide:next_step'), `the process started during the entry: ${w.timeline.join(' ')}`)
  assert.ok(at('claude:turn') > at('decide:next_step'), 'the turn itself still comes after the entry')
  assert.equal(w.transports.length, 1, 'one process: the turn used the prepared one'); assert.deepEqual(w.earlyWrites, [], 'nothing was written before the start was done')
  assert.equal(noteOf(w.transports[0].sent[0]).egdesk_browser_task.status, 'need_context')
  // plain "on": as before, the process starts with the turn
  const on = claudeWorld(t, { flag: 'on', startDelayMs: 40 })
  const s2 = await on.send(MSG); await on.settled(s2)
  assert.ok(on.timeline.indexOf('claude:process') > on.timeline.indexOf('decide:next_step'))
  assert.deepEqual(on.earlyWrites, [])
})

test('prepareTurn is never in the way: an unknown or running conversation is skipped, a live process is left as it is, a folder change is the turn\'s own; a turn during a start waits for it', { timeout: 20000 }, async t => {
  const w = claudeWorld(t, { startDelayMs: 30 })
  assert.deepEqual(await w.claude.prepareTurn({ threadId: '00000000-0000-4000-8000-000000000000' }), { status: 'skipped' })
  const started = await w.claude.startThread({ cwd: w.chat.ownNeutralFolder?.() ?? undefined })
  const threadId = started.thread.id
  assert.deepEqual(await w.claude.prepareTurn({ threadId, cwd: '/somewhere/else' }), { status: 'skipped' }, 'a folder change is never prepared')
  assert.deepEqual(await w.claude.prepareTurn({ threadId, effort: 'not-an-effort' }), { status: 'skipped' })
  const preparing = w.claude.prepareTurn({ threadId })
  const turn = w.claude.startTurn({ threadId, input: [{ type: 'text', text: 'x', text_elements: [] }] })
  assert.deepEqual(await preparing, { status: 'started' }); await turn
  assert.equal(w.transports.length, 1); assert.deepEqual(w.earlyWrites, [], 'the turn waited for the start in flight')
  assert.deepEqual(await w.claude.prepareTurn({ threadId }), { status: 'skipped' }, 'a turn is running')
})

