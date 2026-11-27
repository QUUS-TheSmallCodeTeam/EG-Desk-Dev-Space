import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, chmod } from 'node:fs/promises'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { CALIBRATION_FILE, openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { buildWiki } from './egdesk-wiki-reconstruction.mjs'
import { SYNTHETIC_PAGES, createFakeClock, mockJudge, until } from './egdesk-wiki-reconstruction.fixture.mjs'

const quiet = () => {}
const profiles = { runProfile: (p, r) => ({ binding: { profileId: p, revision: r ?? 1, hash: 'h' }, developerInstructions: 'x', toolCeiling: null, model: null }) }

async function rig({ turnMemory, client, collectCalls }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-tm-wiring-')); await chmod(dir, 0o700)
  const store = openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'synthetic' })
  const calibrationLog = openCalibrationLog({ dataDir: path.join(dir, 'settings'), log: quiet })
  const turnStarts = []
  let turns = 0, threads = 0
  const chat = new CodexChatRuntime({ now: () => Date.now(), store, requireStore: true, getOwnerKey: () => 'codex:synthetic:qa', profiles, resolveProjectWorkspace: async () => null,
    request: async (method, p) => {
      if (method === 'thread/start') return { thread: { id: `t${++threads}` }, cwd: '/work', model: 'syn' }
      if (method === 'thread/resume') return { thread: { id: p.threadId, turns: [] }, cwd: '/work' }
      if (method === 'config/read') return { config: { developer_instructions: null } }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      turnStarts.push(JSON.stringify(p))
      const id = `turn-${++turns}`, timing = { threadId: p.threadId, turnId: id }
      const finish = async () => { const n = (m, q) => chat.handleNotification({ method: m, params: q })
        await n('item/started', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '' } })
        await n('item/completed', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '네' } })
        await n('turn/completed', { threadId: p.threadId, turn: { id, status: 'completed', items: [] } }) }
      setImmediate(() => setImmediate(finish)) // the engine answers after turn/start has returned
      return { turn: { id, status: 'inProgress', items: [] } } },
    respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null,
    decisionContext: { calibrationLog, mode: () => 'advisory', settingsGeneration: () => 0, configured: () => true, budgetMs: 800, client,
      collect: async () => { collectCalls?.push(1); return [] }, ...(turnMemory ? { turnMemory } : {}) } })
  chat.setConnection(true)
  // Waits for the answer itself, not for an amount of time.
  const done = async n => { await until(() => store.listMessages('dm-1').messages.filter(m => m.role === 'assistant' && m.status === 'complete').length >= n, `answer ${n} completed`); for (let i = 0; i < 3; i++) await new Promise(r => setImmediate(r)) }
  const send = (message, requestId, conversationId) => chat.send({ message, clientThreadId: 'dm-1', requestId, ...(conversationId ? { conversationId } : {}), profileId: 'sol', replyDestination: 'direct' })
  return { chat, store, calibrationLog, turnStarts, done, send, dir }
}
const wikiSource = () => { const wiki = buildWiki(SYNTHETIC_PAGES); return async () => wiki }
// Turn memory runs on a manual clock here: its deadline cannot pass because the machine was busy, and stage times are exact.
const memoryConfig = (extra = {}) => ({ mode: () => 'advisory', wiki: wikiSource(), ontologyWrite: true, clock: createFakeClock(), ...extra })
// the only per-run differences in turn/start params are generated ids
const normalize = text => text.replace(/"(?:clientId|requestId|localMessageId|localRunId)":"[^"]*"/g, '"id":"x"')

test('default off: without the flag, with mode off, or with a value that is not a mode, no memory call is made and the turn is unchanged', async () => {
  for (const turnMemory of [undefined, memoryConfig({ mode: () => 'off' }), memoryConfig({ mode: () => 'always' })]) {
    let calls = 0
    const r = await rig({ turnMemory, client: { model: 'syn', async decide() { calls++; return { answers: {} } } } })
    await r.send('PostgreSQL 마이그레이션 배포 끝났어', 'r1'); await r.done(1)
    await r.chat.turnMemoryIdle()
    assert.equal(calls, 0)
    assert.equal(r.calibrationLog.entries().length, 0)
    r.store.close()
  }
})

test('advisory records but changes nothing: turn/start params are identical with and without the flag, and the memory call happens after dispatch', async () => {
  const judge = mockJudge()
  const off = await rig({ client: { model: 'syn', decide: req => judge.decide(req) } })
  await off.send('PostgreSQL 마이그레이션 배포 끝났어', 'r1'); await off.done(1)
  const order = []
  const on = await rig({ turnMemory: memoryConfig(), client: { model: 'syn', async decide(req) { order.push(on.turnStarts.length); return judge.decide(req) } } })
  await on.send('PostgreSQL 마이그레이션 배포 끝났어', 'r1'); await on.done(1); await on.chat.turnMemoryIdle()
  assert.equal(normalize(on.turnStarts[0]), normalize(off.turnStarts[0]), 'byte-identical native input')
  assert.ok(!on.turnStarts[0].includes('egdesk_decision_context'), 'no memory packet reaches the answering model')
  assert.ok(order.length >= 2 && order.every(n => n >= 1), 'every memory request was made after turn/start')
  off.store.close(); on.store.close()
})

test('a slow or hanging memory call never delays the turn; a failing one never changes it', async () => {
  let release, asked = 0, released = false
  const hang = new Promise(resolve => { release = () => { released = true; resolve() } })
  const slow = await rig({ turnMemory: memoryConfig(), client: { model: 'syn', decide: () => { asked++; return hang.then(() => ({ answers: {} })) } } })
  await slow.send('PostgreSQL 마이그레이션 배포 끝났어', 'r1'); await slow.done(1)
  // The answer is complete while the memory call is asked, unanswered and still running: the turn did not wait for it.
  assert.deepEqual([asked >= 1, released, slow.chat.turnMemoryRuns.size], [true, false, 1])
  release(); await slow.chat.turnMemoryIdle()
  slow.store.close()
  const failing = await rig({ turnMemory: memoryConfig({ wiki: async () => { throw new Error('boom') } }), client: { model: 'syn', async decide() { throw new Error('x') } } })
  await failing.send('안녕', 'r1'); await failing.done(1); await failing.chat.turnMemoryIdle()
  assert.equal(failing.store.listMessages('dm-1').messages.filter(m => m.role === 'assistant' && m.status === 'complete').length, 1)
  failing.store.close()
})

test('no wiki, an ineligible turn, or an unconfigured decision setup: nothing runs', async () => {
  for (const turnMemory of [memoryConfig({ wiki: async () => null }), memoryConfig({ eligible: () => false })]) {
    let calls = 0
    const r = await rig({ turnMemory, client: { model: 'syn', async decide() { calls++; return { answers: {} } } } })
    await r.send('PostgreSQL 마이그레이션 배포 끝났어', 'r1'); await r.done(1); await r.chat.turnMemoryIdle()
    assert.equal(calls, 0); r.store.close()
  }
})

test('first turn then mid-session: positions, shadow receipts, stage timing and a content-free calibration entry with its label', async () => {
  const judge = mockJudge()
  const clock = createFakeClock() // every call moves this clock by exactly 15 ms; nothing else moves it
  const r = await rig({ turnMemory: memoryConfig({ clock }), client: { model: 'syn', async decide(req) { const answer = await judge.decide(req); clock.set(clock.now() + 15); return answer } } })
  const first = await r.send('PostgreSQL 마이그레이션 배포 끝났어', 'r1'); await r.done(1); await r.chat.turnMemoryIdle()
  await r.send('PostgreSQL 마이그레이션 배포 끝났어', 'r2', first.conversationId); await r.done(2); await r.chat.turnMemoryIdle()
  await r.send('고마워', 'r3', first.conversationId); await r.done(3); await r.chat.turnMemoryIdle()
  const entries = r.calibrationLog.entries().filter(e => e.feature === 'turn_memory')
  assert.deepEqual(entries.map(e => [e.position, e.memory]), [['first', 'ran'], ['mid', 'ran'], ['mid', 'skipped']])
  const [a, b, c] = entries
  // the default write target ('about'): one yes/no per candidate record (exactly one yes here), then the target the code derived
  const abouts = a.judgments.filter(j => j.q === 'write_about')
  assert.deepEqual(a.judgments.map(j => j.q), ['triage_courtesy', 'triage_need', 'triage_record', ...abouts.map(() => 'write_about'), 'write_target'])
  assert.equal(a.judgments.find(j => j.q === 'triage_record').would, 'attach')
  assert.ok(abouts.length >= 2); assert.deepEqual(abouts.map(j => j.would).sort(), ['accept', ...abouts.slice(1).map(() => 'reject')])
  assert.ok(abouts.every(j => j.threshold === 0.8 && j.minMargin === 0.2 && Number.isFinite(j.p)))
  assert.deepEqual(a.judgments.find(j => j.q === 'write_target'), { q: 'write_target', would: 'accept', options: abouts.length })
  assert.ok(Number.isFinite(a.timing.prepMs) && Number.isFinite(b.timing.prepMs), 'turn preparation time is recorded for first and mid turns')
  assert.ok(a.timing.calls >= 4 && typeof a.timing.withinBudget === 'boolean')
  // Read from the injected clock: every memory call moved it by 15, so the last one ends no earlier than 15 x calls (the log rounds times to
  // 10 ms; the client is shared with the other pre-turn judgments, which move the same clock, so only the lower bound is fixed).
  assert.ok(a.timing.totalMs >= 15 * a.timing.calls - 5 && a.timing.triageMs >= 10 && a.timing.totalMs % 10 === 0, JSON.stringify(a.timing))
  assert.ok(b.judgedTotal >= 0 && b.timing.fetchMs !== undefined, 'the mid-session turn used the shadow receipts of the first turn')
  assert.equal(c.judgments.find(j => j.q === 'triage_courtesy').would, 'skip'); assert.equal(c.timing.calls, 1, 'small talk costs one tiny call')
  assert.equal(a.attached, false); assert.equal(a.mode, 'advisory')
  assert.deepEqual(a.outcome?.run, 'completed', 'the run label was attached when the turn ended')
  const text = await readFile(path.join(r.dir, 'settings', CALIBRATION_FILE), 'utf8')
  assert.ok(!/PostgreSQL|배포|헬스체크|db\/|quote\/|dm-1|t1|고마워/.test(text), 'no text, page id or thread id in the file')
  assert.equal(r.chat.turnMemoryShadow.size, 1)
  r.store.close()
})

test('a failed fetch is recorded as a closed fallback and the turn is untouched', async () => {
  const { DecisionError } = await import('./egdesk-decision-client.mjs')
  const r = await rig({ turnMemory: memoryConfig({ ontologyWrite: false }), client: { model: 'syn', async decide() { throw new DecisionError('timeout', 'SECRET') } } })
  await r.send('PostgreSQL 마이그레이션 배포 끝났어', 'r1'); await r.done(1); await r.chat.turnMemoryIdle()
  const [e] = r.calibrationLog.entries().filter(x => x.feature === 'turn_memory')
  assert.deepEqual([e.memory, e.fallback, e.position], ['fallback', 'timeout', 'first'])
  assert.ok(!JSON.stringify(e).includes('SECRET'))
  r.store.close()
})

test('the "choice" write target can still be selected for comparison: its calibration entry is the N-way target with its bars', async () => {
  const judge = mockJudge()
  const r = await rig({ turnMemory: memoryConfig({ writeTarget: 'choice' }), client: { model: 'syn', decide: req => judge.decide(req) } })
  await r.send('PostgreSQL 마이그레이션 배포 끝났어', 'r1'); await r.done(1); await r.chat.turnMemoryIdle()
  const [a] = r.calibrationLog.entries().filter(e => e.feature === 'turn_memory')
  assert.deepEqual(a.judgments.map(j => j.q), ['triage_courtesy', 'triage_need', 'triage_record', 'write_target'])
  assert.deepEqual(a.judgments.find(j => j.q === 'write_target'), { q: 'write_target', would: 'accept', top: 0.93, second: 0.01, threshold: 0.75, minMargin: 0.2, confidence: 0.92, margin: 0.92, options: 8 })
})
