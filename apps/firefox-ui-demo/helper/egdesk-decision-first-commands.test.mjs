// c32 (U13): the decision-first command path, prototype behind EGDESK_DECISION_FIRST=on. Fake engine and a scripted Decision model: nothing is sent, nothing runs but the fake spawn.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs'
import path from 'node:path'
import { COMMAND_RESULT_KEY, DECISION_FIRST_LIMITS, DECISION_FIRST_PICK, buildCommandOptions, commandResultBlock, decidePick, pickRequest } from './egdesk-decision-first-commands.mjs'
import { createOwnToolsWiring } from './egdesk-own-tools-wiring.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createDecisionClient } from './egdesk-decision-client.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

const tmp = t => { const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-decision-first-')); t.after(() => fs.rmSync(base, { recursive: true, force: true })); return base }
const folder = (t, { scripts = { test: 'node --test', build: 'tsc', dev: 'vite', start: 'node server.js', deploy: 'rm -rf x && ./ship.sh' }, git = false, tests = false, pkg = true } = {}) => {
  const root = tmp(t); if (pkg) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts })); if (git) fs.mkdirSync(path.join(root, '.git')); if (tests) fs.mkdirSync(path.join(root, 'test')); return root
}

test('options come from the folder only and only in fixed forms: safe script names, a test folder, read-only git; servers, watchers and anything else are never offered', t => {
  const full = buildCommandOptions(folder(t, { git: true }))
  assert.deepEqual(full.map(o => [o.id, o.kind, o.command]), [['o1', 'script', 'npm test'], ['o2', 'script', 'npm run build'], ['o3', 'git', 'git status'], ['o4', 'git', 'git diff --stat'], ['o5', 'git', 'git log --oneline -n 10']])
  assert.ok(full.every(o => !/dev|start|deploy|vite|rm /.test(o.command)), 'no dev server, no start, no deploy script'); assert.ok(full.every(o => typeof o.what === 'string' && o.what.length > 10))
  assert.deepEqual(buildCommandOptions(folder(t, { pkg: false, tests: true })).map(o => o.command), ['node --test'], 'no package.json but a test folder')
  assert.deepEqual(buildCommandOptions(folder(t, { pkg: false })).map(o => o.command), [], 'nothing to offer')
  assert.deepEqual(buildCommandOptions(folder(t, { scripts: { lint: 'eslint .', 'test:unit': 'x' } })).map(o => o.command), ['npm run lint', 'npm run test:unit'])
  assert.deepEqual(buildCommandOptions(folder(t, { scripts: { 'bad name; rm': 'x', test: 5 } })).map(o => o.command), [], 'an odd name or a non-string script is skipped')
  assert.deepEqual(buildCommandOptions('/does/not/exist'), []); assert.ok(buildCommandOptions(folder(t, { git: true, scripts: Object.fromEntries(['test', 'build', 'lint', 'typecheck', 'check', 'format:check', 'test:unit', 'test:ci', 'compile'].map(n => [n, 'x'])) })).length <= DECISION_FIRST_LIMITS.options)
})

const raw = (choice, confidence, others = []) => ({ type: 'choice', name: DECISION_FIRST_PICK, choice, confidence, probabilities: [...others, { value: choice, probability: confidence }].sort((a, b) => a.probability - b.probability) })
const clientFor = pickOf => createDecisionClient({ getApiKey: () => 'egd-synthetic-not-a-key-0032', recipientForKey: () => 'a'.repeat(64), fetchImpl: async (url, init) => {
  const body = JSON.parse(init.body), q = body.questions.find(x => x.name === DECISION_FIRST_PICK), message = /"""\n([\s\S]*?)\n"""/.exec(body.input.find(m => m.role === 'user')?.content ?? '')?.[1] ?? ''
  const picked = pickOf({ message, choices: q?.choices ?? [], body }), answers = body.questions.map(x => (x.name === DECISION_FIRST_PICK ? { ...raw(picked.value, picked.confidence, picked.others) } : { name: x.name, type: 'predicate', probability: 0.05 }))
  return Response.json({ model: 'gpt-6-luna', answers, usage: { input_tokens: 40 } })
} })
const byWord = ({ message, choices }) => {
  const by = (re) => choices.find(c => re.test(c.description ?? ''))?.value
  if (/테스트|test/i.test(message)) return { value: by(/tests/) ?? 'none', confidence: 0.96, others: [{ value: 'none', probability: 0.02 }] }
  if (/git|깃/i.test(message)) return { value: by(/git status/) ?? 'none', confidence: 0.95, others: [{ value: 'none', probability: 0.03 }] }
  if (/빌드|build/i.test(message)) return { value: by(/"build"/) ?? 'none', confidence: 0.9, others: [{ value: 'none', probability: 0.05 }] }
  if (/애매/.test(message)) return { value: choices[0].value, confidence: 0.5, others: [{ value: 'none', probability: 0.4 }] }
  return { value: 'none', confidence: 0.97, others: [] }
}

test('the request is one choice question over the options and "none"; decidePick picks above the threshold, and every other outcome is the engine\'s', async t => {
  const options = buildCommandOptions(folder(t, { git: true })), req = pickRequest('테스트 돌려줘', options)
  assert.equal(req.questions.length, 1); assert.deepEqual(req.questions[0].choices.map(c => c.value), ['o1', 'o2', 'o3', 'o4', 'o5', 'none']); assert.match(JSON.stringify(req.input), /테스트 돌려줘/); assert.match(req.input[0].content, /none/)
  assert.equal(JSON.stringify(req).includes('rm -rf'), false, 'script bodies are never sent')
  const picked = await decidePick({ client: clientFor(byWord), message: '테스트 돌려줘', options }); assert.deepEqual([picked.status, picked.option.command], ['picked', 'npm test']); assert.ok(picked.confidence >= 0.9)
  assert.deepEqual((await decidePick({ client: clientFor(byWord), message: 'git 상태 봐줘', options })).option.command, 'git status')
  assert.deepEqual(await decidePick({ client: clientFor(byWord), message: '이 함수 설명해줘', options }).then(r => [r.status, r.reason]), ['engine', 'none'])
  assert.deepEqual(await decidePick({ client: clientFor(byWord), message: '애매한 말', options }).then(r => [r.status, r.reason]), ['engine', 'below_threshold'])
  assert.deepEqual(await decidePick({ client: { decide: async () => { throw new Error('down') } }, message: '테스트 돌려줘', options }).then(r => [r.status, r.reason]), ['engine', 'unreachable'])
  assert.deepEqual(await decidePick({ client: clientFor(byWord), message: '테스트 돌려줘', options: [] }).then(r => [r.status, r.reason]), ['engine', 'no_options']); assert.deepEqual(await decidePick({ client: null, message: 'x', options }).then(r => r.reason), 'unreachable')
  assert.deepEqual(await decidePick({ client: clientFor(() => ({ value: 'o9', confidence: 0.99, others: [] })), message: '테스트', options }).then(r => r.status), 'engine', 'an id that is not an option is never run')
})

test('commandResultBlock: facts only; a failure with counts and the last lines, a command that needs the person, a stopped one', () => {
  const failed = commandResultBlock({ command: 'npm test', status: 'ran', exitCode: 1, durationMs: 1800, health: 'unhealthy', tests: { passed: 4, failed: 1, total: 5 }, tail: 'not ok 3 - rounding\nℹ fail 1\n' })
  assert.match(failed, /^EG-Desk already ran this command for the person's message, with its own runner, before your turn; its result is below, so you need no tool call to see it\./)
  assert.match(failed, /Command: `npm test`/); assert.match(failed, /finished in 1\.8 s with exit code 1; EG-Desk's reading of the result: unhealthy\./); assert.match(failed, /counted 4 passed, 1 failed, 5 in total\./); assert.match(failed, /Last lines of its output:\nnot ok 3 - rounding\nℹ fail 1$/)
  assert.match(commandResultBlock({ command: 'npm run build', status: 'needs_person' }), /It was NOT run: it needs the person's approval first\./); assert.match(commandResultBlock({ command: 'x', status: 'stopped' }), /stopped before it finished/)
  assert.match(commandResultBlock({ command: 'git merge feature', status: 'ran', exitCode: 1, worktree: { state: 'conflict', files: ['app.txt'] } }), /files in conflict: app\.txt/); assert.equal(COMMAND_RESULT_KEY, 'egdesk_command_result')
  assert.ok(commandResultBlock({ command: 'x', status: 'ran', exitCode: 0, tail: 'y'.repeat(5000) }).length < 1800)
})

const PASS = 'ℹ tests 5\nℹ suites 0\nℹ pass 5\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 52.1\n', FAIL = 'ℹ tests 5\nℹ suites 0\nℹ pass 4\nℹ fail 1\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 49.3\n'
const until = async (predicate, ms = 4000) => { const end = Date.now() + ms; while (!predicate() && Date.now() < end) await new Promise(r => setTimeout(r, 5)); assert.ok(predicate(), 'condition not reached in time') }

function world(t, { flag = 'on', decisions = true, project = {}, outputs = { 'npm test': { text: PASS, code: 0 } }, pick = byWord, porcelain = '' } = {}) {
  const base = tmp(t), dataDir = path.join(base, 'egdesk-data'); fs.mkdirSync(dataDir)
  const root = folder(t, project), ran = [], engineCalls = [], decisionBodies = []
  const spawn = (file, args) => { const command = String(args.at(-1)); ran.push(command); const child = new EventEmitter(), out = outputs[command] ?? { text: 'ok\n', code: 0 }
    Object.assign(child, { pid: 7000 + ran.length, stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true }); setImmediate(() => { child.stdout.write(out.text); setTimeout(() => child.emit('close', out.code, null), 5) }); return child }
  let chat = null
  const wiring = createOwnToolsWiring({ env: { EGDESK_OWN_TOOLS: 'on', ...(flag ? { EGDESK_DECISION_FIRST: flag } : {}), PATH: '/usr/bin:/bin', HOME: '/home/synthetic' }, dataDir, spawn, getChat: () => chat, home: '/home/synthetic', gitStatus: async () => porcelain })
  const client = clientFor(args => { decisionBodies.push(args.body); return pick(args) })
  const replies = []
  chat = new CodexChatRuntime({
    request: async (method, params) => { engineCalls.push([method, params]); if (method === 'thread/start') return { thread: { id: 'conv-1' }, cwd: params.cwd }; if (method === 'turn/start') return { turn: { id: 'turn-eng-1', status: 'inProgress', items: [] } }; return {} },
    respond: (...args) => replies.push(args), emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null, getOwnerKey: () => 'codex:decision-first', toolProviders: wiring.toolProviders, ownTools: wiring.ownTools,
    decisionContext: { mode: () => (decisions ? 'on' : 'off'), configured: () => decisions, client, calibrationLog: openCalibrationLog({ dataDir: path.join(base, 'calibration'), log: () => {} }), terminalGate: wiring.terminalGate(null) } })
  chat.setConnection(true)
  return { chat, root, ran, engineCalls, decisionBodies, turnStarts: () => engineCalls.filter(([m]) => m === 'turn/start').map(([, p]) => p) }
}
const send = (w, message) => w.chat.send({ message, clientThreadId: 'ui', requestId: `r-${Math.random()}`, cwd: w.root })

test('card value (c32, a proposal): "테스트 돌려줘" runs npm test through EG-Desk\'s runner and ends the turn with NO engine call; the terminal card is the existing command item; the arbiter reads it healthy', async t => {
  const w = world(t, { flag: 'card' }), started = performance.now()
  const sent = await send(w, '테스트 돌려줘'), run = w.chat.runFor(sent)
  assert.equal(sent.accepted, true); assert.equal(w.turnStarts().length, 0, 'the engine was never asked for a turn'); assert.deepEqual(w.ran, ['npm test'])
  await until(() => run.status === 'completed')
  assert.deepEqual([run.decisionFirst.path, run.decisionFirst.reason, run.decisionFirst.option], ['fast', 'healthy', 'script']); assert.ok(run.decisionFirst.confidence >= 0.9)
  assert.deepEqual(run.ownCommands.map(c => [c.command, c.exitCode, c.health, c.summary.passed, c.summary.failed]), [['npm test', 0, 'healthy', 5, 0]])
  const card = run.activities.find(a => a.kind === 'commandExecution'); assert.ok(card, JSON.stringify(run.activities.map(a => a.kind))); assert.deepEqual([card.detail.command, card.detail.exitCode, card.status], ['npm test', 0, 'completed'])
  assert.equal(w.decisionBodies.length, 1, 'one Decision call'); assert.ok(run.runId.startsWith('egdesk-local-')); assert.ok(performance.now() - started < 3000, 'no model in the loop')
  // the answer-less run still has facts for any later check
  assert.match(w.chat.answerFactsEvidence(run).find(i => /^own1/.test(i.id)).text, /ran `npm test` with EG-Desk's own command tool; it finished with exit code 0/)
})

test('card value: a failing result goes to the engine WITH the result as context (no tool call needed); the engine turn is the ordinary one otherwise', async t => {
  const w = world(t, { flag: 'card', outputs: { 'npm test': { text: FAIL, code: 1 } } })
  const sent = await send(w, '테스트 돌려줘'), run = w.chat.runFor(sent)
  assert.equal(w.turnStarts().length, 1); const turn = w.turnStarts()[0]
  assert.equal(turn.input.at(-1).text, '테스트 돌려줘', 'the person\'s message is untouched'); const block = turn.additionalContext?.[COMMAND_RESULT_KEY]
  assert.equal(block.kind, 'application'); assert.match(block.value, /Command: `npm test`/); assert.match(block.value, /exit code 1; EG-Desk's reading of the result: unhealthy/); assert.match(block.value, /counted 4 passed, 1 failed, 5 in total/); assert.match(block.value, /so you need no tool call/)
  assert.deepEqual([run.decisionFirst.path, run.decisionFirst.reason], ['engine', 'result_for_engine']); assert.equal(run.runId, 'turn-eng-1'); assert.deepEqual(w.ran, ['npm test'], 'the command ran once, before the engine')
  assert.equal(run.ownCommands[0].summary.failed, 1, 'the check of the engine\'s answer sees the run\'s command as evidence')
})

test('everything else is the engine\'s, exactly as today: not a run request, below the threshold, Decisions off, flag off; no command runs and no result block is sent', async t => {
  for (const [name, setup, message, reason] of [['none', {}, '이 함수가 하는 일을 설명해줘', 'none'], ['threshold', {}, '애매한 말', 'below_threshold'], ['decisions off', { decisions: false }, '테스트 돌려줘', 'decisions_off']]) {
    const w = world(t, setup), sent = await send(w, message), run = w.chat.runFor(sent)
    assert.equal(w.turnStarts().length, 1, name); assert.deepEqual(w.ran, [], name); assert.equal(w.turnStarts()[0].additionalContext?.[COMMAND_RESULT_KEY], undefined, name); assert.deepEqual([run.decisionFirst.path, run.decisionFirst.reason], ['engine', reason], name)
    assert.equal(w.turnStarts()[0].input.at(-1).text, message)
  }
  for (const value of ['', 'ON', 'yes', 'fast']) { const odd = world(t, { flag: value }), sentOdd = await send(odd, '테스트 돌려줘'); assert.equal(odd.decisionBodies.length, 0, `value "${value}" is off`); assert.equal(odd.chat.runFor(sentOdd).decisionFirst, undefined); assert.deepEqual(odd.ran, []) }
  const off = world(t, { flag: false }), sent = await send(off, '테스트 돌려줘')
  assert.equal(off.decisionBodies.length, 0, 'no Decision call without the flag'); assert.equal(off.turnStarts().length, 1); assert.equal(off.chat.runFor(sent).decisionFirst, undefined); assert.deepEqual(off.ran, [])
})

test('git status: a read-only git option from the folder; a clean result ends locally, a conflict goes to the engine with the files', async t => {
  const w = world(t, { flag: 'card', project: { git: true, pkg: false }, outputs: { 'git status': { text: 'On branch main\nnothing to commit, working tree clean\n', code: 0 } } })
  const sent = await send(w, 'git 상태 봐줘'), run = w.chat.runFor(sent); await until(() => run.status === 'completed')
  assert.deepEqual(w.ran, ['git status']); assert.equal(w.turnStarts().length, 0); assert.deepEqual([run.decisionFirst.option, run.decisionFirst.path], ['git', 'fast'])
})

test('a conflict in git status is the engine\'s with the file names; a build with no summary ends locally; the local run has no assistant text and says completed', async t => {
  const conflict = world(t, { flag: 'card', project: { git: true, pkg: false }, porcelain: 'UU app.txt\nM  README.md\n', outputs: { 'git status': { text: 'You have unmerged paths.\n', code: 0 } } })
  const sent = await send(conflict, 'git 상태 봐줘'); assert.equal(conflict.turnStarts().length, 1, 'a conflict needs words: the engine'); assert.match(conflict.turnStarts()[0].additionalContext[COMMAND_RESULT_KEY].value, /files in conflict: app\.txt/)
  assert.deepEqual([conflict.chat.runFor(sent).decisionFirst.path, conflict.chat.runFor(sent).decisionFirst.reason], ['engine', 'result_for_engine'])
  const w = world(t, { flag: 'card', outputs: { 'npm run build': { text: 'built in 1.2s\n', code: 0 } } }), built = await send(w, '빌드해 봐'), run = w.chat.runFor(built)
  await until(() => run.status === 'completed'); assert.deepEqual(w.ran, ['npm run build']); assert.equal(w.turnStarts().length, 0)
  assert.deepEqual(run.messages.filter(m => m.role === 'assistant'), [], 'no assistant text: no new words'); assert.equal(run.decisionFirst.path, 'fast'); assert.equal(run.ownCommands[0].summary, null); assert.equal(run.ownCommands[0].health, 'healthy')
  assert.deepEqual(run.activities.filter(a => a.kind === 'commandExecution').map(a => a.detail.command), ['npm run build'])
})

// ---- c34: action first (the value "on"): the Decision model picks, EG-Desk runs, ONE engine round with the result; the engine talks ----
test('action first: the command runs BEFORE the engine, the engine is asked once with the result block and the person\'s own words, its run shows the command as the existing card; no local turn', async t => {
  const w = world(t), order = [], sent = await send(w, '테스트 돌려줘'), run = w.chat.runFor(sent)
  assert.equal(sent.accepted, true); assert.deepEqual(w.ran, ['npm test'], 'ran once'); assert.equal(w.turnStarts().length, 1, 'ONE engine round'); assert.equal(w.engineCalls.filter(([m]) => m === 'turn/start').length, 1)
  const turn = w.turnStarts()[0], block = turn.additionalContext?.[COMMAND_RESULT_KEY]; assert.equal(turn.input.at(-1).text, '테스트 돌려줘'); assert.match(block.value, /Command: `npm test`/); assert.match(block.value, /exit code 0; EG-Desk's reading of the result: healthy/); assert.match(block.value, /so you need no tool call/)
  assert.deepEqual([run.decisionFirst.path, run.decisionFirst.reason, run.decisionFirst.option], ['action', 'healthy', 'script']); assert.equal(run.runId, 'turn-eng-1', 'the engine\'s turn, not a local one')
  const card = run.activities.find(a => a.kind === 'commandExecution'); assert.ok(card, JSON.stringify(run.activities.map(a => a.kind))); assert.deepEqual([card.detail.command, card.detail.exitCode, card.status], ['npm test', 0, 'completed'])
  const firstDecision = w.engineCalls.findIndex(([m]) => m === 'turn/start'); assert.ok(firstDecision >= 0); assert.equal(w.decisionBodies.length, 1, 'one Decision call')
  assert.deepEqual(run.ownCommands.map(c => [c.command, c.exitCode, c.health]), [['npm test', 0, 'healthy']], 'the answer check sees the command as evidence')
  assert.equal(run.status === 'completed', false, 'the run is the engine\'s: it ends when the engine\'s turn ends')
})

test('action first: a failing result and a conflict also go to the engine once, with the facts, on the action path', async t => {
  const failing = world(t, { outputs: { 'npm test': { text: FAIL, code: 1 } } }), sent = await send(failing, '테스트 돌려줘'), run = failing.chat.runFor(sent)
  assert.equal(failing.turnStarts().length, 1); assert.match(failing.turnStarts()[0].additionalContext[COMMAND_RESULT_KEY].value, /counted 4 passed, 1 failed, 5 in total/)
  assert.deepEqual([run.decisionFirst.path, run.decisionFirst.reason], ['action', 'result_for_engine']); assert.equal(run.activities.find(a => a.kind === 'commandExecution').detail.exitCode, 1)
  const conflict = world(t, { project: { git: true, pkg: false }, porcelain: 'UU app.txt\n', outputs: { 'git status': { text: 'You have unmerged paths.\n', code: 0 } } }), gs = await send(conflict, 'git 상태 봐줘')
  assert.match(conflict.turnStarts()[0].additionalContext[COMMAND_RESULT_KEY].value, /files in conflict: app\.txt/); assert.equal(conflict.chat.runFor(gs).decisionFirst.path, 'action')
})

test('action first: what the Decision model does not pick, or must not run, is the engine path as today (none, below the threshold, approval needed); nothing ran without a pick', async t => {
  for (const [message, reason] of [['이 함수가 하는 일을 설명해줘', 'none'], ['애매한 말', 'below_threshold']]) {
    const w = world(t), sent = await send(w, message), run = w.chat.runFor(sent)
    assert.equal(w.turnStarts().length, 1, message); assert.deepEqual(w.ran, [], message); assert.equal(w.turnStarts()[0].additionalContext?.[COMMAND_RESULT_KEY], undefined); assert.deepEqual([run.decisionFirst.path, run.decisionFirst.reason], ['engine', reason]); assert.deepEqual(w.chat.openCommandItems('ui'), [])
  }
})

test('open items for the memory layer: a command that ran is one item in the shape of the resolver\'s candidates, with a closed summary and no output text; none without a run; at most 5', async t => {
  const w = world(t, { outputs: { 'npm test': { text: FAIL, code: 1 } } }); assert.deepEqual(w.chat.openCommandItems('ui'), [])
  const sent = await send(w, '테스트 돌려줘'), run = w.chat.runFor(sent), items = w.chat.openCommandItems('ui')
  assert.equal(items.length, 1); const [item] = items
  assert.deepEqual(Object.keys(item).sort(), ['aliases', 'id', 'kind', 'sourceRef', 'status', 'summary', 'timeSlice', 'title'])
  assert.deepEqual([item.id, item.kind, item.title, item.sourceRef, item.status, item.timeSlice], [`command:${run.answerId}`, 'conversation', 'npm test', `run:${run.answerId}`, 'unresolved', 'present'])
  assert.match(item.summary, /^ran, exit code 1, 4 passed, 1 failed$/); assert.doesNotMatch(JSON.stringify(item), /ℹ tests/); assert.deepEqual(w.chat.openCommandItems('other-thread'), [])
  // the shape is the one the memory resolver reads (kinds and time slices as its closed lists)
  assert.ok(['board', 'source', 'conversation', 'timeline', 'document'].includes(item.kind)); assert.ok(['past', 'present', 'planned', 'hypothetical', 'unknown'].includes(item.timeSlice))
})
