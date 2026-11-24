import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, readdir, stat, writeFile, chmod } from 'node:fs/promises'
import { CALIBRATION_FILE, MAX_ENTRIES, openCalibrationLog, normalizeEntry } from './egdesk-decision-calibration-log.mjs'
import { secretReason } from './egdesk-portable-extras.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'

const quiet = () => {}
const tmp = async () => { const d = await mkdtemp(path.join(os.tmpdir(), 'egdesk-calib-')); await chmod(d, 0o700); return path.join(d, 'settings') }
const entry = extra => ({ feature: 'turn_context', mode: 'advisory', judgments: [{ q: 'relevance', p: 0.42, threshold: 0.8, would: 'skip', kind: 'board', slice: 'planned' }], ...extra })

test('whitelist: free text, ids, URLs and unknown fields cannot enter an entry, only numbers and closed words', () => {
  const dirty = entry({ message: 'SECRET_MESSAGE', url: 'https://x.invalid', judgments: [
    { q: 'relevance', p: 0.4249999, would: 'attach', kind: 'board', slice: 'present', id: 'board:SECRET_ID', title: 'SECRET_TITLE', value: 'SECRET_VALUE', forced: 'SECRET_FORCED', top: 'SECRET', threshold: 7 },
    { q: 'free_text', would: 'attach' }, { q: 'recall', would: 'SECRET_WOULD' }, null, 'SECRET_ROW'] })
  const clean = normalizeEntry(dirty, Date.UTC(2026, 10, 24, 13, 5, 9))
  assert.deepEqual(clean, { feature: 'turn_context', mode: 'advisory', day: '2026-11-24',
    judgments: [{ q: 'relevance', would: 'attach', p: 0.425, kind: 'board', slice: 'present' }] })
  assert.ok(!/SECRET/.test(JSON.stringify(clean)))
  assert.equal(normalizeEntry(entry({ feature: 'other' })), null)
  assert.equal(normalizeEntry(entry({ mode: 'off' })), null)
})

test('file: 0600 in a private dir, atomic, survives reopen, label attaches by id, no clock time stored', async () => {
  const dataDir = await tmp()
  const log = openCalibrationLog({ dataDir, log: quiet })
  assert.equal(log.status, 'missing')
  const id = log.record(entry())
  assert.ok(id)
  assert.equal(log.complete(id, { run: 'completed', toolActivities: 2, text: 'SECRET_TEXT' }), true)
  const file = path.join(dataDir, CALIBRATION_FILE)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal((await stat(dataDir)).mode & 0o077, 0)
  assert.deepEqual((await readdir(dataDir)).sort(), [CALIBRATION_FILE])
  const text = await readFile(file, 'utf8')
  assert.ok(!/SECRET|T\d\d:\d\d/.test(text))
  const reopened = openCalibrationLog({ dataDir, log: quiet })
  assert.equal(reopened.status, 'saved')
  assert.deepEqual(reopened.entries()[0].outcome, { run: 'completed', toolActivities: 2 })
  assert.equal(reopened.complete('c999', { run: 'completed' }), false)
})

test('bounds: entry count, byte size and 30-day retention drop the oldest first', async () => {
  const dataDir = await tmp()
  let now = Date.UTC(2026, 10, 1)
  const log = openCalibrationLog({ dataDir, log: quiet, now: () => now })
  const big = entry({ judgments: Array.from({ length: 64 }, () => ({ q: 'relevance', p: 0.123, threshold: 0.5, would: 'skip', kind: 'document', slice: 'unknown' })) })
  for (let i = 0; i < MAX_ENTRIES + 40; i++) log.record(big)
  assert.ok(log.entries().length <= MAX_ENTRIES)
  assert.ok((await stat(path.join(dataDir, CALIBRATION_FILE))).size <= 192 * 1024 + 64)
  now = Date.UTC(2026, 11, 20) // 49 days later
  log.record(entry())
  assert.equal(log.entries().length, 1)
})

test('a damaged or foreign file is set aside, never trusted; an unusable directory only means nothing is kept', async () => {
  const dataDir = await tmp()
  openCalibrationLog({ dataDir, log: quiet })
  await writeFile(path.join(dataDir, CALIBRATION_FILE), '{"version":1,"entries":[{"feature":"turn_context","mode":"on","day":"2026-11-24","judgments":[],"message":"SECRET"}]}', { mode: 0o600 })
  const reopened = openCalibrationLog({ dataDir, log: quiet })
  assert.ok(!JSON.stringify(reopened.entries()).includes('SECRET'), 'unknown fields are stripped on read')
  await writeFile(path.join(dataDir, CALIBRATION_FILE), 'not json', { mode: 0o600 })
  const broken = openCalibrationLog({ dataDir, log: quiet })
  assert.equal(broken.status, 'recovered')
  assert.ok((await readdir(dataDir)).some(name => name.includes('.corrupt-')))
  const none = openCalibrationLog({ dataDir: 'relative/path', log: quiet })
  assert.equal(none.status, 'unavailable')
  assert.ok(none.record(entry()))
  assert.equal(none.entries().length, 1)
})

test('the calibration file name is treated as a credential-class name by the portable export filter', () => {
  assert.equal(secretReason(CALIBRATION_FILE), 'secret')
})

// ---- wiring through the real CodexChatRuntime: advisory turn, then inspect everything written ----
async function advisoryTurn({ mode = 'advisory', decide, logDir }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-calib-run-')); await chmod(dir, 0o700)
  const profiles = { runProfile: (p, r) => ({ binding: { profileId: p, revision: r ?? 1, hash: 'h' }, developerInstructions: 'x', toolCeiling: null, model: null }) }
  const store = openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'synthetic' })
  const calibrationLog = openCalibrationLog({ dataDir: logDir ?? path.join(dir, 'settings'), log: quiet })
  let turns = 0, threads = 0, params = null
  const chat = new CodexChatRuntime({ now: () => Date.now(), store, requireStore: true, getOwnerKey: () => 'codex:synthetic:qa', profiles, resolveProjectWorkspace: async () => null,
    request: async (method, p) => {
      if (method === 'thread/start') return { thread: { id: `t${++threads}` }, cwd: '/work', model: 'syn' }
      if (method === 'config/read') return { config: { developer_instructions: null } }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      params = p
      const id = `turn-${++turns}`, timing = { threadId: p.threadId, turnId: id }
      setTimeout(async () => { const n = (m, q) => chat.handleNotification({ method: m, params: q })
        await n('item/started', { ...timing, item: { id: 'a', type: 'agentMessage', phase: 'final_answer', text: '' } })
        await n('item/completed', { ...timing, item: { id: 'a', type: 'agentMessage', phase: 'final_answer', text: '네' } })
        await n('turn/completed', { threadId: p.threadId, turn: { id, status: 'completed', items: [] } }) }, 5)
      return { turn: { id, status: 'inProgress', items: [] } } },
    respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null,
    decisionContext: { calibrationLog, mode: () => mode, settingsGeneration: () => 0, configured: () => true, budgetMs: 5000,
      client: { model: 'syn', decide },
      collect: async () => [{ id: 'board:SECRET_ID', kind: 'board', title: 'SECRET_TITLE', summary: 'SECRET_SUMMARY', timeSlice: 'present', loadText: () => 'SECRET_BODY' },
        { id: 'board:2', kind: 'board', title: 'SECRET_TITLE_B', summary: 'SECRET_SUMMARY_B', timeSlice: 'planned' }] } })
  chat.setConnection(true)
  await chat.send({ message: 'SECRET_MESSAGE 알려줘', clientThreadId: 'dm-1', requestId: 'r1', profileId: 'sol', replyDestination: 'direct' })
  for (let i = 0; i < 150; i++) { await new Promise(r => setTimeout(r, 20)); if (store.getLatestRun('dm-1')?.status === 'completed') break }
  await new Promise(r => setTimeout(r, 40))
  const files = []
  const walk = async d => { for (const f of await readdir(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) await walk(p); else files.push(p) } }
  await walk(dir)
  store.close()
  return { calibrationLog, params, files, dir }
}
const answers = (low = false) => async req => {
  const a = {}
  for (const q of req.questions) a[q.name] = q.type === 'choice'
    ? { type: 'choice', choice: q.name === 'time_intent' ? 'present' : 'answer', confidence: 0.9, probabilities: [{ value: q.name === 'time_intent' ? 'present' : 'answer', probability: 0.9 }, { value: 'browse', probability: 0.04 }] }
    : { type: 'predicate', probability: q.name === 'rel_1' ? 0.42 : low ? 0.16 : 0.91 }
  return { answers: a, model: 'syn', usage: { inputTokens: 1 }, latencyMs: 3 }
}

test('advisory turn: the log keeps probabilities, the bar applied, what it would have done and the run label, and none of the private text; nothing is attached', async () => {
  const run = await advisoryTurn({ decide: answers() })
  assert.equal(run.params.additionalContext?.egdesk_decision_context, undefined, 'advisory still attaches nothing')
  const [e] = run.calibrationLog.entries()
  assert.equal(e.mode, 'advisory'); assert.equal(e.attached, false)
  assert.deepEqual(e.outcome, { run: 'completed', toolActivities: 0 })
  const rel = e.judgments.filter(j => j.q === 'relevance')
  assert.deepEqual(rel.map(j => [j.p, j.threshold, j.would]), [[0.91, 0.5, 'attach'], [0.42, 0.8, 'skip']], 'a rejected candidate keeps its probability; the strict bar for a planned item under a present question is recorded')
  assert.deepEqual(e.judgments.find(j => j.q === 'answer_type'), { q: 'answer_type', would: 'accept', top: 0.9, second: 0.04, threshold: 0.75, minMargin: 0, value: 'answer' })
  const logFile = run.files.find(f => f.endsWith(CALIBRATION_FILE))
  const text = await readFile(logFile, 'utf8')
  assert.ok(!/SECRET|dm-1|r1|sol/.test(text.replace(/"slice"|"threshold"/g, '')), text)
  assert.equal((await stat(logFile)).mode & 0o777, 0o600)
})

test('a timeout is recorded as a closed fallback word with no numbers invented; mode off records nothing', async () => {
  const { DecisionError } = await import('./egdesk-decision-client.mjs')
  const timedOut = await advisoryTurn({ decide: async () => { throw new DecisionError('timeout', 'SECRET_ERROR_TEXT') } })
  const [e] = timedOut.calibrationLog.entries()
  assert.deepEqual([e.fallback, e.judgments.length], ['timeout', 0])
  const off = await advisoryTurn({ mode: 'off', decide: answers() })
  assert.equal(off.calibrationLog.entries().length, 0)
  assert.equal(off.files.some(f => f.endsWith(CALIBRATION_FILE)), false)
})
