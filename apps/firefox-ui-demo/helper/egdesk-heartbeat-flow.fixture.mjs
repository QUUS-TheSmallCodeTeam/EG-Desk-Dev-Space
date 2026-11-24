import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openCalibrationLog } from './egdesk-decision-calibration-log.mjs'

// The live-session heartbeat inside the real runtime, over a mock engine and a mock decision model, on a virtual clock:
// virtual monotonic time and virtual timers drive the beats; nothing touches the network or a Codex binary.
export const A = 'first-agent'
export const MID = '이 부분은 시간이 좀 걸립니다. 계속 확인하고 있어요.'
export const SLOW = '응답이 평소보다 늦어지고 있어요. 조금 더 기다리시거나 중지하고 다시 요청하셔도 됩니다.'

// The mock decision model for the heartbeat's message questions. The product asks yes/no questions (message__ask, message__pointer,
// message__told_N, message__note) and code derives the kind; the mock works the other way round so tests can still say "the model
// picked this kind": `offered` is the kinds CODE allowed at that beat (read from the runtime, see world()), restricted to those whose
// question was asked; it picks one (policy.message(values, request), or a default policy) and answers yes to that kind's question
// (ask_missing -> ask, pointer -> pointer, a progress note / milestone / stall -> note) and no to every other one (told_N included).
//   seen row: { offered, pick, facts: the Session block, own: the provider's material and the question blocks, names }
const PREDICATE_OF_KIND = { ask_missing: 'message__ask', pointer: 'message__pointer', explain_wait: 'message__note', milestone: 'message__note', stalled: 'message__note' }
export function judge(request, seen, policy = {}, allowed = null) {
  const answers = {}
  const texts = request.input.map(row => (typeof row.content === 'string' ? row.content : ''))
  const asked = request.questions.filter(q => /^message__/.test(q.name)).map(q => q.name)
  if (asked.length) {
    const context = texts.find(text => text.startsWith('What the message questions are about:')) ?? ''
    // Without the runtime at hand (a caller that passes only the request), the kinds are read from the material like a model would:
    // a stall when the work has been silent for the 20 s bound.
    const silence = Number(/The last sign of activity from the work was (\d+) seconds? ago\./.exec(context)?.[1] ?? 0)
    const kinds = allowed ?? ['none', 'ask_missing', 'pointer', 'explain_wait', ...(silence >= 20 ? ['stalled'] : [])]
    const values = ['none', ...kinds.filter(kind => kind !== 'none' && asked.includes(PREDICATE_OF_KIND[kind]))], text = texts[1]
    const num = name => Number(new RegExp(`${name}: (\\d+)`).exec(text)?.[1] ?? 0)
    const pick = typeof policy.message === 'function' ? policy.message(values, request) : values.includes('stalled') ? 'stalled' : values.includes('ask_missing') ? 'ask_missing'
      : values.includes('explain_wait') && num('tool_steps_done') + num('tool_steps_running') > 0 ? 'explain_wait' : 'none'
    seen.push({ offered: values, pick, facts: text, names: asked, own: [context, ...texts.filter(row => /^Question message__/.test(row))].join('\n') })
    for (const name of asked) answers[name] = { type: 'predicate', probability: PREDICATE_OF_KIND[pick] === name ? 0.97 : 0.03 }
  }
  for (const q of request.questions) {
    if (answers[q.name]) continue
    if (typeof policy[q.name] === 'function') {
      const pick = policy[q.name](q, request), values = q.choices.map(c => c.value)
      answers[q.name] = { type: 'choice', choice: pick, confidence: 0.95, probabilities: [{ value: pick, probability: 0.96 }, { value: values.find(v => v !== pick), probability: 0.02 }] }
    } else if (q.type === 'choice') answers[q.name] = { type: 'choice', choice: /^claim_/.test(q.name) ? 'supported' : q.choices[0].value, confidence: 0.95, probabilities: [{ value: /^claim_/.test(q.name) ? 'supported' : q.choices[0].value, probability: 0.96 }, { value: 'insufficient', probability: 0.02 }] }
    // the draft check's predicate design: a sound judge (supported, no tense mismatch)
    else if (/^sup_\d+$/.test(q.name)) answers[q.name] = { type: 'predicate', probability: 0.96 }
    else answers[q.name] = { type: 'predicate', probability: 0.03 }
  }
  return { answers, model: 'mock', usage: { inputTokens: 5 }, latencyMs: 3 }
}


// writer(prompt) → the fork writer's text (or a promise of it); attentionPosted: the bridge's hook; flags.commands: the engine-command judge (advisory);
// tap(request): called with every decision request before the mock answers it.
export function world(t, { flags = { held: true, flow: true }, fork = 'ok', failTurn = false, presence = null, audience = null, policy = {}, writer = null, attentionPosted = null, tap = null, steer = 'ok' } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egd-beat-')); chmodSync(dir, 0o700)
  const store = openChatStore({ dataDir: dir, ownerScope: 'synthetic-beat' })
  const log = openCalibrationLog({ dataDir: dir, log() {} })
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })
  let clock = 9_000_000, threads = 0, forks = 0, turns = 0
  const timers = [], events = [], native = [], flowAsked = [], beatRequests = [], requests = { flow: 0, draft: 0, other: 0 }, forkPrompts = [], startedFresh = []
  const client = { model: 'mock', async decide(request) {
    if (request.promptCacheKey === 'heartbeat-beat') requests.flow++
    else if (request.promptCacheKey === 'draft-check') requests.draft++
    else requests.other++
    if (request.promptCacheKey === 'heartbeat-beat') beatRequests.push({ names: request.questions.map(q => q.name), input: request.input.map(row => row.content) })
    if (tap) await tap(request) // sees every request exactly as the product built it (the real-measurement plan records them)
    return judge(request, flowAsked, policy, allowedNow())
  } }
  // The kinds code allowed for the message questions of the request being judged (the subject whose proposal is pending).
  const allowedNow = () => {
    for (const key of chat.heartbeats.keys()) {
      const subject = chat.heartbeatSubjects.get(chat.heartbeats.get(key))
      if (subject?.proposal?.mode === 'run') return subject.proposal.flow.pendingOptions ?? null
      if (subject?.proposal?.mode === 'idle') return ['none', 'pointer']
    }
    return null
  }
  const chat = new CodexChatRuntime({
    store, requireStore: true, getOwnerKey: () => 'test-account', now: () => clock, monotonicNow: () => clock,
    setTimer: (fn, ms) => { const timer = { fn, at: clock + ms }; timers.push(timer); return timer },
    clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1) },
    getBoardPeerContract: () => 'c'.repeat(64),
    profiles: { runProfile: profileId => ({ binding: { profileId, revision: 1, hash: `h-${profileId}` }, developerInstructions: `Agent ${profileId}` }) },
    resolveProjectWorkspace: async () => null, respond() {}, emit: e => events.push(e), emitLegacy() {}, verifyFile: async () => null,
    request: async (method, params) => {
      native.push([method, params])
      // What a bounded (read-only QA) run asks of the engine before its turn.
      if (method === 'experimentalFeature/list') return { data: ['browser_use', 'browser_use_external', 'computer_use'].map(name => ({ name, enabled: false, stage: 'stable' })), nextCursor: null }
      if (method === 'mcpServerStatus/list') return { data: [], nextCursor: null }
      if (method === 'config/read') return { config: { developer_instructions: 'Ordinary instructions' }, layers: [] }
      // c26: a private turn's fresh thread (fork 'norollout': the engine refused the fork, so the writer runs on a fresh ephemeral thread) is told by its instructions
      if (method === 'thread/start' && /private one-off task/.test(JSON.stringify(params))) { startedFresh.push(params); return { thread: { id: `fork-${++forks}` }, cwd: '/work', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' } }
      if (method === 'thread/start') return { thread: { id: `native-${++threads}` }, cwd: '/work', model: 'm', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd: '/work', sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      if (method === 'thread/fork') { if (fork === 'hang') return new Promise(() => {}); if (fork === 'norollout') throw Object.assign(new Error(`no rollout found for thread id ${params.threadId}`), { code: -32600 }); return { thread: { id: `fork-${++forks}`, forkedFromId: params.threadId } } }
      if (method === 'turn/start' && String(params.threadId).startsWith('fork-')) {
        const prompt = params.input[0].text
        forkPrompts.push(prompt)
        setTimeout(async () => {
          const text = (writer ? await writer(prompt) : null) ?? (/unusually long/.test(prompt) ? SLOW : MID)
          const n = (m, p) => chat.handleNotification({ method: m, params: p })
          await n('item/completed', { threadId: params.threadId, turnId: 'ft', item: { id: 'f1', type: 'agentMessage', phase: 'final_answer', text } })
          await n('turn/completed', { threadId: params.threadId, turn: { id: 'ft', status: 'completed', items: [] } })
        }, 1)
        return { turn: { id: 'ft', status: 'inProgress', items: [] } }
      }
      if (method === 'turn/start') { if (failTurn) throw Object.assign(new Error('refused'), { code: -32000 }); return { turn: { id: `turn-${++turns}`, status: 'inProgress', items: [] } } }
      if (method === 'turn/interrupt') return {}
      if (method === 'turn/steer') return { turnId: params.expectedTurnId } // c21: in-run messages handed to the working turn
      assert.fail(`Unexpected native call: ${method}`)
    },
    decisionContext: { mode: () => 'on', configured: () => true, client, budgetMs: 800, calibrationLog: log, collect: async () => [],
      draftCheck: flags.held ? { mode: () => 'on', ...(flags.design ? { design: () => flags.design } : {}) } : undefined,
      ...(flags.commands ? { commandJudge: { mode: () => 'advisory' } } : {}),
      // flags.inRun: lane L2's developer flag for messages while a run works (decisionContext.inRunMessages; bridge EGDESK_INRUN_MESSAGES=on)
      ...(flags.inRun ? { inRunMessages: { mode: () => 'on' } } : {}),
      conversationFlow: flags.flow ? { mode: () => 'on', ...(presence ? { presence } : {}), ...(audience ? { audience } : {}), ...(attentionPosted ? { attentionPosted } : {}) } : undefined },
  })
  chat.setConnection(true)
  const n = (m, p) => chat.handleNotification({ method: m, params: p })
  // Settle without waiting on jobs that wait for virtual time (a hung fork waits for its virtual deadline).
  const settle = async () => {
    let quiet = 0, last = -1
    for (let i = 0; i < 80 && quiet < 5; i++) {
      await new Promise(r => setTimeout(r, 2))
      const mark = native.length + events.length + requests.flow + requests.draft + requests.other
      quiet = mark === last ? quiet + 1 : 0; last = mark
    }
  }
  const w = { chat, store, log, events, native, requests, flowAsked, beatRequests, forkPrompts, startedFresh, timers, at: () => clock - 9_000_000, settle, notify: n,
    async advance(ms) {
      const end = clock + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift(); clock = next.at; next.fn(); await settle()
      }
      clock = end; await settle()
    },
    async dm(name, message = '상태를 알려 주세요', extra = {}) {
      const r = await chat.send({ clientThreadId: name, profileId: A, replyDestination: 'direct', message, requestId: `req-${name}`, ...extra })
      const timing = { threadId: r.conversationId, turnId: r.runId }
      const beats = []
      const hb = chat.heartbeatFor(name)
      hb?.subscribe(beat => beats.push({ at: w.at(), beat: beat.beat, phase: beat.facts.phase, sinceUserMs: beat.facts.sinceUserMs, sinceEngineMs: beat.facts.sinceEngineMs, sources: beat.facts.sources }))
      return { name, r, hb, beats, timing,
        raw: (method, params = {}) => n(method, { ...timing, ...params }), // any engine notification for this run, known to the runtime or not
        tool: (id, status) => n(status === 'started' ? 'item/started' : 'item/completed', { ...timing, item: { id, type: 'commandExecution', command: 'ls', cwd: '/work', status: status === 'started' ? 'inProgress' : 'completed', commandActions: [], aggregatedOutput: '', ...(status === 'started' ? {} : { exitCode: 0 }) } }),
        note: async (id, text) => { await n('item/started', { ...timing, item: { id, type: 'agentMessage', phase: 'commentary', text: '' } }); await n('item/completed', { ...timing, item: { id, type: 'agentMessage', phase: 'commentary', text } }) },
        async final(text, status = 'completed') {
          if (text != null) await n('item/completed', { ...timing, item: { id: `ans-${name}`, type: 'agentMessage', phase: 'final_answer', text } })
          await n('turn/completed', { threadId: timing.threadId, turn: { id: timing.turnId, status, items: [] } })
          await settle(); await chat.draftCheckIdle(); await settle()
        },
        history: () => store.listMessages(name).messages.map(m => [m.role, m.text]),
        assistant: () => store.listMessages(name).messages.filter(m => m.role === 'assistant').map(m => m.text),
      }
    },
    flowEntries: () => log.entries().filter(e => e.feature === 'conversation_flow'),
  }
  return w
}

