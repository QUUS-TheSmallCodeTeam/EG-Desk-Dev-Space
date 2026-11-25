import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp } from 'node:fs/promises'
import { CodexChatRuntime, TURN_MEMORY_CAPS } from './codex-chat-runtime.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { collectDecisionCandidates } from './egdesk-decision-candidates.mjs'
import { NUNCHI_KEY, NUNCHI_CAPS, conversationGuidance, createNunchiConfig, dropConversationGuidance } from './egdesk-nunchi-runtime.mjs'
import { createUserGuidanceStore } from './egdesk-user-guidance.mjs'
import { choiceAnswer, createFakeClock, deferred, until } from './egdesk-wiki-reconstruction.fixture.mjs'

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
          return { answers: Object.fromEntries(req.questions.map(q => [q.name, choiceAnswer(q, want[q.name], top)])), model: 'syn', usage: { inputTokens: 1 }, latencyMs: 1 }
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
  assert.equal(guideOf(w.starts[1]), '[guidance from the person: follow it in your reply; do not mention it unless asked]\n- Reply in Korean for the rest of this conversation, as the person asked.')
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
  w.guidance.setStatus(id, 'reverted'); await w.ask('And the day after?', 'dm-2'); assert.equal(guideOf(w.starts.at(-1)), '', 'reverted: gone'); assert.match(w.reply('dm-2'), /full schedule/)
  assert.deepEqual(conversationGuidance(w.chat, 'dm-1').map(g => g.guidance), ['language']); assert.equal(dropConversationGuidance(w.chat, 'dm-1', 'language'), true); assert.equal(dropConversationGuidance(w.chat, 'dm-1', 'language'), false)
  await w.ask('다음은?'); assert.equal(guideOf(w.starts.at(-1)), '', 'dropped'); w.close()
})

test('a second reaction adds its own line (short replies), the same kind of guidance replaces its earlier line, at most four lines', async () => {
  const w = await world({ readings: { '야 한글로 보고해': KOREAN, '너무 길어 짧게': SHORT, '영어로 다시': { ...KOREAN, nk_language: 'english' } } })
  await w.ask('일정?'); await w.ask('야 한글로 보고해'); await w.ask('너무 길어 짧게')
  assert.equal(guideOf(w.starts[2]).split('\n').length, 3, 'header and two lines'); assert.equal(w.reply(), '네, 짧게.')
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
