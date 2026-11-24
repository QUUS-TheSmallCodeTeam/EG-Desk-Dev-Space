import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readFile, chmod } from 'node:fs/promises'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { CALIBRATION_FILE, openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { buildWiki } from './egdesk-wiki-reconstruction.mjs'
import { SYNTHETIC_PAGES, mockJudge } from './egdesk-wiki-reconstruction.fixture.mjs'

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
      setTimeout(async () => { const n = (m, q) => chat.handleNotification({ method: m, params: q })
        await n('item/started', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '' } })
        await n('item/completed', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '네' } })
        await n('turn/completed', { threadId: p.threadId, turn: { id, status: 'completed', items: [] } }) }, 5)
      return { turn: { id, status: 'inProgress', items: [] } } },
    respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null,
    decisionContext: { calibrationLog, mode: () => 'advisory', settingsGeneration: () => 0, configured: () => true, budgetMs: 800, client,
      collect: async () => { collectCalls?.push(1); return [] }, ...(turnMemory ? { turnMemory } : {}) } })
  chat.setConnection(true)
  const done = async n => { for (let i = 0; i < 250; i++) { await new Promise(r => setTimeout(r, 20)); if (store.listMessages('dm-1').messages.filter(m => m.role === 'assistant' && m.status === 'complete').length >= n) break } await new Promise(r => setTimeout(r, 30)) }
  const send = (message, requestId, conversationId) => chat.send({ message, clientThreadId: 'dm-1', requestId, ...(conversationId ? { conversationId } : {}), profileId: 'sol', replyDestination: 'direct' })
  return { chat, store, calibrationLog, turnStarts, done, send, dir }
}
const wikiSource = () => { const wiki = buildWiki(SYNTHETIC_PAGES); return async () => wiki }
const memoryConfig = (extra = {}) => ({ mode: () => 'advisory', wiki: wikiSource(), ontologyWrite: true, ...extra })
// the only per-run differences in turn/start params are generated ids
const normalize = text => text.replace(/"(?:clientId|requestId|localMessageId|localRunId)":"[^"]*"/g, '"id":"x"')

test('default off: without the flag, with mode off, or with the unimplemented "on", no memory call is made and the turn is unchanged', async () => {
  for (const turnMemory of [undefined, memoryConfig({ mode: () => 'off' }), memoryConfig({ mode: () => 'on' })]) {
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
  let release
  const hang = new Promise(resolve => { release = resolve })
  const slow = await rig({ turnMemory: memoryConfig(), client: { model: 'syn', decide: () => hang.then(() => ({ answers: {} })) } })
  const started = Date.now()
  await slow.send('PostgreSQL 마이그레이션 배포 끝났어', 'r1'); await slow.done(1)
  assert.ok(Date.now() - started < 3000, 'the turn completed while the memory call is still pending')
  assert.equal(slow.chat.turnMemoryRuns.size, 1)
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
  const r = await rig({ turnMemory: memoryConfig(), client: { model: 'syn', async decide(req) { await new Promise(res => setTimeout(res, 15)); return judge.decide(req) } } })
  const first = await r.send('PostgreSQL 마이그레이션 배포 끝났어', 'r1'); await r.done(1); await r.chat.turnMemoryIdle()
  await r.send('PostgreSQL 마이그레이션 배포 끝났어', 'r2', first.conversationId); await r.done(2); await r.chat.turnMemoryIdle()
  await r.send('고마워', 'r3', first.conversationId); await r.done(3); await r.chat.turnMemoryIdle()
  const entries = r.calibrationLog.entries().filter(e => e.feature === 'turn_memory')
  assert.deepEqual(entries.map(e => [e.position, e.memory]), [['first', 'ran'], ['mid', 'ran'], ['mid', 'skipped']])
  const [a, b, c] = entries
  assert.deepEqual(a.judgments.map(j => j.q), ['triage_courtesy', 'triage_need', 'triage_record', 'write_target'])
  assert.equal(a.judgments.find(j => j.q === 'triage_record').would, 'attach')
  assert.deepEqual(a.judgments.find(j => j.q === 'write_target'), { q: 'write_target', would: 'accept', top: 0.93, second: 0.01, threshold: 0.75, minMargin: 0.2, confidence: 0.92, margin: 0.92, options: 8 })
  assert.ok(Number.isFinite(a.timing.prepMs) && Number.isFinite(b.timing.prepMs), 'turn preparation time is recorded for first and mid turns')
  assert.ok(a.timing.calls >= 4 && a.timing.totalMs >= 30 && typeof a.timing.withinBudget === 'boolean' && a.timing.triageMs > 0)
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
