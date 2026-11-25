import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp } from 'node:fs/promises'
import { CodexChatRuntime, TURN_MEMORY_CAPS } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'
import { NUNCHI_KEY, NUNCHI_CAPS, NUNCHI_RECENT, beginNunchi, conversationGuidance, createNunchiConfig, dropConversationGuidance, nunchiEligible } from './egdesk-nunchi-runtime.mjs'
import { USER_GUIDANCE_PATH, createUserGuidanceHttpHandler } from './egdesk-user-guidance.mjs'
import { RECORD_HINTS } from './egdesk-nunchi.mjs'
import { claudeTurnContent } from './claude-engine-adapter.mjs'
import { createCodexEngineAdapter } from './codex-engine-adapter.mjs'
import { createUserGuidanceStore } from './egdesk-user-guidance.mjs'
import { choiceAnswer, createFakeClock, deferred, until } from './egdesk-wiki-reconstruction.fixture.mjs'
import { nunchiAnswer } from './egdesk-nunchi.fixture.mjs'

// The nunchi through the real runtime (flag EGDESK_NUNCHI, default off): the person's reaction to the assistant's last message is read by the decision model at the start of a turn and
// the guidance reaches the engine in the same turn (inside the cap) or the next one (late). Real: the runtime, the chat store, the guidance record. Synthetic: the native engine (it
// "answers" in the language and length the guidance says, so a test can see the reply follow it) and the Decisions client (a scripted reading per message).
const OWNER = 'codex:synthetic:qa', AGENT = 'sol'
const profiles = { runProfile: (p, r) => ({ binding: { profileId: p, revision: r ?? 1, hash: 'h' }, developerInstructions: 'x', toolCeiling: null, model: null }) }
const KOREAN = { nk_kind: 'correction', nk_about: 'language', nk_strength: 'clear', nk_direction: 'not_applicable', nk_language: 'korean' }
const SHORT = { nk_kind: 'complaint', nk_about: 'length', nk_strength: 'strong', nk_direction: 'less', nk_language: 'none' }
const NONE = { nk_kind: 'none', nk_about: 'no_particular', nk_strength: 'mild', nk_direction: 'not_applicable', nk_language: 'none' }
const MILD = { ...KOREAN, nk_strength: 'mild' }
const guideOf = p => Object.values(p?.additionalContext ?? {}).map(e => e.value).filter(v => typeof v === 'string' && v.startsWith('[guidance from the person')).join('\n')

async function world({ nunchi = true, readings = {}, hold = null, store = true, engineId = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-nunchi-')); await chmod(dir, 0o700)
  const w = { dir, now: 1_800_000_000_000, requests: [], starts: [], turns: 0, threads: 0, clock: createFakeClock(), readings, asked: 0 }
  w.store = openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'synthetic-nunchi' })
  w.guidance = createUserGuidanceStore({ dataDir: path.join(dir, 'settings'), now: () => w.now })
  const config = nunchi ? { ...createNunchiConfig({ dataDir: path.join(dir, 'settings'), flag: () => 'on', open: () => w.guidance }), clock: w.clock } : null
  if (config && !store) Object.defineProperty(config, 'store', { value: null })
  const chat = new CodexChatRuntime({ now: () => (w.now += 1000), store: w.store, requireStore: true, getOwnerKey: () => OWNER, profiles, resolveProjectWorkspace: async () => null,
    request: async (method, p) => {
      if (method === 'thread/start') return { thread: { id: `t${++w.threads}` }, cwd: '/work', model: 'syn' }
      if (method === 'thread/resume') return { thread: { id: p.threadId, turns: [] }, cwd: '/work' }
      if (method === 'config/read') return { config: { developer_instructions: null } }
      if (method === 'thread/unsubscribe') return { status: 'unsubscribed' }
      w.starts.push(p)
      const id = `turn-${++w.turns}`, timing = { threadId: p.threadId, turnId: id }
      const guide = guideOf(p), text = /Korean/.test(guide) && /short/.test(guide) ? '네, 짧게.' : /Korean/.test(guide) ? '네, 일정은 화요일입니다.' : /short/.test(guide) ? 'Tuesday.' : 'The review meeting is on Tuesday, and here is the full schedule with all the details.'
      const finish = async () => { const n = (m, q) => chat.handleNotification({ method: m, params: q })
        await n('item/started', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text: '' } })
        await n('item/completed', { ...timing, item: { id: `a${id}`, type: 'agentMessage', phase: 'final_answer', text } })
        await n('turn/completed', { threadId: p.threadId, turn: { id, status: 'completed', items: [] } }) }
      setImmediate(() => setImmediate(finish))
      return { turn: { id, status: 'inProgress', items: [] } } },
    respond: () => {}, emit: () => {}, emitLegacy: () => {}, verifyFile: async () => null,
    decisionContext: { mode: () => 'on', settingsGeneration: () => 0, configured: () => true, budgetMs: 5000, ...(config ? { nunchi: config } : {}),
      client: { model: 'syn', async decide(req) {
        const names = req.questions.map(q => q.name)
        if (names.includes('nk_kind')) {
          const message = /The person's turn \(quoted data\):\n"""\n([\s\S]*?)\n"""/.exec(req.input.map(m => m.content).join('\n'))?.[1] ?? ''
          w.requests.push({ turn: w.asked, kind: 'nunchi', message, text: JSON.stringify(req.input) })
          if (hold && message === hold.message) await hold.gate.promise
          const want = w.readings[message] ?? NONE, top = want.top ?? 0.95
          const dist = (q, d) => { const rows = q.choices.map(c => ({ value: c.value, probability: d[c.value] ?? 0 })).sort((a, b) => b.probability - a.probability), n = q.choices.length
            return { type: 'choice', choice: rows[0].value, confidence: Math.max(0, (rows[0].probability - 1 / n) / (1 - 1 / n)), probabilities: rows } }
          return { answers: Object.fromEntries(req.questions.map(q => [q.name, nunchiAnswer(q, want, top)])), model: 'syn', usage: { inputTokens: 1 }, latencyMs: 1 }
        }
        w.requests.push({ turn: w.asked, kind: 'other', names })
        const answers = {}
        for (const q of req.questions) answers[q.name] = q.type !== 'choice' ? { type: 'predicate', probability: 0.02 } : { type: 'choice', choice: q.choices[0].value, confidence: 0.9, probabilities: q.choices.map((c, i) => ({ value: c.value, probability: i === 0 ? 0.9 : 0.1 / (q.choices.length - 1) })) }
        return { answers, model: 'syn', usage: { inputTokens: 1 }, latencyMs: 1 }
      } },
      collect: async ({ body, context, memoryEvidenceFor, speech }) => (await collectDecisionCandidates({ body, clientThreadId: context.clientThreadId, excludeMessageId: context.localMessageId, chatStore: w.store, memoryEvidenceFor, speech })).candidates } })
  chat.setConnection(true); w.chat = chat
  w.ask = async (message, thread = 'dm-1') => {
    w.asked++
    const sent = (w.cid ??= {})[thread]
    const r = await chat.send({ message, clientThreadId: thread, requestId: `r${w.asked}`, ...(sent ? { conversationId: sent } : {}), profileId: AGENT, replyDestination: 'direct' }); w.cid[thread] ||= r.conversationId
    await until(() => w.store.listMessages(thread).messages.filter(m => m.role === 'assistant' && m.status === 'complete').length >= (w.done?.[thread] ?? 0) + 1, `answer ${w.asked}`)
    ;(w.done ??= {})[thread] = (w.done[thread] ?? 0) + 1
    await w.clock.settle()
    return [...chat.runs.values()].at(-1)
  }
  w.reply = (thread = 'dm-1') => w.store.listMessages(thread).messages.filter(m => m.role === 'assistant').at(-1)?.text
  w.close = () => { w.store.close() }
  return w
}

test('flag off (default): no nunchi request, no guidance entry, nothing in the guidance record', async () => {
  const w = await world({ nunchi: false, readings: { '야 한글로 보고해': KOREAN } })
  await w.ask('오늘 일정 알려줘'); await w.ask('야 한글로 보고해')
  assert.equal(w.requests.filter(r => r.kind === 'nunchi').length, 0); assert.ok(w.starts.every(p => guideOf(p) === '')); assert.equal(w.guidance.size(), 0)
  assert.equal(w.chat.nunchiReceiptFor({}), null); w.close()
})

test('"야 한글로 보고해": read at the start of the turn, in the same turn the engine is told to reply in Korean, the line stays for the rest of the conversation, a candidate is recorded and not applied', async () => {
  const w = await world({ readings: { '야 한글로 보고해': KOREAN } })
  await w.ask('오늘 일정 알려줘')
  assert.equal(guideOf(w.starts[0]), '', 'nothing to react to yet'); assert.match(w.reply(), /full schedule/)
  const run = await w.ask('야 한글로 보고해')
  const asked = w.requests.filter(r => r.kind === 'nunchi')
  assert.deepEqual(asked.map(r => r.message), ['오늘 일정 알려줘', '야 한글로 보고해'], 'one request per user message'); assert.ok(asked[1].text.includes('The review meeting is on Tuesday'), 'with the assistant message before it'); assert.ok(asked[0].text.includes('There is no assistant message before the turn'))
  assert.equal(guideOf(w.starts[1]), `[guidance from the person: follow it in your reply; do not mention it unless asked]\n- Reply in Korean for the rest of this conversation, as the person asked.\n- ${RECORD_HINTS.candidate}`, 'the line, and what EG-Desk did with it (kept as a candidate)')
  assert.equal(w.reply(), '네, 일정은 화요일입니다.', 'the (stand-in) engine\'s reply follows it, in the same turn')
  const receipt = w.chat.nunchiReceiptFor(run)
  assert.deepEqual([receipt.status, receipt.inTime, receipt.late, receipt.withPrevious, receipt.reading.kind, receipt.directive, receipt.candidate.status], ['ready', true, false, true, 'correction', { guidance: 'language', value: 'korean' }, 'candidate'])
  await w.ask('다음 일정은?')
  assert.match(guideOf(w.starts[2]), /Reply in Korean/, 'it stays for the rest of the conversation'); assert.equal(w.reply(), '네, 일정은 화요일입니다.')
  // the durable candidate: closed words, the source by reference, never applied by itself
  const [entry] = w.guidance.list(); assert.deepEqual([entry.guidance, entry.value, entry.status, entry.seen], ['language', 'korean', 'candidate', 1]); assert.match(entry.sources[0].ref, /^chat-message:msg-/); assert.equal(entry.sources[0].thread, 'dm-1')
  assert.ok(!JSON.stringify(entry).includes('한글'), 'the person\'s words are not in the record')
  assert.equal(w.guidance.appliedLines().length, 0); w.close()
})

test('another conversation does not get this conversation\'s line; the person applies the candidate and every conversation gets it; reverting takes it away; the conversation line can be dropped', async () => {
  const w = await world({ readings: { '야 한글로 보고해': KOREAN } })
  await w.ask('오늘 일정 알려줘'); await w.ask('야 한글로 보고해')
  await w.ask('Show me the schedule', 'dm-2'); assert.equal(guideOf(w.starts.at(-1)), '', 'the line belongs to its conversation'); assert.match(w.reply('dm-2'), /full schedule/)
  const [{ id }] = w.guidance.list(); assert.equal(w.guidance.setStatus(id, 'applied').entry.status, 'applied')
  await w.ask('And tomorrow?', 'dm-2'); assert.equal(guideOf(w.starts.at(-1)), '[guidance from the person: follow it in your reply; do not mention it unless asked]\n- Reply in Korean in every conversation, as the person asked.'); assert.equal(w.reply('dm-2'), '네, 일정은 화요일입니다.')
  await w.ask('다시 한국어로 알려줘', 'dm-1'); assert.ok(guideOf(w.starts.at(-1)).includes(RECORD_HINTS.applied), 'applied: the hint says so, in the conversation it came from')
  w.guidance.setStatus(id, 'reverted'); await w.ask('And the day after?', 'dm-2'); assert.equal(guideOf(w.starts.at(-1)), '', 'reverted: gone'); assert.match(w.reply('dm-2'), /full schedule/)
  assert.deepEqual(conversationGuidance(w.chat, 'dm-1').map(g => g.guidance), ['language']); assert.equal(dropConversationGuidance(w.chat, 'dm-1', 'language'), true); assert.equal(dropConversationGuidance(w.chat, 'dm-1', 'language'), false)
  await w.ask('다음은?'); assert.equal(guideOf(w.starts.at(-1)), '', 'dropped'); w.close()
})

test('a second reaction adds its own line (short replies), the same kind of guidance replaces its earlier line, at most four lines', async () => {
  const w = await world({ readings: { '야 한글로 보고해': KOREAN, '너무 길어 짧게': SHORT, '영어로 다시': { ...KOREAN, nk_language: 'english' } } })
  await w.ask('일정?'); await w.ask('야 한글로 보고해'); await w.ask('너무 길어 짧게')
  assert.equal(guideOf(w.starts[2]).split('\n').length, 4, 'header, two lines and the state of the record'); assert.equal(w.reply(), '네, 짧게.')
  await w.ask('영어로 다시'); const g = guideOf(w.starts[3]); assert.match(g, /Reply in English/); assert.ok(!/Reply in Korean/.test(g), 'one language line: the newer one'); assert.match(g, /Keep replies short/)
  assert.deepEqual(w.guidance.list().map(e => `${e.guidance}:${e.value}`).sort(), ['language:english', 'language:korean', 'length:less']); w.close()
})

test('not a reaction, a mild reaction, an uncertain reading: no line, no candidate; the request still goes out (one per turn) and never fails the turn', async () => {
  const w = await world({ readings: { 'x': MILD, 'y': { ...KOREAN, top: 0.6 }, 'z': NONE } })
  await w.ask('일정?'); for (const m of ['x', 'y', 'z']) await w.ask(m)
  assert.ok(w.starts.every(p => guideOf(p) === '')); assert.equal(w.guidance.size(), 0); assert.equal(w.requests.filter(r => r.kind === 'nunchi').length, 4)
  w.close()
})

test('budget: a reading that is not back within the turn-memory cap does not hold the turn; it applies from the next turn ("다음 답부터")', async () => {
  const gate = deferred(), w = await world({ readings: { '야 한글로 보고해': KOREAN }, hold: { message: '야 한글로 보고해', gate } })
  await w.ask('일정?')
  const asked = w.ask('야 한글로 보고해')
  await until(() => w.requests.some(r => r.message === '야 한글로 보고해'), 'the reading started'); await w.clock.settle(); await w.clock.advance(2600)
  const run = await asked
  assert.equal(guideOf(w.starts[1]), '', 'this turn went on without it'); assert.match(w.reply(), /full schedule/)
  gate.resolve(); await until(() => w.chat.nunchiReceiptFor(run)?.reading, 'the late reading'); await w.clock.settle()
  const receipt = w.chat.nunchiReceiptFor(run); assert.deepEqual([receipt.inTime, receipt.late, receipt.directive?.guidance], [false, true, 'language'])
  await w.ask('다음 일정은?'); assert.match(guideOf(w.starts[2]), /Reply in Korean/, 'the next answer follows it'); assert.equal(w.guidance.size(), 1)
  assert.deepEqual(NUNCHI_CAPS, { firstMs: TURN_MEMORY_CAPS.firstMs, midMs: TURN_MEMORY_CAPS.midMs }, 'the caps are the turn-memory caps'); w.close()
})

test('an unreachable decision model never fails the turn; a missing guidance record still gives the conversation line', async () => {
  const w = await world({ readings: { '야 한글로 보고해': KOREAN } })
  const decide = w.chat.decisionContext.client.decide.bind(w.chat.decisionContext.client)
  w.chat.decisionContext.client.decide = async req => { if (req.questions.some(q => q.name === 'nk_kind')) throw Object.assign(new Error('down'), { code: 'down' }); return decide(req) }
  await w.ask('일정?'); const run = await w.ask('야 한글로 보고해'); assert.equal(guideOf(w.starts[1]), ''); assert.equal(w.chat.nunchiReceiptFor(run).status, 'fallback'); assert.match(w.reply(), /full schedule/); w.close()
  const lone = await world({ readings: { '야 한글로 보고해': KOREAN }, store: false })
  await lone.ask('일정?'); await lone.ask('야 한글로 보고해'); assert.match(guideOf(lone.starts[1]), /Reply in Korean/); assert.equal(lone.guidance.size(), 0); lone.close()
})

test('the flag in the bridge config is exactly "on"; the record opens only when it is used', () => {
  let opened = 0
  const make = flag => createNunchiConfig({ dataDir: '/nonexistent/x', flag: () => flag, open: () => { opened++; return { appliedLines: () => [] } } })
  assert.deepEqual(['on', 'ON', 'yes', '', undefined, 'advisory'].map(f => make(f).enabled()), [true, false, false, false, false, false]); assert.equal(opened, 0)
  const cfg = make('on'); void cfg.store; void cfg.store; assert.equal(opened, 1, 'opened once, lazily'); assert.equal(NUNCHI_KEY, 'egdesk_nunchi')
})

// the real answers of the control "야 한글로 보고해" (nunchi-eval-v1, 11-26): the single kind split between neighbours (correction .78 / instruction_change .14), the first reading's bar missed it
const SPLIT_KOREAN = { dist: { nk_kind: { correction: 0.78, instruction_change: 0.14, praise: 0.01, complaint: 0.01, none: 0.06 }, nk_about: { language: 0.98, length: 0.02 }, nk_strength: { clear: 0.96, mild: 0.03, strong: 0.01 }, nk_direction: { not_applicable: 0.77, keep: 0.1, less: 0.13 }, nk_language: { korean: 0.98, none: 0.02 } } }
const SPLIT_SHORT = { dist: { nk_kind: { complaint: 0.44, correction: 0.24, instruction_change: 0.2, urging: 0.11, praise: 0.01 }, nk_about: { length: 1 }, nk_strength: { clear: 0.99, mild: 0.01 }, nk_direction: { less: 1 }, nk_language: { none: 1 } } }

test('u2: the reading that split between neighbouring kinds still guides the turn and leaves a candidate (the window of 02:51: "앞으로는 짧게 말해" left none)', async () => {
  const w = await world({ readings: { '야 한글로 보고해': SPLIT_KOREAN, '너무 길어. 앞으로는 짧게 말해': SPLIT_SHORT } })
  await w.ask('일정?'); const run = await w.ask('야 한글로 보고해')
  assert.match(guideOf(w.starts[1]), /Reply in Korean/); const receipt = w.chat.nunchiReceiptFor(run)
  assert.deepEqual([receipt.reading.kind, receipt.reading.change, receipt.reading.changeMass, receipt.reading.forceful, receipt.directive.guidance, receipt.candidate.status], [null, true, 0.93, true, 'language', 'candidate'])
  await w.ask('너무 길어. 앞으로는 짧게 말해'); assert.match(guideOf(w.starts[2]), /Keep replies short/)
  assert.deepEqual(w.guidance.list().map(e => `${e.guidance}:${e.value}`).sort(), ['language:korean', 'length:less']); assert.equal(w.guidance.list().every(e => e.status === 'candidate'), true)
  w.close()
})

test('u2: the guidance record hint follows the state: candidate, then applied, nothing once reverted; it never claims more than is so', async () => {
  const w = await world({ readings: { '야 한글로 보고해': SPLIT_KOREAN } })
  await w.ask('일정?'); await w.ask('야 한글로 보고해'); assert.ok(guideOf(w.starts[1]).includes(RECORD_HINTS.candidate))
  const [{ id }] = w.guidance.list(); w.guidance.setStatus(id, 'applied'); await w.ask('그리고?'); assert.ok(guideOf(w.starts.at(-1)).includes(RECORD_HINTS.applied)); assert.ok(!guideOf(w.starts.at(-1)).includes('as a candidate'))
  w.guidance.setStatus(id, 'reverted'); await w.ask('그리고?'); assert.ok(!/guidance record/.test(guideOf(w.starts.at(-1))), 'reverted: no hint'); assert.match(guideOf(w.starts.at(-1)), /Reply in Korean for the rest of this conversation/, 'the conversation line stays')
  w.close()
  const lone = await world({ readings: { '야 한글로 보고해': SPLIT_KOREAN }, store: false }); await lone.ask('일정?'); await lone.ask('야 한글로 보고해')
  assert.ok(!/guidance record/.test(guideOf(lone.starts[1])), 'no record, no claim that there is one'); lone.close()
})

// The Claude path (u2: the u1 procedure said "talk with Codex"): the entry is an additionalContext entry like every other EG-Desk context, and the Claude adapter puts each one in the turn as a text block
function claudeWorld({ readings }) {
  const calls = []; let threads = 0, turns = 0
  const codex = createCodexEngineAdapter({ request: async () => { throw new Error('Claude must never use Codex') }, respond: () => {} })
  const claude = { id: 'claude', describe: () => ({ id: 'claude', profiles: [{ id: 'claude-slot', active: true }] }), refresh: async () => ({}), capabilities: () => new Set(['stream', 'resume', 'dynamicTools']), ownerKey: () => OWNER, isReady: () => true,
    async startThread(params) { calls.push({ method: 'thread/start', params }); return { thread: { id: `claude-${++threads}` }, cwd: params.cwd || '/legacy/claude' } },
    async resumeThread(params) { return { thread: { id: params.threadId, turns: [] }, cwd: params.cwd } }, async releaseThread() { return { status: 'unsubscribed' } },
    async startTurn(params) { calls.push({ method: 'turn/start', params }); return { turn: { id: `claude-turn-${++turns}`, status: 'completed', items: [] } } },
    interruptTurn: async () => {}, respond: () => {}, subscribe: () => () => {}, dispose: async () => {} }
  const seen = []
  const chat = new CodexChatRuntime({ engines: [codex, claude], profiles, getOwnerKey: () => OWNER, resolveProjectWorkspace: async () => null, emit: () => {},
    decisionContext: { mode: () => 'on', settingsGeneration: () => 0, configured: () => true, budgetMs: 5000, nunchi: { enabled: () => true, store: null },
      client: { model: 'syn', async decide(req) { seen.push(req); const names = req.questions.map(q => q.name)
        if (!names.includes('nk_kind')) return { answers: Object.fromEntries(req.questions.map(q => [q.name, q.type !== 'choice' ? { type: 'predicate', probability: 0.02 } : { type: 'choice', choice: q.choices[0].value, confidence: 0.9, probabilities: q.choices.map((c, i) => ({ value: c.value, probability: i === 0 ? 0.9 : 0.1 / (q.choices.length - 1) })) }])), model: 'syn', usage: { inputTokens: 1 }, latencyMs: 1 }
        return { answers: Object.fromEntries(req.questions.map(q => [q.name, nunchiAnswer(q, readings, 0.95)])), model: 'syn', usage: { inputTokens: 1 }, latencyMs: 1 } } },
      collect: async () => [] } })
  chat.setConnection('claude', true)
  return { chat, calls, seen }
}

test('u2: on the Claude path the guidance entry reaches the engine\'s turn input: egdesk_nunchi is in the turn\'s additionalContext and the Claude adapter turns it into a text block before the person\'s message', async () => {
  const w = claudeWorld({ readings: KOREAN })
  await w.chat.send({ message: '야 한글로 보고해', engineId: 'claude', clientThreadId: 'room-1', requestId: 'r1', profileId: AGENT, replyDestination: 'direct' })
  const start = w.calls.find(c => c.method === 'turn/start')
  assert.ok(start, 'the turn started on Claude'); const entry = start.params.additionalContext?.[NUNCHI_KEY]
  assert.match(entry?.value ?? '', /Reply in Korean for the rest of this conversation/)
  const content = claudeTurnContent({ input: start.params.input, additionalContext: start.params.additionalContext })
  const block = content.find(b => b.type === 'text' && b.text.startsWith('[EG-Desk context: egdesk_nunchi]'))
  assert.ok(block && /Reply in Korean/.test(block.text), JSON.stringify(content).slice(0, 300)); assert.equal(content.at(-1).text, '야 한글로 보고해', 'the person\'s message stays last')
  // the request the decision model got on this path had no assistant message before the turn (the gate is Codex-only), and still read the reaction
  const asked = w.seen.find(r => r.questions.some(q => q.name === 'nk_kind')); assert.ok(JSON.stringify(asked.input).includes('There is no assistant message before the turn'))
})

// ---- u3: the real window (Claude, EGDESK_UPPER=on EGDESK_NUNCHI=on, Decision mode 사용, a plain project room, 11-26 03:30) ----
// "너무 길어. 앞으로는 짧게 말해" left GET /v1/user-guidance empty. The cause was the eligibility rule copied from the memory loop (channelKind === 'direct': an Agent DM only): in a plain room chat the
// channel is null, so the judgment never started (no Decision request at all). The reading is the person's own reaction in ANY conversation with an engine, not a Board, not stateless.
// The answers below are the real ones for this very sentence from the fresh validation plan (nunchi-merge-v1-001, m-length-standing): change 1.00, about length, direction less, clear .99.
const REAL_LENGTH = { dist: { nk_kind: { complaint: 0.5, instruction_change: 0.3, correction: 0.2 }, nk_about: { length: 1 }, nk_strength: { clear: 0.99, mild: 0.01 }, nk_direction: { less: 1 }, nk_language: { none: 1 } } }
async function roomWorld({ readings, mode = 'on', enabled = true }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'egdesk-nunchi-room-')); await chmod(dir, 0o700)
  const store = openChatStore({ dataDir: path.join(dir, 'chat'), ownerScope: 'room-nunchi' }), guidance = createUserGuidanceStore({ dataDir: path.join(dir, 'settings') })
  const calls = []; let threads = 0, turns = 0, asked = 0
  const codex = createCodexEngineAdapter({ request: async () => { throw new Error('Claude must never use Codex') }, respond: () => {} })
  const claude = { id: 'claude', describe: () => ({ id: 'claude', profiles: [{ id: 'claude-slot', active: true }] }), refresh: async () => ({}), capabilities: () => new Set(['stream', 'resume', 'dynamicTools']), ownerKey: () => OWNER, isReady: () => true,
    async startThread(params) { return { thread: { id: `claude-${++threads}` }, cwd: params.cwd || '/legacy/claude' } }, async resumeThread(params) { return { thread: { id: params.threadId, turns: [] }, cwd: params.cwd } }, async releaseThread() { return { status: 'unsubscribed' } },
    async startTurn(params) { calls.push(params); return { turn: { id: `claude-turn-${++turns}`, status: 'completed', items: [] } } }, interruptTurn: async () => {}, respond: () => {}, subscribe: () => () => {}, dispose: async () => {} }
  const dist = (q, d) => { const rows = q.choices.map(c => ({ value: c.value, probability: d[c.value] ?? 0 })).sort((a, b) => b.probability - a.probability), n = q.choices.length
    return { type: 'choice', choice: rows[0].value, confidence: Math.max(0, (rows[0].probability - 1 / n) / (1 - 1 / n)), probabilities: rows } }
  const decide = async req => { const names = req.questions.map(q => q.name)
    if (!names.includes('nk_kind')) return { answers: Object.fromEntries(req.questions.map(q => [q.name, q.type !== 'choice' ? { type: 'predicate', probability: 0.02 } : { type: 'choice', choice: q.choices[0].value, confidence: 0.9, probabilities: q.choices.map((c, i) => ({ value: c.value, probability: i === 0 ? 0.9 : 0.1 / (q.choices.length - 1) })) }])), model: 'syn', usage: {}, latencyMs: 1 }
    asked++
    const want = readings[/The person's turn \(quoted data\):\n"""\n([\s\S]*?)\n"""/.exec(req.input.map(m => m.content).join('\n'))?.[1] ?? ''] ?? NONE
    return { answers: Object.fromEntries(req.questions.map(q => [q.name, nunchiAnswer(q, want, 0.95)])), model: 'syn', usage: {}, latencyMs: 1 } }
  const chat = new CodexChatRuntime({ engines: [codex, claude], store, requireStore: true, profiles, getOwnerKey: () => OWNER, resolveProjectWorkspace: async () => null, emit: () => {},
    decisionContext: { mode: () => mode, settingsGeneration: () => 0, configured: () => true, budgetMs: 5000, ...(enabled ? { nunchi: { enabled: () => true, store: guidance } } : {}), client: { model: 'syn', decide }, collect: async () => [] } })
  chat.setConnection('claude', true)
  return { chat, calls, guidance, store, asked: () => asked, close: () => store.close(),
    // a plain room chat: no Agent profile, no replyDestination (what the Desk sends for a project room with Claude)
    sendPlain: (message, extra = {}) => chat.send({ message, engineId: 'claude', clientThreadId: 'room-1', requestId: `r${calls.length + 1}`, ...extra }) }
}

test('u3: in a plain Claude room chat (channel null, no Agent) "너무 길어. 앞으로는 짧게 말해" is judged, the line reaches Claude\'s turn, and ONE candidate is left in the guidance record', async () => {
  const w = await roomWorld({ readings: { '너무 길어. 앞으로는 짧게 말해': REAL_LENGTH } })
  await w.sendPlain('너무 길어. 앞으로는 짧게 말해')
  assert.equal(w.asked(), 1, 'the decision model was asked (before: not at all)'); assert.equal([...w.chat.runs.values()].at(-1).channelKind ?? null, null, 'a plain room: the channel is not an Agent DM')
  const entry = w.calls[0].additionalContext?.[NUNCHI_KEY]?.value ?? ''; assert.match(entry, /Keep replies short for the rest of this conversation/); assert.ok(entry.includes(RECORD_HINTS.candidate))
  const block = claudeTurnContent({ input: w.calls[0].input, additionalContext: w.calls[0].additionalContext }).find(b => b.type === 'text' && b.text.startsWith('[EG-Desk context: egdesk_nunchi]')); assert.ok(block)
  const [c] = w.guidance.list(); assert.deepEqual([w.guidance.size(), c.guidance, c.value, c.status, c.seen], [1, 'length', 'less', 'candidate', 1]); assert.match(c.sources[0].ref, /^chat-message:msg-/)
  const [r] = w.chat.nunchiRecent(5); assert.deepEqual([r.started, r.engine, r.position, r.status, r.inTime, r.reading.change, r.reading.about, r.directive, r.candidate.status, r.lineSent], [true, 'claude', 'first', 'ready', true, true, 'length', { guidance: 'length', value: 'less' }, 'candidate', true])
  w.close()
})

test('u3: the receipts are closed words, numbers and ids: no sentence of the person, no conversation id; the turns the nunchi did not start are there with the reason', async () => {
  const w = await roomWorld({ readings: { '너무 길어. 앞으로는 짧게 말해': REAL_LENGTH } })
  await w.sendPlain('너무 길어. 앞으로는 짧게 말해')
  await w.chat.send({ message: '비밀 문장 그리고 board 에서', engineId: 'claude', clientThreadId: 'room-2', requestId: 'b1', boardId: 'board-1' }).catch(() => {})
  const raw = JSON.stringify(w.chat.nunchiRecent(20)); assert.ok(!/너무 길어|비밀 문장|room-1|room-2/.test(raw), raw.slice(0, 300))
  const list = w.chat.nunchiRecent(20); assert.ok(list.length >= 1 && list.every(r => /^[0-9a-f]{8}$/.test(r.conversation) && typeof r.at === 'number'))
  assert.deepEqual(w.chat.nunchiRecent(1).length, 1); assert.ok(w.chat.nunchiRecent(1000).length <= NUNCHI_RECENT.max); assert.deepEqual(Object.keys(list[0]).sort(), ['at', 'candidate', 'conversation', 'directive', 'engine', 'inTime', 'late', 'lineSent', 'ms', 'position', 'reading', 'reason', 'started', 'status', 'withPrevious'])
  w.close()
  const off = await roomWorld({ readings: {}, enabled: false }); await off.sendPlain('x'); assert.deepEqual(off.chat.nunchiRecent(5), [], 'flag off: nothing is remembered'); off.close()
})

test('u3: who the nunchi reads: any conversation of the person\'s (Agent DM or plain room), not a Board, not a stateless request; a skipped turn says why', () => {
  assert.equal(nunchiEligible({}, { channelKind: null }), true); assert.equal(nunchiEligible({}, { channelKind: 'direct' }), true); assert.equal(nunchiEligible({}, { channelKind: 'unverified' }), true)
  assert.equal(nunchiEligible({}, { channelKind: 'board' }), false); assert.equal(nunchiEligible({ boardId: 'b' }, { channelKind: null }), false); assert.equal(nunchiEligible({}, { board: { record: 1 } }), false); assert.equal(nunchiEligible({}, { stateless: true }), false)
  const rt = (extra = {}) => ({ decisionContext: { mode: () => 'on', configured: () => true, client: { decide: async () => ({ answers: {} }) }, nunchi: { enabled: () => true, store: null } }, previousReplyFor: () => null, turnPosition: () => ({ kind: 'mid' }), ...extra })
  const ctx = { clientThreadId: 't1', channelKind: null, engine: { id: 'claude' }, localMessageId: 'msg-1' }, reasons = r => (r.nunchiRing ?? []).map(e => e.reason ?? 'started')
  const a = rt(); assert.ok(beginNunchi(a, { message: 'x' }, ctx)); assert.deepEqual(reasons(a), ['started'])
  const b = rt(); assert.equal(beginNunchi(b, { message: 'x' }, ctx, { bounded: true }), null); assert.deepEqual(reasons(b), ['bounded'])
  const c = rt(); assert.equal(beginNunchi(c, { message: 'x' }, { ...ctx, channelKind: 'board' }), null); assert.deepEqual(reasons(c), ['not_eligible'])
  const d = rt(); assert.equal(beginNunchi(d, { message: '  ' }, ctx), null); assert.deepEqual(reasons(d), ['no_message'])
  const e = rt(); assert.equal(beginNunchi(e, { message: 'x' }, { ...ctx, clientThreadId: '' }), null); assert.deepEqual(reasons(e), ['no_thread'])
  const f = rt({ decisionContext: { mode: () => 'off', configured: () => true, client: {}, nunchi: { enabled: () => true } } }); assert.equal(beginNunchi(f, { message: 'x' }, ctx), null); assert.deepEqual(reasons(f), [], 'the Decision mode is 끔: nothing is judged and nothing is remembered')
  const g = rt({ decisionContext: { mode: () => 'on', configured: () => false, client: {}, nunchi: { enabled: () => true } } }); assert.equal(beginNunchi(g, { message: 'x' }, ctx), null)
  const h = rt({ decisionContext: { mode: () => 'on', configured: () => true, client: {}, nunchi: { enabled: () => false } } }); assert.equal(beginNunchi(h, { message: 'x' }, ctx), null); assert.deepEqual(reasons(h), [])
})

test('u3: GET /v1/user-guidance/receipts?recent=n: off (404) unless the flag, loopback only, GET only, n between 1 and 20 (default 5), the runtime\'s receipts and nothing else', async () => {
  const w = await roomWorld({ readings: { '너무 길어. 앞으로는 짧게 말해': REAL_LENGTH } }); await w.sendPlain('너무 길어. 앞으로는 짧게 말해')
  let on = false, loopback = true
  const handler = createUserGuidanceHttpHandler({ store: w.guidance, enabled: () => on, guard: () => loopback, send: (res, code, body) => { res.code = code; res.body = body }, receipts: n => w.chat.nunchiRecent(n) })
  const call = async (method, url) => { const res = { destroyed: false, writableEnded: false, setHeader() {} }; await handler({ method }, res, new URL(`http://x${url}`)); return { code: res.code, body: res.body } }
  assert.equal((await call('GET', `${USER_GUIDANCE_PATH}/receipts`)).code, 404); on = true; loopback = false; assert.equal((await call('GET', `${USER_GUIDANCE_PATH}/receipts`)).code, 403); loopback = true
  const ok = await call('GET', `${USER_GUIDANCE_PATH}/receipts?recent=5`); assert.deepEqual([ok.code, ok.body.status, ok.body.receipts.length, ok.body.receipts[0].candidate.status], [200, 'ok', 1, 'candidate'])
  assert.equal((await call('POST', `${USER_GUIDANCE_PATH}/receipts`)).code, 405); assert.equal((await call('GET', `${USER_GUIDANCE_PATH}/receipts?recent=abc`)).body.receipts.length, 1)
  const bare = createUserGuidanceHttpHandler({ store: w.guidance, enabled: () => true, guard: () => true, send: (res, code, body) => { res.code = code; res.body = body } }); const res = { destroyed: false, writableEnded: false, setHeader() {} }; await bare({ method: 'GET' }, res, new URL(`http://x${USER_GUIDANCE_PATH}/receipts`)); assert.equal(res.code, 404, 'no receipts source: off')
  w.close()
})

// ---- u4: the real 04:02 receipt (Claude, plain project room, no assistant message before the turn): change .92 / forceful .96 / strength clear / direction less / about null -> no directive, no candidate ----
// These are the REAL answers the Decision model gave to "너무 길어. 앞으로는 짧게 말해" (nunchi-merge-v2-001, no previous message): kind instruction_change .70 / complaint .20, about length .49 / no_particular .47,
// strength clear .95, direction less .98. manner .5: the question did not exist then, so it is "unsure" and the kinds alone carry the change (as in the real receipt).
const REAL_0402 = { manner: 0.5, dist: { nk_kind: { instruction_change: 0.70, complaint: 0.20, none: 0.06, praise: 0.01 }, nk_about: { length: 0.49, no_particular: 0.47, language: 0.02, format: 0.01 }, nk_strength: { clear: 0.95, mild: 0.04, strong: 0.01 }, nk_direction: { less: 0.98, more: 0.01 }, nk_language: { none: 0.48, korean: 0.47 } } }
const PLAIN_KOREAN = { manner: 0.95, dist: { nk_kind: { none: 0.81, instruction_change: 0.15, praise: 0.01 }, nk_about: { language: 0.51, no_particular: 0.42, length: 0.02, format: 0.01 }, nk_strength: { clear: 0.67, mild: 0.33 }, nk_direction: { not_applicable: 0.66, less: 0.25 }, nk_language: { korean: 1 } } }
test('u4 replay: the real 04:02 reading (change .92, direction less, about under the bar) in a plain Claude room: about reads length, ONE candidate length/less, the line reaches Claude, the receipt says it was inferred', async () => {
  const w = await roomWorld({ readings: { '너무 길어. 앞으로는 짧게 말해': REAL_0402 } })
  await w.sendPlain('너무 길어. 앞으로는 짧게 말해')
  const [r] = w.chat.nunchiRecent(5)
  assert.deepEqual([r.started, r.withPrevious, r.reading.change, r.reading.changeMass, r.reading.forceful, r.reading.strength, r.reading.direction, r.reading.about, r.reading.inferred], [true, false, true, 0.9, true, 'clear', 'less', 'length', ['about']])
  assert.deepEqual([r.directive, r.candidate.status, r.lineSent], [{ guidance: 'length', value: 'less' }, 'candidate', true])
  assert.equal(w.guidance.size(), 1); const [c] = w.guidance.list(); assert.deepEqual([c.guidance, c.value, c.status, c.seen], ['length', 'less', 'candidate', 1])
  assert.match(w.calls[0].additionalContext?.[NUNCHI_KEY]?.value ?? '', /Keep replies short for the rest of this conversation/)
  // the same sentence again in the same conversation: still one candidate (seen counts up, no second entry)
  await w.sendPlain('너무 길어. 앞으로는 짧게 말해', { requestId: 'again', conversationId: 'claude-1' }); await until(() => w.guidance.list()[0].seen === 2); assert.equal(w.guidance.size(), 1)
  w.close()
})
test('u4 replay: a plain instruction the model read as "none" without a previous message ("영어 말고 한국어로 답해줘": kinds .15) becomes a language/korean candidate once nk_manner says yes (stand-in answer: a fresh plan reads the real one)', async () => {
  const w = await roomWorld({ readings: { '영어 말고 한국어로 답해줘': PLAIN_KOREAN } })
  await w.sendPlain('영어 말고 한국어로 답해줘')
  const [r] = w.chat.nunchiRecent(5); assert.deepEqual([r.reading.change, r.reading.mannerMass, r.reading.about, r.reading.language, r.directive, r.candidate.status], [true, 0.95, 'language', 'korean', { guidance: 'language', value: 'korean' }, 'candidate'])
  assert.deepEqual(w.guidance.list().map(e => `${e.guidance}:${e.value}`), ['language:korean']); w.close()
})
