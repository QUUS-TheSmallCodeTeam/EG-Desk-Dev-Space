// c37: the real-engine check with Claude as the engine. A FAKE Claude transport (EG-Desk's real adapter, permission broker, MCP bridge and translator; only the CLI process is fake): no CLI is run,
// no login is read, no model is called. The Decision model, where a script needs it, is a scripted fetch.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { DECISION_KEY_ENV, HELP, formatPlan, loadScripts, parseArgs, planRun, preflight, runCheck } from './egdesk-real-engine-check.mjs'
import { CLAUDE_FEATURES, claudeApplicability, claudeRequest, createUsageGuard, fileUsageState, validateClaudeOptions, windowsFromUsage, wrapClaudeAdapter } from './egdesk-real-engine-claude.mjs'
import { validateEngineScript } from './egdesk-real-engine-script.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const SMOKE = path.resolve(import.meta.dirname, '../scripts/real-engine/scripts/real-engine-claude-smoke-v1.json')
const tmp = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-claude-check-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }
const PASS = 'ℹ tests 5\nℹ suites 0\nℹ pass 5\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 52.1\n'
const ARGS = ['--engine', 'claude', '--script', 's.json', '--out', '/tmp/o']

// ---- options, plan, applicability ----
test('--engine claude: no Codex binary or home, a cap by default, the guard options validated; Codex-only and Claude-only options refuse each other', () => {
  const o = parseArgs(ARGS); assert.deepEqual([o.engine, o.codexBin, o.home, o.maxConversations, o.usageStopPercent, o.allowSubscriptionSmoke, o.requireUsageSignal], ['claude', null, null, 3, 70, false, false])
  const all = parseArgs([...ARGS, '--claude-bin', '/x/claude', '--max-conversations', '5', '--usage-stop', '60', '--usage-state', '/x/state.json', '--require-usage-signal', '--allow-subscription-smoke'])
  assert.deepEqual([all.claudeBin, all.maxConversations, all.usageStopPercent, all.usageState, all.requireUsageSignal, all.allowSubscriptionSmoke], ['/x/claude', 5, 60, '/x/state.json', true, true])
  for (const [args, re] of [[[...ARGS, '--codex-bin', '/x/codex'], /not with --engine claude/], [[...ARGS, '--person-home'], /not with --engine claude/], [[...ARGS, '--claude-bin', 'claude'], /absolute/], [[...ARGS, '--max-conversations', '0'], /whole number/], [[...ARGS, '--usage-stop', '101'], /1-100/], [[...ARGS, '--usage-state', 'rel.json'], /absolute/], [[...ARGS, '--persisted-with-cleanup'], /Codex thread cleanup/], [['--engine', 'gemini', '--script', 's.json', '--out', '/tmp/o'], /codex or claude/],
    [['--codex-bin', '/x/codex', '--person-home', '--script', 's.json', '--out', '/tmp/o', '--claude-bin', '/x/claude'], /for --engine claude/], [['--codex-bin', '/x/codex', '--person-home', '--script', 's.json', '--out', '/tmp/o', '--allow-subscription-smoke'], /for --engine claude/]])
    assert.throws(() => parseArgs(args), re, args.join(' '))
  assert.equal(parseArgs(['--codex-bin', '/x/codex', '--person-home', '--script', 's.json', '--out', '/tmp/o']).maxConversations, null, 'the Codex engine has no default cap')
  for (const word of ['--engine <codex|claude>', '--claude-bin <path>', '--max-conversations <n>', '--usage-stop <percent>', '--usage-state <file>', '--allow-subscription-smoke', 'API-key login']) assert.ok(HELP.includes(word), word)
  assert.deepEqual(validateClaudeOptions({ engine: 'claude', persisted: false, maxConversations: 3, usageStopPercent: 70 }), []); assert.deepEqual(validateClaudeOptions({ engine: 'codex' }), [])
})

test('the Claude inventory: what works, what is untested, what is not applicable; a conversation that needs a missing feature is not applicable (named), the rest are applicable', () => {
  const by = status => CLAUDE_FEATURES.filter(f => f.status === status).map(f => f.feature)
  assert.ok(by('untested').some(f => /EG-Desk tools offered/.test(f)) && by('notApplicable').some(f => /own-tools mode/.test(f)) && by('supported').some(f => /approvals/.test(f)) && by('supported').some(f => /interrupt/.test(f)) && by('supported').some(f => /timing/.test(f)))
  assert.ok(by('notApplicable').some(f => /steer/.test(f)) && by('notApplicable').some(f => /delete/.test(f)) && by('notApplicable').some(f => /restart/.test(f)) && by('notApplicable').some(f => /fork/.test(f)))
  const turns = extra => [{ say: 'x', ...extra }]
  assert.deepEqual(claudeApplicability({ id: 'a', turns: turns({}) }), { applicable: true, notApplicable: [], untested: [] })
  assert.match(claudeApplicability({ id: 'a', turns: turns({ action: 'steer', say: undefined }) }).notApplicable[0].feature, /steer/)
  assert.match(claudeApplicability({ id: 'a', flags: { EGDESK_INRUN_MESSAGES: 'on' }, turns: turns({}) }).notApplicable[0].feature, /steer/)
  assert.match(claudeApplicability({ id: 'a', turns: turns({ action: 'delete' }) }).notApplicable[0].feature, /delete/); assert.match(claudeApplicability({ id: 'a', turns: [{ action: 'restart' }] }).notApplicable[0].feature, /restart/)
  assert.match(claudeApplicability({ id: 'a', turns: turns({ expect: { deleted: { engineGone: true } } }) }).notApplicable[0].feature, /delete/)
  const draft = claudeApplicability({ id: 'a', draftCheck: { mode: 'on' }, agentProfile: { name: 'x' }, turns: turns({}) }); assert.equal(draft.applicable, true); assert.deepEqual(draft.untested.map(u => /draft/.test(u.feature) ? 'draft' : /Agent/.test(u.feature) ? 'agent' : '?').sort(), ['agent', 'draft'])
  assert.ok(claudeApplicability({ id: 'a', turns: turns({ action: 'steer' }) }).notApplicable.every(n => n.why.length > 20))
})

test('the dry plan for the Claude smoke set: three conversations that run, the guard, the cap, the API-key rule, the inventory; nothing is started and the CLI is not run', () => {
  const smoke = JSON.parse(fs.readFileSync(SMOKE, 'utf8')); assert.deepEqual(validateEngineScript(smoke), { ok: true, errors: [] }); assert.deepEqual(smoke.conversations.map(c => c.id), ['claude-plain', 'claude-two-turns', 'claude-own-command'])
  const options = parseArgs([...ARGS.slice(0, 2), '--script', SMOKE, '--out', '/tmp/o', '--decisions']), scripts = loadScripts([SMOKE])
  const plan = planRun(options, scripts, { env: { PATH: '/nonexistent' }, resolveClaude: () => '/home/x/.local/bin/claude' })
  assert.equal(plan.engine, 'claude'); assert.deepEqual(plan.conversations.map(c => c.claude.runs), [true, true, true]); assert.equal(plan.claudeBin.path, '/home/x/.local/bin/claude'); assert.equal(plan.guard.stopAtPercent, 70); assert.equal(plan.guard.maxConversations, 3)
  const text = formatPlan(plan, preflight(options, scripts, { env: { [DECISION_KEY_ENV]: 'k' }, exists: () => true }))
  for (const word of ['DRY: nothing is started, the CLI is not run', 'API-KEY login only', 'REFUSES a claude.ai subscription login', 'usage guard: stop at >= 70%', 'at most 3 conversations', 'claude-own-command: RUNS', '[notApplicable] steer', '[notApplicable] own-tools mode', '[untested] EG-Desk tools offered']) assert.ok(text.includes(word), word)
  assert.ok(!text.includes('--codex-bin')); assert.deepEqual(preflight(options, scripts, { env: { [DECISION_KEY_ENV]: 'k' }, exists: () => true }), [])
  assert.match(preflight(parseArgs([...ARGS, '--claude-bin', '/no/claude']), loadScripts([SMOKE]), { env: {}, exists: () => false })[0], /Claude binary is not an existing executable/)
  const capped = planRun(parseArgs([...ARGS.slice(0, 2), '--script', SMOKE, '--out', '/tmp/o', '--max-conversations', '2']), scripts, { env: {}, resolveClaude: () => null })
  assert.deepEqual(capped.conversations.map(c => c.claude.runs), [true, true, false]); assert.equal(capped.conversations[2].claude.skippedBy, '--max-conversations'); assert.equal(capped.claudeBin.path, null)
  const withNa = { set: 'real-engine-na-v1', conversations: [{ id: 'steering', turns: [{ say: 'x', action: undefined, expect: { posted: true } }], flags: { EGDESK_INRUN_MESSAGES: 'on' } }, smoke.conversations[0]] }
  const na = planRun(options, [{ file: 'na.json', script: withNa }], { env: {}, resolveClaude: () => null }); assert.deepEqual(na.conversations.map(c => c.claude.runs), [false, true]); assert.match(formatPlan(na), /NOT APPLICABLE \(skipped, not failed\)/)
})

// ---- the usage guard ----
const row = (...windows) => ({ windows })
test('usage guard: stops at >= 70 % of any window, on a warning or a rejection; no signal is unknown, never low; a remembered window of an earlier run counts until it resets', () => {
  const at = Date.now(); let usage = null
  const guard = createUsageGuard({ readUsage: () => usage, now: () => at })
  assert.deepEqual([guard.assess('conversation').ok, guard.assess('conversation').unknown], [true, true]); usage = row({ window: 'fiveHour', usedPercent: 12, resetsAt: at + 1000, status: 'allowed' }, { window: 'weekly', usedPercent: 69.9, resetsAt: at + 9999, status: 'allowed' })
  assert.deepEqual([guard.assess('conversation').ok, guard.assess('conversation').unknown], [true, false])
  usage = row({ window: 'fiveHour', usedPercent: 12 }, { window: 'weekly', usedPercent: 70, status: 'allowed' }); const stop = guard.assess('conversation'); assert.deepEqual([stop.stop, stop.reason], [true, 'window_at_or_above_stop'])
  usage = row({ window: 'fiveHour', usedPercent: null, status: 'allowed_warning' }); assert.equal(guard.assess('turn').reason, 'limit_warning'); usage = row({ window: 'weeklyOpus', usedPercent: 100, status: 'rejected' }); assert.equal(guard.assess('turn').reason, 'limit_rejected')
  assert.equal(createUsageGuard({ readUsage: () => row({ window: 'fiveHour', usedPercent: 50 }), stopAtPercent: 50 }).assess('x').stop, true, 'the threshold is the option')
  const log = guard.log(); assert.ok(log.length >= 6 && log.every(l => typeof l.phase === 'string')); assert.ok(JSON.stringify(log).length < 4000, 'closed names and numbers only')
  // the state of an earlier run: numbers and window names, mode 0600; an expired window is forgotten
  const writes = []; let stored = null; const fsApi = { readFileSync: () => { if (!stored) throw new Error('none'); return stored }, writeFileSync: (file, text, opts) => { writes.push([file, opts]); stored = text } }
  const state = fileUsageState('/x/state.json', fsApi); createUsageGuard({ readUsage: () => row({ window: 'weekly', usedPercent: 81, resetsAt: at + 5000 }), state, now: () => at }).persist()
  assert.deepEqual(writes[0], ['/x/state.json', { mode: 0o600 }]); assert.deepEqual(Object.keys(JSON.parse(stored)).sort(), ['observedAt', 'windows']); assert.doesNotMatch(stored, /email|token|account|key/i)
  assert.equal(createUsageGuard({ state, now: () => at + 1000 }).assess('conversation').reason, 'window_at_or_above_stop', 'a new run refuses to start before the window resets')
  assert.equal(createUsageGuard({ state, now: () => at + 6000 }).assess('conversation').ok, true, 'after the reset it is forgotten')
  const blind = createUsageGuard({ requireSignal: true }); assert.equal(blind.assess('conversation', { conversationsDone: 0 }).ok, true, 'the first conversation may be blind'); assert.equal(blind.assess('conversation', { conversationsDone: 1 }).reason, 'no_usage_signal')
  assert.deepEqual(windowsFromUsage({ windows: [{ window: 'fiveHour', usedPercent: 33.33, resetsAt: 5, status: 'allowed', extra: 'x' }, { window: 'bogus', usedPercent: 99 }] }), [{ window: 'fiveHour', usedPercent: 33.3, resetsAt: 5, status: 'allowed' }])
})

test('the wrapped adapter: the check\'s own request, respond and event taps sit between the runtime and the adapter; other engine requests are not applicable', async () => {
  const calls = [], listeners = [], adapter = { id: 'claude', startThread: async p => { calls.push(['startThread', p]); return { thread: { id: 't' } } }, startTurn: async p => { calls.push(['startTurn', p]); return { turn: { id: 'u', status: 'inProgress' } } }, interruptTurn: async (a, b) => { calls.push(['interrupt', a, b]); return {} }, respond: () => { throw new Error('the wrapper must answer through the check') }, subscribe: sink => { listeners.push(sink); return () => {} } }
  const seen = [], req = []; const request = async (m, p) => { req.push(m); return claudeRequest(adapter)(m, p) }
  const wrapped = wrapClaudeAdapter({ adapter, request, respond: (id, r) => seen.push(['respond', id, r]), tapNotification: m => seen.push(['n', m.method]), tapRequest: m => seen.push(['r', m.method]) })
  await wrapped.startThread({ a: 1 }); await wrapped.startTurn({ b: 2 }); await wrapped.interruptTurn('t', 'u'); wrapped.respond('id1', { ok: true }); assert.deepEqual(req, ['thread/start', 'turn/start', 'turn/interrupt']); assert.deepEqual(calls.map(c => c[0]), ['startThread', 'startTurn', 'interrupt']); assert.deepEqual(seen, [['respond', 'id1', { ok: true }]])
  const got = []; wrapped.subscribe({ notification: (id, m) => got.push(['n', id, m.method]), serverRequest: (id, m) => got.push(['r', id, m.method]), connection: (id, s) => got.push(['c', id, s.ready]) })
  listeners[0].notification('claude', { method: 'turn/started' }); listeners[0].serverRequest('claude', { method: 'item/tool/call' }); listeners[0].connection('claude', { ready: true }); assert.deepEqual(got, [['n', 'claude', 'turn/started'], ['r', 'claude', 'item/tool/call'], ['c', 'claude', true]]); assert.deepEqual(seen.slice(1), [['n', 'turn/started'], ['r', 'item/tool/call']])
  await assert.rejects(claudeRequest(adapter)('thread/fork', {}), { code: 'not_applicable_on_claude' }); await assert.rejects(claudeRequest(adapter)('thread/delete', {}), { code: 'not_applicable_on_claude' })
})

// ---- through the check, with a fake CLI ----
const scriptOf = (...conversations) => ({ set: 'real-engine-claude-test-v1', conversations })
const plain = id => ({ id, turns: [{ say: '한 단어로만 답해: 하나', expect: { posted: true, turnStatus: 'completed', noNativeTools: true } }] })

/** A fake Claude CLI: for each user message it streams a reply (and optionally an EG-Desk tool call and a rate_limit_event); the rest of the product (adapter, broker, MCP bridge, translator) is real. */
function fakeClaudeWorld(t, { method = 'apiKey', status = 'signedIn', installed = true, versionStatus = 'untested', rate = null, tool = null, text = '하나' } = {}) {
  const base = tmp(t), out = path.join(base, 'out'), transports = [], ranCommands = [], picks = []
  const options = parseArgs(['--engine', 'claude', '--script', 'x.json', '--out', out, '--turn-timeout-ms', '20000'])
  const createTransport = opts => {
    const transport = {
      opts, sent: [], replies: [], inited: false,
      async start() {}, info: () => ({ init: { billsApiKey: method === 'apiKey' } }), async interrupt() {},
      respondControl(id, answer) { this.replies.push({ id, ...answer }); return true },
      async close() { opts.onExit?.() },
      sendUserMessage(content) {
        this.sent.push(content); const sid = opts.sessionId || opts.resume, n = this.sent.length
        setImmediate(async () => {
          if (!this.inited) { this.inited = true; opts.onMessage({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-test', cwd: opts.cwd, claude_code_version: '2.1.328', apiKeySource: method === 'apiKey' ? 'ANTHROPIC_API_KEY' : 'none' }) }
          if (rate) opts.onMessage({ type: 'rate_limit_event', session_id: sid, rate_limit_info: rate(n) })
          if (tool) { await opts.controlHandlers.mcp_message({ subtype: 'mcp_message', server_name: 'egdesk', message: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'egdesk_run_command', arguments: { command: tool.command } } } }, { requestId: `tool-${n}` }); for (let i = 0; i < 400 && !this.replies.some(r => r.id === `tool-${n}`); i++) await new Promise(r => setTimeout(r, 5)) } // like the real CLI: the turn goes on only when the tool result is back
          const id = `msg-${n}`
          opts.onMessage({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'message_start', message: { id } } })
          opts.onMessage({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } })
          opts.onMessage({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } })
          opts.onMessage({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { id, role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 3, output_tokens: 1 } } })
          opts.onMessage({ type: 'stream_event', session_id: sid, parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } })
          opts.onMessage({ type: 'result', subtype: 'success', is_error: false, session_id: sid })
        })
      },
    }
    transports.push(transport); return transport
  }
  const runnerSpawn = (file, args) => {
    const child = new EventEmitter(); Object.assign(child, { pid: 9100 + ranCommands.length, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }); ranCommands.push(String(args.at(-1)))
    setImmediate(() => { child.stdout.write(PASS); setTimeout(() => child.emit('close', 0, null), 5) }); return child
  }
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body), q = body.questions.find(x => x.name === 'df_pick')
    if (!q) return Response.json({ answers: body.questions.map(x => ({ name: x.name, type: 'predicate', probability: 0.05 })), usage: { input_tokens: 10 } })
    const message = /"""\n([\s\S]*?)\n"""/.exec(body.input.find(m => m.role === 'user')?.content ?? '')?.[1] ?? '', value = /테스트/.test(message) ? q.choices.find(c => /tests/.test(c.description ?? ''))?.value ?? 'none' : 'none'
    picks.push({ message, value }); return Response.json({ model: 'gpt-6-luna', answers: [{ type: 'choice', name: 'df_pick', choice: value, confidence: 0.96, probabilities: [{ value: 'none', probability: 0.02 }, { value, probability: 0.96 }].sort((a, b) => a.probability - b.probability) }], usage: { input_tokens: 40 } })
  }
  const probes = []
  const deps = { env: { PATH: '/usr/bin:/bin', HOME: base, [DECISION_KEY_ENV]: 'egd-synthetic-not-a-key-0037' }, runnerSpawn, fetchImpl,
    claudeProbe: async () => { probes.push(1); return { installed, version: '2.1.328', versionStatus, auth: { status, method, label: 'Claude API' }, checkedAt: Date.now() } },
    claudeAdapterOptions: { resolveExecutable: () => '/fake/claude', createTransport } }
  return { base, out, options, deps, transports, ranCommands, picks, probes, run: (script, patch = {}) => runCheck({ ...options, ...patch }, [{ file: 'x.json', script }], deps) }
}

test('Claude through the check, fake CLI: a plain turn runs on EG-Desk\'s adapter; the record names the engine and the auth METHOD only; no Codex process; the session id is listed; nothing else is deleted', async t => {
  const w = fakeClaudeWorld(t), result = await w.run(scriptOf(plain('p'))), rec = result.records[0]
  assert.equal(rec.aborted, null, rec.abortDetail); assert.equal(rec.ok, true, JSON.stringify(rec.turns[0]?.expectations?.filter(c => !c.ok)))
  assert.deepEqual([rec.engine.id, rec.engine.signedIn, rec.engine.authMethod, rec.engine.authAllowed, rec.engine.version], ['claude', true, 'apiKey', 'apiKey', '2.1.328']); assert.doesNotMatch(JSON.stringify(rec.engine), /@|token|password/i)
  assert.equal(rec.turns[0].posted.length, 1); assert.ok(rec.turns[0].subTurns[0].firstEventMs >= 0 && rec.turns[0].subTurns[0].firstProgressMs >= 0, 'the timing taps work on the translated events')
  assert.deepEqual(rec.requests.filter(r => r.method === 'turn/start' || r.method === 'thread/start').map(r => r.method), ['thread/start', 'turn/start']); assert.equal(rec.claude.sessions.length, 1); assert.match(rec.claude.sessions[0], /^[0-9a-f-]{36}$/)
  assert.equal(w.transports.length, 1); assert.equal(w.transports[0].opts.cwd, path.join(w.out, 'scratch', 'p'), 'the Claude CLI runs in the conversation\'s folder (its native tools are the adapter\'s to restrict), unlike Codex\'s empty engine folder'); assert.equal(result.summary.engine, 'claude'); assert.equal(result.summary.stoppedBy, null); assert.equal(result.summary.usageGuard.ran, 1)
  assert.equal(JSON.stringify(rec).includes(w.base + '/.claude'), false)
})

test('a SUBSCRIPTION login is refused (API-key authentication only) unless --allow-subscription-smoke; other methods, signed out, not installed, an unsupported version: refused, nothing sent', async t => {
  const sub = fakeClaudeWorld(t, { method: 'claudeai' }), refused = await sub.run(scriptOf(plain('p')))
  assert.equal(refused.records[0].aborted, 'claude_subscription_refused'); assert.equal(refused.ok, false); assert.equal(sub.transports.length, 0, 'the CLI was never asked for a turn'); assert.deepEqual([refused.records[0].engine.authMethod, refused.records[0].engine.authAllowed], ['claudeai', null]); assert.match(refused.records[0].abortDetail, /--allow-subscription-smoke is only for a person who chose it/)
  const allowed = await sub.run(scriptOf(plain('p')), { allowSubscriptionSmoke: true }); assert.equal(allowed.records[0].aborted, null); assert.equal(allowed.records[0].engine.authAllowed, 'subscription-smoke'); assert.equal(allowed.records[0].ok, true)
  assert.equal((await fakeClaudeWorld(t, { method: 'gateway' }).run(scriptOf(plain('p')))).records[0].aborted, 'claude_auth_method_refused')
  assert.equal((await fakeClaudeWorld(t, { status: 'signedOut', method: null }).run(scriptOf(plain('p')))).records[0].aborted, 'claude_login_required')
  assert.equal((await fakeClaudeWorld(t, { installed: false, status: 'unknown', method: null }).run(scriptOf(plain('p')))).records[0].aborted, 'claude_not_installed')
  assert.equal((await fakeClaudeWorld(t, { versionStatus: 'unsupported' }).run(scriptOf(plain('p')))).records[0].aborted, 'claude_version_unsupported')
})

test('conversations that need what Claude does not have are NOT APPLICABLE: recorded with their features, never run, never failed, not counted against the cap', async t => {
  const w = fakeClaudeWorld(t), steering = { id: 'steering', flags: { EGDESK_INRUN_MESSAGES: 'on' }, turns: [{ say: 'x', expect: { posted: true } }] }
  const deleting = { id: 'deleting', turns: [{ say: 'x', expect: { posted: true } }, { action: 'delete', expect: { deleted: { conversationGone: true } } }] }
  const result = await w.run(scriptOf(steering, plain('a'), deleting, plain('b')), { maxConversations: 2 })
  assert.deepEqual(result.records.map(r => [r.id, r.skipped ?? 'ran', r.ok]), [['steering', 'not_applicable', true], ['a', 'ran', true], ['deleting', 'not_applicable', true], ['b', 'ran', true]]); assert.equal(result.ok, true)
  assert.deepEqual(result.summary.notApplicable.map(n => [n.id, n.features.length]), [['steering', 1], ['deleting', 1]]); assert.match(result.records[0].notApplicable[0].why, /steerTurn/); assert.equal(w.transports.length, 2, 'only the applicable ones started a CLI'); assert.equal(result.summary.stoppedBy, null)
})

test('--max-conversations: the run stops before the next conversation and says so; the stop is recorded, the ones that ran are kept', async t => {
  const w = fakeClaudeWorld(t), result = await w.run(scriptOf(plain('a'), plain('b'), plain('c')), { maxConversations: 2 })
  assert.deepEqual(result.records.map(r => r.id), ['a', 'b']); assert.deepEqual([result.summary.stoppedBy.reason, result.summary.stoppedBy.cap, result.summary.stoppedBy.before], ['max_conversations', 2, 'real-engine-claude-test-v1/c']); assert.equal(result.summary.usageGuard.ran, 2); assert.equal(result.summary.ok, true, 'a cap is not a failure')
  assert.equal(fs.existsSync(path.join(w.out, 'records', 'real-engine-claude-test-v1', 'c.json')), false)
})

test('usage guard through the check: a warning the CLI sent stops the run before the next conversation (recorded, run not ok); the state file keeps the windows for the next run', async t => {
  const w = fakeClaudeWorld(t, { rate: () => ({ status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.81, resetsAt: Math.floor(Date.now() / 1000) + 3600 }) }), state = path.join(w.base, 'usage-state.json')
  const result = await w.run(scriptOf(plain('a'), plain('b')), { usageState: state })
  assert.deepEqual(result.records.map(r => r.id), ['a'], 'the second conversation never started'); assert.equal(result.summary.stoppedBy.guard, true); assert.match(result.summary.stoppedBy.reason, /window_at_or_above_stop|limit_warning/); assert.equal(result.ok, false, 'a guard stop is visible as not ok')
  assert.deepEqual(result.summary.stoppedBy.windows.map(x => [x.window, x.usedPercent]), [['fiveHour', 81]]); assert.equal(w.transports.length, 1)
  const saved = JSON.parse(fs.readFileSync(state, 'utf8')); assert.deepEqual(saved.windows.map(x => [x.window, x.usedPercent]), [['fiveHour', 81]]); assert.equal((fs.statSync(state).mode & 0o777), 0o600)
  const next = fakeClaudeWorld(t), refused = await next.run(scriptOf(plain('a')), { usageState: state }); assert.deepEqual(refused.records, [], 'the next run refuses to start before the window resets'); assert.equal(refused.summary.stoppedBy.guard, true); assert.equal(next.transports.length, 0); assert.equal(next.probes.length, 0, 'not even the static probe ran')
})

test('usage guard between turns: a window at 70 % reported by the first turn stops the conversation before its second turn', async t => {
  const w = fakeClaudeWorld(t, { rate: () => ({ status: 'allowed', rateLimitType: 'seven_day', utilization: 0.7, resetsAt: Math.floor(Date.now() / 1000) + 86400 }) })
  const two = { id: 'two', turns: [plain('x').turns[0], plain('x').turns[0]] }, result = await w.run(scriptOf(two))
  assert.equal(result.records[0].aborted, 'usage_guard_stop'); assert.equal(result.records[0].turns.length, 1, 'one turn ran, the second never started'); assert.equal(w.transports[0].sent.length, 1); assert.equal(result.summary.stoppedBy.reason, 'usage_guard_stop')
  assert.deepEqual(result.summary.usageGuard.log.at(-1).windows.map(x => [x.window, x.usedPercent]), [['weekly', 70]])
})

test('--require-usage-signal: with no usage event at all the run stops after the first conversation (it ran blind once); without the option it goes on', async t => {
  const strict = fakeClaudeWorld(t), stopped = await strict.run(scriptOf(plain('a'), plain('b')), { requireUsageSignal: true }); assert.deepEqual(stopped.records.map(r => r.id), ['a']); assert.equal(stopped.summary.stoppedBy.reason, 'no_usage_signal')
  const loose = fakeClaudeWorld(t), ran = await loose.run(scriptOf(plain('a'), plain('b'))); assert.deepEqual(ran.records.map(r => r.id), ['a', 'b']); assert.equal(ran.summary.usageGuard.log.every(l => l.unknown), true, 'honestly unknown')
})

test('EG-Desk\'s command tool through the adapter\'s MCP bridge (fake CLI): the command runs through EG-Desk\'s runner and the record carries it; action first and the other own-tools-mode features are NOT APPLICABLE on Claude (not failed)', async t => {
  const smoke = JSON.parse(fs.readFileSync(SMOKE, 'utf8')), own = smoke.conversations.find(c => c.id === 'claude-own-command')
  const w = fakeClaudeWorld(t, { tool: { command: 'npm test' }, text: '테스트 5개가 모두 통과했습니다.' }), engineRun = await w.run(scriptOf(own), { decisions: true })
  const rec = engineRun.records[0]; assert.equal(rec.aborted, null, rec.abortDetail); assert.equal(rec.ok, true, JSON.stringify(rec.turns[0]?.expectations?.filter(c => !c.ok))); assert.deepEqual(w.ranCommands, ['npm test']); assert.deepEqual(rec.turns[0].subTurns[0].toolCalls.map(c => c.tool), ['egdesk_run_command'])
  const action = { id: 'claude-action-first', flags: { EGDESK_DECISION_FIRST: 'on' }, turns: [{ say: '테스트 돌려줘', expect: { decisionFirst: { path: 'action', engineTurns: 1 } } }] }
  const na = await fakeClaudeWorld(t).run(scriptOf(action), { decisions: true }); assert.deepEqual([na.records[0].skipped, na.records[0].ok, na.ok], ['not_applicable', true, true]); assert.match(na.records[0].notApplicable[0].why, /ownTools = engine.id codex/)
  for (const c of [{ id: 'undo', turns: [{ say: 'x', expect: { undo: {} } }] }, { id: 'edit', turns: [{ say: 'x', expect: { edited: {} } }] }]) assert.equal(claudeApplicability(c).applicable, false, c.id)
})
