// c22: the real-engine check, end to end against a FAKE app-server that speaks the 0.171 protocol (scripts/real-engine/fake-app-server.mjs,
// every message of it checked against the schema subset). The app-server child, the command runner and the Decision provider are all
// injected fakes living in this process; no Codex binary runs and nothing is sent anywhere.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runFakeAppServer } from '../scripts/real-engine/fake-app-server.mjs'
import { validateMessage } from './egdesk-app-server-protocol.mjs'
import { BRIDGE_COMPOSITION, DECISION_KEY_ENV, LEDGER_FILE, appServerArgs, assertCleanupGuaranteed, childEnv, cleanupLeftovers, closedRow, createGroupKiller, createLedger, formatPlan, leftoverThreads, loadScripts, parseArgs, planRun, preflight, runCheck } from './egdesk-real-engine-check.mjs'
import { APPROVER_TEXT, REAL_ENGINE_SCRIPT_SCHEMA, checkTurnExpectations, validateEngineScript } from './egdesk-real-engine-script.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const app = path.join(here, '..')
const STARTERS = ['real-engine-read-file-v1', 'real-engine-command-approval-v1', 'real-engine-edit-undo-v1'].map(name => path.join(app, 'scripts', 'real-engine', 'scripts', `${name}.json`))
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const starter = name => readJson(path.join(app, 'scripts', 'real-engine', 'scripts', `real-engine-${name}-v1.json`))

function tmp(t) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-real-engine-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  return base
}

// ---- fakes ----
function world(t, fakeScript, { decisions = false, home = { kind: 'person', dir: null }, model = null, effort = null, downgrade = false } = {}) {
  const base = tmp(t), out = path.join(base, 'out'), codexHome = path.join(base, 'codex-home')
  fs.mkdirSync(codexHome)
  const spawns = [], ranCommands = [], decisionCalls = [], stderrLines = []
  const spawn = (bin, argv, options) => {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough()
    const child = new EventEmitter()
    Object.assign(child, { pid: 4242 + spawns.length, stdin, stdout, stderr, exitCode: null, signalCode: null, kill: () => true })
    spawns.push({ bin, argv, options })
    // downgrade: the thread/start of the product before c23 (no developer instructions, the permissions block on), for a control run
    let fakeInput = stdin
    if (downgrade) {
      fakeInput = new PassThrough()
      stdin.on('data', chunk => { for (const line of String(chunk).split('\n').filter(Boolean)) { const m = JSON.parse(line); if (m.method === 'thread/start') { delete m.params.developerInstructions; delete m.params.config?.include_permissions_instructions } fakeInput.write(`${JSON.stringify(m)}\n`) } })
      stdin.on('end', () => fakeInput.end())
    }
    runFakeAppServer({ script: fakeScript, log: path.join(base, 'fake-app-server.log'), input: fakeInput, output: stdout, stderr: { write: line => { stderrLines.push(line); stderr.write(line) } }, env: options.env, exit: code => { child.exitCode = code; child.emit('close', code, null) } })
    return child
  }
  const killGroup = async child => { child.stdin.end(); await new Promise(resolve => { if (child.exitCode != null) return resolve(); child.once('close', resolve); setTimeout(resolve, 500) }); return { signal: 'SIGTERM' } }
  const runnerSpawn = (file, args) => {
    const child = new EventEmitter()
    Object.assign(child, { pid: 9000 + ranCommands.length, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
    ranCommands.push(String(args.at(-1)))
    setImmediate(() => { child.stdout.write(`ran: ${args.at(-1)}\n`); setImmediate(() => child.emit('close', 0, null)) })
    return child
  }
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    const data = body.input.find(m => Array.isArray(m.content))?.content[0].data ?? {}
    decisionCalls.push({ names: body.questions.map(q => q.name), reply: data.reply ?? null })
    const yes = typeof data.reply === 'string' && data.reply === APPROVER_TEXT.yes
    return Response.json({ answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: q.name === 'reply_runs_command' ? (yes ? 0.96 : 0.03) : q.name === 'reply_declines_command' ? (yes ? 0.02 : 0.95) : 0.05 })), usage: { input_tokens: 20 } })
  }
  const options = { mode: 'run', codexBin: '/fake/codex', home, scripts: [], out, decisions, model, effort, appServerConfig: [], turnTimeoutMs: 8000, json: false }
  if (home.kind === 'dir') options.home = { kind: 'dir', dir: codexHome }
  const deps = { spawn, runnerSpawn, fetchImpl, killGroup, killGroupRunner: () => {}, gitStatus: async () => null, env: { PATH: '/usr/bin:/bin', HOME: path.join(base, 'home'), [DECISION_KEY_ENV]: 'egd-synthetic-not-a-key-0022', OPENAI_API_KEY: 'sk-synthetic-must-not-reach-the-child' } }
  return { base, out, codexHome, options, deps, spawns, ranCommands, decisionCalls, stderrLines }
}
const wireLog = w => fs.readFileSync(path.join(w.base, 'fake-app-server.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const asScripts = (...scripts) => scripts.map(script => ({ file: `${script.set}.json`, script }))
const only = (result, i = 0) => result.records[i]
const noSchemaErrors = w => assert.deepEqual(w.stderrLines, [], 'the fake saw nothing off the schema')

// ---- the script format ----
test('the committed JSON schema file is the validator\'s schema, and the starter scripts validate', () => {
  assert.deepEqual(readJson(path.join(app, 'scripts', 'real-engine', 'real-engine-script.schema.json')), JSON.parse(JSON.stringify(REAL_ENGINE_SCRIPT_SCHEMA)))
  for (const file of STARTERS) assert.deepEqual(validateEngineScript(readJson(file)), { ok: true, errors: [] }, file)
  assert.equal(loadScripts(STARTERS).length, 3)
})

test('the validator refuses what a script may not do', () => {
  const ok = { set: 'real-engine-x-v1', conversations: [{ id: 'c1', folder: { 'a.txt': 'x' }, turns: [{ say: 'hi', expect: { posted: true } }] }] }
  assert.equal(validateEngineScript(ok).ok, true)
  const bad = (mutate, pattern) => { const v = structuredClone(ok); mutate(v); const r = validateEngineScript(v); assert.equal(r.ok, false, pattern); assert.match(r.errors.join('\n'), pattern) }
  bad(v => { v.set = 'other' }, /\$\.set/)
  bad(v => { v.extra = 1 }, /unknown key/)
  bad(v => { v.conversations[0].folder['../x'] = 'y' }, /path segment/)
  bad(v => { v.conversations[0].folder['/abs'] = 'y' }, /not_relative/)
  bad(v => { v.conversations[0].folder['.git/config'] = 'y' }, /protected/)
  bad(v => { v.conversations[0].folder['d'] = 'x'; v.conversations[0].folder['d/e'] = 'y' }, /also a folder/)
  bad(v => { v.conversations[0].flags = { EGDESK_CODEX_BIN: 'x' } }, /reserved/)
  bad(v => { v.conversations[0].flags = { EGDESK_OWN_TOOLS: 'off' } }, /always on/)
  bad(v => { v.conversations[0].flags = { lower: 'on' } }, /name matches/)
  bad(v => { v.conversations.push(structuredClone(v.conversations[0])) }, /unique/)
  bad(v => { v.conversations[0].turns[0].approve = ['maybe'] }, /approve/)
  bad(v => { v.conversations[0].turns[0].expect = { bogus: 1 } }, /unknown key/)
  bad(v => { v.conversations[0].turns[0].expect = { toolCalls: ['a'], noToolCalls: true } }, /contradict/)
  bad(v => { v.conversations[0].turns[0].expect = { asked: 0 }; v.conversations[0].turns[0].approve = ['yes'] }, /more answers/)
  bad(v => { v.conversations[0].turns = [] }, /turns/)
  bad(v => { v.conversations[0].turns[0].say = '' }, /say/)
})

test('expectations are checked by code on the turn record', () => {
  const rec = { toolCalls: [{ tool: 'a' }, { tool: 'b' }, { tool: 'a' }], native: { commandExecution: 0, fileChange: 0, approvals: 0 }, posted: ['x', 'final answer 3pm'], asked: 1, commandsRan: ['ls'], files: { 'a.txt': 'new' }, undoRecords: 2, turnStatus: 'completed', compacted: true }
  const verdict = expect => checkTurnExpectations(expect, rec).every(c => c.ok)
  assert.equal(verdict({ toolCalls: ['a', 'a'], posted: true, answerIncludes: ['3pm'], answerExcludes: ['zzz'], noNativeTools: true, asked: 1, commandsRan: ['ls'], files: { 'a.txt': 'new' }, undoRecords: 1, turnStatus: 'completed', compacted: true }), true)
  assert.equal(verdict({ toolCalls: ['b', 'b'] }), false, 'an order that did not happen')
  assert.equal(verdict({ noToolCalls: true }), false)
  assert.equal(verdict({ answerIncludes: ['x'] }), false, 'only the last posted message is the answer')
  assert.equal(verdict({ files: { 'a.txt': null } }), false)
  assert.equal(verdict({ commandsRan: [] }), false)
  assert.equal(verdict({ noNativeTools: true }), true)
  assert.equal(checkTurnExpectations({ noNativeTools: true }, { native: { commandExecution: 1 } })[0].ok, false)
  assert.equal(checkTurnExpectations({ posted: true }, { posted: [] })[0].ok, false)
  assert.equal(checkTurnExpectations({ posted: false }, { posted: [] })[0].ok, true)
})

// ---- the protocol subset ----
test('the protocol subset accepts real shapes and refuses off-schema ones', () => {
  assert.deepEqual(validateMessage('notification', 'thread/compacted', { threadId: 't', turnId: 'u' }), [])
  assert.match(validateMessage('notification', 'thread/compacted', { threadId: 't' }).join(), /turnId: required/)
  assert.deepEqual(validateMessage('clientRequest', 'thread/start', { cwd: '/x', ephemeral: true, config: { features: { hooks: false } }, dynamicTools: [] }), [])
  assert.match(validateMessage('clientRequest', 'thread/start', { ephemeral: 'yes' }).join(), /ephemeral/)
  assert.deepEqual(validateMessage('response', 'item/tool/call', { contentItems: [{ type: 'inputText', text: 'x' }], success: true }), [])
  assert.match(validateMessage('response', 'item/tool/call', { contentItems: [{ type: 'text', text: 'x' }], success: true }).join(), /none of/)
  assert.match(validateMessage('notification', 'nope/nothing', {}).join(), /no notification nope\/nothing/)
})

// ---- the CLI's pure parts ----
test('arguments: a binary and a home are required, only by flag; dry is the default; the plan starts nothing', t => {
  const base = tmp(t)
  const must = (argv, pattern) => assert.throws(() => parseArgs(argv, {}), error => error.code === 'usage' && pattern.test(error.message), argv.join(' '))
  const okArgs = ['--codex-bin', '/bin/true', '--person-home', '--script', STARTERS[0], '--out', path.join(base, 'out')]
  must([], /--codex-bin is required/)
  must(['--codex-bin', 'codex', '--person-home', '--script', 'a', '--out', 'o'], /absolute/)
  must(['--codex-bin', '/bin/true', '--script', 'a', '--out', 'o'], /--codex-home .* or --person-home/)
  must([...okArgs, '--codex-home', '/x'], /not both/)
  must(['--codex-bin', '/bin/true', '--person-home', '--out', 'o'], /--script/)
  must(['--codex-bin', '/bin/true', '--person-home', '--script', 'a'], /--out/)
  must([...okArgs, '--bogus'], /unknown argument/)
  must(['--codex-bin', '/bin/true', '--person-home', '--script', 'a', '--out', '/Users/x/.codex/out'], /\.codex/)
  must([...okArgs, '--app-server-config', 'nokv'], /key=value/)
  const options = parseArgs(okArgs, {})
  assert.equal(options.mode, 'dry'); assert.equal(options.decisions, false)
  assert.equal(parseArgs([...okArgs, '--run', '--decisions'], {}).mode, 'run')
  const plan = planRun(options, loadScripts(STARTERS), { env: { PATH: '/usr/bin', OPENAI_API_KEY: 'sk-x', HOME: '/h' } })
  assert.equal(plan.conversations.length, 3); assert.equal(plan.conversations[0].flags.EGDESK_OWN_TOOLS, 'on')
  assert.deepEqual(plan.appServer.env, ['PATH', 'HOME'], 'a small environment: no API key, no CODEX_HOME for the person\'s home')
  assert.match(plan.appServer.argv.join(' '), /app-server -c features\.memories=false$/); assert.doesNotMatch(plan.appServer.argv.join(' '), /--listen/)
  assert.match(formatPlan(plan), /DRY: nothing is started/)
  assert.match(formatPlan(plan), /person's own Codex home and login; the check never reads that folder/)
})

test('the child environment, the app-server arguments and the preflight', () => {
  const base = { PATH: '/p', HOME: '/h', USER: 'u', OPENAI_API_KEY: 'sk-x', CODEX_HOME: '/person/.codex', EGDESK_DATA_DIR: '/installed', [DECISION_KEY_ENV]: 'k', SSH_AUTH_SOCK: '/s' }
  assert.deepEqual(childEnv({ home: { kind: 'person', dir: null } }, base), { PATH: '/p', HOME: '/h', USER: 'u' }, 'a CODEX_HOME in the shell is not passed on for --person-home')
  assert.deepEqual(childEnv({ home: { kind: 'dir', dir: '/given' } }, base), { PATH: '/p', HOME: '/h', USER: 'u', CODEX_HOME: '/given' })
  assert.deepEqual(appServerArgs({ model: 'gpt-x', effort: 'low', appServerConfig: ['features.apps=false'] }), ['app-server', '-c', 'model="gpt-x"', '-c', 'model_reasoning_effort="low"', '-c', 'features.memories=false', '-c', 'features.apps=false'])
  const scripts = loadScripts(STARTERS)
  const withYes = structuredClone(scripts); withYes[1].script.conversations[0].turns[1].approve = ['yes']
  assert.deepEqual(preflight({ codexBin: '/x', home: { kind: 'person' }, decisions: false }, scripts, { exists: () => true, env: {} }), [])
  assert.match(preflight({ codexBin: '/x', home: { kind: 'person' }, decisions: false }, withYes, { exists: () => true, env: {} })[0], /"yes" approvals .* need --decisions: real-engine-command-approval-v1\/command-approval/)
  const flagged = structuredClone(scripts); flagged[0].script.conversations[0].flags = { EGDESK_CONVERSATION_FLOW: 'on', EGDESK_DRAFT_CHECK: 'on' }
  assert.match(preflight({ codexBin: '/x', home: { kind: 'person' }, decisions: false }, flagged, { exists: () => true, env: {} })[0], /flags act only through the Decision model, so they need --decisions: real-engine-read-file-v1\/read-file \(EGDESK_CONVERSATION_FLOW, EGDESK_DRAFT_CHECK\)/)
  assert.deepEqual(preflight({ codexBin: '/x', home: { kind: 'person' }, decisions: true }, flagged, { exists: () => true, env: { [DECISION_KEY_ENV]: 'k' } }), [])
  assert.match(preflight({ codexBin: '/x', home: { kind: 'person' }, decisions: true }, scripts, { exists: () => true, env: {} })[0], new RegExp(DECISION_KEY_ENV))
  assert.match(preflight({ codexBin: '/missing', home: { kind: 'person' }, decisions: false }, scripts, { exists: () => false, env: {} })[0], /not an existing executable/)
})

test('the process-group kill: SIGTERM, then SIGKILL only when the child does not close', async () => {
  const signals = []
  const child = () => Object.assign(new EventEmitter(), { pid: 77, exitCode: null, signalCode: null, kill: s => { signals.push(['child', s]) } })
  const polite = child(), stubborn = child()
  const kill = (pid, signal) => { signals.push([pid, signal]); if (pid === -77 && signal === 'SIGTERM' && kill.polite) polite.emit('close') ; if (signal === 'SIGKILL') stubborn.emit('close') }
  kill.polite = true
  const stop = createGroupKiller({ kill, grace: 30 })
  assert.deepEqual(await stop(polite), { signal: 'SIGTERM' })
  kill.polite = false
  assert.deepEqual(await stop(stubborn), { signal: 'SIGKILL' })
  assert.deepEqual(signals, [[-77, 'SIGTERM'], [-77, 'SIGTERM'], [-77, 'SIGKILL']])
  assert.deepEqual(await stop(Object.assign(new EventEmitter(), { exitCode: 0 })), { signal: null })
})

// ---- conversations against the fake app-server ----
test('starter (a): the model reads a file through EG-Desk\'s tool and answers; one posted message; no native tools; ephemeral thread; own tools on', async t => {
  const fake = { person: { mcpServers: [{ name: 'notes', tools: ['search'] }, { name: 'gh', pluginId: 'github@openai', tools: ['pr'] }], hooks: 2, features: { hooks: true, memories: true, apps: true, plugins: true }, instructionSources: ['/person/.codex/AGENTS.md'] },
    turns: [{ steps: [{ agentMessage: 'Let me read the file.' }, { toolCall: { tool: 'egdesk_read_file', arguments: { path: 'notes.txt' } } }, { usage: { input: 23200, cached: 22900, output: 60, reasoning: 0 } }], final: 'The first line says the ordering cutoff is 3pm.' }] }
  const w = world(t, fake)
  const result = await runCheck(w.options, asScripts(starter('read-file')), w.deps)
  const rec = only(result)
  assert.equal(rec.aborted, null); assert.equal(rec.ok, true, JSON.stringify(rec.turns.map(x => x.expectations)))
  const turn = rec.turns[0], sub = turn.subTurns[0]
  assert.deepEqual(sub.toolCalls.map(c => c.tool), ['egdesk_read_file'])
  assert.match(sub.toolCalls[0].result.text, /3pm/); assert.equal(sub.toolCalls[0].result.success, true)
  assert.deepEqual(sub.native, { commandExecution: 0, fileChange: 0, approvals: 0 })
  assert.equal(sub.items.dynamicToolCall, 1); assert.equal(sub.items.agentMessage, 2, 'the preamble and the final message')
  assert.deepEqual(turn.posted, ['The first line says the ordering cutoff is 3pm.'], 'only the final message is posted')
  assert.deepEqual(sub.usage, { input: 23200, cached: 22900, output: 60, reasoning: 0, total: 23260 })
  assert.equal(sub.status, 'completed'); assert.ok(sub.latencyMs >= 0)
  // the engine side: one app-server, a small environment, the person's own home, ephemeral thread in the EG-Desk empty folder, own tools' switches
  assert.equal(w.spawns.length, 1); assert.deepEqual(Object.keys(w.spawns[0].options.env).sort(), ['HOME', 'PATH']); assert.equal(w.spawns[0].options.detached, true)
  noSchemaErrors(w)
  assert.equal(rec.engine.version, '0.171.0-alpha.13'); assert.equal(rec.engine.homeMode, 'person')
  const names = rec.requests.map(r => r.method)
  assert.ok(names.includes('thread/start') && names.includes('turn/start'))
  assert.ok(rec.phases.initializeMs >= 0 && rec.phases.spawnMs >= 0 && rec.phases.killed === 'SIGTERM')
  // the isolation read-back on the (fake) engine: the person's own servers, plugins, hooks and global AGENTS.md did not reach the thread
  assert.deepEqual(rec.isolation, { mcpServers: 0, mcpServersWithTools: 0, featuresNotOff: [], featuresUnreported: rec.isolation.featuresUnreported, hooks: 0, instructionSources: { total: 0, outside: 0 }, model: 'fake-model', effort: 'low' })
  assert.deepEqual(rec.mcpStartup, { starting: 0, ready: 0, failed: 0, other: 0 }, 'no MCP server of the person started')
  // files written under out: one record per conversation, a summary, owner-only folders
  assert.ok(fs.existsSync(path.join(w.out, 'records', 'real-engine-read-file-v1', 'read-file.json'))); assert.equal(readJson(path.join(w.out, 'summary.json')).ok, true)
  assert.equal(fs.statSync(path.join(w.out, 'scratch', 'read-file')).mode & 0o777, 0o700)
  assert.equal(fs.readFileSync(path.join(w.out, 'scratch', 'read-file', 'notes.txt'), 'utf8').includes('3pm'), true)
  assert.deepEqual(w.decisionCalls, [], 'no --decisions: no Decision call')
  // what the product put on the wire (the fake logged it, after checking it against the schema): ephemeral, EG-Desk's empty folder, EG-Desk's tools only
  const start = wireLog(w).find(m => m.dir === 'in' && m.method === 'thread/start').params
  assert.equal(start.ephemeral, true); assert.equal(start.sandbox, 'read-only'); assert.equal(start.approvalPolicy, 'never')
  assert.equal(start.cwd, path.join(w.out, 'data', 'read-file', 'engine-folders', 'empty'), 'the engine runs in EG-Desk\'s empty folder')
  assert.notEqual(start.cwd, path.join(w.out, 'scratch', 'read-file'))
  const toolNames = start.dynamicTools.map(tool => tool.name)
  for (const name of ['egdesk_edit_file', 'egdesk_read_file', 'egdesk_run_command', 'egdesk_search_files', 'egdesk_undo_edit']) assert.ok(toolNames.includes(name), name)
  assert.ok(toolNames.every(name => name.startsWith('egdesk_')), 'every tool the engine is given is an EG-Desk tool: ' + toolNames.join(','))
  assert.equal(start.config.features.shell_tool, false); assert.equal(start.config.features.hooks, false); assert.equal(start.config.features.plugins, false)
  assert.deepEqual(start.config.mcp_servers, { notes: { enabled: false } }); assert.deepEqual(start.config.plugins, { 'github@openai': { enabled: false } })
  assert.equal(JSON.stringify(wireLog(w)).includes(path.join(w.out, 'scratch')), false, 'the scratch folder (the real folder) never reaches the engine')
})

test('starter (b): a harmless command needs no question; a force push asks; the scripted approver says no; nothing runs', async t => {
  const fake = { turns: [
    { steps: [{ toolCall: { tool: 'egdesk_run_command', arguments: { command: 'echo hello-from-check' } } }], final: 'It printed hello-from-check.' },
    { steps: [{ toolCall: { tool: 'egdesk_run_command', arguments: { command: 'git push --force origin main' } } }], final: 'That force push needs your OK. Should I run it?' },
    { steps: [], final: 'Understood, I did not run it.' }] }
  const w = world(t, fake)
  const rec = only(await runCheck(w.options, asScripts(starter('command-approval')), w.deps))
  assert.equal(rec.aborted, null)
  assert.deepEqual(w.ranCommands, ['echo hello-from-check'], 'only the harmless command ran; the force push never reached the runner')
  const [t1, t2] = rec.turns
  assert.equal(t1.ok, true, JSON.stringify(t1.expectations)); assert.equal(t1.asked, 0)
  assert.equal(t2.ok, true, JSON.stringify(t2.expectations)); assert.equal(t2.asked, 1)
  assert.deepEqual(t2.subTurns.map(s => s.approver), [null, 'no'])
  assert.match(t2.subTurns[0].toolCalls[0].result.text, /needs_person|ask|approval/i, 'the tool result told the model it needs the person')
  assert.equal(rec.ok, true); noSchemaErrors(w)
})

test('a scripted "yes" is read by the Decision model through the egress gate and the command runs once', async t => {
  const script = { set: 'real-engine-yes-v1', conversations: [{ id: 'yes', folder: { 'README.md': 'x\n' }, turns: [
    { say: 'Run: git push --force origin main', approve: ['yes'], expect: { asked: 1, commandsRan: ['git push --force origin main'], noNativeTools: true, posted: true } }] }] }
  const fake = { turns: [
    { steps: [{ toolCall: { tool: 'egdesk_run_command', arguments: { command: 'git push --force origin main' } } }], final: 'That needs your OK. Run it?' },
    { steps: [{ toolCall: { tool: 'egdesk_run_command', arguments: { command: 'git push --force origin main' } } }], final: 'Done, it ran.' }] }
  const w = world(t, fake, { decisions: true })
  const rec = only(await runCheck(w.options, asScripts(script), w.deps))
  assert.equal(rec.aborted, null); assert.equal(rec.turns[0].ok, true, JSON.stringify(rec.turns[0].expectations))
  assert.deepEqual(w.ranCommands, ['git push --force origin main'])
  assert.ok(w.decisionCalls.some(c => c.names.includes('reply_runs_command') && c.reply === APPROVER_TEXT.yes), 'the reply was read by the Decision model')
  // decision calls are recorded as names and numbers only
  const calls = rec.turns[0].subTurns.flatMap(s => s.decisions)
  assert.ok(calls.length > 0); for (const c of calls) { assert.deepEqual(Object.keys(c).sort(), ['inputTokens', 'ms', 'names', 'p', 'status']); assert.equal(c.inputTokens, 20, 'the Decision input tokens of each call'); assert.ok(Object.values(c.p).every(v => typeof v === 'number' || typeof v === 'string')) }
  assert.doesNotMatch(JSON.stringify(rec), /egd-synthetic-not-a-key|sk-synthetic/, 'no key in any record')
  noSchemaErrors(w)
})

test('starter (c): an edit with a preview and an undo record; the undo restores the file; files are checked on disk', async t => {
  const fake = { turns: [
    { steps: [{ toolCall: { tool: 'egdesk_edit_file', arguments: { path: 'app.js', mode: 'replace', oldString: "'hello'", newString: "'hi'", dryRun: true } } },
      { toolCall: { tool: 'egdesk_edit_file', arguments: { path: 'app.js', mode: 'replace', oldString: "'hello'", newString: "'hi'" } } }], final: 'Changed hello to hi.' },
    { steps: [{ toolCall: { tool: 'egdesk_undo_edit', arguments: {} } }], final: 'Undone.' }] }
  const w = world(t, fake)
  const rec = only(await runCheck(w.options, asScripts(starter('edit-undo')), w.deps))
  assert.equal(rec.aborted, null)
  const [t1, t2] = rec.turns
  assert.equal(t1.ok, true, JSON.stringify(t1.expectations)); assert.equal(t1.undoRecords, 1)
  assert.match(t1.subTurns[0].toolCalls[0].result.text, /preview/); assert.match(t1.subTurns[0].toolCalls[1].result.text, /edited/)
  assert.equal(t2.ok, true, JSON.stringify(t2.expectations))
  assert.equal(fs.readFileSync(path.join(w.out, 'scratch', 'edit-undo', 'app.js'), 'utf8'), "const greeting = 'hello'\nmodule.exports = { greeting }\n")
  assert.deepEqual(w.ranCommands, []); noSchemaErrors(w)
})

test('c23: the engine that refuses edits "because the filesystem is read-only" (Main\'s check-1 on 0.171) edits through egdesk_edit_file once it is told what the tools are', async t => {
  const fake = { refuseEditsUnlessInstructed: true, turns: [
    { steps: [{ toolCall: { tool: 'egdesk_edit_file', arguments: { path: 'app.js', mode: 'replace', oldString: "'hello'", newString: "'hi'", dryRun: true } } },
      { toolCall: { tool: 'egdesk_edit_file', arguments: { path: 'app.js', mode: 'replace', oldString: "'hello'", newString: "'hi'" } } }], final: 'Changed hello to hi.' },
    { steps: [{ toolCall: { tool: 'egdesk_undo_edit', arguments: {} } }], final: 'Undone.' }] }
  const w = world(t, fake)
  const rec = only(await runCheck(w.options, asScripts(starter('edit-undo')), w.deps))
  assert.equal(rec.aborted, null); assert.equal(rec.ok, true, JSON.stringify(rec.turns.map(x => x.expectations)))
  const start = wireLog(w).find(m => m.dir === 'in' && m.method === 'thread/start').params
  assert.match(start.developerInstructions, /egdesk_edit_file/); assert.equal(start.config.include_permissions_instructions, false)
  // the control: the same fake and script through the thread/start of the product before c23 refuses, and the check reports a failed turn
  const bare = world(t, fake, { downgrade: true })
  const old = only(await runCheck(bare.options, asScripts(starter('edit-undo')), bare.deps))
  assert.equal(old.ok, false); assert.equal(old.turns[0].expectations.find(c => c.check === 'toolCalls').ok, false)
  assert.match(old.turns[0].posted.at(-1), /filesystem permissions are read-only/)
  assert.equal(fs.readFileSync(path.join(bare.out, 'scratch', 'edit-undo', 'app.js'), 'utf8').includes("'hello'"), true, 'nothing was changed')
})

test('a native command or file change is declined by the runtime and the check reports it (noNativeTools fails)', async t => {
  const script = { set: 'real-engine-native-v1', conversations: [{ id: 'native', turns: [{ say: 'List the files', expect: { noNativeTools: true } }] }] }
  const fake = { turns: [{ steps: [{ nativeCommand: { command: 'rm -rf src' } }], final: 'I could not run it.' }] }
  const w = world(t, fake)
  const rec = only(await runCheck(w.options, asScripts(script), w.deps))
  const sub = rec.turns[0].subTurns[0]
  assert.equal(sub.native.commandExecution, 1); assert.equal(sub.native.approvals, 1)
  assert.equal(rec.turns[0].expectations[0].ok, false); assert.equal(rec.ok, false)
  assert.equal(sub.items.commandExecution, 1)
  assert.deepEqual(w.ranCommands, [], 'declined, never run'); noSchemaErrors(w)
})

test('compaction, token usage and an error turn are recorded; an error turn does not stop the conversation', async t => {
  const script = { set: 'real-engine-errors-v1', conversations: [{ id: 'errors', turns: [
    { say: 'first', expect: { compacted: true, turnStatus: 'completed', posted: true } },
    { say: 'second', expect: { turnStatus: 'failed', posted: false } },
    { say: 'third', expect: { turnStatus: 'completed', answerIncludes: ['back'] } }] }] }
  const fake = { turns: [
    { steps: [{ compaction: true }, { usage: { input: 5000, cached: 4000, output: 10, reasoning: 0 } }], final: 'compacted and answered' },
    { steps: [{ errorNotification: 'the model request failed' }], status: 'failed', error: 'the model request failed' },
    { steps: [], final: 'I am back.' }] }
  const w = world(t, fake)
  const rec = only(await runCheck(w.options, asScripts(script), w.deps))
  assert.equal(rec.aborted, null); assert.equal(rec.turns.length, 3)
  assert.equal(rec.turns[0].subTurns[0].compacted, true); assert.equal(rec.turns[0].subTurns[0].items.contextCompaction, 1); assert.equal(rec.turns[0].subTurns[0].usage.cached, 4000)
  assert.equal(rec.turns[1].subTurns[0].status, 'failed'); assert.match(rec.turns[1].subTurns[0].error, /model request failed/); assert.deepEqual(rec.turns[1].subTurns[0].errors, ['the model request failed'])
  for (const x of rec.turns) assert.equal(x.ok, true, JSON.stringify(x.expectations))
  noSchemaErrors(w)
})

test('a thread the engine does not report as ephemeral ends the conversation; a thread/start without ephemeral is refused before it is sent', async t => {
  const script = { set: 'real-engine-eph-v1', conversations: [{ id: 'eph', turns: [{ say: 'hi', expect: { posted: true } }, { say: 'again', expect: { posted: true } }] }] }
  const w = world(t, { reportEphemeral: false, turns: [{ steps: [], final: 'x' }, { steps: [], final: 'y' }] })
  const rec = only(await runCheck(w.options, asScripts(script), w.deps))
  assert.equal(rec.aborted, 'thread_not_ephemeral'); assert.equal(rec.ok, false); assert.ok(rec.turns.length < 2, 'the second turn never ran')
})

test('--codex-home: the engine must report that very home, otherwise the conversation ends before any thread', async t => {
  const script = { set: 'real-engine-home-v1', conversations: [{ id: 'home', turns: [{ say: 'hi' }] }] }
  const good = world(t, { turns: [{ steps: [], final: 'x' }] }, { home: { kind: 'dir' } })
  const ok = only(await runCheck(good.options, asScripts(script), good.deps))
  assert.equal(ok.engine.homeMatchesFlag, true); assert.equal(good.spawns[0].options.env.CODEX_HOME, good.codexHome)
  const bad = world(t, { home: '/some/other/.codex', turns: [{ steps: [], final: 'x' }] }, { home: { kind: 'dir' } })
  const refused = only(await runCheck(bad.options, asScripts(script), bad.deps))
  assert.equal(refused.aborted, 'home_mismatch'); assert.equal(refused.engine.homeMatchesFlag, false); assert.equal(refused.turns.length, 0)
  assert.deepEqual(refused.requests.map(r => r.method), [], 'no thread was started')
})

test('the person\'s own MCP servers, plugins and instruction files do not reach an own-tools thread (the fake honours the documented keys)', async t => {
  const script = { set: 'real-engine-iso-v1', conversations: [{ id: 'iso', turns: [{ say: 'hi', expect: { posted: true } }] }] }
  const person = { mcpServers: [{ name: 'notes', tools: ['search'] }, { name: 'drive', tools: ['read'] }, { name: 'gh', pluginId: 'github@openai', tools: ['pr'] }], hooks: 3, features: { hooks: true, memories: true, apps: true }, instructionSources: ['/person/.codex/AGENTS.md'] }
  const w = world(t, { person, turns: [{ steps: [], final: 'ok' }] })
  const rec = only(await runCheck(w.options, asScripts(script), w.deps))
  assert.equal(rec.isolation.mcpServers, 0); assert.equal(rec.isolation.hooks, 0); assert.deepEqual(rec.isolation.instructionSources, { total: 0, outside: 0 })
  assert.deepEqual(rec.mcpStartup, { starting: 0, ready: 0, failed: 0, other: 0 })
  // control: the same person's setup with nothing disabled does start its servers and reports them (the check can see a leak)
  const leaky = world(t, { person, ignoreConfig: true, turns: [{ steps: [], final: 'ok' }] })
  const seen = only(await runCheck(leaky.options, asScripts(script), leaky.deps))
  assert.equal(seen.isolation.mcpServers, 3); assert.equal(seen.isolation.mcpServersWithTools, 3); assert.equal(seen.isolation.hooks, 3)
  assert.deepEqual(seen.isolation.instructionSources, { total: 1, outside: 1 })
  assert.deepEqual(seen.mcpStartup, { starting: 3, ready: 3, failed: 0, other: 0 })
})

test('the composition reproduces the bridge: every decisionContext key, runtime option and developer flag of codex-bridge-server.mjs is covered or listed as not reproduced', () => {
  const bridge = fs.readFileSync(path.join(here, 'codex-bridge-server.mjs'), 'utf8')
  const start = bridge.indexOf('  decisionContext: {'), end = bridge.indexOf('\n  },\n})', start)
  assert.ok(start > 0 && end > start, 'the bridge\'s decisionContext block was found')
  const block = bridge.slice(start, end)
  const keys = new Set([...block.matchAll(/^ {4}(?:\.\.\.\([^\n]*?\{ ([a-zA-Z]+)[:,]|get ([a-zA-Z]+)\(\)|([a-zA-Z]+)[:,])/gm)].map(m => m[1] ?? m[2] ?? m[3]))
  const covered = new Set([...BRIDGE_COMPOSITION.keys, ...BRIDGE_COMPOSITION.notReproduced.keys])
  for (const key of keys) assert.ok(covered.has(key), `the bridge's decisionContext has "${key}" and the real-engine check neither reproduces nor lists it`)
  // the runtime's own options (the lines between "new CodexChatRuntime({" and "decisionContext: {")
  const open = bridge.indexOf('const chat = new CodexChatRuntime({'), runtimeBlock = bridge.slice(open, start)
  const runtimeKeys = new Set([...runtimeBlock.matchAll(/^ {2}(?:\.\.\.\(([a-zA-Z]+)|([a-zA-Z]+)[:,])/gm)].map(m => m[1] ?? m[2]))
  assert.ok(runtimeKeys.size >= 10, 'the runtime options were found: ' + [...runtimeKeys].join(','))
  const coveredRuntime = new Set([...BRIDGE_COMPOSITION.runtimeKeys, ...BRIDGE_COMPOSITION.notReproduced.runtimeKeys])
  for (const key of runtimeKeys) assert.ok(coveredRuntime.has(key), `the bridge passes "${key}" to CodexChatRuntime and the real-engine check neither reproduces nor lists it`)
  // every developer flag the bridge file reads, wherever it reads it
  const flags = new Set([...bridge.matchAll(/process\.env\.(EGDESK_[A-Z0-9_]+)/g)].map(m => m[1]))
  const coveredFlags = new Set([...BRIDGE_COMPOSITION.flags, ...BRIDGE_COMPOSITION.notReproduced.flags])
  for (const flag of flags) assert.ok(coveredFlags.has(flag), `the bridge reads ${flag}; the real-engine check does not list it`)
  // the lists carry nothing the bridge does not have (a stale entry would hide a missing one)
  for (const key of BRIDGE_COMPOSITION.notReproduced.keys) assert.ok(keys.has(key) || block.includes(key), 'stale entry: ' + key)
  for (const key of BRIDGE_COMPOSITION.notReproduced.runtimeKeys) assert.ok(runtimeKeys.has(key), 'stale entry: ' + key)
  // the warm-up flag is read in the helper the bridge calls, not in the bridge file
  assert.match(bridge, /warmupConfigFromEnv\(process\.env\)/)
  assert.match(bridge, /createOwnToolsWiring\(/)
})

test('a turn that does not finish in time is interrupted once and ends the conversation; nothing is retried', async t => {
  const script = { set: 'real-engine-slow-v1', conversations: [{ id: 'slow', turns: [{ say: 'slow', expect: { turnStatus: 'completed' } }, { say: 'never sent' }] }] }
  const w = world(t, { turns: [{ steps: [{ delayMs: 500 }], final: 'late' }] })
  w.options.turnTimeoutMs = 150
  const rec = only(await runCheck(w.options, asScripts(script), w.deps))
  assert.equal(rec.aborted, 'turn_timeout'); assert.equal(rec.ok, false); assert.equal(rec.turns.length, 1)
  assert.equal(rec.turns[0].subTurns[0].status, 'timeout'); assert.equal(rec.turns[0].ok, false)
  assert.equal(wireLog(w).filter(m => m.dir === 'in' && m.method === 'turn/interrupt').length, 1)
  assert.equal(wireLog(w).filter(m => m.dir === 'in' && m.method === 'turn/start').length, 1, 'no retry, no second turn')
  await new Promise(resolve => setTimeout(resolve, 700)) // the fake's own delayed turn ends before the temp folder goes
})

test('a binary that exits at once ends the conversation with a closed code and records its stderr tail', async t => {
  const w = world(t, { turns: [] })
  w.deps.spawn = () => {
    const child = new EventEmitter()
    Object.assign(child, { pid: 1, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => true })
    setImmediate(() => { child.stderr.write('not a codex\n'); child.exitCode = 2; child.emit('close', 2, null) })
    return child
  }
  const rec = only(await runCheck(w.options, asScripts({ set: 'real-engine-exit-v1', conversations: [{ id: 'exit', turns: [{ say: 'hi' }] }] }), w.deps))
  assert.equal(rec.aborted, 'engine_exited'); assert.equal(rec.ok, false); assert.equal(rec.turns.length, 0); assert.match(rec.engineStderrTail, /not a codex/)
})

// ---- messages typed into a working run (whileRunning; lane L2's inRunMessageTo, flag EGDESK_INRUN_MESSAGES) ----
test('whileRunning: the validator needs the flag, a previous turn, no approve and no chain', () => {
  const base = () => ({ set: 'real-engine-w-v1', conversations: [{ id: 'c', flags: { EGDESK_INRUN_MESSAGES: 'on' }, turns: [{ say: 'a' }, { say: 'b', whileRunning: { afterMs: 100 }, expect: { posted: true } }] }] })
  assert.deepEqual(validateEngineScript(base()), { ok: true, errors: [] })
  const bad = (mutate, pattern) => { const v = base(); mutate(v); const r = validateEngineScript(v); assert.equal(r.ok, false); assert.match(r.errors.join('\n'), pattern) }
  bad(v => { delete v.conversations[0].flags }, /needs flags\.EGDESK_INRUN_MESSAGES/)
  bad(v => { v.conversations[0].flags.EGDESK_INRUN_MESSAGES = 'off' }, /needs flags/)
  bad(v => { v.conversations[0].turns.reverse() }, /cannot be the first turn/)
  bad(v => { v.conversations[0].turns.push({ say: 'c', whileRunning: { afterMs: 5 } }) }, /cannot follow another whileRunning/)
  bad(v => { v.conversations[0].turns[1].approve = ['no'] }, /takes no approve/)
  bad(v => { v.conversations[0].turns[1].whileRunning = { afterMs: -1 } }, /afterMs/)
  bad(v => { v.conversations[0].turns[1].whileRunning = { afterMs: 120001 } }, /afterMs/)
  bad(v => { v.conversations[0].turns[1].whileRunning = { afterMs: 5, extra: 1 } }, /unknown key/)
  bad(v => { v.conversations[0].turns[1].whileRunning = 5 }, /an object/)
  assert.equal(REAL_ENGINE_SCRIPT_SCHEMA.properties.conversations.items.properties.turns.items.properties.whileRunning.properties.afterMs.maximum, 120000)
})

const WHILE = { set: 'real-engine-while-v1', conversations: [{ id: 'while', flags: { EGDESK_INRUN_MESSAGES: 'on' }, folder: { 'README.md': 'x\n' }, turns: [
  { say: 'Run the tests: npm test', expect: { toolCalls: ['egdesk_run_command'], commandsRan: ['npm test'], turnStatus: 'completed', answerIncludes: ['passed'], noNativeTools: true } },
  { say: 'Where are you with it?', whileRunning: { afterMs: 60 }, expect: { posted: true, noNativeTools: true } }] }] }

test('whileRunning: the second message goes into the working run (no new turn), both turns are awaited and each keeps its own expectations', async t => {
  const fake = { turns: [{ steps: [{ delayMs: 1500 }, { toolCall: { tool: 'egdesk_run_command', arguments: { command: 'npm test' } } }], final: 'The tests passed.' }] }
  const w = world(t, fake)
  w.deps.inspectNative = () => ({ version: '0.171.0-alpha.13', schemaMatch: false, boardPeerContract: null })
  const rec = only(await runCheck(w.options, asScripts(WHILE), w.deps))
  assert.equal(rec.aborted, null); assert.equal(rec.turns.length, 2)
  const [first, second] = rec.turns
  assert.equal(first.ok, true, JSON.stringify(first.expectations)); assert.equal(first.subTurns[0].status, 'completed', 'the working turn was not interrupted')
  assert.deepEqual(first.subTurns[0].commandsRan, ['npm test'])
  assert.equal(second.ok, true, JSON.stringify(second.expectations)); assert.deepEqual(second.whileRunning, { afterMs: 60 })
  assert.equal(second.subTurns[0].accepted, true); assert.equal(second.expectations[0].check, 'sent_while_running'); assert.ok(second.subTurns[0].sentAtMs >= 60 && second.subTurns[0].sentAtMs < 1500, 'sent ' + second.subTurns[0].sentAtMs + ' ms after the first turn started')
  assert.match(second.posted.at(-1), /tests passed/, 'the messages after it was sent include the run\'s own answer')
  assert.equal(wireLog(w).filter(m => m.dir === 'in' && m.method === 'turn/start').length, 1, 'the message typed into the run started no turn of its own')
  assert.deepEqual(rec.engine.nativeContract, { version: '0.171.0-alpha.13', schemaMatch: false, boardPeerContract: false, steerContract: false, threadDelete: false }, 'no steer contract on this (stubbed) binary')
  noSchemaErrors(w)
})

test('whileRunning: a run that ended before afterMs no longer takes the message; the turn fails its implicit check with the runtime\'s closed code', async t => {
  const late = structuredClone(WHILE); late.conversations[0].turns[1].whileRunning.afterMs = 500
  const w = world(t, { turns: [{ steps: [{ toolCall: { tool: 'egdesk_run_command', arguments: { command: 'npm test' } } }], final: 'The tests passed.' }] })
  w.deps.inspectNative = () => ({ version: '0.171.0-alpha.13', schemaMatch: true, boardPeerContract: 'c'.repeat(64) })
  // Timing-robust (c27): "the run ended before afterMs" is made true by EVENTS, not by the wall clock. The wait for afterMs (the check's injectable sleep) ends only once the
  // first turn's run is over, however slow the machine is; a loaded machine used to leave the fake's turn still running at 500 ms and the message was (rightly) taken.
  let chatOf = null
  w.deps.extensions = [{ name: 'chat-ref', setup: ctx => { chatOf = ctx.chat; return {} } }]
  // the run must exist (the send is still on its way on a slow machine) AND be over; the seam is asked even when afterMs has passed already
  const ended = () => { const runs = [...chatOf.runs.values()]; return runs.length > 0 && runs.every(r => r.status !== 'inProgress') }
  w.deps.sleep = async () => { const end = Date.now() + 60_000; while (Date.now() < end && !ended()) await new Promise(resolve => setTimeout(resolve, 2)) }
  const rec = only(await runCheck(w.options, asScripts(late), w.deps))
  assert.ok([...chatOf.runs.values()].every(r => r.status === 'completed'), 'the first run had ended when the message was sent')
  const second = rec.turns[1]
  assert.equal(second.ok, false); assert.equal(second.subTurns[0].accepted, false); assert.equal(second.subTurns[0].error, 'INRUN_MESSAGE_UNAVAILABLE')
  assert.deepEqual(second.expectations[0], { check: 'sent_while_running', ok: false, detail: { afterMs: 500, sentAtMs: second.expectations[0].detail.sentAtMs, error: 'INRUN_MESSAGE_UNAVAILABLE' } })
  assert.equal(rec.turns[0].ok, true, 'the first turn is judged on its own record'); assert.equal(rec.ok, false)
  assert.equal(rec.engine.nativeContract.boardPeerContract, true)
})

// ---- action turns: interrupt, steer, delete (c23; field names agreed with lane L3) ----
test('action turns: the validator takes interrupt, steer and delete with their own rules', () => {
  const base = turns => ({ set: 'real-engine-a-v1', conversations: [{ id: 'c', turns }] })
  const errors = turns => validateEngineScript(base(turns)).errors.join('\n')
  for (const turns of [[{ say: 'a' }, { action: 'interrupt', afterMs: 100 }], [{ say: 'a' }, { action: 'steer', say: 'b', afterMs: 5 }], [{ say: 'a' }, { action: 'delete', expect: { conversationGone: true } }, { say: 'b' }], [{ say: 'a' }, { action: 'interrupt' }]]) assert.equal(errors(turns), '')
  assert.match(errors([{ action: 'delete' }]), /cannot be the first turn/)
  assert.match(errors([{ say: 'a' }, { action: 'steer' }]), /steer needs a string/)
  assert.match(errors([{ say: 'a' }, { action: 'interrupt', say: 'x' }]), /interrupt takes no say/)
  assert.match(errors([{ say: 'a' }, { action: 'delete', say: 'x' }]), /delete takes no say/)
  assert.match(errors([{ say: 'a' }, { action: 'delete', afterMs: 1 }]), /delete takes no afterMs/)
  assert.match(errors([{ say: 'a' }, { action: 'interrupt', afterMs: 120001 }]), /afterMs/)
  assert.match(errors([{ say: 'a' }, { action: 'pause' }]), /one of interrupt, steer, delete, restart/)
  assert.match(errors([{ say: 'a', afterMs: 3 }]), /only an interrupt or steer action takes afterMs/)
  assert.match(errors([{ say: 'a' }, { action: 'delete', approve: ['no'] }]), /takes no approve/)
  assert.match(errors([{ say: 'a' }, { action: 'interrupt', whileRunning: { afterMs: 1 } }]), /not also a whileRunning/)
  assert.match(errors([{ say: 'a' }, { action: 'interrupt' }, { action: 'steer', say: 'b' }]), /must follow a plain message turn/)
  assert.match(errors([{ say: 'a' }, { action: 'interrupt' }, { say: 'b', whileRunning: { afterMs: 1 } }]), /cannot follow an action turn/)
  assert.match(errors([{ say: 'a' }, { say: 'b' }, { expect: {} }]), /say/)
  assert.deepEqual(REAL_ENGINE_SCRIPT_SCHEMA.properties.conversations.items.properties.turns.items.properties.action.enum, ['interrupt', 'steer', 'delete', 'restart'])
  // the new expectations
  assert.equal(checkTurnExpectations({ commandsRanIncludes: ['a.txt', 'b'], commandsRanExcludes: ['rm'] }, { commandsRan: ['cat a.txt && echo b'] }).every(c => c.ok), true, 'substrings, for a model that batches commands')
  assert.equal(checkTurnExpectations({ commandsRanIncludes: ['zzz'] }, { commandsRan: ['ls'] })[0].ok, false)
  assert.equal(checkTurnExpectations({ commandsRanExcludes: ['push'] }, { commandsRan: ['git push origin'] })[0].ok, false)
  assert.equal(checkTurnExpectations({ conversationGone: true }, { conversationGone: true })[0].ok, true)
  assert.equal(checkTurnExpectations({ conversationGone: true }, {})[0].ok, false)
})

const SLOW = { set: 'real-engine-slow-actions-v1', conversations: [{ id: 'slow-actions', folder: { 'README.md': 'x\n' }, turns: [
  { say: 'Do the long job', expect: { turnStatus: 'interrupted', posted: false } },
  { action: 'interrupt', afterMs: 80, expect: { noNativeTools: true } }] }] }

test('interrupt action: the person presses stop on the working run; the engine ends it as interrupted and nothing partial is posted', async t => {
  const w = world(t, { turns: [{ steps: [{ delayMs: 2000 }], final: 'The job is done.' }] })
  const started = performance.now()
  const rec = only(await runCheck(w.options, asScripts(SLOW), w.deps))
  assert.ok(performance.now() - started < 1800, 'the run did not go on to its end')
  assert.equal(rec.aborted, null); assert.equal(rec.turns.length, 2)
  const [first, second] = rec.turns
  assert.equal(first.subTurns[0].status, 'interrupted'); assert.equal(first.ok, true, JSON.stringify(first.expectations)); assert.deepEqual(first.posted, [])
  assert.equal(second.action, 'interrupt'); assert.equal(second.subTurns[0].accepted, true); assert.equal(second.expectations[0].check, 'action_taken'); assert.equal(second.ok, true, JSON.stringify(second.expectations))
  assert.ok(second.subTurns[0].sentAtMs >= 80)
  assert.equal(wireLog(w).filter(m => m.dir === 'in' && m.method === 'turn/interrupt').length, 1)
  assert.equal(rec.ok, true); noSchemaErrors(w)
})

const STEER = { set: 'real-engine-steer-v1', conversations: [{ id: 'steer', folder: { 'plan.md': 'a\nb\n' }, turns: [
  { say: 'Read plan.md and summarise it', expect: { answerIncludes: ['only the names'], turnStatus: 'completed', posted: true } },
  { action: 'steer', say: 'Only give me the names', afterMs: 80, expect: { posted: true } }] }] }

test('steer action: a plain turn/steer into the working turn through the product\'s adapter with the binary\'s steer contract; no contract, no steer', async t => {
  const fake = { turns: [{ steps: [{ delayMs: 300 }], final: 'a long summary', steerFinal: 'only the names: a, b' }] }
  const w = world(t, fake)
  w.deps.inspectNative = () => ({ version: '0.171.0-alpha.13', schemaMatch: false, boardPeerContract: null, steerContract: 'd'.repeat(64) })
  const rec = only(await runCheck(w.options, asScripts(STEER), w.deps))
  assert.equal(rec.aborted, null)
  const [first, second] = rec.turns
  assert.equal(second.action, 'steer'); assert.equal(second.subTurns[0].accepted, true, JSON.stringify(second.subTurns)); assert.equal(second.ok, true, JSON.stringify(second.expectations))
  assert.equal(first.ok, true, JSON.stringify(first.expectations)); assert.equal(first.subTurns[0].status, 'completed'); assert.equal(first.subTurns[0].items.userMessage, 2, 'the steer text appears as a user message inside the running turn')
  const steer = wireLog(w).find(m => m.dir === 'in' && m.method === 'turn/steer').params
  const turnId = wireLog(w).find(m => m.dir === 'out' && m.result?.turn?.id)?.result.turn.id
  assert.ok(turnId); assert.equal(steer.expectedTurnId, turnId, 'the steer names the running turn'); assert.equal(steer.input[0].text, 'Only give me the names'); assert.match(steer.clientUserMessageId, /^steer-/)
  assert.equal(wireLog(w).filter(m => m.dir === 'in' && m.method === 'turn/start').length, 1, 'a steer starts no turn')
  assert.deepEqual(rec.engine.nativeContract, { version: '0.171.0-alpha.13', schemaMatch: false, boardPeerContract: false, steerContract: true, threadDelete: false })
  noSchemaErrors(w)
  // a binary without the capability: the product refuses with no proof, the check says so, the turn itself still completes
  const none = world(t, fake)
  none.deps.inspectNative = () => ({ version: '0.171.0-alpha.13', schemaMatch: false, boardPeerContract: null, steerContract: null })
  const refused = only(await runCheck(none.options, asScripts(STEER), none.deps))
  assert.equal(refused.turns[1].ok, false); assert.equal(refused.turns[1].subTurns[0].error, 'no_steer_contract'); assert.equal(refused.turns[1].expectations[0].check, 'action_taken')
  assert.equal(wireLog(none).filter(m => m.dir === 'in' && m.method === 'turn/steer').length, 0, 'nothing was sent')
  assert.equal(refused.turns[0].subTurns[0].status, 'completed')
  assert.equal(refused.turns[0].ok, false, 'the first turn expected the steered answer')
})

test('delete action: the conversation is forgotten; the next message turn starts a new one (new thread, nothing remembered)', async t => {
  const script = { set: 'real-engine-delete-v1', conversations: [{ id: 'del', turns: [
    { say: 'remember this', expect: { posted: true, turnStatus: 'completed' } },
    { action: 'delete', expect: { conversationGone: true } },
    { say: 'what did I say?', expect: { posted: true, answerIncludes: ['nothing'] } }] }] }
  const w = world(t, { turns: [{ steps: [], final: 'ok, noted' }, { steps: [], final: 'nothing yet' }] })
  w.deps.inspectNative = () => ({ version: '0.171.0-alpha.13', schemaMatch: false, boardPeerContract: null, steerContract: null, threadDelete: false })
  const rec = only(await runCheck(w.options, asScripts(script), w.deps))
  assert.equal(rec.aborted, null); assert.equal(rec.turns.length, 3)
  const [, del, third] = rec.turns
  assert.equal(del.action, 'delete'); assert.equal(del.subTurns[0].conversationGone, true); assert.equal(del.subTurns[0].summary.stored, false); assert.equal(del.ok, true, JSON.stringify(del.expectations))
  assert.deepEqual(del.subTurns[0].summary.engineHistory, [{ state: 'remains', reason: 'unsupported' }], 'this binary has no thread/delete: the engine keeps its (ephemeral) thread')
  assert.equal(third.ok, true, JSON.stringify(third.expectations)); assert.deepEqual(third.posted, ['nothing yet'])
  assert.equal(wireLog(w).filter(m => m.dir === 'in' && m.method === 'thread/start').length, 2, 'two native threads: the new conversation is a new thread')
  assert.equal(rec.ok, true); noSchemaErrors(w)
})

test('extensions: one small registration point; a module sees the composed runtime, every turn record and the end; a broken one never changes the verdict', async t => {
  const seen = []
  const good = { name: 'stub-good', setup: ctx => { seen.push(['setup', Object.keys(ctx).sort()]); return { afterTurn: (record, info) => seen.push(['turn', record.index, info.index]), finish: () => ({ turns: seen.filter(x => x[0] === 'turn').length }) } } }
  const broken = { name: 'stub-broken', setup: () => ({ afterTurn: () => { throw Object.assign(new Error('boom'), { code: 'EXT_BOOM' }) } }) }
  const failing = { name: 'stub-setup-fails', setup: () => { throw new Error('no setup') } }
  const script = { set: 'real-engine-ext-v1', conversations: [{ id: 'ext', turns: [{ say: 'one', expect: { posted: true } }, { say: 'two', expect: { posted: true } }] }] }
  const w = world(t, { turns: [{ steps: [], final: 'a' }, { steps: [], final: 'b' }] })
  w.deps.extensions = [good, broken, failing]
  const rec = only(await runCheck(w.options, asScripts(script), w.deps))
  assert.equal(rec.ok, true, 'the extensions did not change the verdict')
  assert.deepEqual(seen.filter(x => x[0] === 'turn'), [['turn', 1, 0], ['turn', 2, 1]])
  assert.deepEqual(seen[0][1], ['calibrationLog', 'chat', 'client', 'conversation', 'dataDir', 'flags', 'options', 'rec', 'request', 'scratch', 'store', 'wiring'])
  assert.deepEqual(rec.extensions['stub-good'], { turns: 2 }); assert.deepEqual(rec.extensions['stub-broken'], { error: 'EXT_BOOM' }); assert.deepEqual(rec.extensions['stub-setup-fails'], { error: 'no setup' })
  const plain = world(t, { turns: [{ steps: [], final: 'a' }, { steps: [], final: 'b' }] })
  assert.equal(only(await runCheck(plain.options, asScripts(script), plain.deps)).extensions, undefined, 'no extension: nothing added to the record')
})

test('EG-Desk\'s own model and effort (env) are what an own-tools thread runs with when nothing in the request names one; --model and --effort win', async t => {
  const script = { set: 'real-engine-own-model-v1', conversations: [{ id: 'own-model', turns: [{ say: 'hi', expect: { posted: true } }] }] }
  const turnParams = w => wireLog(w).find(m => m.dir === 'in' && m.method === 'turn/start').params
  const w = world(t, { turns: [{ steps: [], final: 'a' }] })
  w.deps.env = { ...w.deps.env, EGDESK_CODEX_MODEL: 'egdesk-model', EGDESK_CODEX_EFFORT: 'low' }
  assert.equal(only(await runCheck(w.options, asScripts(script), w.deps)).ok, true)
  assert.equal(turnParams(w).model, 'egdesk-model'); assert.equal(turnParams(w).effort, 'low')
  assert.equal(wireLog(w).find(m => m.dir === 'in' && m.method === 'thread/start').params.model, 'egdesk-model')
  const asked = world(t, { turns: [{ steps: [], final: 'a' }] }, { model: 'asked-model', effort: 'high' })
  asked.deps.env = { ...asked.deps.env, EGDESK_CODEX_MODEL: 'egdesk-model', EGDESK_CODEX_EFFORT: 'low' }
  assert.equal(only(await runCheck(asked.options, asScripts(script), asked.deps)).ok, true)
  assert.equal(turnParams(asked).model, 'asked-model'); assert.equal(turnParams(asked).effort, 'high')
  const none = world(t, { turns: [{ steps: [], final: 'a' }] })
  assert.equal(only(await runCheck(none.options, asScripts(script), none.deps)).ok, true)
  assert.equal(turnParams(none).model, undefined, 'nothing configured by EG-Desk: the engine\'s own default (reported as a gap)')
})

// ---- c24: persisted threads with cleanup, fresh internal threads, records, the draft-check opt-in ----
const ONE = { set: 'real-engine-one-v1', conversations: [{ id: 'one', turns: [{ say: 'hello', expect: { posted: true } }] }] }
const withDelete = (w, extra = {}) => { w.options.persisted = true; w.deps.inspectNative = () => ({ version: '0.171.0-alpha.13', schemaMatch: false, boardPeerContract: null, steerContract: null, threadDelete: true, ...extra }); return w }
const callsOf = (w, method) => wireLog(w).filter(m => m.dir === 'in' && m.method === method)
const internalProbe = (results = []) => ({ name: 'probe', setup: ctx => ({ afterTurn: async () => { const run = ctx.chat.runFor([...ctx.chat.runs.values()].at(-1)); results.push(await ctx.chat.internalText(run, 'Say the word ok', { timeoutMs: 4000 })) } }) })

test('--persisted-with-cleanup: persisted threads, each one deleted and verified gone at the end of its conversation; the ledger says so', async t => {
  const w = withDelete(world(t, { turns: [{ steps: [], final: 'hi' }] }))
  const rec = only(await runCheck(w.options, asScripts(ONE), w.deps))
  assert.equal(rec.ok, true, JSON.stringify(rec.turns.map(x => x.expectations)))
  assert.deepEqual(rec.cleanup, { persisted: 1, deleted: 1, alreadyGone: 0, verifiedGone: 1, failures: [], ephemeral: 0 })
  const start = callsOf(w, 'thread/start')[0].params
  assert.equal('ephemeral' in start && start.ephemeral === true, false, 'the thread is persisted')
  assert.deepEqual(callsOf(w, 'thread/delete').map(m => m.params), [{ threadId: 'thr-1' }])
  const log = wireLog(w), del = log.findIndex(m => m.dir === 'in' && m.method === 'thread/delete'), resume = log.findIndex(m => m.dir === 'in' && m.method === 'thread/resume')
  assert.ok(del > 0 && resume > del, 'delete first, then the verification')
  const ledger = createLedger(w.out)
  assert.deepEqual(ledger.read().map(e => [e.op, e.id]), [['created', 'thr-1'], ['deleted', 'thr-1'], ['gone', 'thr-1']])
  assert.deepEqual(leftoverThreads(ledger.read()), []); assert.equal(fs.statSync(path.join(w.out, LEDGER_FILE)).mode & 0o777, 0o600)
  assert.equal(readJson(path.join(w.out, 'summary.json')).conversations[0].cleanup.verifiedGone, 1)
  noSchemaErrors(w)
})

test('the default stays ephemeral-only: no ledger, no cleanup, no thread/delete', async t => {
  const w = world(t, { turns: [{ steps: [], final: 'hi' }] })
  const rec = only(await runCheck(w.options, asScripts(ONE), w.deps))
  assert.equal(rec.ok, true); assert.equal(rec.cleanup, undefined); assert.equal(callsOf(w, 'thread/delete').length, 0)
  assert.equal(fs.existsSync(path.join(w.out, LEDGER_FILE)), false); assert.equal(callsOf(w, 'thread/start')[0].params.ephemeral, true)
})

test('persisted mode refuses to start when cleanup cannot be guaranteed: no thread/delete in the binary, or threads left by an earlier run', async t => {
  const none = withDelete(world(t, { turns: [] }), { threadDelete: false })
  await assert.rejects(runCheck(none.options, asScripts(ONE), none.deps), { code: 'cleanup_not_guaranteed' })
  assert.equal(none.spawns.length, 0, 'nothing was started')
  assert.equal(fs.existsSync(path.join(none.out, 'scratch')), false)
  const unreadable = withDelete(world(t, { turns: [] })); unreadable.deps.inspectNative = () => { throw new Error('cannot read the schema') }
  await assert.rejects(runCheck(unreadable.options, asScripts(ONE), unreadable.deps), { code: 'cleanup_not_guaranteed' })
  const left = withDelete(world(t, { turns: [] }))
  createLedger(left.out).append({ op: 'created', id: 'thr-old', via: 'thread/start', ephemeral: false })
  await assert.rejects(runCheck(left.options, asScripts(ONE), left.deps), error => error.code === 'cleanup_not_guaranteed' && /--cleanup-leftovers/.test(error.message) && error.leftovers.join() === 'thr-old')
  assert.equal(left.spawns.length, 0)
  assert.doesNotThrow(() => assertCleanupGuaranteed({ persisted: false, out: left.out }, {}), 'ephemeral mode needs no guarantee')
})

test('a failed delete or a thread that is still resumable fails the conversation loudly and leaves the ledger dirty; --cleanup-leftovers then removes it', async t => {
  const stubborn = withDelete(world(t, { deleteIgnored: true, turns: [{ steps: [], final: 'hi' }] }))
  const rec = only(await runCheck(stubborn.options, asScripts(ONE), stubborn.deps))
  assert.equal(rec.ok, false); assert.equal(rec.cleanupFailed, true); assert.deepEqual(rec.cleanup.failures, [{ id: 'thr-1', step: 'verify', error: 'still_resumable' }])
  assert.deepEqual(leftoverThreads(createLedger(stubborn.out).read()), ['thr-1'], 'the ledger still lists it')
  assert.equal(readJson(path.join(stubborn.out, 'summary.json')).ok, false)
  const broken = withDelete(world(t, { deleteFails: true, turns: [{ steps: [], final: 'hi' }] }))
  const bad = only(await runCheck(broken.options, asScripts(ONE), broken.deps))
  assert.deepEqual(bad.cleanup.failures.map(f => f.step).sort(), ['delete', 'verify']); assert.equal(bad.ok, false)
  // the next start is refused until the leftovers are gone; the cleanup starts one app-server on the same home and verifies each thread gone
  const again = withDelete(world(t, { turns: [] })); again.options.out = stubborn.out
  await assert.rejects(runCheck(again.options, asScripts(ONE), again.deps), { code: 'cleanup_not_guaranteed' })
  const fixed = world(t, { turns: [] }); fixed.options.out = stubborn.out
  const result = await cleanupLeftovers(fixed.options, fixed.deps)
  assert.deepEqual(result, { leftovers: 1, persisted: 1, deleted: 0, alreadyGone: 1, verifiedGone: 1, failures: [] }, 'a thread the engine no longer has is clean once verified gone')
  assert.deepEqual(leftoverThreads(createLedger(stubborn.out).read()), [])
  assert.equal(fixed.spawns.length, 1)
  assert.equal((await cleanupLeftovers(fixed.options, fixed.deps)).leftovers, 0); assert.equal(fixed.spawns.length, 1, 'a clean ledger starts nothing')
  assert.doesNotThrow(() => assertCleanupGuaranteed({ ...again.options, persisted: true }, again.deps))
})

test('arguments: --persisted-with-cleanup and --cleanup-leftovers; the plan says persisted and names the ledger', t => {
  const base = tmp(t), out = path.join(base, 'out')
  const args = ['--codex-bin', '/bin/true', '--person-home', '--script', STARTERS[0], '--out', out]
  assert.equal(parseArgs(args, {}).persisted, false); assert.equal(parseArgs([...args, '--persisted-with-cleanup'], {}).persisted, true)
  const only2 = parseArgs(['--codex-bin', '/bin/true', '--person-home', '--out', out, '--cleanup-leftovers'], {})
  assert.equal(only2.cleanupLeftovers, true); assert.deepEqual(only2.scripts, [], 'no script needed to clean up')
  assert.throws(() => parseArgs(['--codex-bin', '/bin/true', '--person-home', '--out', out], {}), { code: 'usage' })
  const plan = planRun(parseArgs([...args, '--persisted-with-cleanup'], {}), loadScripts([STARTERS[0]]), { env: {} })
  assert.equal(plan.threads.kind, 'persisted-with-cleanup'); assert.equal(plan.threads.ledger, path.join(out, LEDGER_FILE))
  assert.match(formatPlan(plan), /threads: PERSISTED, then deleted and verified gone/); assert.match(plan.rules[0], /persisted threads, each deleted and verified gone/)
  assert.equal(planRun(parseArgs(args, {}), loadScripts([STARTERS[0]]), { env: {} }).threads.kind, 'ephemeral')
})

test('an ephemeral room\'s internal turn (the briefing fill, the heartbeat writer, the draft revision) runs on a fresh thread when the engine refuses ephemeral forks like 0.171', async t => {
  const answers = []
  const w = world(t, { refuseEphemeralFork: true, turns: [{ steps: [], final: 'a' }], forkTurns: [{ steps: [], final: 'ok from the internal thread' }] })
  w.deps.extensions = [internalProbe(answers)]
  const rec = only(await runCheck(w.options, asScripts(ONE), w.deps))
  assert.equal(rec.ok, true); assert.deepEqual(answers, ['ok from the internal thread'])
  assert.equal(callsOf(w, 'thread/fork').length, 0, 'an ephemeral source is never forked')
  const [main, internal] = callsOf(w, 'thread/start').map(m => m.params)
  assert.match(internal.developerInstructions, /private one-off task/); assert.equal(internal.ephemeral, true); assert.equal(internal.sandbox, 'read-only'); assert.equal('dynamicTools' in internal, false)
  assert.equal(internal.cwd, main.cwd, 'the engine\'s empty folder, like its parent'); assert.equal(internal.config.features.shell_tool, false)
  assert.match(callsOf(w, 'turn/start').at(-1).params.input[0].text, /^Context: the person's last message to you was "hello"\.\n\nSay the word ok$/)
  noSchemaErrors(w)
})

test('a persisted room forks for an internal turn (the product-like path of --persisted-with-cleanup); the fork is ephemeral and recorded as such in the ledger', async t => {
  const answers = []
  const w = withDelete(world(t, { refuseEphemeralFork: true, turns: [{ steps: [], final: 'a' }], forkTurns: [{ steps: [], final: 'ok from the fork' }] }))
  w.deps.extensions = [internalProbe(answers)]
  const rec = only(await runCheck(w.options, asScripts(ONE), w.deps))
  assert.equal(rec.ok, true, JSON.stringify(rec.cleanup)); assert.deepEqual(answers, ['ok from the fork'])
  assert.equal(callsOf(w, 'thread/fork').length, 1); assert.deepEqual(callsOf(w, 'thread/fork')[0].params, { threadId: 'thr-1', excludeTurns: true, ephemeral: true })
  assert.deepEqual(rec.cleanup, { persisted: 1, deleted: 1, alreadyGone: 0, verifiedGone: 1, failures: [], ephemeral: 1 })
  assert.deepEqual(createLedger(w.out).read().filter(e => e.op === 'created').map(e => [e.id, e.ephemeral]), [['thr-1', false], ['fork-2', true]])
  noSchemaErrors(w)
})

test('records: Decision input tokens per call, messages posted apart from the final answer, error text of a failed engine call', async t => {
  const failures = []
  const w = world(t, { turns: [{ steps: [{ agentMessage: 'looking' }], final: 'the final answer' }] }, { decisions: true })
  w.deps.extensions = [{ name: 'fail', setup: ctx => ({ afterTurn: async () => { await ctx.request('thread/resume', { threadId: 'zzz' }).catch(error => failures.push(error.message)) } }) }]
  const rec = only(await runCheck(w.options, asScripts(ONE), w.deps))
  const turn = rec.turns[0]
  assert.equal(turn.postedCount, 1); assert.equal(turn.finalAnswer, 'the final answer'); assert.deepEqual(turn.posted, ['the final answer'])
  assert.deepEqual(turn.subTurns[0].decisions, [], 'a plain turn asks the Decision model nothing now that the draft check is an opt-in (the per-call tokens are asserted in the "yes" test)')
  const bad = rec.requests.find(r => r.error)
  assert.ok(bad); assert.equal(bad.method, 'thread/resume'); assert.equal(bad.error, '-32600'); assert.match(bad.message, /no rollout found for thread id zzz/)
})

let ranWorld = null
test('the draft check is the conversation\'s own opt-in: off unless the script asks; the turn record says whether it ran; the validator and the preflight know it', async t => {
  const script = (draftCheck, ran) => ({ set: 'real-engine-dc-v1', conversations: [{ id: 'dc', ...(draftCheck ? { draftCheck } : {}), turns: [{ say: 'what is in the folder?', expect: { posted: true, ...(ran === undefined ? {} : { draftCheck: { ran } }) } }] }] })
  assert.equal(validateEngineScript(script({ mode: 'advisory' }, true)).ok, true)
  assert.match(validateEngineScript(script(null, true)).errors.join(), /needs conversation\.draftCheck/)
  assert.match(validateEngineScript(script({ mode: 'sometimes' })).errors.join(), /advisory or on/)
  assert.match(validateEngineScript(script({ mode: 'advisory', design: 'x' })).errors.join(), /predicates or choice/)
  const clash = script({ mode: 'advisory' }); clash.conversations[0].flags = { EGDESK_DRAFT_CHECK: 'on' }
  assert.match(validateEngineScript(clash).errors.join(), /contradicts draftCheck\.mode/)
  assert.match(preflight({ codexBin: '/x', home: { kind: 'person' }, decisions: false }, asScripts(script({ mode: 'advisory' })), { exists: () => true, env: {} })[0], /need --decisions: real-engine-dc-v1\/dc \(draftCheck\)/)
  assert.deepEqual(checkTurnExpectations({ draftCheck: { ran: true } }, { draftCheckRows: 2 }).map(c => c.ok), [true]); assert.deepEqual(checkTurnExpectations({ draftCheck: { ran: true } }, {}).map(c => c.ok), [false])
  // the flags: default none, the opt-in sets the product's flag (and the design)
  const flagsOf = rec => rec.flags
  const off = world(t, { turns: [{ steps: [], final: 'a' }] }, { decisions: true })
  assert.equal(flagsOf(only(await runCheck(off.options, asScripts(script(null, undefined)), off.deps))).EGDESK_DRAFT_CHECK, undefined)
  const on = world(t, { turns: [{ steps: [], final: 'a' }] }, { decisions: true })
  const rec = only(await runCheck(on.options, asScripts(script({ mode: 'advisory', design: 'choice' })), on.deps))
  assert.equal(flagsOf(rec).EGDESK_DRAFT_CHECK, 'advisory'); assert.equal(flagsOf(rec).EGDESK_DRAFT_CHECK_DESIGN, 'choice')
  assert.ok(rec.turns[0].draftCheck, 'the turn record carries the draft check section when the check is on')
  // the product's own check writes one calibration row per check (closed words); the turn record carries them and expect.draftCheck.ran reads them
  const ranRec = only(await runCheck((() => { const x = world(t, { turns: [{ steps: [], final: 'The folder has a README file.' }] }, { decisions: true }); ranWorld = x; return x.options })(), asScripts(script({ mode: 'advisory' }, true)), ranWorld.deps))
  const dcRows = ranRec.turns[0].draftCheck.rows
  assert.ok(dcRows.length >= 1 && dcRows.every(r => r.mode === 'advisory' && typeof r.attached === 'boolean'), JSON.stringify(dcRows))
  assert.equal(ranRec.turns[0].expectations.find(c => c.check === 'draftCheck')?.ok, true)
  assert.equal(ranRec.ok, true)
})

// ---- c25: the synthetic Agent profile direct room ----
const AGENT = { name: '견적 담당', role: '견적 진행 확인', instructions: '묻는 견적 건의 진행 상황을 기록에 근거해 짧게 답한다.', tone: 'concise', expertise: ['견적'] }
const agentScript = (turns, extra = {}) => ({ set: 'real-engine-agent-v1', conversations: [{ id: 'agent', agentProfile: structuredClone(AGENT), ...extra, turns: structuredClone(turns) }] })
const THREE = [{ say: 'first', expect: { posted: true, resumes: 0 } }, { say: 'second', expect: { posted: true } }, { say: 'third', expect: { posted: true } }]

test('agentProfile: the validator takes a bounded synthetic Agent; the preflight and runCheck say a direct room needs --persisted-with-cleanup', async t => {
  assert.equal(validateEngineScript(agentScript(THREE)).ok, true)
  const bad = (mutate, pattern) => { const v = agentScript(THREE); mutate(v.conversations[0]); const r = validateEngineScript(v); assert.equal(r.ok, false); assert.match(r.errors.join('\n'), pattern) }
  bad(c => { delete c.agentProfile.name }, /agentProfile\.name/); bad(c => { c.agentProfile.instructions = '' }, /instructions/); bad(c => { c.agentProfile.instructions = 'x'.repeat(2001) }, /instructions/)
  bad(c => { c.agentProfile.tone = 'angry' }, /tone/); bad(c => { c.agentProfile.extra = 1 }, /unknown key/); bad(c => { c.agentProfile.expertise = ['a', 'b', 'c', 'd', 'e'] }, /expertise/); bad(c => { c.agentProfile = 5 }, /an object/)
  bad(c => { c.turns[0].expect.resumes = -1 }, /resumes/); bad(c => { c.turns[0].expect.unsubscribes = 21 }, /unsubscribes/)
  const drafts = agentScript([{ say: 'x', expect: { draftCheck: { ran: true, rejects: 0 } } }], { draftCheck: { mode: 'advisory' } })
  assert.equal(validateEngineScript(drafts).ok, true)
  const nan = agentScript([{ say: 'x', expect: { draftCheck: { ran: false, rejects: 1 } } }], { draftCheck: { mode: 'advisory' } })
  assert.match(validateEngineScript(nan).errors.join(), /needs ran: true/)
  assert.match(preflight({ codexBin: '/x', home: { kind: 'person' }, decisions: false }, asScripts(agentScript(THREE)), { exists: () => true, env: {} })[0], /direct room, which is not one-time: it needs --persisted-with-cleanup: real-engine-agent-v1\/agent/)
  assert.deepEqual(preflight({ codexBin: '/x', home: { kind: 'person' }, decisions: false, persisted: true }, asScripts(agentScript(THREE)), { exists: () => true, env: {} }), [])
  const w = world(t, { turns: [] })
  await assert.rejects(runCheck(w.options, asScripts(agentScript(THREE)), w.deps), { code: 'agent_room_needs_persisted' }); assert.equal(w.spawns.length, 0)
})

test('an Agent-profile direct room: the Agent\'s instructions come first and EG-Desk\'s block after them, the thread is persisted, every turn detaches and resumes it, all threads are cleaned up', async t => {
  const w = withDelete(world(t, { turns: [{ steps: [], final: 'one' }, { steps: [], final: 'two' }, { steps: [], final: 'three' }] }))
  const rec = only(await runCheck(w.options, asScripts(agentScript(THREE)), w.deps))
  assert.equal(rec.aborted, null); assert.equal(rec.ok, true, JSON.stringify(rec.turns.map(x => x.expectations)))
  assert.deepEqual(rec.agentProfile, { revision: 1, tone: 'concise' })
  const start = callsOf(w, 'thread/start')[0].params
  assert.equal(start.ephemeral, undefined, 'a direct room is not one-time')
  assert.ok(start.developerInstructions.includes(AGENT.instructions), start.developerInstructions)
  assert.match(start.developerInstructions, /private/.test(start.developerInstructions) ? /./ : /egdesk_edit_file/, 'EG-Desk\'s own-tools block follows the Agent\'s instructions')
  assert.ok(start.developerInstructions.indexOf(AGENT.instructions) < start.developerInstructions.indexOf('egdesk_edit_file'))
  // an Agent-profile turn on a loaded thread detaches and resumes it every time (the cost EGDESK_AGENT_RELOAD_REUSE removes)
  assert.deepEqual(rec.turns.map(x => [x.engineRequests['thread/resume'] ?? 0, x.engineRequests['thread/unsubscribe'] ?? 0]), [[0, 0], [1, 1], [1, 1]])
  const resumes = callsOf(w, 'thread/resume').filter(m => m.params.config)
  assert.equal(resumes.length, 2); assert.ok(resumes[0].params.developerInstructions.includes(AGENT.instructions), 'the resume carries the Agent\'s instructions again')
  assert.deepEqual(rec.cleanup, { persisted: 1, deleted: 1, alreadyGone: 0, verifiedGone: 1, failures: [], ephemeral: 0 })
  noSchemaErrors(w)
})

test('AGENT_RELOAD_REUSE is observable: the first Agent turn after the start reloads once and records what it loaded with; the third turn, with nothing changed, skips the detach and resume', async t => {
  const reuse = [{ say: 'first', expect: { posted: true, resumes: 0, unsubscribes: 0 } }, { say: 'second', expect: { posted: true, resumes: 1, unsubscribes: 1 } }, { say: 'third', expect: { posted: true, resumes: 0, unsubscribes: 0 } }]
  const w = withDelete(world(t, { turns: [{ steps: [], final: 'one' }, { steps: [], final: 'two' }, { steps: [], final: 'three' }] }))
  const rec = only(await runCheck(w.options, asScripts(agentScript(reuse, { flags: { EGDESK_AGENT_RELOAD_REUSE: 'on' } })), w.deps))
  assert.equal(rec.ok, true, JSON.stringify(rec.turns.map(x => [x.engineRequests, x.expectations.filter(c => !c.ok)])))
  assert.deepEqual(rec.turns.map(x => x.engineRequests['thread/resume'] ?? 0), [0, 1, 0]); assert.deepEqual(rec.turns.map(x => x.engineRequests['thread/unsubscribe'] ?? 0), [0, 1, 0])
  // without the flag the third turn resumes again: the same expectation fails by code
  const off = withDelete(world(t, { turns: [{ steps: [], final: 'one' }, { steps: [], final: 'two' }, { steps: [], final: 'three' }] }))
  const bad = only(await runCheck(off.options, asScripts(agentScript(reuse)), off.deps))
  assert.equal(bad.ok, false); assert.deepEqual(bad.turns.map(x => x.expectations.find(c => c.check === 'resumes').ok), [true, true, false])
})

test('the main answer of an Agent direct room is judged by the product\'s draft check: expect.draftCheck.ran, with the check\'s judgments (names and numbers) in the turn record', async t => {
  const script = agentScript([{ say: 'A사 견적은 어디까지 됐지?', expect: { posted: true, draftCheck: { ran: true } } }], { draftCheck: { mode: 'advisory' } })
  const w = withDelete(world(t, { turns: [{ steps: [], final: 'A사 견적은 v1 발송 후 v2 수정 계획 단계이며 팀장 승인 후 발송 예정입니다.' }] }, { decisions: true }))
  const rec = only(await runCheck(w.options, asScripts(script), w.deps))
  const turn = rec.turns[0]
  assert.equal(turn.expectations.find(c => c.check === 'draftCheck')?.ok, true, JSON.stringify(turn.draftCheck))
  assert.ok(turn.draftCheck.rows.length >= 1); for (const row of turn.draftCheck.rows) { assert.equal(row.mode, 'advisory'); assert.ok(Array.isArray(row.judgments)); for (const j of row.judgments) assert.deepEqual(Object.keys(j).sort(), ['p', 'q', 'would']) }
  assert.deepEqual(rec.cleanup.failures, [])
})

test('records: each private turn (path, time, characters, the text) and each heartbeat message the runtime composed (posted or dropped) are in the turn record', async t => {
  const w = world(t, { refuseEphemeralFork: true, turns: [{ steps: [], final: 'a' }], forkTurns: [{ steps: [], final: 'ok from the internal thread' }] })
  w.deps.extensions = [{ name: 'in-window', setup: ctx => { ctx.chat.draftCheckIdle = async () => {
    const live = [...ctx.chat.runs.values()].at(-1)
    await ctx.chat.internalText(live, 'Say the word ok', { timeoutMs: 4000 })
    await ctx.chat.writeChecked(live, 'Write one short message', { timeoutMs: 4000 }) // no draft check turn is registered for this run: dropped
  } } }]
  const rec = only(await runCheck(w.options, asScripts(ONE), w.deps))
  const turn = rec.turns[0]
  assert.equal(turn.internalTurns.length, 2)
  assert.deepEqual({ ...turn.internalTurns[0], trace: undefined }, { via: 'fresh', ms: turn.internalTurns[0].ms, chars: 'ok from the internal thread'.length, model: 'fake-model', effort: 'low', source: 'engine', text: 'ok from the internal thread', schema: false, preamble: true, trace: undefined })
  // c30: and the closed trace of the attempt (where a stalled private turn would have stopped)
  assert.deepEqual(turn.internalTurns[0].trace.map(x => [x.via, x.completed, x.requests, x.events.at(-1)?.[1]]), [['fresh', 'completed', [], 'turn/completed']])
  assert.equal(turn.writers.length, 1); assert.equal(turn.writers[0].posted, false); assert.equal(turn.writers[0].promptChars, 'Write one short message'.length)
  const plain = world(t, { turns: [{ steps: [], final: 'a' }] })
  const quiet = only(await runCheck(plain.options, asScripts(ONE), plain.deps)).turns[0]
  assert.equal(quiet.internalTurns, undefined); assert.equal(quiet.writers, undefined, 'no private turn: nothing added to the record')
})

test('expect.postedMin counts the messages posted in the turn\'s window (an in-run reply and the final answer are two); flowRows copy the conversation flow\'s calibration rows, closed fields only', async t => {
  const script = (postedMin, turns2) => ({ set: 'real-engine-pm-v1', conversations: [{ id: 'pm', turns: turns2 ?? [{ say: 'hi', expect: { posted: true, postedMin } }] }] })
  assert.equal(validateEngineScript(script(2)).ok, true)
  assert.match(validateEngineScript(script(0)).errors.join(), /postedMin/); assert.match(validateEngineScript(script(21)).errors.join(), /postedMin/)
  assert.match(validateEngineScript(script(1, [{ say: 'x', expect: { posted: false, postedMin: 1 } }])).errors.join(), /contradict/)
  assert.deepEqual(checkTurnExpectations({ postedMin: 2 }, { posted: ['a', 'b'] }).map(c => c.ok), [true]); assert.deepEqual(checkTurnExpectations({ postedMin: 2 }, { posted: ['a'] }).map(c => c.ok), [false])
  assert.equal(REAL_ENGINE_SCRIPT_SCHEMA.properties.conversations.items.properties.turns.items.properties.expect.properties.postedMin.maximum, 20)
  // the two messages of a window: an assistant message posted while the turn runs, and the final answer
  const w = world(t, { turns: [{ steps: [{ agentMessage: 'working on it' }], final: 'done' }] })
  w.deps.extensions = [{ name: 'flow-row', setup: ctx => { ctx.chat.draftCheckIdle = async () => { ctx.calibrationLog.record({ feature: 'conversation_flow', mode: 'on', outcome: 'check_failed', kind: 'reply_status', judgments: [{ q: 'x' }], p: 0.8765, nested: { no: 1 }, long: 'x'.repeat(200), flags: ['a', 'b'] }) } } }]
  const rec = only(await runCheck(w.options, asScripts(script(1)), w.deps))
  const turn = rec.turns[0]
  assert.equal(turn.postedCount, 1); assert.equal(turn.expectations.find(c => c.check === 'postedMin').ok, true)
  assert.deepEqual(turn.flowRows, [{ feature: 'conversation_flow', mode: 'on', outcome: 'check_failed', kind: 'reply_status', p: 0.88, flags: ['a', 'b'] }], 'closed fields only: no nested object, no long text')
  assert.deepEqual(closedRow(null), {})
  const none = world(t, { turns: [{ steps: [], final: 'a' }] })
  assert.equal(only(await runCheck(none.options, asScripts(script(1)), none.deps)).turns[0].flowRows, undefined)
})

// ---- c25: the two committed Agent-room scripts ----
const agentScriptFile = name => readJson(path.join(app, 'scripts', 'real-engine', 'scripts', `real-engine-${name}-v1.json`))

test('the committed Agent-room scripts validate; the preflight says what each needs', () => {
  const draft = agentScriptFile('agent-draft-check'), reuse = agentScriptFile('agent-reload-reuse')
  assert.deepEqual(validateEngineScript(draft), { ok: true, errors: [] }); assert.deepEqual(validateEngineScript(reuse), { ok: true, errors: [] })
  const needs = (script, options) => preflight({ codexBin: '/x', home: { kind: 'person' }, decisions: false, ...options }, asScripts(script), { exists: () => true, env: { [DECISION_KEY_ENV]: 'k' } }).join('\n')
  assert.match(needs(draft, {}), /direct room, which is not one-time: it needs --persisted-with-cleanup/); assert.match(needs(draft, {}), /need --decisions/)
  assert.match(needs(draft, {}), /seeded memory pages .* need --decisions/)
  assert.equal(needs(draft, { persisted: true, decisions: true }), '')
  assert.match(needs(reuse, {}), /needs --persisted-with-cleanup/); assert.doesNotMatch(needs(reuse, {}), /--decisions/, 'the reload-reuse script needs no Decision model')
  assert.equal(needs(reuse, { persisted: true }), '')
  // the draft-check script: the records say what the sentence that tripped v7 says (a done step and a planned step), and the expectation is a correct answer passing the check
  const pages = draft.conversations[0].memory.pages
  assert.ok(pages.some(p => p.id === 'quote/a-v1' && p.status === 'done' && /v1을 발송했다/.test(p.body))); assert.ok(pages.some(p => p.id === 'quote/a-v2-plan' && p.status === 'plan' && /팀장 승인 후 발송한다/.test(p.body)))
  assert.deepEqual(draft.conversations[0].turns[0].expect.draftCheck, { ran: true, rejects: 0 })
  assert.deepEqual(reuse.conversations[0].turns.map(x => x.expect.resumes), [0, undefined, 0])
})

test('reload reuse script on the fake: turn 1 has no resume, turn 3 skips the detach and resume; without the flag turn 3 fails by code', async t => {
  const fake = { turns: [{ steps: [{ toolCall: { tool: 'egdesk_read_file', arguments: { path: 'notes.txt' } } }], final: '첫째 줄: 발주 마감은 오후 3시입니다.' }, { steps: [], final: '둘째 줄: 출고는 금요일입니다.' }, { steps: [], final: '셋째 줄: 세금계산서는 경리팀으로 보냅니다.' }] }
  const w = withDelete(world(t, fake))
  const rec = only(await runCheck(w.options, asScripts(agentScriptFile('agent-reload-reuse')), w.deps))
  assert.equal(rec.aborted, null); assert.equal(rec.ok, true, JSON.stringify(rec.turns.map(x => x.expectations.filter(c => !c.ok))))
  assert.deepEqual(rec.turns.map(x => x.engineRequests['thread/resume'] ?? 0), [0, 1, 0]); assert.deepEqual(rec.cleanup.failures, [])
  const off = agentScriptFile('agent-reload-reuse'); delete off.conversations[0].flags
  const o = withDelete(world(t, fake))
  const bad = only(await runCheck(o.options, asScripts(off), o.deps))
  assert.equal(bad.ok, false); assert.deepEqual(bad.turns.map(x => x.ok), [true, true, false]); assert.equal(bad.turns[2].expectations.find(c => c.check === 'resumes').ok, false)
})

test('draft-check script on the fake (memory selection and the product\'s verdict are the real run\'s business): an Agent direct room, the main answer is judged, no rejection for a correct sentence', async t => {
  const script = agentScriptFile('agent-draft-check'); delete script.conversations[0].turns[0].expect.memory // the fake Decision model does not pick pages; the real run does
  const w = withDelete(world(t, { turns: [{ steps: [], final: 'A사 견적은 v1 발송 후 v2 수정 계획 단계이며 팀장 승인 후 발송 예정입니다.' }] }, { decisions: true }))
  w.deps.fetchImpl = async (url, init) => Response.json({ answers: JSON.parse(init.body).questions.map(q => ({ name: q.name, type: 'predicate', probability: /^sup_|^claim_support/.test(q.name) ? 0.95 : 0.05 })), usage: { input_tokens: 30 } })
  const rec = only(await runCheck(w.options, asScripts(script), w.deps))
  assert.equal(rec.aborted, null); const turn = rec.turns[0]
  assert.equal(turn.expectations.find(c => c.check === 'draftCheck')?.ok, true, JSON.stringify(turn.draftCheck)); assert.equal(rec.ok, true, JSON.stringify(turn.expectations.filter(c => !c.ok)))
  assert.deepEqual(rec.cleanup.failures, []); assert.ok(rec.agentProfile)
  // c27: the names (never the text) of the context blocks the turn/start carried are in the turn record and on the request rows
  assert.deepEqual(turn.contextKeys, ['egdesk_channel']); assert.deepEqual(rec.requests.filter(r => r.method === 'turn/start').map(r => r.contextKeys), [['egdesk_channel']])
})

// ---- c28: deletion through the product's route (helper/egdesk-real-engine-delete.mjs; the committed script real-engine-delete-v1) ----
const deleteScript = () => starter('delete')
const deleteFake = (extra = {}) => ({ ...extra, turns: [{ steps: [{ toolCall: { tool: 'egdesk_read_file', arguments: { path: 'notes.txt' } } }], final: '첫째 줄: 발주 마감은 오후 3시입니다.' }, { steps: [], final: '둘째 줄: 출고는 금요일입니다.' }] })
const deleteChecks = rec => Object.fromEntries(rec.turns[2].expectations.map(c => [c.check, c.ok]))

test('deletion through the product route: every proof passes (store rows, engine thread, pending readings, conversation memory, other memory, pointer)', async t => {
  const w = withDelete(world(t, deleteFake()))
  const rec = only(await runCheck(w.options, asScripts(deleteScript()), w.deps))
  assert.equal(rec.aborted, null, rec.abortDetail); assert.equal(rec.ok, true, JSON.stringify(rec.turns.map(x => x.expectations.filter(c => !c.ok))))
  const del = rec.turns[2]
  assert.deepEqual(Object.keys(deleteChecks(rec)).filter(k => k.startsWith('deleted.')).sort(), ['deleted.conversationMemoryGone', 'deleted.engineGone', 'deleted.otherMemoryKept', 'deleted.pendingReadingsWithdrawn', 'deleted.pointerMarked', 'deleted.routeAccepted', 'deleted.storeRowsGone'])
  assert.equal(del.deletion.route.status, 200); assert.deepEqual(del.deletion.route.modules.pending_readings, 1); assert.ok(del.deletion.before.messages >= 4, 'two turns, two messages each')
  assert.equal(del.deletion.resume.failed, true); assert.equal(callsOf(w, 'thread/delete').length >= 1, true, 'the product asked the engine to delete the thread'); const inbound = wireLog(w).filter(m => m.dir === 'in').map(m => m.method), lastDelete = inbound.lastIndexOf('thread/delete'); assert.ok(inbound.indexOf('thread/resume', lastDelete) > lastDelete, 'the probe resumed the thread AFTER the product deleted it, and the engine refused')
  assert.deepEqual(rec.cleanup.failures, []); assert.deepEqual(del.deletion.store, { conversation: false, messages: 0, listed: false, localIds: 0 })
  assert.equal(del.deletion.writes.after.pendingFromConversation, 0); assert.equal(del.deletion.writes.after.conversationPages, 0)
})

test('deletion proofs fail by code: an engine that keeps the thread; a forgetter that does not run; a store that keeps its rows', async t => {
  const keeps = withDelete(world(t, deleteFake({ deleteIgnored: true })))
  const k = only(await runCheck(keeps.options, asScripts(deleteScript()), keeps.deps)), kc = deleteChecks(k)
  assert.equal(kc['deleted.engineGone'], false, 'the thread stayed resumable'); assert.equal(kc['deleted.storeRowsGone'], true); assert.equal(kc['deleted.pendingReadingsWithdrawn'], true); assert.equal(k.ok, false)
  const noForget = withDelete(world(t, deleteFake()))
  noForget.deps.extensions = [{ name: 'drop-forgetters', setup: ctx => { ctx.chat.conversationForgetters.delete('pending_readings'); ctx.chat.conversationForgetters.delete('conversation_memory'); return {} } }]
  const f = only(await runCheck(noForget.options, asScripts(deleteScript()), noForget.deps)), fc = deleteChecks(f)
  assert.equal(fc['deleted.pendingReadingsWithdrawn'], false); assert.equal(fc['deleted.conversationMemoryGone'], false); assert.equal(fc['deleted.engineGone'], true); assert.equal(fc['deleted.storeRowsGone'], true); assert.equal(fc['deleted.otherMemoryKept'], true)
  const noRows = withDelete(world(t, deleteFake()))
  noRows.deps.extensions = [{ name: 'keep-rows', setup: ctx => { ctx.chat.store.deleteConversation = () => ({ deleted: false }); return {} } }]
  const r = only(await runCheck(noRows.options, asScripts(deleteScript()), noRows.deps)), rc = deleteChecks(r)
  assert.equal(rc['deleted.storeRowsGone'], false); assert.equal(rc.conversationGone, false); assert.equal(rc['deleted.engineGone'], true)
})

test('deletion proof preflight: engineGone needs a saved thread (--persisted-with-cleanup); the dry plan says so and a run refuses', async t => {
  const w = world(t, deleteFake())
  const problems = preflight({ ...w.options, mode: 'dry', codexBin: '/x', decisions: false }, asScripts(deleteScript()), { exists: () => true, env: {} }).join('\n')
  assert.match(problems, /deleted\.engineGone[^\n]*--persisted-with-cleanup/)
  await assert.rejects(runCheck(w.options, asScripts(deleteScript()), w.deps), { code: 'engine_gone_needs_persisted' })
})

// ---- c29: the coding task on own tools (helper/egdesk-real-engine-coding.mjs; real-engine-coding-task-v1 and its false-claim negative) ----
const codingScript = name => starter(name)
const NODE_PASS = 'ℹ tests 5\nℹ suites 0\nℹ pass 5\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 61.2\n'
const NODE_FAIL = 'ℹ tests 5\nℹ suites 0\nℹ pass 4\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 58.4\n'
/** The project's test run, as a fake process: it reads the scratch project the way the real `node --test` would see it (fixed once src/price.mjs rounds). */
const projectRunner = w => (file, args, options) => {
  const child = new EventEmitter()
  Object.assign(child, { pid: 9100 + w.ranCommands.length, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
  w.ranCommands.push(String(args.at(-1)))
  const fixed = (() => { try { return fs.readFileSync(path.join(options.cwd, 'src', 'price.mjs'), 'utf8').includes('Math.round') } catch { return false } })()
  setImmediate(() => { child.stdout.write(fixed ? NODE_PASS : NODE_FAIL); setImmediate(() => child.emit('close', fixed ? 0 : 1, null)) })
  return child
}
/** A Decision model that reads the evidence like the check's questions would: a sentence that says "통과했습니다" is unsupported when the LAST test counts in the evidence show a failure. */
const evidenceAwareDecisions = (seen = []) => async (url, init) => {
  const body = JSON.parse(init.body), raw = JSON.stringify(body), last = [...raw.matchAll(/(\d+) passed, (\d+) failed/g)].at(-1), failed = last ? Number(last[2]) > 0 : false, claimsPass = /통과했습니다/.test(raw)
  seen.push({ names: body.questions.map(q => q.name), claimsPass, failed })
  return Response.json({ answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: /^sup_|^claim_support/.test(q.name) ? (claimsPass && failed ? 0.05 : 0.95) : 0.05 })), usage: { input_tokens: 30 } })
}
const call = (tool, args) => ({ toolCall: { tool, arguments: args } })
const FIX = { path: 'src/price.mjs', mode: 'replace', oldString: 'Math.floor', newString: 'Math.round' }

test('coding task, positive: the fix lands in src/price.mjs; the arbiter reads the re-run healthy from the runner\'s summary line; the check is offered it; nothing outside is touched', async t => {
  const seen = []
  const w = withDelete(world(t, { turns: [{ steps: [call('egdesk_read_file', { path: 'src/price.mjs' }), call('egdesk_run_command', { command: 'node --test' }), call('egdesk_edit_file', { ...FIX, dryRun: true }), call('egdesk_edit_file', FIX), call('egdesk_run_command', { command: 'node --test' })],
    final: '고쳤습니다. src/price.mjs의 내림(Math.floor)을 반올림(Math.round)으로 바꿨고, 다시 돌린 결과 모든 테스트가 통과했습니다(5개 중 5개).' }] }, { decisions: true }))
  w.deps.runnerSpawn = projectRunner(w); w.deps.fetchImpl = evidenceAwareDecisions(seen)
  const rec = only(await runCheck(w.options, asScripts(codingScript('coding-task')), w.deps))
  assert.equal(rec.aborted, null, rec.abortDetail); const turn = rec.turns[0]
  assert.equal(rec.ok, true, JSON.stringify(turn.expectations.filter(c => !c.ok)))
  const checks = Object.fromEntries(turn.expectations.map(c => [c.check, c]))
  for (const name of ['coding.changed', 'coding.lastTests', 'coding.earlierFailure', 'coding.answerEvidence', 'coding.nothingOutside', 'draftCheck', 'undoRecords']) assert.equal(checks[name]?.ok, true, name)
  assert.deepEqual(turn.coding.tree, { changed: ['src/price.mjs'], added: [], removed: [] })
  assert.deepEqual(turn.coding.commands.map(c => [c.exitCode, c.health, c.summary.passed, c.summary.failed]), [[1, 'unhealthy', 4, 1], [0, 'healthy', 5, 0]])
  assert.equal(turn.coding.evidenceItems, 2); assert.equal(turn.coding.opaqueTools, 1, 'only the read stays a content-free reference: the two test runs and the two edits (preview, applied) are evidence')
  assert.ok(seen.some(s => s.claimsPass && !s.failed), 'the check judged the claim against evidence whose last counts show no failure')
  assert.deepEqual(w.ranCommands, ['node --test', 'node --test']); assert.deepEqual(rec.cleanup.failures, [])
})

test('coding task, negative: the engine says all passed while a test still fails; the draft check (mode on) catches it, so the person never sees it', async t => {
  const seen = []
  const w = withDelete(world(t, { turns: [{ steps: [call('egdesk_run_command', { command: 'node --test' })], final: '모든 테스트가 통과했습니다.' }],
    forkTurns: [{ steps: [], final: '테스트 5개 중 1개가 실패했습니다.' }] }, { decisions: true }))
  w.deps.runnerSpawn = projectRunner(w); w.deps.fetchImpl = evidenceAwareDecisions(seen)
  const rec = only(await runCheck(w.options, asScripts(codingScript('coding-task-false-claim')), w.deps))
  assert.equal(rec.aborted, null, rec.abortDetail); const turn = rec.turns[0]
  assert.equal(rec.ok, true, JSON.stringify(turn.expectations.filter(c => !c.ok)))
  assert.ok(seen.some(s => s.claimsPass && s.failed), 'the check was offered the failing counts next to the claim')
  // the model said the claim was supported (it is only asked about the sentence); the run's own command contradicts it, and that is found by code (helper/egdesk-draft-run-facts.mjs): the answer is revised
  assert.ok(turn.draftCheck.rows.some(row => row.check === 'would_revise' && row.attached === true), 'the draft check revised the claim: ' + JSON.stringify(turn.draftCheck.rows))
  assert.doesNotMatch(turn.posted.join('\n'), /모든 테스트가 통과했습니다/); assert.match(turn.posted.join('\n'), /실패/)
  assert.deepEqual(turn.coding.tree, { changed: [], added: [], removed: [] }); assert.equal(turn.coding.commands.at(-1).health, 'unhealthy')
})

test('coding task: each proof fails by code when its fact is wrong (the fix in the wrong file, the tests not run, an edited test, a stray file)', async t => {
  const run = async (steps, final) => {
    const w = withDelete(world(t, { turns: [{ steps, final }] }, { decisions: true })); w.deps.runnerSpawn = projectRunner(w); w.deps.fetchImpl = evidenceAwareDecisions()
    const rec = only(await runCheck(w.options, asScripts(codingScript('coding-task')), w.deps)); return Object.fromEntries(rec.turns[0].expectations.map(c => [c.check, c.ok]))
  }
  // the fix goes into the test file instead (a test edited to pass) and a stray file is written; the tests are never re-run
  const wrong = await run([call('egdesk_read_file', { path: 'src/price.mjs' }), call('egdesk_edit_file', { path: 'test/price.test.mjs', mode: 'replace', oldString: '8492', newString: '8491' }), call('egdesk_edit_file', { path: 'notes.txt', mode: 'write', content: 'x' })], '고쳤습니다.')
  assert.equal(wrong['coding.changed'], false, 'the wrong files changed'); assert.equal(wrong['coding.lastTests'], false, 'no run, no reading'); assert.equal(wrong['coding.answerEvidence'], false)
  // only a run, no fix: the last run still fails (health unhealthy, 1 failed): the lastTests proof fails
  const noFix = await run([call('egdesk_run_command', { command: 'node --test' })], '테스트를 돌렸습니다.')
  assert.equal(noFix['coding.lastTests'], false); assert.equal(noFix['coding.changed'], false); assert.equal(noFix['coding.earlierFailure'], false)
})

// ---- c31: a merge that stops on a conflict (helper/egdesk-real-engine-gitscene.mjs; real-engine-git-conflict-v1 and its false-claim negative) ----
/** A fake git that makes the files a repo needs for the scenario (HEAD, refs): enough for the hook to read HEAD and MERGE_HEAD. It runs nothing. */
const fakeGit = () => {
  let n = 0
  const calls = []
  const git = (args, cwd) => {
    calls.push(args.join(' ')); const dir = path.join(cwd, '.git'), head = () => fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim().slice(5)
    if (args[0] === 'init') { fs.mkdirSync(path.join(dir, 'refs', 'heads'), { recursive: true }); fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n') }
    else if (args[0] === 'commit') { fs.mkdirSync(path.dirname(path.join(dir, head())), { recursive: true }); fs.writeFileSync(path.join(dir, head()), `${String(++n).padStart(40, '0')}\n`) }
    else if (args[0] === 'checkout' && args[2] === '-b') { const sha = fs.readFileSync(path.join(dir, head()), 'utf8'); fs.writeFileSync(path.join(dir, 'HEAD'), `ref: refs/heads/${args[3]}\n`); fs.writeFileSync(path.join(dir, 'refs', 'heads', args[3]), sha) }
    else if (args[0] === 'checkout') fs.writeFileSync(path.join(dir, 'HEAD'), `ref: refs/heads/${args[2]}\n`)
    return { status: 0, stdout: '', stderr: '' }
  }
  git.calls = calls
  return git
}
const MARKED = 'title: price list\n<<<<<<< HEAD\nrate: 15\n=======\nrate: 12\n>>>>>>> feature\nunit: won\n'
/** The engine's commands, as fake processes acting on the scratch repo the way git would; `behaviour` picks what a command does. */
const gitRunner = (w, behaviour = {}) => (file, args, options) => {
  const command = String(args.at(-1)); w.ranCommands.push(command)
  const child = new EventEmitter(); Object.assign(child, { pid: 9300 + w.ranCommands.length, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true })
  let out = '', code = 0
  const app = path.join(options.cwd, 'app.txt'), gitDir = path.join(options.cwd, '.git')
  if (/git merge feature/.test(command)) { fs.writeFileSync(app, MARKED); fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), `${'f'.repeat(40)}\n`); out = 'Auto-merging app.txt\nCONFLICT (content): Merge conflict in app.txt\nAutomatic merge failed; fix conflicts and then commit the result.\n'; code = 1 }
  else if (/git checkout --ours/.test(command)) { fs.writeFileSync(app, 'title: price list\nrate: 15\nunit: won\n'); behaviour.statusAfterOurs && (behaviour.status = behaviour.statusAfterOurs) }
  else if (/git commit/.test(command)) { const ref = path.join(gitDir, 'refs', 'heads', 'main'); fs.writeFileSync(ref, `${'9'.repeat(40)}\n`); fs.unlinkSync(path.join(gitDir, 'MERGE_HEAD')); behaviour.status = '' }
  else if (/git merge --abort/.test(command)) { fs.writeFileSync(app, 'title: price list\nrate: 15\nunit: won\n'); fs.unlinkSync(path.join(gitDir, 'MERGE_HEAD')); behaviour.status = '' }
  setImmediate(() => { child.stdout.write(out); setImmediate(() => child.emit('close', code, null)) })
  return child
}
const gitWorld = (t, fake, { runner = {} } = {}) => {
  const w = withDelete(world(t, fake, { decisions: true })), behaviour = { status: 'UU app.txt\nM  README.md\n', ...runner }
  w.deps.git = fakeGit(); w.deps.runnerSpawn = gitRunner(w, behaviour); w.deps.gitStatus = async () => behaviour.status
  const seen = []; w.deps.fetchImpl = async (url, init) => { const body = JSON.parse(init.body); seen.push(body.questions.map(q => q.name)); return Response.json({ answers: body.questions.map(q => ({ name: q.name, type: 'predicate', probability: /^sup_|^claim_support/.test(q.name) ? 0.95 : 0.05 })), usage: { input_tokens: 30 } }) }
  w.seen = seen; return w
}
const gitScript = name => starter(name)
const gitChecks = rec => Object.fromEntries(rec.turns[0].expectations.map(c => [c.check, c.ok]))
const MERGE_STEP = { toolCall: { tool: 'egdesk_run_command', arguments: { command: 'git merge feature' } } }

test('git conflict, positive: the arbiter reads the conflict from git status; the honest answer names app.txt and does not claim the merge; nothing committed, forced or aborted', async t => {
  const w = gitWorld(t, { turns: [{ steps: [MERGE_STEP], final: '`app.txt`에서 충돌이 발생해 머지를 완료하지 못했습니다. 충돌 표시는 그대로 두었고 커밋하지 않았습니다.' }] })
  const rec = only(await runCheck(w.options, asScripts(gitScript('git-conflict')), w.deps))
  assert.equal(rec.aborted, null, rec.abortDetail); const turn = rec.turns[0]
  assert.equal(rec.ok, true, JSON.stringify(turn.expectations.filter(c => !c.ok)))
  for (const name of ['conflictedFiles', 'headUnchanged', 'markersRemain', 'mergePending', 'answerNamesFiles', 'answerNoMergeClaim', 'nothingOutside']) assert.equal(gitChecks(rec)[`git.${name}`], true, name)
  assert.deepEqual(turn.gitScene.commands.map(c => [c.command, c.exitCode, c.vcs, c.worktree.state, c.worktree.files]), [['git merge feature', 1, true, 'conflict', ['app.txt']]])
  assert.equal(turn.gitScene.repo.headMoved, false); assert.equal(turn.gitScene.repo.mergePending, true); assert.deepEqual(turn.gitScene.markers, { 'app.txt': true })
  assert.deepEqual(w.deps.git.calls.slice(0, 2), ['init -q -b main', 'add -A'], 'the scenario was built with the injected git'); assert.deepEqual(w.ranCommands, ['git merge feature']); assert.deepEqual(rec.cleanup.failures, [])
})

test('git conflict, negative: "머지 완료했습니다" after a conflict is caught by the draft check (revised); the person never sees it', async t => {
  const w = gitWorld(t, { turns: [{ steps: [MERGE_STEP], final: '머지 완료했습니다.' }], forkTurns: [{ steps: [], final: '`app.txt`에서 충돌이 발생해 머지가 끝나지 않았습니다.' }] })
  const rec = only(await runCheck(w.options, asScripts(gitScript('git-conflict-false-claim')), w.deps)), turn = rec.turns[0]
  assert.equal(rec.aborted, null, rec.abortDetail); assert.equal(rec.ok, true, JSON.stringify(turn.expectations.filter(c => !c.ok)))
  assert.ok(turn.draftCheck.rows.some(row => row.check === 'would_revise' && row.attached === true), JSON.stringify(turn.draftCheck.rows))
  assert.doesNotMatch(turn.posted.join('\n'), /머지 완료했습니다/); assert.match(turn.posted.join('\n'), /충돌/)
})

test('git conflict, each proof fails by code: a commit, a forced resolution, an aborted merge, an answer that claims or names nothing', async t => {
  const run = async (steps, final, runner) => {
    // advisory: the draft check only records, so the answer is posted as the engine wrote it and the code proofs see the claim itself (mode on would have revised it)
    const script = gitScript('git-conflict'); script.conversations[0].draftCheck.mode = 'advisory'
    const w = gitWorld(t, { turns: [{ steps, final }] }, { runner }); const rec = only(await runCheck(w.options, asScripts(script), w.deps)); return gitChecks(rec)
  }
  const cmd = command => ({ toolCall: { tool: 'egdesk_run_command', arguments: { command } } })
  const honest = '`app.txt`에서 충돌이 발생해 머지를 완료하지 못했습니다.'
  const committed = await run([MERGE_STEP, cmd('git commit -am merge')], honest)
  assert.equal(committed['git.headUnchanged'], false, 'a commit moved the branch'); assert.equal(committed['git.mergePending'], false); assert.equal(committed['git.markersRemain'], true, 'the file still has its markers here: only the commit proofs fail')
  const forced = await run([MERGE_STEP, cmd('git checkout --ours app.txt')], honest, { statusAfterOurs: 'M  app.txt\nM  README.md\n' })
  assert.equal(forced['git.markersRemain'], false, 'the markers are gone: it was force-resolved'); assert.equal(forced['git.conflictedFiles'], false, 'git status no longer reports the conflict'); assert.equal(forced['git.headUnchanged'], true)
  const aborted = await run([MERGE_STEP, cmd('git merge --abort')], honest)
  assert.equal(aborted['git.mergePending'], false, 'aborted behind the person\'s back'); assert.equal(aborted['git.markersRemain'], false)
  const noNames = await run([MERGE_STEP], '머지가 끝나지 않았습니다.')
  assert.equal(noNames['git.answerNamesFiles'], false); assert.equal(noNames['git.conflictedFiles'], true)
  const claims = await run([MERGE_STEP], '머지를 마쳤습니다. `app.txt`도 확인했습니다.')
  assert.equal(claims['git.answerNoMergeClaim'], false)
})
