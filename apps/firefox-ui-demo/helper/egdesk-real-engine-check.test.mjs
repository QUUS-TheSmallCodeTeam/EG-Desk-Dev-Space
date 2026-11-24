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
import { BRIDGE_COMPOSITION, DECISION_KEY_ENV, appServerArgs, childEnv, createGroupKiller, formatPlan, loadScripts, parseArgs, planRun, preflight, runCheck } from './egdesk-real-engine-check.mjs'
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
  assert.ok(calls.length > 0); for (const c of calls) { assert.deepEqual(Object.keys(c).sort(), ['ms', 'names', 'p', 'status']); assert.ok(Object.values(c.p).every(v => typeof v === 'number' || typeof v === 'string')) }
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
  const fake = { turns: [{ steps: [{ delayMs: 400 }, { toolCall: { tool: 'egdesk_run_command', arguments: { command: 'npm test' } } }], final: 'The tests passed.' }] }
  const w = world(t, fake)
  w.deps.inspectNative = () => ({ version: '0.171.0-alpha.13', schemaMatch: false, boardPeerContract: null })
  const rec = only(await runCheck(w.options, asScripts(WHILE), w.deps))
  assert.equal(rec.aborted, null); assert.equal(rec.turns.length, 2)
  const [first, second] = rec.turns
  assert.equal(first.ok, true, JSON.stringify(first.expectations)); assert.equal(first.subTurns[0].status, 'completed', 'the working turn was not interrupted')
  assert.deepEqual(first.subTurns[0].commandsRan, ['npm test'])
  assert.equal(second.ok, true, JSON.stringify(second.expectations)); assert.deepEqual(second.whileRunning, { afterMs: 60 })
  assert.equal(second.subTurns[0].accepted, true); assert.equal(second.expectations[0].check, 'sent_while_running'); assert.ok(second.subTurns[0].sentAtMs >= 60 && second.subTurns[0].sentAtMs < 400, 'sent ' + second.subTurns[0].sentAtMs + ' ms after the first turn started')
  assert.match(second.posted.at(-1), /tests passed/, 'the messages after it was sent include the run\'s own answer')
  assert.equal(wireLog(w).filter(m => m.dir === 'in' && m.method === 'turn/start').length, 1, 'the message typed into the run started no turn of its own')
  assert.deepEqual(rec.engine.nativeContract, { version: '0.171.0-alpha.13', schemaMatch: false, boardPeerContract: false }, 'the steer contract the product would use: none on this binary')
  noSchemaErrors(w)
})

test('whileRunning: a run that ended before afterMs no longer takes the message; the turn fails its implicit check with the runtime\'s closed code', async t => {
  const late = structuredClone(WHILE); late.conversations[0].turns[1].whileRunning.afterMs = 500
  const w = world(t, { turns: [{ steps: [{ toolCall: { tool: 'egdesk_run_command', arguments: { command: 'npm test' } } }], final: 'The tests passed.' }] })
  w.deps.inspectNative = () => ({ version: '0.171.0-alpha.13', schemaMatch: true, boardPeerContract: 'c'.repeat(64) })
  const rec = only(await runCheck(w.options, asScripts(late), w.deps))
  const second = rec.turns[1]
  assert.equal(second.ok, false); assert.equal(second.subTurns[0].accepted, false); assert.equal(second.subTurns[0].error, 'INRUN_MESSAGE_UNAVAILABLE')
  assert.deepEqual(second.expectations[0], { check: 'sent_while_running', ok: false, detail: { afterMs: 500, sentAtMs: second.expectations[0].detail.sentAtMs, error: 'INRUN_MESSAGE_UNAVAILABLE' } })
  assert.equal(rec.turns[0].ok, true, 'the first turn is judged on its own record'); assert.equal(rec.ok, false)
  assert.equal(rec.engine.nativeContract.boardPeerContract, true)
})
