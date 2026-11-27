// Command gate wiring before the engine approval card (advisory first). Real CodexChatRuntime approval path, reached the real way by
// both engines: a Codex item/commandExecution/requestApproval server request, and a Claude can_use_tool control request through the
// real Claude adapter (routePermissionRequest). Real gate, decision client and calibration log; the engine transports, git facts and
// the "model" are fakes. No shell, no network, synthetic commands only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs'
import { createDecisionBudget, createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'

const KEY = 'egd-synthetic-not-a-key-0007'
const MATRIX = {}
const ALL = ['accept', 'acceptForSession', 'decline', 'cancel']
const CLAUDE_CWD = '/work/claude-synthetic'
const tick = () => new Promise(resolve => setImmediate(resolve))
const clone = value => JSON.parse(JSON.stringify(value))
const tracked = target => /\/src$/.test(target) ? { exists: true, kind: 'dir', trackedFiles: 41, ignored: false } : /\/node_modules$/.test(target) ? { exists: true, kind: 'dir', trackedFiles: 0, ignored: true } : null

function riskAnswer(question, data) {
  const command = String(data?.command ?? '')
  // content predicates (the default method): 'yes' means risky. A push sends something out; removing a named container loses its data.
  if (question.type === 'predicate') {
    const yes = question.name === 'risk_outside' ? /\bpush\b/.test(command) : question.name === 'risk_unrestorable' ? /docker rm/.test(command) : false
    return { name: question.name, type: 'predicate', probability: yes ? 0.95 : 0.05 }
  }
  const score = /node_modules|dist\b/.test(command) ? 0.4 : /reset --hard/.test(command) ? 3.7 : /kill/.test(command) ? 0.8 : 2
  return { name: question.name, type: 'score', score, confidence: 0.93, probabilities: question.levels.map((_, i) => ({ value: String(i), probability: i === Math.round(score) ? 0.9 : 0.025 })) }
}
function decisionSetup(t, { flag = null, decisionMode = 'on', configured = true, hang = false, budget = null, dirty = false, deadlineMs, method } = {}) {
  const root = createPrivateQaTempDirectory('egdesk-terminal-gate-wiring-test-')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const requests = [], inspected = []
  const client = createDecisionClient({ getApiKey: () => KEY, budget, recipientForKey: () => 'a'.repeat(64),
    fetchImpl: async (url, init) => {
      requests.push(init.body)
      if (hang) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      const body = JSON.parse(init.body)
      return Response.json({ answers: body.questions.map(q => riskAnswer(q, body.input.find(m => Array.isArray(m.content)).content[0].data)), usage: { input_tokens: 30 } })
    } })
  const calibrationLog = openCalibrationLog({ dataDir: root, log: () => {} })
  const state = { flag, decisionMode, configured }
  const decisionContext = { mode: () => state.decisionMode, configured: () => state.configured, client, calibrationLog,
    ...(flag ? { terminalGate: { mode: () => state.flag, home: '/home/synthetic', ...(method ? { method } : {}), ...(deadlineMs ? { deadlineMs } : {}),
      inspect: async ({ cwd, paths }) => { inspected.push({ cwd, paths }); return { targets: Object.fromEntries(paths.filter(tracked).map(p => [p, tracked(p)])), git: { dirty } } } } } : {}) }
  return { decisionContext, requests, inspected, calibrationLog, state,
    gateEntries: () => calibrationLog.entries().filter(e => e.feature === 'terminal_gate'), carrying: needle => requests.filter(body => body.includes(needle)).length }
}

// ---- Codex: the server request the app-server sends ----
function codexHarness(t, options = {}) {
  const d = decisionSetup(t, options)
  const calls = [], events = [], replies = []
  let turnCount = 0, threadCount = 0
  const chat = new CodexChatRuntime({
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'thread/start') return { thread: { id: `thread-${++threadCount}` }, cwd: '/work', model: 'configured-model' }
      if (method === 'turn/start') return { turn: { id: `turn-${++turnCount}`, status: 'inProgress', items: [] } }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected method: ${method}`)
    },
    respond: (...args) => replies.push(args), emit: event => events.push(event), emitLegacy: () => {}, verifyFile: async () => null, decisionContext: d.decisionContext,
  })
  chat.setConnection(true)
  const ask = async (run, id, command, { cwd = '/work', reason } = {}) => {
    await chat.handleServerRequest({ id, method: 'item/commandExecution/requestApproval',
      params: { threadId: run.conversationId, turnId: run.runId, itemId: `cmd-${id}`, command, cwd, ...(reason ? { reason } : {}), availableDecisions: ALL } })
    await chat.commandGateIdle() // records are content-free, so the test keeps them in command order by letting each finish
    return chat.snapshot().runs[0].pendingApprovals.at(-1)
  }
  return { ...d, chat, calls, events, replies, ask }
}
// ---- Claude: a can_use_tool control request through the real adapter and routePermissionRequest ----
function claudeHarness(t, options = {}) {
  const d = decisionSetup(t, options)
  const transports = [], events = [], codexReplies = []
  const claude = createClaudeEngineAdapter({
    snapshot: () => ({ installed: true, version: '2.1.300', versionStatus: 'untested', auth: { status: 'signedIn', method: 'claudeai', account: 'owner@example.test', label: 'Claude Max' } }),
    env: {}, defaultCwd: CLAUDE_CWD, residentLimit: 2, resolveExecutable: () => '/fake/claude', // never started: the transport below is a fake
    setTimer: (fn, ms) => ({ fn, ms }), clearTimer: () => {},
    createTransport: options => {
      const transport = { options, sent: [], replies: [], closed: false, async start() {}, sendUserMessage(content) { this.sent.push(clone(content)) },
        respondControl(id, answer) { this.replies.push({ id, ...clone(answer) }); return true }, info: () => ({ init: { billsApiKey: false } }), async interrupt() {},
        async close() { if (!this.closed) { this.closed = true; options.onExit() } }, control(requestId, request) { return options.controlHandlers[request.subtype](request, { requestId }) } }
      transports.push(transport)
      return transport
    },
  })
  const codex = createCodexEngineAdapter({ request: async () => { throw new Error('Codex is not used here') }, respond: (...args) => { codexReplies.push(args); return true } })
  const chat = new CodexChatRuntime({ engines: [codex, claude], emit: event => events.push(event), verifyFile: async () => null, decisionContext: d.decisionContext })
  const unsubscribe = claude.subscribe({ notification: (_, message) => chat.handleNotification(message), serverRequest: (_, message) => chat.handleServerRequest(message),
    connection: (id, state) => chat.setConnection(id, state.ready, state) })
  claude.syncStatus()
  const drain = async () => { await chat.queue; await tick(); await chat.queue }
  t.after(async () => { unsubscribe(); await claude.dispose(); await drain() })
  let n = 0
  const ask = async (run, command) => {
    const id = `permission-${++n}`
    transports[0].control(id, { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: `toolu-${n}`, input: { command },
      permission_suggestions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'synthetic' }], destination: 'userSettings' }] })
    await drain(); await chat.commandGateIdle()
    return chat.runs.get(`${run.conversationId}/${run.runId}`).pendingApprovals.at(-1)
  }
  const answers = () => transports[0].replies.map(r => { const res = r.write.response.response; return `${res.behavior}${res.updatedPermissions ? '+session' : ''}` })
  return { ...d, chat, transports, events, codexReplies, ask, answers, send: () => chat.send({ message: 'Work', engineId: 'claude', clientThreadId: 'ui-claude', requestId: 'req-1' }) }
}

// Everything the engine and the screen can observe, with random ids and clock values removed.
const observable = h => JSON.stringify({ replies: h.replies, calls: h.calls.map(c => c.method), events: h.events, runs: h.chat.snapshot().runs },
  (key, value) => (['ts', 'at', 'seq', 'startedAt', 'updatedAt', 'createdAt', 'eventId', 'cursor'].includes(key) ? undefined : value))
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID').replace(/\b1[67]\d{11}\b/g, 'TIME')
const COMMANDS = ['rm -rf src/', 'rm -rf node_modules', 'git reset --hard HEAD~5', 'npm test', 'rm -rf "$TARGET"/*', 'git push origin main']
async function journey(h) {
  const run = await h.chat.send({ message: 'Clean up and run the tests' })
  const pending = []
  for (const [i, command] of COMMANDS.entries()) pending.push(await h.ask(run, i + 1, command, { reason: 'zeta-synthetic-intent' }))
  await h.chat.replyApproval({ ...run, approvalId: pending[0].approvalId, decision: 'decline' })
  await h.chat.replyApproval({ ...run, approvalId: pending[1].approvalId, decision: 'accept' })
  await h.chat.replyApproval({ ...run, approvalId: pending[3].approvalId, decision: 'accept' })
  return { run, pending }
}

test('Codex: flag off and advisory are identical to no gate at all (cards, choices, replies, events); nothing is ever answered for the person', async t => {
  const none = codexHarness(t), off = codexHarness(t, { flag: 'off' }), advisory = codexHarness(t, { flag: 'advisory' })
  const base = await journey(none); await journey(off); await journey(advisory)
  assert.equal(base.pending.length, 6)
  assert.equal(observable(off), observable(none)); assert.equal(observable(advisory), observable(none))
  assert.deepEqual(advisory.replies.map(r => r[1]), [{ decision: 'decline' }, { decision: 'accept' }, { decision: 'accept' }], 'exactly the person\'s three answers')
  assert.deepEqual(advisory.chat.snapshot().runs[0].pendingApprovals.map(p => p.status), ['replySent', 'replySent', 'pending', 'replySent', 'pending', 'pending'])
  assert.equal(none.requests.length, 0); assert.equal(off.requests.length, 0); assert.equal(off.gateEntries().length, 0)
  assert.ok(advisory.requests.length > 0); assert.equal(advisory.gateEntries().length, 6)
  MATRIX.codexIdentical = { cards: 6, observableBytes: observable(none).length, advisoryRequests: advisory.requests.length, advisoryRecords: advisory.gateEntries().length }
})

test('advisory records the rule result, the score and whether approval WOULD have been required, content-free', async t => {
  const h = codexHarness(t, { flag: 'advisory' })
  await journey(h)
  const rows = h.gateEntries().map(e => ({ rule: e.gate.rule, would: e.gate.would, scored: e.gate.scored, reasons: e.gate.reasons ?? [], score: e.gate.score ?? null, method: e.gate.method, engine: e.gate.engine, gitFacts: e.gate.gitFacts, mode: e.mode, attached: e.attached }))
  const by = Object.fromEntries(COMMANDS.map((name, i) => [name, rows[i]]))
  MATRIX.advisory = by
  const row = (fields) => ({ score: null, method: 'predicates', engine: 'codex', mode: 'advisory', attached: false, ...fields })
  assert.deepEqual(by['rm -rf src/'], row({ rule: true, would: true, scored: false, reasons: ['tracked_files'], gitFacts: true }))
  assert.deepEqual(by['rm -rf node_modules'], row({ rule: false, would: false, scored: true, reasons: [], gitFacts: true }))
  assert.deepEqual(by['git reset --hard HEAD~5'], row({ rule: true, would: true, scored: false, reasons: ['discards_history'], gitFacts: false }), 'R5: a rule, not a score')
  assert.deepEqual(by['npm test'], row({ rule: false, would: false, scored: false, reasons: [], gitFacts: false }))
  assert.deepEqual(by['git push origin main'], row({ rule: false, would: true, scored: true, reasons: ['risk_outside'], gitFacts: false }), 'a content predicate adds approval the floor does not')
  assert.deepEqual([by['rm -rf "$TARGET"/*'].rule, by['rm -rf "$TARGET"/*'].would, by['rm -rf "$TARGET"/*'].scored, by['rm -rf "$TARGET"/*'].reasons], [true, true, false, ['unresolved_target']])
  assert.equal(h.requests.length, 2, 'only the two changing commands the rules did not already settle are asked about')
  assert.deepEqual(h.inspected.map(i => i.paths), [['/work/src'], ['/work/node_modules']], 'git facts are asked only for the targets')
  assert.doesNotMatch(JSON.stringify(h.calibrationLog.entries()), /node_modules|src|TARGET|reset|zeta|\/work/, 'the record holds no command, path or intent')
  assert.equal(h.carrying('zeta-synthetic-intent'), 2, 'the stated intent travels only inside the asked requests')
  for (const body of h.requests) assert.deepEqual(JSON.parse(body).questions.map(q => [q.type, q.name]), [['predicate', 'risk_unrestorable'], ['predicate', 'risk_outside'], ['predicate', 'risk_personal_files']])
})

test('no key, Decision off, a used-up budget or a model that never answers: rules only, and the card neither waits nor changes', async t => {
  const usedUp = createDecisionBudget({ monthlyInputTokenCap: 10 }); usedUp.recordEstimate(50)
  for (const [name, options] of [['no key', { configured: false }], ['decision off', { decisionMode: 'off' }], ['budget', { budget: usedUp }]]) {
    const h = codexHarness(t, { flag: 'advisory', ...options })
    const run = await h.chat.send({ message: 'Work' })
    const pending = await h.ask(run, 1, 'git push origin main')
    assert.deepEqual(pending.choices, ['accept', 'decline', 'cancel'], name)
    assert.equal(h.requests.length, 0, name)
    const [entry] = h.gateEntries()
    assert.deepEqual([entry.gate.rule, entry.gate.would, entry.gate.scored], [false, false, false], name)
  }
  const slow = codexHarness(t, { flag: 'advisory', hang: true })
  const run = await slow.chat.send({ message: 'Work' })
  const startedAt = performance.now()
  await slow.chat.handleServerRequest({ id: 1, method: 'item/commandExecution/requestApproval', params: { threadId: run.conversationId, turnId: run.runId, itemId: 'cmd', command: 'git push origin main', cwd: '/work', availableDecisions: ALL } })
  const card = slow.chat.snapshot().runs[0].pendingApprovals[0]
  assert.ok(card && performance.now() - startedAt < 500, 'the card is there at once; it never waits for the gate')
  assert.equal((await slow.chat.replyApproval({ ...run, approvalId: card.approvalId, decision: 'accept' })).status, 'replySent', 'and the person can answer before the model does')
  slow.chat.decisionContext.client = null // let the hanging request end with the test
})

test('an Agent whose tool ceiling forbids terminal commands is declined before any card and before the gate, as today', async t => {
  const h = codexHarness(t, { flag: 'on' })
  const run = await h.chat.send({ message: 'Work' })
  h.chat.runs.get(`${run.conversationId}/${run.runId}`).toolCeiling = { browser: 'none', files: 'read', terminal: 'none', network: 'off', mcp: 'none' }
  await h.ask(run, 9, 'rm -rf node_modules')
  assert.deepEqual(h.replies.at(-1).slice(0, 2), [9, { decision: 'decline' }])
  assert.equal(h.requests.length, 0); assert.equal(h.gateEntries().length, 0)
  assert.equal(h.chat.snapshot().runs[0].pendingApprovals.length, 0)
})

test('Claude: advisory changes nothing on the real can_use_tool path; the session choice and the answers are the same as without the gate', async t => {
  const play = async h => {
    const run = await h.send()
    const cards = []
    for (const command of ['rm -rf src/', 'git push origin main', 'rm -rf node_modules']) cards.push(await h.ask(run, command))
    await h.chat.replyApproval({ ...run, approvalId: cards[0].approvalId, decision: 'acceptForSession' })
    await h.chat.replyApproval({ ...run, approvalId: cards[1].approvalId, decision: 'decline' })
    await h.chat.replyApproval({ ...run, approvalId: cards[2].approvalId, decision: 'accept' })
    return { choices: cards.map(c => c.choices), commands: cards.map(c => [c.command, c.cwd]), answers: h.answers() }
  }
  const none = await play(claudeHarness(t)), advisoryRig = claudeHarness(t, { flag: 'advisory' }), advisory = await play(advisoryRig)
  assert.deepEqual(advisory, none)
  assert.deepEqual(none.choices, [ALL, ALL, ALL]); assert.deepEqual(none.answers, ['allow+session', 'deny', 'allow'])
  assert.deepEqual(none.commands[0], ['rm -rf src/', CLAUDE_CWD])
  assert.deepEqual(advisoryRig.gateEntries().map(e => [e.gate.engine, e.gate.rule, e.gate.would, e.gate.reasons ?? []]), [['claude', true, true, ['tracked_files']], ['claude', false, true, ['risk_outside']], ['claude', false, false, []]])
  MATRIX.claudeAdvisory = { answers: advisory.answers, records: advisoryRig.gateEntries().length }
})

test('flag on (Claude): the only effect is that a high-risk command cannot be approved for the whole session; one-time approval and decline are untouched', async t => {
  const h = claudeHarness(t, { flag: 'on' })
  const run = await h.send()
  // 1) rules that need no lookup settle it at once: the session choice is not offered on that card
  const floor = await h.ask(run, 'rm -rf "$TARGET"/*')
  assert.deepEqual(floor.choices, ['accept', 'decline', 'cancel'])
  // 2) a rule that needs git facts (tracked files): (c13, decision 3) the choice is not shown while the facts come, and stays away when they
  //    require approval, so picking it is impossible rather than refused afterwards
  const trackedCard = await h.ask(run, 'rm -rf src/')
  assert.deepEqual(trackedCard.choices, ['accept', 'decline', 'cancel'])
  await assert.rejects(h.chat.replyApproval({ ...run, approvalId: trackedCard.approvalId, decision: 'acceptForSession' }), e => e.code === 'INVALID_DECISION')
  assert.deepEqual(h.answers(), [], 'a session grant that was never offered answers nothing; the card is still waiting')
  assert.equal((await h.chat.replyApproval({ ...run, approvalId: trackedCard.approvalId, decision: 'accept' })).status, 'replySent')
  // 3) the rule floor (R5) needs no lookup: discarding commits never offers the session choice
  const history = await h.ask(run, 'git reset --hard HEAD~5')
  assert.deepEqual(history.choices, ['accept', 'decline', 'cancel'])
  // 4) a content predicate marks it (something leaves this machine): (c13) the session choice never appears on that card
  const scored = await h.ask(run, 'git push origin main')
  assert.deepEqual(scored.choices, ['accept', 'decline', 'cancel'])
  await assert.rejects(h.chat.replyApproval({ ...run, approvalId: scored.approvalId, decision: 'acceptForSession' }), e => e.code === 'INVALID_DECISION')
  assert.equal((await h.chat.replyApproval({ ...run, approvalId: scored.approvalId, decision: 'decline' })).status, 'replySent')
  // 5) low risk and plain commands: the session choice works as before
  for (const command of ['rm -rf node_modules', 'npm test']) {
    const ok = await h.ask(run, command)
    assert.deepEqual(ok.choices, ALL)
    assert.equal((await h.chat.replyApproval({ ...run, approvalId: ok.approvalId, decision: 'acceptForSession' })).status, 'replySent')
  }
  assert.deepEqual(h.answers(), ['allow', 'deny', 'allow+session', 'allow+session'], 'every grant is the person\'s own click; none was added or made by the gate')
  const rows = h.gateEntries().map(e => [e.mode, e.gate.engine, e.gate.rule, e.gate.would, e.gate.sessionWithheld, e.attached])
  MATRIX.on = { answers: h.answers(), records: rows }
  assert.deepEqual(rows, [['on', 'claude', true, true, true, true], ['on', 'claude', true, true, true, true], ['on', 'claude', true, true, true, true], ['on', 'claude', false, true, true, true],
    ['on', 'claude', false, false, false, false], ['on', 'claude', false, false, false, false]])
})

test('flag on can only add: an unavailable score leaves today\'s behaviour, and the person\'s Decision mode caps the flag', async t => {
  // Decision mode advisory under flag on: the score is only recorded, so the session choice still works; a rule still withholds
  const a = claudeHarness(t, { flag: 'on', decisionMode: 'advisory' })
  const run = await a.send()
  const scored = await a.ask(run, 'git push origin main')
  assert.equal((await a.chat.replyApproval({ ...run, approvalId: scored.approvalId, decision: 'acceptForSession' })).status, 'replySent')
  const ruled = await a.ask(run, 'sudo rm -rf build')
  assert.deepEqual(ruled.choices, ['accept', 'decline', 'cancel'], 'a rule needs no model')
  // the model never answers: a session grant waits for the gate's own deadline at most, then today's behaviour
  const s = claudeHarness(t, { flag: 'on', hang: true, deadlineMs: 80 })
  const run3 = await s.send()
  s.transports[0].control('permission-slow', { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'toolu-slow', input: { command: 'git push origin main' },
    permission_suggestions: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'synthetic' }], destination: 'userSettings' }] })
  await s.chat.queue; await tick(); await s.chat.queue
  const slowCard = s.chat.runs.get(`${run3.conversationId}/${run3.runId}`).pendingApprovals.at(-1)
  const began = performance.now()
  // (c13, decision 3) the card waits for nothing; the session choice comes back on it once the gate gives up (today's behaviour, P2)
  assert.deepEqual(slowCard.choices, ['accept', 'decline', 'cancel'])
  await s.chat.commandGateIdle()
  assert.deepEqual(slowCard.choices, ALL)
  assert.equal((await s.chat.replyApproval({ ...run3, approvalId: slowCard.approvalId, decision: 'acceptForSession' })).status, 'replySent')
  assert.ok(performance.now() - began < 1500, 'bounded by the gate deadline')
  assert.deepEqual(s.answers(), ['allow+session']); assert.equal(s.gateEntries()[0].fallback, 'timeout')
  // no key: rules only, zero requests
  const k = claudeHarness(t, { flag: 'on', configured: false })
  const run2 = await k.send()
  const plain = await k.ask(run2, 'git push origin main')
  assert.equal((await k.chat.replyApproval({ ...run2, approvalId: plain.approvalId, decision: 'acceptForSession' })).status, 'replySent')
  assert.equal(k.requests.length, 0)
})

test('method score (the c5-c10 question) stays selectable for comparison: same wiring, the score is recorded instead of the predicates', async t => {
  const h = codexHarness(t, { flag: 'advisory', method: 'score' })
  const run = await h.chat.send({ message: 'Work' })
  await h.ask(run, 1, 'rm -rf node_modules'); await h.ask(run, 2, 'git reset --hard HEAD~5')
  assert.deepEqual(h.gateEntries().map(e => [e.gate.method, e.gate.rule, e.gate.scored, e.gate.score ?? null, e.gate.reasons ?? []]), [['score', false, true, 0.4, []], ['score', true, false, null, ['discards_history']]],
    'the floor is the same whichever method judges the rest')
  assert.deepEqual(JSON.parse(h.requests[0]).questions.map(q => q.type), ['score'])
})

test.after(() => { if (process.env.EGDESK_SIM_OUT) import('node:fs').then(fs => fs.writeFileSync(process.env.EGDESK_SIM_OUT, JSON.stringify(MATRIX, null, 2))) })
