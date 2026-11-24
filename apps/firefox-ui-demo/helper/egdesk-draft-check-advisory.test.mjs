import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'
import { mkdtempSync, chmodSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Advisory draft check wired after the final answer is posted (flag default off). Mock engine, mock Decisions, no network.
const ANSWER = 'PostgreSQL 마이그레이션은 현재 운영 중입니다.'
const PLAN = { id: 'doc:pg', kind: 'document', title: 'PostgreSQL 이전 계획', summary: '다음 분기에 전환 예정', timeSlice: 'planned', loadText: () => 'full body is never sent to the checker' }

function judgeAnswers(request) {
  const answers = {}
  for (const q of request.questions) {
    if (q.name === 'answer_type' || q.name === 'time_intent') answers[q.name] = { type: 'choice', choice: q.choices[0].value, confidence: 0.9, probabilities: [{ value: q.choices[0].value, probability: 0.9 }] }
    else if (/^claim_/.test(q.name)) answers[q.name] = { type: 'choice', choice: 'supported', confidence: 0.95, probabilities: [{ value: 'supported', probability: 0.96 }, { value: 'insufficient', probability: 0.02 }] }
    else if (/^present_/.test(q.name)) answers[q.name] = { type: 'predicate', probability: 0.93 }
    else answers[q.name] = { type: 'predicate', probability: q.name === 'rel_0' ? 0.95 : 0.04 }
  }
  return { answers, model: 'mock', usage: { inputTokens: 5 }, latencyMs: 3 }
}

function world(t, { draftCheck: dc, decisionMode = 'on', tools = false, check = null, candidates = [PLAN] } = {}) {
  const draftCheck = dc ? { eligible: () => true, ...dc } : dc
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-dc-')); chmodSync(dir, 0o700)
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const events = [], native = [], checkCalls = []
  let clock = 1_000_000, turns = 0, threads = 0
  const log = openCalibrationLog({ dataDir: dir, log() {} })
  const client = { model: 'mock', async decide(request) {
    if (request.promptCacheKey === 'draft-check') { checkCalls.push(request); return check ? check(request) : judgeAnswers(request) }
    return judgeAnswers(request)
  } }
  const chat = new CodexChatRuntime({
    now: () => ++clock,
    request: async (method, params) => {
      native.push([method, JSON.stringify(params)])
      if (method === 'thread/start') return { thread: { id: `thread-${++threads}` }, cwd: '/work', model: 'm' }
      if (method === 'config/read') return { config: { developer_instructions: null } }
      if (method === 'turn/start') {
        const id = `turn-${++turns}`, timing = { threadId: params.threadId, turnId: id }
        setTimeout(async () => {
          const n = (m, p) => chat.handleNotification({ method: m, params: p })
          if (tools) { await n('item/started', { ...timing, item: { id: 'cmd1', type: 'commandExecution', command: 'ls', cwd: '/work', status: 'inProgress', commandActions: [], aggregatedOutput: '' } })
            await n('item/completed', { ...timing, item: { id: 'cmd1', type: 'commandExecution', command: 'ls', cwd: '/work', status: 'completed', commandActions: [], aggregatedOutput: 'SECRET TOOL OUTPUT', exitCode: 0 } }) }
          await n('item/started', { ...timing, item: { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: '' } })
          await n('item/agentMessage/delta', { ...timing, itemId: 'a1', delta: ANSWER })
          await n('item/completed', { ...timing, item: { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: ANSWER } })
          await n('turn/completed', { threadId: params.threadId, turn: { id, status: 'completed', items: [] } })
        }, 5)
        return { turn: { id, status: 'inProgress', items: [] } }
      }
      if (method === 'turn/interrupt') return {}
      throw new Error(`Unexpected ${method}`)
    },
    respond() {}, emit: e => events.push(e), emitLegacy() {}, verifyFile: async () => null,
    decisionContext: { mode: () => decisionMode, configured: () => true, client, budgetMs: 800, calibrationLog: log,
      ...(draftCheck ? { draftCheck } : {}), collect: async () => candidates },
  })
  chat.setConnection(true)
  const ask = async () => {
    await chat.send({ message: 'PostgreSQL 마이그레이션 상태는?', clientThreadId: 'dm-1', conversationId: undefined })
    for (let i = 0; i < 300 && !events.some(e => e.event === 'message.completed'); i++) await new Promise(r => setTimeout(r, 10))
    await new Promise(r => setTimeout(r, 30))
    await chat.draftCheckIdle()
  }
  return { chat, events, native, checkCalls, log, ask, dir }
}
const volatile = text => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'UUID').replace(/"(?:ts|createdAt|updatedAt|completedAt|startedAt)":\d+/g, '"T":0')
const posted = w => JSON.stringify(w.events.map(e => [e.event, e.details?.text ?? e.delta ?? null, e.details?.phase ?? null]))

test('flag absent, off and advisory post byte-identical answers and an identical event stream; advisory only adds one calibration entry', async t => {
  const none = world(t), off = world(t, { draftCheck: { mode: () => 'off' } }), adv = world(t, { draftCheck: { mode: () => 'advisory' } })
  await none.ask(); await off.ask(); await adv.ask()
  assert.equal(none.checkCalls.length + off.checkCalls.length, 0)
  assert.equal(adv.checkCalls.length, 1, 'advisory made exactly one draft-check request')
  assert.ok(none.events.some(e => e.event === 'message.completed' && e.details.text === ANSWER))
  assert.equal(posted(off), posted(none)); assert.equal(posted(adv), posted(none))
  assert.equal(volatile(JSON.stringify(adv.events)), volatile(JSON.stringify(none.events)), 'no event, activity or UI row was added')
  assert.equal(JSON.stringify(adv.native.map(x => x[0])), JSON.stringify(none.native.map(x => x[0])), 'same native calls')
  assert.equal(volatile(JSON.stringify(adv.native.filter(x => x[0] === 'turn/start'))), volatile(JSON.stringify(none.native.filter(x => x[0] === 'turn/start'))))
  assert.equal(none.log.entries().filter(e => e.feature === 'draft_check').length, 0)
  assert.equal(off.log.entries().filter(e => e.feature === 'draft_check').length, 0)
  const sha = w => createHash('sha256').update(volatile(JSON.stringify(w.events))).digest('hex').slice(0, 16)
  t.diagnostic(`event stream sha256[:16] none=${sha(none)} off=${sha(off)} advisory=${sha(adv)}; posted answer sha256[:16] none=${createHash('sha256').update(posted(none)).digest('hex').slice(0, 16)} advisory=${createHash('sha256').update(posted(adv)).digest('hex').slice(0, 16)}`)
  const entries = adv.log.entries().filter(e => e.feature === 'draft_check')
  assert.equal(entries.length, 1)
  const [entry] = entries
  t.diagnostic(`advisory calibration entry: ${JSON.stringify(entry)}`)
  assert.equal(entry.mode, 'advisory'); assert.equal(entry.attached, false)
  assert.equal(entry.check, 'would_revise'); assert.ok(['would_trim', 'would_ask'].includes(entry.ifUnrevised))
  assert.ok(entry.timing.totalMs >= 0 && entry.timing.calls === 1 && typeof entry.timing.withinBudget === 'boolean')
  assert.deepEqual(entry.evidence, { items: 1, opaque: 0, sentences: 1, terms: 0 })
  const text = JSON.stringify(entry)
  for (const secret of ['PostgreSQL', '마이그레이션', '계획', ANSWER]) assert.ok(!text.includes(secret), `no content in the entry: ${secret}`)
  // The request carries catalog text already sent to Decisions, never the loaded body.
  const wire = JSON.stringify(adv.checkCalls[0].input)
  assert.ok(wire.includes('다음 분기에 전환 예정')); assert.ok(!wire.includes('full body is never sent'))
})

test('a hanging check (ignores its signal) or a failing one never changes, delays or breaks the run', async t => {
  const hang = world(t, { draftCheck: { mode: () => 'advisory', deadlineMs: 60 }, check: () => new Promise(() => {}) })
  const fail = world(t, { draftCheck: { mode: () => 'advisory' }, check: () => { throw new Error('provider exploded') } })
  const none = world(t)
  const started = performance.now()
  await hang.ask()
  assert.ok(performance.now() - started < 2500)
  await fail.ask(); await none.ask()
  assert.equal(posted(hang), posted(none)); assert.equal(posted(fail), posted(none))
  assert.equal(volatile(JSON.stringify(hang.events)), volatile(JSON.stringify(none.events)))
  const h = hang.log.entries().find(e => e.feature === 'draft_check'), f = fail.log.entries().find(e => e.feature === 'draft_check')
  assert.equal(h.fallback, 'timeout'); assert.equal(f.fallback, 'unreachable')
  assert.equal(hang.chat.draftCheckRuns.size, 0)
})

test('mode off, a missing key or an ineligible turn run no check; guarded or unknown evidence is skipped without a request', async t => {
  const off = world(t, { draftCheck: { mode: () => 'advisory' }, decisionMode: 'off' })
  await off.ask()
  assert.equal(off.checkCalls.length, 0); assert.equal(off.log.entries().filter(e => e.feature === 'draft_check').length, 0)
  const w = world(t, { draftCheck: { mode: () => 'advisory', eligible: undefined } })
  const run = {}, body = { message: 'x' }, ctx = { channelKind: 'direct' }
  const turn = decision => { w.chat.noteDraftCheckTurn(run, body, ctx, decision, false); return w.chat.draftCheckTurns.get(run) }
  assert.equal(turn({ mode: 'on', result: { status: 'ready', draftEvidence: [{ id: 'a', text: 't', guarded: true }] } }).skip, 'guarded')
  assert.equal(turn({ mode: 'on', result: { status: 'ready', privateTopicBatch: true } }).skip, 'guarded')
  assert.equal(turn({ mode: 'on', result: { status: 'ready' } }).skip, 'unknown')
  assert.equal(turn({ mode: 'advisory', result: { status: 'ready', draftEvidence: [{ id: 'a', text: 't' }] } }).evidence.length, 0, 'advisory context attached nothing, so the model had no packet')
  assert.equal(turn(null).skip, null)
  for (const bad of [{ channelKind: 'board' }, { channelKind: 'direct', stateless: true }, { channelKind: 'direct', board: {} }]) {
    w.chat.noteDraftCheckTurn(run, body, bad, null, false); assert.equal(w.chat.draftCheckTurns.get(run).skip, 'ineligible')
  }
  w.chat.noteDraftCheckTurn(run, body, ctx, null, true); assert.equal(w.chat.draftCheckTurns.get(run).skip, 'ineligible')
})

test('tool use reaches the checker as content-free references only; a claim then cannot be called unverified', async t => {
  const w = world(t, { draftCheck: { mode: () => 'advisory' }, tools: true, candidates: [],
    check: request => { const a = judgeAnswers(request); for (const q of request.questions) if (/^claim_/.test(q.name)) a.answers[q.name] = { type: 'choice', choice: 'not_mentioned', confidence: 0.95, probabilities: [{ value: 'not_mentioned', probability: 0.96 }, { value: 'supported', probability: 0.02 }] }
      for (const q of request.questions) if (/^present_/.test(q.name)) a.answers[q.name] = { type: 'predicate', probability: 0.02 }; return a } })
  await w.ask()
  assert.equal(w.checkCalls.length, 0, 'only opaque references: nothing for the judge to compare with')
  const entry = w.log.entries().find(e => e.feature === 'draft_check')
  assert.ok(entry, 'recorded')
  assert.equal(entry.check, 'would_pass'); assert.deepEqual(entry.evidence, { items: 0, opaque: 1, sentences: 1, terms: 0 })
  assert.ok(!JSON.stringify(w.checkCalls).includes('SECRET'))
  assert.ok(!JSON.stringify(entry).includes('SECRET'))
})
