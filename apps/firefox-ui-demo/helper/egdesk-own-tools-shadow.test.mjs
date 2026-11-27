// c20: the own-tools SHADOW. Codex keeps its own tools; EG-Desk records, in closed words, what its own command tool and file rules
// would have done. Temp folders and a mock app-server only; nothing is run, blocked or answered by the shadow.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { shadowCommand, shadowFileChange } from './egdesk-own-tools-shadow.mjs'
import { createOwnToolsWiring } from './egdesk-own-tools-wiring.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { createPrivateQaTempDirectory } from '../scripts/egdesk-qa-platform.mjs'

function folder(t) {
  const base = fs.realpathSync(createPrivateQaTempDirectory('egdesk-own-tools-shadow-test-'))
  t.after(() => fs.rmSync(base, { recursive: true, force: true }))
  const root = path.join(base, 'project'), outside = path.join(base, 'outside')
  fs.mkdirSync(path.join(root, '.git'), { recursive: true }); fs.mkdirSync(outside)
  fs.writeFileSync(path.join(root, 'notes.md'), 'x\n'); fs.writeFileSync(path.join(root, 'build.log'), 'x\n')
  fs.symlinkSync(outside, path.join(root, 'linked-out'))
  return { base, root, outside }
}

test('commands: what the own command tool would do (floor and unjudged changes ask, outside refuses, the rest runs)', async t => {
  const { root } = folder(t)
  const judged = async (command, extra = {}) => shadowCommand({ command, root, home: '/home/synthetic', ...extra })
  assert.deepEqual(await judged('git reset --hard HEAD~5'), { subject: 'command', would: 'would_ask', reasons: ['discards_history'] })
  assert.deepEqual(await judged('npm test'), { subject: 'command', would: 'would_run', reasons: [] })
  assert.deepEqual(await judged('rm -rf build/'), { subject: 'command', would: 'would_ask', reasons: ['risk_unsure'] }, 'no judge: a changing command would ask')
  assert.deepEqual(await judged('rm -rf build/', { assess: async () => ({ approval: false, reasons: [], source: 'decision' }) }), { subject: 'command', would: 'would_run', reasons: [] })
  assert.deepEqual(await judged('git push origin main', { assess: async () => ({ approval: true, reasons: ['risk_outside'], source: 'decision' }) }), { subject: 'command', would: 'would_ask', reasons: ['risk_outside'] })
  assert.deepEqual(await judged('ls', { cwd: '/elsewhere' }), { subject: 'command', would: 'would_refuse', reasons: ['outside_folder'] })
  assert.deepEqual(await shadowCommand({ command: 'ls', root: null }), { subject: 'command', would: 'would_refuse', reasons: ['no_folder'] })
})

test('file changes: what the own file rules would do (creates and diffs run; a kept file\'s delete asks; protected, outside and link escapes refuse)', async t => {
  const { root, outside } = folder(t)
  const generated = async ({ paths }) => ({ targets: Object.fromEntries(paths.map(p => [p, { exists: true, trackedFiles: 0, ignored: p.endsWith('.log') }])) })
  const judged = (filePath, kind) => shadowFileChange({ filePath, kind, root, inspect: generated })
  assert.equal((await judged(path.join(root, 'notes.md'), 'update')).would, 'would_run')
  assert.equal((await judged('src/new.js', 'add')).would, 'would_run')
  assert.deepEqual(await judged(path.join(root, 'notes.md'), 'delete'), { subject: 'file_change', fileKind: 'delete', would: 'would_ask', reasons: ['kept_file_delete'] })
  assert.equal((await judged(path.join(root, 'build.log'), 'delete')).would, 'would_run', 'a generated file')
  assert.deepEqual((await judged(path.join(root, '.git', 'config'), 'update')).reasons, ['protected_path'])
  assert.deepEqual((await judged(path.join(outside, 'x.txt'), 'add')).reasons, ['outside_folder'])
  assert.deepEqual((await judged(path.join(root, 'linked-out', 'x.txt'), 'add')).reasons, ['symlink_escape'])
})

test('runtime, shadow on: Codex runs exactly as today; each command and file change it starts is recorded once in closed words; off records nothing', async t => {
  const { base, root } = folder(t)
  const observed = []
  for (const mode of [null, 'shadow']) {
    const log = openCalibrationLog({ dataDir: path.join(base, `calibration-${mode}`), log: () => {} })
    const calls = [], replies = [], events = []
    const wiring = mode ? createOwnToolsWiring({ env: { EGDESK_OWN_TOOLS: mode }, dataDir: base, spawn: () => { throw new Error('the shadow never spawns') }, getChat: () => null }) : null
    const chat = new CodexChatRuntime({
      request: async (method, params) => { calls.push([method, params]); if (method === 'thread/start') return { thread: { id: 'conv-1' }, cwd: params.cwd }
        if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress', items: [] } }; return {} },
      respond: (...args) => replies.push(args), emit: event => events.push(event.event), emitLegacy: () => {}, verifyFile: async () => null,
      toolProviders: wiring?.toolProviders ?? [], ...(wiring ? { ownTools: wiring.ownTools } : {}),
      decisionContext: { mode: () => 'off', configured: () => false, client: null, calibrationLog: log } })
    chat.setConnection(true)
    const run = await chat.send({ message: 'Clean up', clientThreadId: 'ui', requestId: 'r1', cwd: root })
    const base_ = { threadId: run.conversationId, turnId: run.runId }
    await chat.handleNotification({ method: 'item/started', params: { ...base_, item: { id: 'c1', type: 'commandExecution', command: 'git clean -fdx', cwd: root, status: 'inProgress' } } })
    await chat.handleNotification({ method: 'item/started', params: { ...base_, item: { id: 'c1', type: 'commandExecution', command: 'git clean -fdx', cwd: root, status: 'inProgress' } } })
    await chat.handleNotification({ method: 'item/started', params: { ...base_, item: { id: 'c2', type: 'commandExecution', command: 'npm test', cwd: root, status: 'inProgress' } } })
    await chat.handleNotification({ method: 'item/started', params: { ...base_, item: { id: 'f1', type: 'fileChange', status: 'inProgress',
      changes: [{ path: path.join(root, 'notes.md'), kind: { type: 'update' } }, { path: path.join(root, 'notes.md'), kind: { type: 'delete' } }, { path: path.join(root, '.git', 'HEAD'), kind: { type: 'update' } }] } } })
    await chat.handleServerRequest({ id: 7, method: 'item/commandExecution/requestApproval', params: { ...base_, itemId: 'c3', command: 'git push origin main', cwd: root, availableDecisions: ['accept', 'decline', 'cancel'] } })
    await chat.queue; await chat.shadowIdle()
    const records = log.entries().filter(e => e.feature === 'own_tools_shadow').map(e => e.shadow)
    observed.push({ mode, calls: JSON.stringify(calls), replies: JSON.stringify(replies), cards: chat.snapshot().runs[0].pendingApprovals.length, approvalEvents: events.filter(e => e === 'approval.required').length, records,
      raw: JSON.stringify(log.entries()) })
  }
  const [off, shadow] = observed
  assert.deepEqual([shadow.calls, shadow.replies, shadow.cards, shadow.approvalEvents], [off.calls, off.replies, off.cards, off.approvalEvents], 'the shadow changes nothing Codex or the person sees')
  assert.equal(off.cards, 1, 'the native approval card is shown as today (not declined)')
  assert.deepEqual(off.records, [])
  assert.deepEqual(shadow.records, [
    { subject: 'command', would: 'would_ask', engine: 'codex', reasons: ['deletes_untracked'] },
    { subject: 'command', would: 'would_run', engine: 'codex' },
    { subject: 'file_change', would: 'would_run', fileKind: 'update', engine: 'codex' },
    { subject: 'file_change', would: 'would_ask', fileKind: 'delete', engine: 'codex', reasons: ['kept_file_delete'] },
    { subject: 'file_change', would: 'would_refuse', fileKind: 'update', engine: 'codex', reasons: ['protected_path'] },
  ], 'one record per command (the repeated event is not counted twice) and per change')
  assert.doesNotMatch(shadow.raw, /git clean|npm test|notes\.md|project|\.git\/HEAD/, 'no command text and no path in the log')
})

test('wiring: EGDESK_OWN_TOOLS=shadow adds no provider, no ledger, no engine folder and leaves the gate configuration as it is', () => {
  const wiring = createOwnToolsWiring({ env: { EGDESK_OWN_TOOLS: 'shadow' }, dataDir: '/nowhere', spawn: () => { throw new Error('never') }, getChat: () => null })
  assert.equal(wiring.shadow, true); assert.deepEqual(wiring.toolProviders, []); assert.equal(wiring.ownTools.mode(), 'shadow'); assert.equal(wiring.ownTools.neutralFolder(), null)
  const gate = { mode: () => 'advisory' }
  assert.equal(wiring.terminalGate(gate), gate)
})
